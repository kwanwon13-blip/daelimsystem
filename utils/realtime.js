/**
 * utils/realtime.js — 변화 즉시 통지용 SSE(Server-Sent Events) 허브
 *
 * 목적: 열린 ERP 탭이 30초 폴링을 기다리지 않고, 서버에서 변화가 생긴 순간 통지를 받게 한다.
 *  - notify()가 send(userId, …)를 호출 → 그 사용자의 열린 탭(들)에 즉시 이벤트 전송.
 *  - http/https 모두 동작, 권한 불필요(웹푸시와 보완 관계: 탭 열림=SSE, 탭 닫힘=웹푸시).
 *  - 연결이 없거나 실패해도 무해(no-op). 프론트의 폴링은 백스톱으로 남는다.
 */
const clients = new Map(); // userId -> Set<res>

// SSE 응답 등록. 반환된 함수를 호출하면 해제(연결 종료 시).
function addClient(userId, res) {
  const uid = String(userId || '');
  if (!uid) return () => {};
  if (!clients.has(uid)) clients.set(uid, new Set());
  clients.get(uid).add(res);
  return () => {
    const s = clients.get(uid);
    if (s) { s.delete(res); if (!s.size) clients.delete(uid); }
  };
}

// 특정 사용자의 모든 열린 탭에 데이터 전송
function send(userId, data) {
  try {
    const s = clients.get(String(userId || ''));
    if (!s || !s.size) return;
    const payload = `data: ${JSON.stringify(data || {})}\n\n`;
    for (const res of s) { try { res.write(payload); } catch (_) {} }
  } catch (_) {}
}

function stats() {
  let n = 0;
  for (const s of clients.values()) n += s.size;
  return { users: clients.size, connections: n };
}

module.exports = { addClient, send, stats };
