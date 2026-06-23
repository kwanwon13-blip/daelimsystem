// routes/lib/workflow-store.js
// 워크플로 스토어(작업jobs·파일files·발주orders·현장projects) SQLite 섀도 이관 어댑터.
// events 어댑터(workflow-events-store.js)의 형제·독립(다른 테이블·다른 플래그·다른 _state).
//
// 원칙: workflow.json(JSON)이 '항상' 진실원본(먼저 기록), SQLite는 best-effort 미러. 플래그=json이면 완전 no-op(현행 동일).
// events와 다른 점: 작업·발주는 단일 쓰기진입점이 없고 in-place로 산재 변경 → saveStore에서 '전체배열 upsert + orphan삭제(syncAll)'로 동기화.
// 적대적 점검(whl1agtj7) 반영: ①hydrate는 loadStore 캐시 적중/미적중 양분기 항상 호출(workflow.js에서 보장) ②projects 결정적 id
//   (랜덤 금지, JSON 객체 불변) ③모드 무캐시(롤백 즉시성) ④best-effort(throw 안 함) ⑤db.sql/테이블 없으면 강제 json.

const crypto = require('crypto');
const db = require('../../db');

const _state = new WeakMap();
function stateFor(data) { let s = _state.get(data); if (!s) { s = { modes: null }; _state.set(data, s); } return s; }

function sqlStore() {
  try { const s = db.sql; if (s && s.jobs && s.files && s.orders && s.projects) return s; } catch (_) {}
  return null;
}

// 설정.json: settings.workflow.workflowStore = { write:'json'|'dual'|'sqlite', read:'json'|'sqlite' }. 기본 json(무변화). eventsStore와 형제·독립.
function readModesFromDisk() {
  try {
    const s = (db['설정'] && db['설정'].load) ? (db['설정'].load() || {}) : {};
    const c = (s.workflow && s.workflow.workflowStore) || {};
    let write = ['json', 'dual', 'sqlite'].includes(c.write) ? c.write : 'json';
    let read = ['json', 'sqlite'].includes(c.read) ? c.read : 'json';
    if (!sqlStore()) { write = 'json'; read = 'json'; } // SQLite 미설치/테이블없음 → 강제 json 하드가드
    return { write, read };
  } catch (_) { return { write: 'json', read: 'json' }; }
}
function modes(data) {
  if (!data) return readModesFromDisk();
  const s = stateFor(data);
  if (!s.modes) s.modes = readModesFromDisk();
  return s.modes;
}

// 프로젝트 안정 id — 있으면 그대로, 없으면 회사|현장 결정적 해시(SQL 키 전용; JSON 객체는 절대 안 바꿈 → Phase 1 무변화·유령행 방지).
function projectId(p) {
  if (p && p.id) return String(p.id);
  const key = (String((p && p.companyName) || '') + '|' + String((p && p.projectName) || '')).toLowerCase().replace(/\s+/g, '');
  return key ? 'wpk_' + crypto.createHash('sha1').update(key).digest('hex').slice(0, 16) : '';
}
const ARRAYS = [
  { name: 'jobs', store: 'jobs', id: o => (o && o.id) ? String(o.id) : '', jobId: o => (o && o.id) ? String(o.id) : '' },
  { name: 'files', store: 'files', id: o => (o && o.id) ? String(o.id) : '', jobId: o => (o && o.jobId) ? String(o.jobId) : '' },
  { name: 'orders', store: 'orders', id: o => (o && o.id) ? String(o.id) : '', jobId: o => (o && o.jobId) ? String(o.jobId) : '' },
  { name: 'projects', store: 'projects', id: o => projectId(o), jobId: () => '' },
];
function rowsOf(arr, a) {
  return (Array.isArray(arr) ? arr : []).map(o => ({ id: a.id(o), jobId: a.jobId(o), obj: o })).filter(r => r.id);
}

// loadStore: read=sqlite면 data.jobs/files/orders/projects를 SQL서 교체(소비코드 무수정). read=json이면 그대로(무변화). ★양 캐시분기에서 항상 호출(수정#1).
function hydrate(data) {
  const m = modes(data);
  const S = sqlStore();
  if (m.read !== 'sqlite' || !S) return;
  for (const a of ARRAYS) {
    try { const arr = S[a.store].getAll(); if (Array.isArray(arr)) data[a.name] = arr; } catch (_) {}
  }
}

// saveStore가 JSON 확정 '뒤' 호출. write!=json이면 4배열 전체동기화(upsert+orphan삭제). 배열당 try-catch(한쪽 실패가 다른쪽·요청 안 막음).
function flush(data) {
  const m = modes(data);
  const S = sqlStore();
  if (m.write === 'json' || !S) return;
  for (const a of ARRAYS) {
    try { S[a.store].syncAll(rowsOf(data[a.name], a)); } catch (_) {}
  }
}

// 정합 보정: JSON(현재 data 배열 = 파일 진실)을 SQL에 전체동기화. read=sqlite throttle. ★hydrate '전에' 호출(아직 파일배열).
let _lastReconcile = 0;
function maybeReconcile(data, intervalMs = 10 * 60 * 1000) {
  const now = Date.now();
  if (now - _lastReconcile < intervalMs) return;
  if (readModesFromDisk().read !== 'sqlite') return;
  const S = sqlStore();
  if (!S) return;
  _lastReconcile = now;
  for (const a of ARRAYS) {
    try { S[a.store].syncAll(rowsOf(data[a.name], a)); } catch (_) {}
  }
}

// 백필/검증용: 현재 SQL 건수
function counts() {
  const S = sqlStore();
  if (!S) return null;
  const out = {};
  for (const a of ARRAYS) { try { out[a.name] = S[a.store].count(); } catch (_) { out[a.name] = -1; } }
  return out;
}

module.exports = { modes, readModesFromDisk, hydrate, flush, maybeReconcile, counts, sqlStore, projectId, rowsOf, ARRAYS };
