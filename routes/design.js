/**
 * routes/design.js — 시안 검색 + 파일/폴더 열기
 * Mounted at: app.use('/api', require('./routes/design'))
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const designWorkflowStorage = require('./lib/design-workflow-storage');
const designIndexer = require('./lib/design-indexer');
const designGuess = require('./lib/design-guess');

// 썸네일 캐시 폴더
const THUMB_DIR = path.join(__dirname, '..', 'data', 'thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// sharp (이미지 리사이즈 — 미설치 시 원본 전송)
let sharp;
try { sharp = require('sharp'); } catch(e) { /* skip */ }

// ── 시안 검색 ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════

const DESIGN_ROOT = process.env.DESIGN_ROOT || 'D:\\';
// 파일 종류별 확장자 매핑 (검색 대상 전체)
const FILE_TYPES = {
  image: new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']),
  pdf:   new Set(['.pdf']),
  ai:    new Set(['.ai']),
  psd:   new Set(['.psd']),
  excel: new Set(['.xlsx', '.xls', '.xlsm', '.xlsb', '.csv']),
  hwp:   new Set(['.hwp', '.hwpx']),
  word:  new Set(['.docx', '.doc']),
};
// 확장자 → 파일종류 역매핑
const EXT_TO_TYPE = (() => {
  const m = {};
  for (const [type, exts] of Object.entries(FILE_TYPES)) {
    for (const ext of exts) m[ext] = type;
  }
  return m;
})();
const INDEXED_EXTS = new Set(Object.keys(EXT_TO_TYPE));
// 네트워크 공유 경로 (클라이언트에서 폴더 열기용)
const NETWORK_SHARE = '\\\\192.168.0.133\\dd';
function toNetworkPath(localPath) {
  return localPath.replace(/^D:\\/i, NETWORK_SHARE + '\\');
}
function normalizeDesignFilter(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '');
}
function makeFilterTerms(value) {
  return String(value || '')
    .split('|')
    .map(normalizeDesignFilter)
    .filter(Boolean);
}
function matchesAnyDesignTerm(item, terms) {
  if (!terms || terms.length === 0) return true;
  const text = normalizeDesignFilter(item.searchText || '');
  return terms.some(term => text.includes(term));
}

const DESIGN_COLLECTIONS = {
  designerPdf: {
    rootFolders: new Set(['＆디자이너', '&디자이너']),
    subFolders: new Set(['★PDF모음']), // ＆디자이너 폴더 전체가 아니라 이 하위폴더만 — 견적서 등 다른 하위폴더 제외(2026-06-17)
    fileTypes: new Set(['pdf']),
  },
};
function designCollectionFolderKey(value) {
  return String(value || '').replace(/[\s★☆＊*]/g, '').toLowerCase();
}

function getDesignCollection(value) {
  return DESIGN_COLLECTIONS[String(value || '').trim()] || null;
}

function matchesDesignCollection(item, collection) {
  if (!collection) return true;
  const parts = (item && item.parts) || [];
  const root = parts[0];
  if (!root || !collection.rootFolders.has(root)) return false;
  if (collection.subFolders) {
    // 지정 하위폴더(예: ★PDF모음)만 — ★/공백 변형에 견고하게 정규화 비교
    const sub = designCollectionFolderKey(parts[1]);
    if (![...collection.subFolders].some(sf => designCollectionFolderKey(sf) === sub)) return false;
  }
  if (collection.fileTypes && !collection.fileTypes.has(item.fileType)) return false;
  return true;
}

function buildTypeCounts(items) {
  const counts = {};
  for (const t of Object.keys(FILE_TYPES)) counts[t] = 0;
  for (const item of items || []) {
    if (item.fileType && counts[item.fileType] !== undefined) counts[item.fileType]++;
  }
  return counts;
}

const HANGUL_INITIALS = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const HANGUL_MEDIALS = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const HANGUL_FINALS = ['', 'ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const HANGUL_INITIAL_INDEX = new Map(HANGUL_INITIALS.map((v, i) => [v, i]));
const HANGUL_MEDIAL_INDEX = new Map(HANGUL_MEDIALS.map((v, i) => [v, i]));
const HANGUL_FINAL_INDEX = new Map(HANGUL_FINALS.map((v, i) => [v, i]));
const QWERTY_CONSONANTS = {
  r:'ㄱ', R:'ㄲ', s:'ㄴ', e:'ㄷ', E:'ㄸ', f:'ㄹ', a:'ㅁ', q:'ㅂ', Q:'ㅃ',
  t:'ㅅ', T:'ㅆ', d:'ㅇ', w:'ㅈ', W:'ㅉ', c:'ㅊ', z:'ㅋ', x:'ㅌ', v:'ㅍ', g:'ㅎ'
};
const QWERTY_VOWELS = {
  k:'ㅏ', o:'ㅐ', i:'ㅑ', O:'ㅒ', j:'ㅓ', p:'ㅔ', u:'ㅕ', P:'ㅖ',
  h:'ㅗ', y:'ㅛ', n:'ㅜ', b:'ㅠ', m:'ㅡ', l:'ㅣ'
};
const COMPOUND_VOWELS = new Map([
  ['ㅗㅏ','ㅘ'], ['ㅗㅐ','ㅙ'], ['ㅗㅣ','ㅚ'],
  ['ㅜㅓ','ㅝ'], ['ㅜㅔ','ㅞ'], ['ㅜㅣ','ㅟ'],
  ['ㅡㅣ','ㅢ']
]);
const COMPOUND_FINALS = new Map([
  ['ㄱㅅ','ㄳ'], ['ㄴㅈ','ㄵ'], ['ㄴㅎ','ㄶ'], ['ㄹㄱ','ㄺ'], ['ㄹㅁ','ㄻ'],
  ['ㄹㅂ','ㄼ'], ['ㄹㅅ','ㄽ'], ['ㄹㅌ','ㄾ'], ['ㄹㅍ','ㄿ'], ['ㄹㅎ','ㅀ'], ['ㅂㅅ','ㅄ']
]);
const DESIGN_SYNONYMS = {
  '배너': ['베너', '현수막', '플랜카드', '프랑카드'],
  '베너': ['배너', '현수막'],
  '현수막': ['배너', '플랜카드', '프랑카드'],
  '플랜카드': ['현수막', '프랑카드', '배너'],
  '프랑카드': ['플랜카드', '현수막'],
  '안전표지': ['표지판', '안전간판', '표찰'],
  '표지판': ['안전표지', '안전간판', '표찰'],
  '입간판': ['배너거치대', '스탠드배너'],
  '거치대': ['배너거치대', '스탠드'],
  'hdc': ['현대산업개발', '현산'],
  '현산': ['현대산업개발', 'hdc'],
  '현대산업개발': ['hdc', '현산'],
  'posco': ['포스코'],
  '포스코': ['posco'],
  'doosan': ['두산'],
  '두산': ['doosan']
};
let designSearchVocabCache = { key: '', terms: [] };

function composeHangul(lead, vowel, tail) {
  if (!lead || !vowel) return (lead || '') + (vowel || '') + (tail || '');
  const l = HANGUL_INITIAL_INDEX.get(lead);
  const v = HANGUL_MEDIAL_INDEX.get(vowel);
  const t = HANGUL_FINAL_INDEX.get(tail || '');
  if (l == null || v == null || t == null) return lead + vowel + (tail || '');
  return String.fromCharCode(0xac00 + ((l * 21 + v) * 28) + t);
}

function qwertyToHangul(value) {
  const input = String(value || '');
  if (!/[A-Za-z]/.test(input)) return input;
  let out = '';
  let lead = '', vowel = '', tail = '';
  const flush = () => {
    out += composeHangul(lead, vowel, tail);
    lead = ''; vowel = ''; tail = '';
  };
  for (const ch of input) {
    const consonant = QWERTY_CONSONANTS[ch];
    const nextVowel = QWERTY_VOWELS[ch];
    if (!consonant && !nextVowel) {
      flush();
      out += ch;
      continue;
    }
    if (consonant) {
      if (!lead) lead = consonant;
      else if (!vowel) { flush(); lead = consonant; }
      else if (!tail) tail = consonant;
      else {
        const combined = COMPOUND_FINALS.get(tail + consonant);
        if (combined) tail = combined;
        else { flush(); lead = consonant; }
      }
      continue;
    }
    if (!lead) {
      flush();
      vowel = nextVowel;
      flush();
    } else if (!vowel) {
      vowel = nextVowel;
    } else if (tail) {
      const prevTail = tail;
      tail = '';
      flush();
      lead = prevTail;
      vowel = nextVowel;
    } else {
      const combined = COMPOUND_VOWELS.get(vowel + nextVowel);
      if (combined) vowel = combined;
      else { flush(); vowel = nextVowel; flush(); }
    }
  }
  flush();
  return out;
}

function hangulInitials(value) {
  return String(value || '').replace(/[가-힣]/g, ch => {
    const code = ch.charCodeAt(0) - 0xac00;
    if (code < 0 || code > 11171) return ch;
    return HANGUL_INITIALS[Math.floor(code / 588)] || ch;
  }).toLowerCase().replace(/\s+/g, '');
}

function compactDesignSearch(value) {
  return String(value || '').toLowerCase().replace(/[\s_\-\\/.,()[\]{}]+/g, '');
}

function getDesignSearchCache(item) {
  if (!item._smartSearch) {
    const text = String(item.searchText || '').toLowerCase();
    item._smartSearch = {
      text,
      compact: compactDesignSearch(text),
      initials: hangulInitials(text),
    };
  }
  return item._smartSearch;
}

function getDesignSearchVocabulary() {
  const key = `${designIndex.length}|${designIndexStatus.lastBuilt || ''}|${designIndexStatus.lastMode || ''}`;
  if (designSearchVocabCache.key === key) return designSearchVocabCache.terms;
  const counts = new Map();
  for (const item of designIndex) {
    const text = String(item.searchText || '').toLowerCase();
    for (const part of text.split(/[^0-9a-z가-힣]+/i)) {
      const token = part.trim();
      if (token.length < 2 || token.length > 32) continue;
      counts.set(token, (counts.get(token) || 0) + 1);
    }
  }
  const terms = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20000)
    .map(([term]) => term);
  designSearchVocabCache = { key, terms };
  return terms;
}

function editDistanceWithin(a, b, maxDistance) {
  a = String(a || '');
  b = String(b || '');
  if (Math.abs(a.length - b.length) > maxDistance) return maxDistance + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = cur[0];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      const val = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      cur[j] = val;
      if (val < rowMin) rowMin = val;
    }
    if (rowMin > maxDistance) return maxDistance + 1;
    prev = cur;
  }
  return prev[b.length];
}

function fuzzyDesignTerms(token) {
  if (!token || token.length < 2) return [];
  const maxDistance = token.length >= 5 ? 2 : 1;
  const isHangul = /[가-힣]/.test(token);
  const isAlphaNum = /^[0-9a-z]+$/i.test(token);
  if (!isHangul && !isAlphaNum) return [];
  const out = [];
  for (const term of getDesignSearchVocabulary()) {
    if (out.length >= 6) break;
    if (Math.abs(term.length - token.length) > maxDistance) continue;
    if (isHangul !== /[가-힣]/.test(term)) continue;
    if (editDistanceWithin(token, term, maxDistance) <= maxDistance) out.push(term);
  }
  return out;
}

function expandDesignKeyword(keyword) {
  const queue = [String(keyword || '').toLowerCase().trim()];
  const out = new Set();
  for (let i = 0; i < queue.length; i++) {
    const token = queue[i];
    if (!token || out.has(token)) continue;
    out.add(token);
    const typedHangul = qwertyToHangul(token).toLowerCase();
    if (typedHangul && typedHangul !== token) queue.push(typedHangul);
    const compact = compactDesignSearch(token);
    if (compact && compact !== token) queue.push(compact);
    for (const synonym of DESIGN_SYNONYMS[token] || []) queue.push(String(synonym).toLowerCase());
  }
  for (const token of Array.from(out)) {
    for (const fuzzy of fuzzyDesignTerms(token)) out.add(fuzzy);
  }
  return Array.from(out).filter(Boolean);
}

function matchesDesignKeyword(item, alternatives) {
  const cache = getDesignSearchCache(item);
  return alternatives.some(term => {
    const compact = compactDesignSearch(term);
    return cache.text.includes(term)
      || (compact && cache.compact.includes(compact))
      || (/^[ㄱ-ㅎ]+$/.test(term) && cache.initials.includes(term));
  });
}

function cleanHierarchyPart(value) {
  return String(value || '')
    .replace(/[\\/:*?"<>|\r\n\t]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120);
}

function cleanCompanyDisplayName(value) {
  return cleanHierarchyPart(value)
    .replace(/^[★●◆■\s]+/g, '')
    .replace(/\s*시안작업\s*$/g, '')
    .trim();
}

function isYearHierarchyPart(value) {
  const s = cleanHierarchyPart(value);
  return /^20\d{2}(\s*년)?(\s*시안작업)?$/i.test(s)
    || /^\d{2}년(\s*.+)?$/i.test(s)
    || /^20\d{2}\s*시안작업$/i.test(s);
}

function isNoiseHierarchyPart(value) {
  const s = cleanHierarchyPart(value).toLowerCase();
  if (!s || s.length < 2) return true;
  if (isYearHierarchyPart(s)) return true;
  if (s.includes('.')) return true;
  return new Set([
    'backup', 'data', 'temp', 'tmp', 'thumbs', 'images', 'ai', 'pdf', 'jpg', 'png',
    '업무', '내부서류', '결산', '정산', '시안', '원본', '수정', '완료', '최종', '참고',
    '신규', '복사', '반사', '추가', '기타', '도면', '사진', '샘플', '샘플링',
    '관리팀', '견적서', '각종시안 자료', '용품사진', 'price-list-app', '박과장', '핫초코'
  ]).has(s);
}

function isWorkflowCompanyName(value) {
  const s = cleanCompanyDisplayName(value);
  if (isNoiseHierarchyPart(s)) return false;
  if (s.length >= 2 && /(건설|공영|이앤씨|E&C|ENC|스틸|기술|종합|산업|개발|금속|엔지니어링|익스테리어|하우징|공사|코닝|포스코|하츠|나이스텍|퍼시스|㈜|\(주\))/i.test(s)) return true;
  return s.length >= 3 && s.length <= 40;
}

function hierarchyCandidateFromParts(parts) {
  const clean = (parts || []).map(cleanHierarchyPart).filter(Boolean);
  if (clean.length < 3) return null;
  const lastDirIdx = clean.length - 2;
  const firstIsYear = isYearHierarchyPart(clean[0]);
  const companyIdx = firstIsYear ? 1 : 0;
  const yearAfterCompany = isYearHierarchyPart(clean[companyIdx + 1]);
  const projectIdx = yearAfterCompany ? companyIdx + 2 : companyIdx + 1;
  if (projectIdx > lastDirIdx) return null;
  const company = cleanCompanyDisplayName(clean[companyIdx]);
  const project = clean[projectIdx];
  if (!isWorkflowCompanyName(company) || isNoiseHierarchyPart(project)) return null;
  return {
    company,
    project,
    companyFolder: clean[companyIdx],
    yearFolder: yearAfterCompany ? clean[companyIdx + 1] : (firstIsYear ? clean[0] : ''),
  };
}

function designWorkflowOptions() {
  const key = `${DESIGN_ROOT}|${designIndex.length}|${designIndexStatus.lastBuilt || ''}`;
  if (designWorkflowOptionsCache.value && designWorkflowOptionsCache.key === key && Date.now() - designWorkflowOptionsCache.cachedAt < 60 * 1000) {
    return designWorkflowOptionsCache.value;
  }
  const value = designWorkflowStorage.buildWorkflowOptions({
    designIndex,
    designRoot: DESIGN_ROOT,
    skipDirs: SKIP_DIRS,
    includeIndex: false,
  });
  designWorkflowOptionsCache = { key, value, cachedAt: Date.now() };
  return value;
}

function invalidateDesignWorkflowOptions() {
  designWorkflowOptionsCache = { key: '', value: null, cachedAt: 0 };
}

// ── 추천(guess) 프로파일: 폴더별 파일명 어휘. 인덱스 상태 키로 캐시(업로드마다 재계산 금지 — 1회만 빌드) ──
let _guessProfilesCache = { key: '', value: null };
function getGuessProfiles() {
  const minYear = new Date().getFullYear(); // 추천은 올해 폴더만 — 옛(2025↓) 현장 제외(쓸데없는 옛 내역 차단)
  const key = `${designIndex.length}|${designIndexStatus.lastBuilt || ''}|${minYear}`;
  if (_guessProfilesCache.value && _guessProfilesCache.key === key) return _guessProfilesCache.value;
  const value = designGuess.buildProfiles(designIndex, designWorkflowOptions(), { minYear });
  _guessProfilesCache = { key, value };
  return value;
}

let designIndex = [];
let designIndexStatus = { built: false, building: false, count: 0, lastBuilt: null, error: null, lastMode: null, lastFullBuilt: null, durationMs: 0, dirsScanned: 0, dirsReused: 0, fromDisk: false };
let designWorkflowOptionsCache = { key: '', value: null, cachedAt: 0 };

// 폴더 증분 인덱싱 캐시 + 디스크 영속화
let designDirCache = new Map();
let lastFullScanAt = 0;
const MAX_DEPTH = 8;
const FULL_RESCAN_MS = parseInt(process.env.DESIGN_FULL_RESCAN_MS) || 6 * 60 * 60 * 1000;
const INDEX_CACHE_PATH = path.join(__dirname, '..', 'data', 'design-index-cache.json');

// 건너뛸 시스템 폴더
const SKIP_DIRS = new Set([
  'system volume information', 'recycler', '$recycle.bin', 'recovery',
  'windows', 'program files', 'program files (x86)', 'programdata',
  'node_modules', '.git', '__pycache__', 'appdata',
  'price-list-app', 'price-app-list', 'sessions', 'claude',
  'npki', 'acs_backup', 'acserver_5.02_200225_2', 'adt', 'lostark',
  '송지현 대리'
]);

// 검색/자동완성에서 숨길 폴더(회사) 목록 — 사용자가 '숨기기'로 직접 관리(복원 가능). data/design-hidden-folders.json 영속.
const HIDDEN_FOLDERS_PATH = path.join(__dirname, '..', 'data', 'design-hidden-folders.json');
function loadHiddenFolders() {
  try {
    const raw = JSON.parse(fs.readFileSync(HIDDEN_FOLDERS_PATH, 'utf8'));
    return Array.isArray(raw && raw.folders) ? raw.folders.map(s => String(s || '').trim()).filter(Boolean) : [];
  } catch (_) { return []; }
}
function saveHiddenFolders(list) {
  const uniq = [];
  const seen = new Set();
  for (const s of (list || [])) {
    const name = String(s || '').trim();
    const key = designWorkflowStorage.normalizeKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key); uniq.push(name);
  }
  const json = JSON.stringify({ folders: uniq }, null, 2);
  try {
    // 원자적 저장(tmp 작성 후 rename) — 쓰기 중 크래시로 파일이 잘려 숨김이 통째로 풀리는 것 방지.
    const tmp = HIDDEN_FOLDERS_PATH + '.tmp';
    fs.writeFileSync(tmp, json);
    try {
      fs.renameSync(tmp, HIDDEN_FOLDERS_PATH);
    } catch (renameErr) {
      // Windows에서 대상이 동시 읽기로 열려 있으면 rename이 EPERM 날 수 있음 → 직접 쓰기로 폴백(영속 보장 우선).
      fs.writeFileSync(HIDDEN_FOLDERS_PATH, json);
      try { fs.unlinkSync(tmp); } catch (_) {}
    }
  } catch (e) {
    console.error('[design] hidden-folders 저장 실패:', e.message);
    throw e; // 디스크 미저장인데 {ok:true}를 주는 거짓 성공 방지 — 호출자(POST/DELETE)가 500으로 알림
  }
  return uniq;
}
function hiddenFolderKeySet() {
  return new Set(loadHiddenFolders().map(n => designWorkflowStorage.normalizeKey(n)).filter(Boolean));
}

// 인덱스 빌드 로직은 ./lib/design-indexer 로 이전됨 (buildDesignIndex)

let designIndexTimer = null;

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

router.get('/design/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  // types 파라미터: 콤마로 구분된 파일종류 목록 (예: "image,pdf")
  const typesParam = (req.query.types || '').trim();
  const typeFilter = typesParam ? new Set(typesParam.split(',').filter(Boolean)) : null;
  const collectionFilter = getDesignCollection(req.query.collection);
  // 숨긴 폴더(회사) 제외 — DESIGN_ROOT 깊이에 무관하게 경로 '폴더' 구간이든 숨긴 폴더명과 일치하면 제외.
  // 마지막 구간(파일명)은 제외해 매칭면을 좁힘(파일명이 숨긴 회사명과 우연히 같아 오탐하는 것 방지).
  const hiddenSet = hiddenFolderKeySet();
  const notHidden = item => !hiddenSet.size || !(item.parts || []).slice(0, -1).some(p => hiddenSet.has(designWorkflowStorage.normalizeKey(p)));
  const collectionItems = (collectionFilter
    ? designIndex.filter(item => matchesDesignCollection(item, collectionFilter))
    : designIndex).filter(notHidden);

  // 파일종류별 개수 집계 (현재 분류 기준 - 필터 UI에서 숫자 표시용)
  const typeCounts = buildTypeCounts(collectionItems);

  // 회사명 필터: brand (건설사), vendor (발주처) — 공백을 제거하고 소문자 매칭
  const brandTerms = makeFilterTerms(req.query.brand);
  const vendorTerms = makeFilterTerms(req.query.vendor);
  const hasBrandFilter = brandTerms.length > 0;
  const hasVendorFilter = vendorTerms.length > 0;
  const yearFilter = parseInt(req.query.year);
  const hasYearFilter = yearFilter && yearFilter >= 2000 && yearFilter <= 2100;
  const applyYearFilter = (items) => {
    if (!hasYearFilter) return items;
    const yearStart = new Date(yearFilter, 0, 1).getTime();
    const yearEnd = new Date(yearFilter + 1, 0, 1).getTime();
    return items.filter(item => item.mtime >= yearStart && item.mtime < yearEnd);
  };

  if (!q || q === '__countonly__') {
    // 필터만 있고 검색어 없을 때도 목록 검색 허용
    if (collectionFilter || hasBrandFilter || hasVendorFilter || hasYearFilter || (typeFilter && typeFilter.size > 0)) {
      let baseMatches = collectionItems.slice();
      if (hasBrandFilter) baseMatches = baseMatches.filter(item => matchesAnyDesignTerm(item, brandTerms));
      if (hasVendorFilter) baseMatches = baseMatches.filter(item => matchesAnyDesignTerm(item, vendorTerms));
      if (typeFilter && typeFilter.size > 0) baseMatches = baseMatches.filter(item => typeFilter.has(item.fileType));
      baseMatches = applyYearFilter(baseMatches);
      baseMatches.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
      const pageSize = Math.min(200, parseInt(req.query.pageSize) || 40);
      const page = Math.max(1, parseInt(req.query.page) || 1);
      const start = (page - 1) * pageSize;
      const results = baseMatches.slice(start, start + pageSize).map(item => ({
        path: item.path, rel: item.rel, parts: item.parts, name: item.name, aiPath: item.aiPath,
        fileType: item.fileType, ext: item.ext,
        netPath: toNetworkPath(item.aiPath || item.path),
        netFolder: toNetworkPath(path.dirname(item.aiPath || item.path))
      }));
      return res.json({ items: results, total: baseMatches.length, page, pageSize, typeCounts, status: designIndexStatus });
    }
    return res.json({ items: [], total: 0, typeCounts, status: designIndexStatus });
  }
  const keywords = q.split(/\s+/).filter(Boolean);
  const keywordGroups = keywords.map(expandDesignKeyword).filter(group => group.length > 0);
  let matches = collectionItems.filter(item => keywordGroups.every(group => matchesDesignKeyword(item, group)));
  // 회사명 필터 (건설사/발주처) — 공백 제거 비교 (검색어와 별개 AND)
  if (hasBrandFilter) {
    matches = matches.filter(item => matchesAnyDesignTerm(item, brandTerms));
  }
  if (hasVendorFilter) {
    matches = matches.filter(item => matchesAnyDesignTerm(item, vendorTerms));
  }
  // 파일종류 필터
  if (typeFilter && typeFilter.size > 0) {
    matches = matches.filter(item => typeFilter.has(item.fileType));
  }
  // 년도 필터
  matches = applyYearFilter(matches);
  // 최신 수정일 순으로 정렬
  matches.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const total = matches.length;
  // 페이지당 기본 40개, 최대 200개
  const pageSize = Math.min(200, parseInt(req.query.pageSize) || 40);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const start = (page - 1) * pageSize;
  const results = matches.slice(start, start + pageSize).map(item => ({
    path: item.path, rel: item.rel, parts: item.parts, name: item.name, aiPath: item.aiPath,
    fileType: item.fileType, ext: item.ext,
    netPath: toNetworkPath(item.aiPath || item.path),
    netFolder: toNetworkPath(path.dirname(item.aiPath || item.path))
  }));
  res.json({ items: results, total, page, pageSize, typeCounts, status: designIndexStatus });
});

// 파일종류별 아이콘 색/라벨
const TYPE_ICON = {
  pdf:   { bg: '#dc2626', fg: '#ffffff', label: 'PDF' },
  ai:    { bg: '#ea580c', fg: '#ffffff', label: 'AI' },
  psd:   { bg: '#1e40af', fg: '#ffffff', label: 'PSD' },
  excel: { bg: '#16a34a', fg: '#ffffff', label: 'XLSX' },
  hwp:   { bg: '#0284c7', fg: '#ffffff', label: 'HWP' },
  word:  { bg: '#2563eb', fg: '#ffffff', label: 'DOC' },
};
function iconSvg(fileType, ext) {
  const icon = TYPE_ICON[fileType] || { bg: '#64748b', fg: '#ffffff', label: (ext || '').replace('.', '').toUpperCase() };
  const label = icon.label;
  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="240" height="180" viewBox="0 0 240 180">
  <rect width="240" height="180" fill="${icon.bg}"/>
  <g transform="translate(120, 75)">
    <rect x="-32" y="-28" width="64" height="56" rx="6" fill="${icon.fg}" opacity="0.15"/>
    <text x="0" y="8" font-family="-apple-system, Segoe UI, sans-serif" font-size="22" font-weight="700" fill="${icon.fg}" text-anchor="middle">${label}</text>
  </g>
  <text x="120" y="150" font-family="-apple-system, Segoe UI, sans-serif" font-size="11" fill="${icon.fg}" opacity="0.7" text-anchor="middle">파일</text>
</svg>`;
}

// PDF 첫 페이지 → JPEG 썸네일(Ghostscript 설치돼 있을 때만). 없으면 null → 호출부가 아이콘으로 폴백. 결과 캐시.
let _gsBinCache;
function ghostscriptBin() {
  if (_gsBinCache !== undefined) return _gsBinCache;
  const cp = require('child_process');
  for (const bin of ['gswin64c', 'gswin32c', 'gs']) {
    try { cp.execSync('"' + bin + '" --version', { stdio: 'ignore', timeout: 4000, windowsHide: true }); _gsBinCache = bin; return _gsBinCache; } catch (_) {}
  }
  _gsBinCache = '';
  return _gsBinCache;
}
function renderPdfFirstPageThumb(pdfPath) {
  const bin = ghostscriptBin();
  if (!bin) return Promise.resolve(null);
  const out = path.join(THUMB_DIR, 'pdf_' + crypto.createHash('md5').update(pdfPath).digest('hex') + '.jpg');
  try { if (fs.existsSync(out)) return Promise.resolve(out); } catch (_) {}
  return new Promise(resolve => {
    let done = false;
    const finish = v => { if (done) return; done = true; resolve(v); };
    try {
      const cp = require('child_process').spawn(bin, ['-q', '-dNOPAUSE', '-dBATCH', '-dSAFER', '-dFirstPage=1', '-dLastPage=1', '-sDEVICE=jpeg', '-dJPEGQ=72', '-r60', '-sOutputFile=' + out, pdfPath], { windowsHide: true });
      const timer = setTimeout(() => { try { cp.kill(); } catch (_) {} finish(null); }, 12000);
      cp.on('error', () => { clearTimeout(timer); finish(null); });
      cp.on('close', code => { clearTimeout(timer); finish(code === 0 && fs.existsSync(out) ? out : null); });
    } catch (_) { finish(null); }
  });
}

router.get('/design/thumb', requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) return res.status(403).send('forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');

  res.set('Cache-Control', 'public, max-age=86400'); // 24시간 캐시

  const ext = path.extname(resolved).toLowerCase();
  const fileType = EXT_TO_TYPE[ext];

  // PDF는 첫 페이지를 이미지로 렌더(Ghostscript 있을 때)·캐시 — 없으면 아래 아이콘으로 폴백
  if (fileType === 'pdf') {
    try {
      const thumb = await renderPdfFirstPageThumb(resolved);
      if (thumb) return res.type('image/jpeg').sendFile(thumb);
    } catch (_) {}
  }
  // 이미지가 아니면 파일종류 아이콘 SVG 반환
  if (fileType && fileType !== 'image') {
    res.type('image/svg+xml').send(iconSvg(fileType, ext));
    return;
  }

  // 이미지: sharp 있으면 축소된 썸네일 생성/캐시
  if (sharp) {
    const hash = crypto.createHash('md5').update(resolved).digest('hex');
    const thumbPath = path.join(THUMB_DIR, hash + '.jpg');
    if (fs.existsSync(thumbPath)) {
      return res.type('image/jpeg').sendFile(thumbPath);
    }
    try {
      await sharp(resolved).resize(240, 180, { fit: 'cover', withoutEnlargement: true }).jpeg({ quality: 60 }).toFile(thumbPath);
      return res.type('image/jpeg').sendFile(thumbPath);
    } catch(e) {
      // sharp 실패 시 원본 전송 (단 5MB 이하만)
    }
  }

  // sharp 없으면 원본 전송 (5MB 제한)
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > 5 * 1024 * 1024) return res.status(204).end();
  } catch(e) {}
  res.sendFile(resolved);
});

router.get('/design/status', (req, res) => res.json(designIndexStatus));

// ── ★ 폴더 스캔 (이미지 내용검색 색인 범위 — 폴더명에 ★ 들어간 것만) ──
// 컨트롤 시크릿(X-Control-Secret) 또는 로그인 허용 → 배포 자동화에서도 호출 가능.
// ⚠️ async(fs.promises)로만 — 동기 전수 스캔은 이벤트루프를 막아 서버를 멈춤(jobs-detail 사고 교훈).
function designAuthOrControl(req, res, next) {
  const s = req.headers['x-control-secret'];
  const exp = process.env.CONTROL_DAEMON_SECRET;
  if (s && exp && s === exp) return next();
  return requireAuth(req, res, next);
}
async function countImagesUnder(rootDir, cap) {
  let n = 0;
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      if (ent.isDirectory()) stack.push(path.join(dir, ent.name));
      else if (FILE_TYPES.image.has(path.extname(ent.name).toLowerCase())) { n++; if (n >= cap) return n; }
    }
  }
  return n;
}
async function scanStarFolders(root, maxDepth) {
  const out = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length) {
    const { dir, depth } = stack.pop();
    let entries;
    try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = path.join(dir, ent.name);
      if (ent.name.includes('★')) {
        out.push({ name: ent.name, path: full, network: toNetworkPath(full), imageCount: await countImagesUnder(full, 200000) });
      } else if (depth < maxDepth) {
        stack.push({ dir: full, depth: depth + 1 });
      }
    }
  }
  return out;
}
router.get('/design/star-scan', designAuthOrControl, async (req, res) => {
  try {
    if (!fs.existsSync(DESIGN_ROOT)) return res.status(404).json({ ok: false, error: '경로 없음: ' + DESIGN_ROOT });
    const maxDepth = Math.min(6, Math.max(1, parseInt(req.query.depth, 10) || 3));
    const folders = (await scanStarFolders(DESIGN_ROOT, maxDepth)).sort((a, b) => b.imageCount - a.imageCount);
    const totalImages = folders.reduce((s, f) => s + f.imageCount, 0);
    res.json({ ok: true, root: DESIGN_ROOT, maxDepth, folderCount: folders.length, totalImages, folders });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 캡션 검증 (샘플): ★폴더 이미지 N장을 비전으로 한국어 설명 — "AI가 사진을 읽나" 증명용 ──
// 컨트롤 시크릿/로그인. 기존 openaiClient.vision 재사용(신규 설치 0). 소량 검증용.
router.get('/design/caption-sample', designAuthOrControl, async (req, res) => {
  try {
    const folder = String(req.query.folder || '').trim();
    const n = Math.min(40, Math.max(1, parseInt(req.query.n, 10) || 12));
    if (!folder) return res.status(400).json({ ok: false, error: 'folder 필요' });
    const folderPath = path.resolve(DESIGN_ROOT, folder);
    if (!folderPath.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) {
      return res.status(400).json({ ok: false, error: '경로 위반' });
    }
    if (!fs.existsSync(folderPath)) return res.status(404).json({ ok: false, error: '폴더 없음: ' + folderPath });
    const imgs = [];
    const stack = [folderPath];
    while (stack.length && imgs.length < n) {
      const dir = stack.pop();
      let entries; try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const ent of entries) {
        if (imgs.length >= n) break;
        const full = path.join(dir, ent.name);
        if (ent.isDirectory()) stack.push(full);
        else if (FILE_TYPES.image.has(path.extname(ent.name).toLowerCase())) imgs.push(full);
      }
    }
    let openaiClient; try { openaiClient = require('../lib/openai-client'); } catch (e) { openaiClient = null; }
    if (!openaiClient || !openaiClient.apiKeyAvailable()) {
      return res.json({ ok: false, error: 'OPENAI_API_KEY 미설정 — 비전 캡션 불가(서버 .env 확인)', imagesFound: imgs.length });
    }
    const results = [];
    for (const p of imgs) {
      try {
        const r = await openaiClient.vision({
          prompt: '이 이미지가 무엇인지 한국어로 한 문장으로 설명해줘. 그다음 줄에 검색용 키워드 6개를 쉼표로. (종류: 로고/현수막/제품/캐릭터/배경/인물 등 + 핵심 사물·색·분위기 포함)',
          imagePaths: [p], isAdmin: true, maxTokens: 220,
        });
        results.push({ file: path.basename(p), caption: String(r.text || '').trim() });
      } catch (e) { results.push({ file: path.basename(p), error: String(e.message).slice(0, 140) }); }
    }
    res.json({ ok: true, folder, imagesFound: imgs.length, captioned: results.length, results });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ── 내용 캡션 저장소 (로컬 클로드가 그림 읽고 7축 캡션 → 저장 → 내용 검색) ──
const designCaptions = require('../lib/design-captions-db');

// 캡션 ingest — 로컬 캡션 잡이 캡션을 POST(배열 또는 {items:[…]}). 컨트롤시크릿/로그인.
router.post('/design/caption-ingest', designAuthOrControl, express.json({ limit: '8mb' }), (req, res) => {
  try {
    const body = req.body || {};
    const items = Array.isArray(body) ? body : (Array.isArray(body.items) ? body.items : [body]);
    let n = 0;
    for (const it of items) { if (it && it.path) { designCaptions.upsert(it); n++; } }
    res.json({ ok: true, ingested: n, total: designCaptions.count() });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

// 내용 검색(AI 캡션) — 파일명 검색(/design/search)과 분리된 별도 모드. 자유어 q + 패싯 필터.
router.get('/design/content-search', designAuthOrControl, (req, res) => {
  try {
    const { q, client, type, material, usage, folder, limit } = req.query;
    const rows = designCaptions.search({ q, client, type, material, usage, folder, limit });
    const results = rows.map(r => ({
      name: path.basename(r.path), path: r.path, network: toNetworkPath(r.path),
      folder: r.folder, client: r.client, type: r.type, material: r.material,
      usage: r.usage, text: r.text_in, visual: r.visual, size: r.size,
    }));
    res.json({ ok: true, count: results.length, total: designCaptions.count(), facets: designCaptions.facets(), results });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});

router.get('/design/workflow-options', requireAuth, (req, res) => {
  const options = designWorkflowOptions();
  const companyTerm = designWorkflowStorage.normalizeKey(req.query.company);
  let projects = [];
  if (companyTerm) {
    const company = options.companies.find(c => designWorkflowStorage.normalizeKey(c.name) === companyTerm || designWorkflowStorage.normalizeKey(c.folderName) === companyTerm)
      || options.companies.find(c => {
        const nameKey = designWorkflowStorage.normalizeKey(c.name);
        const folderKey = designWorkflowStorage.normalizeKey(c.folderName);
        return (nameKey && (nameKey.includes(companyTerm) || companyTerm.includes(nameKey)))
          || (folderKey && (folderKey.includes(companyTerm) || companyTerm.includes(folderKey)));
      });
    if (company) projects = options.projectLookup[designWorkflowStorage.normalizeKey(company.name)] || options.projectsByCompany[company.name] || [];
  }
  res.json({
    ok: true,
    companies: options.companies,
    projectsByCompany: options.projectsByCompany,
    projectLookup: options.projectLookup,
    projects,
    totals: options.totals,
    status: designIndexStatus,
  });
});

// 파일명들 → top-N (회사·현장) 추천 — 폴더별 파일명 어휘 프로파일(TF-IDF). 회사 누락돼도 위치로 역추적.
router.post('/design/guess-target', requireAuth, (req, res) => {
  try {
    const filenames = (Array.isArray(req.body && req.body.filenames) ? req.body.filenames : [])
      .map(n => String(n || '')).filter(Boolean).slice(0, 12);
    if (!filenames.length) return res.json({ ok: true, candidates: [] });
    const companyKey = req.body.company ? designWorkflowStorage.normalizeKey(req.body.company) : '';
    const topN = Math.min(8, Math.max(1, Number(req.body.topN) || 3));
    const profiles = getGuessProfiles();
    // 회사 지정 시 그 회사로 한정(정확↑). 결과 없으면 전사 폴백(회사 누락/오타 대응).
    let candidates = designGuess.guess(profiles, filenames, { companyKey, topN });
    if (!candidates.length && companyKey) candidates = designGuess.guess(profiles, filenames, { companyKey: '', topN });
    res.json({ ok: true, candidates, profiledFolders: profiles.N });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// 검색·자동완성에서 숨길 폴더(회사) 목록 — 직접 관리(추가/복원). 복원 가능하므로 로그인 사용자 허용.
router.get('/design/hidden-folders', requireAuth, (req, res) => {
  res.json({ ok: true, folders: loadHiddenFolders() });
});
router.post('/design/hidden-folders', requireAuth, (req, res) => {
  const name = String((req.body && req.body.name) || '').trim();
  if (!name) return res.status(400).json({ error: '숨길 폴더명이 필요합니다.' });
  let folders;
  try { folders = saveHiddenFolders([...loadHiddenFolders(), name]); }
  catch (e) { return res.status(500).json({ error: '숨김 목록 저장 실패: ' + e.message }); }
  invalidateDesignWorkflowOptions();
  res.json({ ok: true, folders });
});
router.delete('/design/hidden-folders', requireAuth, (req, res) => {
  const name = String((req.query && req.query.name) || (req.body && req.body.name) || '').trim();
  const key = designWorkflowStorage.normalizeKey(name);
  let folders;
  try { folders = saveHiddenFolders(loadHiddenFolders().filter(n => designWorkflowStorage.normalizeKey(n) !== key)); }
  catch (e) { return res.status(500).json({ error: '숨김 목록 저장 실패: ' + e.message }); }
  invalidateDesignWorkflowOptions();
  res.json({ ok: true, folders });
});

router.post('/design/workflow-folder', requireAuth, (req, res) => {
  try {
    const info = designWorkflowStorage.resolveWorkflowStorage({
      designRoot: DESIGN_ROOT,
      designIndex,
      skipDirs: SKIP_DIRS,
      companyName: req.body.companyName,
      projectName: req.body.projectName,
      year: req.body.year,
      create: true,
    });
    if (info.created) invalidateDesignWorkflowOptions();
    res.json({
      ok: true,
      folder: {
        ...info,
        netPath: toNetworkPath(info.dir),
      },
    });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 내부망 여부 확인
router.get('/session/info', requireAuth, (req, res) => {
  const ip = req.ip || req.connection.remoteAddress || '';
  // 클라우드플레어 터널을 통하면 실제 IP가 CF-Connecting-IP 헤더에 담김
  const cfIp = req.headers['cf-connecting-ip'] || '';
  // CF 헤더가 있으면 → 터널 경유 = 외부 접속
  // CF 헤더가 없고 192.168.0.x 이면 → 직접 내부망 접속
  const isInternal = !cfIp && (ip.includes('192.168.0.') || ip === '127.0.0.1' || ip === '::1' || ip.includes('::ffff:127.'));
  res.json({ isInternal });
});

// 파일 직접 다운로드 (외부 접속 대응)
router.get('/design/file', requireAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) {
    return res.status(403).send('forbidden');
  }
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');
  const filename = path.basename(resolved);
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.sendFile(resolved);
});

// ──────────────────────────────────────────────────────────
// 워터마크 다운로드 — 이미지에 DAELIM SM 로고를 타일 패턴으로 합성
// ──────────────────────────────────────────────────────────
const WATERMARK_IMG_EXTS = new Set(['.jpg', '.jpeg', '.png', '.webp', '.bmp', '.gif']);
const LOGO_PATH = path.join(__dirname, '..', 'data', 'logo.png');

// 워터마크용 로고 (data/logo.png) 를 모듈 로드 시 한 번만 읽어 base64 + 사이즈 캐시
let WATERMARK_LOGO = null;       // { base64, width, height, aspect } 또는 null (로고 없음)
async function preloadWatermarkLogo() {
  if (!sharp) return;
  if (!fs.existsSync(LOGO_PATH)) {
    console.warn('[design] 워터마크 로고 없음:', LOGO_PATH);
    return;
  }
  try {
    // PNG 그대로 읽고 메타만 추출 (리사이즈는 합성 시 SVG <image> 태그가 알아서 처리)
    const meta = await sharp(LOGO_PATH).metadata();
    const buf = fs.readFileSync(LOGO_PATH);
    WATERMARK_LOGO = {
      base64: buf.toString('base64'),
      width: meta.width || 1000,
      height: meta.height || 200,
      aspect: (meta.width || 1000) / (meta.height || 200),
    };
    console.log('[design] 워터마크 로고 로드 OK:', WATERMARK_LOGO.width + 'x' + WATERMARK_LOGO.height);
  } catch (e) {
    console.error('[design] 워터마크 로고 로드 실패:', e.message);
  }
}
preloadWatermarkLogo();

// 이미지 크기에 맞는 SVG 워터마크 생성 (실제 DAELIM SM 로고를 패턴으로 회전 타일링)
function buildWatermarkSvg(width, height) {
  // 로고 한 개의 표시 너비 — 이미지 너비의 18% (큰 이미지에선 더 크게)
  const logoW = Math.max(200, Math.floor(width * 0.18));
  const logoH = WATERMARK_LOGO ? Math.round(logoW / WATERMARK_LOGO.aspect) : 40;
  // 타일 한 칸 — 로고 크기보다 약간 크게 (간격 포함)
  const tileW = Math.round(logoW * 1.6);
  const tileH = Math.round(logoH * 4.5);
  const opacity = 0.28;

  if (WATERMARK_LOGO) {
    // 실제 로고 PNG 를 SVG <image> 로 임베딩하여 패턴화 + 회전
    return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">
  <defs>
    <pattern id="wm" patternUnits="userSpaceOnUse" width="${tileW}" height="${tileH}" patternTransform="rotate(-22)">
      <image xlink:href="data:image/png;base64,${WATERMARK_LOGO.base64}" x="${(tileW - logoW) / 2}" y="${(tileH - logoH) / 2}" width="${logoW}" height="${logoH}" opacity="${opacity}" preserveAspectRatio="xMidYMid meet" />
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#wm)" />
</svg>`;
  }

  // 폴백: 로고 파일 없을 때만 텍스트 기반
  const fontSize = Math.max(28, Math.floor(tileW / 8));
  const subFontSize = Math.max(9, Math.floor(fontSize / 3.5));
  return `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <pattern id="wm" patternUnits="userSpaceOnUse" width="${tileW}" height="${tileH}" patternTransform="rotate(-22)">
      <g font-family="Arial, sans-serif" fill="#374151" fill-opacity="${opacity}">
        <text x="${tileW/2}" y="${tileH/2}" text-anchor="middle" font-size="${subFontSize}" font-weight="600" letter-spacing="2">TOTAL SAFETY GROUP CO., LTD.</text>
        <text x="${tileW/2}" y="${tileH/2 + fontSize * 0.9}" text-anchor="middle" font-size="${fontSize}" font-weight="800" letter-spacing="1">DAELIM SM</text>
      </g>
    </pattern>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#wm)" />
</svg>`;
}

router.get('/design/file-watermarked', requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) {
    return res.status(403).send('forbidden');
  }
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');

  const ext = path.extname(resolved).toLowerCase();
  if (!WATERMARK_IMG_EXTS.has(ext)) {
    return res.status(400).send('이미지 파일만 워터마크 적용 가능합니다');
  }
  if (!sharp) {
    return res.status(503).send('sharp 라이브러리 미설치 — 워터마크 기능 사용 불가');
  }

  try {
    const img = sharp(resolved, { failOn: 'none' });
    const meta = await img.metadata();
    const w = meta.width || 1024;
    const h = meta.height || 768;
    // 너무 큰 이미지는 다운스케일 (4096px 초과 시) — 메모리 보호
    const MAX_DIM = 4096;
    let resizedImg = img;
    let outW = w, outH = h;
    if (w > MAX_DIM || h > MAX_DIM) {
      const ratio = MAX_DIM / Math.max(w, h);
      outW = Math.round(w * ratio);
      outH = Math.round(h * ratio);
      resizedImg = img.resize(outW, outH, { fit: 'inside' });
    }

    const wmSvg = Buffer.from(buildWatermarkSvg(outW, outH), 'utf8');
    const isPng = ext === '.png' || ext === '.webp';
    const composited = await resizedImg
      .composite([{ input: wmSvg, top: 0, left: 0 }])
      .toBuffer({ resolveWithObject: false });

    // 출력 형식: 원본이 PNG/WebP면 PNG 유지, 그 외엔 JPEG (워터마크 합성된 결과)
    const outBuf = isPng
      ? await sharp(composited).png({ quality: 90, compressionLevel: 6 }).toBuffer()
      : await sharp(composited).jpeg({ quality: 88, progressive: true }).toBuffer();

    const baseName = path.basename(resolved, ext);
    const outExt = isPng ? '.png' : '.jpg';
    const outName = baseName + '_watermarked' + outExt;
    res.setHeader('Content-Type', isPng ? 'image/png' : 'image/jpeg');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(outName)}`);
    res.setHeader('Cache-Control', 'private, no-cache');
    res.send(outBuf);
  } catch (e) {
    console.error('[design/file-watermarked] 처리 실패:', e.message);
    res.status(500).send('워터마크 처리 실패: ' + e.message);
  }
});

// 일괄 ZIP 다운로드 — 워터마크 박힌 이미지 여러 장을 한 번에
// POST { paths: [...], includeOriginal: false }
router.post('/design/bulk-zip', requireAuth, async (req, res) => {
  const { paths, includeOriginal } = req.body || {};
  if (!Array.isArray(paths) || paths.length === 0) {
    return res.status(400).json({ error: 'paths 배열 필수' });
  }
  if (paths.length > 200) {
    return res.status(400).json({ error: '한 번에 최대 200개까지' });
  }

  // 모든 경로 검증 + 화이트리스트 (DESIGN_ROOT 안에 있어야 함)
  const validPaths = [];
  for (const p of paths) {
    const resolved = path.resolve(p);
    if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) continue;
    if (!fs.existsSync(resolved)) continue;
    const ext = path.extname(resolved).toLowerCase();
    if (!WATERMARK_IMG_EXTS.has(ext)) continue;  // 이미지만
    validPaths.push(resolved);
  }
  if (validPaths.length === 0) {
    return res.status(400).json({ error: '유효한 이미지 파일 없음' });
  }

  // 원본 다운로드 — 모든 사용자 허용
  const wantOriginal = !!includeOriginal;
  if (!wantOriginal && !sharp) {
    return res.status(503).json({ error: 'sharp 라이브러리 미설치' });
  }

  // archiver 로 ZIP 스트리밍
  let archiver;
  try { archiver = require('archiver'); } catch (e) {
    return res.status(503).json({ error: 'archiver 라이브러리 미설치' });
  }

  const ts = new Date();
  const pad = n => String(n).padStart(2, '0');
  const zipName = `시안_${ts.getFullYear()}-${pad(ts.getMonth()+1)}-${pad(ts.getDate())}_${validPaths.length}장${wantOriginal ? '_원본' : ''}.zip`;

  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
  res.setHeader('Cache-Control', 'private, no-cache');

  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (err) => {
    console.error('[design/bulk-zip] archiver 오류:', err.message);
    if (!res.headersSent) res.status(500).end();
    else res.end();
  });
  archive.pipe(res);

  try {
    for (let i = 0; i < validPaths.length; i++) {
      const p = validPaths[i];
      const ext = path.extname(p).toLowerCase();
      const baseName = path.basename(p, ext);

      if (wantOriginal) {
        // 원본 그대로 첨부
        archive.file(p, { name: baseName + ext });
      } else {
        // 워터마크 합성 후 첨부
        try {
          const img = sharp(p, { failOn: 'none' });
          const meta = await img.metadata();
          const w = meta.width || 1024;
          const h = meta.height || 768;
          const MAX_DIM = 4096;
          let resizedImg = img;
          let outW = w, outH = h;
          if (w > MAX_DIM || h > MAX_DIM) {
            const ratio = MAX_DIM / Math.max(w, h);
            outW = Math.round(w * ratio);
            outH = Math.round(h * ratio);
            resizedImg = img.resize(outW, outH, { fit: 'inside' });
          }
          const wmSvg = Buffer.from(buildWatermarkSvg(outW, outH), 'utf8');
          const isPng = ext === '.png' || ext === '.webp';
          const composited = await resizedImg
            .composite([{ input: wmSvg, top: 0, left: 0 }])
            .toBuffer({ resolveWithObject: false });
          const outBuf = isPng
            ? await sharp(composited).png({ quality: 90, compressionLevel: 6 }).toBuffer()
            : await sharp(composited).jpeg({ quality: 88, progressive: true }).toBuffer();
          const outExt = isPng ? '.png' : '.jpg';
          archive.append(outBuf, { name: baseName + '_watermarked' + outExt });
        } catch (procErr) {
          console.warn('[design/bulk-zip] 파일 처리 실패 (스킵):', p, procErr.message);
        }
      }
    }
    await archive.finalize();
  } catch (e) {
    console.error('[design/bulk-zip] 실패:', e.message);
    archive.destroy();
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// 원본 보기 (inline 전송 — 라이트박스용)
router.get('/design/view', requireAuth, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) {
    return res.status(403).send('forbidden');
  }
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');
  const ext = path.extname(resolved).toLowerCase();
  // 콘텐츠 타입 지정 (브라우저가 inline 렌더링할 수 있는 타입)
  const mimeMap = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.png': 'image/png', '.gif': 'image/gif',
    '.bmp': 'image/bmp', '.webp': 'image/webp',
    '.pdf': 'application/pdf',
  };
  const mime = mimeMap[ext];
  if (mime) res.setHeader('Content-Type', mime);
  // inline 명시 (attachment 아님)
  const filename = path.basename(resolved);
  res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(resolved);
});

router.post('/design/open-folder', requireAuth, (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path 필요' });
  const absPath = path.resolve(DESIGN_ROOT, filePath);
  const folderPath = path.dirname(absPath);
  const { execFile } = require('child_process');
  const platform = process.platform;
  if (platform === 'win32') {
    // execFile은 쉘을 거치지 않아서 특수문자(#, ●, 한글 등) 안전
    execFile('explorer', [folderPath], (err) => {
      // explorer는 성공해도 exit code 1 반환하는 경우가 있음
      res.json({ ok: true });
    });
  } else if (platform === 'darwin') {
    execFile('open', [folderPath], (err) => {
      if (err) res.status(500).json({ error: err.message });
      else res.json({ ok: true });
    });
  } else {
    execFile('xdg-open', [folderPath], (err) => {
      if (err) res.status(500).json({ error: err.message });
      else res.json({ ok: true });
    });
  }
});

// ── 폴더/파일 열기 토큰 (URL 인코딩 문제 우회) ──
const openFolderTokens = new Map(); // token -> { path, type, created }
router.post('/design/openfolder', requireAuth, (req, res) => {
  const { folderPath, openType } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const type = openType === 'file' ? 'file' : openType === 'select' ? 'select' : 'folder';
  openFolderTokens.set(token, { path: folderPath, type, created: Date.now() });
  // 5분 후 자동 삭제
  setTimeout(() => openFolderTokens.delete(token), 5 * 60 * 1000);
  res.json({ token });
});
router.get('/design/openfolder/:token', (req, res) => {
  const data = openFolderTokens.get(req.params.token);
  if (!data) return res.status(404).send('not found');
  openFolderTokens.delete(req.params.token);
  res.send(data.type + '|' + data.path);
});

router.post('/design/reindex', requireAuth, (req, res) => {
  if (designIndexStatus.building) return res.json({ building: true, message: '인덱싱 중...', count: designIndex.length });
  const full = req.query.full === '1' || (req.body && req.body.full === true);
  runDesignIndex({ force: full }); // 기본 증분, ?full=1 이면 전체
  res.json({ building: true, message: full ? '전체 재인덱싱 시작됨' : '증분 재인덱싱 시작됨 (변경된 폴더만)', count: designIndex.length });
});

// 진단용 (관리자) — 브라우저에서 /api/design/debug 로 확인
router.get('/design/debug', requireAdmin, (req, res) => {
  const rootExists = fs.existsSync(DESIGN_ROOT);
  let entries = [];
  if (rootExists) {
    try { entries = fs.readdirSync(DESIGN_ROOT).slice(0, 20); } catch(e) { entries = ['읽기 오류: '+e.message]; }
  }
  res.json({
    DESIGN_ROOT,
    rootExists,
    entries,
    status: designIndexStatus,
    indexedCount: designIndex.length,
    platform: process.platform,
  });
});


// design index 외부 노출 (다른 라우터에서 재사용)
router.getDesignIndex = () => designIndex;
router.getDesignIndexStatus = () => designIndexStatus;
router.getDesignRoot = () => DESIGN_ROOT;
router.toNetworkPath = toNetworkPath;
router.getDesignWorkflowOptions = designWorkflowOptions;
router.resolveWorkflowStorage = (opts = {}) => {
  const info = designWorkflowStorage.resolveWorkflowStorage({
    designRoot: DESIGN_ROOT,
    designIndex,
    skipDirs: SKIP_DIRS,
    ...opts,
  });
  if (info?.created) invalidateDesignWorkflowOptions();
  return info;
};

router.invalidateWorkflowOptions = invalidateDesignWorkflowOptions;

module.exports = router;
