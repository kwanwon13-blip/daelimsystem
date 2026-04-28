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
// 파일 종류별 확장자 매핑 (검색 대상 전체)
const FILE_TYPES = {
  image: new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']),
  pdf:   new Set(['.pdf']),
  ai:    new Set(['.ai']),
  psd:   new Set(['.psd']),
  excel: new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv']),
  hwp:   new Set(['.hwp', '.hwpx']),
  word:  new Set(['.docx', '.doc']),
};
// 확장자 → 파일종류 역매핑
const EXT_TO_TYPE = (() => {
  const m = {};
  for (const [type, exts] of Object.entries(FILE_TYPES)) {
    for (const ext of exts) m[ext] = type;
  }
  return m;
})();
const INDEXED_EXTS = new Set(Object.keys(EXT_TO_TYPE));
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

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth > 8) continue;

    // 10개 폴더마다 이벤트 루프 양보 (너무 자주 양보하면 오히려 느림)
    if (items.length % 10 === 0) await new Promise(r => setImmediate(r));

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { continue; }

    // 해당 폴더의 .ai 파일 목록을 한 번에 수집 (이미지-AI 연결용)
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
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!INDEXED_EXTS.has(ext)) continue;
        const fileType = EXT_TO_TYPE[ext];
        const rel = path.relative(rootPath, fullPath);
        const parts = rel.split(path.sep);
        const baseName = path.basename(entry.name, ext);
        // 이미지 파일일 때만 .ai 연결 파일 찾기 (기존 동작 유지)
        let aiPath = null;
        if (fileType === 'image') {
          let hasAi = aiSet.has(baseName.toLowerCase());
          let aiBaseName = baseName;
          if (!hasAi) {
            const stripped = baseName.replace(/-\d+$/, '');
            if (stripped !== baseName && aiSet.has(stripped.toLowerCase())) {
              hasAi = true;
              aiBaseName = stripped;
            }
          }
          if (hasAi) aiPath = path.join(dir, aiBaseName + '.ai');
        }
        let mtime = 0;
        try { mtime = fs.statSync(fullPath).mtimeMs; } catch(e) {}
        items.push({
          path: fullPath, rel, parts, name: entry.name,
          aiPath,
          fileType, ext,
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
  // types 파라미터: 콤마로 구분된 파일종류 목록 (예: "image,pdf")
  const typesParam = (req.query.types || '').trim();
  const typeFilter = typesParam ? new Set(typesParam.split(',').filter(Boolean)) : null;

  // 파일종류별 개수 집계 (전체 인덱스 기준 — 필터 UI에서 숫자 표시용)
  const typeCounts = {};
  for (const t of Object.keys(FILE_TYPES)) typeCounts[t] = 0;
  for (const item of designIndex) {
    if (item.fileType && typeCounts[item.fileType] !== undefined) typeCounts[item.fileType]++;
  }

  if (!q || q === '__countonly__') return res.json({ items: [], total: 0, typeCounts, status: designIndexStatus });
  const keywords = q.split(/\s+/).filter(Boolean);
  const first = keywords[0];
  const rest = keywords.slice(1);
  let matches = designIndex.filter(item => item.searchText.includes(first));
  if (rest.length > 0) matches = matches.filter(item => rest.every(kw => item.searchText.includes(kw)));
  // 파일종류 필터
  if (typeFilter && typeFilter.size > 0) {
    matches = matches.filter(item => typeFilter.has(item.fileType));
  }
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
  // 페이지당 기본 40개, 최대 200개
  const pageSize = Math.min(200, parseInt(req.query.pageSize) || 40);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const start = (page - 1) * pageSize;
  const results = matches.slice(start, start + pageSize).map(item => ({
    path: item.path, rel: item.rel, parts: item.parts, name: item.name, aiPath: item.aiPath,
    fileType: item.fileType, ext: item.ext,
    netPath: toNetworkPath(item.aiPath || item.path),
    netFolder: toNetworkPath(path.dirname(item.aiPath || item.path))
  }));
  res.json({ items: results, total, page, pageSize, typeCounts, status: designIndexStatus });
});

// 파일종류별 아이콘 색/라벨
const TYPE_ICON = {
  pdf:   { bg: '#dc2626', fg: '#ffffff', label: 'PDF' },
  ai:    { bg: '#ea580c', fg: '#ffffff', label: 'AI' },
  psd:   { bg: '#1e40af', fg: '#ffffff', label: 'PSD' },
  excel: { bg: '#16a34a', fg: '#ffffff', label: 'XLSX' },
  hwp:   { bg: '#0284c7', fg: '#ffffff', label: 'HWP' },
  word:  { bg: '#2563eb', fg: '#ffffff', label: 'DOC' },
};
function iconSvg(fileType, ext) {
  const icon = TYPE_ICON[fileType] || { bg: '#64748b', fg: '#ffffff', label: (ext || '').replace('.', '').toUpperCase() };
  const label = icon.label;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180" viewBox="0 0 240 180">
  <rect width="240" height="180" fill="${icon.bg}"/>
  <g transform="translate(120, 75)">
    <rect x="-32" y="-28" width="64" height="56" rx="6" fill="${icon.fg}" opacity="0.15"/>
    <text x="0" y="8" font-family="-apple-system, Segoe UI, sans-serif" font-size="22" font-weight="700" fill="${icon.fg}" text-anchor="middle">${label}</text>
  </g>
  <text x="120" y="150" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" fill="${icon.fg}" opacity="0.7" text-anchor="middle">파일</text>
</svg>`;
}

router.get('/design/thumb', requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) return res.status(403).send('forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');

  res.set('Cache-Control', 'public, max-age=86400'); // 24시간 캐시

  const ext = path.extname(resolved).toLowerCase();
  const fileType = EXT_TO_TYPE[ext];

  // 이미지가 아니면 파일종류 아이콘 SVG 반환
  if (fileType && fileType !== 'image') {
    res.type('image/svg+xml').send(iconSvg(fileType, ext));
    return;
  }

  // 이미지: sharp 있으면 축소된 썸네일 생성/캐시
  if (sharp) {
    const hash = crypto.createHash('md5').update(resolved).digest('hex');
    const thumbPath = path.join(THUMB_DIR, hash + '.jpg');
    if (fs.existsSync(thumbPath)) {
      return res.type('image/jpeg').sendFile(thumbPath);
    }
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

// ──────────────────────────────────────────────────────────
// 워터마크 다운로드 — 이미지에 DAELIM SM 로고를 타일 패턴으로 합성
// ──────────────────────────────────────────────────────────
const WATERMARK_IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
const LOGO_PATH = path.join(__dirname, '..', 'data', 'logo.png');

// 워터마크용 로고 (data/logo.png) 를 모듈 로드 시 한 번만 읽어 base64 + 사이즈 캐시
let WATERMARK_LOGO = null;       // { base64, width, height, aspect } 또는 null (로고 없음)
async function preloadWatermarkLogo() {
  if (!sharp) return;
  if (!fs.existsSync(LOGO_PATH)) {
    console.warn('[design] 워터마크 로고 없음:', LOGO_PATH);
    return;
  }
  try {
    // PNG 그대로 읽고 메타만 추출 (리사이즈는 합성 시 SVG <image> 태그가 알아서 처리)
    const meta = await sharp(LOGO_PATH).metadata();
    const buf = fs.readFileSync(LOGO_PATH);
    WATERMARK_LOGO = {
      base64: buf.toString('base64'),
      width: meta.width || 1000,
      height: meta.height || 200,
      aspect: (meta.width || 1000) / (meta.height || 200),
    };
    console.log('[design] 워터마크 로고 로드 OK:', WATERMARK_LOGO.width + 'x' + WATERMARK_LOGO.height);
  } catch (e) {
    console.error('[design] 워터마크 로고 로드 실패:', e.message);
  }
}
preloadWatermarkLogo();

// 이미지 크기에 맞는 SVG 워터마크 생성 (실제 DAELIM SM 로고를 패턴으로 회전 타일링)
function buildWatermarkSvg(width, height) {
  // 로고 한 개의 표시 너비 — 이미지 너비의 18% (큰 이미지에선 더 크게)
  const logoW = Math.max(200, Math.floor(width * 0.18));
  const logoH = WATERMARK_LOGO ? Math.round(logoW / WATERMARK_LOGO.aspect) : 40;
  // 타일 한 칸 — 로고 크기보다 약간 크게 (간격 포함)
  const tileW = Math.round(logoW * 1.6);
  const tileH = Math.round(logoH * 4.5);
  const opacity = 0.28;

  if (WATERMARK_LOGO) {
    // 실제 로고 PNG 를 SVG <image> 로 임베딩하여 패턴화 + 회전
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <pattern id="wm" patternUnits="userSpaceOnUse" width="${tileW}" height="${tileH}" patternTransform="rotate(-22)">
      <image xlink:href="data:image/png;base64,${WATERMARK_LOGO.base64}" x="${(tileW - logoW) / 2}" y="${(tileH - logoH) / 2}" width="${logoW}" height="${logoH}" opacity="${opacity}" preserveAspectRatio="xMidYMid meet" />
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#wm)" />
</svg>`;
  }

  // 폴백: 로고 파일 없을 때만 텍스트 기반
  const fontSize = Math.max(28, Math.floor(tileW / 8));
  const subFontSize = Math.max(9, Math.floor(fontSize / 3.5));
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="wm" patternUnits="userSpaceOnUse" width="${tileW}" height="${tileH}" patternTransform="rotate(-22)">
      <g font-family="Arial, sans-serif" fill="#374151" fill-opacity="${opacity}">
        <text x="${tileW/2}" y="${tileH/2}" text-anchor="middle" font-size="${subFontSize}" font-weight="600" letter-spacing="2">TOTAL SAFETY GROUP CO., LTD.</text>
        <text x="${tileW/2}" y="${tileH/2 + fontSize * 0.9}" text-anchor="middle" font-size="${fontSize}" font-weight="800" letter-spacing="1">DAELIM SM</text>
      </g>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#wm)" />
</svg>`;
}

router.get('/design/file-watermarked', requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) {
    return res.status(403).send('forbidden');
  }
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');

  const ext = path.extname(resolved).toLowerCase();
  if (!WATERMARK_IMG_EXTS.has(ext)) {
    return res.status(400).send('이미지 파일만 워터마크 적용 가능합니다');
  }
  if (!sharp) {
    return res.status(503).send('sharp 라이브러리 미설치 — 워터마크 기능 사용 불가');
  }

  try {
    const img = sharp(resolved, { failOn: 'none' });
    const meta = await img.metadata();
    const w = meta.width || 1024;
    const h = meta.height || 768;
    // 너무 큰 이미지는 다운스케일 (4096px 초과 시) — 메모리 보호
    const MAX_DIM = 4096;
    let resizedImg = img;
    let outW = w, outH = h;
    if (w > MAX_DIM || h > MAX_DIM) {
      const ratio = MAX_DIM / Math.max(w, h);
      outW = Math.round(w * ratio);
      outH = Math.round(h * ratio);
      resizedImg = img.resize(outW, outH, { fit: 'inside' });
    }

    const wmSvg = Buffer.from(buildWatermarkSvg(outW, outH), 'utf8');
    const isPng = ext === '.png' || ext === '.webp';
    const composited = await resizedImg
      .composite([{ input: wmSvg, top: 0, left: 0 }])
      .toBuffer({ resolveWithObject: false });

    // 출력 형식: 원본이 PNG/WebP면 PNG 유지, 그 외엔 JPEG (워터마크 합성된 결과)
    const outBuf = isPng
      ? await sharp(composited).png({ quality: 90, compressionLevel: 6 }).toBuffer()
      : await sharp(composited).jpeg({ quality: 88, progressive: true }).toBuffer();

    const baseName = path.basename(resolved, ext);
    const outExt = isPng ? '.png' : '.jpg';
    const outName = baseName + '_watermarked' + outExt;
    res.setHeader('Content-Type', isPng ? 'image/png' : 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(outName)}`);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(outBuf);
  } catch (e) {
    console.error('[design/file-watermarked] 처리 실패:', e.message);
    res.status(500).send('워터마크 처리 실패: ' + e.message);
  }
});

// 원본 보기 (inline 전송 — 라이트박스용)
router.get('/design/view', requireAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) {
    return res.status(403).send('forbidden');
  }
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');
  const ext = path.extname(resolved).toLowerCase();
  // 콘텐츠 타입 지정 (브라우저가 inline 렌더링할 수 있는 타입)
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif',
    '.bmp': 'image/bmp', '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };
  const mime = mimeMap[ext];
  if (mime) res.setHeader('Content-Type', mime);
  // inline 명시 (attachment 아님)
  const filename = path.basename(resolved);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
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


// 외부 모듈(routes/product-design.js 등)에서 designIndex 직접 접근하기 위한 export
router.getDesignIndex = () => designIndex;
router.getDesignIndexStatus = () => designIndexStatus;
router.getDesignRoot = () => DESIGN_ROOT;
router.toNetworkPath = toNetworkPath;

module.exports = router;
oduct-design.js 등)에서 designIndex 직접 접근하기 위한 export
router.getDesignIndex = () => designIndex;
router.getDesignIndexStatus = () => designIndexStatus;
router.getDesignRoot = () => DESIGN_ROOT;
router.toNetworkPath = toNetworkPath;

module.exports = router;
