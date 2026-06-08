const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileLocator } = require('./workflow-file-locator');
const { isPathInside } = require('./design-workflow-storage');

function simpleSafeFilePart(value, fallback = 'file') {
  return String(value || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120) || fallback;
}

// 실제 fs 를 감싸 existsSync 호출 횟수와 resolveDesignStorage 호출 횟수를 센다
function harness(extra = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfloc-'));
  const fileDir = path.join(root, 'workflow-files');
  const designRoot = path.join(root, 'design');
  fs.mkdirSync(fileDir, { recursive: true });
  fs.mkdirSync(designRoot, { recursive: true });

  const counters = { existsSync: 0, resolveCalls: 0 };
  const fsWrapped = {
    existsSync: (p) => { counters.existsSync++; return fs.existsSync(p); },
  };
  let clock = 1000;
  const locator = createFileLocator({
    fs: fsWrapped,
    fileDir,
    getDesignRoot: () => designRoot,
    safeFilePart: simpleSafeFilePart,
    isPathInside,
    resolveDesignStorage: (company, project, year) => {
      counters.resolveCalls++;
      // 디자인 프로젝트 폴더를 "스캔"으로 찾았다고 가정
      const dir = path.join(designRoot, company, year || '2026', project);
      return fs.existsSync(dir) ? { dir } : null;
    },
    now: () => clock,
    ...extra,
  });
  return { root, fileDir, designRoot, counters, locator, setClock: (v) => { clock = v; } };
}

test('지연평가: storedPath(절대경로)가 존재하면 네트워크 스캔(resolve)을 호출하지 않는다', () => {
  const h = harness();
  // design 루트 안에 실제 파일을 둔다
  const projDir = path.join(h.designRoot, '대림', '2026', '프로젝트A');
  fs.mkdirSync(projDir, { recursive: true });
  const filePath = path.join(projDir, 'proof.png');
  fs.writeFileSync(filePath, 'x');

  const file = {
    id: 'wff_1',
    storedPath: filePath,                 // 절대경로 (업로드 시 저장됨)
    storedName: 'proof.png',
    storageRoot: 'design',
    storageCompanyName: '대림',
    storageProjectName: '프로젝트A',
    storageYear: '2026',
  };

  assert.strictEqual(h.locator.exists(file), true);
  assert.strictEqual(h.counters.resolveCalls, 0, 'resolve(네트워크 스캔)가 호출되면 안 됨');
});

test('폴백: 싼 후보가 모두 없을 때만 resolve 를 호출한다', () => {
  const h = harness();
  const projDir = path.join(h.designRoot, '대림', '2026', '프로젝트B');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'draw.png'), 'x');

  const file = {
    id: 'wff_2',
    // storedPath / storagePath 없음 → 싼 후보로는 못 찾음
    storedName: 'draw.png',
    originalName: 'draw.png',
    storageRoot: 'design',
    storageCompanyName: '대림',
    storageProjectName: '프로젝트B',
    storageYear: '2026',
  };

  assert.strictEqual(h.locator.exists(file), true);
  assert.strictEqual(h.counters.resolveCalls, 1, '폴백으로 resolve 1회 호출되어야 함');
});

test('존재 메모: 같은 파일 반복 조회는 stat(existsSync)을 다시 하지 않는다', () => {
  const h = harness();
  const projDir = path.join(h.designRoot, '대림', '2026', '프로젝트C');
  fs.mkdirSync(projDir, { recursive: true });
  const filePath = path.join(projDir, 'a.png');
  fs.writeFileSync(filePath, 'x');
  const file = { id: 'wff_3', storedPath: filePath, storedName: 'a.png' };

  assert.strictEqual(h.locator.exists(file), true);
  const after1 = h.counters.existsSync;
  assert.ok(after1 >= 1, '첫 조회는 stat 발생');
  // 반복 9회
  for (let i = 0; i < 9; i++) assert.strictEqual(h.locator.exists(file), true);
  assert.strictEqual(h.counters.existsSync, after1, '메모 적중 → 추가 stat 0회');
  assert.strictEqual(h.locator.snapshotStats().existsMemoHits, 9);
});

test('resolve 메모: 같은 (회사|프로젝트|연도) 파일들은 스캔을 1회만 공유한다', () => {
  const h = harness();
  const projDir = path.join(h.designRoot, '대림', '2026', '프로젝트D');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(path.join(projDir, 'f1.png'), 'x');
  fs.writeFileSync(path.join(projDir, 'f2.png'), 'x');

  const base = { storageRoot: 'design', storageCompanyName: '대림', storageProjectName: '프로젝트D', storageYear: '2026' };
  const f1 = { ...base, id: 'a', storedName: 'f1.png', originalName: 'f1.png' };
  const f2 = { ...base, id: 'b', storedName: 'f2.png', originalName: 'f2.png' };

  assert.strictEqual(h.locator.exists(f1), true);
  assert.strictEqual(h.locator.exists(f2), true);
  assert.strictEqual(h.counters.resolveCalls, 1, '두 파일이 같은 프로젝트 → resolve 1회만');
});

test('diskPath: 어떤 후보도 존재하지 않으면 firstAllowed(경로)를 돌려준다(404 처리는 호출측)', () => {
  const h = harness();
  const filePath = path.join(h.fileDir, 'missing.png'); // 만들지 않음
  const file = { id: 'wff_4', storedPath: filePath, storedName: 'missing.png' };
  assert.strictEqual(h.locator.exists(file), false);
  assert.strictEqual(h.locator.diskPath(file), path.resolve(filePath));
});

test('TTL 만료: 시간이 지나면 다시 stat 한다', () => {
  const h = harness();
  const filePath = path.join(h.fileDir, 'b.png');
  fs.writeFileSync(filePath, 'x');
  const file = { id: 'wff_5', storedPath: filePath, storedName: 'b.png' };

  assert.strictEqual(h.locator.exists(file), true);
  const after1 = h.counters.existsSync;
  h.setClock(1000 + 61 * 1000); // 61초 경과 (TTL 60초)
  assert.strictEqual(h.locator.exists(file), true);
  assert.ok(h.counters.existsSync > after1, 'TTL 만료 후 재조회는 stat 재발생');
});

test('경계: FILE_DIR/디자인루트 밖 경로는 허용하지 않는다', () => {
  const h = harness();
  const outside = path.join(h.root, 'outside-secret.png');
  fs.writeFileSync(outside, 'x');
  const file = { id: 'wff_6', storedPath: outside, storedName: 'outside-secret.png' };
  assert.strictEqual(h.locator.exists(file), false, '경계 밖 경로는 존재해도 false');
});
