// ============================================================
//  사번(UUID→ws-xxx) + 조직관리.json 일괄 보정
// ------------------------------------------------------------
//  목적
//   1. salary_configs/records 에 남아있는 UUID(u_xxx) userId 를
//      엑셀 사원정보(ws-016/ws-012/ws-067) 로 교체 — 남관원/한윤호/장은지 등
//   2. 조직관리.json 에 엑셀 사원정보 전직원(대림에스엠 46 + 대림컴퍼니 8)
//      등록. 기존 UUID 계정(남관원/한윤호/장은지)은 id 보존 + sabun 필드 부여.
//   3. 퇴사자 25명 status='resigned' + resignDate 반영.
//
//  사용법 (로컬 PC Windows, price-list-app 폴더에서):
//     앱 서버(Node) 끈 상태에서
//     node _apply-sabun-org-fix.js
// ============================================================

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', '급여관리.db');
const ORG_PATH = path.join(ROOT, 'data', '조직관리.json');
const IMPORT_SM = path.join(ROOT, 'data', 'import', 'employees_daelim-sm.json');
const IMPORT_CO = path.join(ROOT, 'data', 'import', 'employees_daelim-company.json');
const LOG_PATH = path.join(ROOT, '_apply_sabun_org_fix_log.txt');

const logLines = [];
function log(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(line);
  logLines.push(line);
}
function flushLog() {
  try { fs.writeFileSync(LOG_PATH, logLines.join('\n'), 'utf8'); console.log(`\n  📝 로그: ${path.basename(LOG_PATH)}`); }
  catch (e) { console.error('로그 저장 실패:', e.message); }
}
function ts() { return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14); }

function backup() {
  const tag = ts();
  const bkDb = DB_PATH + '.bak_sabunorg_' + tag;
  fs.copyFileSync(DB_PATH, bkDb);
  for (const s of ['-wal','-shm']) {
    const src = DB_PATH + s;
    if (fs.existsSync(src)) fs.copyFileSync(src, bkDb + s);
  }
  const bkOrg = ORG_PATH + '.bak_sabunorg_' + tag;
  fs.copyFileSync(ORG_PATH, bkOrg);
  log('  💾 백업:');
  log('     -', path.basename(bkDb));
  log('     -', path.basename(bkOrg));
}

function main() {
  log('='.repeat(64));
  log(`  사번/조직관리 일괄 보정  @ ${new Date().toLocaleString('ko-KR')}`);
  log('='.repeat(64));

  for (const p of [DB_PATH, ORG_PATH, IMPORT_SM, IMPORT_CO]) {
    if (!fs.existsSync(p)) { log(`❌ 파일 없음: ${p}`); flushLog(); process.exit(1); }
  }

  log('\n1) 백업');
  backup();

  log('\n2) 엑셀 사원정보 JSON 로드');
  const empSm = JSON.parse(fs.readFileSync(IMPORT_SM, 'utf8'));
  const empCo = JSON.parse(fs.readFileSync(IMPORT_CO, 'utf8'));
  log(`   대림에스엠 ${empSm.length}명, 대림컴퍼니 ${empCo.length}명`);

  // (companyId, name) → 엑셀 사원정보 엔트리
  const excelByNameCo = {};
  for (const e of empSm) excelByNameCo[`dalim-sm::${e.name}`] = e;
  for (const e of empCo) excelByNameCo[`dalim-company::${e.name}`] = e;

  let db;
  try { db = new Database(DB_PATH); }
  catch (e) {
    log(`❌ DB 열기 실패 (앱이 실행 중입니까?): ${e.message}`);
    flushLog(); process.exit(1);
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 30000');
    db.pragma('synchronous = FULL');

    const stats = {
      cfgRenamed: 0, recRenamed: 0,
      orgKept: 0, orgUpdated: 0, orgInserted: 0,
      orgResigned: 0,
    };

    const tx = db.transaction(() => {
      // ── ① salary_configs: u_xxx userId → Excel sabun (소문자) ─────────────
      log('\n3) salary_configs UUID → 엑셀 사번 이전');
      const uConfigs = db.prepare(`
        SELECT id, userId, companyId, name
        FROM salary_configs
        WHERE userId LIKE 'u\\_%' ESCAPE '\\'
          AND companyId IN ('dalim-sm','dalim-company')
      `).all();
      const updCfgUid = db.prepare('UPDATE salary_configs SET userId=? WHERE id=?');
      const chkCfg = db.prepare('SELECT id FROM salary_configs WHERE userId=? AND companyId=? AND effectiveFrom=(SELECT effectiveFrom FROM salary_configs WHERE id=?)');
      const delCfg = db.prepare('DELETE FROM salary_configs WHERE id=?');
      const updRecUid = db.prepare('UPDATE salary_records SET userId=? WHERE userId=? AND companyId=?');
      for (const c of uConfigs) {
        const ex = excelByNameCo[`${c.companyId}::${c.name}`];
        if (!ex) {
          log(`   ⚠️  엑셀에 없음: ${c.companyId} ${c.userId} (${c.name}) — 스킵`);
          continue;
        }
        const newUid = String(ex.userId).toLowerCase();
        // 동일 userId 가 이미 있으면 중복 → 기존 u_ 삭제로 처리
        const dup = chkCfg.get(newUid, c.companyId, c.id);
        if (dup) {
          delCfg.run(c.id);
          log(`   🗑️  ${c.userId} (${c.name}) → ${newUid} 중복, u_ 삭제`);
          continue;
        }
        updCfgUid.run(newUid, c.id);
        const rec = updRecUid.run(newUid, c.userId, c.companyId).changes;
        stats.cfgRenamed++;
        stats.recRenamed += rec;
        log(`   ✏️  ${c.userId} → ${newUid} (${c.name}) : records ${rec}건`);
      }

      // ── ② 조직관리.json 재구성 ────────────────────────────────────────────
      log('\n4) 조직관리.json 재구성');
      const org = JSON.parse(fs.readFileSync(ORG_PATH, 'utf8'));
      org.users = org.users || [];
      org.departments = org.departments || [];

      // 부서명 → 부서ID 매핑 (dalim-sm only)
      const deptByName = {};
      for (const d of org.departments) {
        if (d.companyId === 'dalim-sm') deptByName[d.name] = d.id;
      }
      function resolveDeptId(companyId, deptName) {
        if (!deptName) return '';
        if (companyId === 'dalim-sm') return deptByName[deptName] || '';
        // dalim-company 는 부서명 그대로 저장 (dept id 없음)
        return deptName;
      }

      // 기존 users 를 (companyId, name) 및 id 로 찾기 위한 인덱스
      const keepIdx = {}; // `${companyId}::${name}` → user
      for (const u of org.users) {
        if (u.companyId && u.name) keepIdx[`${u.companyId}::${u.name}`] = u;
      }

      // 새 org.users 구성 (기존 3명 + 엑셀 전직원 병합)
      const finalUsers = [];
      const handledExcel = new Set();

      // (a) 기존 users: id/password/role 등 그대로 + sabun 보강
      for (const u of org.users) {
        const key = `${u.companyId}::${u.name}`;
        const ex = excelByNameCo[key];
        if (!ex) {
          finalUsers.push(u);
          stats.orgKept++;
          continue;
        }
        handledExcel.add(key);
        const merged = { ...u };
        merged.sabun = ex.userId;
        // 기존 ERP 값 우선. 비어있을 때만 엑셀값 채움.
        merged.department = u.department || resolveDeptId(u.companyId, ex.dept) || '';
        merged.position = u.position || ex.position || '';
        merged.hireDate = u.hireDate || ex.hireDate || '';
        if (!u.birthDate && ex.birthDate) merged.birthDate = ex.birthDate;
        if (!u.email && ex.email) merged.email = ex.email;
        if (ex.resignDate) {
          merged.resignDate = ex.resignDate;
          merged.status = 'resigned';
          stats.orgResigned++;
        }
        finalUsers.push(merged);
        stats.orgUpdated++;
        log(`   ✏️  유지+보강: ${u.name} sabun=${ex.userId} ${u.companyId}`);
      }

      // (b) 엑셀에는 있는데 조직관리엔 없는 직원 추가
      const now = new Date().toISOString();
      function addExcelEmp(companyId, e) {
        const key = `${companyId}::${e.name}`;
        if (handledExcel.has(key)) return;
        const sabunLower = String(e.userId).toLowerCase();
        const id = `${companyId}:${sabunLower}`;
        const u = {
          id,
          userId: sabunLower,          // 로그인용은 비활성 (비밀번호 없음)
          sabun: e.userId,
          name: e.name,
          companyId,
          department: resolveDeptId(companyId, e.dept),
          position: e.position || '',
          phone: '',
          hireDate: e.hireDate || '',
          birthDate: e.birthDate || '',
          email: e.email || '',
          role: 'user',
          status: e.resignDate ? 'resigned' : 'approved',
          resignDate: e.resignDate || '',
          createdAt: now,
          // 비밀번호는 일부러 비워둠 → 로그인 불가 (근태/급여만 관리)
        };
        finalUsers.push(u);
        handledExcel.add(key);
        stats.orgInserted++;
        if (e.resignDate) stats.orgResigned++;
      }
      for (const e of empSm) addExcelEmp('dalim-sm', e);
      for (const e of empCo) addExcelEmp('dalim-company', e);

      org.users = finalUsers;
      fs.writeFileSync(ORG_PATH, JSON.stringify(org, null, 2), 'utf8');
      log(`   조직관리.json 쓰기 완료: 유지 ${stats.orgKept}, 보강 ${stats.orgUpdated}, 추가 ${stats.orgInserted}, 퇴사 ${stats.orgResigned}`);
    });
    tx();

    // WAL 체크포인트 (본 DB 파일에 반영)
    try { db.pragma('wal_checkpoint(TRUNCATE)'); log('  ✅ WAL checkpoint 완료'); }
    catch (e) { log('  ⚠️  WAL checkpoint 실패:', e.message); }

    log('\n5) 결과 요약');
    log('   salary_configs userId 교체:', stats.cfgRenamed);
    log('   salary_records userId 교체:', stats.recRenamed);
    log('   조직관리 유지/보강/추가/퇴사:', stats.orgKept, '/', stats.orgUpdated, '/', stats.orgInserted, '/', stats.orgResigned);
  }
  catch (e) {
    log('❌ 트랜잭션 실패:', e.message);
    log(e.stack);
    flushLog(); process.exit(1);
  }
  finally { db.close(); }

  log('\n✅ 완료');
  flushLog();
}

main();
