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
