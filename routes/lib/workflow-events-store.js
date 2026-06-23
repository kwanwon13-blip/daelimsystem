// routes/lib/workflow-events-store.js
// 워크플로 이력(events) SQLite 섀도 이관 어댑터 — routes/workflow.js의 저장 seam에서만 사용.
//
// 원칙: workflow.json(JSON)이 '항상' 진실원본(먼저 기록), SQLite는 best-effort 미러.
//   플래그=json이면 모든 함수가 완전 no-op → 현행과 100% 동일 동작.
//
// 적대적 점검(wvwjaricr) 반영 안전장치:
//   ① readBy는 '바뀐 id만' 갱신(dirty-id) — 매 저장 전건 UPDATE 금지(성능 자해 방지)
//   ② SQL append는 saveStore가 JSON을 확정한 '뒤'에 flush — 크래시 시 JSON이 선행 진실
//   ③ 모드 플래그는 요청-스코프 1회 메모이즈(설정.json 반복 read 방지). WeakMap이라 워크플로.json에 안 섞임
//   ④ meta는 {} 폴백(db-sqlite parseEventRow), readBy는 [] 폴백
//   ⑤ readBy/[{userId,name,at}]·meta 객체는 가공 없이 원본 그대로 직렬화
//   ⑥ db.sql(better-sqlite3) 없거나 events 테이블 없으면 강제 json — SQLite 경로로 안 샘
//   + reconcile: JSON엔 있으나 SQL에 없는 id 재append(append 실패 자동 수렴 — read=sqlite '표시누락' 자가복구)

const db = require('../../db');

// data(로드된 스토어) 객체별 요청-스코프 상태. WeakMap → JSON.stringify(data)에 안 섞이고, 요청 끝나면 자동 GC.
const _state = new WeakMap();
function stateFor(data) {
  let s = _state.get(data);
  if (!s) { s = { modes: null, newEvents: [], dirtyReadBy: new Set(), deleteJobs: new Set() }; _state.set(data, s); }
  return s;
}

function sqlEvents() {
  try { return (db.sql && db.sql.events) ? db.sql.events : null; } catch (_) { return null; }
}

// 설정.json: settings.workflow.eventsStore = { write:'json'|'dual'|'sqlite', read:'json'|'sqlite' }. 기본 json(무변화).
function readModesFromDisk() {
  try {
    const s = (db['설정'] && db['설정'].load) ? (db['설정'].load() || {}) : {};
    const c = (s.workflow && s.workflow.eventsStore) || {};
    let write = ['json', 'dual', 'sqlite'].includes(c.write) ? c.write : 'json';
    let read = ['json', 'sqlite'].includes(c.read) ? c.read : 'json';
    if (!sqlEvents()) { write = 'json'; read = 'json'; } // SQLite 미설치/테이블없음 → 강제 json 하드가드(⑥)
    return { write, read };
  } catch (_) {
    return { write: 'json', read: 'json' };
  }
}

// 요청당 1회만 설정.json을 읽어 메모이즈(③).
function modes(data) {
  if (!data) return readModesFromDisk();
  const s = stateFor(data);
  if (!s.modes) s.modes = readModesFromDisk();
  return s.modes;
}

// loadStore: read=sqlite면 SQL에서 events 배열로 hydrate(소비코드 무수정). 실패/그외면 파일배열 그대로(폴백).
function hydrate(data, fileEvents) {
  const m = modes(data);
  const E = sqlEvents();
  if (m.read === 'sqlite' && E) {
    try { return E.getAll(); } catch (_) { return Array.isArray(fileEvents) ? fileEvents : []; }
  }
  return Array.isArray(fileEvents) ? fileEvents : [];
}

// addEvent: 새 event 추적(아직 SQL 안 씀 — JSON 먼저②). write=json이면 no-op.
function trackNew(data, event) {
  if (!data || !event) return;
  if (modes(data).write === 'json') return;
  stateFor(data).newEvents.push(event);
}

// markEventReadBy 성공 후: 바뀐 event.id만 추적(①). write=json이면 no-op.
function trackReadBy(data, eventId) {
  if (!data || !eventId) return;
  if (modes(data).write === 'json') return;
  stateFor(data).dirtyReadBy.add(String(eventId));
}

// abort-empty 삭제 후: 해당 jobId SQL events 삭제 예약. write=json이면 no-op.
function trackDeleteJob(data, jobId) {
  if (!data || !jobId) return;
  if (modes(data).write === 'json') return;
  stateFor(data).deleteJobs.add(String(jobId));
}

// saveStore가 JSON 기록을 '성공시킨 뒤'② 호출. SQL에 미러(삭제→신규append→바뀐readBy). 전부 best-effort(절대 throw 안 함).
function flush(data) {
  const s = _state.get(data);
  if (!s) return;
  const m = s.modes || readModesFromDisk();
  const E = sqlEvents();
  if (m.write === 'json' || !E) { s.newEvents.length = 0; s.dirtyReadBy.clear(); s.deleteJobs.clear(); return; }
  if (s.deleteJobs.size) {
    for (const jid of s.deleteJobs) { try { E.deleteByJob(jid); } catch (_) {} }
    s.deleteJobs.clear();
  }
  if (s.newEvents.length) {
    try { E.appendMany(s.newEvents); } catch (_) { for (const e of s.newEvents) { try { E.append(e); } catch (_) {} } }
    s.newEvents.length = 0;
  }
  if (s.dirtyReadBy.size) {
    const byId = new Map((Array.isArray(data.events) ? data.events : []).map(e => [String(e.id), e]));
    for (const id of s.dirtyReadBy) {
      const e = byId.get(id);
      if (e) { try { E.updateReadBy(id, e.readBy); } catch (_) {} }
    }
    s.dirtyReadBy.clear();
  }
}

// 정합성 보정: JSON(fileEvents)엔 있으나 SQL에 없는 id 재append. append 실패의 자동 수렴(read=sqlite '표시누락' 복구).
function reconcile(fileEvents) {
  const E = sqlEvents();
  if (!E || !Array.isArray(fileEvents)) return { ok: false, added: 0 };
  try {
    const have = E.allIds();
    const missing = fileEvents.filter(e => e && e.id && !have.has(e.id));
    if (missing.length) E.appendMany(missing);
    return { ok: true, added: missing.length, jsonCount: fileEvents.length, sqlCount: E.count() };
  } catch (e) {
    return { ok: false, added: 0, error: e.message };
  }
}

// loadStore에서 호출(throttle). read=sqlite일 때만, 최대 intervalMs마다 1회 reconcile(상시 모니터 대용).
let _lastReconcile = 0;
function maybeReconcile(fileEvents, intervalMs = 10 * 60 * 1000) {
  const now = Date.now();
  if (now - _lastReconcile < intervalMs) return;      // throttle 먼저(설정.json read 최소화)
  if (readModesFromDisk().read !== 'sqlite') return;  // sqlite 읽기 중일 때만 보정
  _lastReconcile = now;
  try { reconcile(fileEvents); } catch (_) {}
}

module.exports = {
  modes, readModesFromDisk, hydrate,
  trackNew, trackReadBy, trackDeleteJob, flush,
  reconcile, maybeReconcile, sqlEvents,
};
