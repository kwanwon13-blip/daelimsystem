// ═══════════════════════════════════════════════
// 매입 자동화 탭 — Alpine.js 컴포넌트
// tab-purchase-auto.html 에서 x-data="purchaseAutoApp()"
// ═══════════════════════════════════════════════
function purchaseAutoApp() {
  return {
    // ── 상태 ──
    queue: [],            // [{ file, status, result }]
    activeIdx: -1,        // 현재 보이는 큐 항목 인덱스
    processing: false,
    dragOver: false,
    stats: {              // 전체 통계 (TOP 매입처 등)
      total_lines: 0,
      learned: 0,
      top: [],
    },

    // 결과 표시용 (활성화된 큐 항목의 결과)
    get currentResult() {
      if (this.activeIdx < 0 || !this.queue[this.activeIdx]) return {};
      return this.queue[this.activeIdx].result || {};
    },

    // 합계 계산
    get totalSupply() {
      const lines = this.currentResult.lines || [];
      return lines.reduce((s, l) => s + (l.supply_amt || 0), 0);
    },
    get totalVat() {
      const lines = this.currentResult.lines || [];
      return lines.reduce((s, l) => s + (l.vat_amt || 0), 0);
    },
    get totalSum() {
      return this.totalSupply + this.totalVat;
    },

    // 후보 일괄 학습 가능한 행 수 (선택된 후보 있는 candidate 행)
    get confirmedCount() {
      return (this.currentResult.lines || []).filter(l =>
        l.match.method === 'candidate' && l.match.prod_cd && !l._learned
      ).length;
    },

    // 이카운트 등록 가능 여부 (모든 행이 매칭됨)
    get canSubmit() {
      const lines = this.currentResult.lines || [];
      if (lines.length === 0) return false;
      return lines.every(l => l.match.prod_cd);
    },

    // ── 초기화 ──
    async init() {
      await this.loadStats();
    },

    async loadStats() {
      try {
        const r = await fetch('/api/ecount-purchase/vendor-info');
        if (!r.ok) return;
        const d = await r.json();
        if (d.ok) {
          this.stats = {
            total_lines: d.total_lines,
            learned: d.learned_mappings,
            top: d.top || [],
          };
        }
      } catch (e) { console.warn('loadStats failed:', e); }
    },

    // ── 파일 업로드 ──
    onFileSelect(e) {
      const files = [...(e.target.files || [])];
      this.addFiles(files);
      e.target.value = '';
    },
    onDrop(e) {
      this.dragOver = false;
      const files = [...(e.dataTransfer.files || [])];
      this.addFiles(files);
    },
    addFiles(files) {
      const valid = files.filter(f => {
        const ok = f.type.startsWith('image/') || f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf');
        if (!ok) console.warn('skip:', f.name);
        return ok;
      });
      for (const f of valid) {
        this.queue.push({ file: f, status: 'pending', result: null });
      }
      // 첫 항목 자동 처리
      if (this.queue.length > 0 && this.activeIdx < 0) {
        this.activeIdx = 0;
      }
      this.processNext();
    },

    async processNext() {
      if (this.processing) return;
      const idx = this.queue.findIndex(q => q.status === 'pending');
      if (idx < 0) return;

      this.processing = true;
      this.queue[idx].status = 'processing';
      if (this.activeIdx === -1) this.activeIdx = idx;

      try {
        const fd = new FormData();
        fd.append('file', this.queue[idx].file);
        const r = await fetch('/api/ecount-purchase/parse', { method: 'POST', body: fd });
        const d = await r.json();
        if (d.ok) {
          this.queue[idx].result = d;
          this.queue[idx].status = 'ok';
          // 처음 처리된 거면 자동 표시
          if (idx === this.activeIdx) {
            // (강제 갱신 위한 트릭)
            this.queue = [...this.queue];
          }
        } else {
          this.queue[idx].status = 'error';
          this.queue[idx].result = { error: d.error || '실패' };
        }
      } catch (e) {
        this.queue[idx].status = 'error';
        this.queue[idx].result = { error: String(e.message || e) };
      } finally {
        this.processing = false;
        // 다음 항목 처리
        setTimeout(() => this.processNext(), 100);
      }
    },

    selectQueueItem(idx) {
      this.activeIdx = idx;
    },

    clearQueue() {
      if (this.processing) return;
      this.queue = [];
      this.activeIdx = -1;
    },

    statusLabel(s) {
      return { pending: '대기', processing: '🔄 분석', ok: '✅ 완료', error: '❌ 실패' }[s] || s;
    },

    // ── 후보 선택 ──
    pickCandidate(lineIdx, cand) {
      const cur = this.queue[this.activeIdx];
      if (!cur || !cur.result) return;
      const line = cur.result.lines[lineIdx];
      line.match.prod_cd = cand.prod_cd;
      line.match.prod_name = cand.prod_name;
      line.match.confidence = cand.score;
      line._dirty = true;
      // Alpine 갱신
      this.queue = [...this.queue];
    },

    // ── 단건 학습 저장 ──
    async confirmLine(lineIdx) {
      const cur = this.queue[this.activeIdx];
      if (!cur || !cur.result) return;
      const line = cur.result.lines[lineIdx];
      const vendor = cur.result.vendor?.identified?.vendor_name;
      if (!vendor || !line.match.prod_cd) return;

      try {
        const r = await fetch('/api/ecount-purchase/confirm', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            vendor_name: vendor,
            ocr_text: line.ocr_text,
            prod_cd: line.match.prod_cd,
            prod_name: line.match.prod_name,
          }),
        });
        const d = await r.json();
        if (d.ok) {
          line._learned = true;
          line.match.method = 'learned';
          this.queue = [...this.queue];
          this._toast('🎓 학습됨: ' + line.match.prod_name);
          this.loadStats();
        } else {
          this._toast('❌ 저장 실패: ' + (d.error || ''));
        }
      } catch (e) {
        this._toast('❌ 네트워크 오류');
      }
    },

    async confirmAllPending() {
      const cur = this.queue[this.activeIdx];
      if (!cur || !cur.result) return;
      const vendor = cur.result.vendor?.identified?.vendor_name;
      if (!vendor) return;
      let saved = 0;
      for (let i = 0; i < cur.result.lines.length; i++) {
        const line = cur.result.lines[i];
        if (line.match.method === 'candidate' && line.match.prod_cd && !line._learned) {
          await this.confirmLine(i);
          saved++;
        }
      }
      this._toast(`🎓 ${saved}건 일괄 학습 완료`);
    },

    openManualPick(lineIdx) {
      const cur = this.queue[this.activeIdx];
      const vendor = cur.result.vendor?.identified?.vendor_name;
      const ocrText = cur.result.lines[lineIdx].ocr_text;
      const q = prompt('품명 검색어를 입력하세요 (예: 후렉스, 안전화, 스티커):', '');
      if (!q) return;
      this._manualPick(lineIdx, vendor, q);
    },

    async _manualPick(lineIdx, vendor, q) {
      const r = await fetch(`/api/ecount-purchase/candidates?vendor=${encodeURIComponent(vendor)}&q=${encodeURIComponent(q)}`);
      const d = await r.json();
      if (!d.ok || !d.candidates || d.candidates.length === 0) {
        this._toast('❌ 검색 결과 없음');
        return;
      }
      // 후보 5개 보여주기 (간단하게 prompt로)
      const choices = d.candidates.slice(0, 10).map((c, i) => `${i+1}. ${c.prod_name} [${c.prod_cd}] (${c.times}회)`).join('\n');
      const sel = prompt('후보 중 선택 (번호):\n\n' + choices, '1');
      const idx = parseInt(sel, 10);
      if (!idx || isNaN(idx) || idx < 1 || idx > d.candidates.length) return;
      const c = d.candidates[idx - 1];
      this.pickCandidate(lineIdx, { prod_cd: c.prod_cd, prod_name: c.prod_name, score: c.score || 0.5 });
    },

    async submitToEcount() {
      // Phase 2 — 우선 준비됨 알림만
      this._toast('🚀 이카운트 자동등록은 Phase 2에서 활성화 — 우선 매칭/학습 정착 후');
    },

    _toast(msg) {
      const t = document.createElement('div');
      t.textContent = msg;
      t.style.cssText = 'position:fixed;bottom:30px;left:50%;transform:translateX(-50%);background:#1f2937;color:#fff;padding:10px 20px;border-radius:8px;font-size:13px;font-weight:600;z-index:9999;box-shadow:0 4px 14px rgba(0,0,0,.2);';
      document.body.appendChild(t);
      setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; }, 1800);
      setTimeout(() => { t.remove(); }, 2200);
    },
  };
}
