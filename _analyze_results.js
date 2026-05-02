// _pptx_slides/_results.jsonl 분석 → 표준출력으로 리포트
const fs = require('fs');
const path = require('path');

const RESULTS = path.join(__dirname, '_pptx_slides', '_results.jsonl');
const META = path.join(__dirname, '_pptx_slides', '_meta.json');

const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
const lines = fs.readFileSync(RESULTS, 'utf8').split('\n').filter(l => l.trim());

console.log(`=== OCR 결과 분석 ===\n`);
console.log(`전체 슬라이드: ${meta.length}`);
console.log(`결과 파일 라인: ${lines.length}\n`);

let ok = 0, err = 0, matched = 0, unmatched = 0;
const noText = [], hasText = [];
const byCat = { 출력물: { ok: 0, matched: 0, unmatched: 0 }, 용접물: { ok: 0, matched: 0, unmatched: 0 } };
const byDate = {};
const reasons = {};
const errorMsgs = {};

for (const line of lines) {
  let j;
  try { j = JSON.parse(line); } catch(_) { continue; }
  if (j.error) {
    err++;
    errorMsgs[j.error] = (errorMsgs[j.error] || 0) + 1;
    continue;
  }
  ok++;
  const cat = j.cat || '?';
  byCat[cat] = byCat[cat] || { ok: 0, matched: 0, unmatched: 0 };
  byCat[cat].ok++;
  byDate[j.date] = byDate[j.date] || { ok: 0, matched: 0 };
  byDate[j.date].ok++;
  if (j.matched) {
    matched++;
    byCat[cat].matched++;
    byDate[j.date].matched++;
    hasText.push(j);
  } else {
    unmatched++;
    byCat[cat].unmatched++;
    if ((j.ocrText || '').trim() === '') noText.push(j);
    else hasText.push(j);
  }
  reasons[j.reason || ''] = (reasons[j.reason || ''] || 0) + 1;
}

console.log(`성공/실패: OK=${ok}, ERR=${err}`);
console.log(`매칭: matched=${matched} (${ok ? (matched*100/ok).toFixed(1) : 0}%) / unmatched=${unmatched}`);
console.log(`텍스트 없음: ${noText.length}\n`);

console.log(`[카테고리별]`);
for (const [c, v] of Object.entries(byCat)) {
  if (v.ok === 0) continue;
  const rate = v.ok ? (v.matched*100/v.ok).toFixed(1) : 0;
  console.log(`  ${c}: ${v.ok}장, matched=${v.matched} (${rate}%), unmatched=${v.unmatched}`);
}

console.log(`\n[매칭 사유 분포]`);
for (const [r, n] of Object.entries(reasons).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${r || '(none)'}: ${n}`);
}

console.log(`\n[에러 메시지]`);
for (const [m, n] of Object.entries(errorMsgs).sort((a,b) => b[1]-a[1])) {
  console.log(`  ${m.slice(0, 80)}: ${n}`);
}

// 매칭 성공 샘플 5개
const matchedSamples = lines
  .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
  .filter(j => j && j.matched);
console.log(`\n[매칭 성공 샘플 (최대 5개)]`);
for (const j of matchedSamples.slice(0, 5)) {
  console.log(`  [${j.date} ${j.cat}] ${j.image}`);
  console.log(`    OCR: ${(j.ocrText || '').slice(0, 60).replace(/\n/g, ' / ')}`);
  console.log(`    매칭: ${j.matched} (score: ${j.score}, reason: ${j.reason})`);
}

// 매칭 실패 샘플 (텍스트 있는것)
const failedWithText = lines
  .map(l => { try { return JSON.parse(l); } catch(_) { return null; } })
  .filter(j => j && !j.matched && !j.error && (j.ocrText || '').trim());
console.log(`\n[매칭 실패 샘플 - 텍스트 있음 (최대 10개)]`);
for (const j of failedWithText.slice(0, 10)) {
  console.log(`  [${j.date} ${j.cat}] ${j.image}`);
  console.log(`    OCR: ${(j.ocrText || '').slice(0, 80).replace(/\n/g, ' / ')}`);
  console.log(`    이유: ${j.reason}, 후보수: ${j.candidateCount}`);
}

console.log(`\n[일자별 매칭률 - 매칭 0건만]`);
for (const [d, v] of Object.entries(byDate).sort()) {
  if (v.matched === 0) {
    console.log(`  ${d}: ${v.ok}장 OCR / 0건 매칭`);
  }
}
