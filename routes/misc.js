/**
 * routes/misc.js — 감사로그, 알림, 공지, 대시보드, 배포, GitHub 연동
 * Mounted at: app.use('/api', require('./routes/misc'))
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { safeBody } = require('../middleware/sanitize');
const { auditLog } = require('../middleware/audit');
const { notify, notifyRole } = require('../utils/notify');

router.get('/audit-logs', requireAdmin, (req, res) => {
  try {
    const logs = db.감사로그.load();
    const { page = 1, limit = 50, user, action } = req.query;
    let filtered = [...logs.logs];
    if (user) filtered = filtered.filter(l => l.사용자 === user);
    if (action) {
      const keywords = action.split(',').map(k => k.trim()).filter(Boolean);
      filtered = filtered.filter(l => l.행동 && keywords.some(k => l.행동.includes(k)));
    }
    filtered.reverse();
    const start = (parseInt(page) - 1) * parseInt(limit);
    res.json({ total: filtered.length, logs: filtered.slice(start, start + parseInt(limit)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// 단가 이력 API
// ══════════════════════════════════════════════════════
// GET /api/price-history/:categoryId?vendorId=&page=&limit=
router.get('/price-history/:categoryId', requireAuth, (req, res) => {
  try {
    const hist = db['단가이력'].load();
    const { vendorId, page = 1, limit = 30 } = req.query;
    let logs = (hist.logs || []).filter(l => l.품목Id === req.params.categoryId);
    if (vendorId) logs = logs.filter(l => l.업체 === vendorId);
    logs = [...logs].reverse();
    const start = (parseInt(page) - 1) * parseInt(limit);
    res.json({ total: logs.length, logs: logs.slice(start, start + parseInt(limit)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// GET /api/price-history?vendorId=&page=&limit=  (전체)
router.get('/price-history', requireAdmin, (req, res) => {
  try {
    const hist = db['단가이력'].load();
    const { vendorId, catName, page = 1, limit = 50 } = req.query;
    let logs = hist.logs || [];
    if (vendorId) logs = logs.filter(l => l.업체 === vendorId);
    if (catName) logs = logs.filter(l => l.품목명 && l.품목명.includes(catName));
    logs = [...logs].reverse();
    const start = (parseInt(page) - 1) * parseInt(limit);
    res.json({ total: logs.length, logs: logs.slice(start, start + parseInt(limit)) });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// 알림 API
// ══════════════════════════════════════════════════════
router.get('/notifications', requireAuth, (req, res) => {
  try {
    const notifs = db.알림.load();
    const userId = req.user.userId;
    const mine = (notifs.notifications || [])
      .filter(n => n.대상 === userId)
      .reverse()
      .slice(0, 50);
    const unreadCount = mine.filter(n => !n.읽음).length;
    res.json({ unreadCount, notifications: mine });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/notifications/:id/read', requireAuth, (req, res) => {
  try {
    const notifs = db.알림.load();
    const n = notifs.notifications.find(n => n.id === req.params.id);
    if (n) { n.읽음 = true; db.알림.save(notifs); }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/notifications/read-all', requireAuth, (req, res) => {
  try {
    const notifs = db.알림.load();
    const userId = req.user.userId;
    notifs.notifications.filter(n => n.대상 === userId && !n.읽음)
      .forEach(n => n.읽음 = true);
    db.알림.save(notifs);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// 공지사항 API
// ══════════════════════════════════════════════════════
router.get('/notices', requireAuth, (req, res) => {
  try {
    const data = db.공지사항.load();
    res.json((data.notices || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/notices', requireAdmin, (req, res) => {
  try {
    const data = db.공지사항.load();
    const notice = {
      id: db.generateId('notice'),
      제목: req.body.제목 || req.body.title || '',
      내용: req.body.내용 || req.body.content || '',
      작성자: req.user.userId,
      중요: req.body.중요 || false,
      createdAt: new Date().toISOString()
    };
    data.notices.push(notice);
    db.공지사항.save(data);
    auditLog(req.user.userId, '공지사항 등록', notice.제목);
    // 전체 사용자에게 알림
    const org = db.loadUsers();
    (org.users || []).filter(u => u.status === 'approved' && u.userId !== req.user.userId)
      .forEach(u => notify(u.userId, 'notice', `새 공지: ${notice.제목}`, 'notices'));
    res.json(notice);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.put('/notices/:id', requireAdmin, (req, res) => {
  try {
    // Prototype Pollution 차단
    req.body = safeBody(req.body, ['id']);
    const data = db.공지사항.load();
    const idx = data.notices.findIndex(n => n.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: 'not found' });
    data.notices[idx] = { ...data.notices[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
    db.공지사항.save(data);
    auditLog(req.user.userId, '공지사항 수정', data.notices[idx].제목 || req.params.id);
    res.json(data.notices[idx]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.delete('/notices/:id', requireAdmin, (req, res) => {
  try {
    const data = db.공지사항.load();
    const notice = data.notices.find(n => n.id === req.params.id);
    data.notices = data.notices.filter(n => n.id !== req.params.id);
    db.공지사항.save(data);
    if (notice) auditLog(req.user.userId, '공지사항 삭제', notice.제목 || req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// 대시보드 API
// ══════════════════════════════════════════════════════
router.get('/dashboard', requireAuth, (req, res) => {
  try {
    // 데이터 수집
    const categories = db.sql ? db.sql.categories.getAll() : (db.load().categories || []);
    const vendors = db.sql ? db.sql.vendors.getAll() : (db['업체관리'] ? db['업체관리'].load().vendors || [] : []);
    const quotes = db.sql ? db.sql.quotes.getAll() : (db['견적관리'] ? db['견적관리'].load().quotes || [] : []);
    const approvals = db.결재관리.load().approvals || [];
    const notices = db.공지사항.load().notices || [];

    // 이번 달 견적
    const thisMonth = new Date().toISOString().slice(0, 7);
    const monthQuotes = quotes.filter(q => (q.createdAt || '').startsWith(thisMonth));
    const monthTotal = monthQuotes.reduce((sum, q) => sum + (q.totalAmount || 0), 0);

    // 미처리 결재
    const pendingApprovals = approvals.filter(a => a.status === 'pending');

    // 최근 활동 (감사로그 최근 10건)
    let recentActivity = [];
    try {
      const logs = db.감사로그.load();
      recentActivity = (logs.logs || []).slice(-15).reverse();
    } catch(e) {}

    // 최근 공지 3건
    const recentNotices = notices.sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 3);

    // 알림
    let unreadCount = 0;
    try {
      const notifs = db.알림.load();
      unreadCount = (notifs.notifications || []).filter(n => n.대상 === req.user.userId && !n.읽음).length;
    } catch(e) {}

    res.json({
      stats: {
        품목수: categories.length,
        업체수: vendors.length,
        총견적수: quotes.length,
        이번달견적: monthQuotes.length,
        이번달매출: monthTotal,
        미처리결재: pendingApprovals.length,
        읽지않은알림: unreadCount
      },
      recentActivity,
      recentNotices,
      pendingApprovals: pendingApprovals.slice(0, 5)
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════
// 견적 상태 흐름 조회 (프론트에서 허용 상태 표시용)
// ══════════════════════════════════════════════════════
router.get('/quote-status-flow', (req, res) => {
  res.json(QUOTE_STATUS_FLOW);
});

// ══════════════════════════════════════════════════════
// 파일 배포 API (관리자 전용)
// POST /api/deploy - 파일을 서버에 직접 배포
// ══════════════════════════════════════════════════════
router.post('/deploy', requireAdmin, express.json({ limit: '50mb' }), (req, res) => {
  try {
    const { files } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: '배포할 파일이 없습니다' });
    }

    const results = [];
    const allowedDirs = ['public', 'public/css', 'public/js'];

    for (const file of files) {
      const { filePath, content, encoding } = file;
      if (!filePath || !content) {
        results.push({ filePath, success: false, error: '파일경로 또는 내용 누락' });
        continue;
      }

      // 보안: public/ 하위만 허용, 상위 디렉토리 접근 차단
      const normalized = path.normalize(filePath).replace(/\\/g, '/');
      if (normalized.includes('..') || !normalized.startsWith('public/')) {
        results.push({ filePath, success: false, error: 'public/ 폴더 외 접근 불가' });
        continue;
      }

      // server.js, db.js 등 루트 파일도 허용 (명시적 화이트리스트)
      const rootAllowed = ['server.js', 'db.js', 'db-sqlite.js'];
      const isRoot = rootAllowed.includes(normalized);
      const isPublic = normalized.startsWith('public/');

      if (!isRoot && !isPublic) {
        results.push({ filePath, success: false, error: '허용되지 않은 경로' });
        continue;
      }

      const fullPath = path.join(__dirname, '..', normalized);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : content;
      fs.writeFileSync(fullPath, buf);
      results.push({ filePath: normalized, success: true });
    }

    console.log(`[DEPLOY] ${req.user.name}(${req.user.userId}) 배포: ${results.filter(r=>r.success).length}/${files.length} 파일`);
    res.json({ results, deployed: results.filter(r => r.success).length, total: files.length });
  } catch (e) {
    console.error('[ERROR] 배포 실패:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /api/deploy/status - 서버 파일 목록 조회 (배포 확인용)
router.get('/deploy/status', requireAdmin, (req, res) => {
  try {
    const publicDir = path.join(__dirname, '..', 'public');
    const getFiles = (dir, base = 'public') => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      let files = [];
      for (const e of entries) {
        const rel = `${base}/${e.name}`;
        if (e.isDirectory()) {
          files = files.concat(getFiles(path.join(dir, e.name), rel));
        } else {
          const stat = fs.statSync(path.join(dir, e.name));
          files.push({ path: rel, size: stat.size, modified: stat.mtime });
        }
      }
      return files;
    };
    res.json({ files: getFiles(publicDir), serverTime: new Date().toISOString() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════
// Git Pull API (GitHub -> Server auto deploy)
// POST /api/git-pull - GitHub webhook (HMAC 서명 검증) or 관리자 manual trigger
// ══════════════════════════════════════════════════════
// raw body 수집 (HMAC 검증에 필요) - json 파서 대신 수동 raw 파싱
router.post('/git-pull', express.raw({ type: '*/*', limit: '1mb' }), (req, res) => {
  const { execSync } = require('child_process');
  const crypto = require('crypto');

  // ──── 1) 관리자 세션이면 통과 ────
  const { sessions, parseCookies } = require('../middleware/auth');
  const cookies = parseCookies(req);
  const sessToken = cookies.session_token || req.headers['x-session-token'];
  const sess = sessToken ? sessions[sessToken] : null;
  const isAdminSession = sess && sess.role === 'admin';

  // ──── 1.5) control-daemon secret 헤더 일치 시 통과 (배포 .bat 등 자동화 용)
  // x-control-secret 헤더에 .env CONTROL_DAEMON_SECRET 값과 일치하면 인증 통과
  const ctrlSecret = req.headers['x-control-secret'];
  const expectedCtrl = process.env.CONTROL_DAEMON_SECRET;
  const isCtrlSecret = ctrlSecret && expectedCtrl && ctrlSecret === expectedCtrl;

  // ──── 2) 관리자도 아니고 control-secret도 아니면 GitHub HMAC 서명 검증 ────
  if (!isAdminSession && !isCtrlSecret) {
    const secret = process.env.GITHUB_WEBHOOK_SECRET;
    if (!secret) {
      console.warn('[GIT-PULL] 거부: 관리자 세션 없음 + GITHUB_WEBHOOK_SECRET 미설정');
      return res.status(401).json({ success: false, error: 'Unauthorized' });
    }
    const sigHeader = req.headers['x-hub-signature-256'] || '';
    if (!sigHeader.startsWith('sha256=')) {
      return res.status(401).json({ success: false, error: 'Invalid signature header' });
    }
    const rawBody = req.body instanceof Buffer ? req.body : Buffer.from(req.body || '');
    const expected = 'sha256=' + crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
    const a = Buffer.from(sigHeader);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      console.warn('[GIT-PULL] HMAC 서명 불일치 (공격 가능성)');
      return res.status(401).json({ success: false, error: 'Invalid signature' });
    }
  }

  // ──── 3) git pull 실행 ────
  try {
    const result = execSync('git pull origin main', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30000
    });
    console.log('[GIT-PULL] ' + (isAdminSession ? `by admin ${sess.userId}` : 'by webhook') + ': ' + result.trim());
    res.json({ success: true, message: result.trim() });
  } catch (e) {
    console.error('[GIT-PULL ERROR]', e.message);
    res.status(500).json({ success: false, error: 'git pull failed' });  // stderr 노출 제거
  }
});

// GET /api/git-pull - manual trigger (admin only)
router.get('/git-pull', requireAdmin, (req, res) => {
  const { execSync } = require('child_process');
  try {
    const result = execSync('git pull origin main', {
      cwd: path.join(__dirname, '..'),
      encoding: 'utf8',
      timeout: 30000
    });
    console.log('[GIT-PULL] ' + result.trim());
    res.json({ success: true, message: result.trim() });
  } catch (e) {
    console.error('[GIT-PULL ERROR]', e.message);
    res.status(500).json({ success: false, error: 'git pull failed' });  // stderr 노출 제거
  }
});

// ── 커밋 메시지 shell 인젝션 방어용 sanitizer ──
// 영문/숫자/한글/공백/기본 구두점만 허용, 나머지 제거. 최대 200자.
function sanitizeCommitMessage(msg) {
  const s = String(msg || '').replace(/[`$"\\|&;<>(){}[\]!\n\r\t]/g, '').slice(0, 200).trim();
  return s || 'Auto commit';
}

// ══════════════════════════════════════════════════════
// Git Commit & Push API (Server -> GitHub auto sync)
// POST /api/git-push - commit all changes and push to GitHub
// ══════════════════════════════════════════════════════
router.post('/git-push', requireAdmin, express.json(), (req, res) => {
  const { execSync } = require('child_process');
  const message = sanitizeCommitMessage((req.body && req.body.message) || 'Auto deploy from Claude');
  try {
    const opts = { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000 };
    execSync('git add -A', opts);
    try {
      execSync(`git commit -m "${message}"`, opts);
    } catch (commitErr) {
      if (commitErr.stdout && commitErr.stdout.includes('nothing to commit')) {
        return res.json({ success: true, message: 'Nothing to commit, already up to date.' });
      }
      throw commitErr;
    }
    const pushResult = execSync('git push origin main', opts);
    console.log('[GIT-PUSH] ' + message);
    res.json({ success: true, message: 'Pushed: ' + message });
  } catch (e) {
    console.error('[GIT-PUSH ERROR]', e.message);
    res.status(500).json({ success: false, error: 'git push failed' });  // stderr 노출 제거
  }
});

// ══════════════════════════════════════════════════════
// Full Auto Deploy: deploy file + git push in one call
// POST /api/auto-deploy - deploy files, commit, push
// ══════════════════════════════════════════════════════
router.post('/auto-deploy', requireAdmin, express.json({ limit: '50mb' }), (req, res) => {
  const { execSync } = require('child_process');
  try {
    const { files, message } = req.body;
    if (!files || !Array.isArray(files) || files.length === 0) {
      return res.status(400).json({ error: 'No files to deploy' });
    }
    const results = [];
    for (const file of files) {
      const { filePath, content, encoding } = file;
      if (!filePath || !content) { results.push({ filePath, success: false, error: 'Missing data' }); continue; }
      const normalized = path.normalize(filePath).replace(/\\/g, '/');
      if (normalized.includes('..')) { results.push({ filePath, success: false, error: 'Invalid path' }); continue; }
      const rootAllowed = ['server.js', 'db.js', 'db-sqlite.js', 'package.json', 'CLAUDE.md'];
      const isRoot = rootAllowed.includes(normalized);
      const isPublic = normalized.startsWith('public/');
      if (!isRoot && !isPublic) { results.push({ filePath, success: false, error: 'Not allowed' }); continue; }
      const fullPath = path.join(__dirname, '..', normalized);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      const buf = encoding === 'base64' ? Buffer.from(content, 'base64') : content;
      fs.writeFileSync(fullPath, buf);
      results.push({ filePath: normalized, success: true });
    }
    // Auto git commit & push
    const opts = { cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 30000 };
    const commitMsg = sanitizeCommitMessage(message || 'Deploy: ' + results.filter(r=>r.success).map(r=>r.filePath).join(', '));
    execSync('git add -A', opts);
    try { execSync(`git commit -m "${commitMsg}"`, opts); } catch(e) {}
    try { execSync('git push origin main', opts); } catch(e) {}
    console.log(`[AUTO-DEPLOY] ${req.user.name}: ${results.filter(r=>r.success).length}/${files.length} files`);
    res.json({ results, deployed: results.filter(r=>r.success).length, total: files.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});


module.exports = router;
