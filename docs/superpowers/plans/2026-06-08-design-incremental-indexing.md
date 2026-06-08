# 시안검색 폴더 증분 인덱싱 + 디스크 캐시 — 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 시안검색 재인덱싱이 매번 `D:\` 전체를 다시 읽는 것을, 변경된 폴더만 재스캔하는 증분 방식으로 바꾸고, 인덱스를 디스크에 영속화해 서버 재시작 직후에도 즉시 검색되게 한다.

**Architecture:** 인덱싱 핵심 로직을 순수 모듈 `routes/lib/design-indexer.js`로 분리한다(기존 `routes/lib/` 관례 일치 + 단위 테스트 가능). `routes/design.js`는 이 모듈을 호출하는 얇은 소비자로 남고, 폴더별 mtime 캐시(`Map`)와 디스크 캐시 파일(`data/design-index-cache.json`)을 오케스트레이션한다. 외부 인터페이스(item 객체 구조, API 응답, 프론트엔드)는 불변.

**Tech Stack:** Node.js (v24), Express 라우터, 내장 `node:test`/`node:assert` (의존성 추가 없음), `fs`/`path`.

**참고 스펙:** [docs/superpowers/specs/2026-06-08-design-incremental-indexing-design.md](docs/superpowers/specs/2026-06-08-design-incremental-indexing-design.md)

**커밋 규칙:** 모든 커밋은 `-m` 두 번째에 `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>` 트레일러를 포함한다(각 스텝 명령에 명시).

**구조 결정 메모:** 스펙은 "routes/design.js 단일 파일"이라 했으나, 그 파일은 require 시 `../db`·`../middleware/auth`를 로드하고 `startDesignIndexer()`가 자동 실행되어 단위 테스트가 불가능하다. 따라서 순수 로직을 `routes/lib/design-indexer.js`로 분리한다 — 이는 이미 존재하는 `routes/lib/design-workflow-storage.js`, `design-parser.js`, `workflow-storage-rules.js`와 동일한 관례다. item shape의 `searchText`는 Windows 경로 구분자 `\`만 치환하던 것을 `[\\/]`로 바꿔 OS 무관하게 동작시킨다(Windows 출력은 기존과 바이트 동일 — 운영 영향 없음, 테스트가 Linux 샌드박스에서 통과하게 함).

---

## 파일 구조

| 파일 | 책임 | 작업 |
|------|------|------|
| `routes/lib/design-indexer.js` | 증분 인덱스 빌드 + 디스크 캐시 직렬화/로드 (순수, fs/path만 의존) | 생성 |
| `routes/lib/design-indexer.test.js` | buildDesignIndex 동작(스캔/필터/증분/prune) 검증 | 생성 |
| `routes/lib/design-indexer.cache.test.js` | 디스크 캐시 직렬화/로드/저장 검증 | 생성 |
| `routes/design.js` | HTTP 라우트 + 캐시/타이머 오케스트레이션 (얇은 소비자) | 수정 |
| `data/design-index-cache.json` | 파생 캐시(런타임 생성) | 자동 생성 |

---

## Task 1: 증분 인덱스 빌더 (`design-indexer.js` 코어)

**Files:**
- Create: `routes/lib/design-indexer.js`
- Test: `routes/lib/design-indexer.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

`routes/lib/design-indexer.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { buildDesignIndex } = require('./design-indexer');

// routes/design.js 의 실제 상수와 동일한 형태
const INDEXED_EXTS = new Set(['.jpg', '.png', '.pdf', '.ai', '.psd', '.xlsx']);
const EXT_TO_TYPE = { '.jpg': 'image', '.png': 'image', '.pdf': 'pdf', '.ai': 'ai', '.psd': 'psd', '.xlsx': 'excel' };
const SKIP_DIRS = new Set(['node_modules', 'thumbs']);

function mkTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'didx-'));
  fs.writeFileSync(path.join(root, 'a.png'), 'x');
  fs.writeFileSync(path.join(root, 'note.txt'), 'x');            // 비대상 확장자
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'sub', 'b.pdf'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'logo.ai'), 'x');
  fs.writeFileSync(path.join(root, 'sub', 'logo.png'), 'x');     // logo.ai 와 연결
  fs.mkdirSync(path.join(root, 'node_modules'));                 // SKIP
  fs.writeFileSync(path.join(root, 'node_modules', 'c.png'), 'x');
  return root;
}

function opts(extra) {
  return Object.assign({
    cache: new Map(), skipDirs: SKIP_DIRS, indexedExts: INDEXED_EXTS,
    extToType: EXT_TO_TYPE, maxDepth: 8,
  }, extra || {});
}

const bump = (p) => { const t = new Date(Date.now() + 5000); fs.utimesSync(p, t, t); };

test('basic: 대상 파일만 인덱싱, 비대상/SKIP 폴더 제외', async () => {
  const root = mkTree();
  const { items } = await buildDesignIndex(root, opts());
  const names = items.map(i => i.name).sort();
  assert.deepStrictEqual(names, ['a.png', 'b.pdf', 'logo.ai', 'logo.png']);
});

test('basic: item 필드 shape', async () => {
  const root = mkTree();
  const { items } = await buildDesignIndex(root, opts());
  const png = items.find(i => i.name === 'a.png');
  assert.strictEqual(png.fileType, 'image');
  assert.strictEqual(png.ext, '.png');
  assert.strictEqual(png.searchText, 'a.png');
  assert.ok(Array.isArray(png.parts));
  assert.ok(png.mtime > 0);
  const pdf = items.find(i => i.name === 'b.pdf');
  assert.strictEqual(pdf.fileType, 'pdf');
  assert.strictEqual(pdf.searchText, 'sub b.pdf');   // 경로 구분자·_ → 공백
});

test('basic: 이미지-AI 연결 (logo.png → logo.ai)', async () => {
  const root = mkTree();
  const { items } = await buildDesignIndex(root, opts());
  const logoPng = items.find(i => i.name === 'logo.png');
  assert.ok(logoPng.aiPath && logoPng.aiPath.endsWith('logo.ai'));
});

test('basic: maxDepth 초과 폴더 제외', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'didx-'));
  let p = root;
  for (let i = 0; i < 10; i++) { p = path.join(p, 'd' + i); fs.mkdirSync(p); }
  fs.writeFileSync(path.join(p, 'deep.png'), 'x');     // depth 10
  const { items } = await buildDesignIndex(root, opts({ maxDepth: 8 }));
  assert.strictEqual(items.find(i => i.name === 'deep.png'), undefined);
});

test('incremental: 변경 없으면 전부 재사용', async () => {
  const root = mkTree();
  const cache = new Map();
  await buildDesignIndex(root, opts({ cache }));
  const r2 = await buildDesignIndex(root, opts({ cache }));
  assert.strictEqual(r2.dirsScanned, 0);
  assert.ok(r2.dirsReused > 0);
  assert.strictEqual(r2.items.length, 4);
});

test('incremental: 새 파일 추가된 폴더만 재스캔', async () => {
  const root = mkTree();
  const cache = new Map();
  await buildDesignIndex(root, opts({ cache }));
  const sub = path.join(root, 'sub');
  fs.writeFileSync(path.join(sub, 'new.png'), 'x');
  bump(sub);
  const r2 = await buildDesignIndex(root, opts({ cache }));
  assert.ok(r2.items.find(i => i.name === 'new.png'));
  assert.ok(r2.dirsScanned >= 1);
  assert.ok(r2.dirsReused >= 1);
});

test('incremental: 파일 삭제 반영', async () => {
  const root = mkTree();
  const cache = new Map();
  await buildDesignIndex(root, opts({ cache }));
  fs.rmSync(path.join(root, 'a.png'));
  bump(root);
  const r2 = await buildDesignIndex(root, opts({ cache }));
  assert.strictEqual(r2.items.find(i => i.name === 'a.png'), undefined);
});

test('incremental: force=true 면 캐시 무시 전체 재스캔', async () => {
  const root = mkTree();
  const cache = new Map();
  await buildDesignIndex(root, opts({ cache }));
  const r2 = await buildDesignIndex(root, opts({ cache, force: true }));
  assert.strictEqual(r2.dirsReused, 0);
  assert.ok(r2.dirsScanned > 0);
});

test('prune: 사라진 폴더의 캐시 항목 제거', async () => {
  const root = mkTree();
  const cache = new Map();
  await buildDesignIndex(root, opts({ cache }));
  const sub = path.join(root, 'sub');
  assert.ok(cache.has(sub));
  fs.rmSync(sub, { recursive: true, force: true });
  bump(root);
  const r2 = await buildDesignIndex(root, opts({ cache }));
  assert.strictEqual(cache.has(sub), false);
  assert.strictEqual(r2.items.find(i => i.name === 'b.pdf'), undefined);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test routes/lib/design-indexer.test.js`
Expected: FAIL — `Cannot find module './design-indexer'`

- [ ] **Step 3: 모듈 구현**

`routes/lib/design-indexer.js`:

```js
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
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test routes/lib/design-indexer.test.js`
Expected: PASS (9 tests)

- [ ] **Step 5: 커밋**

```bash
git add routes/lib/design-indexer.js routes/lib/design-indexer.test.js
git commit -m "feat: 시안 증분 인덱스 빌더 (design-indexer 코어 + 테스트)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 디스크 캐시 직렬화/로드/저장

**Files:**
- Modify: `routes/lib/design-indexer.js` (함수 추가 + export 확장)
- Test: `routes/lib/design-indexer.cache.test.js`

- [ ] **Step 1: 실패하는 테스트 작성**

`routes/lib/design-indexer.cache.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { serializeCache, deserializeCache, loadIndexCache, saveIndexCache, CACHE_VERSION } = require('./design-indexer');

function sampleCache() {
  const cache = new Map();
  cache.set('D:\\x', { mtimeMs: 111, subdirs: ['D:\\x\\y'], items: [{ path: 'D:\\x\\a.png', name: 'a.png', fileType: 'image', mtime: 5 }] });
  cache.set('D:\\x\\y', { mtimeMs: 222, subdirs: [], items: [] });
  return cache;
}

test('serialize → deserialize 라운드트립', () => {
  const obj = serializeCache(sampleCache(), 'D:\\');
  const json = JSON.parse(JSON.stringify(obj));   // JSON 직렬화 가능성 확인
  const restored = deserializeCache(json, 'D:\\');
  assert.ok(restored);
  assert.strictEqual(restored.cache.size, 2);
  assert.strictEqual(restored.items.length, 1);
  assert.strictEqual(restored.cache.get('D:\\x').mtimeMs, 111);
});

test('deserialize: version 불일치 → null', () => {
  const obj = serializeCache(sampleCache(), 'D:\\');
  obj.version = 999;
  assert.strictEqual(deserializeCache(obj, 'D:\\'), null);
});

test('deserialize: designRoot 불일치 → null', () => {
  const obj = serializeCache(sampleCache(), 'D:\\');
  assert.strictEqual(deserializeCache(obj, 'E:\\'), null);
});

test('deserialize: 깨진 입력 → null', () => {
  assert.strictEqual(deserializeCache(null, 'D:\\'), null);
  assert.strictEqual(deserializeCache({ version: CACHE_VERSION, designRoot: 'D:\\' }, 'D:\\'), null);
});

test('saveIndexCache → loadIndexCache 파일 라운드트립', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'didxc-'));
  const file = path.join(dir, 'cache.json');
  await saveIndexCache(file, sampleCache(), 'D:\\');
  assert.ok(fs.existsSync(file));
  const loaded = loadIndexCache(file, 'D:\\');
  assert.ok(loaded);
  assert.strictEqual(loaded.items.length, 1);
  assert.strictEqual(loaded.cache.size, 2);
});

test('loadIndexCache: 파일 없음 → null', () => {
  assert.strictEqual(loadIndexCache(path.join(os.tmpdir(), 'nope-' + process.pid + '.json'), 'D:\\'), null);
});

test('loadIndexCache: 손상 JSON → null (폴백)', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'didxc-'));
  const file = path.join(dir, 'bad.json');
  fs.writeFileSync(file, '{ not json');
  assert.strictEqual(loadIndexCache(file, 'D:\\'), null);
});
```

- [ ] **Step 2: 테스트 실패 확인**

Run: `node --test routes/lib/design-indexer.cache.test.js`
Expected: FAIL — `serializeCache is not a function` (아직 export 안 됨)

- [ ] **Step 3: 함수 추가 + export 확장**

`routes/lib/design-indexer.js` 의 `module.exports = ...` 줄 **앞에** 다음 함수들을 추가:

```js
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
  await fs.promises.writeFile(tmp, json, 'utf8');
  await fs.promises.rename(tmp, filePath);
}
```

그리고 `module.exports` 를 다음으로 교체:

```js
module.exports = {
  CACHE_VERSION, buildFileItem, buildDesignIndex,
  serializeCache, deserializeCache, loadIndexCache, saveIndexCache,
};
```

- [ ] **Step 4: 테스트 통과 확인**

Run: `node --test routes/lib/design-indexer.cache.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: 전체 테스트 재확인 후 커밋**

Run: `node --test routes/lib/`
Expected: PASS (16 tests 전체)

```bash
git add routes/lib/design-indexer.js routes/lib/design-indexer.cache.test.js
git commit -m "feat: 시안 인덱스 디스크 캐시 직렬화/로드/저장" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `routes/design.js` 통합

**Files:**
- Modify: `routes/design.js` (require 추가, 모듈 상태, runDesignIndex, startDesignIndexer, /design/reindex)

> 아래 6개 편집은 모두 "기존 블록을 찾아 새 블록으로 교체". 라인 번호는 참고용(편집에 따라 이동).

- [ ] **Step 1: 모듈 require 추가 (~line 12)**

찾기:
```js
const designWorkflowStorage = require('./lib/design-workflow-storage');
```
교체:
```js
const designWorkflowStorage = require('./lib/design-workflow-storage');
const designIndexer = require('./lib/design-indexer');
```

- [ ] **Step 2: 모듈 상태/상수 확장 (~line 145)**

찾기:
```js
let designIndex = [];
let designIndexStatus = { built: false, building: false, count: 0, lastBuilt: null, error: null };
let designWorkflowOptionsCache = { key: '', value: null, cachedAt: 0 };
```
교체:
```js
let designIndex = [];
let designIndexStatus = { built: false, building: false, count: 0, lastBuilt: null, error: null, lastMode: null, lastFullBuilt: null, durationMs: 0, dirsScanned: 0, dirsReused: 0, fromDisk: false };
let designWorkflowOptionsCache = { key: '', value: null, cachedAt: 0 };

// 폴더 증분 인덱싱 캐시 + 디스크 영속화
let designDirCache = new Map();
let lastFullScanAt = 0;
const MAX_DEPTH = 8;
const FULL_RESCAN_MS = parseInt(process.env.DESIGN_FULL_RESCAN_MS) || 6 * 60 * 60 * 1000;
const INDEX_CACHE_PATH = path.join(__dirname, '..', 'data', 'design-index-cache.json');
```

- [ ] **Step 3: 기존 `buildDesignIndexAsync` 함수 제거 (~line 159–226)**

`async function buildDesignIndexAsync(rootPath) {` 부터 그 함수의 닫는 `}` 까지 전체 블록을 찾아 다음 한 줄로 교체:
```js
// 인덱스 빌드 로직은 ./lib/design-indexer 로 이전됨 (buildDesignIndex)
```

- [ ] **Step 4: `runDesignIndex` 교체 (~line 230–249)**

찾기 (함수 전체):
```js
function runDesignIndex() {
  if (designIndexStatus.building) return;
  if (!fs.existsSync(DESIGN_ROOT)) {
    designIndexStatus.error = `경로 없음: ${DESIGN_ROOT}`;
    console.log(`[시안검색] 경로 없음: ${DESIGN_ROOT}`);
    return;
  }
  designIndexStatus.building = true;
  designIndexStatus.error = null;
  console.log(`[시안검색] 인덱싱 시작... (${DESIGN_ROOT})`);
  buildDesignIndexAsync(DESIGN_ROOT).then(idx => {
    designIndex = idx;
    designIndexStatus = { built: true, building: false, count: idx.length, lastBuilt: new Date().toISOString(), error: null };
    invalidateDesignWorkflowOptions();
    console.log(`[시안검색] 완료: ${idx.length}개 파일`);
  }).catch(e => {
    designIndexStatus = { ...designIndexStatus, building: false, error: e.message };
    console.log(`[시안검색] 오류: ${e.message}`);
  });
}
```
교체:
```js
function runDesignIndex(runOpts = {}) {
  if (designIndexStatus.building) return;
  if (!fs.existsSync(DESIGN_ROOT)) {
    designIndexStatus.error = `경로 없음: ${DESIGN_ROOT}`;
    console.log(`[시안검색] 경로 없음: ${DESIGN_ROOT}`);
    return;
  }
  // 캐시가 비었으면(콜드 스타트) 무조건 전체 스캔
  const force = !!runOpts.force || designDirCache.size === 0;
  const mode = force ? 'full' : 'incremental';
  designIndexStatus.building = true;
  designIndexStatus.error = null;
  const startedAt = Date.now();
  console.log(`[시안검색] ${mode} 인덱싱 시작... (${DESIGN_ROOT})`);
  designIndexer.buildDesignIndex(DESIGN_ROOT, {
    force,
    cache: designDirCache,
    skipDirs: SKIP_DIRS,
    indexedExts: INDEXED_EXTS,
    extToType: EXT_TO_TYPE,
    maxDepth: MAX_DEPTH,
    onProgress: (n) => { designIndexStatus.count = n; },
  }).then(({ items, dirsScanned, dirsReused }) => {
    designIndex = items;
    const nowIso = new Date().toISOString();
    const durationMs = Date.now() - startedAt;
    if (mode === 'full') lastFullScanAt = Date.now();
    designIndexStatus = {
      built: true, building: false, count: items.length, lastBuilt: nowIso, error: null,
      lastMode: mode,
      lastFullBuilt: mode === 'full' ? nowIso : (designIndexStatus.lastFullBuilt || null),
      durationMs, dirsScanned, dirsReused, fromDisk: false,
    };
    invalidateDesignWorkflowOptions();
    console.log(`[시안검색] ${mode} 완료: ${items.length}개 / 스캔 ${dirsScanned} 재사용 ${dirsReused} / ${durationMs}ms`);
    designIndexer.saveIndexCache(INDEX_CACHE_PATH, designDirCache, DESIGN_ROOT)
      .catch(e => console.warn('[시안검색] 캐시 저장 실패:', e.message));
  }).catch(e => {
    designIndexStatus = { ...designIndexStatus, building: false, error: e.message };
    console.log(`[시안검색] 오류: ${e.message}`);
  });
}
```

- [ ] **Step 5: `startDesignIndexer` 교체 + 디스크 로드 추가 (~line 251–262)**

찾기 (함수 전체 + 호출):
```js
function startDesignIndexer() {
  // 서버 시작 5초 후 첫 인덱싱
  setTimeout(() => {
    runDesignIndex();
    // 이후 30분마다 자동 재인덱싱 (5분은 너무 빈번 → 서버 부담)
    designIndexTimer = setInterval(runDesignIndex, 30 * 60 * 1000);
  }, 5000);
  // fs.watch 제거 — D드라이브 전체 감시는 서버 성능 심각하게 저하
  // 대신 수동 재인덱싱 버튼 또는 30분 자동 주기 사용
  console.log(`[시안검색] 30분 주기 자동 인덱싱 설정 완료 (수동: 재인덱싱 버튼 사용)`);
}
startDesignIndexer();
```
교체:
```js
// 서버 시작 시 디스크 캐시 로드 → 즉시 검색 가능 (재시작 빈 구간 제거)
function loadDesignCacheAtStartup() {
  try {
    const loaded = designIndexer.loadIndexCache(INDEX_CACHE_PATH, DESIGN_ROOT);
    if (loaded) {
      designDirCache = loaded.cache;
      designIndex = loaded.items;
      designIndexStatus = {
        built: true, building: false, count: loaded.items.length, lastBuilt: null, error: null,
        lastMode: 'disk', lastFullBuilt: null, durationMs: 0, dirsScanned: 0, dirsReused: 0, fromDisk: true,
      };
      console.log(`[시안검색] 디스크 캐시 로드: ${loaded.items.length}개 (즉시 검색 가능)`);
    }
  } catch (e) {
    console.warn('[시안검색] 디스크 캐시 로드 실패:', e.message);
  }
}

function startDesignIndexer() {
  loadDesignCacheAtStartup();
  // 서버 시작 5초 후 첫 인덱싱 (디스크 캐시 있으면 증분, 없으면 전체)
  setTimeout(() => {
    runDesignIndex();
    // 30분마다 자동: 마지막 전체 스캔 후 FULL_RESCAN_MS 경과 시 그 회차는 전체
    designIndexTimer = setInterval(() => {
      const needFull = !lastFullScanAt || (Date.now() - lastFullScanAt) >= FULL_RESCAN_MS;
      runDesignIndex({ force: needFull });
    }, 30 * 60 * 1000);
  }, 5000);
  console.log(`[시안검색] 30분 주기 자동 인덱싱 + 디스크 캐시 설정 완료`);
}
startDesignIndexer();
```

- [ ] **Step 6: `/design/reindex` 에 full 파라미터 (~line 785)**

찾기:
```js
router.post('/design/reindex', requireAuth, (req, res) => {
  if (designIndexStatus.building) return res.json({ building: true, message: '인덱싱 중...', count: designIndex.length });
  runDesignIndex(); // 비동기 시작
  res.json({ building: true, message: '인덱싱 시작됨 — 파일 수에 따라 수 분 소요될 수 있습니다', count: 0 });
});
```
교체:
```js
router.post('/design/reindex', requireAuth, (req, res) => {
  if (designIndexStatus.building) return res.json({ building: true, message: '인덱싱 중...', count: designIndex.length });
  const full = req.query.full === '1' || (req.body && req.body.full === true);
  runDesignIndex({ force: full }); // 기본 증분, ?full=1 이면 전체
  res.json({ building: true, message: full ? '전체 재인덱싱 시작됨' : '증분 재인덱싱 시작됨 (변경된 폴더만)', count: designIndex.length });
});
```

- [ ] **Step 7: 구문 검사 + 전체 테스트 + 커밋**

Run: `node --check routes/design.js`
Expected: (출력 없음 = 구문 정상)

Run: `node --test routes/lib/`
Expected: PASS (16 tests)

```bash
git add routes/design.js
git commit -m "feat: 시안검색 증분 인덱싱 + 디스크 캐시 통합 (design.js)" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## 최종 검증 (서버 PC — 배포 후 수동)

> 샌드박스엔 `D:\`가 없어 위 단위 테스트로 로직을 검증한다. 아래는 배포(서버 PC) 후 확인 항목:

- [ ] 콜드 스타트(캐시 파일 없음): 로그 `full 인덱싱 시작 → full 완료: N개 / 스캔 M 재사용 0` 확인. `data/design-index-cache.json` 생성 확인.
- [ ] 2회차(30분 주기 또는 버튼): 로그 `incremental 완료 ... 재사용 M / durationMs` — durationMs가 1회차 대비 급감하는지 확인.
- [ ] 새 시안 파일 한 폴더에 추가 → 재인덱싱 버튼 → 즉시 검색되는지, 그 폴더만 스캔(dirsScanned 소수)인지 확인.
- [ ] 서버 재시작 직후: 첫 검색 요청이 (디스크 캐시 로드로) **바로 결과 반환**되는지 확인. `/api/design/status` 에 `fromDisk:true` 노출 확인.
- [ ] `/api/design/status` 에 `lastMode`, `dirsReused`, `durationMs` 노출 확인.
- [ ] 캐시 파일을 일부러 손상(텍스트 추가) 후 재시작 → 폴백(전체 스캔)되고 검색 정상인지 확인.

---

## Self-Review 결과

- **스펙 커버리지**: 증분 순회(3.2)=Task1, 삭제/prune(3.3)=Task1, 안전망(3.4)=Task3 Step5, 버튼 full(3.5)=Task3 Step6, 상태 필드(3.6)=Task3 Step2/4/5, 디스크 캐시(3.7)=Task2+Task3 Step5. 누락 없음.
- **플레이스홀더**: 없음(모든 스텝 실코드).
- **타입/시그니처 일관성**: `buildDesignIndex(rootPath, {force,cache,skipDirs,indexedExts,extToType,maxDepth,onProgress})`, `saveIndexCache(filePath,cache,designRoot)`, `loadIndexCache(filePath,designRoot)` — Task 간 호출부와 정의부 일치 확인.
