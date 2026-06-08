// lib/ai-memory/tokenizer.js
// 한국어 친화 토크나이저.
// odysseus(src/chat_processor.py:_content_tokens)는 정규식이 [a-z0-9]+ 라서 한글이 토큰 0개로 나온다.
// → ERP(한국어)에서는 키워드 recall이 통째로 죽으므로 반드시 교체해야 하는 부분.
//
// 전략(형태소 분석기 없이 견고하게):
//   1) 영문/숫자/코드 런: 그대로(소문자) + 영문 불용어 제거  (BN, banner, 2024, sku-12 …)
//   2) 한글 런: 조사 제거 어간 + 음절 bigram 동시 방출
//      - 어간: 정확 단어 매칭 가속
//      - bigram: 조사/띄어쓰기 흔들림에도 매칭 (예: "거래처단가" → 거래/래처/처단/단가)
// BM25는 메모리가 짧아 binary presence(토큰 Set)로 쓰므로 어간+bigram 중복은 Set에서 자연 흡수.

const EN_STOP = new Set(
  ("a an the is am are was were be been being have has had do does did will would can could may might must " +
   "to for of in on at by with from and or but not no so if then this that these those it its i me my we our " +
   "you your he she they them his her their what when where which who how why all any some more most very just " +
   "like about into over after as up out").split(/\s+/)
);

// 자주 붙는 조사/어미 — 보수적으로 "끝에서 1회만" 제거 (과도 제거로 의미 깨짐 방지)
const JOSA = [
  "으로서", "으로써", "이라고", "라고는", "에서는", "에게서", "이라는", "라는",
  "으로", "로서", "로써", "에서", "에게", "한테", "까지", "부터", "조차", "마저",
  "에는", "에도", "에만", "이나", "라며", "하며", "으며",
  "은", "는", "이", "가", "을", "를", "에", "의", "와", "과", "도", "만", "로", "께", "요", "님", "들", "고", "며", "서"
];

// 단독으로는 의미 약한 한글 토큰
const KO_STOP = new Set([
  "그", "이", "저", "것", "수", "등", "및", "더", "즉", "또", "또한", "그리고", "하지만", "그러나",
  "그래서", "때문", "위해", "대한", "관련", "경우", "정도", "통해", "합니다", "했습니다", "있습니다", "입니다", "해요", "하는"
]);

function stripJosa(w) {
  for (const j of JOSA) {
    if (w.length >= j.length + 2 && w.endsWith(j)) return w.slice(0, -j.length);
  }
  return w;
}

/** 텍스트 → 토큰 배열 (query·doc 동일 규칙으로 호출해야 매칭이 성립) */
function tokenize(text) {
  if (!text) return [];
  const src = String(text);
  const lower = src.toLowerCase();
  const out = [];

  // 1) 영문/숫자/코드 런
  for (const m of lower.matchAll(/[a-z0-9]+(?:[-_][a-z0-9]+)*/g)) {
    const w = m[0];
    if (w.length >= 2 && !EN_STOP.has(w)) out.push(w);
  }

  // 2) 한글 런: 어간 + bigram
  for (const m of src.matchAll(/[가-힣]+/g)) {
    const run = m[0];
    if (run.length === 1) {
      if (!KO_STOP.has(run)) out.push(run);
      continue;
    }
    const stem = stripJosa(run);
    if (stem.length >= 2 && !KO_STOP.has(stem)) out.push(stem);
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2)); // 음절 bigram
  }
  return out;
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

/** 자카드 유사도 (퍼지 중복제거용). 인자는 문자열 또는 Set 모두 허용 */
function jaccard(a, b) {
  const sa = a instanceof Set ? a : tokenSet(a);
  const sb = b instanceof Set ? b : tokenSet(b);
  if (sa.size === 0 && sb.size === 0) return 1;
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const t of sa) if (sb.has(t)) inter++;
  return inter / (sa.size + sb.size - inter);
}

/** 코드/숫자성 토큰인가 (품목코드·단가 등 정확 일치 부스트용) */
function isCodeLike(tok) {
  return /[0-9]/.test(tok) || /[a-z]+-[a-z0-9]/.test(tok);
}

module.exports = { tokenize, tokenSet, jaccard, isCodeLike, stripJosa };
