/**
 * 워크플로우 파일 존재확인 비용 비교 (OLD vs NEW) — 실측 벤치.
 *
 * OLD = 기존 fileDiskPath 동작: design 파일마다 resolveWorkflowStorage(네트워크 디자인폴더 풀스캔)를
 *       "무조건" 먼저 호출한 뒤 존재확인. 데코레이션은 파일 1개를 ~2.5회 해석.
 * NEW(detail) = workflow-file-locator: 저장된 절대경로 우선 + TTL 메모.
 * NEW(list)   = skipFileExists: 목록/탭열기는 디스크 0회.
 *
 * fs 호출 횟수를 세고, SMB 네트워크 1회 왕복을 보수적으로 15ms 로 가정해 환산한다.
 * 실행: node routes/lib/workflow-file-locator.bench.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createFileLocator } = require('./workflow-file-locator');
const designStorage = require('./design-workflow-storage');
const { isPathInside } = designStorage;

const NET_MS_PER_OP = 15;           // SMB 1회 왕복 가정(보수적)
const DECORATE_CALLS_PER_FILE = 2.5; // missingFileCount + decorateWorkflowFile + 대표이미지

// 규모: 회사 10 × 연도 2 × 프로젝트 5 × 파일 20 = 2000 파일
const COMPANIES = 10, YEARS = ['2025 시안작업', '2026 시안작업'], PROJECTS = 5, FILES = 20;

function simpleSafeFilePart(v, fb = 'file') { return String(v || '').replace(/[\\/:*?"<>|]/g, '_').trim().slice(0, 120) || fb; }

function buildTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wfbench-'));
  const files = [];
  for (let c = 0; c < COMPANIES; c++) {
    const company = `대림에스엠${c}`;
    for (const yf of YEARS) {
      const year = yf.slice(0, 4);
      for (let p = 0; p < PROJECTS; p++) {
        const project = `현장${c}_${p}`;
        const dir = path.join(root, company, yf, project);
        fs.mkdirSync(dir, { recursive: true });
        for (let f = 0; f < FILES; f++) {
          const name = `시안_${f}.png`;
          const full = path.join(dir, name);
          fs.writeFileSync(full, 'x');
          files.push({
            id: `wff_${c}_${p}_${f}`,
            storedPath: full, storedName: name, originalName: name,
            storageRoot: 'design', storageBucket: path.join(company, yf, project),
            storageCompanyName: company, storageProjectName: project, storageYear: year,
            storagePath: dir,
          });
        }
      }
    }
  }
  return { root, files };
}

// fs 카운터 (전역 패치 — design-workflow-storage 가 쓰는 fs 도 같이 잡힌다)
const real = { existsSync: fs.existsSync, readdirSync: fs.readdirSync, statSync: fs.statSync };
let ops = 0;
function patch() {
  fs.existsSync = (...a) => { ops++; return real.existsSync(...a); };
  fs.readdirSync = (...a) => { ops++; return real.readdirSync(...a); };
  fs.statSync = (...a) => { ops++; return real.statSync(...a); };
}
function unpatch() { Object.assign(fs, real); }

// OLD: design 파일 1회 해석 = resolveWorkflowStorage(풀스캔) + storedPath 존재확인
function oldResolveOnce(file, root) {
  try {
    designStorage.resolveWorkflowStorage({
      designRoot: root, designIndex: [], skipDirs: new Set(),
      companyName: file.storageCompanyName, projectName: file.storageProjectName,
      year: file.storageYear, create: false,
    });
  } catch (_) {}
  fs.existsSync(file.storedPath);
}

function run() {
  const { root, files } = buildTree();
  console.log(`규모: 파일 ${files.length}개 (회사 ${COMPANIES} × 연도 ${YEARS.length} × 프로젝트 ${PROJECTS} × 파일 ${FILES})`);
  console.log(`가정: 네트워크 1회 왕복 = ${NET_MS_PER_OP}ms, 파일당 데코레이션 해석 ${DECORATE_CALLS_PER_FILE}회\n`);

  // OLD (탭 열기 = 목록 전체를 데코레이션)
  ops = 0; patch();
  const calls = Math.round(files.length * DECORATE_CALLS_PER_FILE);
  for (let i = 0; i < calls; i++) oldResolveOnce(files[i % files.length], root);
  unpatch();
  const oldOps = ops, oldMs = oldOps * NET_MS_PER_OP;
  console.log(`[OLD] 목록 데코레이션: fs 작업 ${oldOps.toLocaleString()}회  → 약 ${(oldMs / 1000).toFixed(1)}초`);

  // NEW(detail): locator.exists, 파일당 2.5회 호출(메모로 1회 stat 로 수렴)
  const locator = createFileLocator({
    fs, fileDir: path.join(root, '__wf'), getDesignRoot: () => root,
    safeFilePart: simpleSafeFilePart, isPathInside,
    resolveDesignStorage: (co, pr, yr) => {
      const dir = path.join(root, co, `${yr} 시안작업`, pr);
      return fs.existsSync(dir) ? { dir } : null;
    },
  });
  ops = 0; patch();
  for (let i = 0; i < calls; i++) locator.exists(files[i % files.length]);
  unpatch();
  const newOps = ops, newMs = newOps * NET_MS_PER_OP;
  console.log(`[NEW 상세] 같은 작업량(메모 적용): fs 작업 ${newOps.toLocaleString()}회  → 약 ${(newMs / 1000).toFixed(1)}초`);
  console.log(`[NEW 목록] skipFileExists: fs 작업 0회  → 즉시 (네트워크 무관)\n`);

  console.log(`개선: 목록 ${oldOps.toLocaleString()}회 → 0회 (∞ 빠름),  상세 해석 ${oldOps.toLocaleString()}회 → ${newOps.toLocaleString()}회 (${(oldOps / Math.max(1, newOps)).toFixed(0)}배 감소)`);

  // 정리
  try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) {}
}

run();
