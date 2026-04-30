// photos.js - 사진 라이브러리 Alpine 컴포넌트
function photosApp() {
  return {
    // 검색 상태
    searchQ: '',
    filterCat: '',
    filterCon: '',
    filterSite: '',
    bestOnly: false,
    includeHidden: false,
    conQ: '',
    siteQ: '',

    // 데이터
    items: [],
    total: 0,
    limit: 100,
    offset: 0,
    stats: { visible: 0, byCategory: [], topConstructors: [], topSites: [] },

    // 모달
    selected: null,
    edit: {},
    saveMsg: '',

    // 동기화 모달
    syncOpen: false,
    syncDir: 'C:\\Users\\NAMGW\\Downloads',
    syncResult: null,

    async init() {
      await this.loadStats();
      await this.search();
    },

    async loadStats() {
      try {
        const r = await fetch('/api/photos/stats').then(r => r.json());
        if (r.ok) this.stats = r;
      } catch (e) { console.error(e); }
    },

    async search(resetPage = true) {
      if (resetPage) this.offset = 0;
      const params = new URLSearchParams();
      if (this.searchQ.trim()) params.set('q', this.searchQ.trim());
      if (this.filterCat) params.set('category', this.filterCat);
      if (this.filterCon) params.set('constructor', this.filterCon);
      if (this.filterSite) params.set('site', this.filterSite);
      if (this.bestOnly) params.set('best', '1');
      if (this.includeHidden) params.set('hidden', '1');
      params.set('limit', this.limit);
      params.set('offset', this.offset);
      try {
        const r = await fetch('/api/photos?' + params).then(r => r.json());
        if (r.ok) {
          this.items = r.items;
          this.total = r.total;
        }
      } catch (e) { console.error(e); }
    },

    next() { this.offset += this.limit; this.search(false); window.scrollTo(0, 0); },
    prev() { this.offset = Math.max(0, this.offset - this.limit); this.search(false); window.scrollTo(0, 0); },

    reset() {
      this.searchQ = ''; this.filterCat = ''; this.filterCon = ''; this.filterSite = '';
      this.bestOnly = false; this.includeHidden = false;
      this.conQ = ''; this.siteQ = '';
      this.search();
    },

    catClass(cat) {
      const m = { '용품':'cat', '시공현장':'cat-site', '시안주문서':'cat-order', '문서영수증':'cat-doc', '기타':'cat-etc' };
      return m[cat] || 'cat-etc';
    },

    filteredConstructors() {
      const q = this.conQ.toLowerCase();
      const arr = q ? this.stats.topConstructors.filter(c => c.name.toLowerCase().includes(q)) : this.stats.topConstructors;
      return arr.slice(0, 30);
    },
    filteredSites() {
      const q = this.siteQ.toLowerCase();
      const arr = q ? this.stats.topSites.filter(s => s.name.toLowerCase().includes(q)) : this.stats.topSites;
      return arr.slice(0, 30);
    },

    openModal(p) {
      this.selected = p;
      this.edit = {
        category: p.category || '',
        constructor: p.constructor || '',
        site: p.site || '',
        product: p.product || '',
        size_qty: p.size_qty || '',
        slogan: p.slogan || '',
        keywords: p.keywords || '',
        notes: p.notes || '',
      };
      this.saveMsg = '';
    },
    closeModal() { this.selected = null; this.saveMsg = ''; },

    async save() {
      if (!this.selected) return;
      try {
        const r = await fetch('/api/photos/' + this.selected.id, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.edit),
        }).then(r => r.json());
        if (r.ok) {
          this.selected = r.photo;
          this.saveMsg = '저장됨';
          // 그리드 갱신
          const idx = this.items.findIndex(x => x.id === r.photo.id);
          if (idx >= 0) this.items[idx] = r.photo;
          // 통계 다시
          this.loadStats();
        } else {
          this.saveMsg = '저장 실패: ' + r.error;
        }
      } catch (e) {
        this.saveMsg = '에러: ' + e.message;
      }
    },

    async toggleBest() {
      if (!this.selected) return;
      const newVal = !this.selected.is_best;
      const r = await fetch(`/api/photos/${this.selected.id}/label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_best: newVal }),
      }).then(r => r.json());
      if (r.ok) {
        this.selected = r.photo;
        const idx = this.items.findIndex(x => x.id === r.photo.id);
        if (idx >= 0) this.items[idx] = r.photo;
      }
    },
    async toggleHidden() {
      if (!this.selected) return;
      const newVal = !this.selected.is_hidden;
      const r = await fetch(`/api/photos/${this.selected.id}/label`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_hidden: newVal }),
      }).then(r => r.json());
      if (r.ok) {
        this.selected = r.photo;
        if (!this.includeHidden && r.photo.is_hidden) {
          // 그리드에서 빼기
          this.items = this.items.filter(x => x.id !== r.photo.id);
          this.total--;
        }
      }
    },

    async syncPreview() {
      try {
        const r = await fetch('/api/photos/sync-preview', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ downloadDir: this.syncDir }),
        }).then(r => r.json());
        if (r.ok) {
          this.syncResult = r;
        } else {
          alert('스캔 실패: ' + r.error);
        }
      } catch (e) {
        alert('에러: ' + e.message);
      }
    },
  };
}
