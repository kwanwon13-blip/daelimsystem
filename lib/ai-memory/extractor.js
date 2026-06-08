// lib/ai-memory/extractor.js
// 자동 추출 + 감사(audit) — odysseus services/memory/memory_extractor.py 포팅.
//   추출: 최근 N개 메시지 → LLM(최대 2개, 지속 사실만) + 한국어 정규식 fallback
//   중복제거 3단: (1) 정확 일치 → (2) 퍼지 자카드 ≥ 0.6   [+ 벡터 있으면 코사인 dedup은 호출측 옵션]
//   identity는 자동 pin. 신규 N개마다 감사 트리거.
//   감사: LLM 보수적 병합 + fingerprint 단락 + "50% 초과 삭제 거부" 안전장치.
//
// 의존성은 전부 주입:
//   llm(messages, {temperature, maxTokens}) => Promise<string>   (회원님 Claude CLI 어댑터)
//   embedder(text) => Promise<float[]>   (옵션 — 주면 임베딩 저장)

const { tokenSet, jaccard } = require("./tokenizer");
const crypto = require("crypto");

const CONTEXT_WINDOW = 6;   // 추출에 쓸 최근 메시지 수
const AUDIT_INTERVAL = 5;   // 신규 N개 추가마다 감사

const EXTRACT_SYSTEM_PROMPT =
  "너는 메모리 추출 도우미다. 대화에서 '앞으로 여러 대화에 두루 쓸 지속적인 사실'만 추출한다.\n" +
  "좋은 예: 이름/직책/부서, 담당 거래처, 자주 쓰는 단가·할인 규칙, 장기 프로젝트, 강한 선호, 연락처.\n" +
  "나쁜 예: 오늘 한 질문, 일시적 기분, 일반 상식, 어시스턴트가 한 말, 일회성 작업.\n\n" +
  "규칙:\n- 대화당 최대 2개, 가장 중요한 것만\n- 사용자가 말했거나 분명히 함의한 사실만\n" +
  "- 각 사실은 한 문장(20자~40자 내외, 짧게)\n- 이미 알 법한 것과 비슷하면 건너뜀\n- 지속적 사실이 없으면 []\n\n" +
  "JSON 배열로만 반환. 각 객체는 'text','category'. " +
  "category 후보: 'identity','preference','fact','contact','project','goal','단가','거래처','규칙'.\n" +
  "마크다운 펜스 없이 순수 JSON만.";

const AUDIT_SYSTEM_PROMPT =
  "너는 메모리 DB 큐레이터다. 보수적으로: 진짜 중복과 명백한 쓰레기만 제거하고 서로 다른 사실은 모두 살린다. 애매하면 KEEP.\n\n" +
  "규칙:\n1. 같은 사실을 다르게 쓴 항목만 MERGE. 확신 없으면 둘 다 KEEP. 관련되지만 다른 사실은 유지.\n" +
  "2. 어시스턴트 행동/빈 항목/무의미만 REMOVE. 사소해 보여도 진짜 사실은 유지.\n" +
  "3. 원문 표현 유지(가벼운 정리만).\n4. MERGE 시 유지하는 항목의 'id' 보존.\n5. 사실 창작 금지. 애매하면 KEEP.\n\n" +
  "JSON 배열로만 반환. 각 객체 필드: id, text, category. 펜스 없이 순수 JSON만.";

function cleanValue(v, maxLen = 80) {
  v = String(v || "").replace(/\s+/g, " ").trim().replace(/^["'`「」『』]+/, "").replace(/["'`。.,!?:;「」『』]+$/, "");
  if (!v || v.length > maxLen) return "";
  if (/https?:\/\/|[{}<>]/.test(v)) return "";
  return v;
}

/** 한국어 도메인 정규식 fallback — LLM 실패/누락 대비 (좁고 보수적으로) */
function fallbackCandidates(messages) {
  const out = [];
  const seen = new Set();
  const add = (text, category) => {
    const t = cleanValue(text, 120);
    if (!t || seen.has(t.toLowerCase())) return;
    seen.add(t.toLowerCase());
    out.push({ text: t, category });
  };
  for (const msg of messages) {
    if ((msg.role || "") !== "user") continue;
    const text = typeof msg.content === "string" ? msg.content : "";
    if (!text) continue;
    let m;
    if ((m = text.match(/(?:제?\s*이름은|저는|제가|나는)\s*([가-힣A-Za-z][가-힣A-Za-z0-9 .'-]{1,20})(?:입니다|이고|예요|이에요|라고|라는)/)))
      add(`사용자 이름은 ${cleanValue(m[1], 30)}.`, "identity");
    if ((m = text.match(/(?:부서는|소속은|소속이|소속)\s*([가-힣A-Za-z ]{2,15}(?:팀|부|과|실))/)))
      add(`소속 부서는 ${cleanValue(m[1], 15)}.`, "identity");
    if ((m = text.match(/([가-힣A-Za-z0-9()㈜\s]{2,30}?)\s*(?:거래처|업체)\s*(?:담당|관리|맡)/)))
      add(`담당 거래처: ${cleanValue(m[1], 30)}.`, "거래처");
    if ((m = text.match(/([가-힣A-Za-z0-9 ]{2,20}?)\s*단가\s*(?:는|=|:|이)?\s*([0-9][0-9,]{1,})\s*원/)))
      add(`${cleanValue(m[1], 20)} 단가는 ${m[2]}원.`, "단가");
    if ((m = text.match(/(?:항상|기본적으로|규칙(?:상|은)|원칙)\s*([^.!?\n]{4,60})/)))
      add(cleanValue(m[1], 70), "규칙");
  }
  return out.slice(0, 2);
}

/**
 * 최근 대화에서 사실 추출 후 신규만 저장. 응답 경로를 막지 말 것(호출측에서 await 없이 fire-and-forget 권장).
 * state: { sessionId, defaultScope='personal', scopeOwner }
 */
async function extractAndStore({ store, actor, recentMessages, llm, embedder = null, state = {} }) {
  const recent = (recentMessages || []).slice(-CONTEXT_WINDOW);
  if (recent.length < 2) return { added: 0 };

  // 멀티모달 블록 제거 → 텍스트만
  const stripped = recent
    .map((m) => ({
      role: m.role,
      content:
        typeof m.content === "string" ? m.content
          : Array.isArray(m.content) ? m.content.filter((b) => b && b.type === "text").map((b) => b.text).join(" ")
            : "",
    }))
    .filter((m) => m.content);
  if (!stripped.length) return { added: 0 };

  const fb = fallbackCandidates(stripped);

  let facts = [];
  try {
    let raw = await llm([{ role: "system", content: EXTRACT_SYSTEM_PROMPT }, ...stripped], { temperature: 0.1, maxTokens: 500 });
    raw = String(raw || "").trim();
    if (raw.startsWith("```")) raw = raw.replace(/^```[a-z]*\n?/i, "").replace(/```$/, "").trim();
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) facts = parsed;
  } catch (_) { /* LLM 실패 → fallback만 */ }

  if (fb.length) facts = facts.concat(fb);
  if (!facts.length) return { added: 0 };

  const scope = state.defaultScope || "personal";
  const owner = scope === "personal" ? actor.user : (state.scopeOwner || null);

  const visible = store.visibleTo(actor); // 중복 비교 대상 (가시범위)
  let added = 0;

  for (const f of facts) {
    const text = (typeof f === "string" ? f : (f && f.text) || "").trim();
    const category = (typeof f === "object" && f && f.category) || "fact";
    if (!text || text.length < 4) continue;

    // 1) 정확 일치
    if (store.findExact(actor, text)) continue;
    // 2) 퍼지(자카드 ≥ 0.6) — 재서술 중복 차단
    const ts = tokenSet(text);
    if (visible.some((m) => jaccard(ts, tokenSet(m.text)) >= 0.6)) continue;

    let embedding = null;
    if (embedder) { try { embedding = await embedder(text); } catch (_) {} }

    const mem = store.add({
      text, category, scope, owner, source: "auto",
      pinned: category === "identity" ? 1 : 0,    // identity 자동 고정
      session_id: state.sessionId || null, embedding,
    });
    visible.push(mem);
    added++;
  }
  return { added };
}

/** 감사: 한 scopeKey 묶음을 LLM이 보수적으로 병합/정리. actor는 해당 scope 쓰기권한 필요. */
async function auditMemories({ store, actor, scopeKey, llm, getFingerprint, setFingerprint }) {
  const all = store.visibleTo(actor).filter((m) => memScopeKey(m) === scopeKey);
  if (!all.length) return { before: 0, after: 0 };
  const before = all.length;

  const fp = fingerprint(all);
  if (getFingerprint && getFingerprint(scopeKey) === fp) return { before, after: before, alreadyTidy: true };

  const payload = all.map((m) => ({ id: m.id, text: m.text, category: m.category }));
  let cleaned = null;
  try {
    let raw = await llm(
      [{ role: "system", content: AUDIT_SYSTEM_PROMPT }, { role: "user", content: JSON.stringify(payload) }],
      { temperature: 0.1, maxTokens: 16384 }
    );
    raw = String(raw || "").replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, "").trim();
    cleaned = tryParseArray(raw);
  } catch (e) {
    return { before, after: before, error: String(e) };
  }
  if (!cleaned) return { before, after: before, error: "bad_json" };

  const byId = new Map(all.map((m) => [m.id, m]));
  const final = [];
  for (const it of cleaned) {
    if (!it || typeof it !== "object") continue;
    const orig = byId.get(it.id);
    if (!orig || !it.text || !String(it.text).trim()) continue; // 미지 id 창작 금지
    final.push({ ...orig, text: String(it.text).trim(), category: it.category || orig.category });
  }
  const after = final.length;

  // 안전장치: 8개 이상인데 절반 넘게 사라지면 오작동으로 보고 저장 거부
  if (before >= 8 && after < before * 0.5) {
    return { before, after: before, error: "unsafe_removal" };
  }

  const keepIds = new Set(final.map((f) => f.id));
  const tx = store.db.transaction(() => {
    for (const m of all) if (!keepIds.has(m.id)) store.remove(actor, m.id);
    for (const f of final) {
      const cur = byId.get(f.id);
      if (cur && (cur.text !== f.text || cur.category !== f.category)) store.update(actor, f.id, { text: f.text, category: f.category });
    }
  });
  tx();

  if (setFingerprint) setFingerprint(scopeKey, fingerprint(final));
  return { before, after };
}

function memScopeKey(m) { return m.scope === "personal" ? "personal:" + (m.owner || "") : m.scope; }

function fingerprint(entries) {
  const items = entries
    .map((e) => [String(e.id), e.text || "", e.category || ""])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const h = crypto.createHash("sha256");
  for (const t of items) h.update(t.join("\x1f") + "\x1e");
  return h.digest("hex");
}

function tryParseArray(s) {
  if (!s) return null;
  for (const cand of [s, s.replace(/,(\s*[}\]])/g, "$1")]) {
    try { const v = JSON.parse(cand); if (Array.isArray(v)) return v; } catch (_) {}
  }
  const a = s.indexOf("["), b = s.lastIndexOf("]");
  if (a >= 0 && b > a) { try { const v = JSON.parse(s.slice(a, b + 1)); if (Array.isArray(v)) return v; } catch (_) {} }
  return null;
}

module.exports = { extractAndStore, auditMemories, fallbackCandidates, CONTEXT_WINDOW, AUDIT_INTERVAL };
