/**
 * routes/lib/workflow-file-locator.js
 * 워크플로우 파일 디스크 경로 해석 + 존재여부 캐시 (순수 모듈 — fs/path + 주입 의존)
 *
 * 왜 존재하나:
 *   기존 fileDiskPath 는 design 파일마다 resolveWorkflowDesignStorage(= 네트워크 디자인 폴더
 *   풀스캔)를 "무조건" 먼저 호출해 후보 경로를 만들었다. 업로드 시 이미 storedPath(절대경로)가
 *   저장되는데도 매번 풀스캔이 돌아, 목록/상세 1회 로드에 수백~수천 번의 네트워크 I/O 가 발생했다.
 *
 * 이 모듈의 두 가지 절약:
 *   1) 지연 평가(lazy): 싼 후보(저장된 절대경로/디렉터리)가 실제로 존재하면 거기서 끝낸다.
 *      비싼 네트워크 스캔(resolveDesignStorage)은 싼 후보가 모두 실패할 때만 폴백으로 호출.
 *   2) 캐시(memo): 파일 존재여부 + (회사|프로젝트|연도) 폴더 해석 결과를 짧은 TTL 로 기억해
 *      같은 요청 안/요청 간 반복 stat·스캔을 제거한다. (시안검색 디스크캐시와 같은 철학)
 *
 * 순수성: fs / now / 의존 함수 모두 주입 가능 → 단위 테스트에서 네트워크/디자인 모듈 없이 검증.
 */
const fsDefault = require('fs');
const path = require('path');

function createFileLocator(deps = {}) {
  const {
    fs = fsDefault,
    fileDir,                  // FILE_DIR (절대경로)
    getDesignRoot,            // () => 디자인 루트 (문자열)
    resolveDesignStorage,     // (companyName, projectName, year) => { dir } | null  (비쌈: 네트워크 스캔)
    safeFilePart,             // (value, fallback) => string
    isPathInside,             // (root, target) => boolean  (보안 경계)
    existsTtlMs = 60 * 1000,
    resolveTtlMs = 60 * 1000,
    now = () => Date.now(),
  } = deps;

  if (!fileDir) throw new Error('createFileLocator: fileDir required');

  const existsMemo = new Map();   // fileKey -> { exists, at }
  const resolveMemo = new Map();  // company|project|year -> { info, at }
  let stats = emptyStats();

  function emptyStats() {
    return { diskPathCalls: 0, cheapHits: 0, expensiveResolves: 0, existsChecks: 0, existsMemoHits: 0 };
  }

  function designRoot() {
    const r = typeof getDesignRoot === 'function' ? getDesignRoot() : getDesignRoot;
    return path.resolve(r || 'D:\\');
  }

  // FILE_DIR 또는 디자인 루트 안에 있는 경로만 허용 (디렉터리 트래버설 방지)
  function allowedPath(fullPath) {
    if (!fullPath) return null;
    const full = path.resolve(fullPath);
    const wfRoot = path.resolve(fileDir);
    if (full !== wfRoot && isPathInside(wfRoot, full)) return full;
    const dRoot = designRoot();
    if (full !== dRoot && isPathInside(dRoot, full)) return full;
    return null;
  }

  // 네트워크 스캔이 필요 없는 후보들 (순수 경로 계산)
  function cheapCandidates(file) {
    const candidates = [];
    const raw = String(file?.storedPath || file?.storedName || '');
    if (raw) {
      if (path.isAbsolute(raw)) candidates.push(raw);
      else candidates.push(path.resolve(fileDir, raw.replace(/\\/g, '/')));
    }
    if (file?.storagePath) {
      if (file.storedName) candidates.push(path.join(file.storagePath, file.storedName));
      if (file.originalName) candidates.push(path.join(file.storagePath, safeFilePart(file.originalName, file.storedName || file.id || 'file')));
    }
    if (file?.storageRoot === 'design' && file?.storageBucket) {
      const dRoot = designRoot();
      if (file.storedName) candidates.push(path.resolve(dRoot, file.storageBucket, file.storedName));
      if (file.originalName) candidates.push(path.resolve(dRoot, file.storageBucket, safeFilePart(file.originalName, file.storedName || file.id || 'file')));
    }
    return candidates;
  }

  // 비싼 폴백: (회사|프로젝트|연도) 폴더 해석 — TTL 메모로 같은 프로젝트는 1회만 스캔
  function resolveDesignMemoized(file) {
    if (typeof resolveDesignStorage !== 'function') return null;
    const key = `${file.storageCompanyName}|${file.storageProjectName}|${file.storageYear || ''}`;
    const hit = resolveMemo.get(key);
    if (hit && (now() - hit.at) < resolveTtlMs) return hit.info;
    let info = null;
    try { info = resolveDesignStorage(file.storageCompanyName, file.storageProjectName, file.storageYear); }
    catch (_) { info = null; }
    stats.expensiveResolves++;
    resolveMemo.set(key, { info, at: now() });
    return info;
  }

  function expensiveCandidates(file) {
    const candidates = [];
    if (file?.storageRoot === 'design' && file?.storageCompanyName && file?.storageProjectName) {
      const info = resolveDesignMemoized(file);
      if (info?.dir) {
        if (file.storedName) candidates.push(path.resolve(info.dir, file.storedName));
        if (file.originalName) candidates.push(path.resolve(info.dir, safeFilePart(file.originalName, file.storedName || file.id || 'file')));
      }
    }
    return candidates;
  }

  // { path, exists } 반환. 싼 후보 먼저, 모두 실패 시에만 비싼 폴백.
  function resolveOne(file) {
    stats.diskPathCalls++;
    let firstAllowed = null;
    for (const candidate of cheapCandidates(file)) {
      const allowed = allowedPath(candidate);
      if (!allowed) continue;
      if (!firstAllowed) firstAllowed = allowed;
      stats.existsChecks++;
      if (fs.existsSync(allowed)) { stats.cheapHits++; return { path: allowed, exists: true }; }
    }
    for (const candidate of expensiveCandidates(file)) {
      const allowed = allowedPath(candidate);
      if (!allowed) continue;
      if (!firstAllowed) firstAllowed = allowed;
      stats.existsChecks++;
      if (fs.existsSync(allowed)) return { path: allowed, exists: true };
    }
    return { path: firstAllowed, exists: false };
  }

  function fileKey(file) {
    return file?.id || file?.storedPath || file?.storedName || '';
  }

  // 파일 서빙용: 존재하면 그 경로, 없으면 firstAllowed(404 처리는 호출측이) — 메모 안 씀(실시간)
  function diskPath(file) {
    return resolveOne(file).path;
  }

  // 표시용 존재여부: TTL 메모. 같은 파일 반복 호출은 stat 0회.
  function exists(file) {
    const key = fileKey(file);
    if (key) {
      const hit = existsMemo.get(key);
      if (hit && (now() - hit.at) < existsTtlMs) { stats.existsMemoHits++; return hit.exists; }
    }
    const result = resolveOne(file);
    if (key) existsMemo.set(key, { exists: result.exists, at: now() });
    return result.exists;
  }

  function invalidateFile(file) {
    const key = fileKey(file);
    if (key) existsMemo.delete(key);
  }

  function invalidateResolve(companyName, projectName, year) {
    resolveMemo.delete(`${companyName}|${projectName}|${year || ''}`);
  }

  function clear() { existsMemo.clear(); resolveMemo.clear(); }
  function snapshotStats() { return { ...stats }; }

  return {
    diskPath,
    exists,
    invalidateFile,
    invalidateResolve,
    clear,
    snapshotStats,
    // 테스트/디버깅용
    _existsMemo: existsMemo,
    _resolveMemo: resolveMemo,
  };
}

module.exports = { createFileLocator };
