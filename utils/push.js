/**
 * utils/push.js — 웹푸시(서비스워커 Web Push, VAPID) 발송 유틸
 *
 * 설계 원칙
 *  - web-push 미설치/키없음이어도 서버 기동을 막지 않는다(graceful no-op). npm install web-push 후 재시작하면 활성.
 *  - VAPID 키쌍은 서버 로컬 data/push-vapid.json 에 1회 자동생성·보관(.gitignore 대상, 시크릿). 사람이 키를 다루지 않는다.
 *  - 구독은 db.푸시구독(JSON)에 userId별 endpoint로 저장. 410/404(만료) 응답 구독은 자동 정리.
 *  - sendPushToUsers 는 fire-and-forget — 호출부(알림 저장)의 응답을 막지 않는다.
 */
const fs = require('fs');
const path = require('path');
const db = require('../db');

let webpush = null;
try {
  webpush = require('web-push');
} catch (_) {
  console.warn('[푸시] web-push 미설치 — 웹푸시 비활성(서버는 정상 기동). 활성하려면 npm install web-push 후 재시작.');
}

let vapidPublicKey = '';
let pushReady = false;

if (webpush) {
  try {
    const VAPID_FILE = path.join(__dirname, '..', 'data', 'push-vapid.json');
    let vapid;
    if (fs.existsSync(VAPID_FILE)) {
      vapid = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8'));
    } else {
      vapid = webpush.generateVAPIDKeys();
      fs.writeFileSync(VAPID_FILE, JSON.stringify(vapid, null, 2));
      console.log('[푸시] VAPID 키 신규 생성 → data/push-vapid.json (시크릿)');
    }
    const subject = process.env.VAPID_SUBJECT || 'mailto:admin@daelimsm.com';
    webpush.setVapidDetails(subject, vapid.publicKey, vapid.privateKey);
    vapidPublicKey = vapid.publicKey;
    pushReady = true;
    console.log('[푸시] 웹푸시 활성화 완료');
  } catch (e) {
    console.error('[푸시] VAPID 초기화 실패:', e.message);
  }
}

function getPublicKey() { return vapidPublicKey; }
function isReady() { return pushReady; }

function _load() {
  const store = db.푸시구독.load();
  if (!Array.isArray(store.subscriptions)) store.subscriptions = [];
  return store;
}

// 구독 등록(같은 endpoint면 갱신 — 중복 방지)
function saveSubscription(userId, subscription, ua = '') {
  if (!userId || !subscription || !subscription.endpoint) return false;
  const store = _load();
  store.subscriptions = store.subscriptions.filter(s => s.endpoint !== subscription.endpoint);
  store.subscriptions.push({
    userId: String(userId),
    endpoint: subscription.endpoint,
    keys: subscription.keys || {},
    ua: String(ua || '').slice(0, 200),
    생성시간: new Date().toISOString(),
  });
  if (store.subscriptions.length > 3000) store.subscriptions = store.subscriptions.slice(-3000);
  db.푸시구독.save(store);
  return true;
}

function countForUser(userId) {
  try { const id = String(userId || ''); return _load().subscriptions.filter(s => String(s.userId) === id).length; }
  catch (_) { return 0; }
}

function removeSubscription(endpoint) {
  if (!endpoint) return;
  const store = _load();
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter(s => s.endpoint !== endpoint);
  if (store.subscriptions.length !== before) db.푸시구독.save(store);
}

function _removeEndpoints(endpoints) {
  if (!endpoints || !endpoints.length) return;
  const store = _load();
  const set = new Set(endpoints);
  const before = store.subscriptions.length;
  store.subscriptions = store.subscriptions.filter(s => !set.has(s.endpoint));
  if (store.subscriptions.length !== before) db.푸시구독.save(store);
}

/**
 * userIds(배열 또는 단일)의 모든 구독 기기로 푸시 발송.
 * payload: { title, body, link, tag, jobId? }
 * fire-and-forget: 발송은 백그라운드, 즉시 반환.
 */
function sendPushToUsers(userIds, payload) {
  try {
    if (!pushReady || !webpush) return;
    const ids = new Set((Array.isArray(userIds) ? userIds : [userIds]).map(x => String(x || '')).filter(Boolean));
    if (!ids.size) return;
    const store = _load();
    const targets = store.subscriptions.filter(s => ids.has(String(s.userId)));
    if (!targets.length) return;
    const body = JSON.stringify(payload || {});
    const dead = [];
    Promise.allSettled(targets.map(s =>
      webpush.sendNotification({ endpoint: s.endpoint, keys: s.keys }, body)
        .catch(err => {
          const code = err && err.statusCode;
          if (code === 404 || code === 410) dead.push(s.endpoint); // 만료/해지된 구독
          // 그 외 일시 오류는 무시(다음 발송 때 재시도 효과)
        })
    )).then(() => { if (dead.length) _removeEndpoints(dead); }).catch(() => {});
  } catch (e) {
    console.error('[푸시] 발송 실패:', e.message);
  }
}

module.exports = { getPublicKey, isReady, saveSubscription, removeSubscription, sendPushToUsers, countForUser };
