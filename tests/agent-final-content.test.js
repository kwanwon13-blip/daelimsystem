const assert = require('node:assert');
const { buildAgentFinalContent, FRIENDLY_ERROR } = require('../lib/agent-final-content');

// ① 정직한 멈춤(unknownTask): 가드 안내문이 본문 — "작업 완료 0개 파일"로 위장 금지
{
  const guardMsg = '이건 아직 등록되지 않은(처음 보는) 거래처 작업이에요.\n👉 전월 마감 양식 xlsx를 같이 첨부해 주세요.';
  const t = buildAgentFinalContent({ lastDone: { unknownTask: true, files: [] }, collectedOutput: guardMsg, createdArtifacts: [], finalFiles: [] });
  assert.ok(t.includes('등록되지 않은'), 'unknownTask 면 가드 안내문이 본문이어야 함');
  assert.ok(!/작업 완료/.test(t), 'unknownTask 가 "작업 완료"로 보이면 안 됨');
}
// ② collectedOutput 이 비어도 기본 안내문
{
  const t = buildAgentFinalContent({ lastDone: { unknownTask: true }, collectedOutput: '', createdArtifacts: [], finalFiles: [] });
  assert.ok(/양식/.test(t));
}
// ③ 자동점검 🚩 → 헤드라인에 떠야 함 + 사유 노출
{
  const t = buildAgentFinalContent({
    lastDone: { durationMs: 5000, check: { status: 'warn', reasons: ['결과 파일 "a.xlsx"에 데이터가 거의 없습니다 (확인 필요).'], summary: { fileCount: 1, totalRows: 1 } } },
    createdArtifacts: [{ name: 'a.xlsx' }], finalFiles: [], collectedOutput: '로그',
  });
  assert.ok(t.startsWith('🚩 확인 필요'), '점검 warn 이면 🚩 헤드라인');
  assert.ok(t.includes('a.xlsx'), '사유 표시');
}
// ④ 점검 통과(또는 점검 없음) → 기존 완료 헤드라인 유지
{
  const t = buildAgentFinalContent({
    lastDone: { durationMs: 3000, check: { status: 'pass', reasons: [], summary: { fileCount: 1, totalRows: 30 } } },
    createdArtifacts: [{ name: 'b.xlsx' }], finalFiles: [], collectedOutput: '',
  });
  assert.ok(t.startsWith('Agent 작업 완료'));
}
// ⑤ 회귀: 중단/실패 경로 그대로
assert.ok(buildAgentFinalContent({ userStopped: true, createdArtifacts: [], finalFiles: [] }).startsWith('⏹'));
{
  const t = buildAgentFinalContent({ lastError: { message: 'x' }, errorCode: 'TEMPLATE_MISSING', createdArtifacts: [], finalFiles: [], collectedOutput: '' });
  assert.ok(t.includes(FRIENDLY_ERROR.TEMPLATE_MISSING.slice(0, 10)));
}
// ⑥ 회귀: 템플릿 저장 경로 그대로
assert.ok(buildAgentFinalContent({ lastDone: { templateSaved: ['전월.xlsx'] }, createdArtifacts: [], finalFiles: [] }).includes('템플릿 저장 완료'));

console.log('PASS agent-final-content');
