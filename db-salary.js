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
      'ltcRate','employmentRate','overtimeMultiple','nightMultiple','holidayMultiple','holidayOtMultiple','roundingUnit'];
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
    // 통상임금 자동계산
    const normalWage = (data.baseSalary || 0) + (data.fixedOvertimePay || 0) + (data.fixedHolidayPay || 0);
    const hourlyRate = data.workingHours > 0 ? Math.floor(normalWage / data.workingHours) : 0;
    const existing = db.prepare('SELECT id FROM salary_configs WHERE userId=? AND companyId=? AND effectiveFrom=?').get(userId, companyId, effectiveFrom);
    const fields = [
      'userId','companyId','name','effectiveFrom','baseSalary','fixedOvertimePay','fixedHolidayPay',
      'mealAllowance','transportAllowance','teamLeaderAllowance','normalWage','workingHours','hourlyRate',
      'fixedOvertimeHours','fixedHolidayHours','dependents','childrenCount','incomeTaxType',
      'pensionOpt','pensionBasisManual','healthOpt','healthBasisManual','ltcOpt','employmentOpt',
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
const itemLabels = {
  get(companyId, yearMonth) {
    return db.prepare('SELECT * FROM salary_item_labels WHERE companyId=? AND yearMonth=?').get(companyId, yearMonth)
      || { companyId, yearMonth, extraPay1Name:'', extraPay2Name:'', extraPay3Name:'',
           extraDeduction1Name:'', extraDeduction2Name:'', extraDeduction3Name:'' };
  },
  upsert(companyId, yearMonth, data) {
    const existing = db.prepare('SELECT id FROM salary_item_labels WHERE companyId=? AND yearMonth=?').get(companyId, yearMonth);
    const fields = ['extraPay1Name','extraPay2Name','extraPay3Name','extraDeduction1Name','extraDeduction2Name','extraDeduction3Name'];
    if (existing) {
      const sets = fields.map(f => `${f}=@${f}`).join(',');
      db.prepare(`UPDATE salary_item_labels SET ${sets} WHERE companyId=@companyId AND yearMonth=@yearMonth`)
        .run({ ...data, companyId, yearMonth });
    } else {
      db.prepare(`INSERT INTO salary_item_labels (companyId,yearMonth,${fields.join(',')}) VALUES (@companyId,@yearMonth,${fields.map(f=>'@'+f).join(',')})`)
        .run({ companyId, yearMonth, ...data });
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
    // 간이세액표에서 해당 구간 찾기
    return db.prepare('SELECT * FROM income_tax_table WHERE year=? AND salaryFrom<=? AND salaryTo>=? LIMIT 1')
      .get(year, taxableSalary, taxableSalary);
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

// ── 급여 자동계산 로직 ────────────────────────────────────────────────────────
function calcSalary({ config, settingsRow, overtimeData, yearMonth, extraItems, labels }) {
  const s = settingsRow;
  const c = config;

  // ── 지급 ──────────────────────────────────────────────────────
  const base        = c.baseSalary || 0;
  const fixedOt     = c.fixedOvertimePay || 0;
  const fixedHol    = c.fixedHolidayPay || 0;
  const meal        = c.mealAllowance || 0;
  const transport   = c.transportAllowance || 0;
  const teamLeader  = c.teamLeaderAllowance || 0;

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
  const ex1     = extraItems?.extraPay1 || 0;
  const ex2     = extraItems?.extraPay2 || 0;
  const ex3     = extraItems?.extraPay3 || 0;

  // 비과세: 식대(20만 한도) + 차량유지비
  const mealNonTax = Math.min(meal, 200000);
  const nonTax     = mealNonTax + transport;

  // 과세합계: 전체 지급에서 비과세 제외
  const taxable = base + fixedOt + fixedHol + meal + transport + teamLeader
    + otPay + ntPay + holPay + holOtPay + bonus + retro + leave + ex1 + ex2 + ex3 - nonTax;
  const gross   = taxable + nonTax;

  // ── 4대보험 ──────────────────────────────────────────────────
  let pension = 0;
  if (c.pensionOpt === 'O') {
    const pensionBasis = c.pensionBasisManual || Math.min(Math.max(taxable, s.pensionMin || 400000), s.pensionMax || 6370000);
    pension = roundSalary(pensionBasis * (s.pensionRate || 4.5) / 100, s);
  }

  let health = 0, ltc = 0;
  if (c.healthOpt === 'O') {
    const healthBasis = c.healthBasisManual || taxable;
    const healthTotal = Math.floor(healthBasis * (s.healthRate || 3.595) / 100 / 10) * 10;
    health = Math.floor(healthTotal / 2 / 10) * 10;
    if (c.ltcOpt === 'O') {
      const ltcTotal = Math.floor(healthTotal * (s.ltcRate || 13.14) / 100 / 10) * 10;
      ltc = Math.floor(ltcTotal / 2 / 10) * 10;
    }
  }

  let employment = 0;
  if (c.employmentOpt === 'O') {
    employment = roundSalary(taxable * (s.employmentRate || 0.9) / 100, s);
  }

  // ── 소득세 ───────────────────────────────────────────────────
  let incomeTaxAmt = 0, localTaxAmt = 0;
  const year = parseInt(yearMonth?.split('-')[0]) || new Date().getFullYear();
  const taxRow = incomeTax.lookup(year, taxable);
  if (taxRow) {
    const dep = Math.min(Math.max(c.dependents || 1, 1), 11);
    const depKey = `dep${dep}`;
    const baseTax = taxRow[depKey] || 0;
    const type = c.incomeTaxType || '근로소득 100%';
    if (type === '근로소득 100%') incomeTaxAmt = baseTax;
    else if (type === '근로소득 80%') incomeTaxAmt = Math.floor(baseTax * 0.8);
    else if (type === '근로소득 120%') incomeTaxAmt = Math.ceil(baseTax * 1.2);
    else if (type.includes('감면')) {
      const pct = parseFloat(type) || 0;
      incomeTaxAmt = Math.floor(baseTax * (100 - pct) / 100);
    } else if (type === '사업소득 3.3%') {
      incomeTaxAmt = Math.floor(gross * 0.03);
      localTaxAmt  = Math.floor(gross * 0.003);
    } else if (type === '기타소득 8.8%') {
      incomeTaxAmt = Math.floor(gross * 0.08);
      localTaxAmt  = Math.floor(gross * 0.008);
    }
    if (!type.includes('소득')) {
      localTaxAmt = Math.floor(incomeTaxAmt * 0.1);
    }
  }

  // ── 공제합계 / 실지급액 ───────────────────────────────────────
  const ex1d = extraItems?.extraDeduction1 || 0;
  const ex2d = extraItems?.extraDeduction2 || 0;
  const ex3d = extraItems?.extraDeduction3 || 0;
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
    + healthApr + ltcApr + healthRef + ltcRef + misc1 + misc2 + ex1d + ex2d + ex3d;
  const netPay = gross - totalDeduct;

  return {
    baseSalary: base,
    fixedOvertimePay: fixedOt,
    fixedHolidayPay: fixedHol,
    mealAllowance: meal,
    transportAllowance: transport,
    teamLeaderAllowance: teamLeader,
    overtimeHours: otHours, overtimePay: otPay,
    nightHours: ntHours, nightPay: ntPay,
    holidayHours: holHours, holidayPay: holPay,
    holidayOtHours: holOtHrs, holidayOtPay: holOtPay,
    bonusPay: bonus, retroPay: retro, leavePay: leave,
    extraPay1: ex1, extraPay2: ex2, extraPay3: ex3,
    taxableTotal: taxable, nonTaxableTotal: nonTax, grossPay: gross,
    nationalPension: pension, healthInsurance: health, longTermCare: ltc,
    employmentInsurance: employment, incomeTax: incomeTaxAmt, localTax: localTaxAmt,
    incomeTaxAdj: incomeTaxAdjAmt, localTaxAdj: localTaxAdjAmt,
    healthAnnual: healthAnn, ltcAnnual: ltcAnn,
    healthInstallment: healthInst, ltcInstallment: ltcInst,
    healthAprExtra: healthApr, ltcAprExtra: ltcApr,
    healthRefundInterest: healthRef, ltcRefundInterest: ltcRef,
    miscDeduction1: misc1, miscDeduction2: misc2,
    extraDeduction1: ex1d, extraDeduction2: ex2d, extraDeduction3: ex3d,
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
    if (!byUser[r.userId]) byUser[r.userId] = { userId: r.userId, months: {} };
    byUser[r.userId].months[r.yearMonth] = { grossPay: r.grossPay, totalDeductions: r.totalDeductions, netPay: r.netPay, status: r.status };
  });

  // configs에서 이름 정보
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
