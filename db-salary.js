/**
 * db-salary.js — 급여 관리 SQLite 모듈
 *
 * 테이블:
 *   salary_settings      — 4대보험 요율 설정 (회사별)
 *   salary_configs       — 직원별 급여 기초 설정
 *   salary_records       — 월별 급여 명세 (지급/공제 전체)
 *   salary_item_labels   — 자유 항목명 (월별)
 *   salary_edi_records   — EDI 공단 고지값
 *   salary_issuances     — 급여명세서 발급대장
 *   income_tax_table     — 근로소득 간이세액표
 *
 * 보안:
 *   계좌번호는 AES-256-GCM 암호화 저장
 *   requireSalaryAccess 미들웨어로 접근 제어 (별도)
 */

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const DB_PATH = path.join(__dirname, 'data', '급여관리.db');
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── 암호화 키 관리 ─────────────────────────────────────────────────────────────
// AES-256-GCM 키를 파일에 저장 (최초 실행 시 생성)
const KEY_PATH = path.join(__dirname, 'data', '.salary_key');
let ENCRYPTION_KEY;
if (fs.existsSync(KEY_PATH)) {
  ENCRYPTION_KEY = fs.readFileSync(KEY_PATH);
} else {
  ENCRYPTION_KEY = crypto.randomBytes(32);
  fs.writeFileSync(KEY_PATH, ENCRYPTION_KEY, { mode: 0o600 });
}

function encrypt(text) {
  if (!text) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
  const enc = Buffer.concat([cipher.update(String(text), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc.toString('hex');
}

function decrypt(data) {
  if (!data) return null;
  try {
    const [ivHex, tagHex, encHex] = data.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const enc = Buffer.from(encHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', ENCRYPTION_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
  } catch (e) {
    return null;
  }
}

// ── 테이블 생성 ────────────────────────────────────────────────────────────────
db.exec(`
  -- 4대보험 요율 설정 (회사별)
  CREATE TABLE IF NOT EXISTS salary_settings (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    companyId TEXT NOT NULL,
    effectiveFrom TEXT NOT NULL,
    pensionRate REAL DEFAULT 4.5,
    pensionMax INTEGER DEFAULT 6370000,
    pensionMin INTEGER DEFAULT 400000,
    healthRate REAL DEFAULT 3.595,
    healthMax INTEGER DEFAULT 110332300,
    healthMin INTEGER DEFAULT 279266,
    ltcRate REAL DEFAULT 13.14,
    employmentRate REAL DEFAULT 0.9,
    overtimeMultiple REAL DEFAULT 1.5,
    nightMultiple REAL DEFAULT 0.5,
    holidayMultiple REAL DEFAULT 1.5,
    holidayOtMultiple REAL DEFAULT 2.0,
    roundingUnit TEXT DEFAULT '십단위',
    createdAt TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(companyId, effectiveFrom)
  );

  -- 직원별 급여 기초 설정
  CREATE TABLE IF NOT EXISTS salary_configs (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    userId TEXT NOT NULL,
    companyId TEXT NOT NULL,
    baseSalary INTEGER DEFAULT 0,
    fixedOvertimePay INTEGER DEFAULT 0,
    fixedHolidayPay INTEGER DEFAULT 0,
    mealAllowance INTEGER DEFAULT 0,
    transportAllowance INTEGER DEFAULT 0,
    teamLeaderAllowance INTEGER DEFAULT 0,
    normalWage INTEGER DEFAULT 0,
    workingHours REAL DEFAULT 209,
    hourlyRate REAL DEFAULT 0,
    fixedOvertimeHours REAL DEFAULT 0,
    fixedHolidayHours REAL DEFAULT 0,
    dependents INTEGER DEFAULT 1,
    childrenCount INTEGER DEFAULT 0,
    incomeTaxType TEXT DEFAULT '근로소득 100%',
    pensionOpt TEXT DEFAULT 'O',
    pensionBasisManual INTEGER,
    healthOpt TEXT DEFAULT 'O',
    healthBasisManual INTEGER,
    ltcOpt TEXT DEFAULT 'O',
    employmentOpt TEXT DEFAULT 'O',
    bankName TEXT,
    bankAccountEnc TEXT,
    email TEXT,
    effectiveFrom TEXT DEFAULT '2020-01-01',
    createdAt TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(userId, companyId, effectiveFrom)
  );

  -- 월별 급여 명세 (지급+공제)
  CREATE TABLE IF NOT EXISTS salary_records (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    userId TEXT NOT NULL,
    companyId TEXT NOT NULL,
    yearMonth TEXT NOT NULL,
    payDate TEXT,
    workDays INTEGER DEFAULT 0,
    workHours REAL DEFAULT 209,
    -- 지급
    baseSalary INTEGER DEFAULT 0,
    prorateDays INTEGER DEFAULT 0,
    prorateAmount INTEGER DEFAULT 0,
    overtimeHours REAL DEFAULT 0,
    overtimePay INTEGER DEFAULT 0,
    nightHours REAL DEFAULT 0,
    nightPay INTEGER DEFAULT 0,
    holidayHours REAL DEFAULT 0,
    holidayPay INTEGER DEFAULT 0,
    holidayOtHours REAL DEFAULT 0,
    holidayOtPay INTEGER DEFAULT 0,
    fixedOvertimePay INTEGER DEFAULT 0,
    fixedHolidayPay INTEGER DEFAULT 0,
    mealAllowance INTEGER DEFAULT 0,
    transportAllowance INTEGER DEFAULT 0,
    teamLeaderAllowance INTEGER DEFAULT 0,
    bonusPay INTEGER DEFAULT 0,
    retroPay INTEGER DEFAULT 0,
    leavePay INTEGER DEFAULT 0,
    extraPay1 INTEGER DEFAULT 0,
    extraPay2 INTEGER DEFAULT 0,
    extraPay3 INTEGER DEFAULT 0,
    taxableTotal INTEGER DEFAULT 0,
    nonTaxableTotal INTEGER DEFAULT 0,
    grossPay INTEGER DEFAULT 0,
    -- 공제
    nationalPension INTEGER DEFAULT 0,
    healthInsurance INTEGER DEFAULT 0,
    longTermCare INTEGER DEFAULT 0,
    employmentInsurance INTEGER DEFAULT 0,
    incomeTax INTEGER DEFAULT 0,
    localTax INTEGER DEFAULT 0,
    incomeTaxAdj INTEGER DEFAULT 0,
    localTaxAdj INTEGER DEFAULT 0,
    healthAnnual INTEGER DEFAULT 0,
    ltcAnnual INTEGER DEFAULT 0,
    healthInstallment INTEGER DEFAULT 0,
    ltcInstallment INTEGER DEFAULT 0,
    healthAprExtra INTEGER DEFAULT 0,
    ltcAprExtra INTEGER DEFAULT 0,
    healthRefundInterest INTEGER DEFAULT 0,
    ltcRefundInterest INTEGER DEFAULT 0,
    miscDeduction1 INTEGER DEFAULT 0,
    miscDeduction2 INTEGER DEFAULT 0,
    extraDeduction1 INTEGER DEFAULT 0,
    extraDeduction2 INTEGER DEFAULT 0,
    extraDeduction3 INTEGER DEFAULT 0,
    totalDeductions INTEGER DEFAULT 0,
    netPay INTEGER DEFAULT 0,
    -- 상태
    status TEXT DEFAULT 'draft',
    confirmedAt TEXT,
    confirmedBy TEXT,
    paidAt TEXT,
    note TEXT,
    createdAt TEXT DEFAULT (datetime('now','localtime')),
    updatedAt TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(userId, companyId, yearMonth)
  );

  -- 자유 항목명 (월별)
  CREATE TABLE IF NOT EXISTS salary_item_labels (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    companyId TEXT NOT NULL,
    yearMonth TEXT NOT NULL,
    extraPay1Name TEXT DEFAULT '',
    extraPay2Name TEXT DEFAULT '',
    extraPay3Name TEXT DEFAULT '',
    extraDeduction1Name TEXT DEFAULT '',
    extraDeduction2Name TEXT DEFAULT '',
    extraDeduction3Name TEXT DEFAULT '',
    UNIQUE(companyId, yearMonth)
  );

  -- EDI 신고 보험료
  CREATE TABLE IF NOT EXISTS salary_edi_records (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    userId TEXT NOT NULL,
    companyId TEXT NOT NULL,
    yearMonth TEXT NOT NULL,
    healthBasis INTEGER DEFAULT 0,
    healthCalc INTEGER DEFAULT 0,
    healthBilled INTEGER DEFAULT 0,
    healthAnnual INTEGER DEFAULT 0,
    ltcCalc INTEGER DEFAULT 0,
    ltcBilled INTEGER DEFAULT 0,
    ltcAnnual INTEGER DEFAULT 0,
    healthRefundInterest INTEGER DEFAULT 0,
    ltcRefundInterest INTEGER DEFAULT 0,
    totalBilled INTEGER DEFAULT 0,
    pensionBilled INTEGER DEFAULT 0,
    employmentBilled INTEGER DEFAULT 0,
    source TEXT DEFAULT 'manual',
    memo TEXT,
    uploadedAt TEXT DEFAULT (datetime('now','localtime')),
    uploadedBy TEXT,
    UNIQUE(userId, companyId, yearMonth)
  );

  -- 급여명세서 발급대장
  CREATE TABLE IF NOT EXISTS salary_issuances (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    yearMonth TEXT NOT NULL,
    userId TEXT NOT NULL,
    companyId TEXT NOT NULL,
    issuedAt TEXT DEFAULT (datetime('now','localtime')),
    issuedType TEXT,
    recipient TEXT,
    issuedBy TEXT,
    filePath TEXT
  );

  -- 근로소득 간이세액표
  CREATE TABLE IF NOT EXISTS income_tax_table (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    year INTEGER NOT NULL,
    salaryFrom INTEGER NOT NULL,
    salaryTo INTEGER NOT NULL,
    dep1 INTEGER DEFAULT 0,
    dep2 INTEGER DEFAULT 0,
    dep3 INTEGER DEFAULT 0,
    dep4 INTEGER DEFAULT 0,
    dep5 INTEGER DEFAULT 0,
    dep6 INTEGER DEFAULT 0,
    dep7 INTEGER DEFAULT 0,
    dep8 INTEGER DEFAULT 0,
    dep9 INTEGER DEFAULT 0,
    dep10 INTEGER DEFAULT 0,
    dep11 INTEGER DEFAULT 0,
    UNIQUE(year, salaryFrom)
  );

  -- 연장근무 입력 (월별/직원별)
  CREATE TABLE IF NOT EXISTS salary_overtime (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(8)))),
    userId TEXT NOT NULL,
    companyId TEXT NOT NULL,
    yearMonth TEXT NOT NULL,
    workDate TEXT,           -- 근무일 (YYYY-MM-DD), 날짜별 입력 시
    overtimeH REAL DEFAULT 0,
    nightH REAL DEFAULT 0,
    holidayH REAL DEFAULT 0,
    holidayOtH REAL DEFAULT 0,
    memo TEXT,
    updatedAt TEXT DEFAULT (datetime('now','localtime')),
    UNIQUE(userId, companyId, yearMonth, workDate)
  );

  -- 인덱스
  CREATE INDEX IF NOT EXISTS idx_salary_records_month ON salary_records(companyId, yearMonth);
  CREATE INDEX IF NOT EXISTS idx_salary_records_user ON salary_records(userId, yearMonth);
  CREATE INDEX IF NOT EXISTS idx_salary_configs_user ON salary_configs(userId, companyId);
  CREATE INDEX IF NOT EXISTS idx_salary_edi_month ON salary_edi_records(companyId, yearMonth);
  CREATE INDEX IF NOT EXISTS idx_income_tax_year ON income_tax_table(year, salaryFrom);
  CREATE INDEX IF NOT EXISTS idx_salary_overtime_month ON salary_overtime(companyId, yearMonth);
`);

// ── 스키마 마이그레이션 ──────────────────────────────────────────────────────────
// salary_configs에 name 컬럼이 없으면 추가 (기존 DB 호환)
try { db.prepare('ALTER TABLE salary_configs ADD COLUMN name TEXT').run(); } catch(e) {}

// 2026-04-17: 지급/공제 슬롯 확장 (3 → 8) + 라벨/노출 토글
// salary_records: extraPay4~8 + extraDeduction4~8
for (let i = 4; i <= 8; i++) {
  try { db.prepare(`ALTER TABLE salary_records ADD COLUMN extraPay${i} INTEGER DEFAULT 0`).run(); } catch(e) {}
  try { db.prepare(`ALTER TABLE salary_records ADD COLUMN extraDeduction${i} INTEGER DEFAULT 0`).run(); } catch(e) {}
}
// salary_item_labels: 이름 슬롯 확장 + visibility JSON
for (let i = 4; i <= 8; i++) {
  try { db.prepare(`ALTER TABLE salary_item_labels ADD COLUMN extraPay${i}Name TEXT DEFAULT ''`).run(); } catch(e) {}
  try { db.prepare(`ALTER TABLE salary_item_labels ADD COLUMN extraDeduction${i}Name TEXT DEFAULT ''`).run(); } catch(e) {}
}
// visibility: JSON 문자열. 예: {"extraPay1":true,"extraPay2":false,...,"extraDeduction1":true,...}
// 기본값은 빈 객체("{}") — 프론트에서 "이름이 있으면 노출"로 fallback 처리
try { db.prepare(`ALTER TABLE salary_item_labels ADD COLUMN visibility TEXT DEFAULT '{}'`).run(); } catch(e) {}

// 2026-04-17: CAPS 출퇴근 메타 (연차/결근/지각 카운터) — 급여대장 엑셀 구조와 맞춤
try { db.prepare(`ALTER TABLE salary_records ADD COLUMN annualDays REAL DEFAULT 0`).run(); } catch(e) {}
try { db.prepare(`ALTER TABLE salary_records ADD COLUMN absentDays REAL DEFAULT 0`).run(); } catch(e) {}
try { db.prepare(`ALTER TABLE salary_records ADD COLUMN lateCount INTEGER DEFAULT 0`).run(); } catch(e) {}

// ── 2026-04-17 (Wave 1): 엑셀 VBA 급여 공식 정밀 대응 스키마 ────────────────────
// 감면율 (각 4대보험/소득세별로 0~80%, 엑셀의 opt≥5 감면 옵션)
try { db.prepare(`ALTER TABLE salary_configs ADD COLUMN pensionReductionPct REAL DEFAULT 0`).run(); } catch(e) {}
try { db.prepare(`ALTER TABLE salary_configs ADD COLUMN healthReductionPct REAL DEFAULT 0`).run(); } catch(e) {}
try { db.prepare(`ALTER TABLE salary_configs ADD COLUMN ltcReductionPct REAL DEFAULT 0`).run(); } catch(e) {}
try { db.prepare(`ALTER TABLE salary_configs ADD COLUMN employmentReductionPct REAL DEFAULT 0`).run(); } catch(e) {}
try { db.prepare(`ALTER TABLE salary_configs ADD COLUMN incomeReductionPct REAL DEFAULT 0`).run(); } catch(e) {}

// 회사 단위 일할계산 옵션 (엑셀 급여계산설정!F15/F16)
// prorateMode: 'base_only'(1) / 'base_plus_allow'(2) / 'allow_only'(3) — 어떤 항목을 안분할지
// prorateDenom: 'period_ratio'(1) / 'thirty_days'(2) / 'hourly_x_eight'(3) — 안분 분모
try { db.prepare(`ALTER TABLE salary_settings ADD COLUMN prorateMode TEXT DEFAULT 'base_plus_allow'`).run(); } catch(e) {}
try { db.prepare(`ALTER TABLE salary_settings ADD COLUMN prorateDenom TEXT DEFAULT 'period_ratio'`).run(); } catch(e) {}
// 정산기간 타입 (엑셀 F11): 'monthly'(당월1~말일) / 'prev20_curr19'(전월20~당월19)
try { db.prepare(`ALTER TABLE salary_settings ADD COLUMN periodType TEXT DEFAULT 'monthly'`).run(); } catch(e) {}

// ── 기본 설정 초기화 ───────────────────────────────────────────────────────────
// 기본 4대보험 요율 없으면 초기 삽입
['dalim-sm', 'dalim-company'].forEach(companyId => {
  const existing = db.prepare('SELECT id FROM salary_settings WHERE companyId=? LIMIT 1').get(companyId);
  if (!existing) {
    db.prepare(`
      INSERT INTO salary_settings (companyId, effectiveFrom, pensionRate, pensionMax, pensionMin,
        healthRate, healthMax, healthMin, ltcRate, employmentRate)
      VALUES (?,?,4.5,6370000,400000,3.595,110332300,279266,13.14,0.9)
    `).run(companyId, '2026-01-01');
    console.log(`✅ salary_settings 기본값 생성: ${companyId}`);
  }
});

// ── 2026-04-17 (Wave 1): 근로소득간이세액표 자동 시드 ─────────────────────────
// 엑셀 근로소득간이세액표 시트에서 뽑은 2026년 데이터를 최초 1회 import
// 파일: data/income_tax_2026.json (엑셀 추출 포맷: [[from, to, dep1..dep11], ...])
try {
  const ITAX_2026_PATH = path.join(__dirname, 'data', 'income_tax_2026.json');
  const existing2026 = db.prepare('SELECT COUNT(*) AS n FROM income_tax_table WHERE year=?').get(2026);
  if ((existing2026?.n || 0) === 0 && fs.existsSync(ITAX_2026_PATH)) {
    const rows = JSON.parse(fs.readFileSync(ITAX_2026_PATH, 'utf8'));
    const stmt = db.prepare(`INSERT INTO income_tax_table
      (year, salaryFrom, salaryTo, dep1, dep2, dep3, dep4, dep5, dep6, dep7, dep8, dep9, dep10, dep11)
      VALUES (2026, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const txn = db.transaction(() => {
      for (const r of rows) stmt.run(...r);
    });
    txn();
    console.log(`✅ income_tax_table 2026 시드: ${rows.length}행`);
  }
} catch (e) {
  console.warn('⚠️  간이세액표 자동 시드 실패:', e.message);
}

// ── salary_settings CRUD ───────────────────────────────────────────────────────
const settings = {
  get(companyId) {
    return db.prepare('SELECT * FROM salary_settings WHERE companyId=? ORDER BY effectiveFrom DESC LIMIT 1').get(companyId);
  },
  getAll(companyId) {
    return db.prepare('SELECT * FROM salary_settings WHERE companyId=? ORDER BY effectiveFrom DESC').all(companyId);
  },
  upsert(companyId, effectiveFrom, data) {
    const cols = ['pensionRate','pensionMax','pensionMin','healthRate','healthMax','healthMin',
      'ltcRate','employmentRate','overtimeMultiple','nightMultiple','holidayMultiple','holidayOtMultiple','roundingUnit',
      'prorateMode','prorateDenom','periodType'];
    const existing = db.prepare('SELECT id FROM salary_settings WHERE companyId=? AND effectiveFrom=?').get(companyId, effectiveFrom);
    if (existing) {
      const sets = cols.filter(c => data[c] !== undefined).map(c => `${c}=@${c}`).join(',');
      db.prepare(`UPDATE salary_settings SET ${sets} WHERE companyId=@companyId AND effectiveFrom=@effectiveFrom`)
        .run({ ...data, companyId, effectiveFrom });
    } else {
      const fields = ['companyId','effectiveFrom', ...cols.filter(c => data[c] !== undefined)];
      const vals = fields.map(f => `@${f}`).join(',');
      db.prepare(`INSERT INTO salary_settings (${fields.join(',')}) VALUES (${vals})`)
        .run({ companyId, effectiveFrom, ...data });
    }
    return this.get(companyId);
  }
};

// ── salary_configs CRUD ────────────────────────────────────────────────────────
const configs = {
  getAll(companyId) {
    const rows = db.prepare('SELECT * FROM salary_configs WHERE companyId=? ORDER BY userId').all(companyId);
    return rows.map(r => ({ ...r, bankAccount: decrypt(r.bankAccountEnc), bankAccountEnc: undefined }));
  },
  get(userId, companyId) {
    const r = db.prepare('SELECT * FROM salary_configs WHERE userId=? AND companyId=? ORDER BY effectiveFrom DESC LIMIT 1').get(userId, companyId);
    if (!r) return null;
    return { ...r, bankAccount: decrypt(r.bankAccountEnc), bankAccountEnc: undefined };
  },
  upsert(data) {
    const { userId, companyId, bankAccount, effectiveFrom = '2020-01-01' } = data;
    const bankAccountEnc = encrypt(bankAccount);
    // ── 통상임금 / 통상시급 (엑셀 사원정보 I/AC열 공식) ─────────────────────────
    // 통상임금 = 기본급 + 고정연장수당 + 고정휴일수당 + 식대 + 차량유지비 + 팀장수당
    // 통상시급 = 통상임금 ÷ (월소정근로시간 + 고정연장시간 × 1.5 + 고정휴일시간 × 1.5)
    //   — 고정수당에 대한 "가산된" 시간을 분모에 포함해야 실제 시급이 나옴
    const normalWage =
      (+data.baseSalary || 0) +
      (+data.fixedOvertimePay || 0) +
      (+data.fixedHolidayPay || 0) +
      (+data.mealAllowance || 0) +
      (+data.transportAllowance || 0) +
      (+data.teamLeaderAllowance || 0);
    const wh = +data.workingHours || 209;
    const fotH = +data.fixedOvertimeHours || 0;
    const fholH = +data.fixedHolidayHours || 0;
    const denomH = wh + fotH * 1.5 + fholH * 1.5;
    const hourlyRate = denomH > 0 ? Math.floor(normalWage / denomH) : 0;
    const existing = db.prepare('SELECT id FROM salary_configs WHERE userId=? AND companyId=? AND effectiveFrom=?').get(userId, companyId, effectiveFrom);
    const fields = [
      'userId','companyId','name','effectiveFrom','baseSalary','fixedOvertimePay','fixedHolidayPay',
      'mealAllowance','transportAllowance','teamLeaderAllowance','normalWage','workingHours','hourlyRate',
      'fixedOvertimeHours','fixedHolidayHours','dependents','childrenCount','incomeTaxType',
      'pensionOpt','pensionBasisManual','healthOpt','healthBasisManual','ltcOpt','employmentOpt',
      'pensionReductionPct','healthReductionPct','ltcReductionPct','employmentReductionPct','incomeReductionPct',
      'bankName','bankAccountEnc','email'
    ];
    const merged = { ...data, normalWage, hourlyRate, bankAccountEnc };
    // name은 null/빈값도 명시적으로 업데이트하도록 강제 포함 (대림컴퍼니 수동 입력 지원)
    if (merged.name === undefined) merged.name = null;
    if (existing) {
      const sets = fields.filter(f => f !== 'userId' && f !== 'companyId' && f !== 'effectiveFrom' && merged[f] !== undefined)
        .map(f => `${f}=@${f}`).join(',');
      db.prepare(`UPDATE salary_configs SET ${sets} WHERE userId=@userId AND companyId=@companyId AND effectiveFrom=@effectiveFrom`)
        .run(merged);
    } else {
      const available = fields.filter(f => merged[f] !== undefined);
      db.prepare(`INSERT INTO salary_configs (${available.join(',')}) VALUES (${available.map(f=>'@'+f).join(',')})`)
        .run(merged);
    }
    return this.get(userId, companyId);
  },
  delete(userId, companyId) {
    db.prepare('DELETE FROM salary_configs WHERE userId=? AND companyId=?').run(userId, companyId);
  }
};

// ── salary_records CRUD ────────────────────────────────────────────────────────
const records = {
  getByMonth(companyId, yearMonth) {
    return db.prepare('SELECT * FROM salary_records WHERE companyId=? AND yearMonth=? ORDER BY userId').all(companyId, yearMonth);
  },
  getOne(userId, companyId, yearMonth) {
    return db.prepare('SELECT * FROM salary_records WHERE userId=? AND companyId=? AND yearMonth=?').get(userId, companyId, yearMonth);
  },
  getById(id) {
    return db.prepare('SELECT * FROM salary_records WHERE id=?').get(id);
  },
  getAnnual(userId, year) {
    return db.prepare("SELECT * FROM salary_records WHERE userId=? AND yearMonth LIKE ? ORDER BY yearMonth").all(userId, `${year}-%`);
  },
  upsert(data) {
    const existing = this.getOne(data.userId, data.companyId, data.yearMonth);
    const now = new Date().toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }).replace(/\. /g,'-').replace(/\./,'').replace(' ','T');
    if (existing) {
      if (existing.status === 'confirmed' || existing.status === 'paid') {
        throw new Error('확정된 급여는 수정할 수 없습니다.');
      }
      const skip = new Set(['id','userId','companyId','yearMonth','status','confirmedAt','confirmedBy','paidAt','createdAt']);
      const sets = Object.keys(data).filter(k => !skip.has(k) && data[k] !== undefined).map(k => `${k}=@${k}`);
      sets.push('updatedAt=@updatedAt');
      db.prepare(`UPDATE salary_records SET ${sets.join(',')} WHERE id=@id`)
        .run({ ...data, id: existing.id, updatedAt: new Date().toISOString() });
      return this.getById(existing.id);
    } else {
      const fields = Object.keys(data).filter(k => k !== 'id' && data[k] !== undefined);
      fields.push('updatedAt');
      db.prepare(`INSERT INTO salary_records (${fields.join(',')}) VALUES (${fields.map(f=>'@'+f).join(',')})`)
        .run({ ...data, updatedAt: new Date().toISOString() });
      return this.getOne(data.userId, data.companyId, data.yearMonth);
    }
  },
  confirm(id, confirmedBy) {
    db.prepare("UPDATE salary_records SET status='confirmed', confirmedAt=datetime('now','localtime'), confirmedBy=? WHERE id=?").run(confirmedBy, id);
    return this.getById(id);
  },
  unconfirm(id) {
    db.prepare("UPDATE salary_records SET status='draft', confirmedAt=NULL, confirmedBy=NULL WHERE id=? AND status='confirmed'").run(id);
    return this.getById(id);
  },
  markPaid(id, payDate) {
    db.prepare("UPDATE salary_records SET status='paid', paidAt=? WHERE id=?").run(payDate || new Date().toISOString(), id);
    return this.getById(id);
  },
  delete(id) {
    const r = this.getById(id);
    if (r && r.status !== 'draft') throw new Error('draft 상태만 삭제 가능합니다.');
    db.prepare('DELETE FROM salary_records WHERE id=?').run(id);
  },
  deleteByMonth(companyId, yearMonth) {
    db.prepare("DELETE FROM salary_records WHERE companyId=? AND yearMonth=? AND status='draft'").run(companyId, yearMonth);
  }
};

// ── salary_item_labels ─────────────────────────────────────────────────────────
// 지급/공제 각 8슬롯 (extraPay1~8, extraDeduction1~8) + visibility(JSON) 관리
const EXTRA_PAY_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8];
const EXTRA_DED_SLOTS = [1, 2, 3, 4, 5, 6, 7, 8];
const LABEL_FIELDS = [
  ...EXTRA_PAY_SLOTS.map(i => `extraPay${i}Name`),
  ...EXTRA_DED_SLOTS.map(i => `extraDeduction${i}Name`),
  'visibility',
];

function emptyLabels(companyId, yearMonth) {
  const obj = { companyId, yearMonth, visibility: '{}' };
  EXTRA_PAY_SLOTS.forEach(i => { obj[`extraPay${i}Name`] = ''; });
  EXTRA_DED_SLOTS.forEach(i => { obj[`extraDeduction${i}Name`] = ''; });
  return obj;
}

const itemLabels = {
  get(companyId, yearMonth) {
    const row = db.prepare('SELECT * FROM salary_item_labels WHERE companyId=? AND yearMonth=?').get(companyId, yearMonth);
    if (!row) return emptyLabels(companyId, yearMonth);
    // visibility는 JSON 파싱해서 객체로 반환 (프론트 편의)
    try { row.visibility = JSON.parse(row.visibility || '{}'); } catch(e) { row.visibility = {}; }
    return row;
  },
  upsert(companyId, yearMonth, data) {
    const existing = db.prepare('SELECT id FROM salary_item_labels WHERE companyId=? AND yearMonth=?').get(companyId, yearMonth);
    // visibility가 객체로 왔으면 JSON 문자열로 직렬화
    const payload = { ...data };
    if (payload.visibility && typeof payload.visibility === 'object') {
      payload.visibility = JSON.stringify(payload.visibility);
    }
    // 입력에 없는 필드는 undefined → SQL에서 기존값 유지 위해 쿼리에서 제외
    const availableFields = LABEL_FIELDS.filter(f => payload[f] !== undefined);
    if (existing) {
      if (availableFields.length > 0) {
        const sets = availableFields.map(f => `${f}=@${f}`).join(',');
        db.prepare(`UPDATE salary_item_labels SET ${sets} WHERE companyId=@companyId AND yearMonth=@yearMonth`)
          .run({ ...payload, companyId, yearMonth });
      }
    } else {
      const cols = ['companyId', 'yearMonth', ...availableFields];
      const vals = cols.map(f => '@' + f).join(',');
      db.prepare(`INSERT INTO salary_item_labels (${cols.join(',')}) VALUES (${vals})`)
        .run({ companyId, yearMonth, ...payload });
    }
    return this.get(companyId, yearMonth);
  }
};

// ── salary_edi_records ─────────────────────────────────────────────────────────
const ediRecords = {
  getByMonth(companyId, yearMonth) {
    return db.prepare('SELECT * FROM salary_edi_records WHERE companyId=? AND yearMonth=? ORDER BY userId').all(companyId, yearMonth);
  },
  upsert(data) {
    const existing = db.prepare('SELECT id FROM salary_edi_records WHERE userId=? AND companyId=? AND yearMonth=?')
      .get(data.userId, data.companyId, data.yearMonth);
    const fields = ['userId','companyId','yearMonth','healthBasis','healthCalc','healthBilled','healthAnnual',
      'ltcCalc','ltcBilled','ltcAnnual','healthRefundInterest','ltcRefundInterest','totalBilled',
      'pensionBilled','employmentBilled','source','memo','uploadedBy'];
    if (existing) {
      const sets = fields.filter(f => !['userId','companyId','yearMonth'].includes(f) && data[f] !== undefined)
        .map(f => `${f}=@${f}`).join(',');
      db.prepare(`UPDATE salary_edi_records SET ${sets},uploadedAt=datetime('now','localtime') WHERE userId=@userId AND companyId=@companyId AND yearMonth=@yearMonth`)
        .run(data);
    } else {
      const available = fields.filter(f => data[f] !== undefined);
      db.prepare(`INSERT INTO salary_edi_records (${available.join(',')}) VALUES (${available.map(f=>'@'+f).join(',')})`)
        .run(data);
    }
  },
  delete(id) {
    db.prepare('DELETE FROM salary_edi_records WHERE id=?').run(id);
  },
  bulkUpsert(rows) {
    const txn = db.transaction(() => { rows.forEach(r => this.upsert(r)); });
    txn();
  }
};

// ── salary_issuances ──────────────────────────────────────────────────────────
const issuances = {
  getByMonth(companyId, yearMonth) {
    return db.prepare('SELECT * FROM salary_issuances WHERE companyId=? AND yearMonth=? ORDER BY issuedAt DESC').all(companyId, yearMonth);
  },
  create(data) {
    db.prepare('INSERT INTO salary_issuances (yearMonth,userId,companyId,issuedType,recipient,issuedBy,filePath) VALUES (?,?,?,?,?,?,?)')
      .run(data.yearMonth, data.userId, data.companyId, data.issuedType, data.recipient, data.issuedBy, data.filePath);
  }
};

// ── income_tax_table ──────────────────────────────────────────────────────────
const incomeTax = {
  getAll(year) {
    return db.prepare('SELECT * FROM income_tax_table WHERE year=? ORDER BY salaryFrom').all(year);
  },
  getYears() {
    return db.prepare('SELECT DISTINCT year FROM income_tax_table ORDER BY year DESC').all().map(r => r.year);
  },
  lookup(year, taxableSalary) {
    // 엑셀 간이세액표는 월급여액을 "천원 단위"로 저장 (770 = 770,000원 ~ 775,000원)
    // VLOOKUP(PTotal/1000, ..., 1)에 해당 — 미만 조건으로 구간 매칭
    const thousands = Math.floor(taxableSalary / 1000);
    // 최대 구간(10000천원 이상)에는 테이블 값 없으므로 마지막 구간 반환 → 초과분은 calcSalary가 누진 공식 적용
    let row = db.prepare(`SELECT * FROM income_tax_table
      WHERE year=? AND salaryFrom<=? AND salaryTo>? ORDER BY salaryFrom DESC LIMIT 1`)
      .get(year, thousands, thousands);
    if (!row) {
      // PTotal이 테이블 최대(10M)를 초과 → 최상단(last) 구간값 반환 (누진 적용 base)
      row = db.prepare('SELECT * FROM income_tax_table WHERE year=? ORDER BY salaryFrom DESC LIMIT 1').get(year);
    }
    return row;
  },
  bulkInsert(year, rows) {
    db.prepare('DELETE FROM income_tax_table WHERE year=?').run(year);
    const stmt = db.prepare('INSERT INTO income_tax_table (year,salaryFrom,salaryTo,dep1,dep2,dep3,dep4,dep5,dep6,dep7,dep8,dep9,dep10,dep11) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
    const txn = db.transaction(() => {
      rows.forEach(r => stmt.run(year, r.salaryFrom, r.salaryTo, r.dep1||0, r.dep2||0, r.dep3||0, r.dep4||0,
        r.dep5||0, r.dep6||0, r.dep7||0, r.dep8||0, r.dep9||0, r.dep10||0, r.dep11||0));
    });
    txn();
  }
};

// ── 급여 자동계산 로직 (2026-04-17 Wave 1: 엑셀 VBA 공식 대응) ───────────────
// 엑셀 대림에스엠/대림컴퍼니 급여관리기.xlsm의 CTAX/HTAX/HTAX2/ETAX/INTAX/INTAX2
// VBA 함수를 그대로 재현. project_excel_vba_formulas.md 메모리 참조.
function calcSalary({ config, settingsRow, overtimeData, yearMonth, extraItems, labels, prorate }) {
  const s = settingsRow;
  const c = config;

  // ── 지급 ──────────────────────────────────────────────────────
  let base        = c.baseSalary || 0;
  let fixedOt     = c.fixedOvertimePay || 0;
  let fixedHol    = c.fixedHolidayPay || 0;
  let meal        = c.mealAllowance || 0;
  let transport   = c.transportAllowance || 0;
  let teamLeader  = c.teamLeaderAllowance || 0;

  // ── 중도 입/퇴사자 일할계산 (엑셀 급여계산설정 F15/F16) ──────────────────────
  // prorate = { ratio: 0~1, denom: 'period_ratio'|'thirty_days'|'hourly_x_eight',
  //             mode: 'base_only'|'base_plus_allow'|'allow_only', activeDays: number }
  // ratio 계산은 호출측(routes/salary.js)에서 joinDate/resignDate/정산기간을 가지고 수행
  let prorateDays = 0, prorateAmount = 0;
  if (prorate && prorate.ratio < 1 && prorate.ratio > 0) {
    const denom = prorate.denom || s.prorateDenom || 'period_ratio';
    const mode  = prorate.mode  || s.prorateMode  || 'base_plus_allow';
    const activeDays = prorate.activeDays || 0;

    const origBase = base, origFot = fixedOt, origFhol = fixedHol;
    const origMeal = meal, origTrans = transport, origTeam = teamLeader;

    const applyRatio = (amount) => {
      if (denom === 'thirty_days') {
        // 30일 기준: amount × (activeDays / 30)
        return Math.floor(amount * (activeDays / 30));
      } else if (denom === 'hourly_x_eight') {
        // 통상시급 × 8시간 × 재직일수 (기본급에만 적용, 고정수당은 period_ratio)
        const hourly = c.hourlyRate || 0;
        return Math.floor(hourly * 8 * activeDays);
      } else {
        // period_ratio: amount × (activeDays / totalDays)
        return Math.floor(amount * prorate.ratio);
      }
    };

    if (mode === 'base_only') {
      base = applyRatio(origBase);
    } else if (mode === 'base_plus_allow') {
      base = applyRatio(origBase);
      fixedOt = applyRatio(origFot);
      fixedHol = applyRatio(origFhol);
      meal = applyRatio(origMeal);
      transport = applyRatio(origTrans);
      teamLeader = applyRatio(origTeam);
    } else if (mode === 'allow_only') {
      fixedOt = applyRatio(origFot);
      fixedHol = applyRatio(origFhol);
      meal = applyRatio(origMeal);
      transport = applyRatio(origTrans);
      teamLeader = applyRatio(origTeam);
    }
    prorateDays = activeDays;
    prorateAmount =
      (origBase - base) + (origFot - fixedOt) + (origFhol - fixedHol) +
      (origMeal - meal) + (origTrans - transport) + (origTeam - teamLeader);
  }

  const otHours  = overtimeData?.overtimeHours || 0;
  const ntHours  = overtimeData?.nightHours || 0;
  const holHours = overtimeData?.holidayHours || 0;
  const holOtHrs = overtimeData?.holidayOtHours || 0;

  const hourly   = c.hourlyRate || 0;
  const otPay    = Math.floor(otHours  * hourly * (s.overtimeMultiple || 1.5));
  const ntPay    = Math.floor(ntHours  * hourly * (s.nightMultiple || 0.5));
  const holPay   = Math.floor(holHours * hourly * (s.holidayMultiple || 1.5));
  const holOtPay = Math.floor(holOtHrs * hourly * (s.holidayOtMultiple || 2.0));

  const bonus   = extraItems?.bonusPay || 0;
  const retro   = extraItems?.retroPay || 0;
  const leave   = extraItems?.leavePay || 0;
  // 지급 슬롯 1~8 전부 합산
  const extraPaySlots = {};
  let extraPaySum = 0;
  for (let i = 1; i <= 8; i++) {
    const v = extraItems?.[`extraPay${i}`] || 0;
    extraPaySlots[`extraPay${i}`] = v;
    extraPaySum += v;
  }

  // ── 과세/비과세 구분 (엑셀 setting 시트 C2:U2 플래그 재현) ──────────────────
  // labels?.visibility (JSON) 확장: { extraPay1: { nonTaxable: true, nonTaxLimit: 0 }, ... }
  // 기본 규칙 (국세청 표준):
  //   - 식대: 20만원 한도 비과세 (2024년 이후)
  //   - 차량유지비(자가운전보조금): 20만원 한도 비과세
  //   - 그 외: 전액 과세
  let vis = {};
  try { vis = (labels?.visibility && typeof labels.visibility === 'string')
      ? JSON.parse(labels.visibility) : (labels?.visibility || {}); } catch(e) { vis = {}; }

  const mealNonTax      = Math.min(meal, 200000);
  const transportNonTax = Math.min(transport, 200000);
  // 추가 슬롯(extraPay1~8) 비과세 처리
  let extraNonTax = 0;
  for (let i = 1; i <= 8; i++) {
    const cfg = vis[`extraPay${i}`];
    if (cfg && typeof cfg === 'object' && cfg.nonTaxable) {
      const amt = extraPaySlots[`extraPay${i}`] || 0;
      const limit = +cfg.nonTaxLimit || 0;
      extraNonTax += limit > 0 ? Math.min(amt, limit) : amt;
    }
  }
  const nonTax = mealNonTax + transportNonTax + extraNonTax;

  // 과세합계: 전체 지급 − 비과세
  const gross = base + fixedOt + fixedHol + meal + transport + teamLeader
    + otPay + ntPay + holPay + holOtPay + bonus + retro + leave + extraPaySum;
  const taxable = gross - nonTax;

  // ── 4대보험 (엑셀 CTAX/HTAX/HTAX2/ETAX 재현) ──────────────────────────────
  // 감면율: reductionPct (0~80) — 엑셀 opt≥5에서 (1 - (opt-2)/10) 계수와 호환
  const applyReduction = (amount, pct) => {
    if (!pct || pct <= 0) return amount;
    return Math.floor(amount * (100 - Math.min(pct, 80)) / 100);
  };

  let pension = 0;
  if (c.pensionOpt === 'O') {
    // 기준소득월액(P열) 있으면 그 값 사용 (월 과세합계 기준 상/하한 사이로 clamp)
    const pensionBase = c.pensionBasisManual > 0
      ? c.pensionBasisManual
      : Math.min(Math.max(taxable, s.pensionMin || 400000), s.pensionMax || 6370000);
    pension = roundSalary(pensionBase * (s.pensionRate || 4.5) / 100, s);
    pension = applyReduction(pension, c.pensionReductionPct);
  }

  let health = 0, ltc = 0;
  if (c.healthOpt === 'O') {
    // 보수월액(R열) 있으면 그 값 사용
    const healthBase = c.healthBasisManual > 0 ? c.healthBasisManual : taxable;
    const healthTotal = Math.floor(healthBase * (s.healthRate || 3.595) / 100 / 10) * 10;
    health = Math.floor(healthTotal / 2 / 10) * 10;
    health = applyReduction(health, c.healthReductionPct);
    if (c.ltcOpt === 'O') {
      // HTAX2: 장기요양보험 — 엑셀 공식: 건강보험 × (요양율 × 2) / 100
      //   (위에서 health를 절반으로 나눴으므로, 건강보험 × 요양율 × 2 / 100 = 요양 총액 절반)
      // ltcRate는 "건강보험료 대비 %"로 저장 (2024년 12.95%, 2026년 13.14% 등)
      const rate = s.ltcRate || 13.14;
      const ltcTotal = Math.floor(healthTotal * rate / 100 / 10) * 10;
      ltc = Math.floor(ltcTotal / 2 / 10) * 10;
      ltc = applyReduction(ltc, c.ltcReductionPct);
    }
  }

  let employment = 0;
  if (c.employmentOpt === 'O') {
    // opt=3 → 국민연금 기준소득월액 사용, opt=4 → 보수월액 — 지금은 단순화 (taxable 기준)
    employment = roundSalary(taxable * (s.employmentRate || 0.9) / 100, s);
    employment = applyReduction(employment, c.employmentReductionPct);
  }

  // ── 소득세 (엑셀 INTAX 공식: VLOOKUP + 구간별 누진 보정) ────────────────────
  let incomeTaxAmt = 0, localTaxAmt = 0;
  const year = parseInt(yearMonth?.split('-')[0]) || new Date().getFullYear();
  const type = c.incomeTaxType || '근로소득 100%';

  if (type === '사업소득 3.3%') {
    incomeTaxAmt = Math.floor(gross * 0.03);
    localTaxAmt  = Math.floor(gross * 0.003);
  } else if (type === '기타소득 8.8%') {
    incomeTaxAmt = Math.floor(gross * 0.08);
    localTaxAmt  = Math.floor(gross * 0.008);
  } else if (taxable >= 1060000) {
    // 근로소득: 간이세액표 기준
    // 부양가족(dep) + 8세~20세 자녀수 (childrenCount)를 합산하여 column 선택 (엑셀 VBA +2 offset)
    const depCount = Math.min(Math.max((c.dependents || 1) + (c.childrenCount || 0), 1), 11);
    let baseTax = 0;
    // 자주 쓰이는 경우 2026년 표를 우선, 없으면 해당 연도 최신
    const taxRow = incomeTax.lookup(year, taxable) || incomeTax.lookup(2026, taxable);
    if (taxRow) {
      baseTax = taxRow[`dep${depCount}`] || 0;
    }
    // 구간별 누진 보정 (엑셀 VBA INTAX)
    if (taxable <= 10_000_000) {
      incomeTaxAmt = Math.floor(baseTax / 10) * 10;
    } else if (taxable <= 14_000_000) {
      incomeTaxAmt = baseTax + 25_000 + Math.floor((taxable - 10_000_000) * 0.98 * 0.35);
    } else if (taxable <= 28_000_000) {
      incomeTaxAmt = baseTax + 1_397_000 + Math.floor((taxable - 14_000_000) * 0.98 * 0.38);
    } else if (taxable <= 30_000_000) {
      incomeTaxAmt = baseTax + 6_610_600 + Math.floor((taxable - 28_000_000) * 0.98 * 0.4);
    } else if (taxable <= 45_000_000) {
      incomeTaxAmt = baseTax + 7_394_600 + Math.floor((taxable - 30_000_000) * 0.4);
    } else if (taxable <= 87_000_000) {
      incomeTaxAmt = baseTax + 13_394_600 + Math.floor((taxable - 45_000_000) * 0.42);
    } else {
      incomeTaxAmt = baseTax + 31_034_600 + Math.floor((taxable - 87_000_000) * 0.45);
    }
    // 80%/120% 적용 옵션
    if (type === '근로소득 80%')  incomeTaxAmt = Math.floor(incomeTaxAmt * 0.8);
    if (type === '근로소득 120%') incomeTaxAmt = Math.ceil(incomeTaxAmt * 1.2);
    // 감면율
    incomeTaxAmt = applyReduction(incomeTaxAmt, c.incomeReductionPct);
    // 지방소득세 = 소득세 × 10% (INTAX2)
    localTaxAmt = Math.floor(incomeTaxAmt * 0.1 / 10) * 10;
  }
  // else taxable < 1,060,000원: 비과세 근로자 → 소득세 0

  // ── 공제합계 / 실지급액 ───────────────────────────────────────
  // 공제 슬롯 1~8 합산
  const extraDedSlots = {};
  let extraDedSum = 0;
  for (let i = 1; i <= 8; i++) {
    const v = extraItems?.[`extraDeduction${i}`] || 0;
    extraDedSlots[`extraDeduction${i}`] = v;
    extraDedSum += v;
  }
  const misc1 = extraItems?.miscDeduction1 || 0;
  const misc2 = extraItems?.miscDeduction2 || 0;
  const healthAnn = extraItems?.healthAnnual || 0;
  const ltcAnn = extraItems?.ltcAnnual || 0;
  const healthInst = extraItems?.healthInstallment || 0;
  const ltcInst = extraItems?.ltcInstallment || 0;
  const healthApr = extraItems?.healthAprExtra || 0;
  const ltcApr = extraItems?.ltcAprExtra || 0;
  const healthRef = extraItems?.healthRefundInterest || 0;
  const ltcRef = extraItems?.ltcRefundInterest || 0;
  const incomeTaxAdjAmt = extraItems?.incomeTaxAdj || 0;
  const localTaxAdjAmt = extraItems?.localTaxAdj || 0;

  const totalDeduct = pension + health + ltc + employment + incomeTaxAmt + localTaxAmt
    + incomeTaxAdjAmt + localTaxAdjAmt + healthAnn + ltcAnn + healthInst + ltcInst
    + healthApr + ltcApr + healthRef + ltcRef + misc1 + misc2 + extraDedSum;
  const netPay = gross - totalDeduct;

  return {
    baseSalary: base,
    fixedOvertimePay: fixedOt,
    fixedHolidayPay: fixedHol,
    mealAllowance: meal,
    transportAllowance: transport,
    teamLeaderAllowance: teamLeader,
    prorateDays, prorateAmount,
    overtimeHours: otHours, overtimePay: otPay,
    nightHours: ntHours, nightPay: ntPay,
    holidayHours: holHours, holidayPay: holPay,
    holidayOtHours: holOtHrs, holidayOtPay: holOtPay,
    bonusPay: bonus, retroPay: retro, leavePay: leave,
    ...extraPaySlots,
    taxableTotal: taxable, nonTaxableTotal: nonTax, grossPay: gross,
    nationalPension: pension, healthInsurance: health, longTermCare: ltc,
    employmentInsurance: employment, incomeTax: incomeTaxAmt, localTax: localTaxAmt,
    incomeTaxAdj: incomeTaxAdjAmt, localTaxAdj: localTaxAdjAmt,
    healthAnnual: healthAnn, ltcAnnual: ltcAnn,
    healthInstallment: healthInst, ltcInstallment: ltcInst,
    healthAprExtra: healthApr, ltcAprExtra: ltcApr,
    healthRefundInterest: healthRef, ltcRefundInterest: ltcRef,
    miscDeduction1: misc1, miscDeduction2: misc2,
    ...extraDedSlots,
    totalDeductions: totalDeduct,
    netPay,
    status: 'draft'
  };
}

function roundSalary(amount, s) {
  const unit = s?.roundingUnit || '십단위';
  if (unit === '원단위') return Math.floor(amount);
  if (unit === '십단위') return Math.floor(amount / 10) * 10;
  if (unit === '백단위') return Math.floor(amount / 100) * 100;
  if (unit === '천단위') return Math.floor(amount / 1000) * 1000;
  return Math.floor(amount / 10) * 10;
}

// ── salary_overtime CRUD ────────────────────────────────────────────────────────
const overtime = {
  // 월별 전체 조회 (직원별 합산)
  getByMonth(companyId, yearMonth) {
    return db.prepare(`
      SELECT userId, companyId, yearMonth,
        SUM(overtimeH) AS overtimeHours, SUM(nightH) AS nightHours,
        SUM(holidayH) AS holidayHours, SUM(holidayOtH) AS holidayOtHours,
        MAX(memo) AS memo
      FROM salary_overtime
      WHERE companyId=? AND yearMonth=?
      GROUP BY userId
      ORDER BY userId
    `).all(companyId, yearMonth);
  },
  // 직원 월별 날짜별 상세
  getDetail(userId, companyId, yearMonth) {
    return db.prepare(`
      SELECT * FROM salary_overtime
      WHERE userId=? AND companyId=? AND yearMonth=?
      ORDER BY workDate
    `).all(userId, companyId, yearMonth);
  },
  // upsert (월 합계 단순 입력 — workDate='TOTAL' 사용)
  upsertSummary(data) {
    const { userId, companyId, yearMonth, overtimeH=0, nightH=0, holidayH=0, holidayOtH=0, memo='' } = data;
    const workDate = 'TOTAL';
    const ex = db.prepare('SELECT id FROM salary_overtime WHERE userId=? AND companyId=? AND yearMonth=? AND workDate=?')
      .get(userId, companyId, yearMonth, workDate);
    if (ex) {
      db.prepare(`UPDATE salary_overtime SET overtimeH=?,nightH=?,holidayH=?,holidayOtH=?,memo=?,updatedAt=datetime('now','localtime')
        WHERE userId=? AND companyId=? AND yearMonth=? AND workDate=?`)
        .run(overtimeH, nightH, holidayH, holidayOtH, memo, userId, companyId, yearMonth, workDate);
    } else {
      db.prepare(`INSERT INTO salary_overtime (userId,companyId,yearMonth,workDate,overtimeH,nightH,holidayH,holidayOtH,memo)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(userId, companyId, yearMonth, workDate, overtimeH, nightH, holidayH, holidayOtH, memo);
    }
    // 저장 직후 해당 직원의 합산 값만 반환 (long field 이름으로 정규화)
    const row = db.prepare(`
      SELECT userId, companyId, yearMonth,
        SUM(overtimeH) AS overtimeHours, SUM(nightH) AS nightHours,
        SUM(holidayH) AS holidayHours, SUM(holidayOtH) AS holidayOtHours,
        MAX(memo) AS memo
      FROM salary_overtime
      WHERE userId=? AND companyId=? AND yearMonth=?
      GROUP BY userId
    `).get(userId, companyId, yearMonth);
    return row;
  },
  delete(userId, companyId, yearMonth) {
    db.prepare('DELETE FROM salary_overtime WHERE userId=? AND companyId=? AND yearMonth=?').run(userId, companyId, yearMonth);
  },
  // ── 일자별 연장근무 레코드 (엑셀 연장근무 시트 tbOver 대응) ────────────────
  // workDate = YYYY-MM-DD. TOTAL 레코드와 공존 가능하지만 충돌 시 날짜별이 우선.
  upsertDaily(data) {
    const { userId, companyId, yearMonth, workDate, overtimeH=0, nightH=0, holidayH=0, holidayOtH=0, memo='' } = data;
    if (!workDate || workDate === 'TOTAL') throw new Error('workDate는 YYYY-MM-DD 형식이어야 합니다');
    const ex = db.prepare('SELECT id FROM salary_overtime WHERE userId=? AND companyId=? AND yearMonth=? AND workDate=?')
      .get(userId, companyId, yearMonth, workDate);
    if (ex) {
      db.prepare(`UPDATE salary_overtime SET overtimeH=?,nightH=?,holidayH=?,holidayOtH=?,memo=?,updatedAt=datetime('now','localtime')
        WHERE userId=? AND companyId=? AND yearMonth=? AND workDate=?`)
        .run(overtimeH, nightH, holidayH, holidayOtH, memo, userId, companyId, yearMonth, workDate);
    } else {
      db.prepare(`INSERT INTO salary_overtime (userId,companyId,yearMonth,workDate,overtimeH,nightH,holidayH,holidayOtH,memo)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(userId, companyId, yearMonth, workDate, overtimeH, nightH, holidayH, holidayOtH, memo);
    }
    return db.prepare('SELECT * FROM salary_overtime WHERE userId=? AND companyId=? AND yearMonth=? AND workDate=?')
      .get(userId, companyId, yearMonth, workDate);
  },
  // 일자별 일괄 업서트 (CAPS에서 한번에 push)
  bulkUpsertDaily(rows) {
    const txn = db.transaction(() => { rows.forEach(r => this.upsertDaily(r)); });
    txn();
  },
  // 특정 날짜 삭제
  deleteDaily(userId, companyId, yearMonth, workDate) {
    db.prepare('DELETE FROM salary_overtime WHERE userId=? AND companyId=? AND yearMonth=? AND workDate=?')
      .run(userId, companyId, yearMonth, workDate);
  },
  // 그 달 전체 직원의 일자별 (TOTAL 제외) — 엑셀 연장근무 시트와 동일 형태
  getAllDailyByMonth(companyId, yearMonth) {
    return db.prepare(`
      SELECT id, userId, companyId, yearMonth, workDate, overtimeH, nightH, holidayH, holidayOtH, memo, updatedAt
      FROM salary_overtime
      WHERE companyId=? AND yearMonth=? AND workDate != 'TOTAL'
      ORDER BY workDate, userId
    `).all(companyId, yearMonth);
  },
  // 단일 행 삭제 (id 기반 — 그리드 행 삭제용)
  deleteById(id) {
    db.prepare('DELETE FROM salary_overtime WHERE id=?').run(id);
  }
};

// ── 지급현황 (연도별 전직원) ─────────────────────────────────────────────────────
function getPayStatus(companyId, year) {
  const months = Array.from({length:12}, (_,i) => `${year}-${String(i+1).padStart(2,'0')}`);
  // 해당 연도 전 월 레코드
  const rows = db.prepare(`
    SELECT userId, yearMonth, grossPay, totalDeductions, netPay, status
    FROM salary_records
    WHERE companyId=? AND yearMonth BETWEEN ? AND ?
    ORDER BY userId, yearMonth
  `).all(companyId, `${year}-01`, `${year}-12`);

  // userId별 그룹핑
  const byUser = {};
  rows.forEach(r => {
    if (!byUser[r.userId]) byUser[r.userId] = { userId: r.userId, months: {} }
    byUser[r.userId].months[r.yearMonth] = {
      grossPay: r.grossPay || 0, totalDeductions: r.totalDeductions || 0,
      netPay: r.netPay || 0, status: r.status || 'draft'
    };
  });

  // 이름 채우기
  const cfgs = db.prepare('SELECT userId, name FROM salary_configs WHERE companyId=? GROUP BY userId').all(companyId);
  cfgs.forEach(c => { if (byUser[c.userId]) byUser[c.userId].name = c.name; });

  return { employees: Object.values(byUser), months };
}

module.exports = {
  db,
  settings, configs, records, itemLabels, ediRecords, issuances, incomeTax,
  overtime, getPayStatus,
  calcSalary, encrypt, decrypt
};
