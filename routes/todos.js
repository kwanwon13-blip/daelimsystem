/**
 * routes/todos.js — 할일(TODO) : 메모식 체크리스트 + 직급별 보기 + AI 정리
 * 워크스페이스 라우터 밑에 마운트: /api/workspace/todos (server.js 무수정)
 *
 * 보기 모델(직급 자동, 서버 판정 — 클라이언트 신뢰 안 함):
 *   - 직원      : 내 것만
 *   - 부서장    : 우리 부서원 전체 (조직관리의 부서 leaderId === 내 내부 user.id)
 *   - 대표/관리자: 회사 전체 (role==='admin')
 * 작성/수정/완료체크는 본인 것만(관리자 제외). 회사(companyId)로 에스엠/컴퍼니 분리.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const claudeClient = require('../lib/claude-client');

function todayKST() { return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10); }
function load() { const d = db['할일'].load(); if (!Array.isArray(d.todos)) d.todos = []; return d; }
function newId() { return 'todo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }

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

// 범위 내 직원 명단(부서장=부서원, 관리자=전사) — 빈 리스트인 사람도 보이게
function peopleInScope(v) {
  try {
    const org = db.loadUsers();
    const deptMap = {}; (org.departments || []).forEach(d => { if (d && d.id) deptMap[d.id] = d.name || ''; });
    let users = (org.users || []).filter(x => x.status === 'approved' && (x.companyId || 'dalim-sm') === v.companyId);
    if (!v.isAdmin) users = users.filter(x => x.department === v.ledDeptId);
    return users.map(x => ({ userId: x.userId, name: x.name || '', deptName: deptMap[x.department] || '' }));
  } catch (e) { return []; }
}

// ── 목록 ── ?date=YYYY-MM-DD(기본 오늘) · ?view=team(부서장/관리자, 사람별)
router.get('/', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const v = viewerCtx(u);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : todayKST();
    const wantTeam = req.query.view === 'team' && (v.isAdmin || v.isLeader);
    let todos = load().todos.filter(t => (t.companyId || 'dalim-sm') === v.companyId && (t.date || '') === date);

    if (wantTeam) {
      if (!v.isAdmin) todos = todos.filter(t => (t.deptId || '') === v.ledDeptId);
      todos.sort((a, b) => (a.ownerName || '').localeCompare(b.ownerName || '', 'ko') || (a.createdAt || '').localeCompare(b.createdAt || ''));
      return res.json({ ok: true, viewer: { mode: v.isAdmin ? 'admin' : 'leader', isAdmin: v.isAdmin, canSeeTeam: true, name: u.name || '', userId: u.userId }, people: peopleInScope(v), todos });
    }
    todos = todos.filter(t => t.ownerId === u.userId);
    todos.sort((a, b) => (a.createdAt || '').localeCompare(b.createdAt || ''));
    res.json({ ok: true, viewer: { mode: 'mine', isAdmin: v.isAdmin, canSeeTeam: v.isAdmin || v.isLeader, name: u.name || '', userId: u.userId }, todos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 추가(한 줄) ── owner/dept/company 서버강제
router.post('/', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const text = String((req.body && req.body.text) || '').trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 300);
    if (!text) return res.status(400).json({ error: '내용을 입력하세요' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test((req.body && req.body.date) || '') ? req.body.date : todayKST();
    const data = load();
    const t = {
      id: newId(), ownerId: u.userId, ownerName: u.name || '', date, text, done: false,
      deptId: u.department || '', companyId: u.companyId || 'dalim-sm',
      source: ['kakao', 'ai'].includes(req.body && req.body.source) ? req.body.source : 'manual',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    data.todos.push(t);
    db['할일'].save(data);
    res.json({ ok: true, todo: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── AI 정리: 붙여넣은 메모/카톡 → 할 일 항목들로 ──
const TODO_EXTRACT_PROMPT = `당신은 할일 정리 도우미입니다. 사용자가 붙여넣은 메모/카톡 내용에서 '해야 할 일'만 뽑아 짧은 항목으로 정리하세요.
출력은 반드시 순수 JSON만(설명/머릿말/\`\`\`코드블록\`\`\` 절대 금지): {"todos":[{"text":"할 일 한 줄"}, ...]}
- 각 text는 한 줄로 간결하게(필요하면 무엇을/누가/언제 포함).
- 내용에 있는 것만. 없는 일 창작 금지. 할 일이 안 보이면 {"todos":[]}.`;
function extractTodos(content) {
  let s = String(content || '');
  const md = s.match(/```(?:json)?\s*([\s\S]*?)```/); if (md) s = md[1].trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let p; try { p = JSON.parse(s); } catch (e) { return []; }
  if (!p || !Array.isArray(p.todos)) return [];
  return p.todos.map(x => String((x && x.text) || '').trim()).filter(Boolean).slice(0, 30);
}
router.post('/ingest', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const text = String((req.body && req.body.text) || '').trim().slice(0, 3000);
    if (!text) return res.status(400).json({ error: '내용을 입력하세요' });
    const date = /^\d{4}-\d{2}-\d{2}$/.test((req.body && req.body.date) || '') ? req.body.date : todayKST();
    let items = [];
    try {
      const out = await claudeClient.callClaude({ system: TODO_EXTRACT_PROMPT, user: text, maxTokens: 1024 });
      items = extractTodos(out);
    } catch (e) { items = []; }
    if (!items.length) return res.json({ ok: false, error: '정리할 할 일을 못 찾았어요. 직접 적어주세요.' });
    const data = load();
    const created = items.map(txt => {
      const t = { id: newId(), ownerId: u.userId, ownerName: u.name || '', date, text: txt.slice(0, 300), done: false, deptId: u.department || '', companyId: u.companyId || 'dalim-sm', source: 'ai', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      data.todos.push(t); return t;
    });
    db['할일'].save(data);
    res.json({ ok: true, todos: created });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 수정(완료 토글/내용) ── 본인 또는 admin ──
router.put('/:id', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const data = load();
    const t = data.todos.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: '항목 없음' });
    if (t.ownerId !== u.userId && u.role !== 'admin') return res.status(403).json({ error: '본인 할 일만 수정할 수 있어요' });
    const b = req.body || {};
    if (b.done !== undefined) t.done = !!b.done;
    if (b.text !== undefined) t.text = String(b.text).trim().slice(0, 300);
    t.updatedAt = new Date().toISOString();
    db['할일'].save(data);
    res.json({ ok: true, todo: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 삭제 ── 본인 또는 admin ──
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const data = load();
    const t = data.todos.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: '항목 없음' });
    if (t.ownerId !== u.userId && u.role !== 'admin') return res.status(403).json({ error: '본인 할 일만 삭제할 수 있어요' });
    data.todos = data.todos.filter(x => x.id !== req.params.id);
    db['할일'].save(data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
