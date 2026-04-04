// ═══════════════════════════════════════════════
// 연락처 앱 - 업체 > 현장 > 사람 3단 구조
// index.html에서 x-data="contactsApp()" 으로 사용
// 기존 API 3개를 조합해 클라이언트에서 트리 구성
// ═══════════════════════════════════════════════

function contactsApp() {
  return {
    // ── 상태 ──
    tree: [],           // [{id, name, projects:[{id,name,address,contacts:[]}], directContacts:[]}]
    companies: [],      // 업체 목록 (필터용)
    loading: true,
    searchQ: '',
    filterCompanyId: '',
    expandedCompanies: new Set(),
    expandedProjects: new Set(),
    // 인라인 편집
    inlineEditing: null,
    inlineEditField: null,
    inlineEditValue: '',
    // 그룹 헤더 편집 (더블클릭)
    editingHeaderId: null,
    editingHeaderValue: '',
    editingHeaderType: '', // 'company' | 'project'
    // 주소 편집
    editingAddressId: null,
    editingAddressValue: '',
    // 드래그앤드롭 (연락처 이동)
    draggingContact: null,
    dragOverTarget: null,
    // 드래그앤드롭 (순서 변경)
    reorderType: '',             // 'company' | 'project'
    reorderDragId: '',           // 드래그 중인 업체/현장 ID
    reorderOverId: '',           // 드롭 대상 ID
    reorderParentId: '',         // 현장 드래그 시 소속 업체 ID
    // 다중선택 + 일괄이동
    selectedIds: new Set(),      // 선택된 연락처 ID
    showMovePanel: false,        // 이동 패널 표시
    moveTargetCompanyId: '',     // 이동 대상 업체
    moveTargetProjectId: '',     // 이동 대상 현장
    // 토스트
    toast2: '',
    toast2Show: false,

    // ── 초기화 ──
    async init() {
      await this.loadTree();
      // 대림SM(내부) 기본 펼침
      var self = this;
      this.tree.forEach(function(comp) {
        if (comp.name && comp.name.indexOf('대림SM') >= 0) {
          self.expandedCompanies.add(comp.id);
          comp.projects.forEach(function(p) { self.expandedProjects.add(p.id); });
        }
      });
      this.expandedCompanies = new Set(this.expandedCompanies);
      this.expandedProjects = new Set(this.expandedProjects);
    },

    // ── 데이터 로딩 (클라이언트에서 트리 구성) ──
    async loadTree() {
      this.loading = true;
      try {
        var results = await Promise.all([
          fetch('/api/contacts/companies').then(function(r) { return r.ok ? r.json() : []; }),
          fetch('/api/contacts/projects').then(function(r) { return r.ok ? r.json() : []; }),
          fetch('/api/contacts/all').then(function(r) { return r.ok ? r.json() : []; })
        ]);
        var comps = results[0];
        var projs = results[1];
        var contacts = results[2];
      } catch(e) {
        var comps = []; var projs = []; var contacts = [];
      }

      var q = (this.searchQ || '').trim().toLowerCase();

      // 검색 필터: 연락처
      if (q) {
        contacts = contacts.filter(function(c) {
          return (c.name || '').toLowerCase().indexOf(q) >= 0 ||
            (c.company || '').toLowerCase().indexOf(q) >= 0 ||
            (c.position || '').toLowerCase().indexOf(q) >= 0 ||
            (c.phone || '').indexOf(q) >= 0 ||
            (c.mobile || '').indexOf(q) >= 0 ||
            (c.email || '').toLowerCase().indexOf(q) >= 0 ||
            (c.note || '').toLowerCase().indexOf(q) >= 0;
        });
      }

      // order 기준 정렬
      comps.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });
      projs.sort(function(a, b) { return (a.order || 0) - (b.order || 0); });

      // 업체별 프로젝트 맵
      var projByCompany = {};
      projs.forEach(function(p) {
        if (!projByCompany[p.companyId]) projByCompany[p.companyId] = [];
        projByCompany[p.companyId].push(p);
      });

      // 프로젝트별 연락처 맵
      var contactByProject = {};
      var contactNoProject = {};
      var contactOrphan = [];

      contacts.forEach(function(c) {
        if (c.projectId) {
          if (!contactByProject[c.projectId]) contactByProject[c.projectId] = [];
          contactByProject[c.projectId].push(c);
        } else if (c.companyId) {
          if (!contactNoProject[c.companyId]) contactNoProject[c.companyId] = [];
          contactNoProject[c.companyId].push(c);
        } else if (c.company) {
          var matched = comps.find(function(comp) { return comp.name === c.company; });
          if (matched) {
            if (!contactNoProject[matched.id]) contactNoProject[matched.id] = [];
            contactNoProject[matched.id].push(c);
          } else {
            contactOrphan.push(c);
          }
        } else {
          contactOrphan.push(c);
        }
      });

      // 검색 시 현장명도 매치 — 해당 현장의 모든 연락처 포함
      if (q) {
        var allContacts = await fetch('/api/contacts/all').then(function(r) { return r.ok ? r.json() : []; }).catch(function() { return []; });
        projs.forEach(function(p) {
          if ((p.name || '').toLowerCase().indexOf(q) >= 0 || (p.address || '').toLowerCase().indexOf(q) >= 0) {
            var allInProj = allContacts.filter(function(c) { return c.projectId === p.id; });
            allInProj.forEach(function(c) {
              if (!contactByProject[p.id]) contactByProject[p.id] = [];
              if (!contactByProject[p.id].find(function(x) { return x.id === c.id; })) {
                contactByProject[p.id].push(c);
              }
            });
          }
        });
      }

      // 트리 구성
      var tree = [];
      comps.forEach(function(comp) {
        var compProjects = (projByCompany[comp.id] || []).map(function(proj) {
          return Object.assign({}, proj, { contacts: contactByProject[proj.id] || [] });
        });
        var noProjectContacts = contactNoProject[comp.id] || [];

        // 검색 시: 연락처가 없는 현장은 숨김 (매칭된 현장명이면 유지)
        if (q) {
          compProjects = compProjects.filter(function(p) {
            return p.contacts.length > 0 ||
              (p.name || '').toLowerCase().indexOf(q) >= 0 ||
              (p.address || '').toLowerCase().indexOf(q) >= 0;
          });
        }

        var hasContent = compProjects.some(function(p) { return p.contacts.length > 0; }) || noProjectContacts.length > 0;
        if (q && !hasContent && (comp.name || '').toLowerCase().indexOf(q) < 0) return;

        tree.push({
          id: comp.id,
          name: comp.name,
          note: comp.note || '',
          projects: compProjects,
          directContacts: noProjectContacts
        });
      });

      // 미분류 연락처
      if (contactOrphan.length > 0) {
        tree.push({
          id: '_orphan',
          name: '미분류',
          note: '',
          projects: [],
          directContacts: contactOrphan
        });
      }

      this.tree = tree;
      this.loading = false;
      this.buildCompanyFilter();

      // 검색 시 모두 펼침
      if (q) {
        var self = this;
        this.tree.forEach(function(comp) {
          self.expandedCompanies.add(comp.id);
          comp.projects.forEach(function(p) { self.expandedProjects.add(p.id); });
        });
        this.expandedCompanies = new Set(this.expandedCompanies);
        this.expandedProjects = new Set(this.expandedProjects);
      }
    },

    buildCompanyFilter() {
      this.companies = this.tree.filter(function(c) { return c.id !== '_orphan'; }).map(function(c) { return { id: c.id, name: c.name }; });
    },

    get filteredTree() {
      if (!this.filterCompanyId) return this.tree;
      var fid = this.filterCompanyId;
      return this.tree.filter(function(c) { return c.id === fid; });
    },

    totalContacts() {
      var count = 0;
      this.tree.forEach(function(comp) {
        count += (comp.directContacts || []).length;
        comp.projects.forEach(function(p) { count += (p.contacts || []).length; });
      });
      return count;
    },

    // ── 펼치기/접기 ──
    toggleCompany(id) {
      if (this.expandedCompanies.has(id)) this.expandedCompanies.delete(id);
      else this.expandedCompanies.add(id);
      this.expandedCompanies = new Set(this.expandedCompanies);
    },
    toggleProject(id) {
      if (this.expandedProjects.has(id)) this.expandedProjects.delete(id);
      else this.expandedProjects.add(id);
      this.expandedProjects = new Set(this.expandedProjects);
    },
    expandAll() {
      var self = this;
      this.tree.forEach(function(comp) {
        self.expandedCompanies.add(comp.id);
        comp.projects.forEach(function(p) { self.expandedProjects.add(p.id); });
      });
      this.expandedCompanies = new Set(this.expandedCompanies);
      this.expandedProjects = new Set(this.expandedProjects);
    },
    collapseAll() {
      this.expandedCompanies = new Set();
      this.expandedProjects = new Set();
    },

    // ── 업체 헤더 더블클릭 수정 ──
    startEditHeader(id, name, type) {
      this.editingHeaderId = id;
      this.editingHeaderValue = name;
      this.editingHeaderType = type;
      this.$nextTick(function() {
        var inp = document.querySelector('[data-header-edit="' + id + '"]');
        if (inp) { inp.focus(); inp.select(); }
      });
    },
    async saveEditHeader() {
      var id = this.editingHeaderId;
      var val = this.editingHeaderValue.trim();
      var type = this.editingHeaderType;
      if (!val || !id) { this.editingHeaderId = null; return; }
      var url = type === 'company' ? '/api/contacts/companies/' + id : '/api/contacts/projects/' + id;
      var body = { name: val };
      await fetch(url, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      this.editingHeaderId = null;
      await this.loadTree();
      this.showToast2('이름 수정됨');
    },
    cancelEditHeader() { this.editingHeaderId = null; },

    // ── 새 업체 추가 ──
    async addCompany() {
      var res = await fetch('/api/contacts/companies', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: '새 업체' })
      }).then(function(r) { return r.json(); });
      await this.loadTree();
      this.expandedCompanies.add(res.id);
      this.expandedCompanies = new Set(this.expandedCompanies);
      var self = this;
      this.$nextTick(function() { self.startEditHeader(res.id, res.name, 'company'); });
    },

    // ── 새 현장 추가 ──
    async addProject(companyId) {
      var res = await fetch('/api/contacts/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyId: companyId, name: '새 현장' })
      }).then(function(r) { return r.json(); });
      await this.loadTree();
      this.expandedCompanies.add(companyId);
      this.expandedProjects.add(res.id);
      this.expandedCompanies = new Set(this.expandedCompanies);
      this.expandedProjects = new Set(this.expandedProjects);
      var self = this;
      this.$nextTick(function() { self.startEditHeader(res.id, res.name, 'project'); });
    },

    // ── 현장 주소 수정 ──
    startEditAddress(projId, addr) {
      this.editingAddressId = projId;
      this.editingAddressValue = addr || '';
      this.$nextTick(function() {
        var inp = document.querySelector('[data-addr-edit="' + projId + '"]');
        if (inp) { inp.focus(); inp.select(); }
      });
    },
    async saveEditAddress() {
      var id = this.editingAddressId;
      var val = this.editingAddressValue.trim();
      await fetch('/api/contacts/projects/' + id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address: val })
      });
      this.editingAddressId = null;
      await this.loadTree();
      this.showToast2('주소 수정됨');
    },
    cancelEditAddress() { this.editingAddressId = null; },

    // ── 인라인 편집 (연락처 셀) ──
    isEditing(c, field) {
      return this.inlineEditing && this.inlineEditing.id === c.id && this.inlineEditField === field;
    },
    startInlineEdit(c, field) {
      this.inlineEditing = { id: c.id };
      this.inlineEditField = field;
      this.inlineEditValue = c[field] || '';
      this.$nextTick(function() {
        var sel = '[data-inline="' + c.id + '-' + field + '"]';
        var inp = document.querySelector(sel);
        if (inp) { inp.focus(); inp.select(); }
      });
    },
    async saveInlineEdit(c) {
      var oldVal = c[this.inlineEditField] || '';
      if (this.inlineEditValue === oldVal) { this.inlineEditing = null; return; }
      var upd = {};
      upd[this.inlineEditField] = this.inlineEditValue;
      c[this.inlineEditField] = this.inlineEditValue;
      await fetch('/api/contacts/' + c.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upd)
      });
      this.inlineEditing = null;
      this.showToast2(c.name + ' 저장됨');
    },
    cancelInlineEdit() { this.inlineEditing = null; },

    // ── 새 연락처 ──
    async addContact(companyId, projectId) {
      var comp = this.tree.find(function(c) { return c.id === companyId; });
      var compName = comp ? comp.name : '';
      var proj = comp ? (comp.projects || []).find(function(p) { return p.id === projectId; }) : null;
      var noteName = proj ? proj.name : '';

      var body = {
        name: '', company: compName, companyId: companyId,
        projectId: projectId || '', mobile: '', position: '',
        phone: '', email: '', note: noteName
      };
      var saved = await fetch('/api/contacts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function(r) { return r.json(); });
      await this.loadTree();
      this.expandedCompanies.add(companyId);
      if (projectId) this.expandedProjects.add(projectId);
      this.expandedCompanies = new Set(this.expandedCompanies);
      this.expandedProjects = new Set(this.expandedProjects);
      var self = this;
      this.$nextTick(function() { self.startInlineEdit(saved, 'name'); });
    },

    // ── 삭제 ──
    async deleteContact(c) {
      if (!confirm(c.name + ' 연락처를 삭제할까요?')) return;
      await fetch('/api/contacts/' + c.id, { method: 'DELETE' });
      await this.loadTree();
    },
    async deleteCompany(comp) {
      var total = (comp.directContacts || []).length;
      comp.projects.forEach(function(p) { total += (p.contacts || []).length; });
      if (!confirm(comp.name + ' 업체와 소속 연락처 ' + total + '명을 모두 삭제할까요?')) return;
      await fetch('/api/contacts/companies/' + comp.id, { method: 'DELETE' });
      await this.loadTree();
      this.showToast2(comp.name + ' 삭제됨');
    },
    async deleteProject(proj) {
      var total = (proj.contacts || []).length;
      if (!confirm(proj.name + ' 현장과 소속 연락처 ' + total + '명을 모두 삭제할까요?')) return;
      await fetch('/api/contacts/projects/' + proj.id, { method: 'DELETE' });
      await this.loadTree();
      this.showToast2(proj.name + ' 삭제됨');
    },

    // ── 복사 ──
    copyText(c) {
      // 트리에서 현장명/업체명 찾기
      var siteName = c.note || '';
      var compName = c.company || '';
      var self = this;
      if (c.projectId) {
        this.tree.forEach(function(comp) {
          comp.projects.forEach(function(proj) {
            if (proj.id === c.projectId) {
              siteName = proj.name || siteName;
              compName = compName || comp.name;
            }
          });
        });
      }
      if (!compName && c.companyId) {
        this.tree.forEach(function(comp) {
          if (comp.id === c.companyId) compName = comp.name;
        });
      }

      var lines = [];
      var nameStr = c.name || '';
      if (c.position) nameStr += ' ' + c.position;
      if (compName) nameStr += ' (' + compName + ')';
      lines.push(nameStr);
      if (siteName) {
        // 내부연락망(대림SM 등)이면 "소속", 나머지는 "현장"
        var isInternal = (compName || '').indexOf('내부') >= 0 || (compName || '').indexOf('대림SM') >= 0;
        lines.push((isInternal ? '소속: ' : '현장: ') + siteName);
      }
      if (c.mobile) lines.push('휴대폰: ' + c.mobile);
      if (c.phone) lines.push('내선: ' + c.phone);
      if (c.email) lines.push('이메일: ' + c.email);
      var t = lines.join('\n');
      if (navigator.clipboard && window.isSecureContext) {
        navigator.clipboard.writeText(t);
      } else {
        var el = document.createElement('textarea');
        el.value = t; el.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(el); el.select();
        document.execCommand('copy'); document.body.removeChild(el);
      }
      this.showToast2(c.name + ' 복사됨');
    },

    // ── 드래그앤드롭 (현장 이동) ──
    onDragStart(e, contact) {
      this.draggingContact = contact;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', contact.id);
      // 드래그 이미지 설정
      var ghost = e.target.closest('tr');
      if (ghost) {
        ghost.style.opacity = '0.5';
        setTimeout(function() { ghost.style.opacity = ''; }, 0);
      }
    },
    onDragEnd(e) {
      this.draggingContact = null;
      this.dragOverTarget = null;
      // 모든 드롭 하이라이트 제거
      document.querySelectorAll('.ct-drop-active').forEach(function(el) { el.classList.remove('ct-drop-active'); });
    },
    onDragOverProject(e, companyId, projectId) {
      if (!this.draggingContact) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.dragOverTarget = { companyId: companyId, projectId: projectId };
    },
    onDragLeaveProject(e) {
      // relatedTarget가 자식이면 무시
      if (e.currentTarget.contains(e.relatedTarget)) return;
      this.dragOverTarget = null;
    },
    isDragOver(companyId, projectId) {
      return this.dragOverTarget &&
        this.dragOverTarget.companyId === companyId &&
        this.dragOverTarget.projectId === projectId;
    },
    async onDropProject(e, companyId, projectId) {
      e.preventDefault();
      var c = this.draggingContact;
      if (!c) return;
      this.dragOverTarget = null;
      this.draggingContact = null;

      // 같은 현장이면 무시
      if (c.projectId === projectId && c.companyId === companyId) return;

      // 현장명 찾기
      var projName = '';
      var compName = '';
      var self = this;
      this.tree.forEach(function(comp) {
        if (comp.id === companyId) {
          compName = comp.name;
          comp.projects.forEach(function(p) {
            if (p.id === projectId) projName = p.name;
          });
        }
      });

      // API로 연락처 업데이트
      var upd = { companyId: companyId, projectId: projectId, company: compName, note: projName };
      await fetch('/api/contacts/' + c.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upd)
      });
      await this.loadTree();
      this.showToast2((c.name || '연락처') + ' → ' + (projName || '미배정') + ' 이동됨');
    },
    // 현장 미배정으로 드롭
    async onDropDirect(e, companyId) {
      e.preventDefault();
      var c = this.draggingContact;
      if (!c) return;
      this.dragOverTarget = null;
      this.draggingContact = null;

      if (!c.projectId && c.companyId === companyId) return;

      var compName = '';
      this.tree.forEach(function(comp) { if (comp.id === companyId) compName = comp.name; });

      var upd = { companyId: companyId, projectId: '', company: compName, note: '' };
      await fetch('/api/contacts/' + c.id, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(upd)
      });
      await this.loadTree();
      this.showToast2((c.name || '연락처') + ' → 미배정 이동됨');
    },

    // ── 업체/현장 순서 변경 ──
    onReorderDragStart(e, type, id, parentId) {
      this.reorderType = type;
      this.reorderDragId = id;
      this.reorderParentId = parentId || '';
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', id);
      var el = e.target.closest('.ct-comp-hdr, .ct-proj-hdr');
      if (el) { el.style.opacity = '0.4'; setTimeout(function() { el.style.opacity = ''; }, 0); }
    },
    onReorderDragEnd(e) {
      this.reorderDragId = '';
      this.reorderOverId = '';
      this.reorderType = '';
      this.reorderParentId = '';
    },
    onReorderDragOver(e, type, id) {
      if (!this.reorderDragId || this.reorderType !== type) return;
      if (this.reorderDragId === id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.reorderOverId = id;
    },
    onReorderDragLeave(e, id) {
      if (this.reorderOverId === id) this.reorderOverId = '';
    },
    async onReorderDrop(e, type, targetId) {
      e.preventDefault();
      if (!this.reorderDragId || this.reorderType !== type) return;
      var dragId = this.reorderDragId;
      this.reorderDragId = '';
      this.reorderOverId = '';
      this.reorderType = '';
      if (dragId === targetId) return;

      if (type === 'company') {
        // 업체 순서 변경
        var items = this.tree.map(function(c) { return c.id; });
        var fromIdx = items.indexOf(dragId);
        var toIdx = items.indexOf(targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        items.splice(fromIdx, 1);
        items.splice(toIdx, 0, dragId);
        // order 필드 업데이트
        for (var i = 0; i < items.length; i++) {
          await fetch('/api/contacts/companies/' + items[i], {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: i })
          });
        }
      } else if (type === 'project') {
        // 현장 순서 변경 (같은 업체 내)
        var comp = this.tree.find(function(c) { return c.id === this.reorderParentId; }.bind(this));
        if (!comp) {
          // parentId로 못 찾으면 targetId가 속한 업체 찾기
          var self = this;
          this.tree.forEach(function(c) {
            c.projects.forEach(function(p) {
              if (p.id === dragId || p.id === targetId) comp = c;
            });
          });
        }
        if (!comp) return;
        var pIds = comp.projects.map(function(p) { return p.id; });
        var fromIdx = pIds.indexOf(dragId);
        var toIdx = pIds.indexOf(targetId);
        if (fromIdx < 0 || toIdx < 0) return;
        pIds.splice(fromIdx, 1);
        pIds.splice(toIdx, 0, dragId);
        for (var i = 0; i < pIds.length; i++) {
          await fetch('/api/contacts/projects/' + pIds[i], {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ order: i })
          });
        }
      }
      await this.loadTree();
      this.showToast2('순서 변경됨');
    },

    // ── 다중선택 + 일괄이동 ──
    toggleSelect(contactId) {
      if (this.selectedIds.has(contactId)) this.selectedIds.delete(contactId);
      else this.selectedIds.add(contactId);
      this.selectedIds = new Set(this.selectedIds);
    },
    isSelected(contactId) {
      return this.selectedIds.has(contactId);
    },
    selectAllInProject(proj) {
      var self = this;
      var allSelected = proj.contacts.every(function(c) { return self.selectedIds.has(c.id); });
      proj.contacts.forEach(function(c) {
        if (allSelected) self.selectedIds.delete(c.id);
        else self.selectedIds.add(c.id);
      });
      this.selectedIds = new Set(this.selectedIds);
    },
    selectAllDirect(comp) {
      var self = this;
      var dc = comp.directContacts || [];
      var allSelected = dc.every(function(c) { return self.selectedIds.has(c.id); });
      dc.forEach(function(c) {
        if (allSelected) self.selectedIds.delete(c.id);
        else self.selectedIds.add(c.id);
      });
      this.selectedIds = new Set(this.selectedIds);
    },
    clearSelection() {
      this.selectedIds = new Set();
      this.showMovePanel = false;
    },
    openMovePanel() {
      this.moveTargetCompanyId = '';
      this.moveTargetProjectId = '';
      this.showMovePanel = true;
    },
    get moveProjectOptions() {
      if (!this.moveTargetCompanyId) return [];
      var cid = this.moveTargetCompanyId;
      var comp = this.tree.find(function(c) { return c.id === cid; });
      return comp ? comp.projects : [];
    },
    async executeBulkMove() {
      var ids = Array.from(this.selectedIds);
      if (ids.length === 0) return;
      var compId = this.moveTargetCompanyId;
      var projId = this.moveTargetProjectId;
      if (!compId) { this.showToast2('업체를 선택하세요'); return; }

      // 업체/현장명 찾기
      var compName = '';
      var projName = '';
      this.tree.forEach(function(comp) {
        if (comp.id === compId) {
          compName = comp.name;
          comp.projects.forEach(function(p) {
            if (p.id === projId) projName = p.name;
          });
        }
      });

      // 일괄 업데이트
      var upd = { companyId: compId, projectId: projId || '', company: compName, note: projName };
      for (var i = 0; i < ids.length; i++) {
        await fetch('/api/contacts/' + ids[i], {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(upd)
        });
      }
      this.showMovePanel = false;
      this.selectedIds = new Set();
      await this.loadTree();
      this.showToast2(ids.length + '명 → ' + (projName || compName) + ' 이동 완료');
    },

    // ── 유틸 ──
    avatarColor(name) {
      var cs = ['#6366f1', '#8b5cf6', '#ec4899', '#f59e0b', '#10b981', '#3b82f6', '#ef4444', '#14b8a6'];
      return cs[(name || '?').charCodeAt(0) % cs.length];
    },
    showToast2(msg) {
      this.toast2 = msg; this.toast2Show = true;
      var self = this;
      setTimeout(function() { self.toast2Show = false; }, 2000);
    }
  };
}
