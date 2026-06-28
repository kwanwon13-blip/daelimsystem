/**
 * db-sqlite.js — SQLite 기반 업무 데이터 (품목/업체/견적)
 *
 * 테이블 구조:
 *   categories    — 품목 (pricingType, tiers JSON 등)
 *   options       — 옵션 (variants, quotes JSON 등)
 *   vendors       — 업체
 *   vendor_prices — 업체별 맞춤 단가
 *   quotes        — 견적서 헤더
 *   quote_items   — 견적서 항목
 *
 * 사용법:
 *   const sqldb = require('./db-sqlite');
 *   const cats = sqldb.categories.getAll();
 *   sqldb.categories.create({ name: '현수막', code: 'BN', ... });
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const pickupLogic = require('./lib/pickup-logic');

const DB_PATH = path.join(__dirname, 'data', '업무데이터.db');

// data 폴더 보장
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// WAL 모드 (동시 읽기 성능 향상)
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 테이블 생성 ──────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    pricingType TEXT NOT NULL DEFAULT 'QTY',
    unit TEXT NOT NULL DEFAULT '개',
    tiers TEXT DEFAULT '[]',
    widthTiers TEXT DEFAULT '[]',
    qtyPrice REAL DEFAULT 0,
    fixedPrice REAL DEFAULT 0,
    purchaseSpecs TEXT DEFAULT '[]',
    variants TEXT DEFAULT '[]',
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS options (
    id TEXT PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    price REAL DEFAULT 0,
    unit TEXT DEFAULT '개',
    pricingType TEXT DEFAULT 'fixed',
    categoryIds TEXT DEFAULT '[]',
    variants TEXT DEFAULT '[]',
    quotes TEXT DEFAULT '[]',
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vendors (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    bizNo TEXT DEFAULT '',
    ceo TEXT DEFAULT '',
    phone TEXT DEFAULT '',
    email TEXT DEFAULT '',
    address TEXT DEFAULT '',
    note TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS vendor_prices (
    id TEXT PRIMARY KEY,
    vendorId TEXT NOT NULL,
    categoryId TEXT NOT NULL,
    tiers TEXT DEFAULT '[]',
    widthTiers TEXT DEFAULT '[]',
    qtyPrice REAL DEFAULT 0,
    fixedPrice REAL DEFAULT 0,
    UNIQUE(vendorId, categoryId),
    FOREIGN KEY (vendorId) REFERENCES vendors(id) ON DELETE CASCADE,
    FOREIGN KEY (categoryId) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS quotes (
    id TEXT PRIMARY KEY,
    siteName TEXT DEFAULT '',
    quoteName TEXT DEFAULT '',
    manager TEXT DEFAULT '',
    vendorManager TEXT DEFAULT '',
    vendorId TEXT DEFAULT '',
    vendorName TEXT DEFAULT '',
    totalAmount REAL DEFAULT 0,
    status TEXT DEFAULT 'draft',
    createdBy TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now')),
    mailHistory TEXT DEFAULT '[]'
  );

  CREATE TABLE IF NOT EXISTS quote_items (
    id TEXT PRIMARY KEY,
    quoteId TEXT NOT NULL,
    sortOrder INTEGER DEFAULT 0,
    name TEXT DEFAULT '',
    spec TEXT DEFAULT '',
    unit TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    unitPrice REAL DEFAULT 0,
    amount REAL DEFAULT 0,
    remark TEXT DEFAULT '',
    meta TEXT DEFAULT '{}',
    FOREIGN KEY (quoteId) REFERENCES quotes(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_vendor_prices_vendor ON vendor_prices(vendorId);
  CREATE INDEX IF NOT EXISTS idx_vendor_prices_category ON vendor_prices(categoryId);
  CREATE INDEX IF NOT EXISTS idx_quote_items_quote ON quote_items(quoteId);
  CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status);
  CREATE INDEX IF NOT EXISTS idx_quotes_vendorId ON quotes(vendorId);

  CREATE TABLE IF NOT EXISTS pickup_requests (
    id TEXT PRIMARY KEY,
    registrarId TEXT NOT NULL,
    registrarName TEXT DEFAULT '',
    pickupDate TEXT NOT NULL,
    vendorId TEXT,
    vendorName TEXT NOT NULL DEFAULT '',
    preferredTimeSlot TEXT DEFAULT '',
    priority TEXT DEFAULT 'normal',
    status TEXT DEFAULT 'requested',
    sourceType TEXT DEFAULT 'manual',
    sourceJobId TEXT DEFAULT NULL,
    sourceRef TEXT DEFAULT NULL,
    memo TEXT DEFAULT '',
    isLate INTEGER DEFAULT 0,
    requestedAt TEXT DEFAULT (datetime('now')),
    courseConfirmedAt TEXT DEFAULT NULL,
    updatedAt TEXT DEFAULT (datetime('now')),
    cancelledAt TEXT DEFAULT NULL,
    cancelledBy TEXT DEFAULT NULL,
    cancelReason TEXT DEFAULT '',
    courseId TEXT DEFAULT NULL,
    FOREIGN KEY (vendorId) REFERENCES vendors(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS pickup_items (
    id TEXT PRIMARY KEY,
    requestId TEXT NOT NULL,
    lineNo INTEGER DEFAULT 0,
    itemName TEXT NOT NULL,
    spec TEXT DEFAULT '',
    site TEXT DEFAULT '',
    qty REAL DEFAULT 0,
    unit TEXT DEFAULT '개',
    status TEXT DEFAULT 'requested',
    pickedQty REAL DEFAULT NULL,
    failReason TEXT DEFAULT '',
    checkedAt TEXT DEFAULT NULL,
    checkedBy TEXT DEFAULT NULL,
    FOREIGN KEY (requestId) REFERENCES pickup_requests(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS pickup_courses (
    id TEXT PRIMARY KEY,
    pickupDate TEXT NOT NULL,
    courseNumber INTEGER,
    vendorId TEXT,
    vendorName TEXT DEFAULT '',
    status TEXT DEFAULT 'draft',
    assignedDriver TEXT DEFAULT '',
    vehicle TEXT DEFAULT '',
    sortOrder INTEGER DEFAULT 0,
    confirmedAt TEXT DEFAULT NULL,
    completedAt TEXT DEFAULT NULL,
    notes TEXT DEFAULT '',
    createdAt TEXT DEFAULT (datetime('now')),
    updatedAt TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pickup_req_date   ON pickup_requests(pickupDate);
  CREATE INDEX IF NOT EXISTS idx_pickup_req_vendor ON pickup_requests(vendorId);
  CREATE INDEX IF NOT EXISTS idx_pickup_req_status ON pickup_requests(status);
  CREATE INDEX IF NOT EXISTS idx_pickup_req_source ON pickup_requests(sourceJobId);
  CREATE INDEX IF NOT EXISTS idx_pickup_items_req  ON pickup_items(requestId);
  CREATE INDEX IF NOT EXISTS idx_pickup_courses_date ON pickup_courses(pickupDate);
`);

// ── 기존 DB 마이그레이션: quote_items.meta 컬럼 없으면 추가 ──
try {
  const cols = db.prepare("PRAGMA table_info(quote_items)").all();
  if (!cols.find(c => c.name === 'meta')) {
    db.prepare("ALTER TABLE quote_items ADD COLUMN meta TEXT DEFAULT '{}'").run();
  }
} catch(e) { console.warn('quote_items meta 마이그레이션 오류:', e.message); }

// ── vendors 픽업 필드 마이그레이션 (없는 컬럼만 ALTER) ──
try {
  const vcols = db.prepare("PRAGMA table_info(vendors)").all().map(c => c.name);
  const adds = [
    ["vendorType", "TEXT DEFAULT '기타'"],
    ["mapSearchKeyword", "TEXT DEFAULT ''"],
    ["contactPerson", "TEXT DEFAULT ''"],
    ["contactPhone", "TEXT DEFAULT ''"],
    ["pickupMemo", "TEXT DEFAULT ''"],
    ["parkingAccessMemo", "TEXT DEFAULT ''"],
    ["isActive", "INTEGER DEFAULT 1"],
  ];
  for (const [col, def] of adds) {
    if (!vcols.includes(col)) db.prepare(`ALTER TABLE vendors ADD COLUMN ${col} ${def}`).run();
  }
} catch (e) { console.warn('vendors 픽업필드 마이그레이션 오류:', e.message); }

// ── pickup_items.site 컬럼 마이그레이션 (없으면 추가) ──
try {
  const icols = db.prepare("PRAGMA table_info(pickup_items)").all().map(c => c.name);
  if (!icols.includes('site')) db.prepare("ALTER TABLE pickup_items ADD COLUMN site TEXT DEFAULT ''").run();
} catch (e) { console.warn('pickup_items site 마이그레이션 오류:', e.message); }

// ── 기존 DB 마이그레이션: pickup_requests.vendorId 를 NULLABLE 로 (자유 업체명 등록 허용) ──
// 기존 테이블이 vendorId NOT NULL + FK RESTRICT 로 만들어져 있으면 재구성한다.
// SQLite는 컬럼 NOT NULL/FK 변경 ALTER 가 없으므로 테이블 재생성으로 처리.
try {
  const pcols = db.prepare("PRAGMA table_info(pickup_requests)").all();
  const vidCol = pcols.find(c => c.name === 'vendorId');
  if (vidCol && vidCol.notnull === 1) {
    db.pragma('foreign_keys = OFF');
    const rebuild = db.transaction(() => {
      db.exec(`
        CREATE TABLE pickup_requests_new (
          id TEXT PRIMARY KEY,
          registrarId TEXT NOT NULL,
          registrarName TEXT DEFAULT '',
          pickupDate TEXT NOT NULL,
          vendorId TEXT,
          vendorName TEXT NOT NULL DEFAULT '',
          preferredTimeSlot TEXT DEFAULT '',
          priority TEXT DEFAULT 'normal',
          status TEXT DEFAULT 'requested',
          sourceType TEXT DEFAULT 'manual',
          sourceJobId TEXT DEFAULT NULL,
          sourceRef TEXT DEFAULT NULL,
          memo TEXT DEFAULT '',
          isLate INTEGER DEFAULT 0,
          requestedAt TEXT DEFAULT (datetime('now')),
          courseConfirmedAt TEXT DEFAULT NULL,
          updatedAt TEXT DEFAULT (datetime('now')),
          cancelledAt TEXT DEFAULT NULL,
          cancelledBy TEXT DEFAULT NULL,
          cancelReason TEXT DEFAULT '',
          courseId TEXT DEFAULT NULL,
          FOREIGN KEY (vendorId) REFERENCES vendors(id) ON DELETE SET NULL
        );
      `);
      db.exec(`
        INSERT INTO pickup_requests_new (
          id, registrarId, registrarName, pickupDate, vendorId, vendorName,
          preferredTimeSlot, priority, status, sourceType, sourceJobId, sourceRef,
          memo, isLate, requestedAt, courseConfirmedAt, updatedAt, cancelledAt,
          cancelledBy, cancelReason, courseId
        )
        SELECT
          id, registrarId, registrarName, pickupDate, vendorId, vendorName,
          preferredTimeSlot, priority, status, sourceType, sourceJobId, sourceRef,
          memo, isLate, requestedAt, courseConfirmedAt, updatedAt, cancelledAt,
          cancelledBy, cancelReason, courseId
        FROM pickup_requests;
      `);
      db.exec('DROP TABLE pickup_requests;');
      db.exec('ALTER TABLE pickup_requests_new RENAME TO pickup_requests;');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_pickup_req_date   ON pickup_requests(pickupDate);
        CREATE INDEX IF NOT EXISTS idx_pickup_req_vendor ON pickup_requests(vendorId);
        CREATE INDEX IF NOT EXISTS idx_pickup_req_status ON pickup_requests(status);
        CREATE INDEX IF NOT EXISTS idx_pickup_req_source ON pickup_requests(sourceJobId);
      `);
    });
    rebuild();
    db.pragma('foreign_keys = ON');
    console.log('pickup_requests.vendorId NULLABLE 마이그레이션 완료');
  }
} catch (e) {
  try { db.pragma('foreign_keys = ON'); } catch (e2) {}
  console.warn('pickup_requests vendorId 마이그레이션 오류:', e.message);
}

// ── 워크플로 이력(events) 테이블 — 섀도 이관 대상(routes/workflow.js의 단일 events 배열) ──
// 멱등 CREATE. try-catch로 감싸 어떤 경우에도 서버 부팅을 막지 않음(실패 시 events는 JSON으로 계속 동작).
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_events (
      seq            INTEGER PRIMARY KEY AUTOINCREMENT,
      id             TEXT NOT NULL UNIQUE,
      jobId          TEXT NOT NULL,
      type           TEXT,
      message        TEXT,
      meta           TEXT NOT NULL DEFAULT '{}',
      targetUserId   TEXT DEFAULT '',
      targetUserName TEXT DEFAULT '',
      targetLabel    TEXT DEFAULT '',
      readBy         TEXT NOT NULL DEFAULT '[]',
      actorId        TEXT DEFAULT '',
      actorName      TEXT DEFAULT '',
      createdAt      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_workflow_events_job ON workflow_events(jobId);
    CREATE INDEX IF NOT EXISTS idx_workflow_events_created ON workflow_events(createdAt);
  `);
} catch(e) { console.warn('workflow_events 테이블 생성 오류:', e.message); }

// ── 워크플로 스토어(작업/파일/발주/현장) 테이블 — 섀도 이관. 각 항목 = id + jobId(검색용) + blob(전체 JSON). ──
// 전체배열 upsert + orphan삭제로 in-place 산재변경·삭제를 1번에 반영. try-catch로 서버 부팅 보호.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_jobs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, jobId TEXT, blob TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_wfjobs_job ON workflow_jobs(jobId);
    CREATE TABLE IF NOT EXISTS workflow_files (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, jobId TEXT, blob TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_wffiles_job ON workflow_files(jobId);
    CREATE TABLE IF NOT EXISTS workflow_orders (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, jobId TEXT, blob TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_wforders_job ON workflow_orders(jobId);
    CREATE TABLE IF NOT EXISTS workflow_projects (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, jobId TEXT, blob TEXT NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_wfprojects_job ON workflow_projects(jobId);
  `);
} catch(e) { console.warn('workflow_store 테이블 생성 오류:', e.message); }

// ── 시안/파일 다운로드 기록(append-only 로그) — 새 저장데이터는 SQLite 전용(JSON 미사용). ──
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_file_downloads (
      seq      INTEGER PRIMARY KEY AUTOINCREMENT,
      fileId   TEXT NOT NULL,
      jobId    TEXT DEFAULT '',
      at       TEXT NOT NULL,
      byUserId TEXT DEFAULT '',
      byName   TEXT DEFAULT '',
      via      TEXT DEFAULT 'internal',
      note     TEXT DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_wf_downloads_file ON workflow_file_downloads(fileId);
    CREATE INDEX IF NOT EXISTS idx_wf_downloads_job ON workflow_file_downloads(jobId);
  `);
} catch(e) { console.warn('workflow_file_downloads 테이블 생성 오류:', e.message); }

// ── 자동로그인(remember-me) 토큰 — 서버 재시작에도 살아남는 영속 로그인. ──
// selector/validator 분리 패턴: 쿠키는 "selector.validator", DB엔 selector(PK)+validator의 sha256만 저장.
// → DB 유출돼도 원본 validator를 복원 못 함(replay 방지). 조회는 selector 인덱스, 비교는 상수시간.
try {
  db.exec(`
    CREATE TABLE IF NOT EXISTS remember_tokens (
      id            TEXT PRIMARY KEY,            -- selector (쿠키 앞부분, 비밀 아님)
      userId        TEXT NOT NULL,
      validatorHash TEXT NOT NULL,               -- sha256(validator)
      device        TEXT DEFAULT '',             -- user-agent 라벨(분실기기 식별용)
      createdAt     TEXT NOT NULL,
      lastUsedAt    TEXT NOT NULL,
      expiresAt     INTEGER NOT NULL             -- epoch ms
    );
    CREATE INDEX IF NOT EXISTS idx_remember_user ON remember_tokens(userId);
  `);
} catch(e) { console.warn('remember_tokens 테이블 생성 오류:', e.message); }

// ── 헬퍼 ─────────────────────────────────────────────

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// JSON 필드 파싱 (DB에서 꺼낼 때)
function parseJsonFields(row, fields) {
  if (!row) return row;
  const out = { ...row };
  for (const f of fields) {
    if (typeof out[f] === 'string') {
      try { out[f] = JSON.parse(out[f]); } catch { out[f] = []; }
    }
  }
  return out;
}

// JSON 필드 직렬화 (DB에 넣을 때)
function stringifyJsonFields(obj, fields) {
  const out = { ...obj };
  for (const f of fields) {
    if (out[f] !== undefined && typeof out[f] !== 'string') {
      out[f] = JSON.stringify(out[f]);
    }
  }
  return out;
}

// ── Categories (품목) ────────────────────────────────

const CAT_JSON = ['tiers', 'widthTiers', 'purchaseSpecs', 'variants'];

const categories = {
  getAll() {
    return db.prepare('SELECT * FROM categories ORDER BY code').all()
      .map(r => parseJsonFields(r, CAT_JSON));
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM categories WHERE id = ?').get(id);
    return parseJsonFields(row, CAT_JSON);
  },

  create(cat) {
    const id = cat.id || generateId('cat');
    const data = stringifyJsonFields({ id, ...cat }, CAT_JSON);
    db.prepare(`
      INSERT INTO categories (id, name, code, pricingType, unit, tiers, widthTiers, qtyPrice, fixedPrice, purchaseSpecs, variants)
      VALUES (@id, @name, @code, @pricingType, @unit, @tiers, @widthTiers, @qtyPrice, @fixedPrice, @purchaseSpecs, @variants)
    `).run({
      id, name: data.name || '', code: data.code || '',
      pricingType: data.pricingType || 'QTY', unit: data.unit || '개',
      tiers: data.tiers || '[]', widthTiers: data.widthTiers || '[]',
      qtyPrice: data.qtyPrice || 0, fixedPrice: data.fixedPrice || 0,
      purchaseSpecs: data.purchaseSpecs || '[]', variants: data.variants || '[]'
    });
    return this.getById(id);
  },

  update(id, changes) {
    const existing = this.getById(id);
    if (!existing) return null;
    const merged = { ...existing, ...changes, id, updatedAt: new Date().toISOString() };
    const data = stringifyJsonFields(merged, CAT_JSON);
    db.prepare(`
      UPDATE categories SET name=@name, code=@code, pricingType=@pricingType, unit=@unit,
        tiers=@tiers, widthTiers=@widthTiers, qtyPrice=@qtyPrice, fixedPrice=@fixedPrice,
        purchaseSpecs=@purchaseSpecs, variants=@variants, updatedAt=@updatedAt
      WHERE id=@id
    `).run(data);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM categories WHERE id = ?').run(id);
  }
};

// ── Options (옵션) ───────────────────────────────────

const OPT_JSON = ['categoryIds', 'variants', 'quotes'];

const options = {
  getAll() {
    return db.prepare('SELECT * FROM options ORDER BY code').all()
      .map(r => parseJsonFields(r, OPT_JSON));
  },

  getById(id) {
    const row = db.prepare('SELECT * FROM options WHERE id = ?').get(id);
    return parseJsonFields(row, OPT_JSON);
  },

  create(opt) {
    const id = opt.id || generateId('opt');
    const data = stringifyJsonFields({ id, ...opt }, OPT_JSON);
    db.prepare(`
      INSERT INTO options (id, code, name, price, unit, pricingType, categoryIds, variants, quotes)
      VALUES (@id, @code, @name, @price, @unit, @pricingType, @categoryIds, @variants, @quotes)
    `).run({
      id, code: data.code || '', name: data.name || '',
      price: data.price || 0, unit: data.unit || '개',
      pricingType: data.pricingType || 'fixed',
      categoryIds: data.categoryIds || '[]',
      variants: data.variants || '[]', quotes: data.quotes || '[]'
    });
    return this.getById(id);
  },

  update(id, changes) {
    const existing = this.getById(id);
    if (!existing) return null;
    const merged = { ...existing, ...changes, id };
    const data = stringifyJsonFields(merged, OPT_JSON);
    db.prepare(`
      UPDATE options SET code=@code, name=@name, price=@price, unit=@unit,
        pricingType=@pricingType, categoryIds=@categoryIds, variants=@variants, quotes=@quotes
      WHERE id=@id
    `).run(data);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM options WHERE id = ?').run(id);
  }
};

// ── Vendors (업체) ───────────────────────────────────

const vendors = {
  getAll() {
    return db.prepare('SELECT * FROM vendors ORDER BY name').all();
  },

  getById(id) {
    return db.prepare('SELECT * FROM vendors WHERE id = ?').get(id);
  },

  create(v) {
    const id = v.id || generateId('v');
    db.prepare(`
      INSERT INTO vendors (id, name, bizNo, ceo, phone, email, address, note,
        vendorType, mapSearchKeyword, contactPerson, contactPhone, pickupMemo, parkingAccessMemo, isActive)
      VALUES (@id, @name, @bizNo, @ceo, @phone, @email, @address, @note,
        @vendorType, @mapSearchKeyword, @contactPerson, @contactPhone, @pickupMemo, @parkingAccessMemo, @isActive)
    `).run({
      id, name: v.name||'', bizNo: v.bizNo||'', ceo: v.ceo||'', phone: v.phone||'',
      email: v.email||'', address: v.address||'', note: v.note||'',
      vendorType: v.vendorType||'기타', mapSearchKeyword: v.mapSearchKeyword||'',
      contactPerson: v.contactPerson||'', contactPhone: v.contactPhone||'',
      pickupMemo: v.pickupMemo||'', parkingAccessMemo: v.parkingAccessMemo||'',
      isActive: (v.isActive === undefined ? 1 : (v.isActive ? 1 : 0))
    });
    return this.getById(id);
  },

  update(id, changes) {
    const existing = this.getById(id);
    if (!existing) return null;
    const merged = { ...existing, ...changes, id };
    if (merged.isActive !== undefined) merged.isActive = merged.isActive ? 1 : 0;
    db.prepare(`
      UPDATE vendors SET name=@name, bizNo=@bizNo, ceo=@ceo, phone=@phone, email=@email,
        address=@address, note=@note, vendorType=@vendorType, mapSearchKeyword=@mapSearchKeyword,
        contactPerson=@contactPerson, contactPhone=@contactPhone, pickupMemo=@pickupMemo,
        parkingAccessMemo=@parkingAccessMemo, isActive=@isActive
      WHERE id=@id
    `).run(merged);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM vendors WHERE id = ?').run(id);
  }
};

// ── VendorPrices (업체별 단가) ───────────────────────

const VP_JSON = ['tiers', 'widthTiers'];

const vendorPrices = {
  getByVendor(vendorId) {
    return db.prepare('SELECT * FROM vendor_prices WHERE vendorId = ?').all(vendorId)
      .map(r => parseJsonFields(r, VP_JSON));
  },

  upsert(vp) {
    const id = vp.id || generateId('vp');
    const data = stringifyJsonFields({ id, ...vp }, VP_JSON);
    db.prepare(`
      INSERT INTO vendor_prices (id, vendorId, categoryId, tiers, widthTiers, qtyPrice, fixedPrice)
      VALUES (@id, @vendorId, @categoryId, @tiers, @widthTiers, @qtyPrice, @fixedPrice)
      ON CONFLICT(vendorId, categoryId) DO UPDATE SET
        tiers=excluded.tiers, widthTiers=excluded.widthTiers,
        qtyPrice=excluded.qtyPrice, fixedPrice=excluded.fixedPrice
    `).run({
      id, vendorId: data.vendorId, categoryId: data.categoryId,
      tiers: data.tiers||'[]', widthTiers: data.widthTiers||'[]',
      qtyPrice: data.qtyPrice||0, fixedPrice: data.fixedPrice||0
    });
  },

  delete(vendorId, categoryId) {
    return db.prepare('DELETE FROM vendor_prices WHERE vendorId=? AND categoryId=?').run(vendorId, categoryId);
  },

  copyDefaults(vendorId, categoriesData) {
    const insert = db.prepare(`
      INSERT OR IGNORE INTO vendor_prices (id, vendorId, categoryId, tiers, widthTiers, qtyPrice, fixedPrice)
      VALUES (@id, @vendorId, @categoryId, @tiers, @widthTiers, @qtyPrice, @fixedPrice)
    `);
    const tx = db.transaction(() => {
      for (const cat of categoriesData) {
        insert.run({
          id: generateId('vp'), vendorId, categoryId: cat.id,
          tiers: JSON.stringify(cat.tiers||[]), widthTiers: JSON.stringify(cat.widthTiers||[]),
          qtyPrice: cat.qtyPrice||0, fixedPrice: cat.fixedPrice||0
        });
      }
    });
    tx();
  }
};

// ── Pickup (픽업관리) ────────────────────────────────
const pickupRequests = {
  // 날짜별 취합 (요청 + 품목 + 업체 픽업정보)
  getByDate(pickupDate) {
    const reqs = db.prepare('SELECT * FROM pickup_requests WHERE pickupDate = ? ORDER BY requestedAt').all(pickupDate);
    return reqs.map(r => this._hydrate(r));
  },
  getMine(registrarId, pickupDate) {
    const reqs = db.prepare('SELECT * FROM pickup_requests WHERE registrarId = ? AND pickupDate = ? ORDER BY requestedAt DESC')
      .all(registrarId, pickupDate);
    return reqs.map(r => this._hydrate(r));
  },
  getById(id) {
    const r = db.prepare('SELECT * FROM pickup_requests WHERE id = ?').get(id);
    return r ? this._hydrate(r) : null;
  },
  _hydrate(r) {
    const items = db.prepare('SELECT * FROM pickup_items WHERE requestId = ? ORDER BY lineNo, id').all(r.id);
    const v = db.prepare('SELECT name, phone, address, mapSearchKeyword, contactPerson, contactPhone, pickupMemo, parkingAccessMemo FROM vendors WHERE id = ?').get(r.vendorId) || {};
    return { ...r, items, vendor: v };
  },
  // 생성: 요청 1건 + 품목 N개 (트랜잭션)
  create(reqData, items) {
    const id = reqData.id || generateId('pk');
    const create = db.transaction(() => {
      db.prepare(`
        INSERT INTO pickup_requests (id, registrarId, registrarName, pickupDate, vendorId, vendorName,
          preferredTimeSlot, priority, status, sourceType, sourceJobId, sourceRef, memo, isLate)
        VALUES (@id, @registrarId, @registrarName, @pickupDate, @vendorId, @vendorName,
          @preferredTimeSlot, @priority, @status, @sourceType, @sourceJobId, @sourceRef, @memo, @isLate)
      `).run({
        id,
        registrarId: reqData.registrarId, registrarName: reqData.registrarName || '',
        pickupDate: reqData.pickupDate, vendorId: reqData.vendorId || null, vendorName: reqData.vendorName || '',
        preferredTimeSlot: reqData.preferredTimeSlot || '', priority: reqData.priority || 'normal',
        status: 'requested', sourceType: reqData.sourceType || 'manual',
        sourceJobId: reqData.sourceJobId || null, sourceRef: reqData.sourceRef || null,
        memo: reqData.memo || '', isLate: reqData.isLate ? 1 : 0,
      });
      (items || []).forEach((it, i) => {
        db.prepare(`
          INSERT INTO pickup_items (id, requestId, lineNo, itemName, spec, site, qty, unit, status)
          VALUES (@id, @requestId, @lineNo, @itemName, @spec, @site, @qty, @unit, 'requested')
        `).run({
          id: generateId('pi'), requestId: id, lineNo: i,
          itemName: it.itemName || '', spec: it.spec || '', site: it.site || '', qty: Number(it.qty) || 0, unit: it.unit || '개',
        });
      });
    });
    create();
    return this.getById(id);
  },
  update(id, changes) {
    // 헤더 화이트리스트 + 자유 업체명/매칭(vendorName, vendorId[null 가능])
    const ALLOWED = ['pickupDate', 'preferredTimeSlot', 'priority', 'memo', 'vendorName', 'vendorId'];
    const hasItems = Array.isArray(changes.items);
    const tx = db.transaction(() => {
      const sets = ALLOWED.filter(k => changes[k] !== undefined);
      if (sets.length) {
        const sql = 'UPDATE pickup_requests SET ' + sets.map(k => `${k}=@${k}`).join(', ') + ", updatedAt=datetime('now') WHERE id=@id";
        const params = { id };
        sets.forEach(k => params[k] = (k === 'vendorId' ? (changes[k] || null) : changes[k]));
        db.prepare(sql).run(params);
      }
      if (hasItems) {
        // 기존 라인 전부 삭제 후 재삽입 (create의 삽입 로직과 동일, lineNo 재부여)
        db.prepare('DELETE FROM pickup_items WHERE requestId = ?').run(id);
        changes.items.forEach((it, i) => {
          db.prepare(`
            INSERT INTO pickup_items (id, requestId, lineNo, itemName, spec, site, qty, unit, status)
            VALUES (@id, @requestId, @lineNo, @itemName, @spec, @site, @qty, @unit, 'requested')
          `).run({
            id: generateId('pi'), requestId: id, lineNo: i,
            itemName: it.itemName || '', spec: it.spec || '', site: it.site || '', qty: Number(it.qty) || 0, unit: it.unit || '개',
          });
        });
        // 라인 교체 후 부모 요청 상태 재계산 (_recompute가 updatedAt도 갱신)
        this._recompute(id);
      }
      // 헤더·items 모두 안 바뀌어도 updatedAt 만큼은 갱신 (no-op 방어)
      if (!sets.length && !hasItems) {
        db.prepare("UPDATE pickup_requests SET updatedAt=datetime('now') WHERE id=@id").run({ id });
      }
    });
    tx();
    return this.getById(id);
  },
  cancel(id, by, reason) {
    // 멱등: 이미 취소된 요청이면 no-op (cancelledAt/By/Reason 덮어쓰기 방지, 수거기록 보존)
    const existing = db.prepare('SELECT status FROM pickup_requests WHERE id = ?').get(id);
    if (!existing) return null;
    if (existing.status === 'cancelled') return this.getById(id);
    db.prepare("UPDATE pickup_items SET status='cancelled' WHERE requestId=?").run(id);
    db.prepare("UPDATE pickup_requests SET status='cancelled', cancelledAt=datetime('now'), cancelledBy=@by, cancelReason=@reason, updatedAt=datetime('now') WHERE id=@id")
      .run({ id, by: by || '', reason: reason || '' });
    return this.getById(id);
  },
  delete(id) {
    return db.prepare('DELETE FROM pickup_requests WHERE id = ?').run(id); // CASCADE로 items 삭제
  },
  // 라인 상태 변경 → 부모 요청 상태 재계산
  setItemStatus(itemId, patch, checkedBy) {
    const item = db.prepare('SELECT * FROM pickup_items WHERE id = ?').get(itemId);
    if (!item) return null;
    // 보안: 부모 요청이 취소된 상태면 라인 상태 변경 차단 (취소된 요청의 라인을 되살리지 못하게)
    const parent = db.prepare('SELECT status FROM pickup_requests WHERE id = ?').get(item.requestId);
    if (parent && parent.status === 'cancelled') return this.getById(item.requestId);
    db.prepare(`UPDATE pickup_items SET status=@status, pickedQty=@pickedQty, failReason=@failReason,
        checkedAt=datetime('now'), checkedBy=@checkedBy WHERE id=@id`).run({
      id: itemId,
      status: patch.status || item.status,
      pickedQty: (patch.pickedQty === undefined ? item.pickedQty : Number(patch.pickedQty)),
      failReason: patch.failReason !== undefined ? patch.failReason : item.failReason,
      checkedBy: checkedBy || '',
    });
    this._recompute(item.requestId);
    return this.getById(item.requestId);
  },
  _recompute(requestId) {
    const items = db.prepare('SELECT status FROM pickup_items WHERE requestId = ?').all(requestId);
    const req = db.prepare('SELECT courseConfirmedAt FROM pickup_requests WHERE id = ?').get(requestId);
    const status = pickupLogic.computeRequestStatus(items, { courseConfirmed: !!(req && req.courseConfirmedAt) });
    db.prepare("UPDATE pickup_requests SET status=@status, updatedAt=datetime('now') WHERE id=@id").run({ id: requestId, status });
  },
};

// ── Quotes (견적서) ──────────────────────────────────

const QUOTE_JSON = ['mailHistory'];

const quotes = {
  getAll() {
    return db.prepare('SELECT * FROM quotes ORDER BY createdAt DESC').all()
      .map(r => parseJsonFields(r, QUOTE_JSON));
  },

  getById(id) {
    const q = db.prepare('SELECT * FROM quotes WHERE id = ?').get(id);
    if (!q) return null;
    const parsed = parseJsonFields(q, QUOTE_JSON);
    const rawItems = db.prepare('SELECT * FROM quote_items WHERE quoteId = ? ORDER BY sortOrder').all(id);
    parsed.items = rawItems.map(item => {
      let meta = {};
      try { meta = JSON.parse(item.meta || '{}'); } catch {}
      const { meta: _m, ...rest } = item;
      return { ...rest, ...meta };
    });
    return parsed;
  },

  create(q) {
    const id = q.id || generateId('q');
    const items = q.items || [];
    const data = stringifyJsonFields({ id, ...q }, QUOTE_JSON);

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO quotes (id, siteName, quoteName, manager, vendorManager, vendorId, vendorName, totalAmount, status, createdBy, mailHistory, createdAt)
        VALUES (@id, @siteName, @quoteName, @manager, @vendorManager, @vendorId, @vendorName, @totalAmount, @status, @createdBy, @mailHistory, @createdAt)
      `).run({
        id, siteName: data.siteName||'', quoteName: data.quoteName||'',
        manager: data.manager||'', vendorManager: data.vendorManager||'',
        vendorId: data.vendorId||'', vendorName: data.vendorName||'',
        totalAmount: data.totalAmount||0, status: data.status||'draft',
        createdBy: data.createdBy||'', mailHistory: data.mailHistory||'[]',
        createdAt: data.createdAt || new Date().toISOString()
      });

      const insertItem = db.prepare(`
        INSERT INTO quote_items (id, quoteId, sortOrder, name, spec, unit, qty, unitPrice, amount, remark, meta)
        VALUES (@id, @quoteId, @sortOrder, @name, @spec, @unit, @qty, @unitPrice, @amount, @remark, @meta)
      `);
      items.forEach((item, i) => {
        const meta = JSON.stringify({
          categoryId: item.categoryId||'', categoryType: item.categoryType||'QTY',
          widthMm: item.widthMm||0, heightMm: item.heightMm||0,
          variantIdx: item.variantIdx !== undefined ? Number(item.variantIdx) : -1,
          manualPrice: item.manualPrice||false,
          selectedOptions: item.selectedOptions||[],
          optionQtys: item.optionQtys||{}, optionVariants: item.optionVariants||{},
          customName: item.customName||'', customSpec: item.customSpec||'',
          supplier: item.supplier||'', purchasePrice: item.purchasePrice||0,
          purchaseMemo: item.purchaseMemo||'', purchaseImage: item.purchaseImage||''
        });
        insertItem.run({
          id: item.id || generateId('qi'), quoteId: id, sortOrder: i,
          name: item.name||'', spec: item.spec||'', unit: item.unit||'',
          qty: item.qty||0, unitPrice: item.unitPrice||0,
          amount: item.amount||0, remark: item.remark||'', meta
        });
      });
    });
    tx();
    return this.getById(id);
  },

  update(id, changes) {
    const items = changes.items;
    const data = stringifyJsonFields({ ...changes, id, updatedAt: new Date().toISOString() }, QUOTE_JSON);

    const tx = db.transaction(() => {
      const updateSql = data.createdAt
        ? `UPDATE quotes SET siteName=@siteName, quoteName=@quoteName, manager=@manager,
            vendorManager=@vendorManager, vendorId=@vendorId, vendorName=@vendorName,
            totalAmount=@totalAmount, status=@status, updatedAt=@updatedAt, mailHistory=@mailHistory,
            createdAt=@createdAt
           WHERE id=@id`
        : `UPDATE quotes SET siteName=@siteName, quoteName=@quoteName, manager=@manager,
            vendorManager=@vendorManager, vendorId=@vendorId, vendorName=@vendorName,
            totalAmount=@totalAmount, status=@status, updatedAt=@updatedAt, mailHistory=@mailHistory
           WHERE id=@id`;
      db.prepare(updateSql).run({
        id, siteName: data.siteName||'', quoteName: data.quoteName||'',
        manager: data.manager||'', vendorManager: data.vendorManager||'',
        vendorId: data.vendorId||'', vendorName: data.vendorName||'',
        totalAmount: data.totalAmount||0, status: data.status||'draft',
        updatedAt: data.updatedAt, mailHistory: data.mailHistory||'[]',
        ...(data.createdAt ? { createdAt: data.createdAt } : {})
      });

      if (items) {
        db.prepare('DELETE FROM quote_items WHERE quoteId = ?').run(id);
        const insertItem = db.prepare(`
          INSERT INTO quote_items (id, quoteId, sortOrder, name, spec, unit, qty, unitPrice, amount, remark, meta)
          VALUES (@id, @quoteId, @sortOrder, @name, @spec, @unit, @qty, @unitPrice, @amount, @remark, @meta)
        `);
        items.forEach((item, i) => {
          const meta = JSON.stringify({
            categoryId: item.categoryId||'', categoryType: item.categoryType||'QTY',
            widthMm: item.widthMm||0, heightMm: item.heightMm||0,
            variantIdx: item.variantIdx !== undefined ? Number(item.variantIdx) : -1,
            manualPrice: item.manualPrice||false,
            selectedOptions: item.selectedOptions||[],
            optionQtys: item.optionQtys||{}, optionVariants: item.optionVariants||{},
            customName: item.customName||'', customSpec: item.customSpec||'',
            supplier: item.supplier||'', purchasePrice: item.purchasePrice||0,
            purchaseMemo: item.purchaseMemo||'', purchaseImage: item.purchaseImage||''
          });
          insertItem.run({
            id: item.id || generateId('qi'), quoteId: id, sortOrder: i,
            name: item.name||'', spec: item.spec||'', unit: item.unit||'',
            qty: item.qty||0, unitPrice: item.unitPrice||0,
            amount: item.amount||0, remark: item.remark||'', meta
          });
        });
      }
    });
    tx();
    return this.getById(id);
  },

  updateStatus(id, status) {
    db.prepare('UPDATE quotes SET status=?, updatedAt=? WHERE id=?')
      .run(status, new Date().toISOString(), id);
    return this.getById(id);
  },

  delete(id) {
    return db.prepare('DELETE FROM quotes WHERE id = ?').run(id);
  },

  duplicate(id) {
    const orig = this.getById(id);
    if (!orig) return null;
    const newId = generateId('q');
    const items = (orig.items || []).map(item => ({ ...item, id: generateId('qi') }));
    return this.create({ ...orig, id: newId, items, status: 'draft', createdAt: undefined, updatedAt: undefined, mailHistory: [] });
  }
};

// ── Workflow events (워크플로 이력) — 섀도 이관 ───────
// routes/workflow.js의 addEvent가 만드는 event 객체와 1:1. meta=객체, readBy=[{userId,name,at}] 배열(원본 그대로 보존).
// 공유 parseJsonFields는 폴백이 일괄 []라 meta(객체)에 부적합 → 전용 파서로 meta는 {}, readBy는 [] 폴백.
function parseEventRow(row) {
  if (!row) return row;
  const out = { ...row };
  try { out.meta = typeof out.meta === 'string' ? JSON.parse(out.meta) : (out.meta || {}); } catch { out.meta = {}; }
  if (!out.meta || typeof out.meta !== 'object' || Array.isArray(out.meta)) out.meta = {};
  try { out.readBy = typeof out.readBy === 'string' ? JSON.parse(out.readBy) : out.readBy; } catch { out.readBy = []; }
  if (!Array.isArray(out.readBy)) out.readBy = [];
  delete out.seq; // 내부 정렬키 — 원본 event 형태 유지 위해 응답에서 제외
  return out;
}
function evtParams(evt) {
  return {
    id: String(evt.id || ''), jobId: String(evt.jobId || ''),
    type: evt.type || '', message: evt.message || '',
    meta: JSON.stringify(evt.meta || {}),
    targetUserId: evt.targetUserId || '', targetUserName: evt.targetUserName || '', targetLabel: evt.targetLabel || '',
    readBy: JSON.stringify(Array.isArray(evt.readBy) ? evt.readBy : []),
    actorId: evt.actorId || '', actorName: evt.actorName || '',
    createdAt: evt.createdAt || '',
  };
}
const events = {
  getAll() {
    return db.prepare('SELECT * FROM workflow_events ORDER BY seq ASC').all().map(parseEventRow);
  },
  getByJob(jobId) {
    return db.prepare('SELECT * FROM workflow_events WHERE jobId = ? ORDER BY seq ASC').all(String(jobId || '')).map(parseEventRow);
  },
  append(evt) {
    if (!evt || !evt.id || !evt.jobId) return false;
    db.prepare(`INSERT OR IGNORE INTO workflow_events
      (id, jobId, type, message, meta, targetUserId, targetUserName, targetLabel, readBy, actorId, actorName, createdAt)
      VALUES (@id, @jobId, @type, @message, @meta, @targetUserId, @targetUserName, @targetLabel, @readBy, @actorId, @actorName, @createdAt)`).run(evtParams(evt));
    return true;
  },
  appendMany(list) {
    const arr = Array.isArray(list) ? list : [];
    db.transaction((items) => { for (const e of items) events.append(e); })(arr);
    return arr.length;
  },
  updateReadBy(id, readByArr) {
    db.prepare('UPDATE workflow_events SET readBy=@readBy WHERE id=@id')
      .run({ id: String(id || ''), readBy: JSON.stringify(Array.isArray(readByArr) ? readByArr : []) });
    return true;
  },
  deleteByJob(jobId) {
    return db.prepare('DELETE FROM workflow_events WHERE jobId = ?').run(String(jobId || ''));
  },
  count() {
    return db.prepare('SELECT COUNT(*) AS n FROM workflow_events').get().n;
  },
  allIds() {
    return new Set(db.prepare('SELECT id FROM workflow_events').all().map(r => r.id));
  },
};

// ── 워크플로 스토어 blob CRUD (jobs/files/orders/projects 공통 팩토리) ───
// 소비코드는 배열 객체를 그대로 받으므로 blob(전체 JSON)으로 보관·복원. 손상 blob은 {} 폴백(유실 아님, reconcile이 JSON서 재수렴).
function makeBlobStore(table) {
  function parseRow(row) { if (!row) return row; try { const o = JSON.parse(row.blob); return (o && typeof o === 'object') ? o : {}; } catch { return {}; } }
  const upsertStmt = `INSERT INTO ${table} (id, jobId, blob) VALUES (@id, @jobId, @blob) ON CONFLICT(id) DO UPDATE SET jobId=@jobId, blob=@blob`;
  return {
    getAll() { return db.prepare(`SELECT blob FROM ${table} ORDER BY seq ASC`).all().map(parseRow); },
    getByJob(jobId) { return db.prepare(`SELECT blob FROM ${table} WHERE jobId = ? ORDER BY seq ASC`).all(String(jobId || '')).map(parseRow); },
    upsert(id, jobId, obj) {
      if (!id) return false;
      db.prepare(upsertStmt).run({ id: String(id), jobId: String(jobId || ''), blob: JSON.stringify(obj) });
      return true;
    },
    // rows: [{id, jobId, obj}] — 전체배열 upsert + 현재 id집합에 없는 SQL row 삭제(orphan). in-place 변경·삭제를 1번에 동기화.
    syncAll(rows) {
      const list = Array.isArray(rows) ? rows.filter(r => r && r.id) : [];
      const self = this;
      db.transaction(() => {
        for (const r of list) self.upsert(r.id, r.jobId, r.obj);
        const ids = list.map(r => String(r.id));
        // json_each로 orphan 삭제(파라미터 1개 → IN 999개 한계 회피, 배열 어떤 크기도 안전)
        db.prepare(`DELETE FROM ${table} WHERE id NOT IN (SELECT value FROM json_each(?))`).run(JSON.stringify(ids));
      })();
      return list.length;
    },
    count() { return db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n; },
    allIds() { return new Set(db.prepare(`SELECT id FROM ${table}`).all().map(r => r.id)); },
  };
}
const jobs = makeBlobStore('workflow_jobs');
const files = makeBlobStore('workflow_files');
const orders = makeBlobStore('workflow_orders');
const projects = makeBlobStore('workflow_projects');

// ── 닫기 (서버 종료 시) ─────────────────────────────

// 시안/파일 다운로드 기록 — append-only. 표시는 byFile/stats로 집계(외부=공장, 내부=직원).
const downloads = {
  log(row) {
    return db.prepare(`INSERT INTO workflow_file_downloads (fileId, jobId, at, byUserId, byName, via, note)
      VALUES (@fileId, @jobId, @at, @byUserId, @byName, @via, @note)`).run({
      fileId: String((row && row.fileId) || ''),
      jobId: String((row && row.jobId) || ''),
      at: String((row && row.at) || ''),
      byUserId: String((row && row.byUserId) || ''),
      byName: String((row && row.byName) || ''),
      via: String((row && row.via) || 'internal'),
      note: String((row && row.note) || ''),
    });
  },
  byFile(fileId) {
    return db.prepare('SELECT fileId, jobId, at, byUserId, byName, via, note FROM workflow_file_downloads WHERE fileId = ? ORDER BY seq DESC').all(String(fileId || ''));
  },
  statsByFile(fileId) {
    const c = db.prepare('SELECT COUNT(*) AS n FROM workflow_file_downloads WHERE fileId = ?').get(String(fileId || ''));
    const last = db.prepare('SELECT at, byName, via FROM workflow_file_downloads WHERE fileId = ? ORDER BY seq DESC LIMIT 1').get(String(fileId || ''));
    return { count: (c && c.n) || 0, lastAt: (last && last.at) || '', lastBy: (last && last.byName) || '', lastVia: (last && last.via) || '' };
  },
  statsByJob(jobId) {
    const rows = db.prepare('SELECT fileId, at, byName, via FROM workflow_file_downloads WHERE jobId = ? ORDER BY seq DESC').all(String(jobId || ''));
    const out = {};
    for (const r of rows) {
      if (!out[r.fileId]) out[r.fileId] = { count: 0, lastAt: r.at, lastBy: r.byName, lastVia: r.via };
      out[r.fileId].count++;
    }
    return out;
  },
};

// ── 자동로그인 토큰 CRUD ─────────────────────────────
const rememberTokens = {
  issue(row) {
    return db.prepare(`INSERT INTO remember_tokens (id, userId, validatorHash, device, createdAt, lastUsedAt, expiresAt)
      VALUES (@id, @userId, @validatorHash, @device, @createdAt, @lastUsedAt, @expiresAt)`).run({
      id: String(row.id),
      userId: String(row.userId),
      validatorHash: String(row.validatorHash),
      device: String((row.device || '')).slice(0, 200),
      createdAt: String(row.createdAt),
      lastUsedAt: String(row.lastUsedAt),
      expiresAt: Number(row.expiresAt) || 0,
    });
  },
  get(id) {
    return db.prepare('SELECT * FROM remember_tokens WHERE id = ?').get(String(id || ''));
  },
  touch(id, iso) {
    return db.prepare('UPDATE remember_tokens SET lastUsedAt = ? WHERE id = ?').run(String(iso || ''), String(id || ''));
  },
  revoke(id) {
    return db.prepare('DELETE FROM remember_tokens WHERE id = ?').run(String(id || ''));
  },
  revokeUser(userId) {
    return db.prepare('DELETE FROM remember_tokens WHERE userId = ?').run(String(userId || ''));
  },
  listByUser(userId) {
    return db.prepare('SELECT id, device, createdAt, lastUsedAt, expiresAt FROM remember_tokens WHERE userId = ? ORDER BY lastUsedAt DESC').all(String(userId || ''));
  },
  purgeExpired() {
    return db.prepare('DELETE FROM remember_tokens WHERE expiresAt < ?').run(Date.now());
  },
};

function close() {
  db.close();
}

module.exports = {
  db: db,
  generateId,
  categories,
  options,
  vendors,
  vendorPrices,
  pickupRequests,
  quotes,
  events,
  jobs,
  files,
  orders,
  projects,
  downloads,
  rememberTokens,
  close
};
