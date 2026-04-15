/**
 * routes/auth.js — 로그인/로그아웃/회원가입/세션 확인
 *
 * ── 보안 강화 ──────────────────────────────────────────
 * - verifyPassword()  : PBKDF2 검증 + SHA256 레거시 자동 마이그레이션
 * - 로그인 실패 5회 → 30분 잠금
 * - 급여 PIN 재인증 API  POST /api/auth/salary-pin
 * - 급여 세션 만료      POST /api/auth/salary-logout
 * ─────────────────────────────────────────────────────
 */
const express = require('express');
const router  = express.Router();
const crypto  = require('crypto');
const path    = require('path');
const fs      = require('fs');
const db      = require('../db');
const {
  sessions, parseCookies,
  hashPassword, verifyPassword,
  getFailureKey, isLocked, recordFailure, clearFailures, getRemainingLockMinutes,
  requireAuth, requireAdmin,
  createSalarySession, expireSalarySession,
  logSalaryAccess
} = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// ── 로그인 ────────────────────────────────────────────
router.post('/login', (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password)
    return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요' });

  // ① 잠금 확인 (IP + userId 둘 다 체크)
  const ipKey   = getFailureKey(req, null);
  const userKey = getFailureKey(req, userId);
  if (isLocked(ipKey)) {
    const mins = getRemainingLockMinutes(ipKey);
    return res.status(429).json({ error: `로그인 시도가 너무 많습니다. ${mins}분 후 다시 시도해주세요.` });
  }
  if (isLocked(userKey)) {
    const mins = getRemainingLockMinutes(userKey);
    return res.status(429).json({ error: `계정이 잠겼습니다. ${mins}분 후 다시 시도해주세요.` });
  }

  const uData = db.loadUsers();
  if (!uData.users) uData.users = [];
  const user = uData.users.find(u => u.userId === userId);

  // ② 사용자 없음
  if (!user) {
    recordFailure(ipKey);
    return res.status(401).json({ error: '존재하지 않는 아이디입니다' });
  }

  // ③ 비밀번호 검증 (PBKDF2 + SHA256 레거시 자동 지원)
  const { ok, needsMigration } = verifyPassword(password, user.password);
  if (!ok) {
    recordFailure(ipKey);
    recordFailure(userKey);
    const f = require('../middleware/auth').loginFailures || {};
    const count = (f[userKey] || {}).count || 1;
    const remaining = Math.max(0, 5 - count);
    const msg = remaining > 0
      ? `비밀번호가 틀렸습니다. (${remaining}회 더 틀리면 계정이 잠깁니다)`
      : '비밀번호가 틀렸습니다.';
    return res.status(401).json({ error: msg });
  }

  // ④ 계정 상태 확인
  if (user.status === 'pending')  return res.status(403).json({ error: '관리자 승인 대기 중입니다.' });
  if (user.status === 'rejected') return res.status(403).json({ error: '가입이 거절되었습니다.' });
  if (user.status === 'resigned') return res.status(403).json({ error: '퇴사 처리된 계정입니다.' });

  // ⑤ 로그인 성공 — 실패 기록 초기화
  clearFailures(ipKey);
  clearFailures(userKey);

  // ⑥ 레거시 SHA256 → PBKDF2 자동 마이그레이션
  if (needsMigration) {
    user.password = hashPassword(password);
    console.log(`[AUTH] 비밀번호 마이그레이션 완료: ${userId} (SHA256 → PBKDF2)`);
  }

  user.lastLogin = new Date().toISOString();
  db.saveUsers(uData);

  // ⑦ 세션 발급
  const token = crypto.randomBytes(32).toString('hex');
  const perms  = user.permissions || [];
  sessions[token] = {
    userId: user.userId, name: user.name, role: user.role,
    position: user.position || '', phone: user.phone || '',
    department: user.department || '', permissions: perms,
    loginAt: Date.now()
  };
  res.setHeader('Set-Cookie', `session_token=${token}; Path=/; HttpOnly; Max-Age=86400`);
  auditLog(user.userId, '로그인', '시스템');

  // 팀장 여부
  let isTeamLeader = false;
  try {
    const dept = (uData.departments || []).find(d => d.id === user.department);
    if (dept && dept.leaderId === user.id) isTeamLeader = true;
  } catch(e) {}

  res.json({ ok: true, userId: user.userId, name: user.name, role: user.role,
    position: user.position || '', phone: user.phone || '',
    department: user.department || '', permissions: perms, isTeamLeader });
});

// ── 급여 PIN 인증 ──────────────────────────────────────
/**
 * POST /api/auth/salary-pin
 * body: { pin: string }
 * 성공 시 salary_token 쿠키 발급 (30분 유효)
 */
router.post('/salary-pin', requireAuth, (req, res) => {
  const { pin } = req.body;
  if (!pin) return res.status(400).json({ error: 'PIN을 입력해주세요' });

  const uData = db.loadUsers();
  const user  = (uData.users || []).find(u => u.userId === req.user.userId);
  if (!user) return res.status(404).json({ error: '사용자 없음' });

  // 급여 권한 확인
  const perms   = user.permissions || [];
  const isAdmin = user.role === 'admin';
  if (!isAdmin && !perms.includes('salary_view')) {
    logSalaryAccess(req.user.userId, 'PIN_FAIL', '권한 없음');
    return res.status(403).json({ error: '급여 열람 권한이 없습니다', code: 'NO_SALARY_PERM' });
  }

  // salary_pin 설정 여부 확인
  if (!user.salaryPin) {
    logSalaryAccess(req.user.userId, 'PIN_FAIL', 'PIN 미설정');
    return res.status(403).json({ error: '급여 PIN이 설정되어 있지 않습니다. 관리자에게 문의하세요.', code: 'NO_PIN_SET' });
  }

  // PIN 검증
  const { ok } = verifyPassword(pin, user.salaryPin);
  if (!ok) {
    logSalaryAccess(req.user.userId, 'PIN_FAIL', 'PIN 불일치');
    return res.status(401).json({ error: 'PIN이 틀렸습니다', code: 'PIN_WRONG' });
  }

  // 급여 세션 발급
  const salaryToken = createSalarySession(req.user.userId);
  logSalaryAccess(req.user.userId, 'PIN_OK', '급여 세션 발급');

  res.setHeader('Set-Cookie', `salary_token=${salaryToken}; Path=/; HttpOnly; Max-Age=1800`); // 30분
  res.json({ ok: true, message: '급여 인증 완료. 30분간 유효합니다.' });
});

// ── 급여 세션 만료 (급여 탭 닫기) ──────────────────────
router.post('/salary-logout', requireAuth, (req, res) => {
  expireSalarySession(req.user.userId);
  res.setHeader('Set-Cookie', 'salary_token=; Path=/; HttpOnly; Max-Age=0');
  logSalaryAccess(req.user.userId, 'LOGOUT', '급여 세션 수동 만료');
  res.json({ ok: true });
});

// ── 급여 PIN 설정 (admin만) ────────────────────────────
/**
 * POST /api/auth/salary-pin/set
 * body: { targetUserId: string, pin: string }
 * admin이 특정 유저의 급여 PIN을 설정
 */
router.post('/salary-pin/set', requireAdmin, (req, res) => {
  const { targetUserId, pin } = req.body;
  if (!targetUserId || !pin) return res.status(400).json({ error: 'targetUserId와 pin 필수' });
  if (pin.length < 4) return res.status(400).json({ error: 'PIN은 4자리 이상이어야 합니다' });

  const uData = db.loadUsers();
  const user  = (uData.users || []).find(u => u.userId === targetUserId);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });

  user.salaryPin = hashPassword(pin);
  db.saveUsers(uData);
  auditLog(req.user.userId, '급여PIN설정', targetUserId);
  res.json({ ok: true, message: `${user.name}의 급여 PIN이 설정되었습니다` });
});

// ── 회원가입 상태 조회 ────────────────────────────────
router.get('/registration-status', (req, res) => {
  const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch(e) {}
  res.json({ registrationClosed: !!settings.registrationClosed });
});

// ── 회원가입 ──────────────────────────────────────────
router.post('/register', (req, res) => {
  const { userId, password, name, position, phone, hireDate } = req.body;
  if (!userId || !password || !name)
    return res.status(400).json({ error: '아이디, 비밀번호, 이름을 모두 입력해주세요' });
  if (userId.length < 3)   return res.status(400).json({ error: '아이디는 3자 이상이어야 합니다' });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다' });

  const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
  let settings = {};
  try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch(e) {}
  if (settings.registrationClosed)
    return res.status(403).json({ error: '현재 신규 가입이 마감되었습니다. 관리자에게 문의하세요.' });

  const uData = db.loadUsers();
  if (!uData.users) uData.users = [];
  if (uData.users.find(u => u.userId === userId))
    return res.status(400).json({ error: '이미 사용 중인 아이디입니다' });

  uData.users.push({
    id: db.generateId('u'),
    userId, name,
    position: position || '', phone: phone || '', hireDate: hireDate || '',
    password: hashPassword(password),  // PBKDF2
    role: 'user', status: 'approved',
    createdAt: new Date().toISOString(), lastLogin: null
  });
  db.saveUsers(uData);
  auditLog(userId, '회원가입 완료', name);
  res.json({ ok: true, message: '가입이 완료되었습니다. 바로 로그인할 수 있습니다.' });
});

// ── 로그아웃 ──────────────────────────────────────────
router.post('/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token;
  if (token && sessions[token]) {
    expireSalarySession(sessions[token].userId); // 급여 세션도 함께 만료
    delete sessions[token];
  }
  res.setHeader('Set-Cookie', [
    'session_token=; Path=/; HttpOnly; Max-Age=0',
    'salary_token=; Path=/; HttpOnly; Max-Age=0'
  ]);
  res.json({ ok: true });
});

// ── 현재 로그인 상태 ──────────────────────────────────
router.get('/me', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  if (!token || !sessions[token]) return res.json({ loggedIn: false });
  const s = sessions[token];

  // 급여 세션 유효 여부 함께 전달
  const { salarySessions } = require('../middleware/auth');
  const salaryToken = cookies.salary_token;
  const salaryActive = !!(salaryToken && salarySessions[salaryToken] &&
    salarySessions[salaryToken].userId === s.userId &&
    Date.now() < salarySessions[salaryToken].expiresAt);

  let isTeamLeader = false;
  try {
    const uData = db.loadUsers();
    const me = (uData.users || []).find(u => u.userId === s.userId);
    if (me && me.department) {
      const dept = (uData.departments || []).find(d => d.id === me.department);
      if (dept && dept.leaderId === me.id) isTeamLeader = true;
    }
  } catch(e) {}

  res.json({ loggedIn: true, userId: s.userId, name: s.name, role: s.role,
    position: s.position || '', phone: s.phone || '',
    department: s.department || '', permissions: s.permissions || [],
    isTeamLeader, salaryActive });
});

module.exports = router;
