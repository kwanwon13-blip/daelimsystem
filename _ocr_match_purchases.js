// 52장 매입명세서 일괄 OCR + 학습풀 매칭
// 사용법: cd price-list-app && node _ocr_match_purchases.js
// 약 15-30분 소요 (concurrency 3, 장당 30~120초)

const fs = require('fs');
const path = require('path');
const cli = require('./lib/claude-cli');
const pool = require('./lib/learning-pool');

const SLIPS_DIR = path.join(__dirname, 'learning-data', '03_컴퍼니매입', '컴퍼니 매입자료');
const CLASSIFY = path.join(__dirname, 'learning-data', '03_컴퍼니매입', 'mappings', '_classify_results.jsonl');
const OUT = path.join(__dirname, 'learning-data', '03_컴퍼니매입', 'mappings', '_match_results.jsonl');

const OCR_PROMPT = `이 이미지/문서는 매입명세서 또는 거래명세서야. 다음 JSON 형식으로 정확히 추출해줘:

{
  "vendor": {
    "biz_no": "공급자(매입처) 사업자등록번호 (예: 113-81-66743)",
    "name": "공급자(매입처) 회사명 (㈜/주식회사 포함)"
  },
  "buyer": {
    "biz_no": "공급받는자(우리) 사업자번호",
    "name": "공급받는자 회사명"
  },
  "trx_date": "거래 일자 (YYYY-MM-DD, 명세서 발행일)",
  "lines": [
    {
      "row_no": 1,
      "ocr_text": "품명+규격을 매입명세서에 적힌 그대로",
      "qty": 수량,
      "unit_price": 단가,
      "supply_amt": 공급가액,
      "vat_amt": 부가세
    }
  ]
}

규칙:
- 합계/소계/총계/이월금/이체/일계/총합 행은 lines에 포함하지 않음
- ocr_text는 매입명세서에 적힌 원본 그대로
- 숫자는 콤마 빼고
- 사업자번호 'XXX-XX-XXXXX' 형식 유지
- JSON 외 다른 설명 절대 출력하지 말 것`;

(async () => {
  await pool.load();

  // 분류 결과에서 자동화 대상만 추출
  const classifyLines = fs.readFileSync(CLASSIFY, 'utf8').split('\n').filter(l => l.trim());
  const skipPattern = /영신|주서진|크레텍|한우중기|경일안전|서진|^임대|^퀵발송|^신흥철강|^기타|^알수없음|^대림컴퍼니|^미상/;
  const targets = [];
  for (const l of classifyLines) {
    let j; try { j = JSON.parse(l); } catch(_) { continue; }
    if (j.error) continue;
    const v = String(j.vendor || '').trim();
    if (j.skip) continue;
    if (skipPattern.test(v)) continue;
    targets.push(j);
  }
  console.log('[ocr-match] 자동화 대상:', targets.length, '장');

  // 이미 처리한 거 skip
  const done = new Set();
  if (fs.existsSync(OUT)) {
    for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      try {
        const j = JSON.parse(line);
        if (!j.error) done.add(j.image);
      } catch(_){}
    }
  }
  console.log('[ocr-match] 이미 처리:', done.size);
  const todo = targets.filter(t => !done.has(t.image));
  console.log('[ocr-match] 처리 시작:', todo.length);

  const concurrency = 3;
  let cursor = 0;
  let processed = 0;
  let matchedLines = 0;
  let totalLines = 0;
  const startedAt = Date.now();

  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); } catch(_){}

  async function worker(workerId) {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) break;
      const t = todo[i];
      const imgPath = path.join(SLIPS_DIR, t.image);
      try {
        const r = await cli.callClaudeCli(OCR_PROMPT, [imgPath], {
          model: 'claude-sonnet-4-6',
          timeout: 120000,
        });
        let ocr = {};
        try {
          ocr = cli.parseJsonFromResponse(r.text || '');
        } catch (e) {
          fs.appendFileSync(OUT, JSON.stringify({
            image: t.image, error: 'parse_fail', raw: (r.text || '').slice(0, 300),
          }) + '\n');
          continue;
        }
        // 라인별 매칭
        const lines = Array.isArray(ocr.lines) ? ocr.lines : [];
        const matched = [];
        for (const line of lines) {
          const m = pool.matchPurchaseLineToPool(line, {
            vendor: (ocr.vendor && ocr.vendor.name) || t.vendor,
            dateStr: ocr.trx_date || t.date,
            dayRange: 30,
          });
          matched.push({ ...line, matched: m.matched, score: m.score, reason: m.reason });
          totalLines++;
          if (m.matched) matchedLines++;
        }
        const entry = {
          image: t.image,
          classified_vendor: t.vendor,
          ocr_vendor: (ocr.vendor && ocr.vendor.name) || null,
          ocr_biz_no: (ocr.vendor && ocr.vendor.biz_no) || null,
          trx_date: ocr.trx_date || null,
          lineCount: lines.length,
          matchedCount: matched.filter(m => m.matched).length,
          lines: matched,
          ms: r.durationMs,
        };
        fs.appendFileSync(OUT, JSON.stringify(entry) + '\n');
        processed++;
        if (processed % 3 === 0) {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const rate = processed / Math.max(elapsed, 1);
          const eta = Math.round((todo.length - processed) / Math.max(rate, 0.001));
          const matchPct = totalLines ? (matchedLines * 100 / totalLines).toFixed(0) : '-';
          console.log(`[w${workerId}] ${processed}/${todo.length} (${elapsed}s, ETA ${eta}s, 라인매칭 ${matchedLines}/${totalLines}=${matchPct}%)`);
        }
      } catch (e) {
        fs.appendFileSync(OUT, JSON.stringify({ image: t.image, error: e.message }) + '\n');
      }
    }
  }

  await Promise.all([...Array(concurrency)].map((_, i) => worker(i)));

  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  console.log('\n=== 완료 ===');
  console.log(`처리: ${processed} 장 / ${elapsed}s`);
  console.log(`라인 매칭: ${matchedLines} / ${totalLines} (${totalLines ? (matchedLines * 100 / totalLines).toFixed(1) : '-'}%)`);
  console.log('결과:', OUT);
})();
