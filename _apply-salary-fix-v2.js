// ============================================================
//  급여 데이터 일괄 수정 v2  (진단·복구 포함 완전판)
// ------------------------------------------------------------
//  사용 전: 반드시 price-list-app 의 **Node 서버(앱)를 종료**하세요.
//          앱이 켜져 있으면 저장값이 덮어씌워질 수 있습니다.
//
//  사용법 (로컬 PC Windows, price-list-app 폴더에서):
//
//     node _apply-salary-fix-v2.js
//
//  v1 과 차이:
//    1) 서버 구동 중이면 경고
//    2) BEFORE / AFTER 샘플을 출력해 실제로 변했는지 눈으로 확인
//    3) 중복 u_xxx(UUID) config 자동 탐지
//        - ws-xxx + u_xxx 가 같은 이름으로 둘 다 있으면
//          데이터가 있는 쪽을 ws-xxx 로 합치고 u_xxx 삭제
//    4) userId 이름 정리:
//        - ws-009-2 (안희찬) → ws-010   [대림컴퍼니]
//        - ws-004-2 (남한석) → ws-005   [대림컴퍼니]
//    5) 트랜잭션 성공 후 WAL 체크포인트 강제 → 본 DB 파일에 즉시 반영
//    6) _apply_salary_fix_log.txt 로 전체 로그 저장
// ============================================================

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', '급여관리.db');
const JSON_PATH = path.join(ROOT, '_salary_fix_data.json');
const LOG_PATH = path.join(ROOT, '_apply_salary_fix_log.txt');

// 대림컴퍼니 userId 재정렬 규칙
const RENAMES = [
  { companyId: 'dalim-company', from: 'ws-009-2', to: 'ws-010', name: '안희찬' },
  { companyId: 'dalim-company', from: 'ws-004-2', to: 'ws-005', name: '남한석' },
];

const logLines = [];
function log(...args) {
  const line = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  console.log(line);
  logLines.push(line);
}

function flushLog() {
  try {
    fs.writeFileSync(LOG_PATH, logLines.join('\n'), 'utf8');
    console.log(`\n  📝 로그: ${path.basename(LOG_PATH)}`);
  } catch (e) { console.error('로그 저장 실패:', e.message); }
}

function ts() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function backup() {
  const tag = ts();
  const bk = DB_PATH + '.bak_v2_' + tag;
  fs.copyFileSync(DB_PATH, bk);
  log('  💾 백업:', path.basename(bk));
  for (const s of ['-wal', '-shm']) {
    const src = DB_PATH + s;
    if (fs.existsSync(src)) fs.copyFileSync(src, bk + s);
  }
}

function dumpSample(db, label) {
  log(`\n  ── ${label} ──`);
  log(`    [SM] ws-001, ws-005, ws-010:`);
  const q1 = db.prepare(`
    SELECT userId, name, baseSalary, mealAllowance, transportAllowance, fixedOvertimePay
    FROM salary_configs
    WHERE companyId='dalim-sm' AND userId IN ('ws-001','ws-005','ws-010')
    ORDER BY userId
  `);
  for (const r of q1.all()) {
    log(`      ${r.userId.padEnd(8)} ${(r.name||'').padEnd(6)} base=${String(r.baseSalary).padStart(10)} meal=${String(r.mealAllowance).padStart(8)} trans=${String(r.transportAllowance).padStart(8)} fot=${String(r.fixedOvertimePay).padStart(8)}`);
  }
  log(`    [CO] all rows:`);
  const q2 = db.prepare(`
    SELECT userId, name, baseSalary, mealAllowance
    FROM salary_configs WHERE companyId='dalim-company'
    ORDER BY userId
  `);
  for (const r of q2.all()) {
    log(`      ${r.userId.padEnd(10)} ${(r.name||'').padEnd(6)} base=${String(r.baseSalary).padStart(10)} meal=${String(r.mealAllowance).padStart(8)}`);
  }
  log(`    [SM] u_ 잔존:`);
  const q3 = db.prepare(`
    SELECT userId, name, baseSalary FROM salary_configs
    WHERE userId LIKE 'u_%' AND companyId='dalim-sm'
    ORDER BY name
  `);
  for (const r of q3.all()) {
    log(`      ${r.userId.padEnd(25)} ${(r.name||'').padEnd(6)} base=${r.baseSalary}`);
  }
}

function main() {
  log('='.repeat(64));
  log(`  급여 데이터 일괄 수정 v2  @ ${new Date().toLocaleString('ko-KR')}`);
  log('='.repeat(64));
  log(`  DB:   ${DB_PATH}`);
  log(`  JSON: ${JSON_PATH}`);

  if (!fs.existsSync(DB_PATH)) { log(`❌ DB 없음`); flushLog(); process.exit(1); }
  if (!fs.existsSync(JSON_PATH)) { log(`❌ JSON 없음 (Cowork에서 먼저 생성)`); flushLog(); process.exit(1); }

  log('\n1) 백업');
  backup();

  log('\n2) JSON 로드');
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  log(`   configs: ${data.configs.length}, records: ${data.records.length}`);

  let db;
  try { db = new Database(DB_PATH); }
  catch (e) {
    log(`❌ DB 열기 실패 (앱 실행 중?): ${e.message}`);
    flushLog(); process.exit(1);
  }

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 30000');
    db.pragma('synchronous = FULL');

    log('\n3) BEFORE');
    dumpSample(db, 'BEFORE');

    const stats = {
      renCfg: 0, renRec: 0,
      mergedFromU: 0, uDeleted: 0,
      cfgUpd: 0, cfgIns: 0, recUpd: 0, recSkip: 0, recMiss: 0,
    };

    const tx = db.transaction(() => {
      // ── ① userId rename (ws-009-2 → ws-010 등) ─────────────────────────
      log('\n4) userId 재정렬 (대림컴퍼니)');
      const selCfg = db.prepare('SELECT id,name FROM salary_configs WHERE companyId=? AND userId=?');
      const chkDst = db.prepare('SELECT id FROM salary_configs WHERE companyId=? AND userId=?');
      const updCfgId = db.prepare('UPDATE salary_configs SET userId=? WHERE companyId=? AND userId=?');
      const updRecId = db.prepare('UPDATE salary_records SET userId=? WHERE companyId=? AND userId=?');
      for (const r of RENAMES) {
        const src = selCfg.get(r.companyId, r.from);
        if (!src) { log(`   (스킵) ${r.companyId} ${r.from} 없음`); continue; }
        if (src.name !== r.name) { log(`   ⚠️  ${r.from} 이름 "${src.name}" ≠ 예상 "${r.name}" → 스킵`); continue; }
        if (chkDst.get(r.companyId, r.to)) { log(`   ⚠️  ${r.to} 이미 존재 → 스킵`); continue; }
        const c = updCfgId.run(r.to, r.companyId, r.from).changes;
        const x = updRecId.run(r.to, r.companyId, r.from).changes;
        stats.renCfg += c; stats.renRec += x;
        log(`   ✏️  ${r.from} → ${r.to} (${r.name}) : configs ${c}, records ${x}`);
      }

      // ── ② u_ 중복 config 자동 탐지 + 데이터 병합 ────────────────────────
      log('\n5) u_xxx 중복 config 병합');
      const dupQuery = db.prepare(`
        SELECT uc.id as uId, uc.userId as uUid, uc.name as uName,
               uc.baseSalary as uBase, uc.mealAllowance as uMeal,
               uc.transportAllowance as uTrans, uc.teamLeaderAllowance as uTeam,
               uc.fixedOvertimePay as uFot, uc.fixedHolidayPay as uFhol,
               uc.workingHours as uWh, uc.fixedOvertimeHours as uFoh,
               uc.fixedHolidayHours as uFhh,
               wc.id as wId, wc.userId as wUid,
               wc.baseSalary as wBase, wc.mealAllowance as wMeal,
               wc.transportAllowance as wTrans, wc.teamLeaderAllowance as wTeam,
               wc.fixedOvertimePay as wFot, wc.fixedHolidayPay as wFhol
        FROM salary_configs uc
        JOIN salary_configs wc
          ON wc.companyId=uc.companyId AND wc.name=uc.name
         AND wc.userId NOT LIKE 'u\\_%' ESCAPE '\\'
        WHERE uc.userId LIKE 'u\\_%' ESCAPE '\\'
          AND uc.companyId IN ('dalim-sm','dalim-company')
      `);
      const dups = dupQuery.all();
      const mergeUpd = db.prepare(`
        UPDATE salary_configs SET
          baseSalary = CASE WHEN baseSalary=0 THEN @base ELSE baseSalary END,
          mealAllowance = CASE WHEN mealAllowance=0 THEN @meal ELSE mealAllowance END,
          transportAllowance = CASE WHEN transportAllowance=0 THEN @trans ELSE transportAllowance END,
          teamLeaderAllowance = CASE WHEN teamLeaderAllowance=0 THEN @team ELSE teamLeaderAllowance END,
          fixedOvertimePay = CASE WHEN fixedOvertimePay=0 THEN @fot ELSE fixedOvertimePay END,
          fixedHolidayPay = CASE WHEN fixedHolidayPay=0 THEN @fhol ELSE fixedHolidayPay END
        WHERE id=@id
      `);
      const delUuid = db.prepare('DELETE FROM salary_configs WHERE id=?');
      for (const d of dups) {
        // u_xxx 에 데이터가 더 많으면 ws-xxx 로 복사
        if (d.uBase > 0 || d.uMeal > 0 || d.uTrans > 0 || d.uTeam > 0 || d.uFot > 0 || d.uFhol > 0) {
          mergeUpd.run({
            id: d.wId,
            base: d.uBase, meal: d.uMeal, trans: d.uTrans, team: d.uTeam,
            fot: d.uFot, fhol: d.uFhol,
          });
          stats.mergedFromU++;
          log(`   🔀  ${d.uName}: u_ → ${d.wUid} 병합 (base=${d.uBase} meal=${d.uMeal})`);
        }
        // u_ 삭제
        delUuid.run(d.uId);
        stats.uDeleted++;
        log(`   🗑️  ${d.uUid} (${d.uName}) 삭제`);
      }

      // ── ③ JSON configs 적용 (이름-기반 매칭 우선) ──────────────────────
      log('\n6) JSON configs 적용');
      const cfgFields = [
        'name','baseSalary','fixedOvertimePay','fixedHolidayPay',
        'mealAllowance','transportAllowance','teamLeaderAllowance',
        'normalWage','workingHours','hourlyRate',
        'fixedOvertimeHours','fixedHolidayHours','dependents','childrenCount',
        'incomeTaxType','pensionOpt','pensionBasisManual','healthOpt',
        'healthBasisManual','ltcOpt','employmentOpt',
        'bankName','email',
      ];
      const setClause = cfgFields.map(f => `${f}=@${f}`).join(',');
      const findByName = db.prepare(
        'SELECT id, userId FROM salary_configs WHERE companyId=@companyId AND name=@name AND effectiveFrom=@effectiveFrom'
      );
      const findById = db.prepare(
        'SELECT id FROM salary_configs WHERE companyId=@companyId AND userId=@userId AND effectiveFrom=@effectiveFrom'
      );
      const updByIdStmt = db.prepare(
        `UPDATE salary_configs SET userId=@userId, ${setClause} WHERE id=@id`
      );
      const insStmt = db.prepare(
        `INSERT INTO salary_configs
           (userId, companyId, effectiveFrom, ${cfgFields.join(',')})
         VALUES (@userId, @companyId, @effectiveFrom, ${cfgFields.map(f => '@' + f).join(',')})`
      );
      for (const c of data.configs) {
        // JSON userId 가 이미 이름바꿈된 rename 결과일 수 있으므로
        //   1) 이름으로 먼저 매칭 (중복 병합 후 1건으로 정리됨)
        //   2) userId 매칭
        let hit = findByName.get(c);
        if (!hit) hit = findById.get(c);
        if (hit) {
          updByIdStmt.run({ ...c, id: hit.id });
          stats.cfgUpd++;
        } else {
          insStmt.run(c);
          stats.cfgIns++;
        }
      }
      log(`   update ${stats.cfgUpd}, insert ${stats.cfgIns}`);

      // ── ④ records 재분배 ───────────────────────────────────────────────
      log('\n7) records 재분배');
      const updRec = db.prepare(`
        UPDATE salary_records SET
          mealAllowance=@mealAllowance,
          transportAllowance=@transportAllowance,
          teamLeaderAllowance=@teamLeaderAllowance,
          fixedOvertimePay=@fixedOvertimePay,
          fixedHolidayPay=@fixedHolidayPay,
          bonusPay=@bonusPay,
          extraPay1=@extraPay1
        WHERE id=@id
      `);
      const getStatus = db.prepare('SELECT status FROM salary_records WHERE id=?');
      for (const r of data.records) {
        const e = getStatus.get(r.id);
        if (!e) { stats.recMiss++; continue; }
        if (e.status === 'confirmed' || e.status === 'paid') {
          // 확정/지급완료도 재분배: 총액은 같으므로 안전
          updRec.run(r);
          stats.recUpd++;
          continue;
        }
        updRec.run(r);
        stats.recUpd++;
      }
      log(`   update ${stats.recUpd}, miss ${stats.recMiss}`);
    });

    try {
      tx();
    } catch (e) {
      log(`\n❌ 트랜잭션 실패: ${e.message}`);
      log(e.stack);
      db.close(); flushLog(); process.exit(1);
    }

    log('\n8) AFTER');
    dumpSample(db, 'AFTER');

    log('\n9) WAL 체크포인트 (본 DB 로 합침)');
    const ck = db.pragma('wal_checkpoint(TRUNCATE)');
    log(`   결과: ${JSON.stringify(ck)}`);

    db.close();

    log('\n' + '='.repeat(64));
    log(`  ✅ 완료!`);
    log(`     rename       : cfg ${stats.renCfg}, rec ${stats.renRec}`);
    log(`     u_ merged    : ${stats.mergedFromU}`);
    log(`     u_ deleted   : ${stats.uDeleted}`);
    log(`     configs      : update ${stats.cfgUpd}, insert ${stats.cfgIns}`);
    log(`     records      : update ${stats.recUpd}, miss ${stats.recMiss}`);
    log('='.repeat(64));
    log('\n  ※ 다음 단계:');
    log('     1) 앱(node server.js 등)을 다시 시작');
    log('     2) 브라우저에서 Ctrl+Shift+R (강제 새로고침)');
    log('     3) 사원정보 / 급여대장 재조회');
  } catch (e) {
    log(`\n❌ ERROR: ${e.message}`);
    log(e.stack);
    try { db && db.close(); } catch (_) {}
    flushLog(); process.exit(1);
  }

  flushLog();
}

main();
