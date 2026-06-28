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

// 자유 업체명(vendorName) → 등록업체(vendorId) 자동매칭 (POST·PUT 공용)
// - vendorId 명시: 등록업체 이름으로 보정. 없는 업체면 {error}.
// - vendorId 없이 이름만: 등록업체 중 정규화(L.normVendorName) 정확일치 시 자동 링크.
// 반환: { vendorName, vendorId, error? }
function resolveVendor(rawName, rawId) {
  let vendorName = String(rawName || '').trim();
  let vendorId = rawId || null;
  if (vendorId) {
    const vendor = db.sql.vendors.getById(vendorId);
    if (!vendor) return { error: '없는 업체' };
    vendorName = vendor.name;
  } else if (vendorName) {
    const target = L.normVendorName(vendorName);
    try {
      const match = (db.sql.vendors.getAll() || []).find(v => L.normVendorName(v.name) === target);
      if (match) { vendorId = match.id; vendorName = match.name; }
    } catch (e) { /* 매칭 실패는 무시하고 이름만 저장 */ }
  }
  return { vendorName, vendorId };
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
    const rv = resolveVendor(b.vendorName, b.vendorId);
    if (rv.error) return res.status(400).json({ error: rv.error });
    const { vendorName, vendorId } = rv;
    if (!vendorName) return res.status(400).json({ error: 'vendorName 필수' });
    const pickupDate = b.pickupDate || todayStr();
    const items = Array.isArray(b.items) ? b.items : [];
    // 가벼운 중복방지(클라 재시도 2차 방어): 같은 등록자+픽업일+정규화 업체명으로
    // 최근 90초 내 동일 itemName 집합 요청이 이미 있으면 신규 INSERT 대신 그 요청을 반환.
    try {
      const normName = L.normVendorName(vendorName);
      const itemKey = items.map(it => String((it && it.itemName) || '').trim()).filter(Boolean).sort().join('|');
      const nowMs = Date.now();
      const recent = (P.getMine(getReqUser(req), pickupDate) || []).find(r => {
        if (r.status === 'cancelled') return false;
        if (L.normVendorName(r.vendorName) !== normName) return false;
        const t = Date.parse((r.requestedAt || '').replace(' ', 'T') + 'Z');
        if (!t || (nowMs - t) > 90000 || (nowMs - t) < 0) return false;
        const rKey = (r.items || []).map(it => String((it && it.itemName) || '').trim()).filter(Boolean).sort().join('|');
        return rKey === itemKey;
      });
      if (recent) return res.json(recent);
    } catch (e) { /* dedup 실패는 무시하고 정상 등록 진행 */ }
    const isLate = L.computeIsLate(new Date(), cutoffTime(), pickupDate, todayStr());
    const created = P.create({
      registrarId: getReqUser(req), registrarName: (req.user && req.user.name) || '',
      pickupDate, vendorId, vendorName,
      preferredTimeSlot: b.preferredTimeSlot, priority: b.priority, memo: b.memo,
      sourceType: b.sourceType === 'workflow' ? 'workflow' : 'manual',
      sourceJobId: b.sourceJobId || null, isLate,
    }, items);
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
    const b = safeBody(req.body, ['id']);
    const changes = {};
    // 헤더 필드 — 들어온 것만 반영
    ['pickupDate', 'preferredTimeSlot', 'priority', 'memo'].forEach(k => {
      if (b[k] !== undefined) changes[k] = b[k];
    });
    // 자유 업체명(vendorName) 주면 재매칭 (vendorId null 가능)
    if (b.vendorName !== undefined || b.vendorId !== undefined) {
      const rv = resolveVendor(b.vendorName, b.vendorId);
      if (rv.error) return res.status(400).json({ error: rv.error });
      if (!rv.vendorName) return res.status(400).json({ error: 'vendorName 필수' });
      changes.vendorName = rv.vendorName;
      changes.vendorId = rv.vendorId;
    }
    // items 배열 주면 라인 교체 (db-sqlite update가 트랜잭션·_recompute 처리)
    if (Array.isArray(b.items)) changes.items = b.items;
    const updated = P.update(req.params.id, changes);
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

// ── 삭제 (등록자 본인 또는 admin) — CASCADE로 라인 함께 삭제 ──
router.delete('/requests/:id', requirePerm('pickup_register'), (req, res) => {
  try {
    const P = pickup();
    if (!P) return res.status(503).json({ error: 'SQLite 필요' });
    const cur = P.getById(req.params.id);
    if (!cur) return res.status(404).json({ error: 'not found' });
    if (cur.registrarId !== getReqUser(req) && req.user.role !== 'admin')
      return res.status(403).json({ error: '본인 요청만 삭제 가능' });
    P.delete(req.params.id);
    auditLog(getReqUser(req), '픽업요청 삭제', cur.vendorName);
    res.json({ ok: true, id: req.params.id });
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
    // 픽업은 현장(납품팀) 업무 → 알림 클릭 시 모바일 픽업 화면으로(폰 우선). PC에서 눌러도 동작.
    for (const u of users) notify(u.userId || u.id, 'pickup', message, '/m/pickup.html');
  } catch (e) { /* 알림 실패는 무시 */ }
}

module.exports = router;
