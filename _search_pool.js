// 학습풀 직접 검색 — 사용자가 의심하는 케이스 확인
const pool = require('./lib/learning-pool');

(async () => {
  await pool.load();
  const COMPANY_매출 = pool.getQuadrant ? pool.getQuadrant('COMPANY_매출') : null;
  // pool 내부에서 직접 byDate 가져오기
  const learningPool = pool.getRegisteredByDate; // helper

  // 1. 5600*1500, 5565*1200 (큰 사이즈 간판) 근처 날짜에 후렉스/간판 매출 있나?
  console.log('=== 1. 5600*1500 / 5565*1200 / 5600*1100 후렉스 류 ===');
  const targetDates = ['2025-12-12', '2025-12-10', '2025-12-15'];
  for (const d of targetDates) {
    console.log(`\n--- ${d} ±5 일 ---`);
    const rows = pool.getRegisteredByDate(d, { dayRange: 5 });
    const big = rows.filter(r => {
      const spec = (r.spec || '').replace(/\s/g, '');
      const w = parseInt(spec, 10);
      return w >= 4000 || (r.item || '').includes('후렉스') || (r.item || '').includes('세륜장') || (r.item || '').includes('간판');
    });
    for (const r of big.slice(0, 15)) {
      console.log(`  ${r.date}\t${r.item}\t${r.spec}\t수량 ${r.qty}\t₩${r.price}`);
    }
  }

  // 2. 1500*1100 철판자립/축광시트
  console.log('\n\n=== 2. 1500*1100 철판자립/축광시트 류 ===');
  for (const d of ['2025-12-02', '2025-12-04', '2025-12-08']) {
    console.log(`\n--- ${d} ---`);
    const rows = pool.getRegisteredByDate(d, { dayRange: 5 });
    for (const r of rows) {
      const spec = (r.spec || '').replace(/\s/g, '');
      if (spec.includes('1500') || (r.item || '').includes('철판') || (r.item || '').includes('자립') || (r.item || '').includes('축광') || (r.item || '').includes('롤판')) {
        console.log(`  ${r.date}\t${r.item}\t${r.spec}\t수량 ${r.qty}\t₩${r.price}`);
      }
    }
  }

  // 3. 900*1800 A형철판 양면
  console.log('\n\n=== 3. 900*1800 A형철판 양면 류 ===');
  for (const d of ['2025-12-02']) {
    console.log(`\n--- ${d} ±5일 ---`);
    const rows = pool.getRegisteredByDate(d, { dayRange: 5 });
    for (const r of rows) {
      const spec = (r.spec || '').replace(/\s/g, '');
      if (spec.includes('900*1800') || spec.includes('1800*900') || (r.item || '').includes('A형') || (r.item || '').includes('a형')) {
        console.log(`  ${r.date}\t${r.item}\t${r.spec}\t수량 ${r.qty}\t₩${r.price}`);
      }
    }
  }

  // 4. 일반 학습풀 통계 - "철판자립" / "후렉스" / "축광시트" 류 전체
  console.log('\n\n=== 4. 학습풀 전체 키워드 검색 ===');
  const allRows = [];
  // pool 내부 byDate Map 펼치기
  for (const d of ['2025-12-01', '2025-12-15', '2026-01-15', '2026-02-15', '2026-03-15', '2026-04-15']) {
    const rows = pool.getRegisteredByDate(d, { dayRange: 90 });
    allRows.push(...rows);
  }
  // 중복제거
  const uniq = new Map();
  for (const r of allRows) uniq.set(`${r.date}|${r.item}|${r.spec}|${r.qty}`, r);
  const flat = [...uniq.values()];
  console.log(`전체 매출 행: ${flat.length}`);

  const keywords = ['후렉스', '철판자립', '축광시트', '세륜장', '롤판', 'a형철판', 'a형 양면'];
  for (const kw of keywords) {
    const hits = flat.filter(r => (r.item || '').toLowerCase().includes(kw.toLowerCase()));
    console.log(`\n"${kw}" → ${hits.length}건`);
    for (const r of hits.slice(0, 5)) {
      console.log(`  ${r.date}\t${r.item}\t${r.spec}\t수량 ${r.qty}`);
    }
  }
})();
