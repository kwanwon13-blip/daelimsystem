// 매입명세서 사진 거래처별 분류 (1단계)
// 사용법: cd price-list-app && node _classify_purchase_slips.js
//
// 68장 카톡 사진을 Claude Sonnet vision 으로 거래처/일자/합계 추출만 (자세한 품목은 다음 단계).

const fs = require('fs');
const path = require('path');
const cli = require('./lib/claude-cli');

const SLIPS_DIR = path.join(__dirname, 'learning-data', '03_컴퍼니매입', '컴퍼니 매입자료');
const OUT = path.join(__dirname, 'learning-data', '03_컴퍼니매입', 'mappings', '_classify_results.jsonl');

const PROMPT = `이 거래명세서 사진을 보고 JSON 으로만 답변해. 마크다운 X.

추출할 항목:
- vendor: 공급자/판매처 회사명 (예: "이노사인", "이노텍", "한울상사", "DSD리테일", "디에스디리테일", "해냄", "다모아안전", "제이케이", "디오테크", 그 외도 그대로 적기)
- date: 납품/거래 일자 (YYYY-MM-DD 형식, 안 보이면 빈 문자열)
- total: 당일 거래 총액 (숫자만, 안 보이면 0)
- billNo: 증빙번호/세금계산서번호 (안 보이면 빈 문자열)
- itemCount: 품목 행 개수 (몇 줄인지)
- rotated: 사진이 회전돼있으면 true (옆으로 누워있거나 거꾸로)

거래처 이름은 사진에 적힌 그대로 (괄호/주식회사 빼고 핵심만).
사진이 명세서 아니면 vendor를 "기타"로.

응답 형식:
{"vendor":"이노사인","date":"2026-01-07","total":1499850,"billNo":"STX2026010700006","itemCount":6,"rotated":false}`;

(async () => {
  const files = fs.readdirSync(SLIPS_DIR).filter(f => /\.(jpg|jpeg|png)$/i.test(f)).sort();
  console.log('[classify] 전체:', files.length, '장');

  // 이미 처리된 거 skip
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
  console.log('[classify] 이미 처리:', done.size);
  const todo = files.filter(f => !done.has(f));
  console.log('[classify] 처리 시작:', todo.length);

  const concurrency = 4;
  let cursor = 0;
  let processed = 0;
  const startedAt = Date.now();

  async function worker(workerId) {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) break;
      const f = todo[i];
      const imgPath = path.join(SLIPS_DIR, f);
      try {
        const r = await cli.callClaudeCli(PROMPT, [imgPath], {
          model: 'claude-sonnet-4-6',
          timeout: 90000,
        });
        let parsed = {};
        try {
          parsed = cli.parseJsonFromResponse(r.text || '');
        } catch(e) {
          parsed = { error: 'parse_fail', raw: (r.text || '').slice(0, 200) };
        }
        const entry = {
          image: f,
          ...parsed,
          ms: r.durationMs,
        };
        fs.appendFileSync(OUT, JSON.stringify(entry) + '\n');
        processed++;
        if (processed % 5 === 0) {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const rate = processed / Math.max(elapsed, 1);
          const eta = Math.round((todo.length - processed) / Math.max(rate, 0.001));
          console.log(`[w${workerId}] ${processed}/${todo.length} (${elapsed}s, ETA ${eta}s)`);
        }
      } catch(e) {
        fs.appendFileSync(OUT, JSON.stringify({ image: f, error: e.message }) + '\n');
        console.log(`[w${workerId}] ${f} ERROR: ${e.message}`);
      }
    }
  }

  // 디렉토리 보장
  try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); } catch(_){}

  await Promise.all([...Array(concurrency)].map((_, i) => worker(i)));
  console.log('[classify] 완료');
  console.log('결과:', OUT);
})();
