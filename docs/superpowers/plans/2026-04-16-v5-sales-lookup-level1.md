# v5 과거단가조회 (레벨 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 직원이 거래처 + 품명으로 과거 매출 데이터를 검색해서 과거 단가를 확인할 수 있는 조회 화면을 만든다.

**Architecture:** `대림컴퍼니 통합매출.xlsx` → 1회성 적재 스크립트(exceljs) → SQLite `sales_history` 테이블 → Express 검색 API → Alpine.js 조회 화면(tab-sales-lookup.html). 기존 코드는 건드리지 않고, 새 파일만 추가.

**Tech Stack:** Node.js, Express, better-sqlite3, exceljs, Alpine.js, Tailwind CSS

**Spec:** `docs/superpowers/specs/2026-04-16-v5-sales-history-search-design.md`

---

## File Map

### 새로 생성
| File | 역할 |
|---|---|
| `db-sales-history.js` | sales_history 테이블 생성 + CRUD 함수 |
| `scripts/ingest-sales.js` | 엑셀 → DB 적재 스크립트 |
| `routes/salesHistory.js` | 검색 API (`GET /api/sales-history/search`) |
| `public/tab-sales-lookup.html` | 조회 화면 (Alpine.js) |

### 수정
| File | 변경 내용 |
|---|---|
| `server.js` | 라우트 마운트 1줄 추가 |
| `public/index.html` | menuGroups에 탭 1개 + INCLUDE 1줄 + currentTab 분기 1개 추가 |

---

## Task 1: sales_history 테이블 모듈

**Files:**
- Create: `db-sales-history.js`

- [ ] **Step 1: `db-sales-history.js` 파일 생성**

```js
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
// area: 면적 기반 (포맥스, 현수막, 철판, 후렉스, 스티커, 고무자석)
// none: 개당 단가 (pe간판, A형간판, 3D, 서비스 등)
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

// ── INSERT (적재용) ──
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
    // 접두어 매칭: base_name이 키워드로 시작하거나 product_name에 포함
    sql += ` AND (base_name LIKE @kwPrefix OR product_name LIKE @kwContains)`;
    params.kwPrefix = `${keyword}%`;
    params.kwContains = `%${keyword}%`;
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

// ── 적재 전 초기화 ──
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
```

- [ ] **Step 2: 동작 확인**

Run: `cd price-list-app && node -e "const sh = require('./db-sales-history'); console.log('table ready, count:', sh.getCount())"`

Expected: `table ready, count: 0`

- [ ] **Step 3: Commit**

```bash
git add db-sales-history.js
git commit -m "feat: add sales_history table module"
```

---

## Task 2: 엑셀 적재 스크립트

**Files:**
- Create: `scripts/ingest-sales.js`

- [ ] **Step 1: `scripts/ingest-sales.js` 파일 생성**

```js
/**
 * scripts/ingest-sales.js — 대림컴퍼니 통합매출.xlsx → sales_history DB
 *
 * 사용법: node scripts/ingest-sales.js [엑셀파일경로]
 * 기본값: ../대림컴퍼니 통합매출.xlsx
 */
const path = require('path');
const ExcelJS = require('exceljs');
const salesHistory = require('../db-sales-history');

const DEFAULT_FILE = path.join(__dirname, '..', '..', '대림컴퍼니 통합매출.xlsx');
const filePath = process.argv[2] || DEFAULT_FILE;

// ── 노이즈 필터 ──
const NOISE_KEYWORDS = [
  '전표합계', '운반비', '배송비', '택배', '퀵',
  '외상매출금', '입금', '출금', '지급',
  '설치비', '인건비'
];

function isNoise(name) {
  if (!name) return true;
  const n = name.trim();
  if (!n) return true;
  for (const kw of NOISE_KEYWORDS) {
    if (n.includes(kw)) return true;
  }
  return false;
}

// ── 품명 파싱 ──
function parseName(name) {
  const n = (name || '').trim();
  const tokens = n.split('+').map(t => t.trim()).filter(Boolean);
  const baseName = tokens[0] || n;
  const addons = tokens.slice(1);

  // 두께 추출: 숫자t or 숫자T (예: 3t, 5T, 10t)
  const thicknessMatch = n.match(/(\d+(?:\.\d+)?)[tT]/);
  const thickness_mm = thicknessMatch ? parseFloat(thicknessMatch[1]) : null;

  return { baseName, addons, thickness_mm };
}

// ── 규격 파싱 ──
function parseSpec(spec) {
  if (!spec) return { width: null, height: null, depth: null };
  const s = String(spec).trim();
  const parts = s.split('*').map(p => parseFloat(p)).filter(p => !isNaN(p));
  if (parts.length === 2) return { width: parts[0], height: parts[1], depth: null };
  if (parts.length >= 3) return { width: parts[0], height: parts[1], depth: parts[2] };
  return { width: null, height: null, depth: null };
}

// ── 날짜 포매팅 ──
function formatDate(val) {
  if (!val) return null;
  if (val instanceof Date) {
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  return String(val).slice(0, 10);
}

// ── 메인 ──
async function main() {
  console.log(`\n📂 파일: ${filePath}`);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.readFile(filePath);
  const ws = workbook.worksheets[0];

  console.log(`📊 시트: ${ws.name} (${ws.rowCount}행)`);

  // 기존 데이터 초기화
  salesHistory.clearAll();
  console.log('🗑️  기존 데이터 초기화 완료');

  const rows = [];
  let skippedNoise = 0;
  let skippedNoVendor = 0;
  let skippedZeroPrice = 0;
  const sourceFile = path.basename(filePath);

  ws.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return; // 헤더 스킵

    const date = row.getCell(1).value;
    const vendor = row.getCell(2).value;
    const name = row.getCell(3).value;
    const spec = row.getCell(4).value;
    const qty = row.getCell(6).value;
    const unitPrice = row.getCell(7).value;
    const buyAmount = row.getCell(8).value;
    const sellAmount = row.getCell(9).value;
    const project = row.getCell(10).value;
    const deliveryTo = row.getCell(11).value;

    // 필터링
    const nameStr = name ? String(name).trim() : '';
    if (isNoise(nameStr)) { skippedNoise++; return; }
    if (!vendor) { skippedNoVendor++; return; }
    const price = Number(unitPrice) || 0;
    if (price === 0) { skippedZeroPrice++; return; }

    // 파싱
    const { baseName, addons, thickness_mm } = parseName(nameStr);
    const { width, height, depth } = parseSpec(spec);
    const specStr = spec ? String(spec).trim() : null;
    const areaPriceType = salesHistory.classifyAreaPriceType(nameStr, specStr);

    // 날짜 처리: date가 null이면 직전 행의 날짜 사용
    const dateStr = formatDate(date);

    rows.push({
      vendor: String(vendor).trim(),
      sale_date: dateStr || '1970-01-01',
      product_name: nameStr,
      raw_spec: specStr,
      qty: Number(qty) || 0,
      unit_price: price,
      amount: Number(sellAmount) || Number(buyAmount) || 0,
      project: project ? String(project).trim() : null,
      delivery_to: deliveryTo ? String(deliveryTo).trim() : null,
      base_name: baseName,
      addons: JSON.stringify(addons),
      thickness_mm,
      width_mm: width ? Math.round(width) : null,
      height_mm: height ? Math.round(height) : null,
      depth_mm: depth ? Math.round(depth) : null,
      area_price_type: areaPriceType,
      source_file: sourceFile,
      source_row: rowNumber
    });
  });

  // 날짜 누락 행 보정 (직전 행 날짜 상속)
  let lastDate = '1970-01-01';
  for (const r of rows) {
    if (r.sale_date && r.sale_date !== '1970-01-01') {
      lastDate = r.sale_date;
    } else {
      r.sale_date = lastDate;
    }
  }

  // 일괄 삽입
  salesHistory.insertMany(rows);

  // 결과 리포트
  const count = salesHistory.getCount();
  const vendors = salesHistory.getVendors();

  console.log(`\n✅ 적재 완료!`);
  console.log(`   총 적재: ${count}행`);
  console.log(`   노이즈 제외: ${skippedNoise}행`);
  console.log(`   거래처 없음 제외: ${skippedNoVendor}행`);
  console.log(`   단가 0 제외: ${skippedZeroPrice}행`);
  console.log(`\n📋 거래처별 행 수:`);
  for (const v of vendors) {
    console.log(`   ${v.cnt.toString().padStart(6)}  ${v.vendor}`);
  }

  // 면적단가 분류 통계
  const areaCount = salesHistory.db.prepare(
    `SELECT area_price_type, COUNT(*) as cnt FROM sales_history GROUP BY area_price_type`
  ).all();
  console.log(`\n📐 면적단가 분류:`);
  for (const a of areaCount) {
    console.log(`   ${a.area_price_type}: ${a.cnt}행`);
  }

  // 상위 10개 품명 샘플
  const topProducts = salesHistory.db.prepare(
    `SELECT product_name, COUNT(*) as cnt FROM sales_history GROUP BY product_name ORDER BY cnt DESC LIMIT 10`
  ).all();
  console.log(`\n🏷️  상위 10 품명:`);
  for (const p of topProducts) {
    console.log(`   ${p.cnt.toString().padStart(5)}  ${p.product_name}`);
  }

  console.log(`\n🎉 Done!`);
}

main().catch(err => {
  console.error('❌ 오류:', err.message);
  process.exit(1);
});
```

- [ ] **Step 2: scripts 디렉토리 생성 확인**

Run: `mkdir -p scripts`

- [ ] **Step 3: 적재 실행 및 검증**

Run: `cd price-list-app && node scripts/ingest-sales.js`

Expected output:
- `✅ 적재 완료!`
- 총 적재 약 19,000~21,000행 (노이즈 제외 후)
- 거래처 15곳 리스트
- 면적단가 분류 area/none 통계
- 상위 10 품명

**검증:** 적재 수가 15,000 미만이면 노이즈 필터가 너무 공격적인 것 → NOISE_KEYWORDS 확인.

- [ ] **Step 4: Commit**

```bash
git add scripts/ingest-sales.js
git commit -m "feat: add sales data ingest script"
```

---

## Task 3: 검색 API

**Files:**
- Create: `routes/salesHistory.js`

- [ ] **Step 1: `routes/salesHistory.js` 파일 생성**

```js
/**
 * routes/salesHistory.js — 과거 매출 데이터 검색 API
 */
const express = require('express');
const router = express.Router();
const salesHistory = require('../db-sales-history');

/**
 * GET /api/sales-history/search?vendor=라코스&keyword=3t포맥스&limit=20
 *
 * 검색 순서:
 * 1. 같은 거래처 + 접두어 매칭
 * 2. 다른 거래처 + 접두어 매칭 (참고용)
 */
router.get('/search', (req, res) => {
  try {
    const { vendor, keyword, limit } = req.query;
    const lim = Math.min(parseInt(limit) || 20, 100);

    // 1단계: 같은 거래처 결과
    const vendorResults = salesHistory.search({
      vendor: vendor || null,
      keyword: keyword || null,
      limit: lim
    });

    // 2단계: 다른 거래처 결과 (vendor가 지정된 경우에만)
    let otherResults = [];
    if (vendor && keyword) {
      const allResults = salesHistory.search({
        vendor: null,
        keyword: keyword,
        limit: lim
      });
      // 같은 거래처 결과에서 이미 나온 id 제외, 다른 거래처만
      const vendorIds = new Set(vendorResults.map(r => r.id));
      otherResults = allResults.filter(r => {
        if (vendorIds.has(r.id)) return false;
        // 검색한 거래처와 다른 거래처만
        if (vendor && r.vendor.includes(vendor)) return false;
        return true;
      }).slice(0, 10);
    }

    // ㎡당 단가 계산 추가
    function addAreaPrice(row) {
      let pricePerSqm = null;
      if (row.area_price_type === 'area' && row.width_mm && row.height_mm && row.unit_price > 0) {
        const areaSqm = (row.width_mm * row.height_mm) / 1000000;
        if (areaSqm > 0) {
          pricePerSqm = Math.round(row.unit_price / areaSqm);
        }
      }
      return { ...row, price_per_sqm: pricePerSqm };
    }

    res.json({
      vendor_results: vendorResults.map(addAreaPrice),
      other_results: otherResults.map(addAreaPrice),
      total_vendor: vendorResults.length,
      total_other: otherResults.length
    });
  } catch (err) {
    console.error('sales-history search error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sales-history/vendors — 거래처 목록
 */
router.get('/vendors', (req, res) => {
  try {
    const vendors = salesHistory.getVendors();
    res.json(vendors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sales-history/stats — 적재 현황
 */
router.get('/stats', (req, res) => {
  try {
    const count = salesHistory.getCount();
    const vendors = salesHistory.getVendors();
    res.json({ total: count, vendors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
```

- [ ] **Step 2: `server.js`에 라우트 마운트 추가**

`server.js`에서 다른 라우트 마운트 줄들 근처 (예: `app.use('/api', require('./routes/quotes'));` 줄 이후)에 추가:

```js
app.use('/api/sales-history', require('./routes/salesHistory'));
```

- [ ] **Step 3: API 동작 확인**

서버 재시작 후:

Run: `curl "http://localhost:3000/api/sales-history/stats"`
Expected: `{"total":19000+,"vendors":[...]}`

Run: `curl "http://localhost:3000/api/sales-history/search?vendor=라코스&keyword=3t포맥스"`
Expected: `vendor_results` 배열에 과거 거래들, `price_per_sqm` 필드 포함

Run: `curl "http://localhost:3000/api/sales-history/vendors"`
Expected: 15개 거래처 목록

- [ ] **Step 4: Commit**

```bash
git add routes/salesHistory.js server.js
git commit -m "feat: add sales history search API"
```

---

## Task 4: 조회 화면

**Files:**
- Create: `public/tab-sales-lookup.html`

- [ ] **Step 1: `public/tab-sales-lookup.html` 파일 생성**

```html
<!-- ═══════════════════════════════════════════════════
     과거단가조회 (v5 레벨 1)
     ═══════════════════════════════════════════════════ -->
<div x-show="currentTab === 'salesLookup'" x-cloak
     x-data="salesLookupApp()"
     x-init="loadVendors()"
     class="p-6 max-w-5xl mx-auto">

  <div class="mb-6">
    <h2 class="text-lg font-bold text-gray-800 mb-1">과거단가조회</h2>
    <p class="text-xs text-gray-400">과거 매출 데이터에서 거래처별 단가를 검색합니다</p>
  </div>

  <!-- 검색 영역 -->
  <div class="bg-white rounded-xl border border-gray-200 p-4 mb-5 shadow-sm">
    <div class="flex flex-wrap gap-3 items-end">
      <!-- 거래처 검색 -->
      <div class="flex-1 min-w-[200px] relative">
        <label class="block text-xs font-medium text-gray-500 mb-1">거래처</label>
        <input type="text" x-model="vendorQuery" @input="filterVendors()"
          @focus="showVendorDropdown = true"
          @keydown.escape="showVendorDropdown = false"
          placeholder="거래처명 입력 (예: 라코스)"
          class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
        <!-- 거래처 드롭다운 -->
        <div x-show="showVendorDropdown && filteredVendors.length > 0"
          @click.away="showVendorDropdown = false"
          class="absolute z-50 w-full mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-48 overflow-y-auto">
          <template x-for="v in filteredVendors" :key="v.vendor">
            <button @click="selectVendor(v.vendor)"
              class="w-full text-left px-3 py-2 text-sm hover:bg-blue-50 flex justify-between items-center">
              <span x-text="v.vendor"></span>
              <span class="text-xs text-gray-400" x-text="v.cnt + '건'"></span>
            </button>
          </template>
        </div>
      </div>
      <!-- 품명 검색 -->
      <div class="flex-1 min-w-[200px]">
        <label class="block text-xs font-medium text-gray-500 mb-1">품명</label>
        <input type="text" x-model="keyword"
          @keydown.enter="doSearch()"
          placeholder="품명 입력 (예: 3t포맥스)"
          class="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500">
      </div>
      <!-- 검색 버튼 -->
      <div>
        <button @click="doSearch()"
          class="px-5 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors flex items-center gap-1.5">
          <span class="material-symbols-outlined" style="font-size:16px;">search</span>
          검색
        </button>
      </div>
    </div>
    <!-- 선택된 거래처 태그 -->
    <div x-show="selectedVendor" class="mt-2 flex items-center gap-2">
      <span class="inline-flex items-center gap-1 px-2.5 py-1 bg-blue-100 text-blue-700 text-xs font-medium rounded-full">
        <span x-text="selectedVendor"></span>
        <button @click="clearVendor()" class="hover:text-blue-900">&times;</button>
      </span>
    </div>
  </div>

  <!-- 로딩 -->
  <div x-show="loading" class="text-center py-8 text-gray-400">
    <span class="material-symbols-outlined animate-spin" style="font-size:24px;">progress_activity</span>
    <p class="mt-2 text-sm">검색 중...</p>
  </div>

  <!-- 결과 없음 -->
  <div x-show="!loading && searched && vendorResults.length === 0 && otherResults.length === 0"
    class="text-center py-12 text-gray-400">
    <span class="material-symbols-outlined" style="font-size:40px;">search_off</span>
    <p class="mt-2 text-sm">검색 결과가 없습니다</p>
  </div>

  <!-- 거래처 결과 -->
  <div x-show="!loading && vendorResults.length > 0" class="mb-5">
    <h3 class="text-sm font-bold text-gray-700 mb-2 flex items-center gap-1.5">
      <span class="material-symbols-outlined" style="font-size:16px;color:#3b82f6;">storefront</span>
      <span x-text="selectedVendor || '전체'"></span>
      과거 거래
      <span class="text-xs font-normal text-gray-400" x-text="'(' + vendorResults.length + '건)'"></span>
    </h3>
    <div class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b border-gray-200">
          <tr>
            <th class="text-left px-3 py-2 text-xs font-semibold text-gray-500">날짜</th>
            <th class="text-left px-3 py-2 text-xs font-semibold text-gray-500">품명</th>
            <th class="text-left px-3 py-2 text-xs font-semibold text-gray-500">규격</th>
            <th class="text-right px-3 py-2 text-xs font-semibold text-gray-500">수량</th>
            <th class="text-right px-3 py-2 text-xs font-semibold text-gray-500">단가</th>
            <th class="text-right px-3 py-2 text-xs font-semibold text-gray-500">㎡당</th>
          </tr>
        </thead>
        <tbody>
          <template x-for="row in vendorResults" :key="row.id">
            <tr class="border-b border-gray-100 hover:bg-blue-50/30">
              <td class="px-3 py-2 text-xs text-gray-500 whitespace-nowrap" x-text="row.sale_date"></td>
              <td class="px-3 py-2">
                <span class="text-sm font-medium text-gray-800" x-text="row.product_name"></span>
              </td>
              <td class="px-3 py-2 text-xs text-gray-500" x-text="row.raw_spec || '-'"></td>
              <td class="px-3 py-2 text-right text-xs text-gray-500" x-text="(row.qty || 0).toLocaleString()"></td>
              <td class="px-3 py-2 text-right font-semibold text-gray-800" x-text="row.unit_price.toLocaleString() + '원'"></td>
              <td class="px-3 py-2 text-right text-xs"
                :class="row.price_per_sqm ? 'text-blue-600 font-medium' : 'text-gray-300'">
                <span x-text="row.price_per_sqm ? row.price_per_sqm.toLocaleString() + '원/㎡' : '-'"></span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>

  <!-- 다른 거래처 참고 (접힘) -->
  <div x-show="!loading && otherResults.length > 0">
    <button @click="showOthers = !showOthers"
      class="text-sm text-gray-500 hover:text-gray-700 flex items-center gap-1 mb-2">
      <span class="material-symbols-outlined transition-transform" style="font-size:16px;"
        :style="showOthers ? '' : 'transform:rotate(-90deg)'">expand_more</span>
      다른 거래처 참고
      <span class="text-xs text-gray-400" x-text="'(' + otherResults.length + '건)'"></span>
    </button>
    <div x-show="showOthers" x-collapse class="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden opacity-75">
      <table class="w-full text-sm">
        <thead class="bg-gray-50 border-b border-gray-200">
          <tr>
            <th class="text-left px-3 py-2 text-xs font-semibold text-gray-500">거래처</th>
            <th class="text-left px-3 py-2 text-xs font-semibold text-gray-500">날짜</th>
            <th class="text-left px-3 py-2 text-xs font-semibold text-gray-500">품명</th>
            <th class="text-left px-3 py-2 text-xs font-semibold text-gray-500">규격</th>
            <th class="text-right px-3 py-2 text-xs font-semibold text-gray-500">단가</th>
            <th class="text-right px-3 py-2 text-xs font-semibold text-gray-500">㎡당</th>
          </tr>
        </thead>
        <tbody>
          <template x-for="row in otherResults" :key="row.id">
            <tr class="border-b border-gray-100 hover:bg-gray-50/50">
              <td class="px-3 py-2 text-xs text-gray-500 whitespace-nowrap" x-text="row.vendor"></td>
              <td class="px-3 py-2 text-xs text-gray-400" x-text="row.sale_date"></td>
              <td class="px-3 py-2 text-sm text-gray-600" x-text="row.product_name"></td>
              <td class="px-3 py-2 text-xs text-gray-400" x-text="row.raw_spec || '-'"></td>
              <td class="px-3 py-2 text-right text-sm text-gray-700" x-text="row.unit_price.toLocaleString() + '원'"></td>
              <td class="px-3 py-2 text-right text-xs"
                :class="row.price_per_sqm ? 'text-blue-500' : 'text-gray-300'">
                <span x-text="row.price_per_sqm ? row.price_per_sqm.toLocaleString() + '원/㎡' : '-'"></span>
              </td>
            </tr>
          </template>
        </tbody>
      </table>
    </div>
  </div>

  <!-- 적재 현황 (하단) -->
  <div x-show="!loading && stats" class="mt-8 text-center">
    <p class="text-xs text-gray-300">
      데이터: <span x-text="stats.total?.toLocaleString()"></span>건
      (<span x-text="stats.vendors?.length"></span>개 거래처)
    </p>
  </div>
</div>

<script>
function salesLookupApp() {
  return {
    // 검색
    vendorQuery: '',
    keyword: '',
    selectedVendor: '',
    showVendorDropdown: false,

    // 결과
    vendorResults: [],
    otherResults: [],
    showOthers: false,
    loading: false,
    searched: false,
    stats: null,

    // 거래처 목록
    allVendors: [],
    filteredVendors: [],

    async loadVendors() {
      try {
        const res = await fetch('/api/sales-history/vendors');
        this.allVendors = await res.json();
        this.filteredVendors = this.allVendors;
        // 적재 현황
        const statsRes = await fetch('/api/sales-history/stats');
        this.stats = await statsRes.json();
      } catch (e) {
        console.error('vendor load error:', e);
      }
    },

    filterVendors() {
      const q = this.vendorQuery.toLowerCase();
      this.filteredVendors = this.allVendors.filter(v =>
        v.vendor.toLowerCase().includes(q)
      );
      this.showVendorDropdown = true;
      this.selectedVendor = '';
    },

    selectVendor(vendor) {
      this.selectedVendor = vendor;
      this.vendorQuery = vendor;
      this.showVendorDropdown = false;
    },

    clearVendor() {
      this.selectedVendor = '';
      this.vendorQuery = '';
    },

    async doSearch() {
      if (!this.vendorQuery && !this.keyword) return;
      this.loading = true;
      this.searched = true;
      this.showOthers = false;
      try {
        const params = new URLSearchParams();
        if (this.selectedVendor) params.set('vendor', this.selectedVendor);
        else if (this.vendorQuery) params.set('vendor', this.vendorQuery);
        if (this.keyword) params.set('keyword', this.keyword);
        params.set('limit', '30');

        const res = await fetch('/api/sales-history/search?' + params);
        const data = await res.json();
        this.vendorResults = data.vendor_results || [];
        this.otherResults = data.other_results || [];
      } catch (e) {
        console.error('search error:', e);
      }
      this.loading = false;
    }
  };
}
</script>
```

- [ ] **Step 2: Commit**

```bash
git add public/tab-sales-lookup.html
git commit -m "feat: add sales lookup UI tab"
```

---

## Task 5: 네비게이션 연결

**Files:**
- Modify: `public/index.html`

- [ ] **Step 1: menuGroups에 과거단가조회 탭 추가**

`public/index.html`에서 menuGroups 배열의 `'업무'` 그룹을 찾아서 items에 추가:

기존:
```js
{ group: '업무', icon: 'work', items: [
  { id: 'quote', label: '견적 작성', icon: 'edit_note' },
  { id: 'history', label: '견적 목록', icon: 'folder_open' },
  { id: 'stats', label: '통계', icon: 'bar_chart' },
]},
```

변경 (salesLookup 항목 추가):
```js
{ group: '업무', icon: 'work', items: [
  { id: 'quote', label: '견적 작성', icon: 'edit_note' },
  { id: 'history', label: '견적 목록', icon: 'folder_open' },
  { id: 'salesLookup', label: '과거단가조회', icon: 'manage_search' },
  { id: 'stats', label: '통계', icon: 'bar_chart' },
]},
```

- [ ] **Step 2: tabs 배열에도 추가 (admin 권한)**

`public/index.html`에서 admin의 tabs 리턴 배열에 추가:

기존 (admin tabs):
```js
{ id: 'stats', label: '통계' }, { id: 'design', label: '시안 검색' },
```

변경:
```js
{ id: 'salesLookup', label: '과거단가조회' }, { id: 'stats', label: '통계' }, { id: 'design', label: '시안 검색' },
```

- [ ] **Step 3: INCLUDE 태그 추가**

`public/index.html`에서 다른 `<!--INCLUDE:-->` 태그들이 있는 영역 (탭 콘텐츠 영역) 에 추가:

```html
<!--INCLUDE:tab-sales-lookup.html-->
```

기존 INCLUDE 패턴 위치를 확인해서 동일한 위치에 추가.

- [ ] **Step 4: 일반 사용자도 접근 가능하도록 기본 권한에 추가**

`public/index.html`의 `defaultMenus` 배열을 찾아서:

기존:
```js
const defaultMenus = ['quote', 'history'];
```

변경:
```js
const defaultMenus = ['quote', 'history', 'salesLookup'];
```

- [ ] **Step 5: Commit**

```bash
git add public/index.html
git commit -m "feat: add salesLookup tab to navigation"
```

---

## Task 6: 통합 테스트

- [ ] **Step 1: 서버 재시작**

```bash
cd price-list-app && node server.js
```

- [ ] **Step 2: API 검증**

```bash
# 적재 현황
curl http://localhost:3000/api/sales-history/stats

# 거래처 목록
curl http://localhost:3000/api/sales-history/vendors

# 검색 테스트 1: 라코스 + 3t포맥스
curl "http://localhost:3000/api/sales-history/search?vendor=라코스&keyword=3t포맥스"

# 검색 테스트 2: 대림에스엠 + 스티커
curl "http://localhost:3000/api/sales-history/search?vendor=에스엠&keyword=스티커"

# 검색 테스트 3: 거래처만 (품명 없이)
curl "http://localhost:3000/api/sales-history/search?vendor=디자인포트"

# 검색 테스트 4: 품명만 (거래처 없이)
curl "http://localhost:3000/api/sales-history/search?keyword=현수막"
```

각 응답에서 확인:
- `vendor_results` 배열에 데이터 있음
- `price_per_sqm` 필드가 면적 품목에만 숫자 (나머지는 null)
- `other_results`에 다른 거래처 참고 데이터 있음

- [ ] **Step 3: 브라우저 검증**

`http://localhost:3000` 접속 → 좌측 메뉴 "업무" 그룹 → "과거단가조회" 클릭

확인 사항:
1. 페이지가 뜨는지
2. 거래처 검색창에 `라코` 입력 → 드롭다운에 라코스 표시
3. 라코스 선택 → 품명에 `3t포맥스` → 검색
4. 결과 테이블에 날짜/품명/규격/수량/단가/㎡당 표시
5. ㎡당 컬럼: 면적 품목(포맥스)은 파란색 숫자, 아닌 것은 `-`
6. "다른 거래처 참고" 접기/펼치기 동작
7. 하단 데이터 건수 표시

- [ ] **Step 4: 면적단가 분류 확인**

브라우저에서 다음 검색 수행 후 ㎡당 컬럼 확인:
- `스티커` → ㎡당 표시 있어야 함 (area)
- `고무자석` → ㎡당 표시 있어야 함 (area)
- `pe간판` → ㎡당 표시 없어야 함 (none)
- `A형간판` → ㎡당 표시 없어야 함 (none)

분류 오류 있으면 `db-sales-history.js`의 `classifyAreaPriceType()` 함수에서 키워드 수정.

- [ ] **Step 5: 최종 Commit**

```bash
git add -A
git commit -m "feat: v5 Level 1 — sales history lookup complete"
```

---

## 완료 기준 체크리스트

- [ ] 엑셀 23,016행 중 노이즈 제외하고 DB 적재됨
- [ ] 거래처 + 품명 검색 → 과거 거래 결과 나옴
- [ ] ㎡당 단가가 면적 품목에만 파란색으로 표시
- [ ] pe간판, A형간판 등은 ㎡당 표시 안 됨
- [ ] 다른 거래처 참고가 접힌 상태로 나옴
- [ ] 앱 메뉴 "과거단가조회" 탭 접근 가능
- [ ] 일반 사용자도 접근 가능 (defaultMenus에 포함)
