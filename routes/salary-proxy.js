/**
 * routes/salary-proxy.js — 급여 API 프록시 (서버 PC 전용)
 *
 * 요청 흐름:
 *   브라우저 (192.168.0.30) → 서버(192.168.0.133:3000) → 데몬(192.168.0.30:3002)
 *
 * ⚠️ 포트 3001 은 CAPS Bridge 전용. salary-daemon 은 반드시 3002.
 *
 * 이 라우터가 하는 일:
 *   1) 접속 IP 확인: 관리자 PC(SALARY_SOURCE_IP) 외엔 차단
 *   2) 세션/관리자/급여 PIN 검증 (requireSalaryAccess)
 *   3) 검증된 사용자 정보를 x-proxy-user-* 헤더로 담아 데몬에 전달
 *   4) 데몬 응답을 스트리밍 그대로 클라이언트에 돌려줌
 *
 * 환경변수:
 *   SALARY_SOURCE_IP      관리자 PC IP (기본 192.168.0.30)
 *   SALARY_DAEMON_URL     데몬 주소 (기본 http://192.168.0.30:3002)
 *   SALARY_DAEMON_SECRET  데몬과 공유하는 비밀키 (필수)
 *   SALARY_DAEMON_TIMEOUT 응답 대기 ms (기본 15000)
 */
const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const router = express.Router();

const { requireSalaryAccess, logSalaryAccess } = require('../middleware/auth');

const SOURCE_IP = process.env.SALARY_SOURCE_IP || '192.168.0.30';
const DAEMON_URL = process.env.SALARY_DAEMON_URL || 'http://192.168.0.30:3002';
const SECRET = process.env.SALARY_DAEMON_SECRET || '';
const TIMEOUT = parseInt(process.env.SALARY_DAEMON_TIMEOUT || '15000', 10);

if (!SECRET) {
  console.warn('[salary-proxy] ⚠️  SALARY_DAEMON_SECRET 환경변수가 비어 있습니다. 데몬 호출이 실패할 것입니다.');
}

// IP 정규화
function normalizeIp(raw) {
  if (!raw) return '';
  if (raw.startsWith('::ffff:')) return raw.slice(7);
  if (raw === '::1') return '127.0.0.1';
  return raw;
}

// ── 1차 게이트: 관리자 PC IP 여부 ──────────────────────────
router.use((req, res, next) => {
  const clientIp = normalizeIp(req.ip || req.socket?.remoteAddress || '');
  // X-Forwarded-For가 설정되어 있어도 신뢰하지 않음 (trust proxy 미설정)
  if (clientIp !== SOURCE_IP) {
    return res.status(403).json({
      error: '이 기능은 등록된 관리자 PC에서만 접근할 수 있습니다.',
      code: 'NOT_SALARY_PC'
    });
  }
  next();
});

// ── 2차 게이트: 로그인 + 관리자 + 급여 PIN ─────────────────
router.use(requireSalaryAccess);

// ── 3차: 프록시 실행 ──────────────────────────────────────
router.use((req, res) => {
  const targetUrl = new URL(req.originalUrl, DAEMON_URL);
  const lib = targetUrl.protocol === 'https:' ? https : http;

  // 사용자 정보 헤더 인코딩 (non-ASCII 안전)
  const userName = encodeURIComponent(req.user?.name || '');
  const perms = Array.isArray(req.user?.permissions) ? req.user.permissions.join(',') : '';

  // 전달할 헤더 조립
  const forwardHeaders = {
    'x-proxy-secret': SECRET,
    'x-proxy-user-id': String(req.user?.userId || ''),
    'x-proxy-user-role': String(req.user?.role || ''),
    'x-proxy-user-name': userName,
    'x-proxy-user-permissions': perms
  };

  // Content-Type / Transfer-Encoding / Accept 등 일부 원본 헤더 유지
  const passThru = ['content-type', 'accept', 'accept-language', 'user-agent'];
  passThru.forEach(h => {
    if (req.headers[h]) forwardHeaders[h] = req.headers[h];
  });

  // ── Body 재직렬화 방식 결정 ────────────────────────────
  // express.json()이 이미 req.body를 파싱한 경우 → JSON.stringify
  // multipart/form-data 등 bodyParser가 건드리지 않은 경우 → req 자체를 pipe
  const ct = (req.headers['content-type'] || '').toLowerCase();
  const isJsonPreparsed = ct.includes('application/json') && req.body && typeof req.body === 'object';
  const isMultipart = ct.includes('multipart/form-data');

  let bodyPayload = null;
  if (isJsonPreparsed) {
    bodyPayload = Buffer.from(JSON.stringify(req.body), 'utf8');
    forwardHeaders['content-length'] = String(bodyPayload.length);
  } else if (!isMultipart && ['POST','PUT','PATCH','DELETE'].includes(req.method) && req.headers['content-length']) {
    forwardHeaders['content-length'] = req.headers['content-length'];
    forwardHeaders['transfer-encoding'] = req.headers['transfer-encoding'];
  }

  const options = {
    method: req.method,
    hostname: targetUrl.hostname,
    port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
    path: targetUrl.pathname + targetUrl.search,
    headers: forwardHeaders,
    timeout: TIMEOUT
  };

  const proxyReq = lib.request(options, (proxyRes) => {
    // 상태코드 + 헤더 그대로 전달 (단, Transfer-Encoding은 제거해 Express가 알아서 처리)
    const passedHeaders = { ...proxyRes.headers };
    delete passedHeaders['transfer-encoding'];
    res.writeHead(proxyRes.statusCode || 502, passedHeaders);
    proxyRes.pipe(res);
  });

  proxyReq.on('timeout', () => {
    console.error('[salary-proxy] ⏱️  데몬 응답 타임아웃:', req.originalUrl);
    proxyReq.destroy(new Error('DAEMON_TIMEOUT'));
  });

  proxyReq.on('error', (err) => {
    console.error('[salary-proxy] ❌ 데몬 호출 실패:', err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: '급여 데몬에 연결할 수 없습니다. 관리자 PC에서 급여데몬이 실행 중인지 확인하세요.',
        code: 'DAEMON_UNREACHABLE',
        detail: err.message
      });
    }
  });

  // body 전송
  if (bodyPayload) {
    proxyReq.end(bodyPayload);
  } else if (isMultipart || !['POST','PUT','PATCH'].includes(req.method)) {
    // multipart는 스트리밍, GET/DELETE는 body 없음
    req.pipe(proxyReq);
  } else {
    proxyReq.end();
  }
});

module.exports = router;
