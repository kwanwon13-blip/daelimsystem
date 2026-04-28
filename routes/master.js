/**
 * routes/master.js
 * v7 품목 마스터 엑셀 → API 서빙
 *
 * 설계:
 * - 서버 시작 시 1회 파싱
 * - fs.watch 로 파일 변경 감지 → 자동 재파싱 (debounce 1초)
 * - 30분마다 강제 재로드 (안전망)
 *
 * 마스터 파일 위치 (기본):
 *   D:\price-list-app\data\masters\품목마스터.xlsx
 *   (env MASTER_FILE 로 오버라이드 가능)
 *
 * API:
 *   GET  /api/master/options[?limit=50&minCount=2]  옵션 빈도 (정규화)
 *   GET  /api/master/kinds                          종류(품목명) 마스터
 *   GET  /api/master/rules                          분류룰 + 신규등록규칙
 *   GET  /api/master/status                         파싱 상태
 *   POST /api/master/reload                         강제 재로드
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { sessions, parseCookies } = require('../middleware/auth');

// ── 인증 (세션 또는 디자이너 토큰) ──
function authOrDesignerToken(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies.session_token || req.headers['x-session-token'];
    if (token && sessions[token]) { req.session = sessions[token]; return next(); }
  } catch(e) {}
  const desToken = req.headers['x-designer-token'];
  const expected = process.env.DESIGNER_TOKEN || 'designer-default-key-change-in-env';
  if (desToken && desToken === expected) {
    req.session = { role: 'designer', userId: 'designer-script' };
    return next();
  }
  return res.status(401).json({ error: '로그인 또는 디자이너 토큰 필요' });
}

// ── 마스터 파일 위치 ──
const MASTER_FILE = process.env.MASTER_FILE ||
  path.join(__dirname, '..', 'data', 'masters', '품목마스터.xlsx');

// ── 캐시 ──
const cache = {
  options: [],          // [{ name, count, raw: [원본 토큰들] }]
  optionsRaw: [],       // [{ name, count }] — 정규화 전
  kinds: [],            // ["현수막", "포맥스", ...]
  classRules: [],       // [{ 대분류, 소분류, keywords: [] }]
  registration: [],     // 신규등록규칙 raw rows
  status: {
    fileFound: false,
    lastParsed: null,
    parsing: false,
    error: null,
    fileSize: 0,
    parseTimeMs: 0,
    rowsScanned: 0
  }
};

// ── 옵션 정규화 ──
// "집게4개" → "집게", "상단2타공" → "상단타공", "a4아크릴포켓" → "A4아크릴포켓"
function normalizeOption(raw) {
  let s = String(raw || '').trim();
  if (!s) return '';
  // 수량 접미 제거
  s = s.replace(/\s*\d+\s*개$/, '');
  // 상단N타공 → 상단타공
  s = s.replace(/^상단\d+타공$/, '상단타공');
  // 표기 변형 정규화
  s = s.replace(/^아스테이지/, '아스테지');
  s = s.replace(/^a(\d+)/i, 'A$1');
  return s.trim();
}

// ── 헤더 컬럼 찾기 ──
function findCol(row, candidates) {
  if (!row) return null;
  for (let i = 1; i < (row.values || []).length; i++) {
    const v = String(row.getCell(i).value || '').trim();
    if (candidates.includes(v)) return i;
  }
  return null;
}

// ── 파싱 ──
async function loadMaster() {
  const start = Date.now();
  cache.status.parsing = true;
  cache.status.error = null;

  try {
    if (!fs.existsSync(MASTER_FILE)) {
      cache.status.fileFound = false;
      cache.status.error = `파일 없음: ${MASTER_FILE}`;
      cache.status.parsing = false;
      return;
    }

    const stat = fs.statSync(MASTER_FILE);
    cache.status.fileSize = stat.size;
    cache.status.fileFound = true;

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(MASTER_FILE);

    // ── 1. 품목정리 → 상품명 + 토큰 추출 → 옵션 빈도 ──
    const sheetItems = wb.getWorksheet('품목정리');
    const optionCounts = new Map();      // normalized → count
    const optionRawMap = new Map();      // normalized → Set(원본)
    const optionRawCounts = new Map();   // 원본 → count
    const kindSet = new Set();
    let rowsScanned = 0;

    if (sheetItems) {
      const headerRow = sheetItems.getRow(1);
      const nameCol = findCol(headerRow, ['상품명', '품목명', '품명']) || 1;
      const kindCol = findCol(headerRow, ['종류', '품목종류']);

      sheetItems.eachRow({ includeEmpty: false }, (row, num) => {
        if (num === 1) return;
        rowsScanned++;
        const name = String(row.getCell(nameCol).value || '').trim();
        if (!name) return;

        // 종류 컬럼 우선
        if (kindCol) {
          const k = String(row.getCell(kindCol).value || '').trim();
          if (k) kindSet.add(k);
        }

        // + 옵션 추출
        if (!name.includes('+')) return;
        const tokens = name.split('+').map(t => t.trim()).filter(Boolean);
        // 첫 토큰 = 베이스 (종류 추정)
        if (tokens[0]) {
          const firstKind = tokens[0].split(/\s/)[0].trim();
          if (firstKind && firstKind.length <= 20) kindSet.add(firstKind);
        }
        // 나머지 = 옵션
        tokens.slice(1).forEach(opt => {
          if (!opt || opt.length > 30) return;
          // 원본 빈도
          optionRawCounts.set(opt, (optionRawCounts.get(opt) || 0) + 1);
          // 정규화 빈도
          const norm = normalizeOption(opt);
          if (!norm) return;
          optionCounts.set(norm, (optionCounts.get(norm) || 0) + 1);
          if (!optionRawMap.has(norm)) optionRawMap.set(norm, new Set());
          optionRawMap.get(norm).add(opt);
        });
      });
    }

    cache.options = [...optionCounts.entries()]
      .map(([name, count]) => ({
        name,
        count,
        variants: [...(optionRawMap.get(name) || [])]
      }))
      .sort((a, b) => b.count - a.count);
    cache.optionsRaw = [...optionRawCounts.entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    cache.kinds = [...kindSet].sort();

    // ── 2. 분류룰 시트 → 키워드 → 대/소분류 ──
    const sheetRules = wb.getWorksheet('분류룰');
    cache.classRules = [];
    if (sheetRules) {
      const headerRow = sheetRules.getRow(1);
      const dCol = findCol(headerRow, ['대분류']) || 1;
      const sCol = findCol(headerRow, ['소분류']) || 2;
      const kCol = findCol(headerRow, ['키워드', 'keywords']) || 3;
      sheetRules.eachRow({ includeEmpty: false }, (row, num) => {
        if (num === 1) return;
        const daebun = String(row.getCell(dCol).value || '').trim();
        const sobun = String(row.getCell(sCol).value || '').trim();
        const kwRaw = String(row.getCell(kCol).value || '').trim();
        const keywords = kwRaw.split(/[,，]/).map(s => s.trim()).filter(Boolean);
        if (daebun && sobun) {
          cache.classRules.push({ 대분류: daebun, 소분류: sobun, keywords });
        }
      });
    }

    // ── 3. 신규등록규칙 → raw dump ──
    const sheetReg = wb.getWorksheet('신규등록규칙');
    cache.registration = [];
    if (sheetReg) {
      sheetReg.eachRow({ includeEmpty: false }, (row, num) => {
        if (num === 1) return;
        const arr = (row.values || []).slice(1)
          .map(v => v == null ? '' : String(v).trim());
        if (arr.some(x => x)) cache.registration.push(arr);
      });
    }

    cache.status.lastParsed = new Date().toISOString();
    cache.status.parseTimeMs = Date.now() - start;
    cache.status.rowsScanned = rowsScanned;
    cache.status.parsing = false;
    cache.status.error = null;
    console.log(`[master] 파싱 완료 — 옵션 ${cache.options.length}/${cache.optionsRaw.length}(정규화/원본), 종류 ${cache.kinds.length}, 분류룰 ${cache.classRules.length}, ${cache.status.parseTimeMs}ms`);
  } catch (e) {
    cache.status.parsing = false;
    cache.status.error = e.message;
    console.error('[master] 파싱 오류:', e.message);
  }
}

// ── 파일 변경 감시 (debounce 1s) ──
let watcher = null;
let reloadTimer = null;
function startWatch() {
  const dir = path.dirname(MASTER_FILE);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch(e) {
    console.error('[master] 마스터 디렉토리 생성 실패:', e.message);
    return;
  }
  if (watcher) { try { watcher.close(); } catch(e) {} }
  try {
    watcher = fs.watch(dir, (eventType, filename) => {
      if (filename && filename === path.basename(MASTER_FILE)) {
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => {
          console.log('[master] 파일 변경 감지 → 재로드');
          loadMaster().catch(e => console.error('[master] 재로드 오류:', e.message));
        }, 1000);
      }
    });
    console.log('[master] 파일 감시 시작:', MASTER_FILE);
  } catch (e) {
    console.error('[master] 감시 시작 실패:', e.message);
  }
}

// ── 초기 로드 + 감시 + 30분 안전망 ──
loadMaster().catch(e => console.error('[master] 초기 로드 오류:', e.message));
startWatch();
setInterval(() => loadMaster().catch(()=>{}), 30 * 60 * 1000);

// ══════════════════════════════════════════════════════════
// API
// ══════════════════════════════════════════════════════════

router.get('/options', authOrDesignerToken, (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 50, 500);
  const minCount = Number(req.query.minCount) || 1;
  const raw = req.query.raw === '1' || req.query.raw === 'true';
  const source = raw ? cache.optionsRaw : cache.options;
  const items = source.filter(o => o.count >= minCount).slice(0, limit);
  res.json({
    items,
    total: source.length,
    normalized: !raw,
    lastParsed: cache.status.lastParsed
  });
});

router.get('/kinds', authOrDesignerToken, (req, res) => {
  res.json({
    items: cache.kinds,
    total: cache.kinds.length,
    lastParsed: cache.status.lastParsed
  });
});

router.get('/rules', authOrDesignerToken, (req, res) => {
  res.json({
    classRules: cache.classRules,
    registration: cache.registration,
    lastParsed: cache.status.lastParsed
  });
});

router.get('/status', authOrDesignerToken, (req, res) => {
  res.json({
    ...cache.status,
    file: MASTER_FILE,
    counts: {
      options: cache.options.length,
      optionsRaw: cache.optionsRaw.length,
      kinds: cache.kinds.length,
      classRules: cache.classRules.length,
      registration: cache.registration.length
    }
  });
});

router.post('/reload', authOrDesignerToken, async (req, res) => {
  await loadMaster();
  res.json({ ok: true, status: cache.status });
});

module.exports = router;
