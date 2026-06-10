// ══════════════════════════════════════════════════════════
// company-purchase.js — 컴퍼니 매입 장부 (E2E 대체 지향)
// tab-company-purchase.html 에서 x-data="companyLedgerApp()" 으로 사용
// ⚠️ 템플릿(x-if) 안의 <script>는 실행되지 않으므로 별도 파일 (statements.js 패턴)
// 보기: 명세서별 / 업체별 · 입력: OCR 사진 · 저장/확정/삭제 · API: /api/company-purchase/*
// ══════════════════════════════════════════════════════════
function companyLedgerApp() {
  return {
    // 목록
    list: [], loadingList: false,
    viewMode: 'st',              // 'st' 명세서별 | 'vendor' 업체별
    expandedVendor: '',
    filterMonth: '', searchQ: '', filterStatus: '',
    // 선택 명세서(전표)
    selectedId: null, vendor: { name: '', biz_no: '' }, trxDate: '', lines: [], stStatus: '',
    imageUrl: '', loadingDetail: false, saving: false, saveMsg: '',
    // 업로드 큐
    queue: { total: 0, done: 0, failed: 0, running: 0 },

    async init() {
      await this.loadList();
      this._paste = (e) => {
        const items = (e.clipboardData && e.clipboardData.items) || [];
        const imgs = [];
        for (const it of items) if (it.type && it.type.startsWith('image/')) { const f = it.getAsFile(); if (f) imgs.push(f); }
        if (imgs.length) { e.preventDefault(); this.uploadFiles(imgs); }
      };
      document.addEventListener('paste', this._paste);
    },
    destroy() { if (this._paste) document.removeEventListener('paste', this._paste); },

    async loadList() {
      this.loadingList = true;
      try {
        const r = await fetch('/api/company-purchase/history?limit=500', { credentials: 'include' }).then(r => r.json());
        if (r.ok) this.list = r.items || [];
      } catch (e) {} finally { this.loadingList = false; }
    },

    // ── 필터/그룹 ──
    get filtered() {
      let arr = this.list;
      if (this.filterMonth) arr = arr.filter(h => (h.trx_date || '').startsWith(this.filterMonth));
      if (this.filterStatus) arr = arr.filter(h => (h.status || 'parsed') === this.filterStatus);
      const q = this.searchQ.trim().toLowerCase();
      if (q) arr = arr.filter(h => (h.vendor_name || '').toLowerCase().includes(q));
      return arr;
    },
    get vendorGroups() {
      const m = new Map();
      for (const h of this.filtered) {
        const k = h.vendor_name || '(거래처 미인식)';
        if (!m.has(k)) m.set(k, { name: k, n: 0, total: 0, pending: 0, items: [] });
        const g = m.get(k);
        g.n++; g.total += Number(h.total_amt) || 0;
        if (h.status !== 'confirmed') g.pending++;
        g.items.push(h);
      }
      return [...m.values()].sort((a, b) => b.total - a.total);
    },
    get sumFiltered() { return this.filtered.reduce((s, h) => s + (Number(h.total_amt) || 0), 0); },
    toggleVendor(name) { this.expandedVendor = (this.expandedVendor === name) ? '' : name; },

    // ── 업로드 (OCR) ──
    onFileInput(e) { this.uploadFiles(e.target.files); e.target.value = ''; },
    onDrop(e) { this.uploadFiles(e.dataTransfer.files); },
    async uploadFiles(fileList) {
      const files = Array.from(fileList).filter(f => (f.type || '').startsWith('image/'));
      if (!files.length) return;
      this.queue = { total: files.length, done: 0, failed: 0, running: files.length };
      let firstNewId = null;
      for (const f of files) {
        try {
          const fd = new FormData(); fd.append('file', f);
          const r = await fetch('/api/company-purchase/parse', { method: 'POST', body: fd, credentials: 'include' }).then(r => r.json());
          if (r.ok) { this.queue.done++; if (!firstNewId) firstNewId = r.id; }
          else { this.queue.failed++; }
        } catch (e) { this.queue.failed++; }
        this.queue.running = this.queue.total - this.queue.done - this.queue.failed;
        await this.loadList();
      }
      this.queue.running = 0;
      if (firstNewId) this.openDetail(firstNewId);
    },

    // ── 전표 상세 ──
    async openDetail(id) {
      this.loadingDetail = true; this.selectedId = id; this.saveMsg = '';
      try {
        const r = await fetch('/api/company-purchase/history/' + id, { credentials: 'include' }).then(r => r.json());
        if (r.ok) {
          this.vendor = { name: (r.vendor && r.vendor.name) || '', biz_no: (r.vendor && r.vendor.biz_no) || '' };
          this.trxDate = r.trx_date || '';
          this.stStatus = r.status || 'parsed';
          this.lines = (r.lines || []).map(l => ({ ...l, total_amt: (Number(l.supply_amt) || 0) + (Number(l.vat_amt) || 0) }));
          this.imageUrl = r.image_filename ? ('/api/company-purchase/history/' + id + '/image') : '';
        }
      } catch (e) {} finally { this.loadingDetail = false; }
    },
    closeDetail() { this.selectedId = null; this.lines = []; this.vendor = { name: '', biz_no: '' }; this.imageUrl = ''; this.saveMsg = ''; },

    recalcLine(line, src) {
      if (src === 'supply') { line.vat_amt = Math.round((Number(line.supply_amt) || 0) * 0.1); }
      else { line.supply_amt = Math.round((Number(line.qty) || 0) * (Number(line.unit_price) || 0)); line.vat_amt = Math.round(line.supply_amt * 0.1); }
      line.total_amt = (Number(line.supply_amt) || 0) + (Number(line.vat_amt) || 0);
    },
    addBlankLine() {
      this.lines.push({ row_no: this.lines.length + 1, ocr_text: '', ocr_spec: '', item: '', spec: '', code: '', qty: 0, unit_price: 0, supply_amt: 0, vat_amt: 0, total_amt: 0, status: 'unknown', match_source: null, skip: false });
    },
    get totalSupply() { return this.lines.filter(l => !l.skip).reduce((s, l) => s + (Number(l.supply_amt) || 0), 0); },
    get totalVat() { return this.lines.filter(l => !l.skip).reduce((s, l) => s + (Number(l.vat_amt) || 0), 0); },
    get totalAmt() { return this.lines.filter(l => !l.skip).reduce((s, l) => s + (Number(l.total_amt) || 0), 0); },

    // ── 저장 / 확정 / 삭제 ──
    async _patch(body) {
      const r = await fetch('/api/company-purchase/history/' + this.selectedId, {
        method: 'PATCH', credentials: 'include', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).then(r => r.json());
      if (!r.ok) throw new Error(r.error || '실패');
      return r;
    },
    async save(silent) {
      if (!this.selectedId || this.saving) return false;
      this.saving = true; this.saveMsg = '';
      try {
        const r = await this._patch({ vendor: this.vendor, trx_date: this.trxDate, lines: this.lines });
        this.stStatus = r.statement.status || this.stStatus;
        if (!silent) this.saveMsg = '💾 저장됨';
        await this.loadList();
        return true;
      } catch (e) { this.saveMsg = '❌ ' + e.message; return false; }
      finally { this.saving = false; }
    },
    async confirmSt() {
      if (!this.selectedId || this.saving) return;
      this.saving = true; this.saveMsg = '';
      try {
        const r = await this._patch({ vendor: this.vendor, trx_date: this.trxDate, lines: this.lines, status: 'confirmed' });
        this.stStatus = 'confirmed';
        this.saveMsg = '✅ 확정됨 (학습 반영)';
        await this.loadList();
      } catch (e) { this.saveMsg = '❌ ' + e.message; }
      finally { this.saving = false; }
    },
    async reopenSt() {
      if (!this.selectedId || this.saving) return;
      this.saving = true; this.saveMsg = '';
      try {
        await this._patch({ status: 'parsed' });
        this.stStatus = 'parsed';
        this.saveMsg = '↩ 검토 상태로 되돌림';
        await this.loadList();
      } catch (e) { this.saveMsg = '❌ ' + e.message; }
      finally { this.saving = false; }
    },
    async deleteSt() {
      if (!this.selectedId) return;
      const warn = this.stStatus === 'confirmed'
        ? '⚠️ 확정된 전표입니다. 정말 삭제할까요?\n(장부에서 사라지며 원본 사진도 함께 삭제)'
        : '이 명세서를 삭제할까요? (원본 사진도 함께 삭제)';
      if (!confirm(warn)) return;
      try {
        const r = await fetch('/api/company-purchase/history/' + this.selectedId, { method: 'DELETE', credentials: 'include' }).then(r => r.json());
        if (r.ok) { this.closeDetail(); await this.loadList(); }
        else alert('삭제 실패');
      } catch (e) { alert(e.message); }
    },
    async exportOne() {
      // 저장 먼저 → 저장된 내용으로 단건 E2E 엑셀
      const ok = await this.save(true);
      if (ok === false) return;
      window.open('/api/company-purchase/history/' + this.selectedId + '/export.xlsx', '_blank');
    },
    nextStatement() {
      const arr = this.filtered;
      const i = arr.findIndex(x => x.id === this.selectedId);
      if (i >= 0 && i < arr.length - 1) this.openDetail(arr[i + 1].id);
    },

    fmt(n) { return (Number(n) || 0).toLocaleString(); },
    fmtTime(ts) { if (!ts) return ''; const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; },
  };
}
