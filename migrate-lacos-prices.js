/**
 * migrate-lacos-prices.js
 * 실행: node migrate-lacos-prices.js
 *
 * 라코스(주)삼성라코스산업안전) 업체별 단가 및 누락 옵션 추가
 * ⚠ 기존 데이터 안 날아감 (INSERT OR REPLACE, 없는 것만 추가)
 */

const path = require('path');
const Database = require('better-sqlite3');
const DB_PATH = path.join(__dirname, 'data', '업무데이터.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

console.log('📂 DB:', DB_PATH);
console.log('🚀 라코스 단가 마이그레이션 시작\n');

function generateId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2,7)}`;
}

// ── 라코스 vendor ID ──────────────────────────────────
const LACOS_ID = 'v_1774669037156_ehfoj';

// ── 카테고리 ID 맵 ────────────────────────────────────
const catMap = {};
db.prepare('SELECT id, code FROM categories').all().forEach(r => { catMap[r.code] = r.id; });

// ── vendor_prices UPSERT 헬퍼 ─────────────────────────
function upsertVendorPrice(vendorId, catCode, data) {
  const catId = catMap[catCode];
  if (!catId) { console.log(`  ⚠ 카테고리 없음: ${catCode}`); return; }

  const existing = db.prepare(
    'SELECT id FROM vendor_prices WHERE vendorId=? AND categoryId=?'
  ).get(vendorId, catId);

  const row = {
    id: existing ? existing.id : generateId('vp'),
    vendorId,
    categoryId: catId,
    tiers: JSON.stringify(data.tiers || []),
    widthTiers: JSON.stringify(data.widthTiers || []),
    qtyPrice: data.qtyPrice || 0,
    fixedPrice: data.fixedPrice || 0,
  };

  db.prepare(`
    INSERT OR REPLACE INTO vendor_prices (id, vendorId, categoryId, tiers, widthTiers, qtyPrice, fixedPrice)
    VALUES (@id, @vendorId, @categoryId, @tiers, @widthTiers, @qtyPrice, @fixedPrice)
  `).run(row);
}

// ══════════════════════════════════════════════════════
// 1. 라코스 업체별 단가 설정
// ══════════════════════════════════════════════════════

// FM 포맥스 — 20,000원/㎡ (3t포맥스 라코스 실거래 기준)
upsertVendorPrice(LACOS_ID, 'FM', {
  tiers: [{ areaMin: 0, areaMax: null, pricePerSqm: 20000 }]
});
console.log('✅ FM 포맥스: 20,000원/㎡');

// MG 고무자석 — 55,000원/㎡ (라코스 실거래 기준)
upsertVendorPrice(LACOS_ID, 'MG', {
  tiers: [{ areaMin: 0, areaMax: null, pricePerSqm: 55000 }]
});
console.log('✅ MG 고무자석: 55,000원/㎡');

// ST 스티커 — 20,000원/㎡ (대형 기준, 소형은 별도)
upsertVendorPrice(LACOS_ID, 'ST', {
  tiers: [{ areaMin: 0, areaMax: null, pricePerSqm: 20000 }]
});
console.log('✅ ST 스티커: 20,000원/㎡');

// WB 화이트보드 — 28,000원/개 (화이트보드 660*910 라코스 단가)
upsertVendorPrice(LACOS_ID, 'WB', {
  qtyPrice: 28000
});
console.log('✅ WB 화이트보드: 28,000원/개');

// FB 폼보드 — 50,000원/㎡ (기본 단가 유지)
upsertVendorPrice(LACOS_ID, 'FB', {
  tiers: [
    { areaMin: 0, areaMax: 1, pricePerSqm: 50000 },
    { areaMin: 1, areaMax: null, pricePerSqm: 25000 },
  ]
});
console.log('✅ FB 폼보드: 50,000 / 25,000원/㎡');

// BN 현수막 — 폭별 m당 단가 (라코스 실거래 기준)
// 700mm:3,500 / 950mm:4,000 / 1200mm:6,300 / 1500mm:8,000
upsertVendorPrice(LACOS_ID, 'BN', {
  widthTiers: [
    { widthMm: 700,  pricePerM: 3500  },
    { widthMm: 900,  pricePerM: 3500  },
    { widthMm: 950,  pricePerM: 4000  },
    { widthMm: 1000, pricePerM: 4500  },
    { widthMm: 1100, pricePerM: 5000  },
    { widthMm: 1200, pricePerM: 6300  },
    { widthMm: 1500, pricePerM: 8000  },
    { widthMm: 1800, pricePerM: 10000 },
    { widthMm: 2000, pricePerM: 11000 },
    { widthMm: 2400, pricePerM: 13000 },
  ]
});
console.log('✅ BN 현수막: 폭별 단가 10구간 설정');

// GH 각목현수막 — 폭별 m당 단가 (라코스 실거래 기준)
// 600mm:4,000 / 900mm:4,500 / 1000mm:4,200 / 1800mm:11,700
upsertVendorPrice(LACOS_ID, 'GH', {
  widthTiers: [
    { widthMm: 500,  pricePerM: 4300  },
    { widthMm: 600,  pricePerM: 4000  },
    { widthMm: 900,  pricePerM: 4500  },
    { widthMm: 1000, pricePerM: 4200  },
    { widthMm: 1800, pricePerM: 11700 },
  ]
});
console.log('✅ GH 각목현수막: 폭별 단가 5구간 설정');

// PV PVC망 — 12,000/8,500원/㎡ (기본 단가 유지)
upsertVendorPrice(LACOS_ID, 'PV', {
  tiers: [
    { areaMin: 0,  areaMax: 10, pricePerSqm: 12000 },
    { areaMin: 10, areaMax: null, pricePerSqm: 8500 },
  ]
});
console.log('✅ PV PVC망: 12,000 / 8,500원/㎡');

console.log();

// ══════════════════════════════════════════════════════
// 2. 누락 옵션 추가 (라코스에서 자주 등장하는 부속품)
// ══════════════════════════════════════════════════════

// MSDS 문서보관함 — 13,000원/개
// (pe소형단면+MSDS보관함1개=24,000 vs pe소형단면=11,000 → 차액 13,000)
const msdsCat = db.prepare("SELECT id FROM options WHERE code='MS'").get();
if (!msdsCat) {
  const sbId  = catMap['SB']  || '';
  const sbyId = catMap['SBY'] || '';
  const feId  = catMap['FE']  || '';
  const feyId = catMap['FEY'] || '';
  const fmId  = catMap['FM']  || '';
  db.prepare(`
    INSERT INTO options (id, code, name, price, unit, pricingType, categoryIds, variants, quotes)
    VALUES (?, 'MS', 'MSDS 문서보관함 추가', 13000, '개', 'fixed', ?, '[]', '[]')
  `).run(
    generateId('opt'),
    JSON.stringify([sbId, sbyId, feId, feyId, fmId].filter(Boolean))
  );
  console.log('✅ [MS] MSDS 문서보관함 추가: 13,000원 (신규)');
} else {
  console.log('⏭  [MS] MSDS 문서보관함 이미 존재 (스킵)');
}

// 아크릴포켓 150*50 — 2,000원/개
// (pe간판단면+a4아크릴포켓4개+아크릴포켓150*50 4개=57,000 vs pe간판단면+a4아크릴포켓4개=49,000 → 8,000/4)
const apCat = db.prepare("SELECT id FROM options WHERE code='AP'").get();
if (!apCat) {
  const sbId  = catMap['SB']  || '';
  const sbyId = catMap['SBY'] || '';
  const feId  = catMap['FE']  || '';
  const feyId = catMap['FEY'] || '';
  db.prepare(`
    INSERT INTO options (id, code, name, price, unit, pricingType, categoryIds, variants, quotes)
    VALUES (?, 'AP', '아크릴포켓 150×50 추가', 2000, '개', 'fixed', ?, '[]', '[]')
  `).run(
    generateId('opt'),
    JSON.stringify([sbId, sbyId, feId, feyId].filter(Boolean))
  );
  console.log('✅ [AP] 아크릴포켓 150×50 추가: 2,000원 (신규)');
} else {
  console.log('⏭  [AP] 아크릴포켓 150×50 이미 존재 (스킵)');
}

// ── 검증 ──────────────────────────────────────────────
console.log('\n📋 라코스 업체 단가 설정 결과:');
const vps = db.prepare(`
  SELECT c.code, c.name, vp.tiers, vp.widthTiers, vp.qtyPrice
  FROM vendor_prices vp
  JOIN categories c ON c.id = vp.categoryId
  WHERE vp.vendorId = ?
  ORDER BY c.code
`).all(LACOS_ID);

for (const r of vps) {
  const t = JSON.parse(r.tiers || '[]');
  const w = JSON.parse(r.widthTiers || '[]');
  if (w.length) {
    console.log(`  [${r.code}] ${r.name} → 폭별 ${w.length}구간`);
  } else if (t.length) {
    console.log(`  [${r.code}] ${r.name} → ${t.map(x => x.pricePerSqm.toLocaleString()+'원/㎡').join(', ')}`);
  } else if (r.qtyPrice) {
    console.log(`  [${r.code}] ${r.name} → ${r.qtyPrice.toLocaleString()}원/개`);
  }
}

db.close();
console.log('\n✅ 완료');
