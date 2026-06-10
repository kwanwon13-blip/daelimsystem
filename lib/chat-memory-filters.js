/**
 * lib/chat-memory-filters.js — 회사 기억 순수 함수 (DB 무관, 단독 테스트 가능)
 * 정규화 / 카테고리 화이트리스트 / 위험탐지(PII·비밀·명령형·부정).
 * 안전강도 "중간": secret=reject, pii/command/negation/badCategory=pending, 그 외 active.
 */

const ALLOWED_CATEGORIES = ['거래처', '품목', '규칙', '용어'];

// learning-pool 의 norm 패턴 재사용 — 소문자 + 공백/괄호/일부구두점 + 회사표기 제거
function normKey(s) {
  if (!s) return '';
  return String(s).toLowerCase().replace(/\s+/g, '').replace(/[()/\-_.,]/g, '')
    .replace(/㈜|\(주\)|\(유\)|주식회사|유한회사/g, '');
}

function isAllowedCategory(c) {
  return ALLOWED_CATEGORIES.includes(String(c || '').trim());
}

// 비밀/키 — 발견 시 절대 저장 안 함(reject)
const SECRET_RES = [
  /\bsk-[A-Za-z0-9]{8,}/,
  /\bAIza[0-9A-Za-z_\-]{10,}/,
  /\bBearer\s+[A-Za-z0-9._\-]{10,}/i,
  /\bxox[baprs]-[A-Za-z0-9-]{8,}/,
  /(비밀번호|패스워드|password|passwd|pw)\s*[:=]\s*\S+/i,
];
function detectSecret(text) {
  const s = String(text || '');
  for (const re of SECRET_RES) if (re.test(s)) return { hit: true, rule: re.source };
  return { hit: false };
}

// 개인정보 — 발견 시 보류(pending)
const PII_RES = [
  /\b\d{6}-\d{7}\b/,                          // 주민번호
  /\b01[016-9]-?\d{3,4}-?\d{4}\b/,            // 휴대폰
  /(연봉|월급|급여|상여|인센티브)\s*\d/,       // 급여 + 숫자
  /(월차|반차|연차|휴가|징계|인사평가|근태)/,    // 인사/근태
  /\b\d{2,6}-\d{2,6}-\d{2,7}\b/,             // 계좌/카드형 숫자그룹
];
function detectPII(text) {
  const s = String(text || '');
  for (const re of PII_RES) if (re.test(s)) return { hit: true, rule: re.source };
  return { hit: false };
}

// 명령형/탈옥 — 포이즈닝 의심, 보류(pending)
const COMMAND_RES = [
  /무시(하고|하라|하세요|해라|해|할|하)/,                     // "무시" 단독(지시 없이도)
  /따르지\s*마/,
  /\b(ignore|disregard|override)\b/i,
  /\binstead of\b/i,
  /시스템\s*프롬프트/,
  /(항상|무조건|반드시|모든|언제나).*(해라|하라|하세요|답해|답하라|적어|바꿔|변경|대답)/,
];
function detectCommandForm(text) {
  const s = String(text || '');
  for (const re of COMMAND_RES) if (re.test(s)) return { hit: true, rule: re.source };
  return { hit: false };
}

// 부정/교정 — 기존 기억의 취소/수정 신호일 수 있어 보류(pending)
// (한국어는 ASCII \b 가 불안정 → \b 미사용)
const NEGATION_RES = [
  /안\s*(함|해|씀|쓴다|쓴대|한다)/,
  /않(는다|아|음|는)/,
  /아니(다|야|에요|예요|었)/,
  /별도\s*아(님|니)/,
  /(이제|더는|더이상)\s*안/,
  /(취소|폐기|철회|틀렸|잘못(됐|된|되))/,
];
function detectNegation(text) {
  const s = String(text || '');
  for (const re of NEGATION_RES) if (re.test(s)) return { hit: true, rule: re.source };
  return { hit: false };
}

// 통합 판정 — decision: 'reject' | 'pending' | 'active'
function classifyRisk(content, category) {
  if (detectSecret(content).hit) return { decision: 'reject', reason: 'secret' };
  const reasons = [];
  if (!isAllowedCategory(category)) reasons.push('badCategory');
  if (detectPII(content).hit) reasons.push('pii');
  if (detectCommandForm(content).hit) reasons.push('command');
  if (detectNegation(content).hit) reasons.push('negation');
  if (reasons.length) return { decision: 'pending', reason: reasons.join(',') };
  return { decision: 'active', reason: '' };
}

module.exports = {
  ALLOWED_CATEGORIES, normKey, isAllowedCategory,
  detectSecret, detectPII, detectCommandForm, detectNegation, classifyRisk,
};
