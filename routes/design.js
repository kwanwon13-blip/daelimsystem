/**
 * routes/design.js — 시안 검색 + 파일/폴더 열기
 * Mounted at: app.use('/api', require('./routes/design'))
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');

// 썸네일 캐시 폴더
const THUMB_DIR = path.join(__dirname, '..', 'data', 'thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// sharp (이미지 리사이즈 — 미설치 시 원본 전송)
let sharp;
try { sharp = require('sharp'); } catch(e) { /* skip */ }

// ── 시안 검색 ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════

const DESIGN_ROOT = process.env.DESIGN_ROOT || 'D:\\';
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']);
// 네트워크 공유 경로 (클라이언트에서 폴더 열기용)
const NETWORK_SHARE = '\\\\192.168.0.133\\dd';
function toNetworkPath(localPath) {
  return localPath.replace(/^D:\\/i, NETWORK_SHARE + '\\');
}

let designIndex = [];
let designIndexStatus = { built: false, building: false, count: 0, lastBuilt: null, error: null };

// 건너뛸 시스템 폴더
const SKIP_DIRS = new Set([
  'system volume information', 'recycler', '$recycle.bin', 'recovery',
  'windows', 'program files', 'program files (x86)', 'programdata',
  'node_modules', '.git', '__pycache__', 'appdata',
  '송지현 대리'
]);

async function buildDesignIndexAsync(rootPath) {
  const items = [];
  const queue = [{ dir: rootPath, depth: 0 }];
  // .ai 파일 존재 여부를 폴더별로 배치 체크 (디스크 I/O 대폭 감소)
  const aiFileCache = new Map(); // dir -> Set of basenames with .ai

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth > 8) continue;

    // 10개 폴더마다 이벤트 루프 양보 (너무 자주 양보하면 오히려 느림)
    if (items.length % 10 === 0) await new Promise(r => setImmediate(r));

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { continue; }

    // 해당 폴더의 .ai 파일 목록을 한 번에 수집
    const aiSet = new Set();
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.ai')) {
        aiSet.add(path.basename(e.name, '.ai').toLowerCase());
      }
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const rel = path.relative(rootPath, fullPath);
        const parts = rel.split(path.sep);
        const baseName = path.basename(entry.name, path.extname(entry.name));
        // .ai 파일 존재 여부를 이미 수집한 Set에서 O(1) 조회
        let hasAi = aiSet.has(baseName.toLowerCase());
        let aiBaseName = baseName;
        // -01, -02 등 번호 접미사 제거 후 재탐색 (예: 파일명-01.jpg → 파일명.ai)
        if (!hasAi) {
          const stripped = baseName.replace(/-\d+$/, '');
          if (stripped !== baseName && aiSet.has(stripped.toLowerCase())) {
            hasAi = true;
            aiBaseName = stripped;
          }
        }
        // 수정시간 저장 (최신순 정렬용)
        let mtime = 0;
        try { mtime = fs.statSync(fullPath).mtimeMs; } catch(e) {}
        items.push({
          path: fullPath, rel, parts, name: entry.name,
          aiPath: hasAi ? path.join(dir, aiBaseName + '.ai') : null,
          mtime,
          searchText: rel.toLowerCase().replace(/\\/g, ' ').replace(/_/g, ' ')
        });
        if (items.length % 500 === 0) {
          designIndexStatus.count = items.length;
        }
      }
    }
  }
  return items;
}

let designIndexTimer = null;

function runDesignIndex() {
  if (designIndexStatus.building) return;
  if (!fs.existsSync(DESIGN_ROOT)) {
    designIndexStatus.error = `경로 없음: ${DESIGN_ROOT}`;
    console.log(`[시안검색] 경로 없음: ${DESIGN_ROOT}`);
    return;
  }
  designIndexStatus.building = true;
  designIndexStatus.error = null;
  console.log(`[시안검색] 인덱싱 시작... (${DESIGN_ROOT})`);
  buildDesignIndexAsync(DESIGN_ROOT).then(idx => {
    designIndex = idx;
    designIndexStatus = { built: true, building: false, count: idx.length, lastBuilt: new Date().toISOString(), error: null };
    console.log(`[시안검색] 완료: ${idx.length}개 파일`);
  }).catch(e => {
    designIndexStatus = { ...designIndexStatus, building: false, error: e.message };
    console.log(`[시안검색] 오류: ${e.message}`);
  });
}

function startDesignIndexer() {
  // 서버 시작 5초 후 첫 인덱싱
  setTimeout(() => {
    runDesignIndex();
    // 이후 30분마다 자동 재인덱싱 (5분은 너무 빈번 → 서버 부담)
    designIndexTimer = setInterval(runDesignIndex, 30 * 60 * 1000);
  }, 5000);
  // fs.watch 제거 — D드라이브 전체 감시는 서버 성능 심각하게 저하
  // 대신 수동 재인덱싱 버튼 또는 30분 자동 주기 사용
  console.log(`[시안검색] 30분 주기 자동 인덱싱 설정 완료 (수동: 재인덱싱 버튼 사용)`);
}
startDesignIndexer();

router.get('/design/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ items: [], total: 0, status: designIndexStatus });
  const keywords = q.split(/\s+/).filter(Boolean);
  // 빠른 검색: 첫 키워드로 1차 필터링 후 나머지 키워드 매칭
  const first = keywords[0];
  const rest = keywords.slice(1);
  let matches = designIndex.filter(item => item.searchText.includes(first));
  if (rest.length > 0) matches = matches.filter(item => rest.every(kw => item.searchText.includes(kw)));
  // 년도 필터
  const yearFilter = parseInt(req.query.year);
  if (yearFilter && yearFilter >= 2000 && yearFilter <= 2100) {
    const yearStart = new Date(yearFilter, 0, 1).getTime();
    const yearEnd = new Date(yearFilter + 1, 0, 1).getTime();
    matches = matches.filter(item => item.mtime >= yearStart && item.mtime < yearEnd);
  }
  // 최신 수정일 순으로 정렬
  matches.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const total = matches.length;
  const pageSize = Math.min(200, parseInt(req.query.pageSize) || 100);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const start = (page - 1) * pageSize;
  // searchText 제외하고 응답 (트래픽 절감) + 네트워크 경로 추가
  const results = matches.slice(start, start + pageSize).map(item => ({
    path: item.path, rel: item.rel, parts: item.parts, name: item.name, aiPath: item.aiPath,
    netPath: toNetworkPath(item.aiPath || item.path),
    netFolder: toNetworkPath(path.dirname(item.aiPath || item.path))
  }));
  res.json({ items: results, total, page, pageSize, status: designIndexStatus });
});

router.get('/design/thumb', requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) return res.status(403).send('forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');

  res.set('Cache-Control', 'public, max-age=86400'); // 24시간 캐시

  // sharp 있으면 축소된 썸네일 생성/캐시
  if (sharp) {
    const hash = crypto.createHash('md5').update(resolved).digest('hex');
    const thumbPath = path.join(THUMB_DIR, hash + '.jpg');
    // 캐시된 썸네일 있으면 바로 전송
    if (fs.existsSync(thumbPath)) {
      return res.type('image/jpeg').sendFile(thumbPath);
    }
    // 없으면 생성
    try {
      await sharp(resolved).resize(240, 180, { fit: 'cover', withoutEnlargement: true }).jpeg({ quality: 60 }).toFile(thumbPath);
      return res.type('image/jpeg').sendFile(thumbPath);
    } catch(e) {
      // sharp 실패 시 원본 전송 (단 5MB 이하만)
    }
  }

  // sharp 없으면 원본 전송 (5MB 제한)
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > 5 * 1024 * 1024) return res.status(204).end();
  } catch(e) {}
  res.sendFile(resolved);
});

router.get('/design/status', (req, res) => res.json(designIndexStatus));

// 내부망 여부 확인
router.get('/session/info', requireAuth, (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  // 클라우드플레어 터널을 통하면 실제 IP가 CF-Connecting-IP 헤더에 담김
  const cfIp = req.headers['cf-connecting-ip'] || '';
  // CF 헤더가 있으면 → 터널 경유 = 외부 접속
  // CF 헤더가 없고 192.168.0.x 이면 → 직접 내부망 접속
  const isInternal = !cfIp && (ip.includes('192.168.0.') || ip === '127.0.0.1' || ip === '::1' || ip.includes('::ffff:127.'));
  res.json({ isInternal });
});

// 파일 직접 다운로드 (외부 접속 대응)
router.get('/design/file', requireAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) {
    return res.status(403).send('forbidden');
  }
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');
  const filename = path.basename(resolved);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.sendFile(resolved);
});

router.post('/design/open-folder', requireAuth, (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path 필요' });
  const absPath = path.resolve(DESIGN_ROOT, filePath);
  const folderPath = path.dirname(absPath);
  const { execFile } = require('child_process');
  const platform = process.platform;
  if (platform === 'win32') {
    // execFile은 쉘을 거치지 않아서 특수문자(#, ●, 한글 등) 안전
    execFile('explorer', [folderPath], (err) => {
      // explorer는 성공해도 exit code 1 반환하는 경우가 있음
      res.json({ ok: true });
    });
  } else if (platform === 'darwin') {
    execFile('open', [folderPath], (err) => {
      if (err) res.status(500).json({ error: err.message });
      else res.json({ ok: true });
    });
  } else {
    execFile('xdg-open', [folderPath], (err) => {
      if (err) res.status(500).json({ error: err.message });
      else res.json({ ok: true });
    });
  }
});

// ── 폴더/파일 열기 토큰 (URL 인코딩 문제 우회) ──
const openFolderTokens = new Map(); // token -> { path, type, created }
router.post('/design/openfolder', requireAuth, (req, res) => {
  const { folderPath, openType } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const type = openType === 'file' ? 'file' : openType === 'select' ? 'select' : 'folder';
  openFolderTokens.set(token, { path: folderPath, type, created: Date.now() });
  // 5분 후 자동 삭제
  setTimeout(() => openFolderTokens.delete(token), 5 * 60 * 1000);
  res.json({ token });
});
router.get('/design/openfolder/:token', (req, res) => {
  const data = openFolderTokens.get(req.params.token);
  if (!data) return res.status(404).send('not found');
  openFolderTokens.delete(req.params.token);
  res.send(data.type + '|' + data.path);
});

router.post('/design/reindex', requireAuth, (req, res) => {
  if (designIndexStatus.building) return res.json({ building: true, message: '인덱싱 중...', count: designIndex.length });
  runDesignIndex(); // 비동기 시작
  res.json({ building: true, message: '인덱싱 시작됨 — 파일 수에 따라 수 분 소요될 수 있습니다', count: 0 });
});

// 진단용 (관리자) — 브라우저에서 /api/design/debug 로 확인
router.get('/design/debug', requireAdmin, (req, res) => {
  const rootExists = fs.existsSync(DESIGN_ROOT);
  let entries = [];
  if (rootExists) {
    try { entries = fs.readdirSync(DESIGN_ROOT).slice(0, 20); } catch(e) { entries = ['읽기 오류: '+e.message]; }
  }
  res.json({
    DESIGN_ROOT,
    rootExists,
    entries,
    status: designIndexStatus,
    indexedCount: designIndex.length,
    platform: process.platform,
  });
});


module.exports = router;
