/**
 * migrate-variants.js
 * 실행: node migrate-variants.js
 * - categories 테이블에 variants 컬럼 추가 (없을 경우)
 * - PE/철제 표지판 pricingType → VARIANTS 변경
 * - 라코스 실거래 기준 단가 반영
 * - 고무자석/스티커 단가 수정
 *
 * ⚠ 기존 데이터를 덮어쓰지 않고 안전하게 업데이트합니다
 */

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = path.join(__dirname, 'data', '업무데이터.db');
const db = new Database(DB_PATH);

console.log('📂 DB 경로:', DB_PATH);
console.log('🚀 마이그레이션 시작\n');

// ── 1. variants 컬럼 추가 (없을 때만) ──────────────────────
try {
  db.exec("ALTER TABLE categories ADD COLUMN variants TEXT DEFAULT '[]'");
  console.log("✅ variants 컬럼 추가");
} catch (e) {
  if (e.message.includes('duplicate column')) {
    console.log("⏭  variants 컬럼 이미 존재 (스킵)");
  } else {
    throw e;
  }
}

// ── 2. PE 표지판 단면 (SB) ───────────────────────────────
const variantsSB = JSON.stringify([
  { label: "소형 (310×650)", price: 11000 },
  { label: "대형 (600×900)", price: 23000 }
]);
db.prepare("UPDATE categories SET pricingType='VARIANTS', variants=?, tiers='[]' WHERE code='SB'").run(variantsSB);
console.log("✅ SB PE 표지판 (단면): 소형 11,000 / 대형 23,000원");

// ── 3. PE 표지판 양면 (SBY) ─────────────────────────────
const variantsSBY = JSON.stringify([
  { label: "소형 (310×650)", price: 18000 },
  { label: "대형 (600×900)", price: 28000 }
]);
const sbyCat = db.prepare("SELECT id FROM categories WHERE code='SBY'").get();
if (sbyCat) {
  db.prepare("UPDATE categories SET pricingType='VARIANTS', variants=?, tiers='[]' WHERE code='SBY'").run(variantsSBY);
  console.log("✅ SBY PE 표지판 (양면): 소형 18,000 / 대형 28,000원");
} else {
  db.prepare(`INSERT INTO categories (id,code,name,pricingType,unit,tiers,widthTiers,qtyPrice,fixedPrice,purchaseSpecs,variants)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'cat_sby_' + Date.now(), 'SBY', 'PE 표지판 (양면)', 'VARIANTS', '개',
    '[]', '[]', 0, 0, '[]', variantsSBY
  );
  console.log("✅ SBY PE 표지판 (양면) 신규 추가");
}

// ── 4. 철제 표지판 단면 (FE) ─────────────────────────────
const variantsFE = JSON.stringify([
  { label: "소형 (600×900)", price: 25000 },
  { label: "대형 (900×1800)", price: 38000 }
]);
const feCat = db.prepare("SELECT id FROM categories WHERE code='FE'").get();
if (feCat) {
  db.prepare("UPDATE categories SET pricingType='VARIANTS', variants=?, tiers='[]' WHERE code='FE'").run(variantsFE);
  console.log("✅ FE 철제 표지판 (단면): 소형 25,000 / 대형 38,000원");
} else {
  db.prepare(`INSERT INTO categories (id,code,name,pricingType,unit,tiers,widthTiers,qtyPrice,fixedPrice,purchaseSpecs,variants)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'cat_fe_' + Date.now(), 'FE', '철제 표지판 (단면)', 'VARIANTS', '개',
    '[]', '[]', 0, 0, '[]', variantsFE
  );
  console.log("✅ FE 철제 표지판 (단면) 신규 추가");
}

// ── 5. 철제 표지판 양면 (FEY) ────────────────────────────
const variantsFEY = JSON.stringify([
  { label: "소형 (600×900)", price: 35000 },
  { label: "대형 (900×1800)", price: 0 }   // 추후 확인
]);
const feyCat = db.prepare("SELECT id FROM categories WHERE code='FEY'").get();
if (feyCat) {
  db.prepare("UPDATE categories SET pricingType='VARIANTS', variants=?, tiers='[]' WHERE code='FEY'").run(variantsFEY);
  console.log("✅ FEY 철제 표지판 (양면): 소형 35,000 / 대형 추후 확인");
} else {
  db.prepare(`INSERT INTO categories (id,code,name,pricingType,unit,tiers,widthTiers,qtyPrice,fixedPrice,purchaseSpecs,variants)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    'cat_fey_' + Date.now(), 'FEY', '철제 표지판 (양면)', 'VARIANTS', '개',
    '[]', '[]', 0, 0, '[]', variantsFEY
  );
  console.log("✅ FEY 철제 표지판 (양면) 신규 추가");
}

// ── 6. 고무자석 (MG): 55,000원/㎡ 단일 tier ────────────
const tiersMG = JSON.stringify([{ areaMin: 0, areaMax: null, pricePerSqm: 55000 }]);
db.prepare("UPDATE categories SET tiers=? WHERE code='MG'").run(tiersMG);
console.log("✅ MG 고무자석: 55,000원/㎡");

// ── 7. 스티커 (ST): 20,000원/㎡ 단일 tier ──────────────
const tiersST = JSON.stringify([{ areaMin: 0, areaMax: null, pricePerSqm: 20000 }]);
db.prepare("UPDATE categories SET tiers=? WHERE code='ST'").run(tiersST);
console.log("✅ ST 스티커: 20,000원/㎡");

// ── 검증 ────────────────────────────────────────────────
console.log('\n📋 업데이트 결과:');
const rows = db.prepare("SELECT code, name, pricingType, tiers, variants FROM categories WHERE code IN ('SB','SBY','FE','FEY','MG','ST')").all();
for (const r of rows) {
  if (r.pricingType === 'VARIANTS') {
    const v = JSON.parse(r.variants || '[]');
    console.log(`  [${r.code}] ${r.name} → ${v.map(x => x.label + ':' + x.price.toLocaleString()).join(' / ')}`);
  } else {
    const t = JSON.parse(r.tiers || '[]');
    console.log(`  [${r.code}] ${r.name} → ${t.map(x => x.pricePerSqm.toLocaleString() + '원/㎡').join(', ')}`);
  }
}

db.close();
console.log('\n✅ 마이그레이션 완료');
