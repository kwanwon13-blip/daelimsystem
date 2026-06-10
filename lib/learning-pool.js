/**
 * lib/learning-pool.js — 4분할 학습 데이터 풀
 *
 * 서버 시작 시 learning-data/ 폴더의 정답 엑셀들을 메모리 캐시로 로드.
 * AI 프롬프트에 거래처/품목/프로젝트 마스터를 컨텍스트로 주입해서
 * 명세서 자동분류 정확도를 큰 폭으로 끌어올림.
 *
 * 사용:
 *   const pool = require('./lib/learning-pool');
 *   await pool.load();  // 서버 시작 시 1회
 *   const ctx = pool.getContext('SM', '매입');  // AI 프롬프트용 컨텍스트
 *   const item = pool.findItem('SM', '안전화');  // 품목 검색
 */
const path = require('path');
const fs = require('fs');

const LEARNING_DIR = path.join(__dirname, '..', 'learning-data');

// 메모리 캐시 (4분할별)
const pool = {
  loaded: false,
  loadedAt: null,
  ready: false,
  files: [],
  errors: [],
  // 4분할별 데이터
  SM_매입: { vendors: new Map(), items: new Map(), codes: new Map(), rows: 0 },
  SM_매출: { vendors: new Map(), items: new Map(), codes: new Map(), projects: new Map(), rows: 0 },
  COMPANY_매입: {
    vendors: new Map(), items: new Map(), rows: 0,
    byDate: new Map(),         // YYYY-MM-DD → [실제 등록행]
    byVendor: new Map(),       // 거래처(원본) → [실제 등록행]
    byVendorAlias: new Map(),  // 정규화 거래처키 → [실제 등록행] (이노텍+이노사인 통합)
    byItem: new Map(),         // 품명(정규화) → [실제 등록행]
    bySpec: new Map(),         // 규격(정규화) → [실제 등록행]
  },
  COMPANY_매출: {
    vendors: new Map(), items: new Map(), combos: new Map(), rows: 0,
    byDate: new Map(),       // YYYY-MM-DD → [실제 등록행 배열]
    byVendor: new Map(),     // 거래처 → [실제 등록행]
    bySpec: new Map(),       // 규격 → [실제 등록행]
  },
  // ── 품목코드 마스터 (9,950건) — E2E 표준 품목 코드 + 단가 ──
  PRODUCT_MASTER: {
    rows: 0,
    byCode: new Map(),       // 품목코드 → row
    byNameSpec: new Map(),   // norm(상품명)|norm(규격) → row
    byNameOnly: new Map(),   // norm(상품명) → [rows] (규격 다양)
    byCategory: new Map(),   // 대분류/소분류 → [rows]
  },
  // ── 정규화 룰 (그룹요약 33개) — "3T포맥스" → "3t포맥스" ──
  NORMALIZE_RULES: new Map(),  // 변형표기(소문자공백제거) → 대표표기
  // ── 신규등록규칙 (13개) — 검증/안내 ──
  NEW_RULES: [],
  // ── 옵션 마스터 (53개) — "+사방타공" 등 ──
  OPTION_MASTER: [],
  // ── 자주쓰는 프리셋 (33개) — "3t포맥스+사방타공+양면테이프" 같은 조합 ──
  PRESETS: [],
};

function newQuadrants() {
  return {
    SM_매입: { vendors: new Map(), items: new Map(), codes: new Map(), rows: 0 },
    SM_매출: { vendors: new Map(), items: new Map(), codes: new Map(), projects: new Map(), rows: 0 },
    PRODUCT_MASTER: {
      rows: 0,
      byCode: new Map(),
      byNameSpec: new Map(),
      byNameOnly: new Map(),
      byCategory: new Map(),
    },
    NORMALIZE_RULES: new Map(),
    NEW_RULES: [],
    OPTION_MASTER: [],
    PRESETS: [],
    COMPANY_매입: {
      vendors: new Map(), items: new Map(), rows: 0,
      byDate: new Map(),
      byVendor: new Map(),
      byVendorAlias: new Map(),
      byItem: new Map(),
      bySpec: new Map(),
    },
    COMPANY_매출: {
      vendors: new Map(), items: new Map(), combos: new Map(), rows: 0,
      byDate: new Map(),
      byVendor: new Map(),
      bySpec: new Map(),
    },
  };
}

function resetPoolData() {
  const fresh = newQuadrants();
  Object.assign(pool.SM_매입, fresh.SM_매입);
  Object.assign(pool.SM_매출, fresh.SM_매출);
  Object.assign(pool.COMPANY_매입, fresh.COMPANY_매입);
  Object.assign(pool.COMPANY_매출, fresh.COMPANY_매출);
  Object.assign(pool.PRODUCT_MASTER, fresh.PRODUCT_MASTER);
  pool.NORMALIZE_RULES = fresh.NORMALIZE_RULES;
  pool.NEW_RULES = fresh.NEW_RULES;
  pool.OPTION_MASTER = fresh.OPTION_MASTER;
  pool.PRESETS = fresh.PRESETS;
  pool.files = [];
  pool.errors = [];
  pool.ready = false;
}

function trackFile(label, fp, required = true) {
  const exists = fs.existsSync(fp);
  const size = exists ? fs.statSync(fp).size : 0;
  pool.files.push({ label, path: fp, exists, size, required });
  if (required && !exists) pool.errors.push(`${label} 정답 엑셀 없음: ${fp}`);
  return exists;
}

// Map 누적 헬퍼
const inc = (m, k, val = 1) => {
  if (!k) return;
  const cur = m.get(k) || { count: 0, ...val };
  cur.count = (cur.count || 0) + 1;
  if (typeof val === 'object') Object.assign(cur, val, { count: cur.count });
  m.set(k, cur);
};

// 정규화 (검색용)
function norm(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\s+/g, '').replace(/[()/\-]/g, '');
}

function normalizeSpec(s) {
  if (!s) return '';
  return String(s)
    .toLowerCase()
    .replace(/[×xX]/g, '*')
    .replace(/[㎜ｍmM]/g, '')
    .replace(/\s+/g, '')
    .replace(/[()]/g, '');
}

function toIsoDate(v) {
  if (!v) return '';
  if (v instanceof Date && !isNaN(v)) return v.toISOString().slice(0, 10);
  if (typeof v === 'number' && isFinite(v)) {
    // Excel serial date (1900 date system)
    const d = new Date(Math.round((v - 25569) * 86400 * 1000));
    return isNaN(d) ? '' : d.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  return '';
}

// 품명 카테고리 정규화 (통일성 매칭 — 사장님 코드정리 도움)
// "A형 단면" / "A형간판" / "A형간판 양면" → 모두 "a형" 카테고리로
function itemCategory(name) {
  const n = String(name || '').toLowerCase().replace(/\s+/g, '');
  // A형 류 (단면/양면/간판 통일)
  if (/^a형|a형간판|a형단면|a형양면/.test(n)) return 'a형';
  // 포맥스 류 (3t/5t/모든 두께 통일)
  if (/포맥스/.test(n)) return '포맥스';
  // 스티커 류
  if (/^스티커|^원형스티커|^덧방스티커|^투명스티커|^배면스티커/.test(n)) return '스티커';
  // 현수막 류
  if (/현수막/.test(n)) return '현수막';
  // pe간판 류
  if (/^pe간판|^pe소형|^pe단면/.test(n)) return 'pe간판';
  // 후렉스 류
  if (/^후렉스|^아일렛후렉스/.test(n)) return '후렉스';
  // 자석 류
  if (/자석/.test(n)) return '자석';
  // 철판프레임 류 (용접물)
  if (/철판.*프레임|철판자립|철판프레임/.test(n)) return '철판프레임';
  // 프레임 류
  if (/\+프레임|프레임\+/.test(n)) return '프레임결합';
  return null;
}

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[×xX]/g, '*')
    .split(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ一-龥\u0E00-\u0E7F\u1000-\u109F]+/g)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !/^\d+$/.test(t));
}

// PPTX 파일명 → 작업 카테고리 (출력물 vs 용접물)
// "20251201.pptx" → 출력물, "20251201-1.pptx" → 용접물 (또는 다른 작업팀)
function categorizePptx(filename) {
  if (!filename) return null;
  const m = String(filename).match(/(\d{8})(?:[-_](\d+))?\.pptx/i);
  if (!m) return null;
  return m[2] ? '용접물' : '출력물';
}

// ─── 매입 거래처 정규화 (이노텍 ↔ 이노사인 등 통합) ─────────
// 같은 회사가 사업자번호만 둘로 운영 → 학습풀 매칭 시 통합 풀로 처리
function normalizeVendorKey(vendor) {
  if (!vendor) return '';
  // 회사 표기 제거 — 단어 단위 (한글 character class 사용 X, "사" 같은 한 글자가 본명에서 빠지면 안 됨)
  let v = String(vendor)
    .replace(/\s+/g, '')
    .replace(/㈜|\(주\)|\(유\)|주식회사|유한회사/g, '');
  // 이노텍 = 이노사인 (메모리: 매출액 분산 목적 사업자 둘)
  if (/이노텍|이노사인/.test(v)) return '이노사인';
  // DSD리테일 3가지 표기 통일
  if (/dsd리테일|디에스디리테일/i.test(v)) return 'DSD리테일';
  // 한울상사 / 한울 → 한울상사
  if (/한울/.test(v)) return '한울상사';
  return v;
}

// 학습 풀 행을 카테고리 분류 (품명 키워드 기반)
// 출력물 / 용접물 = 공장 제작 매출 (PPTX 시안 있음)
// 트레이딩 = 컴퍼니가 사서 에스엠에 넘겨주는 매입후매출 (PPTX 없음 — 매칭 제외)
//
// 우선순위: 용접물 (강력 키워드) → 트레이딩 → 출력물
function categorizeRow(item, spec = '') {
  const text = `${item || ''} ${spec || ''}`.toLowerCase().replace(/\s+/g, '');
  // 1) 용접물 키워드 (가장 강력 — "안전모걸이대" 같은 결합어 우선)
  const weldKeywords = [
    '안전모걸이대', '콤프보관함', '안전조회장',
    '+프레임', '프레임+', '철판프레임', '철판자립',
    '용접', '거치대', '받침대', '걸이대',
    '자립간판',
    // 바닥/철망/앵글 류 용접 제작품
    '바닥보호덮개', '개구부덮개', '덮개', '앵글+철망', '철망+앵글', '바닥덮개',
    'pvc망', '안전망',
    // 추가 용접 제작품
    '갈바', '명판', '안전발판', '맨홀', '게시판', '갈바게시판',
  ];
  for (const kw of weldKeywords) {
    if (text.includes(kw.toLowerCase().replace(/\s+/g, ''))) return '용접물';
  }
  // 2) 트레이딩 키워드 (매입후매출 — PPTX 매칭 제외)
  const tradingKeywords = [
    '휀스', '펜스', '앙카베이스', '앙카',
    '파이프', '호이스트', '시멘지주', '시멘트지주',
    '쓰레기통', 'u고리',
    '운반비', '택배비', '운임비', '화물비',
    '인건비', '설치비', '제판비', '인쇄비',
    '안전모식별', '안전화', '안전조끼', '안전장갑',
    '방진마스크', '방한', '핫팩', '각반',
    // 출력만 = 컴퍼니가 외주에 후렉스 천만 매입한 거 (매입후매출, 매출기준 매칭 제외)
    '후렉스출력만', '출력만',
  ];
  for (const kw of tradingKeywords) {
    if (text.includes(kw.toLowerCase().replace(/\s+/g, ''))) return '트레이딩';
  }
  // 3) 추가 용접물 키워드 (트레이딩과 헷갈리지 않는 것만)
  const weldKeywords2 = ['프레임', '자립', '철물'];
  for (const kw of weldKeywords2) {
    if (text.includes(kw.toLowerCase().replace(/\s+/g, ''))) return '용접물';
  }
  // 4) 그 외 = 출력물 (공장 제작 인쇄/사인물)
  return '출력물';
}

// 같은 일자의 학습 풀 행을 카테고리 필터
function getRegisteredByDateAndCategory(dateStr, category) {
  const q = pool.COMPANY_매출;
  if (!q.byDate || !dateStr) return [];
  const rows = q.byDate.get(dateStr) || [];
  if (!category) return rows;
  return rows.filter(r => categorizeRow(r.item, r.spec) === category);
}

function companySaleRowKey(row) {
  if (!row) return '';
  return [
    row.date || '',
    row.vendor || '',
    row.item || '',
    normalizeSpec(row.spec || ''),
    row.qty ?? '',
    row.price ?? '',
    row.amount ?? '',
  ].join('|');
}

// ─── 로더 ───────────────────────────────────────────────

async function load() {
  pool.loaded = false;
  resetPoolData();
  console.log('[learning-pool] 로딩 시작...');
  try {
    await loadSmBuy();
    await loadSmSell();
    await loadCompanyBoth();  // 매입+매출 한 파일
    await loadProductMaster();  // ★ 9,950 품목코드 + 정규화 룰
    await loadLearningAdditions();  // ★ 사장님 확정 누적 데이터 (자동 학습)
  } catch (e) {
    console.error('[learning-pool] 로딩 실패:', e.message);
    pool.errors.push(e.message);
  }
  const statsBeforeReady = getStats();
  pool.ready = statsBeforeReady.COMPANY_매출.rows > 0;
  if (!pool.ready) {
    pool.errors.push('컴퍼니 매출 정답 행이 0건입니다. PPTX 매칭을 중단합니다.');
  }
  pool.loaded = true;
  pool.loadedAt = new Date();
  const stats = getStats();
  console.log('[learning-pool] 로딩 완료:', stats);
  return stats;
}

async function loadSmBuy() {
  const fp = path.join(LEARNING_DIR, '01_에스엠매입', '26년 에스엠매입.xlsx');
  if (!trackFile('SM 매입', fp, true)) {
    console.log('[learning-pool] SM매입 파일 없음:', fp);
    return;
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fp);
  const ws = wb.worksheets[0];
  const target = pool.SM_매입;
  let i = 0;
  ws.eachRow((row) => {
    i++;
    if (i <= 2) return;  // 헤더
    const vals = row.values;
    // [_, 일자, 거래처, 품목코드, 품목명(규격), 수량, 단가, 공급가액, 부가세, 합계, 회계반영일, 적요]
    const vendor = vals[2];
    const code = vals[3];
    const name = vals[4];
    const price = vals[6];
    if (!vendor) return;
    target.rows++;
    inc(target.vendors, vendor);
    if (code) {
      const c = target.codes.get(code) || { count: 0, name, lastPrice: price };
      c.count++;
      c.name = name || c.name;
      c.lastPrice = price || c.lastPrice;
      target.codes.set(code, c);
    }
    if (name) inc(target.items, name);
  });
  console.log(`[learning-pool] SM매입 ${target.rows}행 로드`);
}

async function loadSmSell() {
  const fp = path.join(LEARNING_DIR, '02_에스엠매출', '26년 에스엠매출.xlsx');
  if (!trackFile('SM 매출', fp, true)) {
    console.log('[learning-pool] SM매출 파일 없음:', fp);
    return;
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fp);
  const ws = wb.worksheets[0];
  const target = pool.SM_매출;
  let i = 0;
  ws.eachRow((row) => {
    i++;
    if (i <= 2) return;
    const vals = row.values;
    // [_, 일자, 거래처, 프로젝트, 품목코드, 품목명, 규격, 수량, 단가, 공급가액, 부가세, 합계, 비고, 적요, 적요2]
    const vendor = vals[2];
    const project = vals[3];
    const code = vals[4];
    const name = vals[5];
    const spec = vals[6];
    const price = vals[8];
    if (!vendor) return;
    target.rows++;
    inc(target.vendors, vendor);
    if (project) inc(target.projects, project);
    if (code) {
      const c = target.codes.get(code) || { count: 0, name, spec, lastPrice: price };
      c.count++;
      c.name = name || c.name;
      c.spec = spec || c.spec;
      c.lastPrice = price || c.lastPrice;
      target.codes.set(code, c);
    }
    if (name) inc(target.items, name);
  });
  console.log(`[learning-pool] SM매출 ${target.rows}행 로드`);
}

async function loadCompanyBoth() {
  const buyFp = path.join(LEARNING_DIR, '03_컴퍼니매입', 'data', '컴퍼니-매입매출.xlsx');
  const sellFp = path.join(LEARNING_DIR, '04_컴퍼니매출', 'data', '컴퍼니-매입매출.xlsx');
  const ExcelJS = require('exceljs');
  const buy = pool.COMPANY_매입;
  const sell = pool.COMPANY_매출;

  async function loadCompanyWorkbook(fp, label, mode) {
    if (!trackFile(label, fp, true)) {
      console.log(`[learning-pool] ${label} 파일 없음:`, fp);
      return;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(fp);
    const ws = wb.worksheets[0];
    let i = 0;
    ws.eachRow((row) => {
      i++;
      if (i === 1) return;  // 헤더
      const vals = row.values;
      // [_, 일자, 거래처, 품목약어, 품명, 규격, 매입수량, 매출수량, 단가, 매입금액, 매입세액, 매입합계, 매출금액, 매출세액, 매출합계, 상품분류, 상품소분류, 전표번호, 비고, 비고_세부, 프로젝트, 납품처]
      const dateRaw = vals[1];
      const vendor = vals[2];
      const item = vals[4];
      const spec = vals[5];
      const qty = vals[7];   // 매출수량
      const price = vals[8];
      const amount = vals[12]; // 매출금액
      const memo = vals[18]; // 비고
      const memoDetail = vals[19]; // 비고_세부 (대부분 현장명)
      const project = vals[20]; // 프로젝트
      const deliveryTo = vals[21]; // 납품처
      if (!vendor || item === '전표합계') return;
      if (mode === 'buy' && vals[6]) {  // 매입수량
        buy.rows++;
        inc(buy.vendors, vendor);
        if (item) inc(buy.items, item);
        // 매입 인덱스 (날짜/거래처/거래처별칭/품명/규격별)
        const buyDate = toIsoDate(dateRaw);
        const buyQty = vals[6];
        const buyAmount = vals[9] || vals[11] || 0;  // 매입금액 또는 매입합계
        const buyRow = {
          date: buyDate, vendor, item: item || '', spec: spec || '',
          qty: buyQty, price: price || 0, amount: buyAmount,
          memo: memo || '', memoDetail: memoDetail || '',
        };
        const vendorAlias = normalizeVendorKey(vendor);
        if (buyDate) {
          if (!buy.byDate.has(buyDate)) buy.byDate.set(buyDate, []);
          buy.byDate.get(buyDate).push(buyRow);
        }
        if (!buy.byVendor.has(vendor)) buy.byVendor.set(vendor, []);
        buy.byVendor.get(vendor).push(buyRow);
        if (vendorAlias) {
          if (!buy.byVendorAlias.has(vendorAlias)) buy.byVendorAlias.set(vendorAlias, []);
          buy.byVendorAlias.get(vendorAlias).push(buyRow);
        }
        if (item) {
          const itemKey = norm(item);
          if (!buy.byItem.has(itemKey)) buy.byItem.set(itemKey, []);
          buy.byItem.get(itemKey).push(buyRow);
        }
        if (spec) {
          const specKey = normalizeSpec(spec);
          if (!buy.bySpec.has(specKey)) buy.bySpec.set(specKey, []);
          buy.bySpec.get(specKey).push(buyRow);
        }
      }
      if (mode === 'sell' && qty) {  // 매출수량
        sell.rows++;
        inc(sell.vendors, vendor);
        if (item) {
          inc(sell.items, item);
          // 결합 품명 (예: "pe간판+클리어파일4개")
          if (item.includes('+')) {
            const cleanItem = item.replace(/\s+/g, '');
            const key = `${vendor}|${cleanItem}`;
            inc(sell.combos, key);
          }
        }

        // 실제 등록행 인덱스 (일자별 / 거래처별 / 규격별)
        const dateStr = toIsoDate(dateRaw);
        const rowData = {
          date: dateStr, vendor, item, spec: spec || '', qty, price, amount,
          memo: memo || '', memoDetail: memoDetail || '', project: project || '', deliveryTo: deliveryTo || '',
        };
        // 일자별
        if (dateStr) {
          if (!sell.byDate.has(dateStr)) sell.byDate.set(dateStr, []);
          sell.byDate.get(dateStr).push(rowData);
        }
        // 거래처별
        if (!sell.byVendor.has(vendor)) sell.byVendor.set(vendor, []);
        sell.byVendor.get(vendor).push(rowData);
        // 규격별 (정규화 — 600*900, 600x900, 600X900 다 같이)
        if (spec) {
          const specKey = normalizeSpec(spec);
          if (!sell.bySpec.has(specKey)) sell.bySpec.set(specKey, []);
          sell.bySpec.get(specKey).push(rowData);
        }
      }
    });
  }

  await loadCompanyWorkbook(buyFp, '컴퍼니 매입', 'buy');
  await loadCompanyWorkbook(sellFp, '컴퍼니 매출', 'sell');
  console.log(`[learning-pool] 컴퍼니 매입 ${buy.rows}행 / 매출 ${sell.rows}행 로드 (일자 ${sell.byDate.size}일 / 규격 ${sell.bySpec.size}종)`);
}

// ─── 품목코드 마스터 로딩 (9,950건) ──────────────
// learning-data/99_품목마스터/컴퍼니-품목정리_정리완료_v7.xlsx
async function loadProductMaster() {
  const fp = path.join(LEARNING_DIR, '99_품목마스터', '컴퍼니-품목정리_정리완료_v7.xlsx');
  if (!trackFile('품목코드 마스터', fp, false)) {
    console.log('[learning-pool] 품목 마스터 파일 없음:', fp);
    return;
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fp);
  const PM = pool.PRODUCT_MASTER;

  // 1) 품목정리 시트 — 9,950 품목코드
  const ws = wb.getWorksheet('품목정리');
  if (ws) {
    ws.eachRow((row, i) => {
      if (i === 1) return;
      const v = row.values;
      const r = {
        code: String(v[1] || '').trim(),         // 변경금지
        category1: String(v[2] || '').trim(),    // 대분류
        category2: String(v[3] || '').trim(),    // 소분류
        item: String(v[4] || '').trim(),         // 상품명
        spec: String(v[5] || '').trim(),         // 규격
        short: String(v[6] || '').trim(),        // 상품약어
        maker: String(v[7] || '').trim(),        // 제조사
        priceIn: Number(v[8]) || 0,              // 입고단가
        priceOut: Number(v[9]) || 0,             // 출고단가
        priceConsumer: Number(v[10]) || 0,       // 소비자단가
        productCode: String(v[11] || '').trim(), // 상품코드
      };
      if (!r.code || !r.item) return;
      PM.byCode.set(r.code, r);
      const nameKey = norm(r.item);
      const specKey = normalizeSpec(r.spec);
      const fullKey = nameKey + '|' + specKey;
      PM.byNameSpec.set(fullKey, r);
      if (!PM.byNameOnly.has(nameKey)) PM.byNameOnly.set(nameKey, []);
      PM.byNameOnly.get(nameKey).push(r);
      const catKey = r.category1 + '/' + r.category2;
      if (!PM.byCategory.has(catKey)) PM.byCategory.set(catKey, []);
      PM.byCategory.get(catKey).push(r);
      PM.rows++;
    });
  }

  // 2) 그룹요약 — 정규화 룰 (대문자/소문자 통일)
  const ws2 = wb.getWorksheet('그룹요약');
  if (ws2) {
    ws2.eachRow((row, i) => {
      if (i <= 1) return;
      const v = row.values;
      const canonical = String(v[2] || '').trim();  // 대표(살릴 표기)
      const variants = String(v[4] || '');           // 변형 표기들 ("3t포맥스" / "3T포맥스")
      if (!canonical) return;
      const matches = variants.match(/"([^"]+)"/g) || [];
      for (const m of matches) {
        const variant = m.slice(1, -1);
        const k = norm(variant);
        if (k) pool.NORMALIZE_RULES.set(k, canonical);
      }
    });
  }

  // 3) 신규등록규칙
  const ws3 = wb.getWorksheet('신규등록규칙');
  if (ws3) {
    ws3.eachRow((row, i) => {
      if (i === 1) return;
      const v = row.values;
      if (v[1] && v[3]) pool.NEW_RULES.push({
        no: v[1], target: v[2] || '', rule: v[3], example: v[4] || '', why: v[5] || '',
      });
    });
  }

  console.log(`[learning-pool] 품목 마스터: ${PM.rows}개 코드 / 정규화 룰 ${pool.NORMALIZE_RULES.size}개 / 등록규칙 ${pool.NEW_RULES.length}개`);

  // 4) 옵션/프리셋 — 대림컴퍼니 품목 기준표_v2.xlsx 에서
  const fp2 = path.join(__dirname, '..', '..', '대림컴퍼니 품목 기준표_v2.xlsx');
  if (fs.existsSync(fp2)) {
    try {
      const wb2 = new ExcelJS.Workbook();
      await wb2.xlsx.readFile(fp2);
      // 공통옵션 — 헤더 4행 (순위/옵션이름/표준화/사용건수/...)
      const wsOpt = wb2.getWorksheet('공통옵션 마스터');
      if (wsOpt) {
        wsOpt.eachRow((row, i) => {
          if (i <= 4) return;
          const v = row.values;
          const optName = String(v[2] || '').trim();
          if (!optName || optName === '옵션이름') return;
          pool.OPTION_MASTER.push({
            option: optName,
            standard: String(v[3] || '').trim(),
            count: Number(v[4]) || 0,
            unit: String(v[5] || '').trim(),
            usedFor: String(v[7] || '').trim(),
          });
        });
      }
      const wsPre = wb2.getWorksheet('자주쓰는 프리셋');
      if (wsPre) {
        wsPre.eachRow((row, i) => {
          if (i <= 4) return;
          const v = row.values;
          const preset = String(v[2] || v[1] || '').trim();
          if (!preset || preset.includes('프리셋')) return;
          pool.PRESETS.push({ preset, count: Number(v[3] || v[2]) || 0 });
        });
      }
      console.log(`[learning-pool] 옵션 마스터 ${pool.OPTION_MASTER.length}개 / 프리셋 ${pool.PRESETS.length}개`);
    } catch (e) { console.warn('[learning-pool] 옵션/프리셋 로드 실패:', e.message); }
  }
}

// ─── 정규화 함수 (사장님 룰 적용) ─────────────────
// "3T포맥스 양면" → "3t포맥스+양면" (띄어쓰기 제거 + 옵션 + 기호)
// "솔벤트 실사" → "솔벤실사" (사장님 룰: 솔벤트 = 솔벤)
function normalizeItemName(text) {
  if (!text) return '';
  let s = String(text).trim();
  // 1) 띄어쓰기 제거 (룰 1)
  s = s.replace(/\s+/g, '');
  // 2) 별표(*) 통일 (룰 6)
  s = s.replace(/[xX×]/g, '*');
  // 3) 동의어 룰 (사장님 룰)
  s = s.replace(/솔벤트/g, '솔벤');
  // 4) 그룹요약 룰 적용 — 변형 → 대표 표기
  const k = norm(s);
  if (pool.NORMALIZE_RULES && pool.NORMALIZE_RULES.has(k)) {
    return pool.NORMALIZE_RULES.get(k);
  }
  return s;
}

// 시안 텍스트 정규화 (사장님 룰 일괄 적용)
// - 무시 단어 제거 (실사, 관리책임자, 추락주의 등 보드 디자인/현장 텍스트)
// - 동의어 변환 (솔벤트→솔벤)
// - 두께 자리바꿈 (포맥스3T → 3t포맥스, 포맥스1T → 1t포맥스 등)
// - 별표 통일 (xX× → *)
function applySynonymRules(text) {
  if (!text) return '';
  let s = String(text);
  // 1) 무시 단어 (시안의 디자인/보드/현장 텍스트 — 매칭에 영향 X)
  const ignoreKw = [
    '관리책임자', '추락주의', '위험물 사용구간', '낙하물 주의', '낙하주의',
    '방독마스크', '보안경', '안전화', '안전복', '안전모',
    '화상주의', '고온경고', '귀마개착용', '안전장갑착용',
    '안전화착용', '보안경착용', '방독마스크착용', '안전복착용', '안전장갑착용',
    '방진마스크', '화기엄금', '디링 확인', 'D링 확인',
    '실사',  // 사장님 룰: 실사스티커 X
  ];
  for (const kw of ignoreKw) s = s.split(kw).join(' ');
  // 2) 동의어
  s = s.replace(/솔벤트/g, '솔벤');
  // 3) 두께 자리바꿈 (포맥스3T → 3t포맥스, 포맥스1T → 1t포맥스, 폼보드3T → 3t폼보드 등)
  s = s.replace(/포맥스\s*(\d+)\s*T/gi, '$1t포맥스');
  s = s.replace(/폼보드\s*(\d+)\s*T/gi, '$1t폼보드');
  s = s.replace(/포맥스\s*(\d+)\s*t/gi, '$1t포맥스');
  // 4) 별표 통일
  s = s.replace(/[xX×]/g, '*');
  // 5) 다중 공백 → 단일
  s = s.replace(/\s+/g, ' ').trim();
  return s;
}

// 시안 텍스트에서 옵션 키워드 자동 추출 (공통옵션 마스터 기반)
function extractOptionsFromText(text) {
  if (!text || !pool.OPTION_MASTER.length) return [];
  const t = norm(text);
  const found = [];
  for (const opt of pool.OPTION_MASTER) {
    const optName = opt.standard || opt.option;
    if (!optName || optName.length < 2) continue;
    const k = norm(optName);
    if (k && t.includes(k) && !found.includes(optName)) {
      found.push(optName);
    }
  }
  return found;
}

// ─── 시안 → 품목 마스터 매칭 (3단계 결과) ──────────
// 반환: {
//   status: 'matched' | 'predicted' | 'unknown',
//   code: string?,         // 품목코드
//   item: string?,         // 표준 상품명
//   spec: string?,         // 표준 규격
//   priceOut: number?,     // 출고단가
//   options: string[]?,    // 자동 추출된 옵션
//   reason: string,        // 사유
//   suggestion?: object    // predicted 일 때 예측값
// }
// ────────────────────────────────────────────────────────────
// 사장님 룰: 단순 4단계 검색 (추론 X)
// 1) 거래처 학습풀 정확 매칭 → 이미 판/산 코드 + 단가
// 2) 마스터 본품+옵션 결합키 정확 매칭 → 코드 + 사이즈 (단가 빈칸)
// 3) 마스터 같은 품명 사이즈만 다름 → 코드 빈칸 + 표준명 (단가 빈칸)
// 4) 매칭 실패 → 빈칸 (사장님 입력)
// ────────────────────────────────────────────────────────────
function matchSlideToProductMaster(slideText, opts = {}) {
  const PM = pool.PRODUCT_MASTER;
  const rawText = String(slideText || '');
  const vendor = String(opts.vendor || '').trim();
  if (PM.rows === 0 && pool.COMPANY_매출.byVendor.size === 0) {
    return { status: 'unknown', reason: '학습풀/마스터 미로드' };
  }

  // 정규화 (사장님 룰)
  const text = applySynonymRules(rawText);
  const tnorm = norm(text);

  // 사이즈 추출
  const specMatch = text.match(/(\d{2,5})\s*[*xX×]\s*(\d{2,5})/);
  const extractedSpec = specMatch ? `${specMatch[1]}*${specMatch[2]}` : '';
  const targetSpec = normalizeSpec(extractedSpec);

  // 옵션 추출 (시안 텍스트에 명시된 키워드만 — 추론 X)
  const options = extractOptionsFromText(text);

  // 마스터 키 검색 — 결합키 ('+포함') 도 같이 매칭하기 위해 '+' 제거 후 substring
  // 가장 긴 매치 우선 (3t포맥스+양면테이프 11글자 > 포맥스 3글자)
  let bestKey = null;
  let bestKeyLen = 0;
  let bestRows = null;
  for (const [k, rows] of PM.byNameOnly) {
    if (k.length < 2) continue;
    const kNoPlus = k.replace(/\+/g, '');
    if (tnorm.includes(kNoPlus)) {
      if (kNoPlus.length > bestKeyLen) {
        bestKey = k;
        bestKeyLen = kNoPlus.length;
        bestRows = rows;
      }
    }
  }

  // ─── 1순위: 거래처 학습풀 정확 매칭 (이미 판/산 적 있는 코드 + 단가) ──
  if (vendor) {
    const c = pool.COMPANY_매출;
    let vendorRows = [];
    const vNorm = norm(vendor);
    for (const [vk, rows] of c.byVendor) {
      if (norm(vk).includes(vNorm) || vNorm.includes(norm(vk))) {
        vendorRows.push(...rows);
      }
    }
    if (vendorRows.length > 0) {
      // 정확 매칭 — 결합키 형태 그대로 (포맥스3T 양면테이프 → 3t포맥스+양면테이프 결합키와 매칭)
      const targetItemNorm = bestKey;  // bestKey 는 '+포함' 형태
      const exact = vendorRows.filter(r => {
        if (!r.item) return false;
        const rn = norm(r.item);
        return rn === targetItemNorm && normalizeSpec(r.spec) === targetSpec;
      });
      if (exact.length > 0) {
        // 가장 최근 거래
        exact.sort((a, b) => String(b.date).localeCompare(String(a.date)));
        const recent = exact[0];
        return {
          status: 'matched',
          code: null,
          item: recent.item,
          spec: recent.spec,
          priceOut: Number(recent.price) || 0,
          priceIn: 0,
          options,
          reason: `거래처 학습 (${vendor} / ${recent.item} ${recent.spec} ${recent.date})`,
          source: 'vendor_history',
        };
      }
    }
  }

  // ─── 2순위: 마스터 결합키 + 사이즈 정확 매칭 (코드 + 표준명, 단가 빈칸) ──
  if (bestKey && bestRows) {
    const matchedExact = bestRows.find(r => normalizeSpec(r.spec) === targetSpec);
    if (matchedExact) {
      return {
        status: 'matched',
        code: matchedExact.code,
        item: matchedExact.item,
        spec: matchedExact.spec,
        priceOut: matchedExact.priceOut || 0,  // 마스터 출고단가 (있으면)
        priceIn: 0,
        options,
        reason: `마스터 정확 매칭 (코드 ${matchedExact.code})`,
        source: 'master_exact',
      };
    }
  }

  // ─── 3순위: 마스터 같은 품명 사이즈 다름 (표준명만, 단가 빈칸) ──
  if (bestKey && bestRows && bestRows.length > 0) {
    const sample = bestRows[0];
    return {
      status: 'predicted',
      code: null,
      item: sample.item,
      spec: extractedSpec,
      priceOut: 0,        // ★ 추론 안 함 — 사장님 입력 대기
      priceIn: 0,
      options,
      reason: `마스터 품명 매칭 (${sample.item}) — 사이즈 ${extractedSpec} 신규`,
      source: 'master_partial',
      suggestion: { masterRows: bestRows.length },
    };
  }

  // ─── 4순위: 매칭 실패 (전부 빈칸) ──
  return {
    status: 'unknown',
    code: null,
    item: '',
    spec: extractedSpec,
    priceOut: 0,
    priceIn: 0,
    options,
    reason: '시안에서 마스터 품목 못 찾음',
    source: 'unknown',
  };
}

function getProductMasterStats() {
  return {
    rows: pool.PRODUCT_MASTER.rows,
    normalize_rules: pool.NORMALIZE_RULES.size,
    new_rules: pool.NEW_RULES.length,
    options: pool.OPTION_MASTER.length,
    presets: pool.PRESETS.length,
  };
}

// ─── 학습 누적 DB (사장님 확정 시 자동 누적) ──────────────
// data/learning-additions.db 에 저장. 학습풀 로딩 시 자동으로 합쳐짐.
const LEARNING_DB_PATH = path.join(__dirname, '..', 'data', 'learning-additions.db');
let _learnDb = null;
function getLearnDb() {
  if (_learnDb) return _learnDb;
  const Database = require('better-sqlite3');
  _learnDb = new Database(LEARNING_DB_PATH);
  _learnDb.pragma('journal_mode = WAL');
  _learnDb.exec(`
    CREATE TABLE IF NOT EXISTS company_purchase_added (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      added_by TEXT,
      source TEXT,
      date TEXT,
      vendor TEXT,
      item TEXT,
      spec TEXT,
      qty REAL,
      price INTEGER,
      amount INTEGER,
      memo TEXT,
      memo_detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_cpa_date ON company_purchase_added(date);
    CREATE INDEX IF NOT EXISTS idx_cpa_vendor ON company_purchase_added(vendor);

    CREATE TABLE IF NOT EXISTS company_sale_added (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at INTEGER NOT NULL,
      added_by TEXT,
      source TEXT,
      date TEXT,
      vendor TEXT,
      item TEXT,
      spec TEXT,
      qty REAL,
      price INTEGER,
      amount INTEGER,
      memo TEXT,
      memo_detail TEXT,
      project TEXT,
      delivery_to TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_csa_date ON company_sale_added(date);
    CREATE INDEX IF NOT EXISTS idx_csa_vendor ON company_sale_added(vendor);
  `);
  return _learnDb;
}

// 학습풀 로딩 시 누적 데이터 추가 → COMPANY_매입/매출 in-memory 인덱스에 합침
async function loadLearningAdditions() {
  let db;
  try { db = getLearnDb(); } catch (e) {
    console.warn('[learning-pool] 누적 DB 로딩 스킵:', e.message);
    return;
  }
  const buy = pool.COMPANY_매입;
  const sell = pool.COMPANY_매출;
  // 매입 누적
  let buyAdded = 0;
  try {
    const rows = db.prepare('SELECT * FROM company_purchase_added').all();
    for (const r of rows) {
      const buyRow = {
        date: r.date || '', vendor: r.vendor || '', item: r.item || '', spec: r.spec || '',
        qty: r.qty, price: r.price || 0, amount: r.amount || 0,
        memo: r.memo || '', memoDetail: r.memo_detail || '',
      };
      const vendorAlias = normalizeVendorKey(r.vendor || '');
      if (r.date) {
        if (!buy.byDate.has(r.date)) buy.byDate.set(r.date, []);
        buy.byDate.get(r.date).push(buyRow);
      }
      if (r.vendor) {
        if (!buy.byVendor.has(r.vendor)) buy.byVendor.set(r.vendor, []);
        buy.byVendor.get(r.vendor).push(buyRow);
      }
      if (vendorAlias) {
        if (!buy.byVendorAlias.has(vendorAlias)) buy.byVendorAlias.set(vendorAlias, []);
        buy.byVendorAlias.get(vendorAlias).push(buyRow);
      }
      if (r.item) {
        const ik = norm(r.item);
        if (!buy.byItem.has(ik)) buy.byItem.set(ik, []);
        buy.byItem.get(ik).push(buyRow);
      }
      if (r.spec) {
        const sk = normalizeSpec(r.spec);
        if (!buy.bySpec.has(sk)) buy.bySpec.set(sk, []);
        buy.bySpec.get(sk).push(buyRow);
      }
      buy.rows++;
      inc(buy.vendors, r.vendor || '');
      if (r.item) inc(buy.items, r.item);
      buyAdded++;
    }
  } catch (e) { console.warn('[learning-pool] 매입 누적 로드 실패:', e.message); }
  // 매출 누적
  let sellAdded = 0;
  try {
    const rows = db.prepare('SELECT * FROM company_sale_added').all();
    for (const r of rows) {
      const sellRow = {
        date: r.date || '', vendor: r.vendor || '', item: r.item || '', spec: r.spec || '',
        qty: r.qty, price: r.price || 0, amount: r.amount || 0,
        memo: r.memo || '', memoDetail: r.memo_detail || '',
        project: r.project || '', deliveryTo: r.delivery_to || '',
      };
      if (r.date) {
        if (!sell.byDate.has(r.date)) sell.byDate.set(r.date, []);
        sell.byDate.get(r.date).push(sellRow);
      }
      if (r.vendor) {
        if (!sell.byVendor.has(r.vendor)) sell.byVendor.set(r.vendor, []);
        sell.byVendor.get(r.vendor).push(sellRow);
      }
      if (r.spec) {
        const sk = normalizeSpec(r.spec);
        if (!sell.bySpec.has(sk)) sell.bySpec.set(sk, []);
        sell.bySpec.get(sk).push(sellRow);
      }
      sell.rows++;
      inc(sell.vendors, r.vendor || '');
      if (r.item) inc(sell.items, r.item);
      sellAdded++;
    }
  } catch (e) { console.warn('[learning-pool] 매출 누적 로드 실패:', e.message); }
  if (buyAdded || sellAdded) {
    console.log(`[learning-pool] 누적 학습 데이터 합산: 매입 +${buyAdded}행 / 매출 +${sellAdded}행`);
  }
}

// 매입 라인 1건 누적 (사장님 확정 시 호출)
function addCompanyPurchaseLearned({ date, vendor, item, spec, qty, price, amount, memo, memoDetail, addedBy, source }) {
  if (!item) return false;
  try {
    const db = getLearnDb();
    const supply = amount != null ? Number(amount) : Math.round((Number(qty) || 0) * (Number(price) || 0));
    db.prepare(`INSERT INTO company_purchase_added
      (created_at, added_by, source, date, vendor, item, spec, qty, price, amount, memo, memo_detail)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Date.now(), addedBy || '', source || '',
      date || '', vendor || '', item, spec || '',
      Number(qty) || 0, Number(price) || 0, supply,
      memo || '', memoDetail || ''
    );
    // in-memory 인덱스에도 즉시 반영
    const buy = pool.COMPANY_매입;
    const buyRow = { date: date || '', vendor: vendor || '', item, spec: spec || '', qty: Number(qty) || 0, price: Number(price) || 0, amount: supply, memo: memo || '', memoDetail: memoDetail || '' };
    const vendorAlias = normalizeVendorKey(vendor || '');
    if (date) { if (!buy.byDate.has(date)) buy.byDate.set(date, []); buy.byDate.get(date).push(buyRow); }
    if (vendor) { if (!buy.byVendor.has(vendor)) buy.byVendor.set(vendor, []); buy.byVendor.get(vendor).push(buyRow); }
    if (vendorAlias) { if (!buy.byVendorAlias.has(vendorAlias)) buy.byVendorAlias.set(vendorAlias, []); buy.byVendorAlias.get(vendorAlias).push(buyRow); }
    const ik = norm(item);
    if (ik) { if (!buy.byItem.has(ik)) buy.byItem.set(ik, []); buy.byItem.get(ik).push(buyRow); }
    if (spec) { const sk = normalizeSpec(spec); if (!buy.bySpec.has(sk)) buy.bySpec.set(sk, []); buy.bySpec.get(sk).push(buyRow); }
    buy.rows++;
    return true;
  } catch (e) {
    console.error('[learning-pool] addCompanyPurchaseLearned 실패:', e.message);
    return false;
  }
}

// 매출 라인 1건 누적 (사장님 확정 시 호출)
function addCompanySaleLearned({ date, vendor, item, spec, qty, price, amount, memo, memoDetail, project, deliveryTo, addedBy, source }) {
  if (!item) return false;
  try {
    const db = getLearnDb();
    const supply = amount != null ? Number(amount) : Math.round((Number(qty) || 0) * (Number(price) || 0));
    db.prepare(`INSERT INTO company_sale_added
      (created_at, added_by, source, date, vendor, item, spec, qty, price, amount, memo, memo_detail, project, delivery_to)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Date.now(), addedBy || '', source || '',
      date || '', vendor || '', item, spec || '',
      Number(qty) || 0, Number(price) || 0, supply,
      memo || '', memoDetail || '', project || '', deliveryTo || ''
    );
    // in-memory 인덱스
    const sell = pool.COMPANY_매출;
    const sellRow = { date: date || '', vendor: vendor || '', item, spec: spec || '', qty: Number(qty) || 0, price: Number(price) || 0, amount: supply, memo: memo || '', memoDetail: memoDetail || '', project: project || '', deliveryTo: deliveryTo || '' };
    if (date) { if (!sell.byDate.has(date)) sell.byDate.set(date, []); sell.byDate.get(date).push(sellRow); }
    if (vendor) { if (!sell.byVendor.has(vendor)) sell.byVendor.set(vendor, []); sell.byVendor.get(vendor).push(sellRow); }
    if (spec) { const sk = normalizeSpec(spec); if (!sell.bySpec.has(sk)) sell.bySpec.set(sk, []); sell.bySpec.get(sk).push(sellRow); }
    sell.rows++;
    return true;
  } catch (e) {
    console.error('[learning-pool] addCompanySaleLearned 실패:', e.message);
    return false;
  }
}

function getLearningAdditionsStats() {
  try {
    const db = getLearnDb();
    return {
      매입누적: db.prepare('SELECT COUNT(*) c FROM company_purchase_added').get().c,
      매출누적: db.prepare('SELECT COUNT(*) c FROM company_sale_added').get().c,
    };
  } catch (e) { return { 매입누적: 0, 매출누적: 0 }; }
}

// ─── 조회 ───────────────────────────────────────────────

function getStats() {
  return {
    loaded: pool.loaded,
    loadedAt: pool.loadedAt,
    ready: pool.ready,
    files: pool.files.map(f => ({
      label: f.label,
      path: f.path,
      exists: f.exists,
      size: f.size,
      required: f.required,
    })),
    errors: [...pool.errors],
    SM_매입: { rows: pool.SM_매입.rows, vendors: pool.SM_매입.vendors.size, items: pool.SM_매입.items.size, codes: pool.SM_매입.codes.size },
    SM_매출: { rows: pool.SM_매출.rows, vendors: pool.SM_매출.vendors.size, items: pool.SM_매출.items.size, codes: pool.SM_매출.codes.size, projects: pool.SM_매출.projects.size },
    COMPANY_매입: { rows: pool.COMPANY_매입.rows, vendors: pool.COMPANY_매입.vendors.size, items: pool.COMPANY_매입.items.size },
    COMPANY_매출: { rows: pool.COMPANY_매출.rows, vendors: pool.COMPANY_매출.vendors.size, items: pool.COMPANY_매출.items.size, combos: pool.COMPANY_매출.combos.size },
  };
}

function getQuadrant(companyCode, docClass) {
  const key = `${companyCode}_${docClass}`;
  return pool[key] || null;
}

// AI 프롬프트용 컨텍스트 (TOP N)
function getContext(companyCode, docClass, opts = {}) {
  const q = getQuadrant(companyCode, docClass);
  if (!q) return '';
  const topVendors = opts.topVendors || 30;
  const topItems = opts.topItems || 50;
  const vendors = [...q.vendors.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, topVendors).map(([n]) => n);
  const items = [...q.items.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, topItems).map(([n]) => n);
  const projects = q.projects ? [...q.projects.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 30).map(([n]) => n) : [];

  let ctx = `\n[알려진 거래처 TOP ${vendors.length} — 매칭 시 정식 표기 사용]\n`;
  ctx += vendors.map(v => `- ${v}`).join('\n');
  ctx += `\n\n[알려진 품목 TOP ${items.length}]\n`;
  ctx += items.map(i => `- ${i}`).join('\n');
  if (projects.length > 0) {
    ctx += `\n\n[알려진 현장/프로젝트 TOP ${projects.length}]\n`;
    ctx += projects.map(p => `- ${p}`).join('\n');
  }
  return ctx;
}

// 거래처 / 품목 검색 (간단 substring 매칭)
function findVendor(companyCode, docClass, query) {
  const q = getQuadrant(companyCode, docClass);
  if (!q || !query) return [];
  const nq = norm(query);
  const matches = [];
  for (const [name, info] of q.vendors.entries()) {
    if (norm(name).includes(nq)) {
      matches.push({ name, count: info.count });
    }
  }
  return matches.sort((a, b) => b.count - a.count).slice(0, 10);
}

function findItem(companyCode, docClass, query) {
  const q = getQuadrant(companyCode, docClass);
  if (!q || !query) return [];
  const nq = norm(query);
  const matches = [];
  // 코드 매칭 우선 (있으면)
  if (q.codes) {
    for (const [code, info] of q.codes.entries()) {
      if (norm(code).includes(nq) || norm(info.name).includes(nq)) {
        matches.push({ code, name: info.name, spec: info.spec, lastPrice: info.lastPrice, count: info.count, type: 'code' });
      }
    }
  }
  // 품명 매칭
  for (const [name, info] of q.items.entries()) {
    if (norm(name).includes(nq)) {
      // 코드 매칭에 이미 있으면 skip
      if (matches.some(m => m.name === name)) continue;
      matches.push({ name, count: info.count, type: 'name' });
    }
  }
  return matches.sort((a, b) => b.count - a.count).slice(0, 15);
}

// 거래처별 결합 패턴 (④ 컴퍼니 매출만 의미있음)
function getCombosForVendor(vendor) {
  const q = pool.COMPANY_매출;
  const matches = [];
  for (const [key, info] of q.combos.entries()) {
    const [v, item] = key.split('|');
    if (v === vendor || norm(v).includes(norm(vendor))) {
      matches.push({ vendor: v, item, count: info.count });
    }
  }
  return matches.sort((a, b) => b.count - a.count).slice(0, 20);
}

// 같은 일자(±N일)의 실제 등록 행
/**
 * @param {string} dateStr - YYYY-MM-DD
 * @param {object} options
 *   - dayRange: 대칭 ±N일 (default 14). dayBack / dayForward 와 동시 사용 시 무시됨
 *   - dayBack: 과거쪽 N일 (default = dayRange)
 *   - dayForward: 미래쪽 N일 (default = dayRange)
 *
 * 월말 패턴: 25일~말일 시안 → 익월 1-5일 매출 등록 일반적.
 * 따라서 month-end 자동 감지 시 dayForward 늘림.
 */
function getRegisteredByDate(dateStr, options = {}) {
  const q = pool.COMPANY_매출;
  if (!q.byDate || !dateStr) return [];
  const targetDate = new Date(dateStr);
  if (isNaN(targetDate)) return [];
  const dayRange = options.dayRange ?? 14;
  let dayBack = options.dayBack ?? dayRange;
  let dayForward = options.dayForward ?? dayRange;
  // 자동 월말 보정: 25일 이후면 익월 진입까지 자동 확장 (마감 정산 패턴)
  if (options.autoMonthEnd !== false) {
    const day = targetDate.getDate();
    if (day >= 25) {
      // 다음달 5일까지 커버 (예: 12/30 시안 → 1/01~1/05 매출 가능)
      const nextMonthFifth = new Date(targetDate.getFullYear(), targetDate.getMonth() + 1, 5);
      const daysToNext = Math.ceil((nextMonthFifth - targetDate) / 86400000);
      dayForward = Math.max(dayForward, daysToNext);
    }
  }
  const matches = [];
  for (const [d, rows] of q.byDate.entries()) {
    const dt = new Date(d);
    if (isNaN(dt)) continue;
    const diff = (dt - targetDate) / 86400000; // 양수=미래, 음수=과거
    const inRange = (diff >= 0 && diff <= dayForward) || (diff < 0 && Math.abs(diff) <= dayBack);
    if (inRange) {
      for (const r of rows) {
        matches.push({ ...r, dayDiff: Math.round(diff) });
      }
    }
  }
  return matches.sort((a, b) => Math.abs(a.dayDiff) - Math.abs(b.dayDiff));
}

// ─── OCR 텍스트 → 제품 후보 추출 ─────────────────
// 시안 이미지에 보통 5~7개 제품이 함께 들어가 있음. OCR 텍스트에서 (사이즈, 재질, 두께, 수량)
// 패턴을 모두 뽑아서 각각 학습풀과 매칭한다.

// 슬라이드 전체 텍스트에서 재질 키워드 추출 (제목 등에 한 번 적힌 재질을 모든 라인에 상속)
// 예: 슬라이드 제목 "UV코팅/AL스티커 - 총 8개" → 재질=['알루미늄UV','스티커'] 모든 라인에 적용
function extractSlideMaterials(fullText) {
  const t = String(fullText || '').toLowerCase();
  const mats = [];
  // 알루미늄 UV (바닥시트)
  if (/(uv코팅|al스티커|alu.*sticker|알루미늄uv|알루미늄.*바닥)/.test(t)) {
    mats.push('알루미늄UV');
    if (/스티커/.test(t)) mats.push('스티커');
  }
  // 후렉스 (다양한 표기 + OCR 오타 + 관련어 + 큰 사이즈 출력 키워드)
  // - 후렉스/휴렉스(OCR 오타)/세륜장간판/조회단상/현수나배/출력만/텐션/호이스트간판 → 후렉스 계열
  // 띄어쓰기 허용: "호이스트 간판", "후렉스 간판" 등
  if (/후렉스|휴렉스|호이스트\s*간판|후렉스\s*간판|후렉스\s*출력만|세륜장\s*간판|조회단상|현수나배|아일렛\s*후렉스|출력만|텐션용|텐션\s*바|상부.*아일렛|상부.*반생/.test(t)) mats.push('후렉스');
  // 포맥스
  if (/포맥스|포팩스|포멜스|포멕스|표택스/.test(t)) mats.push('포맥스');
  // PE 간판
  if (/p\s*e\s*간판|pe간판|pe\s*판/.test(t)) mats.push('pe간판');
  // 현수막 / 타포린 (현수막 = 현수나배도 포함)
  if (/현수막|현수나배|각목현수막|아일렛현수막/.test(t)) mats.push('현수막');
  if (/타포린/.test(t)) mats.push('타포린');
  // A형
  if (/a형|a-형/.test(t)) mats.push('a형');
  // 자석
  if (/자석|고무자석/.test(t)) mats.push('자석');
  // 철판
  if (/철판자립/.test(t)) mats.push('철판');
  if (/철판프레임|철판\+프레임/.test(t)) mats.push('철판');
  if (/철판실사|칠판실사|절판실사/.test(t)) mats.push('철판');
  // 폼보드
  if (/폼보드/.test(t)) mats.push('폼보드');
  // 페트
  if (/페트배너|페트지/.test(t)) mats.push('페트');
  // 스티커류 (시트지/시트커팅도 스티커 부류)
  if (/원형스티커|덧방스티커|투명스티커|배면스티커|반사스티커|유포실사스티커|실사스티커|시트지|시트커팅|시트지\d종|덧방|민주평통/.test(t)) mats.push('스티커');
  return [...new Set(mats)];
}

// 슬라이드 OCR 에서 현장명 추출 (학습풀 비고_세부 와 매칭용)
// 패턴: "XX 현장" / "XX 공구" / "XX 단지" / "XX 센터" / "XX 사업" / 두번째~네번째 줄에 흔히 위치
function extractSiteFromOcr(ocrText) {
  const lines = String(ocrText || '').split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
  // 상단 6줄 검사 (제목 영역)
  for (const line of lines.slice(0, 6)) {
    const m = line.match(/([가-힣A-Za-z0-9]+(?:\s*[가-힣A-Za-z0-9]+){0,4})\s*(현장|공구|단지|센터|사업|이파크|아이파크|i\s*park)\b/i);
    if (m) {
      let s = m[1];
      // "DL E&C", "HDC", "포스코이앤씨" 같은 발주처는 빼고 진짜 현장명만
      s = s.replace(/^(dl\s*e&c|hdc\s*현대산업개발|hdc|포스코이앤씨|요진건설산업|쌍용건설|한신공영|이상테크원|이상테크윈|동명이엔지|라코스|디자인포트|daelim\s*sm|yojin)\s*/i, '');
      s = s.trim();
      if (s.length >= 2) return s + ' ' + m[2];
    }
    // "XX센터", "XX단지" 단독 (현장 등 키워드 없이)
    const m2 = line.match(/([가-힣A-Za-z]{2,}(?:데이터|아이파크|리츠카운티|아크로|미군|충돌역|오피스텔|서울원|광명))/);
    if (m2) return m2[1];
  }
  return '';
}

// 깃발 type 슬라이드 감지 — 25각 파이프 + 깃발/네오디움/볼트자석
// 매출은 사이즈 (1200*1200) 가 아니라 키워드 ("25각 네오디움자석 깃발") 으로 등록됨
function isFlagSlide(ocrText) {
  const t = String(ocrText || '').toLowerCase();
  return /25각/.test(t) && /(깃발|네오디움|볼트자석|차량용\s*깃발)/.test(t);
}

function extractFlagProduct(ocrText) {
  const txt = String(ocrText || '');
  // 수량 추출: "2개 제작" / "10개 / 네오디움" / "X개" / "2set"
  const qtyMatch =
    txt.match(/(\d+)\s*개\s*제작/) ||
    txt.match(/(\d+)\s*set/i) ||
    txt.match(/-\s*(\d+)\s*set/i) ||
    txt.match(/[-–]\s*(\d+)\s*개/) ||
    txt.match(/^(\d+)\s*개\s*$/m);
  const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : null;
  return {
    raw: '25각 네오디움자석 깃발 (시안 type)',
    spec: '',
    materials: ['깃발'],
    thickness: null,
    qty,
    _flagType: true,
  };
}

function extractProductsFromOcr(ocrText) {
  if (!ocrText) return [];
  // 깃발 type 슬라이드면 단일 깃발 product 만 반환 (사이즈 무시)
  if (isFlagSlide(ocrText)) {
    return [extractFlagProduct(ocrText)];
  }
  // 슬라이드 전체에서 재질 키워드 추출 (제목 컨텍스트 활용)
  const slideMaterials = extractSlideMaterials(ocrText);
  // 줄바꿈 + 슬래시(/) + 콤마로 분할 — 한 슬라이드의 여러 제품 잡기
  const fragments = String(ocrText).split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
  const products = [];
  const seen = new Set(); // 중복 제품 (앞면/뒷면 같은) 방지

  for (const line of fragments) {
    // N6넘버링/N4넘버링 같은 옵션 표기 라인은 제품 아님 (다른 제품의 부속 옵션)
    if (/N\d+\s*넘버링|넘버링\s*\(\d+/.test(line)) continue;
    // 사이즈 패턴: 가로*세로 (300~5000mm 범위, 한 줄에 여러 사이즈도 가능)
    const sizeRegex = /(\d{2,5})\s*[*×xX]\s*(\d{2,5})/g;
    let m;
    while ((m = sizeRegex.exec(line)) !== null) {
      const w = parseInt(m[1], 10);
      const h = parseInt(m[2], 10);
      // 사이즈 범위 검증 (시안에 나올 만한 크기)
      if (w < 50 || w > 6000 || h < 50 || h > 6000) continue;
      const spec = `${w}*${h}`;

      // 줄 전체 컨텍스트로 재질/두께/수량 판별 (사이즈 주변 30자 윈도우)
      const winStart = Math.max(0, m.index - 5);
      const winEnd = Math.min(line.length, m.index + m[0].length + 50);
      const ctx = line.slice(winStart, winEnd);
      const fullCtx = line; // 전체 줄도 같이

      // 재질 키워드 (우선순위: 구체적 → 일반)
      const materials = [];
      if (/포맥스|포맥스|포멜스|포팩스/.test(fullCtx)) materials.push('포맥스');
      if (/p\s*e\s*간판|pe간판|pe\s*판|pe칸판/i.test(fullCtx)) materials.push('pe간판');
      if (/현수막|타포린/.test(fullCtx)) materials.push('현수막');
      if (/스티커/.test(fullCtx)) materials.push('스티커');
      if (/철판|아연도|aluminum|alu/i.test(fullCtx)) materials.push('철판');
      if (/후렉스|아일렛/.test(fullCtx)) materials.push('후렉스');
      if (/a형|a-형/i.test(fullCtx)) materials.push('a형');
      if (/자석/.test(fullCtx)) materials.push('자석');
      if (/프레임/.test(fullCtx) && !materials.includes('철판')) materials.push('프레임결합');
      if (/^칠판|칠판실사/.test(fullCtx)) materials.push('철판'); // 칠판실사 = 철판 인쇄
      if (/실사|배너|족광시트/.test(fullCtx)) materials.push('실사');
      if (/휴플|휴펠스|조획|간판/.test(fullCtx)) materials.push('간판');

      // 두께 추출: "3T", "5T", "포맥스 3T" → 3t
      const thickMatch = fullCtx.match(/(\d{1,2})\s*[Tt](?:\s|\)|$|,|\(모서리)/);
      const thickness = thickMatch ? thickMatch[1] + 't' : null;

      // 수량 추출: "– 35개", "- 2개", "35개", "2 개", "- 1매", "1EA"
      const qtyMatch =
        fullCtx.match(/[\-–~]\s*(\d+)\s*개/) ||
        fullCtx.match(/(\d+)\s*개\b/) ||
        fullCtx.match(/(\d+)\s*매\b/) ||
        fullCtx.match(/(\d+)\s*EA\b/i);
      const qty = qtyMatch ? parseInt(qtyMatch[1], 10) : null;

      // 슬라이드 컨텍스트 재질 머지 (라인에 재질 없으면 제목 등에서 추출한 재질 상속)
      const mergedMaterials = [...new Set([...materials, ...slideMaterials])];

      const dedupKey = `${spec}|${mergedMaterials.join(',')}|${thickness || ''}|${qty || ''}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      products.push({
        raw: line,
        spec,
        materials: mergedMaterials,
        thickness,
        qty,
        _lineMaterials: materials,    // 디버그: 라인 직접 추출
        _slideMaterials: slideMaterials, // 디버그: 슬라이드 상속
      });
    }
  }
  return products;
}

// 한 슬라이드의 OCR 텍스트 → 학습풀 multi-product 매칭
function matchOcrTextToPool(ocrText, opts = {}) {
  const dateStr = opts.dateStr || '';
  const dayRange = opts.dayRange ?? 0;
  const pptxCategory = opts.pptxCategory || null;
  const usedKeys = opts.excludeKeys || new Set();

  // 후보 풀: 같은 일자 + 비대칭 forward 검색 (월말 → 익월 마감 패턴)
  // dayBack=1, dayForward=3 (월말 자동감지로 익월 5일까지 확장됨)
  let allCandidates = getRegisteredByDate(dateStr, {
    dayBack: opts.dayBack ?? Math.max(1, dayRange),
    dayForward: opts.dayForward ?? Math.max(3, dayRange),
  });
  allCandidates = allCandidates.filter(r => categorizeRow(r.item, r.spec) !== '트레이딩');

  const products = extractProductsFromOcr(ocrText);
  const matches = [];

  // ─── 현장명 → 후보 좁히기 (사장님 룰: 학습된 현장명을 OCR 에서 검색) ──────────
  // 학습풀 비고_세부 값들 (= ground truth) 을 시안 OCR text 에서 검색.
  // 매칭되는 현장명 있으면 그 매출만 후보로.
  const ocrN = norm(ocrText);
  const candidateSites = new Set();
  for (const r of allCandidates) {
    if (r.memoDetail && r.memoDetail.length >= 3) candidateSites.add(r.memoDetail);
  }
  let matchedSite = '';
  // 1차: 정확 포함 매칭
  for (const site of candidateSites) {
    if (ocrN.includes(norm(site))) { matchedSite = site; break; }
  }
  // 2차: 부분 매칭 (학습풀 site 의 prefix 4글자 이상)
  if (!matchedSite) {
    for (const site of candidateSites) {
      const siteN = norm(site);
      if (siteN.length < 4) continue;
      for (let len = Math.min(siteN.length, 6); len >= 3; len--) {
        const prefix = siteN.slice(0, len);
        if (prefix.length >= 3 && ocrN.includes(prefix)) { matchedSite = site; break; }
      }
      if (matchedSite) break;
    }
  }
  if (matchedSite) {
    const siteN = norm(matchedSite);
    // same-site 매출이 앞에 오도록 정렬 (필터 X — recall 유지)
    const sameSite = allCandidates.filter(r => norm(r.memoDetail || '') === siteN);
    const others = allCandidates.filter(r => norm(r.memoDetail || '') !== siteN);
    allCandidates = [...sameSite, ...others];

    // ─── 학습 단계 N:M 평균치 매핑 (사장님 합의: 현장명 1차 + 카테고리 일치) ────
    // 운영 단계에는 적용 X — 시안 올라올 때는 카테고리만 사용. 현장명은 비고에 자동 채움.
    if (sameSite.length > 0 && pptxCategory && products.length >= 2 && !products[0]?._flagType) {
      const siteCatMatches = sameSite.filter(r => categorizeRow(r.item, r.spec) === pptxCategory);
      if (siteCatMatches.length === 1) {
        // 같은 현장+카테고리 매출 정확히 1개 → 시안 모든 라인을 그 매출에 N:M 매핑
        const target = siteCatMatches[0];
        if (!usedKeys.has(companySaleRowKey(target))) {
          for (const p of products) {
            matches.push({
              ocrFragment: p.raw,
              extractedSpec: p.spec,
              extractedMaterials: p.materials,
              extractedThickness: p.thickness,
              extractedQty: p.qty,
              matched: target,
              score: 95,
              reason: `현장(${matchedSite})+카테고리(${pptxCategory}) 매출1행 N:M`,
            });
          }
          usedKeys.add(companySaleRowKey(target));
          return { extracted: products.length, matchedCount: products.length, matches, matchedSite };
        }
      }
    }
  }

  // ─── 호이스트간판 N:1 매칭 (합의된 룰) ──────────────────
  // 사장님 합의: 호이스트간판 = 매출 후렉스+프레임 으로 등록 (사이즈는 평균치)
  // 슬라이드 OCR 에 "호이스트 간판" / "호이스트간판" 있으면 → 해당 일자 후렉스+프레임 매출 N:1 매칭
  const isHoistSlide = /호이스트\s*간판/.test(String(ocrText || ''));
  if (isHoistSlide && products.length >= 2 && !products[0]?._flagType) {
    const hoistCands = allCandidates.filter(r =>
      /후렉스\+프레임|후렉스간판/.test(r.item || '') &&
      !usedKeys.has(companySaleRowKey(r))
    );
    // 수량과 라인수가 정확/근접 일치 (±2 또는 20%) 한 매출 row 찾기
    const lineCount = products.length;
    const tol = Math.max(2, Math.round(lineCount * 0.2));
    const candidate = hoistCands.find(r => {
      const q = Number(r.qty) || 0;
      return Math.abs(q - lineCount) <= tol;
    });
    if (candidate) {
      for (const p of products) {
        matches.push({
          ocrFragment: p.raw,
          extractedSpec: p.spec,
          extractedMaterials: p.materials,
          extractedThickness: p.thickness,
          extractedQty: p.qty,
          matched: candidate,
          score: 90,
          reason: `호이스트간판→후렉스+프레임(라인 ${lineCount}, 수량 ${candidate.qty})`,
        });
      }
      usedKeys.add(companySaleRowKey(candidate));
      return { extracted: products.length, matchedCount: products.length, matches };
    }
  }

  // 제품별 카테고리 결정: OCR 재질 키워드가 카테고리 명확하면 그걸 쓰고, 아니면 PPTX 카테고리 fallback
  // 이렇게 하면 한 PPTX 안에 출력물+용접물 섞여 있어도 OK
  function inferCategoryFromMaterials(materials) {
    if (materials.includes('후렉스')) return '용접물'; // 후렉스+프레임 = 용접물
    if (materials.includes('철판') && materials.includes('프레임결합')) return '용접물';
    if (materials.includes('포맥스')) return '출력물';
    if (materials.includes('pe간판')) return '출력물';
    if (materials.includes('a형')) return '출력물';
    if (materials.includes('스티커')) return '출력물';
    if (materials.includes('현수막')) return '출력물';
    if (materials.includes('타포린')) return '출력물';
    if (materials.includes('알루미늄UV')) return '출력물';
    if (materials.includes('폼보드')) return '출력물';
    if (materials.includes('페트')) return '출력물';
    if (materials.includes('자석')) return '출력물';
    return null; // 모르면 fallback
  }

  for (const p of products) {
    // 깃발 type — 사이즈 무시, 키워드 매칭 ("네오디움자석 깃발" / "25각" 들어간 매출)
    if (p._flagType) {
      const flagPool = allCandidates
        .filter(r => /깃발|네오디움자석|네오디움.*자석|25각.*깃발/.test(r.item || ''))
        .filter(r => !usedKeys.has(companySaleRowKey(r)));
      // 수량 일치 우선, 없으면 가장 가까운 거
      let best = null;
      if (p.qty != null) {
        const exact = flagPool.find(r => Number(r.qty) === p.qty);
        if (exact) best = exact;
      }
      if (!best) best = flagPool[0];
      if (best) {
        matches.push({
          ocrFragment: p.raw,
          extractedSpec: '(깃발 — 사이즈 무시)',
          extractedMaterials: p.materials,
          extractedThickness: p.thickness,
          extractedQty: p.qty,
          matched: best,
          score: (p.qty != null && Number(best.qty) === p.qty) ? 100 : 80,
          reason: '깃발 키워드 매칭' + ((p.qty != null && Number(best.qty) === p.qty) ? '+수량' : ''),
        });
        usedKeys.add(companySaleRowKey(best));
      } else {
        matches.push({
          ocrFragment: p.raw,
          extractedSpec: '',
          extractedMaterials: p.materials,
          extractedThickness: p.thickness,
          extractedQty: p.qty,
          matched: null,
          score: 0,
          reason: '깃발 매출 없음',
        });
      }
      continue;
    }
    // 카테고리 결정 — 1차 PPTX 카테고리, 사이즈 못 찾으면 다른 카테고리도 시도
    const inferredCat = inferCategoryFromMaterials(p.materials);
    // 1차 시도: 기본 PPTX 카테고리
    let useCat = pptxCategory || inferredCat;
    let candidates = allCandidates;
    if (useCat) {
      candidates = candidates.filter(r => categorizeRow(r.item, r.spec) === useCat);
    }
    candidates = candidates.filter(r => !usedKeys.has(companySaleRowKey(r)));
    // 1차에서 사이즈 못 찾으면, OCR 이 추론한 카테고리로 재시도 (예: 출력물 PPTX 안의 후렉스간판 슬라이드)
    const tryAlternate = inferredCat && inferredCat !== useCat;
    let didAlternate = false;

    const pSpec = normalizeSpec(p.spec);
    // 사이즈 일치 후보만 1차 필터
    let pool = candidates.filter(r => normalizeSpec(r.spec) === pSpec);
    let specMatchType = 'exact';
    // 사이즈 못 찾으면 (가로/세로 뒤집힌 경우) — 90도 회전 시도
    if (pool.length === 0 && pSpec.includes('*')) {
      const [a, b] = pSpec.split('*');
      const flipped = `${b}*${a}`;
      pool = candidates.filter(r => normalizeSpec(r.spec) === flipped);
      if (pool.length > 0) specMatchType = 'flipped';
    }
    // 3차원 spec 매칭: OCR "1500*1100" ↔ 학습풀 "1500*1100*1500" (앞 두 차원 일치)
    if (pool.length === 0 && pSpec.includes('*')) {
      const [pw, ph] = pSpec.split('*');
      pool = candidates.filter(r => {
        const rSpec = normalizeSpec(r.spec);
        const rParts = rSpec.split('*');
        if (rParts.length < 2) return false;
        // 앞 두 차원 일치 (W*H 가 같음)
        if (rParts[0] === pw && rParts[1] === ph) return true;
        // 가로세로 뒤집힌 경우도 허용
        if (rParts[0] === ph && rParts[1] === pw) return true;
        return false;
      });
      if (pool.length > 0) specMatchType = 'partial3d';
    }
    // 사이즈 fuzzy 매칭 (학습풀에 살짝 다른 사이즈 있을때)
    // 큰 차원 기준 — 한쪽 변이 크면 다른쪽도 관대
    if (pool.length === 0 && pSpec.includes('*')) {
      const [pw, ph] = pSpec.split('*').map(Number);
      const maxDim = Math.max(pw, ph);
      // tolerance: <1000 → 50mm / 1000-2000 → 5% / 2000-4000 → 8% / 4000+ → 10%
      let tol;
      if (maxDim < 1000) tol = 50;
      else if (maxDim < 2000) tol = Math.max(50, Math.round(maxDim * 0.05));
      else if (maxDim < 4000) tol = Math.max(150, Math.round(maxDim * 0.08));
      else tol = Math.max(300, Math.round(maxDim * 0.10));
      pool = candidates.filter(r => {
        const rSpec = normalizeSpec(r.spec);
        const m = rSpec.match(/^(\d+)\*(\d+)/);
        if (!m) return false;
        const rw = Number(m[1]), rh = Number(m[2]);
        if (Math.abs(rw - pw) <= tol && Math.abs(rh - ph) <= tol) return true;
        if (Math.abs(rw - ph) <= tol && Math.abs(rh - pw) <= tol) return true;
        return false;
      });
      if (pool.length > 0) specMatchType = 'fuzzy';
    }
    // 1차에서 사이즈 못 찾으면 OCR 추론 카테고리로 후보 풀 다시 만들고 재시도
    if (pool.length === 0 && tryAlternate) {
      const altCandidates = allCandidates
        .filter(r => categorizeRow(r.item, r.spec) === inferredCat)
        .filter(r => !usedKeys.has(companySaleRowKey(r)));
      pool = altCandidates.filter(r => normalizeSpec(r.spec) === pSpec);
      if (pool.length === 0 && pSpec.includes('*')) {
        const [a, b] = pSpec.split('*');
        const flipped = `${b}*${a}`;
        pool = altCandidates.filter(r => normalizeSpec(r.spec) === flipped);
        if (pool.length > 0) specMatchType = 'flipped+altcat';
      }
      if (pool.length === 0 && pSpec.includes('*')) {
        const [pw, ph] = pSpec.split('*');
        pool = altCandidates.filter(r => {
          const rSpec = normalizeSpec(r.spec);
          const rParts = rSpec.split('*');
          if (rParts.length < 2) return false;
          if (rParts[0] === pw && rParts[1] === ph) return true;
          if (rParts[0] === ph && rParts[1] === pw) return true;
          return false;
        });
        if (pool.length > 0) specMatchType = 'partial3d+altcat';
      }
      if (pool.length > 0) {
        didAlternate = true;
        specMatchType = specMatchType.includes('altcat') ? specMatchType : (specMatchType + '+altcat');
      }
    }
    if (pool.length === 0) {
      // ─── 비고 매칭 (사장님 합의 룰) ────────────────────
      // 매출 행의 비고/비고_세부에 시안 사이즈가 적혀있으면 그 매출에 매핑
      // 예: 시안 240*80 시트 → 매출 절연장갑보관함 비고 "240*80*2장씩 들어감"
      const pSpecPatterns = [
        p.spec.replace('*', '*'),
        p.spec.replace('*', 'x'),
        p.spec.replace('*', '×'),
        p.spec.replace('*', ' x '),
      ];
      const memoMatch = allCandidates.find(r => {
        if (usedKeys.has(companySaleRowKey(r))) return false;
        const memoText = String(r.memo || '') + ' ' + String(r.memoDetail || '');
        return pSpecPatterns.some(pat => memoText.includes(pat));
      });
      if (memoMatch) {
        matches.push({
          ocrFragment: p.raw,
          extractedSpec: p.spec,
          extractedMaterials: p.materials,
          extractedThickness: p.thickness,
          extractedQty: p.qty,
          matched: memoMatch,
          score: 80,
          reason: `매출비고에 사이즈(${p.spec}) 명기됨 → 통합매출`,
        });
        usedKeys.add(companySaleRowKey(memoMatch));
        continue;
      }
      matches.push({ ocrFragment: p.raw, extractedSpec: p.spec, extractedMaterials: p.materials, extractedQty: p.qty, matched: null, score: 0, reason: '사이즈 후보 없음' });
      continue;
    }

    // 점수 계산: 재질, 두께, 수량
    const scored = pool.map(r => {
      let score = 50; // 사이즈 일치만으로 기본 50
      let specLabel = '규격일치';
      if (specMatchType === 'partial3d') specLabel = '규격일치(W*H)';
      else if (specMatchType === 'flipped') specLabel = '규격일치(회전)';
      else if (specMatchType === 'fuzzy') specLabel = '규격유사(±50mm)';
      else if (specMatchType.includes('altcat')) specLabel = '규격일치(타카테고리)';
      const reason = [specLabel];
      // 정확 일치 외에는 살짝 감점 (감점폭 줄여서 매칭률 향상)
      if (specMatchType === 'partial3d') score -= 3;
      else if (specMatchType === 'fuzzy') score -= 5;
      else if (specMatchType.includes('altcat')) score -= 3;
      const rCat = itemCategory(r.item);
      const rName = norm(r.item);

      // 재질 카테고리 매칭 (정확)
      let matMatched = false;
      if (rCat && p.materials.includes(rCat)) {
        score += 30;
        reason.push(`재질:${rCat}`);
        matMatched = true;
      }
      // 재질 키워드 부분 일치 (학습풀 품명에 OCR 추출 재질 포함)
      // 예: 학습풀 "철판자립+축광시트" + OCR materials=['철판'] → 철판 부분일치
      if (!matMatched) {
        for (const mat of p.materials) {
          const matN = norm(mat);
          if (matN && rName.includes(matN)) {
            score += 20;
            reason.push(`재질부분:${mat}`);
            matMatched = true;
            break;
          }
        }
      }
      // 양면/단면 구분
      const ocrLine = (p.raw || '').toLowerCase();
      const wantsDouble = /양면/.test(ocrLine) || /양판/.test(ocrLine);
      const wantsSingle = /단면/.test(ocrLine);
      const rIsDouble = /양면|양판/.test(rName);
      const rIsSingle = /단면/.test(rName);
      if (wantsDouble && rIsDouble) { score += 15; reason.push('양면일치'); }
      else if (wantsSingle && rIsSingle) { score += 15; reason.push('단면일치'); }
      else if (wantsDouble && rIsSingle) { score -= 15; reason.push('양면X단면'); }
      else if (wantsSingle && rIsDouble) { score -= 15; reason.push('단면X양면'); }

      // 두께 매칭 (예: OCR "3T" + 학습풀 "3t 포맥스")
      if (p.thickness && rName.includes(p.thickness)) {
        score += 15;
        reason.push(`두께:${p.thickness}`);
      }

      // 수량 매칭
      if (p.qty != null && r.qty != null && Number(r.qty) === p.qty) {
        score += 25;
        reason.push(`수량:${p.qty}`);
      }

      return { row: r, score, reason: reason.join(',') };
    }).sort((a, b) => b.score - a.score);

    // 매칭 임계값: 정확 사이즈 일치(같은 일자) 면 재질 없어도 50점 매칭 인정 (사용자 검수)
    // fuzzy 매칭은 60점 이상이어야 매칭 (확신 더 필요)
    const isExactSpec = (specMatchType === 'exact' || specMatchType === 'flipped' || specMatchType === 'partial3d' || specMatchType.includes('altcat'));
    const threshold = isExactSpec ? 50 : 60;
    const best = scored[0];
    if (best && best.score >= threshold) {
      const key = companySaleRowKey(best.row);
      if (!usedKeys.has(key)) {
        matches.push({
          ocrFragment: p.raw,
          extractedSpec: p.spec,
          extractedMaterials: p.materials,
          extractedThickness: p.thickness,
          extractedQty: p.qty,
          matched: best.row,
          score: best.score,
          reason: best.reason,
        });
        usedKeys.add(key);
      } else {
        // 이미 사용된 행 - 차순위 매칭
        const next = scored.find(s => s.score >= threshold && !usedKeys.has(companySaleRowKey(s.row)));
        if (next) {
          matches.push({
            ocrFragment: p.raw,
            extractedSpec: p.spec,
            extractedMaterials: p.materials,
            extractedThickness: p.thickness,
            extractedQty: p.qty,
            matched: next.row,
            score: next.score,
            reason: next.reason,
          });
          usedKeys.add(companySaleRowKey(next.row));
        } else {
          // (제거: N:1 평균치 매핑 — 사용자 협의 없이 추가했던 강제 룰)
          matches.push({
            ocrFragment: p.raw,
            extractedSpec: p.spec,
            extractedMaterials: p.materials,
            extractedThickness: p.thickness,
            extractedQty: p.qty,
            matched: null,
            score: best.score,
            reason: '사이즈일치하나 이미 매칭됨',
          });
        }
      }
    } else {
      // 점수미달 fallback: 비고 매칭 시도
      const pSpecPatterns = [
        p.spec,
        p.spec.replace('*', 'x'),
        p.spec.replace('*', '×'),
      ];
      const memoMatch = allCandidates.find(r => {
        if (usedKeys.has(companySaleRowKey(r))) return false;
        const memoText = String(r.memo || '') + ' ' + String(r.memoDetail || '');
        return pSpecPatterns.some(pat => memoText.includes(pat));
      });
      if (memoMatch) {
        matches.push({
          ocrFragment: p.raw,
          extractedSpec: p.spec,
          extractedMaterials: p.materials,
          extractedThickness: p.thickness,
          extractedQty: p.qty,
          matched: memoMatch,
          score: 80,
          reason: `매출비고에 사이즈(${p.spec}) 명기됨 → 통합매출`,
        });
        usedKeys.add(companySaleRowKey(memoMatch));
        continue;
      }
      matches.push({
        ocrFragment: p.raw,
        extractedSpec: p.spec,
        extractedMaterials: p.materials,
        extractedThickness: p.thickness,
        extractedQty: p.qty,
        matched: null,
        score: best ? best.score : 0,
        reason: best ? best.reason + '(점수미달)' : '후보없음',
      });
    }
  }

  // ─── 후처리: 메인 제품에 포함된 부속 무시 (사장님 합의 룰) ────
  // 슬라이드에 매칭된 메인 제품(큰 면적)이 있고, 같은 슬라이드의 다른 미매칭 라인 면적이
  // 메인의 30% 이하면 → "메인에 포함된 부속" 으로 자동 처리.
  const matchedMains = matches.filter(m => m.matched);
  if (matchedMains.length > 0) {
    // 가장 큰 매칭 면적 찾기 (메인 추정)
    let mainArea = 0;
    let mainObj = null;
    for (const m of matchedMains) {
      const sp = String(m.matched.spec || '').replace(/\s/g, '');
      const dims = sp.match(/(\d+)/g);
      if (dims && dims.length >= 2) {
        const area = Number(dims[0]) * Number(dims[1]);
        if (area > mainArea) { mainArea = area; mainObj = m.matched; }
      }
    }
    if (mainArea >= 1000000 && mainObj) {  // 메인 면적 >= 1m² (1000*1000)
      for (const m of matches) {
        if (m.matched) continue;
        if (!m.extractedSpec || !m.extractedSpec.includes('*')) continue;
        const [w, h] = m.extractedSpec.split('*').map(Number);
        const area = (w || 0) * (h || 0);
        if (area > 0 && area <= mainArea * 0.3) {
          m.matched = mainObj;
          m.score = 60;
          m.reason = '메인 제품에 포함된 부속 (자동 무시)';
        }
      }
    }
  }

  return {
    extracted: products.length,
    matchedCount: matches.filter(m => m.matched).length,
    matches,
  };
}

// 신규 PPTX 시안 → 컴퍼니 매출 매칭 (matchOcrTextToPool 사용 — 91.2% 매칭률)
// statements.js 가 사용. 라인별 매칭 + 묶음/메모/현장명 룰 적용
// 반환 형식: { matched, score, reason, candidateCount, exactSpecCount, candidates, allMatches }
function matchPptxSlideToCompanySales(slideText, opts = {}) {
  const r = matchOcrTextToPool(String(slideText || ''), {
    dateStr: opts.dateStr || opts.altDateStr || '',
    dayBack: opts.dayBack ?? Math.max(1, opts.dayRange || 0),
    dayForward: opts.dayForward ?? Math.max(3, opts.dayRange || 0),
    pptxCategory: opts.pptxCategory || null,
    excludeKeys: opts.excludeKeys || new Set(),
  });
  const matchedLines = (r.matches || []).filter(m => m.matched);
  const first = matchedLines[0] || null;
  return {
    matched: first ? first.matched : null,
    score: first ? first.score : 0,
    reason: first ? first.reason : ((r.matches || [])[0]?.reason || '매칭없음'),
    candidateCount: (r.matches || []).length,
    exactSpecCount: matchedLines.length,
    candidates: matchedLines.slice(0, 5).map(m => ({ row: m.matched, score: m.score, reason: m.reason })),
    matchedSite: r.matchedSite || null,
    allMatches: r.matches || [],
  };
}

// 컴퍼니 매출 라인 1개 매칭 — AI 결과 + 카테고리 + 일자 + 거래처힌트 + 텍스트힌트 종합 (LEGACY)
function matchCompanySaleItem(aiItem, opts = {}) {
  const dateStr = opts.dateStr || opts.altDateStr || '';
  const dayRange = opts.dayRange ?? 0;
  const excludeKeys = opts.excludeKeys || new Set();
  const pptxCategory = opts.pptxCategory || null;
  const textHint = (opts.textHint || '').toLowerCase();
  const vendorHint = opts.vendorHint || '';

  // 후보 풀 — 같은 일자 ±N일
  let candidates = getRegisteredByDate(dateStr, { dayRange });
  // 트레이딩 매출은 PPTX 매칭 제외 (공장 제작이 아니라 매입후 매출이라 시안 없음)
  candidates = candidates.filter(r => categorizeRow(r.item, r.spec) !== '트레이딩');
  // 카테고리 필터 (출력물 PPTX → 출력물 행만, 용접물 PPTX → 용접물 행만)
  if (pptxCategory) {
    candidates = candidates.filter(r => categorizeRow(r.item, r.spec) === pptxCategory);
  }
  // 이미 사용된 행 제외
  candidates = candidates.filter(r => !excludeKeys.has(companySaleRowKey(r)));

  const aiSpec = normalizeSpec(aiItem.spec);
  const aiName = norm(aiItem.item_name);
  const aiTokens = tokens(aiItem.item_name);
  const aiCategory = itemCategory(aiItem.item_name);
  const exactSpec = candidates.filter(r => normalizeSpec(r.spec) === aiSpec && aiSpec);

  // 점수 계산
  const scored = candidates.map(r => {
    let score = 0;
    let reason = [];
    const rSpec = normalizeSpec(r.spec);
    const rName = norm(r.item);
    const rCategory = itemCategory(r.item);
    if (aiSpec && rSpec === aiSpec) { score += 50; reason.push('규격일치'); }
    if (aiName && rName === aiName) { score += 60; reason.push('품명일치'); }
    if (aiName && (rName.includes(aiName) || aiName.includes(rName))) { score += 30; reason.push('품명포함'); }
    // 카테고리 매칭 (A형/포맥스/스티커 등 통일 매칭)
    if (aiCategory && rCategory && aiCategory === rCategory) { score += 25; reason.push(`카테고리:${aiCategory}`); }
    // 토큰 매칭
    const rTokens = tokens(r.item);
    const tokenMatch = aiTokens.filter(t => rTokens.includes(t)).length;
    if (tokenMatch > 0) { score += tokenMatch * 5; reason.push(`토큰${tokenMatch}개`); }
    // 텍스트 힌트 (시안 텍스트에 등록행 품목/규격이 있는지)
    if (textHint && (textHint.includes(rName) || textHint.includes(rSpec))) {
      score += 15; reason.push('텍스트힌트');
    }
    // 거래처 힌트
    if (vendorHint && r.vendor && norm(r.vendor).includes(norm(vendorHint))) {
      score += 10; reason.push('거래처힌트');
    }
    return { row: r, score, reason: reason.join(',') };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  const matched = (best && best.score >= 30) ? best.row : null;

  return {
    matched,
    score: best ? best.score : 0,
    reason: best ? best.reason : '후보없음',
    candidateCount: candidates.length,
    exactSpecCount: exactSpec.length,
    candidates: scored.slice(0, 5),
  };
}

// ─── 매입 매칭 (매입명세서 라인 → 학습풀 매입 이력) ─────────
//
// OCR 결과 라인 1개를 받아서 학습풀의 매입 이력 중 가장 비슷한 것을 찾음.
// 거래처 정규화 적용 (이노텍 ↔ 이노사인 통합).
//
// 입력:
//   ocrLine = { ocr_text, qty?, unit_price?, supply_amt? }
//   opts    = { vendor, dateStr, dayRange = 30 }
//
// 출력:
//   {
//     matched: { date, vendor, item, spec, qty, price, amount } | null,
//     score: 0~150,
//     reason: 매칭 사유 문자열,
//     candidates: top 5 후보,
//   }
function matchPurchaseLineToPool(ocrLine, opts = {}) {
  const buy = pool.COMPANY_매입;
  const vendorAlias = normalizeVendorKey(opts.vendor || '');
  const dayRange = (opts.dayRange != null) ? opts.dayRange : 30;

  // 1) 거래처 후보 풀
  let candidates = [];
  if (vendorAlias && buy.byVendorAlias.has(vendorAlias)) {
    candidates = [...buy.byVendorAlias.get(vendorAlias)];
  } else if (opts.vendor && buy.byVendor.has(opts.vendor)) {
    candidates = [...buy.byVendor.get(opts.vendor)];
  }
  // 거래처 못 찾으면 fallback: 같은 일자 매입 전체
  if (candidates.length === 0 && opts.dateStr && buy.byDate.has(opts.dateStr)) {
    candidates = [...buy.byDate.get(opts.dateStr)];
  }

  if (candidates.length === 0) {
    return { matched: null, score: 0, reason: '거래처 후보 없음', candidates: [] };
  }
  const vendorCandidates = [...candidates];

  // 2) 일자 범위 필터 (선택)
  if (opts.dateStr && dayRange > 0) {
    const target = new Date(opts.dateStr).getTime();
    const dateCandidates = candidates.filter(c => {
      if (!c.date) return true;
      const d = new Date(c.date).getTime();
      return Math.abs(d - target) <= dayRange * 24 * 60 * 60 * 1000;
    });
    candidates = dateCandidates.length ? dateCandidates : vendorCandidates;
  }

  // 3) ocr_text 정규화 (노이즈 제거)
  const ocrRaw = String(ocrLine.ocr_text || '').trim();
  const ocrN = norm(ocrRaw);
  // OCR 텍스트에서 규격 패턴 추출 (예: 1270mmX61m, 3T 1220mmX2440mm)
  const ocrSpecMatch = ocrRaw.match(/(\d+(?:t|mm|cm|m|\.|\*|x|×|×)\s*[\dt\.\*xmc×× ]+)/i);
  const ocrSpec = ocrSpecMatch ? ocrSpecMatch[0].trim() : '';
  const ocrSpecN = ocrSpec ? normalizeSpec(ocrSpec) : '';
  const pipeSizeFromText = (text) => {
    const s = String(text || '').toLowerCase();
    const dim = s.match(/(\d{2,3})\s*(?:\*|x|×)\s*\1/);
    if (dim) return dim[1];
    const gak = s.match(/(\d{2,3})\s*각/);
    if (gak) return gak[1];
    return '';
  };
  const ocrPipeSize = pipeSizeFromText(ocrRaw);
  const ocrIsPipe = /파이프/.test(ocrRaw) || /pipe/i.test(ocrRaw);
  const ocrIsGalv = /아연|galv|zinc/i.test(ocrRaw);

  // 4) 후보 점수 계산
  const scored = candidates.map(r => {
    let score = 0;
    const reason = [];

    // 품명 매칭
    const itemN = norm(r.item || '');
    if (itemN && ocrN) {
      if (itemN === ocrN) { score += 100; reason.push('품명일치'); }
      else if (ocrN.includes(itemN) || itemN.includes(ocrN)) {
        // 한쪽이 다른쪽 포함 (예: OCR "(IT)무광코팅지/IL-8014MF" ⊂ 학습풀 "무광코팅지/120")
        score += 70; reason.push('품명포함');
      } else {
        // token overlap fuzzy
        const tokens1 = new Set(itemN.split(/[/\-_+]/).filter(t => t.length >= 2));
        const tokens2 = new Set(ocrN.split(/[/\-_+]/).filter(t => t.length >= 2));
        let overlap = 0;
        for (const t of tokens1) if (tokens2.has(t)) overlap++;
        if (overlap >= 1) {
          score += 30 + overlap * 10;
          reason.push(`품명유사(${overlap}토큰)`);
        }
      }
    }

    const rowText = `${r.item || ''} ${r.spec || ''}`;
    const rowPipeSize = pipeSizeFromText(rowText);
    const rowIsPipe = /파이프/.test(rowText) || /pipe/i.test(rowText);
    const rowIsGalv = /아연|galv|zinc/i.test(rowText);
    if (ocrIsPipe && rowIsPipe) { score += 25; reason.push('파이프'); }
    if (ocrIsGalv && rowIsGalv) { score += 15; reason.push('아연'); }
    if (ocrPipeSize && rowPipeSize && ocrPipeSize === rowPipeSize) {
      score += 55;
      reason.push(`${ocrPipeSize}각`);
    }

    // 규격 매칭
    const specN = normalizeSpec(r.spec || '');
    if (specN && ocrSpecN) {
      if (specN === ocrSpecN) { score += 30; reason.push('규격일치'); }
      else if (specN.includes(ocrSpecN) || ocrSpecN.includes(specN)) {
        score += 15; reason.push('규격포함');
      }
    }

    // 단가 매칭 (강력한 신호 — 같은 품목은 단가 일정)
    const ocrPrice = Number(ocrLine.unit_price) || 0;
    const rPrice = Number(r.price) || 0;
    if (ocrPrice > 0 && rPrice > 0) {
      if (ocrPrice === rPrice) { score += 20; reason.push('단가일치'); }
      else if (Math.abs(ocrPrice - rPrice) / Math.max(ocrPrice, rPrice) < 0.05) {
        score += 10; reason.push('단가근사');
      }
    }

    // 수량 매칭 (보조)
    const ocrQty = Number(ocrLine.qty) || 0;
    const rQty = Number(r.qty) || 0;
    if (ocrQty > 0 && rQty > 0 && ocrQty === rQty) {
      score += 5; reason.push('수량일치');
    }

    return { row: r, score, reason: reason.join(',') };
  }).sort((a, b) => b.score - a.score);

  const best = scored[0];
  // 임계값 50 이상 (품명포함 70 / 토큰2개+규격일치 80 / 정확일치 100+)
  const threshold = 50;
  if (best && best.score >= threshold) {
    return {
      matched: best.row, score: best.score, reason: best.reason,
      candidates: scored.slice(0, 5).map(s => ({ ...s.row, score: s.score, reason: s.reason })),
    };
  }
  return {
    matched: null,
    score: best ? best.score : 0,
    reason: best ? `점수미달(${best.score}<${threshold}): ${best.reason}` : '후보 점수 0',
    candidates: scored.slice(0, 5).map(s => ({ ...s.row, score: s.score, reason: s.reason })),
  };
}

module.exports = {
  load,
  getStats,
  getQuadrant,
  getContext,
  findVendor,
  findItem,
  getCombosForVendor,
  getRegisteredByDate,
  getRegisteredByDateAndCategory,
  categorizePptx,
  categorizeRow,
  itemCategory,
  matchCompanySaleItem,
  matchPptxSlideToCompanySales,
  matchOcrTextToPool,
  matchPurchaseLineToPool,
  matchSlideToProductMaster,
  normalizeItemName,
  extractOptionsFromText,
  getProductMasterStats,
  addCompanyPurchaseLearned,
  addCompanySaleLearned,
  getLearningAdditionsStats,
  extractProductsFromOcr,
  extractSiteFromOcr,
  companySaleRowKey,
  normalizeSpec,
  normalizeVendorKey,
  toIsoDate,
  pool,
};
