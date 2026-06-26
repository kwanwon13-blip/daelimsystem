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
const MODEL_RAW = ENV.DESIGN_CAPTION_MODEL || 'sonnet';
const MODEL = /^[A-Za-z0-9._-]+$/.test(MODEL_RAW) ? MODEL_RAW : 'sonnet'; // shell 주입 차단(아래 shell:true)
const DB_SHARE_PATH = SHARE + '\\price-list-app\\data\\design-captions.db';
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
const CONCURRENCY = Math.max(1, Math.min(6, parseInt(arg('concurrency', '2'), 10) || 2));
const DRY = !!arg('dry', false);
const PER_TIMEOUT_MS = (parseInt(arg('timeout', '120'), 10) || 120) * 1000;

if (!SECRET) { console.error('[runner] CONTROL_DAEMON_SECRET 없음 — 로컬 .env 확인'); process.exit(1); }

// 공유경로(\\192.168.0.133\dd\X) → 서버 저장 규약(D:\X)
function toServerPath(sharePath) {
  const pref = SHARE + '\\';
  if (sharePath.toLowerCase().startsWith(pref.toLowerCase())) return 'D:\\' + sharePath.slice(pref.length);
  return sharePath;
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

const VISION_PROMPT = (sharePath) =>
  'Read 도구로 아래 이미지 파일을 직접 열어 보고, 오직 JSON 한 줄로만 답해라. 설명·코드펜스·여는말 전부 금지. JSON 외 다른 텍스트를 출력하면 실패다.\n' +
  '이미지: ' + sharePath + '\n' +
  '형식: {"type":"종류 한단어(현수막/포스터/로고/스티커/간판/현황판/캐릭터/배경/제품/일러스트/기타)",' +
  '"client":"보이는 회사·브랜드명(없으면 빈문자열)",' +
  '"material":"자재(포맥스/타포린/PE/투명스티커/고무자석 등, 없으면 빈문자열)",' +
  '"usage":"용도·주제(안전/홍보/행사/MSDS/공사현황 등, 없으면 빈문자열)",' +
  '"text":"이미지 속 핵심 문구(없으면 빈문자열)",' +
  '"visual":"색상·구성·분위기 한 줄",' +
  '"keywords":"검색용 한국어 키워드 5개 쉼표"}';

function extractJson(text) {
  if (!text) return null;
  const s = String(text).replace(/```[a-zA-Z]*\s*/g, '').replace(/```/g, '');
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a === -1 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}

// claude CLI 로 이미지 1장 캡션
function captionOne(sharePath) {
  return new Promise((resolve) => {
    // 고정 명령문자열(MODEL은 위에서 살균) — args 배열+shell:true 의 DEP0190 경고 회피. 프롬프트는 stdin.
    const child = spawn(`claude -p --model ${MODEL} --allowedTools Read`, { shell: true });
    let out = '', err = '';
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch (_) {} resolve({ ok: false, reason: 'timeout' }); }, PER_TIMEOUT_MS);
    child.stdout.on('data', d => { out += d; });
    child.stderr.on('data', d => { err += d; });
    child.on('error', e => { clearTimeout(timer); resolve({ ok: false, reason: 'spawn:' + e.message }); });
    child.on('close', () => {
      clearTimeout(timer);
      const parsed = extractJson(out);
      if (!parsed) return resolve({ ok: false, reason: 'nojson', raw: (out || err).replace(/\s+/g, ' ').slice(0, 160) });
      resolve({ ok: true, data: parsed });
    });
    try { child.stdin.write(VISION_PROMPT(sharePath)); child.stdin.end(); } catch (_) {}
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
  console.log(`[runner] share=${SHARE} server=${SERVER} model=${MODEL} conc=${CONCURRENCY} limit=${LIMIT || '∞'} folder=${FOLDER_FILTER || '(전체)'} dry=${DRY}`);
  const done = loadDoneSet();
  console.log(`[runner] 이미 캡션됨: ${done.size}장`);

  const todo = [];
  for (const it of walkStarImages(SHARE)) {
    if (FOLDER_FILTER && !it.folder.includes(FOLDER_FILTER)) continue;
    const serverPath = toServerPath(it.sharePath);
    if (done.has(serverPath)) continue;
    todo.push({ sharePath: it.sharePath, folder: it.folder, serverPath });
    if (LIMIT && todo.length >= LIMIT) break;
  }
  console.log(`[runner] 이번 실행 대상: ${todo.length}장`);
  if (!todo.length) { console.log('[runner] 할 것 없음 — 완료됐거나 필터 결과 0'); return; }

  let okN = 0, failN = 0, consecFail = 0, i = 0, aborted = false;
  const t0 = Date.now();
  async function worker() {
    while (i < todo.length && !aborted) {
      const idx = i++;
      const job = todo[idx];
      const r = await captionOne(job.sharePath);
      if (!r.ok) {
        failN++; consecFail++;
        console.log(`  ✗ [${idx + 1}/${todo.length}] ${r.reason} :: ${path.basename(job.sharePath)}${r.raw ? ' | ' + r.raw : ''}`);
        if (consecFail >= 8) { aborted = true; console.error('[runner] 연속 8회 실패 — rate limit 추정. 종료(다음 실행이 이어감).'); }
        continue;
      }
      consecFail = 0;
      if (DRY) { okN++; console.log(`  · [${idx + 1}/${todo.length}] ${job.folder} | ${r.data.type}/${r.data.client || '-'} | ${(r.data.text || '').slice(0, 24)} :: ${path.basename(job.sharePath)}`); continue; }
      const res = await ingest([buildItem(job.serverPath, job.folder, r.data)]);
      if (res.status === 200) {
        okN++; done.add(job.serverPath);
        if (okN % 20 === 0) {
          const rate = (okN + failN) / ((Date.now() - t0) / 1000);
          console.log(`  ✓ ${okN}장 적재 (실패 ${failN}, ${rate.toFixed(2)}장/s) … 최근 ${job.folder} | ${r.data.type}/${r.data.client || '-'}`);
        }
      } else { failN++; console.log(`  ✗ ingest ${res.status}: ${String(res.body).slice(0, 120)}`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const secs = ((Date.now() - t0) / 1000).toFixed(0);
  console.log(`[runner] 종료 — 성공 ${okN}, 실패 ${failN}, ${secs}s. 누적 캡션 ${done.size}장. (다시 실행하면 이어서)`);
})();
