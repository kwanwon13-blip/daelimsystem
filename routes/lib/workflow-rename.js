'use strict';

// 현장명 변경(팀장 승인제) — 폴더/경로 문자열 치환 순수 로직 (fs 없음 → 단위 테스트 용이)
//
// 변경 실행 시 해야 하는 일:
//   1) 디스크 프로젝트 폴더 rename (leaf 이름에 옛 현장명이 들어있으면 그 부분만 치환 — 장식 보존)
//   2) 같은 현장(회사+현장명)의 모든 작업·파일이 들고 있는 절대경로/버킷 문자열을 새 폴더로 치환

// 폴더 leaf 이름 치환: "(수방사)25-A-00부대 시설공사(1028)" 처럼 장식이 붙은 폴더명에서
// 옛 현장명 부분만 새 이름으로 바꾼다. 마지막 1회만 치환 — 장식 문자열 내부의 부분일치를
// 같이 바꾸는 사고 방지(감사 #8). 옛 이름이 안 들어있으면 새 이름 그대로.
function buildRenamedLeaf(oldLeaf, oldName, newName) {
  const leaf = String(oldLeaf || '');
  const from = String(oldName || '');
  const to = String(newName || '');
  if (!leaf) return to;
  if (from) {
    const idx = leaf.lastIndexOf(from);
    if (idx >= 0) return leaf.slice(0, idx) + to + leaf.slice(idx + from.length);
  }
  return to;
}

// 절대경로 prefix 치환 — Windows 대소문자 무시. oldDir 바로 다음이 경로 구분자일 때만(부분일치 방지).
function replacePathPrefix(value, oldDir, newDir) {
  const v = String(value || '');
  const from = String(oldDir || '');
  const to = String(newDir || '');
  if (!v || !from || !to) return v;
  const lv = v.toLowerCase();
  const lo = from.toLowerCase();
  if (lv === lo) return to;
  if (lv.startsWith(lo)) {
    const next = v.charAt(from.length);
    if (next === '\\' || next === '/') return to + v.slice(from.length);
  }
  return v;
}

// 상대 버킷("★회사\\2026 시안작업\\현장폴더") 안의 폴더 leaf 이름 치환
function replaceBucketLeaf(bucket, oldLeaf, newLeaf) {
  const b = String(bucket || '');
  const from = String(oldLeaf || '');
  const to = String(newLeaf || '');
  if (!b || !from || !to) return b;
  const parts = b.split(/[\\/]/);
  let changed = false;
  for (let i = 0; i < parts.length; i++) {
    if (parts[i] === from) { parts[i] = to; changed = true; }
  }
  return changed ? parts.join('\\') : b;
}

module.exports = { buildRenamedLeaf, replacePathPrefix, replaceBucketLeaf };
