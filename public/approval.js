// 결재 시스템 Alpine.js 컴포넌트
function approvalApp() {
  return {
    // 상태
    approvals: [],
    departments: [],
    allUsers: [],
    loading: false,
    currentView: 'list',  // list | write | detail
    activeFilter: 'all',  // all | mine | pending
    activeDeptFolder: '',  // '' = 전체, 부서명 = 해당 부서 폴더

    // 새 문서 작성
    docType: 'expense',   // expense | leave
    docTitle: '',
    docApproverId: '',
    formData: {},

    // 상세 보기
    selectedDoc: null,
    processComment: '',

    // 지출결의서 폼 기본값
    expenseForm: {
      date: new Date().toISOString().slice(0, 10),
      items: [{ description: '', amount: 0, note: '' }],
      paymentMethod: 'card',  // card | cash | transfer
      account: '',
      purpose: ''
    },

    // 휴가계획서 폼 기본값
    leaveForm: {
      leaveType: '연차',
      startDate: '',
      endDate: '',
      reason: '',
      emergency_contact: ''
    },

    // 휴가유형 목록 (서버에서 로드)
    leaveTypes: [],
    selectedLeaveType: null,  // 선택된 휴가유형 객체

    // 현재 로그인 유저 ID (메인 앱에서 가져옴)
    myUserId: '',
    myRole: '',

    // 초기화
    async init() {
      // 메인 앱의 auth 정보 가져오기
      try {
        const mainApp = document.querySelector('body[x-data]')?._x_dataStack?.[0];
        if (mainApp?.auth) {
          this.myUserId = mainApp.auth.userId || '';
          this.myRole = mainApp.auth.role || '';
        }
      } catch (e) {}
      await this.loadDepartments();
      await this.loadUsers();
      await this.loadApprovals();
      await this.loadLeaveTypes();
    },

    async loadLeaveTypes() {
      try {
        const r = await fetch('/api/leave/settings');
        if (r.ok) {
          const settings = await r.json();
          this.leaveTypes = (settings.leaveTypes || []).filter(t => t.showInApproval !== false);
        }
      } catch (e) { console.warn('휴가유형 로드 실패:', e); }
    },

    async loadDepartments() {
      try {
        const r = await fetch('/api/departments');
        if (r.ok) this.departments = await r.json();
      } catch (e) { console.error('부서 로드 실패:', e); }
    },

    async loadUsers() {
      try {
        const r = await fetch('/api/users/list');
        if (r.ok) this.allUsers = await r.json();
      } catch (e) {
        this.allUsers = [];
      }
    },

    async loadApprovals() {
      this.loading = true;
      try {
        const params = new URLSearchParams();
        if (this.activeFilter === 'mine') params.set('filter', 'mine');
        else if (this.activeFilter === 'pending') params.set('filter', 'pending');
        else if (this.activeFilter === 'deleted') params.set('filter', 'deleted');
        if (this.activeDeptFolder) params.set('dept', this.activeDeptFolder);
        const qs = params.toString();
        const r = await fetch('/api/approvals' + (qs ? '?' + qs : ''));
        if (r.ok) this.approvals = await r.json();
      } catch (e) { console.error('결재 목록 로드 실패:', e); }
      this.loading = false;
    },

    // 필터 변경
    setFilter(f) {
      this.activeFilter = f;
      this.loadApprovals();
    },

    // 부서 폴더 선택
    setDeptFolder(deptName) {
      this.activeDeptFolder = this.activeDeptFolder === deptName ? '' : deptName;
      this.loadApprovals();
    },

    // 부서별 문서 수 집계 (현재 로드된 목록 기준)
    get deptFolders() {
      if (this.myRole !== 'admin') return [];
      const map = {};
      for (const d of this.approvals) {
        const dept = d.authorDept || '(부서 미배정)';
        map[dept] = (map[dept] || 0) + 1;
      }
      // 전체 목록에서 집계하기 위해 departments 순서로 정렬
      return Object.entries(map)
        .map(([name, count]) => ({ name, count }))
        .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
    },

    // 새 문서 작성 시작
    async startWrite(type) {
      this.docType = type || 'expense';
      this.docTitle = '';
      this.docApproverId = '';
      this.processComment = '';
      // 폼 초기화
      this.expenseForm = {
        date: new Date().toISOString().slice(0, 10),
        items: [{ description: '', amount: 0, note: '' }],
        paymentMethod: 'card',
        account: '',
        purpose: ''
      };
      this.leaveForm = {
        leaveType: '연차',
        startDate: '',
        endDate: '',
        reason: '',
        emergency_contact: ''
      };
      this.selectedLeaveType = this.leaveTypes.find(t => t.name === '연차') || null;
      this.currentView = 'write';

      // 부서 팀장을 기본 결재자로 자동 선택
      try {
        const r = await fetch('/api/my-department-leader');
        if (r.ok) {
          const data = await r.json();
          if (data.leader) {
            // approverList에서 해당 팀장의 userId로 매칭
            const match = this.approverList.find(u => u.userId === data.leader.userId);
            if (match) {
              this.docApproverId = match.userId;
            }
          }
        }
      } catch(e) {
        console.log('부서 팀장 자동선택 실패:', e);
      }
    },

    // 연차 자유 날짜 선택 여부 (연차차감 유형이면서 고정일수가 1일인 경우 = 자유 선택)
    get isVariableDaysLeave() {
      const lt = this.selectedLeaveType;
      if (!lt) return false;
      return lt.deductsAnnual && lt.days <= 1 && lt.days > 0.5;
    },

    // 선택 날짜 범위에서 평일 수 계산 (예상 차감일수)
    get estimatedLeaveDays() {
      if (!this.isVariableDaysLeave || !this.leaveForm.startDate || !this.leaveForm.endDate) return null;
      const start = new Date(this.leaveForm.startDate + 'T00:00:00');
      const end = new Date(this.leaveForm.endDate + 'T00:00:00');
      if (end < start) return 0;
      let count = 0;
      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) count++;
      }
      return count;
    },

    // 휴가유형 변경 시
    onLeaveTypeChange() {
      const typeName = this.leaveForm.leaveType;
      this.selectedLeaveType = this.leaveTypes.find(t => t.name === typeName) || null;
      // 자유 선택 유형이면 종료일 유지, 그 외는 자동 계산
      if (!this.isVariableDaysLeave && this.leaveForm.startDate && this.selectedLeaveType) {
        this.calcLeaveEndDate();
      }
    },

    // 시작일 변경 시 종료일 자동 계산 (고정 유형만)
    onLeaveStartChange() {
      if (this.isVariableDaysLeave) {
        // 자유 선택: 시작일 이전 종료일이면 종료일을 시작일로 맞춤
        if (this.leaveForm.endDate && this.leaveForm.endDate < this.leaveForm.startDate) {
          this.leaveForm.endDate = this.leaveForm.startDate;
        }
        return;
      }
      if (this.selectedLeaveType && this.leaveForm.startDate) {
        this.calcLeaveEndDate();
      }
    },

    // 종료일 자동 계산 (고정일수 유형만)
    calcLeaveEndDate() {
      const lt = this.selectedLeaveType;
      if (!lt || !this.leaveForm.startDate) return;
      const days = lt.days || 1;
      if (days <= 0.5) {
        this.leaveForm.endDate = this.leaveForm.startDate;
        return;
      }
      const start = new Date(this.leaveForm.startDate + 'T00:00:00');
      let remaining = days - 1;
      const end = new Date(start);
      while (remaining > 0) {
        end.setDate(end.getDate() + 1);
        const dow = end.getDay();
        if (dow !== 0 && dow !== 6) remaining--;
      }
      const yy = end.getFullYear();
      const mm = String(end.getMonth() + 1).padStart(2, '0');
      const dd = String(end.getDate()).padStart(2, '0');
      this.leaveForm.endDate = `${yy}-${mm}-${dd}`;
    },

    // 휴가유형 카테고리별 그룹
    get leaveTypeGroups() {
      const groups = {};
      for (const t of this.leaveTypes) {
        const cat = t.category || '기타';
        if (!groups[cat]) groups[cat] = [];
        groups[cat].push(t);
      }
      return groups;
    },

    // 지출결의서 항목 추가/삭제
    addExpenseItem() {
      this.expenseForm.items.push({ description: '', amount: 0, note: '' });
    },
    removeExpenseItem(idx) {
      if (this.expenseForm.items.length > 1) this.expenseForm.items.splice(idx, 1);
    },

    // 지출 합계
    get expenseTotal() {
      return this.expenseForm.items.reduce((s, item) => s + (Number(item.amount) || 0), 0);
    },

    // 승인 가능한 사용자 목록 (본인 제외)
    get approverList() {
      const myId = this.$root?.dataset?.userId || '';
      return this.allUsers.filter(u => u.userId !== myId && u.status === 'approved');
    },

    // 부서명 가져오기
    getDeptName(deptId) {
      const d = this.departments.find(dept => dept.id === deptId);
      return d ? d.name : '';
    },

    // 문서 제출
    async submitDoc() {
      const fd = this.docType === 'expense' ? { ...this.expenseForm } : { ...this.leaveForm };

      // 자동 제목 생성
      if (!this.docTitle) {
        if (this.docType === 'expense') {
          this.docTitle = '[지출결의] ' + (this.expenseForm.purpose || this.expenseForm.items[0]?.description || '');
        } else {
          const lt = this.selectedLeaveType;
          // 자유 선택 연차(변동일수)는 실제 선택된 일수, 고정 유형은 lt.days 사용
          const actualDays = (this.isVariableDaysLeave && this.estimatedLeaveDays !== null)
            ? this.estimatedLeaveDays
            : (lt ? lt.days : 1);
          const dateRange = (this.leaveForm.startDate && this.leaveForm.endDate && this.leaveForm.startDate !== this.leaveForm.endDate)
            ? `${this.leaveForm.startDate}~${this.leaveForm.endDate}`
            : (this.leaveForm.startDate || '');
          this.docTitle = '[휴가] ' + (this.leaveForm.leaveType || '연차') + ` (${actualDays}일) ` + dateRange;
        }
      }

      if (!this.docApproverId) {
        this.showToast3('승인자를 선택해주세요', 'error');
        return;
      }

      try {
        const r = await fetch('/api/approvals', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: this.docType,
            title: this.docTitle,
            approverId: this.docApproverId,
            formData: fd
          })
        });
        const result = await r.json();
        if (r.ok) {
          this.showToast3('결재 요청이 제출되었습니다', 'success');
          this.currentView = 'list';
          this.loadApprovals();
        } else {
          this.showToast3(result.error || '제출 실패', 'error');
        }
      } catch (e) {
        this.showToast3('네트워크 오류', 'error');
      }
    },

    // 문서 상세 보기
    async viewDoc(doc) {
      this.selectedDoc = doc;
      this.processComment = '';
      this.currentView = 'detail';
    },

    // 승인/반려 처리
    async processDoc(action) {
      if (!this.selectedDoc) return;
      try {
        const r = await fetch(`/api/approvals/${this.selectedDoc.id}/process`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action, comment: this.processComment })
        });
        const result = await r.json();
        if (r.ok) {
          this.showToast3(action === 'approved' ? '승인 완료' : '반려 완료', 'success');
          this.currentView = 'list';
          this.loadApprovals();
        } else {
          this.showToast3(result.error || '처리 실패', 'error');
        }
      } catch (e) {
        this.showToast3('네트워크 오류', 'error');
      }
    },

    // 문서 삭제 (소프트 삭제 — 복구 가능)
    async deleteDoc(id, isCompleted) {
      const msg = isCompleted
        ? '완료된 결재 문서를 삭제하시겠습니까?\n휴지통에서 복구할 수 있습니다.'
        : '이 결재 문서를 회수(삭제)하시겠습니까?\n휴지통에서 복구할 수 있습니다.';
      if (!confirm(msg)) return;
      try {
        const r = await fetch(`/api/approvals/${id}`, { method: 'DELETE' });
        if (r.ok) {
          this.showToast3('삭제됨. 휴지통에서 복구 가능합니다.', 'success');
          if (this.currentView === 'detail') this.currentView = 'list';
          this.loadApprovals();
        } else {
          const e = await r.json();
          this.showToast3(e.error || '삭제 실패', 'error');
        }
      } catch (e) {
        this.showToast3('삭제 실패', 'error');
      }
    },

    // 문서 복구 (admin 전용)
    async restoreDoc(id) {
      if (!confirm('이 문서를 복구하시겠습니까?')) return;
      try {
        const r = await fetch(`/api/approvals/${id}/restore`, { method: 'POST' });
        if (r.ok) {
          this.showToast3('복구되었습니다', 'success');
          if (this.currentView === 'detail') this.currentView = 'list';
          this.loadApprovals();
        } else {
          const e = await r.json();
          this.showToast3(e.error || '복구 실패', 'error');
        }
      } catch (e) {
        this.showToast3('복구 실패', 'error');
      }
    },

    // 상태 라벨/색상
    statusLabel(s) {
      return { pending: '대기', approved: '승인', rejected: '반려', deleted: '삭제됨' }[s] || s;
    },
    statusColor(s) {
      return {
        pending: 'background:#fef3c7;color:#b45309;',
        approved: 'background:#dcfce7;color:#15803d;',
        rejected: 'background:#fee2e2;color:#dc2626;',
        deleted: 'background:#f3f4f6;color:#6b7280;'
      }[s] || '';
    },

    // 문서 타입 라벨
    typeLabel(t) {
      return { expense: '지출결의서', leave: '휴가계획서' }[t] || t;
    },
    typeIcon(t) {
      return { expense: 'receipt_long', leave: 'event_available' }[t] || 'description';
    },

    // 간단 토스트
    _toast3: { show: false, msg: '', type: 'success' },
    showToast3(msg, type) {
      this._toast3 = { show: true, msg, type: type || 'success' };
      setTimeout(() => { this._toast3.show = false; }, 2500);
    },

    // 날짜 포맷
    fmtDate(d) {
      if (!d) return '-';
      return new Date(d).toLocaleDateString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit' });
    },
    fmtDateTime(d) {
      if (!d) return '-';
      return new Date(d).toLocaleString('ko-KR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    },

    // 휴가 타입 라벨 (하위 호환 + 새 체계)
    leaveTypeLabel(t) {
      const legacy = { annual: '연차', half: '반차', sick: '병가', special: '특별휴가' };
      if (legacy[t]) return legacy[t];
      // 새 체계는 이름이 곧 라벨
      return t || '-';
    },

    // 결제수단 라벨
    payMethodLabel(m) {
      return { card: '법인카드', cash: '현금', transfer: '계좌이체' }[m] || m;
    }
  };
}
