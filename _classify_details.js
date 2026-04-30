// _classify_details.js — 제품 종류 + 사이즈 자동 추출
// product / size_qty / keywords 컬럼의 텍스트를 분석해서
// product_type, size_value 컬럼에 정규화된 값 채움

const path = require('path');
const dbPhotos = require('./db-photos');
const db = dbPhotos.db;

// ========== DB 컬럼 추가 ==========
function safeAlter(sql) {
  try { db.exec(sql); console.log('[ALTER]', sql); }
  catch (e) {
    if (!String(e.message).includes('duplicate column')) console.error('[ALTER 실패]', e.message);
    else console.log('[ALTER skip - already exists]');
  }
}
safeAlter('ALTER TABLE photos ADD COLUMN product_type TEXT');
safeAlter('ALTER TABLE photos ADD COLUMN size_value TEXT');

// 인덱스
try { db.exec('CREATE INDEX IF NOT EXISTS idx_photos_product_type ON photos(product_type)'); } catch (e) {}
try { db.exec('CREATE INDEX IF NOT EXISTS idx_photos_size_value ON photos(size_value)'); } catch (e) {}

// ========== 제품 종류 매핑 ==========
// 키워드 매칭 우선순위 — 더 구체적인 게 먼저
const PRODUCT_TYPE_RULES = [
  { type: '슬러지보관소', keywords: ['슬러지보관소', '슬러지 보관소', '슬러지'] },
  { type: '안전보건게시판', keywords: ['안전보건게시판', '안전보건 게시판', '안전보건판'] },
  { type: '도어 래핑', keywords: ['도어 래핑', '도어래핑', '도어 시트', '도어 시트지', '문 래핑'] },
  { type: '소화기', keywords: ['소화기'] },
  { type: '소화기점검표', keywords: ['소화기점검표', '점검표'] },
  { type: '안전모', keywords: ['안전모', '헬멧', '하드햇'] },
  { type: '안전화', keywords: ['안전화', '안전 신발'] },
  { type: '안전벨트', keywords: ['안전벨트', '안전 벨트', '풀하네스'] },
  { type: '안전조끼', keywords: ['안전조끼', '야광조끼', '형광조끼', '안전 조끼'] },
  { type: '안전배너', keywords: ['안전배너', '안전 배너', '현수막', '배너'] },
  { type: '안전펜스', keywords: ['안전펜스', '방호울', '가설울타리', '안전 펜스'] },
  { type: '안전표지판', keywords: ['표지판', '안내판', '사인', '사이니지', '안내 표지'] },
  { type: '안전콘', keywords: ['라바콘', '안전콘', '카라콘', '트래픽콘'] },
  { type: '깃발/유도기', keywords: ['깃발', '삼각기', '유도기', '안전기'] },
  { type: '안전스티커', keywords: ['스티커', '라벨'] },
  { type: '간판/명판', keywords: ['명판', '간판', 'ㅂ판', '스텐 명판'] },
  { type: '포맥스/실사', keywords: ['포맥스', '실사', '실사출력'] },
  { type: '안전장갑', keywords: ['안전장갑', '장갑'] },
  { type: '구급함', keywords: ['구급함', '응급함'] },
  { type: '거울/반사경', keywords: ['반사경', '안전거울'] },
  { type: '경광등/조명', keywords: ['경광등', 'LED조명', '안전등'] },
  { type: '바리케이드', keywords: ['바리케이드', '차단봉', '쇠말뚝'] },
  { type: '작업복', keywords: ['작업복', '점퍼', '동복', '하복'] },
];

function detectProductType(text) {
  if (!text) return null;
  for (const rule of PRODUCT_TYPE_RULES) {
    for (const k of rule.keywords) {
      if (text.includes(k)) return rule.type;
    }
  }
  return null;
}

// ========== 사이즈 추출 ==========
// 우선순위: 사이즈 X 사이즈 → 무게 → 수량 → 두께
function detectSize(text) {
  if (!text) return null;
  const found = [];

  // 1) 사이즈 (가로 X 세로): 600*900, 210*297, 150x100
  const dim = text.matchAll(/(\d{2,4})\s*[x*×]\s*(\d{2,4})/g);
  for (const m of dim) {
    found.push(`${m[1]}*${m[2]}`);
  }

  // 2) 무게: 3.3kg, 20KG, 5 kg
  const weight = text.matchAll(/(\d+(?:\.\d+)?)\s*(?:kg|KG|Kg)/g);
  for (const m of weight) {
    found.push(`${m[1]}kg`);
  }

  // 3) 두께: 3T, 5t, 0.5T
  const thick = text.matchAll(/(\d+(?:\.\d+)?)\s*[Tt]\b/g);
  for (const m of thick) {
    found.push(`${m[1]}T`);
  }

  // 4) 수량: 50EA, 100개, 5장
  const qty = text.matchAll(/(\d+)\s*(?:EA|ea|개|장|매)/g);
  for (const m of qty) {
    found.push(`${m[1]}EA`);
  }

  // 중복 제거 + 처음 3개만
  return [...new Set(found)].slice(0, 3).join(' / ') || null;
}

// ========== 메인 ==========
console.log('[1/3] 전체 행 로드 중...');
const rows = db.prepare(
  `SELECT id, product, size_qty, keywords FROM photos
   WHERE category IN ('용품', '시공현장')`
).all();
console.log(`  대상: ${rows.length} 장`);

console.log('[2/3] 제품 종류 + 사이즈 추출...');
let typed = 0;
let sized = 0;
const stmt = db.prepare('UPDATE photos SET product_type = ?, size_value = ? WHERE id = ?');
const tx = db.transaction(() => {
  for (const row of rows) {
    // 우선 size_qty (정확함), 그 다음 product, 마지막 keywords
    const text = [row.size_qty, row.product, row.keywords].filter(Boolean).join(' | ');
    const productType = detectProductType(text);
    const sizeValue = detectSize(row.size_qty || '') || detectSize(row.product || '') || null;
    stmt.run(productType, sizeValue, row.id);
    if (productType) typed++;
    if (sizeValue) sized++;
  }
});
tx();
console.log(`  제품 종류 인식: ${typed} / ${rows.length} 장 (${(typed / rows.length * 100).toFixed(1)}%)`);
console.log(`  사이즈 추출: ${sized} / ${rows.length} 장 (${(sized / rows.length * 100).toFixed(1)}%)`);

console.log('[3/3] TOP 통계');
const topTypes = db.prepare(
  `SELECT product_type, COUNT(*) as n FROM photos
   WHERE product_type IS NOT NULL AND is_hidden = 0
   GROUP BY product_type ORDER BY n DESC LIMIT 20`
).all();
console.log('  제품 종류 TOP 20:');
for (const t of topTypes) console.log(`    ${t.product_type}: ${t.n}`);

const topSizes = db.prepare(
  `SELECT size_value, COUNT(*) as n FROM photos
   WHERE size_value IS NOT NULL AND is_hidden = 0
   GROUP BY size_value ORDER BY n DESC LIMIT 20`
).all();
console.log('  사이즈 TOP 20:');
for (const s of topSizes) console.log(`    ${s.size_value}: ${s.n}`);

console.log('\n✅ 세부 분류 완료');
