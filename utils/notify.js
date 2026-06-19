/**
 * utils/notify.js — 알림 유틸
 * notify(), notifyRole()
 */
const db = require('../db');
const push = require('./push');
const realtime = require('./realtime');

// notify()의 link(앱 내부 표기)를 푸시 클릭 시 열 URL + 묶음 tag로 변환
function pushTargetFromLink(type, link) {
  const s = String(link || '');
  if (type === 'workflow' || s.startsWith('workflow:')) {
    const jobId = s.startsWith('workflow:') ? (s.split(':')[1] || '') : '';
    return { url: '/#workflow', tag: jobId ? 'wf-' + jobId : 'wf' }; // 같은 작업 알림은 하나로 묶임
  }
  if (s.startsWith('#')) return { url: '/' + s, tag: type || 'erp' };
  if (s.startsWith('/')) return { url: s, tag: type || 'erp' };
  return { url: '/', tag: type || 'erp' };
}

const PUSH_TITLES = { workflow: '워크플로우 알림', approval: '결재 알림', quote: '견적 알림' };

function notify(targetUserId, type, message, link = '') {
  try {
    const notifs = db.알림.load();
    notifs.notifications.push({
      id: `notif_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      대상: targetUserId,
      유형: type,
      메시지: message,
      링크: link,
      읽음: false,
      생성시간: new Date().toISOString()
    });
    // 전체 5,000건 제한
    if (notifs.notifications.length > 5000) notifs.notifications = notifs.notifications.slice(-5000);
    db.알림.save(notifs);
  } catch (e) {
    console.error('[알림] 저장 실패:', e.message);
  }
  // 변화 즉시 통지(열린 탭) — SSE로 그 사용자의 열린 ERP 탭에 바로 신호. 폴링 30초를 기다리지 않음.
  try { realtime.send(targetUserId, { t: 'notify', type }); } catch (_) {}
  // 웹푸시(탭 닫혀도 OS 알림) — 구독한 기기로 발송. 미구독/미설치면 자동 no-op. 저장과 독립(실패해도 무방).
  try {
    const t = pushTargetFromLink(type, link);
    push.sendPushToUsers([targetUserId], {
      title: PUSH_TITLES[type] || '대림에스엠 ERP',
      body: String(message || '').slice(0, 200),
      link: t.url,
      tag: t.tag,
    });
  } catch (_) {}
}

function notifyRole(role, type, message, link = '') {
  try {
    const org = db.loadUsers();
    (org.users || []).filter(u => u.role === role && u.status === 'approved')
      .forEach(u => notify(u.userId, type, message, link));
  } catch (e) {}
}

module.exports = { notify, notifyRole };
