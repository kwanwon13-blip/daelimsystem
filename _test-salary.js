// ============================================================
// 급여계산 검증 스크립트 (Wave 1 정확도 점검용)
// ------------------------------------------------------------
// 사용법:  node _test-salary.js
// (price-list-app 디렉토리에서 실행)
// ============================================================
//
// 엑셀 급여관리기와 동일한 입력을 주고 서버의 calcSalary가
// 같은 값을 내는지 콘솔에 한 줄씩 비교 출력합니다.
// ============================================================

process.env.SALARY_DB = require('path').join(require('os').tmpdir(), 'salary-verify.db');
const fs = require('fs');
try { fs.unlinkSync(process.env.SALARY_DB); } catch(e) {}

const salaryDb = require('./db-salary');

const config = {
  userId: 'TEST001', companyId: 'test', name: '테스트',
  baseSalary: 2500000, fixedOvertimePay: 0, fixedHolidayPay: 0,
  mealAllowance: 200000, transportAllowance: 0, teamLeaderAllowance: 0,
  workingHours: 209, incomeTaxType: '근로소득 100%',
  dependents: 1, childrenCount: 0,
  pensionOpt: 'O', healthOpt: 'O', ltcOpt: 'O', employmentOpt: 'O',
  pensionReductionPct: 0, healthReductionPct: 0, ltcReductionPct: 0,
  employmentReductionPct: 0, incomeReductionPct: 100,
  healthBasisManual: 0, pensionBasisManual: 0,
};
const settings = {
  pensionRate: 4.5, pensionMax: 6370000, pensionMin: 400000,
  healthRate: 3.595, ltcRate: 13.14, employmentRate: 0.9,
  overtimeMultiple: 1.5, nightMultiple: 0.5,
  roundingUnit: '십단위',
  periodType: 'monthly', prorateMode: 'base_plus_allow', prorateDenom: 'period_ratio',
};

const fmt = n => (n || 0).toLocaleString() + ' 원';

// 1) 기본 검증
const result = salaryDb.calcSalary({
  config, settingsRow: settings, overtimeData: null,
  yearMonth: '2026-04', extraItems: {}, labels: {}, prorate: null,
});

console.log('─────────────────────────────────────────────────');
console.log('  급여 계산 검증  (기본급 2,500,000 + 식대 200,000)');
console.log('─────────────────────────────────────────────────');
console.log('과세합계      :', fmt(result.taxableTotal),     '  (예상: 2,500,000)');
console.log('비과세합계    :', fmt(result.nonTaxableTotal),  '  (예상:   200,000)');
console.log('지급합계      :', fmt(result.grossPay),         '  (예상: 2,700,000)');
console.log('─────────────────────────────────────────────────');
console.log('국민연금      :', fmt(result.nationalPension),  '  (엑셀: 약 112,500)');
console.log('건강보험      :', fmt(result.healthInsurance),  '  (엑셀: 약 44,930)');
console.log('장기요양      :', fmt(result.longTermCare),     '  (엑셀: 약  5,900)');
console.log('고용보험      :', fmt(result.employmentInsurance), '  (엑셀: 약 22,500)');
console.log('소득세        :', fmt(result.incomeTax),        '  (간이세액표 VLOOKUP)');
console.log('지방소득세    :', fmt(result.localTax),         '  (소득세 × 10%)');
console.log('─────────────────────────────────────────────────');
console.log('공제합계      :', fmt(result.totalDeductions));
console.log('실지급액      :', fmt(result.netPay));
console.log('─────────────────────────────────────────────────');

// 2) 감면율 검증
console.log('\n[감면율 30% 적용 시 — 국민연금·건강보험만]');
const res2 = salaryDb.calcSalary({
  config: { ...config, pensionReductionPct: 30, healthReductionPct: 30 },
  settingsRow: settings, overtimeData: null,
  yearMonth: '2026-04', extraItems: {}, labels: {}, prorate: null,
});
console.log('국민연금      :', fmt(res2.nationalPension),   '  (감면전 대비 70%)');
console.log('건강보험      :', fmt(res2.healthInsurance),   '  (감면전 대비 70%)');

// 3) 일할계산 검증
console.log('\n[일할계산: 4/15 입사(16/30일) base_plus_allow + period_ratio]');
const prorate = { ratio: 16/30, activeDays: 16, totalDays: 30, periodStart: '2026-04-01', periodEnd: '2026-04-30' };
const res3 = salaryDb.calcSalary({
  config, settingsRow: settings, overtimeData: null,
  yearMonth: '2026-04', extraItems: {}, labels: {}, prorate,
});
console.log('지급합계      :', fmt(res3.grossPay),   '  (원래 2,700,000 × 16/30 ≈ 1,440,000)');
console.log('과세합계      :', fmt(res3.taxableTotal));

try { fs.unlinkSync(process.env.SALARY_DB); } catch(e) {}
