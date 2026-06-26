/**
 * middleware/remember.js — 자동로그인(remember-me) 토큰
 *
 * 목적: 서버가 자주 재시작/업데이트돼도 폰에서 다시 로그인할 필요 없게.
 *  - 세션(sessions{})은 메모리라 재시작 시 사라짐 → 그때 remember 토큰으로 세션을 자동 재발급.
 *
 * 보안 설계 (selector/validator 분리):
 *  - 쿠키 값  = "<selector>.<validator>"  (둘 다 랜덤)
 *  - DB 저장 = selector(PK, 비밀 아님) + sha256(validator)
 *  - 검증: selector로 1건 조회(인덱스) → validator 해시를 상수시간 비교
 *  - DB가 유출돼도 validator 원본을 못 구함(replay 차단). selector만 맞고 validator 틀리면 도난 의심 → 즉시 폐기.
 *
 * SQLite 미설치(db.sql=null) 시: 자동로그인만 비활성(일반 로그인은 정상). 모든 호출을 가드.
 */
const crypto = require('crypto');
const db = require('../db');

const COOKIE = 'remember_token';
const REMEMBER_TTL_MS = 60 * 24 * 60 * 60 * 1000; // 60일

function store() {
  return (db.sql && db.sql.rememberTokens) ? db.sql.rememberTokens : null;
}

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// 요청이 HTTPS(터널)인지 — 그러면 쿠키에 Secure를 붙인다. 사내 HTTP LAN에선 Secure 없이(안 그러면 쿠키 안 감).
function isHttps(req) {
  try {
    if (!req) return false;
    if (req.secure) return true;
    const xf = (req.headers && req.headers['x-forwarded-proto']) || '';
    return String(xf).split(',')[0].trim().toLowerCase() === 'https';
  } catch (e) { return false; }
}

// res의 기존 Set-Cookie를 보존하면서 쿠키 1개를 덧붙인다(세션 쿠키와 공존).
function appendCookie(res, cookie) {
  const prev = res.getHeader('Set-Cookie');
  if (!prev) res.setHeader('Set-Cookie', cookie);
  else if (Array.isArray(prev)) res.setHeader('Set-Cookie', prev.concat(cookie));
  else res.setHeader('Set-Cookie', [prev, cookie]);
}

/**
 * 로그인 성공 시 호출 — remember 토큰을 발급하고 쿠키를 심는다.
 * @returns {boolean} 성공 여부(SQLite 없으면 false)
 */
function issue(res, userId, device, opts) {
  const s = store();
  if (!s) return false;
  const selector = crypto.randomBytes(12).toString('hex');
  const validator = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  try {
    s.issue({
      id: selector,
      userId: String(userId),
      validatorHash: sha256(validator),
      device: String(device || ''),
      createdAt: new Date(now).toISOString(),
      lastUsedAt: new Date(now).toISOString(),
      expiresAt: now + REMEMBER_TTL_MS,
    });
  } catch (e) {
    console.warn('[remember] 토큰 발급 실패:', e.message);
    return false;
  }
  // 만료 토큰 기회적 청소(로그인은 드물어 비용 미미) — 별도 스케줄러 없이 무한증가 방지
  try { s.purgeExpired(); } catch (e) {}
  const secure = (opts && opts.secure) ? '; Secure' : '';
  appendCookie(res, `${COOKIE}=${selector}.${validator}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(REMEMBER_TTL_MS / 1000)}${secure}`);
  return true;
}

/**
 * remember 쿠키 원문을 검증한다.
 * @returns {{selector:string, userId:string}|null}
 */
function verify(raw) {
  const s = store();
  if (!s || !raw) return null;
  const dot = String(raw).indexOf('.');
  if (dot < 0) return null;
  const selector = raw.slice(0, dot);
  const validator = raw.slice(dot + 1);
  if (!selector || !validator) return null;

  let row;
  try { row = s.get(selector); } catch (e) { return null; }
  if (!row) return null;

  if (!row.expiresAt || row.expiresAt < Date.now()) {
    try { s.revoke(selector); } catch (e) {}
    return null;
  }

  const expected = Buffer.from(String(row.validatorHash), 'utf8');
  const got = Buffer.from(sha256(validator), 'utf8');
  if (expected.length !== got.length || !crypto.timingSafeEqual(expected, got)) {
    // selector는 맞는데 validator가 틀림 → 도난/충돌 의심 → 폐기
    try { s.revoke(selector); } catch (e) {}
    return null;
  }

  try { s.touch(selector, new Date().toISOString()); } catch (e) {}
  return { selector, userId: row.userId };
}

/** 로그아웃 시 호출 — 쿠키 원문으로 해당 토큰 폐기 */
function revoke(raw) {
  const s = store();
  if (!s || !raw) return;
  const dot = String(raw).indexOf('.');
  if (dot < 0) return;
  try { s.revoke(raw.slice(0, dot)); } catch (e) {}
}

/** 쿠키 제거 지시 */
function clearCookie(res) {
  appendCookie(res, `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

module.exports = { issue, verify, revoke, clearCookie, appendCookie, isHttps, COOKIE, REMEMBER_TTL_MS };
