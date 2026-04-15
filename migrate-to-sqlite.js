/**
 * migrate-to-sqlite.js — JSON → SQLite 데이터 마이그레이션
 *
 * 실행: node migrate-to-sqlite.js
 *
 * 품목관리.json + 업체관리.json + 견적관리.json 데이터를
 * 업무데이터.db (SQLite)로 이전합니다.
 */

const fs = require('fs');
const path = require('path');
const sqldb = require('./db-sqlite');

const DATA_DIR = path.join(__dirname, 'data');

function readJson(filename) {
  const fp = path.join(DATA_DIR, filename);
  if (!fs.existsSync(fp)) return null;
  return JSON.parse(fs.readFileSync(fp, 'utf8'));
}

console.log('=== JSON → SQLite 마이그레이션 시작 ===\n');

// 1. 품목 (categories)
const itemsData = readJson('품목관리.json');
if (itemsData) {
  let count = 0;
  for (const cat of (itemsData.categories || [])) {
    try {
      sqldb.categories.create(cat);
      count++;
    } catch (e) {
      if (e.message.includes('UNIQUE')) {
        console.log(`  [건너뜀] 품목 "${cat.name}" (${cat.code}) 이미 존재`);
      } else {
        console.error(`  [오류] 품목 "${cat.name}":`, e.message);
      }
    }
  }
  console.log(`품목: ${count}건 이전 완료`);

  // 옵션
  let optCount = 0;
  for (const opt of (itemsData.options || [])) {
    try {
      sqldb.options.create(opt);
      optCount++;
    } catch (e) {
      if (!e.message.includes('UNIQUE'))
        console.error(`  [오류] 옵션 "${opt.name}":`, e.message);
    }
  }
  console.log(`옵션: ${optCount}건 이전 완료`);

  // 업체별 단가
  let vpCount = 0;
  for (const vp of (itemsData.vendorPrices || [])) {
    try {
      sqldb.vendorPrices.upsert(vp);
      vpCount++;
    } catch (e) {
      console.error(`  [오류] 업체별단가:`, e.message);
    }
  }
  console.log(`업체별단가: ${vpCount}건 이전 완료`);
}

// 2. 업체 (vendors)
const vendorsData = readJson('업체관리.json');
if (vendorsData) {
  let count = 0;
  for (const v of (vendorsData.vendors || [])) {
    try {
      sqldb.vendors.create(v);
      count++;
    } catch (e) {
      if (!e.message.includes('UNIQUE'))
        console.error(`  [오류] 업체 "${v.name}":`, e.message);
    }
  }
  console.log(`업체: ${count}건 이전 완료`);
}

// 3. 견적서 (quotes)
const quotesData = readJson('견적관리.json');
if (quotesData) {
  let count = 0;
  for (const q of (quotesData.quotes || [])) {
    try {
      sqldb.quotes.create(q);
      count++;
    } catch (e) {
      if (!e.message.includes('UNIQUE'))
        console.error(`  [오류] 견적 "${q.quoteName}":`, e.message);
    }
  }
  console.log(`견적서: ${count}건 이전 완료`);
}

console.log('\n=== 마이그레이션 완료 ===');
console.log(`DB 파일: ${path.join(DATA_DIR, '업무데이터.db')}`);

// 검증
const cats = sqldb.categories.getAll();
const opts = sqldb.options.getAll();
const vends = sqldb.vendors.getAll();
const qts = sqldb.quotes.getAll();

console.log(`\n[검증] 품목: ${cats.length}건 | 옵션: ${opts.length}건 | 업체: ${vends.length}건 | 견적: ${qts.length}건`);

sqldb.close();
