const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

function makeRuleId(companyName) {
  const key = cleanText(companyName, 80)
    .toLowerCase()
    .replace(/[^a-z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return `rule_${key || crypto.randomBytes(4).toString('hex')}_${Date.now().toString(36)}`;
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

function normalizeRuleInput(input = {}, existing = null) {
  const hasAliasInput = Object.prototype.hasOwnProperty.call(input, 'companyAliases')
    || Object.prototype.hasOwnProperty.call(input, 'company_aliases');
  const rule = normalizeRule({
    ...existing,
    ...input,
    companyAliases: hasAliasInput
      ? (Array.isArray(input.companyAliases)
        ? input.companyAliases
        : String(input.companyAliases || input.company_aliases || '')
        .split(',')
        .map(v => cleanText(v, 120))
        .filter(Boolean))
      : existing?.companyAliases,
  });
  rule.id = rule.id || existing?.id || makeRuleId(rule.companyName || rule.companyFolder);
  rule.companyName = cleanText(rule.companyName, 120);
  rule.companyFolder = cleanText(rule.companyFolder, 160);
  rule.yearFolderTemplate = cleanText(rule.yearFolderTemplate || '{year} 시안작업', 160);
  rule.projectFolderTemplate = cleanText(rule.projectFolderTemplate || '{project}', 160);
  rule.projectFolderMode = ['under-year'].includes(rule.projectFolderMode) ? rule.projectFolderMode : 'under-year';
  rule.priority = Number.isFinite(rule.priority) ? Math.trunc(rule.priority) : 0;
  rule.active = rule.active !== false;
  if (!rule.companyName) throw new Error('companyName required');
  if (!rule.companyFolder) throw new Error('companyFolder required');
  if (!rule.yearFolderTemplate) throw new Error('yearFolderTemplate required');
  return rule;
}

function invalidateCache() {
  cachedRules = null;
  cachedAt = 0;
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

function listRulesFromDb({ includeInactive = false } = {}) {
  const Database = require('better-sqlite3');
  ensureDataDir();
  const db = new Database(DB_PATH);
  try {
    ensureRuleDb(db);
    const where = includeInactive ? '' : 'WHERE active = 1';
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
      ${where}
      ORDER BY active DESC, priority DESC, company_name ASC
    `).all().map(normalizeRule);
  } finally {
    db.close();
  }
}

function saveRuleToDb(input = {}) {
  const Database = require('better-sqlite3');
  ensureDataDir();
  const db = new Database(DB_PATH);
  try {
    ensureRuleDb(db);
    const existing = input.id
      ? db.prepare(`
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
        WHERE id = ?
      `).get(input.id)
      : null;
    const rule = normalizeRuleInput(input, existing ? normalizeRule(existing) : null);
    db.prepare(`
      INSERT INTO workflow_storage_rules (
        id, company_name, company_folder, company_aliases,
        year_folder_template, project_folder_template, project_folder_mode,
        priority, active, note, updated_at
      ) VALUES (
        @id, @companyName, @companyFolder, @companyAliases,
        @yearFolderTemplate, @projectFolderTemplate, @projectFolderMode,
        @priority, @active, @note, CURRENT_TIMESTAMP
      )
      ON CONFLICT(id) DO UPDATE SET
        company_name = excluded.company_name,
        company_folder = excluded.company_folder,
        company_aliases = excluded.company_aliases,
        year_folder_template = excluded.year_folder_template,
        project_folder_template = excluded.project_folder_template,
        project_folder_mode = excluded.project_folder_mode,
        priority = excluded.priority,
        active = excluded.active,
        note = excluded.note,
        updated_at = CURRENT_TIMESTAMP
    `).run({
      ...rule,
      companyAliases: JSON.stringify(rule.companyAliases || []),
      active: rule.active ? 1 : 0,
    });
    invalidateCache();
    return rule;
  } finally {
    db.close();
  }
}

function deactivateRuleInDb(id) {
  const Database = require('better-sqlite3');
  ensureDataDir();
  const db = new Database(DB_PATH);
  try {
    ensureRuleDb(db);
    const info = db.prepare(`
      UPDATE workflow_storage_rules
      SET active = 0, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
    invalidateCache();
    return info.changes > 0;
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

function listRulesFromJson({ includeInactive = false } = {}) {
  ensureDataDir();
  if (!fs.existsSync(JSON_PATH)) {
    fs.writeFileSync(JSON_PATH, JSON.stringify({ rules: DEFAULT_RULES }, null, 2), 'utf8');
  }
  const data = safeJsonParse(fs.readFileSync(JSON_PATH, 'utf8'), { rules: DEFAULT_RULES });
  const rules = Array.isArray(data.rules) ? data.rules : DEFAULT_RULES;
  return rules.map(normalizeRule)
    .filter(rule => includeInactive || rule.active)
    .sort((a, b) => Number(b.active) - Number(a.active) || b.priority - a.priority || a.companyName.localeCompare(b.companyName, 'ko'));
}

function saveRuleToJson(input = {}) {
  ensureDataDir();
  const data = fs.existsSync(JSON_PATH)
    ? safeJsonParse(fs.readFileSync(JSON_PATH, 'utf8'), { rules: DEFAULT_RULES })
    : { rules: DEFAULT_RULES };
  if (!Array.isArray(data.rules)) data.rules = [];
  const existingIndex = input.id ? data.rules.findIndex(rule => String(rule.id || '') === String(input.id)) : -1;
  const existing = existingIndex >= 0 ? normalizeRule(data.rules[existingIndex]) : null;
  const rule = normalizeRuleInput(input, existing);
  if (existingIndex >= 0) data.rules[existingIndex] = rule;
  else data.rules.push(rule);
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), 'utf8');
  invalidateCache();
  return rule;
}

function deactivateRuleInJson(id) {
  ensureDataDir();
  if (!fs.existsSync(JSON_PATH)) return false;
  const data = safeJsonParse(fs.readFileSync(JSON_PATH, 'utf8'), { rules: DEFAULT_RULES });
  if (!Array.isArray(data.rules)) data.rules = [];
  const idx = data.rules.findIndex(rule => String(rule.id || '') === String(id || ''));
  if (idx < 0) return false;
  data.rules[idx] = { ...data.rules[idx], active: false };
  fs.writeFileSync(JSON_PATH, JSON.stringify(data, null, 2), 'utf8');
  invalidateCache();
  return true;
}

function listRules(options = {}) {
  try {
    return listRulesFromDb(options);
  } catch (_) {
    return listRulesFromJson(options);
  }
}

function saveRule(input = {}) {
  try {
    return saveRuleToDb(input);
  } catch (_) {
    return saveRuleToJson(input);
  }
}

function deactivateRule(id) {
  try {
    return deactivateRuleInDb(id);
  } catch (_) {
    return deactivateRuleInJson(id);
  }
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
  deactivateRule,
  listRules,
  loadRules,
  saveRule,
};
