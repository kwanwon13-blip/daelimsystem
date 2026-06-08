const assert = require('node:assert');
const r = require('../lib/ledger-router');

// --- looksLikeLedgerRequest: 마감 의도 키워드 ---
assert.strictEqual(r.looksLikeLedgerRequest('퍼시스 마감해줘'), true);
assert.strictEqual(r.looksLikeLedgerRequest('거래명세서 만들어줘'), true);
assert.strictEqual(r.looksLikeLedgerRequest('이번달 원장 정리'), true);
assert.strictEqual(r.looksLikeLedgerRequest('안녕 오늘 날씨 어때'), false);
assert.strictEqual(r.looksLikeLedgerRequest('이 엑셀 무슨 뜻이야'), false);

// --- hasXlsxAttachment ---
assert.strictEqual(r.hasXlsxAttachment([{ name: '판매현황.xlsx' }]), true);
assert.strictEqual(r.hasXlsxAttachment([{ path: '/x/y.XLSX' }]), true);
assert.strictEqual(r.hasXlsxAttachment([{ name: 'photo.png' }]), false);
assert.strictEqual(r.hasXlsxAttachment([]), false);

// --- unknownLedgerGuard ---
// 스킬 매칭됨 → 통과(멈추지 않음)
assert.strictEqual(r.unknownLedgerGuard({ matchedSlugs: ['persys-ledger'], task: '퍼시스 마감', attachments: [{ name: 'a.xlsx' }] }).stop, false);
// 미매칭 + 마감의도 + xlsx → 멈춤 + 안내 메시지
{
  const g = r.unknownLedgerGuard({ matchedSlugs: [], task: '새거래처 마감해줘', attachments: [{ name: '판매현황.xlsx' }] });
  assert.strictEqual(g.stop, true);
  assert.ok(/처음 보는|등록되지|멈/.test(g.message));
  assert.ok(/양식/.test(g.message));
}
// 미매칭 + 마감의도지만 첨부 없음 → 통과(일반 질문일 수 있음)
assert.strictEqual(r.unknownLedgerGuard({ matchedSlugs: [], task: '퍼시스 마감 어떻게 해?', attachments: [] }).stop, false);
// 미매칭 + 잡담 + xlsx → 통과(일반 처리)
assert.strictEqual(r.unknownLedgerGuard({ matchedSlugs: [], task: '이 파일 요약해줘', attachments: [{ name: 'a.xlsx' }] }).stop, false);

// --- classifyUnknownLedger ---
assert.strictEqual(r.classifyUnknownLedger({ matchedSlugs: ['persys-ledger'], task: '마감', attachments: [{ name: 'a.xlsx' }] }).mode, 'skill');
assert.strictEqual(r.classifyUnknownLedger({ matchedSlugs: [], task: '안녕', attachments: [] }).mode, 'passthrough');
assert.strictEqual(r.classifyUnknownLedger({ matchedSlugs: [], task: '이 파일 요약해줘', attachments: [{ name: 'a.xlsx' }] }).mode, 'passthrough');
assert.strictEqual(r.classifyUnknownLedger({ matchedSlugs: [], task: '새거래처 마감', attachments: [{ name: 'raw.xlsx' }] }).mode, 'ask-template');
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
