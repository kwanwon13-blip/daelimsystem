/**
 * sync-categories-from-server.js
 * 실행: node sync-categories-from-server.js
 *
 * 서버(192.168.0.133:3000)의 품목 데이터를 로컬 DB에 동기화합니다.
 * 견적/업체 등 다른 데이터는 건드리지 않습니다.
 */

const http = require('http');
const path = require('path');
const Database = require('better-sqlite3');

const SERVER_URL = 'http://192.168.0.133:3000/api/categories';
const DB_PATH = path.join(__dirname, 'data', '업무데이터.db');

function fetchCategories() {
  return new Promise((resolve, reject) => {
    http.get(SERVER_URL, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('응답 파싱 실패: ' + data.slice(0, 100))); }
      });
    }).on('error', reject);
  });
}

async function main() {
  console.log('📡 서버에서 품목 데이터 가져오는 중...');
  console.log('   URL:', SERVER_URL);

  let categories;
  try {
    categories = await fetchCategories();
  } catch (e) {
    console.error('❌ 서버 연결 실패:', e.message);
    console.error('   서버가 켜져 있는지, IP가 맞는지 확인하세요.');
    process.exit(1);
  }

  console.log(`✅ ${categories.length}개 품목 수신`);

  const db = new Database(DB_PATH);
  console.log('📂 로컬 DB:', DB_PATH);

  // variants 컬럼 없으면 추가
  try {
    db.exec("ALTER TABLE categories ADD COLUMN variants TEXT DEFAULT '[]'");
    console.log('✅ variants 컬럼 추가');
  } catch (e) {
    if (!e.message.includes('duplicate column')) throw e;
  }

  const JSON_FIELDS = ['tiers', 'widthTiers', 'purchaseSpecs', 'variants'];

  const upsert = db.prepare(`
    INSERT OR REPLACE INTO categories
      (id, name, code, pricingType, unit, tiers, widthTiers, qtyPrice, fixedPrice, purchaseSpecs, variants, updatedAt)
    VALUES
      (@id, @name, @code, @pricingType, @unit, @tiers, @widthTiers, @qtyPrice, @fixedPrice, @purchaseSpecs, @variants, @updatedAt)
  `);

  const syncAll = db.transaction((cats) => {
    for (const cat of cats) {
      const row = { ...cat };
      for (const f of JSON_FIELDS) {
        if (row[f] !== undefined && typeof row[f] !== 'string') {
          row[f] = JSON.stringify(row[f]);
        }
        if (row[f] === undefined) row[f] = '[]';
      }
      row.updatedAt = row.updatedAt || new Date().toISOString();
      upsert.run(row);
    }
  });

  syncAll(categories);

  console.log(`\n✅ 로컬 DB 동기화 완료 — ${categories.length}개 품목 반영`);
  console.log('\n📋 동기화된 품목:');
  for (const c of categories) {
    console.log(`  [${c.code}] ${c.name} (${c.pricingType})`);
  }

  db.close();
}

main();
