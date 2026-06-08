/**
 * lib/agent-runtime.js — Claude CLI 기반 Agent 런타임
 *
 * "Cowork-in-ERP" — 직원이 자연어로 작업 요청 → Claude 가 격리된 workspace 에서
 * 파일 읽기/쓰기/Python 실행 등으로 결과물 생성. SSE 스트리밍으로 진행 상황 전달.
 *
 * 디자인:
 *   - 사용자별 workspace: data/agent-workspace/<userId>/<sessionId>/
 *   - 첨부 파일은 workspace 에 복사
 *   - claude CLI 가 그 cwd 에서 자유롭게 작업
 *   - 결과 파일은 workspace 에 그대로 → 다운로드/미리보기
 *
 * 보안:
 *   - 사용자별 폴더 격리
 *   - 시스템 파일 접근 차단 (claude 의 --permission-mode bypassPermissions 사용,
 *     단 cwd 가 workspace 라 영향 범위가 자연 제한됨)
 *   - 작업 시간 제한 (기본 15분, AGENT_MAX_DURATION_MS 로 조정)
 *
 * 환경변수:
 *   AGENT_MAX_DURATION_MS    개별 작업 최대 시간 (기본 900000 = 15분)
 *   AGENT_WORKSPACE_ROOT     workspace 루트 (기본 data/agent-workspace)
 *   AGENT_MAX_CONCURRENT     동시 실행 슬롯 (기본 3)
 *   AGENT_PERMISSION_MODE    claude 권한 모드 (기본 bypassPermissions, 'default'/'acceptEdits' 가능)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');

const WORKSPACE_ROOT = process.env.AGENT_WORKSPACE_ROOT
  || path.join(__dirname, '..', 'data', 'agent-workspace');
const APP_ROOT = path.join(__dirname, '..');
const SKILLS_ROOT = path.join(APP_ROOT, '.claude', 'skills');
const TEMPLATE_ROOT = process.env.AGENT_SKILL_TEMPLATE_ROOT
  || path.join(APP_ROOT, 'data', 'ai-skill-templates');
const MAX_DURATION = parseInt(process.env.AGENT_MAX_DURATION_MS || '900000', 10);
const MAX_CONCURRENT = parseInt(process.env.AGENT_MAX_CONCURRENT || '3', 10);
const PERMISSION_MODE = process.env.AGENT_PERMISSION_MODE || 'bypassPermissions';
const CLAUDE_DRIVER = String(process.env.AGENT_CLAUDE_DRIVER || 'interactive').trim().toLowerCase();
const CLAUDE_MODEL = process.env.AGENT_CLAUDE_MODEL || process.env.ANTHROPIC_MODEL || 'claude-opus-4-8';
const DONE_FILE_NAME = '_agent_done.json';

const BUNDLED_SCRIPT_SKILLS = {
  'persys-ledger': 'make_persys.py',
  'haatz-ledger': 'make_haatz.py',
  'nicetech-ledger': 'make_nicetech.py',
  'partner-ledger': 'make_partner_ledger.py',
  'posco-statement': 'make_posco_statement.py',
};

// partner-ledger 대상 8개 거래처 — 단일 출처(SSOT). 탐지 정규식/단어 모두 여기서 파생.
// ⚠️ make_partner_ledger.py 의 SUPPORTED 와 동일하게 유지할 것(런타임 분리로 import 불가).
const PARTNER_LEDGER_VENDORS = ['한신공영', '요진건설', '홍지이앤씨', '삼진비티', '선두종합기술', '익스테리어앤', '한국지오텍', '금광스틸'];
const PARTNER_LEDGER_VENDOR_RE = new RegExp(PARTNER_LEDGER_VENDORS.join('|'), 'i');
const SALES_SHEET_RE = /판매현황|raw|sales/i;
const LEDGER_TEMPLATE_RE = /마감내역서|거래명세|template|템플릿|전월/i;

// workspace 루트 생성
if (!fs.existsSync(WORKSPACE_ROOT)) {
  fs.mkdirSync(WORKSPACE_ROOT, { recursive: true });
}
if (!fs.existsSync(TEMPLATE_ROOT)) {
  fs.mkdirSync(TEMPLATE_ROOT, { recursive: true });
}

// ── 동시 실행 슬롯 (Agent 는 무겁기 때문에 더 작은 풀) ──
let _activeCount = 0;
const _waiters = [];

function _acquireSlot() {
  if (_activeCount < MAX_CONCURRENT) { _activeCount++; return Promise.resolve(); }
  return new Promise(resolve => _waiters.push(resolve));
}
function _releaseSlot() {
  const next = _waiters.shift();
  if (next) next();
  else _activeCount--;
}

function getStats() {
  return { active: _activeCount, waiting: _waiters.length, max: MAX_CONCURRENT };
}

// ── 사용자별 workspace 세션 디렉터리 생성 ──
function createSession(userId) {
  const sid = Date.now().toString(36) + '_' + crypto.randomBytes(3).toString('hex');
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32) || 'anon';
  const wsDir = path.join(WORKSPACE_ROOT, safeUserId, sid);
  fs.mkdirSync(wsDir, { recursive: true });
  return { sessionId: sid, dir: wsDir };
}

// ── 첨부 파일 워크스페이스에 복사 ──
function copyAttachments(wsDir, attachmentPaths) {
  const copied = [];
  for (const item of attachmentPaths || []) {
    const src = typeof item === 'string' ? item : (item && (item.path || item.filePath));
    if (!src || !fs.existsSync(src)) continue;
    try {
      const baseName = typeof item === 'string'
        ? path.basename(src)
        : (item.originalName || item.original_name || item.name || path.basename(src));
      // 파일명 정규화 (한글/공백 OK, 특수문자만 제거)
      const safe = baseName.replace(/[<>:"/\\|?*]/g, '_');
      const dest = path.join(wsDir, safe);
      fs.copyFileSync(src, dest);
      copied.push({ original: baseName, name: safe, path: dest });
    } catch (e) {
      console.warn('[agent] 첨부 복사 실패:', src, e.message);
    }
  }
  return copied;
}

// ── 작업 후 생성된 파일 스캔 (재귀) ──
function scanWorkspaceFiles(wsDir) {
  const out = [];
  function walk(dir, rel = '') {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch(e) { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      const r = rel ? path.join(rel, e.name) : e.name;
      if (e.isDirectory()) {
        walk(full, r);
      } else if (e.isFile()) {
        let stat;
        try { stat = fs.statSync(full); } catch(_) { continue; }
        out.push({
          name: e.name,
          relPath: r,
          fullPath: full,
          size: stat.size,
          mtime: stat.mtimeMs,
          ext: path.extname(e.name).toLowerCase(),
        });
      }
    }
  }
  walk(wsDir);
  return out;
}

function isInternalAgentFile(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  return normalized === DONE_FILE_NAME;
}

function snapshotWorkspaceFiles(wsDir) {
  return new Map(scanWorkspaceFiles(wsDir).map(f => [f.relPath, {
    size: f.size,
    mtime: f.mtime,
  }]));
}

function fileChangedSinceSnapshot(file, snapshot) {
  const before = snapshot.get(file.relPath);
  if (!before) return true;
  return before.size !== file.size || Math.abs(before.mtime - file.mtime) > 1;
}

function vendorSlugFromText(s) {
  if (/포스코|posco/i.test(s)) return 'posco-statement';
  if (PARTNER_LEDGER_VENDOR_RE.test(s)) return 'partner-ledger';
  if (/퍼시스|fursys|persys/i.test(s)) return 'persys-ledger';
  if (/하츠|haatz/i.test(s)) return 'haatz-ledger';
  if (/나이스텍|nicetech/i.test(s)) return 'nicetech-ledger';
  return '';
}

function safeSkillDir(slug) {
  const clean = String(slug || '').trim().replace(/^@skill[:\s]*/i, '');
  if (!clean) return null;
  const root = path.resolve(SKILLS_ROOT);
  const resolved = path.resolve(root, clean);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return resolved;
}

function skillExists(slug) {
  const dir = safeSkillDir(slug);
  return !!(dir && fs.existsSync(path.join(dir, 'SKILL.md')));
}

function readInstalledSkillRefs() {
  const out = [];
  if (!fs.existsSync(SKILLS_ROOT)) return out;
  const walk = (dir, depth = 0) => {
    if (depth > 3) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const child = path.join(dir, ent.name);
      const mdPath = path.join(child, 'SKILL.md');
      if (fs.existsSync(mdPath)) {
        const slug = path.relative(SKILLS_ROOT, child).replace(/[\\/]+/g, '/');
        let name = '';
        let description = '';
        try {
          const raw = fs.readFileSync(mdPath, 'utf8');
          const fm = (raw.match(/^---\n([\s\S]*?)\n---/) || [])[1] || '';
          name = ((fm.match(/^name:\s*(.+)$/m) || [])[1] || '').trim();
          description = ((fm.match(/^description:\s*([\s\S]+?)(?=\n[a-zA-Z_-]+:|$)/m) || [])[1] || '')
            .trim().replace(/\s+/g, ' ').slice(0, 700);
        } catch (_) {}
        out.push({ slug, name, description });
      }
      walk(child, depth + 1);
    }
  };
  walk(SKILLS_ROOT);
  return out;
}

function detectExplicitSkillSlug(text) {
  const s = String(text || '');
  const direct = s.match(/(?:@skill|skill|스킬)\s*[:=]?\s*([a-z0-9][a-z0-9._/-]{1,80})/i);
  if (direct && skillExists(direct[1])) return direct[1].replace(/[\\/]+/g, '/');
  const lower = s.toLowerCase();
  for (const skill of readInstalledSkillRefs()) {
    const slugLower = skill.slug.toLowerCase();
    const nameLower = String(skill.name || '').toLowerCase();
    if (lower.includes(slugLower)) return skill.slug;
    if (nameLower && nameLower.length >= 2 && lower.includes(nameLower)) return skill.slug;
  }
  return '';
}

const SKILL_STOPWORDS = new Set([
  'skill', 'skills', 'ledger', 'auto', 'download', 'upload', 'api', 'app',
  '스킬', '사용', '요청', '작업', '자동', '적용', '파일', '첨부', '생성', '처리',
  '정리', '엑셀', '형식', '기준', '대림에스엠', '합니다', '하세요',
]);

function normalizeSkillText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}@._/-]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function skillTokens(text) {
  return normalizeSkillText(text)
    .split(' ')
    .map(t => t.trim())
    .filter(t => t.length >= 2 && !SKILL_STOPWORDS.has(t));
}

function quotedSkillPhrases(text) {
  const out = [];
  const raw = String(text || '');
  const re = /["“”']([^"“”']{2,60})["“”']/g;
  let m;
  while ((m = re.exec(raw))) out.push(normalizeSkillText(m[1]));
  return out.filter(Boolean);
}

function scoreSkillForText(skill, text) {
  const hay = normalizeSkillText(text);
  if (!hay) return 0;
  const slug = normalizeSkillText(skill.slug);
  const name = normalizeSkillText(skill.name);
  const desc = String(skill.description || '');
  let score = 0;

  if (slug && hay.includes(slug)) score += 90;
  if (name && name !== slug && hay.includes(name)) score += 80;

  const slugParts = slug.split(/[\/._-]+/).filter(t => t.length >= 3 && !SKILL_STOPWORDS.has(t));
  for (const part of slugParts) {
    if (hay.includes(part)) score += 22;
  }

  for (const phrase of quotedSkillPhrases(desc)) {
    if (phrase && hay.includes(phrase)) score += 55;
  }

  const tokenSet = new Set(skillTokens(`${skill.name} ${skill.slug} ${desc}`));
  let tokenHits = 0;
  let strongTokenHits = 0;
  for (const token of tokenSet) {
    if (!hay.includes(token)) continue;
    tokenHits++;
    if (token.length >= 4 || /^[a-z0-9]{3,}$/i.test(token)) strongTokenHits++;
  }
  score += Math.min((tokenHits * 5) + (strongTokenHits * 13), 45);

  const hasAnchor = score >= 40 || strongTokenHits > 0 || slugParts.some(part => hay.includes(part));
  return hasAnchor ? score : 0;
}

function detectAutoSkillSlug(text) {
  const ranked = readInstalledSkillRefs()
    .map(skill => ({ skill, score: scoreSkillForText(skill, text) }))
    .filter(x => x.score >= 20)
    .sort((a, b) => b.score - a.score);
  return ranked[0] ? ranked[0].skill.slug : '';
}

// 첨부된 판매현황 xlsx 1행 헤더(A1)의 회사명으로 거래처 감지 — exceljs 사용(서버에 xlsx 모듈 없음)
async function detectVendorFromAttachments(attachments = []) {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (_) { return ''; }
  for (const a of attachments) {
    const p = a && a.path;
    if (!p || !/\.xlsx$/i.test(p) || !fs.existsSync(p)) continue;
    try {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.readFile(p);
      const ws = wb.getWorksheet('판매현황') || wb.worksheets[0];
      if (!ws) continue;
      const a1 = ws.getCell('A1').value;
      const slug = vendorSlugFromText(String(a1 == null ? '' : (a1.text || a1)));
      if (slug) return slug;
    } catch (_) { continue; }
  }
  return '';
}

async function detectLedgerSkillSlug(task, attachments = []) {
  const text = [
    String(task || ''),
    ...(attachments || []).map(a => `${a.original || ''} ${a.name || ''}`),
  ].join(' ');
  // 0) 사용자가 @skill 또는 스킬명을 직접 적으면 그 스킬을 우선 적용
  const explicit = detectExplicitSkillSlug(text);
  if (explicit) return explicit;
  // 1) task/파일명에 회사명이 직접 있으면 그걸로
  const direct = vendorSlugFromText(text);
  if (direct) return direct;
  // 2) SKILL.md name/description 기반 자동 라우팅
  const auto = detectAutoSkillSlug(text);
  if (auto) return auto;
  // 3) "마감/거래명세서/원장/정리" 업무 키워드 + 판매현황 첨부면, 첨부 헤더 회사명으로 감지
  //    (예: "각자 회사별로 원장 만들어줘" 처럼 회사명을 안 적은 경우)
  if (/마감|거래명세|명세서|원장|정리|내역서|청구|판매현황/.test(text)) {
    return await detectVendorFromAttachments(attachments);
  }
  return '';
}

function loadSkillContext(slug) {
  if (!slug) return [];
  const skillDir = safeSkillDir(slug);
  if (!skillDir) return [];
  const skillMd = path.join(skillDir, 'SKILL.md');
  if (!fs.existsSync(skillMd)) return [];
  // 번들 스크립트 경로 먼저 수집
  const scriptsDir = path.join(skillDir, 'scripts');
  let scripts = [];
  if (fs.existsSync(scriptsDir)) {
    scripts = fs.readdirSync(scriptsDir, { withFileTypes: true })
      .filter(ent => ent.isFile() && /\.(py|js|mjs|ps1|bat)$/i.test(ent.name))
      .map(ent => path.join(scriptsDir, ent.name));
  }
  const lines = [
    '## ★★ 반드시 적용할 업무 스킬 (필수) ★★',
    '',
    `- 스킬: ${slug}`,
    '- **이 작업은 반드시 아래 번들 스크립트를 실행해서 처리한다. 절대 직접 코드(make_ledger.py 등)를 새로 만들지 말 것.**',
    '- **"원장 / 정리본 / 요약 / 분석표 / 매출원장" 같은 다른 형식을 만들지 말 것.** 이 스킬은 정해진 거래명세서(마감내역서) 양식만 생성한다.',
    '- 사용자가 "원장", "회사별로", "정리" 라고 말해도 → 그 의미는 이 스킬의 거래명세서 생성이다.',
    '- 현재 첨부 파일만 원본 데이터로 사용한다. 전월 템플릿이 필요한데 없으면, 추정하지 말고 "전월 마감 파일이 필요하다"고 사용자에게 요청한다.',
  ];
  if (scripts.length) {
    lines.push('', '### 실행할 스크립트 (이것만 실행)', ...scripts.map(s => `- ${s}`),
      '', '실행 예: python "' + scripts[0] + '" --raw "<첨부 판매현황.xlsx>" [--template "<전월 마감파일>"] [--outdir "<폴더>"]',
      '※ 스크립트의 --help 또는 상단 주석에서 정확한 인자명을 먼저 확인하고 실행할 것.');
  }
  lines.push('', '--- 스킬 상세 절차 ---', '',
    fs.readFileSync(skillMd, 'utf8').replace(/^---\n[\s\S]*?\n---\s*/, '').trim(), '');
  return lines;
}

function resolvePythonCommand() {
  const candidates = [];
  if (process.env.AGENT_PYTHON) candidates.push({ cmd: process.env.AGENT_PYTHON, prefix: [] });
  if (process.env.AGENT_PYTHON_EXE) candidates.push({ cmd: process.env.AGENT_PYTHON_EXE, prefix: [] });
  if (process.env.PYTHON) candidates.push({ cmd: process.env.PYTHON, prefix: [] });
  if (process.env.PYTHON_EXE) candidates.push({ cmd: process.env.PYTHON_EXE, prefix: [] });
  const bundled = path.join(process.env.USERPROFILE || '', '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', 'python.exe');
  if (bundled && fs.existsSync(bundled)) candidates.push({ cmd: bundled, prefix: [] });
  candidates.push({ cmd: 'python', prefix: [] }, { cmd: 'py', prefix: ['-3'] });
  for (const c of candidates) {
    try {
      const test = spawnSync(c.cmd, [...c.prefix, '--version'], { encoding: 'utf8', windowsHide: true });
      if (!test.error && test.status === 0) return c;
    } catch (_) {}
  }
  return null;
}

function sanitizeStoredTemplateName(name) {
  const ext = path.extname(String(name || '')).toLowerCase() || '.xlsx';
  const base = path.basename(String(name || 'template.xlsx'), ext)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120) || 'template';
  return `${base}${ext}`;
}

function getSkillTemplateDir(skillSlug) {
  const dir = safeSkillDir(skillSlug);
  if (!dir) return null;
  const root = path.resolve(TEMPLATE_ROOT);
  const resolved = path.resolve(root, String(skillSlug).replace(/[\\/]+/g, '_'));
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function listStoredTemplates(skillSlug) {
  const dir = getSkillTemplateDir(skillSlug);
  if (!dir || !fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter(ent => ent.isFile() && /\.xlsx$/i.test(ent.name) && !ent.name.startsWith('~$'))
    .map(ent => {
      const full = path.join(dir, ent.name);
      let stat = null;
      try { stat = fs.statSync(full); } catch (_) {}
      return { name: ent.name, path: full, mtimeMs: stat ? stat.mtimeMs : 0 };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
}

function storeSkillTemplates(skillSlug, templates = []) {
  const dir = getSkillTemplateDir(skillSlug);
  if (!dir) return [];
  const saved = [];
  for (const t of templates || []) {
    if (!t || !t.path || !fs.existsSync(t.path)) continue;
    try {
      const safeName = sanitizeStoredTemplateName(t.original || t.name || path.basename(t.path));
      const dest = path.join(dir, safeName);
      fs.copyFileSync(t.path, dest);
      try {
        const now = new Date();
        fs.utimesSync(dest, now, now);
      } catch (_) {}
      saved.push({ name: safeName, path: dest });
    } catch (e) {
      console.warn('[agent/skill-template] 저장 실패:', t.path, e.message);
    }
  }
  return saved;
}

function resolveStoredTemplateArg(skillSlug) {
  if (skillSlug === 'haatz-ledger'
      || skillSlug === 'nicetech-ledger'
      || skillSlug === 'persys-ledger'
      || skillSlug === 'partner-ledger'
      || skillSlug === 'posco-statement') {
    return getSkillTemplateDir(skillSlug) || '';
  }
  const stored = listStoredTemplates(skillSlug);
  if (!stored.length) return '';
  if (stored.length === 1) return stored[0].path;
  return stored[0].path;
}

function exceljsValueText(value) {
  if (value == null) return '';
  if (typeof value !== 'object') return String(value);
  if (Object.prototype.hasOwnProperty.call(value, 'text')) return String(value.text || '');
  if (Object.prototype.hasOwnProperty.call(value, 'result')) return exceljsValueText(value.result);
  if (Array.isArray(value.richText)) return value.richText.map(r => r.text || '').join('');
  if (value.formula) return exceljsValueText(value.result);
  return String(value);
}

async function classifySkillXlsxFiles(attachments, skillSlug, options = {}) {
  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (_) { ExcelJS = null; }
  const files = (attachments || []).filter(a => a && a.path && /\.xlsx$/i.test(a.path) && fs.existsSync(a.path));
  const raw = [];
  const templates = [];
  const vendorWords = {
    'persys-ledger': ['퍼시스', 'fursys', 'persys'],
    'haatz-ledger': ['하츠', 'haatz'],
    'nicetech-ledger': ['나이스텍', 'nicetech'],
    'partner-ledger': PARTNER_LEDGER_VENDORS,
    'posco-statement': ['포스코', '포스코이앤씨', 'posco'],
  }[skillSlug] || [];

  for (const a of files) {
    const name = `${a.original || ''} ${a.name || ''}`.toLowerCase();
    let fileSize = 0;
    try { fileSize = fs.statSync(a.path).size || 0; } catch (_) {}
    let fileSkill = vendorSlugFromText(name);
    let sheetNames = [];
    let sampleText = '';
    if (ExcelJS) {
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(a.path);
        sheetNames = wb.worksheets.map(ws => String(ws.name || ''));
        const ws = wb.getWorksheet('판매현황') || wb.worksheets[0];
        if (ws) {
          const a1 = ws.getCell('A1').value;
          const pieces = [exceljsValueText(a1)];
          for (let r = 1; r <= Math.min(ws.rowCount || 0, 8); r++) {
            for (let c = 1; c <= Math.min(ws.columnCount || 0, 18); c++) {
              pieces.push(exceljsValueText(ws.getCell(r, c).value));
            }
          }
          sampleText = pieces.join(' ');
          fileSkill = fileSkill || vendorSlugFromText(sampleText);
        }
      } catch (_) {}
    }
    if (fileSkill && fileSkill !== skillSlug) continue;
    const sheetText = sheetNames.join(' ').toLowerCase();
    const combined = `${name} ${sheetText} ${sampleText}`;
    let looksRaw = sheetNames.some(n => SALES_SHEET_RE.test(n)) || SALES_SHEET_RE.test(name);
    let looksTemplate = LEDGER_TEMPLATE_RE.test(combined)
      || vendorWords.some(w => name.includes(w.toLowerCase())) && !looksRaw;
    if (skillSlug === 'partner-ledger') {
      const hasRawHeaders = /거래처명/.test(sampleText) && /프로젝트명/.test(sampleText) && /품목코드/.test(sampleText);
      const hasTemplateHeaders = /일자-No\./.test(sampleText) && /품목명/.test(sampleText) && /수량/.test(sampleText) && /단가/.test(sampleText) && /공급가액/.test(sampleText) && !hasRawHeaders;
      looksRaw = hasRawHeaders || (looksRaw && !hasTemplateHeaders);
      looksTemplate = hasTemplateHeaders || (LEDGER_TEMPLATE_RE.test(combined) && !hasRawHeaders);
    }
    if (skillSlug === 'posco-statement') {
      const hasRawHeaders = /일자-No\./.test(sampleText) && /거래처명/.test(sampleText) && /프로젝트명/.test(sampleText) && /적요/.test(sampleText) && /공급가액/.test(sampleText);
      const hasTemplateHeaders = /25년 코드/.test(sampleText) || /단가계약 품목/.test(combined) || /구매사코드/.test(sampleText) || /거래 명세표/.test(sampleText);
      looksRaw = hasRawHeaders || (looksRaw && !hasTemplateHeaders);
      looksTemplate = hasTemplateHeaders && !hasRawHeaders;
    }
    if (options.strictTemplates && !looksRaw && !fileSkill) {
      const matchesThisSkill = vendorWords.some(w => combined.includes(String(w).toLowerCase()));
      if (!matchesThisSkill) continue;
    }
    if (looksRaw) raw.push(a);
    else if (looksTemplate && fileSize >= 20000) templates.push(a);
  }
  return { raw: raw[0] || null, template: templates[0] || null, templates, files };
}

async function detectBundledSkillSlugs(task, attachments = []) {
  const found = new Set();
  const text = [
    String(task || ''),
    ...(attachments || []).map(a => `${a.original || ''} ${a.name || ''}`),
  ].join(' ');
  const textSkill = vendorSlugFromText(text);
  if (textSkill && BUNDLED_SCRIPT_SKILLS[textSkill]) found.add(textSkill);

  let ExcelJS;
  try { ExcelJS = require('exceljs'); } catch (_) { ExcelJS = null; }
  for (const a of attachments || []) {
    if (!a || !a.path || !/\.xlsx$/i.test(a.path) || !fs.existsSync(a.path)) continue;
    let skill = vendorSlugFromText(`${a.original || ''} ${a.name || ''}`);
    if (!skill && ExcelJS) {
      try {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.readFile(a.path);
        const ws = wb.getWorksheet('판매현황') || wb.worksheets[0];
        if (ws) {
          const a1 = ws.getCell('A1').value;
          skill = vendorSlugFromText(String(a1 == null ? '' : (a1.text || a1)));
        }
      } catch (_) {}
    }
    if (skill && BUNDLED_SCRIPT_SKILLS[skill]) found.add(skill);
  }

  if (!found.size) {
    const single = await detectLedgerSkillSlug(task, attachments);
    if (single && BUNDLED_SCRIPT_SKILLS[single]) found.add(single);
  }
  return [...found];
}

async function* runBundledScriptSkill({ skillSlug, session, attachments, baseFiles, signal, strictTemplates = false }) {
  const scriptName = BUNDLED_SCRIPT_SKILLS[skillSlug];
  const skillDir = safeSkillDir(skillSlug);
  const scriptPath = skillDir && scriptName ? path.join(skillDir, 'scripts', scriptName) : '';
  if (!scriptPath || !fs.existsSync(scriptPath)) {
    yield { type: 'error', data: { message: `스킬 스크립트를 찾지 못했습니다: ${skillSlug}` } };
    return;
  }

  const py = resolvePythonCommand();
  if (!py) {
    yield { type: 'error', data: { message: '서버에서 Python 실행 파일을 찾지 못했습니다. AGENT_PYTHON_EXE 환경변수 또는 python/py 등록이 필요합니다.' } };
    return;
  }

  const classified = await classifySkillXlsxFiles(attachments, skillSlug, {
    strictTemplates,
  });
  const savedTemplates = classified.templates.length
    ? storeSkillTemplates(skillSlug, classified.templates)
    : [];
  if (!classified.raw) {
    if (savedTemplates.length) {
      yield { type: 'output', data: {
        text: `템플릿 저장 완료: ${skillSlug}\n${savedTemplates.map(t => `- ${t.name}`).join('\n')}\n다음부터는 판매현황 파일만 첨부해도 이 템플릿을 자동 사용합니다.\n`,
      }};
      yield { type: 'done', data: {
        sessionId: session.sessionId,
        dir: session.dir,
        exitCode: 0,
        durationMs: 0,
        files: [],
        templateSaved: savedTemplates.map(t => t.name),
      }};
      return;
    }
    yield { type: 'error', data: { message: `${skillSlug} 스킬을 실행하려면 '판매현황' 시트가 있는 원본 xlsx 첨부가 필요합니다. 템플릿 저장만 하려면 전월 마감내역서 xlsx를 첨부하세요.` } };
    return;
  }

  const storedTemplateArg = resolveStoredTemplateArg(skillSlug);
  const args = [
    ...py.prefix,
    scriptPath,
    '--raw', classified.raw.path,
    '--outdir', session.dir,
  ];
  if (storedTemplateArg) args.push('--template', storedTemplateArg);

  const templateLabel = savedTemplates.length
    ? `첨부 템플릿 저장/사용: ${savedTemplates.map(t => t.name).join(', ')}`
    : (storedTemplateArg ? `저장된 템플릿 사용: ${path.basename(storedTemplateArg)}` : '템플릿: 첨부/저장 템플릿 없음');
  yield { type: 'output', data: { text: `스킬 실행: ${skillSlug}\n원본: ${classified.raw.name}\n${templateLabel}\n` } };

  const startedAt = Date.now();
  const beforeRunFiles = snapshotWorkspaceFiles(session.dir);
  const child = spawn(py.cmd, args, {
    cwd: session.dir,
    env: { ...process.env, LANG: 'ko_KR.UTF-8', PYTHONIOENCODING: 'utf-8' },
    windowsHide: true,
    shell: false,
  });

  const stdoutQueue = [];
  const stderrQueue = [];
  let exited = false, exitCode = null, stdoutAll = '', stderrAll = '';
  let timedOut = false;
  const killTimer = setTimeout(() => {
    timedOut = true;
    try { child.kill('SIGTERM'); } catch (_) {}
    setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 5000);
  }, MAX_DURATION);

  if (signal) {
    signal.addEventListener('abort', () => {
      try { child.kill('SIGTERM'); } catch (_) {}
      setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} }, 3000);
    }, { once: true });
  }

  child.stdout.on('data', d => { const s = d.toString('utf8'); stdoutAll += s; stdoutQueue.push(s); });
  child.stderr.on('data', d => { const s = d.toString('utf8'); stderrAll += s; stderrQueue.push(s); });
  child.on('close', code => { exited = true; exitCode = code; });
  child.on('error', e => {
    const s = '[child error] ' + e.message;
    stderrAll += s;
    stderrQueue.push(s);
    exited = true;
    exitCode = -1;
  });

  while (!exited || stdoutQueue.length || stderrQueue.length) {
    while (stdoutQueue.length) yield { type: 'output', data: { text: stdoutQueue.shift() } };
    while (stderrQueue.length) yield { type: 'stderr', data: { text: stderrQueue.shift() } };
    if (!exited) await new Promise(r => setTimeout(r, 100));
  }
  clearTimeout(killTimer);

  const finalFiles = scanWorkspaceFiles(session.dir)
    .filter(f => fileChangedSinceSnapshot(f, beforeRunFiles));
  for (const f of finalFiles) {
    yield { type: 'file', data: { name: f.name, relPath: f.relPath, size: f.size, ext: f.ext } };
  }

  if (timedOut) {
    yield { type: 'error', data: {
      message: `스킬 실행 시간 초과 (${Math.round(MAX_DURATION / 1000)}초)`,
      exitCode, sessionId: session.sessionId, dir: session.dir,
      files: finalFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
    }};
    return;
  }

  if (exitCode !== 0) {
    const tail = (stderrAll || stdoutAll || '').trim().slice(-1200);
    // 마감 스킬 종료코드 → 머신 코드(프런트가 코드별 안내·액션 버튼 띄우는 데 사용).
    // make_*.py 공통: 1=원본없음 2=템플릿없음 3=판매현황시트없음 4=템플릿시트깨짐 5=데이터0 6=결과0
    const codeMap = { 1: 'RAW_MISSING', 2: 'TEMPLATE_MISSING', 3: 'NO_SALES_SHEET', 4: 'BAD_TEMPLATE', 5: 'NO_DATA', 6: 'NO_OUTPUT' };
    const errorCode = codeMap[exitCode] || null;
    yield { type: 'error', data: {
      message: `스킬 실행 실패 (${skillSlug}, exit ${exitCode})${tail ? ': ' + tail : ''}`,
      code: errorCode, skillSlug, exitCode, sessionId: session.sessionId, dir: session.dir,
      files: finalFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
    }};
    return;
  }

  yield { type: 'done', data: {
    sessionId: session.sessionId,
    dir: session.dir,
    exitCode,
    durationMs: Date.now() - startedAt,
    files: finalFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
    templateSaved: savedTemplates.map(t => t.name),
  }};
}

// ── 시스템 프롬프트: Agent 에게 환경 안내 ──
async function buildSystemContext(session, attachments, task = '') {
  let lines = [
    '# Agent 작업 환경 안내',
    '',
    '당신은 대림에스엠 ERP 의 AI 도우미입니다. 다음 환경에서 작업하세요:',
    '',
    `- 현재 작업 디렉터리(workspace): ${session.dir}`,
    '- 이 폴더 안에서만 파일을 만들고/수정/실행하세요',
    '- 절대 시스템 다른 곳을 건드리지 마세요',
    '- Python (pandas, openpyxl, matplotlib, python-pptx, python-docx) 실행 가능',
    '- Node.js 도 가능 (exceljs, sharp, pdfkit, jszip 사용 가능)',
    '- 결과물은 이 workspace 안에 파일로 저장. 사용자가 다운로드해서 사용함',
    '- 한국어로 작업 진행 상황을 짧게 설명하면서 진행',
    '- 회사 정보: 대림에스엠 (안전 종합 그룹, 단가표/견적/시안 업무)',
    '',
  ];
  if (attachments && attachments.length) {
    lines.push('## 첨부 파일');
    for (const a of attachments) {
      lines.push(`- ${a.name} (${(a.path)})`);
    }
    lines.push('');
  }
  const skillSlug = await detectLedgerSkillSlug(task, attachments);
  lines.push(...loadSkillContext(skillSlug));
  lines.push('## 사용자 요청');
  return lines.join('\n');
}

/**
 * Agent 작업 실행 (async generator — 이벤트 스트리밍)
 *
 * yield 되는 이벤트:
 *   { type: 'queued', data: { waiting } }              슬롯 대기 시작
 *   { type: 'started', data: { sessionId, dir } }      작업 시작
 *   { type: 'output', data: { text } }                 stdout 한 청크
 *   { type: 'stderr', data: { text } }                 stderr 한 청크
 *   { type: 'file', data: { name, relPath, size, ext } } 새로 생성된 파일 감지
 *   { type: 'done', data: { sessionId, dir, files, exitCode, durationMs } }
 *   { type: 'error', data: { message } }
 *
 * @param {Object} opts
 * @param {string} opts.userId - 사용자 ID (workspace 격리용)
 * @param {string} opts.task - 작업 요청 자연어
 * @param {string[]} [opts.attachmentPaths] - 첨부 파일 절대경로 배열
 * @param {AbortSignal} [opts.signal] - 취소용 시그널
 */
async function* runAgent({ userId, task, attachmentPaths = [], signal } = {}) {
  if (!task || !String(task).trim()) {
    yield { type: 'error', data: { message: 'task 가 비어있습니다' } };
    return;
  }

  // 슬롯 대기 시작
  const queueStart = Date.now();
  yield { type: 'queued', data: { ...getStats() } };
  await _acquireSlot();
  const queueWaitMs = Date.now() - queueStart;

  const session = createSession(userId || 'anon');
  const attachments = copyAttachments(session.dir, attachmentPaths);
  const startedAt = Date.now();
  const baseFileSnapshot = snapshotWorkspaceFiles(session.dir);
  const baseFiles = new Set(baseFileSnapshot.keys());

  try {
    yield { type: 'started', data: {
      sessionId: session.sessionId,
      dir: session.dir,
      attachments: attachments.map(a => a.name),
      queueWaitMs,
    }};

    const bundledSkillSlugs = await detectBundledSkillSlugs(task, attachments);
    if (bundledSkillSlugs.length) {
      for (const skillSlug of bundledSkillSlugs) {
        yield { type: 'output', data: { text: `\n[${skillSlug}] 작업을 시작합니다.\n` } };
        for await (const evt of runBundledScriptSkill({
          skillSlug,
          session,
          attachments,
          baseFiles,
          signal,
          strictTemplates: bundledSkillSlugs.length > 1,
        })) {
          if (evt.type === 'file' && evt.data?.relPath) baseFiles.add(evt.data.relPath);
          if (evt.type === 'done' && Array.isArray(evt.data?.files)) {
            for (const f of evt.data.files) {
              if (f && f.relPath) baseFiles.add(f.relPath);
            }
          }
          yield evt;
        }
      }
      const batchFiles = scanWorkspaceFiles(session.dir)
        .filter(f => fileChangedSinceSnapshot(f, baseFileSnapshot))
        .map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext }));
      yield { type: 'done', data: {
        sessionId: session.sessionId,
        dir: session.dir,
        exitCode: 0,
        durationMs: Date.now() - startedAt,
        files: batchFiles,
      }};
      return;
    }

    const systemContext = await buildSystemContext(session, attachments, task);
    const doneFilePath = path.join(session.dir, DONE_FILE_NAME);
    const doneInstruction = [
      '',
      '=== ERP agent completion protocol ===',
      `When every requested task is complete, create ${DONE_FILE_NAME} in the current working directory.`,
      'The file must be valid JSON with keys: status, summary, files.',
      'Do not create the done file until all files are written and closed.',
    ].join('\n');
    const fullPrompt = systemContext + '\n\n' + task.trim() + doneInstruction;

    // claude CLI driver. Interactive mode mirrors a real Claude Code terminal session;
    // set AGENT_CLAUDE_DRIVER=print to use the old headless -p path.
    const useInteractiveDriver = CLAUDE_DRIVER !== 'print' && CLAUDE_DRIVER !== 'headless';
    const args = useInteractiveDriver
      ? ['--model', CLAUDE_MODEL, '--dangerously-skip-permissions', '--add-dir', APP_ROOT]
      : ['-p', '--model', CLAUDE_MODEL, '--permission-mode', PERMISSION_MODE, '--add-dir', APP_ROOT];
    const child = spawn('claude', args, {
      cwd: session.dir,                         // workspace 안에서만 작업
      env: { ...process.env, TERM: 'dumb', NO_COLOR: '1', LANG: 'ko_KR.UTF-8' },
      windowsHide: true,
      shell: true,
    });
    yield { type: 'output', data: { text: `[claude-driver] ${useInteractiveDriver ? 'interactive' : 'print'} / ${CLAUDE_MODEL}\n` } };

    // 타임아웃
    let timedOut = false;
    const killTimer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGTERM'); } catch(_) {}
      // SIGTERM 으로 안 죽으면 5초 뒤 SIGKILL
      setTimeout(() => { try { child.kill('SIGKILL'); } catch(_) {} }, 5000);
    }, MAX_DURATION);

    // AbortSignal (사용자 취소 버튼 등)
    // ⚠️ Windows + shell:true 는 child 가 cmd.exe 래퍼라 child.kill 은 래퍼만 죽이고
    //    실제 claude(손자) 는 남을 수 있다. 그래서 stdin 을 닫아(EOF) claude 가 스스로
    //    종료하도록 유도 + 루프의 signal.aborted 체크로 finalize 는 즉시 진행한다.
    if (signal) {
      signal.addEventListener('abort', () => {
        try { child.stdin.end(); } catch(_) {}          // EOF → claude 자체 종료 유도
        try { child.kill('SIGTERM'); } catch(_) {}
        setTimeout(() => { try { child.kill('SIGKILL'); } catch(_) {} }, 3000);
      }, { once: true });
    }

    // ── 출력 리스너 먼저 등록 (race condition 방지) ──
    const stdoutQueue = [];
    const stderrQueue = [];
    let exited = false, exitCode = null;

    child.stdout.on('data', d => { stdoutQueue.push(d.toString('utf8')); });
    child.stderr.on('data', d => { stderrQueue.push(d.toString('utf8')); });
    child.on('close', code => { exited = true; exitCode = code; });
    child.on('error', e => {
      stderrQueue.push('[child error] ' + e.message);
      exited = true; exitCode = -1;
    });

    // stdin 으로 prompt 주입 (리스너 등록 후)
    try {
      child.stdin.write(fullPrompt + (useInteractiveDriver ? '\r' : ''), 'utf8');
      if (!useInteractiveDriver) child.stdin.end();
    } catch (e) {
      yield { type: 'error', data: { message: 'stdin write 실패: ' + e.message } };
      try { child.kill('SIGTERM'); } catch(_) {}
      return;
    }

    let lastFileScan = 0;
    let exitSent = false;
    while (!exited || stdoutQueue.length || stderrQueue.length) {
      // stdout drain
      while (stdoutQueue.length) {
        yield { type: 'output', data: { text: stdoutQueue.shift() } };
      }
      while (stderrQueue.length) {
        yield { type: 'stderr', data: { text: stderrQueue.shift() } };
      }
      // ★ 사용자 중단(stop): 자식이 즉시 안 죽어도(특히 Windows shell 래퍼 손자)
      //   남은 출력만 비우고 루프를 끝내 finalize 가 바로 돌게 한다.
      //   안 그러면 message 가 MAX_DURATION(15분)까지 'generating' 에 멈춤.
      if (signal && signal.aborted) break;
      // 1초마다 파일 감시
      const now = Date.now();
      if (now - lastFileScan > 1000) {
        lastFileScan = now;
        const current = scanWorkspaceFiles(session.dir);
        for (const f of current) {
          if (!baseFiles.has(f.relPath) && !isInternalAgentFile(f.relPath)) {
            baseFiles.add(f.relPath);
            yield { type: 'file', data: {
              name: f.name, relPath: f.relPath, size: f.size, ext: f.ext,
            }};
          }
        }
      }
      if (useInteractiveDriver && !exitSent && fs.existsSync(doneFilePath)) {
        exitSent = true;
        yield { type: 'output', data: { text: '\n[claude-driver] completion file detected, closing session\n' } };
        try { child.stdin.write('/exit\r', 'utf8'); } catch(_) {}
        setTimeout(() => { try { child.stdin.end(); } catch(_) {} }, 500);
      }
      if (!exited) await new Promise(r => setTimeout(r, 100));
    }

    clearTimeout(killTimer);

    // 최종 파일 스캔
    const finalFiles = scanWorkspaceFiles(session.dir);
    const newFiles = finalFiles
      .filter(f => !isInternalAgentFile(f.relPath))
      .filter(f => fileChangedSinceSnapshot(f, baseFileSnapshot));

    // ★ 사용자 중단: 부분 산출물과 함께 done(aborted)으로 마감 →
    //   라우터가 userStopped 기준으로 status='interrupted' 표기 + 친절 안내.
    if (signal && signal.aborted) {
      yield { type: 'done', data: {
        sessionId: session.sessionId, dir: session.dir, exitCode,
        durationMs: Date.now() - startedAt, aborted: true,
        files: newFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
      }};
      return;
    }

    if (timedOut) {
      yield { type: 'error', data: {
        message: `작업 시간 초과 (${Math.round(MAX_DURATION/1000)}초)`,
        exitCode, sessionId: session.sessionId, dir: session.dir,
        files: newFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
      }};
      return;
    }

    if (exitCode !== 0) {
      yield { type: 'error', data: {
        message: `Claude CLI 작업 실패 (exit ${exitCode})`,
        exitCode, sessionId: session.sessionId, dir: session.dir,
        files: newFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
      }};
      return;
    }

    yield { type: 'done', data: {
      sessionId: session.sessionId,
      dir: session.dir,
      exitCode,
      durationMs: Date.now() - startedAt,
      files: newFiles.map(f => ({ name: f.name, relPath: f.relPath, size: f.size, ext: f.ext })),
    }};
  } catch (e) {
    yield { type: 'error', data: { message: e.message, stack: e.stack } };
  } finally {
    _releaseSlot();
  }
}

// ── 세션 정리 (작업 후 일정 시간 지나면 workspace 삭제) ──
const SESSION_TTL_MS = parseInt(process.env.AGENT_SESSION_TTL_MS || '86400000', 10); // 24시간
function cleanupOldSessions() {
  try {
    if (!fs.existsSync(WORKSPACE_ROOT)) return;
    const userDirs = fs.readdirSync(WORKSPACE_ROOT, { withFileTypes: true })
      .filter(e => e.isDirectory());
    const cutoff = Date.now() - SESSION_TTL_MS;
    for (const u of userDirs) {
      const userDir = path.join(WORKSPACE_ROOT, u.name);
      const sessions = fs.readdirSync(userDir, { withFileTypes: true })
        .filter(e => e.isDirectory());
      for (const s of sessions) {
        const sDir = path.join(userDir, s.name);
        try {
          const stat = fs.statSync(sDir);
          if (stat.mtimeMs < cutoff) {
            fs.rmSync(sDir, { recursive: true, force: true });
          }
        } catch(_) {}
      }
    }
  } catch (e) {
    console.warn('[agent] cleanup 실패:', e.message);
  }
}
// 1시간마다 자동 청소 (unref 로 프로세스 종료 막지 않음)
const _cleanupTimer = setInterval(cleanupOldSessions, 3600000);
if (_cleanupTimer && _cleanupTimer.unref) _cleanupTimer.unref();

// ── 세션 폴더 → URL 매핑 (다운로드용) ──
// /api/ai/agent/file/<userId>/<sessionId>/<relPath>
function resolveSessionFile(userId, sessionId, relPath) {
  const safeUserId = String(userId).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 32) || 'anon';
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 64);
  // relPath 정규화 + 상위 이동 차단
  const cleanRel = path.posix.normalize(String(relPath || '')).replace(/^[/\\]+/, '');
  if (cleanRel.includes('..')) return null;
  const full = path.resolve(WORKSPACE_ROOT, safeUserId, safeSession, cleanRel);
  // 반드시 WORKSPACE_ROOT 내부여야 함
  const root = path.resolve(WORKSPACE_ROOT);
  if (!full.startsWith(root + path.sep) && full !== root) return null;
  if (!fs.existsSync(full)) return null;
  return full;
}

module.exports = {
  runAgent,
  getStats,
  resolveSessionFile,
  // 엑셀 스킬 템플릿 관리 (등록/조회/삭제 라우트에서 사용)
  listStoredTemplates,
  storeSkillTemplates,
  getSkillTemplateDir,
  WORKSPACE_ROOT,
  TEMPLATE_ROOT,
  MAX_DURATION,
  MAX_CONCURRENT,
};
