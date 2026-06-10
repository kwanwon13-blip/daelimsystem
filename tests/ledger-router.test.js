const assert = require('node:assert');
const r = require('../lib/ledger-router');

// --- looksLikeLedgerRequest: 마감 의도 키워드 (agent-runtime 과 SSOT 공유) ---
assert.strictEqual(r.looksLikeLedgerRequest('퍼시스 마감해줘'), true);
assert.strictEqual(r.looksLikeLedgerRequest('거래명세서 만들어줘'), true);
assert.strictEqual(r.looksLikeLedgerRequest('이번달 원장 정리'), true);
assert.strictEqual(r.looksLikeLedgerRequest('판매현황 정리해줘'), true);   // '정리'/'판매현황' 도 의도 (구멍 메움)
assert.strictEqual(r.looksLikeLedgerRequest('엘지 청구 내역 뽑아줘'), true); // '청구'
assert.strictEqual(r.looksLikeLedgerRequest('안녕 오늘 날씨 어때'), false);
assert.strictEqual(r.looksLikeLedgerRequest('이 엑셀 무슨 뜻이야'), false);
assert.strictEqual(r.looksLikeLedgerRequest('이 파일 분석해줘'), false);   // 탈출구: 분석/요약은 통과

// --- hasXlsxAttachment ---
assert.strictEqual(r.hasXlsxAttachment([{ name: '판매현황.xlsx' }]), true);
assert.strictEqual(r.hasXlsxAttachment([{ path: '/x/y.XLSX' }]), true);
assert.strictEqual(r.hasXlsxAttachment([{ name: 'photo.png' }]), false);
assert.strictEqual(r.hasXlsxAttachment([]), false);

// --- classifyUnknownLedger ---
assert.strictEqual(r.classifyUnknownLedger({ matchedSlugs: ['persys-ledger'], task: '마감', attachments: [{ name: 'a.xlsx' }] }).mode, 'skill');
assert.strictEqual(r.classifyUnknownLedger({ matchedSlugs: [], task: '안녕', attachments: [] }).mode, 'passthrough');
assert.strictEqual(r.classifyUnknownLedger({ matchedSlugs: [], task: '이 파일 요약해줘', attachments: [{ name: 'a.xlsx' }] }).mode, 'passthrough');
assert.strictEqual(r.classifyUnknownLedger({ matchedSlugs: [], task: '새거래처 마감', attachments: [{ name: 'raw.xlsx' }] }).mode, 'ask-template');
// '정리' 도 마감 의도 → 모르는 거래처면 멈춤 (멋대로 안 만듦)
{
  const g = r.classifyUnknownLedger({ matchedSlugs: [], task: '새거래처꺼 정리해줘', attachments: [{ name: 'raw.xlsx' }] });
  assert.strictEqual(g.mode, 'ask-template');
  assert.ok(/양식/.test(g.message));
  assert.ok(/분석해줘/.test(g.message)); // 마감 아닐 때의 탈출구 안내
}
{
  const g = r.classifyUnknownLedger({ matchedSlugs: [], task: '새거래처 마감', attachments: [{ name: 'raw.xlsx' }, { name: '전월양식.xlsx' }] });
  assert.strictEqual(g.mode, 'generate');
}
// --- buildGenerationInstruction ---
{
  const t = r.buildGenerationInstruction({ task: 'x' });
  assert.ok(/양식/.test(t));
  assert.ok(/make_generated\.py/.test(t));
  assert.ok(/임시/.test(t));
}

console.log('PASS ledger-router');
