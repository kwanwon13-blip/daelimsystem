// db-statements.js — 명세서 (매입/매출) DB 모듈
// 받은 명세서를 AI 로 추출 → 검토 → 누적 저장 → 검색 / 통계

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', 'statements.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS statements (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,

  -- 메타
  source_file     TEXT,                       -- 원본 파일명 (스캔 사진/PDF)
  stored_file     TEXT,                       -- 디스크 저장 파일
  uploaded_by     TEXT,                       -- 업로드한 사번
  uploaded_at     TEXT DEFAULT (datetime('now', 'localtime')),

  -- AI 추출 결과 (JSON)
  raw_extract     TEXT,                       -- AI 가 뽑은 raw JSON

  -- 정규화된 메타
  doc_type        TEXT,                       -- '세금계산서' / '거래명세서' / '영수증' / 'PPTX시안' 등 (서류 타입)
  doc_class       TEXT,                       -- '매입' / '매출' (4분할 라우팅 핵심)
  company_code    TEXT,                       -- 'SM' (대림에스엠) / 'COMPANY' (대림컴퍼니) / NULL
  target_erp      TEXT,                       -- 'ECOUNT' / 'E2E' (회사 → ERP 자동매핑)
  doc_date        TEXT,                       -- 일자 (YYYY-MM-DD)
  vendor_name     TEXT,                       -- 거래처명 (raw)
  vendor_biz_no   TEXT,                       -- 사업자번호
  norm_vendor     TEXT,                       -- 정규화된 거래처

  -- 금액
  supply_amount   INTEGER,                    -- 공급가액
  vat_amount      INTEGER,                    -- 부가세
  total_amount    INTEGER,                    -- 합계

  -- 상태
  status          TEXT DEFAULT 'pending',     -- 'pending' (검토전) / 'confirmed' (확정) / 'rejected' (반려)
  confirmed_by    TEXT,
  confirmed_at    TEXT,
  notes           TEXT,                       -- 검토 메모

  -- 인덱스용
  month_key       TEXT                        -- '2026-04' 형식 (월별 조회)
);

CREATE INDEX IF NOT EXISTS idx_st_doc_date ON statements(doc_date);
CREATE INDEX IF NOT EXISTS idx_st_vendor ON statements(norm_vendor);
CREATE INDEX IF NOT EXISTS idx_st_status ON statements(status);
CREATE INDEX IF NOT EXISTS idx_st_month ON statements(month_key);
CREATE INDEX IF NOT EXISTS idx_st_doctype ON statements(doc_type);
CREATE INDEX IF NOT EXISTS idx_st_class ON statements(doc_class);
CREATE INDEX IF NOT EXISTS idx_st_company ON statements(company_code);

-- 명세서 라인 아이템 (품목별)
CREATE TABLE IF NOT EXISTS statement_items (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  statement_id    INTEGER NOT NULL,
  line_no         INTEGER,
  item_name       TEXT,
  spec            TEXT,                       -- 규격
  quantity        REAL,
  unit            TEXT,                       -- 단위 (개, EA, kg 등)
  unit_price      INTEGER,
  amount          INTEGER,                    -- 공급가액
  vat             INTEGER,                    -- 부가세
  notes           TEXT,
  FOREIGN KEY (statement_id) REFERENCES statements(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_st_items_st ON statement_items(statement_id);
CREATE INDEX IF NOT EXISTS idx_st_items_item ON statement_items(item_name);
`);

// 기존 DB(이전 버전)에 새 컬럼 자동 추가 (upgrade)
function _safeAddCol(table, col, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  } catch (e) {
    if (!/duplicate column/i.test(e.message)) throw e;
  }
}
_safeAddCol('statements', 'doc_class', 'TEXT');
_safeAddCol('statements', 'company_code', 'TEXT');
_safeAddCol('statements', 'target_erp', 'TEXT');

// 회사 → ERP 매핑
const COMPANY_ERP = { SM: 'ECOUNT', COMPANY: 'E2E' };
function inferTargetErp(companyCode) {
  return COMPANY_ERP[companyCode] || null;
}

// ========== 헬퍼 ==========

const stmts = {
  insert: db.prepare(`
    INSERT INTO statements (
      source_file, stored_file, uploaded_by,
      raw_extract, doc_type, doc_class, company_code, target_erp,
      doc_date, vendor_name, vendor_biz_no, norm_vendor,
      supply_amount, vat_amount, total_amount,
      status, month_key, notes
    ) VALUES (
      @source_file, @stored_file, @uploaded_by,
      @raw_extract, @doc_type, @doc_class, @company_code, @target_erp,
      @doc_date, @vendor_name, @vendor_biz_no, @norm_vendor,
      @supply_amount, @vat_amount, @total_amount,
      @status, @month_key, @notes
    )
  `),
  insertItem: db.prepare(`
    INSERT INTO statement_items (
      statement_id, line_no, item_name, spec, quantity, unit, unit_price, amount, vat, notes
    ) VALUES (
      @statement_id, @line_no, @item_name, @spec, @quantity, @unit, @unit_price, @amount, @vat, @notes
    )
  `),
  byId: db.prepare('SELECT * FROM statements WHERE id = ?'),
  itemsByStId: db.prepare('SELECT * FROM statement_items WHERE statement_id = ? ORDER BY line_no'),
  delItems: db.prepare('DELETE FROM statement_items WHERE statement_id = ?'),
  delStmt: db.prepare('DELETE FROM statements WHERE id = ?'),
  update: db.prepare(`
    UPDATE statements SET
      doc_type = @doc_type,
      doc_class = @doc_class,
      company_code = @company_code,
      target_erp = @target_erp,
      doc_date = @doc_date,
      vendor_name = @vendor_name,
      vendor_biz_no = @vendor_biz_no,
      norm_vendor = @norm_vendor,
      supply_amount = @supply_amount,
      vat_amount = @vat_amount,
      total_amount = @total_amount,
      month_key = @month_key,
      notes = @notes
    WHERE id = @id
  `),
  setStatus: db.prepare(`
    UPDATE statements SET status = @status, confirmed_by = @confirmed_by, confirmed_at = datetime('now', 'localtime')
    WHERE id = @id
  `),
};

function createStatement(row, items = []) {
  const tx = db.transaction(() => {
    const r = stmts.insert.run({
      source_file: row.source_file || null,
      stored_file: row.stored_file || null,
      uploaded_by: row.uploaded_by || null,
      raw_extract: row.raw_extract || null,
      doc_type: row.doc_type || null,
      doc_class: row.doc_class || null,
      company_code: row.company_code || null,
      target_erp: row.target_erp || inferTargetErp(row.company_code),
      doc_date: row.doc_date || null,
      vendor_name: row.vendor_name || null,
      vendor_biz_no: row.vendor_biz_no || null,
      norm_vendor: row.norm_vendor || row.vendor_name || null,
      supply_amount: row.supply_amount || null,
      vat_amount: row.vat_amount || null,
      total_amount: row.total_amount || null,
      status: row.status || 'pending',
      month_key: row.month_key || (row.doc_date ? row.doc_date.slice(0, 7) : null),
      notes: row.notes || null,
    });
    const stId = r.lastInsertRowid;
    for (let i = 0; i < items.length; i++) {
      const it = items[i] || {};
      stmts.insertItem.run({
        statement_id: stId,
        line_no: i + 1,
        item_name: it.item_name || it.name || null,
        spec: it.spec || it.규격 || null,
        quantity: it.quantity || it.수량 || null,
        unit: it.unit || it.단위 || null,
        unit_price: it.unit_price || it.단가 || null,
        amount: it.amount || it.금액 || null,
        vat: it.vat || it.부가세 || null,
        notes: it.notes || null,
      });
    }
    return stId;
  });
  return tx();
}

function getById(id) {
  const st = stmts.byId.get(id);
  if (!st) return null;
  st.items = stmts.itemsByStId.all(id);
  return st;
}

function listStatements({
  status = null,
  month = null,
  vendor = null,
  docType = null,
  docClass = null,
  companyCode = null,
  q = '',
  limit = 100,
  offset = 0,
} = {}) {
  const where = [];
  const params = {};
  if (status) { where.push('status = @status'); params.status = status; }
  if (month) { where.push('month_key = @month'); params.month = month; }
  if (vendor) { where.push('norm_vendor LIKE @vendor'); params.vendor = `%${vendor}%`; }
  if (docType) { where.push('doc_type = @docType'); params.docType = docType; }
  if (docClass) { where.push('doc_class = @docClass'); params.docClass = docClass; }
  if (companyCode) { where.push('company_code = @companyCode'); params.companyCode = companyCode; }
  if (q) {
    where.push(`(vendor_name LIKE @q OR norm_vendor LIKE @q OR notes LIKE @q OR raw_extract LIKE @q)`);
    params.q = `%${q}%`;
  }
  const lim = Math.max(1, Math.min(parseInt(limit, 10) || 100, 500));
  const off = Math.max(0, parseInt(offset, 10) || 0);
  const sql = `
    SELECT * FROM statements
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY doc_date DESC, id DESC
    LIMIT ${lim} OFFSET ${off}
  `;
  const stmt = db.prepare(sql);
  return Object.keys(params).length ? stmt.all(params) : stmt.all();
}

function countStatements(opts = {}) {
  const where = [];
  const params = {};
  if (opts.status) { where.push('status = @status'); params.status = opts.status; }
  if (opts.month) { where.push('month_key = @month'); params.month = opts.month; }
  if (opts.vendor) { where.push('norm_vendor LIKE @vendor'); params.vendor = `%${opts.vendor}%`; }
  if (opts.docType) { where.push('doc_type = @docType'); params.docType = opts.docType; }
  if (opts.docClass) { where.push('doc_class = @docClass'); params.docClass = opts.docClass; }
  if (opts.companyCode) { where.push('company_code = @companyCode'); params.companyCode = opts.companyCode; }
  if (opts.q) { where.push(`(vendor_name LIKE @q OR norm_vendor LIKE @q OR notes LIKE @q)`); params.q = `%${opts.q}%`; }
  const sql = `SELECT COUNT(*) as n FROM statements ${where.length ? 'WHERE ' + where.join(' AND ') : ''}`;
  const stmt = db.prepare(sql);
  return (Object.keys(params).length ? stmt.get(params) : stmt.get()).n;
}

function getStats() {
  return {
    total: db.prepare('SELECT COUNT(*) as n FROM statements').get().n,
    pending: db.prepare(`SELECT COUNT(*) as n FROM statements WHERE status = 'pending'`).get().n,
    confirmed: db.prepare(`SELECT COUNT(*) as n FROM statements WHERE status = 'confirmed'`).get().n,
    byMonth: db.prepare(
      `SELECT month_key as month, COUNT(*) as n, SUM(supply_amount) as supply, SUM(vat_amount) as vat, SUM(total_amount) as total
       FROM statements WHERE status = 'confirmed' AND month_key IS NOT NULL
       GROUP BY month_key ORDER BY month_key DESC LIMIT 24`
    ).all(),
    topVendors: db.prepare(
      `SELECT norm_vendor as name, COUNT(*) as n, SUM(supply_amount) as supply, SUM(total_amount) as total
       FROM statements WHERE status = 'confirmed' AND norm_vendor IS NOT NULL
       GROUP BY norm_vendor ORDER BY supply DESC LIMIT 50`
    ).all(),
    // 4분할 통계 (회사 × 구분)
    byQuadrant: db.prepare(
      `SELECT
         COALESCE(company_code, '미분류') as company,
         COALESCE(doc_class, '미분류') as class,
         COUNT(*) as n,
         SUM(supply_amount) as supply,
         SUM(total_amount) as total
       FROM statements
       GROUP BY company_code, doc_class
       ORDER BY company, class`
    ).all(),
    pendingByQuadrant: db.prepare(
      `SELECT
         COALESCE(company_code, '미분류') as company,
         COALESCE(doc_class, '미분류') as class,
         COUNT(*) as n
       FROM statements WHERE status = 'pending'
       GROUP BY company_code, doc_class`
    ).all(),
  };
}

function updateStatement(id, fields, items) {
  const cur = stmts.byId.get(id);
  if (!cur) return null;
  const merged = {
    ...cur,
    ...fields,
    id,
    month_key: fields.doc_date ? fields.doc_date.slice(0, 7) : cur.month_key,
    // company_code 가 변경되면 target_erp 자동 재계산
    target_erp: fields.target_erp
      || (fields.company_code ? inferTargetErp(fields.company_code) : cur.target_erp),
  };
  const tx = db.transaction(() => {
    stmts.update.run(merged);
    if (Array.isArray(items)) {
      stmts.delItems.run(id);
      for (let i = 0; i < items.length; i++) {
        const it = items[i] || {};
        stmts.insertItem.run({
          statement_id: id,
          line_no: i + 1,
          item_name: it.item_name || null,
          spec: it.spec || null,
          quantity: it.quantity || null,
          unit: it.unit || null,
          unit_price: it.unit_price || null,
          amount: it.amount || null,
          vat: it.vat || null,
          notes: it.notes || null,
        });
      }
    }
  });
  tx();
  return getById(id);
}

function setStatus(id, status, confirmedBy) {
  stmts.setStatus.run({ id, status, confirmed_by: confirmedBy || null });
  return getById(id);
}

function deleteStatement(id) {
  const tx = db.transaction(() => {
    stmts.delItems.run(id);
    stmts.delStmt.run(id);
  });
  tx();
}

module.exports = {
  db,
  createStatement,
  getById,
  listStatements,
  countStatements,
  getStats,
  updateStatement,
  setStatus,
  deleteStatement,
};
