// 기존 OCR 결과 (_results.jsonl) → 새 매칭 함수로 재매칭
// 사용법: cd <price-list-app> && node _rematch_results.js
const fs = require('fs');
const path = require('path');

const pool = require('./lib/learning-pool');

const RESULTS = path.join(__dirname, '_pptx_slides', '_results.jsonl');
const META = path.join(__dirname, '_pptx_slides', '_meta.json');
const OUT = path.join(__dirname, '_pptx_slides', '_rematch_results.jsonl');
const REPORT = path.join(__dirname, '_pptx_slides', '_rematch_report.txt');
const USER_DECISIONS = path.join(__dirname, '_pptx_slides', '_user_decisions.json');

(async () => {
  await pool.load();
  const meta = JSON.parse(fs.readFileSync(META, 'utf8'));
  const lines = fs.readFileSync(RESULTS, 'utf8').split('\n').filter(l => l.trim());
  // 사장님 검수 결정 (체크/무시/매출누락) 로드
  const userDecisions = fs.existsSync(USER_DECISIONS)
    ? JSON.parse(fs.readFileSync(USER_DECISIONS, 'utf8'))
    : {};

  // 로그 + 결과 저장
  const out = [];
  let totalSlides = 0;
  let okSlides = 0;
  let extractedTotal = 0;
  let matchedTotal = 0;
  const usedKeysGlobal = new Set();
  const byCat = { 출력물: { ok: 0, extracted: 0, matched: 0 }, 용접물: { ok: 0, extracted: 0, matched: 0 } };
  const byDate = {};

  for (const line of lines) {
    let j;
    try { j = JSON.parse(line); } catch(_) { continue; }
    if (j.error) {
      out.push({ ...j, rematch: null });
      continue;
    }
    totalSlides++;
    if (!j.ocrText) {
      okSlides++;
      out.push({ ...j, rematch: { extracted: 0, matchedCount: 0, matches: [] } });
      continue;
    }
    okSlides++;

    // 같은 PPTX (= 같은 날짜+카테고리) 내에서 한번 매칭된 행 재사용 방지
    const dateCatKey = `${j.date}|${j.cat}`;
    if (!usedKeysGlobal[dateCatKey]) usedKeysGlobal[dateCatKey] = new Set();

    const r = pool.matchOcrTextToPool(j.ocrText, {
      dateStr: j.date,
      dayRange: 0,
      pptxCategory: j.cat,
      excludeKeys: usedKeysGlobal[dateCatKey],
    });

    // 사장님 검수 결정 적용 — "체크" 한 미매칭은 매칭 처리, "무시" 는 분모에서 제외
    const slideDecisions = userDecisions[j.image] || {};
    let userCheckCount = 0;
    let userIgnoreCount = 0;
    for (const m of r.matches) {
      if (m.matched) continue;
      const dec = slideDecisions[m.extractedSpec];
      if (!dec) continue;
      if (dec.decision === 'check') {
        m._userCheck = true;
        m.reason = (m.reason || '') + ' [사장님 체크: ' + (dec.memo || '확인됨') + ']';
        userCheckCount++;
      } else if (dec.decision === 'ignore') {
        m._userIgnore = true;
        m.reason = (m.reason || '') + ' [사장님 무시: ' + (dec.memo || '') + ']';
        userIgnoreCount++;
      }
    }
    // 매칭 카운트 = 자동 매칭 + 사장님 체크
    const effectiveMatched = r.matchedCount + userCheckCount;
    // 분모 = 전체 - 사장님 무시
    const effectiveExtracted = r.extracted - userIgnoreCount;

    extractedTotal += effectiveExtracted;
    matchedTotal += effectiveMatched;

    byCat[j.cat] = byCat[j.cat] || { ok: 0, extracted: 0, matched: 0 };
    byCat[j.cat].ok++;
    byCat[j.cat].extracted += effectiveExtracted;
    byCat[j.cat].matched += effectiveMatched;

    byDate[j.date] = byDate[j.date] || { ok: 0, extracted: 0, matched: 0 };
    byDate[j.date].ok++;
    byDate[j.date].extracted += effectiveExtracted;
    byDate[j.date].matched += effectiveMatched;

    out.push({
      pptx: j.pptx,
      slide: j.slide,
      date: j.date,
      cat: j.cat,
      image: j.image,
      ocrText: j.ocrText,
      rematch: r,
    });
  }

  // 결과 저장
  fs.writeFileSync(OUT, out.map(o => JSON.stringify(o)).join('\n'));

  // 리포트 작성
  const report = [];
  report.push('=== 재매칭 결과 분석 ===');
  report.push('');
  report.push(`전체 슬라이드: ${meta.length}`);
  report.push(`OCR 성공: ${okSlides}`);
  report.push(`추출된 제품 수: ${extractedTotal} (슬라이드 1장당 평균 ${(extractedTotal/Math.max(okSlides,1)).toFixed(1)}개)`);
  report.push(`매칭된 제품 수: ${matchedTotal} (${extractedTotal ? (matchedTotal*100/extractedTotal).toFixed(1) : 0}%)`);
  report.push('');

  report.push('[카테고리별]');
  for (const [c, v] of Object.entries(byCat)) {
    if (v.ok === 0) continue;
    const rate = v.extracted ? (v.matched*100/v.extracted).toFixed(1) : 0;
    report.push(`  ${c}: ${v.ok}장, 추출 ${v.extracted}개, 매칭 ${v.matched} (${rate}%)`);
  }
  report.push('');

  // 일자별
  report.push('[일자별 매칭률]');
  const sortedDates = Object.entries(byDate).sort();
  for (const [d, v] of sortedDates) {
    const rate = v.extracted ? (v.matched*100/v.extracted).toFixed(0) : 0;
    const flag = v.matched === 0 ? ' ❌' : (v.matched === v.extracted ? ' ✅' : '');
    report.push(`  ${d}: ${v.ok}장, 추출 ${v.extracted}개, 매칭 ${v.matched} (${rate}%)${flag}`);
  }
  report.push('');

  // 매칭 성공 샘플 (각 카테고리에서 5개씩)
  const matchedOut = out.filter(o => o.rematch && o.rematch.matchedCount > 0);
  report.push(`[매칭 성공 슬라이드 샘플 (10개)]`);
  for (const o of matchedOut.slice(0, 10)) {
    report.push(`  [${o.date} ${o.cat}] ${o.image} (${o.rematch.matchedCount}/${o.rematch.extracted})`);
    for (const m of o.rematch.matches.filter(m => m.matched).slice(0, 3)) {
      const fragShort = (m.ocrFragment || '').slice(0, 60).replace(/\n/g, ' ');
      report.push(`    > "${fragShort}"`);
      report.push(`      → ${m.matched.item} / ${m.matched.spec} / 수량 ${m.matched.qty} (score ${m.score}, ${m.reason})`);
    }
  }
  report.push('');

  // 매칭 실패 슬라이드 샘플 (텍스트 있고 사이즈 추출했는데 매칭 안 된 경우)
  const failedOut = out.filter(o => o.rematch && o.rematch.extracted > 0 && o.rematch.matchedCount === 0);
  report.push(`[매칭 실패 슬라이드 샘플 - 사이즈 추출은 됐지만 매칭 X (10개)]`);
  for (const o of failedOut.slice(0, 10)) {
    report.push(`  [${o.date} ${o.cat}] ${o.image} (추출 ${o.rematch.extracted}개)`);
    for (const m of o.rematch.matches.slice(0, 2)) {
      const fragShort = (m.ocrFragment || '').slice(0, 60).replace(/\n/g, ' ');
      report.push(`    > "${fragShort}"`);
      report.push(`      추출: ${m.extractedSpec} / 재질 [${(m.extractedMaterials||[]).join(',')}] / 두께 ${m.extractedThickness} / 수량 ${m.extractedQty}`);
      report.push(`      이유: ${m.reason}`);
    }
  }

  fs.writeFileSync(REPORT, report.join('\n'));
  console.log(report.join('\n'));
})();
