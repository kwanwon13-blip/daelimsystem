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

router.use(requireAuth);

router.get('/vapid-public-key', (req, res) => {
  res.json({ key: push.getPublicKey(), ready: push.isReady() });
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
