// 조직도 Alpine.js 컴포넌트
function orgChartApp() {
  return {
    users: [],
    departments: [],
    loading: false,
    dragUser: null,
    dropTarget: null,
    editingExec: null,
    isAdmin: false,
    leaderDropTarget: null,
    searchQ: '',   // 검색어

    // 부서 색상 팔레트 (tab-orgchart.html의 --org-dept-colors 와 맞춰주세요)
    _deptPalette: [
      ['#2563eb','#1d4ed8'],  // 파랑
      ['#0891b2','#0e7490'],  // 시안
      ['#059669','#047857'],  // 초록
      ['#d97706','#b45309'],  // 주황
      ['#dc2626','#b91c1c'],  // 빨강
      ['#7c3aed','#6d28d9'],  // 보라
      ['#db2777','#be185d'],  // 핑크
      ['#0284c7','#0369a1'],  // 스카이
    ],
    deptColor(idx)     { return this._deptPalette[idx % this._deptPalette.length][0]; },
    deptColorDark(idx) { return this._deptPalette[idx % this._deptPalette.length][1]; },

    // 검색 하이라이트 클래스
    personClass(u) {
      if (!this.searchQ) return '';
      const q = this.searchQ.toLowerCase();
      const match = (u.name||'').toLowerCase().includes(q) || (u.position||'').toLowerCase().includes(q);
      return match ? 'search-highlight' : 'search-dim';
    },

    async init() {
      this.loading = true;
      try {
        const r = await fetch('/api/auth/me');
        if (r.ok) {
          const me = await r.json();
          this.isAdmin = me.role === 'admin';
        }
      } catch(e) {}
      await Promise.all([this.loadUsers(), this.loadDepts()]);
      this.loading = false;
    },

    async loadUsers() {
      try {
        const r = await fetch('/api/users/list');
        if (r.ok) this.users = await r.json();
      } catch (e) { this.users = []; }
    },

    async loadDepts() {
      try {
        const r = await fetch('/api/departments');
        if (r.ok) this.departments = await r.json();
      } catch (e) { this.departments = []; }
    },

    // 임원 (부서 없는 사람 중 직책이 대표이사/이사)
    get executives() {
      const execTitles = ['대표이사', '이사'];
      return this.users.filter(u =>
        !u.department && execTitles.includes(u.position)
      );
    },

    // 대표이사
    get ceo() {
      return this.users.find(u => u.position === '대표이사') || null;
    },

    // 이사급 (대표이사 제외)
    get directors() {
      const dirTitles = ['이사'];
      return this.users.filter(u => dirTitles.includes(u.position));
    },

    // 부서별 인원
    deptMembers(deptId) {
      return this.users.filter(u => u.department === deptId);
    },

    // 부서 팀장
    getDeptLeader(dept) {
      if (!dept.leaderId) return null;
      return this.users.find(u => u.id === dept.leaderId) || null;
    },

    // 부서 팀원 (팀장 제외)
    deptTeamMembers(deptId) {
      const dept = this.departments.find(d => d.id === deptId);
      if (!dept) return this.deptMembers(deptId);
      return this.deptMembers(deptId).filter(u => u.id !== dept.leaderId);
    },

    // 팀장 여부
    isLeader(dept, user) {
      return dept.leaderId === user.id;
    },

    // 팀장 지정 (admin only)
    async setDeptLeader(deptId, userId) {
      if (!this.isAdmin) return;
      try {
        const r = await fetch('/api/departments/' + deptId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leaderId: userId })
        });
        if (r.ok) {
          const dept = this.departments.find(d => d.id === deptId);
          if (dept) dept.leaderId = userId;
        }
      } catch(e) {
        console.error('팀장 지정 실패:', e);
      }
    },

    // 팀장 해제 (admin only)
    async removeDeptLeader(deptId) {
      if (!this.isAdmin) return;
      try {
        const r = await fetch('/api/departments/' + deptId, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ leaderId: null })
        });
        if (r.ok) {
          const dept = this.departments.find(d => d.id === deptId);
          if (dept) dept.leaderId = null;
        }
      } catch(e) {
        console.error('팀장 해제 실패:', e);
      }
    },

    // 미배정 (임원도 아니고 부서도 없는 사람)
    get unassigned() {
      const execTitles = ['대표이사', '이사'];
      return this.users.filter(u =>
        !u.department && !execTitles.includes(u.position)
      );
    },

    // 정렬된 부서
    get sortedDepts() {
      return [...this.departments].sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    },

    // 아바타 색상
    avatarColor(name) {
      const colors = ['#f59e0b','#ef4444','#8b5cf6','#06b6d4','#10b981','#f97316','#ec4899','#6366f1','#14b8a6','#e11d48'];
      let hash = 0;
      for (let i = 0; i < (name||'').length; i++) hash = name.charCodeAt(i) + ((hash << 5) - hash);
      return colors[Math.abs(hash) % colors.length];
    },

    // 이니셜
    initial(name) {
      return (name || '?')[0];
    },

    // ── 드래그 앤 드롭 ──
    onDragStart(e, userId) {
      this.dragUser = userId;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', userId);
      requestAnimationFrame(() => {
        const el = e.target.closest('.org-person');
        if (el) el.style.opacity = '0.4';
      });
    },

    onDragEnd(e) {
      const el = e.target.closest('.org-person');
      if (el) el.style.opacity = '1';
      this.dragUser = null;
      this.dropTarget = null;
      this.leaderDropTarget = null;
    },

    onDragOver(e, deptId) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.dropTarget = deptId;
    },

    onDragLeave(e, deptId) {
      const related = e.relatedTarget;
      const container = e.currentTarget;
      if (container.contains(related)) return;
      if (this.dropTarget === deptId) this.dropTarget = null;
    },

    // 팀장 슬롯 드래그 오버/리브
    onLeaderDragOver(e, deptId) {
      if (!this.isAdmin) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      this.leaderDropTarget = deptId;
    },
    onLeaderDragLeave(e, deptId) {
      const related = e.relatedTarget;
      const container = e.currentTarget;
      if (container.contains(related)) return;
      if (this.leaderDropTarget === deptId) this.leaderDropTarget = null;
    },

    // 팀장 슬롯에 드롭
    async onLeaderDrop(e, deptId) {
      e.preventDefault();
      this.leaderDropTarget = null;
      this.dropTarget = null;
      if (!this.isAdmin || !this.dragUser) return;

      const userId = this.dragUser;
      this.dragUser = null;

      // userId(로그인 ID)로 user를 찾아 내부 id를 가져옴
      const user = this.users.find(u => u.userId === userId);
      if (!user) return;

      // 이미 같은 부서 소속이면 그냥 팀장 지정
      if (user.department === deptId) {
        await this.setDeptLeader(deptId, user.id);
      } else {
        // 다른 부서이거나 미배정이면 먼저 부서 이동 후 팀장 지정
        try {
          const r = await fetch('/api/admin/users');
          if (!r.ok) return;
          const adminUsers = await r.json();
          const target = adminUsers.find(u => u.userId === userId);
          if (!target) return;

          await fetch('/api/admin/users/' + target.id + '/department', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ department: deptId })
          });
          await this.setDeptLeader(deptId, target.id);
          await this.loadUsers();
        } catch(e) {
          console.error('팀장 지정 실패:', e);
        }
      }
    },

    async onDrop(e, deptId) {
      e.preventDefault();
      this.dropTarget = null;
      if (!this.dragUser) return;

      const userId = this.dragUser;
      this.dragUser = null;

      try {
        const r = await fetch('/api/admin/users');
        if (!r.ok) return;
        const adminUsers = await r.json();
        const target = adminUsers.find(u => u.userId === userId);
        if (!target) return;

        await fetch('/api/admin/users/' + target.id + '/department', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ department: deptId })
        });

        // 기존 부서에서 팀장이었다면 해제
        for (const dept of this.departments) {
          if (dept.leaderId === target.id && dept.id !== deptId) {
            dept.leaderId = null;
            await fetch('/api/departments/' + dept.id, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ leaderId: null })
            });
          }
        }

        await this.loadUsers();
      } catch (e) {
        console.error('부서 이동 실패:', e);
      }
    },

    // 직책 순서 (정렬용)
    positionOrder(pos) {
      const order = { '대표이사':0, '이사':1, '실장':2, '팀장':3, '부장':4, '차장':5, '과장':6, '대리':7, '사원':8 };
      return order[pos] !== undefined ? order[pos] : 20;
    },

    // 부서 팀원 직책순 정렬 (팀장 제외)
    sortedTeamMembers(deptId) {
      return this.deptTeamMembers(deptId).sort((a, b) =>
        this.positionOrder(a.position) - this.positionOrder(b.position)
      );
    }
  };
}
