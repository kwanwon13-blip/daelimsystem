/**
 * middleware/sanitize.js — 요청 본문 Mass Assignment / Prototype Pollution 방어
 *
 * 용도:
 *   1) safeBody(req.body)                       — prototype 조작 필드 제거
 *   2) safeBody(req.body, ['role','status'])    — 추가로 지정된 필드도 제거
 *
 * 반환값은 항상 새 객체(원본 불변).
 * 배열/객체 내부는 재귀적으로 정화한다.
 */

// prototype 체인을 오염시키는 데 쓰일 수 있는 키들
const PROTO_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function sanitizeRecursive(value, extraBlockSet, depth) {
  if (depth > 10) return null; // 비정상적으로 깊은 객체 차단
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map(v => sanitizeRecursive(v, extraBlockSet, depth + 1));
  }
  if (typeof value !== 'object') return value;

  // Buffer 같은 특수 객체는 그대로 통과 (현실적으로 req.body에는 거의 없지만 안전 차원)
  if (Buffer.isBuffer(value)) return value;

  const out = Object.create(null); // prototype이 null인 "순수" 객체로 생성
  for (const k of Object.keys(value)) {
    if (PROTO_KEYS.has(k)) continue;
    if (extraBlockSet && extraBlockSet.has(k)) continue;
    out[k] = sanitizeRecursive(value[k], extraBlockSet, depth + 1);
  }
  return out;
}

/**
 * @param {any} body - 정화할 원본 (대개 req.body)
 * @param {string[]} [blockList] - 제거할 추가 필드 이름 배열
 * @returns {any} 정화된 복사본
 */
function safeBody(body, blockList) {
  const extra = Array.isArray(blockList) && blockList.length > 0
    ? new Set(blockList)
    : null;
  return sanitizeRecursive(body, extra, 0);
}

module.exports = { safeBody };
