// backfill-events-to-sqlite.js
// 워크플로 이력(events) JSON → SQLite 백필. 1회 수동 실행: node backfill-events-to-sqlite.js
//
// 안전: workflow.json은 '읽기만'(안 건드림) + 사전 백업. 멱등(INSERT OR IGNORE) → 재실행 안전(듀얼라이트로 이미 들어온 신규분은 자동 skip).
//   건수/샘플 불일치 시 '비정상 종료'(전환 금지 신호) — 사람 눈으로만 확인하던 1차 마이그레이션보다 강한 게이트.
//   ※ 듀얼라이트(eventsStore.write='dual') 배포 '이후' 실행 권장. 통과해야만 read='sqlite'로 전환.

const fs = require('fs');
const path = require('path');

const STORE_PATH = path.join(__dirname, 'data', 'workflow.json');
const BACKUP_DIR = path.join(__dirname, 'data', '_기존백업');

function log(...a) { console.log('[backfill-events]', ...a); }

let sqldb;
try { sqldb = require('./db-sqlite'); }
catch (e) {
  console.error('[backfill-events] better-sqlite3/db-sqlite 로드 실패 — 이 서버는 SQLite 미사용(JSON 폴백). 백필 불가:', e.message);
  process.exit(1);
}
if (!sqldb.events) { console.error('[backfill-events] db-sqlite.events 없음(구버전?). 중단.'); process.exit(1); }

// 1) 원본 읽기(손대지 않음)
let data;
try { data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8').replace(/\0/g, '')); }
catch (e) { console.error('[backfill-events] workflow.json 읽기 실패:', e.message); process.exit(1); }
const jsonEvents = Array.isArray(data.events) ? data.events : [];
log(`workflow.json events: ${jsonEvents.length}건`);

// 2) 사전 백업(원본 스냅샷)
try {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(BACKUP_DIR, `workflow.json.${stamp}`);
  fs.copyFileSync(STORE_PATH, dest);
  log('백업 생성:', dest);
} catch (e) { console.error('[backfill-events] 백업 실패(중단):', e.message); process.exit(1); }

// 3) 멱등 백필 — 배열 '원순서' 그대로(createdAt 재정렬 금지: 화면이 삽입순 의존). INSERT OR IGNORE라 재실행 안전.
try {
  const tried = sqldb.events.appendMany(jsonEvents);
  log(`appendMany 완료(시도 ${tried}건, 기존 id는 IGNORE)`);
} catch (e) { console.error('[backfill-events] 백필 실패:', e.message); process.exit(1); }

// 4) 건수 검증 게이트
const jsonCount = jsonEvents.length;
const sqlCount = sqldb.events.count();
log(`검증: JSON ${jsonCount} vs SQLite ${sqlCount}`);
if (jsonCount !== sqlCount) {
  console.error(`[backfill-events] ❌ 건수 불일치(JSON ${jsonCount} != SQLite ${sqlCount}) — 전환 금지. 원인 확인 후 재실행(멱등).`);
  process.exit(2);
}

// 5) 샘플 일치 검증(무작위 N) — id/jobId/type/message/createdAt + meta/readBy(객체 원본까지) 문자열 동등
const byId = new Map(sqldb.events.getAll().map(e => [String(e.id), e]));
const N = Math.min(20, jsonEvents.length);
let mismatch = 0;
for (let i = 0; i < N; i++) {
  const e = jsonEvents[Math.floor(Math.random() * jsonEvents.length)];
  const s = byId.get(String(e.id));
  if (!s) { mismatch++; console.error('  누락:', e.id); continue; }
  const same = String(e.id) === String(s.id)
    && String(e.jobId || '') === String(s.jobId || '')
    && String(e.type || '') === String(s.type || '')
    && String(e.message || '') === String(s.message || '')
    && String(e.createdAt || '') === String(s.createdAt || '')
    && JSON.stringify(e.meta || {}) === JSON.stringify(s.meta || {})
    && JSON.stringify(Array.isArray(e.readBy) ? e.readBy : []) === JSON.stringify(Array.isArray(s.readBy) ? s.readBy : []);
  if (!same) { mismatch++; console.error('  불일치:', e.id); }
}
if (mismatch) { console.error(`[backfill-events] ❌ 샘플 ${mismatch}건 불일치 — 전환 금지.`); process.exit(3); }

log(`✅ 통과: JSON==SQLite ${sqlCount}건, 샘플 ${N}건 일치.`);
log(`다음: 설정.json의 workflow.eventsStore.read 를 'sqlite' 로(또는 PUT /api/workflow/settings/events-store {read:"sqlite"}). 문제 시 read:'json' 으로 즉시 원복.`);
process.exit(0);
