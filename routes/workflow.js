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

function newStageChecks(seed = {}) {
  const out = {};
  for (const stage of STAGES) {
    const prev = seed[stage.id] || {};
    out[stage.id] = {
      status: ['pending', 'ready', 'done', 'blocked'].includes(prev.status) ? prev.status : 'pending',
      assignee: safeText(prev.assignee, 80),
      dueDate: safeDate(prev.dueDate),
      note: safeText(prev.note, 1000),
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

function isUnreadForUser(file, userId) {
  if (!file || !userId) return false;
  if (String(file.uploadedBy || '') === String(userId)) return false;
  const readBy = Array.isArray(file.readBy) ? file.readBy : [];
  return !readBy.some(r => String(r.userId || '') === String(userId));
}

function isOverdueJob(job) {
  if (!job || job.status === 'done' || job.status === 'cancelled' || !job.dueDate) return false;
  const today = new Date().toISOString().slice(0, 10);
  return String(job.dueDate) < today;
}

function blockedStageCount(job) {
  return Object.values(job.stageChecks || {}).filter(c => c && c.status === 'blocked').length;
}

function decorateJob(data, job, viewerUser = null) {
  const files = data.files.filter(f => f.jobId === job.id);
  const events = data.events.filter(e => e.jobId === job.id);
  const viewerId = viewerUser?.userId || '';
  return {
    ...job,
    fileCount: files.length,
    unreadFileCount: files.filter(f => isUnreadForUser(f, viewerId)).length,
    blockedStageCount: blockedStageCount(job),
    overdue: isOverdueJob(job),
    latestFileAt: files.reduce((max, f) => !max || f.createdAt > max ? f.createdAt : max, ''),
    latestEvent: events[events.length - 1] || null,
  };
}

function buildSummary(data, req) {
  const userId = req.user?.userId || '';
  const userLabel = userName(req).toLowerCase();
  const activeJobs = data.jobs.filter(j => !['done', 'cancelled'].includes(j.status));
  const byStage = {};
  for (const stage of STAGES) byStage[stage.id] = 0;
  for (const job of activeJobs) {
    const stageId = STAGES.some(s => s.id === job.currentStage) ? job.currentStage : 'design';
    byStage[stageId] = (byStage[stageId] || 0) + 1;
  }
  const unreadFiles = data.files
    .filter(f => isUnreadForUser(f, userId))
    .map(file => {
      const job = data.jobs.find(j => j.id === file.jobId);
      return {
        id: file.id,
        jobId: file.jobId,
        jobTitle: job?.title || '',
        stageId: file.stageId,
        originalName: file.originalName,
        uploadedByName: file.uploadedByName,
        createdAt: file.createdAt,
      };
    })
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const myActionJobs = activeJobs.filter(job => {
    const stageCheck = job.stageChecks?.[job.currentStage] || {};
    const assignee = String(stageCheck.assignee || '').toLowerCase();
    return assignee && userLabel && assignee.includes(userLabel);
  });
  return {
    active: activeJobs.length,
    done: data.jobs.filter(j => j.status === 'done').length,
    overdue: activeJobs.filter(isOverdueJob).length,
    blocked: activeJobs.reduce((sum, job) => sum + blockedStageCount(job), 0),
    unreadFiles: unreadFiles.length,
    unreadFileItems: unreadFiles.slice(0, 8),
    myActions: myActionJobs.length,
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
  let jobs = data.jobs.slice();
  if (status && status !== 'all') jobs = jobs.filter(j => j.status === status);
  if (q) {
    jobs = jobs.filter(j => [
      j.title, j.companyName, j.projectName, j.contactName, j.summary,
    ].join(' ').toLowerCase().includes(q));
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
      .map(f => ({ ...f, viewerUnread: isUnreadForUser(f, req.user?.userId || '') })),
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
  check.updatedAt = nowIso();
  if (nextStatus === 'done') check.completedAt = check.completedAt || nowIso();
  if (nextStatus !== 'done') check.completedAt = '';
  job.currentStage = inferCurrentStage(job.stageChecks, job.currentStage);
  job.status = Object.values(job.stageChecks).every(c => c.status === 'done') ? 'done' : (job.status === 'done' ? 'active' : job.status);
  job.updatedAt = nowIso();
  addEvent(data, req, job.id, 'stage', `${stage.label} ${CHECK_STATUS_LABELS[nextStatus] || nextStatus}`, { stageId: stage.id, status: nextStatus });
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
      .map(f => ({ ...f, viewerUnread: isUnreadForUser(f, req.user?.userId || '') })),
  });
});

router.post('/jobs/:id/files', upload.array('files', 20), (req, res) => {
  const data = loadStore();
  const job = data.jobs.find(j => j.id === req.params.id);
  if (!job) return res.status(404).json({ error: '작업을 찾을 수 없습니다.' });
  const stageId = STAGES.some(s => s.id === req.body.stageId) ? req.body.stageId : job.currentStage;
  const kind = ['proof', 'attachment', 'drawing', 'photo'].includes(req.body.kind) ? req.body.kind : 'attachment';
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
    addEvent(data, req, job.id, 'file', `파일 ${uploaded.length}개 업로드`, { stageId, fileIds: uploaded.map(f => f.id) });
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
  if (!Array.isArray(file.readBy)) file.readBy = [];
  const readerId = req.user?.userId || '';
  if (!file.readBy.some(r => r.userId === readerId)) {
    file.readBy.push({ userId: readerId, name: userName(req), at: nowIso() });
    addEvent(data, req, file.jobId, 'read', `${file.originalName} 확인`, { fileId: file.id });
    saveStore(data);
  }
  res.json({ ok: true, file });
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
