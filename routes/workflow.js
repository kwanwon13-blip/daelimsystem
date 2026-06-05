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
let sharp;
try { sharp = require('sharp'); } catch (_) {}
const { sendSmtpMail, normalizeEmailList } = mailRoute;

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'workflow.json');
const FILE_DIR = path.join(DATA_DIR, 'workflow-files');
const THUMB_DIR = path.join(DATA_DIR, 'workflow-thumbs');
const MAX_WORKFLOW_UPLOAD_FILES = 20;
const MAX_WORKFLOW_UPLOAD_FILE_SIZE = 100 * 1024 * 1024;
const MAX_WORKFLOW_MAIL_ATTACH_BYTES = 24 * 1024 * 1024;

const STAGES = [
  { id: 'design', label: '디자인팀', icon: 'design_services' },
  { id: 'management', label: '관리팀', icon: 'rule_settings' },
  { id: 'factory', label: '공장', icon: 'precision_manufacturing' },
  { id: 'delivery', label: '납품팀', icon: 'local_shipping' },
];

const STAGE_CHECKLISTS = {
  design: ['시안 파일 정리', '승인/수정요청 확인'],
  management: ['일정 확인', '발주/관리 전달 확인'],
  factory: ['제작 사양 확인', '제작 완료 확인'],
  delivery: ['납품 일정 확인', '납품 완료 확인'],
};

const DESIGN_PARALLEL_STAGE_IDS = ['management', 'factory'];

const STAGE_DEPARTMENT_ALIASES = {
  design: ['디자인팀', '디자인'],
  management: ['경영관리팀', '관리팀', '관리'],
  factory: ['공장', '공장팀', '생산팀'],
  delivery: ['납품팀', '납품'],
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
    if (!label || !email) continue;
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
  requested: '발주요청',
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
    if (ensurePublicTokens(data)) saveStore(data);
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

function fileDiskPath(file) {
  const raw = String(file?.storedPath || file?.storedName || '');
  const candidates = [];
  if (raw) {
    if (path.isAbsolute(raw)) {
      candidates.push(raw);
    } else {
      candidates.push(path.resolve(FILE_DIR, raw.replace(/\\/g, '/')));
    }
  }
  if (file?.storagePath) {
    if (file.storedName) candidates.push(path.join(file.storagePath, file.storedName));
    if (file.originalName) candidates.push(path.join(file.storagePath, safeFilePart(file.originalName, file.storedName || file.id || 'file')));
  }
  if (file?.storageRoot === 'design' && file?.storageBucket) {
    const designRoot = path.resolve(designModule.getDesignRoot ? designModule.getDesignRoot() : 'D:\\');
    if (file.storedName) candidates.push(path.resolve(designRoot, file.storageBucket, file.storedName));
    if (file.originalName) candidates.push(path.resolve(designRoot, file.storageBucket, safeFilePart(file.originalName, file.storedName || file.id || 'file')));
  }
  let firstAllowed = null;
  for (const candidate of candidates) {
    const allowed = allowedWorkflowFilePath(candidate);
    if (!allowed) continue;
    if (!firstAllowed) firstAllowed = allowed;
    if (fs.existsSync(allowed)) return allowed;
  }
  return firstAllowed;
}

function workflowFileExists(file) {
  const full = fileDiskPath(file);
  return !!(full && fs.existsSync(full));
}

function fileExt(file) {
  return path.extname(String(file?.originalName || file?.storedName || '')).toLowerCase();
}

function isImageFile(file) {
  const mime = String(file?.mime || '').toLowerCase();
  if (mime.startsWith('image/')) return true;
  return ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'].includes(fileExt(file));
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
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
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

function publicWorkflowBaseUrl() {
  return envPublicWorkflowBaseUrl() || storedPublicWorkflowBaseUrl();
}

function resolveWorkflowDesignStorage(companyName, projectName, year, create = true) {
  if (!designModule.resolveWorkflowStorage) return null;
  return designModule.resolveWorkflowStorage({
    companyName,
    projectName,
    year,
    create,
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
  if (!job.companyName || !job.projectName) {
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
  let parallelActivated = false;
  let deliveryActivated = false;

  if (job.stageChecks.design?.status === 'done') {
    for (const stageId of DESIGN_PARALLEL_STAGE_IDS) {
      parallelActivated = setStageReady(job, stageId, at) || parallelActivated;
    }
  }

  const managementDone = job.stageChecks.management?.status === 'done';
  const factoryDone = job.stageChecks.factory?.status === 'done';
  if (managementDone && factoryDone) {
    deliveryActivated = setStageReady(job, 'delivery', at) || deliveryActivated;
  }

  job.currentStage = inferCurrentStage(job.stageChecks, job.currentStage || 'design');
  return { parallelActivated, deliveryActivated };
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
    return job.stageChecks?.[stageId]?.assignee || stage?.label || stageId;
  }));
}

function defaultUploadTargetLabels(job, stageId, kind) {
  if (stageId === 'design' && ['proof', 'drawing', 'photo'].includes(kind || '')) {
    return stageTargetLabels(job, DESIGN_PARALLEL_STAGE_IDS);
  }
  return stageTargetLabels(job, [stageId]);
}

function stageStatusNotifyTargets(job, stageId, status) {
  if (!job || !stageId) return [];
  if (status === 'blocked') {
    if (stageId === 'design') return ['management'];
    if (stageId === 'management') return ['design'];
    return ['design', 'management'];
  }
  if (status === 'done') {
    if (stageId === 'design') return DESIGN_PARALLEL_STAGE_IDS;
    if (stageId === 'management' || stageId === 'factory') {
      const otherStageId = stageId === 'management' ? 'factory' : 'management';
      if (job.stageChecks?.[otherStageId]?.status === 'done') return ['delivery'];
      return [otherStageId];
    }
    return [];
  }
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

let orgCache = { at: 0, data: { users: [], departments: [] } };

function loadOrgSnapshot() {
  const now = Date.now();
  if (now - orgCache.at < 1500) return orgCache.data;
  try {
    const data = db.loadUsers ? db.loadUsers() : db.조직관리.load();
    orgCache = {
      at: now,
      data: {
        users: Array.isArray(data.users) ? data.users : [],
        departments: Array.isArray(data.departments) ? data.departments : [],
      },
    };
  } catch (_) {
    orgCache = { at: now, data: { users: [], departments: [] } };
  }
  return orgCache.data;
}

function lowerText(value) {
  return String(value || '').trim().toLowerCase();
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

function stageTargetTexts(job, stageId) {
  const stage = STAGES.find(s => s.id === stageId);
  const check = job?.stageChecks?.[stageId] || {};
  return uniqueTexts([
    stageId,
    stage?.label,
    check.assignee,
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
    .filter(stage => stageTargetTexts(job, stage.id).some(text => {
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
    if (targetLabels.some(label => textMatchesProfile(label, resolveWorkflowUser(user)))) addUser(user);
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

function decorateWorkflowFile(file, viewerUser, job = null) {
  const exists = workflowFileExists(file);
  const image = isImageFile(file);
  const publicDownloadUrl = exists && file.publicToken ? `/api/workflow/public/files/${encodeURIComponent(file.publicToken)}/download` : '';
  const publicPreviewUrl = exists && file.publicToken && image ? `/api/workflow/public/files/${encodeURIComponent(file.publicToken)}/preview` : '';
  const publicThumbUrl = exists && file.publicToken && image ? `/api/workflow/public/files/${encodeURIComponent(file.publicToken)}/thumb` : '';
  return {
    ...file,
    exists,
    missing: !exists,
    isImage: image,
    isAi: isAiFile(file),
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

function orderStatusFromResponse(responseStatus) {
  if (responseStatus === 'needs_change') return 'replied';
  return 'confirmed';
}

function orderTargetStageIds(order) {
  if (!order) return [];
  return order.targetType === 'internal' ? ['factory', 'management'] : ['management'];
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
  if (!shouldEvent) return true;
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
    eventTargetLabel: stageTargetLabels(job, ['design', 'management']).join(', '),
    targetStageIds: ['design', 'management'],
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
  };
}

function decorateOrder(data, job, order) {
  const files = orderFiles(data, order, job);
  const safeOrder = { ...(order || {}) };
  delete safeOrder.mailTo;
  delete safeOrder.mailCc;
  delete safeOrder.mailSubject;
  delete safeOrder.mailBody;
  return {
    ...safeOrder,
    fileCount: files.length,
    fileNames: files.map(f => f.originalName || f.storedName || f.id),
    statusLabel: ORDER_STATUS_LABELS[order.status] || order.status || '초안',
    targetTypeLabel: order.targetType === 'external' ? '외주/업체' : '우리공장',
    deliveryMethod: order.deliveryMethod || (order.targetType === 'external' ? 'email' : 'download'),
    deliveryMethodLabel: ORDER_DELIVERY_METHOD_LABELS[order.deliveryMethod || (order.targetType === 'external' ? 'email' : 'download')] || 'ERP 다운로드',
    responseStatusLabel: ORDER_RESPONSE_LABELS[order.responseStatus] || '',
    publicViewUrl: order.publicToken ? `/workflow/order/${encodeURIComponent(order.publicToken)}` : '',
    publicArchiveUrl: order.publicToken ? `/api/workflow/public/orders/${encodeURIComponent(order.publicToken)}/files.zip` : '',
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
  const settingsPath = path.join(DATA_DIR, 'settings.json');
  if (!fs.existsSync(settingsPath)) return null;
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
  const smtp = settings.smtp || {};
  if (!smtp.user || !smtp.pass) return null;
  return {
    host: smtp.host || 'smtp.naver.com',
    port: Number(smtp.port) || 465,
    user: smtp.user || '',
    pass: smtp.pass || '',
    from: smtp.from || smtp.user || '',
  };
}

function absoluteWorkflowOrderUrl(order, req = null) {
  if (!order?.publicToken) return '';
  const relative = `/workflow/order/${encodeURIComponent(order.publicToken)}`;
  let base = publicWorkflowBaseUrl();
  if (!base && req) {
    const proto = safeText(req.headers['x-forwarded-proto'] || req.protocol || 'http', 20).split(',')[0];
    const host = safeText(req.headers['x-forwarded-host'] || req.get?.('host') || req.headers.host || '', 200).split(',')[0];
    base = host ? normalizePublicBaseUrl(`${proto}://${host}`) : '';
  }
  return base ? `${base}${relative}` : relative;
}

function defaultWorkflowOrderMailSubject(job, order) {
  const project = job.projectName || job.title || '';
  return `[제작요청] ${job.companyName || '프로젝트'}${project ? ' - ' + project : ''} / ${order.targetName || '업체'}`;
}

function buildWorkflowOrderMailHtml(job, order, files, message, publicUrl) {
  const project = job.projectName || job.title || '';
  const rows = [
    ['회사', job.companyName || '-'],
    ['프로젝트/현장', project || '-'],
    ['희망 납기', order.dueDate || '협의'],
    ['파일', `${files.length}건`],
  ];
  const memo = message || order.note || '제작 가능 여부와 납기 확인 부탁드립니다.';
  return `<!doctype html><html><body style="margin:0;padding:0;font-family:'Malgun Gothic','맑은 고딕',Arial,sans-serif;color:#222;">
    <div style="font-size:14px;line-height:1.8;">
      <p style="margin:0 0 14px;">${escapeHtml(order.targetName || '담당자')} 담당자님,</p>
      <p style="margin:0 0 16px;">${escapeHtml(memo).replace(/\n/g, '<br>')}</p>
      <table style="border-collapse:collapse;margin:0 0 16px;font-size:13px;">
        ${rows.map(([k, v]) => `<tr><th style="text-align:left;background:#f3f4f6;border:1px solid #d1d5db;padding:6px 10px;">${escapeHtml(k)}</th><td style="border:1px solid #d1d5db;padding:6px 10px;">${escapeHtml(v)}</td></tr>`).join('')}
      </table>
      ${publicUrl ? `<p style="margin:0 0 14px;">ERP 확인/다운로드: <a href="${escapeHtml(publicUrl)}">${escapeHtml(publicUrl)}</a></p>` : ''}
      <p style="margin:0;">확인 후 회신 부탁드립니다.</p>
    </div>
  </body></html>`;
}

function workflowOrderMailAttachments(files, attachFiles) {
  if (!attachFiles) return { attachments: [], totalBytes: 0, skipped: files.length };
  const attachments = [];
  let totalBytes = 0;
  for (const file of files) {
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
        label: `${stage.label} 마감`,
        dueDate: check.dueDate,
        stageId: stage.id,
        stageLabel: stage.label,
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
    stageLabel: first.stage.label,
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

function completionBlockers(data, job) {
  const blockers = [];
  const pendingStages = pendingStageCount(job);
  const pendingChecklist = pendingChecklistCount(job);
  const blockedStages = blockedStageCount(job);
  const pendingReviews = pendingReviewCount(data, job);
  const changeRequests = changeRequestCount(data, job);
  const orderChangeRequests = orderChangeRequestCount(data, job);
  const pendingOrders = pendingOrderCount(data, job);
  if (pendingStages) blockers.push({ key: 'pendingStages', label: '미완료 단계', count: pendingStages });
  if (pendingChecklist) blockers.push({ key: 'pendingChecklist', label: '미완료 체크', count: pendingChecklist });
  if (blockedStages) blockers.push({ key: 'blockedStages', label: '막힘 단계', count: blockedStages });
  if (pendingReviews) blockers.push({ key: 'pendingReviews', label: '검토대기 파일', count: pendingReviews });
  if (changeRequests) blockers.push({ key: 'changeRequests', label: '수정/조정요청 파일', count: changeRequests });
  if (orderChangeRequests) blockers.push({ key: 'orderChangeRequests', label: '전달 조정요청', count: orderChangeRequests });
  if (pendingOrders) blockers.push({ key: 'pendingOrders', label: '미확정 전달', count: pendingOrders });
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

function decorateJob(data, job, viewerUser = null) {
  const files = data.files.filter(f => f.jobId === job.id);
  const events = data.events.filter(e => e.jobId === job.id);
  const orderSummary = buildOrderSummary(data, job);
  const blockers = completionBlockers(data, job);
  const storedArchiveCount = Number(job.archiveFileCount);
  const archiveFileCount = Number.isFinite(storedArchiveCount) ? storedArchiveCount : files.length;
  const visualFiles = files.filter(f => isImageFile(f) && workflowFileExists(f));
  const primaryVisualFile = visualFiles
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  return {
    ...job,
    fileCount: files.length,
    orderCount: orderSummary.total,
    activeOrderCount: orderSummary.active,
    externalOrderCount: orderSummary.external,
    visualFileCount: visualFiles.length,
    urgentFileCount: files.filter(f => f.urgent && (!f.scheduleNegotiation || f.scheduleNegotiation === 'pending' || f.scheduleNegotiation === 'needs_change')).length,
    archiveUrl: `/api/workflow/jobs/${encodeURIComponent(job.id)}/files/archive`,
    publicArchiveUrl: job.publicToken ? `/api/workflow/public/jobs/${encodeURIComponent(job.publicToken)}/files.zip` : '',
    archiveFileCount,
    archiveStatus: job.archiveStatus || (job.status === 'done' ? 'ready' : ''),
    archiveUpdatedAt: job.archiveUpdatedAt || job.completedAt || '',
    archiveStorageBucket: job.archiveStorageBucket || job.storageBucket || '',
    primaryVisualFile: primaryVisualFile ? {
      id: primaryVisualFile.id,
      originalName: primaryVisualFile.originalName || '',
      previewUrl: `/api/workflow/files/${encodeURIComponent(primaryVisualFile.id)}/preview`,
      thumbUrl: `/api/workflow/files/${encodeURIComponent(primaryVisualFile.id)}/thumb`,
      publicPreviewUrl: primaryVisualFile.publicToken ? `/api/workflow/public/files/${encodeURIComponent(primaryVisualFile.publicToken)}/preview` : '',
      publicThumbUrl: primaryVisualFile.publicToken ? `/api/workflow/public/files/${encodeURIComponent(primaryVisualFile.publicToken)}/thumb` : '',
      publicDownloadUrl: primaryVisualFile.publicToken ? `/api/workflow/public/files/${encodeURIComponent(primaryVisualFile.publicToken)}/download` : '',
      designDueDate: primaryVisualFile.designDueDate || '',
      factoryAvailableDate: primaryVisualFile.factoryAvailableDate || '',
      urgent: !!primaryVisualFile.urgent,
      scheduleNegotiation: primaryVisualFile.scheduleNegotiation || 'pending',
    } : null,
    unreadFileCount: files.filter(f => isUnreadForViewer(f, viewerUser, job)).length,
    activeStageIds: activeStageIds(job),
    pendingStageCount: pendingStageCount(job),
    pendingChecklistCount: pendingChecklistCount(job),
    pendingReviewCount: pendingReviewCount(data, job),
    blockedStageCount: blockedStageCount(job),
    overdueStageCount: overdueStageCount(job),
    changeRequestCount: changeRequestCount(data, job),
    canComplete: blockers.length === 0,
    completionBlockers: blockers,
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
  const byStage = {};
  for (const stage of STAGES) byStage[stage.id] = 0;
  for (const job of activeJobs) {
    for (const stageId of activeStageIds(job)) {
      byStage[stageId] = (byStage[stageId] || 0) + 1;
    }
  }
  const unreadFiles = data.files
    .filter(f => isUnreadForViewer(f, req.user, data.jobs.find(j => j.id === f.jobId)))
    .map(file => {
      const job = data.jobs.find(j => j.id === file.jobId);
      return {
        id: file.id,
        jobId: file.jobId,
        jobTitle: job?.title || '',
        stageId: file.stageId,
        stageLabel: STAGES.find(s => s.id === file.stageId)?.label || file.stageId,
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
    .filter(e => isUnreadEventForViewer(e, req.user, data.jobs.find(j => j.id === e.jobId)))
    .map(event => {
      const job = data.jobs.find(j => j.id === event.jobId);
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
      const job = data.jobs.find(j => j.id === f.jobId);
      if (!job || ['done', 'cancelled'].includes(job.status || 'active')) return false;
      if (isWorkflowAdmin(req)) return true;
      return isTargetViewer(f, req.user, job) || isUserJob(job, req);
    })
    .map(file => {
      const job = data.jobs.find(j => j.id === file.jobId);
      return {
        id: file.id,
        jobId: file.jobId,
        jobTitle: job?.title || '',
        stageId: file.stageId,
        stageLabel: STAGES.find(s => s.id === file.stageId)?.label || file.stageId,
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
      const stage = STAGES.find(s => s.id === job.currentStage) || STAGES[0] || { id: 'design', label: '디자인' };
      const check = job.stageChecks?.[stage.id] || {};
      const blockers = completionBlockers(data, job);
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
        stageLabel: stage.label || stage.id,
        assignee: check.assignee || '',
        dueDate,
        overdue: !!(isOverdueJob(job) || overdueStageCount(job) > 0 || stageOverdue),
        blockedStageCount: blockedStageCount(job),
        changeRequestCount: changeRequestCount(data, job),
        completionBlockerCount: blockers.length,
        latestFileAt: data.files
          .filter(f => f.jobId === job.id)
          .reduce((max, f) => !max || f.createdAt > max ? f.createdAt : max, ''),
        updatedAt: job.updatedAt || job.createdAt || '',
      };
    })
    .sort((a, b) => {
      if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
      const ad = a.dueDate || '9999-99-99';
      const bd = b.dueDate || '9999-99-99';
      const byDue = String(ad).localeCompare(String(bd));
      if (byDue !== 0) return byDue;
      return String(b.updatedAt || b.latestFileAt || '').localeCompare(String(a.updatedAt || a.latestFileAt || ''));
    })
    .slice(0, 8);
  const changeRequests = activeJobs.reduce((sum, job) => sum + changeRequestCount(data, job), 0);
  const readyToComplete = activeJobs.filter(job => completionBlockers(data, job).length === 0).length;
  const scheduleItems = buildScheduleItems(data, req);
  return {
    active: activeJobs.length,
    done: data.jobs.filter(j => j.status === 'done').length,
    readyToComplete,
    overdue: activeJobs.filter(job => isOverdueJob(job) || overdueStageCount(job) > 0).length,
    overdueStages: activeJobs.reduce((sum, job) => sum + overdueStageCount(job), 0),
    blocked: activeJobs.reduce((sum, job) => sum + blockedStageCount(job), 0),
    changeRequests,
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
    byStage,
  };
}

function uploadName(name) {
  const raw = String(name || 'file');
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
const upload = multer({ storage, limits: { fileSize: MAX_WORKFLOW_UPLOAD_FILE_SIZE, files: MAX_WORKFLOW_UPLOAD_FILES } });

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
    return res.status(400).json({ ok: false, error: `파일 업로드 처리에 실패했습니다: ${err.message || err}` });
  });
}

function archiveFilters(query = {}) {
  const stageId = STAGES.some(s => s.id === query.stageId) ? query.stageId : '';
  const kind = ['proof', 'attachment', 'drawing', 'photo'].includes(query.kind) ? query.kind : '';
  return { stageId, kind };
}

function jobArchiveFiles(data, job, filters = {}) {
  const { stageId = '', kind = '' } = filters;
  return data.files
    .filter(f => f.jobId === job.id)
    .filter(f => !stageId || f.stageId === stageId)
    .filter(f => !kind || (f.kind || 'attachment') === kind)
    .filter(f => {
      const full = fileDiskPath(f);
      return !!(full && fs.existsSync(full));
    });
}

async function buildArchiveFromFiles(job, files, filters = {}, suffix = 'all') {
  if (!files.length) return null;

  const zip = new JSZip();
  const used = new Set();
  const root = safeFilePart(`${job.companyName || 'workflow'}_${job.projectName || ''}_${job.title || job.id}`, job.id);
  for (const file of files) {
    const stage = safeFilePart(file.stageId || 'stage');
    const fileKind = safeFilePart(file.kind || 'attachment');
    const original = safeFilePart(file.originalName || file.storedName || file.id, file.id);
    const version = Number(file.version || 1);
    const zipPath = uniqueZipPath(used, `${root}/${stage}/${fileKind}/v${version}_${original}`);
    zip.file(zipPath, fs.readFileSync(fileDiskPath(file)));
  }
  zip.file(`${root}/_manifest.json`, JSON.stringify({
    job: {
      id: job.id,
      title: job.title,
      companyName: job.companyName || '',
      projectName: job.projectName || '',
      currentStage: job.currentStage || '',
    },
    filters,
    files: files.map(f => ({
      id: f.id,
      stageId: f.stageId,
      kind: f.kind || 'attachment',
      version: f.version || 1,
      originalName: f.originalName,
      uploadedByName: f.uploadedByName,
      targetLabel: f.targetLabel || '',
      reviewStatus: f.reviewStatus || 'pending',
      reviewNote: f.reviewNote || '',
      createdAt: f.createdAt,
    })),
    generatedAt: nowIso(),
  }, null, 2));

  const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const filename = safeFilePart(`${job.companyName || 'workflow'}_${job.projectName || job.title || job.id}_${suffix}`) + '.zip';
  return { buffer, filename, files };
}

async function buildJobArchive(data, job, filters = {}) {
  const { stageId = '', kind = '' } = filters;
  const files = jobArchiveFiles(data, job, filters);
  const suffix = [stageId, kind].filter(Boolean).join('_') || 'all';
  return buildArchiveFromFiles(job, files, { stageId, kind }, suffix);
}

function completeWorkflowJob(data, req, job, at = nowIso()) {
  const firstComplete = !job.completedAt;
  const files = jobArchiveFiles(data, job, {});
  job.status = 'done';
  job.completedAt = job.completedAt || at;
  job.completedBy = job.completedBy || req.user?.userId || '';
  job.completedByName = job.completedByName || userName(req);
  job.archiveStatus = 'ready';
  job.archiveUpdatedAt = at;
  job.archiveFileCount = files.length;
  job.archiveStorageBucket = job.storageBucket || '';
  job.currentStage = 'delivery';
  if (firstComplete) {
    addEvent(data, req, job.id, 'complete', '완료 보관함 저장', {
      archiveFileCount: files.length,
      archiveStorageBucket: job.archiveStorageBucket,
    });
  }
  return files.length;
}

function clearWorkflowCompletion(job) {
  job.completedAt = '';
  job.completedBy = '';
  job.completedByName = '';
  job.archiveStatus = '';
  job.archiveUpdatedAt = '';
  job.archiveFileCount = 0;
  job.archiveStorageBucket = '';
}

function sendWorkflowFile(res, file, inline = false, publicCache = false) {
  const full = fileDiskPath(file);
  if (!full || !fs.existsSync(full)) return false;
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', inline ? 'inline' : attachmentDisposition(file.originalName || 'file'));
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
      // Fall back below for small images.
    }
  }
  try {
    const stat = fs.statSync(full);
    if (stat.size > 5 * 1024 * 1024) {
      res.status(204).end();
      return true;
    }
  } catch (_) {}
  res.type(file.mime || 'image/jpeg').sendFile(full);
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
  if (!sendWorkflowFile(res, file, true, true)) return res.status(404).send('not found');
});

router.get('/public/files/:token/thumb', async (req, res, next) => {
  try {
    const data = loadStore();
    const token = safeText(req.params.token, 120);
    const file = data.files.find(f => String(f.publicToken || '') === token);
    if (!file || !isImageFile(file)) return res.status(404).send('not found');
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
    const files = orderFiles(data, order, job);
    const archive = await buildArchiveFromFiles(job, files, { orderId: order.id, targetName: order.targetName || '' }, `order_${safeFilePart(order.targetName || order.id)}`);
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
  if (!order) return res.status(404).json({ error: '발주를 찾을 수 없습니다.' });
  const job = data.jobs.find(j => j.id === order.jobId);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  markPublicOrderActivity(data, job, order, 'view');
  saveStore(data);
  res.json(decoratePublicOrder(data, job, order));
});

router.post('/public/orders/:token/reply', (req, res) => {
  const data = loadStore();
  const token = safeText(req.params.token, 120);
  const order = (data.orders || []).find(o => String(o.publicToken || '') === token);
  if (!order) return res.status(404).json({ error: '발주를 찾을 수 없습니다.' });
  const job = data.jobs.find(j => j.id === order.jobId);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });

  const response = normalizeOrderResponse(req.body || {});
  const files = orderFiles(data, order, job);
  const fileResponses = normalizePublicFileResponses(req.body?.fileResponses, files, response);
  const aggregateStatus = aggregateFileResponses(fileResponses, response);
  response.responseStatus = aggregateStatus;
  Object.assign(order, response, {
    status: orderStatusFromResponse(response.responseStatus),
    respondedAt: nowIso(),
    updatedAt: nowIso(),
  });
  applyOrderResponseToFiles(files, response, fileResponses);
  job.updatedAt = nowIso();

  const label = ORDER_RESPONSE_LABELS[response.responseStatus] || response.responseStatus;
  const by = response.respondedByName || order.targetName || '외부 회신';
  const dateText = response.responseAvailableDate ? ` · 가능일 ${response.responseAvailableDate}` : '';
  const noteText = response.responseNote ? ` · ${response.responseNote}` : '';
  const fileText = fileResponses.length ? ` · 파일별 일정 ${fileResponses.length}건` : '';
  addEvent(data, { user: { userId: 'public-order', name: by } }, job.id, 'order_public_reply', `발주 회신 · ${order.targetName} · ${label}${dateText}${noteText}${fileText}`, {
    orderId: order.id,
    targetName: order.targetName,
    responseStatus: response.responseStatus,
    responseAvailableDate: response.responseAvailableDate,
    responseNote: response.responseNote,
    fileResponses,
    eventTargetUserId: job.createdBy || '',
    eventTargetUserName: job.createdByName || '',
    eventTargetLabel: stageTargetLabels(job, ['design', 'management']).join(', '),
    targetStageIds: ['design', 'management'],
  });
  saveStore(data);
  res.json(decoratePublicOrder(data, job, order));
});

router.use(requireAuth);

router.get('/meta', (req, res) => {
  res.json({
    ok: true,
    stages: STAGES,
    statuses: STATUS_LABELS,
    checkStatuses: CHECK_STATUS_LABELS,
    orderTargets: buildWorkflowOrderTargets(),
    orderStatuses: ORDER_STATUS_LABELS,
    publicBaseUrl: publicWorkflowBaseUrl(),
    uploadLimits: {
      files: MAX_WORKFLOW_UPLOAD_FILES,
      fileSize: MAX_WORKFLOW_UPLOAD_FILE_SIZE,
    },
  });
});

router.get('/settings/public-link', (req, res) => {
  const envUrl = envPublicWorkflowBaseUrl();
  const storedUrl = storedPublicWorkflowBaseUrl();
  res.json({
    ok: true,
    publicBaseUrl: envUrl || storedUrl,
    configuredBaseUrl: storedUrl,
    source: envUrl ? 'env' : (storedUrl ? 'settings' : ''),
    envLocked: !!envUrl,
  });
});

router.post('/settings/public-link', requireAdmin, (req, res) => {
  const url = normalizePublicBaseUrl(req.body?.publicBaseUrl || req.body?.url || '');
  if (req.body?.publicBaseUrl || req.body?.url) {
    if (!url) return res.status(400).json({ ok: false, error: 'http 또는 https 주소를 입력해주세요.' });
  }
  const settings = db['설정'].load();
  if (!settings.workflow || typeof settings.workflow !== 'object') settings.workflow = {};
  settings.workflow.publicBaseUrl = url;
  db['설정'].save(settings);
  res.json({
    ok: true,
    publicBaseUrl: publicWorkflowBaseUrl(),
    configuredBaseUrl: url,
    source: envPublicWorkflowBaseUrl() ? 'env' : (url ? 'settings' : ''),
    envLocked: !!envPublicWorkflowBaseUrl(),
  });
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

router.get('/jobs', (req, res) => {
  const data = loadStore();
  const q = safeText(req.query.q, 100).toLowerCase();
  const status = safeText(req.query.status, 30);
  const scope = safeText(req.query.scope, 30) || 'all';
  let jobs = data.jobs.slice();
  if (status && status !== 'all') jobs = jobs.filter(j => j.status === status);
  if (q) {
    jobs = jobs.filter(j => workflowJobSearchText(data, j).includes(q));
  }
  if (scope === 'mine') {
    jobs = jobs.filter(j => isUserJob(j, req));
  } else if (scope === 'unread') {
    jobs = jobs.filter(j => decorateJob(data, j, req.user).unreadFileCount > 0);
  } else if (scope === 'risk') {
    jobs = jobs.filter(j => isOverdueJob(j) || overdueStageCount(j) > 0 || blockedStageCount(j) > 0 || changeRequestCount(data, j) > 0);
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
  res.json({ ok: true, jobs: jobs.map(job => decorateJob(data, job, req.user)) });
});

router.get('/jobs/:id', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  const files = data.files
    .filter(f => f.jobId === job.id)
    .map(f => decorateWorkflowFile(f, req.user, job));
  res.json({
    ok: true,
    job: decorateJob(data, job, req.user),
    files,
    orders: (data.orders || []).filter(o => o.jobId === job.id).map(o => decorateOrder(data, job, o)),
    orderSummary: buildOrderSummary(data, job),
    deliverySummary: buildDeliverySummary(files, req.user, job),
    events: data.events.filter(e => e.jobId === job.id).map(e => decorateWorkflowEvent(e, req.user, job)),
  });
});

router.post('/jobs', (req, res) => {
  const data = loadStore();
  const payload = normalizeJobPayload(req.body || {});
  if (!payload.title) {
    payload.title = payload.projectName || (payload.companyName ? `${payload.companyName} 작업` : '워크플로우 작업');
  }
  const job = {
    id: makeId('wf'),
    publicToken: makeUniquePublicToken(data),
    ...payload,
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
  upsertWorkflowProject(data, { ...job, status: 'active', year: job.storageYear || String(job.dueDate || '').slice(0, 4) }, req, storageInfo);
  job.stageChecks.design.status = 'ready';
  job.stageChecks.design.updatedAt = job.updatedAt;
  data.jobs.push(job);
  addEvent(data, req, job.id, 'create', '작업 생성', { title: job.title });
  saveStore(data);
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

router.put('/jobs/:id', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  const payload = normalizeJobPayload(req.body || {}, job);
  const at = nowIso();
  if (payload.status === 'done') {
    const nextJob = { ...job, ...payload };
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
    for (const stage of STAGES) {
      if (job.stageChecks[stage.id].status !== 'done') {
        job.stageChecks[stage.id].status = 'done';
        job.stageChecks[stage.id].completedAt = job.stageChecks[stage.id].completedAt || at;
      }
    }
    completeWorkflowJob(data, req, job, at);
  } else {
    clearWorkflowCompletion(job);
    syncWorkflowStageFlow(job);
  }
  addEvent(data, req, job.id, 'update', storageResult.changed ? '작업 정보 수정 · 저장 폴더 자동 준비' : '작업 정보 수정');
  saveStore(data);
  res.json({ ok: true, job: decorateJob(data, job, req.user) });
});

router.post('/jobs/:id/stages/:stageId', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  const stage = STAGES.find(s => s.id === req.params.stageId);
  if (!job || !stage) return res.status(404).json({ error: '작업 또는 단계를 찾을 수 없습니다.' });
  job.stageChecks = newStageChecks(job.stageChecks || {});
  const check = job.stageChecks[stage.id];
  const previousStatus = check.status || 'pending';
  const nextStatus = ['pending', 'ready', 'done', 'blocked'].includes(req.body.status) ? req.body.status : check.status;
  const at = nowIso();
  check.status = nextStatus;
  check.assignee = safeText(req.body.assignee, 80);
  check.dueDate = safeDate(req.body.dueDate);
  check.note = safeText(req.body.note, 1000);
  check.checklist = normalizeChecklist(stage.id, req.body.checklist);
  check.updatedAt = at;
  if (nextStatus === 'done') check.completedAt = check.completedAt || at;
  if (nextStatus !== 'done') check.completedAt = '';
  syncWorkflowStageFlow(job);
  const allStagesDone = Object.values(job.stageChecks).every(c => c.status === 'done');
  const blockers = completionBlockers(data, job);
  job.status = allStagesDone && blockers.length === 0 ? 'done' : (job.status === 'done' ? 'active' : job.status);
  job.updatedAt = at;
  if (job.status === 'done') {
    completeWorkflowJob(data, req, job, at);
  } else {
    clearWorkflowCompletion(job);
  }
  const targetStageIds = previousStatus !== nextStatus ? stageStatusNotifyTargets(job, stage.id, nextStatus) : [];
  addEvent(data, req, job.id, 'stage', `${stage.label} ${CHECK_STATUS_LABELS[nextStatus] || nextStatus}`, {
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
  const message = safeText(req.body.message, 1000);
  const at = nowIso();

  const currentCheck = job.stageChecks[current.id];
  currentCheck.status = 'done';
  currentCheck.completedAt = currentCheck.completedAt || at;
  currentCheck.updatedAt = at;
  if (message) currentCheck.note = currentCheck.note ? `${currentCheck.note}\n${message}` : message;

  const flow = syncWorkflowStageFlow(job, at);
  if (job.status === 'hold') job.status = 'active';

  if (current.id === 'design') {
    const targetLabels = stageTargetLabels(job, DESIGN_PARALLEL_STAGE_IDS);
    addEvent(data, req, job.id, 'handoff', `${current.label} 완료 · 관리팀/공장 동시 전달${message ? ' - ' + message : ''}`, {
      fromStageId: current.id,
      toStageId: DESIGN_PARALLEL_STAGE_IDS.join(','),
      eventTargetLabel: targetLabels.join(', '),
      targetStageIds: DESIGN_PARALLEL_STAGE_IDS,
    });
  } else if (current.id === 'management' || current.id === 'factory') {
    const otherStageId = current.id === 'management' ? 'factory' : 'management';
    const other = STAGES.find(s => s.id === otherStageId);
    if (flow.deliveryActivated) {
      const deliveryCheck = job.stageChecks.delivery || {};
      addEvent(data, req, job.id, 'handoff', `${current.label} 완료 · 납품팀 전달${message ? ' - ' + message : ''}`, {
        fromStageId: current.id,
        toStageId: 'delivery',
        eventTargetLabel: deliveryCheck.assignee || '',
        targetStageIds: ['delivery'],
      });
    } else {
      addEvent(data, req, job.id, 'handoff', `${current.label} 완료 · ${other?.label || otherStageId} 진행 대기${message ? ' - ' + message : ''}`, {
        fromStageId: current.id,
        toStageId: otherStageId,
        eventTargetLabel: job.stageChecks[otherStageId]?.assignee || '',
        targetStageIds: [otherStageId],
      });
    }
  } else if (next) {
    const nextCheck = job.stageChecks[next.id];
    if (nextCheck.status === 'pending') nextCheck.status = 'ready';
    nextCheck.updatedAt = at;
    syncWorkflowStageFlow(job, at);
    addEvent(data, req, job.id, 'handoff', `${current.label} 완료 · ${next.label} 전달${message ? ' - ' + message : ''}`, {
      fromStageId: current.id,
      toStageId: next.id,
      eventTargetLabel: nextCheck.assignee || '',
      targetStageIds: [next.id],
    });
  } else {
    const blockers = completionBlockers(data, job);
    if (blockers.length) {
      return res.status(400).json({
        error: '완료 전 확인할 항목이 남아 있습니다.',
        blockers,
      });
    }
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

router.post('/jobs/:id/events', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
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
  if (markEventReadBy(event, req)) {
    addEvent(data, req, event.jobId, 'event_read', `${event.message || '기록'} 확인`, { eventId: event.id });
    saveStore(data);
  }
  res.json({ ok: true, event: decorateWorkflowEvent(event, req.user, job) });
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
  job.updatedAt = nowIso();
  const targetStageIds = orderTargetStageIds(order);
  addEvent(data, req, job.id, 'order', `제작 파일 전달 생성 · ${order.targetName} · 파일 ${order.fileIds.length}건`, {
    orderId: order.id,
    targetName: order.targetName,
    targetType: order.targetType,
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
  });
});

router.put('/jobs/:id/orders/:orderId', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  const order = (data.orders || []).find(o => o.jobId === req.params.id && o.id === req.params.orderId);
  if (!job || !order) return res.status(404).json({ error: '작업 또는 발주를 찾을 수 없습니다.' });
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
  job.updatedAt = nowIso();
  addEvent(data, req, job.id, 'order_update', `제작 파일 전달 ${ORDER_STATUS_LABELS[order.status] || order.status} · ${order.targetName}`, {
    orderId: order.id,
    targetName: order.targetName,
    status: order.status,
    previousStatus: beforeStatus,
  });
  saveStore(data);
  res.json({
    ok: true,
    order: decorateOrder(data, job, order),
    orders: data.orders.filter(o => o.jobId === job.id).map(o => decorateOrder(data, job, o)),
    orderSummary: buildOrderSummary(data, job),
    job: decorateJob(data, job, req.user),
  });
});

router.post('/jobs/:id/orders/:orderId/email', async (req, res) => {
  try {
    const data = loadStore();
    const job = data.jobs.find(j => j.id === req.params.id);
    const order = (data.orders || []).find(o => o.jobId === req.params.id && o.id === req.params.orderId);
    if (!job || !order) return res.status(404).json({ error: '작업 또는 전달건을 찾을 수 없습니다.' });

    const toList = normalizeEmailList(req.body?.toEmail || req.body?.recipientEmail || order.recipientEmail || order.mailTo || '');
    const ccList = normalizeEmailList(req.body?.ccEmail || req.body?.recipientCc || order.recipientCc || order.mailCc || '');
    if (!toList.length) return res.status(400).json({ error: '수신 이메일이 필요합니다.' });

    const smtp = loadWorkflowSmtpSettings();
    if (!smtp) return res.status(400).json({ error: 'SMTP 설정이 완료되지 않았습니다.' });

    const files = orderFiles(data, order, job);
    if (!files.length) return res.status(400).json({ error: '발송할 파일이 없습니다.' });

    const attachFiles = req.body?.attachFiles !== false;
    const mailFiles = workflowOrderMailAttachments(files, attachFiles);
    if (mailFiles.tooLarge) {
      return res.status(413).json({
        error: `첨부 용량이 ${Math.round(mailFiles.totalBytes / 1024 / 1024)}MB입니다. 메일 첨부는 ${Math.round(MAX_WORKFLOW_MAIL_ATTACH_BYTES / 1024 / 1024)}MB 이하일 때만 발송합니다.`,
        publicUrl: absoluteWorkflowOrderUrl(order, req),
      });
    }

    const subject = safeText(req.body?.subject, 240) || defaultWorkflowOrderMailSubject(job, order);
    const message = safeText(req.body?.message, 3000);
    const publicUrl = absoluteWorkflowOrderUrl(order, req);
    const html = buildWorkflowOrderMailHtml(job, order, files, message, publicUrl);

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

    const sentAt = nowIso();
    order.deliveryMethod = 'email';
    order.mailStatus = 'sent';
    order.mailSentAt = sentAt;
    order.mailSentBy = req.user?.userId || '';
    order.mailSentByName = userName(req);
    order.mailTo = toList.join(', ');
    order.mailCc = ccList.join(', ');
    order.recipientEmail = toList.join(', ');
    order.recipientCc = ccList.join(', ');
    order.mailSubject = subject;
    if (!Array.isArray(order.mailHistory)) order.mailHistory = [];
    order.mailHistory.push({
      to: toList,
      cc: ccList,
      subject,
      sentAt,
      sentBy: req.user?.userId || '',
      sentByName: userName(req),
      fileCount: files.length,
      attachedCount: mailFiles.attachments.length,
      publicUrl,
    });
    if (['draft', 'requested'].includes(order.status || 'draft')) order.status = 'sent';
    order.updatedAt = sentAt;
    order.updatedBy = req.user?.userId || '';
    order.updatedByName = userName(req);
    job.updatedAt = sentAt;

    addEvent(data, req, job.id, 'order_email', `제작 파일 메일 발송 · ${order.targetName} · ${toList.join(', ')}`, {
      orderId: order.id,
      targetName: order.targetName,
      to: toList,
      cc: ccList,
      fileCount: files.length,
      attachedCount: mailFiles.attachments.length,
      publicUrl,
      targetStageIds: ['management'],
      eventTargetLabel: stageTargetLabels(job, ['management']).join(', '),
    });
    saveStore(data);
    res.json({
      ok: true,
      order: decorateOrder(data, job, order),
      orders: data.orders.filter(o => o.jobId === job.id).map(o => decorateOrder(data, job, o)),
      orderSummary: buildOrderSummary(data, job),
      job: decorateJob(data, job, req.user),
      message: `${toList.join(', ')}로 발송 완료`,
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
      ? (requestedTargetStageIds.length ? requestedTargetStageIds : DESIGN_PARALLEL_STAGE_IDS)
      : requestedTargetStageIds;
  const targetLabels = targetUserId || targetUserName
    ? uniqueTexts([requestedTargetLabel || targetUserName || targetUserId])
    : isDesignAsset
      ? (splitTargetLabels(requestedTargetLabel).length > 1 ? splitTargetLabels(requestedTargetLabel) : autoTargetLabels)
      : (requestedTargetLabel ? uniqueTexts([requestedTargetLabel]) : autoTargetLabels);
  const targetLabel = targetLabels.join(', ') || targetUserName || stageAssignee;
  const storageYear = safeYear(req.body.storageYear || safeDate(req.body.designDueDate).slice(0, 4));
  const storageCompanyName = bodyText(req.body, 'storageCompanyName', 120) || safeText(job.companyName, 120);
  const storageProjectName = bodyText(req.body, 'storageProjectName', 160) || safeText(job.projectName || job.title, 160);
  if (!storageCompanyName || !storageProjectName) {
    for (const file of req.files || []) {
      try { fs.unlinkSync(path.join(FILE_DIR, file.filename)); } catch (_) {}
    }
    return res.status(400).json({ error: '회사와 프로젝트를 먼저 선택해주세요.' });
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
      if (fs.existsSync(from)) {
        fs.renameSync(from, target.fullPath);
        if (!fs.existsSync(target.fullPath)) throw new Error('file move failed');
        storedName = target.fileName;
        movedFiles.push(target.fullPath);
        storedPath = actualStorageInfo ? target.fullPath : `${actualStorageRelDir}/${target.fileName}`;
      }
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
  res.json({
    ok: true,
    files: uploaded.map(f => decorateWorkflowFile(f, req.user, job)),
    job: decorateJob(data, job, req.user),
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
  const managementAssignee = safeText(job.stageChecks?.management?.assignee, 80);
  const factoryAssignee = safeText(job.stageChecks?.factory?.assignee, 80);
  const messageParts = [];
  if (urgentChanged) messageParts.push(file.urgent ? '긴급 요청' : '긴급 해제');
  if (designChanged) messageParts.push(`희망일 ${file.designDueDate || '미정'}`);
  if (factoryChanged || negotiationChanged) messageParts.push(`공장 ${SCHEDULE_NEGOTIATION_LABELS[file.scheduleNegotiation || 'pending'] || '일정확인'} · 가능일 ${file.factoryAvailableDate || '미정'}${file.factoryScheduleNote ? ' - ' + file.factoryScheduleNote : ''}`);
  addEvent(data, req, job.id, 'file_schedule', `${file.originalName} 일정 협의 · ${messageParts.join(' · ') || '일정 확인'}`, {
    fileId: file.id,
    designDueDate: file.designDueDate,
    factoryAvailableDate: file.factoryAvailableDate,
    eventTargetLabel: factoryChanged ? uniqueTexts([designAssignee, managementAssignee]).join(', ') : factoryAssignee,
    targetStageIds: factoryChanged ? ['design', 'management'] : ['factory'],
  });
  saveStore(data);
  res.json({ ok: true, file: decorateWorkflowFile(file, req.user, job), job: decorateJob(data, job, req.user) });
});

router.post('/jobs/:id/files/:fileId/events', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  const file = data.files.find(f => f.jobId === req.params.id && f.id === req.params.fileId);
  if (!job || !file) return res.status(404).json({ error: '작업 또는 파일을 찾을 수 없습니다.' });
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
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).send('not found');
  const filters = archiveFilters(req.query);
  const archive = await buildJobArchive(data, job, filters);
  if (!archive) return res.status(404).send('no files');
  addEvent(data, req, job.id, 'archive', `파일 묶음 다운로드 ${archive.files.length}개`, { ...filters, count: archive.files.length });
  saveStore(data);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', attachmentDisposition(archive.filename));
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(archive.buffer);
});

router.get('/files/:fileId/download', (req, res) => {
  const data = loadStore();
  const file = data.files.find(f => f.id === req.params.fileId);
  if (!file) return res.status(404).send('not found');
  const full = fileDiskPath(file);
  if (!full || !fs.existsSync(full)) return res.status(404).send('not found');
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', attachmentDisposition(file.originalName || 'file'));
  res.sendFile(full);
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
  const full = fileDiskPath(file);
  if (!full || !fs.existsSync(full)) return res.status(404).send('not found');
  res.setHeader('Content-Type', file.mime || 'image/jpeg');
  res.setHeader('Content-Disposition', 'inline');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.sendFile(full);
});

module.exports = router;
