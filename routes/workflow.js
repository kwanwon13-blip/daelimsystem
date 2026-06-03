const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const JSZip = require('jszip');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const DATA_DIR = path.join(__dirname, '..', 'data');
const STORE_PATH = path.join(DATA_DIR, 'workflow.json');
const FILE_DIR = path.join(DATA_DIR, 'workflow-files');

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

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(FILE_DIR)) fs.mkdirSync(FILE_DIR, { recursive: true });
}

function emptyStore() {
  return { jobs: [], events: [], files: [] };
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

function safeText(v, max = 500) {
  return String(v == null ? '' : v).trim().slice(0, max);
}

function safeFilePart(value, fallback = 'file') {
  const cleaned = String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
  return cleaned || fallback;
}

function fileDiskPath(file) {
  const rel = String(file?.storedPath || file?.storedName || '').replace(/\\/g, '/');
  if (!rel) return null;
  const root = path.resolve(FILE_DIR);
  const full = path.resolve(FILE_DIR, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return full;
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

function fileTargetLabels(file) {
  const labels = Array.isArray(file?.targetLabels) ? file.targetLabels : [];
  if (labels.length) return uniqueTexts(labels);
  return uniqueTexts([file?.targetLabel, file?.targetUserName, file?.targetUserId]);
}

function splitTargetLabels(label) {
  return uniqueTexts(String(label || '').split(/[,\u00b7/]+/));
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
  return !!(
    String(event?.targetUserId || '').trim()
    || String(event?.targetUserName || '').trim()
    || String(event?.targetLabel || '').trim()
  );
}

function isEventTargetViewer(event, viewerUser) {
  const viewerId = String(viewerUser?.userId || '').trim().toLowerCase();
  const viewerName = String(viewerUser?.name || '').trim().toLowerCase();
  const targetUserId = String(event?.targetUserId || '').trim().toLowerCase();
  const targetUserName = String(event?.targetUserName || '').trim().toLowerCase();
  const targetLabel = String(event?.targetLabel || '').trim().toLowerCase();
  if (!hasEventTarget(event)) return false;
  if (targetUserId && viewerId && targetUserId === viewerId) return true;
  if (targetUserName && viewerName && targetUserName === viewerName) return true;
  if (targetLabel && viewerName && targetLabel.includes(viewerName)) return true;
  if (targetLabel && viewerId && targetLabel.includes(viewerId)) return true;
  return false;
}

function isUnreadEventForViewer(event, viewerUser) {
  const userId = String(viewerUser?.userId || '');
  if (!event || !userId) return false;
  if (String(event.actorId || '') === userId) return false;
  if (!isEventTargetViewer(event, viewerUser)) return false;
  const readBy = Array.isArray(event.readBy) ? event.readBy : [];
  return !readBy.some(r => String(r.userId || '') === userId);
}

function hasEventTargetRead(event) {
  const readBy = Array.isArray(event?.readBy) ? event.readBy : [];
  if (!hasEventTarget(event) || !readBy.length) return false;
  const targetUserId = String(event.targetUserId || '').trim().toLowerCase();
  const targetUserName = String(event.targetUserName || '').trim().toLowerCase();
  const targetLabel = String(event.targetLabel || '').trim().toLowerCase();
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

function decorateWorkflowEvent(event, viewerUser) {
  return {
    ...event,
    hasTarget: hasEventTarget(event),
    targetRead: hasEventTargetRead(event),
    viewerUnread: isUnreadEventForViewer(event, viewerUser),
  };
}

function isTargetViewer(file, viewerUser) {
  const viewerId = String(viewerUser?.userId || '').trim().toLowerCase();
  const viewerName = String(viewerUser?.name || '').trim().toLowerCase();
  const targetUserId = String(file?.targetUserId || '').trim().toLowerCase();
  const targetUserName = String(file?.targetUserName || '').trim().toLowerCase();
  const targetLabel = String(file?.targetLabel || '').trim().toLowerCase();
  const targetLabels = fileTargetLabels(file).map(v => String(v || '').trim().toLowerCase());
  const hasTarget = !!(targetUserId || targetUserName || targetLabel || targetLabels.length);
  if (!hasTarget) return true;
  if (targetUserId && viewerId && targetUserId === viewerId) return true;
  if (targetUserName && viewerName && targetUserName === viewerName) return true;
  if (targetLabel && viewerName && targetLabel.includes(viewerName)) return true;
  if (targetLabel && viewerId && targetLabel.includes(viewerId)) return true;
  if (targetLabels.some(label => viewerName && label.includes(viewerName))) return true;
  if (targetLabels.some(label => viewerId && label.includes(viewerId))) return true;
  return false;
}

function isUnreadForViewer(file, viewerUser) {
  const userId = String(viewerUser?.userId || '');
  if (!file || !userId) return false;
  if (String(file.uploadedBy || '') === userId) return false;
  if (!isTargetViewer(file, viewerUser)) return false;
  const readBy = Array.isArray(file.readBy) ? file.readBy : [];
  return !readBy.some(r => String(r.userId || '') === userId);
}

function hasFileTarget(file) {
  if (fileTargetLabels(file).length) return true;
  return !!(
    String(file?.targetUserId || '').trim()
    || String(file?.targetUserName || '').trim()
    || String(file?.targetLabel || '').trim()
  );
}

function readMatchesTarget(readBy, target) {
  const needle = String(target || '').trim().toLowerCase();
  if (!needle) return false;
  return (Array.isArray(readBy) ? readBy : []).some(r => {
    const userId = String(r.userId || '').trim().toLowerCase();
    const name = String(r.name || '').trim().toLowerCase();
    return (userId && needle.includes(userId)) || (name && needle.includes(name));
  });
}

function hasTargetRead(file) {
  const readBy = Array.isArray(file?.readBy) ? file.readBy : [];
  if (!hasFileTarget(file) || !readBy.length) return false;
  const targetLabels = fileTargetLabels(file);
  if (targetLabels.length > 1) {
    return targetLabels.every(label => readMatchesTarget(readBy, label));
  }
  const targetUserId = String(file.targetUserId || '').trim().toLowerCase();
  const targetUserName = String(file.targetUserName || '').trim().toLowerCase();
  const targetLabel = String(file.targetLabel || '').trim().toLowerCase();
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

function decorateWorkflowFile(file, viewerUser) {
  return {
    ...file,
    isImage: isImageFile(file),
    isAi: isAiFile(file),
    previewUrl: isImageFile(file) ? `/api/workflow/files/${encodeURIComponent(file.id)}/preview` : '',
    downloadUrl: `/api/workflow/files/${encodeURIComponent(file.id)}/download`,
    viewerUnread: isUnreadForViewer(file, viewerUser),
    hasTarget: hasFileTarget(file),
    targetRead: hasTargetRead(file),
  };
}

function isReviewableFile(file) {
  return ['proof', 'drawing'].includes(file?.kind || 'attachment');
}

function fileTargetDisplay(file) {
  const labels = fileTargetLabels(file);
  return labels.length ? labels.join(', ') : String(file?.targetLabel || file?.targetUserName || file?.targetUserId || '').trim();
}

function buildDeliverySummary(files, viewerUser) {
  const list = Array.isArray(files) ? files : [];
  const targetFiles = list.filter(hasFileTarget);
  const pendingTargetFiles = targetFiles.filter(f => !hasTargetRead(f));
  const reviewableFiles = list.filter(isReviewableFile);
  const pendingTargetLabels = Array.from(new Set(pendingTargetFiles.map(fileTargetDisplay).filter(Boolean)));
  return {
    totalFiles: list.length,
    targetedFiles: targetFiles.length,
    targetPendingFiles: pendingTargetFiles.length,
    targetReadFiles: Math.max(0, targetFiles.length - pendingTargetFiles.length),
    unreadForViewer: list.filter(f => Object.prototype.hasOwnProperty.call(f, 'viewerUnread') ? f.viewerUnread : isUnreadForViewer(f, viewerUser)).length,
    reviewableFiles: reviewableFiles.length,
    pendingReviews: reviewableFiles.filter(f => !f.reviewStatus || f.reviewStatus === 'pending').length,
    approvedReviews: reviewableFiles.filter(f => f.reviewStatus === 'approved').length,
    changeRequests: reviewableFiles.filter(f => f.reviewStatus === 'change_requested').length,
    pendingTargets: pendingTargetLabels.slice(0, 8),
    pendingTargetOverflow: Math.max(0, pendingTargetLabels.length - 8),
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
  return data.files.filter(f => f.jobId === job.id && f.reviewStatus === 'change_requested').length;
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

function completionBlockers(data, job) {
  const blockers = [];
  const pendingStages = pendingStageCount(job);
  const pendingChecklist = pendingChecklistCount(job);
  const blockedStages = blockedStageCount(job);
  const pendingReviews = pendingReviewCount(data, job);
  const changeRequests = changeRequestCount(data, job);
  if (pendingStages) blockers.push({ key: 'pendingStages', label: '미완료 단계', count: pendingStages });
  if (pendingChecklist) blockers.push({ key: 'pendingChecklist', label: '미완료 체크', count: pendingChecklist });
  if (blockedStages) blockers.push({ key: 'blockedStages', label: '막힘 단계', count: blockedStages });
  if (pendingReviews) blockers.push({ key: 'pendingReviews', label: '검토대기 파일', count: pendingReviews });
  if (changeRequests) blockers.push({ key: 'changeRequests', label: '수정요청 파일', count: changeRequests });
  return blockers;
}

function userMatchTokens(req) {
  return [req.user?.userId, req.user?.name]
    .map(v => String(v || '').trim().toLowerCase())
    .filter(Boolean);
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
  return Object.values(job.stageChecks || {}).some(check => {
    if (!check || check.status === 'done') return false;
    return textMatchesToken(check.assignee, tokens);
  });
}

function decorateJob(data, job, viewerUser = null) {
  const files = data.files.filter(f => f.jobId === job.id);
  const events = data.events.filter(e => e.jobId === job.id);
  const blockers = completionBlockers(data, job);
  const primaryVisualFile = files
    .filter(isImageFile)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
  return {
    ...job,
    fileCount: files.length,
    visualFileCount: files.filter(isImageFile).length,
    urgentFileCount: files.filter(f => f.urgent && (!f.scheduleNegotiation || f.scheduleNegotiation === 'pending' || f.scheduleNegotiation === 'needs_change')).length,
    primaryVisualFile: primaryVisualFile ? {
      id: primaryVisualFile.id,
      originalName: primaryVisualFile.originalName || '',
      previewUrl: `/api/workflow/files/${encodeURIComponent(primaryVisualFile.id)}/preview`,
      designDueDate: primaryVisualFile.designDueDate || '',
      factoryAvailableDate: primaryVisualFile.factoryAvailableDate || '',
      urgent: !!primaryVisualFile.urgent,
      scheduleNegotiation: primaryVisualFile.scheduleNegotiation || 'pending',
    } : null,
    unreadFileCount: files.filter(f => isUnreadForViewer(f, viewerUser)).length,
    activeStageIds: activeStageIds(job),
    pendingStageCount: pendingStageCount(job),
    pendingChecklistCount: pendingChecklistCount(job),
    pendingReviewCount: pendingReviewCount(data, job),
    blockedStageCount: blockedStageCount(job),
    overdueStageCount: overdueStageCount(job),
    changeRequestCount: changeRequestCount(data, job),
    canComplete: blockers.length === 0,
    completionBlockers: blockers,
    overdue: isOverdueJob(job),
    nextStageDue: nextStageDue(job),
    latestFileAt: files.reduce((max, f) => !max || f.createdAt > max ? f.createdAt : max, ''),
    latestEvent: events[events.length - 1] || null,
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
    .filter(f => isUnreadForViewer(f, req.user))
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
    .filter(e => isUnreadEventForViewer(e, req.user))
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
const upload = multer({ storage, limits: { fileSize: 100 * 1024 * 1024, files: 20 } });

router.use(requireAuth);

router.get('/meta', (req, res) => {
  res.json({ ok: true, stages: STAGES, statuses: STATUS_LABELS, checkStatuses: CHECK_STATUS_LABELS });
});

router.get('/summary', (req, res) => {
  const data = loadStore();
  res.json({ ok: true, summary: buildSummary(data, req) });
});

router.get('/jobs', (req, res) => {
  const data = loadStore();
  const q = safeText(req.query.q, 100).toLowerCase();
  const status = safeText(req.query.status, 30);
  const scope = safeText(req.query.scope, 30) || 'all';
  let jobs = data.jobs.slice();
  if (status && status !== 'all') jobs = jobs.filter(j => j.status === status);
  if (q) {
    jobs = jobs.filter(j => [
      j.title, j.companyName, j.projectName, j.contactName, j.summary,
    ].join(' ').toLowerCase().includes(q));
  }
  if (scope === 'mine') {
    jobs = jobs.filter(j => isUserJob(j, req));
  } else if (scope === 'unread') {
    jobs = jobs.filter(j => decorateJob(data, j, req.user).unreadFileCount > 0);
  } else if (scope === 'risk') {
    jobs = jobs.filter(j => isOverdueJob(j) || overdueStageCount(j) > 0 || blockedStageCount(j) > 0 || changeRequestCount(data, j) > 0);
  }
  jobs.sort((a, b) => {
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
    .map(f => decorateWorkflowFile(f, req.user));
  res.json({
    ok: true,
    job: decorateJob(data, job, req.user),
    files,
    deliverySummary: buildDeliverySummary(files, req.user),
    events: data.events.filter(e => e.jobId === job.id).map(e => decorateWorkflowEvent(e, req.user)),
  });
});

router.post('/jobs', (req, res) => {
  const data = loadStore();
  const payload = normalizeJobPayload(req.body || {});
  if (!payload.title) return res.status(400).json({ error: '작업명이 필요합니다.' });
  const job = {
    id: makeId('wf'),
    ...payload,
    stageChecks: newStageChecks(),
    currentStage: 'design',
    createdBy: req.user?.userId || '',
    createdByName: userName(req),
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
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
  Object.assign(job, payload, { updatedAt: nowIso() });
  if (job.status === 'done') {
    for (const stage of STAGES) {
      if (job.stageChecks[stage.id].status !== 'done') {
        job.stageChecks[stage.id].status = 'done';
        job.stageChecks[stage.id].completedAt = job.stageChecks[stage.id].completedAt || nowIso();
      }
    }
    job.currentStage = 'delivery';
  } else {
    syncWorkflowStageFlow(job);
  }
  addEvent(data, req, job.id, 'update', '작업 정보 수정');
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
  const nextStatus = ['pending', 'ready', 'done', 'blocked'].includes(req.body.status) ? req.body.status : check.status;
  check.status = nextStatus;
  check.assignee = safeText(req.body.assignee, 80);
  check.dueDate = safeDate(req.body.dueDate);
  check.note = safeText(req.body.note, 1000);
  check.checklist = normalizeChecklist(stage.id, req.body.checklist);
  check.updatedAt = nowIso();
  if (nextStatus === 'done') check.completedAt = check.completedAt || nowIso();
  if (nextStatus !== 'done') check.completedAt = '';
  syncWorkflowStageFlow(job);
  const allStagesDone = Object.values(job.stageChecks).every(c => c.status === 'done');
  const blockers = completionBlockers(data, job);
  job.status = allStagesDone && blockers.length === 0 ? 'done' : (job.status === 'done' ? 'active' : job.status);
  job.updatedAt = nowIso();
  addEvent(data, req, job.id, 'stage', `${stage.label} ${CHECK_STATUS_LABELS[nextStatus] || nextStatus}`, { stageId: stage.id, status: nextStatus });
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
      });
    } else {
      addEvent(data, req, job.id, 'handoff', `${current.label} 완료 · ${other?.label || otherStageId} 진행 대기${message ? ' - ' + message : ''}`, {
        fromStageId: current.id,
        toStageId: otherStageId,
        eventTargetLabel: job.stageChecks[otherStageId]?.assignee || '',
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
  res.json({ ok: true, event: decorateWorkflowEvent(event, req.user) });
});

router.post('/jobs/:id/events/:eventId/read', (req, res) => {
  const data = loadStore();
  const event = data.events.find(e => e.jobId === req.params.id && e.id === req.params.eventId);
  if (!event) return res.status(404).json({ error: '기록을 찾을 수 없습니다.' });
  if (markEventReadBy(event, req)) {
    addEvent(data, req, event.jobId, 'event_read', `${event.message || '기록'} 확인`, { eventId: event.id });
    saveStore(data);
  }
  res.json({ ok: true, event: decorateWorkflowEvent(event, req.user) });
});

router.get('/jobs/:id/files', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  const files = data.files
    .filter(f => f.jobId === job.id)
    .map(f => decorateWorkflowFile(f, req.user));
  res.json({
    ok: true,
    files,
    deliverySummary: buildDeliverySummary(files, req.user),
  });
});

router.post('/jobs/:id/files', upload.array('files', 20), (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  const stageId = STAGES.some(s => s.id === req.body.stageId) ? req.body.stageId : job.currentStage;
  const kind = ['proof', 'attachment', 'drawing', 'photo'].includes(req.body.kind) ? req.body.kind : 'attachment';
  const stageAssignee = safeText(job.stageChecks?.[stageId]?.assignee, 80);
  const targetUserId = safeText(req.body.targetUserId, 80);
  const targetUserName = safeText(req.body.targetUserName, 80);
  const requestedTargetLabel = safeText(req.body.targetLabel, 120);
  const autoTargetLabels = defaultUploadTargetLabels(job, stageId, kind);
  const isDesignAsset = stageId === 'design' && ['proof', 'drawing', 'photo'].includes(kind);
  const targetLabels = targetUserId || targetUserName
    ? uniqueTexts([requestedTargetLabel || targetUserName || targetUserId])
    : isDesignAsset
      ? (splitTargetLabels(requestedTargetLabel).length > 1 ? splitTargetLabels(requestedTargetLabel) : autoTargetLabels)
      : (requestedTargetLabel ? uniqueTexts([requestedTargetLabel]) : autoTargetLabels);
  const targetLabel = targetLabels.join(', ') || targetUserName || stageAssignee;
  const storageYear = safeYear(req.body.storageYear || safeDate(req.body.designDueDate).slice(0, 4));
  const storageCompanyName = safeText(req.body.storageCompanyName, 120) || safeText(job.companyName, 120) || '미지정업체';
  const storageProjectName = safeText(req.body.storageProjectName, 160) || safeText(job.projectName || job.title, 160) || '미지정프로젝트';
  const storageYearPart = safeFilePart(storageYear, String(new Date().getFullYear()));
  const storageCompanyPart = safeFilePart(storageCompanyName, '미지정업체');
  const storageProjectPart = safeFilePart(storageProjectName, '미지정프로젝트');
  const storageRelDir = `${storageYearPart}/${storageCompanyPart}/${storageProjectPart}`;
  const storageDir = path.join(FILE_DIR, storageYearPart, storageCompanyPart, storageProjectPart);
  const uploaded = [];
  for (const file of req.files || []) {
    const originalName = uploadName(file.originalname || file.filename);
    const version = data.files.filter(f => f.jobId === job.id && f.stageId === stageId && f.originalName === originalName).length + 1;
    let storedPath = file.filename;
    try {
      fs.mkdirSync(storageDir, { recursive: true });
      const from = path.join(FILE_DIR, file.filename);
      const to = path.join(storageDir, file.filename);
      if (fs.existsSync(from)) {
        fs.renameSync(from, to);
        storedPath = `${storageRelDir}/${file.filename}`;
      }
    } catch (e) {
      storedPath = file.filename;
    }
    const rec = {
      id: makeId('wff'),
      jobId: job.id,
      stageId,
      kind,
      version,
      originalName,
      storedName: file.filename,
      storedPath,
      mime: file.mimetype || 'application/octet-stream',
      size: file.size || 0,
      note: safeText(req.body.note, 1000),
      designDueDate: safeDate(req.body.designDueDate),
      urgent: String(req.body.urgent || '') === '1' || req.body.urgent === true,
      scheduleNegotiation: '',
      storageYear,
      storageCompanyName,
      storageProjectName,
      storageBucket: `${storageYearPart}/${storageCompanyPart}/${storageProjectPart}`,
      factoryAvailableDate: '',
      factoryScheduleNote: '',
      targetUserId,
      targetUserName,
      targetLabel,
      targetLabels,
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
    addEvent(data, req, job.id, 'file', `파일 ${uploaded.length}개 업로드${targetLabel ? ' · 확인 대상 ' + targetLabel : ''}`, {
      stageId,
      fileIds: uploaded.map(f => f.id),
      targetUserId,
      targetUserName,
      targetLabel,
    });
  }
  saveStore(data);
  res.json({
    ok: true,
    files: uploaded.map(f => decorateWorkflowFile(f, req.user)),
    job: decorateJob(data, job, req.user),
  });
});

router.post('/jobs/:id/files/:fileId/read', (req, res) => {
  const data = loadStore();
  const file = data.files.find(f => f.jobId === req.params.id && f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
  if (markFileReadBy(file, req)) {
    addEvent(data, req, file.jobId, 'read', `${file.originalName} 확인`, { fileId: file.id });
    saveStore(data);
  }
  res.json({ ok: true, file: decorateWorkflowFile(file, req.user) });
});

router.post('/jobs/:id/files/:fileId/review', (req, res) => {
  const data = loadStore();
  const file = data.files.find(f => f.jobId === req.params.id && f.id === req.params.fileId);
  if (!file) return res.status(404).json({ error: '파일을 찾을 수 없습니다.' });
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
  });
  saveStore(data);
  res.json({ ok: true, file: decorateWorkflowFile(file, req.user) });
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
  });
  saveStore(data);
  res.json({ ok: true, file: decorateWorkflowFile(file, req.user), job: decorateJob(data, job, req.user) });
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
  });
  job.updatedAt = nowIso();
  saveStore(data);
  res.json({ ok: true, event: decorateWorkflowEvent(event, req.user) });
});

router.get('/jobs/:id/files/archive', async (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).send('not found');
  const stageId = STAGES.some(s => s.id === req.query.stageId) ? req.query.stageId : '';
  const kind = ['proof', 'attachment', 'drawing', 'photo'].includes(req.query.kind) ? req.query.kind : '';
  const files = data.files
    .filter(f => f.jobId === job.id)
    .filter(f => !stageId || f.stageId === stageId)
    .filter(f => !kind || (f.kind || 'attachment') === kind)
    .filter(f => {
      const full = fileDiskPath(f);
      return !!(full && fs.existsSync(full));
    });
  if (!files.length) return res.status(404).send('no files');

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
    filters: { stageId, kind },
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
  const suffix = [stageId, kind].filter(Boolean).join('_') || 'all';
  const filename = safeFilePart(`${job.companyName || 'workflow'}_${job.projectName || job.title || job.id}_${suffix}`) + '.zip';
  addEvent(data, req, job.id, 'archive', `파일 묶음 다운로드 ${files.length}개`, { stageId, kind, count: files.length });
  saveStore(data);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', attachmentDisposition(filename));
  res.setHeader('Cache-Control', 'private, max-age=60');
  res.send(buffer);
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
