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
