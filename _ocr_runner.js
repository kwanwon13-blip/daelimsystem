// 모든 슬라이드 OCR + 학습 풀 매칭
const fs = require('fs');
const path = require('path');

process.chdir('/sessions/epic-peaceful-bohr/mnt/업체별 단가표 만들기!!!/price-list-app');
const cli = require('./lib/claude-cli');
const pool = require('./lib/learning-pool');

const META = JSON.parse(fs.readFileSync('/tmp/pptx_slides/_meta.json', 'utf8'));
const OUT = '/tmp/pptx_slides/_results.jsonl';
const STATUS = '/tmp/pptx_slides/_status.json';

// 이미 처리한 거 skip (재시작 가능)
const done = new Set();
if (fs.existsSync(OUT)) {
  for (const line of fs.readFileSync(OUT, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { done.add(JSON.parse(line).image); } catch(_){}
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
  const concurrency = 8;
  let cursor = 0;
  let processed = 0;
  const startedAt = Date.now();

  async function worker(workerId) {
    while (true) {
      const i = cursor++;
      if (i >= todo.length) break;
      const m = todo[i];
      try {
        const r = await cli.callClaudeCli(PROMPT, [m.image], { model: 'claude-haiku-4-5', timeout: 60000 });
        let text = '';
        try {
          const parsed = cli.parseJsonFromResponse(r.text || '');
          text = parsed.text || '';
        } catch(_) {
          text = (r.text || '').slice(0, 200);
        }
        // 학습 풀 매칭
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
        if (processed % 20 === 0) {
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
