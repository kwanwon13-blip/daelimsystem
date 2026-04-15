/**
 * routes/github.js — GitHub 연동 (코드 push/pull)
 * POST /api/github/token
 * POST /api/github/push
 * GET  /api/github/status
 * POST /api/github/pull
 */
const express = require('express');
const router = express.Router();
const https = require('https');
const path = require('path');
const fs = require('fs');
const JSZip = require('jszip');
const db = require('../db');
const { requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// GitHub API 호출 헬퍼 (Node.js 내장 https 모듈 사용)
function githubApi(token, method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'Authorization': `token ${token}`,
        'User-Agent': 'daelimsystem-erp',
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        ...(data ? { 'Content-Length': Buffer.byteLength(data) } : {})
      }
    };
    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch(e) { resolve({ status: res.statusCode, body: raw }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

// 푸시할 파일 목록 수집
function collectFilesForPush(rootDir) {
  const ignore = new Set(['node_modules', 'data', '.git', 'backups', 'thumbs', 'uploads']);
  const ignoreExt = new Set(['.db', '.log', '.bak', '.tmp', '.broken', '.csv']);
  const files = {};

  function walk(dir, rel) {
    let entries;
    try { entries = fs.readdirSync(dir); } catch(e) { return; }
    for (const f of entries) {
      if (ignore.has(f)) continue;
      const abs = path.join(dir, f);
      const relPath = rel ? `${rel}/${f}` : f;
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) {
        walk(abs, relPath);
      } else {
        const ext = path.extname(f).toLowerCase();
        if (ignoreExt.has(ext)) continue;
        if (stat.size > 5 * 1024 * 1024) continue; // 5MB 초과 제외
        try {
          const content = fs.readFileSync(abs);
          files[relPath] = content.toString('base64');
        } catch(e) { /* skip */ }
      }
    }
  }
  walk(rootDir, '');
  return files;
}

// GitHub 토큰 저장/조회
router.post('/github/token', requireAdmin, (req, res) => {
  const { token } = req.body;
  if (!token || !token.startsWith('ghp_')) return res.status(400).json({ error: '유효하지 않은 토큰' });
  const settings = db.설정.load();
  settings.githubToken = token;
  db.설정.save(settings);
  auditLog(req.user?.userId, 'GitHub토큰설정', '설정', '토큰 저장');
  res.json({ ok: true });
});

// GitHub push
router.post('/github/push', requireAdmin, async (req, res) => {
  try {
    const settings = db.설정.load();
    const token = req.body.token || settings.githubToken;
    if (!token) return res.status(400).json({ error: 'GitHub 토큰 없음 — 먼저 토큰을 설정하세요' });

    const owner = 'kwanwon13-blip';
    const repo = 'daelimsystem';
    const branch = 'main';
    const message = req.body.message || `[ERP 자동업데이트] ${new Date().toLocaleString('ko-KR')}`;

    // 1. 현재 main 브랜치 SHA
    const refRes = await githubApi(token, 'GET', `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
    if (refRes.status !== 200) return res.status(500).json({ error: `ref 조회 실패: ${refRes.status}`, detail: refRes.body });
    const latestSha = refRes.body.object.sha;

    // 2. 현재 커밋의 tree SHA
    const commitRes = await githubApi(token, 'GET', `/repos/${owner}/${repo}/git/commits/${latestSha}`);
    const baseTreeSha = commitRes.body.tree.sha;

    // 3. 파일 목록 수집 & blob 생성
    const appDir = path.join(__dirname, '..');
    const files = collectFilesForPush(appDir);
    const treeItems = [];
    const fileKeys = Object.keys(files);
    console.log(`[GitHub Push] ${fileKeys.length}개 파일 업로드 시작...`);

    for (const filePath of fileKeys) {
      const blobRes = await githubApi(token, 'POST', `/repos/${owner}/${repo}/git/blobs`, {
        content: files[filePath],
        encoding: 'base64'
      });
      if (blobRes.status !== 201) { console.warn(`[GitHub Push] blob 실패: ${filePath}`); continue; }
      treeItems.push({ path: filePath, mode: '100644', type: 'blob', sha: blobRes.body.sha });
    }

    // 4. 새 tree 생성
    const treeRes = await githubApi(token, 'POST', `/repos/${owner}/${repo}/git/trees`, {
      base_tree: baseTreeSha,
      tree: treeItems
    });
    if (treeRes.status !== 201) return res.status(500).json({ error: `tree 생성 실패: ${treeRes.status}` });

    // 5. 새 커밋 생성
    const newCommitRes = await githubApi(token, 'POST', `/repos/${owner}/${repo}/git/commits`, {
      message,
      tree: treeRes.body.sha,
      parents: [latestSha],
      author: { name: 'kwanwon13', email: 'kwanwon13@gmail.com', date: new Date().toISOString() }
    });
    if (newCommitRes.status !== 201) return res.status(500).json({ error: `커밋 생성 실패: ${newCommitRes.status}` });

    // 6. main 브랜치 업데이트
    const updateRes = await githubApi(token, 'PATCH', `/repos/${owner}/${repo}/git/refs/heads/${branch}`, {
      sha: newCommitRes.body.sha,
      force: false
    });
    if (updateRes.status !== 200) return res.status(500).json({ error: `ref 업데이트 실패: ${updateRes.status}` });

    auditLog(req.user?.userId, 'GitHub Push', repo, `${fileKeys.length}개 파일, 커밋: ${newCommitRes.body.sha.slice(0,7)}`);
    console.log(`[GitHub Push] 완료: ${newCommitRes.body.sha.slice(0,7)}`);
    res.json({ ok: true, sha: newCommitRes.body.sha.slice(0,7), files: fileKeys.length, message });

  } catch(e) {
    console.error('[GitHub Push] 오류:', e);
    res.status(500).json({ error: e.message });
  }
});

// GitHub 연동 상태 조회
router.get('/github/status', requireAdmin, async (req, res) => {
  const settings = db.설정.load();
  const token = settings.githubToken;
  if (!token) return res.json({ connected: false });
  try {
    const r = await githubApi(token, 'GET', '/repos/kwanwon13-blip/daelimsystem');
    if (r.status === 200) {
      const refR = await githubApi(token, 'GET', '/repos/kwanwon13-blip/daelimsystem/git/refs/heads/main');
      const sha = refR.body?.object?.sha?.slice(0, 7) || '?';
      res.json({ connected: true, repo: r.body.full_name, latestSha: sha });
    } else {
      res.json({ connected: false, error: `상태코드 ${r.status}` });
    }
  } catch(e) { res.json({ connected: false, error: e.message }); }
});

// GitHub pull — GitHub에서 최신 코드를 ZIP으로 받아 서버 파일을 덮어쓰고 재시작
router.post('/github/pull', requireAdmin, async (req, res) => {
  try {
    const settings = db.설정.load();
    const token = settings.githubToken;
    if (!token) return res.status(400).json({ error: 'GitHub 토큰 없음' });

    const owner = 'kwanwon13-blip';
    const repo  = 'daelimsystem';
    const branch = 'main';

    // data/ 폴더 및 덮어쓰면 안 되는 경로
    const skipPaths = new Set(['data', 'node_modules', 'backups', '.git', 'uploads', 'thumbs']);

    // 1. 최신 커밋 SHA
    const refRes = await githubApi(token, 'GET', `/repos/${owner}/${repo}/git/refs/heads/${branch}`);
    if (refRes.status !== 200) return res.status(500).json({ error: `ref 조회 실패: ${refRes.status}` });
    const latestSha = refRes.body.object.sha;

    // 2. 전체 저장소를 ZIP 한 번에 다운로드 (리다이렉트 따라가기)
    const zipBuffer = await new Promise((resolve, reject) => {
      function download(url, useAuth, redirects) {
        if (redirects > 5) return reject(new Error('너무 많은 리다이렉트'));
        const urlObj = new URL(url);
        const opts = {
          hostname: urlObj.hostname,
          path: urlObj.pathname + urlObj.search,
          method: 'GET',
          headers: {
            'User-Agent': 'daelimsystem-erp',
            ...(useAuth ? { 'Authorization': `token ${token}`, 'Accept': 'application/vnd.github.v3+json' } : {})
          },
          timeout: 120000
        };
        const req = https.request(opts, (r) => {
          if (r.statusCode === 301 || r.statusCode === 302 || r.statusCode === 307) {
            r.resume();
            return download(r.headers.location, false, redirects + 1);
          }
          if (r.statusCode !== 200) {
            r.resume();
            return reject(new Error(`ZIP 다운로드 실패: ${r.statusCode}`));
          }
          const chunks = [];
          r.on('data', c => chunks.push(c));
          r.on('end', () => resolve(Buffer.concat(chunks)));
          r.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('ZIP 다운로드 타임아웃 (120초)')); });
        req.end();
      }
      download(`https://api.github.com/repos/${owner}/${repo}/zipball/${branch}`, true, 0);
    });

    // 3. ZIP 압축 해제 및 파일 쓰기
    const appDir = path.join(__dirname, '..');
    const zip = await JSZip.loadAsync(zipBuffer);
    let updated = 0, skipped = 0;

    for (const [zipPath, zipEntry] of Object.entries(zip.files)) {
      if (zipEntry.dir) continue;
      // GitHub zipball 내부 폴더명: "{owner}-{repo}-{sha}/" → 제거
      const relPath = zipPath.replace(/^[^/]+\//, '');
      if (!relPath) continue;

      const topDir = relPath.split('/')[0];
      if (skipPaths.has(topDir)) { skipped++; continue; }

      const content = await zipEntry.async('nodebuffer');
      const destPath = path.join(appDir, relPath);
      const destDir = path.dirname(destPath);
      if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });
      fs.writeFileSync(destPath, content);
      updated++;
    }

    auditLog(req.user?.userId, 'GitHub Pull', repo, `${updated}개 파일 업데이트, SHA: ${latestSha.slice(0,7)}`);
    console.log(`[GitHub Pull] 완료: ${updated}개 파일 업데이트 (SHA: ${latestSha.slice(0,7)})`);

    // 4. 응답 먼저 보내고 서버 재시작
    res.json({ ok: true, sha: latestSha.slice(0,7), updated, skipped });

    // 워치독이 있으면 자동 재시작, 없으면 수동 재시작 필요
    setTimeout(() => {
      console.log('[GitHub Pull] 서버 재시작...');
      process.exit(0);
    }, 500);

  } catch(e) {
    console.error('[GitHub Pull] 오류:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
