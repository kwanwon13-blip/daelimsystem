'use strict';
// AI 이미지 자기정리 1단계(규칙기반) — 프롬프트에서 종류(type)·거래처(client)·키워드(keywords) 추출.
// 순수·결정적·의존성 0. 같은 입력이면 항상 같은 출력(테스트 가능).
// 2단계(임베딩) 준비: 시그니처를 유지하고 순수하게 둠 — 추후 임베딩 보강 시 호출부만 확장.

// ── 이미지 종류(type) 규칙 ────────────────────────────────────────────────
// 우선순위 순서(앞에서 먼저 매칭되면 확정). 키워드는 소문자화한 프롬프트에서 검사.
const TYPE_RULES = [
  { type: 'logo', re: /(로고|엠블럼|\bci\b|\bbi\b|logo|emblem)/ },
  { type: 'banner', re: /(현수막|배너|시안|족자|x배너|현판|banner|signage)/ },
  { type: 'product', re: /(제품|상품|패키지|목업|mockup|패키징|package)/ },
  { type: 'character', re: /(캐릭터|마스코트|이모티콘|character|mascot)/ },
  { type: 'social', re: /(인스타|썸네일|sns|피드|스토리|instagram|thumbnail)/ },
  { type: 'background', re: /(배경화면|월페이퍼|배경|background|wallpaper)/ },
  { type: 'poster', re: /(포스터|홍보물|전단|poster|flyer|leaflet)/ },
];

// type 키 목록(순서 = 우선순위, 마지막은 기본값 'etc').
const IMAGE_TYPES = TYPE_RULES.map(r => r.type).concat('etc');

// ── 거래처(client) 사전 ───────────────────────────────────────────────────
// alias(소문자)가 프롬프트(+context)에 등장하면 해당 name 반환. 첫 매칭 우선.
const KNOWN_CLIENTS = [
  { name: '포스코', alias: ['포스코', '포스코이앤씨', 'posco'] },
  { name: 'DL', alias: ['dl', '디엘', '대림'] },
  { name: '퍼시스', alias: ['퍼시스', 'persys'] },
  { name: '두산', alias: ['두산', 'doosan'] },
  { name: '한신', alias: ['한신', '한신공영'] },
  { name: '요진', alias: ['요진', '요진건설'] },
  { name: '쌍용', alias: ['쌍용'] },
  { name: '골든플랫폼', alias: ['골든플랫폼', 'golden'] },
  { name: '라코스', alias: ['라코스', 'lacos'] },
  { name: '이상테크', alias: ['이상테크'] },
  { name: '하츠', alias: ['하츠', 'haatz'] },
  { name: '나이스텍', alias: ['나이스텍', 'nicetech'] },
];

// ── 키워드 추출용 불용어 ───────────────────────────────────────────────────
// 생성 지시어/꾸밈말처럼 식별에 도움 안 되는 토큰 제거.
const STOPWORDS = new Set([
  '시안', '이미지', '만들', '만들기', '그려', '그려줘', '좀', '해줘', '느낌',
  '스타일', '버전', '으로', '하게', '해서', '하는', '같은', '들어', '들어간',
  '그리고', '또는', '그림', '디자인', '제작', '하나', '으로된', '에서',
]);

// 프롬프트 정규화 (소문자·공백정규화·트림) — routes의 normalizePrompt / db의 prompt_norm 과 동일 규칙.
function normalize(p) {
  return String(p || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

// 종류(type) 판정 — TYPE_RULES 우선순위대로 첫 매칭. 없으면 'etc'.
function detectType(lower) {
  for (const rule of TYPE_RULES) {
    if (rule.re.test(lower)) return rule.type;
  }
  return 'etc';
}

// 거래처(client) 판정 — KNOWN_CLIENTS 순서대로, alias 중 하나라도 포함되면 그 name. 없으면 ''.
function detectClient(lower) {
  // 라틴/숫자 토큰 집합 — 짧은 라틴 별칭(dl 등)은 단어 단위로만 매칭(candle/handle 오탐 방지)
  const latinTokens = new Set(lower.match(/[a-z0-9]+/g) || []);
  for (const c of KNOWN_CLIENTS) {
    for (const a of c.alias) {
      const shortLatin = /^[a-z0-9]{1,2}$/.test(a);
      if (shortLatin ? latinTokens.has(a) : lower.includes(a)) return c.name;
    }
  }
  return '';
}

// 한글 조사 제거 — '현수막을'→'현수막', '포스코의'→'포스코'. 어간이 2글자 이상일 때만 벗김(국가/물가 등 2글자 명사 보호).
const JOSA2 = ['에서', '으로', '에게', '한테', '까지', '부터', '보다', '처럼', '같이'];
function stripJosa(t) {
  for (const j of JOSA2) {
    if (t.endsWith(j) && t.length - j.length >= 2) return t.slice(0, -j.length);
  }
  const last = t.charAt(t.length - 1);
  if (/[을를이가은는의에로와과도만랑]/.test(last) && t.length - 1 >= 2) return t.slice(0, -1);
  return t;
}

// 키워드 추출 — 2글자 이상 한글/영문 토큰 → 조사 제거 → 불용어 제거 → 등장순 유지, 상위 4개 고유 토큰.
function extractKeywords(lower) {
  const tokens = lower.match(/[가-힣a-z0-9]+/g) || [];
  const seen = new Set();
  const out = [];
  for (let t of tokens) {
    t = stripJosa(t);
    if (t.length < 2) continue;
    if (STOPWORDS.has(t)) continue;
    if (seen.has(t)) continue;
    seen.add(t);
    out.push(t);
    if (out.length >= 4) break;
  }
  return out.join(',');
}

/**
 * classifyImage — 프롬프트(+선택 context)에서 종류·거래처·키워드 도출.
 * @param {string} prompt 사용자 프롬프트
 * @param {{context?: string}} [opts] context는 client 매칭에만 추가 사용(페이지 컨텍스트 등)
 * @returns {{type: string, client: string, keywords: string}}
 */
function classifyImage(prompt, opts) {
  const promptLower = normalize(prompt);
  // client 매칭은 prompt + context 둘 다에서. type/keywords 는 prompt 본문만.
  const ctx = opts && opts.context ? normalize(opts.context) : '';
  const clientHaystack = ctx ? `${promptLower} ${ctx}` : promptLower;
  return {
    type: detectType(promptLower),
    client: detectClient(clientHaystack),
    keywords: extractKeywords(promptLower),
  };
}

module.exports = { classifyImage, KNOWN_CLIENTS, IMAGE_TYPES };
