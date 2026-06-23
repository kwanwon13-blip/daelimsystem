// backfill-workflow-store.js
// 워크플로 스토어(작업·파일·발주·현장) JSON → SQLite 백필. 1회 수동 실행: node backfill-workflow-store.js
//
// 안전: workflow.json '읽기만'(안 건드림) + 사전 백업. syncAll(upsert+orphan삭제)이라 멱등(재실행 안전·dual 중 갱신분도 따라잡음).
//   건수 불일치 시 비정상 종료(전환 금지). ※ 듀얼라이트(workflowStore.write='dual') '이후' 실행 권장.

const fs = require('fs');
const path = require('path');
const STORE_PATH = path.join(__dirname, 'data', 'workflow.json');
const BACKUP_DIR = path.join(__dirname, 'data', '_기존백업');
function log(...a) { console.log('[backfill-store]', ...a); }

let wfStore;
try { wfStore = require('./routes/lib/workflow-store'); }
catch (e) { console.error('[backfill-store] 로드 실패:', e.message); process.exit(1); }
const S = wfStore.sqlStore();
if (!S) { console.error('[backfill-store] SQLite 미사용(db.sql=null/테이블없음) — 백필 불가.'); process.exit(1); }

// 1) 원본 읽기(손대지 않음)
let data;
try { data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8').replace(/\0/g, '')); }
catch (e) { console.error('[backfill-store] workflow.json 읽기 실패:', e.message); process.exit(1); }

// 2) 사전 백업
try {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  fs.copyFileSync(STORE_PATH, path.join(BACKUP_DIR, `workflow.json.store_${stamp}`));
  log('백업 생성');
} catch (e) { console.error('[backfill-store] 백업 실패(중단):', e.message); process.exit(1); }

// 3) 멱등 동기화(syncAll) + 검증
let fail = 0;
for (const a of wfStore.ARRAYS) {
  const arr = Array.isArray(data[a.name]) ? data[a.name] : [];
  const rows = wfStore.rowsOf(arr, a);
  const uniqIds = new Set(rows.map(r => r.id));
  try {
    S[a.store].syncAll(rows);
    const sqlCount = S[a.store].count();
    log(`${a.name}: 항목 ${arr.length} (id있음 ${rows.length}, 고유 ${uniqIds.size}) → SQLite ${sqlCount}`);
    if (rows.length !== uniqIds.size) console.warn(`  ⚠ ${a.name} 중복 id ${rows.length - uniqIds.size}개(현장 키 충돌 가능 — 검토)`);
    if (sqlCount !== uniqIds.size) { console.error(`  ❌ ${a.name} 건수 불일치(SQLite ${sqlCount} != 고유 ${uniqIds.size})`); fail++; }
  } catch (e) { console.error(`  ❌ ${a.name} 동기화 실패:`, e.message); fail++; }
}
if (fail) { console.error(`[backfill-store] ❌ ${fail}개 배열 실패 — 전환 금지. 원인 확인 후 재실행(멱등).`); process.exit(2); }

log('✅ 통과: 작업·파일·발주·현장 JSON==SQLite.');
log('다음: PUT /api/workflow/settings/workflow-store {read:"sqlite"} (또는 설정.json workflow.workflowStore.read="sqlite"). 문제 시 read:"json" 즉시 복귀.');
process.exit(0);
