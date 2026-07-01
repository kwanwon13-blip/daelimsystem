/**
 * routes/approvals.js — 결재 시스템 + 결재 위임
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { notify } = require('../utils/notify');

// 결재 위임 여부 확인 — userId가 위임받은 사람이 있으면 대리인 반환, 없으면 원래 userId 반환
function getEffectiveApprover(userId) {
  try {
    const delegateData = db['결재위임'].load();
    if (!delegateData.delegates || !Array.isArray(delegateData.delegates)) return userId;

    const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    const activeDelegate = delegateData.delegates.find(d =>
      d.위임자 === userId && d.시작일 <= today && d.종료일 >= today
    );

    return activeDelegate ? activeDelegate.대리인 : userId;
  } catch (e) {
    console.error('[결재위임] 확인 실패:', e.message);
    return userId;
  }
}

// 결재 문서 접근 가능 여부 판단 헬퍼
function canViewApproval(doc, user, uData) {
  if (user.role === 'admin') return true;
  if (doc.authorId === user.userId) return true;        // 본인 기안
  if (doc.approverId === user.userId) return true;      // 본인 결재 대상

  // 팀장이면 같은 부서원 문서 조회 가능
  const me = (uData.users || []).find(u => u.userId === user.userId);
  if (me && me.department) {
    const myDept = (uData.departments || []).find(d => d.id === me.department);
    if (myDept && myDept.leaderId === me.id) {
      // 같은 부서에 속한 직원이 작성한 문서인지 확인
      const author = (uData.users || []).find(u => u.userId === doc.authorId);
      if (author && author.department === me.department) return true;
    }
  }
  return false;
}

// ── 결재 대리/위임 API (/:id 보다 먼저 등록해야 충돌 방지) ──

// 위임 설정 추가
router.post('/delegate', requireAuth, (req, res) => {
  const { 대리인, 시작일, 종료일, 사유 } = req.body;
  if (!대리인 || !시작일 || !종료일) {
    return res.status(400).json({ error: '필수 항목 누락' });
  }

  try {
    const delegateData = db['결재위임'].load();
    const newDelegate = {
      id: `del_${Date.now()}`,
      위임자: req.user.userId,
      대리인,
      시작일,
      종료일,
      사유: 사유 || '',
      생성일: new Date().toISOString()
    };

    delegateData.delegates.push(newDelegate);
    db['결재위임'].save(delegateData);

    auditLog(req.user.userId, '결재 위임 설정', `${대리인}에게 위임 (${시작일}~${종료일})`);
    res.json({ ok: true, delegate: newDelegate });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 내 위임 목록 조회
router.get('/delegates', requireAuth, (req, res) => {
  try {
    const delegateData = db['결재위임'].load();
    const myDelegates = (delegateData.delegates || []).filter(d => d.위임자 === req.user.userId);
    res.json({ delegates: myDelegates });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 위임 취소
router.delete('/delegate/:id', requireAuth, (req, res) => {
  try {
    const delegateData = db['결재위임'].load();
    const delegate = delegateData.delegates.find(d => d.id === req.params.id);

    if (!delegate) return res.status(404).json({ error: '위임 기록 없음' });
    if (delegate.위임자 !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: '본인의 위임만 취소할 수 있습니다' });
    }

    delegateData.delegates = delegateData.delegates.filter(d => d.id !== req.params.id);
    db['결재위임'].save(delegateData);

    auditLog(req.user.userId, '결재 위임 취소', delegate.대리인);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 추가근무(컴퍼니) — 전실장이 직원별 대신 입력 + 월별 집계 ───────────
// 컴퍼니 부서장(전실장) 또는 admin만. '결재형'(대기 → 사장님 승인). /:id 보다 먼저 등록.
function isCompanyTeamLeader(user, uData) {
  try {
    const me = (uData.users || []).find(u => u.userId === user.userId);
    if (!me) return false;
    if ((me.companyId || 'dalim-sm') !== 'dalim-company') return false;
    const dept = (uData.departments || []).find(d => d.id === me.department);
    return !!(dept && dept.leaderId === me.id);
  } catch (e) { return false; }
}
function canCompanyOvertime(user, uData) {
  return user.role === 'admin' || isCompanyTeamLeader(user, uData);
}

// 추가근무 기안 (대상 직원 + 날짜 + 시간(소수점) + 사유) — 입력자: 전실장/admin
router.post('/overtime-add', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  if (!canCompanyOvertime(req.user, uData)) {
    return res.status(403).json({ error: '추가근무 등록 권한이 없습니다 (관리자·컴퍼니 팀장)' });
  }
  const { targetUserId, date, hours, reason } = req.body;
  if (!targetUserId || !date || hours === undefined || hours === null) {
    return res.status(400).json({ error: '대상 직원, 날짜, 시간을 입력해주세요' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
    return res.status(400).json({ error: '날짜 형식이 올바르지 않습니다' });
  }
  const hoursNum = Math.round(Number(hours) * 10) / 10;
  if (!(hoursNum > 0) || hoursNum > 24) {
    return res.status(400).json({ error: '시간은 0 초과 24 이하로 입력해주세요' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: '사유를 입력해주세요' });
  }
  const target = (uData.users || []).find(u => u.userId === targetUserId);
  if (!target) return res.status(400).json({ error: '대상 직원을 찾을 수 없습니다' });
  if ((target.companyId || 'dalim-sm') !== 'dalim-company') {
    return res.status(400).json({ error: '컴퍼니 직원만 등록할 수 있습니다' });
  }

  // 승인자 = 관리자(사장님). 없으면 입력자 자신(폴백).
  const adminUser = (uData.users || []).find(u => u.role === 'admin');
  const approverId = adminUser ? adminUser.userId : req.user.userId;
  const approverName = adminUser ? adminUser.name : req.user.name;
  const effectiveApproverId = getEffectiveApprover(approverId);
  const effectiveApprover = (uData.users || []).find(u => u.userId === effectiveApproverId);
  const isDelegated = effectiveApproverId !== approverId;

  if (!uData.approvals) uData.approvals = [];
  const authorDept = (() => {
    const u = (uData.users || []).find(u2 => u2.userId === req.user.userId);
    const dept = (uData.departments || []).find(d => d.id === (u ? u.department : ''));
    return dept ? dept.name : '';
  })();

  const doc = {
    id: db.generateId('appr'),
    type: '추가근무',
    title: `추가근무 — ${target.name} ${date} (${hoursNum}시간)`,
    authorId: req.user.userId,
    authorName: req.user.name,
    authorDept,
    approverId,
    approverName,
    effectiveApproverId,
    approverDelegatedTo: (isDelegated && effectiveApprover) ? effectiveApprover.name : null,
    isDelegated,
    companyId: 'dalim-company',
    status: 'pending',
    formData: {
      targetUserId, targetName: target.name,
      date, hours: hoursNum, reason: String(reason).trim()
    },
    comment: '',
    createdAt: new Date().toISOString(),
    processedAt: null
  };
  uData.approvals.push(doc);
  db.saveUsers(uData);

  auditLog(req.user.userId, '추가근무 등록', `${target.name} ${date} ${hoursNum}시간`);
  notify(effectiveApproverId, 'approval',
    `${req.user.name}님이 ${target.name} 추가근무를 등록했습니다: ${date} ${hoursNum}시간`,
    'approvals');

  res.json({ ok: true, id: doc.id });
});

// 추가근무 월별 직원별 집계 (컴퍼니) — admin / 컴퍼니 팀장
router.get('/overtime-summary', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  if (!canCompanyOvertime(req.user, uData)) {
    return res.status(403).json({ error: '집계 열람 권한이 없습니다' });
  }
  const month = String(req.query.month || '');
  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month=YYYY-MM 형식으로 요청해주세요' });
  }
  // 컴퍼니 소속 판정(스토어드 companyId 누락 대비: 유저 현재 companyId 또는 소속부서 companyId)
  const companyDeptIds = new Set((uData.departments || []).filter(dp => dp.companyId === 'dalim-company').map(dp => dp.id));
  const userIsCompany = (userId, name) => {
    const u = (uData.users || []).find(x => (userId && x.userId === userId) || (!userId && name && x.name === name));
    if (!u) return false;
    if ((u.companyId || '') === 'dalim-company') return true;
    return !!(u.department && companyDeptIds.has(u.department));
  };
  const overtimeHrs = (s, e) => {
    if (!s || !e) return 0;
    const toMin = t => { const p = String(t).split(':'); return (Number(p[0]) || 0) * 60 + (Number(p[1]) || 0); };
    const diff = toMin(e) - toMin(s);
    return diff > 0 ? Math.round((diff / 60) * 10) / 10 : 0;
  };
  // 컴퍼니 추가근무(대신입력·시간단위) + 시간외근무(자기기안·시작~종료) 둘 다 합산
  const docs = (uData.approvals || []).filter(d =>
    (d.type === '추가근무' || d.type === '시간외근무') &&
    d.status !== 'deleted' &&
    d.formData && typeof d.formData.date === 'string' &&
    d.formData.date.slice(0, 7) === month
  );
  const byEmp = {};
  for (const d of docs) {
    const fd = d.formData || {};
    let h, personId, personName, startTime = '', endTime = '';
    if (d.type === '추가근무') {
      h = Number(fd.hours) || 0;
      personId = fd.targetUserId || '';
      personName = fd.targetName || '';
    } else { // 시간외근무 — 자기기안, 시작~종료로 시간 계산. 컴퍼니 소속만.
      if (d.companyId !== 'dalim-company' && !userIsCompany(d.authorId, d.authorName)) continue;
      startTime = fd.startTime || ''; endTime = fd.endTime || '';
      h = overtimeHrs(startTime, endTime);
      personId = d.authorId || '';
      personName = d.authorName || '';
    }
    const key = personId || personName || '(미상)';
    if (!byEmp[key]) {
      byEmp[key] = { userId: personId, name: personName || '(미상)',
        entries: [], approvedHours: 0, pendingHours: 0, pendingIds: [] };
    }
    byEmp[key].entries.push({
      id: d.id, date: fd.date, hours: Math.round(h * 10) / 10, reason: fd.reason || '',
      status: d.status, kind: d.type, startTime, endTime, enteredBy: d.authorName
    });
    if (d.status === 'approved') byEmp[key].approvedHours += h;
    else if (d.status === 'pending') {
      byEmp[key].pendingHours += h;
      if (d.type === '추가근무') byEmp[key].pendingIds.push(d.id); // 일괄승인은 추가근무만(시간외근무는 결재함서 승인)
    }
  }
  const employees = Object.values(byEmp).map(e => {
    e.entries.sort((a, b) => String(a.date).localeCompare(String(b.date)));
    e.approvedHours = Math.round(e.approvedHours * 10) / 10;
    e.pendingHours = Math.round(e.pendingHours * 10) / 10;
    return e;
  }).sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  const totalApproved = Math.round(employees.reduce((s, e) => s + e.approvedHours, 0) * 10) / 10;
  const totalPending = Math.round(employees.reduce((s, e) => s + e.pendingHours, 0) * 10) / 10;
  res.json({ month, employees, totalApproved, totalPending, canApprove: req.user.role === 'admin' });
});

// 추가근무 일괄 승인/반려 (admin=사장님 또는 해당 승인자) — 집계 화면 직원별 묶음 처리
router.post('/overtime-bulk-process', requireAuth, (req, res) => {
  const { ids, action, comment } = req.body;
  if (!Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: '처리할 항목이 없습니다' });
  }
  if (action !== 'approved' && action !== 'rejected') {
    return res.status(400).json({ error: 'action은 approved 또는 rejected여야 합니다' });
  }
  const uData = db.loadUsers();
  let changed = 0;
  const touched = [];
  for (const id of ids) {
    const doc = (uData.approvals || []).find(d => d.id === id && d.type === '추가근무');
    if (!doc || doc.status !== 'pending') continue;
    const approverId = doc.effectiveApproverId || doc.approverId;
    if (req.user.role !== 'admin' && approverId !== req.user.userId) continue;
    doc.status = action;
    doc.comment = comment || '';
    doc.processedAt = new Date().toISOString();
    doc.approvedBy = req.user.userId;
    changed++;
    touched.push(doc);
  }
  if (changed) db.saveUsers(uData);
  auditLog(req.user.userId, `추가근무 ${action === 'approved' ? '승인' : '반려'}`, `${changed}건`);
  if (changed) {
    const byAuthor = {};
    for (const d of touched) byAuthor[d.authorId] = (byAuthor[d.authorId] || 0) + 1;
    for (const [authorId, cnt] of Object.entries(byAuthor)) {
      if (authorId === req.user.userId) continue;
      notify(authorId, 'approval',
        `추가근무 ${cnt}건이 ${action === 'approved' ? '승인' : '반려'}되었습니다`,
        'approvals');
    }
  }
  res.json({ ok: true, changed });
});

// ── 결재 문서 목록 조회 ──────────────────────────────────
router.get('/', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  let docs = uData.approvals || [];
  // 추가근무(컴퍼니 대신입력)는 결재함 목록에서 제외 — 전용 '월별 집계' 화면에서만 관리
  docs = docs.filter(d => d.type !== '추가근무');
  const { filter, status, dept } = req.query;
  const myId = req.user.userId;

  // 회사별 필터 (관리자는 전체, 일반은 자기 회사만)
  if (req.user.role !== 'admin') {
    const myCompany = req.user.companyId || 'dalim-sm';
    docs = docs.filter(d => !d.companyId || d.companyId === myCompany);
    docs = docs.filter(d => canViewApproval(d, req.user, uData));
  }

  // 휴지통 필터 (admin 전용)
  if (filter === 'deleted') {
    docs = docs.filter(d => d.status === 'deleted');
  } else {
    // 기본: deleted 상태는 숨김
    docs = docs.filter(d => d.status !== 'deleted');
    if (filter === 'mine') {
      docs = docs.filter(d => d.authorId === myId);
    } else if (filter === 'pending') {
      docs = docs.filter(d => d.status === 'pending' && d.approverId === myId);
    }
  }

  // 부서별 폴더 필터 (조직도 연동)
  if (dept) {
    if (dept === '__none__') {
      docs = docs.filter(d => !d.authorDept || d.authorDept === '');
    } else {
      docs = docs.filter(d => d.authorDept === dept);
    }
  }

  if (status) {
    docs = docs.filter(d => d.status === status);
  }

  // 최신순 정렬
  docs.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json(docs);
});

// 결재 문서 상세 조회
router.get('/:id', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });
  if (!canViewApproval(doc, req.user, uData)) {
    return res.status(403).json({ error: '열람 권한이 없습니다' });
  }
  res.json(doc);
});

// 결재 문서 작성 (기안)
router.post('/', requireAuth, (req, res) => {
  const { type, title, approverId, formData } = req.body;
  if (!type || !title || !approverId) {
    return res.status(400).json({ error: '문서 종류, 제목, 승인자를 입력해주세요' });
  }
  const uData = db.loadUsers();
  if (!uData.approvals) uData.approvals = [];

  // 승인자 존재 확인
  const approver = (uData.users || []).find(u => u.userId === approverId);
  if (!approver) return res.status(400).json({ error: '승인자를 찾을 수 없습니다' });

  // ── 위임 여부 확인 ──
  const effectiveApproverId = getEffectiveApprover(approverId);
  const effectiveApprover = (uData.users || []).find(u => u.userId === effectiveApproverId);
  const isDelegated = effectiveApproverId !== approverId;

  const doc = {
    id: db.generateId('appr'),
    type,
    title,
    authorId: req.user.userId,
    authorName: req.user.name,
    authorDept: (() => {
      const u = (uData.users || []).find(u2 => u2.userId === req.user.userId);
      const deptId = u ? u.department : '';
      const dept = (uData.departments || []).find(d => d.id === deptId);
      return dept ? dept.name : '';
    })(),
    approverId,
    approverName: approver.name,
    effectiveApproverId,
    approverDelegatedTo: isDelegated ? effectiveApprover.name : null,
    isDelegated,
    companyId: req.user.companyId || 'dalim-sm',
    status: 'pending',
    formData: formData || {},
    comment: '',
    createdAt: new Date().toISOString(),
    processedAt: null
  };

  uData.approvals.push(doc);
  db.saveUsers(uData);

  const logMsg = isDelegated
    ? `${doc.title} → ${approver.name} (대리: ${effectiveApprover.name})`
    : `${doc.title} → ${approver.name}`;
  auditLog(req.user.userId, '결재 기안', logMsg);

  notify(effectiveApproverId, 'approval',
    isDelegated
      ? `[대리] ${req.user.name}님이 결재를 요청했습니다: ${doc.title}`
      : `${req.user.name}님이 결재를 요청했습니다: ${doc.title}`,
    'approvals');

  res.json({ ok: true, id: doc.id });
});

// ── 시간외근무 빠른 기안 ──
router.post('/overtime', requireAuth, (req, res) => {
  const { date, startTime, endTime, reason, approverId } = req.body;
  if (!date || !startTime || !endTime || !approverId) {
    return res.status(400).json({ error: '날짜, 시작시간, 종료시간, 승인자를 입력해주세요' });
  }
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: '사유를 입력해주세요' });
  }
  // 자기결재: 팀장/관리자만 허용
  if (approverId === req.user.userId) {
    if (req.user.role !== 'team_leader' && req.user.role !== 'admin') {
      return res.status(403).json({ error: '본인을 승인자로 지정할 수 없습니다' });
    }
  }
  const uData = db.loadUsers();
  if (!uData.approvals) uData.approvals = [];

  const approver = (uData.users || []).find(u => u.userId === approverId);
  if (!approver) return res.status(400).json({ error: '승인자를 찾을 수 없습니다' });

  const effectiveApproverId = getEffectiveApprover(approverId);
  const effectiveApprover = (uData.users || []).find(u => u.userId === effectiveApproverId);
  const isDelegated = effectiveApproverId !== approverId;
  const isSelfApproval = approverId === req.user.userId;

  const doc = {
    id: db.generateId('appr'),
    type: '시간외근무',
    title: `시간외근무 — ${date} (${startTime}~${endTime})`,
    authorId: req.user.userId,
    authorName: req.user.name,
    authorDept: (() => {
      const u = (uData.users || []).find(u2 => u2.userId === req.user.userId);
      const deptId = u ? u.department : '';
      const dept = (uData.departments || []).find(d => d.id === deptId);
      return dept ? dept.name : '';
    })(),
    approverId,
    approverName: approver.name,
    effectiveApproverId,
    approverDelegatedTo: isDelegated ? effectiveApprover.name : null,
    isDelegated,
    companyId: req.user.companyId || 'dalim-sm',
    status: 'pending',
    formData: { date, startTime, endTime, reason: String(reason).trim() },
    comment: '',
    createdAt: new Date().toISOString(),
    processedAt: null
  };

  uData.approvals.push(doc);
  db.saveUsers(uData);

  auditLog(req.user.userId, '시간외근무 기안', `${date} ${startTime}~${endTime}`);
  // 자기결재는 본인에게 알림 불필요
  if (!isSelfApproval) {
    notify(effectiveApproverId, 'approval',
      `${req.user.name}님이 시간외근무를 신청했습니다: ${date} ${startTime}~${endTime}`,
      'approvals');
  }

  res.json({ ok: true, id: doc.id });
});

// 결재 승인/반려
router.post('/:id/process', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });

  const actualApproverId = doc.effectiveApproverId || doc.approverId;
  if (actualApproverId !== req.user.userId) {
    return res.status(403).json({ error: '승인 권한이 없습니다' });
  }
  if (doc.status !== 'pending') {
    return res.status(400).json({ error: '이미 처리된 문서입니다' });
  }

  const { action, comment } = req.body;
  if (action !== 'approved' && action !== 'rejected') {
    return res.status(400).json({ error: 'action은 approved 또는 rejected여야 합니다' });
  }

  doc.status = action;
  doc.comment = comment || '';
  doc.processedAt = new Date().toISOString();
  doc.approvedBy = req.user.userId;
  db.saveUsers(uData);

  const logMsg = doc.isDelegated
    ? `${action === 'approved' ? '승인' : '반려'} (대리인: ${req.user.name})`
    : `${action === 'approved' ? '승인' : '반려'}`;
  auditLog(req.user.userId, `결재 ${logMsg}`, doc.title);

  notify(doc.authorId, 'approval',
    `${req.user.name}님이 "${doc.title}"을 ${action === 'approved' ? '승인' : '반려'}했습니다${doc.isDelegated ? ' (대리)' : ''}`,
    'approvals');

  // 휴가계획서 승인 시 → 연차관리에 사용 기록 자동 반영
  if (action === 'approved' && doc.type === 'leave' && doc.formData) {
    try {
      const leaveData = db['연차관리'].load();
      const fd = doc.formData;

      const legacyMap = { annual: '연차', half: '반차', sick: '병가', special: '특별휴가' };
      const leaveTypeName = legacyMap[fd.leaveType] || fd.leaveType || '연차';
      const leaveSetting = (leaveData.settings?.leaveTypes || []).find(t => t.name === leaveTypeName);
      const deductsAnnual = leaveSetting ? leaveSetting.deductsAnnual : (leaveTypeName === '연차' || leaveTypeName === '반차');
      const isHalfDay = leaveSetting ? (leaveSetting.days === 0.5) : (leaveTypeName === '반차');

      const fixedDays = leaveSetting?.days || null;
      const start = new Date(fd.startDate);
      let end;
      if (fd.endDate) {
        end = new Date(fd.endDate);
      } else if (fixedDays && fixedDays >= 1) {
        end = new Date(start);
        let remaining = fixedDays - 1;
        while (remaining > 0) {
          end.setDate(end.getDate() + 1);
          const dow = end.getDay();
          if (dow !== 0 && dow !== 6) remaining--;
        }
      } else {
        end = new Date(start);
      }

      for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
        const dayOfWeek = d.getDay();
        if (dayOfWeek === 0 || dayOfWeek === 6) continue;
        const dateStr = d.toISOString().slice(0, 10);
        leaveData.leaveRecords = (leaveData.leaveRecords || []).filter(r =>
          !(r.employeeName === doc.authorName && r.date === dateStr && r.source === 'attendance')
        );
        const dup = (leaveData.leaveRecords || []).find(r =>
          r.employeeName === doc.authorName && r.date === dateStr && r.approvalId === doc.id
        );
        if (dup) continue;
        const daysPerDay = isHalfDay ? 0.5 : 1;
        if (!leaveData.leaveRecords) leaveData.leaveRecords = [];
        leaveData.leaveRecords.push({
          id: 'lr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          employeeName: doc.authorName,
          date: dateStr,
          leaveType: leaveTypeName,
          annualDays: deductsAnnual ? daysPerDay : 0,
          nonAnnualDays: deductsAnnual ? 0 : daysPerDay,
          reason: fd.reason || doc.title || '',
          approvalId: doc.id,
          createdAt: new Date().toISOString()
        });
      }
      db['연차관리'].save(leaveData);
      console.log(`✅ 휴가 승인 → 연차관리 자동 반영: ${doc.authorName} ${leaveTypeName} ${fd.startDate}~${fd.endDate || fd.startDate}`);

      // ── 출퇴근 기록부(attendanceNotes)에도 동시 반영 ──
      try {
        const attData = db.출퇴근관리.load();
        if (!attData.attendanceNotes) attData.attendanceNotes = {};
        const attEmpId = doc.authorName;
        const leaveCodeMap = { '연차': 'annual', '반차': 'halfAM', '병가': 'sick', '특별휴가': 'special' };
        const attLeaveType = leaveCodeMap[leaveTypeName] || 'annual';
        const attLeaveLabel = leaveTypeName;

        for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
          const dayOfWeek = d.getDay();
          if (dayOfWeek === 0 || dayOfWeek === 6) continue;
          const dateStr = d.toISOString().slice(0, 10);
          const noteKey = `${attEmpId}_${dateStr}`;
          if (!attData.attendanceNotes[noteKey]) {
            attData.attendanceNotes[noteKey] = {
              leaveType: attLeaveType,
              leaveLabel: attLeaveLabel,
              note: `결재승인: ${doc.title}`,
              approvalId: doc.id,
              setAt: new Date().toISOString()
            };
          }
        }
        db.출퇴근관리.save(attData);
        console.log(`✅ 휴가 승인 → 출퇴근 기록부 자동 반영: ${doc.authorName} ${leaveTypeName} ${fd.startDate}~${fd.endDate || fd.startDate}`);
      } catch(e2) {
        console.error('휴가 승인 → 출퇴근 기록부 반영 실패:', e2.message);
      }
    } catch(e) {
      console.error('휴가 승인 → 연차관리 반영 실패:', e.message);
    }
  }

  // ── 시간외근무 승인 → 출퇴근 기록부에 "결재 승인 야근" 마크 ──
  // 자동 계산 야근(퇴근시각 기준) 외에, 결재로 공식 인정된 야근을 별도 저장.
  // 출퇴근 화면 / 엑셀에서 둘 다 표시.
  if (action === 'approved' && doc.type === '시간외근무' && doc.formData) {
    try {
      const fd = doc.formData;
      const [sh, sm] = String(fd.startTime || '00:00').split(':').map(Number);
      const [eh, em] = String(fd.endTime || '00:00').split(':').map(Number);
      const startMin = sh * 60 + sm;
      const endMin = eh * 60 + em;
      const minutes = Math.max(0, endMin - startMin);

      const attData = db.출퇴근관리.load();
      if (!attData.overtimeApprovals) attData.overtimeApprovals = {};
      const key = `${doc.authorName}_${fd.date}`;
      attData.overtimeApprovals[key] = {
        approvalId: doc.id,
        employeeName: doc.authorName,
        date: fd.date,
        startTime: fd.startTime,
        endTime: fd.endTime,
        minutes,
        reason: fd.reason || '',
        approvedAt: new Date().toISOString(),
        approvedBy: req.user.userId,
      };
      db.출퇴근관리.save(attData);
      console.log(`✅ 시간외근무 승인 → 출퇴근 반영: ${doc.authorName} ${fd.date} ${fd.startTime}~${fd.endTime} (${minutes}분)`);
    } catch(e) {
      console.error('시간외근무 승인 → 출퇴근 반영 실패:', e.message);
    }
  }

  // 시간외근무 반려 시 → 인정 마크 제거
  if (action === 'rejected' && doc.type === '시간외근무' && doc.formData) {
    try {
      const attData = db.출퇴근관리.load();
      if (attData.overtimeApprovals) {
        const key = `${doc.authorName}_${doc.formData.date}`;
        if (attData.overtimeApprovals[key] && attData.overtimeApprovals[key].approvalId === doc.id) {
          delete attData.overtimeApprovals[key];
          db.출퇴근관리.save(attData);
          console.log(`✅ 시간외근무 반려 → 출퇴근 인정 마크 제거: ${doc.authorName} ${doc.formData.date}`);
        }
      }
    } catch(e) {
      console.error('시간외근무 반려 → 출퇴근 마크 제거 실패:', e.message);
    }
  }

  // 반려 시 → 출퇴근 기록부에서 해당 결재 기록 제거
  if (action === 'rejected' && doc.type === 'leave' && doc.formData) {
    try {
      const attData = db.출퇴근관리.load();
      if (attData.attendanceNotes) {
        for (const key of Object.keys(attData.attendanceNotes)) {
          if (attData.attendanceNotes[key].approvalId === doc.id) {
            delete attData.attendanceNotes[key];
          }
        }
        db.출퇴근관리.save(attData);
        console.log(`✅ 휴가 반려 → 출퇴근 기록부 노트 제거: ${doc.authorName} (결재 ${doc.id})`);
      }
    } catch(e3) {
      console.error('휴가 반려 → 출퇴근 기록부 제거 실패:', e3.message);
    }
  }

  res.json({ ok: true, status: doc.status });
});

// ── 결재 취소요청 (본인이 승인된 문서 취소 요청) ──
router.post('/:id/cancel-request', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });
  if (doc.authorId !== req.user.userId) {
    return res.status(403).json({ error: '본인이 기안한 문서만 취소 요청할 수 있습니다' });
  }
  if (doc.status !== 'approved') {
    return res.status(400).json({ error: '승인 완료된 문서만 취소 요청할 수 있습니다' });
  }
  const { reason } = req.body;
  if (!reason || !String(reason).trim()) {
    return res.status(400).json({ error: '취소 사유를 입력해주세요' });
  }

  doc.status = 'cancel_requested';
  doc.cancelReason = String(reason).trim();
  doc.cancelRequestedAt = new Date().toISOString();
  db.saveUsers(uData);

  auditLog(req.user.userId, '결재 취소요청', `${doc.title} — ${doc.cancelReason}`);

  // 원래 결재자에게 알림
  const approverId = doc.effectiveApproverId || doc.approverId;
  if (approverId) {
    notify(approverId, 'approval',
      `${req.user.name}님이 "${doc.title}" 취소를 요청했습니다`,
      'approvals');
  }

  res.json({ ok: true, status: doc.status });
});

// ── 결재 취소요청 처리 (원래 결재자 또는 관리자가 승인/반려) ──
router.post('/:id/cancel-process', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });

  // 권한: 원래 결재자 또는 관리자
  const approverId = doc.effectiveApproverId || doc.approverId;
  if (approverId !== req.user.userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: '취소 처리 권한이 없습니다' });
  }
  if (doc.status !== 'cancel_requested') {
    return res.status(400).json({ error: '취소요청 상태가 아닙니다' });
  }

  const { action, comment } = req.body;
  if (action !== 'approved' && action !== 'rejected') {
    return res.status(400).json({ error: 'action은 approved 또는 rejected여야 합니다' });
  }

  if (action === 'approved') {
    // 취소 승인 → 문서 cancelled 처리 + 연차/출퇴근 마크 제거
    doc.status = 'cancelled';
    doc.cancelProcessedAt = new Date().toISOString();
    doc.cancelProcessedBy = req.user.userId;
    doc.cancelComment = comment || '';
    db.saveUsers(uData);

    // 휴가 취소 → 연차 기록 + 출퇴근 마크 제거 (rejected 시와 같은 처리)
    if (doc.type === 'leave') {
      try {
        const leaveData = db['연차관리'].load();
        if (leaveData.leaveRecords) {
          const before = leaveData.leaveRecords.length;
          leaveData.leaveRecords = leaveData.leaveRecords.filter(r => r.approvalId !== doc.id);
          const removed = before - leaveData.leaveRecords.length;
          if (removed > 0) {
            db['연차관리'].save(leaveData);
            console.log(`✅ 휴가 취소 → 연차 기록 ${removed}건 제거: ${doc.authorName} (결재 ${doc.id})`);
          }
        }
      } catch (e) {
        console.error('휴가 취소 → 연차 기록 제거 실패:', e.message);
      }
      try {
        const attData = db.출퇴근관리.load();
        if (attData.attendanceNotes) {
          let removed = 0;
          for (const key of Object.keys(attData.attendanceNotes)) {
            if (attData.attendanceNotes[key].approvalId === doc.id) {
              delete attData.attendanceNotes[key];
              removed++;
            }
          }
          if (removed > 0) {
            db.출퇴근관리.save(attData);
            console.log(`✅ 휴가 취소 → 출퇴근 노트 ${removed}건 제거: ${doc.authorName} (결재 ${doc.id})`);
          }
        }
      } catch (e) {
        console.error('휴가 취소 → 출퇴근 노트 제거 실패:', e.message);
      }
    }
    // 시간외근무 취소 → 야근 인정 마크 제거
    if (doc.type === '시간외근무' && doc.formData) {
      try {
        const attData = db.출퇴근관리.load();
        if (attData.overtimeApprovals) {
          const key = `${doc.authorName}_${doc.formData.date}`;
          if (attData.overtimeApprovals[key] && attData.overtimeApprovals[key].approvalId === doc.id) {
            delete attData.overtimeApprovals[key];
            db.출퇴근관리.save(attData);
            console.log(`✅ 시간외근무 취소 → 인정 마크 제거: ${doc.authorName} ${doc.formData.date}`);
          }
        }
      } catch (e) {
        console.error('시간외근무 취소 → 마크 제거 실패:', e.message);
      }
    }

    auditLog(req.user.userId, '결재 취소승인', `${doc.title} — ${doc.cancelReason || ''}`);
    notify(doc.authorId, 'approval',
      `${req.user.name}님이 "${doc.title}" 취소를 승인했습니다`,
      'approvals');
  } else {
    // 취소 반려 → 다시 approved 로 복귀
    doc.status = 'approved';
    doc.cancelRejectedAt = new Date().toISOString();
    doc.cancelRejectedBy = req.user.userId;
    doc.cancelComment = comment || '';
    db.saveUsers(uData);

    auditLog(req.user.userId, '결재 취소반려', `${doc.title} — ${comment || ''}`);
    notify(doc.authorId, 'approval',
      `${req.user.name}님이 "${doc.title}" 취소 요청을 반려했습니다`,
      'approvals');
  }

  res.json({ ok: true, status: doc.status });
});

// 결재 문서 삭제 (소프트 삭제)
router.delete('/:id', requireAuth, (req, res) => {
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });
  if (doc.authorId !== req.user.userId && req.user.role !== 'admin') {
    return res.status(403).json({ error: '삭제 권한이 없습니다' });
  }
  if (doc.status !== 'pending' && req.user.role !== 'admin') {
    return res.status(400).json({ error: '대기 중인 문서만 삭제할 수 있습니다' });
  }

  const prevStatus = doc.status;
  doc._prevStatus = doc.status;
  doc.status = 'deleted';
  doc.deletedAt = new Date().toISOString();
  doc.deletedBy = req.user.name;
  db.saveUsers(uData);

  // 결재가 승인 상태였다면 연차 기록도 함께 삭제
  if (prevStatus === 'approved' && doc.type === 'leave') {
    try {
      const leaveData = db['연차관리'].load();
      if (leaveData.leaveRecords) {
        const before = leaveData.leaveRecords.length;
        leaveData.leaveRecords = leaveData.leaveRecords.filter(r => r.approvalId !== doc.id);
        const removed = before - leaveData.leaveRecords.length;
        if (removed > 0) db['연차관리'].save(leaveData);
      }
    } catch (e) {
      console.error('연차 기록 연동 삭제 실패:', e);
    }
  }

  auditLog(req.user.userId, '결재 삭제', doc.title);
  res.json({ ok: true });
});

// 결재 문서 복구 (admin 전용)
router.post('/:id/restore', requireAuth, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 복구할 수 있습니다' });
  const uData = db.loadUsers();
  const doc = (uData.approvals || []).find(d => d.id === req.params.id);
  if (!doc) return res.status(404).json({ error: '문서 없음' });
  if (doc.status !== 'deleted') return res.status(400).json({ error: '삭제된 문서가 아닙니다' });
  doc.status = doc._prevStatus || 'pending';
  delete doc._prevStatus;
  delete doc.deletedAt;
  delete doc.deletedBy;
  db.saveUsers(uData);
  auditLog(req.user.userId, '결재 복구', doc.title);
  res.json({ ok: true });
});

module.exports = router;
