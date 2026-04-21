/**
 * db-sales-history.js — 과거 매출 데이터 (검색용)
 */
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', '업무데이터.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

// ── 테이블 생성 ──
db.exec(`
  CREATE TABLE IF NOT EXISTS sales_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    vendor TEXT NOT NULL,
    sale_date TEXT NOT NULL,
    product_name TEXT NOT NULL,
    raw_spec TEXT,
    qty INTEGER,
    unit_price INTEGER NOT NULL,
    amount INTEGER NOT NULL,
    project TEXT,
    delivery_to TEXT,
    base_name TEXT,
    addons TEXT,
    thickness_mm REAL,
    width_mm INTEGER,
    height_mm INTEGER,
    depth_mm INTEGER,
    area_price_type TEXT DEFAULT 'none',
    source_file TEXT,
    source_row INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_sh_vendor_product ON sales_history(vendor, product_name);
  CREATE INDEX IF NOT EXISTS idx_sh_vendor_base ON sales_history(vendor, base_name);
  CREATE INDEX IF NOT EXISTS idx_sh_date ON sales_history(sale_date DESC);
`);

// ── 면적당 단가 표시 품목 판정 ──
function classifyAreaPriceType(productName, spec) {
  const name = (productName || '').toLowerCase();
  // 개당 단가 품목 (우선 체크)
  const perUnitKeywords = ['pe간판', 'a형', 'a형간판', '워킹배너'];
  for (const kw of perUnitKeywords) {
    if (name.includes(kw)) return 'none';
  }
  // 3D 규격 (가로x세로x높이) → 개당
  if (spec && spec.split('*').length >= 3) return 'none';
  // 면적 품목
  const areaKeywords = ['포맥스', '현수막', '철판', '후렉스', '스티커', '고무자석', '폼보드', '실사'];
  for (const kw of areaKeywords) {
    if (name.includes(kw)) return 'area';
  }
  return 'none';
}

// ── INSERT ──
const insertStmt = db.prepare(`
  INSERT INTO sales_history (
    vendor, sale_date, product_name, raw_spec, qty, unit_price, amount,
    project, delivery_to, base_name, addons, thickness_mm,
    width_mm, height_mm, depth_mm, area_price_type, source_file, source_row
  ) VALUES (
    @vendor, @sale_date, @product_name, @raw_spec, @qty, @unit_price, @amount,
    @project, @delivery_to, @base_name, @addons, @thickness_mm,
    @width_mm, @height_mm, @depth_mm, @area_price_type, @source_file, @source_row
  )
`);

function insertRow(row) {
  insertStmt.run(row);
}

function insertMany(rows) {
  const tx = db.transaction((rows) => {
    for (const row of rows) insertStmt.run(row);
  });
  tx(rows);
}

// ── 검색 ──
function search({ vendor, keyword, limit = 20 }) {
  let sql = `SELECT * FROM sales_history WHERE 1=1`;
  const params = {};

  if (vendor) {
    sql += ` AND vendor LIKE @vendor`;
    params.vendor = `%${vendor}%`;
  }

  if (keyword) {
    // 키워드 분리: 띄어쓰기로 분할, 각 키워드가 product_name+raw_spec에 모두 포함
    const keywords = keyword.trim().split(/\s+/).filter(k => k.length > 0);
    if (keywords.length === 1) {
      // 단일 키워드: 기존 로직 유지 (base_name prefix OR product_name contains)
      sql += ` AND (base_name LIKE @kwPrefix OR product_name LIKE @kwContains OR raw_spec LIKE @kwContains)`;
      params.kwPrefix = `${keywords[0]}%`;
      params.kwContains = `%${keywords[0]}%`;
    } else {
      // 복수 키워드: 각각이 (product_name || ' ' || COALESCE(raw_spec,''))에 포함
      keywords.forEach((kw, i) => {
        const paramName = `kw${i}`;
        sql += ` AND (LOWER(product_name) || ' ' || LOWER(COALESCE(raw_spec,''))) LIKE @${paramName}`;
        params[paramName] = `%${kw.toLowerCase()}%`;
      });
    }
  }

  sql += ` ORDER BY sale_date DESC LIMIT @limit`;
  params.limit = limit;

  return db.prepare(sql).all(params);
}

// ── 거래처 목록 ──
function getVendors() {
  return db.prepare(`
    SELECT vendor, COUNT(*) as cnt
    FROM sales_history
    GROUP BY vendor
    ORDER BY cnt DESC
  `).all();
}

// ── 초기화 / 통계 ──
function clearAll() {
  db.exec(`DELETE FROM sales_history`);
}

function getCount() {
  return db.prepare(`SELECT COUNT(*) as cnt FROM sales_history`).get().cnt;
}

module.exports = {
  insertRow,
  insertMany,
  search,
  getVendors,
  clearAll,
  getCount,
  classifyAreaPriceType,
  db
};
