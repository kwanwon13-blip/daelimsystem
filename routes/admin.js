/**
 * routes/admin.js — 관리자 사용자 관리 + 부서 관리
 * - /api/admin/users/* (requireAdmin)
 * - /api/users/list (requireAuth)
 * - /api/departments/* (requireAuth / requireAdmin)
 * - /api/my-department-leader (requireAuth)
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { sessions, hashPassword, requireAuth, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// ── 관리자: 사용자 관리 ──────────────────────────────────
router.get('/admin/users', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  // 연차관리 직원 목록 로드 (CAPS 연동 확인용)
  let leaveEmployees = [];
  try {
    const leaveData = db['연차관리'] ? db['연차관리'].load() : {};
    leaveEmployees = leaveData.employees || [];
  } catch(e) {}
  // 비밀번호 제외하고 반환
  const users = (uData.users || []).map(u => ({
    id: u.id, userId: u.userId, name: u.name, role: u.role, status: u.status,
    sabun: u.sabun || '',
    position: u.position || '', phone: u.phone || '',
    department: u.department || '', companyId: u.companyId || 'dalim-sm',
    hireDate: u.hireDate || '', resignDate: u.resignDate || '',
    birthDate: u.birthDate || '', email: u.email || '',
    permissions: u.permissions || [],
    createdAt: u.createdAt, lastLogin: u.lastLogin,
    capsName: u.capsName || '',
    attendanceRule: u.attendanceRule || 'general',
    leaveLinked: leaveEmployees.some(e => e.name === u.name && !e.resignDate),
  }));
  res.json(users);
});

// 관리자 직접 계정 생성
router.post('/admin/users/create', requireAdmin, (req, res) => {
  const { userId, password, name, role, position, phone, department, companyId } = req.body;
  if (!userId || !password || !name) return res.status(400).json({ error: '아이디, 비밀번호, 이름을 모두 입력해주세요' });
  if (userId.length < 3) return res.status(400).json({ error: '아이디는 3자 이상이어야 합니다' });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다' });

  const uData = db.loadUsers();
  if (!uData.users) uData.users = [];
  if (uData.users.some(u => u.userId === userId)) {
    return res.status(400).json({ error: '이미 존재하는 아이디입니다' });
  }

  uData.users.push({
    id: db.generateId('u'), userId, name,
    position: position || '', phone: phone || '',
    department: department || '', companyId: companyId || 'dalim-sm',
    password: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    status: 'approved', // 관리자가 만든 계정은 바로 승인
    createdAt: new Date().toISOString(), lastLogin: null
  });
  db.saveUsers(uData);

  // 연차관리에 직원 자동 등록 (이름 매칭으로 CAPS 연동)
  try {
    const leaveData = db['연차관리'] ? db['연차관리'].load() : {};
    if (!leaveData.employees) leaveData.employees = [];
    const existing = leaveData.employees.find(e => e.name === name);
    if (!existing) {
      // 부서명 조회
      let deptName = '';
      if (department) {
        const dept = (uData.departments || []).find(d => d.id === department);
        if (dept) deptName = dept.name;
      }
      leaveData.employees.push({
        name, department: deptName, position: position || '',
        hireDate: req.body.hireDate || '', resignDate: '',
        annualLeave: 0, additionalDays: 0, deductedDays: 0,
        totalLeave: 0, usedDays: 0, paidDays: 0, remainingDays: 0, yearlyData: {}
      });
      if (db['연차관리']) db['연차관리'].save(leaveData);
    }
  } catch(e) { console.error('연차관리 자동등록 오류:', e.message); }

  auditLog(req.user.userId, `${name} (${userId}) 계정 생성`, name);
  res.json({ ok: true, message: `${name} (${userId}) 계정 생성 완료` });
});

// 사용자 승인
router.post('/admin/users/:id/approve', requireAdmin, (req, res) => {
  const { linkToEmployee, department } = req.body || {};
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.status = 'approved';
  if (department) user.department = department;
  db.saveUsers(uData);

  // 연차관리 연동
  try {
    const leaveData = db['연차관리'].load();
    if (!leaveData.employees) leaveData.employees = [];

    if (linkToEmployee) {
      // 기존 직원과 연결: 이름 매칭된 직원의 정보 업데이트
      const existing = leaveData.employees.find(e => e.name === linkToEmployee);
      if (existing) {
        // 퇴사자였으면 복직 처리
        if (existing.resignDate) {
          existing.resignDate = '';
          console.log(`✅ 복직 처리: ${existing.name} (퇴사일 해제)`);
        }
        // 부서/직위 업데이트
        const deptObj = (uData.departments || []).find(d => d.id === user.department);
        if (deptObj) existing.department = deptObj.name;
        if (user.position) existing.position = user.position;
        if (user.hireDate && !existing.hireDate) existing.hireDate = user.hireDate;
        db['연차관리'].save(leaveData);
        console.log(`✅ 연차관리 연동: ${user.name} → 기존 직원 '${linkToEmployee}'과 연결 (부서: ${existing.department})`);
      } else {
        console.warn(`⚠️ 연차관리에서 '${linkToEmployee}' 직원을 찾을 수 없음`);
      }
    } else {
      // 새 직원 등록 (이름 일치하는 기존 직원이 없는 경우만)
      const exists = leaveData.employees.find(e => e.name === user.name);
      if (!exists) {
        const deptObj = (uData.departments || []).find(d => d.id === user.department);
        leaveData.employees.push({
          name: user.name,
          department: deptObj ? deptObj.name : '',
          position: user.position || '',
          hireDate: user.hireDate || '',
          resignDate: '',
          annualLeave: 0,
          additionalDays: 0,
          deductedDays: 0,
          totalLeave: 0,
          usedDays: 0,
          paidDays: 0,
          remainingDays: 0,
          yearlyData: {}
        });
        db['연차관리'].save(leaveData);
      }
    }
  } catch(e) { console.warn('연차관리 자동등록 실패:', e.message); }

  const linked = linkToEmployee ? ` (기존 직원 '${linkToEmployee}'과 연결)` : '';
  auditLog(req.user.userId, '사용자 승인', user.name);
  res.json({ ok: true, message: user.name + ' 승인 완료' + linked });
});

// 사용자 거절
router.post('/admin/users/:id/reject', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.status = 'rejected';
  db.saveUsers(uData);
  auditLog(req.user.userId, '사용자 거절', user.name);
  res.json({ ok: true, message: user.name + ' 거절' });
});

// 퇴사 처리
router.post('/admin/users/:id/resign', requireAdmin, (req, res) => {
  const { resignDate } = req.body;
  if (!resignDate) return res.status(400).json({ error: '퇴사일을 입력해주세요' });

  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });

  user.status = 'resigned';
  user.resignDate = resignDate;
  db.saveUsers(uData);

  // 연차관리에도 퇴사일 반영
  try {
    const leaveData = db['연차관리'].load();
    const emp = (leaveData.employees || []).find(e => e.name === user.name);
    if (emp) {
      emp.resignDate = resignDate;
      db['연차관리'].save(leaveData);
    }
  } catch(e) {}

  // 해당 사용자의 세션 무효화
  for (const [token, session] of Object.entries(sessions)) {
    if (session.userId === user.userId) delete sessions[token];
  }

  auditLog(req.user.userId, '퇴사 처리', user.name, { resignDate });
  res.json({ ok: true, message: user.name + ' 퇴사 처리 완료' });
});

// 퇴사 복귀 (퇴사 취소)
router.post('/admin/users/:id/reinstate', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });

  user.status = 'approved';
  user.resignDate = '';
  db.saveUsers(uData);

  // 연차관리에도 퇴사일 제거
  try {
    const leaveData = db['연차관리'].load();
    const emp = (leaveData.employees || []).find(e => e.name === user.name);
    if (emp) {
      emp.resignDate = '';
      db['연차관리'].save(leaveData);
    }
  } catch(e) {}

  auditLog(req.user.userId, '퇴사 취소 (복귀)', user.name);
  res.json({ ok: true, message: user.name + ' 복귀 처리 완료' });
});

// 사용자 삭제
router.delete('/admin/users/:id', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  if (!uData.users) uData.users = [];
  const target = uData.users.find(u => u.id === req.params.id);
  if (target && target.role === 'admin' && uData.users.filter(u => u.role === 'admin').length <= 1) {
    return res.status(400).json({ error: '마지막 관리자는 삭제할 수 없습니다' });
  }
  const targetName = target ? target.name : req.params.id;
  uData.users = uData.users.filter(u => u.id !== req.params.id);
  db.saveUsers(uData);
  auditLog(req.user.userId, '사용자 삭제', targetName);
  res.json({ ok: true });
});

// 사용자 역할 변경
router.post('/admin/users/:id/role', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  const newRole = req.body.role;
  if (newRole !== 'admin' && newRole !== 'user') return res.status(400).json({ error: '유효하지 않은 역할' });
  // 마지막 관리자 체크
  if (user.role === 'admin' && newRole === 'user') {
    const adminCount = uData.users.filter(u => u.role === 'admin').length;
    if (adminCount <= 1) return res.status(400).json({ error: '마지막 관리자의 역할을 변경할 수 없습니다' });
  }
  user.role = newRole;
  db.saveUsers(uData);
  auditLog(req.user.userId, '역할 변경', user.name, { newRole });
  res.json({ ok: true });
});

// 비밀번호 초기화 (관리자)
// 보안 강화:
//  - 하드코딩 '1234' 기본값 제거 → admin이 암호를 주지 않으면 암호학적 랜덤 임시 비밀번호 생성
//  - mustChangePassword 플래그 세팅 → 다음 로그인 시 반드시 변경
//  - 대상 사용자의 활성 세션 전부 무효화 (세션 탈취/구세션 재사용 방지)
router.post('/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const crypto = require('crypto');
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });

  // admin이 직접 지정한 경우에만 그 값을 사용, 아니면 12자리 랜덤 생성
  const provided = (req.body.password || '').trim();
  let newPw = provided;
  if (!newPw) {
    // 사람이 전달 가능한 문자만 사용 (혼동되는 0/O/1/l/I 제외)
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    const buf = crypto.randomBytes(12);
    newPw = Array.from(buf).map(b => alphabet[b % alphabet.length]).join('');
  } else if (newPw.length < 6) {
    return res.status(400).json({ error: '비밀번호는 최소 6자 이상이어야 합니다' });
  }

  user.password = hashPassword(newPw);
  user.mustChangePassword = true;
  user.passwordResetAt = new Date().toISOString();
  db.saveUsers(uData);

  // 해당 사용자의 활성 세션을 모두 만료시킨다
  let killed = 0;
  for (const token of Object.keys(sessions)) {
    if (sessions[token] && sessions[token].userId === user.userId) {
      delete sessions[token];
      killed++;
    }
  }

  auditLog(req.user.userId, '비밀번호 초기화', user.name, { sessionsInvalidated: killed });
  res.json({
    ok: true,
    tempPassword: newPw,
    mustChangePassword: true,
    sessionsInvalidated: killed,
    message: `${user.name}의 임시 비밀번호가 발급되었습니다. 최초 로그인 시 반드시 변경해야 합니다.`
  });
});

// 사용자별 메뉴 권한 설정 (관리자)
router.post('/admin/users/:id/permissions', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.permissions = req.body.permissions || [];
  db.saveUsers(uData);
  res.json({ ok: true, permissions: user.permissions });
});

// 팀/부서 단위 권한 일괄 수정 (관리자)
// body: { userIds: string[], permissions: string[], operation: 'replace'|'add'|'remove' }
// - replace: 해당 유저들의 권한을 permissions 로 덮어쓰기
// - add: 기존 권한 + permissions 합집합
// - remove: 기존 권한 - permissions 차집합
// admin 역할 유저는 대상에서 자동 제외 (admin 은 전체 권한 고정)
router.post('/admin/users/bulk-permissions', requireAdmin, (req, res) => {
  const { userIds, permissions = [], operation = 'replace' } = req.body || {};
  if (!Array.isArray(userIds) || userIds.length === 0) {
    return res.status(400).json({ error: '대상 userIds 필요' });
  }
  if (!Array.isArray(permissions)) {
    return res.status(400).json({ error: 'permissions 배열 필요' });
  }
  if (!['replace', 'add', 'remove'].includes(operation)) {
    return res.status(400).json({ error: 'operation 은 replace|add|remove' });
  }

  const uData = db.loadUsers();
  const allUsers = uData.users || [];
  const updated = [];
  const skipped = [];

  for (const id of userIds) {
    const user = allUsers.find(u => u.id === id);
    if (!user) { skipped.push({ id, reason: 'not_found' }); continue; }
    if (user.role === 'admin') { skipped.push({ id, reason: 'admin' }); continue; }
    if (user.status === 'resigned') { skipped.push({ id, reason: 'resigned' }); continue; }

    const cur = Array.isArray(user.permissions) ? user.permissions : [];
    let next;
    if (operation === 'replace') {
      next = [...new Set(permissions)];
    } else if (operation === 'add') {
      next = [...new Set([...cur, ...permissions])];
    } else { // remove
      const removeSet = new Set(permissions);
      next = cur.filter(p => !removeSet.has(p));
    }
    user.permissions = next;
    updated.push({ id: user.id, name: user.name, permissions: next });
  }

  db.saveUsers(uData);
  res.json({
    ok: true,
    updatedCount: updated.length,
    skippedCount: skipped.length,
    updated,
    skipped
  });
});

// ── 권한 프리셋 CRUD (관리자) ──
router.get('/admin/perm-presets', requireAdmin, (req, res) => {
  try {
    const data = db['설정'].load();
    res.json(data.permPresets || []);
  } catch(e) { res.json([]); }
});

router.post('/admin/perm-presets', requireAdmin, (req, res) => {
  const { name, perms } = req.body;
  if (!name || !Array.isArray(perms)) return res.status(400).json({ error: '이름과 권한 배열 필요' });
  const data = db['설정'].load();
  if (!data.permPresets) data.permPresets = [];
  // 같은 이름이면 덮어쓰기
  const idx = data.permPresets.findIndex(p => p.name === name);
  if (idx >= 0) data.permPresets[idx] = { name, perms };
  else data.permPresets.push({ name, perms });
  db['설정'].save(data);
  res.json(data.permPresets);
});

router.delete('/admin/perm-presets/:name', requireAdmin, (req, res) => {
  const data = db['설정'].load();
  if (!data.permPresets) data.permPresets = [];
  data.permPresets = data.permPresets.filter(p => p.name !== req.params.name);
  db['설정'].save(data);
  res.json(data.permPresets);
});

// 사용자 프로필 수정 (관리자)
router.post('/admin/users/:id/profile', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  const oldName = user.name;
  if (req.body.name !== undefined) user.name = req.body.name;
  if (req.body.position !== undefined) user.position = req.body.position;
  if (req.body.phone !== undefined) user.phone = req.body.phone;
  if (req.body.department !== undefined) user.department = req.body.department;
  if (req.body.hireDate !== undefined) user.hireDate = req.body.hireDate;
  if (req.body.resignDate !== undefined) user.resignDate = req.body.resignDate;
  if (req.body.capsName !== undefined) user.capsName = req.body.capsName;
  if (req.body.companyId !== undefined) user.companyId = req.body.companyId;
  if (req.body.attendanceRule !== undefined) user.attendanceRule = req.body.attendanceRule; // general|flex|exempt|exclude
  db.saveUsers(uData);

  // ── 연차관리 자동 동기화 ──
  try {
    const leaveData = db['연차관리'].load();
    const emp = (leaveData.employees || []).find(e => e.name === oldName || e.name === user.name);
    if (emp) {
      if (req.body.name !== undefined) emp.name = user.name;
      if (req.body.position !== undefined) emp.position = user.position;
      if (req.body.hireDate !== undefined && user.hireDate) emp.hireDate = user.hireDate;
      if (req.body.department !== undefined) {
        const deptObj = (uData.departments || []).find(d => d.id === user.department);
        if (deptObj) emp.department = deptObj.name;
      }
      db['연차관리'].save(leaveData);
    }
  } catch(e) { console.error('연차관리 동기화 실패:', e.message); }

  // ── 출퇴근 근태규칙 동기화 (exclude 설정만 반영) ──
  if (req.body.attendanceRule !== undefined) {
    try {
      const attData = db['출퇴근관리'].load();
      const empName = user.capsName || user.name;
      if (!attData.excludeEmployees) attData.excludeEmployees = [];
      if (req.body.attendanceRule === 'exclude') {
        if (!attData.excludeEmployees.includes(empName)) attData.excludeEmployees.push(empName);
      } else {
        attData.excludeEmployees = attData.excludeEmployees.filter(n => n !== empName && n !== oldName);
      }
      db['출퇴근관리'].save(attData);
    } catch(e) { console.error('출퇴근 근태규칙 동기화 실패:', e.message); }
  }

  res.json({ ok: true });
});

// 일반 사용자도 접근 가능한 사용자 목록 (결재 승인자 선택용)
router.get('/users/list', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const excludeAdmin = req.query.excludeAdmin === 'true';
  const users = (uData.users || [])
    .filter(u => u.status === 'approved' && (!excludeAdmin || u.role !== 'admin'))
    .map(u => ({
      id: u.id, userId: u.userId, name: u.name,
      position: u.position || '', department: u.department || '',
      status: u.status || 'approved',
      role: u.role || 'user',
      capsName: u.capsName || ''
    }));
  res.json(users);
});

// ── 부서(조직도) 관리 ──────────────────────────────────
router.get('/departments', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  res.json(uData.departments || []);
});

router.post('/departments', requireAdmin, (req, res) => {
  const { name, sortOrder } = req.body;
  if (!name) return res.status(400).json({ error: '부서명을 입력해주세요' });
  const uData = db.loadUsers();
  if (!uData.departments) uData.departments = [];
  if (uData.departments.find(d => d.name === name)) return res.status(400).json({ error: '이미 존재하는 부서입니다' });
  uData.departments.push({
    id: db.generateId('dept'),
    name, companyId: req.body.companyId || 'dalim-sm',
    sortOrder: sortOrder || uData.departments.length,
    createdAt: new Date().toISOString()
  });
  db.saveUsers(uData);
  res.json({ ok: true, departments: uData.departments });
});

router.put('/departments/:id', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  const dept = (uData.departments || []).find(d => d.id === req.params.id);
  if (!dept) return res.status(404).json({ error: '부서 없음' });
  if (req.body.name !== undefined) dept.name = req.body.name;
  if (req.body.sortOrder !== undefined) dept.sortOrder = req.body.sortOrder;
  if (req.body.leaderId !== undefined) dept.leaderId = req.body.leaderId || null;
  if (req.body.companyId !== undefined) dept.companyId = req.body.companyId;
  db.saveUsers(uData);
  res.json({ ok: true, dept });
});

router.delete('/departments/:id', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  if (!uData.departments) uData.departments = [];
  // 해당 부서 소속 사용자가 있는지 확인
  const hasMembers = (uData.users || []).some(u => u.department === req.params.id);
  if (hasMembers) return res.status(400).json({ error: '소속 직원이 있는 부서는 삭제할 수 없습니다' });
  uData.departments = uData.departments.filter(d => d.id !== req.params.id);
  db.saveUsers(uData);
  res.json({ ok: true });
});

// 사용자 부서 배정
router.post('/admin/users/:id/department', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.department = req.body.department || '';
  db.saveUsers(uData);
  res.json({ ok: true });
});

// 내 부서 팀장 조회
router.get('/my-department-leader', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const me = (uData.users || []).find(u => u.userId === req.user.userId);
  if (!me || !me.department) return res.json({ leader: null });
  const dept = (uData.departments || []).find(d => d.id === me.department);
  if (!dept || !dept.leaderId) return res.json({ leader: null });
  const leader = (uData.users || []).find(u => u.id === dept.leaderId);
  if (!leader) return res.json({ leader: null });
  res.json({ leader: { id: leader.id, userId: leader.userId, name: leader.name, position: leader.position } });
});

// ══════════════════════════════════════════════════════
// 회사(Company) 관리 API
// ══════════════════════════════════════════════════════

// 회사 목록 조회
router.get('/companies', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  res.json({ ok: true, companies: uData.companies || [] });
});

// 회사 추가
router.post('/companies', requireAdmin, (req, res) => {
  const { name, bizNo, ceo, tel, address, note } = req.body;
  if (!name) return res.status(400).json({ error: '회사명을 입력해주세요' });
  const uData = db.loadUsers();
  if (!uData.companies) uData.companies = [];

  // id 자동 생성 (회사명 기반 slug)
  const id = name.replace(/[^가-힣a-zA-Z0-9]/g, '').toLowerCase() || db.generateId('co');
  if (uData.companies.some(c => c.id === id || c.name === name)) {
    return res.status(400).json({ error: '이미 존재하는 회사입니다' });
  }

  uData.companies.push({
    id, name, bizNo: bizNo || '', ceo: ceo || '', tel: tel || '',
    address: address || '', note: note || '',
    sortOrder: uData.companies.length,
    createdAt: new Date().toISOString()
  });
  db.saveUsers(uData);
  res.json({ ok: true, companies: uData.companies });
});

// 회사 수정
router.put('/companies/:id', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  const co = (uData.companies || []).find(c => c.id === req.params.id);
  if (!co) return res.status(404).json({ error: '회사 없음' });
  if (req.body.name !== undefined) co.name = req.body.name;
  if (req.body.bizNo !== undefined) co.bizNo = req.body.bizNo;
  if (req.body.ceo !== undefined) co.ceo = req.body.ceo;
  if (req.body.tel !== undefined) co.tel = req.body.tel;
  if (req.body.address !== undefined) co.address = req.body.address;
  if (req.body.note !== undefined) co.note = req.body.note;
  if (req.body.sortOrder !== undefined) co.sortOrder = req.body.sortOrder;
  db.saveUsers(uData);
  res.json({ ok: true, companies: uData.companies });
});

// 회사 삭제
router.delete('/companies/:id', requireAdmin, (req, res) => {
  const uData = db.loadUsers();
  // 소속 직원이 있으면 삭제 불가
  const hasUsers = (uData.users || []).some(u => u.companyId === req.params.id && u.status !== 'resigned');
  if (hasUsers) return res.status(400).json({ error: '소속 직원이 있는 회사는 삭제할 수 없습니다' });
  uData.companies = (uData.companies || []).filter(c => c.id !== req.params.id);
  db.saveUsers(uData);
  res.json({ ok: true, companies: uData.companies });
});

// 직원 회사 일괄 변경
router.post('/admin/users/bulk-company', requireAdmin, (req, res) => {
  const { userIds, companyId } = req.body;
  if (!userIds || !companyId) return res.status(400).json({ error: 'userIds, companyId 필수' });
  const uData = db.loadUsers();
  let count = 0;
  for (const uid of userIds) {
    const user = (uData.users || []).find(u => u.id === uid);
    if (user) { user.companyId = companyId; count++; }
  }
  db.saveUsers(uData);
  res.json({ ok: true, updated: count });
});

// ══════════════════════════════════════════════════════════
// ── 서버 제어 (admin-only) — 재시작/정지/상태 ────────────
// 와치독(proxy-watchdog.bat / 서버_프록시모드_와치독.bat)이 3초 뒤 재기동
// 정지는 server-stop.flag를 만들어서 와치독도 종료시킴
// ══════════════════════════════════════════════════════════
const path = require('path');
const fs = require('fs');

router.get('/admin/server/status', requireAdmin, (req, res) => {
  const uptimeSec = Math.floor(process.uptime());
  const memMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
  res.json({
    ok: true,
    pid: process.pid,
    port: 3000,
    uptimeSec,
    uptimeText: formatUptime(uptimeSec),
    memoryMB: memMB,
    nodeVersion: process.version,
    salaryMode: (process.env.SALARY_MODE || 'local').toLowerCase(),
    startedAt: new Date(Date.now() - uptimeSec * 1000).toISOString(),
  });
});

router.post('/admin/server/restart', requireAdmin, (req, res) => {
  const by = req.user?.userId || 'unknown';
  console.log(`[server-ctl] RESTART requested by ${by}`);
  try { auditLog(by, 'server-restart', null, { ip: req.ip }); } catch(e) {}
  res.json({ ok: true, msg: '재시작 중... (3초 후 와치독이 서버를 다시 시작합니다)' });
  // 응답 후 잠깐 기다렸다가 프로세스 종료
  setTimeout(() => {
    console.log('[server-ctl] exiting for restart');
    process.exit(0);
  }, 500);
});

router.post('/admin/server/stop', requireAdmin, (req, res) => {
  const by = req.user?.userId || 'unknown';
  console.log(`[server-ctl] STOP requested by ${by}`);
  try { auditLog(by, 'server-stop', null, { ip: req.ip }); } catch(e) {}
  const flagPath = path.join(__dirname, '..', 'server-stop.flag');
  try {
    fs.writeFileSync(flagPath, new Date().toISOString(), 'utf8');
    console.log('[server-ctl] stop.flag created:', flagPath);
  } catch (e) {
    console.error('[server-ctl] stop.flag 생성 실패:', e.message);
    return res.status(500).json({ error: 'stop.flag 생성 실패: ' + e.message });
  }
  res.json({ ok: true, msg: '정지 중... (다시 켜려면 트레이에서 Start Server 클릭 또는 원격 컨트롤 데몬 사용)' });
  setTimeout(() => {
    console.log('[server-ctl] exiting for stop');
    process.exit(0);
  }, 500);
});

function formatUptime(sec) {
  if (sec < 60) return `${sec}초`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  if (m < 60) return `${m}분 ${s}초`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  if (h < 24) return `${h}시간 ${mm}분`;
  const d = Math.floor(h / 24);
  const hh = h % 24;
  return `${d}일 ${hh}시간 ${mm}분`;
}

module.exports = router;
