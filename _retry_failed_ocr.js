// timeout 등 실패한 OCR만 재시도
const fs = require('fs');
const path = require('path');
const cli = require('./lib/claude-cli');
const pool = require('./lib/learning-pool');

const SLIDES_DIR = path.join(__dirname, '_pptx_slides');
const RESULTS = path.join(SLIDES_DIR, '_results.jsonl');

const PROMPT = `이 시안 이미지의 모든 텍스트를 추출하세요. 디자인 시안에 보이는 글자를 그대로.
JSON 만 출력 (마크다운 X):
{"text": "추출된 텍스트 (줄바꿈은 \\n)"}
글자 안 보이면 "text": "".`;

(async () => {
  await pool.load();
  const lines = fs.readFileSync(RESULTS, 'utf8').split('\n').filter(l => l.trim());
  const records = lines.map(l => { try { return JSON.parse(l); } catch(_){ return null; } }).filter(Boolean);

  const failed = records.filter(r => r.error);
  console.log(`실패한 OCR: ${failed.length}건 — 재시도`);
  for (const f of failed) console.log(`  - ${f.image}: ${f.error}`);

  if (failed.length === 0) {
    console.log('재시도할 거 없음.');
    process.exit(0);
  }

  // 재시도 — 더 긴 timeout (180초)
  const updated = new Map(); // image → 새 record
  for (let i = 0; i < failed.length; i++) {
    const f = failed[i];
    const fullImage = path.join(SLIDES_DIR, f.image);
    process.stdout.write(`[${i+1}/${failed.length}] ${f.image} ... `);
    try {
      const r = await cli.callClaudeCli(PROMPT, [fullImage], { model: 'claude-sonnet-4-6', timeout: 180000 });
      let text = '';
      try {
        const parsed = cli.parseJsonFromResponse(r.text || '');
        text = parsed.text || '';
      } catch(_) {
        text = (r.text || '').slice(0, 200);
      }
      // 새 record 만들기 (error 빼고)
      const newRec = {
        pptx: f.pptx, slide: f.slide, date: f.date, cat: f.cat,
        image: f.image, size: f.size, ocrText: text,
        matched: null, score: 0, reason: '재OCR완료', candidateCount: 0,
      };
      updated.set(f.image, newRec);
      console.log(`OK (${text.length}자)`);
    } catch (e) {
      console.log(`FAIL: ${e.message}`);
    }
  }

  // results.jsonl 다시 쓰기 — 실패였던 행을 새 행으로 교체
  const newLines = records.map(r => {
    if (updated.has(r.image)) return JSON.stringify(updated.get(r.image));
    return JSON.stringify(r);
  });
  fs.writeFileSync(RESULTS, newLines.join('\n') + '\n');
  console.log(`\n✓ ${updated.size}건 재OCR 완료, _results.jsonl 갱신`);
})();
