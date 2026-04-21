// ============================================================
// 엑셀 사원정보 → salary_configs 직접 업데이트 (재시도 버전)
// ------------------------------------------------------------
// 사용법 (로컬 PC Windows, price-list-app 폴더에서):
//
//   node _fix-configs.js --dry-run    ← 미리보기 (DB 변경 X)
//   node _fix-configs.js               ← 실제 반영
//
// 하는 일:
//   1) 대림에스엠_급여관리기_신버전2026.xlsm / 대림컴퍼니_..xlsm 읽음
//   2) 각 Excel 사원 row에 대해 DB에서 대응하는 config 찾음
//      - userId(WS-001) 대소문자 무시 매치
//      - UUID 유저(남관원/한윤호/장은지)는 이름으로 매치
//   3) 중복 UUID configs(u_177643...) 삭제
//   4) configs.upsert()로 값 반영 (normalWage/hourlyRate 자동 계산)
// ============================================================

const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');

const DRY = process.argv.includes('--dry-run');

const ROOT = __dirname;
const DB_PATH = path.join(ROOT, 'data', '급여관리.db');

// Excel 파일 경로 (루트 세션 경로)
const XLSM_SM = path.join(ROOT, '..', '..', '대림에스엠_급여관리기_신버전2026.xlsm');
const XLSM_CO = path.join(ROOT, '..', '..', '대림컴퍼니_급여관리기_신버전2026.xlsm');

function log(...args) { console.log(...args); }

// ── DB backup ────────────────────────────────────────────────────────────
function backupDb() {
  if (DRY) return;
  const tag = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);
  for (const suffix of ['', '-wal', '-shm']) {
    const src = DB_PATH + suffix;
    if (fs.existsSync(src)) {
      const dst = src.replace('.db', `.db.bak_configfix_${tag}`);
      fs.copyFileSync(src, dst);
      log(`  💾 백업: ${path.basename(dst)}`);
    }
  }
}

// ── Excel 사원정보 시트 읽기 ────────────────────────────────────────────
async function readEmployees(xlsmPath, companyLabel) {
  if (!fs.existsSync(xlsmPath)) {
    log(`  ⚠️ ${companyLabel} xlsm 파일 없음: ${xlsmPath} — 건너뜀`);
    return [];
  }
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(xlsmPath);
  const ws = wb.getWorksheet('사원정보');
  if (!ws) {
    log(`  ⚠️ ${companyLabel} 사원정보 시트 없음`);
    return [];
  }
  const rows = [];
  // 행 3부터 데이터 시작 (행 1=제목, 행 2=헤더)
  for (let r = 3; r <= ws.rowCount; r++) {
    const row = ws.getRow(r);
    const sabun = row.getCell(2).value;
    const name = row.getCell(4).value;
    if (!sabun || !name) continue;
    // Excel value → primitive
    const v = (cell, def = 0) => {
      let x = cell.value;
      if (x && typeof x === 'object' && 'result' in x) x = x.result;
      if (x === null || x === undefined || x === '') return def;
      return x;
    };
    const s = (cell, def = '') => {
      let x = cell.value;
      if (x && typeof x === 'object' && 'result' in x) x = x.result;
      if (x === null || x === undefined) return def;
      return String(x).trim();
    };
    const d = (cell) => {
      let x = cell.value;
      if (x instanceof Date) return x.toISOString().slice(0, 10);
      if (x && typeof x === 'object' && 'result' in x && x.result instanceof Date) {
        return x.result.toISOString().slice(0, 10);
      }
      return '';
    };
    const boolMark = (cell) => {
      const t = s(cell).trim();
      // Excel에서는 ○, X, - 등으로 표시. O/X로 정규화
      if (!t || t === '-') return '';
      if (t === '○' || t === 'O' || t === 'o') return 'O';
      if (t === 'X' || t === 'x' || t === '×') return 'X';
      return t;
    };
    rows.push({
      sabun: String(sabun).trim(),
      dept: s(row.getCell(3)),
      name: String(name).trim(),
      position: s(row.getCell(5)),
      birthDate: d(row.getCell(6)),
      hireDate: d(row.getCell(7)),
      resignDate: d(row.getCell(8)),
      baseSalary: Math.round(Number(v(row.getCell(10))) || 0),
      fixedOvertimePay: Math.round(Number(v(row.getCell(11))) || 0),
      fixedHolidayPay: Math.round(Number(v(row.getCell(12))) || 0),
      mealAllowance: Math.round(Number(v(row.getCell(13))) || 0),
      transportAllowance: Math.round(Number(v(row.getCell(14))) || 0),
      teamLeaderAllowance: Math.round(Number(v(row.getCell(15))) || 0),
      pensionBasisManual: Math.round(Number(v(row.getCell(16))) || 0),
      pensionOpt: boolMark(row.getCell(17)),
      healthBasisManual: Math.round(Number(v(row.getCell(18))) || 0),
      healthOpt: boolMark(row.getCell(19)),
      ltcOpt: boolMark(row.getCell(20)),
      employmentOpt: boolMark(row.getCell(21)),
      incomeTaxType: s(row.getCell(22), '근로소득 100%'),
      dependents: Math.round(Number(v(row.getCell(23))) || 1),
      childrenCount: Math.round(Number(v(row.getCell(24))) || 0),
      bankName: s(row.getCell(25)),
      bankAccount: s(row.getCell(26)),
      email: s(row.getCell(27)),
      workingHours: Math.round(Number(v(row.getCell(28))) || 209),
      fixedOvertimeHours: Number(v(row.getCell(30))) || 0,
      fixedHolidayHours: Number(v(row.getCell(31))) || 0,
    });
  }
  return rows;
}

// ── 회사 1개 처리 ────────────────────────────────────────────────────────
async function processCompany(db, salaryDb, companyId, companyLabel, xlsmPath) {
  log(`\n─────────────────────────────────────────────────`);
  log(`  ${companyLabel}  [${companyId}]`);
  log(`─────────────────────────────────────────────────`);

  const employees = await readEmployees(xlsmPath, companyLabel);
  if (employees.length === 0) {
    log(`  사원정보 비어있음 — 건너뜀`);
    return;
  }
  log(`  Excel 사원 ${employees.length}명 읽음`);

  // DB 기존 configs
  const dbConfigs = db.prepare('SELECT userId, name FROM salary_configs WHERE companyId=?').all(companyId);
  const byLowerId = {};
  const byName = {};
  for (const c of dbConfigs) {
    byLowerId[c.userId.toLowerCase()] = c;
    (byName[c.name] = byName[c.name] || []).push(c);
  }

  // 중복 UUID configs 감지 (이름이 WS-xxx 에 이미 있는데 추가로 UUID config도 존재)
  const dupUuidConfigs = [];
  for (const c of dbConfigs) {
    if (!c.userId.startsWith('u_')) continue;
    // 같은 이름의 ws-xxx config이 있는가?
    const sameName = byName[c.name] || [];
    const wsOne = sameName.find(x => !x.userId.startsWith('u_'));
    if (wsOne) {
      dupUuidConfigs.push({ uuid: c.userId, name: c.name, wsUserId: wsOne.userId });
    }
  }
  if (dupUuidConfigs.length) {
    log(`\n  ⚠️ 중복 UUID configs (ws-xxx에 이미 존재) — 삭제 예정:`);
    for (const d of dupUuidConfigs) {
      log(`     ${d.uuid} (${d.name}) → ws: ${d.wsUserId}`);
    }
    if (!DRY) {
      const delStmt = db.prepare('DELETE FROM salary_configs WHERE userId=? AND companyId=?');
      for (const d of dupUuidConfigs) delStmt.run(d.uuid, companyId);
      log(`  🗑️ ${dupUuidConfigs.length}건 삭제 완료`);
    }
  }

  // 매칭 & upsert
  let matched = 0, nameMatched = 0, unmatched = 0;
  for (const e of employees) {
    const sabunLower = e.sabun.toLowerCase();
    let target = byLowerId[sabunLower];
    let matchType = 'ID';

    if (!target) {
      // 이름 매치 (다시 조회 — 중복 삭제됐으므로)
      const nameHits = db.prepare('SELECT userId, name FROM salary_configs WHERE companyId=? AND name=?').all(companyId, e.name);
      if (nameHits.length === 1) {
        target = nameHits[0];
        matchType = 'NAME';
      } else if (nameHits.length > 1) {
        target = nameHits.find(x => x.userId.startsWith('u_')) || nameHits[0];
        matchType = 'NAME(multi)';
      }
    }

    if (!target) {
      unmatched++;
      log(`  ❌ 매치실패: ${e.sabun} ${e.name}`);
      continue;
    }

    if (matchType === 'ID') matched++; else nameMatched++;

    const cfg = {
      userId: target.userId,
      companyId,
      name: e.name,
      effectiveFrom: '2020-01-01', // 기존 row와 동일
      baseSalary: e.baseSalary,
      fixedOvertimePay: e.fixedOvertimePay,
      fixedHolidayPay: e.fixedHolidayPay,
      mealAllowance: e.mealAllowance,
      transportAllowance: e.transportAllowance,
      teamLeaderAllowance: e.teamLeaderAllowance,
      workingHours: e.workingHours,
      fixedOvertimeHours: e.fixedOvertimeHours,
      fixedHolidayHours: e.fixedHolidayHours,
      dependents: e.dependents,
      childrenCount: e.childrenCount,
      incomeTaxType: e.incomeTaxType,
      pensionOpt: e.pensionOpt || 'O',
      pensionBasisManual: e.pensionBasisManual,
      healthOpt: e.healthOpt || 'O',
      healthBasisManual: e.healthBasisManual,
      ltcOpt: e.ltcOpt || 'O',
      employmentOpt: e.employmentOpt || 'O',
      bankName: e.bankName,
      bankAccount: e.bankAccount,
      email: e.email,
    };

    if (!DRY) {
      try {
        salaryDb.configs.upsert(cfg);
      } catch (err) {
        log(`  ❌ upsert 실패 ${e.sabun} ${e.name}: ${err.message}`);
        continue;
      }
    }

    const n = (v) => String(v || 0).padStart(10);
    log(`    ${matchType.padEnd(11)} ${e.sabun.padEnd(8)} ${e.name.padEnd(6)} → ${target.userId.padEnd(24)} base=${n(e.baseSalary)} meal=${n(e.mealAllowance)} trans=${n(e.transportAllowance)}`);
  }

  log(`\n  요약: ID매치 ${matched}, 이름매치 ${nameMatched}, 실패 ${unmatched} / 전체 ${employees.length}`);
}

// ── 메인 ────────────────────────────────────────────────────────────────
(async () => {
  log('='.repeat(60));
  log(`  salary_configs 재생성 (${DRY ? 'DRY RUN' : '실제 반영'})`);
  log('='.repeat(60));

  backupDb();

  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  const salaryDb = require('./db-salary');

  try {
    await processCompany(db, salaryDb, 'dalim-sm', '대림에스엠', XLSM_SM);
    await processCompany(db, salaryDb, 'dalim-company', '대림컴퍼니', XLSM_CO);
  } finally {
    db.close();
  }

  log('\n' + '='.repeat(60));
  if (DRY) log('  DRY RUN 완료 — 실제 반영은 --dry-run 빼고 다시 실행');
  else log('  ✅ configs 반영 완료! 이제 _redistribute-records.js 실행');
  log('='.repeat(60));
})().catch(e => { console.error(e); process.exit(1); });
