/**
 * routes/product-design.js
 * 시안 자동 분석 + e2e 등록양식 추출 + 일러스트 자동저장 연동
 *
 * 엔드포인트:
 *   GET  /api/product-design/masters         - 마스터 (건설사/현장/발주처/종류) 반환
 *   GET  /api/product-design/parse           - 단일 파일경로 파싱
 *   POST /api/product-design/parse-batch     - 다수 파일 일괄 파싱
 *   POST /api/product-design/check-name      - 파일명 중복 체크
 *   POST /api/product-design/register        - 시안 메타 등록 (Illustrator 자동저장 후)
 *
 * Mounted at: app.use('/api/product-design', require('./routes/product-design'))
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { requireAuth, sessions, parseCookies } = require('../middleware/auth');

/**
 * 세션 또는 디자이너 토큰 인증 (Illustrator 스크립트용)
 * - 웹 사용자: 세션 쿠키
 * - 일러스트 스크립트: X-Designer-Token 헤더
 */
function authOrDesignerToken(req, res, next) {
  // 1) 세션 쿠키 우선
  try {
    const cookies = parseCookies(req);
    const token = cookies.session_token || req.headers['x-session-token'];
    if (token && sessions[token]) { req.session = sessions[token]; return next(); }
  } catch(e) {}
  // 2) 디자이너 토큰
  const desToken = req.headers['x-designer-token'];
  const expected = process.env.DESIGNER_TOKEN || 'designer-default-key-change-in-env';
  if (desToken && desToken === expected) {
    req.session = { role: 'designer', userId: 'designer-script' };
    return next();
  }
  return res.status(401).json({ error: '로그인 또는 디자이너 토큰 필요' });
}
const parser = require('./lib/design-parser');
const designModule = require('./design');
const db = require('../db');

// ── 마스터 캐시 (24시간) ──
const MASTER_CACHE_DIR = path.join(__dirname, '..', 'data', 'design-masters');
if (!fs.existsSync(MASTER_CACHE_DIR)) fs.mkdirSync(MASTER_CACHE_DIR, { recursive: true });
const MASTER_CACHE_FILE = path.join(MASTER_CACHE_DIR, 'masters.json');
const MASTER_TTL_MS = 24 * 60 * 60 * 1000;

let mastersCache = null;
let mastersCachedAt = 0;

function isCacheValid() {
  return mastersCache && (Date.now() - mastersCachedAt) < MASTER_TTL_MS;
}

/** designIndex 전체에서 마스터 추출 */
function buildMasters() {
  const items = designModule.getDesignIndex();

  const brand = {};        // 건설사 → 빈도
  const vendor = {};       // 발주처 → 빈도
  const site = {};         // 현장명 → 빈도
  const brandSites = {};   // 건설사 → 현장 → 빈도
  const kind = {};         // 종류 → 빈도

  const VENDOR_NOISE = new Set([
    '외국어','주','태,캄,미','&디자이너','&디자','수정','반사','추가','신규',
    '수령','참고','복사','대형','미사용','한국어','앞','뒤','북측','남측','동측','서측',
    '최종','중,베','1','2','3','1단지','2단지','3단지'
  ]);

  for (const it of items) {
    const parts = it.parts || [];
    if (parts[0]) {
      const b = parts[0].replace(/^★+/, '').trim();
      if (b.length >= 2 && !/^[●＆]/.test(b)) {
        brand[b] = (brand[b] || 0) + 1;
        if (parts.length >= 4 && parts[2]) {
          if (!brandSites[b]) brandSites[b] = {};
          brandSites[b][parts[2]] = (brandSites[b][parts[2]] || 0) + 1;
        }
      }
    }
    if (parts.length >= 4 && parts[2]) site[parts[2]] = (site[parts[2]] || 0) + 1;

    const name = (it.name || '').replace(/\.(ai|jpg|jpeg|png|pdf|psd)$/i, '');
    const m = name.match(/[\(（]([^()（）]+)[\)）]/g);
    if (m) for (const v of m) {
      const raw = v.replace(/^[\(（]/,'').replace(/[\)）]$/,'').trim();
      const norm = parser.normalizeVendor(raw);
      if (!norm || VENDOR_NOISE.has(norm)) continue;
      vendor[norm] = (vendor[norm] || 0) + 1;
    }
  }

  // 빈도순 정렬 + 임계값 필터
  function rank(obj, minCount = 5) {
    return Object.entries(obj)
      .filter(([k, v]) => v >= minCount && k.length >= 2)
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => ({ name, count }));
  }

  const result = {
    builtAt: new Date().toISOString(),
    indexedCount: items.length,
    brands: rank(brand, 5),
    vendors: rank(vendor, 5),
    sites: rank(site, 3).slice(0, 200),
    brandSites: Object.fromEntries(
      Object.entries(brandSites).map(([b, sites]) => [
        b,
        Object.entries(sites)
          .filter(([n, c]) => c >= 2)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 50)
          .map(([name, count]) => ({ name, count }))
      ])
    ),
    // 분류룰 — 다이얼로그 종류 드롭다운용
    classificationRules: parser.CLASSIFICATION_RULES.map(([대분류, 소분류, kws]) => ({
      대분류, 소분류, 키워드: kws
    })),
    prefixMap: parser.PREFIX_MAP,
  };

  return result;
}

/** 마스터 캐시 로드 또는 빌드 */
function getMasters(forceRebuild = false) {
  if (!forceRebuild && isCacheValid()) return mastersCache;
  // 디스크 캐시 시도
  if (!forceRebuild && fs.existsSync(MASTER_CACHE_FILE)) {
    try {
      const stat = fs.statSync(MASTER_CACHE_FILE);
      if (Date.now() - stat.mtimeMs < MASTER_TTL_MS) {
        mastersCache = JSON.parse(fs.readFileSync(MASTER_CACHE_FILE, 'utf-8'));
        mastersCachedAt = stat.mtimeMs;
        return mastersCache;
      }
    } catch(e) { /* fall through */ }
  }
  // 새로 빌드
  mastersCache = buildMasters();
  mastersCachedAt = Date.now();
  try { fs.writeFileSync(MASTER_CACHE_FILE, JSON.stringify(mastersCache, null, 2)); } catch(e) {}
  return mastersCache;
}

// ══════════════════════════════════════════════════════════
// GET /masters — 마스터 데이터 반환 (다이얼로그 자동완성용)
// ══════════════════════════════════════════════════════════
router.get('/masters', authOrDesignerToken, (req, res) => {
  try {
    const force = req.query.refresh === '1';
    const masters = getMasters(force);
    res.json({ ok: true, masters });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// GET /parse?path=... — 단일 파일경로 파싱
// ══════════════════════════════════════════════════════════
router.get('/parse', authOrDesignerToken, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path 필수' });
  try {
    const root = designModule.getDesignRoot();
    const parsed = parser.parseDesignPath(filePath, root);
    // OUT- 코드 매칭 시도 (품목마스터에서)
    parsed.제안코드 = lookupProductCode(parsed);
    res.json({ ok: true, parsed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// POST /parse-batch — 다수 파일 일괄 파싱
//   body: { paths: [...] }
// ══════════════════════════════════════════════════════════
router.post('/parse-batch', authOrDesignerToken, (req, res) => {
  const paths = (req.body && req.body.paths) || [];
  try {
    const root = designModule.getDesignRoot();
    const results = paths.map(p => {
      const parsed = parser.parseDesignPath(p, root);
      parsed.제안코드 = lookupProductCode(parsed);
      return parsed;
    });
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// POST /check-name — 파일명 중복 체크
//   body: { folder, names: [...] }
// ══════════════════════════════════════════════════════════
router.post('/check-name', authOrDesignerToken, (req, res) => {
  const folder = (req.body && req.body.folder) || '';
  const names = (req.body && req.body.names) || [];
  const results = {};
  try {
    for (const name of names) {
      const full = path.join(folder, name);
      results[name] = fs.existsSync(full);
    }
    res.json({ ok: true, results });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// POST /register — 시안 메타 등록 (일러스트 자동저장 후 호출)
//   body: { 월일, 건설사, 현장, 종류, 내용, 버전, 발주처, 파일경로[], savedAt }
// ══════════════════════════════════════════════════════════
router.post('/register', authOrDesignerToken, (req, res) => {
  const body = req.body || {};
  try {
    const required = ['건설사', '종류'];
    for (const k of required) {
      if (!body[k]) return res.status(400).json({ error: `${k} 필수` });
    }
    // 파일에 저장 (간단 로그 — 추후 SQLite 테이블로 확장 가능)
    const logDir = path.join(__dirname, '..', 'data', 'design-masters', 'register-log');
    if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
    const yyyy = new Date().getFullYear();
    const logFile = path.join(logDir, `${yyyy}.jsonl`);
    const entry = {
      ...body,
      registeredAt: new Date().toISOString(),
      registeredBy: (req.session && req.session.userId) || null
    };
    fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf-8');
    res.json({ ok: true, entry });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════
// GET /e2e-form?path=... — e2e 등록 양식으로 변환된 텍스트 반환
//   (클립보드 복사용)
// ══════════════════════════════════════════════════════════
router.get('/e2e-form', authOrDesignerToken, (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).json({ error: 'path 필수' });
  try {
    const root = designModule.getDesignRoot();
    const p = parser.parseDesignPath(filePath, root);
    // 탭 구분 텍스트 (e2e 그리드에 붙여넣기 용)
    const code = lookupProductCode(p);
    const lines = [
      ['상품명', p.종류 + (p.내용 ? ('+' + p.내용) : '')],
      ['규격', '(시안에서 직접 입력)'],
      ['수량', '(시안에서 직접 입력)'],
      ['거래처', p.건설사],
      ['프로젝트', p.현장],
      ['상품코드', code],
      ['대분류', p.대분류],
      ['소분류', p.소분류],
      ['비고', p.내용 + (p.발주처.length ? ` / 발주: ${p.발주처.join(', ')}` : '')],
    ];
    const tsv = lines.map(([k, v]) => `${k}\t${v}`).join('\n');
    res.json({ ok: true, parsed: p, tsv, fields: Object.fromEntries(lines) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── helper: 품목마스터에서 OUT/RAW 코드 매칭 ──
function lookupProductCode(parsed) {
  try {
    if (!db.sql || !db.sql.categories) return parser.PREFIX_MAP[parsed.대분류] + '-(신규)';
    // categories 테이블에서 정규화상품명으로 검색
    const norm = (s) => String(s || '').replace(/\s+/g, '').toLowerCase();
    const target = norm(parsed.종류);
    const rows = db.sql.categories.list ? db.sql.categories.list() : [];
    for (const r of rows) {
      if (norm(r.name) === target) return r.code || (parser.PREFIX_MAP[parsed.대분류] + '-?');
    }
  } catch(e) { /* skip */ }
  return parser.PREFIX_MAP[parsed.대분류] + '-(신규)';
}

module.exports = router;
