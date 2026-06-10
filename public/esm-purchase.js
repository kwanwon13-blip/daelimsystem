// ══════════════════════════════════════════════════════════
// esm-purchase.js — 에스엠 매입 OCR (A안: 좌 목록 / 우 상세)
// tab-esm-purchase.html 에서 x-data="esmPurchaseApp()" 으로 사용
// ⚠️ 별도 파일로 분리: 템플릿(x-if) 안의 <script> 는 실행되지 않으므로
//    (statements.js 와 동일 패턴) index.html 에서 <script src="/esm-purchase.js"> 로 로드
// API: /api/esm-purchase/*  (컴퍼니와 완전 분리) · 출력: 이카운트용 엑셀
// ══════════════════════════════════════════════════════════
function esmPurchaseApp() {
  return {
    list: [], loadingList: false,
    selectedId: null, vendor: {}, buyer: null, trxDate: '', lines: [], stats: {},
    imageUrl: '', loadingDetail: false,
    queue: { total: 0, done: 0, failed: 0, running: 0 },
    dragover: false, saving: false,

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
        const r = await fetch('/api/esm-purchase/history?limit=200', { credentials: 'include' }).then(r => r.json());
        if (r.ok) this.list = r.items || [];
      } catch (e) {} finally { this.loadingList = false; }
    },

    onFileInput(e) { this.uploadFiles(e.target.files); e.target.value = ''; },
    onDrop(e) { this.dragover = false; this.uploadFiles(e.dataTransfer.files); },

    async uploadFiles(fileList) {
      const files = Array.from(fileList).filter(f => (f.type || '').startsWith('image/'));
      if (!files.length) return;
      this.queue = { total: files.length, done: 0, failed: 0, running: files.length };
      let firstNewId = null;
      for (const f of files) {
        try {
          const fd = new FormData(); fd.append('file', f);
          const r = await fetch('/api/esm-purchase/parse', { method: 'POST', body: fd, credentials: 'include' }).then(r => r.json());
          if (r.ok) { this.queue.done++; if (!firstNewId) firstNewId = r.id; }
          else { this.queue.failed++; }
        } catch (e) { this.queue.failed++; }
        this.queue.running = this.queue.total - this.queue.done - this.queue.failed;
        await this.loadList();
      }
      this.queue.running = 0;
      if (firstNewId) this.openDetail(firstNewId);
    },

    async openDetail(id) {
      this.loadingDetail = true; this.selectedId = id;
      try {
        const r = await fetch('/api/esm-purchase/history/' + id, { credentials: 'include' }).then(r => r.json());
        if (r.ok) {
          this.vendor = r.vendor || {}; this.buyer = r.buyer || null;
          this.trxDate = r.trx_date || '';
          this.lines = (r.lines || []).map(l => ({ ...l, total_amt: (Number(l.supply_amt) || 0) + (Number(l.vat_amt) || 0) }));
          this.stats = r.stats || {};
          this.imageUrl = '/api/esm-purchase/history/' + id + '/image';
        }
      } catch (e) {} finally { this.loadingDetail = false; }
    },

    recalcLine(line, src) {
      if (src === 'supply') { line.vat_amt = Math.round((Number(line.supply_amt) || 0) * 0.1); }
      else { line.supply_amt = Math.round((Number(line.qty) || 0) * (Number(line.unit_price) || 0)); line.vat_amt = Math.round(line.supply_amt * 0.1); }
      line.total_amt = (Number(line.supply_amt) || 0) + (Number(line.vat_amt) || 0);
      if (src !== 'supply') line.status = line.item ? (line.code ? 'matched' : 'predicted') : 'unknown';
    },
    get totalSupply() { return this.lines.filter(l => !l.skip).reduce((s, l) => s + (Number(l.supply_amt) || 0), 0); },
    get totalVat() { return this.lines.filter(l => !l.skip).reduce((s, l) => s + (Number(l.vat_amt) || 0), 0); },
    get totalAmt() { return this.lines.filter(l => !l.skip).reduce((s, l) => s + (Number(l.total_amt) || 0), 0); },

    async exportExcel() {
      if (!this.selectedId) return;
      this.saving = true;
      try {
        const r = await fetch('/api/esm-purchase/export', {
          method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: this.selectedId, trx_date: this.trxDate, vendor_name: this.vendor.name, lines: this.lines }),
        });
        if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || '실패'); }
        const blob = await r.blob(); const url = URL.createObjectURL(blob);
        const a = document.createElement('a'); a.href = url;
        a.download = `에스엠매입_${this.trxDate || 'noday'}_${(this.vendor.name || 'vendor').replace(/[^\w가-힣]/g, '')}.xlsx`;
        a.click(); URL.revokeObjectURL(url);
        await this.loadList();
      } catch (e) { alert('엑셀 실패: ' + e.message); } finally { this.saving = false; }
    },

    async deleteStatement() {
      if (!this.selectedId) return;
      if (!confirm('이 명세서를 삭제할까요?')) return;
      try {
        const r = await fetch('/api/esm-purchase/history/' + this.selectedId, { method: 'DELETE', credentials: 'include' }).then(r => r.json());
        if (r.ok) { this.selectedId = null; this.lines = []; this.vendor = {}; this.imageUrl = ''; await this.loadList(); }
        else alert('삭제 실패');
      } catch (e) { alert(e.message); }
    },

    nextStatement() {
      const i = this.list.findIndex(x => x.id === this.selectedId);
      if (i >= 0 && i < this.list.length - 1) this.openDetail(this.list[i + 1].id);
    },

    fmt(n) { return (Number(n) || 0).toLocaleString(); },
    fmtTime(ts) { if (!ts) return ''; const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; },
  };
}
