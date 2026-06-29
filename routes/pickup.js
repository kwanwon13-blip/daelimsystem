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
let realtime = { send: () => {} };
try { realtime = require('../utils/realtime') || realtime; } catch (e) {}

// ── [일회용·관리] 매입처 일괄 등록 (requireAuth 위 — control-secret 게이트) ──
// 사장님 로그인(세션) 없이 배포 자동화로 호출. git-pull/restart 와 동일 .env CONTROL_DAEMON_SECRET 사용.
//   POST /api/pickup/import-vendors   헤더 x-control-secret: <secret>
//   바디 { vendors:[{name,address,phone,contactPerson,freq6mo?}], vendorType?='매입처', dryRun? }
// upsert: 정규화 업체명(L.normVendorName) 일치하면 기존 보강(빈 필드만)+매입처 표시, 없으면 생성.
//   - 기존 vendorType 이 '기타'(기본)일 때만 '매입처'로 표시 → 매출처 등 기존 분류 보존.
//   - 같은 배치 내 중복도 정규화로 1건만 생성. dryRun=true 면 쓰지 않고 집계만.
router.post('/import-vendors', express.json({ limit: '4mb' }), (req, res) => {
  try {
    const ctrl = req.headers['x-control-secret'];
    const expected = process.env.CONTROL_DAEMON_SECRET;
    if (!expected || !ctrl || ctrl !== expected) return res.status(401).json({ error: 'unauthorized' });
    if (!db.sql || !db.sql.vendors) return res.status(503).json({ error: 'SQLite 필요(better-sqlite3 미설치)' });
    const b = req.body || {};
    // [점검] 중복 후보만 반환(쓰기 X) — { mode:'dupes' }. 클라 '중복 찾기'와 동일 로직(정규화 동일 + 한쪽이 다른쪽 포함).
    if (b.mode === 'dupes') {
      const all = db.sql.vendors.getAll() || [];
      const arr = all.map(v => ({ name: v.name, type: v.vendorType || '기타', n: L.normVendorName(v.name) })).filter(x => x.n.length >= 2);
      const pairs = [];
      for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i], c = arr[j];
        if (a.n === c.n) pairs.push({ kind: '동일', a: a.name, at: a.type, b: c.name, bt: c.type });
        else { const sh = a.n.length <= c.n.length ? a.n : c.n; const lo = a.n.length <= c.n.length ? c.n : a.n; if (sh.length >= 2 && lo.indexOf(sh) !== -1) pairs.push({ kind: '포함', a: a.name, at: a.type, b: c.name, bt: c.type }); }
      }
      pairs.sort((x, y) => (x.kind === '동일' ? 0 : 1) - (y.kind === '동일' ? 0 : 1));
      return res.json({ totalVendors: all.length, dupePairs: pairs.length, pairs });
    }
    const list = Array.isArray(b.vendors) ? b.vendors : [];
    const vendorType = String(b.vendorType || '매입처');
    const dryRun = !!b.dryRun;
    const byNorm = new Map();
    for (const v of (db.sql.vendors.getAll() || [])) byNorm.set(L.normVendorName(v.name), v);
    const report = { total: list.length, created: 0, merged: 0, skipped: 0, dryRun, samples: [] };
    for (const raw of list) {
      const name = String((raw && raw.name) || '').trim();
      if (!name) { report.skipped++; continue; }
      const norm = L.normVendorName(name);
      const found = byNorm.get(norm);
      const address = String((raw && raw.address) || '').trim();
      const phone = String((raw && raw.phone) || '').trim();
      const contactPerson = String((raw && raw.contactPerson) || '').trim();
      const mapKw = address || name;
      if (found) {
        const ch = {};
        if ((found.vendorType || '기타') === '기타') ch.vendorType = vendorType;
        if (!found.address && address) ch.address = address;
        if (!found.phone && phone) ch.phone = phone;
        if (!found.contactPerson && contactPerson) ch.contactPerson = contactPerson;
        if (!found.mapSearchKeyword && mapKw) ch.mapSearchKeyword = mapKw;
        if (!dryRun && Object.keys(ch).length) db.sql.vendors.update(found.id, ch);
        report.merged++;
        if (report.samples.length < 8) report.samples.push({ name, action: 'merge', id: found.id });
      } else {
        if (!dryRun) {
          const created = db.sql.vendors.create({
            name, address, phone, contactPerson, vendorType,
            mapSearchKeyword: mapKw, isActive: 1,
          });
          byNorm.set(norm, created);
        }
        report.created++;
        if (report.samples.length < 8) report.samples.push({ name, action: 'create' });
      }
    }
    res.json(report);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
  // 마감(추가요청 기준) 기본 13:00 — 13시 이후 같은날 등록분만 '추가요청'(isLate)로 표시·알림.
  try { return (db['설정'] && db['설정'].load().pickup || {}).cutoffTime || '13:00'; }
  catch (e) { return '13:00'; }
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
    // 알림은 마감(기본 13:00) 이후 '추가요청'에서만 — 영업지원팀에게. 매 등록/매 업체마다 X.
    // 한 번 등록에 업체가 여러 개여도(순차 POST) 등록자별로 묶어 알림 1건(queueLateNotify).
    if (isLate) queueLateNotify(getReqUser(req), vendorName, pickupDate);
    notifyPickupViewers(pickupDate, getReqUser(req));   // 그 날짜 보는 사람 화면 실시간 새로고침
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
    notifyPickupViewers((updated && updated.pickupDate) || cur.pickupDate, getReqUser(req));
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
    notifyPickupViewers(cur.pickupDate, getReqUser(req));
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
    notifyPickupViewers(cur.pickupDate, getReqUser(req));
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
    }, (req.user && req.user.name) || getReqUser(req));   // checkedBy=이름(완료자 표시·동시작업 추적)
    if (!updated) return res.status(404).json({ error: 'item not found' });
    notifyPickupViewers(updated && updated.pickupDate, getReqUser(req));   // 동료 화면에 체크 즉시 반영(중복 픽업 방지)
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

// ── 실시간: 픽업 변경 시 그 날짜를 보는 사용자(pickup_view/check/admin)의 열린 화면에 새로고침 신호 ──
// 등록/상태변경/취소/수정/삭제 직후 호출. 행위자(exceptUserId)는 본인 화면이 이미 반영돼 있어 제외(불필요 리로드 방지).
// 클라(/m/pickup.html, 데스크톱 취합)는 SSE(/api/workflow/events)에서 이 신호를 받아 디바운스 후 load(). 동료 체크 즉시 반영 → 중복 픽업 방지.
function notifyPickupViewers(date, exceptUserId) {
  try {
    const users = (db['조직관리'].load().users || []).filter(u =>
      u && u.status === 'approved' && (u.role === 'admin'
        || (u.permissions || []).includes('pickup_view') || (u.permissions || []).includes('pickup_check')));
    for (const u of users) {
      const uid = u.userId || u.id;
      if (!uid || uid === exceptUserId) continue;
      try { realtime.send(uid, { t: 'pickup', date: date || '' }); } catch (_) {}
    }
  } catch (_) { /* 실시간 신호 실패는 무시(폴링 백스톱 있음) */ }
}

// ── 알림: 영업지원팀(부서)에게만 — 13시 이후 '추가요청' 발생 시 (best-effort) ──
// 매 등록마다가 아니라 마감 이후 추가요청에서만 호출(라우트 isLate 게이트). 수신자=영업지원팀 부서원(없으면 admin 폴백).
function notifySalesSupport(message) {
  try {
    const ids = L.salesSupportUserIds(db['조직관리'].load());
    // 픽업은 현장 업무 → 알림 클릭 시 모바일 픽업 화면으로(폰 우선). PC에서 눌러도 동작.
    for (const uid of ids) notify(uid, 'pickup', message, '/m/pickup.html');
  } catch (e) { /* 알림 실패는 무시 */ }
}

// ── '추가요청' 알림 합치기 — 한 번 등록(여러 업체를 순차 POST)이 알림 1건이 되도록 ──
// registrarId별로 짧은 창(4초, 마지막 POST 기준 trailing) 동안 들어온 업체명을 모아 한 번만 통지.
// 같은 사람이 한 번에 여러 업체를 올려도 "라코스 외 N건"으로 1건. 다른 사람/시간차(>4초)는 각각.
const _lateNotifyBuf = new Map(); // registrarId -> { vendors:Set, date, timer }
function queueLateNotify(registrarId, vendorName, pickupDate) {
  const key = registrarId || 'unknown';
  let buf = _lateNotifyBuf.get(key);
  if (!buf) { buf = { vendors: new Set(), date: pickupDate, timer: null }; _lateNotifyBuf.set(key, buf); }
  if (vendorName) buf.vendors.add(vendorName);
  if (pickupDate) buf.date = pickupDate;
  if (buf.timer) clearTimeout(buf.timer);
  buf.timer = setTimeout(() => {
    _lateNotifyBuf.delete(key);
    const names = Array.from(buf.vendors);
    if (!names.length) return;
    const head = names[0] + (names.length > 1 ? ` 외 ${names.length - 1}건` : '');
    notifySalesSupport(`🔴 추가요청 — ${head} 픽업 (${buf.date || ''})`);
  }, 4000);
  if (buf.timer && buf.timer.unref) buf.timer.unref(); // 대기 타이머가 프로세스 종료를 막지 않게
}

module.exports = router;
