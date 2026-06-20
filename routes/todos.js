/**
 * routes/todos.js — 개인/공유 할일(TODO)
 * 워크스페이스 라우터 밑에 마운트: /api/workspace/todos (server.js 무수정)
 * 항목: { id, ownerId, ownerName, date('YYYY-MM-DD'), text, done,
 *        scope('personal'|'dept'|'company'), deptId, companyId, source, createdAt, updatedAt }
 * 공유 범위(scope): personal(본인만) / dept(같은 부서) / company(같은 회사 전원).
 *   companyId 로 에스엠/컴퍼니 완전분리. owner/dept/company 값은 세션(req.user)으로 서버강제.
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

function todayKST() {
  // KST(UTC+9) 기준 오늘 YYYY-MM-DD
  return new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
}
function load() { const d = db['할일'].load(); if (!Array.isArray(d.todos)) d.todos = []; return d; }

// 읽기 게이트: 회사 분리 후, 본인 OR 전사공유 OR 같은부서
function canSee(t, u) {
  if (!t || !u) return false;
  if ((t.companyId || '') && u.companyId && t.companyId !== u.companyId) return false; // 에스엠/컴퍼니 분리
  if (t.ownerId === u.userId) return true;
  if (t.scope === 'company') return true;
  if (t.scope === 'dept' && t.deptId && u.department && t.deptId === u.department) return true;
  return false;
}

// 목록 (?date= 하루 | ?from&to 기간)
router.get('/', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const { date, from, to } = req.query;
    let todos = (load().todos).filter(t => canSee(t, u));
    if (date) todos = todos.filter(t => (t.date || '') === date);
    else if (from && to) todos = todos.filter(t => (t.date || '') >= from && (t.date || '') <= to);
    todos.sort((a, b) => (a.date || '').localeCompare(b.date || '') || (a.createdAt || '').localeCompare(b.createdAt || ''));
    res.json({ ok: true, todos });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 추가 (owner/dept/company 서버강제, 날짜 미지정 시 오늘 KST)
router.post('/', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const text = String((req.body && req.body.text) || '').trim().replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').slice(0, 300);
    if (!text) return res.status(400).json({ error: '내용을 입력하세요' });
    const scope = ['personal', 'dept', 'company'].includes(req.body && req.body.scope) ? req.body.scope : 'personal';
    const date = /^\d{4}-\d{2}-\d{2}$/.test((req.body && req.body.date) || '') ? req.body.date : todayKST();
    const data = load();
    const t = {
      id: 'todo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      ownerId: u.userId, ownerName: u.name || '',
      date, text, done: false, scope,
      deptId: u.department || '', companyId: u.companyId || '',
      source: ['kakao', 'ai'].includes(req.body && req.body.source) ? req.body.source : 'manual',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    };
    data.todos.push(t);
    db['할일'].save(data);
    res.json({ ok: true, todo: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 수정 — done 토글은 '볼 수 있는 사람 누구나'(협업 체크), 내용/범위/날짜는 작성자·admin
router.put('/:id', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const data = load();
    const t = data.todos.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: '항목 없음' });
    if (!canSee(t, u)) return res.status(403).json({ error: '권한 없음' });
    const isOwner = t.ownerId === u.userId || u.role === 'admin';
    const b = req.body || {};
    if (b.done !== undefined) t.done = !!b.done;  // 공유범위 누구나 완료체크
    if (b.text !== undefined) {
      if (!isOwner) return res.status(403).json({ error: '내용은 작성자만 수정할 수 있어요' });
      t.text = String(b.text).trim().slice(0, 300);
    }
    if (b.scope !== undefined && ['personal', 'dept', 'company'].includes(b.scope)) {
      if (!isOwner) return res.status(403).json({ error: '공유 범위는 작성자만 바꿀 수 있어요' });
      t.scope = b.scope;
    }
    if (b.date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(b.date)) {
      if (!isOwner) return res.status(403).json({ error: '날짜는 작성자만 바꿀 수 있어요' });
      t.date = b.date;
    }
    t.updatedAt = new Date().toISOString();
    db['할일'].save(data);
    res.json({ ok: true, todo: t });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 삭제 — 작성자·admin
router.delete('/:id', requireAuth, (req, res) => {
  try {
    const u = req.user;
    const data = load();
    const t = data.todos.find(x => x.id === req.params.id);
    if (!t) return res.status(404).json({ error: '항목 없음' });
    if (t.ownerId !== u.userId && u.role !== 'admin') return res.status(403).json({ error: '작성자만 삭제할 수 있어요' });
    data.todos = data.todos.filter(x => x.id !== req.params.id);
    db['할일'].save(data);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
