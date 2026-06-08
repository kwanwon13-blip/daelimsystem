/**
 * routes/lib/design-indexer.js
 * 시안검색 폴더 증분 인덱스 빌더 + 디스크 캐시 (순수 모듈 — fs/path 만 의존)
 */
const fs = require('fs');
const path = require('path');

const CACHE_VERSION = 1;

// 파일 항목 1개 생성 (routes/design.js 기존 인라인 로직과 동일 shape)
function buildFileItem({ dir, entryName, rootPath, ext, extToType, aiSet }) {
  const fileType = extToType[ext];
  const fullPath = path.join(dir, entryName);
  const rel = path.relative(rootPath, fullPath);
  const parts = rel.split(path.sep);
  const baseName = path.basename(entryName, ext);
  let aiPath = null;
  if (fileType === 'image') {
    let hasAi = aiSet.has(baseName.toLowerCase());
    let aiBaseName = baseName;
    if (!hasAi) {
      const stripped = baseName.replace(/-\d+$/, '');
      if (stripped !== baseName && aiSet.has(stripped.toLowerCase())) {
        hasAi = true; aiBaseName = stripped;
      }
    }
    if (hasAi) aiPath = path.join(dir, aiBaseName + '.ai');
  }
  let mtime = 0;
  try { mtime = fs.statSync(fullPath).mtimeMs; } catch (e) {}
  return {
    path: fullPath, rel, parts, name: entryName,
    aiPath, fileType, ext, mtime,
    searchText: rel.toLowerCase().replace(/[\\/]/g, ' ').replace(/_/g, ' '),
  };
}

// 증분 인덱스 빌드.
// opts: { force, cache(Map), skipDirs(Set), indexedExts(Set), extToType(obj), maxDepth, onProgress(fn) }
// returns { items, dirsScanned, dirsReused }
// 주의: 반환 items 는 cache 와 객체를 공유(참조)한다 — 소비측은 item 을 in-place 변형하지 말 것(불변 취급).
async function buildDesignIndex(rootPath, opts = {}) {
  const {
    force = false,
    cache = new Map(),
    skipDirs = new Set(),
    indexedExts = new Set(),
    extToType = {},
    maxDepth = 8,
    onProgress = null,
  } = opts;

  const items = [];
  const visited = new Set();
  let dirsScanned = 0, dirsReused = 0, dirCount = 0;
  const queue = [{ dir: rootPath, depth: 0 }];

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth > maxDepth) continue;
    visited.add(dir);
    dirCount++;
    if (dirCount % 20 === 0) {
      if (onProgress) onProgress(items.length);
      await new Promise(r => setImmediate(r));
    }

    let curMtime;
    try { curMtime = fs.statSync(dir).mtimeMs; }
    catch (e) { cache.delete(dir); continue; }   // 사라진 폴더

    const cached = cache.get(dir);
    if (!force && cached && cached.mtimeMs === curMtime) {
      dirsReused++;
      for (const it of cached.items) items.push(it);
      for (const sub of cached.subdirs) queue.push({ dir: sub, depth: depth + 1 });
      continue;
    }

    dirsScanned++;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { cache.delete(dir); continue; }

    const aiSet = new Set();
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.ai')) {
        aiSet.add(path.basename(e.name, '.ai').toLowerCase());
      }
    }

    const dirItems = [];
    const subdirs = [];
    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      if (skipDirs.has(entry.name.toLowerCase())) continue;
      if (entry.isDirectory()) {
        const sub = path.join(dir, entry.name);
        subdirs.push(sub);
        queue.push({ dir: sub, depth: depth + 1 });
      } else {
        const ext = path.extname(entry.name).toLowerCase();
        if (!indexedExts.has(ext)) continue;
        dirItems.push(buildFileItem({ dir, entryName: entry.name, rootPath, ext, extToType, aiSet }));
      }
    }
    cache.set(dir, { mtimeMs: curMtime, items: dirItems, subdirs });
    for (const it of dirItems) items.push(it);
  }

  // prune: 이번 실행에서 도달하지 못한 캐시 항목 제거
  for (const key of cache.keys()) {
    if (!visited.has(key)) cache.delete(key);
  }

  return { items, dirsScanned, dirsReused };
}

// designDirCache(Map) → 디스크 저장용 평탄 객체
function serializeCache(cache, designRoot) {
  const dirs = [];
  for (const [dir, entry] of cache.entries()) {
    dirs.push({ dir, mtimeMs: entry.mtimeMs, subdirs: entry.subdirs, items: entry.items });
  }
  return { version: CACHE_VERSION, designRoot, savedAt: new Date().toISOString(), dirs };
}

// 디스크 객체 → { cache(Map), items[] } 또는 null(무효)
function deserializeCache(obj, designRoot) {
  if (!obj || obj.version !== CACHE_VERSION) return null;
  if (obj.designRoot !== designRoot) return null;
  if (!Array.isArray(obj.dirs)) return null;
  const cache = new Map();
  const items = [];
  for (const d of obj.dirs) {
    if (!d || typeof d.dir !== 'string') continue;
    const entry = {
      mtimeMs: d.mtimeMs || 0,
      subdirs: Array.isArray(d.subdirs) ? d.subdirs : [],
      items: Array.isArray(d.items) ? d.items : [],
    };
    cache.set(d.dir, entry);
    for (const it of entry.items) items.push(it);
  }
  return { cache, items };
}

// 파일에서 캐시 로드 (손상/없음/불일치 시 null)
function loadIndexCache(filePath, designRoot) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    return deserializeCache(JSON.parse(raw), designRoot);
  } catch (e) {
    return null;
  }
}

// 파일에 캐시 저장 (임시파일 → rename 원자적 교체)
async function saveIndexCache(filePath, cache, designRoot) {
  const json = JSON.stringify(serializeCache(cache, designRoot));
  const tmp = filePath + '.tmp';
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(tmp, json, 'utf8');
  await fs.promises.rename(tmp, filePath);
}

module.exports = {
  CACHE_VERSION, buildFileItem, buildDesignIndex,
  serializeCache, deserializeCache, loadIndexCache, saveIndexCache,
};
