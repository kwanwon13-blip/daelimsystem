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

module.exports = { CACHE_VERSION, buildFileItem, buildDesignIndex };
