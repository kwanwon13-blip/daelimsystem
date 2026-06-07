function workflowApp() {
  return {
    loading: true,
    saving: false,
    jobs: [],
    jobsByStage: {},
    jobListLimit: 120,
    jobListTotal: 0,
    jobListLimited: false,
    stages: [],
    statuses: {},
    checkStatuses: {},
    orderTargets: [],
    orderStatuses: {},
    uploadLimits: { files: 20, fileSize: 100 * 1024 * 1024 },
    summary: { active: 0, overdue: 0, blocked: 0, urgentFiles: 0, unreadTotal: 0, unreadFiles: 0, unreadEvents: 0, scheduleCount: 0, myActions: 0, byStage: {} },
    selectedId: '',
    selectedWorkStageId: '',
    detail: null,
    detailMoreOpen: false,
    orderPanelOpen: false,
    historyPanelOpen: false,
    query: '',
    statusFilter: 'active',
    scopeFilter: 'all',
    newOpen: false,
    newFiles: [],
    newUploadDragOver: false,
    currentUser: null,
    publicShareBaseUrl: '',
    publicLinkPanelOpen: false,
    publicLinkSettings: { configuredBaseUrl: '', source: '', envLocked: false, configuredValid: true, configuredProblem: '', envProblem: '' },
    publicLinkForm: { publicBaseUrl: '', saving: false },
    departmentMappingPanelOpen: false,
    workflowDepartments: [],
    stageDepartmentMap: {},
    stageDepartmentMissingIds: [],
    stageDepartmentSaving: false,
    contactOptions: [],
    contactsLoaded: false,
    contactsLoading: null,
    designWorkflowOptions: { companies: [], projectsByCompany: {}, projectLookup: {}, masterCompanies: [] },
    designWorkflowOptionsLoaded: false,
    designWorkflowOptionsLoading: null,
    workflowProjects: [],
    storagePreviewCache: {},
    storagePreviewTimers: {},
    projectPanelOpen: false,
    autoTitleValue: '',
    projectQuery: '',
    projectStatusFilter: 'active',
    projectNotice: '',
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
    quickFactoryOrderSaving: false,
    orderTargetQuery: '',
    orderSelectedFileIds: [],
    orderForm: {
      targetPreset: 'factory',
      targetType: 'internal',
      targetName: '우리공장',
      deliveryMethod: 'download',
      recipientEmail: '',
      recipientCc: '',
      recipientName: '',
      dueDate: '',
      note: '',
    },
    orderMailModal: {
      open: false,
      sending: false,
      order: null,
      toEmail: '',
      ccEmail: '',
      subject: '',
      message: '',
      attachFiles: true,
      error: '',
      linkOnlySuggested: false,
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
      await Promise.all([this.loadAuth(), this.loadMeta()]);
      await this.loadPublicLinkSettings();
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
      this.workflowDepartments = d.departments || [];
      this.stageDepartmentMap = { ...(d.stageDepartmentMap || {}) };
      this.stageDepartmentMissingIds = d.stageDepartmentMissingIds || [];
      this.applyPublicLinkSettings(d.publicLink || d);
      this.uploadLimits = d.uploadLimits || this.uploadLimits;
    },

    missingDepartmentMappings() {
      return (this.stages || []).filter(stage => !this.stageDepartmentMap?.[stage.id]);
    },

    stageDepartmentName(stageId) {
      const deptId = this.stageDepartmentMap?.[stageId] || '';
      const dept = (this.workflowDepartments || []).find(d => d.id === deptId);
      return dept?.name || '';
    },

    departmentMappingSummary() {
      const missing = this.missingDepartmentMappings();
      if (!this.workflowDepartments.length) return '조직도 부서를 먼저 등록해주세요.';
      if (missing.length) return `팀 매칭 필요 ${missing.length}개`;
      return '팀 매칭 완료';
    },

    async toggleDepartmentMappingPanel(force = null) {
      const next = force === null ? !this.departmentMappingPanelOpen : !!force;
      this.departmentMappingPanelOpen = next;
      if (next) await this.loadDepartmentMappingSettings();
    },

    async loadDepartmentMappingSettings() {
      try {
        const r = await fetch('/api/workflow/settings/departments');
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '팀 매칭 조회 실패');
        this.stages = d.stages || this.stages || [];
        this.workflowDepartments = d.departments || [];
        this.stageDepartmentMap = { ...(d.stageDepartmentMap || {}) };
        this.stageDepartmentMissingIds = d.stageDepartmentMissingIds || [];
      } catch (e) {
        alert(e.message);
      }
    },

    async saveDepartmentMappingSettings() {
      this.stageDepartmentSaving = true;
      try {
        const r = await fetch('/api/workflow/settings/departments', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ stageDepartmentMap: this.stageDepartmentMap || {} }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '팀 매칭 저장 실패');
        this.stages = d.stages || this.stages || [];
        this.workflowDepartments = d.departments || [];
        this.stageDepartmentMap = { ...(d.stageDepartmentMap || {}) };
        this.stageDepartmentMissingIds = d.stageDepartmentMissingIds || [];
        await this.loadJobs();
        alert('워크플로우 팀 매칭을 저장했습니다.');
      } catch (e) {
        alert(e.message);
      } finally {
        this.stageDepartmentSaving = false;
      }
    },

    applyPublicLinkSettings(data = {}) {
      this.publicShareBaseUrl = data.publicBaseUrl || '';
      this.publicLinkSettings = {
        configuredBaseUrl: data.configuredBaseUrl || '',
        source: data.source || '',
        envLocked: !!data.envLocked,
        configuredValid: data.configuredValid !== false,
        configuredProblem: data.configuredProblem || '',
        envProblem: data.envProblem || '',
      };
      this.publicLinkForm.publicBaseUrl = this.publicLinkSettings.configuredBaseUrl || this.publicShareBaseUrl || '';
    },

    async loadPublicLinkSettings() {
      try {
        const r = await fetch('/api/workflow/settings/public-link');
        const d = await r.json();
        if (!r.ok || !d.ok) return;
        this.applyPublicLinkSettings(d);
      } catch (_) {}
    },

    async savePublicLinkSettings() {
      this.publicLinkForm.saving = true;
      try {
        const r = await fetch('/api/workflow/settings/public-link', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ publicBaseUrl: this.publicLinkForm.publicBaseUrl || '' }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '외부 다운로드 주소 저장 실패');
        this.applyPublicLinkSettings(d);
        alert(this.publicShareBaseUrl ? '외부 다운로드 주소를 저장했습니다.' : '외부 다운로드 주소를 비웠습니다.');
      } catch (e) {
        alert(e.message);
      } finally {
        this.publicLinkForm.saving = false;
      }
    },

    currentExternalOrigin() {
      try {
        const origin = window.location.origin || '';
        const host = window.location.hostname || '';
        if (!origin || origin === 'null' || this.isPrivateWorkflowHost(host)) return '';
        if (!/^https?:\/\//i.test(origin)) return '';
        return origin.replace(/\/+$/, '');
      } catch (_) {
        return '';
      }
    },

    canUseCurrentExternalOrigin() {
      return !this.publicLinkSettings.envLocked && !!this.currentExternalOrigin();
    },

    useCurrentExternalOrigin() {
      const origin = this.currentExternalOrigin();
      if (!origin) return alert('현재 접속 주소가 외부 터널 주소가 아닙니다.');
      this.publicLinkForm.publicBaseUrl = origin;
    },

    publicLinkCurrentOriginHint() {
      const origin = this.currentExternalOrigin();
      if (!origin) return '';
      if (this.publicShareBaseUrl && origin === this.publicShareBaseUrl) return '현재 접속 주소와 외부 다운로드 주소가 같습니다';
      return '현재 접속 주소: ' + origin;
    },

    activePublicWorkflowBaseUrl() {
      return this.publicShareBaseUrl || this.currentExternalOrigin();
    },

    publicLinkProblem() {
      return this.publicLinkSettings.configuredProblem || this.publicLinkSettings.envProblem || '';
    },

    publicLinkStatusClass() {
      if (this.publicLinkProblem()) return 'high';
      return this.activePublicWorkflowBaseUrl() ? 'ready' : 'high';
    },

    publicLinkSourceLabel() {
      const source = this.publicLinkSettings.source || '';
      if (source === 'env') return '환경변수';
      if (source === 'settings') return '저장설정';
      return '';
    },

    publicLinkStatusText() {
      const problem = this.publicLinkProblem();
      if (problem) return '외부주소 확인 필요';
      if (this.publicShareBaseUrl) {
        const source = this.publicLinkSourceLabel();
        return '링크 발송 가능' + (source ? ' · ' + source : '');
      }
      if (this.currentExternalOrigin()) return '현재 터널로 링크 가능';
      return '터널 주소 없음 · 첨부 메일만 가능';
    },

    async loadContacts(force = false) {
      if (!force && this.contactsLoaded) return this.contactOptions;
      if (!force && this.contactsLoading) return this.contactsLoading;
      this.contactsLoading = (async () => {
        try {
          const contacts = await fetch('/api/contacts/all').then(r => r.ok ? r.json() : []);
          this.contactOptions = (contacts || []).slice(0, 1000).map(c => ({
            name: c.name || '',
            company: c.company || '',
            phone: c.mobile || c.phone || '',
            email: c.email || '',
          })).filter(c => c.name || c.company);
          this.contactsLoaded = true;
        } catch (_) {
          this.contactOptions = [];
        }
        return this.contactOptions;
      })();
      try {
        return await this.contactsLoading;
      } finally {
        this.contactsLoading = null;
      }
    },

    async loadDesignWorkflowOptions(force = false) {
      if (!force && this.designWorkflowOptionsLoaded) return this.designWorkflowOptions;
      if (!force && this.designWorkflowOptionsLoading) return this.designWorkflowOptionsLoading;
      this.designWorkflowOptionsLoading = (async () => {
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
          this.designWorkflowOptionsLoaded = true;
        } catch (_) {
          this.workflowProjects = [];
          this.designWorkflowOptions = { companies: [], projectsByCompany: {}, projectLookup: {}, masterCompanies: [] };
        }
        return this.designWorkflowOptions;
      })();
      try {
        return await this.designWorkflowOptionsLoading;
      } finally {
        this.designWorkflowOptionsLoading = null;
      }
    },

    async loadSummary() {
      try {
        const r = await fetch('/api/workflow/summary');
        const d = await r.json();
        if (r.ok && d.ok) this.summary = d.summary || this.summary;
      } catch (_) {}
    },

    async setWorkflowListFilter(status = 'active', scope = 'all') {
      this.statusFilter = status || 'active';
      this.scopeFilter = scope || 'all';
      this.selectedId = '';
      this.detail = null;
      await this.loadJobs();
    },

    async loadJobs() {
      this.loading = true;
      const qs = new URLSearchParams();
      if (this.query.trim()) qs.set('q', this.query.trim());
      if (this.statusFilter) qs.set('status', this.statusFilter);
      if (this.scopeFilter && this.scopeFilter !== 'all') qs.set('scope', this.scopeFilter);
      qs.set('limit', this.jobListLimit === 0 ? '0' : String(this.jobListLimit || 120));
      try {
        const r = await fetch('/api/workflow/jobs?' + qs.toString());
        const d = await r.json();
        const jobs = Array.isArray(d.jobs) ? d.jobs : [];
        this.jobs = jobs;
        const total = Number(d.total);
        this.jobListTotal = Number.isFinite(total) ? total : jobs.length;
        this.jobListLimited = !!d.limited;
        this.rebuildJobsByStage();
        if (this.selectedId && !this.jobs.find(j => j.id === this.selectedId)) this.selectedId = '';
        if (!this.selectedId) this.detail = null;
        if (this.selectedId) await this.refreshDetail(false);
        if (d.summary) this.summary = d.summary;
        else await this.loadSummary();
      } finally {
        this.loading = false;
      }
    },

    workflowLimitText() {
      const shown = (this.jobs || []).length;
      const total = Number(this.jobListTotal || shown);
      return `${shown}/${total}`;
    },

    async showAllWorkflowJobs() {
      this.jobListLimit = 0;
      await this.loadJobs();
    },

    async resetWorkflowJobLimit() {
      this.jobListLimit = 120;
      await this.loadJobs();
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
        this.historyPanelOpen = true;
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
      return this.jobsByStage?.[stageId] || [];
    },

    rebuildJobsByStage() {
      const grouped = {};
      for (const stage of this.stages || []) grouped[stage.id] = [];
      for (const job of this.jobs || []) {
        for (const stage of this.stages || []) {
          if (this.jobBelongsToStage(job, stage.id)) grouped[stage.id].push(job);
        }
      }
      this.jobsByStage = grouped;
    },

    jobBelongsToStage(job, stageId) {
      if (Array.isArray(job.activeStageIds) && job.activeStageIds.length) return job.activeStageIds.includes(stageId);
      const check = this.stageCheck(job, stageId);
      if (check.status === 'ready' || check.status === 'blocked') return true;
      return (job.currentStage || 'design') === stageId && check.status !== 'done';
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

    workflowEventFocusLabel(event = {}) {
      const type = event.type || '';
      if (type === 'order_public_reply') return '전달 회신';
      if (type === 'order_public_download') return '다운로드';
      if (type === 'order_public_view') return '열람';
      if (type === 'file_schedule') return '일정';
      if (type === 'review') return '검토';
      if (type === 'handoff' || type === 'stage') return '전달';
      return '메모';
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
        const risky = item.overdue || item.blockedStageCount || item.changeRequestCount || item.lateScheduleCount;
        push('action', item.overdue || item.lateScheduleCount ? '위험' : '내 담당', item.title, `${item.stageLabel || ''}${item.dueDate ? ' · ' + item.dueDate : ''}`, item, risky ? 'urgent' : 'info');
      });
      this.unreadEventItems().slice(0, 2).forEach(item => {
        push('event', this.workflowEventFocusLabel(item), item.message, `${item.jobTitle || '-'}${item.actorName ? ' · ' + item.actorName : ''}`, item, item.type === 'order_public_reply' ? 'warn' : 'info');
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

    storagePreviewKey(companyName, projectName, yearValue) {
      const company = String(companyName || '').trim();
      const project = String(projectName || '').trim();
      const year = /^\d{4}$/.test(String(yearValue || '')) ? String(yearValue) : String(new Date().getFullYear());
      if (!company || !project) return '';
      return [this.normalizeOptionName(company), this.normalizeOptionName(project), year].join('|');
    },

    async fetchStoragePreview(companyName, projectName, yearValue) {
      const key = this.storagePreviewKey(companyName, projectName, yearValue);
      if (!key) return null;
      const qs = new URLSearchParams({
        companyName: String(companyName || '').trim(),
        projectName: String(projectName || '').trim(),
        year: /^\d{4}$/.test(String(yearValue || '')) ? String(yearValue) : String(new Date().getFullYear()),
      });
      try {
        const r = await fetch('/api/workflow/storage/preview?' + qs.toString());
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) {
          this.storagePreviewCache[key] = { error: d.error || '저장 경로 확인 실패' };
          return null;
        }
        this.storagePreviewCache[key] = {
          label: d.storage?.rel || '',
          existedBefore: d.storage?.existedBefore !== false,
          created: !!d.storage?.created,
          netPath: d.storage?.netPath || '',
        };
        return this.storagePreviewCache[key];
      } catch (e) {
        this.storagePreviewCache[key] = { error: e.message || '저장 경로 확인 실패' };
        return null;
      }
    },

    scheduleStoragePreview(companyName, projectName, yearValue) {
      const key = this.storagePreviewKey(companyName, projectName, yearValue);
      if (!key || this.storagePreviewCache[key]) return;
      this.storagePreviewCache[key] = { pending: true };
      clearTimeout(this.storagePreviewTimers[key]);
      this.storagePreviewTimers[key] = setTimeout(() => {
        this.fetchStoragePreview(companyName, projectName, yearValue);
      }, 250);
    },

    clearStoragePreview(companyName, projectName, yearValue) {
      const key = this.storagePreviewKey(companyName, projectName, yearValue);
      if (!key) return;
      clearTimeout(this.storagePreviewTimers[key]);
      delete this.storagePreviewTimers[key];
      delete this.storagePreviewCache[key];
    },

    estimatedWorkflowStorageLabel(companyName, projectName, yearValue) {
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

    workflowStorageLabel(companyName, projectName, yearValue) {
      const estimated = this.estimatedWorkflowStorageLabel(companyName, projectName, yearValue);
      const key = this.storagePreviewKey(companyName, projectName, yearValue);
      if (!key) return estimated;
      const cached = this.storagePreviewCache[key];
      if (!cached) {
        this.scheduleStoragePreview(companyName, projectName, yearValue);
        return estimated;
      }
      return cached.label || estimated;
    },

    workflowStorageStateLabel(companyName, projectName, yearValue) {
      const key = this.storagePreviewKey(companyName, projectName, yearValue);
      const cached = key ? this.storagePreviewCache[key] : null;
      if (!cached) {
        this.scheduleStoragePreview(companyName, projectName, yearValue);
        return '';
      }
      if (cached.error) return '저장 경로 확인 필요';
      if (cached.pending) return '저장 경로 확인 중';
      if (cached.created) return '새 폴더 생성 예정';
      if (cached.existedBefore) return '기존 폴더 사용';
      return '';
    },

    workflowStorageText(companyName, projectName, yearValue) {
      const label = this.workflowStorageLabel(companyName, projectName, yearValue);
      const state = this.workflowStorageStateLabel(companyName, projectName, yearValue);
      return state ? `${label} · ${state}` : label;
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
      this.clearStoragePreview(company, project, storageYear);
      await this.loadDesignWorkflowOptions(true);
      const rel = d.folder?.rel || d.project?.storageBucket || '';
      this.projectNotice = rel ? `프로젝트 준비됨 · ${rel}` : '프로젝트 준비됨';
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
      this.projectNotice = `프로젝트 상태 저장 · ${this.projectStatusLabel(status)} · ${d.project?.storageBucket || d.project?.projectName || projectName}`;
      await this.loadDesignWorkflowOptions(true);
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
      this.projectNotice = `프로젝트 상태 저장 · ${this.projectStatusLabel(status)} · ${d.project?.storageBucket || d.project?.projectName || project.projectName}`;
      await this.loadDesignWorkflowOptions(true);
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
        if (['done', 'cancelled'].includes(job.status || 'active')) continue;
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

    isWorkflowJobClosed(job) {
      return !!job && ['done', 'cancelled'].includes(job.status || '');
    },

    canUploadToCurrentJob() {
      return !!this.detail?.job && !this.isWorkflowJobClosed(this.detail.job);
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
      return this.workflowStorageText(this.form.companyName, this.form.projectName, this.newStorageYear());
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

    fileTitlePart(fileName) {
      const name = String(fileName || '').trim();
      if (!name) return '';
      return name.replace(/\.[^.\\\/]{1,12}$/i, '').trim() || name;
    },

    fileNameSearchText(files = []) {
      return Array.from(files || [])
        .filter(Boolean)
        .slice(0, 6)
        .map(file => this.fileTitlePart(file.name || file.originalName || ''))
        .join(' ');
    },

    fileGuessTokens(text = '') {
      const stopwords = new Set(['시안', '발주', '공장', '디자인', '작업', '견적', '마감', '내역서', '최종', '수정', '완료', '납품', '파일', '원본', '확인', '요청', 'ai', 'jpg', 'jpeg', 'png', 'pdf', 'psd', 'xls', 'xlsx', 'doc', 'docx']);
      return Array.from(new Set(String(text || '')
        .split(/[^\p{L}\p{N}]+/gu)
        .map(token => this.normalizeOptionName(token))
        .filter(token => token.length >= 2 && !stopwords.has(token))));
    },

    optionKeys(option = {}, fields = ['name']) {
      if (typeof option === 'string') {
        const key = this.normalizeOptionName(option);
        return key && key.length >= 2 ? [key] : [];
      }
      return fields
        .map(field => this.normalizeOptionName(option?.[field]))
        .filter(key => key && key.length >= 2);
    },

    optionDisplayName(option) {
      return typeof option === 'string' ? option : (option?.name || option?.projectName || '');
    },

    bestNameMatch(options = [], haystack = '', fields = ['name']) {
      const hay = this.normalizeOptionName(haystack);
      if (!hay) return null;
      const tokens = this.fileGuessTokens(haystack);
      let best = null;
      for (const option of options || []) {
        const keys = this.optionKeys(option, fields);
        const exactHit = keys
          .filter(key => hay.includes(key))
          .sort((a, b) => b.length - a.length)[0];
        const prefixHit = exactHit ? '' : keys
          .map(key => {
            const token = tokens
              .filter(item => item.length >= 2 && (key.startsWith(item) || item.startsWith(key)))
              .sort((a, b) => b.length - a.length)[0];
            return token ? { key, token } : null;
          })
          .filter(Boolean)
          .sort((a, b) => b.token.length - a.token.length || a.key.length - b.key.length)[0];
        const hit = exactHit || prefixHit?.token;
        if (!hit) continue;
        const score = (exactHit ? 100000 : 50000)
          + hit.length * 1000
          + Number(option?.projectCount || option?.activeJobCount || option?.count || 0);
        if (!best || score > best.score) best = { option, score, key: hit };
      }
      return best?.option || null;
    },

    inferWorkflowTargetFromFiles(files = []) {
      const text = this.fileNameSearchText(files);
      if (!text) return {};
      const companies = this.mergeWorkflowCompanies(
        this.designWorkflowOptions.companies || [],
        (this.workflowProjects || []).map(project => ({
          name: project.companyName || '',
          folderName: project.storageCompanyFolder || project.companyName || '',
          projectCount: 1,
        })),
        (this.jobs || []).map(job => ({
          name: job.companyName || '',
          folderName: job.companyName || '',
          projectCount: 1,
        }))
      );
      const matchedCompany = this.bestNameMatch(companies, text, ['name', 'folderName']);
      let companyName = matchedCompany?.name || '';
      let projectName = '';
      const projectPool = companyName
        ? this.workflowProjectOptionsForCompany(companyName, false)
        : (this.workflowProjects || []).map(project => ({
            name: project.projectName || '',
            folderName: project.storageProjectFolder || project.projectName || '',
            companyName: project.companyName || '',
            activeJobCount: Number(project.activeJobCount || 0),
            status: project.status || 'active',
          })).filter(project => {
            return project.status !== 'done';
          });
      const matchedProject = this.bestNameMatch(projectPool, text, ['name', 'folderName']);
      if (matchedProject) {
        projectName = this.optionDisplayName(matchedProject);
        if (!companyName && matchedProject.companyName) companyName = matchedProject.companyName;
      }
      return { companyName, projectName };
    },

    applyFileGuessToNewForm(files = this.newFiles) {
      const guess = this.inferWorkflowTargetFromFiles(files);
      if (guess.companyName && !String(this.form.companyName || '').trim()) {
        this.form.companyName = guess.companyName;
      }
      if (!guess.projectName && String(this.form.companyName || '').trim()) {
        const matched = this.bestNameMatch(this.workflowProjectOptionsForCompany(this.form.companyName, false), this.fileNameSearchText(files), ['name', 'folderName']);
        if (matched) guess.projectName = this.optionDisplayName(matched);
      }
      if (guess.projectName && !String(this.form.projectName || '').trim()) {
        this.form.projectName = guess.projectName;
      }
      if (!this.form.dueDate) this.form.dueDate = this.defaultWorkDate();
    },

    applyFileGuessToUpload(files = []) {
      const guess = this.inferWorkflowTargetFromFiles(files);
      if (guess.companyName && !String(this.uploadCompanyName || '').trim()) {
        this.uploadCompanyName = guess.companyName;
      }
      if (!guess.projectName && String(this.uploadCompanyName || '').trim()) {
        const matched = this.bestNameMatch(this.workflowProjectOptionsForCompany(this.uploadCompanyName, false), this.fileNameSearchText(files), ['name', 'folderName']);
        if (matched) guess.projectName = this.optionDisplayName(matched);
      }
      if (guess.projectName && !String(this.uploadProjectName || '').trim()) {
        this.uploadProjectName = guess.projectName;
      }
      if (!this.uploadDesignDueDate) this.uploadDesignDueDate = this.defaultWorkDate();
    },

    autoJobTitle(files = this.newFiles, form = this.form) {
      const list = Array.from(files || []).filter(Boolean);
      if (list.length) {
        const first = this.fileTitlePart(list[0].name || '');
        return first + (list.length > 1 ? ` 외 ${list.length - 1}개` : '');
      }
      const project = String(form?.projectName || '').trim();
      const company = String(form?.companyName || '').trim();
      if (project) return project;
      if (company) return `${company} 작업`;
      return '';
    },

    syncAutoJobTitle(force = false) {
      const next = this.autoJobTitle();
      const current = String(this.form.title || '').trim();
      if (force || !current || current === this.autoTitleValue) {
        this.form.title = next;
        this.autoTitleValue = next;
      }
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
      this.applyFileGuessToNewForm(this.newFiles);
      this.syncAutoJobTitle();
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
      this.syncAutoJobTitle(true);
    },

    clearNewFiles() {
      this.newFiles = [];
      this.newUploadDragOver = false;
      this.autoTitleValue = '';
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
      return this.filteredFiles().filter(file => file.isImage && file.exists !== false);
    },

    sourceFiles() {
      return this.filteredFiles().filter(file => !file.isImage || file.exists === false);
    },

    orders() {
      return this.detail?.orders || [];
    },

    orderSummary() {
      return this.detail?.orderSummary || this.detail?.job?.orderSummary || {};
    },

    filteredOrderTargets() {
      const q = String(this.orderTargetQuery || '').trim().toLowerCase();
      const targets = this.orderTargets || [];
      if (!q) return targets.slice(0, 80);
      return targets.filter(target => {
        return [
          target.label,
          target.recipientEmail,
          target.recipientName,
          target.source,
        ].some(value => String(value || '').toLowerCase().includes(q));
      }).slice(0, 80);
    },

    onOrderTargetQuery() {
      const targets = this.filteredOrderTargets();
      if (!targets.length) return;
      if (!targets.some(target => target.id === this.orderForm.targetPreset)) {
        this.orderForm.targetPreset = targets[0].id;
        this.onOrderTargetPreset();
      }
    },

    onOrderTargetPreset() {
      const target = (this.orderTargets || []).find(t => t.id === this.orderForm.targetPreset);
      if (!target) return;
      this.orderForm.targetName = target.label || this.orderForm.targetName;
      this.orderForm.targetType = target.type || this.orderForm.targetType || 'internal';
      this.orderForm.deliveryMethod = target.deliveryMethod || (this.orderForm.targetType === 'external' ? 'email' : 'download');
      this.orderForm.recipientEmail = target.recipientEmail || '';
      this.orderForm.recipientCc = target.recipientCc || '';
      this.orderForm.recipientName = target.recipientName || '';
    },

    orderStatusLabel(status) {
      return this.orderStatuses?.[status] || status || '초안';
    },

    orderTargetTypeLabel(type) {
      return type === 'external' ? '외주/업체' : this.stageLabel('factory', '우리공장');
    },

    orderFormIsExternal() {
      return this.orderForm.targetType === 'external' || this.orderForm.deliveryMethod === 'email';
    },

    orderTargetHint() {
      if (!this.orderForm.targetPreset && !this.orderForm.targetName) return '';
      if (!this.orderFormIsExternal()) return `${this.stageLabel('factory', '공장')}/내부는 ERP에서 바로 파일을 받습니다.`;
      return String(this.orderForm.recipientEmail || '').trim()
        ? '메일주소 자동 입력됨 · 발송 전에 확인할 수 있습니다.'
        : '메일주소 없음 · 아래 입력하면 업체에 저장됩니다.';
    },

    createOrderButtonLabel() {
      return this.orderFormIsExternal() ? '업체 메일 준비' : '파일 받기 준비';
    },

    factoryOrderFiles() {
      return (this.detail?.files || []).filter(file => file.id && file.exists !== false);
    },

    canCreateQuickFactoryOrder() {
      return !!(this.detail?.job && this.factoryOrderFiles().length && !this.quickFactoryOrderSaving);
    },

    quickFactoryOrderButtonLabel() {
      if (this.quickFactoryOrderSaving) return '전달 중';
      const count = this.factoryOrderFiles().length;
      return count ? `${this.stageLabel('factory', '공장')} 전달 ${count}건` : '전달 파일 없음';
    },

    activeFactoryOrder() {
      return this.orders().find(order => {
        if (!order || this.isExternalOrder(order)) return false;
        return !['done', 'confirmed', 'cancelled'].includes(order.status || 'requested');
      }) || null;
    },

    factoryOrderCoversFiles(order, fileIds) {
      const ids = new Set(order?.fileIds || []);
      return fileIds.every(id => ids.has(id));
    },

    orderSelectableFiles() {
      return this.filteredFiles().filter(file => file.id && file.exists !== false);
    },

    selectedOrderFileIds() {
      const available = new Set((this.detail?.files || []).filter(file => file.id && file.exists !== false).map(file => file.id));
      return (this.orderSelectedFileIds || []).filter(id => available.has(id));
    },

    isOrderFileSelected(file) {
      return !!(file && file.id && this.selectedOrderFileIds().includes(file.id));
    },

    toggleOrderFileSelection(file) {
      if (!file?.id || file.exists === false) return;
      const selected = new Set(this.selectedOrderFileIds());
      if (selected.has(file.id)) selected.delete(file.id);
      else selected.add(file.id);
      this.orderSelectedFileIds = Array.from(selected);
    },

    selectVisibleOrderFiles() {
      this.orderSelectedFileIds = this.orderSelectableFiles().map(file => file.id);
    },

    clearOrderFileSelection() {
      this.orderSelectedFileIds = [];
    },

    currentOrderFileIds() {
      const selected = this.selectedOrderFileIds();
      if (selected.length) return selected;
      return this.orderSelectableFiles().map(file => file.id).filter(Boolean);
    },

    orderFileSelectionText() {
      const selected = this.selectedOrderFileIds();
      if (selected.length) return `선택 파일 ${selected.length}건 전달`;
      return `현재 표시 파일 ${this.orderSelectableFiles().length}건 전달`;
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
      if (!fileIds.length) return alert('전달할 파일이 없습니다.');
      if (!String(this.orderForm.targetName || '').trim()) return alert('전달 대상을 입력하세요.');
      const isExternal = this.orderFormIsExternal();
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/orders', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...this.orderForm, status: 'requested', fileIds }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '전달 생성 실패');
      const createdOrderId = d.order?.id || '';
      this.applyOrderResponse(d);
      this.clearOrderFileSelection();
      if (d.recipientSavedToVendor) await this.loadMeta();
      await this.loadJobs();
      if (isExternal) {
        const createdOrder = (this.detail?.orders || []).find(order => order.id === createdOrderId) || d.order;
        if (createdOrder) {
          this.openOrderMail(createdOrder);
          return;
        }
      }
      alert(`${this.stageLabel('factory', '공장')} 전달건을 만들었습니다. ERP에서 파일 받기만 누르면 됩니다.`);
    },

    async createQuickFactoryOrderPackage() {
      if (!this.detail || !this.detail.job || this.quickFactoryOrderSaving) return;
      const files = this.factoryOrderFiles();
      const fileIds = files.map(file => file.id).filter(Boolean);
      if (!fileIds.length) return alert('공장에 전달할 파일이 없습니다.');
      const existing = this.activeFactoryOrder();
      if (existing && this.factoryOrderCoversFiles(existing, fileIds)) {
        this.openOrderDelivery(existing);
        return;
      }
      const target = (this.orderTargets || []).find(item => item.id === 'factory') || {};
      this.quickFactoryOrderSaving = true;
      try {
        const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            targetPreset: 'factory',
            targetType: 'internal',
            targetName: target.label || this.stageLabel('factory', '우리공장'),
            deliveryMethod: 'download',
            dueDate: this.detail.job.dueDate || this.defaultWorkDate(),
            note: '',
            status: 'requested',
            fileIds,
          }),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) return alert(d.error || '공장 전달 생성 실패');
        this.applyOrderResponse(d);
        this.clearOrderFileSelection();
        this.orderPanelOpen = false;
        await this.loadJobs();
      } finally {
        this.quickFactoryOrderSaving = false;
      }
    },

    async saveOrder(order) {
      if (!this.detail || !this.detail.job || !order) return;
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/orders/' + encodeURIComponent(order.id), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(order),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '전달 저장 실패');
      this.applyOrderResponse(d);
      if (d.recipientSavedToVendor) await this.loadMeta();
      await this.loadJobs();
    },

    isExternalOrder(order) {
      return !!order && (order.deliveryMethod === 'email' || order.targetType === 'external');
    },

    orderRecipientEmail(order) {
      return String(order?.recipientEmail || order?.mailTo || '').trim();
    },

    hasOrderRecipientEmail(order) {
      return !!this.orderRecipientEmail(order);
    },

    orderMailAttachmentTooLarge(order) {
      const total = Number(order?.fileTotalSize || 0);
      const limit = Number(order?.mailAttachLimit || (24 * 1024 * 1024));
      return total > 0 && limit > 0 && total > limit;
    },

    orderMailAttachmentText(order) {
      if (!order) return '';
      const total = Number(order.fileTotalSize || 0);
      const limit = Number(order.mailAttachLimit || (24 * 1024 * 1024));
      const count = Number(order.fileCount || 0);
      const prefix = `자동저장 원본 ${count}개 · 총 ${this.fileSizeLabel(total)}`;
      if (this.orderMailAttachmentTooLarge(order)) {
        return `${prefix} · 첨부 한도 ${this.fileSizeLabel(limit)} 초과`;
      }
      return `${prefix} · 첨부 가능`;
    },

    orderMailLinkStateText() {
      if (!this.orderMailModal.open || this.orderMailModal.attachFiles) return '';
      return this.activePublicWorkflowBaseUrl()
        ? '터널 다운로드 링크가 본문에 포함됩니다.'
        : '링크 발송에는 워크플로우 외부 다운로드 주소가 필요합니다.';
    },

    orderMailModeText() {
      const modal = this.orderMailModal || {};
      if (!modal.open || !modal.order) return '';
      if (modal.attachFiles) return '발송 방식: 파일 첨부';
      if (this.activePublicWorkflowBaseUrl()) return '발송 방식: 터널 링크';
      return '발송 방식: 터널 주소 필요';
    },

    orderMailSubmitLabel() {
      const modal = this.orderMailModal || {};
      if (modal.sending) return '발송 중';
      return modal.attachFiles ? '첨부 메일 발송' : '링크 메일 발송';
    },

    canSendOrderMail() {
      const modal = this.orderMailModal;
      if (!modal.open || modal.sending) return false;
      if (!String(modal.toEmail || '').trim()) return false;
      if (!modal.attachFiles && !this.activePublicWorkflowBaseUrl()) return false;
      return true;
    },

    orderMailButtonLabel(order) {
      if (!this.isExternalOrder(order)) return '파일 받기';
      return this.hasOrderRecipientEmail(order) ? '메일 보내기' : '메일주소 입력';
    },

    orderActionLabel(order) {
      return this.orderMailButtonLabel(order);
    },

    orderActionIcon(order) {
      return this.isExternalOrder(order) ? 'mail' : 'download';
    },

    orderActionTitle(order) {
      return this.isExternalOrder(order)
        ? '외부업체에는 메일로 첨부 또는 다운로드 링크를 보냅니다'
        : `${this.stageLabel('factory', '공장')}/내부 수신자는 ERP에서 파일을 ZIP으로 받습니다`;
    },

    orderDeliveryStateText(order) {
      if (!order) return '';
      if (this.isExternalOrder(order)) {
        if (order.mailStatus === 'sent') return '업체 메일 발송 완료';
        if (this.hasOrderRecipientEmail(order)) return '업체 메일 발송 준비됨';
        return '업체 메일주소 입력 필요';
      }
      if (!this.orderArchiveUrl(order)) return '파일 링크 준비 중';
      if (this.isExternalWorkflowHost()) return '터널 접속 중 · 바로 다운로드';
      if (order.publicArchiveAbsoluteUrl) return '터널 다운로드 준비됨';
      return '내부망 다운로드 · 외부는 터널 주소 필요';
    },

    canOpenOrderDelivery(order) {
      if (!order) return false;
      if (this.isExternalOrder(order)) return true;
      return !!this.orderArchiveUrl(order);
    },

    openOrderDelivery(order) {
      if (!order) return;
      if (this.isExternalOrder(order)) {
        this.openOrderMail(order);
        return;
      }
      const url = this.orderArchiveUrl(order);
      if (!url) {
        alert('받을 파일 링크가 아직 준비되지 않았습니다.');
        return;
      }
      window.location.href = url;
    },

    defaultOrderMailSubject(order) {
      const job = this.detail?.job || {};
      const project = job.projectName || job.title || '';
      return `[제작요청] ${job.companyName || '프로젝트'}${project ? ' - ' + project : ''} / ${order?.targetName || '업체'}`;
    },

    defaultOrderMailMessage(order) {
      return [
        `${order?.targetName || '업체'} 담당자님,`,
        '',
        '제작 가능 여부와 납기 확인 부탁드립니다.',
        order?.dueDate ? `희망 납기: ${order.dueDate}` : '',
        '',
        '확인 후 회신 부탁드립니다.',
      ].filter(line => line !== '').join('\n');
    },

    openOrderMail(order) {
      if (!this.detail || !this.detail.job || !order) return;
      if (!this.isExternalOrder(order)) return alert('메일 발송은 외부업체 전달건에서 사용합니다.');
      const recipient = this.orderRecipientEmail(order);
      const tooLarge = this.orderMailAttachmentTooLarge(order);
      this.orderMailModal = {
        open: true,
        sending: false,
        order,
        toEmail: recipient,
        ccEmail: order.recipientCc || '',
        subject: order.mailSubject || this.defaultOrderMailSubject(order),
        message: order.note || this.defaultOrderMailMessage(order),
        attachFiles: !tooLarge,
        error: '',
        linkOnlySuggested: tooLarge,
      };
    },

    closeOrderMail() {
      if (this.orderMailModal.sending) return;
      this.orderMailModal.open = false;
      this.orderMailModal.order = null;
      this.orderMailModal.error = '';
    },

    async sendOrderMail() {
      const modal = this.orderMailModal;
      const order = modal.order;
      if (!this.detail || !this.detail.job || !order) return;
      if (!String(modal.toEmail || '').trim()) {
        modal.error = '받는 이메일을 입력하세요.';
        return;
      }
      if (!modal.attachFiles && !this.activePublicWorkflowBaseUrl()) {
        modal.error = '링크만 발송하려면 워크플로우 외부 다운로드 주소를 먼저 저장하세요.';
        return;
      }
      modal.sending = true;
      modal.error = '';
      try {
        const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/orders/' + encodeURIComponent(order.id) + '/email', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            toEmail: modal.toEmail,
            ccEmail: modal.ccEmail,
            subject: modal.subject,
            message: modal.message,
            attachFiles: !!modal.attachFiles,
          }),
        });
        const d = await r.json().catch(() => ({}));
        if (!r.ok || !d.ok) {
          if (r.status === 413) {
            modal.attachFiles = false;
            modal.linkOnlySuggested = true;
          }
          modal.error = d.error || '메일 발송 실패';
          return;
        }
        this.applyOrderResponse(d);
        if (d.recipientSavedToVendor) await this.loadMeta();
        await this.loadJobs();
        modal.sending = false;
        this.closeOrderMail();
        alert(d.message || '메일 발송 완료');
      } catch (e) {
        modal.error = e.message || '메일 발송 실패';
      } finally {
        modal.sending = false;
      }
    },

    orderArchiveUrl(order) {
      if (!order) return '';
      return order.publicArchiveAbsoluteUrl || this.absoluteUrl(order.publicArchiveUrl || '');
    },

    orderMailSentText(order) {
      if (!order || order.mailStatus !== 'sent') return '';
      const at = order.mailSentAt ? this.eventTime(order.mailSentAt) : '';
      const to = this.orderRecipientEmail(order);
      return ['메일', at, to].filter(Boolean).join(' · ');
    },

    orderPublicActivityText(order) {
      if (!order) return '';
      const parts = [];
      if (order.lastPublicViewedAt) parts.push('열람 ' + this.eventTime(order.lastPublicViewedAt));
      if (order.lastPublicDownloadedAt) {
        const count = Number(order.publicDownloadCount || 0);
        parts.push('다운로드 ' + this.eventTime(order.lastPublicDownloadedAt) + (count > 1 ? ` ${count}회` : ''));
      }
      return parts.join(' · ');
    },

    orderResponseText(order) {
      if (!order || !order.responseStatus) return '';
      const label = order.responseStatusLabel || this.scheduleNegotiationLabel(order.responseStatus);
      const parts = [label];
      if (order.responseAvailableDate) parts.push('가능일 ' + order.responseAvailableDate);
      const note = String(order.responseNote || '').trim().split(/\r?\n/)[0].slice(0, 80);
      if (note) parts.push(note);
      return parts.join(' · ');
    },

    orderResponseChipClass(order) {
      const status = order?.responseStatus || '';
      if (status === 'confirmed') return 'ready';
      if (status === 'needs_change') return 'high';
      if (status === 'possible') return 'unread';
      return '';
    },

    fileReviewLabel(status) {
      return ({ pending: '검토대기', approved: '승인', change_requested: '수정요청' })[status || 'pending'] || '검토대기';
    },

    scheduleNegotiationLabel(status) {
      return ({ pending: '일정확인', possible: '가능', needs_change: '조정요청', confirmed: '확정' })[status || 'pending'] || '일정확인';
    },

    fileScheduleChipClass(file) {
      if (!file) return '';
      if (file.scheduleLate) return 'overdue';
      const status = file.scheduleNegotiation || '';
      if (status === 'needs_change') return 'change_requested';
      if (status === 'confirmed' || status === 'possible') return 'ready';
      return '';
    },

    fileScheduleChipLabel(file) {
      if (!file) return '일정확인';
      if (file.scheduleLate) return '가능일 지연';
      return this.scheduleNegotiationLabel(file.scheduleNegotiation);
    },

    completionBlockerText(job) {
      const blockers = job?.completionBlockers || [];
      if (!blockers.length) return '완료 가능';
      return blockers.map(b => `${b.label} ${b.count}`).join(' · ');
    },

    archiveDateLabel(job) {
      const ts = job?.completedAt || job?.archiveUpdatedAt || '';
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return String(ts).slice(0, 10);
      return d.toLocaleDateString('ko-KR', { month: '2-digit', day: '2-digit' });
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

    stageLabel(stageId, fallback = '') {
      const stage = (this.stages || []).find(s => s.id === stageId);
      return stage?.label || fallback || stageId || '';
    },

    parallelStageLabel(separator = '/') {
      return ['management', 'factory'].map(id => this.stageLabel(id)).filter(Boolean).join(separator);
    },

    nextStage() {
      const current = this.currentStage();
      if (!current) return null;
      if (current.id === 'design') return { id: 'parallel', label: this.parallelStageLabel('/') };
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
      if (current.id === 'design') return `${current.label} 완료 · ${this.parallelStageLabel('/')} 전달`;
      if (current.id === 'management' || current.id === 'factory') {
        const otherId = current.id === 'management' ? 'factory' : 'management';
        const otherCheck = this.detail?.job?.stageChecks?.[otherId] || {};
        if (otherCheck.status !== 'done') return `${current.label} 완료`;
        return `${current.label} 완료 · ${this.stageLabel('delivery', '납품팀')} 전달`;
      }
      if (!next) return '작업 완료';
      return `${current.label} 완료 · ${next.label} 전달`;
    },

    async createJob() {
      if (!this.form.dueDate) this.form.dueDate = this.defaultWorkDate();
      if (this.newFiles.length && (!String(this.form.companyName || '').trim() || !String(this.form.projectName || '').trim())) {
        return alert('시안 파일을 같이 올릴 때는 회사명과 프로젝트명을 입력하세요.');
      }
      const payload = { ...this.form };
      payload.title = String(payload.title || '').trim() || this.autoJobTitle(this.newFiles, payload) || '워크플로우 작업';
      payload.dueDate = this.form.dueDate;
      this.saving = true;
      try {
        const r = await fetch('/api/workflow/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
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
        await this.loadDesignWorkflowOptions(true);
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
      this.loadContacts();
      this.loadDesignWorkflowOptions();
      this.syncAutoJobTitle();
      this.newOpen = true;
      setTimeout(() => {
        try { this.$refs?.newJobCompany?.focus(); } catch (_) {}
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
      if (keepOpen) {
        this.loadContacts();
        this.loadDesignWorkflowOptions();
        this.newOpen = true;
      }
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
      if (force) {
        this.detailMoreOpen = false;
        this.orderPanelOpen = false;
        this.historyPanelOpen = false;
        this.uploadOpen = false;
        this.orderSelectedFileIds = [];
      }
      this.uploadStageId = 'design';
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
        await this.loadDesignWorkflowOptions(true);
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
      this.historyPanelOpen = true;
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
    },

    async uploadFiles(ev) {
      const files = ev?.target?.files || ev?.dataTransfer?.files || ev;
      if (!this.detail || !files || !files.length) return;
      if (!this.canUploadToCurrentJob()) {
        alert('완료/취소된 작업에는 파일을 추가할 수 없습니다.');
        if (ev?.target) ev.target.value = '';
        return;
      }
      this.applyFileGuessToUpload(files);
      const storageCompanyName = String(this.uploadCompanyName || this.detail.job.companyName || '').trim();
      const storageProjectName = String(this.uploadProjectName || this.detail.job.projectName || this.detail.job.title || '').trim();
      if (!storageCompanyName || !storageProjectName) {
        alert('회사와 프로젝트를 먼저 선택해주세요.');
        return;
      }
      try {
        const result = await this.uploadFilesForJob(this.detail.job.id, files, {
          companyName: storageCompanyName,
          projectName: storageProjectName,
          designDueDate: this.uploadDesignDueDate || '',
          urgent: this.uploadUrgent,
          note: this.uploadNote || '',
          storageYear: this.uploadStorageYear(),
          targetLabel: this.uploadTargetLabel(),
        });
        this.clearStoragePreview(storageCompanyName, storageProjectName, result?.storage?.year || this.uploadStorageYear());
      } catch (e) {
        alert(e.message);
        return;
      } finally {
        if (ev?.target) ev.target.value = '';
      }
      this.uploadNote = '';
      this.uploadDesignDueDate = this.detail?.job?.dueDate || this.defaultWorkDate();
      this.uploadUrgent = false;
      await this.loadDesignWorkflowOptions(true);
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
            const storageText = data.storage?.created ? ' · 새 폴더 준비' : (data.storage?.rel ? ' · 저장 완료' : '');
            this.uploadProgress = { active: true, percent: 100, text: `${this.fileBatchLabel(list)} 업로드 완료${storageText}` };
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
    },

    fileUrl(file) {
      if (!file) return '#';
      if (file.exists === false) return '#';
      return file.downloadUrl || ('/api/workflow/files/' + encodeURIComponent(file.id) + '/download');
    },

    filePreviewUrl(file) {
      if (!file || !file.isImage) return '';
      if (file.exists === false) return '';
      return file.previewUrl || this.fileUrl(file);
    },

    fileThumbUrl(file) {
      if (!file || !file.isImage) return '';
      if (file.exists === false) return '';
      return file.thumbUrl || file.previewUrl || this.fileUrl(file);
    },

    handleWorkflowImageError(event, fallbackUrl = '') {
      const img = event?.target;
      if (!img) return;
      const fallback = String(fallbackUrl || '').trim();
      if (fallback && img.dataset.fallbackSrc !== fallback) {
        img.dataset.fallbackSrc = fallback;
        img.src = fallback;
        return;
      }
      const holder = img.closest ? img.closest('.wf-proof-thumb, .wf-card-visual') : null;
      if (holder) holder.classList.add('image-failed');
      img.style.visibility = 'hidden';
    },

    publicFileUrl(file) {
      return file && file.publicDownloadUrl ? file.publicDownloadUrl : '';
    },

    smartFileUrl(file) {
      if (!file || file.exists === false) return '#';
      const publicUrl = this.publicFileUrl(file);
      if (this.isExternalWorkflowHost() && publicUrl) return publicUrl;
      return this.fileUrl(file);
    },

    absoluteUrl(url) {
      if (!url) return '';
      try {
        const base = this.activePublicWorkflowBaseUrl() || window.location.origin;
        return new URL(url, base).toString();
      } catch (_) {
        return url;
      }
    },

    fileStorageTitle(file) {
      if (!file) return '';
      const parts = [file.originalName || 'file'];
      if (file.storedNameChanged && file.storedName) parts.push('저장명: ' + file.storedName);
      if (file.storageBucket) parts.push('저장경로: ' + file.storageBucket);
      if (file.storageFolderCreated) parts.push('새 폴더 자동 준비');
      return parts.join('\n');
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

    archiveSummaryText(job) {
      if (!job) return '';
      const parts = [];
      const at = this.eventTime(job.completedAt || job.archiveUpdatedAt || job.updatedAt || '');
      const who = String(job.completedByName || '').trim();
      if (at) parts.push((who ? who + ' · ' : '') + at + ' 완료');
      const count = Number(job.archiveFileCount || 0);
      parts.push(count ? `파일 ${count}개` : '보관 파일 없음');
      const storage = String(job.archiveStorageBucket || job.storageBucket || '').trim();
      if (storage) parts.push('저장경로 ' + storage);
      if (count) parts.push('다운로드/메일 원본');
      return parts.join(' · ');
    },

    jobArchiveUrl() {
      if (!this.detail || !this.detail.job) return '#';
      const qs = new URLSearchParams();
      if (this.fileStageFilter !== 'all') qs.set('stageId', this.fileStageFilter);
      if (this.fileKindFilter !== 'all') qs.set('kind', this.fileKindFilter);
      const query = qs.toString();
      return '/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/files/archive' + (query ? '?' + query : '');
    },

    isPrivateWorkflowHost(hostname = '') {
      const host = String(hostname || '').toLowerCase();
      return !host
        || host === 'localhost'
        || host === '127.0.0.1'
        || host === '::1'
        || host.startsWith('192.168.')
        || host.startsWith('10.')
        || /^172\.(1[6-9]|2\d|3[0-1])\./.test(host);
    },

    isExternalWorkflowHost() {
      try {
        return !this.isPrivateWorkflowHost(window.location.hostname);
      } catch (_) {
        return false;
      }
    },

    smartArchiveUrl(preferStoredArchive = false) {
      const job = this.detail && this.detail.job ? this.detail.job : {};
      const publicUrl = this.factoryArchiveUrl();
      if (this.isExternalWorkflowHost() && publicUrl) return publicUrl;
      if (preferStoredArchive && job.archiveUrl) return job.archiveUrl;
      return this.jobArchiveUrl();
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

    eventTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return ts;
      return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
  };
}
