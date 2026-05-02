// 후렉스간판/후렉스 류 매칭 케이스 분석
const fs = require('fs');
const path = require('path');

const RES = path.join(__dirname, '_pptx_slides', '_rematch_results.jsonl');
const lines = fs.readFileSync(RES, 'utf8').split('\n').filter(l => l.trim());

let totalHurex = 0, matchedHurex = 0;
const matched = [], failed = [];

for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch(_) { continue; }
  if (!j.rematch || !j.rematch.matches) continue;
  for (const m of j.rematch.matches) {
    const isHurex = /후렉스|간판/.test(m.ocrFragment || '') || (m.extractedMaterials || []).some(x => x === '후렉스' || x === '간판');
    if (!isHurex) continue;
    totalHurex++;
    if (m.matched) {
      matchedHurex++;
      matched.push({ date: j.date, frag: m.ocrFragment, spec: m.extractedSpec, mats: m.extractedMaterials, matched: `${m.matched.item}/${m.matched.spec}/수량${m.matched.qty}`, score: m.score, reason: m.reason });
    } else {
      failed.push({ date: j.date, frag: m.ocrFragment, spec: m.extractedSpec, mats: m.extractedMaterials, reason: m.reason });
    }
  }
}

console.log(`=== 후렉스/간판 케이스 분석 ===`);
console.log(`전체 후렉스/간판 라인: ${totalHurex}`);
console.log(`매칭 성공: ${matchedHurex} (${(matchedHurex*100/totalHurex).toFixed(1)}%)`);
console.log(`매칭 실패: ${failed.length}`);

console.log(`\n[매칭 성공 샘플 - 후렉스]`);
for (const m of matched.filter(m => m.mats.includes('후렉스')).slice(0, 10)) {
  console.log(`  [${m.date}] "${m.frag.slice(0, 50)}"`);
  console.log(`    → ${m.matched} (score ${m.score}, ${m.reason})`);
}

console.log(`\n[매칭 성공 샘플 - 간판만]`);
for (const m of matched.filter(m => m.mats.includes('간판') && !m.mats.includes('후렉스')).slice(0, 5)) {
  console.log(`  [${m.date}] "${m.frag.slice(0, 50)}"`);
  console.log(`    → ${m.matched} (score ${m.score}, ${m.reason})`);
}

console.log(`\n[매칭 실패 샘플 - 후렉스 (10개)]`);
for (const m of failed.filter(m => m.mats.includes('후렉스')).slice(0, 10)) {
  console.log(`  [${m.date}] "${m.frag.slice(0, 60)}"`);
  console.log(`    추출: ${m.spec} / 재질 [${m.mats.join(',')}] / 이유: ${m.reason}`);
}

console.log(`\n[매칭 실패 샘플 - 간판만 (10개)]`);
for (const m of failed.filter(m => m.mats.includes('간판') && !m.mats.includes('후렉스')).slice(0, 10)) {
  console.log(`  [${m.date}] "${m.frag.slice(0, 60)}"`);
  console.log(`    추출: ${m.spec} / 재질 [${m.mats.join(',')}] / 이유: ${m.reason}`);
}
