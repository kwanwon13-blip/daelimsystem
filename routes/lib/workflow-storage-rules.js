const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const DB_PATH = path.join(DATA_DIR, '업무데이터.db');
const JSON_PATH = path.join(DATA_DIR, 'workflow-storage-rules.json');
const CACHE_TTL_MS = 30 * 1000;
let cachedRules = null;
let cachedAt = 0;

const DEFAULT_RULES = [
  {
    id: 'hyundai-development-2026',
    companyName: '현대산업개발',
    companyFolder: '★★현대산업개발',
    companyAliases: ['HDC', '아이파크', '현산'],
    yearFolderTemplate: '{year} 시안작업',
    projectFolderTemplate: '{project}',
    projectFolderMode: 'under-year',
    priority: 100,
    active: true,
    note: '현대산업개발 계열은 회사 폴더 아래 연도별 "{year} 시안작업" 폴더를 사용한다.',
  },
];

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function cleanText(value, max = 200) {
  return String(value || '').trim().slice(0, max);
}

function safeJsonParse(value, fallback) {
  try {
    const parsed = JSON.parse(value || '');
    return parsed == null ? fallback : parsed;
  } catch (_) {
    return fallback;
  }
}

function normalizeRule(row = {}) {
  return {
    id: cleanText(row.id, 80),
    companyName: cleanText(row.companyName || row.company_name, 120),
    companyFolder: cleanText(row.companyFolder || row.company_folder, 160),
    companyAliases: Array.isArray(row.companyAliases)
      ? row.companyAliases.map(v => cleanText(v, 120)).filter(Boolean)
      : safeJsonParse(row.company_aliases || row.companyAliases, []),
    yearFolderTemplate: cleanText(row.yearFolderTemplate || row.year_folder_template, 160),
    projectFolderTemplate: cleanText(row.projectFolderTemplate || row.project_folder_template, 160),
    projectFolderMode: cleanText(row.projectFolderMode || row.project_folder_mode || 'under-year', 40),
    priority: Number(row.priority || 0),
    active: row.active === undefined ? true : !!Number(row.active),
    note: cleanText(row.note, 500),
  };
}

function ensureRuleDb(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_storage_rules (
      id TEXT PRIMARY KEY,
      company_name TEXT NOT NULL,
      company_folder TEXT NOT NULL,
      company_aliases TEXT DEFAULT '[]',
      year_folder_template TEXT NOT NULL,
      project_folder_template TEXT DEFAULT '{project}',
      project_folder_mode TEXT DEFAULT 'under-year',
      priority INTEGER DEFAULT 0,
      active INTEGER DEFAULT 1,
      note TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const insert = db.prepare(`
    INSERT OR IGNORE INTO workflow_storage_rules (
      id, company_name, company_folder, company_aliases,
      year_folder_template, project_folder_template, project_folder_mode,
      priority, active, note
    ) VALUES (
      @id, @companyName, @companyFolder, @companyAliases,
      @yearFolderTemplate, @projectFolderTemplate, @projectFolderMode,
      @priority, @active, @note
    )
  `);
  for (const rule of DEFAULT_RULES) {
    insert.run({
      ...rule,
      companyAliases: JSON.stringify(rule.companyAliases || []),
      active: rule.active ? 1 : 0,
    });
  }
}

function loadRulesFromDb() {
  const Database = require('better-sqlite3');
  ensureDataDir();
  const db = new Database(DB_PATH);
  try {
    ensureRuleDb(db);
    return db.prepare(`
      SELECT
        id,
        company_name,
        company_folder,
        company_aliases,
        year_folder_template,
        project_folder_template,
        project_folder_mode,
        priority,
        active,
        note
      FROM workflow_storage_rules
      WHERE active = 1
      ORDER BY priority DESC, company_name ASC
    `).all().map(normalizeRule);
  } finally {
    db.close();
  }
}

function loadRulesFromJson() {
  ensureDataDir();
  if (!fs.existsSync(JSON_PATH)) {
    fs.writeFileSync(JSON_PATH, JSON.stringify({ rules: DEFAULT_RULES }, null, 2), 'utf8');
  }
  const data = safeJsonParse(fs.readFileSync(JSON_PATH, 'utf8'), { rules: DEFAULT_RULES });
  const rules = Array.isArray(data.rules) ? data.rules : DEFAULT_RULES;
  return rules.map(normalizeRule)
    .filter(rule => rule.active)
    .sort((a, b) => b.priority - a.priority || a.companyName.localeCompare(b.companyName, 'ko'));
}

function loadRules() {
  if (cachedRules && Date.now() - cachedAt < CACHE_TTL_MS) return cachedRules;
  try {
    cachedRules = loadRulesFromDb();
  } catch (_) {
    cachedRules = loadRulesFromJson();
  }
  cachedAt = Date.now();
  return cachedRules;
}

module.exports = {
  DEFAULT_RULES,
  loadRules,
};
