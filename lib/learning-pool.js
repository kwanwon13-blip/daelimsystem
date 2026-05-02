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

function tokens(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[×xX]/g, '*')
    .split(/[^0-9a-z가-힣ㄱ-ㅎㅏ-ㅣ一-龥\u0E00-\u0E7F\u1000-\u109F]+/g)
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !/^\d+$/.test(t));
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

// 시안 일자 → 같은 일자(±N일)의 실제 등록 행들
// PPTX 시안 처리 시 학습 정답으로 활용
function getRegisteredByDate(dateStr, options = {}) {
  const q = pool.COMPANY_매출;
  if (!q.byDate || !dateStr) return [];
  const targetDate = new Date(dateStr);
  if (isNaN(targetDate)) return [];
  const dayRange = options.dayRange ?? 14;  // ±14일 안의 등록 행
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
  // 일자 차이가 적은 거 우선
  return matches.sort((a, b) => Math.abs(a.dayDiff) - Math.abs(b.dayDiff));
}

// 같은 규격 (예: 600*900) 실제 등록 행
function getRegisteredBySpec(spec) {
  const q = pool.COMPANY_매출;
  if (!q.bySpec || !spec) return [];
  const specKey = normalizeSpec(spec);
  return (q.bySpec.get(specKey) || []).slice(0, 30);
}

function scoreCompanySaleRow(row, aiItem = {}, options = {}) {
  const aiName = norm(aiItem.item_name || aiItem.name || '');
  const rowName = norm(row.item || '');
  const aiSpec = normalizeSpec(aiItem.spec || aiItem.규격 || '');
  const rowSpec = normalizeSpec(row.spec || '');
  const hintNorm = norm(options.textHint || '');
  const hintSpec = normalizeSpec(options.textHint || '');
  const vendorHint = norm(options.vendorHint || '');
  const rowVendor = norm(row.vendor || '');
  const aiQty = Number(aiItem.quantity || aiItem.qty || aiItem.수량 || 0);
  const rowQty = Number(row.qty || 0);

  let score = 0;
  const reasons = [];

  if (aiSpec && rowSpec && aiSpec === rowSpec) {
    score += 130;
    reasons.push('규격일치');
  } else if (rowSpec && hintSpec.includes(rowSpec)) {
    score += 70;
    reasons.push('시안텍스트-규격');
  }

  if (aiName && rowName) {
    if (aiName === rowName) {
      score += 100;
      reasons.push('품명일치');
    } else if (rowName.includes(aiName) || aiName.includes(rowName)) {
      const genericPartial = aiName.includes(rowName) && rowName.length < Math.max(6, aiName.length * 0.55);
      score += genericPartial ? 28 : 70;
      reasons.push('품명부분일치');
    }

    let overlap = 0;
    for (const t of tokens(aiItem.item_name || aiItem.name || '')) {
      if (rowName.includes(norm(t))) overlap++;
    }
    if (overlap > 0) {
      const add = Math.min(70, overlap * 18);
      score += add;
      reasons.push(`품명토큰${overlap}`);
    }
  }

  if (hintNorm && rowName) {
    if (hintNorm.includes(rowName)) {
      score += rowName.length >= 7 ? 80 : 25;
      reasons.push('시안텍스트-품명');
    }

    let overlap = 0;
    for (const t of tokens(row.item || '')) {
      if (hintNorm.includes(norm(t))) overlap++;
    }
    if (overlap > 0) {
      const add = Math.min(65, overlap * 14);
      score += add;
      reasons.push(`시안토큰${overlap}`);
    }
  }

  if (aiQty && rowQty && Math.abs(aiQty - rowQty) < 0.0001) {
    score += 25;
    reasons.push('수량일치');
  }
  if (vendorHint && rowVendor && (rowVendor.includes(vendorHint) || vendorHint.includes(rowVendor))) {
    score += 20;
    reasons.push('거래처일치');
  }
  if (typeof row.dayDiff === 'number') {
    if (row.dayDiff === 0) {
      score += 20;
      reasons.push('동일일자');
    } else {
      score -= Math.min(35, Math.abs(row.dayDiff) * 5);
      reasons.push(`일자${row.dayDiff > 0 ? '+' : ''}${row.dayDiff}`);
    }
  }
  if (Number(row.price) > 0 || Number(row.amount) > 0) score += 5;

  return { row, score, reasons };
}

function matchCompanySaleItem(aiItem = {}, options = {}) {
  const dayRange = options.dayRange ?? 0;
  const excludeKeys = options.excludeKeys || null;
  let candidates = [];
  if (options.dateStr) candidates = getRegisteredByDate(options.dateStr, { dayRange });
  if (candidates.length === 0 && options.altDateStr && options.altDateStr !== options.dateStr) {
    candidates = getRegisteredByDate(options.altDateStr, { dayRange });
  }
  if (candidates.length === 0 && (aiItem.spec || aiItem.규격)) {
    candidates = getRegisteredBySpec(aiItem.spec || aiItem.규격);
  }
  if (excludeKeys && excludeKeys.size > 0) {
    candidates = candidates.filter(r => !excludeKeys.has(companySaleRowKey(r)));
  }

  const aiSpec = normalizeSpec(aiItem.spec || aiItem.규격 || '');
  const exactSpec = aiSpec ? candidates.filter(r => normalizeSpec(r.spec) === aiSpec) : [];
  const poolToScore = exactSpec.length > 0 ? exactSpec : candidates;
  const scored = poolToScore
    .map(r => scoreCompanySaleRow(r, aiItem, options))
    .sort((a, b) => b.score - a.score)
    .slice(0, 10);

  const best = scored[0] || null;
  const second = scored[1] || null;
  const uniqueExactSpec = exactSpec.length === 1;
  const threshold = uniqueExactSpec ? 120 : 150;
  const ambiguous = !!(best && second && best.score - second.score < 12 && best.score < 210);
  const exactSpecTie = !!(best && second && exactSpec.length > 1 && best.score - second.score < 18);

  if (!best || best.score < threshold || ambiguous || exactSpecTie) {
    return {
      matched: null,
      score: best ? best.score : 0,
      reason: !best ? 'no_candidate' : ((ambiguous || exactSpecTie) ? 'ambiguous' : 'low_score'),
      candidates: scored,
      candidateCount: candidates.length,
      exactSpecCount: exactSpec.length,
    };
  }

  return {
    matched: best.row,
    score: best.score,
    reason: best.reasons.join(', '),
    candidates: scored,
    candidateCount: candidates.length,
    exactSpecCount: exactSpec.length,
  };
}

// 시안 분석용 종합 컨텍스트 (일자 기반)
// 같은 일자 ±14일 + 거래처 매칭하는 실제 등록 행 보여줌
function getSlideContext(dateStr, vendorHint) {
  const q = pool.COMPANY_매출;
  const lines = [];

  // 1. 같은 일자 등록 행 (정답 패턴)
  const sameDate = getRegisteredByDate(dateStr, { dayRange: 7 });
  if (sameDate.length > 0) {
    lines.push(`\n[같은 일자(±7일) 컴퍼니 매출 실제 등록 — 정답 패턴]`);
    for (const r of sameDate.slice(0, 40)) {
      lines.push(`  ${r.date} | ${r.vendor} | ${r.item} | 규격 ${r.spec} | 수량 ${r.qty}`);
    }
    if (sameDate.length > 40) lines.push(`  ... 외 ${sameDate.length - 40}건`);
  }

  // 2. 거래처별 자주 쓰는 결합 (있으면)
  if (vendorHint) {
    const combos = getCombosForVendor(vendorHint);
    if (combos.length > 0) {
      lines.push(`\n[${vendorHint} 자주 등록되는 결합 품명]`);
      for (const c of combos.slice(0, 10)) {
        lines.push(`  ${c.count}회: ${c.item}`);
      }
    }
  }

  return lines.length ? lines.join('\n') : '';
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
  getRegisteredBySpec,
  matchCompanySaleItem,
  normalizeSpec,
  companySaleRowKey,
  getSlideContext,
  pool,
};
