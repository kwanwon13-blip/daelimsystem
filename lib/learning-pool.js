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
  COMPANY_매입: { vendors: new Map(), items: new Map(), rows: 0 },
  COMPANY_매출: {
    vendors: new Map(), items: new Map(), combos: new Map(), rows: 0,
    byDate: new Map(),       // YYYY-MM-DD → [실제 등록행 배열]
    byVendor: new Map(),     // 거래처 → [실제 등록행]
    bySpec: new Map(),       // 규격 → [실제 등록행]
  },
};

function newQuadrants() {
  return {
    SM_매입: { vendors: new Map(), items: new Map(), codes: new Map(), rows: 0 },
    SM_매출: { vendors: new Map(), items: new Map(), codes: new Map(), projects: new Map(), rows: 0 },
    COMPANY_매입: { vendors: new Map(), items: new Map(), rows: 0 },
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
  ];
  for (const kw of weldKeywords) {
    if (text.includes(kw.toLowerCase().replace(/\s+/g, ''))) return '용접물';
  }
  // 2) 트레이딩 키워드 (매입후매출 — PPTX 매칭 제외)
  const tradingKeywords = [
    '휀스', '펜스', '앙카베이스', '앙카',
    '파이프', '호이스트', '시멘지주', '시멘트지주',
    '쓰레기통', 'u고리', '폼보드', '타포린',
    '운반비', '택배비', '운임비', '화물비',
    '인건비', '설치비', '제판비', '인쇄비',
    '안전모식별', '안전화', '안전조끼', '안전장갑',
    '방진마스크', '방한', '핫팩', '각반',
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
  // 컴퍼니-매입매출.xlsx 한 파일에 매입+매출 둘 다
  const fp = path.join(LEARNING_DIR, '04_컴퍼니매출', 'data', '컴퍼니-매입매출.xlsx');
  if (!trackFile('컴퍼니 매입/매출', fp, true)) {
    console.log('[learning-pool] 컴퍼니 매입매출 파일 없음:', fp);
    return;
  }
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(fp);
  const ws = wb.worksheets[0];
  const buy = pool.COMPANY_매입;
  const sell = pool.COMPANY_매출;
  let i = 0;
  ws.eachRow((row) => {
    i++;
    if (i === 1) return;  // 헤더
    const vals = row.values;
    // [_, 일자, 거래처, 품목약어, 품명, 규격, 매입수량, 매출수량, 단가, 매입금액, 매입세액, 매입합계, 매출금액, 매출세액, 매출합계]
    const dateRaw = vals[1];
    const vendor = vals[2];
    const item = vals[4];
    const spec = vals[5];
    const qty = vals[7];   // 매출수량
    const price = vals[8];
    const amount = vals[12]; // 매출금액
    if (!vendor || item === '전표합계') return;
    if (vals[6]) {  // 매입수량
      buy.rows++;
      inc(buy.vendors, vendor);
      if (item) inc(buy.items, item);
    }
    if (qty) {  // 매출수량
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
      const rowData = { date: dateStr, vendor, item, spec: spec || '', qty, price, amount };
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
  console.log(`[learning-pool] 컴퍼니 매입 ${buy.rows}행 / 매출 ${sell.rows}행 로드 (일자 ${sell.byDate.size}일 / 규격 ${sell.bySpec.size}종)`);
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
function getRegisteredByDate(dateStr, options = {}) {
  const q = pool.COMPANY_매출;
  if (!q.byDate || !dateStr) return [];
  const targetDate = new Date(dateStr);
  if (isNaN(targetDate)) return [];
  const dayRange = options.dayRange ?? 14;
  const matches = [];
  for (const [d, rows] of q.byDate.entries()) {
    const dt = new Date(d);
    if (isNaN(dt)) continue;
    const diff = Math.abs((dt - targetDate) / 86400000);
    if (diff <= dayRange) {
      for (const r of rows) {
        matches.push({ ...r, dayDiff: Math.round((dt - targetDate) / 86400000) });
      }
    }
  }
  return matches.sort((a, b) => Math.abs(a.dayDiff) - Math.abs(b.dayDiff));
}

// ─── OCR 텍스트 → 제품 후보 추출 ─────────────────
// 시안 이미지에 보통 5~7개 제품이 함께 들어가 있음. OCR 텍스트에서 (사이즈, 재질, 두께, 수량)
// 패턴을 모두 뽑아서 각각 학습풀과 매칭한다.
function extractProductsFromOcr(ocrText) {
  if (!ocrText) return [];
  // 줄바꿈 + 슬래시(/) + 콤마로 분할 — 한 슬라이드의 여러 제품 잡기
  const fragments = String(ocrText).split(/[\n\r]+/).map(s => s.trim()).filter(Boolean);
  const products = [];
  const seen = new Set(); // 중복 제품 (앞면/뒷면 같은) 방지

  for (const line of fragments) {
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

      const dedupKey = `${spec}|${materials.join(',')}|${thickness || ''}|${qty || ''}`;
      if (seen.has(dedupKey)) continue;
      seen.add(dedupKey);

      products.push({
        raw: line,
        spec,
        materials,
        thickness,
        qty,
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

  // 후보 풀: 같은 일자 (트레이딩 제외)
  let allCandidates = getRegisteredByDate(dateStr, { dayRange });
  allCandidates = allCandidates.filter(r => categorizeRow(r.item, r.spec) !== '트레이딩');

  const products = extractProductsFromOcr(ocrText);
  const matches = [];

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
    return null; // 모르면 fallback
  }

  for (const p of products) {
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
    // 사이즈 ±50mm fuzzy 매칭 (학습풀에 살짝 다른 사이즈 있을때)
    if (pool.length === 0 && pSpec.includes('*')) {
      const [pw, ph] = pSpec.split('*').map(Number);
      pool = candidates.filter(r => {
        const rSpec = normalizeSpec(r.spec);
        const m = rSpec.match(/^(\d+)\*(\d+)/);
        if (!m) return false;
        const rw = Number(m[1]), rh = Number(m[2]);
        const dw = Math.abs(rw - pw);
        const dh = Math.abs(rh - ph);
        // 50mm 이내, 또는 1% 이내 차이 (큰 사이즈일수록 관대하게)
        const tolW = Math.max(50, pw * 0.02);
        const tolH = Math.max(50, ph * 0.02);
        if (dw <= tolW && dh <= tolH) return true;
        // 회전된 경우도
        if (Math.abs(rw - ph) <= tolH && Math.abs(rh - pw) <= tolW) return true;
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
      // 정확 일치 외에는 약간 감점
      if (specMatchType === 'partial3d') score -= 5;
      else if (specMatchType === 'fuzzy') score -= 10;
      else if (specMatchType.includes('altcat')) score -= 5;
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

    const best = scored[0];
    if (best && best.score >= 60) {
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
        const next = scored.find(s => s.score >= 60 && !usedKeys.has(companySaleRowKey(s.row)));
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

  return {
    extracted: products.length,
    matchedCount: matches.filter(m => m.matched).length,
    matches,
  };
}

// 컴퍼니 매출 라인 1개 매칭 — AI 결과 + 카테고리 + 일자 + 거래처힌트 + 텍스트힌트 종합
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
  matchOcrTextToPool,
  extractProductsFromOcr,
  companySaleRowKey,
  normalizeSpec,
  toIsoDate,
  pool,
};
