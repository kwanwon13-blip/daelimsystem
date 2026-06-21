/**
 * routes/todos.js — 할일(TODO) : 메모식(2단) — 메모(제목) 안에 할 일 항목 + 직급별 보기 + AI 정리
 * 워크스페이스 라우터 밑에 마운트: /api/workspace/todos (server.js 무수정)
 *
 * 구조: 하루치 = 여러 '메모'(묶음). 메모 = { title, items:[{id,text,done}] }.
 *   - 메모를 누르면 안에 할 일들이 □ 박스로 펼쳐짐(엔터로 줄 추가, 체크로 취소선).
 * 보기 모델(직급 자동, 서버 판정 — 클라이언트 신뢰 안 함):
 *   - 직원      : 내 것만
 *   - 부서장    : 우리 부서원 전체 (조직관리의 부서 leaderId === 내 내부 user.id)
 *   - 대표/관리자: 회사 전체 (role==='admin')
 * 작성/수정/삭제는 본인 메모만(관리자 제외). 회사(companyId)로 에스엠/컴퍼니 분리.
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const claudeClient = require('../lib/claude-client');
const ai = require('../db-ai');                       // 첨부 저장/조회(ai_attachments) 재사용
const fileExtract = require('../lib/file-extract');   // 파일 추출/종류감지/OCR

// multer optional-require (미설치 시 첨부 라우트는 503 graceful)
let multer = null;
try { multer = require('multer'); } catch (_) { multer = null; }

// 업로드 화이트리스트 — 이미지/엑셀/PDF/텍스트만
const ATTACH_KINDS = ['image', 'excel', 'pdf', 'text'];
function isAllowedFile(mime, originalName) {
  const ext = path.extname(originalName || '').toLowerCase();
  return ATTACH_KINDS.includes(fileExtract.detectKind(mime, ext));
}

// multer 디스크 저장 (ai-history.js 패턴) — destination=ai.UPLOAD_DIR, 서버생성 stored_name
const _attStorage = multer ? multer.diskStorage({
  destination: (req, file, cb) => cb(null, ai.UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').slice(0, 10);
    const base = crypto.randomBytes(8).toString('hex');
    cb(null, `${Date.now()}_${base}${ext}`);
  }
}) : null;
function _fileFilter(req, file, cb) {
  if (isAllowedFile(file.mimetype, file.originalname)) return cb(null, true);
  cb(new Error('지원하지 않는 파일 형식입니다 (이미지·엑셀·PDF·텍스트만)'));
}
const uploadSingle = (multer && _attStorage)
  ? multer({ storage: _attStorage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: _fileFilter })
  : null;
const uploadMany = (multer && _attStorage)
  ? multer({ storage: _attStorage, limits: { fileSize: 10 * 1024 * 1024 }, fileFilter: _fileFilter })
  : null;

// 업로드된 파일 → kind별 텍스트 추출(있으면). 이미지는 OCR 안 함(여기선 빈 문자열, 호출부에서 처리).
async function extractByKind(kind, filePath, originalName) {
  try {
    if (kind === 'excel') return await fileExtract.extractExcel(filePath, originalName);
    if (kind === 'pdf') return await fileExtract.extractPdf(filePath);
    if (kind === 'text') return fileExtract.extractText(filePath);
  } catch (e) { return ''; }
  return '';
}

function todayKST() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
function nowISO() { return new Date().toISOString(); }
function load() { const d = db['할일'].load(); if (!Array.isArray(d.memos)) d.memos = []; return d; }
function newId(p) { return (p || 'memo') + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }
function clean(s, n) { return String(s == null ? '' : s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').trim().slice(0, n); }
function isDate(s) { return /^\d{4}-\d{2}-\d{2}$/.test(s || ''); }

// 항목 정규화 — id 유지(없으면 발급), 빈 줄은 버림.
//   detail(세부내역) + 전달 기록(source/assignedBy*/assignedAt) 보존, 완료 시 completedAt 기록.
function normItems(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.slice(0, 200).map(it => {
    const o = {
      id: clean(it && it.id, 40) || newId('item'),
      text: clean(it && it.text, 300),
      done: !!(it && it.done)
    };
    const detail = clean(it && it.detail, 2000); if (detail) o.detail = detail;
    if (it && it.source) o.source = clean(it.source, 20);
    if (it && it.assignedById) o.assignedById = clean(it.assignedById, 60);
    if (it && it.assignedByName) o.assignedByName = clean(it.assignedByName, 60);
    if (it && it.assignedAt) o.assignedAt = clean(it.assignedAt, 40);
    if (o.done) o.completedAt = clean(it && it.completedAt, 40) || nowISO();  // 완료 기록(있으면 유지)
    if (it && Array.isArray(it.attachmentIds)) {
      const ids = it.attachmentIds.map(n => parseInt(n, 10)).filter(n => Number.isInteger(n) && n > 0).slice(0, 12);
      if (ids.length) o.attachmentIds = ids;
    }
    return o;
  }).filter(it => it.text);
}

// 보기 권한 컨텍스트 (서버에서 직급 판정)
function viewerCtx(u) {
  const companyId = u.companyId || 'dalim-sm';
  const isAdmin = u.role === 'admin';
  let isLeader = false, ledDeptId = '';
  try {
    const org = db.loadUsers();
    const me = (org.users || []).find(x => x.userId === u.userId);
    if (me && me.department) {
      const dept = (org.departments || []).find(d => d.id === me.department);
      if (dept && dept.leaderId && dept.leaderId === me.id) { isLeader = true; ledDeptId = me.department; }
    }
  } catch (e) {}
  return { isAdmin, isLeader, ledDeptId, companyId };
}

// 범위 내 직원 명단(부서장=부서원, 관리자=전사) — 빈 사람도 보이게
function peopleInScope(v) {
  try {
    const org = db.loadUsers();
    const deptMap = {}; (org.departments || []).forEach(d => { if (d && d.id) deptMap[d.id] = d.name || ''; });
    let users = (org.users || []).filter(x => x.status === 'approved' && (x.companyId || 'dalim-sm') === v.companyId);
    if (!v.isAdmin) users = users.filter(x => x.department === v.ledDeptId);
    return users.map(x => ({ userId: x.userId, name: x.name || '', deptName: deptMap[x.department] || '' }));
  } catch (e) { return []; }
}

// 메모 → 클라이언트 안전 형태(내 것 여부 표시)
function shape(m, u) {
  return {
    id: m.id, ownerId: m.ownerId, ownerName: m.ownerName || '', date: m.date || '',
    title: m.title || '', items: Array.isArray(m.items) ? m.items : [],
    source: m.source || 'manual', updatedAt: m.updatedAt || '', mine: m.ownerId === u.userId
  };
}

// 안 끝낸(미완료) 항목이 있는 메모인지 — 자동 이월 판단용
function hasUndone(m) { return Array.isArray(m.items) && m.items.some(i => i && i.text && !i.done); }

// 메모가 GET / 가시규칙으로 사용자(u, 컨텍스트 v)에게 보이는가
//   = 내 것(ownerId===userId) || 팀장이고 같은부서(deptId===ledDeptId) || admin. 회사(companyId) 일치 전제.
function memoVisibleTo(m, u, v) {
  if (!m) return false;
  if ((m.companyId || 'dalim-sm') !== v.companyId) return false;
  if (m.ownerId === u.userId) return true;
  if (v.isAdmin) return true;
  if (v.isLeader && (m.deptId || '') === v.ledDeptId) return true;
  return false;
}

// ── 첨부 가시성(서버 판정만 신뢰, 클라 주장 무시) ──
//   허용 = 업로더 본인 OR admin OR '이 첨부 id 를 가리키는 todo 아이템을 가진 메모를 v 범위에서 볼 수 있음'.
//   첨부엔 companyId 가 없으므로, 연결된 todo 메모의 companyId 로 회사분리.
function canViewAttachment(a, u, v) {
  if (!a) return false;
  if (String(a.owner_id) === String(u.userId)) return true;   // 업로더 본인
  if (v.isAdmin) return true;                                  // admin
  try {
    const id = a.id;
    const memos = load().memos;
    for (const m of memos) {
      if (!memoVisibleTo(m, u, v)) continue;
      const items = Array.isArray(m.items) ? m.items : [];
      if (items.some(it => it && Array.isArray(it.attachmentIds) && it.attachmentIds.map(Number).includes(Number(id)))) {
        return true;
      }
    }
  } catch (e) {}
  return false;
}

// 첨부 원본 파일 경로 — traversal 방어(stored_name 은 서버생성이나 방어적으로 basename + UPLOAD_DIR 하위 확인)
function attachmentFilePath(a) {
  if (!a || !a.stored_name) return null;
  const base = path.basename(String(a.stored_name));
  const fp = path.join(ai.UPLOAD_DIR, base);
  const resolved = path.resolve(fp);
  if (!resolved.startsWith(path.resolve(ai.UPLOAD_DIR))) return null;
  return resolved;
}

// ── 목록 ── ?date=YYYY-MM-DD(기본 오늘) · ?view=team(부서장/관리자, 사람별)
//   오늘 보기  : 그날 메모 + 이전에 '안 끝낸' 메모(자동 이월). 다 체크하면 원래 날짜에만 남음.
//   과거 날짜 : 그날 만든 메모만(기록).
router.get('/', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const v = viewerCtx(u);
    const date = isDate(req.query.date) ? req.query.date : todayKST();
    const isToday = date === todayKST();
    const wantTeam = req.query.view === 'team' && (v.isAdmin || v.isLeader);
    let memos = load().memos.filter(m => {
      if ((m.companyId || 'dalim-sm') !== v.companyId) return false;
      const md = m.date || '';
      if (md === date) return true;                                  // 그날 메모
      if (isToday && md && md < date && hasUndone(m)) return true;   // 이전에 안 끝낸 메모 → 오늘로 이월
      return false;
    });
    // 이월된(오래된) 메모가 위로 오도록 날짜 오름차순 → 같은 날은 작성순
    const byDate = (a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || '');

    if (wantTeam) {
      if (!v.isAdmin) memos = memos.filter(m => (m.deptId || '') === v.ledDeptId);
      memos.sort((a, b) => (a.ownerName || '').localeCompare(b.ownerName || '', 'ko') || byDate(a, b));
      return res.json({ ok: true, viewer: { mode: v.isAdmin ? 'admin' : 'leader', isAdmin: v.isAdmin, canSeeTeam: true, name: u.name || '', userId: u.userId }, people: peopleInScope(v), memos: memos.map(m => shape(m, u)) });
    }
    memos = memos.filter(m => m.ownerId === u.userId).sort(byDate);
    res.json({ ok: true, viewer: { mode: 'mine', isAdmin: v.isAdmin, canSeeTeam: v.isAdmin || v.isLeader, name: u.name || '', userId: u.userId }, memos: memos.map(m => shape(m, u)) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 메모 추가 ── owner/dept/company 서버강제
router.post('/', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const title = clean(req.body && req.body.title, 200);
    if (!title) return res.status(400).json({ error: '메모 제목을 입력하세요' });
    const date = isDate(req.body && req.body.date) ? req.body.date : todayKST();
    const data = load();
    const m = {
      id: newId('memo'), ownerId: u.userId, ownerName: u.name || '', date, title,
      items: normItems(req.body && req.body.items),
      deptId: u.department || '', companyId: u.companyId || 'dalim-sm', source: 'manual',
      createdAt: nowISO(), updatedAt: nowISO()
    };
    data.memos.push(m);
    db['할일'].save(data);
    res.json({ ok: true, memo: shape(m, u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 메모 수정(제목/항목 통째 저장) ── 본인 또는 admin ──
router.put('/:id', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const data = load();
    const m = data.memos.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: '메모 없음' });
    if (m.ownerId !== u.userId && u.role !== 'admin') return res.status(403).json({ error: '본인 메모만 수정할 수 있어요' });
    const b = req.body || {};
    if (b.title !== undefined) m.title = clean(b.title, 200);
    if (b.items !== undefined) m.items = normItems(b.items);
    m.updatedAt = nowISO();
    db['할일'].save(data);
    res.json({ ok: true, memo: shape(m, u) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 메모 삭제 ── 본인 또는 admin ──
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const data = load();
    const m = data.memos.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: '메모 없음' });
    if (m.ownerId !== u.userId && u.role !== 'admin') return res.status(403).json({ error: '본인 메모만 삭제할 수 있어요' });
    data.memos = data.memos.filter(x => x.id !== req.params.id);
    db['할일'].save(data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI 정리: 붙여넣은 메모/카톡 → 메모(묶음) + 할 일 항목들로 ──
const TODO_EXTRACT_PROMPT = `당신은 할일 정리 도우미입니다. 사용자가 붙여넣은 메모/카톡 내용에서 '해야 할 일'을 주제·현장·업체별로 묶어 정리하세요.
출력은 반드시 순수 JSON만(설명/머릿말/\`\`\`코드블록\`\`\` 절대 금지): {"memos":[{"title":"묶음 제목","items":["할 일 한 줄", ...]}, ...]}
- title은 현장/업체/주제 등 묶음 이름(짧게). 마땅치 않으면 "할 일".
- items는 각 한 줄로 간결하게(필요하면 무엇을/누가/언제 포함). 내용에 있는 것만, 없는 일 창작 금지.
- 할 일이 안 보이면 {"memos":[]}.`;
function extractMemos(content) {
  let s = String(content || '');
  const md = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (md) s = md[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let p; try { p = JSON.parse(s); } catch (e) { return []; }
  if (!p || !Array.isArray(p.memos)) return [];
  return p.memos.map(mm => ({
    title: clean(mm && mm.title, 200) || '할 일',
    items: Array.isArray(mm && mm.items) ? mm.items.map(t => clean(t, 300)).filter(Boolean).slice(0, 30) : []
  })).filter(mm => mm.items.length).slice(0, 12);
}
// 세부내역 AI 작성 프롬프트(고정 상수 — 사용자/파일내용으로 덮어쓰기 불가)
const DETAIL_WRITE_PROMPT = `당신은 업무 세부내역 작성 도우미입니다. 주어진 할 일 한 줄과 참고자료를 바탕으로, 실행에 필요한 구체적 세부내역(준비물·연락처·수량·기한·체크포인트 등)을 5줄 이내 한국어 평문으로 적으세요. 근거 없는 내용 창작 금지, 마크다운/머릿말 금지, 본문만 출력.`;

// ── /ingest 멀티파트(파일 동봉) 분기용 미들웨어 ──
//   Content-Type 이 multipart 일 때만 multer 동작(JSON 모드 무영향). 미설치 시 503.
function ingestUpload(req, res, next) {
  const ct = String(req.headers['content-type'] || '');
  if (!/multipart\/form-data/i.test(ct)) return next();   // JSON 모드 → 그대로 통과
  if (!uploadMany) return res.status(503).json({ error: '파일 첨부 기능을 사용할 수 없습니다 (서버에 multer 미설치).' });
  uploadMany.array('files', 5)(req, res, (err) => {
    if (err) {
      let msg = err.message;
      if (/지원하지 않는/.test(err.message)) msg = '지원하지 않는 파일이 포함됐어요 (이미지·엑셀·PDF·텍스트만)';
      else if (err.code === 'LIMIT_FILE_SIZE') msg = '파일이 너무 커요 (최대 10MB)';
      else if (err.code === 'LIMIT_UNEXPECTED_FILE') msg = '파일은 최대 5개까지예요';
      return res.status(400).json({ error: msg });
    }
    next();
  });
}

router.post('/ingest', requireAuth, ingestUpload, async (req, res) => {
  const tmpFiles = [];     // 추출 후 정리할 임시파일 경로
  try {
    const u = req.user;
    const text = clean(req.body && req.body.text, 4000);
    const files = Array.isArray(req.files) ? req.files : [];
    files.forEach(f => { if (f && f.path) tmpFiles.push(f.path); });
    if (!text && !files.length) return res.status(400).json({ error: '내용을 입력하거나 파일을 첨부하세요' });
    const date = isDate(req.body && req.body.date) ? req.body.date : todayKST();

    // 파일 → 라벨링된 텍스트 블록(신뢰불가 데이터로 격리)
    const blocks = [];
    for (const f of files) {
      const originalName = fileExtract.fixKoreanFilename(f.originalname || '');
      const ext = path.extname(originalName).toLowerCase();
      const kind = fileExtract.detectKind(f.mimetype, ext);
      let extracted = '';
      try {
        if (kind === 'image') {
          extracted = await fileExtract.ocrImageToText(path.resolve(f.path), 'multilingual');
        } else {
          extracted = await extractByKind(kind, f.path, originalName);
        }
      } catch (e) { extracted = ''; }
      // 읽기 실패 텍스트는 AI 입력 오염 방지 위해 '원본 확인 필요' 로 치환
      if (fileExtract.isReadFailureExcerpt(extracted)) extracted = '(원본 확인 필요 — 자동 추출 실패)';
      const body = String(extracted || '').slice(0, 50000);     // 파일블록 ≤50K자
      blocks.push(`[첨부: ${originalName} (${kind})]\n${body}`);
    }

    let combinedInput = '';
    if (text) combinedInput += text;
    if (blocks.length) combinedInput += (combinedInput ? '\n\n' : '') + blocks.join('\n\n');
    combinedInput = combinedInput.slice(0, 12000);              // 전체 ≤12000자 cap
    if (!combinedInput.trim()) return res.json({ ok: false, error: '정리할 할 일을 못 찾았어요. 직접 적어주세요.' });

    let groups = [];
    try {
      const out = await claudeClient.callClaude({ system: TODO_EXTRACT_PROMPT, user: combinedInput, maxTokens: 1500 });
      groups = extractMemos(out);
    } catch (e) { groups = []; }
    if (!groups.length) return res.json({ ok: false, error: '정리할 할 일을 못 찾았어요. 직접 적어주세요.' });
    const data = load();
    const created = groups.map(g => {
      const m = {
        id: newId('memo'), ownerId: u.userId, ownerName: u.name || '', date, title: g.title,
        items: g.items.map(t => ({ id: newId('item'), text: t, done: false })),
        deptId: u.department || '', companyId: u.companyId || 'dalim-sm', source: 'ai',
        createdAt: nowISO(), updatedAt: nowISO()
      };
      data.memos.push(m); return m;
    });
    db['할일'].save(data);
    res.json({ ok: true, memos: created.map(m => shape(m, u)) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    // ingest 업로드는 추출만 하고 영구저장 안 함 → 임시파일 60초 후 정리(ai-ocr 패턴)
    if (tmpFiles.length) {
      setTimeout(() => { tmpFiles.forEach(p => { try { fs.unlinkSync(p); } catch (_) {} }); }, 60 * 1000);
    }
  }
});

// ──────────────────────────────────────────────────────────
// 첨부 업로드 / 서빙 / 메타 / 세부내역 AI 작성
// ──────────────────────────────────────────────────────────

// ── 단일 파일 업로드 → ai_attachments(owner_id=업로더) ──
router.post('/attachments', requireAuth, (req, res) => {
  if (!ai.ready) return res.status(503).json({ error: '첨부 기능은 SQLite 설치가 필요합니다 (better-sqlite3).' });
  if (!uploadSingle) return res.status(503).json({ error: '첨부 기능은 SQLite 설치가 필요합니다 (better-sqlite3).' });
  uploadSingle.single('file')(req, res, async (err) => {
    if (err) {
      let msg = err.message;
      if (/지원하지 않는/.test(err.message)) msg = '지원하지 않는 파일 형식이에요 (이미지·엑셀·PDF·텍스트만)';
      else if (err.code === 'LIMIT_FILE_SIZE') msg = '파일이 너무 커요 (최대 10MB)';
      return res.status(400).json({ error: msg });
    }
    if (!req.file) return res.status(400).json({ error: '파일이 필요합니다' });
    const tmpPath = req.file.path;
    try {
      const u = req.user;
      const originalName = fileExtract.fixKoreanFilename(req.file.originalname || '');
      const ext = path.extname(originalName).toLowerCase();
      const kind = fileExtract.detectKind(req.file.mimetype, ext);
      // 엑셀/PDF/텍스트는 업로드 시점에 추출, 이미지는 excerpt 없음(detail-ai/ingest에서 비전으로 따로 읽음)
      let textExcerpt = '';
      if (kind !== 'image') textExcerpt = await extractByKind(kind, tmpPath, originalName);
      const saved = ai.attachments.create({
        ownerId: u.userId,                      // 서버강제 — 클라 지정 불가
        originalName,
        storedName: path.basename(req.file.path),
        mime: req.file.mimetype || '',
        size: req.file.size || 0,
        kind,
        textExcerpt
      });
      res.json({ ok: true, attachment: fileExtract.attachmentForClient(saved) });
    } catch (e) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      res.status(500).json({ error: e.message });
    }
  });
});

// ── 첨부 원본 서빙(이미지 미리보기/파일 다운로드) — IDOR 차단 게이트 ──
router.get('/attachments/:id/raw', requireAuth, (req, res) => {
  try {
    if (!ai.ready) return res.status(503).json({ error: '첨부 기능은 SQLite 설치가 필요합니다 (better-sqlite3).' });
    const u = req.user;
    const v = viewerCtx(u);
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id) || id <= 0) return res.status(404).json({ error: '첨부 없음' });
    const a = ai.attachments.get(id);
    if (!a) return res.status(404).json({ error: '첨부 없음' });
    if (!canViewAttachment(a, u, v)) return res.status(403).json({ error: '권한이 없어요' });
    const fp = attachmentFilePath(a);
    if (!fp || !fs.existsSync(fp)) return res.status(404).json({ error: '파일 없음' });
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Type', a.mime || 'application/octet-stream');
    if (String(a.kind || '') === 'image') {
      res.setHeader('Content-Disposition', 'inline');
    } else {
      res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(a.original_name || 'file')}"`);
    }
    fs.createReadStream(fp).pipe(res);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 여러 첨부 메타 조회(파일명/kind/크기/상태) — 세부내역 칩 렌더용 ──
router.get('/attachments/meta', requireAuth, (req, res) => {
  try {
    if (!ai.ready) return res.json({ ok: true, attachments: [] });
    const u = req.user;
    const v = viewerCtx(u);
    const raw = String(req.query.ids || '');
    const ids = raw.split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0).slice(0, 60);
    const out = [];
    for (const id of ids) {
      const a = ai.attachments.get(id);
      if (!a) continue;
      if (!canViewAttachment(a, u, v)) continue;         // 통과 못한 id 는 조용히 드롭
      out.push(fileExtract.attachmentForClient(a));
    }
    res.json({ ok: true, attachments: out });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 세부내역 AI 대신 작성 ── 본인 메모 또는 admin ──
router.post('/:id/items/:itemId/detail-ai', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const data = load();
    const m = data.memos.find(x => x.id === req.params.id);
    if (!m) return res.status(404).json({ error: '메모 없음' });
    if (m.ownerId !== u.userId && u.role !== 'admin') return res.status(403).json({ error: '본인 메모만 가능해요' });
    const items = Array.isArray(m.items) ? m.items : [];
    const it = items.find(x => x && x.id === req.params.itemId);
    if (!it) return res.status(404).json({ error: '항목 없음' });
    const extra = clean(req.body && req.body.extra, 1000);

    // 아이템 첨부의 참고텍스트 수집(ownerId=메모.ownerId 로 스코프 — IDOR 방지)
    let refBlocks = [];
    let imageCount = 0;
    if (ai.ready && Array.isArray(it.attachmentIds) && it.attachmentIds.length) {
      const rows = ai.attachments.hydrate(it.attachmentIds.map(Number), m.ownerId);
      for (const a of rows) {
        if (String(a.kind || '') === 'image') { imageCount++; continue; }   // 이미지는 메타만(구현단순화)
        const ex = String(a.text_excerpt || '');
        if (ex && !fileExtract.isReadFailureExcerpt(ex)) {
          refBlocks.push(`[첨부: ${a.original_name} (${a.kind})]\n${ex}`);
        }
      }
    }
    if (imageCount > 0) refBlocks.push(`[이미지 첨부 ${imageCount}장]`);
    let refText = refBlocks.join('\n\n').slice(0, 6000);    // 참고 ≤6000자

    const user = `할 일: ${it.text || ''}\n참고(첨부):\n${refText || '(없음)'}\n사용자 메모: ${extra || '(없음)'}`;
    let out = '';
    try {
      out = await claudeClient.callClaude({ system: DETAIL_WRITE_PROMPT, user, maxTokens: 600 });
    } catch (e) { out = ''; }
    res.json({ ok: true, detail: clean(out, 2000) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 업무 전달(지시): 팀장=부서원 / 관리자=전사 직원에게 할 일 보내기 ──
//   대상 직원의 '전달받은 업무' 메모(그 날짜)에 항목 추가. 누가·언제 전달했는지 기록.
router.post('/assign', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const v = viewerCtx(u);
    if (!v.isAdmin && !v.isLeader) return res.status(403).json({ error: '업무를 전달할 권한이 없어요' });
    const b = req.body || {};
    const targetUserId = clean(b.targetUserId, 60);
    const text = clean(b.text, 300);
    const detail = clean(b.detail, 2000);
    const date = isDate(b.date) ? b.date : todayKST();
    if (!targetUserId || !text) return res.status(400).json({ error: '대상과 업무 내용을 입력하세요' });

    // 대상 직원 조회 + 권한(같은 회사 / 관리자=전사, 팀장=우리 부서) 확인 — 클라이언트 신뢰 안 함
    const org = db.loadUsers();
    const target = (org.users || []).find(x => x.userId === targetUserId && x.status === 'approved');
    if (!target) return res.status(404).json({ error: '대상 직원을 찾을 수 없어요' });
    const sameCompany = (target.companyId || 'dalim-sm') === v.companyId;
    const allowed = v.isAdmin ? sameCompany : (v.isLeader && sameCompany && target.department === v.ledDeptId);
    if (!allowed) return res.status(403).json({ error: '이 직원에게는 전달할 수 없어요' });

    // 대상의 '전달받은 업무' 메모(그 날짜) 찾거나 생성
    const data = load();
    let memo = data.memos.find(m => m.ownerId === target.userId && (m.date || '') === date && m.source === 'assigned' && m.title === '전달받은 업무');
    if (!memo) {
      memo = {
        id: newId('memo'), ownerId: target.userId, ownerName: target.name || '', date, title: '전달받은 업무',
        items: [], deptId: target.department || '', companyId: target.companyId || 'dalim-sm', source: 'assigned',
        createdAt: nowISO(), updatedAt: nowISO()
      };
      data.memos.push(memo);
    }
    if (!Array.isArray(memo.items)) memo.items = [];
    const item = {
      id: newId('item'), text, done: false,
      source: 'assigned', assignedById: u.userId, assignedByName: u.name || '', assignedAt: nowISO(), completedAt: ''
    };
    if (detail) item.detail = detail;
    memo.items.push(item);
    memo.updatedAt = nowISO();
    db['할일'].save(data);
    res.json({ ok: true, memo: shape(memo, u), item });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
