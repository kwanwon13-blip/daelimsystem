function workflowApp() {
  return {
    loading: true,
    saving: false,
    jobs: [],
    stages: [],
    statuses: {},
    checkStatuses: {},
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
    contactOptions: [],
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
    fileStageFilter: 'all',
    fileKindFilter: 'all',
    filePreview: { open: false, file: null, zoom: 1, fit: true },
    expandedFileId: '',
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
      await Promise.all([this.loadAuth(), this.loadMeta(), this.loadContacts()]);
      if (!this.form.dueDate) this.form.dueDate = this.defaultWorkDate();
      await this.loadJobs();
      this.consumeWorkflowDraft();
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

    myActionItems() {
      return this.summary?.myActionItems || [];
    },

    scheduleItems() {
      return this.summary?.scheduleItems || [];
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

    workflowProjectNames() {
      const names = [];
      if (this.detail?.job?.projectName) names.push(this.detail.job.projectName);
      for (const job of this.jobs || []) {
        if (job.projectName) names.push(job.projectName);
      }
      return Array.from(new Set(names.filter(Boolean))).sort((a, b) => String(a).localeCompare(String(b), 'ko'));
    },

    workflowCompanyNames() {
      const names = [];
      if (this.detail?.job?.companyName) names.push(this.detail.job.companyName);
      for (const job of this.jobs || []) {
        if (job.companyName) names.push(job.companyName);
      }
      for (const contact of this.contactOptions || []) {
        if (contact.company) names.push(contact.company);
      }
      return Array.from(new Set(names.map(v => String(v || '').trim()).filter(Boolean)))
        .sort((a, b) => a.localeCompare(b, 'ko'));
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
      const company = String(this.form.companyName || '').trim() || '회사 미입력';
      const project = String(this.form.projectName || '').trim() || '프로젝트 미입력';
      return `${this.newStorageYear()} / ${company} / ${project}`;
    },

    fileSizeLabel(size) {
      const n = Number(size || 0);
      if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
      if (n >= 1024) return `${Math.round(n / 1024)} KB`;
      return `${n} B`;
    },

    setNewFiles(files) {
      const incoming = Array.from(files || []).filter(Boolean);
      if (!incoming.length) return;
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
      this.query = '';
      this.statusFilter = 'all';
      this.scopeFilter = 'all';
      await this.loadJobs();
      await this.selectJob(item.jobId);
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
      this.query = '';
      this.statusFilter = 'all';
      this.scopeFilter = 'all';
      await this.loadJobs();
      await this.selectJob(item.jobId);
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
      await this.loadJobs();
      await this.refreshDetail(false);
    },

    async uploadFilesForJob(jobId, files, options = {}) {
      const list = Array.from(files || []).filter(Boolean);
      if (!jobId || !list.length) return null;
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
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(jobId) + '/files', {
        method: 'POST',
        body: fd,
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '파일 업로드 실패');
      return d;
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

    eventTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return ts;
      return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
  };
}
