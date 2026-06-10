'use strict';
// 정직한 라우터: 알려진 마감 스킬이 없는데 "마감/거래명세서" 의도 + 엑셀 첨부면,
// 일반 에이전트가 멋대로 결과를 만들지 못하게 정직하게 멈춘다. (잡담/단순질문은 막지 않음)

// ⚠️ 마감 의도의 "단일 출처(SSOT)" — agent-runtime.js detectLedgerSkillSlug 도 이 정규식을 공유한다.
// 여기 없는 단어로 들어온 모르는 거래처 마감이 일반 에이전트로 새는(멋대로 만드는) 구멍을 막는다.
const LEDGER_INTENT = /마감|거래\s*명세|명세서|원장|정리|내역서|청구|판매현황/;

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

function countXlsx(attachments = []) {
  if (!Array.isArray(attachments)) return 0;
  return attachments.filter(a => /\.xlsx$/i.test(String((a && (a.name || a.path)) || ''))).length;
}

// 모르는(미등록) 거래처 마감 요청을 분류한다.
//  - skill: 이미 등록된 스킬이 매칭됨 (기존 경로로 진행)
//  - passthrough: 마감 의도가 아니거나 xlsx 없음 (일반 에이전트로)
//  - ask-template: 마감 의도 + xlsx 1개(원본만) → 전월 양식 요청하며 멈춤
//  - generate: 마감 의도 + xlsx 2개+ (원본+양식) → AI가 양식대로 틀 생성
function classifyUnknownLedger({ matchedSlugs = [], task = '', attachments = [] } = {}) {
  if (Array.isArray(matchedSlugs) && matchedSlugs.length) return { mode: 'skill' };
  if (!looksLikeLedgerRequest(task) || !hasXlsxAttachment(attachments)) return { mode: 'passthrough' };
  if (countXlsx(attachments) >= 2) return { mode: 'generate' };
  return {
    mode: 'ask-template',
    message: [
      '이건 아직 등록되지 않은(처음 보는) 거래처 작업이에요.',
      '멋대로 만들면 틀릴 수 있어서 멈췄습니다.',
      '',
      '👉 전월 마감 양식(결과가 어떻게 나와야 하는지) xlsx를 같이 첨부해 주시면,',
      '   그 양식대로 처리해서 등록할 수 있어요.',
      '',
      '※ 마감이 아니라 단순 분석·요약이 필요하면 "분석해줘"라고 적어 주세요.',
    ].join('\n'),
  };
}

// generate 모드에서 일반 에이전트에 주입할 지시문(틀 만들기 규칙). 순수 함수.
function buildGenerationInstruction({ task = '' } = {}) {
  return [
    '=== 처음 하는 거래처 — 재사용 "틀" 만들기 ===',
    '첨부에 (1) 원본 데이터 xlsx 와 (2) 전월 마감 양식 xlsx 이 함께 있습니다. 아래를 반드시 지키세요:',
    '1) 전월 양식 파일을 openpyxl 의 load_workbook 으로 "그대로 열어" 서식·열·시트 구조를 유지한 채 데이터만 채웁니다. 양식을 새로 그리지 마세요.',
    '2) 원본에서 데이터를 읽어 양식의 해당 위치에 채웁니다.',
    '3) 이 변환을 수행하는 파이썬 스크립트를 워크스페이스에 make_generated.py 로 저장합니다(다음 재사용용).',
    '4) 결과 xlsx 를 워크스페이스에 생성합니다.',
    '5) 추정하지 마세요 — 원본을 못 읽거나 양식과 안 맞으면 멈추고 무엇이 문제인지 보고합니다.',
    '6) 결과 생성 후 stdout 에 검산표 한 줄을 출력합니다: [RECON] {"raw_rows":N,"raw_total":원본공급가액합,"excluded_rows":N,"excluded_total":제외합,"excluded_note":"사유","out_rows":N,"out_total":결과공급가액합} — "원본 = 결과 + 제외"가 맞아야 합니다.',
    '※ 이 결과는 아직 "임시(미승인)"입니다. 사장님 확인·등록 전까지는 정식 결과가 아닙니다.',
    '',
  ].join('\n');
}

module.exports = { LEDGER_INTENT, looksLikeLedgerRequest, hasXlsxAttachment, countXlsx, classifyUnknownLedger, buildGenerationInstruction };
