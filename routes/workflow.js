const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const multer = require('multer');
const JSZip = require('jszip');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const db = require('../db');
const { notify } = require('../utils/notify');
const designModule = require('./design');
const mailRoute = require('./mail');
const { isPathInside } = require('./lib/design-workflow-storage');
const workflowStorageRules = require('./lib/workflow-storage-rules');
const { createFileLocator } = require('./lib/workflow-file-locator');
const stageRules = require('./lib/workflow-stage-rules');
const renameLib = require('./lib/workflow-rename');
let sharp;
try { sharp = require('sharp'); } catch (_) {}
const { sendSmtpMail, normalizeEmailList } = mailRoute;

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'workflow.json');
const FILE_DIR = path.join(DATA_DIR, 'workflow-files');
const THUMB_DIR = path.join(DATA_DIR, 'workflow-thumbs');
const MAX_WORKFLOW_UPLOAD_FILES = 20;
const MAX_WORKFLOW_UPLOAD_FILE_SIZE = 500 * 1024 * 1024;
const MAX_WORKFLOW_MAIL_ATTACH_BYTES = 24 * 1024 * 1024;

// 3단계 직선 흐름: 디자인팀 → 대림컴퍼니 → 영업지원팀
// 내부 단계 ID(design/factory/delivery)는 유지하고 라벨만 바꾼다 → 기존 데이터·업무로직 100% 호환.
// 경영관리(management)는 더 이상 파이프라인 단계가 아니다(필요할 때 별도로 체크).
const STAGES = [
  { id: 'design', label: '디자인팀', icon: 'design_services' },
  { id: 'factory', label: '대림컴퍼니', icon: 'factory' },
  { id: 'delivery', label: '경영관리팀', icon: 'manage_accounts' },
];

// 단계별 체크리스트 폐지 — 상세 드릴다운 제거 + 가벼운 UX. 핵심 동작은 "올리고 다음으로".
const STAGE_CHECKLISTS = {
  design: [],
  factory: [],
  delivery: [],
};

// 병렬 단계 폐지 → 완전 직선 흐름
const DESIGN_PARALLEL_STAGE_IDS = [];

const STAGE_DEPARTMENT_ALIASES = {
  design: ['디자인팀', '디자인'],
  factory: ['대림컴퍼니', '대림', '공장', '공장팀', '생산팀', '제작팀'],
  delivery: ['경영관리팀', '경영관리', '영업지원팀', '영업지원', '영업팀', '영업', '납품팀', '납품', '배송팀', '배송'],
};

const STATUS_LABELS = {
  active: '진행',
  hold: '보류',
  done: '완료',
  cancelled: '취소',
};

const CHECK_STATUS_LABELS = {
  pending: '대기',
  ready: '진행',
  done: '완료',
  blocked: '막힘',
};

const FILE_REVIEW_LABELS = {
  pending: '검토대기',
  approved: '승인',
  change_requested: '수정요청',
};

const SCHEDULE_NEGOTIATION_LABELS = {
  pending: '일정확인',
  possible: '가능',
  needs_change: '조정요청',
  confirmed: '확정',
};

const ORDER_TARGETS = [
  { id: 'factory', label: '우리공장', type: 'internal', deliveryMethod: 'download' },
  { id: 'lacoss', label: '라코스', type: 'external', deliveryMethod: 'email' },
  { id: 'isangtech', label: '이상테크', type: 'external', deliveryMethod: 'email' },
  { id: 'kep', label: 'KEP', type: 'external', deliveryMethod: 'email' },
  { id: 'space-etching', label: '공간부식', type: 'external', deliveryMethod: 'email' },
  { id: 'other', label: '기타', type: 'external', deliveryMethod: 'email' },
];

const ORDER_DELIVERY_METHOD_LABELS = {
  download: 'ERP 다운로드',
  email: '메일 발송',
};

function vendorListForWorkflowTargets() {
  try {
    if (db.sql) return db.sql.vendors.getAll() || [];
    if (db['업체관리']) return db['업체관리'].load().vendors || [];
    return db.load().vendors || [];
  } catch (_) {
    return [];
  }
}

function rememberWorkflowVendorEmail(order, email) {
  const vendorId = String(order?.targetPreset || '').startsWith('vendor:')
    ? String(order.targetPreset).slice('vendor:'.length)
    : '';
  const nextEmail = normalizeEmailList(email || '')[0] || '';
  if (!vendorId || !nextEmail) return false;
  try {
    if (db.sql?.vendors) {
      const vendor = db.sql.vendors.getById(vendorId);
      if (!vendor || String(vendor.email || '').trim()) return false;
      db.sql.vendors.update(vendorId, { ...vendor, email: nextEmail });
      return true;
    }
    const store = db['업체관리'] ? db['업체관리'].load() : db.load();
    const vendors = store.vendors || [];
    const vendor = vendors.find(v => String(v.id || '') === vendorId);
    if (!vendor || String(vendor.email || '').trim()) return false;
    vendor.email = nextEmail;
    if (db['업체관리']) db['업체관리'].save(store);
    else db.save(store);
    return true;
  } catch (e) {
    console.warn('[workflow-mail] vendor email remember failed:', e.message);
    return false;
  }
}

function contactTargetsForWorkflow() {
  try {
    const data = db.loadContacts();
    const companies = new Map((data.contactCompanies || []).map(c => [c.id, c.name]));
    return (data.contacts || [])
      .map(contact => {
        const email = normalizeEmailList(contact.email || '')[0] || '';
        if (!email) return null;
        const companyName = safeText(contact.company || companies.get(contact.companyId) || '', 120);
        const personName = safeText(contact.name || '', 80);
        const label = companyName && personName ? `${companyName} / ${personName}` : (companyName || personName);
        if (!label) return null;
        return {
          id: `contact:${contact.id || crypto.createHash('sha1').update(`${label}:${email}`).digest('hex').slice(0, 12)}`,
          label,
          type: 'external',
          deliveryMethod: 'email',
          recipientEmail: email,
          recipientName: personName,
          source: 'contacts',
        };
      })
      .filter(Boolean);
  } catch (_) {
    return [];
  }
}

function buildWorkflowOrderTargets() {
  const targets = ORDER_TARGETS.map(t => ({ ...t }));
  const byLabel = new Map(targets.map(t => [String(t.label || '').trim().toLowerCase(), t]).filter(([key]) => key));
  for (const vendor of vendorListForWorkflowTargets()) {
    const label = safeText(vendor.name, 120);
    const email = normalizeEmailList(vendor.email || '')[0] || '';
    if (!label) continue;
    const key = label.toLowerCase();
    const existing = byLabel.get(key);
    if (existing) {
      existing.recipientEmail = existing.recipientEmail || email;
      existing.deliveryMethod = existing.deliveryMethod || 'email';
      existing.source = existing.source || 'vendors';
      continue;
    }
    const target = {
      id: `vendor:${vendor.id || crypto.createHash('sha1').update(`${label}:${email}`).digest('hex').slice(0, 12)}`,
      label,
      type: 'external',
      deliveryMethod: 'email',
      recipientEmail: email,
      source: 'vendors',
    };
    targets.push({
      ...target,
    });
    byLabel.set(key, target);
  }
  const seenContacts = new Set();
  const contactTargets = contactTargetsForWorkflow()
    .filter(target => {
      const key = `${String(target.label || '').toLowerCase()}|${String(target.recipientEmail || '').toLowerCase()}`;
      if (seenContacts.has(key)) return false;
      seenContacts.add(key);
      return true;
    })
    .slice(0, 300);
  return targets.concat(contactTargets);
}

const ORDER_STATUS_LABELS = {
  draft: '초안',
  requested: '전달요청',
  sent: '발송',
  replied: '회신',
  confirmed: '확정',
  done: '완료',
  cancelled: '취소',
};

const ORDER_RESPONSE_LABELS = {
  possible: '가능',
  needs_change: '조정요청',
  confirmed: '확정',
};

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR, { recursive: true });
  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });
}

function emptyStore() {
  return { jobs: [], events: [], files: [], orders: [], projects: [] };
}

// 기존 4단계(관리/공장/납품) → 3단계 일회성 이전.
// 경영관리(management)는 파이프라인에서 제거하되 job.managementReview 로 보존하고,
// currentStage/파일 stageId 가 management 면 대림컴퍼니(factory)로 옮긴다. (멱등)
function migrateLegacyManagementStage(data) {
  let changed = false;
  for (const job of data.jobs || []) {
    const sc = job.stageChecks;
    if (sc && typeof sc === 'object' && sc.management) {
      if (!job.managementReview) {
        const m = sc.management || {};
        job.managementReview = { status: m.status || '', note: m.note || '', assignee: m.assignee || '', updatedAt: m.updatedAt || '' };
      }
      delete sc.management;
      changed = true;
    }
    if (job.currentStage === 'management') { job.currentStage = 'factory'; changed = true; }
  }
  for (const file of data.files || []) {
    if (file && file.stageId === 'management') { file.stageId = 'factory'; changed = true; }
  }
  return changed;
}

function loadStore() {
  ensureDirs();
  if (!fs.existsSync(STORE_PATH)) {
    const init = emptyStore();
    saveStore(init);
    return init;
  }
  try {
    const data = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8').replace(/\0/g, ''));
    if (!Array.isArray(data.jobs)) data.jobs = [];
    if (!Array.isArray(data.events)) data.events = [];
    if (!Array.isArray(data.files)) data.files = [];
    if (!Array.isArray(data.orders)) data.orders = [];
    if (!Array.isArray(data.projects)) data.projects = [];
    let storeChanged = ensurePublicTokens(data);
    storeChanged = migrateLegacyManagementStage(data) || storeChanged;
    if (storeChanged) saveStore(data);
    return data;
  } catch (e) {
    const brokenPath = STORE_PATH + '.broken_' + Date.now();
    try { fs.copyFileSync(STORE_PATH, brokenPath); } catch (_) {}
    const init = emptyStore();
    saveStore(init);
    return init;
  }
}

function saveStore(data) {
  ensureDirs();
  const tmp = STORE_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  JSON.parse(fs.readFileSync(tmp, 'utf8'));
  if (fs.existsSync(STORE_PATH)) {
    try { fs.copyFileSync(STORE_PATH, STORE_PATH + '.bak'); } catch (_) {}
  }
  fs.renameSync(tmp, STORE_PATH);
}

function nowIso() {
  return new Date().toISOString();
}

// 한국시간(KST, UTC+9) 기준 'YYYY-MM-DD'. createdAt/completedAt은 toISOString()=UTC라 그대로 자르면
// 한국 새벽 0~9시 건이 전날로 샌다 → 등록코드 날짜부·내역 날짜를 KST로 통일(2026-06-17).
function kstDay(iso) {
  const t = Date.parse(iso || '');
  if (!Number.isFinite(t)) return '';
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10);
}

function makeId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function makePublicToken() {
  return crypto.randomBytes(18)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function makeUniquePublicToken(data) {
  const used = new Set();
  for (const job of data?.jobs || []) {
    if (job?.publicToken) used.add(String(job.publicToken));
  }
  for (const file of data?.files || []) {
    if (file?.publicToken) used.add(String(file.publicToken));
  }
  for (const order of data?.orders || []) {
    if (order?.publicToken) used.add(String(order.publicToken));
  }
  let token = makePublicToken();
  while (used.has(token)) token = makePublicToken();
  return token;
}

function ensurePublicTokens(data) {
  let changed = false;
  for (const job of data?.jobs || []) {
    if (!job.publicToken) {
      job.publicToken = makeUniquePublicToken(data);
      changed = true;
    }
  }
  for (const file of data?.files || []) {
    if (!file.publicToken) {
      file.publicToken = makeUniquePublicToken(data);
      changed = true;
    }
  }
  for (const order of data?.orders || []) {
    if (!order.publicToken) {
      order.publicToken = makeUniquePublicToken(data);
      changed = true;
    }
  }
  return changed;
}

function safeText(v, max = 500) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function decodeEncodedText(v) {
  const raw = String(v == null ? '' : v).trim();
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch (_) {
    return raw;
  }
}

function bodyText(body, key, max = 500) {
  const encoded = decodeEncodedText(body?.[`${key}Encoded`]);
  if (encoded) return safeText(encoded, max);
  return safeText(body?.[key], max);
}

function safeFilePart(value, fallback = 'file') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function allowedWorkflowFilePath(fullPath) {
  if (!fullPath) return null;
  const full = path.resolve(fullPath);
  const workflowRoot = path.resolve(FILE_DIR);
  if (full !== workflowRoot && isPathInside(workflowRoot, full)) return full;
  const designRoot = path.resolve(designModule.getDesignRoot ? designModule.getDesignRoot() : 'D:\\');
  if (full !== designRoot && isPathInside(designRoot, full)) return full;
  return null;
}

let _fileLocator = null;
function fileLocator() {
  if (_fileLocator) return _fileLocator;
  _fileLocator = createFileLocator({
    fileDir: FILE_DIR,
    getDesignRoot: () => (designModule.getDesignRoot ? designModule.getDesignRoot() : 'D:\\'),
    resolveDesignStorage: (company, project, year) =>
      resolveWorkflowDesignStorage(company, project, safeYear(year), false),
    safeFilePart,
    isPathInside,
  });
  return _fileLocator;
}

// 디스크 경로 해석 — 저장된 절대경로/디렉터리(싼 후보) 우선, 모두 없을 때만 네트워크 폴백.
// 기존엔 design 파일마다 네트워크 디자인폴더 풀스캔을 "무조건" 먼저 했다 → 목록/상세 로드가 분 단위.
function fileDiskPath(file) {
  return fileLocator().diskPath(file);
}

// 표시용 존재여부 — 모듈 레벨 TTL 메모. 한 요청 안/요청 간 반복 stat 을 제거.
function workflowFileExists(file) {
  return fileLocator().exists(file);
}

// 느린 요청 자가보고: 300ms 이상이거나 WORKFLOW_PERF_LOG 환경변수일 때만 1줄 출력.
// 캐시가 더워지면 자동으로 조용해진다. (어디서 시간이 새는지 확인용)
function workflowPerfSnapshot() {
  return fileLocator().snapshotStats();
}
function logWorkflowPerf(label, t0, s0, extra = {}) {
  const ms = Date.now() - t0;
  if (ms < 300 && !process.env.WORKFLOW_PERF_LOG) return;
  const s = fileLocator().snapshotStats();
  console.log(`[workflow-perf] ${label} ${ms}ms`, {
    ...extra,
    diskPath: s.diskPathCalls - (s0.diskPathCalls || 0),
    stat: s.existsChecks - (s0.existsChecks || 0),
    memoHit: s.existsMemoHits - (s0.existsMemoHits || 0),
    scan: s.expensiveResolves - (s0.expensiveResolves || 0),
  });
}

function workflowFileExistsCached(file, cache = null) {
  if (!cache || !file) return workflowFileExists(file);
  const key = file.id || file.storedPath || file.storedName || file.originalName || '';
  if (!key) return workflowFileExists(file);
  if (!cache.has(key)) cache.set(key, workflowFileExists(file));
  return cache.get(key);
}

function missingFileCount(data, job, cache = null) {
  if (!job || !data || !Array.isArray(data.files)) return 0;
  return data.files.filter(file => file.jobId === job.id && !workflowFileExistsCached(file, cache)).length;
}

function fileExt(file) {
  return path.extname(String(file?.originalName || file?.storedName || '')).toLowerCase();
}

function isImageFile(file) {
  const mime = String(file?.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(fileExt(file));
}

function workflowImageMime(file) {
  const mime = String(file?.mime || '').toLowerCase();
  // 보안: svg/xml 등 스크립트 가능 image mime은 그대로 반환 금지(인라인 XSS 방지) — 확장자로만 결정.
  if (mime.startsWith('image/') && !mime.includes('svg') && !mime.includes('xml')) return mime;
  const ext = fileExt(file);
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return 'image/jpeg';
}

function isAiFile(file) {
  return fileExt(file) === '.ai';
}

function uniqueZipPath(used, wantedPath) {
  const normalized = wantedPath.replace(/\\/g, '/');
  if (!used.has(normalized)) {
    used.add(normalized);
    return normalized;
  }
  const ext = path.posix.extname(normalized);
  const base = normalized.slice(0, normalized.length - ext.length);
  let idx = 2;
  while (used.has(`${base}_${idx}${ext}`)) idx++;
  const out = `${base}_${idx}${ext}`;
  used.add(out);
  return out;
}

function attachmentDisposition(filename) {
  const raw = String(filename || 'download.bin');
  const fallback = raw
    .replace(/[\\/\r\n"]/g, '_')
    .replace(/[^\x20-\x7E]/g, '_')
    .slice(0, 160) || 'download.bin';
  return `attachment; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(raw)}`;
}

function safeDate(v) {
  const s = safeText(v, 30);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return '';
  const y = +s.slice(0, 4), m = +s.slice(5, 7), d = +s.slice(8, 10);
  const dt = new Date(y, m - 1, d);
  // 달력상 실재하는 날짜만 통과 (2026-02-30, 2026-13-01 등 차단)
  if (dt.getFullYear() !== y || dt.getMonth() !== m - 1 || dt.getDate() !== d) return '';
  return s;
}

function safeYear(v) {
  const s = safeText(v, 10);
  return /^\d{4}$/.test(s) ? s : String(new Date().getFullYear());
}

function normalizePublicBaseUrl(rawValue) {
  const raw = safeText(rawValue, 300);
  if (!raw) return '';
  try {
    const url = new URL(raw);
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    url.pathname = url.pathname.replace(/\/+$/, '');
    url.search = '';
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch (_) {
    return '';
  }
}

function isPrivateHostname(hostname) {
  const host = String(hostname || '').trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!host) return true;
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  if (host.startsWith('192.168.') || host.startsWith('10.')) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(host)) return true;
  return false;
}

function isPublicWorkflowBaseUrl(urlValue) {
  const url = normalizePublicBaseUrl(urlValue);
  if (!url) return false;
  try {
    return !isPrivateHostname(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

function envPublicWorkflowBaseUrl() {
  return normalizePublicBaseUrl(
    process.env.WORKFLOW_PUBLIC_BASE_URL
      || process.env.PUBLIC_BASE_URL
      || process.env.CLOUDFLARE_TUNNEL_URL,
  );
}

function storedPublicWorkflowBaseUrl() {
  try {
    const settings = db['설정'].load();
    return normalizePublicBaseUrl(
      settings.workflow?.publicBaseUrl
        || settings.general?.workflowPublicBaseUrl
        || settings.workflowPublicBaseUrl
        || '',
    );
  } catch (_) {
    return '';
  }
}

function loadWorkflowSettings() {
  try {
    const settings = db['설정'].load() || {};
    return {
      root: settings,
      workflow: settings.workflow && typeof settings.workflow === 'object' ? settings.workflow : {},
    };
  } catch (_) {
    return { root: {}, workflow: {} };
  }
}

function storedWorkflowStageDepartmentMap() {
  const { workflow, root } = loadWorkflowSettings();
  const raw = workflow.stageDepartmentMap || root.workflowStageDepartmentMap || {};
  const out = {};
  for (const stage of STAGES) {
    const value = safeText(raw[stage.id], 120);
    if (value) out[stage.id] = value;
  }
  return out;
}

function saveWorkflowStageDepartmentMap(stageDepartmentMap = {}) {
  const settings = db['설정'].load() || {};
  if (!settings.workflow || typeof settings.workflow !== 'object') settings.workflow = {};
  const next = {};
  for (const stage of STAGES) {
    const value = safeText(stageDepartmentMap[stage.id], 120);
    if (value) next[stage.id] = value;
  }
  settings.workflow.stageDepartmentMap = next;
  db['설정'].save(settings);
  return next;
}

function publicWorkflowBaseUrl() {
  return publicWorkflowLinkState().publicBaseUrl;
}

function publicWorkflowLinkState() {
  const envUrl = envPublicWorkflowBaseUrl();
  const storedUrl = storedPublicWorkflowBaseUrl();
  const envValid = isPublicWorkflowBaseUrl(envUrl);
  const storedValid = isPublicWorkflowBaseUrl(storedUrl);
  const publicBaseUrl = envValid ? envUrl : (storedValid ? storedUrl : '');
  return {
    publicBaseUrl,
    configuredBaseUrl: storedUrl,
    source: envValid ? 'env' : (storedValid ? 'settings' : ''),
    envLocked: envValid,
    configuredValid: !storedUrl || storedValid,
    configuredProblem: storedUrl && !storedValid ? '저장된 외부주소가 localhost 또는 사설 IP라서 공장/외부업체 링크로 사용할 수 없습니다.' : '',
    envProblem: envUrl && !envValid ? '서버 환경변수 외부주소가 localhost 또는 사설 IP라서 무시됩니다.' : '',
  };
}

function absoluteWorkflowPublicUrl(relativePath) {
  const base = publicWorkflowBaseUrl();
  if (!base || !isPublicWorkflowBaseUrl(base)) return '';
  return `${base}${String(relativePath || '').startsWith('/') ? '' : '/'}${relativePath || ''}`;
}

function resolveWorkflowDesignStorage(companyName, projectName, year, create = true, extra = {}) {
  if (!designModule.resolveWorkflowStorage) return null;
  return designModule.resolveWorkflowStorage({
    companyName,
    projectName,
    year,
    create,
    ...extra,
  });
}

function workflowDesignNetworkPath(fullPath) {
  if (!fullPath || !designModule.toNetworkPath) return '';
  return designModule.toNetworkPath(fullPath);
}

function clearWorkflowStorageFields(job) {
  delete job.storageRoot;
  delete job.storageBucket;
  delete job.storageYear;
  delete job.storageCompanyFolder;
  delete job.storageYearFolder;
  delete job.storageProjectFolder;
  delete job.storagePath;
  delete job.storageNetPath;
}

function applyWorkflowDesignStorage(job, create = false) {
  if (!job) return { changed: false, info: null };
  // 현장명(projectName)이 없어도 회사명만 있으면 회사\연도 폴더로 저장 — 업체만 있는 건 대응.
  if (!job.companyName) {
    const hadStorage = !!(job.storageRoot || job.storageBucket || job.storagePath || job.storageNetPath);
    if (hadStorage) clearWorkflowStorageFields(job);
    return { changed: hadStorage, info: null };
  }
  const storageInfo = resolveWorkflowDesignStorage(
    job.companyName,
    job.projectName,
    safeYear(String(job.dueDate || '').slice(0, 4)),
    create,
  );
  if (!storageInfo) return { changed: false, info: null };

  const next = {
    storageRoot: 'design',
    storageBucket: storageInfo.rel,
    storageYear: storageInfo.year,
    storageCompanyFolder: storageInfo.companyFolderName,
    storageYearFolder: storageInfo.yearFolderName,
    storageProjectFolder: storageInfo.projectFolderName,
    storagePath: storageInfo.dir,
    storageNetPath: workflowDesignNetworkPath(storageInfo.dir),
  };
  const changed = Object.entries(next).some(([key, value]) => String(job[key] || '') !== String(value || ''));
  Object.assign(job, next);
  return { changed, info: storageInfo };
}

function userName(req) {
  return req.user?.name || req.user?.userId || 'unknown';
}

// 현장명 변경 승인권자 — 관리자 또는 조직도에서 자기 부서의 팀장(departments[].leaderId)
function isWorkflowApprover(req) {
  if ((req.user?.role || '') === 'admin') return true;
  try {
    const org = loadOrgSnapshotFromFile();
    const me = (org?.users || []).find(u => u.userId === req.user?.userId);
    if (!me || !me.department) return false;
    const dept = (org?.departments || []).find(d => d.id === me.department);
    return !!(dept && dept.leaderId === me.id);
  } catch (_) { return false; }
}

// 현장명 변경 실행(팀장 승인 후에만 호출) — 디스크 폴더 rename + 같은 현장의 모든 작업·파일 경로 일괄 갱신.
// 폴더가 없으면 DB만 갱신. 같은 이름 폴더가 이미 있으면 충돌 에러(throw).
function executeProjectRename(data, req, anchorJob, newNameRaw) {
  const company = String(anchorJob.companyName || '');
  const oldName = String(anchorJob.projectName || '');
  const newName = safeText(newNameRaw, 160).trim();
  if (!newName) throw new Error('새 현장명이 비어 있습니다.');
  if (!oldName || newName === oldName) throw new Error('바꿀 현장명이 기존과 같습니다.');
  const at = nowIso();

  // 1) 디스크 폴더 rename (실제 폴더가 있을 때만)
  let oldDir = String(anchorJob.storagePath || '');
  if (!oldDir || !fs.existsSync(oldDir)) {
    const info = resolveWorkflowDesignStorage(company, oldName, safeYear(String(anchorJob.dueDate || '').slice(0, 4)), false);
    oldDir = (info && info.dir) || '';
  }
  let newDir = '';
  let oldLeaf = '';
  let newLeaf = '';
  if (oldDir && fs.existsSync(oldDir)) {
    oldLeaf = path.basename(oldDir);
    newLeaf = safeFilePart(renameLib.buildRenamedLeaf(oldLeaf, oldName, newName), newName);
    newDir = path.join(path.dirname(oldDir), newLeaf);
    if (path.resolve(newDir) === path.resolve(oldDir)) {
      newDir = '';
    } else {
      if (fs.existsSync(newDir)) throw new Error('같은 이름의 폴더가 이미 있습니다: ' + newLeaf);
      fs.renameSync(oldDir, newDir);
    }
  }

  // 2) 같은 현장(회사+현장명)의 모든 작업 갱신
  //    경로 메타데이터(버킷/leaf/넷패스)는 '실제로 rename 된 폴더(prefix 일치)' 잡에만 적용 —
  //    연도·루트가 다른 형제 폴더 잡의 버킷을 존재하지 않는 폴더로 깨뜨리지 않음 (감사 #6,#7,#15)
  const targetJobs = data.jobs.filter(j => String(j.companyName || '') === company && String(j.projectName || '') === oldName);
  for (const j of targetJobs) {
    j.projectName = newName;
    if (newDir) {
      const beforePath = String(j.storagePath || '');
      const afterPath = renameLib.replacePathPrefix(beforePath, oldDir, newDir);
      if (afterPath !== beforePath) {
        j.storagePath = afterPath;
        j.storageBucket = renameLib.replaceBucketLeaf(j.storageBucket, oldLeaf, newLeaf);
        j.storageProjectFolder = newLeaf;
        j.storageNetPath = workflowDesignNetworkPath(j.storagePath);
        if (j.archiveStorageBucket) j.archiveStorageBucket = renameLib.replaceBucketLeaf(j.archiveStorageBucket, oldLeaf, newLeaf);
      }
    }
    if (j.renameRequest && j.renameRequest.to && j.renameRequest.to !== newName) {
      // 내용이 다른 경쟁 변경요청을 정리할 때는 흔적을 남김 (감사 #13,#19)
      addEvent(data, req, j.id, 'update', `경쟁 변경요청 자동 종료: ${j.renameRequest.from} → ${j.renameRequest.to} ('${newName}' 승인으로 정리)`, { renameSuperseded: true });
    }
    delete j.renameRequest;
    j.updatedAt = at;
    addEvent(data, req, j.id, 'update', `현장명 변경: ${oldName} → ${newName} (팀장 승인 · 폴더 동기화)`, { projectRename: true });
  }

  // 3) 같은 현장의 모든 파일 — 실제 경로가 바뀐 파일만 버킷/넷패스 동기화 (감사 #7,#17)
  for (const f of (data.files || [])) {
    if (String(f.storageCompanyName || '') !== company || String(f.storageProjectName || '') !== oldName) continue;
    f.storageProjectName = newName;
    if (newDir) {
      const beforeStored = String(f.storedPath || '');
      const beforeStorage = String(f.storagePath || '');
      f.storedPath = renameLib.replacePathPrefix(beforeStored, oldDir, newDir);
      f.storagePath = renameLib.replacePathPrefix(beforeStorage, oldDir, newDir);
      if (f.storedPath !== beforeStored || f.storagePath !== beforeStorage) {
        f.storageBucket = renameLib.replaceBucketLeaf(f.storageBucket, oldLeaf, newLeaf);
        if (f.storagePath) f.storageNetPath = workflowDesignNetworkPath(f.storagePath);
        if (f.storageRelDir) f.storageRelDir = f.storageBucket;
      }
    }
  }

  // 4) 프로젝트 목록 이름 갱신 (새 이름 항목이 이미 있으면 옛 항목 제거)
  if (Array.isArray(data.projects)) {
    const oldKey = workflowProjectKey(company, oldName);
    const newKey = workflowProjectKey(company, newName);
    const mine = data.projects.find(p => workflowProjectKey(p.companyName, p.projectName) === oldKey);
    const dupe = data.projects.find(p => workflowProjectKey(p.companyName, p.projectName) === newKey);
    if (mine && dupe && dupe !== mine) data.projects = data.projects.filter(p => p !== mine);
    else if (mine) { mine.projectName = newName; mine.updatedAt = at; }
  }

  // 5) 경로/존재여부 캐시 + 디자인 회사·현장 옵션 캐시 비우기 — 다음 조회부터 새 경로/이름으로
  try { fileLocator().clear(); } catch (_) {}
  try { if (typeof designModule.invalidateWorkflowOptions === 'function') designModule.invalidateWorkflowOptions(); } catch (_) {}

  return { jobs: targetJobs.length, oldDir, newDir };
}

function normalizeChecklist(stageId, prev = []) {
  const base = (STAGE_CHECKLISTS[stageId] || []).map((label, idx) => ({
    id: `${stageId}_${idx + 1}`,
    label,
    done: false,
  }));
  const prevItems = Array.isArray(prev) ? prev : [];
  const byId = {};
  for (const item of prevItems) {
    const id = safeText(item?.id, 80);
    if (!id) continue;
    byId[id] = {
      id,
      label: safeText(item?.label, 120),
      done: !!item?.done,
      updatedAt: item?.updatedAt || '',
    };
  }
  return base.map(item => {
    const saved = byId[item.id];
    return saved ? { ...item, done: !!saved.done, updatedAt: saved.updatedAt || '' } : item;
  });
}

function newStageChecks(seed = {}) {
  const out = {};
  for (const stage of STAGES) {
    const prev = seed[stage.id] || {};
    out[stage.id] = {
      status: ['pending', 'ready', 'done', 'blocked'].includes(prev.status) ? prev.status : 'pending',
      assignee: safeText(prev.assignee, 80),
      dueDate: safeDate(prev.dueDate),
      note: safeText(prev.note, 1000),
      checklist: normalizeChecklist(stage.id, prev.checklist),
      completedAt: prev.completedAt || '',
      completedBy: safeText(prev.completedBy, 80),
      completedByName: safeText(prev.completedByName, 80),
      updatedAt: prev.updatedAt || '',
    };
  }
  return out;
}

function inferCurrentStage(stageChecks, fallback = 'design') {
  for (const stage of STAGES) {
    if (stageChecks[stage.id]?.status !== 'done') return stage.id;
  }
  return fallback || 'delivery';
}

function setStageReady(job, stageId, at = nowIso()) {
  const check = job.stageChecks?.[stageId];
  if (!check) return false;
  if (check.status === 'pending') {
    check.status = 'ready';
    check.updatedAt = at;
    return true;
  }
  return false;
}

function syncWorkflowStageFlow(job, at = nowIso()) {
  if (!job) return { parallelActivated: false, deliveryActivated: false };
  job.stageChecks = newStageChecks(job.stageChecks || {});
  let advanced = false;
  // 직선 흐름: 이전 단계가 done 이면 다음 단계를 ready 로 (디자인 → 대림컴퍼니 → 영업지원)
  for (let i = 1; i < STAGES.length; i++) {
    if (job.stageChecks[STAGES[i - 1].id]?.status === 'done') {
      advanced = setStageReady(job, STAGES[i].id, at) || advanced;
    }
  }
  job.currentStage = inferCurrentStage(job.stageChecks, job.currentStage || 'design');
  return { parallelActivated: advanced, deliveryActivated: advanced };
}

function activeStageIds(job) {
  if (!job || !job.stageChecks) return ['design'];
  const ids = [];
  for (const stage of STAGES) {
    const check = job.stageChecks[stage.id] || {};
    if (check.status === 'done') continue;
    if (check.status === 'ready' || check.status === 'blocked' || stage.id === job.currentStage) {
      ids.push(stage.id);
    }
  }
  return ids.length ? ids : [job.currentStage || 'design'];
}

function uniqueTexts(values) {
  return Array.from(new Set(values.map(v => safeText(v, 120)).filter(Boolean)));
}

function stageTargetLabels(job, stageIds) {
  return uniqueTexts(stageIds.map(stageId => {
    const stage = STAGES.find(s => s.id === stageId);
    return job.stageChecks?.[stageId]?.assignee || workflowStageLabel(stageId) || stage?.label || stageId;
  }));
}

function nextStageId(stageId) {
  const idx = STAGES.findIndex(s => s.id === stageId);
  return idx >= 0 && idx < STAGES.length - 1 ? STAGES[idx + 1].id : '';
}

function defaultUploadTargetLabels(job, stageId, kind) {
  // 디자인 시안/도면/사진은 다음 단계(대림컴퍼니)로 전달
  if (stageId === 'design' && ['proof', 'drawing', 'photo'].includes(kind || '')) {
    const next = nextStageId('design');
    return stageTargetLabels(job, next ? [next] : ['design']);
  }
  return stageTargetLabels(job, [stageId]);
}

function stageStatusNotifyTargets(job, stageId, status) {
  if (!job || !stageId) return [];
  const idx = STAGES.findIndex(s => s.id === stageId);
  if (idx < 0) return [];
  // 직선 흐름: 막히면 이전 단계, 완료되면 다음 단계에 알림
  if (status === 'blocked') return idx > 0 ? [STAGES[idx - 1].id] : [stageId];
  if (status === 'done') return idx < STAGES.length - 1 ? [STAGES[idx + 1].id] : [];
  if (status === 'ready') return [stageId];
  return [];
}

function fileTargetLabels(file) {
  const labels = Array.isArray(file?.targetLabels) ? file.targetLabels : [];
  if (labels.length) return uniqueTexts(labels);
  return uniqueTexts([file?.targetLabel, file?.targetUserName, file?.targetUserId]);
}

function splitTargetLabels(label) {
  return uniqueTexts(String(label || '').split(/[,\u00b7/]+/));
}

function normalizeTargetStageIds(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(/[,\s]+/);
  return uniqueTexts(raw).filter(id => STAGES.some(stage => stage.id === id));
}

function fileTargetStageIds(file) {
  return normalizeTargetStageIds(file?.targetStageIds);
}

function eventTargetStageIds(event) {
  return normalizeTargetStageIds(event?.targetStageIds || event?.meta?.targetStageIds);
}

const ORG_STORE_PATH = path.join(DATA_DIR, '조직관리.json');
let orgCache = { at: 0, data: { users: [], departments: [], companies: [] } };
let orgRepairWarnedAt = 0;

function normalizeOrgSnapshot(data = {}) {
  return {
    users: Array.isArray(data.users) ? data.users : [],
    departments: Array.isArray(data.departments) ? data.departments : [],
    companies: Array.isArray(data.companies) ? data.companies : [],
  };
}

function unescapedQuoteCount(line) {
  let count = 0;
  for (let i = 0; i < line.length; i += 1) {
    if (line[i] !== '"') continue;
    let slashes = 0;
    for (let j = i - 1; j >= 0 && line[j] === '\\'; j -= 1) slashes += 1;
    if (slashes % 2 === 0) count += 1;
  }
  return count;
}

function repairDanglingJsonStringLines(raw) {
  return String(raw || '')
    .replace(/\0/g, '')
    .split(/\r?\n/)
    .map(line => {
      if (unescapedQuoteCount(line) % 2 === 0) return line;
      if (!/^\s*"[^"]+"\s*:/.test(line)) return line;
      if (/,\s*$/.test(line)) return line.replace(/,\s*$/, '",');
      return line.replace(/\s*$/, '"');
    })
    .join('\n');
}

function loadOrgSnapshotFromFile() {
  try {
    if (!fs.existsSync(ORG_STORE_PATH)) return null;
    const raw = fs.readFileSync(ORG_STORE_PATH, 'utf8').replace(/\0/g, '');
    try {
      return normalizeOrgSnapshot(JSON.parse(raw));
    } catch (_) {
      const repaired = repairDanglingJsonStringLines(raw);
      const parsed = JSON.parse(repaired);
      const now = Date.now();
      if (now - orgRepairWarnedAt > 60000) {
        orgRepairWarnedAt = now;
        console.warn('[workflow] 조직관리.json has dangling strings; using runtime repaired snapshot');
      }
      return normalizeOrgSnapshot(parsed);
    }
  } catch (e) {
    const now = Date.now();
    if (now - orgRepairWarnedAt > 60000) {
      orgRepairWarnedAt = now;
      console.warn('[workflow] org snapshot fallback failed:', e.message);
    }
    return null;
  }
}

function loadOrgSnapshot() {
  const now = Date.now();
  if (now - orgCache.at < 1500) return orgCache.data;
  const fromFile = loadOrgSnapshotFromFile();
  if (fromFile && (fromFile.users.length || fromFile.departments.length || fromFile.companies.length)) {
    orgCache = { at: now, data: fromFile };
    return orgCache.data;
  }
  try {
    const data = db.loadUsers ? db.loadUsers() : db.조직관리.load();
    orgCache = { at: now, data: normalizeOrgSnapshot(data) };
  } catch (_) {
    orgCache = { at: now, data: { users: [], departments: [], companies: [] } };
  }
  return orgCache.data;
}

function loadFreshOrgSnapshot() {
  orgCache.at = 0;
  return loadOrgSnapshot();
}

function lowerText(value) {
  return String(value || '').trim().toLowerCase();
}

function departmentMatchKey(value) {
  return lowerText(value)
    .replace(/^[\u2605\u2606\u25cf\u25cb\u25a0\u25a1\s]+/gu, '')
    .replace(/[\u2605\u2606\u25cf\u25cb\u25a0\u25a1]/gu, '')
    .replace(/[\s._\-()（）\[\]{}]/g, '');
}

function suggestedWorkflowStageDepartmentMap(org = loadOrgSnapshot()) {
  const departments = workflowDepartmentOptions(org);
  const used = new Set();
  const out = {};
  for (const stage of STAGES) {
    const aliases = uniqueTexts([stage.label, ...(STAGE_DEPARTMENT_ALIASES[stage.id] || [])])
      .map(departmentMatchKey)
      .filter(Boolean);
    if (!aliases.length) continue;
    const candidates = departments
      .map(dept => {
        const key = departmentMatchKey(dept.name || dept.id);
        if (!key || used.has(dept.id)) return null;
        let score = 99;
        for (const alias of aliases) {
          if (key === alias) score = Math.min(score, 0);
          else if (key.startsWith(alias) || alias.startsWith(key)) score = Math.min(score, 1);
          else if (key.includes(alias) || alias.includes(key)) score = Math.min(score, 2);
        }
        return score < 99 ? { dept, score } : null;
      })
      .filter(Boolean)
      .sort((a, b) => a.score - b.score || (a.dept.sortOrder - b.dept.sortOrder) || String(a.dept.name).localeCompare(String(b.dept.name), 'ko'));
    if (candidates[0]) {
      out[stage.id] = candidates[0].dept.id;
      used.add(candidates[0].dept.id);
    }
  }
  return out;
}

function stageDepartments(stageId, org = loadOrgSnapshot()) {
  const mappedId = storedWorkflowStageDepartmentMap()[stageId] || '';
  if (!mappedId) return [];
  const dept = (org.departments || []).find(d => String(d.id || '') === mappedId);
  return dept ? [dept] : [];
}

function workflowDepartmentOptions(org = loadOrgSnapshot()) {
  return (org.departments || [])
    .map(d => ({
      id: d.id,
      name: d.name || d.id,
      sortOrder: Number(d.sortOrder) || 0,
      companyId: d.companyId || '',
    }))
    .filter(d => d.id && d.name)
    .sort((a, b) => (a.sortOrder - b.sortOrder) || String(a.name).localeCompare(String(b.name), 'ko'));
}

function workflowStageMeta(stage, org = loadOrgSnapshot()) {
  const departments = stageDepartments(stage.id, org);
  const primary = departments[0] || null;
  return {
    ...stage,
    label: primary?.name || stage.label,
    defaultLabel: stage.label,
    departmentIds: departments.map(d => d.id).filter(Boolean),
    departmentNames: departments.map(d => d.name).filter(Boolean),
    mappedDepartmentId: primary?.id || '',
    matchedDepartmentCount: departments.length,
  };
}

function workflowStagesForOrg(org = loadOrgSnapshot()) {
  return STAGES.map(stage => workflowStageMeta(stage, org));
}

function workflowStageLabel(stageId) {
  const stage = STAGES.find(s => s.id === stageId);
  if (!stage) return stageId || '';
  return workflowStageMeta(stage).label || stage.label || stageId;
}

function workflowParallelStageLabel(separator = '/') {
  return DESIGN_PARALLEL_STAGE_IDS.map(workflowStageLabel).filter(Boolean).join(separator);
}

function resolveWorkflowUser(userLike = {}) {
  const org = loadOrgSnapshot();
  const userId = lowerText(userLike.userId);
  const name = lowerText(userLike.name);
  const found = org.users.find(u => userId && lowerText(u.userId) === userId)
    || org.users.find(u => name && lowerText(u.name) === name)
    || {};
  const departmentValue = userLike.department || found.department || '';
  const dept = org.departments.find(d => lowerText(d.id) === lowerText(departmentValue) || lowerText(d.name) === lowerText(departmentValue));
  const departmentName = dept ? dept.name : departmentValue;
  const departmentId = dept ? dept.id : departmentValue;
  return {
    userId,
    name: name || lowerText(found.name),
    departmentId: lowerText(departmentId),
    departmentName: lowerText(departmentName),
    raw: found,
  };
}

function profileTokens(profile) {
  return uniqueTexts([
    profile.userId,
    profile.name,
    profile.departmentId,
    profile.departmentName,
  ]).map(lowerText).filter(Boolean);
}

function textMatchesProfile(text, profile) {
  const hay = lowerText(text);
  if (!hay) return false;
  return profileTokens(profile).some(token => hay.includes(token) || token.includes(hay));
}

function textMatchesUserIdentity(text, userLike) {
  const hay = lowerText(text);
  if (!hay) return false;
  const profile = resolveWorkflowUser(userLike || {});
  return [profile.userId, profile.name]
    .map(lowerText)
    .filter(Boolean)
    .some(token => hay.includes(token) || token.includes(hay));
}

function stageReferenceTexts(job, stageId) {
  const stage = STAGES.find(s => s.id === stageId);
  const check = job?.stageChecks?.[stageId] || {};
  return uniqueTexts([
    stageId,
    stage?.label,
    workflowStageLabel(stageId),
    check.assignee,
    ...(STAGE_DEPARTMENT_ALIASES[stageId] || []),
  ]);
}

function stageTargetTexts(job, stageId) {
  const check = job?.stageChecks?.[stageId] || {};
  const departments = stageDepartments(stageId);
  return uniqueTexts([
    stageId,
    workflowStageLabel(stageId),
    check.assignee,
    ...departments.map(d => d.id),
    ...departments.map(d => d.name),
    // 부서매핑 미설정 시에도 '디자인팀' 등 한글 사용자에게 알림이 닿도록 별칭 폴백
    ...(STAGE_DEPARTMENT_ALIASES[stageId] || []),
  ]);
}

function viewerMatchesStageTarget(job, stageId, viewerUser) {
  if (!STAGES.some(stage => stage.id === stageId)) return false;
  const profile = resolveWorkflowUser(viewerUser || {});
  return stageTargetTexts(job, stageId).some(text => textMatchesProfile(text, profile));
}

function targetLabelStageIds(label, job) {
  const needle = lowerText(label);
  if (!needle) return [];
  return STAGES
    .filter(stage => stageReferenceTexts(job, stage.id).some(text => {
      const hay = lowerText(text);
      return hay && (needle.includes(hay) || hay.includes(needle));
    }))
    .map(stage => stage.id);
}

function isApprovedWorkflowUser(user) {
  return !!(user && user.userId && (!user.status || user.status === 'approved'));
}

function workflowTargetUsers(job, target = {}, actorId = '') {
  const org = loadOrgSnapshot();
  const users = (org.users || []).filter(isApprovedWorkflowUser);
  const picked = new Map();
  const actor = lowerText(actorId);
  const targetUserId = lowerText(target.targetUserId);
  const targetUserName = lowerText(target.targetUserName);
  const targetLabel = safeText(target.targetLabel, 120);
  const targetLabels = splitTargetLabels(targetLabel);
  const stageIds = uniqueTexts([
    ...normalizeTargetStageIds(target.targetStageIds),
    ...targetLabelStageIds(targetLabel, job),
  ]);

  const addUser = user => {
    if (!isApprovedWorkflowUser(user)) return;
    if (actor && lowerText(user.userId) === actor) return;
    picked.set(String(user.userId), user);
  };

  for (const user of users) {
    const uid = lowerText(user.userId);
    const name = lowerText(user.name);
    if (targetUserId && uid === targetUserId) addUser(user);
    if (targetUserName && name === targetUserName) addUser(user);
    if (stageIds.some(stageId => viewerMatchesStageTarget(job, stageId, user))) addUser(user);
    if (targetLabels.some(label => textMatchesUserIdentity(label, user))) addUser(user);
  }

  return Array.from(picked.values());
}

function notifyWorkflowEventTargets(data, req, event) {
  if (!event || !hasEventTarget(event)) return;
  const job = data.jobs.find(j => j.id === event.jobId);
  if (!job) return;
  const users = workflowTargetUsers(job, {
    targetUserId: event.targetUserId,
    targetUserName: event.targetUserName,
    targetLabel: event.targetLabel,
    targetStageIds: eventTargetStageIds(event),
  }, req.user?.userId || event.actorId || '');
  if (!users.length) return;
  const title = safeText(job.title, 80) || '워크플로우';
  const message = safeText(event.message, 180);
  const link = `workflow:${event.jobId || ''}:${event.id || ''}`;
  for (const user of users) {
    notify(user.userId, 'workflow', `[워크플로우] ${title}${message ? ' - ' + message : ''}`, link);
  }
}

function stageIndex(stageId) {
  const idx = STAGES.findIndex(s => s.id === stageId);
  return idx >= 0 ? idx : 0;
}

function normalizeJobPayload(body, existing = null) {
  const stageChecks = newStageChecks(existing?.stageChecks || {});
  const status = ['active', 'hold', 'done', 'cancelled'].includes(body.status) ? body.status : (existing?.status || 'active');
  return {
    title: safeText(body.title, 160),
    companyName: safeText(body.companyName, 120),
    projectName: safeText(body.projectName, 160),
    contactName: safeText(body.contactName, 80),
    contactPhone: safeText(body.contactPhone, 60),
    priority: ['low', 'normal', 'high', 'urgent'].includes(body.priority) ? body.priority : (existing?.priority || 'normal'),
    status,
    currentStage: STAGES.some(s => s.id === body.currentStage) ? body.currentStage : (existing?.currentStage || inferCurrentStage(stageChecks)),
    dueDate: safeDate(body.dueDate),
    factoryAvailableDate: safeDate(body.factoryAvailableDate),
    deliveryDate: safeDate(body.deliveryDate),
    summary: safeText(body.summary, 3000),
    stageChecks,
  };
}

function normalizeProjectStatus(value, fallback = 'active') {
  return ['active', 'done'].includes(value) ? value : fallback;
}

function workflowProjectKey(companyName, projectName) {
  const clean = value => safeText(value, 180)
    .toLowerCase()
    .replace(/[\s._\-()[\]{}]+/g, '');
  const companyKey = clean(companyName);
  const projectKey = clean(projectName);
  return companyKey && projectKey ? `${companyKey}|${projectKey}` : '';
}

function workflowProjectId(companyName, projectName) {
  const key = workflowProjectKey(companyName, projectName);
  const hash = crypto.createHash('sha1').update(key || `${companyName}|${projectName}`).digest('hex').slice(0, 14);
  return `prj_${hash}`;
}

function workflowProjectStatusFromJobs(data, companyName, projectName, fallback = 'active') {
  const key = workflowProjectKey(companyName, projectName);
  const fallbackStatus = normalizeProjectStatus(fallback);
  if (!key) return fallbackStatus;
  let total = 0;
  let active = 0;
  for (const job of data.jobs || []) {
    if (workflowProjectKey(job.companyName, job.projectName) !== key) continue;
    total += 1;
    if (!['done', 'cancelled'].includes(job.status || 'active')) active += 1;
  }
  if (active > 0) return 'active';
  if (total > 0) return 'done';
  return fallbackStatus;
}

function applyProjectStorageFields(project, storageInfo) {
  if (!project || !storageInfo) return;
  Object.assign(project, {
    storageRoot: 'design',
    storageBucket: storageInfo.rel,
    storageYear: storageInfo.year,
    storageCompanyFolder: storageInfo.companyFolderName,
    storageYearFolder: storageInfo.yearFolderName,
    storageProjectFolder: storageInfo.projectFolderName,
    storagePath: storageInfo.dir,
    storageNetPath: workflowDesignNetworkPath(storageInfo.dir),
  });
}

function upsertWorkflowProject(data, payload = {}, req = null, storageInfo = null) {
  if (!Array.isArray(data.projects)) data.projects = [];
  const companyName = safeText(payload.companyName, 120);
  const projectName = safeText(payload.projectName, 160);
  const key = workflowProjectKey(companyName, projectName);
  if (!key) return null;
  const at = nowIso();
  let project = data.projects.find(p => workflowProjectKey(p.companyName, p.projectName) === key);
  if (!project) {
    project = {
      id: workflowProjectId(companyName, projectName),
      companyName,
      projectName,
      year: safeYear(payload.year),
      status: normalizeProjectStatus(payload.status),
      createdBy: req?.user?.userId || '',
      createdByName: req ? userName(req) : '',
      createdAt: at,
      updatedAt: at,
    };
    data.projects.push(project);
  } else {
    Object.assign(project, {
      companyName,
      projectName,
      year: safeYear(payload.year || project.year),
      status: normalizeProjectStatus(payload.status, project.status || 'active'),
      updatedAt: at,
    });
  }
  if (storageInfo) applyProjectStorageFields(project, storageInfo);
  return project;
}

function projectStorageInfo(project) {
  if (!project?.companyName || !project?.projectName) return null;
  try {
    return resolveWorkflowDesignStorage(
      project.companyName,
      project.projectName,
      safeYear(project.storageYear || project.year || String(project.updatedAt || project.createdAt || '').slice(0, 4)),
      false,
    );
  } catch (_) {
    return null;
  }
}

function buildWorkflowProjects(data) {
  if (!Array.isArray(data.projects)) data.projects = [];
  const map = new Map();
  for (const project of data.projects) {
    const key = workflowProjectKey(project.companyName, project.projectName);
    if (!key) continue;
    map.set(key, {
      ...project,
      id: project.id || workflowProjectId(project.companyName, project.projectName),
      status: normalizeProjectStatus(project.status),
      source: 'project',
      jobCount: 0,
      activeJobCount: 0,
      doneJobCount: 0,
    });
    const storageInfo = projectStorageInfo(map.get(key));
    if (storageInfo) applyProjectStorageFields(map.get(key), storageInfo);
  }
  for (const job of data.jobs || []) {
    const key = workflowProjectKey(job.companyName, job.projectName);
    if (!key) continue;
    if (!map.has(key)) {
      map.set(key, {
        id: workflowProjectId(job.companyName, job.projectName),
        companyName: job.companyName,
        projectName: job.projectName,
        year: safeYear(String(job.dueDate || job.createdAt || '').slice(0, 4)),
        status: 'active',
        source: 'job',
        createdAt: job.createdAt || '',
        updatedAt: job.updatedAt || job.createdAt || '',
        storageRoot: job.storageRoot || '',
        storageBucket: job.storageBucket || '',
        storageYear: job.storageYear || '',
        storageCompanyFolder: job.storageCompanyFolder || '',
        storageYearFolder: job.storageYearFolder || '',
        storageProjectFolder: job.storageProjectFolder || '',
        storagePath: job.storagePath || '',
        storageNetPath: job.storageNetPath || '',
        jobCount: 0,
        activeJobCount: 0,
        doneJobCount: 0,
      });
      const storageInfo = projectStorageInfo(map.get(key));
      if (storageInfo) applyProjectStorageFields(map.get(key), storageInfo);
    }
    const project = map.get(key);
    project.jobCount += 1;
    if (['done', 'cancelled'].includes(job.status || 'active')) {
      project.doneJobCount += 1;
    } else {
      project.activeJobCount += 1;
    }
    if (!project.storageBucket && job.storageBucket) {
      applyProjectStorageFields(project, {
        rel: job.storageBucket,
        year: job.storageYear,
        companyFolderName: job.storageCompanyFolder,
        yearFolderName: job.storageYearFolder,
        projectFolderName: job.storageProjectFolder,
        dir: job.storagePath,
      });
    }
    if (job.updatedAt && String(job.updatedAt).localeCompare(String(project.updatedAt || '')) > 0) {
      project.updatedAt = job.updatedAt;
    }
  }
  return Array.from(map.values()).map(project => {
    const status = project.source === 'job' && project.activeJobCount <= 0 && project.jobCount > 0
      ? 'done'
      : normalizeProjectStatus(project.status);
    return {
      ...project,
      status,
      statusLabel: status === 'done' ? '완료' : '진행',
    };
  }).sort((a, b) => {
    const ap = a.status === 'done' ? 1 : 0;
    const bp = b.status === 'done' ? 1 : 0;
    if (ap !== bp) return ap - bp;
    return String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
      || String(a.companyName || '').localeCompare(String(b.companyName || ''), 'ko')
      || String(a.projectName || '').localeCompare(String(b.projectName || ''), 'ko');
  });
}

function addEvent(data, req, jobId, type, message, meta = {}) {
  const targetUserId = safeText(meta.eventTargetUserId, 80);
  const targetUserName = safeText(meta.eventTargetUserName, 80);
  const targetLabel = safeText(meta.eventTargetLabel, 120) || targetUserName;
  const eventMeta = { ...meta };
  delete eventMeta.eventTargetUserId;
  delete eventMeta.eventTargetUserName;
  delete eventMeta.eventTargetLabel;
  const event = {
    id: makeId('evt'),
    jobId,
    type,
    message: safeText(message, 3000),
    meta: eventMeta,
    targetUserId,
    targetUserName,
    targetLabel,
    readBy: [],
    actorId: req.user?.userId || '',
    actorName: userName(req),
    createdAt: nowIso(),
  };
  data.events.push(event);
  notifyWorkflowEventTargets(data, req, event);
  return event;
}

function markFileReadBy(file, req) {
  if (!Array.isArray(file.readBy)) file.readBy = [];
  const readerId = req.user?.userId || '';
  if (!file.readBy.some(r => r.userId === readerId)) {
    file.readBy.push({ userId: readerId, name: userName(req), at: nowIso() });
    return true;
  }
  return false;
}

function markEventReadBy(event, req) {
  if (!Array.isArray(event.readBy)) event.readBy = [];
  const readerId = req.user?.userId || '';
  if (!readerId) return false;
  if (!event.readBy.some(r => r.userId === readerId)) {
    event.readBy.push({ userId: readerId, name: userName(req), at: nowIso() });
    return true;
  }
  return false;
}

function hasEventTarget(event) {
  if (eventTargetStageIds(event).length) return true;
  return !!(
    String(event?.targetUserId || '').trim()
    || String(event?.targetUserName || '').trim()
    || String(event?.targetLabel || '').trim()
  );
}

function isEventTargetViewer(event, viewerUser, job = null) {
  const viewerId = String(viewerUser?.userId || '').trim().toLowerCase();
  const viewerName = String(viewerUser?.name || '').trim().toLowerCase();
  const targetUserId = String(event?.targetUserId || '').trim().toLowerCase();
  const targetUserName = String(event?.targetUserName || '').trim().toLowerCase();
  const targetLabel = String(event?.targetLabel || '').trim().toLowerCase();
  if (!hasEventTarget(event)) return false;
  const stageIds = eventTargetStageIds(event);
  if (job && stageIds.some(stageId => viewerMatchesStageTarget(job, stageId, viewerUser))) return true;
  if (targetUserId && viewerId && targetUserId === viewerId) return true;
  if (targetUserName && viewerName && targetUserName === viewerName) return true;
  if (targetLabel && viewerName && targetLabel.includes(viewerName)) return true;
  if (targetLabel && viewerId && targetLabel.includes(viewerId)) return true;
  if (job && targetLabelStageIds(targetLabel, job).some(stageId => viewerMatchesStageTarget(job, stageId, viewerUser))) return true;
  return false;
}

function isUnreadEventForViewer(event, viewerUser, job = null) {
  const userId = String(viewerUser?.userId || '');
  if (!event || !userId) return false;
  if (String(event.actorId || '') === userId) return false;
  if (!isEventTargetViewer(event, viewerUser, job)) return false;
  const readBy = Array.isArray(event.readBy) ? event.readBy : [];
  return !readBy.some(r => String(r.userId || '') === userId);
}

function hasEventTargetRead(event, job = null) {
  const readBy = Array.isArray(event?.readBy) ? event.readBy : [];
  if (!hasEventTarget(event) || !readBy.length) return false;
  const stageIds = eventTargetStageIds(event);
  if (job && stageIds.length) {
    return stageIds.every(stageId => readBy.some(reader => viewerMatchesStageTarget(job, stageId, reader)));
  }
  const targetUserId = String(event.targetUserId || '').trim().toLowerCase();
  const targetUserName = String(event.targetUserName || '').trim().toLowerCase();
  const targetLabel = String(event.targetLabel || '').trim().toLowerCase();
  const targetStageIds = job ? targetLabelStageIds(targetLabel, job) : [];
  if (job && targetStageIds.length) {
    return targetStageIds.every(stageId => readBy.some(reader => viewerMatchesStageTarget(job, stageId, reader)));
  }
  return readBy.some(r => {
    const userId = String(r.userId || '').trim().toLowerCase();
    const name = String(r.name || '').trim().toLowerCase();
    if (targetUserId && userId === targetUserId) return true;
    if (targetUserName && name === targetUserName) return true;
    if (targetLabel && name && targetLabel.includes(name)) return true;
    if (targetLabel && userId && targetLabel.includes(userId)) return true;
    return !targetUserId && !targetUserName && !!targetLabel;
  });
}

function decorateWorkflowEvent(event, viewerUser, job = null) {
  return {
    ...event,
    hasTarget: hasEventTarget(event),
    targetRead: hasEventTargetRead(event, job),
    viewerUnread: isUnreadEventForViewer(event, viewerUser, job),
  };
}

function isTargetViewer(file, viewerUser, job = null) {
  const viewerId = String(viewerUser?.userId || '').trim().toLowerCase();
  const viewerName = String(viewerUser?.name || '').trim().toLowerCase();
  const targetUserId = String(file?.targetUserId || '').trim().toLowerCase();
  const targetUserName = String(file?.targetUserName || '').trim().toLowerCase();
  const targetLabel = String(file?.targetLabel || '').trim().toLowerCase();
  const targetLabels = fileTargetLabels(file).map(v => String(v || '').trim().toLowerCase());
  const stageIds = fileTargetStageIds(file);
  const hasTarget = !!(targetUserId || targetUserName || targetLabel || targetLabels.length || stageIds.length);
  if (!hasTarget) return true;
  if (job && stageIds.some(stageId => viewerMatchesStageTarget(job, stageId, viewerUser))) return true;
  if (targetUserId && viewerId && targetUserId === viewerId) return true;
  if (targetUserName && viewerName && targetUserName === viewerName) return true;
  if (targetLabel && viewerName && targetLabel.includes(viewerName)) return true;
  if (targetLabel && viewerId && targetLabel.includes(viewerId)) return true;
  if (targetLabels.some(label => viewerName && label.includes(viewerName))) return true;
  if (targetLabels.some(label => viewerId && label.includes(viewerId))) return true;
  if (job && targetLabels.some(label => targetLabelStageIds(label, job).some(stageId => viewerMatchesStageTarget(job, stageId, viewerUser)))) return true;
  return false;
}

function isUnreadForViewer(file, viewerUser, job = null) {
  const userId = String(viewerUser?.userId || '');
  if (!file || !userId) return false;
  if (String(file.uploadedBy || '') === userId) return false;
  if (!isTargetViewer(file, viewerUser, job)) return false;
  const readBy = Array.isArray(file.readBy) ? file.readBy : [];
  return !readBy.some(r => String(r.userId || '') === userId);
}

function hasFileTarget(file) {
  if (fileTargetStageIds(file).length) return true;
  if (fileTargetLabels(file).length) return true;
  return !!(
    String(file?.targetUserId || '').trim()
    || String(file?.targetUserName || '').trim()
    || String(file?.targetLabel || '').trim()
  );
}

function readMatchesTarget(readBy, target, job = null) {
  const needle = String(target || '').trim().toLowerCase();
  if (!needle) return false;
  const stageIds = job ? targetLabelStageIds(needle, job) : [];
  if (job && stageIds.length) {
    return stageIds.some(stageId => (Array.isArray(readBy) ? readBy : []).some(reader => viewerMatchesStageTarget(job, stageId, reader)));
  }
  return (Array.isArray(readBy) ? readBy : []).some(r => {
    const userId = String(r.userId || '').trim().toLowerCase();
    const name = String(r.name || '').trim().toLowerCase();
    return (userId && needle.includes(userId)) || (name && needle.includes(name));
  });
}

function hasTargetRead(file, job = null) {
  const readBy = Array.isArray(file?.readBy) ? file.readBy : [];
  if (!hasFileTarget(file) || !readBy.length) return false;
  const stageIds = fileTargetStageIds(file);
  if (job && stageIds.length) {
    return stageIds.every(stageId => readBy.some(reader => viewerMatchesStageTarget(job, stageId, reader)));
  }
  const targetLabels = fileTargetLabels(file);
  if (targetLabels.length > 1) {
    return targetLabels.every(label => readMatchesTarget(readBy, label, job));
  }
  const targetUserId = String(file.targetUserId || '').trim().toLowerCase();
  const targetUserName = String(file.targetUserName || '').trim().toLowerCase();
  const targetLabel = String(file.targetLabel || '').trim().toLowerCase();
  const targetStageIds = job ? targetLabelStageIds(targetLabel, job) : [];
  if (job && targetStageIds.length) {
    return targetStageIds.every(stageId => readBy.some(reader => viewerMatchesStageTarget(job, stageId, reader)));
  }
  return readBy.some(r => {
    const userId = String(r.userId || '').trim().toLowerCase();
    const name = String(r.name || '').trim().toLowerCase();
    if (targetUserId && userId === targetUserId) return true;
    if (targetUserName && name === targetUserName) return true;
    if (targetLabel && name && targetLabel.includes(name)) return true;
    if (targetLabel && userId && targetLabel.includes(userId)) return true;
    return !targetUserId && !targetUserName && !!targetLabel;
  });
}

function isFileScheduleLate(file) {
  const wanted = safeDate(file?.designDueDate);
  const available = safeDate(file?.factoryAvailableDate);
  if (!wanted || !available) return false;
  if (file?.scheduleNegotiation === 'confirmed') return false;
  return available > wanted;
}

function factoryConfirmationFiles(data, job) {
  if (!data || !job || !Array.isArray(data.files)) return [];
  return data.files.filter(file => {
    if (file.jobId !== job.id) return false;
    const kind = file.kind || 'attachment';
    if (!['proof', 'drawing', 'photo'].includes(kind)) return false;
    const targetStages = fileTargetStageIds(file);
    if (targetStages.includes('factory')) return true;
    if (file.stageId === 'design') return true;
    const labels = fileTargetLabels(file);
    return labels.some(label => targetLabelStageIds(label, job).includes('factory'));
  });
}

function hasFactorySeenFile(data, job, file) {
  if (hasTargetRead(file, job)) return true;
  const orders = Array.isArray(data?.orders) ? data.orders : [];
  return orders.some(order => {
    if (order.jobId !== job.id || order.status === 'cancelled') return false;
    if (!orderTargetStageIds(order).includes('factory')) return false;
    const ids = new Set(normalizeFileIds(order.fileIds || []));
    if (!ids.has(file.id)) return false;
    return !!(order.lastPublicViewedAt || order.lastPublicDownloadedAt || order.responseStatus);
  });
}

function factoryConfirmationBlockers(data, job) {
  const files = factoryConfirmationFiles(data, job);
  if (!files.length) {
    return [{ key: 'factoryProofMissing', label: '공장 확인 대상 시안 없음', count: 1 }];
  }
  const unread = files.filter(file => !hasFactorySeenFile(data, job, file)).length;
  const missingDate = files.filter(file => !safeDate(file.factoryAvailableDate)).length;
  const notConfirmed = files.filter(file => !['possible', 'confirmed'].includes(file.scheduleNegotiation || '')).length;
  const blockers = [];
  if (unread) blockers.push({ key: 'factoryFileUnread', label: '공장 시안 미확인', count: unread });
  if (missingDate) blockers.push({ key: 'factoryAvailableDateMissing', label: '공장 가능일 미입력', count: missingDate });
  if (notConfirmed) blockers.push({ key: 'factorySchedulePending', label: '공장 일정 미확인', count: notConfirmed });
  return blockers;
}

function factoryConfirmationError(blockers = []) {
  const detail = blockers
    .map(b => `${b.label} ${b.count}`)
    .join(' · ');
  return `공장이 시안을 확인하고 가능일/일정 상태를 남겨야 다음 진행이 가능합니다.${detail ? ' (' + detail + ')' : ''}`;
}

function decorateWorkflowFile(file, viewerUser, job = null) {
  const exists = workflowFileExists(file);
  const image = isImageFile(file);
  const originalSafeName = safeStoredFileName(file.originalName || file.storedName || file.id || 'file');
  const storedName = String(file.storedName || '').trim();
  // 외부 공개 파일 토큰/링크는 admin·생성자·공장/경영관리 담당에게만. 그 외 뷰어에겐 토큰 제거 + 링크 빈값(유출 차단)
  const _vuF = viewerUser || {};
  const canSeePublicLink = _vuF.role === 'admin'
    || (!!job && !!_vuF.userId && String(_vuF.userId).toLowerCase() === String(job.createdBy || '').toLowerCase())
    || canDeptActOnStage({ user: _vuF }, 'factory')
    || canDeptActOnStage({ user: _vuF }, 'delivery');
  const publicDownloadUrl = canSeePublicLink && exists && file.publicToken ? `/api/workflow/public/files/${encodeURIComponent(file.publicToken)}/download` : '';
  const publicPreviewUrl = canSeePublicLink && exists && file.publicToken && image ? `/api/workflow/public/files/${encodeURIComponent(file.publicToken)}/preview` : '';
  const publicThumbUrl = canSeePublicLink && exists && file.publicToken && image ? `/api/workflow/public/files/${encodeURIComponent(file.publicToken)}/thumb` : '';
  const { publicToken: _publicTokenOmitF, ...fileSafe } = file;
  return {
    ...fileSafe,
    exists,
    missing: !exists,
    isImage: image,
    isAi: isAiFile(file),
    scheduleLate: isFileScheduleLate(file),
    storedNameChanged: !!(storedName && originalSafeName && storedName !== originalSafeName),
    previewUrl: exists && image ? `/api/workflow/files/${encodeURIComponent(file.id)}/preview` : '',
    thumbUrl: exists && image ? `/api/workflow/files/${encodeURIComponent(file.id)}/thumb` : '',
    downloadUrl: exists ? `/api/workflow/files/${encodeURIComponent(file.id)}/download` : '',
    publicDownloadUrl,
    publicPreviewUrl,
    publicThumbUrl,
    viewerUnread: isUnreadForViewer(file, viewerUser, job),
    hasTarget: hasFileTarget(file),
    targetRead: hasTargetRead(file, job),
  };
}

function isReviewableFile(file) {
  return ['proof', 'drawing'].includes(file?.kind || 'attachment');
}

function fileTargetDisplay(file) {
  const labels = fileTargetLabels(file);
  return labels.length ? labels.join(', ') : String(file?.targetLabel || file?.targetUserName || file?.targetUserId || '').trim();
}

function buildDeliverySummary(files, viewerUser, job = null) {
  const list = Array.isArray(files) ? files : [];
  const targetFiles = list.filter(hasFileTarget);
  const pendingTargetFiles = targetFiles.filter(f => !hasTargetRead(f, job));
  const reviewableFiles = list.filter(isReviewableFile);
  const pendingTargetLabels = Array.from(new Set(pendingTargetFiles.map(fileTargetDisplay).filter(Boolean)));
  return {
    totalFiles: list.length,
    targetedFiles: targetFiles.length,
    targetPendingFiles: pendingTargetFiles.length,
    targetReadFiles: Math.max(0, targetFiles.length - pendingTargetFiles.length),
    unreadForViewer: list.filter(f => Object.prototype.hasOwnProperty.call(f, 'viewerUnread') ? f.viewerUnread : isUnreadForViewer(f, viewerUser, job)).length,
    reviewableFiles: reviewableFiles.length,
    pendingReviews: reviewableFiles.filter(f => !f.reviewStatus || f.reviewStatus === 'pending').length,
    approvedReviews: reviewableFiles.filter(f => f.reviewStatus === 'approved').length,
    changeRequests: reviewableFiles.filter(f => f.reviewStatus === 'change_requested').length,
    pendingTargets: pendingTargetLabels.slice(0, 8),
    pendingTargetOverflow: Math.max(0, pendingTargetLabels.length - 8),
  };
}

function normalizeFileIds(value) {
  const raw = Array.isArray(value) ? value : String(value || '').split(',');
  return uniqueTexts(raw.map(v => safeText(v, 120)));
}

function normalizeOrderPayload(body = {}, existing = {}) {
  const targetPreset = buildWorkflowOrderTargets().find(t => t.id === body.targetPreset || t.label === body.targetName);
  const targetType = ['internal', 'external'].includes(body.targetType)
    ? body.targetType
    : (targetPreset?.type || existing.targetType || 'internal');
  let deliveryMethod = ['download', 'email'].includes(body.deliveryMethod)
    ? body.deliveryMethod
    : (targetPreset?.deliveryMethod || existing.deliveryMethod || (targetType === 'external' ? 'email' : 'download'));
  if (targetType === 'internal') deliveryMethod = 'download';
  const targetName = safeText(body.targetName || targetPreset?.label || existing.targetName || '우리공장', 120);
  const status = Object.prototype.hasOwnProperty.call(ORDER_STATUS_LABELS, body.status)
    ? body.status
    : (existing.status || 'draft');
  return {
    targetPreset: safeText(body.targetPreset || targetPreset?.id || existing.targetPreset || '', 80),
    targetType,
    targetName,
    deliveryMethod,
    status,
    dueDate: safeDate(body.dueDate) || existing.dueDate || '',
    fileIds: normalizeFileIds(body.fileIds || existing.fileIds || []),
    recipientEmail: safeText(body.recipientEmail || targetPreset?.recipientEmail || existing.recipientEmail || '', 300),
    recipientCc: safeText(body.recipientCc || existing.recipientCc || '', 500),
    recipientName: safeText(body.recipientName || targetPreset?.recipientName || existing.recipientName || '', 120),
    note: safeText(body.note || existing.note || '', 3000),
  };
}

function orderFiles(data, order, job = null) {
  const ids = new Set(normalizeFileIds(order?.fileIds || []));
  return (data.files || [])
    .filter(f => (!job || f.jobId === job.id) && ids.has(f.id))
    .filter(f => {
      const full = fileDiskPath(f);
      return !!(full && fs.existsSync(full));
    });
}

function normalizeOrderResponse(body = {}) {
  const responseStatus = Object.prototype.hasOwnProperty.call(ORDER_RESPONSE_LABELS, body.responseStatus)
    ? body.responseStatus
    : 'possible';
  return {
    responseStatus,
    responseAvailableDate: safeDate(body.responseAvailableDate || body.availableDate),
    responseNote: safeText(body.responseNote || body.note, 3000),
    respondedByName: safeText(body.respondedByName || body.responderName, 120),
  };
}

function normalizePublicFileResponses(value, files, fallback = {}) {
  const allowedIds = new Set((files || []).map(f => String(f.id || '')));
  const raw = Array.isArray(value) ? value : [];
  const out = [];
  for (const item of raw) {
    const fileId = safeText(item?.fileId || item?.id, 120);
    if (!fileId || !allowedIds.has(fileId)) continue;
    const responseStatus = Object.prototype.hasOwnProperty.call(ORDER_RESPONSE_LABELS, item?.responseStatus)
      ? item.responseStatus
      : (fallback.responseStatus || 'possible');
    out.push({
      fileId,
      responseStatus,
      responseAvailableDate: safeDate(item?.responseAvailableDate || item?.availableDate),
      responseNote: safeText(item?.responseNote || item?.note, 1000),
    });
  }
  return out;
}

function aggregateFileResponses(fileResponses, fallback = {}) {
  if (!fileResponses.length) return fallback.responseStatus || 'possible';
  if (fileResponses.some(r => r.responseStatus === 'needs_change')) return 'needs_change';
  if (fileResponses.every(r => r.responseStatus === 'confirmed')) return 'confirmed';
  return 'possible';
}

function summarizePublicFileResponses(fileResponses) {
  const summary = {
    total: Array.isArray(fileResponses) ? fileResponses.length : 0,
    possible: 0,
    confirmed: 0,
    needsChange: 0,
    dates: [],
  };
  if (!summary.total) return summary;

  const dates = new Set();
  for (const response of fileResponses) {
    if (response.responseStatus === 'needs_change') summary.needsChange += 1;
    else if (response.responseStatus === 'confirmed') summary.confirmed += 1;
    else summary.possible += 1;
    if (response.responseAvailableDate) dates.add(response.responseAvailableDate);
  }
  summary.dates = Array.from(dates).sort();
  return summary;
}

function publicFileResponseText(summary) {
  if (!summary?.total) return '';
  const parts = [`파일별 회신 ${summary.total}건`];
  if (summary.needsChange) parts.push(`조정요청 ${summary.needsChange}`);
  if (summary.confirmed) parts.push(`확정 ${summary.confirmed}`);
  if (summary.possible) parts.push(`가능 ${summary.possible}`);
  if (summary.dates?.length === 1) {
    parts.push(`가능일 ${summary.dates[0]}`);
  } else if (summary.dates?.length > 1) {
    parts.push(`가능일 ${summary.dates[0]} 외 ${summary.dates.length - 1}`);
  }
  return ` · ${parts.join(' · ')}`;
}

function orderStatusFromResponse(responseStatus) {
  if (responseStatus === 'needs_change') return 'replied';
  return 'confirmed';
}

function orderTargetStageIds(order) {
  if (!order) return [];
  // 내부(우리공장)=대림컴퍼니, 외부(거래처)=영업지원팀
  return order.targetType === 'internal' ? ['factory'] : ['delivery'];
}

function markPublicOrderActivity(data, job, order, kind, meta = {}) {
  if (!data || !job || !order) return false;
  const at = nowIso();
  let shouldEvent = true;
  if (kind === 'view') {
    const lastViewMs = Date.parse(order.lastPublicViewedAt || '');
    if (Number.isFinite(lastViewMs) && Date.now() - lastViewMs < 10 * 60 * 1000) shouldEvent = false;
    order.lastPublicViewedAt = at;
    if (shouldEvent) order.publicViewCount = Number(order.publicViewCount || 0) + 1;
  } else if (kind === 'download') {
    order.lastPublicDownloadedAt = at;
    order.publicDownloadCount = Number(order.publicDownloadCount || 0) + 1;
  } else {
    return false;
  }
  order.updatedAt = at;
  job.updatedAt = at;
  // 변화 없는(쓰로틀된) 열람은 false 반환 → 호출부가 saveStore를 건너뛰어 매 공개 GET마다 전체 스토어 재기록되는 DoS 방지.
  if (!shouldEvent) return false;
  const type = kind === 'download' ? 'order_public_download' : 'order_public_view';
  const filePart = kind === 'download' && meta.fileName ? ` · ${meta.fileName}` : '';
  const label = kind === 'download' ? `파일 다운로드${filePart}` : '전달 화면 열람';
  addEvent(data, { user: { userId: 'public-order', name: order.targetName || '외부 확인' } }, job.id, type, `${label} · ${order.targetName || '전달 대상'}`, {
    orderId: order.id,
    targetName: order.targetName || '',
    count: kind === 'download' ? order.publicDownloadCount : order.publicViewCount,
    ...meta,
    eventTargetUserId: job.createdBy || '',
    eventTargetUserName: job.createdByName || '',
    eventTargetLabel: stageTargetLabels(job, ['design', 'delivery']).join(', '),
    targetStageIds: ['design', 'delivery'],
  });
  return true;
}

function decoratePublicOrderFile(file, order = null) {
  const orderQuery = order?.publicToken ? `?order=${encodeURIComponent(order.publicToken)}` : '';
  return {
    id: file.id,
    originalName: file.originalName || file.storedName || file.id,
    kind: file.kind || 'attachment',
    stageId: file.stageId || '',
    version: file.version || 1,
    mime: file.mime || '',
    size: file.size || 0,
    isImage: isImageFile(file),
    isAi: isAiFile(file),
    designDueDate: file.designDueDate || '',
    factoryAvailableDate: file.factoryAvailableDate || '',
    factoryScheduleNote: file.factoryScheduleNote || '',
    urgent: !!file.urgent,
    scheduleNegotiation: file.scheduleNegotiation || 'pending',
    downloadUrl: file.publicToken ? `/api/workflow/public/files/${encodeURIComponent(file.publicToken)}/download${orderQuery}` : '',
    previewUrl: file.publicToken && isImageFile(file) ? `/api/workflow/public/files/${encodeURIComponent(file.publicToken)}/preview` : '',
    thumbUrl: file.publicToken && isImageFile(file) ? `/api/workflow/public/files/${encodeURIComponent(file.publicToken)}/thumb` : '',
  };
}

function decorateOrder(data, job, order) {
  const files = orderFiles(data, order, job);
  const fileTotalSize = files.reduce((sum, file) => sum + Number(file.size || 0), 0);
  const safeOrder = { ...(order || {}) };
  delete safeOrder.mailTo;
  delete safeOrder.mailCc;
  delete safeOrder.mailSubject;
  delete safeOrder.mailBody;
  const publicViewUrl = order.publicToken ? `/workflow/order/${encodeURIComponent(order.publicToken)}` : '';
  const publicArchiveUrl = order.publicToken ? `/api/workflow/public/orders/${encodeURIComponent(order.publicToken)}/files.zip` : '';
  return {
    ...safeOrder,
    fileCount: files.length,
    fileTotalSize,
    mailAttachLimit: MAX_WORKFLOW_MAIL_ATTACH_BYTES,
    mailAttachmentTooLarge: fileTotalSize > MAX_WORKFLOW_MAIL_ATTACH_BYTES,
    fileNames: files.map(f => f.originalName || f.storedName || f.id),
    statusLabel: ORDER_STATUS_LABELS[order.status] || order.status || '초안',
    targetTypeLabel: order.targetType === 'external' ? '외주/업체' : '우리공장',
    deliveryMethod: order.deliveryMethod || (order.targetType === 'external' ? 'email' : 'download'),
    deliveryMethodLabel: ORDER_DELIVERY_METHOD_LABELS[order.deliveryMethod || (order.targetType === 'external' ? 'email' : 'download')] || 'ERP 다운로드',
    responseStatusLabel: ORDER_RESPONSE_LABELS[order.responseStatus] || '',
    publicViewUrl,
    publicArchiveUrl,
    publicViewAbsoluteUrl: absoluteWorkflowPublicUrl(publicViewUrl),
    publicArchiveAbsoluteUrl: absoluteWorkflowPublicUrl(publicArchiveUrl),
  };
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function loadWorkflowSmtpSettings() {
  if (typeof mailRoute.getConfiguredSmtpSettings !== 'function') return null;
  return mailRoute.getConfiguredSmtpSettings();
}

function absoluteWorkflowOrderUrl(order, req = null) {
  if (!order?.publicToken) return '';
  const relative = `/workflow/order/${encodeURIComponent(order.publicToken)}`;
  let base = publicWorkflowBaseUrl();
  if (!base && req) {
    const proto = safeText(req.headers['x-forwarded-proto'] || req.protocol || 'http', 20).split(',')[0];
    const host = safeText(req.headers['x-forwarded-host'] || req.get?.('host') || req.headers.host || '', 200).split(',')[0];
    base = host && !isPrivateHostname(host) ? normalizePublicBaseUrl(`${proto}://${host}`) : '';
  }
  if (base && !isPublicWorkflowBaseUrl(base)) return '';
  return base ? `${base}${relative}` : '';
}

function defaultWorkflowOrderMailSubject(job, order) {
  const project = job.projectName || job.title || '';
  return `[제작요청] ${job.companyName || '프로젝트'}${project ? ' - ' + project : ''} / ${order.targetName || '업체'}`;
}

function buildWorkflowOrderMailHtml(job, order, files, message, publicUrl) {
  // 본문 = 사장님이 적은 내용만(2026-06-17 요청) — 자동 인사말/표(회사·프로젝트·납기·파일)/맺음말 넣지 않음.
  // 링크(publicUrl)는 호출부가 '대용량 첨부 폴백(attachFiles=false)'일 때만 넘겨준다 — 일반 첨부 메일엔 링크 없음.
  const memo = String(message || order.note || '').trim();
  const bodyHtml = memo ? escapeHtml(memo).replace(/\n/g, '<br>') : '';
  return `<!doctype html><html><body style="margin:0;padding:0;font-family:'Malgun Gothic','맑은 고딕',Arial,sans-serif;color:#222;">
    <div style="font-size:14px;line-height:1.8;">
      ${bodyHtml ? `<p style="margin:0 0 16px;">${bodyHtml}</p>` : ''}
      ${publicUrl ? `<p style="margin:0;">ERP 확인/다운로드: <a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a></p>` : ''}
    </div>
  </body></html>`;
}

function workflowOrderMailAttachments(files, attachFiles) {
  if (!attachFiles) return { attachments: [], totalBytes: 0, skipped: files.length };
  // A) AI 파일은 파일명에 '발주'가 든 것만 첨부(=공장으로 보냄). 그 외 AI(수정용·폰트 안 깬 것)는 서버 저장만 — 사장님 정책(2026-06-16). 비AI(시안 이미지 등)는 그대로.
  const sendList = files.filter(f => !isAiFile(f) || String(f.originalName || f.storedName || '').includes('발주'));
  const attachments = [];
  let totalBytes = 0;
  for (const file of sendList) {
    const full = fileDiskPath(file);
    if (!full || !fs.existsSync(full)) continue;
    const stat = fs.statSync(full);
    totalBytes += stat.size;
    if (totalBytes > MAX_WORKFLOW_MAIL_ATTACH_BYTES) {
      return { attachments, totalBytes, tooLarge: true, skipped: files.length - attachments.length };
    }
    attachments.push({
      filename: file.originalName || file.storedName || file.id || 'workflow-file',
      contentType: file.mime || 'application/octet-stream',
      content: fs.readFileSync(full),
    });
  }
  return { attachments, totalBytes, skipped: files.length - attachments.length };
}

function decoratePublicOrder(data, job, order) {
  const files = orderFiles(data, order, job);
  const decorated = decorateOrder(data, job, order);
  return {
    ok: true,
    job: {
      id: job.id,
      title: job.title || '',
      companyName: job.companyName || '',
      projectName: job.projectName || '',
      dueDate: job.dueDate || '',
      deliveryDate: job.deliveryDate || '',
      priority: job.priority || 'normal',
      summary: job.summary || '',
    },
    order: {
      id: order.id,
      targetName: order.targetName || '',
      targetType: order.targetType || 'internal',
      status: order.status || 'draft',
      statusLabel: decorated.statusLabel,
      dueDate: order.dueDate || '',
      note: order.note || '',
      fileCount: files.length,
      responseStatus: order.responseStatus || '',
      responseStatusLabel: decorated.responseStatusLabel,
      responseAvailableDate: order.responseAvailableDate || '',
      responseNote: order.responseNote || '',
      respondedByName: order.respondedByName || '',
      respondedAt: order.respondedAt || '',
      publicArchiveUrl: decorated.publicArchiveUrl,
    },
    files: files.map(file => decoratePublicOrderFile(file, order)),
    responseLabels: ORDER_RESPONSE_LABELS,
  };
}

function applyOrderResponseToFiles(files, response, fileResponses = []) {
  const byFileId = new Map(fileResponses.map(item => [item.fileId, item]));
  for (const file of files) {
    const fileResponse = byFileId.get(file.id) || {};
    const responseStatus = fileResponse.responseStatus || response.responseStatus || 'possible';
    const hasFileDate = Object.prototype.hasOwnProperty.call(fileResponse, 'responseAvailableDate');
    const hasFileNote = Object.prototype.hasOwnProperty.call(fileResponse, 'responseNote');
    const nextDate = hasFileDate ? fileResponse.responseAvailableDate : response.responseAvailableDate;
    const nextNote = hasFileNote ? fileResponse.responseNote : response.responseNote;
    file.factoryAvailableDate = safeDate(nextDate);
    file.scheduleNegotiation = responseStatus === 'needs_change'
      ? 'needs_change'
      : responseStatus === 'confirmed'
        ? 'confirmed'
        : 'possible';
    file.factoryScheduleNote = safeText(nextNote, 1000);
    file.scheduleUpdatedAt = nowIso();
    file.scheduleUpdatedBy = 'public-order';
    file.scheduleUpdatedByName = response.respondedByName || 'public-order';
    file.updatedAt = nowIso();
  }
}

function buildOrderSummary(data, job) {
  const orders = (data.orders || []).filter(o => o.jobId === job.id);
  return {
    total: orders.length,
    active: orders.filter(o => !['done', 'cancelled'].includes(o.status || 'draft')).length,
    external: orders.filter(o => o.targetType === 'external').length,
    internal: orders.filter(o => o.targetType !== 'external').length,
    pending: orders.filter(o => ['draft', 'requested', 'sent', 'replied'].includes(o.status || 'draft')).length,
  };
}

function isOverdueJob(job) {
  if (!job || job.status === 'done' || job.status === 'cancelled' || !job.dueDate) return false;
  return isPastDue(job.dueDate);
}

function isPastDue(dateValue) {
  if (!dateValue) return false;
  const today = new Date().toISOString().slice(0, 10);
  return String(dateValue) < today;
}

function addDaysIso(dateIso, days) {
  const d = new Date(`${dateIso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isScheduleVisible(dateValue, endDate) {
  const date = safeDate(dateValue);
  if (!date) return false;
  return isPastDue(date) || date <= endDate;
}

function buildScheduleItems(data, req) {
  const today = new Date().toISOString().slice(0, 10);
  const endDate = addDaysIso(today, 7);
  const activeJobs = data.jobs.filter(j => !['done', 'cancelled'].includes(j.status));
  const items = [];

  function pushItem(job, item) {
    const dueDate = safeDate(item.dueDate);
    if (!dueDate || !isScheduleVisible(dueDate, endDate)) return;
    if (!isWorkflowAdmin(req)) {
      const stageId = safeText(item.stageId, 30);
      const mine = stageId ? viewerMatchesStageTarget(job, stageId, req.user) || isUserJob(job, req) : isUserJob(job, req);
      if (!mine) return;
    }
    items.push({
      id: `${job.id}:${item.kind}:${item.stageId || 'job'}:${dueDate}`,
      jobId: job.id,
      title: job.title || '',
      companyName: job.companyName || '',
      projectName: job.projectName || '',
      kind: item.kind,
      label: item.label,
      dueDate,
      overdue: isPastDue(dueDate),
      today: dueDate === today,
      stageId: item.stageId || '',
      stageLabel: item.stageLabel || '',
      assignee: item.assignee || '',
      mine: isUserJob(job, req),
      priority: job.priority || 'normal',
    });
  }

  for (const job of activeJobs) {
    if (job.dueDate) {
      pushItem(job, {
        kind: 'job',
        label: '작업마감',
        dueDate: job.dueDate,
        assignee: job.contactName || '',
      });
    }
    if (job.deliveryDate) {
      pushItem(job, {
        kind: 'delivery',
        label: '납품일',
        dueDate: job.deliveryDate,
        assignee: job.contactName || '',
      });
    }
    for (const stage of STAGES) {
      const check = job.stageChecks?.[stage.id] || {};
      if (check.status === 'done' || !check.dueDate) continue;
      pushItem(job, {
        kind: 'stage',
        label: `${workflowStageLabel(stage.id) || stage.label} 마감`,
        dueDate: check.dueDate,
        stageId: stage.id,
        stageLabel: workflowStageLabel(stage.id) || stage.label,
        assignee: check.assignee || '',
      });
    }
  }

  return items
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (a.today !== b.today) return a.today ? -1 : 1;
      const byDate = String(a.dueDate).localeCompare(String(b.dueDate));
      if (byDate !== 0) return byDate;
      return String(a.title).localeCompare(String(b.title), 'ko');
    })
    .slice(0, 12);
}

function blockedStageCount(job) {
  return Object.values(job.stageChecks || {}).filter(c => c && c.status === 'blocked').length;
}

function overdueStageCount(job) {
  if (!job || job.status === 'done' || job.status === 'cancelled') return 0;
  return Object.values(job.stageChecks || {})
    .filter(c => c && c.status !== 'done' && isPastDue(c.dueDate)).length;
}

function nextStageDue(job) {
  if (!job || !job.stageChecks) return null;
  const pending = STAGES
    .map(stage => ({ stage, check: job.stageChecks[stage.id] || {} }))
    .filter(({ check }) => check.status !== 'done' && check.dueDate)
    .sort((a, b) => String(a.check.dueDate).localeCompare(String(b.check.dueDate)));
  if (!pending.length) return null;
  const first = pending[0];
  return {
    stageId: first.stage.id,
    stageLabel: workflowStageLabel(first.stage.id) || first.stage.label,
    dueDate: first.check.dueDate,
    overdue: isPastDue(first.check.dueDate),
  };
}

function changeRequestCount(data, job) {
  if (!job || !data || !Array.isArray(data.files)) return 0;
  return data.files.filter(f => {
    if (f.jobId !== job.id) return false;
    return f.reviewStatus === 'change_requested' || f.scheduleNegotiation === 'needs_change';
  }).length;
}

function lateScheduleCount(data, job) {
  if (!job || !data || !Array.isArray(data.files)) return 0;
  return data.files.filter(f => f.jobId === job.id && isFileScheduleLate(f)).length;
}

function urgentOpenFileCount(data, job) {
  if (!job || ['done', 'cancelled'].includes(job.status || 'active') || !data || !Array.isArray(data.files)) return 0;
  return data.files.filter(f => {
    if (f.jobId !== job.id || !f.urgent) return false;
    return !f.scheduleNegotiation || f.scheduleNegotiation === 'pending' || f.scheduleNegotiation === 'needs_change';
  }).length;
}

function pendingStageCount(job) {
  if (!job || !job.stageChecks) return STAGES.length;
  return STAGES.filter(stage => job.stageChecks[stage.id]?.status !== 'done').length;
}

function pendingChecklistCount(job) {
  if (!job || !job.stageChecks) return 0;
  return STAGES.reduce((sum, stage) => {
    const items = job.stageChecks[stage.id]?.checklist || [];
    return sum + items.filter(item => !item.done).length;
  }, 0);
}

function pendingReviewCount(data, job) {
  if (!job || !data || !Array.isArray(data.files)) return 0;
  return data.files.filter(f => {
    if (f.jobId !== job.id) return false;
    if (!['proof', 'drawing'].includes(f.kind || 'attachment')) return false;
    return !f.reviewStatus || f.reviewStatus === 'pending';
  }).length;
}

function pendingOrderCount(data, job) {
  if (!job || !data || !Array.isArray(data.orders)) return 0;
  return data.orders.filter(order => {
    if (order.jobId !== job.id) return false;
    if (order.responseStatus === 'needs_change' || order.status === 'replied') return false;
    return !['done', 'confirmed', 'cancelled'].includes(order.status || 'draft');
  }).length;
}

function orderChangeRequestCount(data, job) {
  if (!job || !data || !Array.isArray(data.orders)) return 0;
  return data.orders.filter(order => {
    if (order.jobId !== job.id) return false;
    if (['done', 'confirmed', 'cancelled'].includes(order.status || 'draft')) return false;
    return order.responseStatus === 'needs_change' || order.status === 'replied';
  }).length;
}

function completionBlockers(data, job, opts = {}) {
  // 사장님 정책(2026-06-14): 완료는 '권한'만으로 가능. 팀별 확인 강제 게이트 폐지
  // (모든 팀이 검토대기 승인·공장 시안확인·가능일·일정·체크·전달확정을 일일이 눌러야 완료되던 방식 제거).
  // 단 하나, 데이터 무결성만 유지 — 참조 파일이 디스크에서 실제로 사라진 경우(완료 시 과거내역 ZIP이 깨지므로).
  // 공장 [받기]/[수락]/완료가능일 버튼은 그대로 존재하나(쓰고 싶으면 사용), 완료를 막지는 않음.
  const blockers = [];
  const missingFiles = opts.skipFileExists ? 0 : missingFileCount(data, job, data?.fileExistsCache || null);
  if (missingFiles) blockers.push({ key: 'missingFiles', label: '서버 파일 없음', count: missingFiles });
  return blockers;
}

function userMatchTokens(req) {
  return [req.user?.userId, req.user?.name]
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
}

function isWorkflowAdmin(req) {
  return req?.user?.role === 'admin';
}

function canAbortEmptyJob(data, job, req) {
  if (!job) return false;
  if (!isWorkflowAdmin(req) && String(job.createdBy || '') !== String(req?.user?.userId || '')) return false;
  const files = Array.isArray(data?.files) ? data.files.filter(file => file.jobId === job.id) : [];
  const orders = Array.isArray(data?.orders) ? data.orders.filter(order => order.jobId === job.id) : [];
  const events = Array.isArray(data?.events) ? data.events.filter(event => event.jobId === job.id) : [];
  const hasUserWork = events.some(event => event.type && event.type !== 'create');
  return files.length === 0 && orders.length === 0 && !hasUserWork;
}

function removeAutoCreatedProjectForJob(data, job) {
  if (!job?.autoCreatedProjectId || !Array.isArray(data?.projects)) return false;
  const key = workflowProjectKey(job.companyName, job.projectName);
  if (!key) return false;
  const hasOtherJob = (data.jobs || []).some(other => (
    other.id !== job.id && workflowProjectKey(other.companyName, other.projectName) === key
  ));
  if (hasOtherJob) return false;
  const idx = data.projects.findIndex(project => (
    project.id === job.autoCreatedProjectId && workflowProjectKey(project.companyName, project.projectName) === key
  ));
  if (idx < 0) return false;
  data.projects.splice(idx, 1);
  return true;
}

function textMatchesToken(text, tokens) {
  const hay = String(text || '').trim().toLowerCase();
  return !!hay && tokens.some(token => hay.includes(token));
}

function isUserJob(job, req) {
  const tokens = userMatchTokens(req);
  const userId = String(req.user?.userId || '').trim().toLowerCase();
  if (!job || !tokens.length) return false;
  if (userId && String(job.createdBy || '').trim().toLowerCase() === userId) return true;
  if (textMatchesToken(job.createdByName, tokens)) return true;
  return Object.entries(job.stageChecks || {}).some(([stageId, check]) => {
    if (!check || check.status === 'done') return false;
    if (viewerMatchesStageTarget(job, stageId, req.user)) return true;
    return textMatchesToken(check.assignee, tokens);
  });
}

// ── 워크플로 변경 권한(부서-단계 매핑 게이트) — admin/생성자/해당 단계 담당 부서만 ──
const WF_NO_PERM = '이 작업을 변경할 권한이 없습니다. (담당 부서·단계 또는 관리자만 가능)';
function isJobCreator(job, req) {
  const uid = String(req?.user?.userId || '').trim().toLowerCase();
  return !!uid && String(job?.createdBy || '').trim().toLowerCase() === uid;
}
// ── 인가 전용 부서-단계 매처(알림 매처와 분리) ──
// 알림용 viewerMatchesStageTarget은 양방향 substring이라 인가엔 부적합('영업관리팀'이 '영업'으로 delivery 오매칭, '출력팀'이 어떤 별칭과도 비겹쳐 차단 등).
// 인가는: 명시 팀매칭(stageDepartmentMap, 정확 id) OR 인가별칭 풀네임 정확일치만. 이름토큰·짧은단편 사용 안 함.
const STAGE_AUTHZ_ALIASES = {
  design: ['디자인팀', '디자인'],
  factory: ['대림컴퍼니', '공장', '공장팀', '생산팀', '제작팀', '용접팀', '출력팀'],
  delivery: ['경영관리팀', '경영관리'],
};
function canDeptActOnStage(req, stageId) {
  if (!STAGES.some(s => s.id === stageId)) return false;
  const org = loadOrgSnapshot();
  const me = (org.users || []).find(u => lowerText(u.userId) === lowerText(req?.user?.userId));
  const deptVal = (me && me.department) || req?.user?.department || '';
  if (!deptVal) return false;
  const dept = (org.departments || []).find(d => lowerText(d.id) === lowerText(deptVal) || lowerText(d.name) === lowerText(deptVal));
  const deptId = lowerText(dept ? dept.id : deptVal);
  const deptKey = departmentMatchKey(dept ? dept.name : deptVal);
  const mappedId = lowerText(storedWorkflowStageDepartmentMap()[stageId] || '');
  if (mappedId && deptId === mappedId) return true; // 팀매칭 설정 시 정확 id 일치
  return (STAGE_AUTHZ_ALIASES[stageId] || []).map(departmentMatchKey).includes(deptKey); // 폴백: 풀네임 정확일치
}
// 이 단계 담당 부서의 '팀장'인가 — 예: 공장=대림컴퍼니 팀장(전상현 실장) → 시안 용접/출력 배정 전담.
// (가져오기는 공장원 누구나, 팀 나누기만 팀장 몫)
function isStageDeptLeader(req, stageId) {
  const org = loadOrgSnapshot();
  const me = (org.users || []).find(u => lowerText(u.userId) === lowerText(req?.user?.userId));
  if (!me || !me.id) return false;
  const mappedId = lowerText(storedWorkflowStageDepartmentMap()[stageId] || '');
  const aliasKeys = (STAGE_AUTHZ_ALIASES[stageId] || []).map(departmentMatchKey);
  return (org.departments || []).some(d => {
    if (lowerText(d.leaderId) !== lowerText(me.id)) return false;
    return (mappedId && lowerText(d.id) === mappedId) || aliasKeys.includes(departmentMatchKey(d.name));
  });
}
// 특정 단계 담당(또는 생성자/admin)인가
function canActOnStage(job, req, stageId) {
  if (isWorkflowAdmin(req)) return true;
  if (!job) return false;
  if (isJobCreator(job, req)) return true;
  return !!(stageId && canDeptActOnStage(req, stageId));
}
// 현재 진행 단계 담당(되돌리기 등)
function canActOnCurrentStage(job, req) {
  if (isWorkflowAdmin(req) || isJobCreator(job, req)) return true;
  const curId = inferCurrentStage(job?.stageChecks || {}, job?.currentStage || 'design');
  return canDeptActOnStage(req, curId);
}
// 넘기기: 현재 단계(밀기) 또는 다음 단계(가져오기·당기기) 담당이면 허용 — '공장이 가져감' 동선
function canHandoffJob(job, req, currentStageId, nextStageId) {
  if (isWorkflowAdmin(req) || isJobCreator(job, req)) return true;
  if (currentStageId && canDeptActOnStage(req, currentStageId)) return true;
  if (nextStageId && canDeptActOnStage(req, nextStageId)) return true;
  return false;
}
// 현장명 변경 승인: 팀장(admin 포함)이면서 이 발주의 어느 단계든 자기 부서가 담당
function isJobRenameApprover(job, req) {
  if (isWorkflowAdmin(req)) return true;
  if (!isWorkflowApprover(req)) return false;
  return isJobCreator(job, req) || STAGES.some(s => canDeptActOnStage(req, s.id));
}

function workflowJobSearchText(data, job) {
  const files = (data.files || []).filter(f => f.jobId === job.id);
  const orders = (data.orders || []).filter(o => o.jobId === job.id);
  return [
    job.title,
    job.companyName,
    job.projectName,
    job.contactName,
    job.contactPhone,
    job.summary,
    job.storageBucket,
    job.storageCompanyFolder,
    job.storageProjectFolder,
    job.archiveStorageBucket,
    files.map(f => [
      f.originalName,
      f.storedName,
      f.storageBucket,
      f.storageCompanyName,
      f.storageProjectName,
      f.targetLabel,
      f.note,
    ].join(' ')).join(' '),
    orders.map(o => [
      o.targetName,
      o.note,
      o.fileNames,
    ].join(' ')).join(' '),
  ].join(' ').toLowerCase();
}

function workflowItemsByJob(items = []) {
  const map = new Map();
  for (const item of items || []) {
    const jobId = item?.jobId || '';
    if (!jobId) continue;
    if (!map.has(jobId)) map.set(jobId, []);
    map.get(jobId).push(item);
  }
  return map;
}

function decorateJob(data, job, viewerUser = null, options = {}) {
  const files = options.filesByJob ? (options.filesByJob.get(job.id) || []) : data.files.filter(f => f.jobId === job.id);
  const events = options.eventsByJob ? (options.eventsByJob.get(job.id) || []) : data.events.filter(e => e.jobId === job.id);
  const orders = options.ordersByJob ? (options.ordersByJob.get(job.id) || []) : (data.orders || []).filter(o => o.jobId === job.id);
  const fileExistsCache = options.fileExistsCache || data.fileExistsCache || null;
  const scopedData = { ...data, files, events, orders, fileExistsCache };
  const orderSummary = buildOrderSummary(scopedData, job);
  const blockers = completionBlockers(scopedData, job, { skipFileExists: options.skipFileExists });
  const jobMissingFileCount = options.skipFileExists ? 0 : missingFileCount(scopedData, job, fileExistsCache);
  const unreadFileCount = files.filter(f => isUnreadForViewer(f, viewerUser, job)).length;
  const unreadEventCount = events.filter(e => isUnreadEventForViewer(e, viewerUser, job)).length;
  const storedArchiveCount = Number(job.archiveFileCount);
  const archiveFileCount = Number.isFinite(storedArchiveCount) ? storedArchiveCount : files.length;
  const visualFiles = files
    .filter(f => isImageFile(f))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const primaryVisualFile = options.skipFileExists
    ? (visualFiles[0] || null)
    : options.skipVisualFileExists
      ? (visualFiles[0] && workflowFileExistsCached(visualFiles[0], fileExistsCache) ? visualFiles[0] : null)
      : (visualFiles.find(f => workflowFileExistsCached(f, fileExistsCache)) || null);
  // 외부 공장 받기 링크(publicToken)는 관리자·생성자·공장/경영관리 담당에게만 노출. 그 외엔 토큰 자체를 응답에서 제거.
  const vuPL = viewerUser || {};
  const canSeePublicLink = vuPL.role === 'admin'
    || (!!vuPL.userId && String(vuPL.userId).toLowerCase() === String(job.createdBy || '').toLowerCase())
    || canDeptActOnStage({ user: vuPL }, 'factory')
    || canDeptActOnStage({ user: vuPL }, 'delivery');
  const reqLikePL = { user: vuPL };
  const curStageIdPL = inferCurrentStage(job.stageChecks || {}, job.currentStage || 'design');
  const nextStageIdPL = (STAGES[stageIndex(curStageIdPL) + 1] || {}).id || '';
  const { publicToken: _publicTokenOmit, ...jobSafe } = job;
  return {
    ...jobSafe,
    fileCount: files.length,
    // 뷰어 권한 플래그 — 프론트가 버튼 노출을 서버 권한과 일치시켜 403 클릭을 방지
    viewerCanHandoff: canHandoffJob(job, reqLikePL, curStageIdPL, nextStageIdPL),
    viewerCanCurrentStage: canActOnCurrentStage(job, reqLikePL),
    viewerCanFactory: vuPL.role === 'admin' || canDeptActOnStage({ user: vuPL }, 'factory'),
    viewerCanAssignTeam: vuPL.role === 'admin' || isStageDeptLeader({ user: vuPL }, 'factory'),
    viewerCanReopen: vuPL.role === 'admin' || canDeptActOnStage({ user: vuPL }, 'delivery') || (!!vuPL.userId && String(vuPL.userId).toLowerCase() === String(job.createdBy || '').toLowerCase()),
    viewerCanManage: vuPL.role === 'admin' || (!!vuPL.userId && String(vuPL.userId).toLowerCase() === String(job.createdBy || '').toLowerCase()), // 파일삭제·발주취소: 작성자+관리자
    // 공장 팀 분배(전상현) — 시안 파일을 용접/출력으로 나눈 개수
    weldingFileCount: visualFiles.filter(f => f.team === 'welding').length,
    outputFileCount: visualFiles.filter(f => f.team === 'output').length,
    unassignedFileCount: visualFiles.filter(f => f.team !== 'welding' && f.team !== 'output').length,
    missingFileCount: jobMissingFileCount,
    orderCount: orderSummary.total,
    activeOrderCount: orderSummary.active,
    externalOrderCount: orderSummary.external,
    visualFileCount: visualFiles.length,
    // 주간 달력 '이미지 1장=1칸'용 — 이미지 시안별 팀·썸네일(작은 객체). 진행중 작업만(완료/취소는 빈 배열로 가볍게). AI/비이미지는 제외(팀분할 안 함).
    visualFilesBrief: (job.status === 'done' || job.status === 'cancelled') ? [] : visualFiles.map(f => ({
      id: f.id,
      team: f.team || '',
      name: f.originalName || '',
      thumbUrl: `/api/workflow/files/${encodeURIComponent(f.id)}/thumb`,
      previewUrl: `/api/workflow/files/${encodeURIComponent(f.id)}/preview`,
    })),
    urgentFileCount: files.filter(f => f.urgent && (!f.scheduleNegotiation || f.scheduleNegotiation === 'pending' || f.scheduleNegotiation === 'needs_change')).length,
    archiveUrl: `/api/workflow/jobs/${encodeURIComponent(job.id)}/files/archive`,
    publicArchiveUrl: (canSeePublicLink && job.publicToken) ? `/api/workflow/public/jobs/${encodeURIComponent(job.publicToken)}/files.zip` : '',
    archiveFileCount,
    archiveStatus: job.archiveStatus || (job.status === 'done' ? 'ready' : ''),
    archiveUpdatedAt: job.archiveUpdatedAt || '', // 수령(보관) 전에는 비움 — 제작완료(completedAt)와 분리
    archiveStorageBucket: job.archiveStorageBucket || job.storageBucket || '',
    primaryVisualFile: primaryVisualFile ? {
      id: primaryVisualFile.id,
      originalName: primaryVisualFile.originalName || '',
      previewUrl: `/api/workflow/files/${encodeURIComponent(primaryVisualFile.id)}/preview`,
      thumbUrl: `/api/workflow/files/${encodeURIComponent(primaryVisualFile.id)}/thumb`,
      publicPreviewUrl: (canSeePublicLink && primaryVisualFile.publicToken) ? `/api/workflow/public/files/${encodeURIComponent(primaryVisualFile.publicToken)}/preview` : '',
      publicThumbUrl: (canSeePublicLink && primaryVisualFile.publicToken) ? `/api/workflow/public/files/${encodeURIComponent(primaryVisualFile.publicToken)}/thumb` : '',
      publicDownloadUrl: (canSeePublicLink && primaryVisualFile.publicToken) ? `/api/workflow/public/files/${encodeURIComponent(primaryVisualFile.publicToken)}/download` : '',
      designDueDate: primaryVisualFile.designDueDate || '',
      factoryAvailableDate: primaryVisualFile.factoryAvailableDate || '',
      urgent: !!primaryVisualFile.urgent,
      scheduleNegotiation: primaryVisualFile.scheduleNegotiation || 'pending',
    } : null,
    unreadFileCount,
    unreadEventCount,
    unreadCount: unreadFileCount + unreadEventCount,
    activeStageIds: activeStageIds(job),
    pendingStageCount: pendingStageCount(job),
    pendingChecklistCount: pendingChecklistCount(job),
    pendingReviewCount: pendingReviewCount(scopedData, job),
    blockedStageCount: blockedStageCount(job),
    overdueStageCount: overdueStageCount(job),
    changeRequestCount: changeRequestCount(scopedData, job),
    lateScheduleCount: lateScheduleCount(scopedData, job),
    canComplete: blockers.length === 0,
    completionBlockers: blockers,
    factoryAvailableDate: job.factoryAvailableDate || '',
    scheduleLate: !!(job.currentStage === 'factory' && job.factoryAvailableDate && job.dueDate && job.factoryAvailableDate > job.dueDate),
    scheduleChanged: !!(job.currentStage === 'factory' && job.factoryAvailableDate && job.dueDate && job.factoryAvailableDate !== job.dueDate),
    completedAt: job.completedAt || '',
    completedByName: job.completedByName || '',
    overdue: isOverdueJob(job),
    nextStageDue: nextStageDue(job),
    latestFileAt: files.reduce((max, f) => !max || f.createdAt > max ? f.createdAt : max, ''),
    latestEvent: events[events.length - 1] || null,
    orderSummary,
  };
}

function buildSummary(data, req) {
  const activeJobs = data.jobs.filter(j => !['done', 'cancelled'].includes(j.status));
  const jobById = new Map((data.jobs || []).map(job => [job.id, job]));
  const filesByJob = workflowItemsByJob(data.files);
  const ordersByJob = workflowItemsByJob(data.orders || []);
  const fileExistsCache = new Map();
  const summaryDataForJob = job => ({
    ...data,
    files: filesByJob.get(job.id) || [],
    orders: ordersByJob.get(job.id) || [],
    fileExistsCache,
  });
  const byStage = {};
  for (const stage of STAGES) byStage[stage.id] = 0;
  for (const job of activeJobs) {
    for (const stageId of activeStageIds(job)) {
      byStage[stageId] = (byStage[stageId] || 0) + 1;
    }
  }
  const unreadFiles = data.files
    .filter(f => isUnreadForViewer(f, req.user, jobById.get(f.jobId)))
    .map(file => {
      const job = jobById.get(file.jobId);
      return {
        id: file.id,
        jobId: file.jobId,
        jobTitle: job?.title || '',
        stageId: file.stageId,
        stageLabel: workflowStageLabel(file.stageId) || STAGES.find(s => s.id === file.stageId)?.label || file.stageId,
        kind: file.kind || 'attachment',
        originalName: file.originalName,
        note: file.note || '',
        targetLabel: file.targetLabel || '',
        reviewStatus: file.reviewStatus || 'pending',
        reviewNote: file.reviewNote || '',
        uploadedByName: file.uploadedByName,
        createdAt: file.createdAt,
      };
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const unreadEvents = data.events
    .filter(e => isUnreadEventForViewer(e, req.user, jobById.get(e.jobId)))
    .map(event => {
      const job = jobById.get(event.jobId);
      return {
        id: event.id,
        jobId: event.jobId,
        jobTitle: job?.title || '',
        message: event.message || '',
        type: event.type || '',
        targetLabel: event.targetLabel || '',
        actorName: event.actorName || '',
        createdAt: event.createdAt || '',
      };
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const urgentFiles = data.files
    .filter(f => f.urgent && (!f.scheduleNegotiation || f.scheduleNegotiation === 'pending' || f.scheduleNegotiation === 'needs_change'))
    .filter(f => {
      const job = jobById.get(f.jobId);
      if (!job || ['done', 'cancelled'].includes(job.status || 'active')) return false;
      if (isWorkflowAdmin(req)) return true;
      return isTargetViewer(f, req.user, job) || isUserJob(job, req);
    })
    .map(file => {
      const job = jobById.get(file.jobId);
      return {
        id: file.id,
        jobId: file.jobId,
        jobTitle: job?.title || '',
        stageId: file.stageId,
        stageLabel: workflowStageLabel(file.stageId) || STAGES.find(s => s.id === file.stageId)?.label || file.stageId,
        originalName: file.originalName,
        designDueDate: file.designDueDate || '',
        factoryAvailableDate: file.factoryAvailableDate || '',
        scheduleNegotiation: file.scheduleNegotiation || 'pending',
        createdAt: file.createdAt || '',
      };
    })
    .sort((a, b) => String(a.designDueDate || '9999-99-99').localeCompare(String(b.designDueDate || '9999-99-99')));
  const myActionJobs = activeJobs.filter(job => isUserJob(job, req));
  const myActionItems = myActionJobs
    .map(job => {
      const scopedData = summaryDataForJob(job);
      const stage = STAGES.find(s => s.id === job.currentStage) || STAGES[0] || { id: 'design', label: '디자인' };
      const check = job.stageChecks?.[stage.id] || {};
      const blockers = completionBlockers(scopedData, job, { skipFileExists: true });
      const dueDate = check.dueDate || job.dueDate || '';
      const stageOverdue = check.status !== 'done' && isPastDue(dueDate);
      return {
        id: job.id,
        title: job.title,
        companyName: job.companyName || '',
        projectName: job.projectName || '',
        priority: job.priority || 'normal',
        status: job.status || 'active',
        stageId: stage.id,
        stageLabel: workflowStageLabel(stage.id) || stage.label || stage.id,
        assignee: check.assignee || '',
        dueDate,
        overdue: !!(isOverdueJob(job) || overdueStageCount(job) > 0 || stageOverdue),
        blockedStageCount: blockedStageCount(job),
        changeRequestCount: changeRequestCount(scopedData, job),
        lateScheduleCount: lateScheduleCount(scopedData, job),
        completionBlockerCount: blockers.length,
        latestFileAt: (filesByJob.get(job.id) || [])
          .reduce((max, f) => !max || f.createdAt > max ? f.createdAt : max, ''),
        updatedAt: job.updatedAt || job.createdAt || '',
      };
    })
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      if (b.lateScheduleCount !== a.lateScheduleCount) return b.lateScheduleCount - a.lateScheduleCount;
      const ad = a.dueDate || '9999-99-99';
      const bd = b.dueDate || '9999-99-99';
      const byDue = String(ad).localeCompare(String(bd));
      if (byDue !== 0) return byDue;
      return String(b.updatedAt || b.latestFileAt || '').localeCompare(String(a.updatedAt || a.latestFileAt || ''));
    })
    .slice(0, 8);
  const changeRequests = activeJobs.reduce((sum, job) => sum + changeRequestCount(summaryDataForJob(job), job), 0);
  const lateSchedules = activeJobs.reduce((sum, job) => sum + lateScheduleCount(summaryDataForJob(job), job), 0);
  const readyToComplete = activeJobs.filter(job => completionBlockers(summaryDataForJob(job), job, { skipFileExists: true }).length === 0).length;
  const scheduleItems = buildScheduleItems(data, req);
  return {
    active: activeJobs.length,
    done: data.jobs.filter(j => j.status === 'done').length,
    cancelled: data.jobs.filter(j => j.status === 'cancelled').length,
    readyToComplete,
    overdue: activeJobs.filter(job => isOverdueJob(job) || overdueStageCount(job) > 0).length,
    overdueStages: activeJobs.reduce((sum, job) => sum + overdueStageCount(job), 0),
    blocked: activeJobs.reduce((sum, job) => sum + blockedStageCount(job), 0),
    changeRequests,
    lateSchedules,
    unreadTotal: unreadFiles.length + unreadEvents.length,
    unreadFiles: unreadFiles.length,
    unreadFileItems: unreadFiles.slice(0, 8),
    unreadEvents: unreadEvents.length,
    unreadEventItems: unreadEvents.slice(0, 8),
    urgentFiles: urgentFiles.length,
    urgentFileItems: urgentFiles.slice(0, 8),
    scheduleCount: scheduleItems.length,
    scheduleOverdue: scheduleItems.filter(item => item.overdue).length,
    scheduleItems,
    myActions: myActionJobs.length,
    myActionItems,
    viewerStageIds: STAGES.filter(s => canDeptActOnStage(req, s.id)).map(s => s.id), // 로그인 부서가 담당하는 단계 — 상단 알림 부서별 분기용(2026-06-17)
    byStage,
  };
}

function uploadName(name) {
  const raw = String(name || 'file');
  if ([...raw].some(ch => ch.charCodeAt(0) > 255)) return raw;
  try {
    const decoded = Buffer.from(raw, 'latin1').toString('utf8');
    if (decoded && !decoded.includes('�')) return decoded;
  } catch (_) {}
  return raw;
}

function safeStoredFileName(name, fallback = 'file.bin') {
  const decoded = uploadName(name || fallback);
  const base = safeFilePart(path.basename(decoded), fallback);
  return base || safeFilePart(fallback, 'file.bin');
}

function uniqueStoredFileTarget(dir, wantedName) {
  const safeName = safeStoredFileName(wantedName);
  const ext = path.extname(safeName);
  const base = safeName.slice(0, safeName.length - ext.length);
  let fileName = safeName;
  let fullPath = path.join(dir, fileName);
  let idx = 2;
  while (fs.existsSync(fullPath)) {
    fileName = `${base} (${idx})${ext}`;
    fullPath = path.join(dir, fileName);
    idx += 1;
  }
  return { fileName, fullPath };
}

function escapeRegExp(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function storedNamePreservesOriginalName(storedName, originalSafeName) {
  const stored = String(storedName || '').trim();
  const safe = String(originalSafeName || '').trim();
  if (!stored || !safe) return false;
  if (stored === safe) return true;
  const ext = path.extname(safe);
  const base = safe.slice(0, safe.length - ext.length);
  if (!base) return false;
  return new RegExp(`^${escapeRegExp(base)} \\(\\d+\\)${escapeRegExp(ext)}$`).test(stored);
}

function moveWorkflowFile(source, target) {
  try {
    fs.renameSync(source, target);
  } catch (e) {
    if (e && e.code === 'EXDEV') {
      fs.copyFileSync(source, target);
      fs.unlinkSync(source);
      return;
    }
    throw e;
  }
}

function repairLegacyWorkflowFileStorage(data, options = {}) {
  const dryRun = !!options.dryRun;
  const limit = Math.max(1, Math.min(Number(options.limit || 200), 1000));
  const result = {
    checked: 0,
    repairable: 0,
    repaired: 0,
    skipped: 0,
    errors: 0,
    changed: false,
    items: [],
  };
  if (!data || !Array.isArray(data.files) || !Array.isArray(data.jobs)) return result;
  const jobsById = new Map(data.jobs.map(job => [job.id, job]));
  const storageInfoCache = new Map();
  for (const file of data.files) {
    if (result.checked >= limit) break;
    result.checked += 1;
    const job = jobsById.get(file.jobId);
    if (!job || !file?.originalName) continue;
    const originalSafeName = safeStoredFileName(file.originalName, file.storedName || file.id || 'file');
    const currentStoredName = String(file.storedName || '').trim();
    const needsDesignStorage = file.storageRoot !== 'design' || !file.storagePath || !file.storageBucket;
    const needsOriginalName = !!currentStoredName && originalSafeName && !storedNamePreservesOriginalName(currentStoredName, originalSafeName);
    if (!needsDesignStorage && !needsOriginalName) continue;

    const source = fileDiskPath(file);
    if (!source || !fs.existsSync(source)) {
      result.skipped += 1;
      continue;
    }
    const companyName = safeText(file.storageCompanyName || job.companyName, 120);
    const projectName = safeText(file.storageProjectName || job.projectName || job.title, 160);
    if (!companyName || !projectName) {
      result.skipped += 1;
      continue;
    }

    let storageInfo = null;
    try {
      const storageYear = safeYear(file.storageYear || safeDate(file.designDueDate).slice(0, 4) || job.storageYear || String(job.dueDate || '').slice(0, 4));
      const cacheKey = `${companyName}\n${projectName}\n${storageYear}`;
      if (!storageInfoCache.has(cacheKey)) {
        storageInfoCache.set(cacheKey, resolveWorkflowDesignStorage(companyName, projectName, storageYear, true, { dryRun }));
      }
      storageInfo = storageInfoCache.get(cacheKey);
    } catch (_) {
      result.errors += 1;
      continue;
    }
    if (!storageInfo?.dir || !fs.existsSync(storageInfo.dir)) {
      result.skipped += 1;
      continue;
    }

    const resolvedSource = path.resolve(source);
    let targetFileName = originalSafeName;
    let targetPath = path.resolve(storageInfo.dir, targetFileName);
    result.repairable += 1;
    try {
      if (!isPathInside(storageInfo.dir, targetPath)) continue;
      if (isPathInside(storageInfo.dir, resolvedSource) && storedNamePreservesOriginalName(path.basename(resolvedSource), originalSafeName)) {
        targetFileName = path.basename(resolvedSource);
        targetPath = resolvedSource;
      } else if (resolvedSource.toLowerCase() !== targetPath.toLowerCase()) {
        if (fs.existsSync(targetPath)) {
          const unique = uniqueStoredFileTarget(storageInfo.dir, originalSafeName);
          targetFileName = unique.fileName;
          targetPath = unique.fullPath;
        }
        if (!dryRun) moveWorkflowFile(resolvedSource, targetPath);
      }
      if (!dryRun) {
        file.storedName = targetFileName;
        file.storedPath = targetPath;
        file.storageRoot = 'design';
        file.storageYear = storageInfo.year;
        file.storageCompanyName = companyName;
        file.storageProjectName = projectName;
        file.storageBucket = storageInfo.rel;
        file.storageRelDir = storageInfo.rel;
        file.storagePath = storageInfo.dir;
        file.storageNetPath = workflowDesignNetworkPath(storageInfo.dir);
        file.storageFolderCreated = !!storageInfo.created;
        file.storageFolderExistedBefore = !!storageInfo.existedBefore;
        result.changed = true;
      }
      result.repaired += 1;
      if (result.items.length < 50) {
        result.items.push({
          fileId: file.id,
          originalName: file.originalName,
          from: resolvedSource,
          to: targetPath,
          dryRun,
        });
      }
    } catch (_) {
      result.errors += 1;
      continue;
    }
  }
  return result;
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    ensureDirs();
    cb(null, FILE_DIR);
  },
  filename: (req, file, cb) => {
    const ext = path.extname(uploadName(file.originalname || ''));
    cb(null, `${Date.now()}_${Math.random().toString(36).slice(2, 10)}${ext || '.bin'}`);
  },
});
// 보안: 업로드 형식 화이트리스트 — 디자인/문서 파일만, 실행·스크립트 차단(외부 메일 첨부로 악성코드 전달 방지).
// 클라이언트 mimetype은 위조 가능 → '확장자' 기준으로 거른다.
const ALLOWED_UPLOAD_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.svg',
  '.pdf', '.ai', '.psd', '.eps', '.cdr', '.indd', '.dwg', '.dxf', '.sketch',
  '.zip', '.docx', '.xlsx', '.pptx', '.hwp', '.hwpx', '.txt', '.csv',
]);
function workflowUploadFileFilter(req, file, cb) {
  const ext = path.extname(uploadName(file.originalname || '')).toLowerCase();
  if (ALLOWED_UPLOAD_EXTS.has(ext)) return cb(null, true);
  const e = new Error('허용되지 않는 파일 형식: ' + (ext || '확장자 없음') + ' — 이미지·AI·PDF 등 디자인/문서 파일만 올릴 수 있습니다.');
  e.code = 'UNSUPPORTED_FILE_TYPE';
  cb(e, false);
}
const upload = multer({ storage, limits: { fileSize: MAX_WORKFLOW_UPLOAD_FILE_SIZE, files: MAX_WORKFLOW_UPLOAD_FILES }, fileFilter: workflowUploadFileFilter });

function workflowUploadFiles(req, res, next) {
  upload.array('files', MAX_WORKFLOW_UPLOAD_FILES)(req, res, err => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      if (err.code === 'LIMIT_FILE_SIZE') {
        return res.status(413).json({
          ok: false,
          error: `파일당 최대 ${Math.round(MAX_WORKFLOW_UPLOAD_FILE_SIZE / 1024 / 1024)}MB까지만 업로드할 수 있습니다.`,
        });
      }
      if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') {
        return res.status(413).json({
          ok: false,
          error: `한 번에 최대 ${MAX_WORKFLOW_UPLOAD_FILES}개 파일까지만 업로드할 수 있습니다.`,
        });
      }
      return res.status(400).json({ ok: false, error: `파일 업로드 제한에 걸렸습니다: ${err.message}` });
    }
    if (err && err.code === 'UNSUPPORTED_FILE_TYPE') {
      return res.status(415).json({ ok: false, error: err.message });
    }
    return res.status(400).json({ ok: false, error: `파일 업로드 처리에 실패했습니다: ${err.message || err}` });
  });
}

function archiveFilters(query = {}) {
  const stageId = STAGES.some(s => s.id === query.stageId) ? query.stageId : '';
  const kind = ['proof', 'attachment', 'drawing', 'photo'].includes(query.kind) ? query.kind : '';
  const images = query.images === '1' || query.images === 'image' || query.images === true;
  return { stageId, kind, images };
}

function jobArchiveFiles(data, job, filters = {}) {
  const { stageId = '', kind = '', images = false } = filters;
  return data.files
    .filter(f => f.jobId === job.id)
    .filter(f => !stageId || f.stageId === stageId)
    .filter(f => !kind || (f.kind || 'attachment') === kind)
    .filter(f => !images || isImageFile(f))
    .filter(f => {
      const full = fileDiskPath(f);
      return !!(full && fs.existsSync(full));
    });
}

function archiveStageChecksForManifest(job) {
  const checks = job?.stageChecks || {};
  const out = {};
  for (const stage of STAGES) {
    const check = checks[stage.id] || {};
    out[stage.id] = {
      label: workflowStageLabel(stage.id) || stage.label,
      status: check.status || 'pending',
      assignee: check.assignee || '',
      dueDate: check.dueDate || '',
      completedAt: check.completedAt || '',
      updatedAt: check.updatedAt || '',
      checklist: (check.checklist || []).map(item => ({
        label: item.label || '',
        done: !!item.done,
        updatedAt: item.updatedAt || '',
      })),
    };
  }
  return out;
}

function archiveOrderForManifest(order = {}) {
  return {
    id: order.id || '',
    targetName: order.targetName || '',
    targetType: order.targetType || '',
    deliveryMethod: order.deliveryMethod || '',
    status: order.status || '',
    dueDate: order.dueDate || '',
    fileIds: normalizeFileIds(order.fileIds || []),
    responseStatus: order.responseStatus || '',
    responseAvailableDate: order.responseAvailableDate || '',
    responseNote: order.responseNote || '',
    respondedByName: order.respondedByName || '',
    respondedAt: order.respondedAt || '',
    mailStatus: order.mailStatus || '',
    mailSentAt: order.mailSentAt || '',
    recipientEmail: order.recipientEmail || order.mailTo || '',
    createdByName: order.createdByName || '',
    createdAt: order.createdAt || '',
    updatedAt: order.updatedAt || '',
  };
}

function archiveFileForManifest(file = {}) {
  return {
    id: file.id,
    stageId: file.stageId,
    stageLabel: workflowStageLabel(file.stageId) || file.stageId || '',
    kind: file.kind || 'attachment',
    version: file.version || 1,
    originalName: file.originalName || '',
    storedName: file.storedName || '',
    storedPath: file.storedPath || '',
    size: file.size || 0,
    mime: file.mime || '',
    storageRoot: file.storageRoot || '',
    storageBucket: file.storageBucket || file.storageRelDir || '',
    storagePath: file.storagePath || '',
    storageNetPath: file.storageNetPath || '',
    uploadedByName: file.uploadedByName || '',
    targetLabel: file.targetLabel || '',
    targetLabels: Array.isArray(file.targetLabels) ? file.targetLabels : [],
    targetStageIds: normalizeTargetStageIds(file.targetStageIds),
    designDueDate: file.designDueDate || '',
    factoryAvailableDate: file.factoryAvailableDate || '',
    factoryScheduleNote: file.factoryScheduleNote || '',
    scheduleNegotiation: file.scheduleNegotiation || '',
    reviewStatus: file.reviewStatus || 'pending',
    reviewNote: file.reviewNote || '',
    reviewedByName: file.reviewedByName || '',
    reviewedAt: file.reviewedAt || '',
    urgent: !!file.urgent,
    createdAt: file.createdAt || '',
  };
}

async function buildArchiveFromFiles(job, files, filters = {}, suffix = 'all', context = {}) {
  if (!files.length) return null;
  // DoS 방지: ZIP은 전체를 메모리 버퍼로 만들므로 총 개수/용량 상한(초과 시 413). 무제한이면 OOM으로 단일 프로세스 ERP가 다운된다.
  const MAX_ARCHIVE_FILES = 300;
  const MAX_ARCHIVE_BYTES = 500 * 1024 * 1024;
  let _archiveBytes = 0;
  for (const f of files) _archiveBytes += Number(f.size || 0);
  if (files.length > MAX_ARCHIVE_FILES || _archiveBytes > MAX_ARCHIVE_BYTES) {
    const e = new Error('아카이브가 너무 큽니다(파일 수/용량 제한 초과). 개별 다운로드를 이용하세요.');
    e.statusCode = 413;
    throw e;
  }

  const zip = new JSZip();
  const used = new Set();
  // ZIP 내부 구조 단순화(사장님 요청 2026-06-17): 짧은 현장명 폴더 + 파일 평탄 저장.
  // 기존: 회사_프로젝트_긴제목 / 단계 / 종류 / v버전_파일 (경로 너무 길고 _manifest.json 등 군더더기).
  const root = safeFilePart(job.projectName || job.companyName || job.title || job.id, job.id);
  for (const file of files) {
    const original = safeFilePart(file.originalName || file.storedName || file.id, file.id);
    const zipPath = uniqueZipPath(used, `${root}/${original}`);
    zip.file(zipPath, fs.readFileSync(fileDiskPath(file)));
  }

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const filename = safeFilePart(`${job.projectName || job.companyName || job.title || job.id}${suffix && suffix !== 'all' ? '_' + suffix : ''}`) + '.zip';
  return { buffer, filename, files };
}

async function buildJobArchive(data, job, filters = {}) {
  const { stageId = '', kind = '' } = filters;
  const files = jobArchiveFiles(data, job, filters);
  const suffix = [stageId, kind].filter(Boolean).join('_') || 'all';
  const orders = (data.orders || []).filter(order => order.jobId === job.id);
  return buildArchiveFromFiles(job, files, { stageId, kind }, suffix, { orders });
}

// 완료 명세서 코드: 완료일자 기준 일별 순번 (예: 20260710-001). 완료일이 바뀌면 새 날짜로 재발번.
function actorFromReq(req) {
  return { userId: (req && req.user && req.user.userId) || '', userName: userName(req) };
}

// 제작완료(factory 단계 done) 동기화 — 제작완료일/완료코드/완료자를 세팅하거나 초기화.
// 완료코드/제작완료일은 "제작완료"에 종속하며, 수령(done/archive)과 분리된다.
function syncJobFactoryCompletion(data, req, job, at = nowIso()) {
  return stageRules.syncFactoryCompletion(data.jobs, job, at, actorFromReq(req));
}

// 수령(영업지원팀): 완료본을 과거내역으로 보관. 제작완료일/코드는 factory 동기화가 이미 세팅함.
function completeWorkflowJob(data, req, job, at = nowIso()) {
  const firstArchive = !job.archiveUpdatedAt;
  const files = jobArchiveFiles(data, job, {});
  job.status = 'done';
  job.unordered = false; // 완료=발주 절차 종료 → 미발주 플래그 제거(과거내역에 '미발주' 흔적·뱃지 잔존 방지)
  stageRules.ensureStagesDone(job, STAGES.map(s => s.id), at); // 수령=전 단계 완료 확정 → 제작완료일/코드 보존
  syncJobFactoryCompletion(data, req, job, at);
  job.archiveStatus = 'ready';
  job.archiveUpdatedAt = at;
  job.archiveFileCount = files.length;
  job.archiveStorageBucket = job.storageBucket || '';
  job.currentStage = 'delivery';
  if (firstArchive) {
    addEvent(data, req, job.id, 'complete', '완료 보관함 저장', {
      archiveFileCount: files.length,
      archiveStorageBucket: job.archiveStorageBucket,
    });
  }
  return files.length;
}

// 수령(done/archive) 취소 시 보관 메타만 초기화. 제작완료일/코드는 factory 동기화가 관리.
function clearWorkflowArchive(job) {
  job.archiveStatus = '';
  job.archiveUpdatedAt = '';
  job.archiveFileCount = 0;
  job.archiveStorageBucket = '';
}

function sendWorkflowFile(res, file, inline = false, publicCache = false) {
  const full = fileDiskPath(file);
  if (!full || !fs.existsSync(full)) return false;
  // 보안: SVG/HTML/XML 등 스크립트 가능 형식은 인라인 금지(저장형 XSS 차단) — 무조건 다운로드(attachment)로 강등.
  const ext = fileExt(file);
  const mime = String(file.mime || '').toLowerCase();
  const scriptable = ['.svg', '.svgz', '.html', '.htm', '.xml', '.xhtml', '.mht'].includes(ext) || mime.includes('svg') || mime.includes('html') || mime.includes('xml');
  const safeInline = inline && isImageFile(file) && !scriptable;
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Type', safeInline ? workflowImageMime(file) : (scriptable ? 'application/octet-stream' : (file.mime || 'application/octet-stream')));
  res.setHeader('Content-Disposition', safeInline ? 'inline' : attachmentDisposition(file.originalName || 'file'));
  res.setHeader('Cache-Control', publicCache ? 'public, max-age=300' : 'private, max-age=300');
  res.sendFile(full);
  return true;
}

async function sendWorkflowThumb(res, file, publicCache = false) {
  const full = fileDiskPath(file);
  if (!full || !fs.existsSync(full) || !isImageFile(file)) return false;
  res.setHeader('Cache-Control', publicCache ? 'public, max-age=86400' : 'private, max-age=86400');
  if (sharp) {
    try {
      ensureDirs();
      const stat = fs.statSync(full);
      const hash = crypto
        .createHash('md5')
        .update(`${full}|${stat.size}|${stat.mtimeMs}|320x220`)
        .digest('hex');
      const thumbPath = path.join(THUMB_DIR, `${hash}.jpg`);
      if (!fs.existsSync(thumbPath)) {
        await sharp(full, { failOn: 'none' })
          .resize(320, 220, { fit: 'cover', withoutEnlargement: true })
          .jpeg({ quality: 64, progressive: true })
          .toFile(thumbPath);
      }
      res.type('image/jpeg').sendFile(thumbPath);
      return true;
    } catch (_) {
      // Fall back below. It is better to show the real image than an empty tile.
    }
  }
  // 폴백(sharp 미설치/실패): 원본 서빙 — 스크립트 가능 형식(SVG/HTML/XML)은 인라인 금지(저장형 XSS 차단) + nosniff.
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Workflow-Thumb-Fallback', 'original');
  const fext = fileExt(file);
  const fmime = String(file.mime || '').toLowerCase();
  const fscriptable = ['.svg', '.svgz', '.html', '.htm', '.xml', '.xhtml', '.mht'].includes(fext) || fmime.includes('svg') || fmime.includes('html') || fmime.includes('xml');
  if (fscriptable) {
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', attachmentDisposition(file.originalName || 'file'));
  } else {
    res.type(workflowImageMime(file));
  }
  res.sendFile(full);
  return true;
}

router.get('/public/files/:token/download', (req, res) => {
  const data = loadStore();
  const token = safeText(req.params.token, 120);
  const file = data.files.find(f => String(f.publicToken || '') === token);
  if (!file) return res.status(404).send('not found');
  const orderToken = safeText(req.query.order || req.query.orderToken, 120);
  if (orderToken) {
    const order = (data.orders || []).find(o => String(o.publicToken || '') === orderToken);
    if (order?.status === 'cancelled') return res.status(409).send('cancelled order');
    const ids = new Set(normalizeFileIds(order?.fileIds || []));
    const job = order && ids.has(file.id) ? data.jobs.find(j => j.id === order.jobId) : null;
    if (order && job) {
      markPublicOrderActivity(data, job, order, 'download', {
        fileId: file.id,
        fileName: file.originalName || file.storedName || file.id,
      });
      saveStore(data);
    }
  }
  if (!sendWorkflowFile(res, file, false, true)) return res.status(404).send('not found');
});

router.get('/public/files/:token/preview', (req, res) => {
  const data = loadStore();
  const token = safeText(req.params.token, 120);
  const file = data.files.find(f => String(f.publicToken || '') === token);
  if (!file || !isImageFile(file)) return res.status(404).send('not found');
  const orderToken = safeText(req.query.order || req.query.orderToken, 120);
  if (orderToken) {
    const order = (data.orders || []).find(o => String(o.publicToken || '') === orderToken);
    if (order?.status === 'cancelled') return res.status(409).send('cancelled order');
  }
  if (!sendWorkflowFile(res, file, true, true)) return res.status(404).send('not found');
});

router.get('/public/files/:token/thumb', async (req, res, next) => {
  try {
    const data = loadStore();
    const token = safeText(req.params.token, 120);
    const file = data.files.find(f => String(f.publicToken || '') === token);
    if (!file || !isImageFile(file)) return res.status(404).send('not found');
    const orderToken = safeText(req.query.order || req.query.orderToken, 120);
    if (orderToken) {
      const order = (data.orders || []).find(o => String(o.publicToken || '') === orderToken);
      if (order?.status === 'cancelled') return res.status(409).send('cancelled order');
    }
    if (!await sendWorkflowThumb(res, file, true)) return res.status(404).send('not found');
  } catch (e) {
    next(e);
  }
});

router.get('/public/jobs/:token/files.zip', async (req, res, next) => {
  try {
    const data = loadStore();
    const token = safeText(req.params.token, 120);
    const job = data.jobs.find(j => String(j.publicToken || '') === token);
    if (!job) return res.status(404).send('not found');
    if (job.status === 'cancelled') return res.status(409).send('cancelled');
    const archive = await buildJobArchive(data, job, archiveFilters(req.query));
    if (!archive) return res.status(404).send('no files');
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachmentDisposition(archive.filename));
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(archive.buffer);
  } catch (e) {
    next(e);
  }
});

router.get('/public/orders/:token/files.zip', async (req, res, next) => {
  try {
    const data = loadStore();
    const token = safeText(req.params.token, 120);
    const order = (data.orders || []).find(o => String(o.publicToken || '') === token);
    if (!order) return res.status(404).send('not found');
    const job = data.jobs.find(j => j.id === order.jobId);
    if (!job) return res.status(404).send('not found');
    if (order.status === 'cancelled') return res.status(409).send('cancelled order');
    const files = orderFiles(data, order, job);
    const archive = await buildArchiveFromFiles(
      job,
      files,
      { orderId: order.id, targetName: order.targetName || '' },
      `order_${safeFilePart(order.targetName || order.id)}`,
      { order },
    );
    if (!archive) return res.status(404).send('no files');
    markPublicOrderActivity(data, job, order, 'download', { fileCount: archive.files.length });
    saveStore(data);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachmentDisposition(archive.filename));
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.send(archive.buffer);
  } catch (e) {
    next(e);
  }
});

router.get('/public/orders/:token', (req, res) => {
  const data = loadStore();
  const token = safeText(req.params.token, 120);
  const order = (data.orders || []).find(o => String(o.publicToken || '') === token);
  if (!order) return res.status(404).json({ error: '전달건을 찾을 수 없습니다.' });
  const job = data.jobs.find(j => j.id === order.jobId);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  // 10분 내 재열람은 쓰로틀 → saveStore 생략(미인증 공개 GET의 전체 스토어 재기록 증폭 차단).
  if (markPublicOrderActivity(data, job, order, 'view')) saveStore(data);
  res.json(decoratePublicOrder(data, job, order));
});

router.post('/public/orders/:token/reply', (req, res) => {
  const data = loadStore();
  const token = safeText(req.params.token, 120);
  const order = (data.orders || []).find(o => String(o.publicToken || '') === token);
  if (!order) return res.status(404).json({ error: '전달건을 찾을 수 없습니다.' });
  const job = data.jobs.find(j => j.id === order.jobId);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (order.status === 'cancelled') return res.status(409).json({ error: '취소된 발주입니다.' });

  const response = normalizeOrderResponse(req.body || {});
  const files = orderFiles(data, order, job);
  const fileResponses = normalizePublicFileResponses(req.body?.fileResponses, files, response);
  const aggregateStatus = aggregateFileResponses(fileResponses, response);
  const fileResponseSummary = summarizePublicFileResponses(fileResponses);
  response.responseStatus = aggregateStatus;
  Object.assign(order, response, {
    status: orderStatusFromResponse(response.responseStatus),
    fileResponseCount: fileResponseSummary.total,
    fileResponseSummary: fileResponseSummary.total ? fileResponseSummary : null,
    respondedAt: nowIso(),
    updatedAt: nowIso(),
  });
  applyOrderResponseToFiles(files, response, fileResponses);
  job.updatedAt = nowIso();

  const label = ORDER_RESPONSE_LABELS[response.responseStatus] || response.responseStatus;
  const by = response.respondedByName || order.targetName || '외부 회신';
  const dateText = response.responseAvailableDate ? ` · 가능일 ${response.responseAvailableDate}` : '';
  const noteText = response.responseNote ? ` · ${response.responseNote}` : '';
  const fileText = publicFileResponseText(fileResponseSummary);
  addEvent(data, { user: { userId: 'public-order', name: by } }, job.id, 'order_public_reply', `파일 전달 회신 · ${order.targetName} · ${label}${dateText}${noteText}${fileText}`, {
    orderId: order.id,
    targetName: order.targetName,
    responseStatus: response.responseStatus,
    responseAvailableDate: response.responseAvailableDate,
    responseNote: response.responseNote,
    fileResponses,
    fileResponseSummary,
    eventTargetUserId: job.createdBy || '',
    eventTargetUserName: job.createdByName || '',
    eventTargetLabel: stageTargetLabels(job, ['design', 'delivery']).join(', '),
    targetStageIds: ['design', 'delivery'],
  });
  saveStore(data);
  res.json(decoratePublicOrder(data, job, order));
});

router.use(requireAuth);

router.get('/meta', (req, res) => {
  const publicLink = publicWorkflowLinkState();
  const org = loadFreshOrgSnapshot();
  const stageDepartmentMap = storedWorkflowStageDepartmentMap();
  const stages = workflowStagesForOrg(org);
  res.json({
    ok: true,
    stages,
    statuses: STATUS_LABELS,
    checkStatuses: CHECK_STATUS_LABELS,
    orderStatuses: ORDER_STATUS_LABELS,
    publicBaseUrl: publicLink.publicBaseUrl,
    publicLink,
    departments: workflowDepartmentOptions(org),
    stageDepartmentMap,
    suggestedStageDepartmentMap: suggestedWorkflowStageDepartmentMap(org),
    stageDepartmentMissingIds: stages.filter(stage => !stage.mappedDepartmentId).map(stage => stage.id),
    uploadLimits: {
      files: MAX_WORKFLOW_UPLOAD_FILES,
      fileSize: MAX_WORKFLOW_UPLOAD_FILE_SIZE,
    },
  });
});

router.get('/order-targets', (req, res) => {
  res.json({
    ok: true,
    orderTargets: buildWorkflowOrderTargets(),
  });
});

router.get('/settings/departments', (req, res) => {
  const org = loadFreshOrgSnapshot();
  const stages = workflowStagesForOrg(org);
  res.json({
    ok: true,
    stages,
    departments: workflowDepartmentOptions(org),
    stageDepartmentMap: storedWorkflowStageDepartmentMap(),
    suggestedStageDepartmentMap: suggestedWorkflowStageDepartmentMap(org),
    stageDepartmentMissingIds: stages.filter(stage => !stage.mappedDepartmentId).map(stage => stage.id),
  });
});

router.post('/settings/departments', requireAdmin, (req, res) => {
  const org = loadFreshOrgSnapshot();
  const validDepartmentIds = new Set((org.departments || []).map(d => String(d.id || '')).filter(Boolean));
  const raw = req.body?.stageDepartmentMap || {};
  const next = {};
  for (const stage of STAGES) {
    const deptId = safeText(raw[stage.id] || req.body?.[stage.id], 120);
    if (!deptId) continue;
    if (!validDepartmentIds.has(deptId)) {
      return res.status(400).json({ ok: false, error: `${stage.label}에 선택한 부서를 찾을 수 없습니다.` });
    }
    next[stage.id] = deptId;
  }
  saveWorkflowStageDepartmentMap(next);
  const refreshedOrg = loadFreshOrgSnapshot();
  const stages = workflowStagesForOrg(refreshedOrg);
  res.json({
    ok: true,
    stages,
    departments: workflowDepartmentOptions(refreshedOrg),
    stageDepartmentMap: storedWorkflowStageDepartmentMap(),
    suggestedStageDepartmentMap: suggestedWorkflowStageDepartmentMap(refreshedOrg),
    stageDepartmentMissingIds: stages.filter(stage => !stage.mappedDepartmentId).map(stage => stage.id),
  });
});

router.get('/settings/public-link', (req, res) => {
  res.json({
    ok: true,
    ...publicWorkflowLinkState(),
  });
});

router.post('/settings/public-link', requireAdmin, (req, res) => {
  const url = normalizePublicBaseUrl(req.body?.publicBaseUrl || req.body?.url || '');
  if (req.body?.publicBaseUrl || req.body?.url) {
    if (!url) return res.status(400).json({ ok: false, error: 'http 또는 https 주소를 입력해주세요.' });
    if (!isPublicWorkflowBaseUrl(url)) {
      return res.status(400).json({ ok: false, error: '외부 다운로드 주소는 localhost 또는 사설 IP가 아닌 터널/공개 주소여야 합니다.' });
    }
  }
  const settings = db['설정'].load();
  if (!settings.workflow || typeof settings.workflow !== 'object') settings.workflow = {};
  settings.workflow.publicBaseUrl = url;
  db['설정'].save(settings);
  res.json({
    ok: true,
    ...publicWorkflowLinkState(),
    configuredBaseUrl: url,
  });
});

router.get('/settings/storage-rules', (req, res) => {
  const includeInactive = isWorkflowAdmin(req) && String(req.query.includeInactive || '') === '1';
  res.json({
    ok: true,
    rules: workflowStorageRules.listRules({ includeInactive }),
  });
});

router.post('/settings/storage-rules', requireAdmin, (req, res) => {
  try {
    const rule = workflowStorageRules.saveRule(req.body || {});
    if (typeof designModule.invalidateWorkflowOptions === 'function') designModule.invalidateWorkflowOptions();
    res.json({
      ok: true,
      rule,
      rules: workflowStorageRules.listRules({ includeInactive: true }),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || '저장 규칙을 저장할 수 없습니다.' });
  }
});

router.put('/settings/storage-rules/:id', requireAdmin, (req, res) => {
  try {
    const rule = workflowStorageRules.saveRule({ ...(req.body || {}), id: req.params.id });
    if (typeof designModule.invalidateWorkflowOptions === 'function') designModule.invalidateWorkflowOptions();
    res.json({
      ok: true,
      rule,
      rules: workflowStorageRules.listRules({ includeInactive: true }),
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: e.message || '저장 규칙을 저장할 수 없습니다.' });
  }
});

router.delete('/settings/storage-rules/:id', requireAdmin, (req, res) => {
  const ok = workflowStorageRules.deactivateRule(req.params.id);
  if (!ok) return res.status(404).json({ ok: false, error: '저장 규칙을 찾을 수 없습니다.' });
  if (typeof designModule.invalidateWorkflowOptions === 'function') designModule.invalidateWorkflowOptions();
  res.json({
    ok: true,
    rules: workflowStorageRules.listRules({ includeInactive: true }),
  });
});

router.post('/maintenance/repair-file-storage', requireAdmin, (req, res) => {
  const data = loadStore();
  const result = repairLegacyWorkflowFileStorage(data, {
    dryRun: req.body?.dryRun === true,
    limit: req.body?.limit,
  });
  if (result.changed) saveStore(data);
  res.json({
    ok: true,
    ...result,
  });
});

router.get('/storage/preview', (req, res) => {
  const companyName = safeText(req.query.companyName || req.query.company, 120);
  const projectName = safeText(req.query.projectName || req.query.project, 160);
  const year = safeYear(req.query.year);
  if (!companyName) return res.status(400).json({ ok: false, error: '회사명이 필요합니다.' });
  if (!projectName) return res.status(400).json({ ok: false, error: '프로젝트명이 필요합니다.' });
  try {
    const info = resolveWorkflowDesignStorage(companyName, projectName, year, true, { dryRun: true });
    if (!info) return res.status(400).json({ ok: false, error: '저장 경로를 계산하지 못했습니다.' });
    res.json({
      ok: true,
      storage: {
        root: 'design',
        rel: info.rel,
        year: info.year,
        companyFolderName: info.companyFolderName,
        yearFolderName: info.yearFolderName,
        projectFolderName: info.projectFolderName,
        existedBefore: !!info.existedBefore,
        created: !info.existedBefore,
        netPath: workflowDesignNetworkPath(info.dir),
      },
    });
  } catch (e) {
    res.status(400).json({ ok: false, error: '저장 경로를 확인할 수 없습니다: ' + e.message });
  }
});

router.get('/summary', (req, res) => {
  const data = loadStore();
  res.json({ ok: true, summary: buildSummary(data, req) });
});

router.get('/projects', (req, res) => {
  const data = loadStore();
  const company = safeText(req.query.company, 120).toLowerCase();
  const status = safeText(req.query.status, 30);
  let projects = buildWorkflowProjects(data);
  if (company) {
    projects = projects.filter(project => String(project.companyName || '').toLowerCase().includes(company));
  }
  if (status && status !== 'all') {
    projects = projects.filter(project => project.status === status);
  }
  res.json({ ok: true, projects });
});

router.post('/projects', (req, res) => {
  const data = loadStore();
  const companyName = safeText(req.body?.companyName, 120);
  const projectName = safeText(req.body?.projectName, 160);
  if (!companyName) return res.status(400).json({ error: '회사명이 필요합니다.' });
  if (!projectName) return res.status(400).json({ error: '프로젝트명이 필요합니다.' });
  let storageInfo = null;
  try {
    storageInfo = resolveWorkflowDesignStorage(companyName, projectName, safeYear(req.body?.year), true);
  } catch (e) {
    return res.status(400).json({ error: '프로젝트 폴더를 만들 수 없습니다: ' + e.message });
  }
  const project = upsertWorkflowProject(data, {
    companyName,
    projectName,
    year: storageInfo?.year || req.body?.year,
    status: normalizeProjectStatus(req.body?.status),
  }, req, storageInfo);
  saveStore(data);
  res.json({
    ok: true,
    project: buildWorkflowProjects(data).find(p => p.id === project.id) || project,
    folder: storageInfo ? {
      ...storageInfo,
      netPath: workflowDesignNetworkPath(storageInfo.dir),
    } : null,
  });
});

router.put('/projects/:id', (req, res) => {
  const data = loadStore();
  const projects = buildWorkflowProjects(data);
  const current = projects.find(project => project.id === req.params.id)
    || projects.find(project => workflowProjectKey(project.companyName, project.projectName) === workflowProjectKey(req.body?.companyName, req.body?.projectName));
  const companyName = safeText(req.body?.companyName || current?.companyName, 120);
  const projectName = safeText(req.body?.projectName || current?.projectName, 160);
  if (!companyName) return res.status(400).json({ error: '회사명이 필요합니다.' });
  if (!projectName) return res.status(400).json({ error: '프로젝트명이 필요합니다.' });
  let storageInfo = null;
  try {
    storageInfo = resolveWorkflowDesignStorage(companyName, projectName, safeYear(req.body?.year || current?.year), true);
  } catch (e) {
    return res.status(400).json({ error: '프로젝트 폴더를 만들 수 없습니다: ' + e.message });
  }
  const project = upsertWorkflowProject(data, {
    companyName,
    projectName,
    year: storageInfo?.year || req.body?.year || current?.year,
    status: normalizeProjectStatus(req.body?.status, current?.status || 'active'),
  }, req, storageInfo);
  saveStore(data);
  res.json({
    ok: true,
    project: buildWorkflowProjects(data).find(p => p.id === project.id) || project,
  });
});

// 등록코드(regCode) = 등록일 기준 일별 순번 YYYYMMDD-NNN. 등록 즉시 발번·끝까지 고정 — 통합 '내역' 표의 기준 코드(2026-06-17).
function assignRegistrationCode(jobs, job) {
  if (!job) return '';
  if (job.regCode) return job.regCode;
  const ymd = kstDay(job.createdAt).replace(/-/g, ''); // KST 기준 YYYYMMDD(새벽 0~9시 건이 전날로 새지 않게)
  if (!ymd) return '';
  let max = 0;
  for (const j of (jobs || [])) {
    if (j === job) continue;
    const c = String(j.regCode || '');
    if (c.slice(0, 8) === ymd && c.charAt(8) === '-') {
      const n = parseInt(c.slice(9), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  job.regCode = `${ymd}-${String(max + 1).padStart(3, '0')}`;
  return job.regCode;
}
let _regCodeBackfilled = false;
function backfillRegistrationCodes(data) {
  if (_regCodeBackfilled) return false;
  _regCodeBackfilled = true;
  const missing = (data.jobs || []).filter(j => !j.regCode).sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  for (const job of missing) assignRegistrationCode(data.jobs, job);
  return missing.length > 0;
}

// 통합 '내역' 표 데이터 — 진행+완료+취소 전부, 경량 행(무거운 job 객체 아님). 등록일/완료일 기준 날짜범위 필터로 가볍게.
router.get('/ledger', (req, res) => {
  const data = loadStore();
  if (backfillRegistrationCodes(data)) saveStore(data);
  const from = safeDate(req.query.from);
  const to = safeDate(req.query.to);
  const basis = String(req.query.basis || 'reg') === 'done' ? 'done' : 'reg'; // 등록일(reg) 또는 완료일(done) 기준
  const countByJob = new Map();
  for (const f of (data.files || [])) countByJob.set(f.jobId, (countByJob.get(f.jobId) || 0) + 1);
  const rows = (data.jobs || []).map(job => ({
    id: job.id,
    code: job.regCode || job.completionCode || '',
    regDate: kstDay(job.createdAt),  // KST 기준 — 등록코드와 동일 기준(날짜필터 누락 방지)
    doneDate: kstDay(job.completedAt),
    companyName: job.companyName || '',
    projectName: job.projectName || '',
    status: job.status || 'active',
    currentStage: job.currentStage || 'design',
    createdByName: job.createdByName || '',
    fileCount: countByJob.get(job.id) || 0,
  })).filter(r => {
    const d = basis === 'done' ? r.doneDate : r.regDate;
    if (!d) return false; // 기준 날짜 없으면 제외(완료일 기준인데 미완료 등)
    if (from && d < from) return false;
    if (to && d > to) return false;
    return true;
  }).sort((a, b) => String(b.regDate).localeCompare(String(a.regDate)) || String(b.code).localeCompare(String(a.code)));
  res.json({ ok: true, rows, total: rows.length });
});

router.get('/jobs', (req, res) => {
  const __t0 = Date.now();
  const __s0 = workflowPerfSnapshot();
  const data = loadStore();
  if (backfillRegistrationCodes(data)) saveStore(data); // 기존 작업에 등록코드 1회 백필(과거+현재 코드 보유)
  const q = safeText(req.query.q, 100).toLowerCase();
  const status = safeText(req.query.status, 30);
  const scope = safeText(req.query.scope, 30) || 'all';
  const rawLimit = String(req.query.limit ?? '').trim().toLowerCase();
  let limit = 120;
  if (rawLimit === '0' || rawLimit === 'all' || rawLimit === 'false') {
    limit = 0;
  } else if (rawLimit) {
    const parsedLimit = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(parsedLimit)) limit = Math.min(Math.max(parsedLimit, 1), 500);
  }
  const decorateOptions = {
    filesByJob: workflowItemsByJob(data.files),
    eventsByJob: workflowItemsByJob(data.events),
    ordersByJob: workflowItemsByJob(data.orders || []),
    fileExistsCache: new Map(),
    // 목록은 디스크 존재확인을 아예 건너뛴다 → 네트워크 드라이브와 무관하게 즉시. 상세에서 검증.
    skipFileExists: true,
  };
  let jobs = data.jobs.slice();
  if (status && status !== 'all') jobs = jobs.filter(j => j.status === status);
  if (q) {
    jobs = jobs.filter(j => workflowJobSearchText(data, j).includes(q));
  }
  if (scope === 'mine') {
    jobs = jobs.filter(j => isUserJob(j, req));
  } else if (scope === 'unread') {
    jobs = jobs.filter(j => decorateJob(data, j, req.user, decorateOptions).unreadCount > 0);
  } else if (scope === 'urgent') {
    jobs = jobs.filter(j => urgentOpenFileCount(data, j) > 0);
  } else if (scope === 'risk') {
    jobs = jobs.filter(j => isOverdueJob(j) || overdueStageCount(j) > 0 || blockedStageCount(j) > 0 || changeRequestCount(data, j) > 0 || missingFileCount(data, j, decorateOptions.fileExistsCache) > 0);
  }
  jobs.sort((a, b) => {
    if (status === 'done') {
      return String(b.archiveUpdatedAt || b.completedAt || b.updatedAt || '').localeCompare(String(a.archiveUpdatedAt || a.completedAt || a.updatedAt || ''))
        || String(a.companyName || '').localeCompare(String(b.companyName || ''), 'ko')
        || String(a.projectName || '').localeCompare(String(b.projectName || ''), 'ko');
    }
    const ap = { urgent: 0, high: 1, normal: 2, low: 3 }[a.priority] ?? 2;
    const bp = { urgent: 0, high: 1, normal: 2, low: 3 }[b.priority] ?? 2;
    if (ap !== bp) return ap - bp;
    return String(a.dueDate || '9999-99-99').localeCompare(String(b.dueDate || '9999-99-99'))
      || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''));
  });
  const total = jobs.length;
  const visibleJobs = limit ? jobs.slice(0, limit) : jobs;
  const decoratedJobs = visibleJobs.map(job => decorateJob(data, job, req.user, decorateOptions));
  const summary = buildSummary(data, req);
  logWorkflowPerf('GET /jobs', __t0, __s0, { jobs: decoratedJobs.length, total });
  res.json({
    ok: true,
    jobs: decoratedJobs,
    total,
    limit,
    limited: !!limit && total > visibleJobs.length,
    summary,
  });
});

router.get('/jobs/:id', (req, res) => {
  const __t0 = Date.now();
  const __s0 = workflowPerfSnapshot();
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  const files = data.files
    .filter(f => f.jobId === job.id)
    .map(f => decorateWorkflowFile(f, req.user, job));
  const payload = {
    ok: true,
    job: decorateJob(data, job, req.user),
    files,
    orders: (data.orders || []).filter(o => o.jobId === job.id).map(o => decorateOrder(data, job, o)),
    orderSummary: buildOrderSummary(data, job),
    deliverySummary: buildDeliverySummary(files, req.user, job),
    events: data.events.filter(e => e.jobId === job.id).map(e => decorateWorkflowEvent(e, req.user, job)),
  };
  logWorkflowPerf('GET /jobs/:id', __t0, __s0, { files: files.length });
  res.json(payload);
});

router.post('/jobs', (req, res) => {
  const data = loadStore();
  const payload = normalizeJobPayload(req.body || {});
  stageRules.applyDateRoleGuard({ currentStage: 'design' }, payload); // 생성=디자인 단계: 완료가능일 입력 차단
  if (!payload.title) {
    payload.title = payload.projectName || (payload.companyName ? `${payload.companyName} 작업` : '워크플로우 작업');
  }
  // 특이사항은 등록 시 디자인팀이 적어서 넘김('없음'은 빈값으로 정규화 — 배지/팝업 안 띄움)
  const rawNote = safeText(req.body.handoffNote, 1000).trim();
  const createNote = (rawNote === '없음' || rawNote === '없음.') ? '' : rawNote;
  const job = {
    id: makeId('wf'),
    publicToken: makeUniquePublicToken(data),
    ...payload,
    handoffNote: createNote,
    handoffNoteAt: createNote ? nowIso() : '',
    handoffNoteFrom: createNote ? userName(req) : '',
    handoffNoteFromStage: createNote ? 'design' : '',
    handoffNoteAckBy: '',
    handoffNoteAckByName: '',
    handoffNoteAckAt: '',
    stageChecks: newStageChecks(),
    currentStage: 'design',
    createdBy: req.user?.userId || '',
    createdByName: userName(req),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  let storageInfo = null;
  try {
    storageInfo = applyWorkflowDesignStorage(job).info;
  } catch (e) {
    return res.status(400).json({ error: '시안 저장 폴더를 만들 수 없습니다: ' + e.message });
  }
  const projectKey = workflowProjectKey(job.companyName, job.projectName);
  const projectExistedBefore = projectKey && (data.projects || []).some(project => workflowProjectKey(project.companyName, project.projectName) === projectKey);
  const project = upsertWorkflowProject(data, { ...job, status: 'active', year: job.storageYear || String(job.dueDate || '').slice(0, 4) }, req, storageInfo);
  if (!projectExistedBefore && project?.id) job.autoCreatedProjectId = project.id;
  job.stageChecks.design.status = 'ready';
  job.stageChecks.design.updatedAt = job.updatedAt;
  // 제작방식: 외주(타 회사)면 공장 단계를 건너뛰고 경영관리(배송)로 바로 보낸다. 내부면 기존대로 디자인→공장.
  if (String(req.body.productionRoute || '') === 'external') {
    job.productionRoute = 'external';
    const at = job.updatedAt;
    for (const sid of ['design', 'factory']) {
      const c = job.stageChecks[sid];
      c.status = 'done'; c.completedAt = at; c.completedBy = job.createdBy; c.completedByName = job.createdByName; c.updatedAt = at;
    }
    job.stageChecks.factory.note = '외주(타 회사) — 공장 단계 건너뜀';
    syncWorkflowStageFlow(job, at); // → 경영관리(배송) ready, currentStage = delivery
    syncJobFactoryCompletion(data, req, job, at); // 외주: 제작완료일/완료코드 발번(내부 발주와 동일 — 납품지시서 '미발번' 방지)
  } else if (String(req.body.productionRoute || '') === 'none') {
    // 미발주: 시안만 등록·발주 보류. 디자인 단계 활성으로 두고 보드에 '미발주' 뱃지. 나중에 [내부/외주 발주]로 진행.
    job.productionRoute = 'none';
    job.unordered = true;
  } else {
    job.productionRoute = 'internal';
  }
  data.jobs.push(job);
  backfillRegistrationCodes(data); // 콜드스타트(첫 GET 전 POST) 대비: 기존 같은날 건 먼저 발번 → 등록순서 보존
  assignRegistrationCode(data.jobs, job); // 등록 즉시 등록코드 발번(끝까지 고정)
  addEvent(data, req, job.id, 'create', '작업 생성', { title: job.title });
  saveStore(data);
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

// 파일 개별 삭제 — 작성자·관리자만, 진행 중 작업만. 디스크 원본은 보존(목록에서만 제거 → 안전).
router.delete('/jobs/:id/files/:fileId', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (job.status === 'done' || job.status === 'cancelled') return res.status(400).json({ error: '완료/취소된 작업의 파일은 변경할 수 없습니다.' });
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req))) return res.status(403).json({ error: '파일 삭제는 작성자·관리자만 가능합니다.' });
  const idx = (data.files || []).findIndex(f => f.jobId === job.id && f.id === req.params.fileId);
  if (idx < 0) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const [removed] = data.files.splice(idx, 1);
  for (const o of (data.orders || [])) {
    if (Array.isArray(o.fileIds)) o.fileIds = o.fileIds.filter(fid => fid !== removed.id);
  }
  job.updatedAt = nowIso();
  addEvent(data, req, job.id, 'file', `파일 삭제 · ${removed.originalName || removed.id}`, { fileId: removed.id, fileName: removed.originalName || '' });
  saveStore(data);
  res.json({
    ok: true,
    job: decorateJob(data, job, req.user),
    files: data.files.filter(f => f.jobId === job.id).map(f => decorateWorkflowFile(f, req.user, job)),
  });
});

// 발주(작업) 취소 — 작성자·관리자만. 소프트 취소(기록 보존, 되돌리기로 복구 가능).
router.post('/jobs/:id/cancel', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req))) return res.status(403).json({ error: '발주 취소는 작성자·관리자만 가능합니다.' });
  if (job.status === 'cancelled') return res.status(400).json({ error: '이미 취소된 발주입니다.' });
  const at = nowIso();
  const prev = job.status || 'active';
  job.status = 'cancelled';
  job.cancelledAt = at;
  job.cancelledBy = req.user?.userId || '';
  job.cancelledByName = userName(req);
  job.updatedAt = at;
  addEvent(data, req, job.id, 'cancel', '발주 취소 · 기록 보존(되돌리기로 복구 가능)', { previousStatus: prev });
  saveStore(data);
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

// 미발주 → 발주 전환 — 작성자·관리자만. 내부/외주 지정 후 정상 흐름 진입.
router.post('/jobs/:id/reorder', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (job.status === 'cancelled') return res.status(400).json({ error: '취소된 발주입니다.' });
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req))) return res.status(403).json({ error: '발주는 작성자·관리자만 가능합니다.' });
  // 미발주 건만 발주 전환 가능 — 이미 발주(진행 중)된 작업을 stale 보드/중복클릭/직접호출로 리셋하는 사고 차단(공장 진행 데이터 보존).
  if (!job.unordered) return res.status(400).json({ error: '이미 발주된 작업입니다. (미발주 건만 발주 전환할 수 있습니다)' });
  const route = String(req.body.route || '') === 'external' ? 'external' : 'internal';
  const at = nowIso();
  job.unordered = false;
  job.productionRoute = route;
  job.status = 'active';
  if (route === 'external') {
    job.stageChecks = newStageChecks(job.stageChecks || {});
    for (const sid of ['design', 'factory']) {
      const c = job.stageChecks[sid];
      if (c) { c.status = 'done'; c.completedAt = at; c.completedBy = job.createdBy; c.completedByName = job.createdByName; c.updatedAt = at; }
    }
    if (job.stageChecks.factory) job.stageChecks.factory.note = '외주(타 회사) — 공장 단계 건너뜀';
  }
  syncWorkflowStageFlow(job, at); // 내부=디자인(공장이 가져감) / 외주=경영관리(배송)
  if (route === 'external') syncJobFactoryCompletion(data, req, job, at); // 외주: 제작완료일/완료코드 발번(내부 발주와 동일)
  job.updatedAt = at;
  addEvent(data, req, job.id, 'update', `미발주 → ${route === 'external' ? '외주' : '내부'} 발주`, { productionRoute: route });
  saveStore(data);
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

router.post('/jobs/:id/abort-empty', (req, res) => {
  const data = loadStore();
  const idx = data.jobs.findIndex(j => j.id === req.params.id);
  const job = idx >= 0 ? data.jobs[idx] : null;
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (!canAbortEmptyJob(data, job, req)) {
    return res.status(400).json({ error: '이미 파일이나 전달 기록이 있는 작업은 자동 정리할 수 없습니다.' });
  }
  const projectRemoved = removeAutoCreatedProjectForJob(data, job);
  data.jobs.splice(idx, 1);
  if (Array.isArray(data.events)) {
    data.events = data.events.filter(event => event.jobId !== job.id);
  }
  saveStore(data);
  res.json({ ok: true, projectRemoved });
});

router.put('/jobs/:id', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  // 변경 권한: 관리자·생성자·이 발주의 어느 단계든 담당 부서만 (무관한 직원 차단)
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || STAGES.some(s => canDeptActOnStage(req, s.id)))) {
    return res.status(403).json({ error: WF_NO_PERM });
  }
  const payload = normalizeJobPayload(req.body || {}, job);
  stageRules.applyDateRoleGuard(job, payload); // 요청날짜=design / 완료가능일=factory 단계만 저장
  const previousStatus = job.status || 'active';
  const prevFactoryDate = job.factoryAvailableDate || '';
  const at = nowIso();

  // 현장명 변경은 팀장 승인제 — PUT 으로 직접 못 바꿈(폴더·파일 경로가 같이 움직여야 해서).
  // 승인권자는 즉시 실행하되, 디스크 rename 은 모든 검증을 통과한 뒤 저장 직전에 1회만 수행한다.
  // (먼저 rename 하고 뒤의 검증이 400 을 내면 디스크만 바뀌고 DB 는 옛 이름으로 남는 분리가 생김 — 감사 #2,#3,#10)
  const approver = isWorkflowApprover(req);
  const renameFrom = String(job.projectName || '').trim();
  const renameTo = safeText(payload.projectName, 160).trim();
  let renamed = false;
  let renamePending = false;
  let pendingRenameTo = '';
  if (renameFrom && renameTo && renameTo !== renameFrom) {
    payload.projectName = job.projectName; // PUT 본문으로는 어떤 경우에도 직접 변경 안 됨
    if (approver) {
      pendingRenameTo = renameTo; // 저장 직전에 실행
    } else {
      job.renameRequest = { from: renameFrom, to: renameTo, requestedBy: req.user?.userId || '', requestedByName: userName(req), at };
      renamePending = true;
      addEvent(data, req, job.id, 'update', `현장명 변경 요청: ${renameFrom} → ${renameTo} · 팀장 승인 대기`, { renameRequested: true });
    }
  }
  // 회사명 변경도 저장 폴더 정체성을 가르므로 승인권자(팀장/관리자) 전용 — 일반 직원은 차단 (감사 #4)
  const companyFrom = String(job.companyName || '').trim();
  const companyTo = safeText(payload.companyName, 120).trim();
  let companyLocked = false;
  if (companyFrom && companyTo && companyTo !== companyFrom && !approver) {
    payload.companyName = job.companyName;
    companyLocked = true;
    addEvent(data, req, job.id, 'update', `회사명 변경 차단: ${companyFrom} → ${companyTo} · 팀장/관리자만 가능`, { companyChangeBlocked: true });
  }

  // 특이사항은 공장이 가져가기 전(디자인 단계)에만 수정 — 내용이 바뀌면 공장 확인 기록 리셋
  if (job.currentStage === 'design' && req.body.handoffNote !== undefined) {
    const rawNote = safeText(req.body.handoffNote, 1000).trim();
    const nextNote = (rawNote === '없음' || rawNote === '없음.') ? '' : rawNote;
    if (nextNote !== String(job.handoffNote || '')) {
      job.handoffNote = nextNote;
      job.handoffNoteAt = nextNote ? at : '';
      job.handoffNoteFrom = nextNote ? userName(req) : '';
      job.handoffNoteFromStage = nextNote ? 'design' : '';
      job.handoffNoteAckBy = '';
      job.handoffNoteAckByName = '';
      job.handoffNoteAckAt = '';
    }
  }
  if (payload.status === 'done' && previousStatus !== 'done') {
    // 완료 게이트는 '미완→완료 신규 전이'에만 적용. 이미 완료된 과거내역의 단순 편집은 통과.
    const nextJob = { ...job, ...payload };
    // 미발주(발주 전) 작업은 완료 불가 — 발주 절차를 건너뛴 채 완료/완료코드가 발번되는 모순 차단.
    if (nextJob.unordered) {
      return res.status(400).json({ error: '미발주 상태입니다. 먼저 [내부/외주 발주]로 발주한 뒤 완료할 수 있습니다.' });
    }
    // 단계 건너뛰기 방지: 앞 단계(디자인·공장)가 끝나지 않았으면 완료 불가.
    // (사장님 정책 '완료는 권한만' 은 유지 — 팀별 확인 강제는 없음. 단, 공장 작업 자체를 건너뛴 강제완료는 막는다.
    //  정상 흐름은 경영관리 단계에서 완료되며 그때 디자인·공장은 이미 done. 외주는 생성 시 공장 done 처리됨.)
    const skipped = STAGES.slice(0, STAGES.length - 1).find(s => (nextJob.stageChecks && nextJob.stageChecks[s.id] && nextJob.stageChecks[s.id].status) !== 'done');
    if (skipped) {
      return res.status(400).json({ error: `'${workflowStageLabel(skipped.id) || skipped.id}' 단계가 끝나지 않아 완료할 수 없습니다. 단계 순서대로 진행해주세요.` });
    }
    const blockers = completionBlockers(data, nextJob);
    if (blockers.length) {
      return res.status(400).json({
        error: '완료 전 확인할 항목이 남아 있습니다.',
        blockers,
      });
    }
  }
  Object.assign(job, payload, { updatedAt: at });
  let storageResult = { changed: false, info: null };
  try {
    storageResult = applyWorkflowDesignStorage(job);
  } catch (e) {
    return res.status(400).json({ error: '시안 저장 폴더를 만들 수 없습니다: ' + e.message });
  }
  upsertWorkflowProject(data, {
    ...job,
    status: workflowProjectStatusFromJobs(data, job.companyName, job.projectName, ['done', 'cancelled'].includes(job.status) ? 'done' : 'active'),
    year: job.storageYear || String(job.dueDate || '').slice(0, 4),
  }, req, storageResult.info);
  if (job.status === 'done') {
    completeWorkflowJob(data, req, job, at); // 내부에서 전 단계 done 확정(ensureStagesDone)
  } else {
    syncWorkflowStageFlow(job);
    clearWorkflowArchive(job);
    syncJobFactoryCompletion(data, req, job, at);
  }
  let eventType = 'update';
  let eventMessage = storageResult.changed ? '작업 정보 수정 · 저장 폴더 자동 준비' : '작업 정보 수정';
  if (previousStatus !== job.status && job.status === 'cancelled') {
    eventType = 'cancel';
    eventMessage = '작업 취소 표시 · 기록 보존';
  } else if (previousStatus === 'cancelled' && job.status !== 'cancelled') {
    eventType = 'restore';
    eventMessage = `${STATUS_LABELS[job.status] || job.status || '진행'} 상태로 취소 복구`;
  }
  addEvent(data, req, job.id, eventType, eventMessage, {
    previousStatus,
    status: job.status,
  });
  // 공장(대림컴퍼니)이 완료가능일을 바꾸면 디자인팀에 알림 — 요청일보다 늦으면 긴급(지연)
  if (job.currentStage === 'factory' && job.factoryAvailableDate && job.factoryAvailableDate !== prevFactoryDate) {
    const late = !!(job.dueDate && job.factoryAvailableDate > job.dueDate);
    addEvent(data, req, job.id, 'schedule', `공장 완료가능일 ${job.factoryAvailableDate}${late ? ` · 요청일(${job.dueDate})보다 지연` : ' · 일정 조정'}`, {
      targetStageIds: ['design'],
      factoryAvailableDate: job.factoryAvailableDate,
      dueDate: job.dueDate,
      scheduleLate: late,
      urgent: late,
    });
  }
  // 승인권자의 현장명 변경 — 모든 검증을 통과한 지금 시점에 디스크 rename + 일괄 갱신 실행
  let renameInfo = null;
  if (pendingRenameTo) {
    try { renameInfo = executeProjectRename(data, req, job, pendingRenameTo); renamed = true; }
    catch (e) { return res.status(400).json({ error: '현장명 변경 실패: ' + e.message }); }
    try { applyWorkflowDesignStorage(job); } catch (_) {}
    upsertWorkflowProject(data, {
      ...job,
      status: workflowProjectStatusFromJobs(data, job.companyName, job.projectName, ['done', 'cancelled'].includes(job.status) ? 'done' : 'active'),
      year: job.storageYear || String(job.dueDate || '').slice(0, 4),
    }, req, null);
  }
  try {
    saveStore(data);
  } catch (e) {
    // 저장 실패 → 방금 한 디스크 rename 을 역롤백해 디스크-DB 분리 방지 (감사 #10)
    if (renameInfo && renameInfo.oldDir && renameInfo.newDir) {
      try { fs.renameSync(renameInfo.newDir, renameInfo.oldDir); } catch (_) {}
      try { fileLocator().clear(); } catch (_) {}
    }
    return res.status(500).json({ error: '저장 실패: ' + e.message + (renameInfo ? ' (현장명 변경은 되돌렸습니다)' : '') });
  }
  res.json({ ok: true, job: decorateJob(data, job, req.user), renamed, renamePending, companyLocked });
});

// 현장명 변경 승인/거절 — 팀장(부서 leaderId) 또는 관리자만
router.post('/jobs/:id/rename/decision', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (!isJobRenameApprover(job, req)) return res.status(403).json({ error: '이 발주 담당 부서의 팀장(또는 관리자)만 승인할 수 있습니다.' });
  const reqInfo = job.renameRequest;
  if (!reqInfo || !reqInfo.to) return res.status(400).json({ error: '대기 중인 현장명 변경 요청이 없습니다.' });
  const accept = req.body.accept === true || String(req.body.accept) === 'true';
  let renameInfo = null;
  if (accept) {
    try { renameInfo = executeProjectRename(data, req, job, reqInfo.to); } // 내부에서 같은 현장 전체 renameRequest 정리
    catch (e) { return res.status(400).json({ error: '현장명 변경 실패: ' + e.message }); }
    // 새 이름 기준으로 스토리지/프로젝트 목록 상태 재정렬 (감사 #23)
    try { applyWorkflowDesignStorage(job); } catch (_) {}
    upsertWorkflowProject(data, {
      ...job,
      status: workflowProjectStatusFromJobs(data, job.companyName, job.projectName, ['done', 'cancelled'].includes(job.status) ? 'done' : 'active'),
      year: job.storageYear || String(job.dueDate || '').slice(0, 4),
    }, req, null);
  } else {
    // 거절은 같은 현장의 동일(from→to) 요청 전체에 적용 — 승인(전체 정리)과 대칭 (감사 #14)
    const rejectAt = nowIso();
    for (const j of data.jobs) {
      if (String(j.companyName || '') !== String(job.companyName || '')) continue;
      const rr = j.renameRequest;
      if (rr && rr.from === reqInfo.from && rr.to === reqInfo.to) {
        delete j.renameRequest;
        j.updatedAt = rejectAt;
        addEvent(data, req, j.id, 'update', `현장명 변경 거절: ${reqInfo.from} → ${reqInfo.to}`, { renameRejected: true });
      }
    }
  }
  try {
    saveStore(data);
  } catch (e) {
    if (renameInfo && renameInfo.oldDir && renameInfo.newDir) {
      try { fs.renameSync(renameInfo.newDir, renameInfo.oldDir); } catch (_) {}
      try { fileLocator().clear(); } catch (_) {}
    }
    return res.status(500).json({ error: '저장 실패: ' + e.message + (renameInfo ? ' (현장명 변경은 되돌렸습니다)' : '') });
  }
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

router.post('/jobs/:id/stages/:stageId', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  const stage = STAGES.find(s => s.id === req.params.stageId);
  if (!job || !stage) return res.status(404).json({ error: '작업 또는 단계를 찾을 수 없습니다.' });
  if (!canActOnStage(job, req, stage.id)) return res.status(403).json({ error: WF_NO_PERM });
  job.stageChecks = newStageChecks(job.stageChecks || {});
  const check = job.stageChecks[stage.id];
  const previousStatus = check.status || 'pending';
  const nextStatus = ['pending', 'ready', 'done', 'blocked'].includes(req.body.status) ? req.body.status : check.status;
  // 순서 강제: 앞 단계가 모두 done 이어야 이 단계를 'done' 으로 올릴 수 있음(직선흐름 정합성 — 디자인 미완인데 완료코드 발번 방지)
  if (nextStatus === 'done' && previousStatus !== 'done') {
    const idx = STAGES.findIndex(s => s.id === stage.id);
    const blocked = STAGES.slice(0, idx).find(s => job.stageChecks[s.id]?.status !== 'done');
    if (blocked) {
      return res.status(400).json({ error: `앞 단계 '${workflowStageLabel(blocked.id) || blocked.label}'를 먼저 완료해야 합니다.` });
    }
  }
  const at = nowIso();
  check.status = nextStatus;
  check.assignee = safeText(req.body.assignee, 80);
  check.dueDate = safeDate(req.body.dueDate);
  check.note = safeText(req.body.note, 1000);
  check.checklist = normalizeChecklist(stage.id, req.body.checklist);
  check.updatedAt = at;
  if (nextStatus === 'done') {
    check.completedAt = check.completedAt || at;
    check.completedBy = check.completedBy || (req.user?.userId || '');
    check.completedByName = check.completedByName || userName(req);
  }
  if (nextStatus !== 'done') { check.completedAt = ''; check.completedBy = ''; check.completedByName = ''; }
  syncWorkflowStageFlow(job);
  const allStagesDone = Object.values(job.stageChecks).every(c => c.status === 'done');
  const wasJobDone = job.status === 'done';
  job.status = allStagesDone ? 'done' : (job.status === 'done' ? 'active' : job.status);
  job.updatedAt = at;
  if (job.status === 'done') {
    // 신규 완료 전이에만 완료게이트 — 이미 done인 과거 발주의 단계 정정까지 막지 않음(was-done 가드)
    if (!wasJobDone) {
      const blockers = completionBlockers(data, job);
      if (blockers.length) return res.status(400).json({ error: '완료할 수 없습니다 — ' + blockers.map(b => b.label).join(', '), blockers });
    }
    completeWorkflowJob(data, req, job, at);
  } else {
    clearWorkflowArchive(job);
    syncJobFactoryCompletion(data, req, job, at);
  }
  const targetStageIds = previousStatus !== nextStatus ? stageStatusNotifyTargets(job, stage.id, nextStatus) : [];
  addEvent(data, req, job.id, 'stage', `${workflowStageLabel(stage.id) || stage.label} ${CHECK_STATUS_LABELS[nextStatus] || nextStatus}`, {
    stageId: stage.id,
    status: nextStatus,
    previousStatus,
    eventTargetLabel: stageTargetLabels(job, targetStageIds).join(', '),
    targetStageIds,
  });
  saveStore(data);
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

router.post('/jobs/:id/handoff', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (job.status === 'done' || job.status === 'cancelled') {
    return res.status(400).json({ error: '이미 종료된 작업입니다.' });
  }
  // 미발주(발주 전) 작업은 단계 전진 불가 — stale 보드/직접호출로 발주 절차를 건너뛰는 것 차단. 먼저 [내부/외주 발주].
  if (job.unordered) return res.status(409).json({ error: '미발주 상태입니다. 먼저 [내부/외주 발주]로 발주한 뒤 단계를 넘길 수 있습니다.' });

  job.stageChecks = newStageChecks(job.stageChecks || {});
  const requestedStageId = safeText(req.body.stageId, 80);
  const currentId = STAGES.some(s => s.id === requestedStageId)
    ? requestedStageId
    : STAGES.some(s => s.id === job.currentStage)
    ? job.currentStage
    : inferCurrentStage(job.stageChecks, 'design');
  const currentIdx = stageIndex(currentId);
  const current = STAGES[currentIdx];
  const next = STAGES[currentIdx + 1] || null;
  // 가져오기(디자인→공장)는 '공장이 당기는' 동선 — 공장(다음단계)·관리자만 허용. 디자인(현재단계)·작성자는 당길 수 없음.
  // 그 외 전진(공장→경영관리, 경영관리→완료)은 기존대로 미는 쪽(현재단계 담당)·작성자·관리자.
  const handoffAllowed = current.id === 'design'
    ? (isWorkflowAdmin(req) || (next && canDeptActOnStage(req, next.id)))
    : canHandoffJob(job, req, current.id, next ? next.id : '');
  if (!handoffAllowed) return res.status(403).json({ error: WF_NO_PERM });
  const message = safeText(req.body.message, 1000);
  const at = nowIso();

  const currentCheck = job.stageChecks[current.id];
  currentCheck.status = 'done';
  currentCheck.completedAt = currentCheck.completedAt || at;
  currentCheck.completedBy = currentCheck.completedBy || (req.user?.userId || '');
  currentCheck.completedByName = currentCheck.completedByName || userName(req);
  currentCheck.updatedAt = at;
  if (message) currentCheck.note = currentCheck.note ? `${currentCheck.note}\n${message}` : message;
  // 특이사항은 '등록 시' 디자인팀이 적는 게 기본(풀 모델 — 공장이 [가져오기] 누름).
  // 핸드오프 메시지가 따로 오면 그걸로 갱신하고 확인 기록 리셋, 빈 메시지면 등록된 특이사항 보존.
  if (message) {
    job.handoffNote = message;
    job.handoffNoteAt = at;
    job.handoffNoteFrom = userName(req);
    job.handoffNoteFromStage = current.id;
    job.handoffNoteAckBy = '';
    job.handoffNoteAckByName = '';
    job.handoffNoteAckAt = '';
  }

  syncWorkflowStageFlow(job, at);
  if (job.status === 'hold') job.status = 'active';

  if (next) {
    const nextCheck = job.stageChecks[next.id];
    if (nextCheck.status === 'pending') nextCheck.status = 'ready';
    nextCheck.updatedAt = at;
    syncWorkflowStageFlow(job, at);
    syncJobFactoryCompletion(data, req, job, at); // factory→delivery 전환 시 제작완료일/완료코드 발번
    addEvent(data, req, job.id, 'handoff', `${workflowStageLabel(current.id)} 완료 · ${workflowStageLabel(next.id) || next.label} 전달${message ? ' - ' + message : ''}`, {
      fromStageId: current.id,
      toStageId: next.id,
      eventTargetLabel: nextCheck.assignee || '',
      targetStageIds: [next.id],
    });
  } else {
    const blockers = completionBlockers(data, job);
    if (blockers.length) return res.status(400).json({ error: '완료할 수 없습니다 — ' + blockers.map(b => b.label).join(', '), blockers });
    job.status = 'done';
    addEvent(data, req, job.id, 'handoff', `작업 완료${message ? ' - ' + message : ''}`, {
      fromStageId: current.id,
      toStageId: '',
    });
    completeWorkflowJob(data, req, job, at);
  }

  job.updatedAt = at;
  saveStore(data);
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

// 특이사항 확인(공장 팝업의 [확인했습니다]) — 누가/언제 확인했는지 기록, 디자인팀에 알림
router.post('/jobs/:id/handoff-note/ack', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  // 특이사항 확인은 공장(가져가는 부서)·생성자·관리자만. 무관한 직원이 확인 처리하는 것 차단.
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || canDeptActOnStage(req, 'factory'))) return res.status(403).json({ error: WF_NO_PERM });
  if (!job.handoffNote) return res.status(400).json({ error: '확인할 특이사항이 없습니다.' });
  if (!job.handoffNoteAckAt) {
    job.handoffNoteAckBy = req.user?.userId || '';
    job.handoffNoteAckByName = userName(req);
    job.handoffNoteAckAt = nowIso();
    job.updatedAt = job.handoffNoteAckAt;
    addEvent(data, req, job.id, 'update', `특이사항 확인 — ${job.handoffNoteAckByName}`, {
      handoffNoteAck: true,
      targetStageIds: ['design'],
    });
    saveStore(data);
  }
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

// 실수로 다음 단계로 넘긴 작업을 한 단계 뒤로 되돌림. 과거내역(완료/취소)이면 배송 단계로 복구.
router.post('/jobs/:id/stepback', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (job.status === 'done' || job.status === 'cancelled') {
    if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || canDeptActOnStage(req, 'delivery')))
      return res.status(403).json({ error: '완료/취소 보관은 경영관리팀(또는 관리자)만 되돌릴 수 있습니다.' });
  } else if (!canActOnCurrentStage(job, req)) {
    return res.status(403).json({ error: WF_NO_PERM });
  }
  job.stageChecks = newStageChecks(job.stageChecks || {});
  const at = nowIso();
  if (job.status === 'done' || job.status === 'cancelled') {
    job.status = 'active';
    if (job.unordered) {
      // 미발주(발주 전) 작업의 복구 — 발주를 안 했으므로 마지막 단계가 아니라 디자인 단계로 되돌린다.
      // (마지막 단계로 보내면 design='ready' + delivery='ready' 가 공존해 같은 카드가 디자인·경영관리 두 칸에 동시 표시되는 버그)
      const first = STAGES[0];
      const fc = job.stageChecks[first.id];
      fc.status = 'ready'; fc.completedAt = ''; fc.completedBy = ''; fc.completedByName = ''; fc.updatedAt = at;
      for (const s of STAGES.slice(1)) {
        const c = job.stageChecks[s.id];
        if (c) { c.status = 'pending'; c.completedAt = ''; c.completedBy = ''; c.completedByName = ''; c.updatedAt = at; }
      }
    } else {
      // 완료/취소 보관 → 마지막 단계(배송)로 되돌려 다시 진행 상태로
      const last = STAGES[STAGES.length - 1];
      const lc = job.stageChecks[last.id];
      lc.status = 'ready'; lc.completedAt = ''; lc.completedBy = ''; lc.completedByName = ''; lc.updatedAt = at;
    }
    clearWorkflowArchive(job);
  } else {
    const curId = inferCurrentStage(job.stageChecks, job.currentStage || 'design');
    const curIdx = stageIndex(curId);
    if (curIdx <= 0) return res.status(400).json({ error: '디자인팀이 첫 단계라 더 되돌릴 수 없습니다.' });
    const prev = STAGES[curIdx - 1];
    const pc = job.stageChecks[prev.id];
    pc.status = 'ready'; pc.completedAt = ''; pc.completedBy = ''; pc.completedByName = ''; pc.updatedAt = at;
    const cc = job.stageChecks[curId];
    cc.status = 'pending'; cc.completedAt = ''; cc.updatedAt = at;
  }
  syncWorkflowStageFlow(job, at);
  syncJobFactoryCompletion(data, req, job, at); // factory 미완료로 돌아가면 제작완료일 초기화(완료코드는 영구보존)
  job.updatedAt = at;
  addEvent(data, req, job.id, 'update', `${workflowStageLabel(job.currentStage) || job.currentStage} 단계로 되돌림 (실수 취소)`, {
    toStageId: job.currentStage,
  });
  saveStore(data);
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

router.post('/jobs/:id/events', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  // 코멘트 작성은 관리자·생성자·이 발주의 어느 단계든 담당 부서만. 무관한 직원의 기록 추가 차단.
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || STAGES.some(s => canDeptActOnStage(req, s.id)))) return res.status(403).json({ error: WF_NO_PERM });
  const message = safeText(req.body.message, 3000);
  if (!message) return res.status(400).json({ error: '내용이 필요합니다.' });
  const targetUserId = safeText(req.body.targetUserId, 80);
  const targetUserName = safeText(req.body.targetUserName, 80);
  const targetLabel = safeText(req.body.targetLabel, 120) || targetUserName;
  const event = addEvent(data, req, job.id, 'comment', message, {
    eventTargetUserId: targetUserId,
    eventTargetUserName: targetUserName,
    eventTargetLabel: targetLabel,
  });
  job.updatedAt = nowIso();
  saveStore(data);
  res.json({ ok: true, event: decorateWorkflowEvent(event, req.user, job) });
});

router.post('/jobs/:id/events/:eventId/read', (req, res) => {
  const data = loadStore();
  const event = data.events.find(e => e.jobId === req.params.id && e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  const job = data.jobs.find(j => j.id === event.jobId) || null;
  // 읽음 처리도 관리자·생성자·이 발주의 어느 단계든 담당 부서만. 무관한 직원의 상태 변경 차단.
  if (job && !(isWorkflowAdmin(req) || isJobCreator(job, req) || STAGES.some(s => canDeptActOnStage(req, s.id)))) return res.status(403).json({ error: WF_NO_PERM });
  if (markEventReadBy(event, req)) {
    addEvent(data, req, event.jobId, 'event_read', `${event.message || '기록'} 확인`, { eventId: event.id });
    saveStore(data);
  }
  res.json({ ok: true, event: decorateWorkflowEvent(event, req.user, job) });
});

router.post('/jobs/:id/items/:itemId/read', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id) || null;
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  // 읽음 처리도 관리자·생성자·이 발주의 어느 단계든 담당 부서만. 무관한 직원의 상태 변경 차단.
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || STAGES.some(s => canDeptActOnStage(req, s.id)))) return res.status(403).json({ error: WF_NO_PERM });
  const itemId = safeText(req.params.itemId, 120);
  const file = data.files.find(f => f.jobId === job.id && f.id === itemId);
  if (file) {
    if (markFileReadBy(file, req)) {
      addEvent(data, req, file.jobId, 'read', `${file.originalName} 확인`, { fileId: file.id });
      saveStore(data);
    }
    return res.json({ ok: true, kind: 'file', file: decorateWorkflowFile(file, req.user, job) });
  }
  const event = data.events.find(e => e.jobId === job.id && e.id === itemId);
  if (event) {
    if (markEventReadBy(event, req)) {
      addEvent(data, req, event.jobId, 'event_read', `${event.message || '기록'} 확인`, { eventId: event.id });
      saveStore(data);
    }
    return res.json({ ok: true, kind: 'event', event: decorateWorkflowEvent(event, req.user, job) });
  }
  return res.status(404).json({ error: '확인할 항목을 찾을 수 없습니다.' });
});

router.get('/jobs/:id/files', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  const files = data.files
    .filter(f => f.jobId === job.id)
    .map(f => decorateWorkflowFile(f, req.user, job));
  res.json({
    ok: true,
    files,
    deliverySummary: buildDeliverySummary(files, req.user, job),
  });
});

router.get('/jobs/:id/orders', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json({
    ok: true,
    orders: (data.orders || []).filter(o => o.jobId === job.id).map(o => decorateOrder(data, job, o)),
    orderSummary: buildOrderSummary(data, job),
  });
});

router.post('/jobs/:id/orders', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (job.status === 'done' || job.status === 'cancelled') return res.status(400).json({ error: '완료/취소된 작업은 변경할 수 없습니다.' });
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || canDeptActOnStage(req, 'factory') || canDeptActOnStage(req, 'delivery'))) return res.status(403).json({ error: '제작 파일 전달(외부 발송)은 공장·경영관리(또는 관리자)만 가능합니다.' });
  const payload = normalizeOrderPayload(req.body || {});
  if (!Object.prototype.hasOwnProperty.call(req.body || {}, 'status')) payload.status = 'requested';
  const validFileIds = new Set(data.files.filter(f => f.jobId === job.id).map(f => f.id));
  payload.fileIds = payload.fileIds.filter(id => validFileIds.has(id));
  if (!payload.fileIds.length) return res.status(400).json({ error: '전달할 파일이 필요합니다.' });
  const order = {
    id: makeId('wfo'),
    publicToken: makeUniquePublicToken(data),
    jobId: job.id,
    ...payload,
    createdBy: req.user?.userId || '',
    createdByName: userName(req),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  data.orders.push(order);
  const recipientSavedToVendor = rememberWorkflowVendorEmail(order, order.recipientEmail);
  job.updatedAt = nowIso();
  const targetStageIds = orderTargetStageIds(order);
  addEvent(data, req, job.id, 'order', `제작 파일 전달 생성 · ${order.targetName} · 파일 ${order.fileIds.length}건`, {
    orderId: order.id,
    targetName: order.targetName,
    targetType: order.targetType,
    recipientSavedToVendor,
    fileIds: order.fileIds,
    eventTargetLabel: stageTargetLabels(job, targetStageIds).join(', '),
    targetStageIds,
  });
  saveStore(data);
  res.json({
    ok: true,
    order: decorateOrder(data, job, order),
    orders: data.orders.filter(o => o.jobId === job.id).map(o => decorateOrder(data, job, o)),
    orderSummary: buildOrderSummary(data, job),
    job: decorateJob(data, job, req.user),
    recipientSavedToVendor,
  });
});

router.put('/jobs/:id/orders/:orderId', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  const order = (data.orders || []).find(o => o.jobId === req.params.id && o.id === req.params.orderId);
  if (!job || !order) return res.status(404).json({ error: '작업 또는 전달건을 찾을 수 없습니다.' });
  if (job.status === 'cancelled') return res.status(400).json({ error: '취소된 작업은 변경할 수 없습니다.' });
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || canDeptActOnStage(req, 'factory') || canDeptActOnStage(req, 'delivery'))) return res.status(403).json({ error: '제작 파일 전달(외부 발송)은 공장·경영관리(또는 관리자)만 가능합니다.' });
  const beforeStatus = order.status || 'draft';
  const payload = normalizeOrderPayload(req.body || {}, order);
  const validFileIds = new Set(data.files.filter(f => f.jobId === job.id).map(f => f.id));
  payload.fileIds = payload.fileIds.filter(id => validFileIds.has(id));
  if (!payload.fileIds.length) payload.fileIds = normalizeFileIds(order.fileIds || []);
  Object.assign(order, payload, {
    updatedAt: nowIso(),
    updatedBy: req.user?.userId || '',
    updatedByName: userName(req),
  });
  const recipientSavedToVendor = rememberWorkflowVendorEmail(order, order.recipientEmail);
  job.updatedAt = nowIso();
  const targetStageIds = orderTargetStageIds(order);
  const orderStatusChanged = beforeStatus !== order.status;
  const eventType = orderStatusChanged && order.status === 'cancelled'
    ? 'order_cancel'
    : orderStatusChanged && beforeStatus === 'cancelled'
      ? 'order_restore'
      : 'order_update';
  const eventLabel = eventType === 'order_cancel'
    ? '제작 파일 전달 취소'
    : eventType === 'order_restore'
      ? '제작 파일 전달 복구'
      : `제작 파일 전달 ${ORDER_STATUS_LABELS[order.status] || order.status}`;
  addEvent(data, req, job.id, eventType, `${eventLabel} · ${order.targetName}`, {
    orderId: order.id,
    targetName: order.targetName,
    status: order.status,
    previousStatus: beforeStatus,
    recipientSavedToVendor,
    eventTargetLabel: stageTargetLabels(job, targetStageIds).join(', '),
    targetStageIds,
  });
  saveStore(data);
  res.json({
    ok: true,
    order: decorateOrder(data, job, order),
    orders: data.orders.filter(o => o.jobId === job.id).map(o => decorateOrder(data, job, o)),
    orderSummary: buildOrderSummary(data, job),
    job: decorateJob(data, job, req.user),
    recipientSavedToVendor,
  });
});

router.post('/jobs/:id/orders/:orderId/email', async (req, res) => {
  try {
    const data = loadStore();
    const job = data.jobs.find(j => j.id === req.params.id);
    const order = (data.orders || []).find(o => o.jobId === req.params.id && o.id === req.params.orderId);
    if (!job || !order) return res.status(404).json({ error: '작업 또는 전달건을 찾을 수 없습니다.' });
    if (job.status === 'cancelled') return res.status(400).json({ error: '취소된 작업의 파일은 외부로 보낼 수 없습니다.' });
    if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || canDeptActOnStage(req, 'factory') || canDeptActOnStage(req, 'delivery'))) return res.status(403).json({ error: '제작 파일 외부 발송은 공장·경영관리(또는 관리자)만 가능합니다.' });

    const toList = normalizeEmailList(req.body?.toEmail || req.body?.recipientEmail || order.recipientEmail || order.mailTo || '');
    const ccList = normalizeEmailList(req.body?.ccEmail || req.body?.recipientCc || order.recipientCc || order.mailCc || '');
    if (!toList.length) return res.status(400).json({ error: '수신 이메일이 필요합니다.' });

    const smtp = loadWorkflowSmtpSettings();
    if (!smtp) return res.status(400).json({ error: 'SMTP 설정이 완료되지 않았습니다.' });

    const files = orderFiles(data, order, job);
    if (!files.length) return res.status(400).json({ error: '발송할 파일이 없습니다.' });

    const attachFiles = req.body?.attachFiles !== false;
    const publicUrl = absoluteWorkflowOrderUrl(order, req);
    if (!attachFiles && !publicUrl) {
      return res.status(400).json({ error: '링크만 발송하려면 워크플로우 외부 다운로드 주소를 먼저 저장해주세요.' });
    }
    const mailFiles = workflowOrderMailAttachments(files, attachFiles);
    if (attachFiles && !mailFiles.attachments.length) {
      // A 정책(2026-06-16)으로 보낼 파일이 0건이 된 경우(예: 전부 파일명에 '발주' 없는 .ai) — 빈 메일 조용히 발송 방지.
      // 본문엔 '파일 N건'이 찍히는데 실제 첨부 0건이면 공장/외주는 빈 메일을 받는다 → 막고 안내.
      return res.status(400).json({ error: '첨부할 발주 파일이 없습니다. AI(.ai) 파일은 파일명에 "발주"가 들어간 것만 발송됩니다 — 파일명을 확인하거나 시안 파일을 함께 올려주세요.' });
    }
    if (mailFiles.tooLarge) {
      if (!publicUrl) {
        return res.status(400).json({ error: '첨부 용량이 큽니다. 링크 발송을 위해 워크플로우 외부 다운로드 주소를 먼저 저장해주세요.' });
      }
      return res.status(413).json({
        error: `첨부 용량이 ${Math.round(mailFiles.totalBytes / 1024 / 1024)}MB입니다. 메일 첨부는 ${Math.round(MAX_WORKFLOW_MAIL_ATTACH_BYTES / 1024 / 1024)}MB 이하일 때만 발송합니다.`,
        publicUrl,
      });
    }

    const subject = safeText(req.body?.subject, 240) || defaultWorkflowOrderMailSubject(job, order);
    const message = safeText(req.body?.message, 3000);
    // 링크는 대용량 폴백(attachFiles=false, 파일을 첨부 못 해 링크로 보내는 경우)에만 — 일반 첨부 메일엔 링크 안 넣음(2026-06-17 요청).
    const html = buildWorkflowOrderMailHtml(job, order, files, message, attachFiles ? '' : publicUrl);

    try {
      await sendSmtpMail({
        smtpHost: smtp.host,
        smtpPort: smtp.port,
        smtpUser: smtp.user,
        smtpPass: smtp.pass,
        from: smtp.from,
        to: toList,
        cc: ccList,
        subject,
        html,
        attachments: mailFiles.attachments,
      });
    } catch (sendErr) {
      // 발송 실패 영속 기록 — 검증/권한 실패(400/403/404/413)는 전송 전 return이라 여기 안 옴(실제 전송 실패만 'failed').
      const failFresh = loadStore();
      const failJob = failFresh.jobs.find(j => j.id === req.params.id) || job;
      const failOrder = (failFresh.orders || []).find(o => o.jobId === req.params.id && o.id === req.params.orderId) || order;
      const failAt = nowIso();
      failOrder.mailStatus = 'failed';
      failOrder.mailError = String(sendErr.message || '발송 실패').slice(0, 500);
      failOrder.mailFailedAt = failAt;
      failOrder.mailFailedBy = req.user?.userId || '';
      if (!Array.isArray(failOrder.mailHistory)) failOrder.mailHistory = [];
      failOrder.mailHistory.push({ to: toList, subject, sentAt: failAt, sentBy: req.user?.userId || '', sentByName: userName(req), status: 'failed', error: failOrder.mailError });
      failOrder.updatedAt = failAt;
      try { saveStore(failFresh); } catch (_) {}
      console.error('[workflow-mail] send failed:', sendErr);
      return res.status(500).json({ error: '메일 발송 실패: ' + sendErr.message, order: decorateOrder(failFresh, failJob, failOrder) });
    }

    // 메일 전송(await) 동안 다른 요청이 스토어를 바꿨을 수 있음 — stale 스냅샷을 그대로 저장하면
    // 그 사이 변경(예: 승인된 현장명 변경)이 통째로 롤백됨(감사 #1 critical). 최신 스토어를 다시 읽어 그 위에 기록.
    const fresh = loadStore();
    const freshJob = fresh.jobs.find(j => j.id === req.params.id) || job;
    const freshOrder = (fresh.orders || []).find(o => o.jobId === req.params.id && o.id === req.params.orderId) || order;

    const sentAt = nowIso();
    freshOrder.deliveryMethod = 'email';
    freshOrder.mailStatus = 'sent';
    freshOrder.mailSentAt = sentAt;
    freshOrder.mailSentBy = req.user?.userId || '';
    freshOrder.mailSentByName = userName(req);
    freshOrder.mailTo = toList.join(', ');
    freshOrder.mailCc = ccList.join(', ');
    freshOrder.recipientEmail = toList.join(', ');
    freshOrder.recipientCc = ccList.join(', ');
    freshOrder.mailSubject = subject;
    const recipientSavedToVendor = rememberWorkflowVendorEmail(freshOrder, toList[0]);
    if (!Array.isArray(freshOrder.mailHistory)) freshOrder.mailHistory = [];
    freshOrder.mailHistory.push({
      to: toList,
      cc: ccList,
      subject,
      sentAt,
      sentBy: req.user?.userId || '',
      sentByName: userName(req),
      fileCount: files.length,
      attachedCount: mailFiles.attachments.length,
      publicUrl,
      recipientSavedToVendor,
    });
    if (['draft', 'requested'].includes(freshOrder.status || 'draft')) freshOrder.status = 'sent';
    freshOrder.updatedAt = sentAt;
    freshOrder.updatedBy = req.user?.userId || '';
    freshOrder.updatedByName = userName(req);
    freshJob.updatedAt = sentAt;

    addEvent(fresh, req, freshJob.id, 'order_email', `제작 파일 메일 발송 · ${freshOrder.targetName} · ${toList.join(', ')}`, {
      orderId: freshOrder.id,
      targetName: freshOrder.targetName,
      to: toList,
      cc: ccList,
      fileCount: files.length,
      attachedCount: mailFiles.attachments.length,
      publicUrl,
      recipientSavedToVendor,
      targetStageIds: ['delivery'],
      eventTargetLabel: stageTargetLabels(freshJob, ['delivery']).join(', '),
    });
    saveStore(fresh);
    res.json({
      ok: true,
      order: decorateOrder(fresh, freshJob, freshOrder),
      orders: (fresh.orders || []).filter(o => o.jobId === freshJob.id).map(o => decorateOrder(fresh, freshJob, o)),
      orderSummary: buildOrderSummary(fresh, freshJob),
      job: decorateJob(fresh, freshJob, req.user),
      recipientSavedToVendor,
      message: `${toList.join(', ')}로 발송 완료${recipientSavedToVendor ? ' · 업체 메일 저장' : ''}`,
    });
  } catch (e) {
    console.error('[workflow-mail] send failed:', e);
    res.status(500).json({ error: '메일 발송 실패: ' + e.message });
  }
});

router.post('/jobs/:id/files', workflowUploadFiles, (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  if (['done', 'cancelled'].includes(job.status || '')) {
    for (const file of req.files || []) {
      try { fs.unlinkSync(path.join(FILE_DIR, file.filename)); } catch (_) {}
    }
    return res.status(400).json({ error: '완료/취소된 작업에는 파일을 추가할 수 없습니다.' });
  }
  // 업로드 권한: 관리자·생성자·이 발주의 어느 단계든 담당 부서만. 무관한 직원이 남의 시안 폴더에 올리는 것 차단.
  // (폴더 생성/파일 이동 전에 게이트 — 거부 시 임시 업로드 파일만 정리)
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || STAGES.some(s => canDeptActOnStage(req, s.id)))) {
    for (const file of req.files || []) {
      try { fs.unlinkSync(path.join(FILE_DIR, file.filename)); } catch (_) {}
    }
    return res.status(403).json({ error: WF_NO_PERM });
  }
  const stageId = STAGES.some(s => s.id === req.body.stageId) ? req.body.stageId : job.currentStage;
  const kind = ['proof', 'attachment', 'drawing', 'photo'].includes(req.body.kind) ? req.body.kind : 'attachment';
  const stageAssignee = safeText(job.stageChecks?.[stageId]?.assignee, 80);
  const targetUserId = safeText(req.body.targetUserId, 80);
  const targetUserName = safeText(req.body.targetUserName, 80);
  const requestedTargetLabel = bodyText(req.body, 'targetLabel', 120);
  const autoTargetLabels = defaultUploadTargetLabels(job, stageId, kind);
  const isDesignAsset = stageId === 'design' && ['proof', 'drawing', 'photo'].includes(kind);
  const requestedTargetStageIds = normalizeTargetStageIds(req.body.targetStageIds);
  const targetStageIds = targetUserId || targetUserName
    ? []
    : isDesignAsset
      ? (requestedTargetStageIds.length ? requestedTargetStageIds : [nextStageId('design')].filter(Boolean))
      : requestedTargetStageIds;
  const targetLabels = targetUserId || targetUserName
    ? uniqueTexts([requestedTargetLabel || targetUserName || targetUserId])
    : isDesignAsset
      ? (splitTargetLabels(requestedTargetLabel).length > 1 ? splitTargetLabels(requestedTargetLabel) : autoTargetLabels)
      : (requestedTargetLabel ? uniqueTexts([requestedTargetLabel]) : autoTargetLabels);
  const targetLabel = targetLabels.join(', ') || targetUserName || stageAssignee;
  const storageYear = safeYear(req.body.storageYear || safeDate(req.body.designDueDate).slice(0, 4));
  // 서버의 현재 회사·현장명 우선 — 개명 직후 stale 클라이언트가 옛 이름 폴더를 재생성하는 것 방지 (감사 #11)
  const storageCompanyName = safeText(job.companyName, 120) || bodyText(req.body, 'storageCompanyName', 120);
  // 현장명(프로젝트)은 없어도 됨 — 비면 회사\연도 폴더에 바로 저장(업체만 있는 곳 대응). 회사명만 필수.
  const storageProjectName = safeText(job.projectName, 160) || bodyText(req.body, 'storageProjectName', 160);
  if (!storageCompanyName) {
    for (const file of req.files || []) {
      try { fs.unlinkSync(path.join(FILE_DIR, file.filename)); } catch (_) {}
    }
    return res.status(400).json({ error: '회사를 먼저 선택해주세요.' });
  }
  const storageYearPart = safeFilePart(storageYear, String(new Date().getFullYear()));
  const storageCompanyPart = safeFilePart(storageCompanyName, '미지정업체');
  const storageProjectPart = safeFilePart(storageProjectName, '미지정프로젝트');
  const storageRelDir = `${storageYearPart}/${storageCompanyPart}/${storageProjectPart}`;
  const storageDir = path.join(FILE_DIR, storageYearPart, storageCompanyPart, storageProjectPart);
  let actualStorageInfo = null;
  let actualStorageDir = storageDir;
  let actualStorageRelDir = storageRelDir;
  let actualStorageRoot = 'workflow';
  let actualStorageYearPart = storageYearPart;
  let actualStorageCompanyPart = storageCompanyPart;
  let actualStorageProjectPart = storageProjectPart;
  try {
    actualStorageInfo = resolveWorkflowDesignStorage(storageCompanyName, storageProjectName, storageYear, true);
    if (!actualStorageInfo) {
      for (const file of req.files || []) {
        try { fs.unlinkSync(path.join(FILE_DIR, file.filename)); } catch (_) {}
      }
      return res.status(400).json({
        error: '선택한 회사/프로젝트 저장 폴더를 준비하지 못했습니다.',
      });
    }
    if (actualStorageInfo) {
      actualStorageDir = actualStorageInfo.dir;
      actualStorageRelDir = actualStorageInfo.rel;
      actualStorageRoot = 'design';
      actualStorageYearPart = actualStorageInfo.year;
      actualStorageCompanyPart = actualStorageInfo.companyFolderName;
      actualStorageProjectPart = actualStorageInfo.projectFolderName;
    }
  } catch (e) {
    for (const file of req.files || []) {
      try { fs.unlinkSync(path.join(FILE_DIR, file.filename)); } catch (_) {}
    }
    return res.status(400).json({ error: '시안 저장 폴더를 확인할 수 없습니다: ' + e.message });
  }
  const uploaded = [];
  const movedFiles = [];
  for (const file of req.files || []) {
    const originalName = uploadName(file.originalname || file.filename);
    const version = data.files.filter(f => f.jobId === job.id && f.stageId === stageId && f.originalName === originalName).length + 1;
    let storedPath = file.filename;
    let storedName = file.filename;
    try {
      if (!fs.existsSync(actualStorageDir)) throw new Error('target folder missing');
      const from = path.join(FILE_DIR, file.filename);
      const target = uniqueStoredFileTarget(actualStorageDir, originalName || file.filename);
      if (!fs.existsSync(from)) throw new Error('uploaded temp file missing');
      fs.renameSync(from, target.fullPath);
      if (!fs.existsSync(target.fullPath)) throw new Error('file move failed');
      storedName = target.fileName;
      movedFiles.push(target.fullPath);
      storedPath = actualStorageInfo ? target.fullPath : `${actualStorageRelDir}/${target.fileName}`;
    } catch (e) {
      for (const movedPath of movedFiles) {
        try { fs.unlinkSync(movedPath); } catch (_) {}
      }
      for (const pending of req.files || []) {
        try { fs.unlinkSync(path.join(FILE_DIR, pending.filename)); } catch (_) {}
      }
      return res.status(500).json({ error: '파일을 서버 폴더에 저장하지 못했습니다: ' + e.message });
    }
    const rec = {
      id: makeId('wff'),
      publicToken: makeUniquePublicToken(data),
      jobId: job.id,
      stageId,
      kind,
      version,
      originalName,
      storedName,
      storedPath,
      mime: file.mimetype || 'application/octet-stream',
      size: file.size || 0,
      note: bodyText(req.body, 'note', 1000),
      designDueDate: safeDate(req.body.designDueDate),
      urgent: String(req.body.urgent || '') === '1' || req.body.urgent === true,
      scheduleNegotiation: '',
      storageRoot: actualStorageRoot,
      storageYear,
      storageCompanyName,
      storageProjectName,
      storageBucket: actualStorageRelDir,
      storageRelDir: actualStorageRelDir,
      storagePath: actualStorageDir,
      storageNetPath: workflowDesignNetworkPath(actualStorageDir),
      storageFolderCreated: !!actualStorageInfo?.created,
      storageFolderExistedBefore: actualStorageInfo ? !!actualStorageInfo.existedBefore : true,
      factoryAvailableDate: '',
      factoryScheduleNote: '',
      targetUserId,
      targetUserName,
      targetLabel,
      targetLabels,
      targetStageIds,
      reviewStatus: 'pending',
      reviewNote: '',
      reviewedBy: '',
      reviewedByName: '',
      reviewedAt: '',
      uploadedBy: req.user?.userId || '',
      uploadedByName: userName(req),
      readBy: [],
      createdAt: nowIso(),
    };
    data.files.push(rec);
    uploaded.push(rec);
  }
  if (uploaded.length) {
    job.updatedAt = nowIso();
    if (actualStorageInfo) {
      upsertWorkflowProject(data, {
        companyName: storageCompanyName,
        projectName: storageProjectName,
        year: actualStorageInfo.year || storageYear,
        status: workflowProjectStatusFromJobs(data, storageCompanyName, storageProjectName, 'active'),
      }, req, actualStorageInfo);
    }
    addEvent(data, req, job.id, 'file', `파일 ${uploaded.length}개 업로드${actualStorageInfo?.created ? ' · 저장 폴더 자동 준비' : ''}${targetLabel ? ' · 확인 대상 ' + targetLabel : ''}`, {
      stageId,
      fileIds: uploaded.map(f => f.id),
      eventTargetUserId: targetUserId,
      eventTargetUserName: targetUserName,
      eventTargetLabel: targetLabel,
      targetStageIds,
    });
  }
  saveStore(data);
  // 폴더가 새로 만들어졌을 수 있으니 해당 프로젝트의 폴더해석 캐시를 비운다(읽기 폴백이 최신 폴더를 보도록).
  if (actualStorageInfo) fileLocator().invalidateResolve(storageCompanyName, storageProjectName, actualStorageInfo.year || storageYear);
  res.json({
    ok: true,
    files: uploaded.map(f => decorateWorkflowFile(f, req.user, job)),
    job: decorateJob(data, job, req.user),
    storage: {
      root: actualStorageRoot,
      rel: actualStorageRelDir,
      year: actualStorageYearPart,
      companyFolderName: actualStorageCompanyPart,
      yearFolderName: actualStorageInfo?.yearFolderName || storageYearPart,
      projectFolderName: actualStorageProjectPart,
      created: !!actualStorageInfo?.created,
      existedBefore: actualStorageInfo ? !!actualStorageInfo.existedBefore : true,
    },
  });
});

router.post('/jobs/:id/files/:fileId/read', (req, res) => {
  const data = loadStore();
  const file = data.files.find(f => f.jobId === req.params.id && f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const job = data.jobs.find(j => j.id === file.jobId) || null;
  if (markFileReadBy(file, req)) {
    addEvent(data, req, file.jobId, 'read', `${file.originalName} 확인`, { fileId: file.id });
    saveStore(data);
  }
  res.json({ ok: true, file: decorateWorkflowFile(file, req.user, job) });
});

router.post('/jobs/:id/files/:fileId/review', (req, res) => {
  const data = loadStore();
  const file = data.files.find(f => f.jobId === req.params.id && f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  const job = data.jobs.find(j => j.id === file.jobId) || null;
  if (job && (job.status === 'done' || job.status === 'cancelled')) return res.status(400).json({ error: '완료/취소된 작업의 파일은 변경할 수 없습니다.' });
  if (job && !(isWorkflowAdmin(req) || isJobCreator(job, req) || STAGES.some(s => canDeptActOnStage(req, s.id)))) return res.status(403).json({ error: WF_NO_PERM });
  const status = ['pending', 'approved', 'change_requested'].includes(req.body.status) ? req.body.status : '';
  if (!status) return res.status(400).json({ error: '검토 상태가 필요합니다.' });
  const note = safeText(req.body.note, 1000);
  file.reviewStatus = status;
  file.reviewNote = note;
  file.reviewedBy = req.user?.userId || '';
  file.reviewedByName = userName(req);
  file.reviewedAt = nowIso();
  markFileReadBy(file, req);
  const label = FILE_REVIEW_LABELS[status] || status;
  addEvent(data, req, file.jobId, 'review', `${file.originalName} ${label}${note ? ' - ' + note : ''}`, {
    fileId: file.id,
    status,
    eventTargetLabel: job?.stageChecks?.design?.assignee || '',
    targetStageIds: ['design'],
  });
  saveStore(data);
  res.json({ ok: true, file: decorateWorkflowFile(file, req.user, job) });
});

router.post('/jobs/:id/files/:fileId/schedule', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  const file = data.files.find(f => f.jobId === req.params.id && f.id === req.params.fileId);
  if (!job || !file) return res.status(404).json({ error: '작업 또는 파일을 찾을 수 없습니다.' });
  if (job.status === 'done' || job.status === 'cancelled') return res.status(400).json({ error: '완료/취소된 작업은 변경할 수 없습니다.' });
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || canDeptActOnStage(req, 'design') || canDeptActOnStage(req, 'factory'))) return res.status(403).json({ error: WF_NO_PERM });
  job.stageChecks = newStageChecks(job.stageChecks || {});
  const designBefore = file.designDueDate || '';
  const factoryBefore = file.factoryAvailableDate || '';
  const noteBefore = file.factoryScheduleNote || '';
  const urgentBefore = !!file.urgent;
  const negotiationBefore = file.scheduleNegotiation || '';
  file.designDueDate = safeDate(req.body.designDueDate);
  file.urgent = String(req.body.urgent || '') === '1' || req.body.urgent === true;
  file.factoryAvailableDate = safeDate(req.body.factoryAvailableDate);
  file.factoryScheduleNote = safeText(req.body.factoryScheduleNote, 1000);
  file.scheduleNegotiation = ['pending', 'possible', 'needs_change', 'confirmed'].includes(req.body.scheduleNegotiation)
    ? req.body.scheduleNegotiation
    : (file.scheduleNegotiation || (file.factoryAvailableDate ? 'possible' : 'pending'));
  file.scheduleUpdatedAt = nowIso();
  file.scheduleUpdatedBy = req.user?.userId || '';
  file.scheduleUpdatedByName = userName(req);
  job.updatedAt = nowIso();

  const designChanged = designBefore !== file.designDueDate;
  const factoryChanged = factoryBefore !== file.factoryAvailableDate || noteBefore !== file.factoryScheduleNote;
  const urgentChanged = urgentBefore !== !!file.urgent;
  const negotiationChanged = negotiationBefore !== file.scheduleNegotiation;
  const designAssignee = safeText(job.stageChecks?.design?.assignee, 80);
  const factoryAssignee = safeText(job.stageChecks?.factory?.assignee, 80);
  const messageParts = [];
  if (urgentChanged) messageParts.push(file.urgent ? '긴급 요청' : '긴급 해제');
  if (designChanged) messageParts.push(`희망일 ${file.designDueDate || '미정'}`);
  if (factoryChanged || negotiationChanged) messageParts.push(`공장 ${SCHEDULE_NEGOTIATION_LABELS[file.scheduleNegotiation || 'pending'] || '일정확인'} · 가능일 ${file.factoryAvailableDate || '미정'}${isFileScheduleLate(file) ? ' · 가능일 지연' : ''}${file.factoryScheduleNote ? ' - ' + file.factoryScheduleNote : ''}`);
  addEvent(data, req, job.id, 'file_schedule', `${file.originalName} 일정 협의 · ${messageParts.join(' · ') || '일정 확인'}`, {
    fileId: file.id,
    designDueDate: file.designDueDate,
    factoryAvailableDate: file.factoryAvailableDate,
    eventTargetLabel: factoryChanged ? designAssignee : factoryAssignee,
    targetStageIds: factoryChanged ? ['design'] : ['factory'],
  });
  saveStore(data);
  res.json({ ok: true, file: decorateWorkflowFile(file, req.user, job), job: decorateJob(data, job, req.user) });
});

// 공장 팀 분배(전상현 실장) — 시안 파일을 용접팀/출력팀으로 배정. 디자인은 팀 구분 모름.
router.post('/jobs/:id/files/:fileId/team', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  const file = data.files.find(f => f.jobId === req.params.id && f.id === req.params.fileId);
  if (!job || !file) return res.status(404).json({ error: '작업 또는 파일을 찾을 수 없습니다.' });
  if (job.status === 'done' || job.status === 'cancelled') return res.status(400).json({ error: '완료/취소된 작업은 변경할 수 없습니다.' });
  // 디자인팀은 팀을 모름 — 시안 팀배정은 공장 부서(전상현 실장)·관리자만. 생성자 우회 없음.
  if (!(isWorkflowAdmin(req) || isStageDeptLeader(req, 'factory'))) return res.status(403).json({ error: '시안 용접/출력 배정은 대림컴퍼니 팀장(또는 관리자)만 가능합니다.' });
  const team = ['welding', 'output', ''].includes(req.body.team) ? req.body.team : '';
  file.team = team;
  file.teamUpdatedAt = nowIso();
  file.teamUpdatedBy = req.user?.userId || '';
  file.teamUpdatedByName = userName(req);
  job.updatedAt = nowIso();
  const label = team === 'welding' ? '용접팀' : team === 'output' ? '출력팀' : '미배정';
  addEvent(data, req, job.id, 'update', `${file.originalName} → ${label} 배정`, { fileId: file.id, team });
  saveStore(data);
  res.json({ ok: true, file: decorateWorkflowFile(file, req.user, job), job: decorateJob(data, job, req.user) });
});

router.post('/jobs/:id/files/:fileId/events', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  const file = data.files.find(f => f.jobId === req.params.id && f.id === req.params.fileId);
  if (!job || !file) return res.status(404).json({ error: '작업 또는 파일을 찾을 수 없습니다.' });
  // 파일 코멘트 작성도 관리자·생성자·이 발주의 어느 단계든 담당 부서만. 무관한 직원의 기록 추가 차단.
  if (!(isWorkflowAdmin(req) || isJobCreator(job, req) || STAGES.some(s => canDeptActOnStage(req, s.id)))) return res.status(403).json({ error: WF_NO_PERM });
  const message = safeText(req.body.message, 3000);
  if (!message) return res.status(400).json({ error: '내용이 필요합니다.' });
  const targetUserId = safeText(req.body.targetUserId, 80);
  const targetUserName = safeText(req.body.targetUserName, 80);
  const targetLabel = safeText(req.body.targetLabel, 120) || targetUserName || file.targetLabel || '';
  const event = addEvent(data, req, job.id, 'file_comment', `${file.originalName}: ${message}`, {
    fileId: file.id,
    eventTargetUserId: targetUserId,
    eventTargetUserName: targetUserName,
    eventTargetLabel: targetLabel,
    targetStageIds: targetUserId || targetUserName ? [] : (fileTargetStageIds(file).length ? fileTargetStageIds(file) : targetLabelStageIds(targetLabel, job)),
  });
  job.updatedAt = nowIso();
  saveStore(data);
  res.json({ ok: true, event: decorateWorkflowEvent(event, req.user, job) });
});

router.get('/jobs/:id/files/archive', async (req, res) => {
  try {
    const data = loadStore();
    const job = data.jobs.find(j => j.id === req.params.id);
    if (!job) return res.status(404).send('not found');
    const filters = archiveFilters(req.query);
    const archive = await buildJobArchive(data, job, filters);
    if (!archive) return res.status(404).send('no files');
    // ZIP 생성(await) 동안의 다른 변경을 덮어쓰지 않도록 최신 스토어에 이벤트만 기록 (감사 #1 critical)
    const fresh = loadStore();
    addEvent(fresh, req, job.id, 'archive', `파일 묶음 다운로드 ${archive.files.length}개`, { ...filters, count: archive.files.length });
    saveStore(fresh);
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', attachmentDisposition(archive.filename));
    res.setHeader('Cache-Control', 'private, max-age=60');
    res.send(archive.buffer);
  } catch (e) {
    // 용량 상한(413) 등 — 핸들 안 하면 unhandled rejection. 메모리 OOM은 buildArchiveFromFiles에서 이미 사전 차단.
    res.status(e && e.statusCode === 413 ? 413 : 500).send(e && e.statusCode === 413 ? String(e.message) : '아카이브 생성 실패');
  }
});

router.get('/files/:fileId/download', (req, res) => {
  const data = loadStore();
  const file = data.files.find(f => f.id === req.params.fileId);
  if (!file) return res.status(404).send('not found');
  // 강화된 sendWorkflowFile 경유 — nosniff + 스크립터블(SVG/HTML/XML) 강등 일괄 적용(저장형 XSS 차단).
  if (!sendWorkflowFile(res, file, false)) return res.status(404).send('not found');
});

router.get('/files/:fileId/thumb', async (req, res, next) => {
  try {
    const data = loadStore();
    const file = data.files.find(f => f.id === req.params.fileId);
    if (!file || !isImageFile(file)) return res.status(404).send('not found');
    if (!await sendWorkflowThumb(res, file)) return res.status(404).send('not found');
  } catch (e) {
    next(e);
  }
});

router.get('/files/:fileId/preview', (req, res) => {
  const data = loadStore();
  const file = data.files.find(f => f.id === req.params.fileId);
  if (!file || !isImageFile(file)) return res.status(404).send('not found');
  // 인증 preview도 공개 경로와 동일하게 sendWorkflowFile 경유 — SVG 등 스크립터블은 inline 대신 attachment+octet-stream으로 강등(저장형 XSS 차단), nosniff 포함.
  if (!sendWorkflowFile(res, file, true)) return res.status(404).send('not found');
});

module.exports = router;
