/**
 * routes/calendar.js — 캘린더/일정 API
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

// 일정 목록 조회 (기간별)
router.get('/events', requireAuth, (req, res) => {
  const { from, to } = req.query;
  try {
    const eventData = db['일정관리'].load();
    let events = eventData.events || [];

    if (from && to) {
      events = events.filter(e => e.날짜 >= from && e.날짜 <= to);
    }

    res.json({ events });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 일정 추가
router.post('/events', requireAuth, (req, res) => {
  const { 제목, 유형, 날짜, 종료일, 작성자, 공개, 메모 } = req.body;
  if (!제목 || !날짜) {
    return res.status(400).json({ error: '제목과 날짜는 필수입니다' });
  }

  try {
    const eventData = db['일정관리'].load();
    const newEvent = {
      id: `evt_${Date.now()}`,
      제목,
      유형: 유형 || '개인일정',
      날짜,
      종료일: 종료일 || 날짜,
      작성자: 작성자 || req.user.userId,
      공개: 공개 !== undefined ? 공개 : true,
      메모: 메모 || '',
      생성일: new Date().toISOString()
    };

    eventData.events.push(newEvent);
    db['일정관리'].save(eventData);

    auditLog(req.user.userId, '일정 추가', 제목);
    res.json({ ok: true, event: newEvent });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 일정 수정
router.put('/events/:id', requireAuth, (req, res) => {
  const { 제목, 유형, 날짜, 종료일, 공개, 메모 } = req.body;
  try {
    const eventData = db['일정관리'].load();
    const event = eventData.events.find(e => e.id === req.params.id);

    if (!event) return res.status(404).json({ error: '일정 없음' });
    if (event.작성자 !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: '본인 일정만 수정할 수 있습니다' });
    }

    if (제목) event.제목 = 제목;
    if (유형) event.유형 = 유형;
    if (날짜) event.날짜 = 날짜;
    if (종료일) event.종료일 = 종료일;
    if (공개 !== undefined) event.공개 = 공개;
    if (메모) event.메모 = 메모;

    db['일정관리'].save(eventData);
    auditLog(req.user.userId, '일정 수정', 제목 || event.제목);
    res.json({ ok: true, event });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 일정 삭제
router.delete('/events/:id', requireAuth, (req, res) => {
  try {
    const eventData = db['일정관리'].load();
    const event = eventData.events.find(e => e.id === req.params.id);

    if (!event) return res.status(404).json({ error: '일정 없음' });
    if (event.작성자 !== req.user.userId && req.user.role !== 'admin') {
      return res.status(403).json({ error: '본인 일정만 삭제할 수 있습니다' });
    }

    eventData.events = eventData.events.filter(e => e.id !== req.params.id);
    db['일정관리'].save(eventData);

    auditLog(req.user.userId, '일정 삭제', event.제목);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
