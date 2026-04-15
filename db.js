/**
 * db.js — 통합 데이터베이스 (SQLite + JSON 혼합)
 *
 * ┌─ SQLite (업무데이터.db) ─────────────────────┐
 * │  품목(categories), 옵션(options)              │
 * │  업체(vendors), 업체별단가(vendor_prices)     │
 * │  견적서(quotes), 견적항목(quote_items)        │
 * └──────────────────────────────────────────────┘
 * ┌─ JSON (한글 파일명) ─────────────────────────┐
 * │  조직관리.json  ← users + departments        │
 * │  결재관리.json  ← approvals                  │
 * │  연락처.json    ← contacts                   │
 * │  공지사항.json  ← notices (예정)             │
 * │  일정관리.json  ← calendar (예정)            │
 * │  알림.json      ← notifications (예정)       │
 * │  설정.json      ← system settings            │
 * └──────────────────────────────────────────────┘
 *
 * 사용법:
 *   const db = require('./db');
 *
 *   // SQLite (업무 데이터)
 *   db.sql.categories.getAll();
 *   db.sql.quotes.create({ ... });
 *
 *   // JSON (조직/설정 데이터)
 *   const org = db.조직관리.load();
 *   org.users.push(newUser);
 *   db.조직관리.save(org);
 *
 * 새 JSON 메뉴 추가:
 *   jsonStores 객체에 { 파일명: { 기본데이터 } } 한 줄 추가하면 끝
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ══════════════════════════════════════════════════════
// SQLite 영역 (업무 데이터)
// ══════════════════════════════════════════════════════

let sql;
try {
  sql = require('./db-sqlite');
} catch (e) {
  // better-sqlite3 미설치 시 JSON 폴백
  console.warn('⚠️ better-sqlite3 미설치 → JSON 모드로 동작합니다');
  console.warn('   설치: npm install better-sqlite3');
  sql = null;
}

// ══════════════════════════════════════════════════════
// JSON 영역 (조직/설정 데이터)
// ══════════════════════════════════════════════════════

const jsonStores = {
  '조직관리': {
    users: [],
    departments: []
  },
  '결재관리': {
    approvals: []
  },
  '연락처': {
    contactCompanies: [],
    contactProjects: [],
    contacts: []
  },
  '설정': {
    smtp: {},
    general: {}
  },
  '연차관리': {
    settings: {
      fiscalStartMonth: 1,
      leaveTypes: [
        { name: '연차', days: 1, deductsAnnual: true },
        { name: '반차', days: 0.5, deductsAnnual: true },
        { name: '외출', days: 0.5, deductsAnnual: false },
        { name: '지각', days: 0.25, deductsAnnual: false },
        { name: '조퇴', days: 0.25, deductsAnnual: false },
        { name: '경조휴가', days: 1, deductsAnnual: false },
        { name: '예비군', days: 1, deductsAnnual: false }
      ]
    },
    employees: [],
    leaveRecords: [],
    adjustments: []
  },
  '출퇴근관리': {
    attendanceNotes: {},
    attendanceRequests: [],
    departments: [],
    employeeOrder: {},
    flexDepts: [],          // 유연근무 부서 (조퇴 면제)
    saturdayWorkDepts: [],  // 토요일 근무 부서
    exemptDepts: [],        // 근태면제 부서
    excludeEmployees: []    // 기록 제외 직원
  },
  '감사로그': {
    logs: []
  },
  '단가이력': {
    logs: []
  },
  '알림': {
    notifications: []
  },
  '공지사항': {
    notices: []
  },
  '결재위임': {
    delegates: []
  },
  '일정관리': {
    events: []
  },
};

// JSON 폴백용 (SQLite 미설치 시)
const jsonFallbackStores = {
  '품목관리': {
    categories: [],
    options: [],
    vendorPrices: []
  },
  '업체관리': {
    vendors: []
  },
  '견적관리': {
    quotes: []
  }
};

function getFilePath(storeName) {
  return path.join(DATA_DIR, `${storeName}.json`);
}

function loadStore(storeName) {
  ensureDir();
  const filePath = getFilePath(storeName);
  const allStores = { ...jsonStores, ...jsonFallbackStores };
  const defaults = allStores[storeName];

  if (!defaults) throw new Error(`알 수 없는 스토어: ${storeName}`);

  if (!fs.existsSync(filePath)) {
    const init = JSON.parse(JSON.stringify(defaults));
    saveStore(storeName, init);
    return init;
  }

  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/\0/g, ''));
  } catch (e) {
    console.warn(`⚠️ ${storeName}.json 손상: ${e.message}`);
    const backupPath = filePath + '.bak';
    // 백업에서 복구 시도
    try {
      if (fs.existsSync(backupPath)) {
        console.warn(`  → 백업에서 복구 시도...`);
        data = JSON.parse(fs.readFileSync(backupPath, 'utf8').replace(/\0/g, ''));
        fs.copyFileSync(backupPath, filePath);
        console.warn(`  → 백업 복구 성공`);
      } else {
        throw new Error('백업 없음');
      }
    } catch (e2) {
      // 백업도 실패 → 기본값으로 초기화 (서버 크래시 방지)
      console.error(`  → 백업 복구 실패: ${e2.message}`);
      console.warn(`  → 기본값으로 초기화합니다`);
      // 손상 파일 보존 (수동 복구용)
      const brokenPath = filePath + '.broken_' + Date.now();
      try { fs.copyFileSync(filePath, brokenPath); } catch(e3) {}
      data = JSON.parse(JSON.stringify(defaults));
      saveStore(storeName, data);
    }
  }

  for (const key of Object.keys(defaults)) {
    if (!(key in data)) data[key] = JSON.parse(JSON.stringify(defaults[key]));
  }
  return data;
}

function saveStore(storeName, data) {
  ensureDir();
  const filePath = getFilePath(storeName);
  const json = JSON.stringify(data, null, 2);
  const tmpPath = filePath + '.tmp';
  const backupPath = filePath + '.bak';

  // ── 자동 백업 (감사로그 제외 — 감사로그는 양이 많아서) ──
  if (storeName !== '감사로그' && storeName !== '단가이력' && fs.existsSync(filePath)) {
    try {
      const autoBackupDir = path.join(DATA_DIR, '_자동백업');
      if (!fs.existsSync(autoBackupDir)) fs.mkdirSync(autoBackupDir, { recursive: true });
      const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
      const abPath = path.join(autoBackupDir, `${storeName}_${ts}.json`);
      fs.copyFileSync(filePath, abPath);
      // 파일별 최근 20개만 유지
      const files = fs.readdirSync(autoBackupDir)
        .filter(f => f.startsWith(storeName + '_') && f.endsWith('.json'))
        .sort();
      while (files.length > 20) {
        try { fs.unlinkSync(path.join(autoBackupDir, files.shift())); } catch(e) {}
      }
    } catch (e) { /* 백업 실패해도 저장은 진행 */ }
  }

  try {
    fs.writeFileSync(tmpPath, json, 'utf8');
    JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    if (fs.existsSync(filePath)) {
      try { fs.copyFileSync(filePath, backupPath); } catch (e) {}
    }
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmpPath); } catch (e2) {}
    console.error(`❌ ${storeName}.json 저장 실패:`, e.message);
    throw e;
  }
}

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ══════════════════════════════════════════════════════
// 통합 모듈 빌드
// ══════════════════════════════════════════════════════

const db = {
  sql,
  generateId
};

// JSON 스토어 접근자 등록
for (const storeName of Object.keys(jsonStores)) {
  db[storeName] = {
    load: () => loadStore(storeName),
    save: (data) => saveStore(storeName, data)
  };
}

// ── 하위 호환 (기존 server.js 코드 대응) ────────────

// db.loadUsers() → 조직관리.json
db.loadUsers = () => loadStore('조직관리');
db.saveUsers = (data) => saveStore('조직관리', data);

// db.loadContacts() → 연락처.json
db.loadContacts = () => loadStore('연락처');
db.saveContacts = (data) => saveStore('연락처', data);

// db.load() / db.save() → SQLite가 있으면 SQLite, 없으면 JSON 폴백
if (sql) {
  // SQLite 모드: load()는 호환용으로 categories/options/vendorPrices 반환
  db.load = () => ({
    categories: sql.categories.getAll(),
    options: sql.options.getAll(),
    vendors: sql.vendors.getAll(),
    vendorPrices: [],
    quotes: sql.quotes.getAll(),
    products: []
  });
  db.save = () => {
    console.warn('⚠️ db.save()는 SQLite 모드에서 사용하지 마세요. db.sql.categories.update() 등을 사용하세요.');
  };
} else {
  // JSON 폴백 모드
  for (const storeName of Object.keys(jsonFallbackStores)) {
    db[storeName] = {
      load: () => loadStore(storeName),
      save: (data) => saveStore(storeName, data)
    };
  }
  db.load = () => loadStore('품목관리');
  db.save = (data) => saveStore('품목관리', data);
}

module.exports = db;
