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
`);

// ── 기존 DB 마이그레이션: quote_items.meta 컬럼 없으면 추가 ──
try {
  const cols = db.prepare("PRAGMA table_info(quote_items)").all();
  if (!cols.find(c => c.name === 'meta')) {
    db.prepare("ALTER TABLE quote_items ADD COLUMN meta TEXT DEFAULT '{}'").run();
  }
} catch(e) { console.warn('quote_items meta 마이그레이션 오류:', e.message); }

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
      INSERT INTO vendors (id, name, bizNo, ceo, phone, email, address, note)
      VALUES (@id, @name, @bizNo, @ceo, @phone, @email, @address, @note)
    `).run({ id, name: v.name||'', bizNo: v.bizNo||'', ceo: v.ceo||'', phone: v.phone||'', email: v.email||'', address: v.address||'', note: v.note||'' });
    return this.getById(id);
  },

  update(id, changes) {
    const existing = this.getById(id);
    if (!existing) return null;
    const merged = { ...existing, ...changes, id };
    db.prepare(`
      UPDATE vendors SET name=@name, bizNo=@bizNo, ceo=@ceo, phone=@phone, email=@email, address=@address, note=@note
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
  quotes,
  events,
  jobs,
  files,
  orders,
  projects,
  close
};
