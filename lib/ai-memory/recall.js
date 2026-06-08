// lib/ai-memory/recall.js
// 하이브리드 recall — odysseus src/chat_processor.py:_hybrid_retrieve(54) 1:1 포팅.
//   점수 = 0.55·벡터 + 0.40·키워드(BM25) + 0.05·recency      (벡터 있을 때)
//        = 0.95·키워드 + 0.05·recency                          (벡터 없을 때 = ERP 초기 MVP)
//   recency는 최대 5% tiebreaker로 못박음 — "최신이지만 무관"이 "오래됐지만 관련"을 이기지 못하게.
//   ERP 단가/견적 도메인에선 정확 코드/문구 일치에 점수 바닥 0.8을 줘 최우선 노출.

const { tokenize, isCodeLike } = require("./tokenizer");
const { untrustedBlock, UNTRUSTED_POLICY } = require("./untrusted");

function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

// candidates: store.visibleTo(actor) 결과(이미 scope 필터됨 = 보안 경계 적용 완료).
// queryEmbedding: 옵션. 주면 벡터 경로 활성화(candidate.embedding과 코사인). 없으면 키워드-only.
function hybridRetrieve(message, candidates, { k = 3, queryEmbedding = null } = {}) {
  if (!candidates || !candidates.length || !message || !message.trim()) return [];
  const now = Date.now() / 1000;
  const qTokenSet = new Set(tokenize(message));
  const msgLower = message.toLowerCase();
  const hasVec = Array.isArray(queryEmbedding) && queryEmbedding.length > 0;
  if (qTokenSet.size === 0 && !hasVec) return [];

  // ── 코퍼스 기준 IDF 즉석 계산 ──
  const N = candidates.length;
  const docFreq = new Map();
  const memToks = new Map();
  let totalLen = 0;
  for (const m of candidates) {
    const toks = new Set(tokenize(m.text));
    memToks.set(m.id, toks);
    totalLen += toks.size;
    for (const t of toks) docFreq.set(t, (docFreq.get(t) || 0) + 1);
  }
  const avgLen = Math.max(totalLen / N, 1);
  const k1 = 1.5, b = 0.75;

  function bm25(memId) {
    const toks = memToks.get(memId);
    if (!toks || !toks.size || !qTokenSet.size) return 0;
    let score = 0;
    const memLen = toks.size;
    for (const qt of qTokenSet) {
      if (!toks.has(qt)) continue;
      const df = docFreq.get(qt) || 0;
      const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);
      const tfNorm = (1 * (k1 + 1)) / (1 + k1 * (1 - b + b * (memLen / avgLen))); // tf=1(짧은 메모리, binary)
      score += idf * tfNorm;
    }
    return score;
  }

  const scored = [];
  for (const m of candidates) {
    let kwNorm = 0;
    const kw = bm25(m.id);
    if (kw > 0) kwNorm = Math.min(kw / 6.0, 1.0);

    // 카테고리 부스트 (ERP 도메인 포함)
    const memLower = m.text.toLowerCase();
    let catBoost = 1.0;
    if (/단가|가격|얼마|단가표/.test(msgLower) && (m.category === "단가" || /원|단가|가격/.test(memLower))) catBoost = 1.4;
    else if (/거래처|업체|벤더|매입처/.test(msgLower) && m.category === "거래처") catBoost = 1.3;
    else if (/연락처|전화|이메일|메일|번호|담당자/.test(msgLower) && (m.category === "contact" || memLower.includes("@"))) catBoost = 1.3;
    else if (/이름|누구|담당/.test(msgLower) && m.category === "identity") catBoost = 1.4;
    else if (/규칙|정책|기준|방침/.test(msgLower) && m.category === "규칙") catBoost = 1.3;
    else if (/선호|좋아|싫어|자주/.test(msgLower) && m.category === "preference") catBoost = 1.2;
    kwNorm = Math.min(kwNorm * catBoost, 1.0);

    // 정확 코드/문구 일치 → 바닥 0.8 (odysseus exact-match floor)
    const exactPhrase = msgLower.length >= 2 && memLower.includes(msgLower);
    const memTok = memToks.get(m.id) || new Set();
    const sharedCode = [...qTokenSet].some((t) => isCodeLike(t) && memTok.has(t));
    if (exactPhrase || sharedCode) kwNorm = Math.max(kwNorm, 0.8);

    // 벡터
    let vs = 0;
    if (hasVec && Array.isArray(m.embedding)) vs = Math.max(cosine(queryEmbedding, m.embedding), 0);

    // recency (최대 5%)
    const ts = m.updated_at || m.created_at || 0;
    const daysOld = Math.max((now - ts) / 86400, 0);
    const recency = 1.0 / (1.0 + daysOld * 0.05);

    // 게이트: 진짜 관련성 필요(단순 최신성 배제)
    let final;
    if (hasVec) {
      if (vs < 0.20 && kwNorm < 0.08) continue;
      final = 0.55 * vs + 0.40 * kwNorm + 0.05 * recency;
    } else {
      if (kwNorm < 0.08) continue;
      final = 0.95 * kwNorm + 0.05 * recency;
    }
    if (final > 0.12) scored.push([final, m]);
  }

  scored.sort((x, y) => y[0] - x[0]);
  return scored.slice(0, k).map((s) => s[1]);
}

/**
 * LLM 컨텍스트용 메모리 preface 생성.
 *   - 맨 앞: UNTRUSTED 정책(system)
 *   - pinned(고정 회사/팀 규칙·핵심 사실): 항상 주입
 *   - extended: hybridRetrieve로 top-k만
 *   - pinned/extended 전부 신뢰경계 가드블록(user 롤)으로 격리
 * 반환 messages를 LLM 호출 messages 앞쪽에 끼워 넣으면 된다.
 */
function buildMemoryPreface(store, actor, message, { k = 3, queryEmbedding = null } = {}) {
  const messages = [{ role: "system", content: UNTRUSTED_POLICY }];
  const usedIds = [];
  const all = store.visibleTo(actor);
  const pinned = all.filter((m) => m.pinned);
  const extended = all.filter((m) => !m.pinned);

  if (pinned.length) {
    messages.push(untrustedBlock(
      "saved memory: 고정 규칙·핵심 사실",
      "핵심 사실:\n- " + pinned.map((m) => m.text).join("\n- ")
    ));
    for (const m of pinned) usedIds.push(m.id);
  }

  if (extended.length) {
    const relevant = hybridRetrieve(message, extended, { k, queryEmbedding });
    if (relevant.length) {
      messages.push(untrustedBlock(
        "saved memory: 관련 컨텍스트",
        "메모리 컨텍스트(사용자가 해당 주제를 물을 때만 참고):\n" + relevant.map((m) => `- ${m.text}`).join("\n")
      ));
      for (const m of relevant) usedIds.push(m.id);
    }
  }

  if (usedIds.length) { try { store.incrementUses(usedIds); } catch (_) {} }
  return { messages, usedIds, pinnedCount: pinned.length };
}

module.exports = { hybridRetrieve, buildMemoryPreface, cosine };
