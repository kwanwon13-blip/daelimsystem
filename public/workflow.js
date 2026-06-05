function workflowApp() {
  return {
    loading: true,
    saving: false,
    jobs: [],
    stages: [],
    statuses: {},
    checkStatuses: {},
    orderTargets: [],
    orderStatuses: {},
    uploadLimits: { files: 20, fileSize: 100 * 1024 * 1024 },
    summary: { active: 0, overdue: 0, blocked: 0, unreadFiles: 0, unreadEvents: 0, scheduleCount: 0, myActions: 0, byStage: {} },
    selectedId: '',
    selectedWorkStageId: '',
    detail: null,
    query: '',
    statusFilter: 'active',
    scopeFilter: 'all',
    newOpen: false,
    newFiles: [],
    newUploadDragOver: false,
    currentUser: null,
    publicShareBaseUrl: '',
    contactOptions: [],
    designWorkflowOptions: { companies: [], projectsByCompany: {}, projectLookup: {}, masterCompanies: [] },
    workflowProjects: [],
    projectPanelOpen: false,
    projectQuery: '',
    projectStatusFilter: 'active',
    projectForm: {
      companyName: '',
      projectName: '',
      year: String(new Date().getFullYear()),
      status: 'active',
    },
    commentText: '',
    handoffText: '',
    uploadStageId: 'design',
    uploadKind: 'proof',
    uploadCompanyName: '',
    uploadProjectName: '',
    uploadNote: '',
    uploadDesignDueDate: '',
    uploadUrgent: false,
    uploadDragOver: false,
    uploadOpen: false,
    uploadProgress: { active: false, percent: 0, text: '' },
    fileStageFilter: 'all',
    fileKindFilter: 'all',
    filePreview: { open: false, file: null, zoom: 1, fit: true },
    expandedFileId: '',
    highlightedEventId: '',
    orderForm: {
      targetPreset: 'factory',
      targetType: 'internal',
      targetName: '우리공장',
      dueDate: '',
      mailTo: '',
      mailCc: '',
      note: '',
    },
    form: {
      title: '',
      companyName: '',
      projectName: '',
      contactName: '',
      contactPhone: '',
      dueDate: '',
      deliveryDate: '',
      priority: 'normal',
      summary: '',
    },

    async init() {
      if (!window.__workflowPrefillListenerInstalled) {
        window.addEventListener('workflow:prefill', e => {
          const root = document.querySelector('[x-data="workflowApp()"]');
          if (!root || !window.Alpine) return;
          window.Alpine.$data(root).applyWorkflowDraft(e.detail || {}, true);
        });
        window.__workflowPrefillListenerInstalled = true;
      }
      if (!window.__workflowOpenListenerInstalled) {
        window.addEventListener('workflow:open', e => {
          const root = document.querySelector('[x-data="workflowApp()"]');
          if (!root || !window.Alpine) return;
          const app = window.Alpine.$data(root);
          const jobId = e.detail?.jobId || '';
          const itemId = e.detail?.itemId || '';
          if (jobId && app?.openWorkflowTarget) {
            Promise.resolve(app.openWorkflowTarget(jobId, itemId));
          }
        });
        window.__workflowOpenListenerInstalled = true;
      }
      await Promise.all([this.loadAuth(), this.loadMeta(), this.loadContacts(), this.loadDesignWorkflowOptions()]);
      if (!this.form.dueDate) this.form.dueDate = this.defaultWorkDate();
      await this.loadJobs();
      this.consumeWorkflowDraft();
      await this.consumeWorkflowOpenTarget();
    },

    async loadAuth() {
      try {
        const r = await fetch('/api/auth/me');
        const d = await r.json();
        this.currentUser = d && d.loggedIn ? d : null;
      } catch (_) {
        this.currentUser = null;
      }
    },

    async loadMeta() {
      const r = await fetch('/api/workflow/meta');
      const d = await r.json();
      this.stages = d.stages || [];
      this.statuses = d.statuses || {};
      this.checkStatuses = d.checkStatuses || {};
      this.orderTargets = d.orderTargets || [];
      this.orderStatuses = d.orderStatuses || {};
      this.publicShareBaseUrl = d.publicBaseUrl || '';
      this.uploadLimits = d.uploadLimits || this.uploadLimits;
    },

    async loadContacts() {
      try {
        const contacts = await fetch('/api/contacts/all').then(r => r.ok ? r.json() : []);
        this.contactOptions = (contacts || []).slice(0, 1000).map(c => ({
          name: c.name || '',
          company: c.company || '',
          phone: c.mobile || c.phone || '',
          email: c.email || '',
        })).filter(c => c.name || c.company);
      } catch (_) {
        this.contactOptions = [];
      }
    },

    async loadDesignWorkflowOptions() {
      try {
        const [workflowResult, mastersResult, projectsResult] = await Promise.allSettled([
          fetch('/api/design/workflow-options'),
          fetch('/api/product-design/masters'),
          fetch('/api/workflow/projects'),
        ]);
        const r = workflowResult.status === 'fulfilled' ? workflowResult.value : null;
        const d = r ? await r.json() : {};
        let masterCompanies = [];
        let managedProjects = [];
        if (mastersResult.status === 'fulfilled' && mastersResult.value.ok) {
          const md = await mastersResult.value.json().catch(() => ({}));
          masterCompanies = ((md.masters && md.masters.brands) || []).map(company => ({
            name: company.name || '',
            folderName: company.name || '',
            count: Number(company.count || 0),
            projectCount: 0,
            source: 'design-master',
          })).filter(company => company.name);
        }
        if (projectsResult.status === 'fulfilled' && projectsResult.value.ok) {
          const pd = await projectsResult.value.json().catch(() => ({}));
          managedProjects = Array.isArray(pd.projects) ? pd.projects : [];
        }
        this.workflowProjects = managedProjects;
        const projectCompanies = this.workflowCompaniesFromProjects(managedProjects);
        if (r && r.ok && d.ok) {
          const workflowCompanies = Array.isArray(d.companies) ? d.companies : [];
          this.designWorkflowOptions = {
            companies: this.mergeWorkflowCompanies(projectCompanies, workflowCompanies, masterCompanies),
            projectsByCompany: d.projectsByCompany || {},
            projectLookup: d.projectLookup || {},
            masterCompanies,
          };
        } else if (masterCompanies.length || projectCompanies.length) {
          this.designWorkflowOptions = { companies: this.mergeWorkflowCompanies(projectCompanies, masterCompanies), projectsByCompany: {}, projectLookup: {}, masterCompanies };
        }
      } catch (_) {
        this.workflowProjects = [];
        this.designWorkflowOptions = { companies: [], projectsByCompany: {}, projectLookup: {}, masterCompanies: [] };
      }
    },

    async loadSummary() {
      try {
        const r = await fetch('/api/workflow/summary');
        const d = await r.json();
        if (r.ok && d.ok) this.summary = d.summary || this.summary;
      } catch (_) {}
    },

    async loadJobs() {
      this.loading = true;
      const qs = new URLSearchParams();
      if (this.query.trim()) qs.set('q', this.query.trim());
      if (this.statusFilter) qs.set('status', this.statusFilter);
      if (this.scopeFilter && this.scopeFilter !== 'all') qs.set('scope', this.scopeFilter);
      try {
        const r = await fetch('/api/workflow/jobs?' + qs.toString());
        const d = await r.json();
        this.jobs = d.jobs || [];
        if (this.selectedId && !this.jobs.find(j => j.id === this.selectedId)) this.selectedId = '';
        if (!this.selectedId) this.detail = null;
        if (this.selectedId) await this.refreshDetail(false);
        await this.loadSummary();
      } finally {
        this.loading = false;
      }
    },

    workflowOpenTargetFromLocation() {
      const hash = String(window.location.hash || '').replace(/^#/, '');
      if (!hash) return {};
      if (hash.startsWith('workflow:')) {
        const [, jobId = '', itemId = ''] = hash.split(':');
        return { jobId: decodeURIComponent(jobId || ''), itemId: decodeURIComponent(itemId || '') };
      }
      if (hash.startsWith('workflow?')) {
        const qs = new URLSearchParams(hash.slice('workflow?'.length));
        return { jobId: qs.get('job') || '', itemId: qs.get('file') || qs.get('event') || '' };
      }
      return {};
    },

    async consumeWorkflowOpenTarget() {
      let raw = '';
      let rawItemId = '';
      try {
        raw = sessionStorage.getItem('workflow:openJobId') || '';
        if (raw) sessionStorage.removeItem('workflow:openJobId');
        rawItemId = sessionStorage.getItem('workflow:openItemId') || '';
        if (rawItemId) sessionStorage.removeItem('workflow:openItemId');
      } catch (_) {}
      const fromHash = this.workflowOpenTargetFromLocation();
      const jobId = raw || fromHash.jobId || '';
      const itemId = rawItemId || fromHash.itemId || '';
      if (!jobId) return;
      await this.openWorkflowTarget(jobId, itemId);
    },

    async openWorkflowTarget(jobId, itemId = '') {
      if (!jobId) return;
      this.query = '';
      this.statusFilter = 'all';
      this.scopeFilter = 'all';
      await this.loadJobs();
      await this.selectJob(jobId);
      this.focusWorkflowItem(itemId);
    },

    focusWorkflowItem(itemId = '') {
      const id = String(itemId || '').trim();
      this.highlightedEventId = '';
      if (!id || !this.detail) return;
      const files = this.detail.files || [];
      const events = this.detail.events || [];
      const file = files.find(f => f.id === id);
      if (file) {
        this.expandedFileId = file.id;
        this.scrollWorkflowDetailTo(`[data-workflow-file-id="${this.cssEscape(file.id)}"]`);
        return;
      }
      const event = events.find(e => e.id === id);
      if (event) {
        this.highlightedEventId = event.id;
        const linkedFileId = event.meta && event.meta.fileId ? String(event.meta.fileId) : '';
        if (linkedFileId) this.expandedFileId = linkedFileId;
        this.scrollWorkflowDetailTo(`[data-workflow-event-id="${this.cssEscape(event.id)}"]`);
      }
    },

    cssEscape(value) {
      const raw = String(value || '');
      if (window.CSS && typeof window.CSS.escape === 'function') return window.CSS.escape(raw);
      return raw.replace(/["\\]/g, '\\$&');
    },

    scrollWorkflowDetailTo(selector) {
      if (!selector) return;
      setTimeout(() => {
        try {
          const node = document.querySelector(selector);
          if (node && typeof node.scrollIntoView === 'function') node.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } catch (_) {}
      }, 80);
    },

    jobsForStage(stageId) {
      return this.jobs.filter(j => {
        if (Array.isArray(j.activeStageIds) && j.activeStageIds.length) return j.activeStageIds.includes(stageId);
        const check = this.stageCheck(j, stageId);
        if (check.status === 'ready' || check.status === 'blocked') return true;
        return (j.currentStage || 'design') === stageId && check.status !== 'done';
      });
    },

    stageCheck(job, stageId) {
      return (job.stageChecks && job.stageChecks[stageId]) || { status: 'pending' };
    },

    stageLabel(stageId) {
      const s = this.stages.find(x => x.id === stageId);
      return s ? s.label : stageId;
    },

    priorityLabel(p) {
      return ({ urgent: '긴급', high: '높음', normal: '보통', low: '낮음' })[p] || '보통';
    },

    checkLabel(status) {
      return this.checkStatuses[status] || status || '대기';
    },

    isPastDue(dateValue) {
      if (!dateValue) return false;
      const today = new Date().toISOString().slice(0, 10);
      return String(dateValue) < today;
    },

    isStageOverdue(stageId) {
      if (!this.detail || !this.detail.job) return false;
      const check = this.detail.job.stageChecks?.[stageId] || {};
      return check.status !== 'done' && this.isPastDue(check.dueDate);
    },

    stageChecklist(stageId) {
      if (!this.detail || !this.detail.job) return [];
      return this.detail.job.stageChecks?.[stageId]?.checklist || [];
    },

    checklistDoneCount(stageId) {
      return this.stageChecklist(stageId).filter(item => item.done).length;
    },

    async toggleChecklist(stageId, item) {
      if (!item) return;
      item.done = !item.done;
      item.updatedAt = new Date().toISOString();
      await this.saveStage(stageId);
    },

    isUnreadFile(file) {
      return !!(file && file.viewerUnread);
    },

    unreadFileItems() {
      return this.summary?.unreadFileItems || [];
    },

    unreadEventItems() {
      return this.summary?.unreadEventItems || [];
    },

    urgentFileItems() {
      return this.summary?.urgentFileItems || [];
    },

    myActionItems() {
      return this.summary?.myActionItems || [];
    },

    scheduleItems() {
      return this.summary?.scheduleItems || [];
    },

    workflowFocusItems() {
      const items = [];
      const push = (kind, label, title, meta, source, level = 'info') => {
        if (!source) return;
        items.push({
          key: `${kind}:${source.id || source.jobId || title}:${items.length}`,
          kind,
          label,
          title: title || '-',
          meta: meta || '',
          level,
          source,
        });
      };
      this.urgentFileItems().slice(0, 3).forEach(item => {
        push('urgentFile', '긴급', item.originalName, `${item.jobTitle || '-'} · 희망 ${item.designDueDate || '미정'}`, item, 'urgent');
      });
      this.scheduleItems()
        .filter(item => item.overdue || item.today)
        .slice(0, 3)
        .forEach(item => {
          push('schedule', item.overdue ? '지연' : '오늘', item.title, `${item.label || '일정'} · ${item.dueDate || ''}`, item, item.overdue ? 'urgent' : 'warn');
        });
      this.unreadFileItems().slice(0, 3).forEach(item => {
        push('unreadFile', '확인', item.originalName, `${item.jobTitle || '-'} · ${item.stageLabel || ''}`, item, 'info');
      });
      this.myActionItems().slice(0, 3).forEach(item => {
        push('action', item.overdue ? '위험' : '내 담당', item.title, `${item.stageLabel || ''}${item.dueDate ? ' · ' + item.dueDate : ''}`, item, item.overdue ? 'urgent' : 'info');
      });
      this.unreadEventItems().slice(0, 2).forEach(item => {
        push('event', '메모', item.message, `${item.jobTitle || '-'}${item.actorName ? ' · ' + item.actorName : ''}`, item, 'info');
      });
      return items.slice(0, 8);
    },

    focusItemClass(item) {
      if (!item) return 'info';
      return item.level === 'urgent' ? 'urgent' : item.level === 'warn' ? 'warn' : 'info';
    },

    async openFocusItem(item) {
      if (!item || !item.source) return;
      if (item.kind === 'schedule') return this.openScheduleItem(item.source);
      if (item.kind === 'action') return this.openActionJob(item.source);
      if (item.kind === 'event') return this.openUnreadEvent(item.source);
      return this.openUnreadFile(item.source);
    },

    deliverySummary() {
      return this.detail?.deliverySummary || {};
    },

    deliveryPendingTargets() {
      const summary = this.deliverySummary();
      const names = summary.pendingTargets || [];
      const overflow = Number(summary.pendingTargetOverflow || 0);
      return names.join(', ') + (overflow > 0 ? ` 외 ${overflow}` : '');
    },

    normalizeOptionName(value) {
      return String(value || '')
        .replace(/^[\u2605\u2606\u25cf\u25cb\u25a0\u25a1\s]+/gu, '')
        .toLowerCase()
        .replace(/[\u2605\u2606\u25cf\u25cb\u25a0\u25a1]/gu, '')
        .replace(/[\s._\-()（）\[\]{}]/g, '');
    },

    workflowCompaniesFromProjects(projects = []) {
      const map = new Map();
      for (const project of projects || []) {
        const name = String(project?.companyName || '').trim();
        const key = this.normalizeOptionName(name);
        if (!name || !key) continue;
        if (!map.has(key)) {
          map.set(key, {
            name,
            folderName: project.storageCompanyFolder || name,
            count: 0,
            projectCount: 0,
          });
        }
        const current = map.get(key);
        current.projectCount += 1;
        if (project.status !== 'done') current.count += 1;
      }
      return Array.from(map.values());
    },

    mergeWorkflowCompanies(...lists) {
      const map = new Map();
      const put = company => {
        const name = String(company?.name || '').trim();
        const folderName = String(company?.folderName || name).trim();
        const key = this.normalizeOptionName(name || folderName);
        if (!key) return;
        const current = map.get(key);
        if (!current) {
          map.set(key, {
            name: name || folderName,
            folderName,
            count: Number(company?.count || 0),
            folderCount: Number(company?.folderCount || 0),
            projectCount: Number(company?.projectCount || 0),
          });
          return;
        }
        current.count = Math.max(Number(current.count || 0), Number(company?.count || 0));
        current.folderCount = Math.max(Number(current.folderCount || 0), Number(company?.folderCount || 0));
        current.projectCount = Math.max(Number(current.projectCount || 0), Number(company?.projectCount || 0));
        if (!current.folderName && folderName) current.folderName = folderName;
      };
      lists.flat().forEach(put);
      return Array.from(map.values())
        .sort((a, b) => b.count - a.count || b.projectCount - a.projectCount || a.name.localeCompare(b.name, 'ko'));
    },

    optionMatchScore(value, term) {
      const key = this.normalizeOptionName(value);
      if (!term) return 0;
      if (!key) return 99;
      if (key === term) return 0;
      if (key.startsWith(term)) return 1;
      if (key.includes(term)) return 2;
      if (term.includes(key)) return 3;
      return 99;
    },

    managedProjectOptionsForCompany(companyName, includeCompleted = false) {
      const companyKey = this.normalizeOptionName(companyName);
      if (!companyKey) return [];
      return (this.workflowProjects || [])
        .filter(project => {
          const key = this.normalizeOptionName(project.companyName);
          if (!key || !(key === companyKey || key.includes(companyKey) || companyKey.includes(key))) return false;
          if (!includeCompleted && project.status === 'done') return false;
          return true;
        })
        .map(project => ({
          id: project.id || '',
          name: String(project.projectName || '').trim(),
          folderName: project.storageProjectFolder || project.projectName || '',
          yearFolder: project.storageYearFolder || (project.year ? `${project.year}\uB144 \uC2DC\uC548\uC791\uC5C5` : ''),
          count: Number(project.jobCount || 0),
          activeJobCount: Number(project.activeJobCount || 0),
          status: project.status || 'active',
          statusLabel: project.statusLabel || this.projectStatusLabel(project.status),
          storageBucket: project.storageBucket || '',
          source: project.source || 'project',
        }))
        .filter(project => project.name);
    },

    currentYearProjectOptionsForCompany(companyName) {
      const year = String(new Date().getFullYear());
      return this.projectOptionsForCompany(companyName)
        .filter(project => String(project?.yearFolder || '').startsWith(year))
        .map(project => ({
          ...project,
          status: 'active',
          statusLabel: '진행',
          source: 'folder',
        }));
    },

    workflowProjectOptionsForCompany(companyName, includeCompleted = false) {
      const managed = this.managedProjectOptionsForCompany(companyName, true);
      const managedKeys = new Set(managed.map(project => this.normalizeOptionName(project.name)));
      const visibleManaged = includeCompleted ? managed : managed.filter(project => project.status !== 'done');
      const unmanagedFolders = this.currentYearProjectOptionsForCompany(companyName)
        .filter(project => !managedKeys.has(this.normalizeOptionName(project.name)));
      return [...visibleManaged, ...unmanagedFolders];
    },

    projectNamesForCompany(companyName) {
      const key = this.normalizeOptionName(companyName);
      if (!key) return [];
      return this.workflowProjectOptionsForCompany(companyName, false).map(p => p.name || p).filter(Boolean);
    },

    projectOptionsForCompany(companyName) {
      const key = this.normalizeOptionName(companyName);
      if (!key) return [];
      const lookup = this.designWorkflowOptions.projectLookup || {};
      if (Array.isArray(lookup[key])) return lookup[key];
      const entries = Object.entries(this.designWorkflowOptions.projectsByCompany || {});
      const exact = entries.find(([company]) => this.normalizeOptionName(company) === key);
      const fuzzy = exact || entries.find(([company]) => {
        const c = this.normalizeOptionName(company);
        return c && (c.includes(key) || key.includes(c));
      });
      return fuzzy ? (fuzzy[1] || []) : [];
    },

    workflowCompanyOption(companyName) {
      const key = this.normalizeOptionName(companyName);
      if (!key) return null;
      const companies = this.designWorkflowOptions.companies || [];
      return companies.find(c => this.normalizeOptionName(c.name) === key || this.normalizeOptionName(c.folderName) === key)
        || companies.find(c => {
          const nameKey = this.normalizeOptionName(c.name);
          const folderKey = this.normalizeOptionName(c.folderName);
          return (nameKey && (nameKey.includes(key) || key.includes(nameKey)))
            || (folderKey && (folderKey.includes(key) || key.includes(folderKey)));
        }) || null;
    },

    workflowStorageLabel(companyName, projectName, yearValue) {
      const year = /^\d{4}$/.test(String(yearValue || '')) ? String(yearValue) : String(new Date().getFullYear());
      const company = String(companyName || '').trim();
      const project = String(projectName || '').trim();
      const companyOption = this.workflowCompanyOption(company);
      const companyFolder = companyOption?.folderName || company || '회사 미입력';
      const managedProject = this.currentWorkflowProject(company, project);
      if (managedProject?.storageBucket) return managedProject.storageBucket;
      const projectOptions = [
        ...this.workflowProjectOptionsForCompany(company, true),
        ...this.projectOptionsForCompany(company),
      ];
      const projectKey = this.normalizeOptionName(project);
      const exactProject = projectOptions.find(p => this.normalizeOptionName(p.name || p) === projectKey && String(p.yearFolder || '').startsWith(year))
        || projectOptions.find(p => this.normalizeOptionName(p.name || p) === projectKey);
      const yearProject = projectOptions.find(p => String(p.yearFolder || '').startsWith(year));
      const yearFolder = exactProject?.yearFolder || yearProject?.yearFolder || `${year}\uB144 \uC2DC\uC548\uC791\uC5C5`;
      return `${companyFolder} / ${yearFolder} / ${project || '프로젝트 미입력'}`;
    },

    workflowProjectSuggestions(companyName, limit = 8, query = '') {
      const seen = new Set();
      const term = this.normalizeOptionName(query);
      const includeCompleted = !!term;
      return this.workflowProjectOptionsForCompany(companyName, includeCompleted)
        .map(project => ({
          id: String(project?.id || '').trim(),
          name: String(project?.name || project || '').trim(),
          yearFolder: String(project?.yearFolder || '').trim(),
          count: Number(project?.count || 0),
          activeJobCount: Number(project?.activeJobCount || 0),
          status: project?.status || 'active',
          statusLabel: project?.statusLabel || this.projectStatusLabel(project?.status),
          source: project?.source || '',
        }))
        .filter(project => {
          const key = this.normalizeOptionName(project.name);
          if (!key || seen.has(key)) return false;
          if (!includeCompleted && project.status === 'done') return false;
          if (term && this.optionMatchScore(project.name, term) >= 99) return false;
          seen.add(key);
          return true;
        })
        .sort((a, b) => {
          const as = a.status === 'done' ? 1 : 0;
          const bs = b.status === 'done' ? 1 : 0;
          if (as !== bs) return as - bs;
          if (!term) return b.activeJobCount - a.activeJobCount || b.count - a.count || a.name.localeCompare(b.name, 'ko');
          return this.optionMatchScore(a.name, term) - this.optionMatchScore(b.name, term)
            || b.activeJobCount - a.activeJobCount
            || b.count - a.count
            || a.name.localeCompare(b.name, 'ko');
        })
        .slice(0, Number(limit || 8));
    },

    projectStatusLabel(status) {
      return status === 'done' ? '완료' : '진행';
    },

    projectBadge(project) {
      if (!project) return '';
      const parts = [this.projectStatusLabel(project.status)];
      if (project.yearFolder) parts.push(project.yearFolder);
      if (project.activeJobCount) parts.push(`작업 ${project.activeJobCount}`);
      return parts.filter(Boolean).join(' · ');
    },

    openProjectPanel() {
      if (!this.projectForm.year) this.projectForm.year = String(new Date().getFullYear());
      this.projectPanelOpen = true;
      this.loadDesignWorkflowOptions();
    },

    closeProjectPanel() {
      this.projectPanelOpen = false;
    },

    resetProjectForm(keepCompany = true) {
      const companyName = keepCompany ? this.projectForm.companyName : '';
      this.projectForm = {
        companyName,
        projectName: '',
        year: String(new Date().getFullYear()),
        status: 'active',
      };
    },

    filteredWorkflowProjects() {
      const term = this.normalizeOptionName(this.projectQuery);
      return (this.workflowProjects || [])
        .filter(project => {
          if (this.projectStatusFilter !== 'all' && project.status !== this.projectStatusFilter) return false;
          if (!term) return true;
          return [
            project.companyName,
            project.projectName,
            project.storageBucket,
            project.storageCompanyFolder,
            project.storageProjectFolder,
          ].some(value => this.normalizeOptionName(value).includes(term));
        })
        .sort((a, b) => {
          const as = a.status === 'done' ? 1 : 0;
          const bs = b.status === 'done' ? 1 : 0;
          if (as !== bs) return as - bs;
          return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
            || String(a.companyName || '').localeCompare(String(b.companyName || ''), 'ko')
            || String(a.projectName || '').localeCompare(String(b.projectName || ''), 'ko');
        });
    },

    currentWorkflowProject(companyName, projectName) {
      const companyKey = this.normalizeOptionName(companyName);
      const projectKey = this.normalizeOptionName(projectName);
      if (!companyKey || !projectKey) return null;
      return (this.workflowProjects || []).find(project => {
        const c = this.normalizeOptionName(project.companyName);
        const p = this.normalizeOptionName(project.projectName);
        return c === companyKey && p === projectKey;
      }) || null;
    },

    detailProjectStatus() {
      if (!this.detail?.job) return 'active';
      const project = this.currentWorkflowProject(this.detail.job.companyName, this.detail.job.projectName);
      return project?.status || (this.detail.job.status === 'done' ? 'done' : 'active');
    },

    async createWorkflowProjectFolder(companyName, projectName, year, status = 'active', options = {}) {
      const company = String(companyName || '').trim();
      const project = String(projectName || '').trim();
      const storageYear = /^\d{4}$/.test(String(year || '')) ? String(year) : String(new Date().getFullYear());
      if (!company) return alert('회사명을 입력하세요.');
      if (!project) return alert('프로젝트명을 입력하세요.');
      const r = await fetch('/api/workflow/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyName: company, projectName: project, year: storageYear, status }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '프로젝트 추가에 실패했습니다.');
      await this.loadDesignWorkflowOptions();
      const rel = d.folder?.rel || d.project?.storageBucket || '';
      if (!options.quiet) alert(rel ? `프로젝트를 준비했습니다.\n${rel}` : '프로젝트를 준비했습니다.');
      return d.project;
    },

    async createManagedProject() {
      const project = await this.createWorkflowProjectFolder(
        this.projectForm.companyName,
        this.projectForm.projectName,
        this.projectForm.year,
        this.projectForm.status,
        { quiet: true },
      );
      if (project) {
        this.projectQuery = project.projectName || this.projectForm.projectName;
        this.projectStatusFilter = 'all';
        this.resetProjectForm(true);
      }
    },

    async addFormProjectFolder() {
      return this.createWorkflowProjectFolder(this.form.companyName, this.form.projectName, this.newStorageYear(), 'active');
    },

    async addUploadProjectFolder() {
      return this.createWorkflowProjectFolder(this.uploadCompanyName, this.uploadProjectName, this.uploadStorageYear(), 'active');
    },

    async addDetailProjectFolder() {
      if (!this.detail?.job) return null;
      const year = String(this.detail.job.dueDate || '').slice(0, 4);
      return this.createWorkflowProjectFolder(this.detail.job.companyName, this.detail.job.projectName, year, this.detailProjectStatus());
    },

    async saveDetailProjectStatus(status) {
      if (!this.detail?.job) return;
      const companyName = String(this.detail.job.companyName || '').trim();
      const projectName = String(this.detail.job.projectName || '').trim();
      if (!companyName) return alert('회사명을 입력하세요.');
      if (!projectName) return alert('프로젝트명을 입력하세요.');
      let project = this.currentWorkflowProject(companyName, projectName);
      if (!project) {
        project = await this.createWorkflowProjectFolder(companyName, projectName, String(this.detail.job.dueDate || '').slice(0, 4), status);
        return project;
      }
      const r = await fetch('/api/workflow/projects/' + encodeURIComponent(project.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName,
          projectName,
          year: project.year || String(this.detail.job.dueDate || '').slice(0, 4),
          status,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '프로젝트 상태 저장에 실패했습니다.');
      await this.loadDesignWorkflowOptions();
      await this.loadJobs();
      await this.refreshDetail(false);
      return d.project;
    },

    async saveWorkflowProjectStatus(project, status) {
      if (!project) return;
      const r = await fetch('/api/workflow/projects/' + encodeURIComponent(project.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          companyName: project.companyName,
          projectName: project.projectName,
          year: project.year || String(new Date().getFullYear()),
          status,
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '프로젝트 상태 저장에 실패했습니다.');
      await this.loadDesignWorkflowOptions();
      await this.loadJobs();
      if (this.detail?.job) await this.refreshDetail(false);
      return d.project;
    },

    workflowCompanySuggestions(query = '', limit = 30) {
      const raw = String(query || '').trim();
      const term = this.normalizeOptionName(query);
      if (!raw || !term) return [];
      const seen = new Set();
      const suggestions = [];
      for (const company of this.designWorkflowOptions.companies || []) {
        const name = String(company?.name || '').trim();
        const folderName = String(company?.folderName || '').trim();
        const key = this.normalizeOptionName(name);
        const folderKey = this.normalizeOptionName(folderName);
        if (!name || seen.has(key)) continue;
        const score = Math.min(this.optionMatchScore(name, term), this.optionMatchScore(folderName, term));
        if (term && score >= 99) continue;
        seen.add(key);
        suggestions.push({
          name,
          folderName,
          count: Number(company?.count || 0),
          projectCount: Number(company?.projectCount || 0),
          score,
        });
      }
      if (term) {
        suggestions.sort((a, b) => a.score - b.score
          || b.count - a.count
          || b.projectCount - a.projectCount
          || a.name.localeCompare(b.name, 'ko'));
      }
      return suggestions.slice(0, Number(limit || 30));
    },

    workflowProjectNames(companyName = '', currentProjectName = '') {
      const names = [];
      names.push(...this.projectNamesForCompany(companyName));
      if (currentProjectName) names.push(currentProjectName);
      const companyKey = this.normalizeOptionName(companyName);
      if (this.detail?.job?.projectName && (!companyKey || this.normalizeOptionName(this.detail.job.companyName) === companyKey)) names.push(this.detail.job.projectName);
      for (const job of this.jobs || []) {
        if (job.projectName && (!companyKey || this.normalizeOptionName(job.companyName) === companyKey)) names.push(job.projectName);
      }
      return Array.from(new Set(names.filter(Boolean)));
    },

    workflowCompanyNames() {
      const names = [];
      const seen = new Set();
      const add = value => {
        const name = String(value || '').trim();
        const key = this.normalizeOptionName(name);
        if (!name || seen.has(key)) return;
        seen.add(key);
        names.push(name);
      };
      for (const company of this.designWorkflowOptions.companies || []) {
        if (company?.name) add(company.name);
      }
      if (this.detail?.job?.companyName) add(this.detail.job.companyName);
      for (const job of this.jobs || []) {
        if (job.companyName) add(job.companyName);
      }
      for (const contact of this.contactOptions || []) {
        if (contact.company) add(contact.company);
      }
      return names;
    },

    currentUserLabel() {
      if (!this.currentUser) return '로그인 사용자';
      return this.currentUser.name || this.currentUser.userId || '로그인 사용자';
    },

    formatDateInput(date) {
      const y = date.getFullYear();
      const m = String(date.getMonth() + 1).padStart(2, '0');
      const d = String(date.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    },

    addWorkingDays(baseDate, days) {
      const date = baseDate instanceof Date ? new Date(baseDate.getTime()) : new Date(baseDate || Date.now());
      date.setHours(12, 0, 0, 0);
      let remain = Number(days || 0);
      while (remain > 0) {
        date.setDate(date.getDate() + 1);
        const day = date.getDay();
        if (day !== 0 && day !== 6) remain -= 1;
      }
      return this.formatDateInput(date);
    },

    defaultWorkDate() {
      return this.addWorkingDays(new Date(), 3);
    },

    uploadStorageYear() {
      const dueYear = String(this.uploadDesignDueDate || '').slice(0, 4);
      if (/^\d{4}$/.test(dueYear)) return dueYear;
      return String(new Date().getFullYear());
    },

    newStorageYear() {
      const dueYear = String(this.form.dueDate || '').slice(0, 4);
      if (/^\d{4}$/.test(dueYear)) return dueYear;
      return String(new Date().getFullYear());
    },

    newStorageLabel() {
      return this.workflowStorageLabel(this.form.companyName, this.form.projectName, this.newStorageYear());
    },

    fileSizeLabel(size) {
      const n = Number(size || 0);
      if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
      if (n >= 1024) return `${Math.round(n / 1024)} KB`;
      return `${n} B`;
    },

    uploadFilesLimitLabel() {
      return `최대 ${this.uploadLimits.files || 20}개 · 파일당 ${this.fileSizeLabel(this.uploadLimits.fileSize || (100 * 1024 * 1024))}`;
    },

    fileListTotalSize(files) {
      return Array.from(files || []).reduce((sum, file) => sum + Number(file?.size || 0), 0);
    },

    fileBatchLabel(files) {
      const list = Array.from(files || []).filter(Boolean);
      if (!list.length) return this.uploadFilesLimitLabel();
      return `${list.length}개 · 총 ${this.fileSizeLabel(this.fileListTotalSize(list))}`;
    },

    fileBatchPreview(files, limit = 3) {
      const list = Array.from(files || []).filter(Boolean);
      const names = list.slice(0, Number(limit || 3)).map(file => file.name || 'file');
      const more = list.length > names.length ? ` 외 ${list.length - names.length}개` : '';
      return names.join(', ') + more;
    },

    validateUploadFileList(files) {
      const list = Array.from(files || []).filter(Boolean);
      const maxFiles = Number(this.uploadLimits.files || 20);
      const maxFileSize = Number(this.uploadLimits.fileSize || (100 * 1024 * 1024));
      if (list.length > maxFiles) return `한 번에 최대 ${maxFiles}개 파일까지만 업로드할 수 있습니다.`;
      const oversized = list.find(file => Number(file?.size || 0) > maxFileSize);
      if (oversized) return `${oversized.name || '파일'}이 너무 큽니다. 파일당 최대 ${this.fileSizeLabel(maxFileSize)}까지 업로드할 수 있습니다.`;
      return '';
    },

    setNewFiles(files) {
      const incoming = Array.from(files || []).filter(Boolean);
      if (!incoming.length) return;
      const error = this.validateUploadFileList([...this.newFiles, ...incoming]);
      if (error) return alert(error);
      const seen = new Set(this.newFiles.map(f => `${f.name}:${f.size}:${f.lastModified}`));
      for (const file of incoming) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (!seen.has(key)) {
          this.newFiles.push(file);
          seen.add(key);
        }
      }
    },

    handleNewFiles(ev) {
      this.setNewFiles(ev?.target?.files);
      if (ev?.target) ev.target.value = '';
    },

    handleNewDrop(ev) {
      ev.preventDefault();
      this.newUploadDragOver = false;
      this.setNewFiles(ev?.dataTransfer?.files);
    },

    removeNewFile(idx) {
      this.newFiles.splice(idx, 1);
    },

    clearNewFiles() {
      this.newFiles = [];
      this.newUploadDragOver = false;
    },

    findContact(name) {
      const q = String(name || '').trim().toLowerCase();
      if (!q) return null;
      return this.contactOptions.find(c => String(c.name || '').trim().toLowerCase() === q)
        || this.contactOptions.find(c => String(c.name || '').trim().toLowerCase().includes(q));
    },

    applyContactToForm() {
      const c = this.findContact(this.form.contactName);
      if (!c) return;
      if (!this.form.companyName && c.company) this.form.companyName = c.company;
      if (c.phone) this.form.contactPhone = c.phone;
    },

    applyContactToDetail() {
      if (!this.detail || !this.detail.job) return;
      const c = this.findContact(this.detail.job.contactName);
      if (!c) return;
      if (!this.detail.job.companyName && c.company) this.detail.job.companyName = c.company;
      if (c.phone) this.detail.job.contactPhone = c.phone;
    },

    uploadTargetLabel() {
      if (!this.detail || !this.detail.job) return '';
      const stageId = 'design';
      if (stageId === 'design' && ['proof', 'drawing', 'photo'].includes(this.uploadKind || 'attachment')) {
        return this.parallelTargetLabelForJob(this.detail.job);
      }
      const check = this.detail.job.stageChecks?.[stageId] || {};
      return check.assignee || '';
    },

    parallelTargetLabelForJob(job) {
      return ['management', 'factory']
        .map(id => {
          const stage = this.stages.find(s => s.id === id);
          const check = job?.stageChecks?.[id] || {};
          return check.assignee || stage?.label || id;
        })
        .filter(Boolean)
        .join(', ');
    },

    fileReadNames(file) {
      return (file?.readBy || []).map(r => r.name || r.userId).filter(Boolean).join(', ');
    },

    eventReadNames(event) {
      return (event?.readBy || []).map(r => r.name || r.userId).filter(Boolean).join(', ');
    },

    isUnreadEvent(event) {
      return !!(event && event.viewerUnread);
    },

    fileKindLabel(kind) {
      return ({ proof: '시안', drawing: '도면', photo: '사진', attachment: '첨부' })[kind || 'attachment'] || '첨부';
    },

    filteredFiles() {
      const files = this.detail?.files || [];
      return files.filter(file => {
        if (this.fileStageFilter !== 'all' && file.stageId !== this.fileStageFilter) return false;
        if (this.fileKindFilter !== 'all' && (file.kind || 'attachment') !== this.fileKindFilter) return false;
        return true;
      });
    },

    visualFiles() {
      return this.filteredFiles().filter(file => file.isImage);
    },

    sourceFiles() {
      return this.filteredFiles().filter(file => !file.isImage);
    },

    orders() {
      return this.detail?.orders || [];
    },

    orderSummary() {
      return this.detail?.orderSummary || this.detail?.job?.orderSummary || {};
    },

    onOrderTargetPreset() {
      const target = (this.orderTargets || []).find(t => t.id === this.orderForm.targetPreset);
      if (!target) return;
      this.orderForm.targetName = target.label || this.orderForm.targetName;
      this.orderForm.targetType = target.type || this.orderForm.targetType || 'internal';
    },

    orderStatusLabel(status) {
      return this.orderStatuses?.[status] || status || '초안';
    },

    orderTargetTypeLabel(type) {
      return type === 'external' ? '외주/업체' : '우리공장';
    },

    currentOrderFileIds() {
      return this.filteredFiles().map(file => file.id).filter(Boolean);
    },

    applyOrderResponse(d) {
      if (!this.detail) return;
      if (Array.isArray(d.orders)) this.detail.orders = d.orders;
      if (d.orderSummary) this.detail.orderSummary = d.orderSummary;
      if (d.job) this.detail.job = d.job;
    },

    async createOrderPackage() {
      if (!this.detail || !this.detail.job) return;
      const fileIds = this.currentOrderFileIds();
      if (!fileIds.length) return alert('발주에 포함할 파일이 없습니다.');
      if (!String(this.orderForm.targetName || '').trim()) return alert('발주 대상을 입력하세요.');
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...this.orderForm, status: 'requested', fileIds }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '발주 패키지 생성 실패');
      this.applyOrderResponse(d);
      await this.loadJobs();
      const copied = d.order ? await this.copyText(this.orderShareText(d.order)) : false;
      alert(copied ? '발주 패키지를 만들고 공유문을 복사했습니다.' : '발주 패키지를 만들었습니다. 화면링크 버튼으로 공유할 수 있습니다.');
    },

    async saveOrder(order) {
      if (!this.detail || !this.detail.job || !order) return;
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/orders/' + encodeURIComponent(order.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '발주 저장 실패');
      this.applyOrderResponse(d);
      await this.loadJobs();
    },

    orderArchiveUrl(order) {
      return order && order.publicArchiveUrl ? order.publicArchiveUrl : '';
    },

    orderViewUrl(order) {
      return order && order.publicViewUrl ? order.publicViewUrl : '';
    },

    async copyOrderViewLink(order) {
      const url = this.orderViewUrl(order);
      if (!url) return alert('발주 확인 화면 링크가 없습니다.');
      const ok = await this.copyText(this.absoluteUrl(url));
      alert(ok ? '발주 확인 화면 링크를 복사했습니다.' : '링크 복사에 실패했습니다.');
    },

    async copyOrderArchiveLink(order) {
      const url = this.orderArchiveUrl(order);
      if (!url) return alert('발주 묶음 링크가 없습니다.');
      const ok = await this.copyText(this.absoluteUrl(url));
      alert(ok ? '발주 묶음 링크를 복사했습니다.' : '링크 복사에 실패했습니다.');
    },

    orderShareText(order) {
      if (!order) return;
      const viewUrl = this.orderViewUrl(order) ? this.absoluteUrl(this.orderViewUrl(order)) : '';
      const url = this.orderArchiveUrl(order) ? this.absoluteUrl(this.orderArchiveUrl(order)) : '';
      return [
        order.mailTo ? '수신: ' + order.mailTo : '',
        order.mailCc ? '참조: ' + order.mailCc : '',
        '제목: ' + (order.mailSubject || ''),
        '',
        order.mailBody || '',
        '',
        viewUrl ? '발주 확인/회신 링크: ' + viewUrl : '',
        url ? '발주 묶음 링크: ' + url : '',
      ].filter(v => v !== '').join('\n');
    },

    async copyOrderMailDraft(order) {
      const text = this.orderShareText(order);
      if (!text) return;
      const ok = await this.copyText(text);
      alert(ok ? '공유문을 복사했습니다.' : '공유문 복사에 실패했습니다.');
    },

    fileReviewLabel(status) {
      return ({ pending: '검토대기', approved: '승인', change_requested: '수정요청' })[status || 'pending'] || '검토대기';
    },

    scheduleNegotiationLabel(status) {
      return ({ pending: '일정확인', possible: '가능', needs_change: '조정요청', confirmed: '확정' })[status || 'pending'] || '일정확인';
    },

    completionBlockerText(job) {
      const blockers = job?.completionBlockers || [];
      if (!blockers.length) return '완료 가능';
      return blockers.map(b => `${b.label} ${b.count}`).join(' · ');
    },

    canReviewFile(file) {
      return !!file && ['proof', 'drawing'].includes(file.kind || 'attachment');
    },

    currentStage() {
      if (!this.detail || !this.detail.job) return null;
      const preferredId = this.selectedWorkStageId;
      const preferredCheck = preferredId ? this.detail.job.stageChecks?.[preferredId] : null;
      if (preferredId && preferredCheck && preferredCheck.status !== 'done') {
        return this.stages.find(s => s.id === preferredId) || null;
      }
      const id = this.detail.job.currentStage || 'design';
      return this.stages.find(s => s.id === id) || this.stages[0] || null;
    },

    nextStage() {
      const current = this.currentStage();
      if (!current) return null;
      if (current.id === 'design') return { id: 'parallel', label: '관리팀/공장' };
      if (current.id === 'management' || current.id === 'factory') {
        const otherId = current.id === 'management' ? 'factory' : 'management';
        const otherCheck = this.detail?.job?.stageChecks?.[otherId] || {};
        if (otherCheck.status !== 'done') return null;
        return this.stages.find(s => s.id === 'delivery') || null;
      }
      const idx = this.stages.findIndex(s => s.id === current.id);
      return idx >= 0 ? this.stages[idx + 1] || null : null;
    },

    handoffLabel() {
      const current = this.currentStage();
      const next = this.nextStage();
      if (!current) return '전달';
      if (current.id === 'design') return `${current.label} 완료 · 관리팀/공장 전달`;
      if (current.id === 'management' || current.id === 'factory') {
        const otherId = current.id === 'management' ? 'factory' : 'management';
        const otherCheck = this.detail?.job?.stageChecks?.[otherId] || {};
        if (otherCheck.status !== 'done') return `${current.label} 완료`;
        return `${current.label} 완료 · 납품팀 전달`;
      }
      if (!next) return '작업 완료';
      return `${current.label} 완료 · ${next.label} 전달`;
    },

    async createJob() {
      if (!this.form.title.trim()) return alert('작업명을 입력하세요.');
      if (!this.form.dueDate) this.form.dueDate = this.defaultWorkDate();
      if (this.newFiles.length && (!String(this.form.companyName || '').trim() || !String(this.form.projectName || '').trim())) {
        return alert('시안 파일을 같이 올릴 때는 회사명과 프로젝트명을 입력하세요.');
      }
      this.saving = true;
      try {
        const r = await fetch('/api/workflow/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.form),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '작업 생성 실패');
        const pendingFiles = this.newFiles.slice();
        let uploadError = null;
        if (pendingFiles.length) {
          try {
            await this.uploadFilesForJob(d.job.id, pendingFiles, {
              companyName: this.form.companyName,
              projectName: this.form.projectName,
              designDueDate: this.form.dueDate,
              urgent: this.form.priority === 'urgent' || this.form.priority === 'high',
              note: this.form.summary,
              storageYear: this.newStorageYear(),
              targetLabel: this.parallelTargetLabelForJob(d.job),
            });
          } catch (e) {
            uploadError = e;
          }
        }
        this.resetForm();
        this.clearNewFiles();
        this.newOpen = false;
        await this.loadDesignWorkflowOptions();
        await this.loadJobs();
        await this.selectJob(d.job.id);
        if (uploadError) alert('작업은 등록됐지만 파일 업로드에 실패했습니다: ' + uploadError.message);
      } catch (e) {
        alert(e.message);
      } finally {
        this.saving = false;
      }
    },

    resetForm() {
      this.form = {
        title: '',
        companyName: '',
        projectName: '',
        contactName: '',
        contactPhone: '',
        dueDate: this.defaultWorkDate(),
        deliveryDate: '',
        priority: 'normal',
        summary: '',
      };
    },

    openNewJobModal() {
      if (!this.form.dueDate) this.form.dueDate = this.defaultWorkDate();
      this.newOpen = true;
      setTimeout(() => {
        try { this.$refs?.newJobTitle?.focus(); } catch (_) {}
      }, 50);
    },

    closeNewJobModal() {
      this.newOpen = false;
    },

    applyWorkflowDraft(draft, keepOpen) {
      if (!draft || typeof draft !== 'object') return;
      const next = { ...this.form };
      ['title', 'companyName', 'projectName', 'contactName', 'contactPhone', 'dueDate', 'deliveryDate', 'priority', 'summary']
        .forEach(key => {
          if (draft[key] !== undefined && draft[key] !== null) next[key] = String(draft[key]);
        });
      if (!next.priority) next.priority = 'normal';
      if (!next.dueDate) next.dueDate = this.defaultWorkDate();
      this.form = next;
      if (keepOpen) this.newOpen = true;
    },

    consumeWorkflowDraft() {
      let raw = '';
      try {
        raw = sessionStorage.getItem('workflow:newDraft') || '';
        if (raw) sessionStorage.removeItem('workflow:newDraft');
      } catch (_) {}
      if (!raw) return;
      try {
        this.applyWorkflowDraft(JSON.parse(raw), true);
      } catch (_) {}
    },

    async selectJob(id, stageId = '') {
      this.selectedId = id;
      this.selectedWorkStageId = stageId || '';
      await this.refreshDetail(true);
    },

    async openUnreadFile(item) {
      if (!item || !item.jobId) return;
      await this.openWorkflowTarget(item.jobId, item.id || '');
    },

    async openActionJob(item) {
      if (!item || !item.id) return;
      this.query = '';
      this.statusFilter = 'all';
      this.scopeFilter = 'all';
      await this.loadJobs();
      await this.selectJob(item.id);
    },

    async openScheduleItem(item) {
      if (!item || !item.jobId) return;
      this.query = '';
      this.statusFilter = 'all';
      this.scopeFilter = 'all';
      await this.loadJobs();
      await this.selectJob(item.jobId);
    },

    async refreshDetail(force) {
      if (!this.selectedId) {
        this.detail = null;
        return;
      }
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.selectedId));
      const d = await r.json();
      if (!r.ok || !d.ok) {
        if (force) alert(d.error || '작업 조회 실패');
        return;
      }
      this.detail = d;
      this.uploadStageId = 'design';
      this.uploadOpen = true;
      if (force || !this.uploadCompanyName) this.uploadCompanyName = d.job.companyName || '';
      if (force || !this.uploadProjectName) this.uploadProjectName = d.job.projectName || d.job.title || '';
      if (force || !this.uploadDesignDueDate) this.uploadDesignDueDate = d.job.dueDate || this.defaultWorkDate();
      if (force || !this.orderForm.dueDate) this.orderForm.dueDate = d.job.dueDate || this.defaultWorkDate();
    },

    async saveJob() {
      if (!this.detail || !this.detail.job) return;
      this.saving = true;
      try {
        const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.detail.job),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '저장 실패');
        await this.loadDesignWorkflowOptions();
        await this.loadJobs();
        await this.refreshDetail(false);
      } catch (e) {
        alert(e.message);
      } finally {
        this.saving = false;
      }
    },

    async saveStage(stageId) {
      if (!this.detail || !this.detail.job) return;
      const check = this.detail.job.stageChecks[stageId];
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/stages/' + encodeURIComponent(stageId), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(check),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '단계 저장 실패');
      await this.loadJobs();
      await this.refreshDetail(false);
    },

    async handoffJob() {
      if (!this.detail || !this.detail.job) return;
      const stage = this.currentStage();
      this.saving = true;
      try {
        const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/handoff', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: this.handoffText, stageId: stage?.id || '' }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '전달 실패');
        this.handoffText = '';
        await this.loadJobs();
        await this.refreshDetail(false);
      } catch (e) {
        alert(e.message);
      } finally {
        this.saving = false;
      }
    },

    async addComment() {
      if (!this.detail || !this.commentText.trim()) return;
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: this.commentText,
          targetUserId: '',
          targetUserName: '',
          targetLabel: '',
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '댓글 저장 실패');
      this.commentText = '';
      await this.refreshDetail(false);
      await this.loadSummary();
    },

    async openUnreadEvent(item) {
      if (!item || !item.jobId) return;
      await this.openWorkflowTarget(item.jobId, item.id || '');
    },

    async markEventRead(event) {
      if (!this.detail || !event) return;
      await this.markEventReadById(this.detail.job.id, event.id);
    },

    async markInboxEventRead(item) {
      if (!item || !item.jobId || !item.id) return;
      await this.markEventReadById(item.jobId, item.id);
    },

    async markEventReadById(jobId, eventId) {
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(jobId) + '/events/' + encodeURIComponent(eventId) + '/read', {
        method: 'POST',
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '확인 처리 실패');
      if (this.selectedId === jobId) await this.refreshDetail(false);
      await this.loadJobs();
      await this.loadSummary();
    },

    async uploadFiles(ev) {
      const files = ev?.target?.files || ev?.dataTransfer?.files || ev;
      if (!this.detail || !files || !files.length) return;
      const storageCompanyName = String(this.uploadCompanyName || this.detail.job.companyName || '').trim();
      const storageProjectName = String(this.uploadProjectName || this.detail.job.projectName || this.detail.job.title || '').trim();
      if (!storageCompanyName || !storageProjectName) {
        alert('회사와 프로젝트를 먼저 선택해주세요.');
        return;
      }
      try {
        await this.uploadFilesForJob(this.detail.job.id, files, {
          companyName: storageCompanyName,
          projectName: storageProjectName,
          designDueDate: this.uploadDesignDueDate || '',
          urgent: this.uploadUrgent,
          note: this.uploadNote || '',
          storageYear: this.uploadStorageYear(),
          targetLabel: this.uploadTargetLabel(),
        });
      } catch (e) {
        alert(e.message);
        return;
      } finally {
        if (ev?.target) ev.target.value = '';
      }
      this.uploadNote = '';
      this.uploadDesignDueDate = this.detail?.job?.dueDate || this.defaultWorkDate();
      this.uploadUrgent = false;
      await this.loadDesignWorkflowOptions();
      await this.loadJobs();
      await this.refreshDetail(false);
    },

    async uploadFilesForJob(jobId, files, options = {}) {
      const list = Array.from(files || []).filter(Boolean);
      if (!jobId || !list.length) return null;
      const validationError = this.validateUploadFileList(list);
      if (validationError) throw new Error(validationError);
      const storageCompanyName = String(options.companyName || '').trim();
      const storageProjectName = String(options.projectName || '').trim();
      if (!storageCompanyName || !storageProjectName) {
        throw new Error('회사와 프로젝트를 먼저 선택해주세요.');
      }
      const fd = new FormData();
      const encodeField = value => encodeURIComponent(String(value || ''));
      list.forEach(f => fd.append('files', f));
      fd.append('stageId', options.stageId || 'design');
      fd.append('kind', options.kind || 'proof');
      fd.append('note', options.note || '');
      fd.append('noteEncoded', encodeField(options.note || ''));
      fd.append('designDueDate', options.designDueDate || '');
      fd.append('urgent', options.urgent ? '1' : '');
      fd.append('storageYear', options.storageYear || String(new Date().getFullYear()));
      fd.append('storageCompanyName', storageCompanyName);
      fd.append('storageCompanyNameEncoded', encodeField(storageCompanyName));
      fd.append('storageProjectName', storageProjectName);
      fd.append('storageProjectNameEncoded', encodeField(storageProjectName));
      fd.append('targetUserId', '');
      fd.append('targetUserName', '');
      fd.append('targetLabel', options.targetLabel || '');
      fd.append('targetLabelEncoded', encodeField(options.targetLabel || ''));
      const totalSize = this.fileListTotalSize(list);
      this.uploadProgress = { active: true, percent: 0, text: `${this.fileBatchLabel(list)} 업로드 준비 중` };
      try {
        const d = await new Promise((resolve, reject) => {
          const xhr = new XMLHttpRequest();
          xhr.open('POST', '/api/workflow/jobs/' + encodeURIComponent(jobId) + '/files');
          xhr.upload.onprogress = event => {
            if (!event.lengthComputable) {
              this.uploadProgress = { active: true, percent: 0, text: `${this.fileBatchLabel(list)} 업로드 중` };
              return;
            }
            const percent = Math.max(1, Math.min(99, Math.round((event.loaded / event.total) * 100)));
            this.uploadProgress = {
              active: true,
              percent,
              text: `${this.fileSizeLabel(event.loaded)} / ${this.fileSizeLabel(event.total || totalSize)} 업로드 중`,
            };
          };
          xhr.onerror = () => reject(new Error('파일 업로드 중 네트워크 오류가 발생했습니다.'));
          xhr.onload = () => {
            let data = {};
            try { data = JSON.parse(xhr.responseText || '{}'); }
            catch (_) { data = {}; }
            if (xhr.status < 200 || xhr.status >= 300 || !data.ok) {
              reject(new Error(data.error || '파일 업로드 실패'));
              return;
            }
            this.uploadProgress = { active: true, percent: 100, text: `${this.fileBatchLabel(list)} 업로드 완료` };
            resolve(data);
          };
          xhr.send(fd);
        });
        return d;
      } finally {
        setTimeout(() => {
          this.uploadProgress = { active: false, percent: 0, text: '' };
        }, 900);
      }
    },

    async uploadDroppedFiles(ev) {
      ev.preventDefault();
      this.uploadDragOver = false;
      await this.uploadFiles(ev);
    },

    async saveFileSchedule(file) {
      if (!this.detail || !file) return;
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/files/' + encodeURIComponent(file.id) + '/schedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          designDueDate: file.designDueDate || '',
          urgent: !!file.urgent,
          factoryAvailableDate: file.factoryAvailableDate || '',
          factoryScheduleNote: file.factoryScheduleNote || '',
          scheduleNegotiation: file.scheduleNegotiation || '',
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '일정 저장 실패');
      await this.refreshDetail(false);
      await this.loadJobs();
      await this.loadSummary();
    },

    fileEvents(file) {
      if (!file || !this.detail) return [];
      return (this.detail.events || [])
        .filter(event => event.meta && event.meta.fileId === file.id)
        .slice()
        .reverse()
        .slice(0, 4);
    },

    async addFileComment(file) {
      if (!this.detail || !file) return;
      const message = String(file._commentText || '').trim();
      if (!message) return;
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/files/' + encodeURIComponent(file.id) + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          targetUserId: '',
          targetUserName: '',
          targetLabel: this.uploadTargetLabel() || file.targetLabel || '',
        }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '댓글 등록 실패');
      file._commentText = '';
      await this.refreshDetail(false);
      await this.loadJobs();
      await this.loadSummary();
    },

    async markRead(file) {
      if (!this.detail || !file) return;
      await this.markFileRead(this.detail.job.id, file.id);
    },

    async markInboxRead(item) {
      if (!item || !item.jobId || !item.id) return;
      await this.markFileRead(item.jobId, item.id);
    },

    async markFileRead(jobId, fileId) {
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(jobId) + '/files/' + encodeURIComponent(fileId) + '/read', {
        method: 'POST',
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '확인 처리 실패');
      if (this.selectedId === jobId) await this.refreshDetail(false);
      await this.loadJobs();
      await this.loadSummary();
    },

    async reviewFile(file, status) {
      if (!this.detail || !file) return;
      let note = '';
      if (status === 'change_requested') {
        note = prompt('수정 요청 내용을 입력하세요.') || '';
        if (!note.trim()) return;
      }
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/files/' + encodeURIComponent(file.id) + '/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status, note }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '검토 처리 실패');
      await this.refreshDetail(false);
      await this.loadJobs();
      await this.loadSummary();
    },

    fileUrl(file) {
      if (!file) return '#';
      return file.downloadUrl || ('/api/workflow/files/' + encodeURIComponent(file.id) + '/download');
    },

    filePreviewUrl(file) {
      if (!file || !file.isImage) return '';
      return file.previewUrl || this.fileUrl(file);
    },

    publicFileUrl(file) {
      return file && file.publicDownloadUrl ? file.publicDownloadUrl : '';
    },

    absoluteUrl(url) {
      if (!url) return '';
      try {
        const base = this.publicShareBaseUrl || window.location.origin;
        return new URL(url, base).toString();
      } catch (_) {
        return url;
      }
    },

    async copyText(text) {
      const value = String(text || '');
      if (!value) return false;
      const api = typeof navigator !== 'undefined' ? navigator.clipboard : null;
      if (api && typeof api.writeText === 'function') {
        try {
          await api.writeText(value);
          return true;
        } catch (_) {}
      }
      try {
        const el = document.createElement('textarea');
        el.value = value;
        el.setAttribute('readonly', '');
        el.style.cssText = 'position:fixed;left:-9999px;top:-9999px;opacity:0;';
        document.body.appendChild(el);
        el.select();
        const ok = document.execCommand && document.execCommand('copy');
        document.body.removeChild(el);
        return !!ok;
      } catch (_) {
        return false;
      }
    },

    async copyFactoryFileLink(file) {
      const url = this.publicFileUrl(file);
      if (!url) return alert('공장 다운로드 링크가 없습니다.');
      const ok = await this.copyText(this.absoluteUrl(url));
      alert(ok ? '공장 다운로드 링크를 복사했습니다.' : '링크 복사에 실패했습니다.');
    },

    openFilePreview(file) {
      if (!file || !file.isImage) return;
      this.filePreview = { open: true, file, zoom: 1, fit: true };
    },

    fitPreview() {
      if (!this.filePreview.open) return;
      this.filePreview.fit = true;
      this.filePreview.zoom = 1;
    },

    actualPreview() {
      if (!this.filePreview.open) return;
      this.filePreview.fit = false;
      this.filePreview.zoom = 1;
    },

    zoomPreview(delta) {
      if (!this.filePreview.open) return;
      const current = this.filePreview.fit ? 1 : Number(this.filePreview.zoom || 1);
      this.filePreview.fit = false;
      this.filePreview.zoom = Math.min(4, Math.max(0.5, Math.round((current + delta) * 100) / 100));
    },

    previewZoomLabel() {
      if (this.filePreview.fit) return '맞춤';
      return Math.round(Number(this.filePreview.zoom || 1) * 100) + '%';
    },

    previewImageStyle() {
      if (this.filePreview.fit) {
        return 'max-width:100%;max-height:100%;width:auto;height:auto;';
      }
      return `width:${Math.round(Number(this.filePreview.zoom || 1) * 100)}%;max-width:none;max-height:none;height:auto;`;
    },

    toggleFileCollab(file) {
      if (!file) return;
      this.expandedFileId = this.expandedFileId === file.id ? '' : file.id;
    },

    closeFilePreview() {
      this.filePreview = { open: false, file: null, zoom: 1, fit: true };
    },

    fileTypeLabel(file) {
      if (!file) return 'FILE';
      if (file.isAi) return 'AI';
      const name = String(file.originalName || '');
      const m = name.match(/\.([a-z0-9]+)$/i);
      return m ? m[1].toUpperCase().slice(0, 5) : 'FILE';
    },

    jobArchiveUrl() {
      if (!this.detail || !this.detail.job) return '#';
      const qs = new URLSearchParams();
      if (this.fileStageFilter !== 'all') qs.set('stageId', this.fileStageFilter);
      if (this.fileKindFilter !== 'all') qs.set('kind', this.fileKindFilter);
      const query = qs.toString();
      return '/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/files/archive' + (query ? '?' + query : '');
    },

    factoryArchiveUrl() {
      const base = this.detail && this.detail.job ? (this.detail.job.publicArchiveUrl || '') : '';
      if (!base) return '';
      const qs = new URLSearchParams();
      if (this.fileStageFilter !== 'all') qs.set('stageId', this.fileStageFilter);
      if (this.fileKindFilter !== 'all') qs.set('kind', this.fileKindFilter);
      const query = qs.toString();
      return base + (query ? '?' + query : '');
    },

    async copyFactoryArchiveLink() {
      const url = this.factoryArchiveUrl();
      if (!url) return alert('공장 묶음 다운로드 링크가 없습니다.');
      const ok = await this.copyText(this.absoluteUrl(url));
      alert(ok ? '공장 묶음 다운로드 링크를 복사했습니다.' : '링크 복사에 실패했습니다.');
    },

    eventTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return ts;
      return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
  };
}
