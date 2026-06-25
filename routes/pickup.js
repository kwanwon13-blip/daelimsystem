/**
 * routes/pickup.js — 픽업관리 v1 API
 * 권한: pickup_view(조회) / pickup_register(등록·수정·취소) / pickup_check(라인체크)
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getReqUser, requireAuth } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { safeBody } = require('../middleware/sanitize');
const L = require('../lib/pickup-logic');

let notify = () => {};
try { notify = require('../utils/notify').notify || notify; } catch (e) {}

router.use(requireAuth);

// ── 권한 헬퍼 ──
function hasPerm(req, perm) {
  const u = req.user || {};
  return u.role === 'admin' || (Array.isArray(u.permissions) && u.permissions.includes(perm));
}
function requirePerm(perm) {
  return (req, res, next) => hasPerm(req, perm)
    ? next()
    : res.status(403).json({ error: '권한이 없습니다', code: 'PICKUP_FORBIDDEN', need: perm });
}
function pickup() {
  if (!db.sql || !db.sql.pickupRequests) return null;
  return db.sql.pickupRequests;
}
function cutoffTime() {
  try { return (db['설정'] && db['설정'].load().pickup || {}).cutoffTime || '10:00'; }
  catch (e) { return '10:00'; }
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── 조회: 날짜별 취합 (업체 그룹 메타 포함) ──
router.get('/requests', requirePerm('pickup_view'), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요(better-sqlite3 미설치)' });
    const date = req.query.date || todayStr();
    const requests = P.getByDate(date);
    res.json({ date, requests, groups: L.groupByVendor(requests) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 조회: 내가 등록한 것 ──
router.get('/requests/mine', requirePerm('pickup_view'), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const date = req.query.date || todayStr();
    res.json(P.getMine(getReqUser(req), date));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 등록 ──
router.post('/requests', requirePerm('pickup_register'), express.json(), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const b = safeBody(req.body, []);
    // 자유 업체명(vendorName)만으로도 등록 허용 — 등록업체(vendorId)는 선택.
    let vendorName = String(b.vendorName || '').trim();
    let vendorId = b.vendorId || null;
    if (vendorId) {
      // vendorId 가 명시되면 등록업체 이름으로 보정
      const vendor = db.sql.vendors.getById(vendorId);
      if (!vendor) return res.status(400).json({ error: '없는 업체' });
      vendorName = vendor.name;
    } else if (vendorName) {
      // vendorId 없이 이름만 들어오면 등록업체 중 이름 정규화 일치 시 자동 링크
      const norm = (s) => String(s || '').toLowerCase().replace(/\s+/g, '');
      const target = norm(vendorName);
      try {
        const match = (db.sql.vendors.getAll() || []).find(v => norm(v.name) === target);
        if (match) { vendorId = match.id; vendorName = match.name; }
      } catch (e) { /* 매칭 실패는 무시하고 이름만 저장 */ }
    }
    if (!vendorName) return res.status(400).json({ error: 'vendorName 필수' });
    const pickupDate = b.pickupDate || todayStr();
    const isLate = L.computeIsLate(new Date(), cutoffTime(), pickupDate, todayStr());
    const created = P.create({
      registrarId: getReqUser(req), registrarName: (req.user && req.user.name) || '',
      pickupDate, vendorId, vendorName,
      preferredTimeSlot: b.preferredTimeSlot, priority: b.priority, memo: b.memo,
      sourceType: b.sourceType === 'workflow' ? 'workflow' : 'manual',
      sourceJobId: b.sourceJobId || null, isLate,
    }, Array.isArray(b.items) ? b.items : []);
    auditLog(getReqUser(req), '픽업요청 등록', vendorName + (isLate ? ' (추가요청)' : ''));
    notifyDeliveryTeam(`${isLate ? '🔴추가요청 ' : ''}${vendorName} 픽업요청 (${pickupDate})`);
    res.json(created);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 수정 (등록자 본인 또는 admin) ──
router.put('/requests/:id', requirePerm('pickup_register'), express.json(), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const cur = P.getById(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    if (cur.registrarId !== getReqUser(req) && req.user.role !== 'admin')
      return res.status(403).json({ error: '본인 요청만 수정 가능' });
    const updated = P.update(req.params.id, safeBody(req.body, ['id']));
    auditLog(getReqUser(req), '픽업요청 수정', updated.vendorName);
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 취소 ──
router.post('/requests/:id/cancel', requirePerm('pickup_register'), express.json(), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const cur = P.getById(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    if (cur.registrarId !== getReqUser(req) && req.user.role !== 'admin')
      return res.status(403).json({ error: '본인 요청만 취소 가능' });
    const r = P.cancel(req.params.id, getReqUser(req), (req.body && req.body.reason) || '');
    auditLog(getReqUser(req), '픽업요청 취소', cur.vendorName);
    res.json(r);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 라인(품목) 상태 체크 ──
router.patch('/items/:id/status', requirePerm('pickup_check'), express.json(), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const VALID = ['requested', 'pickedUp', 'notPicked', 'cancelled'];
    const b = req.body || {};
    if (b.status && !VALID.includes(b.status)) return res.status(400).json({ error: '잘못된 상태' });
    const updated = P.setItemStatus(req.params.id, {
      status: b.status, pickedQty: b.pickedQty, failReason: b.failReason,
    }, getReqUser(req));
    if (!updated) return res.status(404).json({ error: 'item not found' });
    res.json(updated);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 카톡 붙여넣기 파싱 (저장 아님, 후보 반환) ──
router.post('/parse-kakao', requirePerm('pickup_register'), express.json(), (req, res) => {
  res.json({ groups: L.parseKakaoPickup((req.body && req.body.text) || '') });
});

// ── 카톡 공유텍스트 ──
router.get('/requests/:date/share-text', requirePerm('pickup_view'), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const groups = L.groupByVendor(P.getByDate(req.params.date));
    res.json({ text: L.buildShareText(req.params.date, groups) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 알림: pickup_check 보유자 + admin 에게 (best-effort) ──
function notifyDeliveryTeam(message) {
  try {
    const users = (db['조직관리'].load().users || []).filter(u =>
      u.status === 'approved' && (u.role === 'admin' || (u.permissions || []).includes('pickup_check')));
    for (const u of users) notify(u.userId || u.id, 'pickup', message, '/?tab=pickup');
  } catch (e) { /* 알림 실패는 무시 */ }
}

module.exports = router;
