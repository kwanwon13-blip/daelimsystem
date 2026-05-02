// 매칭 실패한 후렉스 사이즈가 학습풀에 진짜 없나? ±20mm 까지 fuzzy search
const pool = require('./lib/learning-pool');

(async () => {
  await pool.load();
  const targets = [
    { date: '2025-12-12', spec: '5565*1200' },
    { date: '2025-12-23', spec: '4384*900' },
    { date: '2025-12-23', spec: '4483*900' },
    { date: '2026-01-13', spec: '4825*1200' },
    { date: '2026-01-13', spec: '4363*894' },
    { date: '2026-02-12', spec: '4000*1000' },
    { date: '2026-02-24', spec: '2980*1000' },
    { date: '2026-04-02', spec: '2000*600' },
  ];

  for (const t of targets) {
    const [tw, th] = t.spec.split('*').map(Number);
    console.log(`\n=== ${t.date} OCR 추출 ${t.spec} (후렉스간판) ===`);
    const rows = pool.getRegisteredByDate(t.date, { dayRange: 7 });
    const huxs = rows.filter(r => /후렉스/.test(r.item));
    console.log(`같은 주간 후렉스 매출 ${huxs.length}건`);

    // ±100mm 범위로 비슷한 사이즈 찾기
    let nearMatches = 0;
    for (const r of huxs) {
      const rSpec = (r.spec || '').replace(/\s/g, '');
      const m = rSpec.match(/^(\d+)\*(\d+)/);
      if (!m) continue;
      const rw = Number(m[1]), rh = Number(m[2]);
      const diff = Math.max(Math.abs(rw-tw), Math.abs(rh-th));
      if (diff <= 200) {
        nearMatches++;
        console.log(`  ±${diff}mm: ${r.date} / ${r.item} / ${r.spec} / 수량${r.qty}`);
      }
    }
    if (nearMatches === 0) {
      console.log(`  ⚠ ±200mm 내에 비슷한 후렉스 없음 - 학습풀에 진짜 없음`);
      // 같은 주간 후렉스 전체 사이즈 출력
      console.log(`  주간 후렉스 사이즈들:`);
      for (const r of huxs.slice(0, 10)) {
        console.log(`    ${r.date} / ${r.spec} / ${r.item}`);
      }
    }
  }
})();
