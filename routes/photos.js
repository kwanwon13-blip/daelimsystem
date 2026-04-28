/**
 * routes/photos.js — 사진 라이브러리 API
 * Mounted at: app.use('/api/photos', require('./routes/photos'))
 *
 * 엔드포인트:
 *   GET    /api/photos                  검색/필터/페이징
 *   GET    /api/photos/stats            통계 (카테고리/회사/현장 TOP)
 *   GET    /api/photos/:id              단일 사진
 *   PATCH  /api/photos/:id              사진 메타데이터 수정 (회사·현장·키워드 등)
 *   POST   /api/photos/:id/label        라벨 토글 (is_best, is_hidden)
 *   POST   /api/photos/sync-preview     다운로드 폴더 스캔 (분류 안 함, 미리보기만)
 *   POST   /api/photos/sync             신규 사진 가져오기 + Claude CLI 분류
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const dbPhotos = require('../db-photos');

const PHOTOS_DIR = path.join(__dirname, '..', 'data', 'photos');

// ── 검색 / 페이징 ──────────────────────────────────────────
router.get('/', (req, res) => {
  try {
    const params = {
      q: (req.query.q || '').trim(),
      category: req.query.category || null,
      constructor: req.query.constructor || null,
      site: req.query.site || null,
      bestOnly: req.query.best === '1' || req.query.best === 'true',
      includeHidden: req.query.hidden === '1' || req.query.hidden === 'true',
      limit: Math.min(parseInt(req.query.limit) || 100, 500),
      offset: parseInt(req.query.offset) || 0,
    };
    const items = dbPhotos.searchPhotos(params);
    const total = dbPhotos.countPhotos(params);
    res.json({ ok: true, items, total, limit: params.limit, offset: params.offset });
  } catch (e) {
    console.error('[photos] search error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 통계 (사이드바 필터용) ─────────────────────────────────
router.get('/stats', (req, res) => {
  try {
    res.json({ ok: true, ...dbPhotos.getStats() });
  } catch (e) {
    console.error('[photos] stats error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 단일 사진 ──────────────────────────────────────────────
router.get('/:id(\\d+)', (req, res) => {
  const p = dbPhotos.getById(parseInt(req.params.id));
  if (!p) return res.status(404).json({ ok: false, error: 'not found' });
  res.json({ ok: true, photo: p });
});

// ── 메타데이터 수정 ────────────────────────────────────────
// body: { constructor, site, product, keywords, category, slogan, size_qty, custom_tags, notes }
router.patch('/:id(\\d+)', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const photo = dbPhotos.getById(id);
    if (!photo) return res.status(404).json({ ok: false, error: 'not found' });

    const merged = {
      ...photo,
      ...req.body,
      id,
    };

    // 회사명·현장명 직접 수정 시 → 정규화 컬럼 자동 갱신 + 매핑 학습
    if (req.body.constructor !== undefined && req.body.constructor !== photo.constructor) {
      if (photo.constructor) {
        dbPhotos.learnMapping(photo.constructor, req.body.constructor, 'constructor');
      }
      merged.norm_constructor = req.body.constructor || '';
    }
    if (req.body.site !== undefined && req.body.site !== photo.site) {
      if (photo.site) {
        dbPhotos.learnMapping(photo.site, req.body.site, 'site');
      }
      merged.norm_site = req.body.site || '';
    }

    // 라벨 / 숨김 그대로
    merged.is_best = photo.is_best;
    merged.is_hidden = photo.is_hidden;

    merged.edited_by = req.body.edited_by || (req.user && req.user.사번) || null;

    dbPhotos.updatePhoto(merged);
    res.json({ ok: true, photo: dbPhotos.getById(id) });
  } catch (e) {
    console.error('[photos] update error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 라벨 토글 (베스트샷·숨김) ───────────────────────────────
// body: { is_best?: bool, is_hidden?: bool }
router.post('/:id(\\d+)/label', (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const { is_best, is_hidden } = req.body;
    dbPhotos.setLabel(id, {
      is_best: typeof is_best === 'boolean' ? is_best : undefined,
      is_hidden: typeof is_hidden === 'boolean' ? is_hidden : undefined,
      edited_by: (req.user && req.user.사번) || req.body.edited_by || null,
    });
    res.json({ ok: true, photo: dbPhotos.getById(id) });
  } catch (e) {
    console.error('[photos] label error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 카톡 사진 동기화 (Phase 6 — 일단 골격만) ────────────────
// body: { downloadDir?: string }
// 다운로드 폴더에서 카톡 사진 패턴 매칭, 신규/중복 갯수 미리보기
const KAKAO_PATTERN = /^(KakaoTalk_\d{8}_|\d{8}_\d{6})/;

function listKakaoFiles(dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    if (!fs.statSync(full).isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (!['.jpg', '.jpeg', '.png'].includes(ext)) continue;
    if (!KAKAO_PATTERN.test(name)) continue;
    out.push({ name, path: full, size: fs.statSync(full).size });
  }
  return out;
}

router.post('/sync-preview', (req, res) => {
  try {
    const downloadDir = req.body.downloadDir || dbPhotos.getSyncState('download_dir') || 'C:\\Users\\NAMGW\\Downloads';
    const files = listKakaoFiles(downloadDir);

    // 중복 체크: filename + size
    let duplicate = 0;
    let newCount = 0;
    const newFiles = [];
    for (const f of files) {
      const existing = dbPhotos.getByFilename(f.name);
      if (existing && existing.file_size === f.size) {
        duplicate++;
      } else {
        newCount++;
        newFiles.push({ name: f.name, size: f.size });
      }
    }

    res.json({
      ok: true,
      downloadDir,
      total: files.length,
      duplicate,
      newCount,
      newFiles: newFiles.slice(0, 20), // 미리보기 20개만
    });
  } catch (e) {
    console.error('[photos] sync-preview error:', e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 실제 동기화는 다음 단계 (Claude CLI 분류 + DB 등록 + 원본 삭제)
// 지금은 placeholder
router.post('/sync', (req, res) => {
  res.json({
    ok: false,
    error: 'sync not implemented yet (Phase 6). Use sync-preview for now.',
  });
});

// ── 동기화 설정 ────────────────────────────────────────────
router.get('/sync-config', (req, res) => {
  res.json({
    ok: true,
    downloadDir: dbPhotos.getSyncState('download_dir') || 'C:\\Users\\NAMGW\\Downloads',
    lastSyncAt: dbPhotos.getSyncState('last_sync_at') || null,
  });
});
router.post('/sync-config', (req, res) => {
  if (req.body.downloadDir) {
    dbPhotos.setSyncState('download_dir', req.body.downloadDir);
  }
  res.json({ ok: true });
});

module.exports = router;
