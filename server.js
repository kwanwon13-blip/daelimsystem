// ── .env 로드 (없거나 dotenv 미설치여도 안전하게 무시) ──
try { require('dotenv').config(); } catch (e) { /* dotenv 미설치 — 기본값 사용 */ }

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
  // 로그인 + 관리자 권한 확인 (require() 이전이라 직접 체크)
  const { sessions, parseCookies } = require('./middleware/auth');
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const sess = token ? sessions[token] : null;
  if (!sess) return res.status(401).json({ error: '로그인이 필요합니다' });
  if (sess.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다' });
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

// ── 워크스페이스 외부 공유 뷰어 (로그인 불필요) ──
app.get('/workspace/view/:token', (req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'workspace-view.html'));
});

// ── /data 경로 — 이미지 파일만 서빙 (JSON/DB/백업 파일 보호) ──────
// 이전에는 data/ 전체를 정적 서빙하여 설정.json(SMTP 비번), 조직관리.json(사용자 해시),
// 업무데이터.db, 감사로그.json 등이 웹으로 모두 노출됐음. 이미지만 화이트리스트 허용.
const DATA_ALLOWED_EXT = /\.(png|jpe?g|gif|webp|ico)$/i;  // svg는 XSS 위험으로 제외
app.use('/data', (req, res, next) => {
  // 이미지 확장자만 통과
  if (!DATA_ALLOWED_EXT.test(req.path)) {
    return res.status(404).send('Not Found');
  }
  // 백업 폴더 직접 접근 차단 (이중 방어)
  if (/_기존백업|_자동백업|_backup|\.bak|\.db/i.test(req.path)) {
    return res.status(404).send('Not Found');
  }
  next();
}, express.static(path.join(__dirname, 'data'), {
  dotfiles: 'deny',  // .env 등 dotfile 차단
  index: false,      // 디렉토리 인덱싱 차단
}));

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

// ── 멀티 컴퍼니 마이그레이션 (조직관리.json에 companies 필드 추가 + 기존 사용자에 companyId 부여) ──
function migrateMultiCompany() {
  const uData = db.loadUsers();
  let changed = false;

  // companies 배열이 없으면 생성
  if (!uData.companies || uData.companies.length === 0) {
    uData.companies = [
      { id: 'dalim-sm', name: '대림에스엠', bizNo: '', ceo: '남관원', tel: '', address: '', note: '', sortOrder: 0 },
      { id: 'dalim-company', name: '대림컴퍼니', bizNo: '', ceo: '남관원', tel: '', address: '', note: '', sortOrder: 1 }
    ];
    changed = true;
    console.log('[멀티컴퍼니] companies 배열 생성됨');
  }

  // 기존 사용자에 companyId 없으면 기본값 부여
  for (const u of (uData.users || [])) {
    if (!u.companyId) {
      u.companyId = 'dalim-sm'; // 기존 직원은 모두 대림에스엠 소속
      changed = true;
    }
  }

  // 기존 부서에 companyId 없으면 기본값 부여
  for (const d of (uData.departments || [])) {
    if (!d.companyId) {
      d.companyId = 'dalim-sm';
      changed = true;
    }
  }

  if (changed) {
    db.saveUsers(uData);
    console.log('[멀티컴퍼니] 마이그레이션 완료 — 기존 데이터에 companyId 부여됨');
  }
}
try { migrateMultiCompany(); } catch(e) { console.error('⚠️ 멀티컴퍼니 마이그레이션 실패:', e.message); }

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

// ── 급여 모듈 ───────────────────────────────────────────────────────────────
// SALARY_MODE=proxy  → 관리자 PC 데몬으로 프록시 (서버 PC에는 데이터 없음)
// SALARY_MODE=local  → 로컬 DB 직결 (단일 PC 개발 환경, 기본)
const SALARY_MODE = (process.env.SALARY_MODE || 'local').toLowerCase();
if (SALARY_MODE === 'proxy') {
  console.log('[salary] 모드: proxy → 관리자 PC 데몬 호출');
  app.use('/api/salary', require('./routes/salary-proxy'));
} else {
  console.log('[salary] 모드: local → 로컬 DB 직결');
  app.use('/api/salary', require('./routes/salary'));
}

// ── 급여 가용성 체크 (프론트엔드용) ──
// proxy 모드: 현재 요청자 IP == SALARY_SOURCE_IP 일 때만 true
// local  모드: 항상 true (기존 동작)
app.get('/api/salary-availability', (req, res) => {
  const SOURCE_IP = process.env.SALARY_SOURCE_IP || '192.168.0.30';
  const raw = req.ip || req.socket?.remoteAddress || '';
  const clientIp = raw.startsWith('::ffff:') ? raw.slice(7) : (raw === '::1' ? '127.0.0.1' : raw);
  const available = SALARY_MODE === 'proxy' ? (clientIp === SOURCE_IP) : true;
  res.json({ available, mode: SALARY_MODE });
});

// ══════════════════════════════════════════════════════
// 감사 로그 API
// ══════════════════════════════════════════════════════
// ── 감사로그/알림/공지/대시보드/배포/GitHub (routes/misc.js) ──
app.use('/api', require('./routes/misc'));

// ── 과거 매출 검색 (routes/salesHistory.js) ──
app.use('/api/sales-history', require('./routes/salesHistory'));

// ── GitHub 연동 (routes/github.js) ──
app.use('/api', require('./routes/github'));

// ── GPS 출퇴근 (routes/gps-attendance.js) ──
app.use('/api/gps-attendance', require('./routes/gps-attendance'));

// ── 워크스페이스 (routes/workspace.js) ──
app.use('/api/workspace', require('./routes/workspace'));

// ── AI 히스토리/프로젝트/템플릿/첨부 (routes/ai-history.js) ──
app.use('/api/ai', require('./routes/ai-history'));

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
