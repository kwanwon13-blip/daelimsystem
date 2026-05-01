
function statementsApp() {
  return {
    items: [], total: 0, limit: 100, offset: 0,
    stats: { total: 0, pending: 0, confirmed: 0, byQuadrant: [], pendingByQuadrant: [] },
    filterStatus: '', filterMonth: '', filterCompany: '', filterClass: '', searchQ: '',
    queue: { total: 0, processed: 0, failed: 0, queueLen: 0, processing: 0 },
    queueTimer: null,
    dragOver: false,
    selected: null, edit: {}, saveMsg: '',

    // 모드 라우팅
    currentView: 'overview',  // overview / company-buy / company-sell / sm-buy / sm-sell
    modeRows: [], selectedRowIdx: -1,

    enterMode(company, cls) {
      const map = {
        'COMPANY_매입': 'company-buy', 'COMPANY_매출': 'company-sell',
        'SM_매입': 'sm-buy', 'SM_매출': 'sm-sell',
      };
      this.currentView = map[`${company}_${cls}`] || 'overview';
      this.filterCompany = company;
      this.filterClass = cls;
      this.selectedRowIdx = -1;
      this.loadModeRows();
    },
    exitMode() {
      this.currentView = 'overview';
      this.modeRows = [];
      this.selectedRowIdx = -1;
    },

    async loadModeRows() {
      // 분할 조건에 맞는 명세서 + 라인아이템 펼쳐서 불러오기
      const params = new URLSearchParams();
      params.set('companyCode', this.filterCompany);
      params.set('docClass', this.filterClass);
      if (this.filterMonth) params.set('month', this.filterMonth);
      params.set('limit', 1000);
      try {
        const r = await fetch('/api/statements/list?' + params).then(r => r.json());
        if (!r.ok) { this.modeRows = []; return; }
        // 명세서별로 라인아이템 가져와서 펼치기 (각 명세서 GET)
        const rows = [];
        for (const st of r.items) {
          const dt = await fetch('/api/statements/' + st.id).then(r => r.json());
          if (!dt.ok) continue;
          const items = (dt.statement.items || []);
          if (items.length === 0) {
            rows.push({
              _key: 'st_' + st.id,
              statement_id: st.id,
              source_file: st.source_file,
              vendor: st.norm_vendor || st.vendor_name || '',
              uploaded_at: st.uploaded_at,
              date: st.doc_date || '', name: st.norm_vendor || '', spec: '',
              qty: 1, price: st.supply_amount || 0, amount: st.supply_amount || 0,
              vat: st.vat_amount || 0, total: st.total_amount || 0,
              notes: st.notes || '',
            });
          } else {
            for (const it of items) {
              const amt = Number(it.amount) || 0;
              rows.push({
                _key: 'st_' + st.id + '_' + it.id,
                statement_id: st.id,
                source_file: st.source_file,
                vendor: st.norm_vendor || st.vendor_name || '',
                uploaded_at: st.uploaded_at,
                date: st.doc_date || '',
                name: it.item_name || '', spec: it.spec || '',
                qty: it.quantity, price: it.unit_price,
                amount: amt, vat: it.vat || Math.round(amt * 0.1),
                total: amt + (it.vat || Math.round(amt * 0.1)),
                notes: it.notes || st.notes || '',
              });
            }
          }
        }
        this.modeRows = rows;
        if (rows.length > 0 && this.selectedRowIdx === -1) this.selectedRowIdx = 0;
      } catch(e) { console.error(e); this.modeRows = []; }
    },

    get selectedRow() {
      return (this.modeRows && this.selectedRowIdx >= 0) ? this.modeRows[this.selectedRowIdx] : null;
    },
    selectModeRow(idx) { this.selectedRowIdx = idx; },
    prevRow() { if (this.selectedRowIdx > 0) this.selectedRowIdx--; },
    nextRow() { if (this.selectedRowIdx < (this.modeRows||[]).length - 1) this.selectedRowIdx++; },

    recalc(r, fromAmount) {
      // 수량×단가=금액 자동 계산
      if (!fromAmount && r.qty && r.price) {
        r.amount = Math.round(r.qty * r.price);
      }
      r.vat = Math.round(r.amount * 0.1);
      r.total = r.amount + r.vat;
    },
    addBlankRow() {
      this.modeRows = this.modeRows || [];
      this.modeRows.push({
        _key: 'new_' + Date.now(),
        statement_id: null, source_file: '', vendor: '',
        date: '', name: '', spec: '', qty: 0, price: 0, amount: 0, vat: 0, total: 0, notes: '',
      });
    },
    modeSum() {
      return (this.modeRows || []).reduce((s, r) => s + (Number(r.total) || 0), 0);
    },
    exportUrl(company) {
      const p = new URLSearchParams();
      p.set('status', 'confirmed');
      if (company) p.set('companyCode', company);
      if (this.filterClass) p.set('docClass', this.filterClass);
      if (this.filterMonth) p.set('month', this.filterMonth);
      return '/api/statements/export.xlsx?' + p;
    },
    async confirmAllInMode() {
      if (!confirm(`현재 분할의 검토전 명세서 모두 확정?\n(이미 확정된 건 변경 없음)`)) return;
      for (const r of (this.modeRows || [])) {
        if (r.statement_id) {
          try { await fetch(`/api/statements/${r.statement_id}/confirm`, {method:'POST'}); } catch(e){}
        }
      }
      this.loadModeRows();
      this.loadStats();
    },

    // 학습 풀 통계
    poolStats: { loaded: false },
    async loadPoolStats() {
      try {
        const r = await fetch('/api/statements/learning-pool/stats').then(r => r.json());
        if (r.ok) this.poolStats = r;
      } catch(e) {}
    },
    async reloadPool() {
      try {
        const r = await fetch('/api/statements/learning-pool/reload', { method: 'POST' }).then(r => r.json());
        if (r.ok) {
          this.poolStats = { loaded: true, ...r.stats };
          alert('학습 풀 다시 로드 완료');
        } else { alert('실패: ' + r.error); }
      } catch(e) { alert('에러: ' + e.message); }
    },

    // 4분할 학습 데이터 풀
    dataSources: {},
    selectedDataFile: '',
    dataSheets: [],
    selectedSheetIdx: 0,
    dataLoading: false,

    async loadDataSources() {
      try {
        const r = await fetch('/api/statements/data-sources').then(r => r.json());
        if (r.ok) this.dataSources = r.sources || {};
      } catch(e) { console.error(e); }
    },

    async loadDataPreview(file) {
      this.selectedDataFile = file.path;
      this.dataLoading = true;
      this.dataSheets = [];
      this.selectedSheetIdx = 0;
      try {
        // SheetJS (XLSX 글로벌 라이브러리, index.html 에 이미 로드됨) 로 파싱
        const url = `/api/statements/data-source-file?path=${encodeURIComponent(file.path)}`;
        if (!window.XLSX) {
          alert('SheetJS 가 로드 안 됨 (index.html 의 xlsx CDN 확인)');
          this.dataLoading = false;
          return;
        }
        const ab = await fetch(url).then(r => r.arrayBuffer());
        const wb = XLSX.read(ab, { type: 'array' });
        this.dataSheets = wb.SheetNames.map(name => {
          const ws = wb.Sheets[name];
          const json = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
          const headers = (json[0] || []).map(h => String(h ?? ''));
          // 처음 100행만 미리보기 (큰 파일 방지)
          const preview = json.slice(1, 101).map(row =>
            headers.map((_, ci) => {
              const v = row[ci];
              if (v == null || v === '') return '';
              if (v instanceof Date) return v.toISOString().slice(0, 10);
              return String(v).slice(0, 60);
            })
          );
          return { name, headers, preview, rows: Math.max(0, json.length - 1) };
        });
      } catch(e) {
        alert('미리보기 실패: ' + e.message);
      } finally {
        this.dataLoading = false;
      }
    },

    // 시안 문구 확인
    spellResults: [],
    spellChecking: false,
    spellChecked: 0,
    spellTotal: 0,
    spellSelectedIdx: -1,
    async spellCheck(files) {
      if (!files || files.length === 0) return;
      // 이미지만 필터
      const imgs = Array.from(files).filter(f => (f.type || '').startsWith('image/'));
      if (imgs.length === 0) {
        alert('이미지 파일만 확인 가능 — 카톡 시안 사진 복사 후 Ctrl+V');
        return;
      }
      this.spellChecking = true;
      this.spellChecked = 0;
      this.spellTotal = imgs.length;
      // 이미지 미리보기 dataURL 만들기
      const previews = await Promise.all(imgs.map(f => new Promise(res => {
        const fr = new FileReader();
        fr.onload = () => res({ name: f.name || '붙여넣은 이미지', dataUrl: fr.result });
        fr.readAsDataURL(f);
      })));
      const fd = new FormData();
      imgs.forEach((f, i) => fd.append('files', f, previews[i].name));
      try {
        const r = await fetch('/api/statements/spell-check', { method: 'POST', body: fd }).then(r => r.json());
        if (r.ok) {
          this.spellChecked = imgs.length;
          const results = (r.results || []).map((res, i) => ({
            ...res,
            imageDataUrl: previews[i] ? previews[i].dataUrl : null,
          }));
          // 누적 (Ctrl+V 여러번 가능)
          const wasEmpty = this.spellResults.length === 0;
          this.spellResults = [...this.spellResults, ...results];
          // 새로 들어온 첫 결과 자동 선택 (또는 이미 결과 있으면 새 결과 첫 번째)
          if (wasEmpty || this.spellSelectedIdx < 0) {
            this.spellSelectedIdx = this.spellResults.length - results.length;
          }
        } else {
          alert('실패: ' + r.error);
        }
      } catch (e) {
        alert('에러: ' + e.message);
      } finally {
        this.spellChecking = false;
      }
    },

    // 추출 텍스트에서 의심 단어 형광펜 (HTML 출력)
    highlightText(text, issues) {
      if (!text) return '(텍스트 추출 안됨)';
      const escapeHtml = (s) => String(s).replace(/[&<>]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;'})[c]);
      let html = escapeHtml(text);
      if (!issues || issues.length === 0) return html;
      // 각 issue 의 found 단어를 형광펜으로
      const colors = {
        '오타':       'background:#fee2e2; color:#991b1b;',
        '철자':       'background:#fee2e2; color:#991b1b;',
        '문자깨짐':   'background:#fee2e2; color:#991b1b;',
        '맞춤법':     'background:#fef3c7; color:#92400e;',
        '사이즈':     'background:#dbeafe; color:#1e40af;',
        '숫자':       'background:#e0e7ff; color:#3730a3;',
        '기타':       'background:#f3e8ff; color:#6b21a8;',
      };
      for (const iss of issues) {
        if (!iss.found) continue;
        const found = escapeHtml(iss.found);
        const color = colors[iss.type] || colors['기타'];
        const tooltip = escapeHtml(iss.message + (iss.suggest ? ' → ' + iss.suggest : ''));
        // 첫 발견되는 거 한 번만 마킹 (중복 방지)
        const re = new RegExp(found.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
        html = html.replace(re, `<mark style="${color} padding:1px 4px; border-radius:3px; font-weight:600;" title="${tooltip}">${found}</mark>`);
      }
      return html;
    },

    // Ctrl+V 핸들러 — 클립보드에 이미지 있으면 검사
    onSpellPaste(e) {
      if (this.currentView !== 'spell-check') return;
      const items = (e.clipboardData && e.clipboardData.items) || [];
      const files = [];
      for (const it of items) {
        if ((it.type || '').startsWith('image/')) {
          const f = it.getAsFile();
          if (f) {
            const ts = new Date().toISOString().slice(11, 19).replace(/:/g, '');
            const ext = (f.type || 'image/png').split('/')[1] || 'png';
            files.push(new File([f], `붙여넣기_${ts}.${ext}`, { type: f.type }));
          }
        }
      }
      if (files.length > 0) {
        e.preventDefault();
        this.spellCheck(files);
      }
    },

    // 이카운트 등록 (dryRun OR 실제)
    ecountMsg: '',
    async ecountRegister(docClass, dryRun) {
      this.ecountMsg = dryRun ? '⚙️ dry-run 검증 중...' : '🔴 이카운트 실제 등록 중... (취소 불가)';
      if (!dryRun) {
        if (!confirm(`이카운트에 ${docClass} ${(this.modeRows||[]).length}건 실제 등록합니다. 진행?`)) {
          this.ecountMsg = '';
          return;
        }
      }
      try {
        const r = await fetch('/api/statements/ecount/register', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            docClass,
            month: this.filterMonth || null,
            dryRun,
          }),
        }).then(r => r.json());
        if (r.ok && r.dryRun) {
          this.ecountMsg = `✅ dry-run 성공\n등록 대기: ${r.itemCount}건\n샘플:\n${JSON.stringify(r.sample, null, 2)}`;
        } else if (r.ok) {
          this.ecountMsg = `✅ 이카운트 등록 성공! ${r.itemCount}건\n응답: ${JSON.stringify(r.result?.raw || r.result, null, 2).slice(0, 500)}`;
          this.loadModeRows();
        } else {
          this.ecountMsg = `❌ 실패: ${r.error || '알 수 없음'}\n${JSON.stringify(r, null, 2).slice(0, 500)}`;
        }
      } catch (e) {
        this.ecountMsg = '❌ 호출 에러: ' + e.message;
      }
    },

    // 4분할 카드 헬퍼
    quadCount(company, cls) {
      const arr = this.stats.byQuadrant || [];
      if (company === null && cls === null) {
        return arr.filter(q => q.company === '미분류' || q.class === '미분류').reduce((a,b) => a + (b.n||0), 0);
      }
      const f = arr.find(q => q.company === company && q.class === cls);
      return f ? (f.n || 0) : 0;
    },
    quadPending(company, cls) {
      const arr = this.stats.pendingByQuadrant || [];
      const f = arr.find(q => q.company === company && q.class === cls);
      return f ? (f.n || 0) : 0;
    },

    async init() {
      await this.loadStats();
      await this.load();
      await this.loadPoolStats();
    },
    async loadStats() {
      try { const r = await fetch('/api/statements/stats').then(r=>r.json()); if (r.ok) this.stats = r; } catch(e) {}
    },
    async load() {
      const params = new URLSearchParams();
      if (this.filterStatus) params.set('status', this.filterStatus);
      if (this.filterMonth) params.set('month', this.filterMonth);
      if (this.filterCompany) params.set('companyCode', this.filterCompany);
      if (this.filterClass) params.set('docClass', this.filterClass);
      if (this.searchQ.trim()) params.set('q', this.searchQ.trim());
      params.set('limit', this.limit);
      params.set('offset', this.offset);
      try {
        const r = await fetch('/api/statements/list?' + params).then(r=>r.json());
        if (r.ok) { this.items = r.items; this.total = r.total; }
      } catch(e) { console.error(e); }
    },

    async uploadFiles(fileList) {
      const files = Array.from(fileList);
      if (files.length === 0) return;
      const fd = new FormData();
      for (const f of files) fd.append('files', f);
      try {
        const r = await fetch('/api/statements/upload-batch', { method: 'POST', body: fd }).then(r=>r.json());
        if (r.ok) {
          this.queue = { ...this.queue, ...r.queue };
          this.startQueuePoll();
        }
      } catch(e) { alert('업로드 실패: '+e.message); }
    },

    startQueuePoll() {
      if (this.queueTimer) return;
      this.queueTimer = setInterval(async () => {
        try {
          const r = await fetch('/api/statements/queue').then(r=>r.json());
          if (r.ok) {
            this.queue = r;
            // 끝나면 폴링 멈추고 목록 갱신
            if (r.processing === 0 && r.queueLen === 0 && r.total > 0) {
              clearInterval(this.queueTimer); this.queueTimer = null;
              await this.loadStats();
              await this.load();
            }
          }
        } catch(e) {}
      }, 1500);
    },

    async openModal(id) {
      try {
        const r = await fetch('/api/statements/'+id).then(r=>r.json());
        if (r.ok) {
          this.selected = r.statement;
          this.edit = {
            doc_type: r.statement.doc_type || '',
            doc_class: r.statement.doc_class || '',
            company_code: r.statement.company_code || '',
            doc_date: r.statement.doc_date || '',
            norm_vendor: r.statement.norm_vendor || r.statement.vendor_name || '',
            vendor_biz_no: r.statement.vendor_biz_no || '',
            supply_amount: r.statement.supply_amount,
            vat_amount: r.statement.vat_amount,
            total_amount: r.statement.total_amount,
            notes: r.statement.notes || '',
            items: (r.statement.items || []).map(it => ({...it})),
          };
          this.saveMsg = '';
        }
      } catch(e) { alert(e.message); }
    },
    closeModal() { this.selected = null; this.saveMsg = ''; },

    async save() {
      if (!this.selected) return;
      try {
        const r = await fetch('/api/statements/'+this.selected.id, {
          method: 'PATCH', headers: {'Content-Type':'application/json'},
          body: JSON.stringify(this.edit),
        }).then(r=>r.json());
        if (r.ok) {
          this.selected = r.statement;
          this.saveMsg = '저장됨';
          this.load();
        } else { this.saveMsg = '실패: '+r.error; }
      } catch(e) { this.saveMsg = '에러: '+e.message; }
    },
    async confirm(id) {
      await fetch(`/api/statements/${id}/confirm`, {method:'POST'});
      await this.load(); await this.loadStats();
      if (this.selected?.id === id) this.closeModal();
    },
    async reject(id) {
      await fetch(`/api/statements/${id}/reject`, {method:'POST'});
      await this.load(); await this.loadStats();
    },
    async reset(id) {
      // 다시 pending 으로 돌리기
      await fetch(`/api/statements/${id}/reset`, { method:'POST' });
      await this.load(); await this.loadStats();
    },
    async del() {
      if (!confirm('정말 삭제할까요?')) return;
      await fetch('/api/statements/'+this.selected.id, { method: 'DELETE' });
      this.closeModal(); this.load(); this.loadStats();
    },
  };
}
