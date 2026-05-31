/**
 * lib/generation-registry.js — 진행 중인 AI 답변 생성 레지스트리
 *
 * 목적: claude.ai 웹처럼 "안 끊기는 경험" — 답변 생성을 클라이언트 연결과 분리.
 *   · 생성은 서버에서 끝까지 진행 (브라우저 새로고침/창닫기/다른PC 와 무관)
 *   · 여러 구독자(원래 요청 + 나중에 attach 한 다른 탭/기기)가 같은 생성 스트림을 공유
 *   · 명시적 stop 만 생성을 취소. 단순 연결 끊김(close)은 취소가 아님.
 *
 * 단일 Node 프로세스 메모리 Map 으로 충분 (동시 사용자 ~10명, 외부 큐/redis 불필요).
 * 영속성은 db-ai.js 의 부분저장(updateMessageContent)/확정(finalizeMessage)이 담당.
 *
 * 키 = messageId (ai_messages.id). attach/stop/복원 모두의 자연 키.
 *
 * rec 구조:
 *   { threadId, ownerId, abort, getAccumulated, status, subscribers:Set<fn>, doneEvent }
 *     - abort()          : 생성 중단 함수 (라우터가 streamPromise.abort 를 연결)
 *     - getAccumulated() : 지금까지 누적된 전체 텍스트 (attach 시 snapshot 으로 전송)
 *     - status           : 'generating' | 'ok' | 'interrupted' | 'error'
 *     - subscribers      : SSE write 콜백 (event, data) 집합 — fan-out
 *     - doneEvent        : finish 시 done/error payload (늦은 attach 가 즉시 받도록)
 */

const gens = new Map();

/** 생성 시작 — 레지스트리에 등록 */
function start(messageId, info = {}) {
  const rec = {
    threadId: info.threadId,
    ownerId: info.ownerId,
    abort: info.abort || null,
    getAccumulated: info.getAccumulated || (() => ''),
    status: 'generating',
    subscribers: new Set(),
    doneEvent: null,
  };
  gens.set(messageId, rec);
  return rec;
}

function get(messageId) {
  return gens.get(messageId);
}

/**
 * 구독 — fn(event, data) 가 publish 마다 호출됨.
 * 반환된 unsubscribe 는 구독만 해제. (절대 abort 하지 않음 — 연결 끊김 ≠ 생성 취소)
 */
function subscribe(messageId, fn) {
  const rec = gens.get(messageId);
  if (!rec) return () => {};
  rec.subscribers.add(fn);
  return () => { try { rec.subscribers.delete(fn); } catch (_) {} };
}

/** 모든 구독자에게 SSE 이벤트 fan-out */
function publish(messageId, event, data) {
  const rec = gens.get(messageId);
  if (!rec) return;
  for (const fn of rec.subscribers) {
    try { fn(event, data); } catch (_) {}
  }
}

/**
 * 명시적 중단 (stop API 전용). status='interrupted' 마킹 후 child kill.
 * 실제 'interrupted' 저장은 라우터 catch 의 finalizeMessage 가 수행.
 */
function abort(messageId) {
  const rec = gens.get(messageId);
  if (!rec) return false;
  rec.status = 'interrupted';
  try { if (typeof rec.abort === 'function') rec.abort(); } catch (_) {}
  return true;
}

/**
 * 생성 종료 — done/error 이벤트 publish 후 잠깐 유지하다 GC.
 * 15초 유지: 생성 직후 attach 한 늦은 구독자도 done 을 받게 함.
 */
function finish(messageId, finalStatus, doneEvent) {
  const rec = gens.get(messageId);
  if (!rec) return;
  rec.status = finalStatus || 'ok';
  rec.doneEvent = doneEvent || null;
  publish(messageId, finalStatus === 'ok' ? 'done' : 'error', doneEvent || {});
  setTimeout(() => { gens.delete(messageId); }, 15000);
}

/** 모니터링/디버그용 */
function stats() {
  let generating = 0;
  for (const rec of gens.values()) if (rec.status === 'generating') generating++;
  return { total: gens.size, generating };
}

module.exports = { start, get, subscribe, publish, abort, finish, stats, gens };
