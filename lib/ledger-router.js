'use strict';
// 정직한 라우터: 알려진 마감 스킬이 없는데 "마감/거래명세서" 의도 + 엑셀 첨부면,
// 일반 에이전트가 멋대로 결과를 만들지 못하게 정직하게 멈춘다. (잡담/단순질문은 막지 않음)

const LEDGER_INTENT = /마감|거래\s*명세|명세서|원장|내역서|청구서|청구\s*내역/;

function looksLikeLedgerRequest(task = '') {
  return LEDGER_INTENT.test(String(task || ''));
}

function hasXlsxAttachment(attachments = []) {
  if (!Array.isArray(attachments)) return false;
  return attachments.some(a => {
    const n = (a && (a.name || a.path)) || '';
    return /\.xlsx$/i.test(String(n));
  });
}

// matchedSlugs: detectBundledSkillSlugs 결과(배열). 빈 배열이면 미감지.
// 반환: { stop: boolean, message?: string }
function unknownLedgerGuard({ matchedSlugs = [], task = '', attachments = [] } = {}) {
  if (Array.isArray(matchedSlugs) && matchedSlugs.length) return { stop: false };
  if (looksLikeLedgerRequest(task) && hasXlsxAttachment(attachments)) {
    return {
      stop: true,
      message: [
        '이건 아직 등록되지 않은(처음 보는) 거래처 작업이에요.',
        '멋대로 만들면 틀릴 수 있어서 멈췄습니다.',
        '',
        '👉 전월 마감 양식(결과가 어떻게 나와야 하는지) xlsx를 같이 첨부해 주시면,',
        '   그 양식대로 처리해서 등록할 수 있어요.',
      ].join('\n'),
    };
  }
  return { stop: false };
}

module.exports = { LEDGER_INTENT, looksLikeLedgerRequest, hasXlsxAttachment, unknownLedgerGuard };
