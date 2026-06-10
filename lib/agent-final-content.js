'use strict';
// Agent 실행 결과 → 챗 최종 메시지 본문 (순수 함수 — routes/ai-agent.js 와 테스트가 공용).
// 핵심 규칙: ① 정직한 멈춤(unknownTask)은 안내문이 본문 — "작업 완료 0개 파일"로 위장 금지
//           ② 자동점검 🚩(check.status warn/fail)는 헤드라인에 떠야 함 — 로그 꼬리에 묻히면 무의미

// 마감 스킬 실패 코드별 직원용 안내 (raw stderr 대신 이걸 먼저 보여줌)
const FRIENDLY_ERROR = {
  RAW_MISSING:    '원본 판매현황 파일을 찾지 못했어요. "판매현황" 시트가 있는 엑셀을 첨부했는지 확인해 주세요.',
  TEMPLATE_MISSING: '이 업체의 전월 마감 양식(템플릿)이 등록돼 있지 않아요. 전월 마감내역서 엑셀을 한 번 첨부하면 다음부터는 판매현황만 올려도 됩니다.',
  NO_SALES_SHEET: '첨부한 엑셀에 "판매현황" 시트가 없어요. eCount 판매현황 원본을 첨부했는지 확인해 주세요.',
  BAD_TEMPLATE:   '등록된 템플릿 양식이 올바르지 않아요(필요한 시트를 찾지 못함). 정상적인 전월 마감내역서로 다시 등록해 주세요.',
  NO_DATA:        '처리할 데이터가 없어요. 판매현황에 해당 월 데이터가 들어있는지 확인해 주세요.',
  NO_OUTPUT:      '생성된 결과가 없어요. 데이터·템플릿을 다시 확인해 주세요.',
};

function buildAgentFinalContent({ status, lastError, lastDone, finalFiles, createdArtifacts, collectedOutput, userStopped, errorCode }) {
  // 사용자가 명시적으로 중단한 경우 — 오류가 아니라 '중단됨' 으로 표시 (여태 만든 파일은 아래서 카드로 노출)
  if (userStopped) {
    const made = createdArtifacts && createdArtifacts.length
      ? `\n\n중단 전까지 생성된 파일 ${createdArtifacts.length}개는 아래에서 받을 수 있어요.` : '';
    return '⏹ 작업을 중단했어요.' + made;
  }
  if (lastError) {
    // 종료코드별 친절 안내 (있으면) — 미매핑 코드도 raw 메시지 대신 깔끔한 일반 안내로 (raw 는 접이식 로그에)
    const friendly = errorCode
      ? (FRIENDLY_ERROR[errorCode] || '작업을 끝내지 못했어요. 입력 파일과 요청을 확인하고 다시 시도해 주세요.')
      : '';
    const tail = String(collectedOutput || '').trim().slice(-2500);
    const head = friendly
      ? friendly
      : ('작업에 실패했어요: ' + (lastError.message || '알 수 없는 오류'));
    const partial = createdArtifacts && createdArtifacts.length
      ? `\n\n(실패 전까지 생성된 파일 ${createdArtifacts.length}개는 아래에서 받을 수 있어요.)` : '';
    return head + partial
      + (tail ? '\n\n<details>\n<summary>실행 로그 보기</summary>\n\n```text\n' + tail + '\n```\n</details>' : '');
  }
  if (lastDone?.templateSaved?.length) {
    return `템플릿 저장 완료 (${lastDone.templateSaved.join(', ')})`;
  }
  // 정직한 멈춤(미등록 작업): 가드 안내문이 곧 본문 — "Agent 작업 완료 (0개 파일)" 로 보이면 안 된다.
  if (lastDone?.unknownTask) {
    const msg = String(collectedOutput || '').trim();
    return msg || '아직 등록되지 않은 작업이라 멈췄어요. 전월 마감 양식 xlsx를 함께 첨부해 주세요.';
  }
  const durationSec = Math.round((lastDone?.durationMs || 0) / 1000);
  const fileCount = createdArtifacts.length || finalFiles.length;
  // 자동점검 결과가 헤드라인을 결정 (스펙 §4.5 — 🚩가 로그에 묻히지 않게)
  const check = lastDone && lastDone.check;
  const flagged = !!(check && (check.status === 'warn' || check.status === 'fail'));
  const lines = [flagged
    ? `🚩 확인 필요 — 작업은 끝났지만 자동점검에 걸렸어요 (${fileCount}개 파일, ${durationSec}초)`
    : `Agent 작업 완료 (${fileCount}개 파일, ${durationSec}초)`];
  if (flagged && Array.isArray(check.reasons) && check.reasons.length) {
    lines.push('', ...check.reasons.map(r => `· ${r}`));
  }
  if (createdArtifacts.length) {
    lines.push('', '생성 파일:');
    for (const a of createdArtifacts) {
      lines.push(`- ${a.name || a.filename || 'file'}`);
    }
  }
  const output = String(collectedOutput || '').trim();
  if (output) {
    const tail = output.slice(-3500);
    lines.push('', '실행 요약:', '```text', tail, '```');
  }
  return lines.join('\n');
}

module.exports = { FRIENDLY_ERROR, buildAgentFinalContent };
