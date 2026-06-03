const express = require('express');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
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

function safeDate(v) {
  const s = safeText(v, 30);
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : '';
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
  const event = {
    id: makeId('evt'),
    jobId,
    type,
    message: safeText(message, 3000),
    meta,
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

function isTargetViewer(file, viewerUser) {
  const viewerId = String(viewerUser?.userId || '').trim().toLowerCase();
  const viewerName = String(viewerUser?.name || '').trim().toLowerCase();
  const targetUserId = String(file?.targetUserId || '').trim().toLowerCase();
  const targetUserName = String(file?.targetUserName || '').trim().toLowerCase();
  const targetLabel = String(file?.targetLabel || '').trim().toLowerCase();
  const hasTarget = !!(targetUserId || targetUserName || targetLabel);
  if (!hasTarget) return true;
  if (targetUserId && viewerId && targetUserId === viewerId) return true;
  if (targetUserName && viewerName && targetUserName === viewerName) return true;
  if (targetLabel && viewerName && targetLabel.includes(viewerName)) return true;
  if (targetLabel && viewerId && targetLabel.includes(viewerId)) return true;
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

function isOverdueJob(job) {
  if (!job || job.status === 'done' || job.status === 'cancelled' || !job.dueDate) return false;
  return isPastDue(job.dueDate);
}

function isPastDue(dateValue) {
  if (!dateValue) return false;
  const today = new Date().toISOString().slice(0, 10);
  return String(dateValue) < today;
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
  return {
    ...job,
    fileCount: files.length,
    unreadFileCount: files.filter(f => isUnreadForViewer(f, viewerUser)).length,
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
    const stageId = STAGES.some(s => s.id === job.currentStage) ? job.currentStage : 'design';
    byStage[stageId] = (byStage[stageId] || 0) + 1;
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
  res.json({
    ok: true,
    job: decorateJob(data, job, req.user),
    files: data.files
      .filter(f => f.jobId === job.id)
      .map(f => ({ ...f, viewerUnread: isUnreadForViewer(f, req.user) })),
    events: data.events.filter(e => e.jobId === job.id),
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
    job.currentStage = inferCurrentStage(job.stageChecks, job.currentStage);
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
  job.currentStage = inferCurrentStage(job.stageChecks, job.currentStage);
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
  const currentId = STAGES.some(s => s.id === job.currentStage)
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

  if (next) {
    const nextCheck = job.stageChecks[next.id];
    if (nextCheck.status === 'pending') nextCheck.status = 'ready';
    nextCheck.updatedAt = at;
    job.currentStage = next.id;
    if (job.status === 'hold') job.status = 'active';
    addEvent(data, req, job.id, 'handoff', `${current.label} 완료 · ${next.label} 전달${message ? ' - ' + message : ''}`, {
      fromStageId: current.id,
      toStageId: next.id,
    });
  } else {
    job.currentStage = current.id;
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
  const event = addEvent(data, req, job.id, 'comment', message);
  job.updatedAt = nowIso();
  saveStore(data);
  res.json({ ok: true, event });
});

router.get('/jobs/:id/files', (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  res.json({
    ok: true,
    files: data.files
      .filter(f => f.jobId === job.id)
      .map(f => ({ ...f, viewerUnread: isUnreadForViewer(f, req.user) })),
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
  const targetLabel = safeText(req.body.targetLabel, 120) || targetUserName || stageAssignee;
  const uploaded = [];
  for (const file of req.files || []) {
    const originalName = uploadName(file.originalname || file.filename);
    const version = data.files.filter(f => f.jobId === job.id && f.stageId === stageId && f.originalName === originalName).length + 1;
    const rec = {
      id: makeId('wff'),
      jobId: job.id,
      stageId,
      kind,
      version,
      originalName,
      storedName: file.filename,
      mime: file.mimetype || 'application/octet-stream',
      size: file.size || 0,
      note: safeText(req.body.note, 1000),
      targetUserId,
      targetUserName,
      targetLabel,
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
    files: uploaded.map(f => ({ ...f, viewerUnread: false })),
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
  res.json({ ok: true, file });
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
  res.json({ ok: true, file: { ...file, viewerUnread: isUnreadForViewer(file, req.user) } });
});

router.get('/files/:fileId/download', (req, res) => {
  const data = loadStore();
  const file = data.files.find(f => f.id === req.params.fileId);
  if (!file) return res.status(404).send('not found');
  const full = path.join(FILE_DIR, file.storedName);
  if (!fs.existsSync(full)) return res.status(404).send('not found');
  res.setHeader('Content-Type', file.mime || 'application/octet-stream');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(file.originalName || 'file')}`);
  res.sendFile(full);
});

module.exports = router;
