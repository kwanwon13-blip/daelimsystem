const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
// v2.1
const db = require('./db');

// ── 전역 에러 핸들러 (서버 크래시 방지) ──────────────
process.on('uncaughtException', (err) => {
  console.error('❌ [uncaughtException]', err.message);
  console.error(err.stack);
  // 서버를 죽이지 않고 계속 실행
});
process.on('unhandledRejection', (reason) => {
  console.error('❌ [unhandledRejection]', reason);
});
const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── index.html 서버사이드 인클루드 ─────────────────────────
// <!--INCLUDE:파일명.html--> 태그를 실제 파일 내용으로 치환하여 서빙
// 분리된 탭 HTML (tab-pricing.html, tab-options.html 등)을 index.html에 합쳐서 전송
const PUBLIC_DIR = path.join(__dirname, 'public');
let _indexCache = null;
let _indexMtime = 0;

function buildIndexHtml() {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  const stat = fs.statSync(indexPath);
  // 인클루드 파일들의 최신 mtime도 확인
  const includeFiles = (fs.readdirSync(PUBLIC_DIR)).filter(f => f.startsWith('tab-') && f.endsWith('.html'));
  const latestMtime = Math.max(stat.mtimeMs, ...includeFiles.map(f => {
    try { return fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs; } catch(e) { return 0; }
  }));
  // 파일이 변경되지 않았으면 캐시 사용
  if (_indexCache && latestMtime === _indexMtime) return _indexCache;
  let html = fs.readFileSync(indexPath, 'utf-8');
  // <!--INCLUDE:filename.html--> 패턴 치환
  html = html.replace(/<!--INCLUDE:([a-zA-Z0-9_\-]+\.html)-->/g, (match, filename) => {
    const filePath = path.join(PUBLIC_DIR, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    console.warn('[SSI] 파일 없음:', filename);
    return match; // 파일이 없으면 원본 유지
  });
  // function app() 스크립트 앞에 있는 불필요한 </body> 제거 (브라우저 파싱 오류 방지)
  const appScriptIdx = html.indexOf('<script>\nfunction app()');
  if (appScriptIdx === -1) {
    // CRLF 줄바꿈 시도
    const appScriptIdxCRLF = html.indexOf('<script>\r\nfunction app()');
    if (appScriptIdxCRLF > -1) {
      const before = html.slice(0, appScriptIdxCRLF);
      const after = html.slice(appScriptIdxCRLF);
      html = before.replace(/<\/body>\s*$/, '') + after;
    }
  } else {
    const before = html.slice(0, appScriptIdx);
    const after = html.slice(appScriptIdx);
    html = before.replace(/<\/body>\s*$/, '') + after;
  }
  _indexCache = html;
  _indexMtime = latestMtime;
  return html;
}

app.get('/api/admin/clear-cache', (req, res) => {
  _indexCache = null;
  _indexMtime = 0;
  res.json({ ok: true, msg: 'SSI cache cleared' });
});

app.get(['/', '/index.html'], (req, res) => {
  try {
    const html = buildIndexHtml();
    res.type('html').send(html);
  } catch (e) {
    console.error('[SSI] 오류:', e.message);
    // 실패 시 원본 index.html 직접 전송
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));
// data 폴더에서 로고/직인 이미지 제공
app.use('/data', express.static(path.join(__dirname, 'data')));

// ── 시안 파일 보안 미들웨어 ──────────────────────────────
app.use('/files', (req, res, next) => {
  // 1. 로그인 확인 (requireAuth 전이므로 직접 쿠키 파싱)
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  if (!token || !sessions[token]) {
    return res.status(401).send('로그인이 필요합니다.');
  }

  const ua = req.headers['user-agent'] || '';
  const isMobile = /mobile|android|iphone|ipad/i.test(ua);

  // 2. 모바일은 로그인만 되어있으면 허용
  if (isMobile) return next();

  // 3. 데스크탑은 허가된 IP만 허용
  const ip = req.ip || req.connection.remoteAddress || '';
  const 사무실 = ip.includes('192.168.0.');    // 사무실 내부망
  const 공장   = ip.includes('59.15.222.131'); // 공장 외부IP
  const 집     = ip.includes('220.126.134.84'); // 집

  if (사무실 || 공장 || 집) return next();

  // 4. 그 외 데스크탑 차단
  return res.status(403).send('허가된 IP에서만 접속 가능합니다.');
});

// D드라이브 시안 폴더 서빙 (로그인+IP 보안 적용)
app.use('/files', express.static('D:\\시안'));

// ── 미들웨어 모듈 (분리된 파일에서 로드) ─────────────────
const {
  sessions, parseCookies,
  hashPassword, verifyPassword,
  getFailureKey, isLocked, recordFailure, clearFailures, getRemainingLockMinutes,
  requireSalaryAccess, createSalarySession, expireSalarySession,
  logSalaryAccess, salaryAccessLog
} = require('./middleware/auth');


// 초기 관리자 계정 확인 + 기존 SHA256 비밀번호 PBKDF2 자동 마이그레이션
function ensureAdminAccount() {
  const uData = db.loadUsers();
  if (!uData.users) uData.users = [];
  const hasAdmin = uData.users.some(u => u.role === 'admin');
  if (!hasAdmin) {
    uData.users.push({
      id: db.generateId('u'),
      userId: 'admin',
      name: '관리자',
      password: hashPassword('admin'),
      role: 'admin',
      status: 'approved',
      createdAt: new Date().toISOString(),
      lastLogin: null
    });
    db.saveUsers(uData);
    console.log('[초기설정] 관리자 계정 생성됨 (admin / admin)');
  }
  // 기존 SHA256 비밀번호를 PBKDF2로 마이그레이션 (비밀번호 알 수 없으므로 임시 처리)
  // → 실제 마이그레이션은 로그인 성공 시 자동으로 이루어짐 (routes/auth.js verifyPassword)
}
// 서버 시작 시 관리자 계정 확인
try { ensureAdminAccount(); } catch(e) { console.error('⚠️ 관리자 계정 확인 실패 (서버는 계속 실행):', e.message); }

app.use('/api/auth', require('./routes/auth'));

// ── 관리자/사용자/부서 (routes/admin.js) ──
app.use('/api', require('./routes/admin'));

// ── 결재 시스템 (routes/approvals.js) ──
app.use('/api/approvals', require('./routes/approvals'));
app.use('/api/approval', require('./routes/approvals'));

// ── 캘린더 (routes/calendar.js) ──
app.use('/api/calendar', require('./routes/calendar'));

// ── 카테고리 (routes/categories.js) ──
app.use('/api/categories', require('./routes/categories'));

// ── 옵션 (routes/options.js) ──
app.use('/api/options', require('./routes/options'));

// ── 업체 (routes/vendors.js) ──
app.use('/api/vendors', require('./routes/vendors'));

// ── 업체별 단가 (routes/vendorPrices.js) ──
app.use('/api', require('./routes/vendorPrices'));

// ── 견적/통계/명함 (routes/quotes.js) ──
app.use('/api', require('./routes/quotes'));


// ── 메일 발송 (routes/mail.js) ──
app.use('/api', require('./routes/mail'));

// ── 백업 (routes/backup.js) ──
app.use('/api', require('./routes/backup'));

// ══════════════════════════════════════════════════════════
// ── 전화번호부 (routes/contacts.js) ──
app.use('/api/contacts', require('./routes/contacts'));
// 마이그레이션: 서버 시작 시 기존 flat 연락처 데이터를 3단 구조로 변환
try { (function migrateContactsData() {
  const data = db.load(); const contacts = data.contacts || [];
  if (data.contactCompanies && data.contactCompanies.length > 0) return;
  if (data.contactSites && Array.isArray(data.contactSites)) {
    const defaultCompany = { id: 'comp_' + Date.now(), name: '기본 업체', note: '', createdAt: new Date().toISOString() };
    data.contactCompanies = [defaultCompany];
    data.contactProjects = data.contactSites.map(site => ({ id: site.id, companyId: defaultCompany.id, name: site.name, address: site.address || '', note: site.note || '', createdAt: site.createdAt || new Date().toISOString(), customFields: site.customFields || [] }));
    contacts.forEach(c => { if (c.siteId && !c.projectId) c.projectId = c.siteId; }); db.save(data); return;
  }
})(); } catch(e) { console.error('연락처 마이그레이션 실패:', e.message); }


// ── 시안 검색 (routes/design.js) ──
app.use('/api', require('./routes/design'));

// ══════════════════════════════════════════════════════════
// ── 공지사항 (→ 하단 공지사항 API 섹션으로 이동됨) ───────
// ══════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════
// ── 출퇴근/연차 관리 (routes/attendance.js) ──
app.use('/api', require('./routes/attendance'));

// ── 급여 모듈 (routes/salary.js) ──────────────────────────────────────────────
app.use('/api/salary', require('./routes/salary'));

// ══════════════════════════════════════════════════════
// 감사 로그 API
// ══════════════════════════════════════════════════════
// ── 감사로그/알림/공지/대시보드/배포/GitHub (routes/misc.js) ──
app.use('/api', require('./routes/misc'));

// ── GitHub 연동 (routes/github.js) ──
app.use('/api', require('./routes/github'));

app.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) { localIP = cfg.address; break; }
    }
  }
  console.log(`\n✅ 단가표 서버 실행 중 (v2026-04-04 admin-fix)`);
  console.log(`   로컬: http://localhost:${PORT}`);
  console.log(`   네트워크: http://${localIP}:${PORT}  ← 직원들은 이 주소로 접속`);
  console.log(`   자동동기화: 08:35, 11:35, 14:05, 19:05 (평일)
`);
});
