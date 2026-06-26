/**
 * middleware/auth.js — 세션 관리 & 인증 미들웨어
 *
 * ── 보안 레이어 ──────────────────────────────────────
 * 1. PBKDF2 비밀번호 해시 (SHA256 → 자동 마이그레이션)
 * 2. 로그인 실패 횟수 제한 (5회 실패 → 30분 잠금)
 * 3. 급여 PIN 재인증 (step-up auth, 30분 유효)
 * 4. 급여 접근 로그
 * ─────────────────────────────────────────────────────
 */
const crypto = require('crypto');

// ── 세션 저장소 ───────────────────────────────────────
const sessions = {};        // { token: { userId, name, role, permissions, ... } }

// 자동로그인(remember-me) 토큰 — 지연 require로 순환참조 방지(remember.js는 auth를 require하지 않음)
let _remember = null;
function rememberMod() { try { if (!_remember) _remember = require('./remember'); } catch (e) {} return _remember; }
let _db = null;
function dbMod() { try { if (!_db) _db = require('../db'); } catch (e) {} return _db; }

// ── 로그인 실패 추적 ──────────────────────────────────
// { "ip_or_userId": { count, lockedUntil } }
const loginFailures = {};
const MAX_FAILURES  = 5;          // 최대 실패 횟수
const LOCK_DURATION = 30 * 60 * 1000; // 잠금 시간: 30분

// ── 내부 유틸 ─────────────────────────────────────────

function parseCookies(req) {
  const obj = {};
  const str = req.headers.cookie || '';
  str.split(';').forEach(pair => {
    try {
      const [k, ...v] = pair.trim().split('=');
      if (k) obj[k.trim()] = decodeURIComponent(v.join('='));
    } catch(e) {}
  });
  return obj;
}

// ── 비밀번호 해시 ─────────────────────────────────────

/**
 * PBKDF2 해시 (강화된 방식)
 * 포맷: "pbkdf2$<iterations>$<salt>$<hash>"
 */
function hashPasswordPbkdf2(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const iterations = 100000;
  const hash = crypto.pbkdf2Sync(pw, salt, iterations, 64, 'sha256').toString('hex');
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

/**
 * 구버전 SHA256 해시 (마이그레이션용 — 검증만, 신규 생성 금지)
 */
function hashPasswordLegacy(pw) {
  return crypto.createHash('sha256').update(pw + '_단가표_salt').digest('hex');
}

/**
 * hashPassword — 외부에서 새 비밀번호 저장 시 호출
 * 항상 PBKDF2로 생성
 */
function hashPassword(pw) {
  return hashPasswordPbkdf2(pw);
}

/**
 * verifyPassword — 로그인 시 비밀번호 검증
 * PBKDF2 포맷이면 PBKDF2로 검증,
 * 구버전 SHA256 해시면 SHA256으로 검증 (자동 마이그레이션 지원)
 *
 * @returns { ok: boolean, needsMigration: boolean }
 */
function verifyPassword(inputPw, storedHash) {
  if (!storedHash) return { ok: false, needsMigration: false };

  if (storedHash.startsWith('pbkdf2$')) {
    const parts = storedHash.split('$');
    if (parts.length !== 4) return { ok: false, needsMigration: false };
    const [, iterStr, salt] = parts;
    const iter = parseInt(iterStr, 10);
    const computed = crypto.pbkdf2Sync(inputPw, salt, iter, 64, 'sha256').toString('hex');
    return { ok: computed === parts[3], needsMigration: false };
  }

  // 구버전 SHA256 해시
  const legacyHash = hashPasswordLegacy(inputPw);
  return { ok: legacyHash === storedHash, needsMigration: true };
}

// ── 로그인 실패 제한 ──────────────────────────────────

function getFailureKey(req, userId) {
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  return userId ? `u_${userId}` : `ip_${ip}`;
}

function isLocked(key) {
  const f = loginFailures[key];
  if (!f) return false;
  if (f.lockedUntil && Date.now() < f.lockedUntil) return true;
  if (f.lockedUntil && Date.now() >= f.lockedUntil) {
    delete loginFailures[key]; // 잠금 해제
    return false;
  }
  return false;
}

function recordFailure(key) {
  if (!loginFailures[key]) loginFailures[key] = { count: 0 };
  loginFailures[key].count += 1;
  if (loginFailures[key].count >= MAX_FAILURES) {
    loginFailures[key].lockedUntil = Date.now() + LOCK_DURATION;
  }
}

function clearFailures(key) {
  delete loginFailures[key];
}

function getRemainingLockMinutes(key) {
  const f = loginFailures[key];
  if (!f || !f.lockedUntil) return 0;
  return Math.ceil((f.lockedUntil - Date.now()) / 60000);
}

// ── 기본 인증 미들웨어 ────────────────────────────────

/**
 * tryReviveSession — 유효 세션이 없을 때 remember(자동로그인) 쿠키로 세션을 재발급한다.
 * 서버 재시작/업데이트로 메모리 세션이 날아가도 폰에서 재로그인 없이 이어쓰게 하는 핵심.
 * 같은 요청의 downstream(requireAuth 등)도 통과하도록 req.headers.cookie에 새 세션을 주입하고,
 * res가 있으면 새 session_token 쿠키를 응답에 심는다.
 * @returns {string|null} 새/기존 세션 토큰
 */
function tryReviveSession(req, res) {
  try {
    const cookies = parseCookies(req);
    const st = cookies.session_token || req.headers['x-session-token'];
    if (st && sessions[st]) return st;             // 이미 유효
    const raw = cookies.remember_token;
    if (!raw) return null;

    const remember = rememberMod();
    const db = dbMod();
    if (!remember || !db) return null;

    const v = remember.verify(raw);
    if (!v) return null;

    const uData = db.loadUsers();
    const user = (uData.users || []).find(u => u.userId === v.userId);
    if (!user || ['resigned', 'rejected', 'pending'].includes(user.status)) {
      remember.revoke(raw);
      if (res) remember.clearCookie(res);
      return null;
    }

    const token = generateSessionToken();
    sessions[token] = {
      userId: user.userId, name: user.name, role: user.role,
      position: user.position || '', phone: user.phone || '',
      department: user.department || '', companyId: user.companyId || 'dalim-sm',
      permissions: user.permissions || [], loginAt: Date.now(), viaRemember: true
    };
    req.headers.cookie = (req.headers.cookie ? req.headers.cookie + '; ' : '') + 'session_token=' + token;
    const secure = (remember.isHttps && remember.isHttps(req)) ? '; Secure' : '';
    if (res) remember.appendCookie(res, `session_token=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400${secure}`);
    return token;
  } catch (e) {
    try { console.warn('[auth] tryReviveSession 오류:', e.message); } catch (_) {}
    return null;
  }
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  let token = cookies.session_token || req.headers['x-session-token'];
  if (!token || !sessions[token]) {
    token = tryReviveSession(req, res);            // 자동로그인 토큰으로 세션 복구 시도
    if (!token) return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  req.user = sessions[token];
  req.sessionToken = token;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') {
      return res.status(403).json({ error: '관리자 권한이 필요합니다' });
    }
    next();
  });
}

// ── 급여 권한 미들웨어 제거됨 (2026-06-13, 보안: 미사용 급여 모듈 완전 분리) ──

// ── 기타 유틸 ─────────────────────────────────────────

function getReqUser(req) {
  if (req.user) return req.user.userId || req.user.name || '알수없음';
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  if (token && sessions[token]) return sessions[token].userId || sessions[token].name || '알수없음';
  return '알수없음';
}

// 세션 토큰 생성 (랜덤 32바이트 hex)
function generateSessionToken() {
  return crypto.randomBytes(32).toString('hex');
}

module.exports = {
  sessions,
  loginFailures,
  generateSessionToken,
  parseCookies,
  hashPassword,
  hashPasswordPbkdf2,
  verifyPassword,
  getFailureKey,
  isLocked,
  recordFailure,
  clearFailures,
  getRemainingLockMinutes,
  requireAuth,
  requireAdmin,
  getReqUser,
  tryReviveSession
};
