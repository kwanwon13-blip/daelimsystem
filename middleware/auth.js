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
const salarySessions = {};  // { salaryToken: { userId, expiresAt } }  ← 급여 재인증 토큰

// ── 로그인 실패 추적 ──────────────────────────────────
// { "ip_or_userId": { count, lockedUntil } }
const loginFailures = {};
const MAX_FAILURES  = 5;          // 최대 실패 횟수
const LOCK_DURATION = 30 * 60 * 1000; // 잠금 시간: 30분

// ── 급여 세션 만료 시간 ───────────────────────────────
const SALARY_SESSION_TTL = 30 * 60 * 1000; // 30분

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

function requireAuth(req, res, next) {
  // ── 데몬 모드: 프록시 헤더 신뢰 ──
  if (process.env.SALARY_DAEMON_MODE === '1') {
    const userId = req.headers['x-proxy-user-id'];
    const role = req.headers['x-proxy-user-role'];
    if (!userId || !role) {
      return res.status(403).json({ error: '프록시 사용자 정보 누락', code: 'DAEMON_USER_MISSING' });
    }
    let decodedName = req.headers['x-proxy-user-name'] || '';
    try { decodedName = decodeURIComponent(decodedName); } catch(e) {}
    req.user = {
      userId: String(userId),
      name: decodedName,
      role,
      permissions: (req.headers['x-proxy-user-permissions'] || '').split(',').filter(Boolean)
    };
    req.sessionToken = 'daemon-proxy';
    return next();
  }

  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
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

// ── 급여 권한 미들웨어 ────────────────────────────────

/**
 * requireSalaryAccess
 * 조건: 로그인 + 관리자(admin) + 급여 PIN 재인증 완료
 * 급여는 보안이 매우 중요하므로 관리자만 접근 가능 (2026-04-17 강화)
 *
 * 데몬 모드 (process.env.SALARY_DAEMON_MODE === '1'):
 *   서버 PC가 프록시로 호출하므로 세션/쿠키/PIN 검증은 서버 PC에서 이미 완료됨.
 *   이 프로세스는 x-proxy-secret / x-proxy-user-* 헤더만 신뢰하면 됨.
 *   (헤더 1차 검증은 salary-daemon.js 진입 미들웨어에서 수행)
 */
function requireSalaryAccess(req, res, next) {
  // ── control-daemon secret bypass — sandbox/자동화 호출 (admin-import 등) ──
  // x-control-secret 헤더가 .env CONTROL_DAEMON_SECRET 와 일치하면 인증 통과
  // 이건 LAN 안에서만 도달 가능하고 secret 보안에 의존하므로 안전함
  const ctrlSecret = req.headers['x-control-secret'];
  const expectedCtrl = process.env.CONTROL_DAEMON_SECRET;
  if (ctrlSecret && expectedCtrl && ctrlSecret === expectedCtrl) {
    req.user = { userId: 'control-daemon', name: 'AUTO', role: 'admin', permissions: [] };
    req.sessionToken = 'control-daemon-bypass';
    return next();
  }

  // ── 데몬 모드: 프록시 헤더로부터 req.user 재구성 ──
  if (process.env.SALARY_DAEMON_MODE === '1') {
    const userId = req.headers['x-proxy-user-id'];
    const role = req.headers['x-proxy-user-role'];
    const name = req.headers['x-proxy-user-name'] || '';
    const permRaw = req.headers['x-proxy-user-permissions'] || '';

    if (!userId || !role) {
      return res.status(403).json({ error: '프록시 사용자 정보 누락', code: 'DAEMON_USER_MISSING' });
    }
    // 관리자만 데몬 요청 처리
    if (role !== 'admin') {
      return res.status(403).json({ error: '급여 모듈은 관리자만 접근할 수 있습니다', code: 'ADMIN_ONLY' });
    }

    let decodedName = name;
    try { decodedName = decodeURIComponent(name); } catch(e) {}

    req.user = {
      userId: String(userId),
      name: decodedName,
      role,
      permissions: permRaw ? String(permRaw).split(',').filter(Boolean) : []
    };
    req.sessionToken = 'daemon-proxy';
    return next();
  }

  // 1. 로그인 확인
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  req.user = sessions[token];
  req.sessionToken = token;

  // 2. 관리자 권한 필수 (salary_view 권한만으론 부족 — 급여는 관리자 전용)
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: '급여 모듈은 관리자만 접근할 수 있습니다', code: 'ADMIN_ONLY' });
  }

  // 3. 급여 PIN 재인증 토큰 확인
  const salaryToken = cookies.salary_token || req.headers['x-salary-token'];
  if (!salaryToken || !salarySessions[salaryToken]) {
    return res.status(403).json({ error: '급여 PIN 인증이 필요합니다', code: 'SALARY_PIN_REQUIRED' });
  }

  // 4. 토큰 만료 확인
  const ss = salarySessions[salaryToken];
  if (Date.now() > ss.expiresAt) {
    delete salarySessions[salaryToken];
    return res.status(403).json({ error: '급여 인증이 만료되었습니다. 다시 PIN을 입력해주세요', code: 'SALARY_PIN_EXPIRED' });
  }

  // 5. 토큰 소유자 확인 (다른 사람 토큰 사용 방지)
  if (ss.userId !== req.user.userId) {
    return res.status(403).json({ error: '유효하지 않은 급여 인증입니다', code: 'SALARY_PIN_MISMATCH' });
  }

  next();
}

/**
 * createSalarySession — PIN 검증 성공 후 급여 세션 발급
 * @returns salaryToken (32바이트 hex)
 */
function createSalarySession(userId) {
  // 기존 토큰 정리 (같은 유저 중복 방지)
  Object.keys(salarySessions).forEach(t => {
    if (salarySessions[t].userId === userId) delete salarySessions[t];
  });

  const token = crypto.randomBytes(32).toString('hex');
  salarySessions[token] = {
    userId,
    createdAt: Date.now(),
    expiresAt: Date.now() + SALARY_SESSION_TTL
  };
  return token;
}

/**
 * expireSalarySession — 로그아웃 또는 수동 만료 시 호출
 */
function expireSalarySession(userId) {
  Object.keys(salarySessions).forEach(t => {
    if (salarySessions[t].userId === userId) delete salarySessions[t];
  });
}

// ── 급여 접근 로그 ────────────────────────────────────
const salaryAccessLog = []; // 메모리 로그 (서버 재시작 시 초기화)

function logSalaryAccess(userId, action, detail) {
  const entry = {
    ts: new Date().toISOString(),
    userId,
    action,   // 'PIN_OK' | 'PIN_FAIL' | 'VIEW' | 'EXPORT'
    detail: detail || ''
  };
  salaryAccessLog.unshift(entry);
  if (salaryAccessLog.length > 500) salaryAccessLog.pop(); // 최근 500건만
  console.log(`[SALARY] ${entry.ts} | ${userId} | ${action} | ${detail || ''}`);
}

// ── 기타 유틸 ─────────────────────────────────────────

function getReqUser(req) {
  if (req.user) return req.user.userId || req.user.name || '알수없음';
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  if (token && sessions[token]) return sessions[token].userId || sessions[token].name || '알수없음';
  return '알수없음';
}

module.exports = {
  // 세션
  sessions,
  generateSessionToken,
  // 쿠키
  parseCookies,
  // 비밀번호
  hashPassword,
  hashPasswordPbkdf2,
  verifyPassword,
  // 로그인 실패 제한
  getFailureKey,
  isLocked,
  recordFailure,
  clearFailures,
  getRemainingLockMinutes,
  // 기본 미들웨어
  requireAuth,
  requireAdmin,
  // 급여 미들웨어
  requireSalaryAccess,
  createSalarySession,
  expireSalarySession,
  // 급여 로그
  logSalaryAccess,
  salaryAccessLog,
  // 유틸
  getReqUser
};
