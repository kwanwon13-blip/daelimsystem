// lib/ai-memory/index.js
// 조립 — 저장소 + recall + 추출기를 하나의 파사드로.
//
//   const { createAiMemory } = require('./lib/ai-memory');
//   const aiMem = createAiMemory({ db: 업무데이터핸들, llm: claudeAdapter, embedder: null });
//
//   // 1) 채팅 요청 시: 메모리 preface를 LLM messages 앞에 끼움
//   const { messages: memMsgs } = await aiMem.buildPreface(actor, userMessage);
//   const llmMessages = [...memMsgs, ...히스토리, { role:'user', content:userMessage }];
//
//   // 2) 응답 끝난 뒤(백그라운드, await 금지 권장): 자동 추출
//   aiMem.afterTurn(actor, recentMessages, { sessionId }).catch(()=>{});

const { createMemoryStore } = require("./store");
const recall = require("./recall");
const extractor = require("./extractor");
const { untrustedBlock, UNTRUSTED_POLICY } = require("./untrusted");

function createAiMemory({ db, dbPath, llm, embedder = null, canWrite } = {}) {
  if (typeof llm !== "function") {
    // llm 없이도 저장/조회/recall(키워드)은 동작. 추출/감사만 비활성.
    llm = null;
  }
  const store = createMemoryStore({ db, dbPath, canWrite });

  // 감사 fingerprint 저장(단락용) — 같은 DB의 작은 테이블
  store.db.exec(`CREATE TABLE IF NOT EXISTS ai_memory_tidy (scope_key TEXT PRIMARY KEY, fingerprint TEXT)`);
  const getFp = (k) => (store.db.prepare(`SELECT fingerprint FROM ai_memory_tidy WHERE scope_key=?`).get(k) || {}).fingerprint;
  const setFp = (k, fp) =>
    store.db.prepare(
      `INSERT INTO ai_memory_tidy(scope_key,fingerprint) VALUES(?,?)
       ON CONFLICT(scope_key) DO UPDATE SET fingerprint=excluded.fingerprint`
    ).run(k, fp);

  let sinceAudit = 0;

  return {
    store,
    untrustedBlock,
    UNTRUSTED_POLICY,

    /** 채팅 컨텍스트용 메모리 preface (pinned 항상 + 관련 top-k, 전부 신뢰경계 격리) */
    async buildPreface(actor, message, { k = 3 } = {}) {
      let qEmb = null;
      if (embedder) { try { qEmb = await embedder(message); } catch (_) {} }
      return recall.buildMemoryPreface(store, actor, message, { k, queryEmbedding: qEmb });
    },

    /** 응답 후 백그라운드 자동 추출(+주기적 감사). llm 없으면 no-op. */
    async afterTurn(actor, recentMessages, { sessionId = null, defaultScope = "personal" } = {}) {
      if (!llm) return { added: 0, skipped: "no-llm" };
      const r = await extractor.extractAndStore({
        store, actor, recentMessages, llm, embedder,
        state: { sessionId, defaultScope },
      });
      sinceAudit += r.added || 0;
      if (sinceAudit >= extractor.AUDIT_INTERVAL && r.added) {
        sinceAudit = 0;
        try {
          await extractor.auditMemories({
            store, actor, scopeKey: "personal:" + actor.user, llm,
            getFingerprint: getFp, setFingerprint: setFp,
          });
        } catch (_) {}
      }
      return r;
    },

    /** 수동 감사 (scopeKey 예: 'personal:1234' | 'team:영업부' | 'company') */
    audit(actor, scopeKey) {
      if (!llm) return Promise.resolve({ error: "no-llm" });
      return extractor.auditMemories({ store, actor, scopeKey, llm, getFingerprint: getFp, setFingerprint: setFp });
    },

    // 저수준 직접 접근 (라우트 CRUD 연결용)
    recall,
  };
}

module.exports = { createAiMemory };
