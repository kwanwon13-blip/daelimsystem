/**
 * utils/notify.js — 알림 유틸
 * notify(), notifyRole()
 */
const db = require('../db');

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
}

function notifyRole(role, type, message, link = '') {
  try {
    const org = db.loadUsers();
    (org.users || []).filter(u => u.role === role && u.status === 'approved')
      .forEach(u => notify(u.userId, type, message, link));
  } catch (e) {}
}

module.exports = { notify, notifyRole };
