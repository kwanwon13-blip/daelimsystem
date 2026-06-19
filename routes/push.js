/**
 * routes/push.js — 웹푸시 구독 관리
 * Mounted at: app.use('/api/push', require('./routes/push'))
 *  GET  /api/push/vapid-public-key  → 구독에 필요한 VAPID 공개키(비밀 아님) + 서버 준비여부
 *  POST /api/push/subscribe         → 현재 사용자 기기 구독 등록 { subscription }
 *  POST /api/push/unsubscribe       → 구독 해제 { endpoint }
 */
const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const push = require('../utils/push');
const realtime = require('../utils/realtime');

router.use(requireAuth);

// 테스트 알림 — 본인에게 SSE(실시간) + 웹푸시(OS 알림) 동시 발송 + 진단 반환
router.post('/test', (req, res) => {
  const uid = req.user.userId;
  const now = new Date().toLocaleTimeString('ko-KR');
  try { realtime.send(uid, { t: 'test', message: '🔔 SSE 실시간 테스트 (' + now + ')' }); } catch (_) {}
  try {
    push.sendPushToUsers([uid], {
      title: '🔔 테스트 알림',
      body: '대림에스엠 ERP 알림이 정상 작동합니다. (' + now + ')',
      link: '/#workflow',
      // tag 생략 — 테스트를 여러 번 눌러도 각각 쌓이게(누적 확인용)
    });
  } catch (_) {}
  res.json({ ok: true, pushReady: push.isReady(), subscriptions: push.countForUser(uid) });
});

router.get('/vapid-public-key', (req, res) => {
  res.json({ key: push.getPublicKey(), ready: push.isReady() });
});

// 이 계정이 어느 기기에서든 구독했는지(안내 팝업 표시 여부 판단용)
router.get('/status', (req, res) => {
  res.json({ ready: push.isReady(), count: push.countForUser(req.user.userId) });
});

router.post('/subscribe', (req, res) => {
  try {
    const sub = req.body && req.body.subscription;
    if (!sub || !sub.endpoint) return res.status(400).json({ error: 'subscription required' });
    const ok = push.saveSubscription(req.user.userId, sub, req.headers['user-agent'] || '');
    res.json({ ok });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/unsubscribe', (req, res) => {
  try {
    push.removeSubscription(req.body && req.body.endpoint);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
