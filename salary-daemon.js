/**
 * salary-daemon.js — 급여 데이터 로컬 데몬 (CAPS 스타일 격리)
 *
 * 이 프로세스는 "관리자 PC"(기본 192.168.0.30)에서만 실행된다.
 * 서버 PC(192.168.0.133)가 요청을 프록시로 보낼 때 데이터를 꺼내 응답한다.
 * 다른 누구도(외부 터널, 사내 타 PC) 직접 이 데몬에 접근할 수 없다.
 *
 * 환경변수:
 *   SALARY_DAEMON_PORT    데몬 포트 (기본 3001)
 *   SALARY_DAEMON_BIND    바인딩 IP (기본 0.0.0.0 — 사내망 전용)
 *   SALARY_DAEMON_SECRET  프록시 인증 공유 비밀 (필수)
 *   SALARY_SERVER_IP      신뢰 서버 PC IP (기본 192.168.0.133)
 *
 * 자동시작: bat/급여데몬시작.bat → Windows 시작프로그램 등록
 */

// ── 0. .env 로드 (없거나 dotenv 미설치여도 안전하게 무시) ──
try { require('dotenv').config(); } catch (e) { /* dotenv 미설치 — 기본값 사용 */ }

// ── 1. 데몬 모드 플래그 먼저 세팅 ─────────────────────────────
// routes/salary.js가 require하는 middleware/auth.js가 이 값을 읽는다.
process.env.SALARY_DAEMON_MODE = '1';

const express = require('express');
const path = require('path');
const fs = require('fs');

// ── 2. 설정 로드 ───────────────────────────────────────────
const PORT = parseInt(process.env.SALARY_DAEMON_PORT || '3001', 10);
const BIND = process.env.SALARY_DAEMON_BIND || '0.0.0.0';
const SECRET = process.env.SALARY_DAEMON_SECRET || '';
const SERVER_IP = process.env.SALARY_SERVER_IP || '192.168.0.133';

if (!SECRET) {
  console.error('❌ SALARY_DAEMON_SECRET 환경변수가 없습니다.');
  console.error('   급여데몬시작.bat 파일을 확인하세요.');
  process.exit(1);
}

// ── 3. 크래시 방지 전역 핸들러 ────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('❌ [salary-daemon:uncaughtException]', err.message);
  console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ [salary-daemon:unhandledRejection]', reason);
});

// ── 4. Express 앱 구성 ────────────────────────────────────
const app = express();
app.use(express.json({ limit: '50mb' }));

// IP 정규화: ::ffff:192.168.0.133 → 192.168.0.133, ::1 → 127.0.0.1
function normalizeIp(raw) {
  if (!raw) return '';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  if (raw === '::1') return '127.0.0.1';
  return raw;
}

// ── 5. 접근 제어 (서버 PC IP + 공유 비밀) ────────────────────
app.use((req, res, next) => {
  const clientIp = normalizeIp(req.ip || req.socket?.remoteAddress || '');
  const allowedIps = new Set([SERVER_IP, '127.0.0.1', 'localhost']);

  if (!allowedIps.has(clientIp)) {
    console.warn(`[salary-daemon] 🚫 차단된 IP: ${clientIp} (${req.method} ${req.url})`);
    return res.status(403).json({ error: 'DAEMON_IP_FORBIDDEN' });
  }

  const providedSecret = req.headers['x-proxy-secret'] || '';
  if (providedSecret !== SECRET) {
    console.warn(`[salary-daemon] 🚫 잘못된 비밀키: ${clientIp}`);
    return res.status(403).json({ error: 'DAEMON_SECRET_MISMATCH' });
  }
  next();
});

// ── 6. 헬스체크 (프록시 진단용) ──────────────────────────────
app.get('/_daemon/health', (req, res) => {
  res.json({
    ok: true,
    mode: 'salary-daemon',
    time: new Date().toISOString(),
    node: process.version
  });
});

// ── 7. 급여 라우트 마운트 (기존 코드 그대로 재사용) ──────────
// routes/salary.js → require('../middleware/auth') → SALARY_DAEMON_MODE=1 감지
//                    → x-proxy-user-* 헤더로 req.user 구성 (세션/PIN 검증 skip)
app.use('/api/salary', require('./routes/salary'));

// ── 8. 404 / 에러 핸들러 ──────────────────────────────────
app.use((req, res) => res.status(404).json({ error: 'NOT_FOUND', path: req.url }));
app.use((err, req, res, next) => {
  console.error('❌ [salary-daemon:route-error]', err.message);
  res.status(500).json({ error: err.message || 'DAEMON_ERROR' });
});

// ── 9. 리슨 ────────────────────────────────────────────────
app.listen(PORT, BIND, () => {
  console.log('');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`✅ 급여 데몬 실행 중  (v1.0)`);
  console.log(`   포트:       ${PORT}`);
  console.log(`   바인딩:     ${BIND}`);
  console.log(`   서버 PC IP: ${SERVER_IP}  ← 이 IP만 접근 허용`);
  console.log(`   DB 파일:    ${path.join(__dirname, 'data', '급여관리.db')}`);
  console.log('═══════════════════════════════════════════════════════');
  console.log('');
});
