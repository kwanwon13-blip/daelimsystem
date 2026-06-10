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
