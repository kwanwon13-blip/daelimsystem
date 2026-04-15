/**
 * middleware/audit.js — 감사 로그 & 단가 이력
 */
const db = require('../db');

function auditLog(userId, action, target, detail = {}) {
  try {
    const logs = db.감사로그.load();
    logs.logs.push({
      id: `log_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      시간: new Date().toISOString(),
      사용자: userId || '시스템',
      행동: action,
      대상: target || '',
      상세: detail
    });
    if (logs.logs.length > 10000) logs.logs = logs.logs.slice(-10000);
    db.감사로그.save(logs);
  } catch (e) {
    console.error('[감사로그] 기록 실패:', e.message);
  }
}

function savePriceHistory(userId, catId, catName, vendorId, before, after) {
  try {
    const hist = db['단가이력'].load();
    hist.logs.push({
      id: `ph_${Date.now()}_${Math.random().toString(36).slice(2,5)}`,
      시간: new Date().toISOString(),
      사용자: userId || '시스템',
      품목ID: catId,
      품목명: catName,
      업체ID: vendorId || null,
      변경전: before,
      변경후: after
    });
    if (hist.logs.length > 50000) hist.logs = hist.logs.slice(-50000);
    db['단가이력'].save(hist);
  } catch (e) {
    console.error('[단가이력] 저장 실패:', e.message);
  }
}

module.exports = { auditLog, savePriceHistory };
