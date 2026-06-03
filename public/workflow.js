function workflowApp() {
  return {
    loading: true,
    saving: false,
    jobs: [],
    stages: [],
    statuses: {},
    checkStatuses: {},
    selectedId: '',
    detail: null,
    query: '',
    statusFilter: 'active',
    newOpen: false,
    contactOptions: [],
    commentText: '',
    uploadStageId: '',
    uploadKind: 'attachment',
    uploadNote: '',
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
      await Promise.all([this.loadMeta(), this.loadContacts()]);
      await this.loadJobs();
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
        })).filter(c => c.name || c.company);
      } catch (_) {
        this.contactOptions = [];
      }
    },

    async loadJobs() {
      this.loading = true;
      const qs = new URLSearchParams();
      if (this.query.trim()) qs.set('q', this.query.trim());
      if (this.statusFilter) qs.set('status', this.statusFilter);
      try {
        const r = await fetch('/api/workflow/jobs?' + qs.toString());
        const d = await r.json();
        this.jobs = d.jobs || [];
        if (this.selectedId && !this.jobs.find(j => j.id === this.selectedId)) this.selectedId = '';
        if (!this.selectedId && this.jobs[0]) await this.selectJob(this.jobs[0].id);
        if (!this.selectedId && !this.jobs[0]) this.detail = null;
        if (this.selectedId) await this.refreshDetail(false);
      } finally {
        this.loading = false;
      }
    },

    jobsForStage(stageId) {
      return this.jobs.filter(j => (j.currentStage || 'design') === stageId);
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

    async createJob() {
      if (!this.form.title.trim()) return alert('작업명을 입력하세요.');
      this.saving = true;
      try {
        const r = await fetch('/api/workflow/jobs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(this.form),
        });
        const d = await r.json();
        if (!r.ok || !d.ok) throw new Error(d.error || '작업 생성 실패');
        this.resetForm();
        this.newOpen = false;
        await this.loadJobs();
        await this.selectJob(d.job.id);
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
        dueDate: '',
        deliveryDate: '',
        priority: 'normal',
        summary: '',
      };
    },

    async selectJob(id) {
      this.selectedId = id;
      await this.refreshDetail(true);
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
      this.uploadStageId = this.uploadStageId || d.job.currentStage || 'design';
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

    async addComment() {
      if (!this.detail || !this.commentText.trim()) return;
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/events', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: this.commentText }),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '댓글 저장 실패');
      this.commentText = '';
      await this.refreshDetail(false);
    },

    async uploadFiles(ev) {
      const files = ev.target.files;
      if (!this.detail || !files || !files.length) return;
      const fd = new FormData();
      Array.from(files).forEach(f => fd.append('files', f));
      fd.append('stageId', this.uploadStageId || this.detail.job.currentStage || 'design');
      fd.append('kind', this.uploadKind || 'attachment');
      fd.append('note', this.uploadNote || '');
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/files', {
        method: 'POST',
        body: fd,
      });
      ev.target.value = '';
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '파일 업로드 실패');
      this.uploadNote = '';
      await this.loadJobs();
      await this.refreshDetail(false);
    },

    async markRead(file) {
      if (!this.detail || !file) return;
      const r = await fetch('/api/workflow/jobs/' + encodeURIComponent(this.detail.job.id) + '/files/' + encodeURIComponent(file.id) + '/read', {
        method: 'POST',
      });
      const d = await r.json();
      if (!r.ok || !d.ok) return alert(d.error || '확인 처리 실패');
      await this.refreshDetail(false);
    },

    fileUrl(file) {
      return '/api/workflow/files/' + encodeURIComponent(file.id) + '/download';
    },

    eventTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      if (Number.isNaN(d.getTime())) return ts;
      return d.toLocaleString('ko-KR', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },
  };
}
