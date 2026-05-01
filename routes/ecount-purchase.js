/**
 * routes/ecount-purchase.js — 매입명세서 자동 등록 (이카운트 SaveInvoiceAuto)
 * Mounted at: app.use('/api/ecount-purchase', require('./routes/ecount-purchase'))
 *
 * 흐름:
 *   1. POST /parse        매입명세서(PDF/이미지) 업로드 → OCR → 행별 추출 + 매칭
 *   2. POST /confirm      사용자가 매칭 컨펌 (학습 저장)
 *   3. POST /submit       이카운트 SaveInvoiceAuto API 호출
 *   4. GET /candidates    후보 풀 검색 (수동 매핑용)
 *   5. GET /vendor-info   거래처 매입 통계
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const Database = require('better-sqlite3');
const { requireAuth } = require('../middleware/auth');
const claudeClient = require('../lib/claude-client');
const matcher = require('../lib/purchase-matcher');

// ─── DB 연결 ─────────────────────────────────────
const DB_PATH = path.join(__dirname, '..', 'data', '매입자동화.db');
let db = null;
function getDB() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
  }
  return db;
}

// ─── 업로드 ──────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'purchase-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ts = Date.now();
      const rand = crypto.randomBytes(3).toString('hex');
      const ext = path.extname(file.originalname || '').toLowerCase() || '.bin';
      cb(null, `purch_${ts}_${rand}${ext}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 }, // 30MB
});

// ─── OCR 프롬프트 ───────────────────────────────
// 매입명세서/거래내역서 전용 — 구조화된 JSON 추출
const OCR_PROMPT = `이 이미지/문서는 매입명세서 또는 거래명세서야. 다음 JSON 형식으로 정확히 추출해줘:

{
  "vendor": {
    "biz_no": "공급자(매입처) 사업자등록번호 (예: 113-81-66743)",
    "name": "공급자(매입처) 회사명 (㈜/주식회사 포함)"
  },
  "buyer": {
    "biz_no": "공급받는자(우리) 사업자번호",
    "name": "공급받는자 회사명"
  },
  "trx_date": "거래 일자 (YYYY-MM-DD, 명세서 발행일)",
  "lines": [
    {
      "row_no": 1,
      "ocr_text": "품명+규격을 매입명세서에 적힌 그대로 (예: '[별도]열전사 앞_(대림에스엠)DOOSAN오른쪽 반사띠 위')",
      "qty": 수량(숫자),
      "unit_price": 단가(숫자, 원),
      "supply_amt": 공급가액(숫자, 원),
      "vat_amt": 부가세(숫자, 원, 없으면 supply_amt*0.1)
    }
  ]
}

규칙:
- 합계/소계/총액 행은 lines에 포함하지 않음
- ocr_text는 매입명세서에 적힌 원본 그대로 (정규화 X, 우리가 따로 처리)
- 숫자는 콤마 빼고
- 사업자번호는 'XXX-XX-XXXXX' 형식 유지
- JSON 외 다른 설명 절대 출력하지 말 것`;

// ─── PDF 텍스트 직접 추출 (텍스트 레이어 있는 PDF) ──
function tryPdfTextExtract(filePath) {
  // Node에 pypdf 같은 거 없어서 외부 도구 시도
  // 1) pdftotext 명령 (poppler) 있으면 사용
  // 2) 없으면 null 반환 → OCR fallback
  const { spawnSync } = require('child_process');
  try {
    const r = spawnSync('pdftotext', ['-layout', filePath, '-'], {
      encoding: 'utf-8',
      maxBuffer: 10 * 1024 * 1024,
    });
    if (r.status === 0 && r.stdout && r.stdout.trim().length > 50) {
      return r.stdout;
    }
  } catch (e) { /* pdftotext 없으면 무시 */ }
  return null;
}

// ─── OCR 호출 ───────────────────────────────────
async function runOcrForInvoice(filePath, mimeType) {
  // PDF 텍스트 레이어 우선
  if (mimeType === 'application/pdf' || filePath.toLowerCase().endsWith('.pdf')) {
    const text = tryPdfTextExtract(filePath);
    if (text) {
      // 텍스트 추출 성공 → Claude로 구조화만 시킴
      return await callClaudeForStructure(text, 'pdf_text');
    }
  }

  // 이미지 또는 텍스트 추출 실패한 PDF → Claude Vision
  return await callClaudeVision(filePath, mimeType);
}

async function callClaudeVision(filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  const mime = (mimeType && mimeType.startsWith('image/')) ? mimeType : 'image/jpeg';

  if (claudeClient.apiModeAvailable && claudeClient.apiModeAvailable()) {
    const result = await claudeClient.callClaudeApi([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } },
        { type: 'text', text: OCR_PROMPT },
      ],
    }], { maxTokens: 8192 });
    return parseOcrResponse((result && result.text) || '');
  }

  // CLI 모드 fallback
  const cliPrompt = `${OCR_PROMPT}\n\n이미지 경로: ${path.resolve(filePath)}\n위 경로의 이미지를 Read 도구로 읽고 분석해줘.`;
  const result = await claudeClient.callClaudeCli(cliPrompt, { timeoutMs: 120000 });
  return parseOcrResponse(result.text || '');
}

async function callClaudeForStructure(rawText, source) {
  // 텍스트 PDF — Claude가 JSON으로 정리
  const prompt = `${OCR_PROMPT}\n\n--- 추출된 텍스트 ---\n${rawText}\n\n위 텍스트는 매입명세서/거래명세서 PDF에서 추출됐어. JSON으로 구조화해줘.`;

  if (claudeClient.apiModeAvailable && claudeClient.apiModeAvailable()) {
    const result = await claudeClient.callClaudeApi([{
      role: 'user', content: prompt,
    }], { maxTokens: 8192 });
    return parseOcrResponse((result && result.text) || '');
  }

  const result = await claudeClient.callClaudeCli(prompt, { timeoutMs: 120000 });
  return parseOcrResponse(result.text || '');
}

function parseOcrResponse(text) {
  // ```json ... ``` 또는 raw JSON
  let s = text.trim();
  const jsonBlock = s.match(/```json\s*([\s\S]*?)\s*```/) || s.match(/```\s*([\s\S]*?)\s*```/);
  if (jsonBlock) s = jsonBlock[1];

  // 첫 { ~ 마지막 } 범위
  const firstBrace = s.indexOf('{');
  const lastBrace = s.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    s = s.substring(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(s);
  } catch (e) {
    return { _raw: text, _parse_error: e.message };
  }
}

// ─── 라우트 ──────────────────────────────────────

// POST /parse — 매입명세서 업로드 → OCR + 매칭
router.post('/parse', requireAuth, upload.single('file'), async (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ ok: false, error: '파일이 필요합니다' });

  const started = Date.now();

  try {
    // 1. OCR
    const ocrResult = await runOcrForInvoice(file.path, file.mimetype);
    if (ocrResult._parse_error) {
      return res.status(500).json({
        ok: false,
        error: 'OCR 결과 JSON 파싱 실패',
        raw: (ocrResult._raw || '').substring(0, 500)
      });
    }

    // 2. 거래처 식별
    const dbConn = getDB();
    const vendorIdent = matcher.identifyVendor(ocrResult.vendor || {}, dbConn);

    // 3. 행별 매칭
    const lines = (ocrResult.lines || []).map(line => {
      const match = vendorIdent.vendor_name
        ? matcher.matchProduct(vendorIdent.vendor_name, line.ocr_text || '', dbConn)
        : { prod_cd: null, prod_name: null, confidence: 0, method: 'no_vendor', candidates: [] };

      return {
        row_no: line.row_no,
        ocr_text: line.ocr_text,
        qty: line.qty,
        unit_price: line.unit_price,
        supply_amt: line.supply_amt,
        vat_amt: line.vat_amt,
        match: {
          prod_cd: match.prod_cd,
          prod_name: match.prod_name,
          confidence: match.confidence,
          method: match.method,
          candidates: (match.candidates || []).map(c => ({
            prod_cd: c.prod_cd,
            prod_name: c.prod_name,
            score: c.score,
            times: c.times,
            avg_price: c.avg_price,
          })),
        },
      };
    });

    // 4. 통계
    const auto = lines.filter(l => l.match.method === 'auto' || l.match.method === 'shipping_shortcut' || l.match.method === 'learned').length;
    const candidates = lines.filter(l => l.match.method === 'candidate').length;
    const manual = lines.filter(l => l.match.method === 'manual' || l.match.method === 'no_history' || l.match.method === 'no_vendor').length;

    res.json({
      ok: true,
      durationMs: Date.now() - started,
      file: {
        name: file.originalname,
        path: file.path,
        size: file.size,
      },
      vendor: {
        ocr_extracted: ocrResult.vendor,
        identified: vendorIdent,
      },
      buyer: ocrResult.buyer,
      trx_date: ocrResult.trx_date,
      lines,
      stats: {
        total: lines.length,
        auto,
        candidates,
        manual,
        auto_ratio: lines.length > 0 ? auto / lines.length : 0,
      },
    });

  } catch (e) {
    console.error('[ecount-purchase/parse] error:', e);
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// POST /confirm — 사용자가 매칭 컨펌 (학습 저장)
// body: { vendor_name, ocr_text, prod_cd, prod_name }
router.post('/confirm', requireAuth, express.json(), (req, res) => {
  const { vendor_name, ocr_text, prod_cd, prod_name } = req.body || {};
  if (!vendor_name || !ocr_text || !prod_cd) {
    return res.status(400).json({ ok: false, error: 'vendor_name/ocr_text/prod_cd 필요' });
  }
  try {
    const dbConn = getDB();
    const userId = (req.user && req.user.id) || 'unknown';
    matcher.saveLearnedMapping(vendor_name, ocr_text, prod_cd, prod_name || '', userId, dbConn);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// GET /candidates?vendor=&q=  — 후보 풀 검색 (수동 매핑용)
router.get('/candidates', requireAuth, (req, res) => {
  const vendor = req.query.vendor;
  const q = (req.query.q || '').toString().trim();
  if (!vendor) return res.status(400).json({ ok: false, error: 'vendor 필요' });

  try {
    const dbConn = getDB();
    let pool = matcher.getCandidatePool(vendor, dbConn);

    // 키워드 필터 (있으면)
    if (q) {
      const norm = matcher.normalizeForCompare(q);
      pool = pool
        .map(p => ({ ...p, score: matcher.similarity(q, p.prod_name) }))
        .filter(p => matcher.normalizeForCompare(p.prod_name).includes(norm) || p.score > 0.3)
        .sort((a, b) => b.score - a.score || b.times - a.times);
    }

    res.json({ ok: true, vendor, q, total: pool.length, candidates: pool.slice(0, 50) });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// GET /vendor-info — 매입처 통계 (TOP 20 + 검색)
router.get('/vendor-info', requireAuth, (req, res) => {
  try {
    const dbConn = getDB();
    const top = dbConn.prepare(`
      SELECT vendor_name,
             COUNT(*) AS lines,
             COUNT(DISTINCT prod_cd) AS uniq_prods,
             SUM(total_amt) AS total_amt,
             MAX(trx_date) AS last_date
      FROM ecount_purchase_history
      GROUP BY vendor_name
      ORDER BY lines DESC
      LIMIT 20
    `).all();

    const total = dbConn.prepare(`SELECT COUNT(*) AS c FROM ecount_purchase_history`).get().c;
    const learnedCount = dbConn.prepare(`SELECT COUNT(*) AS c FROM ecount_mapping`).get().c;

    res.json({ ok: true, top, total_lines: total, learned_mappings: learnedCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// POST /submit — 이카운트 SaveInvoiceAuto 호출
// body: { lines: [...], vendor_name, trx_date }
// 각 line: { vendor_biz_no, supply_amt, vat_amt, dr_code (매입계정), remarks, ... }
router.post('/submit', requireAuth, express.json(), async (req, res) => {
  // TODO Phase 2 — 매뉴얼 보고 SaveInvoiceAuto API 호출
  // 지금은 stub
  res.json({
    ok: false,
    error: '이카운트 자동등록은 Phase 2에서 구현 — 우선 매칭/학습 정착 후 진행',
    received: req.body,
  });
});

// GET /health
router.get('/health', (req, res) => {
  try {
    const dbConn = getDB();
    const total = dbConn.prepare(`SELECT COUNT(*) AS c FROM ecount_purchase_history`).get().c;
    const prods = dbConn.prepare(`SELECT COUNT(*) AS c FROM ecount_products`).get().c;
    const learned = dbConn.prepare(`SELECT COUNT(*) AS c FROM ecount_mapping`).get().c;
    const apiMode = !!(claudeClient.apiModeAvailable && claudeClient.apiModeAvailable());
    res.json({
      ok: true,
      db: DB_PATH,
      purchase_history: total,
      products: prods,
      learned_mappings: learned,
      ocr_mode: apiMode ? 'api' : 'cli',
    });
  } catch (e) {
    res.json({ ok: false, error: String(e.message || e) });
  }
});

module.exports = router;
