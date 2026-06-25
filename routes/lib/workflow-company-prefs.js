// 회사별 '프로젝트 없음' 기억 (라코스 등 — 매번 체크 안 하게).
// 저장규칙(workflow-storage-rules)과 분리한 경량 저장: 저장경로(companyFolder) 로직을 전혀 건드리지 않음.
// SQLite(업무데이터.db) 우선 + JSON 폴백. 사장님 지시: 새 저장데이터는 무조건 SQLite.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, '업무데이터.db');
const JSON_PATH = path.join(DATA_DIR, 'workflow-company-noproject.json');
const CACHE_TTL_MS = 30 * 1000;
let cached = null;
let cachedAt = 0;

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function cleanName(value) {
  return String(value || '').trim().slice(0, 160);
}

// PK 중복 방지용 정규화(공백/특수문자 제거, 소문자). 클라는 returned companyName을 자체 정규화해 매칭하므로
// 이 키가 클라 정규화와 1:1로 같을 필요는 없음(중복 합치는 용도).
function normalizeKey(name) {
  return cleanName(name).toLowerCase().replace(/[\s()[\]{}.\-_/\\]+/g, '');
}

function invalidateCache() {
  cached = null;
  cachedAt = 0;
}

function ensureDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_company_no_project (
      company_key TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      no_project INTEGER DEFAULT 1,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
}

function listFromDb() {
  const Database = require('better-sqlite3');
  ensureDataDir();
  const db = new Database(DB_PATH);
  try {
    ensureDb(db);
    return db.prepare(`
      SELECT company_name FROM workflow_company_no_project
      WHERE no_project = 1
      ORDER BY company_name ASC
    `).all().map(row => cleanName(row.company_name)).filter(Boolean);
  } finally {
    db.close();
  }
}

function setInDb(companyName, value) {
  const Database = require('better-sqlite3');
  ensureDataDir();
  const db = new Database(DB_PATH);
  try {
    ensureDb(db);
    const key = normalizeKey(companyName);
    if (!key) return;
    if (value) {
      db.prepare(`
        INSERT INTO workflow_company_no_project (company_key, company_name, no_project, updated_at)
        VALUES (@key, @name, 1, CURRENT_TIMESTAMP)
        ON CONFLICT(company_key) DO UPDATE SET
          company_name = excluded.company_name,
          no_project = 1,
          updated_at = CURRENT_TIMESTAMP
      `).run({ key, name: cleanName(companyName) });
    } else {
      db.prepare('DELETE FROM workflow_company_no_project WHERE company_key = ?').run(key);
    }
  } finally {
    db.close();
  }
}

function readJson() {
  ensureDataDir();
  if (!fs.existsSync(JSON_PATH)) return { companies: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
    return parsed && typeof parsed === 'object' && parsed.companies ? parsed : { companies: {} };
  } catch (_) {
    return { companies: {} };
  }
}

function listFromJson() {
  const data = readJson();
  return Object.values(data.companies || {})
    .filter(v => v && v.no_project)
    .map(v => cleanName(v.company_name))
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b, 'ko'));
}

function setInJson(companyName, value) {
  ensureDataDir();
  const data = readJson();
  if (!data.companies) data.companies = {};
  const key = normalizeKey(companyName);
  if (!key) return;
  if (value) data.companies[key] = { company_name: cleanName(companyName), no_project: 1 };
  else delete data.companies[key];
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), 'utf8');
}

function listNoProjectCompanies() {
  if (cached && Date.now() - cachedAt < CACHE_TTL_MS) return cached;
  try {
    cached = listFromDb();
  } catch (_) {
    cached = listFromJson();
  }
  cachedAt = Date.now();
  return cached;
}

function setCompanyNoProject(companyName, value) {
  if (!cleanName(companyName)) throw new Error('companyName required');
  try {
    setInDb(companyName, value);
  } catch (_) {
    setInJson(companyName, value);
  }
  invalidateCache();
  return listNoProjectCompanies();
}

module.exports = {
  listNoProjectCompanies,
  setCompanyNoProject,
  normalizeKey,
};
