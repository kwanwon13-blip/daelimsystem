/**
 * db-ai.js — AI 히스토리 전용 DB 모듈
 *
 * - 별도 파일(data/ai기록.db) 사용 → 기존 업무데이터.db 와 독립
 * - 대용량 누적에도 렉 방지 (WAL + 인덱스)
 * - better-sqlite3 미설치시 exports.ready=false 로 fallback 가능하게 구성
 *
 * 스키마
 *   ai_projects          프로젝트(폴더)
 *   ai_project_members   초대 공유 전용 멤버
 *   ai_threads           대화 스레드 (여러 메시지 묶음)
 *   ai_messages          1 메시지(질문 or 답변)
 *   ai_templates         재사용 프롬프트 템플릿
 *   ai_attachments       AI 질문에 첨부한 파일 메타
 */
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'data', 'ai기록.db');
const UPLOAD_DIR = path.join(__dirname, 'data', 'ai_uploads');
const OUTPUT_DIR = path.join(__dirname, 'data', 'ai_outputs');

// 업로드/출력 폴더 보장
try { if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true }); } catch(_) {}
try { if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true }); } catch(_) {}

let db = null;
let ready = false;
try {
  const Database = require('better-sqlite3');
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL'); // 렉 방지
  ready = true;
} catch (e) {
  console.error('[db-ai] better-sqlite3 사용 불가 — AI 히스토리 비활성화:', e.message);
}

function nowIso() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

if (ready) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS ai_projects (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id     TEXT    NOT NULL,
      owner_name   TEXT    NOT NULL DEFAULT '',
      name         TEXT    NOT NULL,
      emoji        TEXT    DEFAULT '📁',
      description  TEXT    DEFAULT '',
      share_mode   TEXT    NOT NULL DEFAULT 'private', -- private | team | company | invited
      pinned       INTEGER NOT NULL DEFAULT 0,
      archived     INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_proj_owner ON ai_projects(owner_id, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_proj_share ON ai_projects(share_mode);

    CREATE TABLE IF NOT EXISTS ai_project_members (
      project_id   INTEGER NOT NULL,
      user_id      TEXT    NOT NULL,
      user_name    TEXT    DEFAULT '',
      added_at     TEXT    NOT NULL,
      PRIMARY KEY (project_id, user_id),
      FOREIGN KEY (project_id) REFERENCES ai_projects(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_pm_user ON ai_project_members(user_id);

    CREATE TABLE IF NOT EXISTS ai_threads (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id   INTEGER,
      owner_id     TEXT    NOT NULL,
      owner_name   TEXT    NOT NULL DEFAULT '',
      title        TEXT    NOT NULL DEFAULT '새 대화',
      source_page_id TEXT,               -- 워크스페이스 페이지에서 시작됐을 경우
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL,
      last_message_at TEXT,
      message_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ai_thr_owner ON ai_threads(owner_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_thr_project ON ai_threads(project_id, last_message_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_thr_page ON ai_threads(source_page_id);

    CREATE TABLE IF NOT EXISTS ai_messages (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id    INTEGER NOT NULL,
      role         TEXT    NOT NULL,           -- user | ai
      kind         TEXT    NOT NULL DEFAULT 'chat', -- chat | template | image | quick_help
      content      TEXT    NOT NULL DEFAULT '',
      image_url    TEXT,                        -- 이미지 생성 결과 (role=ai, kind=image)
      metadata     TEXT    NOT NULL DEFAULT '{}',
      status       TEXT    NOT NULL DEFAULT 'ok', -- ok | error
      error        TEXT,
      duration_ms  INTEGER,
      attachments  TEXT    NOT NULL DEFAULT '[]', -- JSON array of attachment IDs
      created_at   TEXT    NOT NULL,
      FOREIGN KEY (thread_id) REFERENCES ai_threads(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_ai_msg_thread ON ai_messages(thread_id, created_at);

    CREATE TABLE IF NOT EXISTS ai_templates (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id     TEXT    NOT NULL,
      owner_name   TEXT    NOT NULL DEFAULT '',
      name         TEXT    NOT NULL,
      emoji        TEXT    DEFAULT '✦',
      prompt       TEXT    NOT NULL,
      share_mode   TEXT    NOT NULL DEFAULT 'private',
      usage_count  INTEGER NOT NULL DEFAULT 0,
      created_at   TEXT    NOT NULL,
      updated_at   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_tmpl_owner ON ai_templates(owner_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS ai_attachments (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id     TEXT    NOT NULL,
      original_name TEXT   NOT NULL,
      stored_name  TEXT    NOT NULL,
      mime         TEXT    NOT NULL DEFAULT '',
      size         INTEGER NOT NULL DEFAULT 0,
      kind         TEXT    NOT NULL DEFAULT 'file', -- image | excel | pdf | word | text | file
      text_excerpt TEXT    DEFAULT '',              -- 텍스트 추출 결과 (엑셀/PDF/워드)
      created_at   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_att_owner ON ai_attachments(owner_id, created_at DESC);

    -- Claude API 사용량 기록 (비용 트래킹 + 직원별 일일 한도)
    CREATE TABLE IF NOT EXISTS ai_api_usage (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id       TEXT    NOT NULL,
      user_name     TEXT    NOT NULL DEFAULT '',
      thread_id     INTEGER,
      model         TEXT    NOT NULL,
      input_tokens  INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_write_tokens  INTEGER NOT NULL DEFAULT 0,
      cost_usd      REAL    NOT NULL DEFAULT 0,
      duration_ms   INTEGER NOT NULL DEFAULT 0,
      turn_count    INTEGER NOT NULL DEFAULT 1,   -- tool use 턴 수
      tool_names    TEXT    DEFAULT '',           -- 사용된 도구들 (쉼표 구분)
      created_at    TEXT    NOT NULL,
      date_ymd      TEXT    NOT NULL              -- YYYY-MM-DD (일일 한도 빠른 조회)
    );
    CREATE INDEX IF NOT EXISTS idx_ai_usage_user_date ON ai_api_usage(user_id, date_ymd);
    CREATE INDEX IF NOT EXISTS idx_ai_usage_created ON ai_api_usage(created_at DESC);

    -- 생성된 파일 (도구가 만든 엑셀/PDF 등)
    CREATE TABLE IF NOT EXISTS ai_artifacts (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id     TEXT    NOT NULL,
      thread_id    INTEGER,
      message_id   INTEGER,
      original_name TEXT   NOT NULL,
      stored_name  TEXT    NOT NULL,
      mime         TEXT    NOT NULL DEFAULT '',
      size         INTEGER NOT NULL DEFAULT 0,
      kind         TEXT    NOT NULL DEFAULT 'file',  -- excel | pdf | image | text | file
      created_at   TEXT    NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ai_artifact_thread ON ai_artifacts(thread_id, created_at DESC);
  `);

  // 기본 "(미분류)" 가상 프로젝트는 project_id=NULL 로 표현 → 레코드 불필요
}

// ──────────────────────────────────────────────────────────
// 공통 헬퍼
// ──────────────────────────────────────────────────────────

function getUserDept(userId) {
  // 조직관리.json 에서 사용자의 부서(팀) 찾기
  // 한 사람이 여러 부서에 속할 수도 있으니 배열 반환
  try {
    const orgPath = path.join(__dirname, 'data', '조직관리.json');
    if (!fs.existsSync(orgPath)) return { company: null, departments: [] };
    const data = JSON.parse(fs.readFileSync(orgPath, 'utf8'));
    const users = Array.isArray(data.users) ? data.users : [];
    const u = users.find(x => String(x.userId) === String(userId));
    if (!u) return { company: null, departments: [] };
    const depts = [];
    if (Array.isArray(u.departments)) depts.push(...u.departments);
    if (u.department) depts.push(u.department);
    return { company: u.company || null, departments: Array.from(new Set(depts.filter(Boolean))) };
  } catch (e) {
    return { company: null, departments: [] };
  }
}

function usersInSameDept(userId) {
  // 내 부서 동료들의 userId 배열
  try {
    const my = getUserDept(userId);
    if (my.departments.length === 0) return [];
    const orgPath = path.join(__dirname, 'data', '조직관리.json');
    const data = JSON.parse(fs.readFileSync(orgPath, 'utf8'));
    const users = Array.isArray(data.users) ? data.users : [];
    const result = new Set();
    for (const u of users) {
      const depts = [];
      if (Array.isArray(u.departments)) depts.push(...u.departments);
      if (u.department) depts.push(u.department);
      if (my.company && u.company && u.company !== my.company) continue;
      if (depts.some(d => my.departments.includes(d))) result.add(String(u.userId));
    }
    return Array.from(result);
  } catch (e) {
    return [];
  }
}

// 프로젝트가 사용자에게 보이는지
function canViewProject(project, userId, isAdmin) {
  if (!project) return false;
  if (isAdmin) return true;
  if (String(project.owner_id) === String(userId)) return true;
  switch (project.share_mode) {
    case 'company':
      return true;
    case 'team': {
      // owner 와 동일 팀이면 허용
      const teammates = usersInSameDept(project.owner_id);
      return teammates.includes(String(userId));
    }
    case 'invited': {
      if (!ready) return false;
      const row = db.prepare('SELECT 1 FROM ai_project_members WHERE project_id=? AND user_id=?')
        .get(project.id, String(userId));
      return !!row;
    }
    case 'private':
    default:
      return false;
  }
}

function canEditProject(project, userId, isAdmin) {
  if (!project) return false;
  if (String(project.owner_id) === String(userId)) return true;
  // admin 은 타인 프로젝트 수정 안 함 (신뢰)
  return false;
}

// ──────────────────────────────────────────────────────────
// 프로젝트
// ──────────────────────────────────────────────────────────
const projects = {
  list(userId, { includeShared = true, isAdmin = false } = {}) {
    if (!ready) return [];
    const mine = db.prepare(`
      SELECT * FROM ai_projects
      WHERE owner_id=? AND archived=0
      ORDER BY pinned DESC, updated_at DESC
    `).all(String(userId));

    if (!includeShared) return mine;

    // 팀/회사/초대된 프로젝트
    const shared = [];
    const all = db.prepare(`
      SELECT * FROM ai_projects
      WHERE owner_id!=? AND archived=0
      ORDER BY updated_at DESC
      LIMIT 500
    `).all(String(userId));
    for (const p of all) {
      if (canViewProject(p, userId, isAdmin)) shared.push(p);
    }
    return [...mine, ...shared];
  },
  get(id) {
    if (!ready) return null;
    return db.prepare('SELECT * FROM ai_projects WHERE id=?').get(id);
  },
  create({ ownerId, ownerName, name, emoji, description, shareMode, members }) {
    if (!ready) throw new Error('DB 미사용');
    const now = nowIso();
    const r = db.prepare(`
      INSERT INTO ai_projects (owner_id, owner_name, name, emoji, description, share_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(ownerId), ownerName || '', String(name || '새 프로젝트'), emoji || '📁',
           description || '', shareMode || 'private', now, now);
    const id = r.lastInsertRowid;
    if (Array.isArray(members) && members.length > 0 && shareMode === 'invited') {
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO ai_project_members (project_id, user_id, user_name, added_at) VALUES (?,?,?,?)
      `);
      for (const m of members) {
        stmt.run(id, String(m.userId || m.id || m), m.name || '', now);
      }
    }
    return this.get(id);
  },
  update(id, patch) {
    if (!ready) throw new Error('DB 미사용');
    const cur = this.get(id);
    if (!cur) return null;
    const now = nowIso();
    const fields = [];
    const values = [];
    const allowed = ['name', 'emoji', 'description', 'share_mode', 'pinned', 'archived'];
    for (const k of allowed) {
      if (patch[k] !== undefined) { fields.push(`${k}=?`); values.push(patch[k]); }
    }
    if (fields.length === 0 && !patch.members) return cur;
    if (fields.length > 0) {
      fields.push('updated_at=?'); values.push(now);
      values.push(id);
      db.prepare(`UPDATE ai_projects SET ${fields.join(', ')} WHERE id=?`).run(...values);
    }
    if (Array.isArray(patch.members)) {
      db.prepare('DELETE FROM ai_project_members WHERE project_id=?').run(id);
      const stmt = db.prepare(`
        INSERT OR IGNORE INTO ai_project_members (project_id, user_id, user_name, added_at) VALUES (?,?,?,?)
      `);
      for (const m of patch.members) {
        stmt.run(id, String(m.userId || m.id || m), m.name || '', now);
      }
    }
    return this.get(id);
  },
  delete(id) {
    if (!ready) return;
    // 프로젝트 삭제 시 스레드는 project_id=NULL 로 (미분류로 이동)
    db.prepare('UPDATE ai_threads SET project_id=NULL WHERE project_id=?').run(id);
    db.prepare('DELETE FROM ai_project_members WHERE project_id=?').run(id);
    db.prepare('DELETE FROM ai_projects WHERE id=?').run(id);
  },
  members(projectId) {
    if (!ready) return [];
    return db.prepare('SELECT * FROM ai_project_members WHERE project_id=? ORDER BY added_at').all(projectId);
  }
};

// ──────────────────────────────────────────────────────────
// 스레드 + 메시지
// ──────────────────────────────────────────────────────────
const threads = {
  list(userId, { projectId, q, limit = 20, offset = 0, scope = 'mine', isAdmin = false } = {}) {
    if (!ready) return { items: [], total: 0 };

    const where = [];
    const params = [];

    if (scope === 'mine') {
      where.push('t.owner_id = ?'); params.push(String(userId));
    } else if (scope === 'shared') {
      // 내가 볼 수 있는 "남의" 스레드 = 해당 프로젝트를 볼 수 있는 경우
      where.push('t.owner_id != ?'); params.push(String(userId));
      where.push('t.project_id IS NOT NULL');
      // project 필터는 JOIN 후 후처리로 검증
    } else if (scope === 'project' && projectId !== undefined) {
      where.push('t.project_id = ?'); params.push(projectId);
    } else if (scope === 'all' && isAdmin) {
      // admin 모든 스레드
    }

    if (projectId !== undefined && scope !== 'project') {
      if (projectId === null || projectId === '' || projectId === 'null') {
        where.push('t.project_id IS NULL');
      } else {
        where.push('t.project_id = ?'); params.push(projectId);
      }
    }
    if (q) {
      where.push('(t.title LIKE ? OR EXISTS (SELECT 1 FROM ai_messages m WHERE m.thread_id=t.id AND m.content LIKE ?))');
      params.push(`%${q}%`, `%${q}%`);
    }

    const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const totalRow = db.prepare(`SELECT COUNT(*) AS c FROM ai_threads t ${whereSql}`).get(...params);
    const rows = db.prepare(`
      SELECT t.*
      FROM ai_threads t
      ${whereSql}
      ORDER BY COALESCE(t.last_message_at, t.created_at) DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset);

    // shared 스코프면 권한 필터링
    let items = rows;
    if (scope === 'shared') {
      items = rows.filter(r => {
        if (r.project_id === null) return false;
        const p = projects.get(r.project_id);
        return canViewProject(p, userId, isAdmin);
      });
    }

    // 각 스레드의 첫 user 메시지(= 프리뷰 타이틀용) 붙여주기
    const preview = db.prepare(`
      SELECT content FROM ai_messages
      WHERE thread_id=? AND role='user'
      ORDER BY created_at LIMIT 1
    `);
    for (const it of items) {
      const p = preview.get(it.id);
      it.first_prompt = p ? (p.content || '') : '';
    }

    return { items, total: totalRow.c, limit, offset };
  },

  get(id) {
    if (!ready) return null;
    return db.prepare('SELECT * FROM ai_threads WHERE id=?').get(id);
  },

  create({ ownerId, ownerName, projectId = null, title, sourcePageId = null }) {
    if (!ready) throw new Error('DB 미사용');
    const now = nowIso();
    const r = db.prepare(`
      INSERT INTO ai_threads (owner_id, owner_name, project_id, title, source_page_id, created_at, updated_at, last_message_at, message_count)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
    `).run(String(ownerId), ownerName || '', projectId, (title || '새 대화').slice(0, 120),
           sourcePageId ? String(sourcePageId) : null, now, now, now);
    return this.get(r.lastInsertRowid);
  },

  update(id, patch) {
    if (!ready) throw new Error('DB 미사용');
    const cur = this.get(id);
    if (!cur) return null;
    const now = nowIso();
    const fields = [];
    const values = [];
    const allowed = ['title', 'project_id'];
    for (const k of allowed) {
      if (patch[k] !== undefined) { fields.push(`${k}=?`); values.push(patch[k]); }
    }
    if (fields.length === 0) return cur;
    fields.push('updated_at=?'); values.push(now);
    values.push(id);
    db.prepare(`UPDATE ai_threads SET ${fields.join(', ')} WHERE id=?`).run(...values);
    return this.get(id);
  },

  delete(id) {
    if (!ready) return;
    db.prepare('DELETE FROM ai_threads WHERE id=?').run(id);
  },

  messages(threadId) {
    if (!ready) return [];
    return db.prepare(`
      SELECT * FROM ai_messages WHERE thread_id=? ORDER BY created_at
    `).all(threadId);
  },

  // 마지막 N개 메시지 (컨텍스트용)
  recentMessages(threadId, n = 6) {
    if (!ready) return [];
    const rows = db.prepare(`
      SELECT * FROM ai_messages WHERE thread_id=? ORDER BY created_at DESC LIMIT ?
    `).all(threadId, n);
    return rows.reverse();
  },

  addMessage(threadId, { role, kind, content, imageUrl, metadata, status, error, durationMs, attachments }) {
    if (!ready) throw new Error('DB 미사용');
    const now = nowIso();
    const r = db.prepare(`
      INSERT INTO ai_messages (thread_id, role, kind, content, image_url, metadata, status, error, duration_ms, attachments, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(threadId, role, kind || 'chat', content || '', imageUrl || null,
           JSON.stringify(metadata || {}), status || 'ok', error || null,
           durationMs || null, JSON.stringify(attachments || []), now);

    // 스레드 통계 업데이트
    db.prepare(`
      UPDATE ai_threads SET last_message_at=?, updated_at=?, message_count=message_count+1 WHERE id=?
    `).run(now, now, threadId);

    return db.prepare('SELECT * FROM ai_messages WHERE id=?').get(r.lastInsertRowid);
  },

  // 첫 질문 기반으로 제목 자동 생성 (너무 긴 경우만)
  autoTitleIfEmpty(threadId) {
    if (!ready) return;
    const t = this.get(threadId);
    if (!t) return;
    if (t.title && t.title !== '새 대화') return;
    const first = db.prepare(`
      SELECT content FROM ai_messages WHERE thread_id=? AND role='user' ORDER BY created_at LIMIT 1
    `).get(threadId);
    if (!first || !first.content) return;
    const title = first.content.replace(/\s+/g, ' ').trim().slice(0, 60);
    if (title) db.prepare('UPDATE ai_threads SET title=? WHERE id=?').run(title, threadId);
  }
};

// ──────────────────────────────────────────────────────────
// 템플릿
// ──────────────────────────────────────────────────────────
const templates = {
  list(userId, { scope = 'visible', isAdmin = false } = {}) {
    if (!ready) return [];
    const mine = db.prepare(`
      SELECT * FROM ai_templates WHERE owner_id=? ORDER BY usage_count DESC, updated_at DESC
    `).all(String(userId));
    if (scope === 'mine') return mine;
    // shared
    const all = db.prepare(`
      SELECT * FROM ai_templates WHERE owner_id != ? ORDER BY usage_count DESC, updated_at DESC
    `).all(String(userId));
    const shared = [];
    for (const t of all) {
      // 템플릿 공유는 프로젝트 공유 규칙 재활용 (소유자 프로젝트가 아니라 템플릿 소유자 기준)
      const fakeProj = { id: 0, owner_id: t.owner_id, share_mode: t.share_mode };
      if (canViewProject(fakeProj, userId, isAdmin)) shared.push(t);
    }
    return [...mine, ...shared];
  },
  get(id) {
    if (!ready) return null;
    return db.prepare('SELECT * FROM ai_templates WHERE id=?').get(id);
  },
  create({ ownerId, ownerName, name, emoji, prompt, shareMode }) {
    if (!ready) throw new Error('DB 미사용');
    const now = nowIso();
    const r = db.prepare(`
      INSERT INTO ai_templates (owner_id, owner_name, name, emoji, prompt, share_mode, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(ownerId), ownerName || '', String(name || '새 템플릿'), emoji || '✦',
           String(prompt || ''), shareMode || 'private', now, now);
    return this.get(r.lastInsertRowid);
  },
  update(id, patch) {
    if (!ready) throw new Error('DB 미사용');
    const cur = this.get(id);
    if (!cur) return null;
    const now = nowIso();
    const fields = [];
    const values = [];
    const allowed = ['name', 'emoji', 'prompt', 'share_mode'];
    for (const k of allowed) {
      if (patch[k] !== undefined) { fields.push(`${k}=?`); values.push(patch[k]); }
    }
    if (fields.length === 0) return cur;
    fields.push('updated_at=?'); values.push(now);
    values.push(id);
    db.prepare(`UPDATE ai_templates SET ${fields.join(', ')} WHERE id=?`).run(...values);
    return this.get(id);
  },
  delete(id) {
    if (!ready) return;
    db.prepare('DELETE FROM ai_templates WHERE id=?').run(id);
  },
  bumpUsage(id) {
    if (!ready) return;
    db.prepare('UPDATE ai_templates SET usage_count=usage_count+1, updated_at=? WHERE id=?')
      .run(nowIso(), id);
  }
};

// ──────────────────────────────────────────────────────────
// 첨부파일
// ──────────────────────────────────────────────────────────
const attachments = {
  get(id) {
    if (!ready) return null;
    return db.prepare('SELECT * FROM ai_attachments WHERE id=?').get(id);
  },
  create({ ownerId, originalName, storedName, mime, size, kind, textExcerpt }) {
    if (!ready) throw new Error('DB 미사용');
    const now = nowIso();
    const r = db.prepare(`
      INSERT INTO ai_attachments (owner_id, original_name, stored_name, mime, size, kind, text_excerpt, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(ownerId), originalName, storedName, mime || '', size || 0,
           kind || 'file', (textExcerpt || '').slice(0, 50000), now);
    return this.get(r.lastInsertRowid);
  },
  delete(id) {
    if (!ready) return;
    const a = this.get(id);
    if (a) {
      try { fs.unlinkSync(path.join(UPLOAD_DIR, a.stored_name)); } catch(_) {}
    }
    db.prepare('DELETE FROM ai_attachments WHERE id=?').run(id);
  },
  hydrate(ids) {
    if (!ready || !Array.isArray(ids) || ids.length === 0) return [];
    const q = db.prepare('SELECT * FROM ai_attachments WHERE id=?');
    return ids.map(id => q.get(id)).filter(Boolean);
  }
};

// ──────────────────────────────────────────────────────────
// API 사용량 (비용 트래킹)
// ──────────────────────────────────────────────────────────
// Anthropic 가격표 (2026년 기준, USD/1M tokens)
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.0, cacheRead: 0.08, cacheWrite: 1.0 },
  'claude-sonnet-4-6':         { input: 3.0,  output: 15.0, cacheRead: 0.30, cacheWrite: 3.75 },
  'claude-opus-4-6':           { input: 15.0, output: 75.0, cacheRead: 1.50, cacheWrite: 18.75 },
};

function calcCostUsd(model, usage) {
  if (!usage) return 0;
  const p = MODEL_PRICING[model] || MODEL_PRICING['claude-sonnet-4-6'];
  const input = (usage.input_tokens || 0) * p.input / 1_000_000;
  const output = (usage.output_tokens || 0) * p.output / 1_000_000;
  const cacheR = (usage.cache_read_input_tokens || 0) * p.cacheRead / 1_000_000;
  const cacheW = (usage.cache_creation_input_tokens || 0) * p.cacheWrite / 1_000_000;
  return input + output + cacheR + cacheW;
}

const apiUsage = {
  log({ userId, userName, threadId, model, usage, durationMs, turnCount, toolNames }) {
    if (!ready) return null;
    const now = nowIso();
    const dateYmd = now.slice(0, 10);
    const cost = calcCostUsd(model, usage);
    const r = db.prepare(`
      INSERT INTO ai_api_usage
        (user_id, user_name, thread_id, model,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         cost_usd, duration_ms, turn_count, tool_names, created_at, date_ymd)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      String(userId), userName || '', threadId || null, model || '',
      (usage?.input_tokens) || 0, (usage?.output_tokens) || 0,
      (usage?.cache_read_input_tokens) || 0, (usage?.cache_creation_input_tokens) || 0,
      cost, durationMs || 0, turnCount || 1,
      Array.isArray(toolNames) ? toolNames.join(',') : (toolNames || ''),
      now, dateYmd
    );
    return { id: r.lastInsertRowid, cost };
  },
  countToday(userId) {
    if (!ready) return 0;
    const today = nowIso().slice(0, 10);
    const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ai_api_usage WHERE user_id=? AND date_ymd=?`)
      .get(String(userId), today);
    return row?.cnt || 0;
  },
  summaryMonth(yyyymm) {
    // yyyymm = 'YYYY-MM'
    if (!ready) return { total: 0, cost: 0, byModel: [], byUser: [] };
    const prefix = yyyymm + '-%';
    const total = db.prepare(`SELECT COUNT(*) AS cnt, SUM(cost_usd) AS cost, SUM(input_tokens) AS inT, SUM(output_tokens) AS outT FROM ai_api_usage WHERE date_ymd LIKE ?`).get(prefix);
    const byModel = db.prepare(`SELECT model, COUNT(*) AS cnt, SUM(cost_usd) AS cost FROM ai_api_usage WHERE date_ymd LIKE ? GROUP BY model`).all(prefix);
    const byUser = db.prepare(`SELECT user_id, user_name, COUNT(*) AS cnt, SUM(cost_usd) AS cost FROM ai_api_usage WHERE date_ymd LIKE ? GROUP BY user_id ORDER BY cost DESC`).all(prefix);
    return {
      count: total?.cnt || 0,
      costUsd: total?.cost || 0,
      inputTokens: total?.inT || 0,
      outputTokens: total?.outT || 0,
      byModel,
      byUser,
    };
  },
  dailySeries(days = 30) {
    // 최근 N일 일별 비용
    if (!ready) return [];
    return db.prepare(`
      SELECT date_ymd, COUNT(*) AS cnt, SUM(cost_usd) AS cost,
             SUM(input_tokens) AS inT, SUM(output_tokens) AS outT
      FROM ai_api_usage
      WHERE date_ymd >= date('now', ?)
      GROUP BY date_ymd
      ORDER BY date_ymd ASC
    `).all(`-${days} days`);
  }
};

// ──────────────────────────────────────────────────────────
// 생성 파일 (AI 도구가 만든 엑셀/PDF 등)
// ──────────────────────────────────────────────────────────
const artifacts = {
  get(id) {
    if (!ready) return null;
    return db.prepare('SELECT * FROM ai_artifacts WHERE id=?').get(id);
  },
  create({ ownerId, threadId, messageId, originalName, storedName, mime, size, kind }) {
    if (!ready) throw new Error('DB 미사용');
    const now = nowIso();
    const r = db.prepare(`
      INSERT INTO ai_artifacts (owner_id, thread_id, message_id, original_name, stored_name, mime, size, kind, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(String(ownerId), threadId || null, messageId || null,
           originalName, storedName, mime || '', size || 0, kind || 'file', now);
    return this.get(r.lastInsertRowid);
  },
  listByThread(threadId) {
    if (!ready) return [];
    return db.prepare('SELECT * FROM ai_artifacts WHERE thread_id=? ORDER BY created_at ASC').all(threadId);
  },
  listByMessage(messageId) {
    if (!ready) return [];
    return db.prepare('SELECT * FROM ai_artifacts WHERE message_id=? ORDER BY created_at ASC').all(messageId);
  },
  setMessageId(id, messageId) {
    if (!ready) return;
    db.prepare('UPDATE ai_artifacts SET message_id=? WHERE id=?').run(messageId, id);
  }
};

module.exports = {
  get ready() { return ready; },
  db,
  UPLOAD_DIR,
  OUTPUT_DIR,
  projects,
  threads,
  templates,
  attachments,
  apiUsage,
  artifacts,
  MODEL_PRICING,
  calcCostUsd,
  // 권한 헬퍼도 외부에서 쓸 수 있게
  canViewProject,
  canEditProject,
  getUserDept,
  usersInSameDept,
  nowIso,
};
