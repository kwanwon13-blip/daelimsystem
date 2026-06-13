/**
 * routes/auth.js — 로그인/로그아웃/회원가입/세션 확인
 *
 * ── 보안 강화 ──────────────────────────────────────────
 * - verifyPassword()  : PBKDF2 검증 + SHA256 레거시 자동 마이그레이션
 * - 로그인 실패 5회 → 30분 잠금
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
  requireAuth, requireAdmin
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
    department: user.department || '', companyId: user.companyId || 'dalim-sm',
    permissions: perms, loginAt: Date.now()
  };
  res.setHeader('Set-Cookie', `session_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`);
  auditLog(user.userId, '로그인', '시스템');

  // 팀장 여부
  let isTeamLeader = false;
  try {
    const dept = (uData.departments || []).find(d => d.id === user.department);
    if (dept && dept.leaderId === user.id) isTeamLeader = true;
  } catch(e) {}

  res.json({ ok: true, userId: user.userId, name: user.name, role: user.role,
    position: user.position || '', phone: user.phone || '',
    department: user.department || '', companyId: user.companyId || 'dalim-sm',
    permissions: perms, isTeamLeader,
    mustChangePassword: !!user.mustChangePassword });
});

// ── 본인 비밀번호 변경 ────────────────────────────────
// 현재 비밀번호를 확인한 뒤 새 비밀번호로 교체.
// 임시 비밀번호 발급 후 최초 로그인 시 반드시 호출되어야 함.
router.post('/change-password', requireAuth, (req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  if (!currentPassword || !newPassword) {
    return res.status(400).json({ error: '현재 비밀번호와 새 비밀번호를 모두 입력해주세요' });
  }
  if (String(newPassword).length < 6) {
    return res.status(400).json({ error: '새 비밀번호는 6자 이상이어야 합니다' });
  }
  if (currentPassword === newPassword) {
    return res.status(400).json({ error: '새 비밀번호는 현재 비밀번호와 달라야 합니다' });
  }
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.userId === req.user.userId);
  if (!user) return res.status(404).json({ error: '사용자를 찾을 수 없습니다' });
  // ⚠ 보안수정(2026-06-13): verifyPassword 는 항상 객체를 반환하므로 .ok 를 확인해야 함.
  // 기존 `if (!verifyPassword(...))` 는 항상 false 라 현재 비밀번호 검증이 무력화됐었음.
  const { ok: curPwOk } = verifyPassword(currentPassword, user.password);
  if (!curPwOk) {
    return res.status(401).json({ error: '현재 비밀번호가 일치하지 않습니다' });
  }
  user.password = hashPassword(newPassword);
  user.mustChangePassword = false;
  user.passwordChangedAt = new Date().toISOString();
  db.saveUsers(uData);

  // 본인의 다른 기기 세션을 모두 만료시켜 재로그인 유도 (현재 세션은 유지)
  const currentCookies = parseCookies(req);
  const currentToken = currentCookies.session_token || req.headers['x-session-token'];
  let killed = 0;
  for (const token of Object.keys(sessions)) {
    if (token === currentToken) continue;
    if (sessions[token] && sessions[token].userId === user.userId) {
      delete sessions[token];
      killed++;
    }
  }
  auditLog(user.userId, '비밀번호 변경', user.name, { otherSessionsInvalidated: killed });
  res.json({ ok: true, otherSessionsInvalidated: killed });
});

// ── 급여 PIN/세션 엔드포인트 제거됨 (2026-06-13, 보안: 미사용 급여 모듈 완전 분리) ──

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
    // 외부 노출 대비: 신규 가입은 반드시 '대기' 상태로 진입 → 관리자가 승인해야 로그인 가능
    role: 'user', status: 'pending',
    createdAt: new Date().toISOString(), lastLogin: null
  });
  db.saveUsers(uData);
  auditLog(userId, '회원가입 신청', name);
  res.json({ ok: true, message: '가입 신청이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.' });
});

// ── 로그아웃 ──────────────────────────────────────────
router.post('/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token;
  if (token && sessions[token]) {
    delete sessions[token];
  }
  res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.json({ ok: true });
});

// ── 현재 로그인 상태 ──────────────────────────────────
router.get('/me', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  if (!token || !sessions[token]) return res.json({ loggedIn: false });
  const s = sessions[token];

  let isTeamLeader = false;
  let mustChangePassword = false;
  try {
    const uData = db.loadUsers();
    const me = (uData.users || []).find(u => u.userId === s.userId);
    if (me) {
      mustChangePassword = !!me.mustChangePassword;
      if (me.department) {
        const dept = (uData.departments || []).find(d => d.id === me.department);
        if (dept && dept.leaderId === me.id) isTeamLeader = true;
      }
    }
  } catch(e) {}

  res.json({ loggedIn: true, userId: s.userId, name: s.name, role: s.role,
    position: s.position || '', phone: s.phone || '',
    department: s.department || '', companyId: s.companyId || 'dalim-sm',
    permissions: s.permissions || [], isTeamLeader,
    mustChangePassword });
});

module.exports = router;
