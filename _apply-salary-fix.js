// ============================================================
// 사원정보 configs 재생성 + extraPay1 재분배 적용 스크립트
// ------------------------------------------------------------
// 사용법 (로컬 PC Windows, price-list-app 폴더에서):
//
//   node _apply-salary-fix.js             ← 실제 반영
//
// 하는 일:
//   1) _salary_fix_data.json 읽음 (Cowork에서 미리 생성해 둠)
//   2) 중복 UUID configs 삭제 (이름이 ws-xxx에 이미 있는 경우)
//   3) 대림에스엠 46명 + 대림컴퍼니 8명 configs 업데이트
//      (Excel 사원정보 시트의 값 그대로)
//   4) 과거 52개월치 records의 extraPay1 재분배
//      → 식대 / 차량유지비 / 팀장수당 / 고정연장 / 고정휴일 / 상여로 분리
//   5) DB 백업 자동 생성
// ============================================================

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', '급여관리.db');
const JSON_PATH = path.join(ROOT, '_salary_fix_data.json');

function ts() {
  return new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

function backup() {
  const tag = ts();
  const bk = DB_PATH + '.bak_apply_fix_' + tag;
  fs.copyFileSync(DB_PATH, bk);
  console.log('  💾 백업:', path.basename(bk));
  for (const s of ['-wal', '-shm']) {
    const src = DB_PATH + s;
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, bk + s);
    }
  }
}

function main() {
  console.log('='.repeat(60));
  console.log('  급여 데이터 일괄 수정 (configs + records 재분배)');
  console.log('='.repeat(60));

  if (!fs.existsSync(JSON_PATH)) {
    console.error('❌ 데이터 파일 없음:', JSON_PATH);
    console.error('   Cowork 세션에서 먼저 데이터 추출이 필요합니다.');
    process.exit(1);
  }

  console.log('\n1) 백업 생성 중...');
  backup();

  console.log('\n2) JSON 데이터 로드 중...');
  const data = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  console.log(`   configs: ${data.configs.length}`);
  console.log(`   중복 UUID 후보: ${data.uuid_configs_to_check.length}`);
  console.log(`   records: ${data.records.length}`);

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 30000');

  const stats = { cfgUpsert: 0, cfgDel: 0, recUpdate: 0, recSkip: 0 };

  const tx = db.transaction(() => {
    // A) 중복 UUID configs 삭제 (이름이 ws-xxx 에 이미 있는 경우만)
    console.log('\n3) 중복 UUID configs 정리...');
    const findByName = db.prepare(
      "SELECT userId FROM salary_configs WHERE companyId=? AND name=? AND userId NOT LIKE 'u_%'"
    );
    const delCfg = db.prepare(
      "DELETE FROM salary_configs WHERE userId=? AND companyId=?"
    );
    for (const uc of data.uuid_configs_to_check) {
      const ws = findByName.get(uc.companyId, uc.name);
      if (ws) {
        delCfg.run(uc.userId, uc.companyId);
        stats.cfgDel++;
        console.log(`   🗑️  ${uc.userId} (${uc.name}) — ws쪽에 이미 존재`);
      }
    }

    // B) configs 업데이트 (UPSERT)
    console.log('\n4) configs 업데이트 중...');
    const cfgFields = [
      'name', 'baseSalary', 'fixedOvertimePay', 'fixedHolidayPay',
      'mealAllowance', 'transportAllowance', 'teamLeaderAllowance',
      'normalWage', 'workingHours', 'hourlyRate',
      'fixedOvertimeHours', 'fixedHolidayHours', 'dependents', 'childrenCount',
      'incomeTaxType', 'pensionOpt', 'pensionBasisManual', 'healthOpt',
      'healthBasisManual', 'ltcOpt', 'employmentOpt',
      'bankName', 'email',
    ];
    const setClause = cfgFields.map(f => `${f}=@${f}`).join(',');
    const checkExist = db.prepare(
      'SELECT id FROM salary_configs WHERE userId=@userId AND companyId=@companyId AND effectiveFrom=@effectiveFrom'
    );
    const updCfg = db.prepare(
      `UPDATE salary_configs SET ${setClause}
       WHERE userId=@userId AND companyId=@companyId AND effectiveFrom=@effectiveFrom`
    );
    const insCfg = db.prepare(
      `INSERT INTO salary_configs
       (userId, companyId, effectiveFrom, ${cfgFields.join(',')})
       VALUES (@userId, @companyId, @effectiveFrom, ${cfgFields.map(f => '@' + f).join(',')})`
    );
    for (const c of data.configs) {
      const existing = checkExist.get(c);
      if (existing) {
        updCfg.run(c);
      } else {
        insCfg.run(c);
      }
      stats.cfgUpsert++;
    }
    console.log(`   ✅ configs 업데이트: ${stats.cfgUpsert}건`);

    // C) records 업데이트 (extraPay1 재분배)
    console.log('\n5) records 재분배 중...');
    const updRec = db.prepare(
      `UPDATE salary_records SET
         mealAllowance=@mealAllowance,
         transportAllowance=@transportAllowance,
         teamLeaderAllowance=@teamLeaderAllowance,
         fixedOvertimePay=@fixedOvertimePay,
         fixedHolidayPay=@fixedHolidayPay,
         bonusPay=@bonusPay,
         extraPay1=@extraPay1
       WHERE id=@id`
    );
    const getRecStatus = db.prepare(
      'SELECT status FROM salary_records WHERE id=?'
    );
    for (const r of data.records) {
      const exist = getRecStatus.get(r.id);
      if (!exist) { stats.recSkip++; continue; }
      // 확정/지급완료된 record는 건드리지 않음 (데이터 무결성)
      if (exist.status === 'confirmed' || exist.status === 'paid') {
        stats.recSkip++;
        continue;
      }
      updRec.run(r);
      stats.recUpdate++;
    }
    console.log(`   ✅ records 재분배: ${stats.recUpdate}건 (확정/지급완료 스킵: ${stats.recSkip}건)`);
  });

  try {
    tx();
  } catch (e) {
    console.error('❌ 트랜잭션 실패:', e.message);
    db.close();
    process.exit(1);
  }
  db.close();

  console.log('\n' + '='.repeat(60));
  console.log('  ✅ 완료!');
  console.log(`     configs: ${stats.cfgUpsert}건 업데이트, ${stats.cfgDel}건 삭제`);
  console.log(`     records: ${stats.recUpdate}건 재분배 (${stats.recSkip}건 스킵)`);
  console.log('='.repeat(60));
  console.log('\n  브라우저에서 "급여대장 조회"를 다시 해보세요 —');
  console.log('  각 칸(식대/차량/고정연장/고정휴일/상여)이 제자리로 갑니다.');
}

main();
