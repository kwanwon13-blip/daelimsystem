/**
 * routes/lib/design-guess.js — 폴더별 파일명 어휘 프로파일 기반 (회사·현장) 추천
 *
 * 원리(전수조사 실측으로 검증, recall@3: 회사앎 92~96% / 회사누락 76%):
 *  각 현장 폴더 안에 이미 쌓인 '파일명들'을 학습데이터로 토큰 어휘 프로파일을 만들고,
 *  새 업로드 파일명의 토큰과 겹치는 폴더를 TF-IDF로 점수화 → top-N 추천.
 *  폴더명("마포현장")이 파일명에 없어도, 그 폴더의 기존 파일이 가진 어휘("마포합정")로 매칭됨.
 *  흔한 출력물명(현수막·시트지 등)은 IDF로 자동 약화 → 위치 토큰에 집중.
 *
 * 비용 주의: 프로파일은 designIndex 1패스로 만들고 캐시(인덱스 상태 키)에 묶는다.
 *           절대 업로드마다 전체 인덱스를 순회하지 않는다(서버 부하 사고 방지).
 */
const { normalizeKey, isYearHierarchyPart } = require('./design-workflow-storage');

const STOP = new Set(['시안', '발주', '공장', '디자인', '작업', '견적', '마감', '내역서', '최종', '수정', '완료', '납품', '파일', '원본', '확인', '요청', '출력', '본', '사본', 'copy',
  'ai', 'jpg', 'jpeg', 'png', 'pdf', 'psd', 'xls', 'xlsx', 'doc', 'docx']);

// 파일명/이름 → 의미 토큰(확장자·날짜·범용어 제거). 출력물명은 남기되 IDF가 약화.
function tokenize(s) {
  return String(s || '')
    .replace(/\.[a-z0-9]{1,8}$/i, '')
    .split(/[^\p{L}\p{N}]+/gu)
    .map(t => t.toLowerCase().replace(/[★☆●○■□]/gu, ''))
    .filter(t => t.length >= 2 && !STOP.has(t) && !/^\d{1,8}$/.test(t));
}

const DESIGN_EXT = new Set(['jpg', 'jpeg', 'png', 'ai', 'pdf', 'psd']);

// 연도 폴더명에서 연도(4자리) 추출 — 못 읽으면 null(보수적: 그 폴더는 제외하지 않음)
function yearOfPart(part) {
  const s = String(part || '');
  let m = s.match(/20(\d{2})/);                 // "2026 시안작업", "2025"
  if (m) return 2000 + parseInt(m[1], 10);
  m = s.match(/(?:^|[^\d])(\d{2})\s*년/);        // "26년"
  if (m) return 2000 + parseInt(m[1], 10);
  m = s.match(/^(\d{2})(?!\d)/);                 // 앞 2자리 "26 시안작업"
  if (m) { const y = parseInt(m[1], 10); if (y >= 15 && y <= 60) return 2000 + y; }
  return null;
}

// 같은 (회사키) 다른 표기(★유무 등) 중 대표 폴더 선택용 — ★ 정식 폴더 + 더 구체적(긴) 이름 선호(낮을수록 우선)
function folderRank(name) {
  const s = String(name || '').replace(/^\s+/, '');
  let r = 0;
  if (/^[★☆●○■□]/u.test(s)) r -= 100;
  r -= s.length * 0.01;
  return r;
}

// item.parts(폴더경로 세그먼트) → 유효 (회사,현장) 폴더키 + 실제 폴더명(★포함). minYear 미만(옛) 연도 폴더는 제외.
// validProjByComp = Map(compKey -> Map(projKey -> {companyName, projectName}))
function folderOf(parts, validProjByComp, minYear) {
  if (!Array.isArray(parts) || parts.length < 2) return null;
  const ck = normalizeKey(parts[0]);
  if (!validProjByComp.has(ck)) return null;
  let i = 1;
  if (parts[i] !== undefined && isYearHierarchyPart(parts[i])) {
    if (minYear) {
      const y = yearOfPart(parts[i]);
      if (y && y < minYear) return null; // 옛 연도(예: 2025↓) 현장은 추천에서 제외 — 연도 못 읽으면 보존
    }
    i++;
  }
  if (parts[i] === undefined) return null;
  const pk = normalizeKey(parts[i]);
  const valid = validProjByComp.get(ck);
  if (!valid.has(pk)) return null;
  const meta = valid.get(pk);
  // companyFolder/projectFolder = 디스크의 실제 폴더명(★ 등 마크 그대로) → 저장힌트로 전달돼 '추천=저장' 일치
  return { ck, pk, fk: ck + '|' + pk, companyName: meta.companyName, projectName: meta.projectName, companyFolder: parts[0], projectFolder: parts[i] };
}

// designIndex(flat 파일아이템 배열) + workflowOptions(companies/projectsByCompany) → 프로파일
function buildProfiles(designIndex, workflowOptions, opts = {}) {
  const minYear = opts.minYear || 0;   // 이 연도 미만(옛) 폴더 제외 — 추천을 올해 현장으로 한정
  const validProjByComp = new Map();   // compKey(normalizeKey) -> Map(projKey -> {companyName, projectName})
  const pbc = workflowOptions.projectsByCompany || {};
  const plookup = workflowOptions.projectLookup || {};
  for (const c of (workflowOptions.companies || [])) {
    const name = c.name || c.folderName;
    if (!name) continue;
    const ck = normalizeKey(name);
    if (!ck || validProjByComp.has(ck)) continue;
    const projs = plookup[ck] || pbc[name] || pbc[ck] || [];   // 키가 normalizeKey or 회사명 둘 다 대응
    if (!projs.length) continue;
    const m = new Map();
    for (const p of projs) {
      const pname = (p && (p.name || p.folderName)) || '';
      const pk = normalizeKey(pname);
      if (pk && !m.has(pk)) m.set(pk, { companyName: name, projectName: pname });
    }
    if (m.size) validProjByComp.set(ck, m);
  }

  const folders = new Map(); // fk -> { ck, pk, companyName, projectName, tok: Map(token->count), files }
  for (const item of (designIndex || [])) {
    const ext = String(item.ext || '').replace(/^\./, '').toLowerCase() || String(item.fileType || '').toLowerCase();
    if (!DESIGN_EXT.has(ext)) continue;
    const f = folderOf(item.parts, validProjByComp, minYear);
    if (!f) continue;
    let info = folders.get(f.fk);
    if (!info) { info = { ck: f.ck, pk: f.pk, companyName: f.companyName, projectName: f.projectName, companyFolder: f.companyFolder, projectFolder: f.projectFolder, tok: new Map(), files: 0 }; folders.set(f.fk, info); }
    else { if (folderRank(f.companyFolder) < folderRank(info.companyFolder)) info.companyFolder = f.companyFolder; if (folderRank(f.projectFolder) < folderRank(info.projectFolder)) info.projectFolder = f.projectFolder; }
    info.files++;
    for (const t of tokenize(item.name || '')) info.tok.set(t, (info.tok.get(t) || 0) + 1);
  }
  // 폴더명 자체 토큰도 시드(파일 적은 폴더 대비)
  for (const [, info] of folders) { for (const t of tokenize(info.projectName)) if (!info.tok.has(t)) info.tok.set(t, 1); }

  const df = new Map();        // token -> #folders
  const inverted = new Map();  // token -> [fk]
  for (const [fk, info] of folders) {
    for (const t of info.tok.keys()) {
      df.set(t, (df.get(t) || 0) + 1);
      let lst = inverted.get(t); if (!lst) { lst = []; inverted.set(t, lst); }
      lst.push(fk);
    }
  }
  return { folders, df, inverted, N: folders.size };
}

// 새 파일명들 → top-N (회사·현장) 추천. companyKey 주면 그 회사로 한정(정확도↑), 없으면 전사(회사 누락 대응).
function guess(profiles, filenames, opts = {}) {
  if (!profiles || !profiles.N) return [];
  const { companyKey = '', topN = 3 } = opts;
  const { folders, df, inverted, N } = profiles;
  const toks = [...new Set((filenames || []).flatMap(n => tokenize(n)))];
  if (!toks.length) return [];
  const idf = t => Math.log((N + 1) / ((df.get(t) || 1)));
  const score = new Map();
  for (const t of toks) {
    const lst = inverted.get(t); if (!lst) continue;
    const w = idf(t); if (w <= 0) continue;
    for (const fk of lst) {
      if (companyKey && folders.get(fk).ck !== companyKey) continue;
      score.set(fk, (score.get(fk) || 0) + w);
    }
  }
  const ranked = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, Math.max(1, topN));
  const top = ranked[0] ? ranked[0][1] : 0;
  return ranked.map(([fk, s]) => {
    const f = folders.get(fk);
    return { companyName: f.companyName, projectName: f.projectName, companyFolder: f.companyFolder || '', projectFolder: f.projectFolder || '', files: f.files, score: Math.round(s * 100) / 100, confidence: top ? Math.round((s / top) * 100) / 100 : 0 };
  });
}

module.exports = { buildProfiles, guess, tokenize };
