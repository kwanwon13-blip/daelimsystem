// ============================================================
// 엑셀 → 웹 ERP 직원 데이터 일괄 import 스크립트 (1회용)
// ------------------------------------------------------------
// 사용법 (로컬 PC Windows, price-list-app 폴더에서):
//
//   node _import-employees.js            ← 실제 반영
//   node _import-employees.js --dry-run  ← 미리보기(DB 변경 X)
//
// 하는 일:
//   1) data/import/employees_daelim-sm.json         (대림에스엠 46명)
//   2) data/import/employees_daelim-company.json    (대림컴퍼니 8명)
//   → 조직관리.json에 직원 추가/매칭 + salary_configs(급여설정) upsert
//
// 매칭 규칙:
//   · 이름 + 회사 기준으로 조직관리.json 에서 기존 직원 찾음
//   · 있으면 그 user.id 를 userId 로 재사용 (출퇴근/연장근무 연결 유지)
//   · 없으면 새 직원 생성 (status=approved / 퇴사일 있으면 resigned)
//   · 부서가 없으면 조직관리.json departments 에 자동 추가
// ============================================================

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DRY = process.argv.includes('--dry-run');

// ── 경로 ──────────────────────────────────────────────────────────────
const DATA_DIR = path.join(__dirname, 'data');
const ORG_FILE = path.join(DATA_DIR, '조직관리.json');
const IMPORT_DIR = path.join(DATA_DIR, 'import');

// ── 유틸 ──────────────────────────────────────────────────────────────
const now = () => new Date().toISOString();
const rndId = (prefix) => `${prefix}_${Date.now()}_${crypto.randomBytes(3).toString('hex')}`;
function backup(p) {
  if (!fs.existsSync(p)) return;
  const tag = new Date().toISOString().replace(/[-:T]/g,'').slice(0,14);
  const dst = p + `.bak_import_${tag}`;
  fs.copyFileSync(p, dst);
  console.log(`  💾 백업: ${path.basename(dst)}`);
}

// 부서 이름 정규화 (엑셀 오타 보정)
const DEPT_FIX = { '영엽관리팀': '영업관리팀' };
const normDept = (n) => DEPT_FIX[n] || n;

// ── 조직관리.json 로드 ───────────────────────────────────────────────
if (!fs.existsSync(ORG_FILE)) {
  console.error('❌ 조직관리.json 이 없습니다:', ORG_FILE);
  process.exit(1);
}
const org = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8'));
org.users = org.users || [];
org.departments = org.departments || [];
org.companies = org.companies || [];

// ── DB 연결 (better-sqlite3) ─────────────────────────────────────────
let salaryDb;
try {
  salaryDb = require('./db-salary');
} catch (e) {
  console.error('❌ db-salary 로드 실패:', e.message);
  console.error('   price-list-app 폴더에서 실행하세요: cd price-list-app && node _import-employees.js');
  process.exit(1);
}

// ── 부서 upsert (회사별) ─────────────────────────────────────────────
function ensureDept(name, companyId) {
  const norm = normDept(name);
  if (!norm) return null;
  let dept = org.departments.find(d => d.name === norm && d.companyId === companyId);
  if (dept) return dept.id;
  const id = rndId('dept');
  dept = { id, name: norm, companyId };
  org.departments.push(dept);
  console.log(`    ➕ 부서 신규: [${companyId}] ${norm}`);
  return id;
}

// ── 회사 1개 import ──────────────────────────────────────────────────
function importCompany(jsonFile, companyId, companyLabel) {
  const p = path.join(IMPORT_DIR, jsonFile);
  if (!fs.existsSync(p)) {
    console.warn(`⚠️  ${jsonFile} 파일 없음 — 건너뜀`);
    return { matched: 0, created: 0, resignedCount: 0, total: 0 };
  }
  const arr = JSON.parse(fs.readFileSync(p, 'utf8'));

  console.log(`\n─────────────────────────────────────────────────`);
  console.log(`  ${companyLabel}  [${companyId}]  —  ${arr.length}명`);
  console.log(`─────────────────────────────────────────────────`);

  let matched = 0, created = 0, resignedCount = 0;

  for (const e of arr) {
    const name = (e.name || '').trim();
    if (!name) { console.warn('  (이름 공란 row 건너뜀)'); continue; }

    // 1) 부서 ID
    const deptId = ensureDept(e.dept, companyId);

    // 2) 기존 조직관리 user 찾기 (이름 + 회사)
    let user = org.users.find(u => (u.name || '').trim() === name && u.companyId === companyId);
    const isResigned = !!e.resignDate;

    if (user) {
      matched++;
      // 기존 값 비어 있을 때만 채움 (엑셀이 마스터가 아닌 보조자료라고 가정)
      if (!user.department && deptId) user.department = deptId;
      if (!user.hireDate && e.hireDate) user.hireDate = e.hireDate;
      if (!user.resignDate && e.resignDate) user.resignDate = e.resignDate;
      if (!user.birthDate && e.birthDate) user.birthDate = e.birthDate;
      if (isResigned && user.status !== 'resigned') user.status = 'resigned';
    } else {
      // 신규 생성
      user = {
        id: rndId('u'),
        userId: name,                     // 로그인ID는 일단 이름(한글)
        name,
        password: '',                     // 최초 로그인 전에 관리자 초기비번 설정 필요
        role: 'user',
        status: isResigned ? 'resigned' : 'approved',
        createdAt: now(),
        lastLogin: null,
        department: deptId,
        capsName: name,
        salaryPin: null,
        companyId,
        hireDate: e.hireDate || null,
        resignDate: e.resignDate || null,
        birthDate: e.birthDate || null,
      };
      org.users.push(user);
      created++;
    }
    if (isResigned) resignedCount++;

    // 3) salary_configs upsert
    const cfg = {
      userId: user.id,                     // ※ 조직관리 user.id 를 salary userId 로
      companyId,
      name,
      baseSalary: e.baseSalary || 0,
      fixedOvertimePay: e.fixedOvertimePay || 0,
      fixedHolidayPay: e.fixedHolidayPay || 0,
      mealAllowance: e.mealAllowance || 0,
      transportAllowance: e.transportAllowance || 0,
      teamLeaderAllowance: e.teamLeaderAllowance || 0,
      workingHours: e.workingHours || 209,
      fixedOvertimeHours: e.fixedOvertimeH || 0,
      fixedHolidayHours: e.fixedHolidayH || 0,
      dependents: e.dependents || 1,
      childrenCount: e.childrenCount || 0,
      incomeTaxType: e.incomeTaxType || '근로소득 100%',
      pensionOpt: e.pensionOpt || 'O',
      pensionBasisManual: e.pensionBasisManual || 0,
      healthOpt: e.healthOpt || 'O',
      healthBasisManual: e.healthBasisManual || 0,
      ltcOpt: e.ltcOpt || 'O',
      employmentOpt: e.employmentOpt || 'O',
      bankName: e.bankName || '',
      bankAccount: e.bankAccount || '',
      email: e.email || '',
      // 감면율은 엑셀에 없으므로 0 유지
      pensionReductionPct: 0,
      healthReductionPct: 0,
      ltcReductionPct: 0,
      employmentReductionPct: 0,
      incomeReductionPct: 100,   // 소득세 100% (기본)
    };

    if (!DRY) {
      salaryDb.configs.upsert(cfg);
    }

    const statusMark = isResigned ? '🔴' : '🟢';
    const mark = e.resignDate ? `퇴사 ${e.resignDate}` : '재직';
    const n = (v) => (v||0).toLocaleString();
    const boolMark = (v) => v === 'O' ? '○' : (v === 'X' ? '×' : '-');

    // 1줄차: 이름/부서/재직상태/입사일
    console.log(`    ${statusMark} ${name.padEnd(6)} ${(e.dept||'-').padEnd(7)} ${mark.padEnd(15)} 입사 ${e.hireDate||'-'}`);
    // 2줄차: 지급 항목 전부
    console.log(`         지급  기본급 ${n(e.baseSalary).padStart(10)}  고정연장 ${n(e.fixedOvertimePay).padStart(8)}  고정휴일 ${n(e.fixedHolidayPay).padStart(8)}  식대 ${n(e.mealAllowance).padStart(7)}  차량 ${n(e.transportAllowance).padStart(7)}  팀장 ${n(e.teamLeaderAllowance).padStart(7)}`);
    // 3줄차: 4대보험 가입여부 + 기준액 + 부양/자녀 + 소득세유형
    console.log(`         보험  연금${boolMark(e.pensionOpt)} 건강${boolMark(e.healthOpt)} 장기${boolMark(e.ltcOpt)} 고용${boolMark(e.employmentOpt)}   연금기준 ${n(e.pensionBasisManual).padStart(10)}  건강기준 ${n(e.healthBasisManual).padStart(10)}   부양 ${e.dependents||1}  자녀 ${e.childrenCount||0}   ${e.incomeTaxType||'-'}`);
    // 4줄차: 근로시간
    console.log(`         근로  소정 ${(e.workingHours||209)}h   고정연장 ${e.fixedOvertimeH||0}h   고정휴일 ${e.fixedHolidayH||0}h`);
  }

  return { matched, created, resignedCount, total: arr.length };
}

// ── 실행 ─────────────────────────────────────────────────────────────
console.log('='.repeat(60));
console.log(`  엑셀 → 웹 ERP 직원 데이터 import  (${DRY ? 'DRY RUN — 미리보기' : '실제 반영'})`);
console.log('='.repeat(60));

if (!DRY) backup(ORG_FILE);

const sm  = importCompany('employees_daelim-sm.json',      'dalim-sm',      '대림에스엠');
const co  = importCompany('employees_daelim-company.json', 'dalim-company', '대림컴퍼니');

// 조직관리.json 저장
if (!DRY) {
  fs.writeFileSync(ORG_FILE, JSON.stringify(org, null, 2), 'utf8');
  console.log(`\n  💾 조직관리.json 저장됨`);
} else {
  console.log(`\n  (DRY RUN — 조직관리.json 변경 없음)`);
}

// ── 요약 ─────────────────────────────────────────────────────────────
console.log('\n' + '='.repeat(60));
console.log('  요약');
console.log('='.repeat(60));
const fmt = (v) => String(v).padStart(3);
console.log(`  대림에스엠  —  총 ${fmt(sm.total)}명  (기존매칭 ${fmt(sm.matched)}  신규 ${fmt(sm.created)}  퇴사자 ${fmt(sm.resignedCount)})`);
console.log(`  대림컴퍼니  —  총 ${fmt(co.total)}명  (기존매칭 ${fmt(co.matched)}  신규 ${fmt(co.created)}  퇴사자 ${fmt(co.resignedCount)})`);
console.log(`  합계        —  총 ${fmt(sm.total+co.total)}명  (기존매칭 ${fmt(sm.matched+co.matched)}  신규 ${fmt(sm.created+co.created)}  퇴사자 ${fmt(sm.resignedCount+co.resignedCount)})`);
console.log('='.repeat(60));

if (DRY) {
  console.log('\n⚠️  DRY RUN 모드로 실행됨 — 실제로 반영하려면 --dry-run 빼고 다시 실행하세요.');
} else {
  console.log('\n✅ 완료! 브라우저에서 새로고침하면 기본급/식대/부양가족이 엑셀 값대로 보입니다.');
  console.log('   (이상이 있으면 data/조직관리.json.bak_import_* 백업에서 복구 가능)');
}
