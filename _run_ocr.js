// 모든 슬라이드 OCR + 학습 풀 매칭 (사용자 PC 에서 실행)
// 사용법: cd C:\Users\NAMGW\Documents\Claude\Projects\업체별 단가표 만들기!!!\price-list-app
//        node _run_ocr.js
const fs = require('fs');
const path = require('path');

const cli = require('./lib/claude-cli');
const pool = require('./lib/learning-pool');

const SLIDES_DIR = path.join(__dirname, '_pptx_slides');
const META_PATH = path.join(SLIDES_DIR, '_meta.json');
const OUT = path.join(SLIDES_DIR, '_results.jsonl');
const STATUS = path.join(SLIDES_DIR, '_status.json');

const META = JSON.parse(fs.readFileSync(META_PATH, 'utf8'));

// 이미 처리한 거 skip (재시작 가능)
const done = new Set();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line);
      // 에러난 거는 다시 시도하도록
      if (!j.error) done.add(j.image);
    } catch(_){}
  }
}
console.log(`[ocr] 이미 처리: ${done.size} / 전체 ${META.length}`);

const PROMPT = `이 시안 이미지의 모든 텍스트를 추출하세요. 디자인 시안에 보이는 글자를 그대로.
JSON 만 출력 (마크다운 X):
{"text": "추출된 텍스트 (줄바꿈은 \\n)"}
글자 안 보이면 "text": "".`;

(async () => {
  await pool.load();
  const todo = META.filter(m => !done.has(m.image));
  console.log(`[ocr] 처리 시작: ${todo.length}`);
  const concurrency = 6;
  let cursor = 0;
  let processed = 0;
  const startedAt = Date.now();

  // 새 시작이면 기존 결과 백업/리셋
  if (fs.existsSync(OUT) && done.size === 0) {
    fs.renameSync(OUT, OUT + '.failed.bak');
  }

  async function worker(workerId) {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) break;
      const m = todo[i];
      const fullImage = path.join(SLIDES_DIR, m.image);
      try {
        const r = await cli.callClaudeCli(PROMPT, [fullImage], { model: 'claude-sonnet-4-6', timeout: 120000 });
        let text = '';
        try {
          const parsed = cli.parseJsonFromResponse(r.text || '');
          text = parsed.text || '';
        } catch(_) {
          text = (r.text || '').slice(0, 200);
        }
        const match = pool.matchCompanySaleItem(
          { item_name: text.split('\n')[0] || '', spec: '' },
          { dateStr: m.date, dayRange: 0, pptxCategory: m.cat, textHint: text }
        );
        const entry = {
          ...m, ocrText: text,
          matched: match.matched ? `${match.matched.item}/${match.matched.spec}/${match.matched.qty}` : null,
          score: match.score, reason: match.reason,
          candidateCount: match.candidateCount,
        };
        fs.appendFileSync(OUT, JSON.stringify(entry) + '\n');
        processed++;
        if (processed % 10 === 0) {
          const elapsed = Math.round((Date.now() - startedAt) / 1000);
          const rate = processed / elapsed;
          const eta = Math.round((todo.length - processed) / rate);
          fs.writeFileSync(STATUS, JSON.stringify({ processed, total: todo.length, elapsed, eta_sec: eta, rate: rate.toFixed(2) }));
          console.log(`[ocr] ${processed}/${todo.length} (${elapsed}s, ${rate.toFixed(2)}/s, ETA ${Math.round(eta/60)}분)`);
        }
      } catch (e) {
        fs.appendFileSync(OUT, JSON.stringify({ ...m, error: e.message }) + '\n');
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  console.log(`[ocr] ✅ 완료: ${processed} 처리 / 전체 ${todo.length}`);
})();
