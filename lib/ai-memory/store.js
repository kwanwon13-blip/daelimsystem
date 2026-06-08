// lib/ai-memory/store.js
// SQLite 단일 진실원천(single source of truth) 메모리 저장소.
//
// odysseus는 memory.json(CRUD) + 별도 Chroma 컬렉션(벡터)으로 이원화돼 있어
//   (1) source-of-truth 드리프트, (2) JSON fsync 누락, (3) 벡터에 owner 미저장 → cross-tenant 누수
// 세 가지 문제를 안고 있었다. 여기서는 한 테이블에 텍스트+메타+임베딩을 함께 두어 셋 다 원천 차단한다.
//   - 단일 저장소  → 드리프트 없음
//   - SQLite(WAL)  → 트랜잭션 내구성(직접 fsync 불필요)
//   - 임베딩을 같은 행에 → recall은 scope 필터된 행만 보므로 벡터도 자동으로 테넌트 격리

const crypto = require("crypto");

function uid() { return crypto.randomBytes(12).toString("hex"); }
function nowSec() { return Math.floor(Date.now() / 1000); }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ai_memories (
  id          TEXT PRIMARY KEY,
  text        TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'fact',     -- identity|preference|fact|contact|project|goal|단가|거래처|규칙
  scope       TEXT NOT NULL DEFAULT 'personal', -- 'personal' | 'team:<부서>' | 'company'  (null 금지)
  owner       TEXT,                             -- 사번 (scope='personal'일 때 필수)
  source      TEXT NOT NULL DEFAULT 'user',     -- user|auto|import
  pinned      INTEGER NOT NULL DEFAULT 0,
  uses        INTEGER NOT NULL DEFAULT 0,       -- '실제 컨텍스트에 주입됨' 카운트(검색됨 아님)
  session_id  TEXT,
  embedding   TEXT,                             -- JSON float[] (옵션 — 나중에 벡터 붙일 때만 채움)
  created_at  INTEGER NOT NULL DEFAULT (strftime('%s','now')),
  updated_at  INTEGER NOT NULL DEFAULT (strftime('%s','now'))
);
CREATE INDEX IF NOT EXISTS ix_ai_mem_scope ON ai_memories(scope, owner);
CREATE INDEX IF NOT EXISTS ix_ai_mem_cat   ON ai_memories(category);
CREATE INDEX IF NOT EXISTS ix_ai_mem_pin   ON ai_memories(pinned);
`;

// actor = { user: 사번, dept: 부서명, isAdmin: bool, isTeamLead: bool }
// 가시성: 회사 공통은 모두 / 같은 팀은 팀 메모리 / 개인은 본인 것만.
// odysseus의 "null=공유 vs null=미할당" 모호성을 피해 scope를 명시 sentinel로 못박았다.
function visibilityWhere(actor) {
  const clauses = ["scope = 'company'"];
  const params = [];
  if (actor && actor.dept) { clauses.push("scope = ?"); params.push("team:" + actor.dept); }
  if (actor && actor.user) { clauses.push("(scope = 'personal' AND owner = ?)"); params.push(actor.user); }
  return { sql: "(" + clauses.join(" OR ") + ")", params };
}

function createMemoryStore(opts = {}) {
  let db = opts.db;
  if (!db) {
    const Database = require("better-sqlite3");
    const path = require("path");
    const dbPath = opts.dbPath || path.join(__dirname, "..", "..", "data", "업무데이터.db");
    db = new Database(dbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
  }
  db.exec(SCHEMA);

  const parse = (r) => r && { ...r, pinned: !!r.pinned, embedding: r.embedding ? JSON.parse(r.embedding) : null };

  // 쓰기/삭제 권한 정책 (주입 가능). 기본: 개인=본인, 팀=팀장+같은부서, 회사=admin.
  const canWrite = opts.canWrite || function (actor, mem) {
    if (!actor) return false;
    if (actor.isAdmin) return true;
    if (mem.scope === "company") return false;
    if (mem.scope.startsWith("team:")) return !!actor.isTeamLead && ("team:" + actor.dept) === mem.scope;
    return mem.scope === "personal" && mem.owner === actor.user;
  };

  const stmts = {
    insert: db.prepare(
      `INSERT INTO ai_memories (id,text,category,scope,owner,source,pinned,session_id,embedding,created_at,updated_at)
       VALUES (@id,@text,@category,@scope,@owner,@source,@pinned,@session_id,@embedding,@ts,@ts)`
    ),
    getById: db.prepare(`SELECT * FROM ai_memories WHERE id = ?`),
    del: db.prepare(`DELETE FROM ai_memories WHERE id = ?`),
    setPinned: db.prepare(`UPDATE ai_memories SET pinned=?, updated_at=? WHERE id=?`),
    updText: db.prepare(`UPDATE ai_memories SET text=@text, category=@category, embedding=@embedding, updated_at=@ts WHERE id=@id`),
    bumpUses: db.prepare(`UPDATE ai_memories SET uses = uses + 1 WHERE id = ?`),
    setEmb: db.prepare(`UPDATE ai_memories SET embedding=? WHERE id=?`),
  };

  return {
    db,
    nowSec,
    uid,
    canWrite,

    /** 추가 (정확/퍼지 중복검사는 호출측/extractor 책임) */
    add({ text, category = "fact", scope = "personal", owner = null, source = "user", pinned = 0, session_id = null, embedding = null }) {
      if (!text || !String(text).trim()) throw new Error("empty memory text");
      if (scope === "personal" && !owner) throw new Error("personal scope requires owner");
      if (!/^(personal|company|team:.+)$/.test(scope)) throw new Error("invalid scope: " + scope);
      const id = uid();
      const ts = nowSec();
      stmts.insert.run({
        id, text: String(text).trim(), category, scope, owner, source,
        pinned: pinned ? 1 : 0, session_id,
        embedding: embedding ? JSON.stringify(embedding) : null, ts,
      });
      return parse(stmts.getById.get(id));
    },

    get(id) { return parse(stmts.getById.get(id)); },

    /** actor가 볼 수 있는 메모리 전체 (← 보안 경계는 여기서 '한 번만' 적용된다) */
    visibleTo(actor, { category = null, limit = 2000 } = {}) {
      const v = visibilityWhere(actor);
      let sql = `SELECT * FROM ai_memories WHERE ${v.sql}`;
      const params = [...v.params];
      if (category) { sql += ` AND category = ?`; params.push(category); }
      sql += ` ORDER BY updated_at DESC LIMIT ?`; params.push(limit);
      return db.prepare(sql).all(...params).map(parse);
    },

    /** 가시범위 내 정확 일치(텍스트) — 중복 추가 방지 */
    findExact(actor, text) {
      const t = String(text).trim().toLowerCase();
      return this.visibleTo(actor).find((m) => m.text.toLowerCase() === t) || null;
    },

    /** 수정 — 권한 없으면 404(존재 은폐, odysseus memory_routes.py:66 패턴) */
    update(actor, id, { text, category }) {
      const mem = parse(stmts.getById.get(id));
      if (!mem || !canWrite(actor, mem)) return { ok: false, code: 404 };
      stmts.updText.run({ id, text: String(text).trim(), category: category || mem.category, embedding: null, ts: nowSec() });
      return { ok: true, memory: parse(stmts.getById.get(id)) };
    },

    remove(actor, id) {
      const mem = parse(stmts.getById.get(id));
      if (!mem || !canWrite(actor, mem)) return { ok: false, code: 404 };
      stmts.del.run(id);
      return { ok: true };
    },

    setPinned(actor, id, pinned) {
      const mem = parse(stmts.getById.get(id));
      if (!mem || !canWrite(actor, mem)) return { ok: false, code: 404 };
      stmts.setPinned.run(pinned ? 1 : 0, nowSec(), id);
      return { ok: true, pinned: !!pinned };
    },

    /** 실제 컨텍스트 주입된 메모리의 uses 증가 (트랜잭션) */
    incrementUses(ids) {
      if (!ids || !ids.length) return;
      const tx = db.transaction((arr) => { for (const id of arr) stmts.bumpUses.run(id); });
      tx(ids);
    },

    setEmbedding(id, vec) { stmts.setEmb.run(JSON.stringify(vec), id); },
  };
}

module.exports = { createMemoryStore, visibilityWhere, uid, nowSec };
