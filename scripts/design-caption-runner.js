#!/usr/bin/env node
'use strict';
/**
 * scripts/design-caption-runner.js — 시안 ★폴더 전수 "내용 캡션" 러너 (로컬 PC 전용, 무료)
 *
 * 로컬 claude CLI 가 각 이미지를 비전으로 읽어 7축 JSON 캡션 → 서버 /design/caption-ingest 로 적재.
 * design-captions.db(path UNIQUE)에 이미 있는 건 건너뜀 = 재시작/이어하기 안전(밤마다 돌려 누적).
 * rate limit 걸리면 연속 실패를 감지해 깔끔히 종료 — 다음 실행이 끊긴 데서 이어감.
 *
 * 실행(로컬 PC, 네트워크 공유 \\192.168.0.133\dd 접근 가능해야 함):
 *   node scripts/design-caption-runner.js                  # 전체 ★폴더, 끝까지
 *   node scripts/design-caption-runner.js --limit 200      # 이번 실행 200장만
 *   node scripts/design-caption-runner.js --folder 라코스  # 폴더명에 '라코스' 포함만
 *   node scripts/design-caption-runner.js --concurrency 3  # 동시 claude 3개(기본 2)
 *   node scripts/design-caption-runner.js --dry --limit 5  # 캡션만, 적재 안 함(미리보기)
 *
 * .env 자동 로드(로컬 체크아웃의 .env): CONTROL_DAEMON_SECRET 필수.
 *   추가 환경변수: DESIGN_SHARE(기본 \\192.168.0.133\dd),
 *                  DESIGN_SERVER(기본 http://192.168.0.133:3000),
 *                  DESIGN_CAPTION_MODEL(기본 sonnet)
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const http = require('http');

const ROOT = path.join(__dirname, '..');

function loadEnv() {
  const out = {};
  try {
    const txt = fs.readFileSync(path.join(ROOT, '.env'), 'utf8');
    for (const line of txt.split(/\r?\n/)) {
      const m = line.match(/^([A-Za-z0-9_]+)=(.*)$/);
      if (m) out[m[1]] = m[2].trim();
    }
  } catch (_) {}
  return out;
}
const ENV = { ...loadEnv(), ...process.env };
const SHARE = (ENV.DESIGN_SHARE || '\\\\192.168.0.133\\dd').replace(/[\\/]+$/, '');
const SERVER = ENV.DESIGN_SERVER || 'http://192.168.0.133:3000';
const SECRET = String(ENV.CONTROL_DAEMON_SECRET || '').trim();
// 주간한도 실측(2026-06-28): claude -p 는 호출당 시스템프롬프트 ~26k토큰을 매번 새로 캐시(호출 간 재사용 안 됨).
// 인라인·--system-prompt·--exclude-dynamic 다 효과없음 → 유일한 지렛대=배치로 그 고정비 분산.
// sonnet: b5 $0.05 → b12 $0.035/장(1.4배↓, b12가 안전상한 — 더 키우면 출력 잘려 JSON 깨짐).
// 한도 더 아끼려면: 매일 --limit N 으로 쪼개 돌리거나(스로틀), 핵심 폴더만 sonnet·나머지 haiku($0.0107, 3배↓).
const MODEL_RAW = ENV.DESIGN_CAPTION_MODEL || 'sonnet';
const MODEL = /^[A-Za-z0-9._-]+$/.test(MODEL_RAW) ? MODEL_RAW : 'sonnet'; // shell 주입 차단(아래 shell:true)
const DB_SHARE_PATH = SHARE + '\\price-list-app\\data\\design-captions.db';
const WF_JSON_PATH = SHARE + '\\price-list-app\\data\\workflow.json'; // --workflow 모드: 워크플로 시안 목록
const IMG_EXT = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']);
const SKIP_DIRS = new Set(['node_modules', '.git', '$RECYCLE.BIN', 'System Volume Information', 'price-list-app']);

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  if (i === -1) return def;
  const v = process.argv[i + 1];
  return (v && !v.startsWith('--')) ? v : true;
}
const LIMIT = parseInt(arg('limit', '0'), 10) || 0;
const FOLDER_FILTER = (arg('folder', '') === true) ? '' : String(arg('folder', ''));
// --folder 는 쉼표로 여러 거래처(부분일치 OR). 예: --folder 포스코,DL,현대산업
const FOLDER_TERMS = FOLDER_FILTER ? FOLDER_FILTER.split(',').map(s => s.trim().toLowerCase()).filter(Boolean) : [];
// --year 는 쉼표로 여러 연도(폴더경로에 포함되면 통과). 예: --year 2025,2026
const YEAR_RAW = (arg('year', '') === true) ? '' : String(arg('year', ''));
const YEAR_TERMS = YEAR_RAW ? YEAR_RAW.split(',').map(s => s.trim()).filter(Boolean) : [];
const CONCURRENCY = Math.max(1, Math.min(6, parseInt(arg('concurrency', '3'), 10) || 3));
const BATCH = Math.max(1, Math.min(20, parseInt(arg('batch', '12'), 10) || 12)); // 한 claude 호출당 이미지 수 — 고정비(시스템프롬프트 28k) 분산. 기본12=장당비용 batch5 대비 ~1.5배↓
const DRY = !!arg('dry', false);
const COUNT_ONLY = !!arg('count', false); // 캡션 안 하고 필터 결과 장수만 세고 종료(무료 미리보기)
const WORKFLOW = !!arg('workflow', false); // ★스캔 대신 workflow.json 의 워크플로 시안만 캡션(매일밤 신규 자동)
const PER_IMG_TIMEOUT_S = parseInt(arg('timeout', '40'), 10) || 40;            // 이미지 1장당 상한(초). 배치는 ×장수+여유
// 5시간/주간 한도 도달 시: 종료하지 말고 대기 후 자동 재개(회복되면 이어서 돎).
const WAIT_MIN = Math.max(1, parseInt(arg('wait', '20'), 10) || 20);          // 한도 걸리면 재시도 간 대기(분)
const MAX_WAITS = Math.max(1, parseInt(arg('maxwaits', '72'), 10) || 72);     // 배치당 최대 대기횟수(20분×72=24시간)

if (!SECRET) { console.error('[runner] CONTROL_DAEMON_SECRET 없음 — 로컬 .env 확인'); process.exit(1); }

// MCP 서버 로딩 스킵(빈 설정) — 시동 단순화·MCP 오류 차단. 실패해도 무해(플래그 생략).
let MCP_FLAGS = '';
try {
  const f = path.join(os.tmpdir(), 'design-caption-empty-mcp.json');
  fs.writeFileSync(f, '{"mcpServers":{}}');
  MCP_FLAGS = ` --strict-mcp-config --mcp-config "${f}"`;
} catch (_) { MCP_FLAGS = ''; }

// 공유경로(\\192.168.0.133\dd\X) → 서버 저장 규약(D:\X)
function toServerPath(sharePath) {
  const pref = SHARE + '\\';
  if (sharePath.toLowerCase().startsWith(pref.toLowerCase())) return 'D:\\' + sharePath.slice(pref.length);
  return sharePath;
}
// 서버 D:\ 경로 → 러너가 읽을 공유경로(\\192.168.0.133\dd\…). 워크플로 시안 읽기용.
function toSharePath(serverPath) {
  return String(serverPath).replace(/^[A-Za-z]:\\/, SHARE + '\\');
}
// 워크플로 시안 열거 — workflow.json files[] 의 이미지 파일을 {sharePath, folder, serverPath} 로
function enumerateWorkflowImages() {
  let wf;
  try { wf = JSON.parse(fs.readFileSync(WF_JSON_PATH, 'utf8')); }
  catch (e) { console.error('[runner] workflow.json 읽기 실패:', e.message); return []; }
  const out = [], seen = new Set();
  for (const f of (wf.files || [])) {
    const isImg = /^image\//.test(f.mime || '') || IMG_EXT.has(path.extname(f.originalName || f.storedName || '').toLowerCase());
    if (!isImg) continue;
    if (f.supersededBy) continue; // 교체된 옛 버전은 건너뜀(최신만)
    const serverPath = String(f.storedPath || '');
    if (!/^[A-Za-z]:\\/.test(serverPath)) continue; // D:\ 경로(디자인 저장)만 — 내부 임시경로 제외
    if (seen.has(serverPath)) continue;
    seen.add(serverPath);
    const sharePath = toSharePath(serverPath);
    try { if (!fs.existsSync(sharePath)) continue; } catch (_) { continue; } // stale 경로(이동·삭제됨) 건너뜀 — garbage 캡션 방지
    out.push({ sharePath, folder: f.storageCompanyName || '워크플로', serverPath });
  }
  return out;
}

// 이미 캡션된 path 집합(재시작용) — 서버 design-captions.db 를 공유로 읽기전용
function loadDoneSet() {
  let Database;
  try { Database = require('better-sqlite3'); }
  catch (_) { console.warn('[runner] better-sqlite3 없음 — 중복검사 생략(서버 upsert가 흡수, 단 재캡션 낭비)'); return new Set(); }
  try {
    const db = new Database(DB_SHARE_PATH, { readonly: true, fileMustExist: true });
    const rows = db.prepare('SELECT path FROM design_captions').all();
    db.close();
    return new Set(rows.map(r => String(r.path)));
  } catch (e) { console.warn('[runner] done-set 로드 실패(빈 집합으로 진행):', e.message); return new Set(); }
}

// ★폴더 전수 이미지 열거 — 첫 ★조상 폴더명을 folder 로 묶음
function* walkStarImages(root) {
  const stack = [{ dir: root, star: '', depth: 0 }];
  while (stack.length) {
    const { dir, star, depth } = stack.pop();
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!star && SKIP_DIRS.has(e.name)) continue;
        const nextStar = star || (e.name.includes('★') ? e.name : '');
        // ★ 안: 깊이 무제한. ★ 밖: ★ 찾으려 depth<3 까지만 내려감(★는 보통 1~2뎁스).
        if (nextStar || depth < 3) stack.push({ dir: full, star: nextStar, depth: depth + 1 });
      } else if (star && IMG_EXT.has(path.extname(e.name).toLowerCase())) {
        yield { sharePath: full, folder: star };
      }
    }
  }
}

// 배치 프롬프트 — N장 → JSON 배열(객체 N개). 각 객체 file(파일명)로 매칭.
function batchPrompt(jobs) {
  const list = jobs.map((j, n) => `${n + 1}: ${j.sharePath}`).join('\n');
  return 'Read 도구로 아래 이미지 파일들을 각각 직접 열어 보고, 오직 JSON 배열로만 답해라(이미지 1장당 객체 1개, 입력 순서대로). 설명·코드펜스·여는말 전부 금지. JSON 배열 외 다른 텍스트는 실패다.\n' +
    list + '\n' +
    '각 객체 형식: {"file":"파일명(확장자 포함)",' +
    '"type":"종류 한단어(현수막/포스터/로고/스티커/간판/현황판/캐릭터/배경/제품/일러스트/기타)",' +
    '"client":"보이는 회사·브랜드명(없으면 빈문자열)",' +
    '"material":"자재(포맥스/타포린/PE/투명스티커/고무자석 등, 없으면 빈문자열)",' +
    '"usage":"용도·주제(안전/홍보/행사/MSDS/공사현황 등, 없으면 빈문자열)",' +
    '"text":"이미지 속 핵심 문구(없으면 빈문자열)",' +
    '"visual":"색상·구성·분위기 한 줄",' +
    '"keywords":"검색용 한국어 키워드 5개 쉼표"}';
}

function extractArray(text) {
  if (!text) return null;
  const s = String(text).replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const a = s.indexOf('['), b = s.lastIndexOf(']');
  if (a === -1 || b <= a) return null;
  try { const v = JSON.parse(s.slice(a, b + 1)); return Array.isArray(v) ? v : null; } catch (_) { return null; }
}

function sleep(ms) { return new Promise(res => setTimeout(res, ms)); }

// claude -p 실패 출력이 5시간/주간 한도(레이트리밋)로 보이는지 — 그러면 종료 대신 대기·재개.
function looksRateLimited(text) {
  const s = String(text || '').toLowerCase();
  return /limit reached|usage limit|rate.?limit|5.?hour|five.?hour|too many request|\b429\b|quota|resets? (at|in|on)|reset your|try again (later|in|after)|exceeded|out of (usage|credit)|weekly limit|please wait|overloaded|capacity/.test(s);
}

// claude가 파일을 못 읽었을 때의 응답 감지 — 적재하면 garbage(기타/빈값)가 done으로 박힘.
function looksUnreadable(d) {
  const blob = `${d.type || ''} ${d.client || ''} ${d.material || ''} ${d.usage || ''} ${d.text || ''} ${d.visual || ''} ${d.caption || ''}`.toLowerCase();
  return /읽을 수 없|읽지 못|열 수 없|볼 수 없|찾을 수 없|cannot read|unable to read|can'?t (read|open|access)|no such file|not found/.test(blob);
}

// 반환 배열을 입력 jobs 에 매칭 — file(basename) 우선, 없으면 순서. 못 맞춘 장은 null(다음 실행 재시도).
function matchResults(jobs, arr) {
  const byFile = new Map();
  for (const o of arr) { if (o && o.file) byFile.set(path.basename(String(o.file)).trim().toLowerCase(), o); }
  return jobs.map((j, n) => byFile.get(path.basename(j.sharePath).toLowerCase()) || (arr[n] && typeof arr[n] === 'object' ? arr[n] : null));
}

// claude CLI 로 이미지 N장 한 번에 캡션
function captionBatch(jobs) {
  return new Promise((resolve) => {
    // 고정 명령문자열(MODEL/경로는 위에서 통제) — args 배열+shell:true 의 DEP0190 경고 회피. 프롬프트는 stdin.
    const child = spawn(`claude -p --model ${MODEL}${MCP_FLAGS} --allowedTools Read`, { shell: true });
    let out = '', err = '';
    const callTimeout = (PER_IMG_TIMEOUT_S * jobs.length + 30) * 1000;
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, reason: 'timeout' }); }, callTimeout);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, reason: 'spawn:' + e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      const arr = extractArray(out);
      if (!arr) return resolve({ ok: false, reason: 'nojson', raw: (out || err).replace(/\s+/g, ' ').slice(0, 160) });
      resolve({ ok: true, arr });
    });
    try { child.stdin.write(batchPrompt(jobs)); child.stdin.end(); } catch (_) {}
  });
}

function ingest(items) {
  return new Promise((resolve) => {
    const payload = Buffer.from(JSON.stringify({ items }), 'utf8');
    const u = new URL(SERVER + '/api/design/caption-ingest');
    const req = http.request({
      hostname: u.hostname, port: u.port || 80, path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'X-Control-Secret': SECRET },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', e => resolve({ status: 0, body: e.message }));
    req.write(payload); req.end();
  });
}

function buildItem(serverPath, folder, d) {
  const s = v => String(v == null ? '' : v).trim();
  const text = s(d.text), kw = s(d.keywords);
  const caption = [s(d.client), s(d.type), s(d.material), s(d.usage), text, s(d.visual), kw, path.basename(serverPath)]
    .filter(Boolean).join(' ');
  return {
    path: serverPath, folder, client: s(d.client), type: s(d.type), material: s(d.material),
    usage: s(d.usage), text_in: text, visual: s(d.visual), caption,
  };
}

(async () => {
  console.log(`[runner] src=${WORKFLOW ? '워크플로시안' : '★폴더'} model=${MODEL} batch=${BATCH} conc=${CONCURRENCY} limit=${LIMIT || '∞'} folder=${FOLDER_TERMS.join('|') || '(전체)'} year=${YEAR_TERMS.join('|') || '(전체)'} dry=${DRY}`);
  const done = loadDoneSet();
  console.log(`[runner] 이미 캡션됨: ${done.size}장`);

  const source = WORKFLOW ? enumerateWorkflowImages() : walkStarImages(SHARE);
  const todo = [];
  for (const it of source) {
    // 거래처 필터: 폴더명(또는 워크플로 회사명)에 지정 용어 중 하나라도 포함
    if (FOLDER_TERMS.length && !FOLDER_TERMS.some(t => it.folder.toLowerCase().includes(t))) continue;
    const serverPath = it.serverPath || toServerPath(it.sharePath);
    // 연도 필터: 이미지 폴더경로(파일명 제외)에 지정 연도 중 하나라도 포함
    if (YEAR_TERMS.length) { const dir = path.dirname(serverPath); if (!YEAR_TERMS.some(y => dir.includes(y))) continue; }
    if (done.has(serverPath)) continue;
    todo.push({ sharePath: it.sharePath, folder: it.folder, serverPath });
    if (LIMIT && todo.length >= LIMIT) break;
  }
  console.log(`[runner] 이번 실행 대상: ${todo.length}장`);
  if (!todo.length) { console.log('[runner] 할 것 없음 — 완료됐거나 필터 결과 0'); return; }

  if (COUNT_ONLY) {
    const byFolder = {};
    for (const t of todo) byFolder[t.folder] = (byFolder[t.folder] || 0) + 1;
    for (const [k, v] of Object.entries(byFolder).sort((a, b) => b[1] - a[1])) console.log(`   ${k}: ${v}장`);
    console.log('[runner] --count 모드: 세기만 하고 종료(캡션 안 함).');
    return;
  }

  // 배치로 분할 — 한 claude 호출이 BATCH장 처리(시동비용 분산)
  const batches = [];
  for (let k = 0; k < todo.length; k += BATCH) batches.push(todo.slice(k, k + BATCH));
  console.log(`[runner] ${batches.length}개 배치(배치당 ≤${BATCH}장) × 동시 ${CONCURRENCY}`);
  console.log(`[runner] 한도 걸리면 ${WAIT_MIN}분 쉬고 자동 재개(회복되면 이어서 돎). 멈추려면 Ctrl+C.`);

  let okN = 0, failN = 0, bi = 0, aborted = false;
  const t0 = Date.now();
  async function worker() {
    while (bi < batches.length && !aborted) {
      const myIdx = bi++;
      const jobs = batches[myIdx];
      let r = await captionBatch(jobs);
      // 한도(5시간/주간) 도달로 실패하면 종료하지 말고 회복까지 대기 후 자동 재개.
      let rlWaits = 0, softRetried = false;
      while (!r.ok && !aborted) {
        if (looksRateLimited(r.raw)) {
          if (rlWaits >= MAX_WAITS) break;
          rlWaits++;
          console.log(`  ⏳ 한도 도달 추정 — ${WAIT_MIN}분 쉬고 자동 재개 (배치#${myIdx + 1}, ${rlWaits}/${MAX_WAITS}회) :: ${String(r.raw || '').replace(/\s+/g, ' ').slice(0, 60)}`);
          await sleep(WAIT_MIN * 60000);
        } else {
          if (softRetried) break;      // 한도 아닌 실패는 즉시 1회만 재시도 후 스킵(중단 안 함)
          softRetried = true;
          await sleep(2000);
        }
        if (aborted) break;
        r = await captionBatch(jobs);
      }
      if (!r.ok) {
        failN += jobs.length;
        console.log(`  ✗ 배치#${myIdx + 1}/${batches.length} ${r.reason} (${jobs.length}장 다음 실행 재시도)${r.raw ? ' | ' + String(r.raw).slice(0, 70) : ''}`);
        continue;
      }
      const matched = matchResults(jobs, r.arr);
      const ok = [];
      for (let n = 0; n < jobs.length; n++) {
        const d = matched[n];
        if (!d || typeof d !== 'object') { failN++; continue; } // 매칭 안 된 장 → 다음 실행 재시도
        if (looksUnreadable(d)) { failN++; continue; }           // claude가 파일 못읽음 → 적재·done 안 함(재시도)
        if (DRY) { okN++; console.log(`  · ${jobs[n].folder} | ${(d.type || '')}/${(d.client || '-')} | ${String(d.text || '').slice(0, 20)} :: ${path.basename(jobs[n].sharePath)}`); continue; }
        ok.push({ job: jobs[n], item: buildItem(jobs[n].serverPath, jobs[n].folder, d) });
      }
      if (DRY || !ok.length) continue;
      const res = await ingest(ok.map(x => x.item));
      if (res.status === 200) {
        okN += ok.length; ok.forEach(x => done.add(x.job.serverPath));
        const rate = okN / ((Date.now() - t0) / 1000);
        console.log(`  ✓ ${okN}장 적재 (실패 ${failN}, ${rate.toFixed(2)}장/s) … 배치#${myIdx + 1} ${jobs[0].folder}`);
      } else { failN += ok.length; console.log(`  ✗ ingest ${res.status}: ${String(res.body).slice(0, 120)}`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const wall = (Date.now() - t0) / 1000;
  const persec = okN > 0 ? (wall / okN).toFixed(1) : '-';
  console.log(`[runner] 종료 — 성공 ${okN}, 실패 ${failN}, ${wall.toFixed(0)}s (${persec}s/장 실측). 누적 캡션 ${done.size}장. (다시 실행하면 이어서)`);
})();
