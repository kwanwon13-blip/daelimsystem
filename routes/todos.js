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
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const claudeClient = require('../lib/claude-client');

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
router.post('/ingest', requireAuth, async (req, res) => {
  try {
    const u = req.user;
    const text = clean(req.body && req.body.text, 4000);
    if (!text) return res.status(400).json({ error: '내용을 입력하세요' });
    const date = isDate(req.body && req.body.date) ? req.body.date : todayKST();
    let groups = [];
    try {
      const out = await claudeClient.callClaude({ system: TODO_EXTRACT_PROMPT, user: text, maxTokens: 1500 });
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
