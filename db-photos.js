// db-photos.js — 사진 라이브러리 DB 모듈
// photos 테이블: 47K+ 카톡 사진의 메타데이터 + 라벨링 + 검색

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'photos.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ========== 스키마 ==========

db.exec(`
CREATE TABLE IF NOT EXISTS photos (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  filename        TEXT UNIQUE NOT NULL,           -- 원본 파일명 (= 디스크 상의 이름)
  taken_at        TEXT,                            -- 파일명에서 추출한 촬영일 (YYYY-MM-DD HH:MM:SS)
  file_size       INTEGER,                         -- 바이트

  -- AI 분류 결과
  category        TEXT,                            -- 용품/시공현장/시안주문서/문서영수증/기타
  constructor     TEXT,                            -- 건설사
  site            TEXT,                            -- 현장명
  product         TEXT,                            -- 제품 디테일
  size_qty        TEXT,                            -- 사이즈/수량
  slogan          TEXT,                            -- 슬로건
  keywords        TEXT,                            -- 검색 키워드

  -- 정규화 (검색 정확도용)
  norm_constructor TEXT,                           -- 통일된 건설사명 (HDC 들 다 합침)
  norm_site        TEXT,                           -- 통일된 현장명

  -- 라벨링 (사람이 부여)
  is_best         INTEGER DEFAULT 0,               -- ⭐ 베스트샷 (거래처 보여줄 만한)
  is_hidden       INTEGER DEFAULT 0,               -- 🚫 숨김 (갤러리에서 안 보이게)
  custom_tags     TEXT,                            -- JSON 배열 자유 태그
  notes           TEXT,                            -- 사람이 추가한 메모

  -- 메타
  ai_processed_at TEXT,                            -- AI 분류 시점
  ai_model        TEXT,                            -- 'gemini-flash-lite' / 'claude-cli' / ...
  edited_by       TEXT,                            -- 사람이 수정한 경우 사번
  edited_at       TEXT,
  created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_photos_constructor ON photos(norm_constructor);
CREATE INDEX IF NOT EXISTS idx_photos_site ON photos(norm_site);
CREATE INDEX IF NOT EXISTS idx_photos_category ON photos(category);
CREATE INDEX IF NOT EXISTS idx_photos_taken_at ON photos(taken_at);
CREATE INDEX IF NOT EXISTS idx_photos_is_best ON photos(is_best);
CREATE INDEX IF NOT EXISTS idx_photos_is_hidden ON photos(is_hidden);
`);

// 컬럼 안전 추가 (이미 있으면 무시) — 세부 분류용
function _safeAddCol(sql) {
  try { db.exec(sql); } catch (e) {
    if (!String(e.message).includes('duplicate column')) {
      // 다른 에러면 로그만
      console.warn('[db-photos] alter:', e.message);
    }
  }
}
_safeAddCol('ALTER TABLE photos ADD COLUMN product_type TEXT');
_safeAddCol('ALTER TABLE photos ADD COLUMN size_value TEXT');
try {
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_product_type ON photos(product_type)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_photos_size_value ON photos(size_value)');
} catch (e) {}

db.exec(`

-- 동기화 상태 (카톡 사진 가져오기 버튼)
CREATE TABLE IF NOT EXISTS photo_sync_state (
  key             TEXT PRIMARY KEY,
  value           TEXT
);

-- 정규화 매핑 (사람이 수정하면 누적되는 학습 매핑)
CREATE TABLE IF NOT EXISTS photo_name_mapping (
  raw_name        TEXT PRIMARY KEY,                -- 원본 표기 (POSCO, 포스코, posco, ...)
  normalized      TEXT NOT NULL,                   -- 통일된 표기 (포스코)
  type            TEXT NOT NULL,                   -- 'constructor' / 'site'
  count           INTEGER DEFAULT 0,
  created_at      TEXT DEFAULT (datetime('now', 'localtime'))
);
`);

// ========== 헬퍼 함수 ==========

const stmts = {
  insert: db.prepare(`
    INSERT INTO photos (
      filename, taken_at, file_size,
      category, constructor, site, product, size_qty, slogan, keywords,
      norm_constructor, norm_site,
      ai_processed_at, ai_model
    ) VALUES (
      @filename, @taken_at, @file_size,
      @category, @constructor, @site, @product, @size_qty, @slogan, @keywords,
      @norm_constructor, @norm_site,
      @ai_processed_at, @ai_model
    )
    ON CONFLICT(filename) DO NOTHING
  `),

  update: db.prepare(`
    UPDATE photos SET
      category = @category,
      constructor = @constructor,
      site = @site,
      product = @product,
      size_qty = @size_qty,
      slogan = @slogan,
      keywords = @keywords,
      norm_constructor = @norm_constructor,
      norm_site = @norm_site,
      is_best = @is_best,
      is_hidden = @is_hidden,
      custom_tags = @custom_tags,
      notes = @notes,
      edited_by = @edited_by,
      edited_at = datetime('now', 'localtime')
    WHERE id = @id
  `),

  setLabel: db.prepare(`
    UPDATE photos SET
      is_best = COALESCE(@is_best, is_best),
      is_hidden = COALESCE(@is_hidden, is_hidden),
      edited_by = @edited_by,
      edited_at = datetime('now', 'localtime')
    WHERE id = @id
  `),

  byId: db.prepare('SELECT * FROM photos WHERE id = ?'),
  byFilename: db.prepare('SELECT * FROM photos WHERE filename = ?'),

  getSyncState: db.prepare('SELECT value FROM photo_sync_state WHERE key = ?'),
  setSyncState: db.prepare(`
    INSERT INTO photo_sync_state(key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `),

  upsertMapping: db.prepare(`
    INSERT INTO photo_name_mapping(raw_name, normalized, type, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(raw_name) DO UPDATE SET
      normalized = excluded.normalized,
      count = count + 1
  `),
  getMapping: db.prepare(
    `SELECT raw_name, normalized FROM photo_name_mapping WHERE type = ?`
  ),

  countAll: db.prepare('SELECT COUNT(*) as n FROM photos'),
  countVisible: db.prepare(
    `SELECT COUNT(*) as n FROM photos WHERE is_hidden = 0 AND category IN ('용품', '시공현장')`
  ),
  countTotalAll: db.prepare('SELECT COUNT(*) as n FROM photos WHERE is_hidden = 0'),
};

function insertPhoto(row) {
  return stmts.insert.run({
    filename: row.filename,
    taken_at: row.taken_at || null,
    file_size: row.file_size || null,
    category: row.category || null,
    constructor: row.constructor || null,
    site: row.site || null,
    product: row.product || null,
    size_qty: row.size_qty || null,
    slogan: row.slogan || null,
    keywords: row.keywords || null,
    norm_constructor: row.norm_constructor || null,
    norm_site: row.norm_site || null,
    ai_processed_at: row.ai_processed_at || null,
    ai_model: row.ai_model || null,
  });
}

function bulkInsert(rows) {
  const tx = db.transaction((batch) => {
    for (const row of batch) insertPhoto(row);
  });
  tx(rows);
}

// 기본 표시 카테고리 (시안주문서/문서영수증/기타 자동 숨김)
const DEFAULT_VISIBLE_CATEGORIES = ['용품', '시공현장'];

// 검색 — 카테고리/회사/현장/키워드 텍스트 검색
function searchPhotos(opts = {}) {
  const q = typeof opts.q === 'string' ? opts.q : '';
  const category = typeof opts.category === 'string' ? opts.category : null;
  const constructorName =
    typeof opts.constructorName === 'string' ? opts.constructorName :
    typeof opts.constructor === 'string' ? opts.constructor : null;
  const site = typeof opts.site === 'string' ? opts.site : null;
  const includeHidden = !!opts.includeHidden;
  const onlyHidden = !!opts.onlyHidden;
  const bestOnly = !!opts.bestOnly;
  const includeAllCats = !!opts.includeAllCats;
  const productType = typeof opts.productType === 'string' ? opts.productType : null;
  const sizeValue = typeof opts.sizeValue === 'string' ? opts.sizeValue : null;
  const limit = opts.limit;
  const offset = opts.offset;

  const where = [];
  const params = {};
  if (onlyHidden) where.push('is_hidden = 1');
  else if (!includeHidden) where.push('is_hidden = 0');
  if (bestOnly) where.push('is_best = 1');
  if (category) {
    where.push('category = @category');
    params.category = category;
  } else if (!includeAllCats) {
    // 카테고리 미지정 + 모든 카테고리 보기 X → 기본 가시 카테고리만 (용품+시공현장)
    where.push(`category IN ('${DEFAULT_VISIBLE_CATEGORIES.join("','")}')`);
  }
  if (constructorName) {
    where.push('norm_constructor LIKE @cname');
    params.cname = `%${constructorName}%`;
  }
  if (site) {
    where.push('norm_site LIKE @site');
    params.site = `%${site}%`;
  }
  if (productType) {
    where.push('product_type LIKE @ptype');
    params.ptype = `%${productType}%`;
  }
  if (sizeValue) {
    where.push('size_value LIKE @sv');
    params.sv = `%${sizeValue}%`;
  }
  if (q) {
    where.push(`(
      product LIKE @q OR
      keywords LIKE @q OR
      slogan LIKE @q OR
      norm_constructor LIKE @q OR
      norm_site LIKE @q OR
      size_qty LIKE @q OR
      product_type LIKE @q OR
      size_value LIKE @q OR
      notes LIKE @q OR
      custom_tags LIKE @q
    )`);
    params.q = `%${q}%`;
  }
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const sql = `
    SELECT * FROM photos
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY taken_at DESC, id DESC
    LIMIT ${lim} OFFSET ${off}
  `;
  const stmt = db.prepare(sql);
  return Object.keys(params).length ? stmt.all(params) : stmt.all();
}

function countPhotos(opts = {}) {
  const q = typeof opts.q === 'string' ? opts.q : '';
  const category = typeof opts.category === 'string' ? opts.category : null;
  const constructorName =
    typeof opts.constructorName === 'string' ? opts.constructorName :
    typeof opts.constructor === 'string' ? opts.constructor : null;
  const site = typeof opts.site === 'string' ? opts.site : null;
  const includeHidden = !!opts.includeHidden;
  const onlyHidden = !!opts.onlyHidden;
  const bestOnly = !!opts.bestOnly;
  const includeAllCats = !!opts.includeAllCats;
  const productType = typeof opts.productType === 'string' ? opts.productType : null;
  const sizeValue = typeof opts.sizeValue === 'string' ? opts.sizeValue : null;

  const where = [];
  const params = {};
  if (onlyHidden) where.push('is_hidden = 1');
  else if (!includeHidden) where.push('is_hidden = 0');
  if (bestOnly) where.push('is_best = 1');
  if (category) {
    where.push('category = @category');
    params.category = category;
  } else if (!includeAllCats) {
    where.push(`category IN ('${DEFAULT_VISIBLE_CATEGORIES.join("','")}')`);
  }
  if (constructorName) {
    where.push('norm_constructor LIKE @cname');
    params.cname = `%${constructorName}%`;
  }
  if (site) {
    where.push('norm_site LIKE @site');
    params.site = `%${site}%`;
  }
  if (productType) {
    where.push('product_type LIKE @ptype');
    params.ptype = `%${productType}%`;
  }
  if (sizeValue) {
    where.push('size_value LIKE @sv');
    params.sv = `%${sizeValue}%`;
  }
  if (q) {
    where.push(`(
      product LIKE @q OR
      keywords LIKE @q OR
      slogan LIKE @q OR
      norm_constructor LIKE @q OR
      norm_site LIKE @q OR
      size_qty LIKE @q OR
      product_type LIKE @q OR
      size_value LIKE @q OR
      notes LIKE @q OR
      custom_tags LIKE @q
    )`);
    params.q = `%${q}%`;
  }
  const sql = `
    SELECT COUNT(*) as n FROM photos
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
  `;
  const stmt = db.prepare(sql);
  return (Object.keys(params).length ? stmt.get(params) : stmt.get()).n;
}

// 통계 — 카테고리/회사/현장 빈도
function getStats() {
  return {
    total: stmts.countAll.get().n,
    visible: stmts.countVisible.get().n,
    byCategory: db.prepare(
      `SELECT category, COUNT(*) as n FROM photos WHERE is_hidden = 0 AND category IS NOT NULL
       GROUP BY category ORDER BY n DESC`
    ).all(),
    topConstructors: db.prepare(
      `SELECT norm_constructor as name, COUNT(*) as n FROM photos
       WHERE is_hidden = 0 AND norm_constructor IS NOT NULL AND norm_constructor != ''
       GROUP BY norm_constructor ORDER BY n DESC LIMIT 200`
    ).all(),
    topSites: db.prepare(
      `SELECT norm_site as name, COUNT(*) as n FROM photos
       WHERE is_hidden = 0 AND norm_site IS NOT NULL AND norm_site != ''
       GROUP BY norm_site ORDER BY n DESC LIMIT 200`
    ).all(),
    topProductTypes: (() => {
      try {
        return db.prepare(
          `SELECT product_type as name, COUNT(*) as n FROM photos
           WHERE is_hidden = 0 AND product_type IS NOT NULL AND product_type != ''
           AND category IN ('용품', '시공현장')
           GROUP BY product_type ORDER BY n DESC LIMIT 100`
        ).all();
      } catch (e) {
        return [];  // 컬럼 아직 없을 때
      }
    })(),
    topSizes: (() => {
      try {
        return db.prepare(
          `SELECT size_value as name, COUNT(*) as n FROM photos
           WHERE is_hidden = 0 AND size_value IS NOT NULL AND size_value != ''
           AND category IN ('용품', '시공현장')
           GROUP BY size_value ORDER BY n DESC LIMIT 100`
        ).all();
      } catch (e) {
        return [];
      }
    })(),
  };
}

function getById(id) {
  return stmts.byId.get(id);
}
function getByFilename(filename) {
  return stmts.byFilename.get(filename);
}

function updatePhoto(row) {
  return stmts.update.run(row);
}
function setLabel(id, { is_best, is_hidden, edited_by }) {
  return stmts.setLabel.run({
    id,
    is_best: typeof is_best === 'boolean' ? (is_best ? 1 : 0) : null,
    is_hidden: typeof is_hidden === 'boolean' ? (is_hidden ? 1 : 0) : null,
    edited_by: edited_by || null,
  });
}

// 동기화 상태 (last_sync_at 등)
function getSyncState(key) {
  const row = stmts.getSyncState.get(key);
  return row ? row.value : null;
}
function setSyncState(key, value) {
  stmts.setSyncState.run(key, value);
}

// 매핑 학습 (사람이 회사명 수정하면 누적)
function learnMapping(rawName, normalized, type) {
  if (!rawName || !normalized || rawName === normalized) return;
  stmts.upsertMapping.run(rawName, normalized, type);
}
function getMappings(type) {
  const map = {};
  for (const row of stmts.getMapping.all(type)) {
    map[row.raw_name] = row.normalized;
  }
  return map;
}

module.exports = {
  db,
  insertPhoto,
  bulkInsert,
  searchPhotos,
  countPhotos,
  getStats,
  getById,
  getByFilename,
  updatePhoto,
  setLabel,
  getSyncState,
  setSyncState,
  learnMapping,
  getMappings,
};
