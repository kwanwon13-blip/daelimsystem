/**
 * routes/esm-purchase.js — 대림에스엠 매입명세서 OCR + 매칭 + (이카운트용) 엑셀 출력
 *
 * ⚠️ 컴퍼니(routes/company-purchase.js)와 완전히 분리된 별개 모듈.
 *    - 저장소: data/esm-purchase.db (컴퍼니와 다른 DB)
 *    - 업로드: data/esm-purchase-uploads
 *    - 출력: 에스엠 = 이카운트 (1단계 뼈대에선 이카운트 import용 엑셀, 실제 API 등록은 2단계)
 *
 * 흐름:
 *   POST /parse            사진 → OCR → 사업자번호 정정 → 품목 매칭 → 이력 저장 → JSON
 *   POST /export           편집된 라인 → 이카운트용 엑셀 + 학습 누적
 *   GET  /history          처리이력 목록 (좌측 명세서 목록)
 *   GET  /history/:id      이력 상세 (우측 상세)
 *   GET  /history/:id/image  원본 이미지
 *   GET  /history/:id/export.xlsx  이력에서 엑셀 재다운로드
 *   DELETE /history/:id    명세서 삭제 (잘못 들어온 건 정리)
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const multer = require('multer');
const ExcelJS = require('exceljs');
const Database = require('better-sqlite3');
const claudeClient = require('../lib/claude-client');
const pool = require('../lib/learning-pool');
const vendorResolver = require('../lib/vendor-resolver');

const COMPANY_LABEL = '에스엠';

// ─── inline 인증 (company-purchase 와 동일 패턴) ──
function requireAuth(req, res, next) {
  try {
    const auth = require('../middleware/auth');
    const cookies = auth.parseCookies(req);
    const token = cookies.session_token || req.headers['x-session-token'];
    const sess = token ? auth.sessions[token] : null;
    if (!sess) return res.status(401).json({ ok: false, error: '로그인 필요' });
    req.session = sess;
    next();
  } catch (e) {
    res.status(500).json({ ok: false, error: '인증 실패: ' + e.message });
  }
}

// ─── 업로드 (에스엠 전용 폴더) ─────────────────
const UPLOAD_DIR = path.join(__dirname, '..', 'data', 'esm-purchase-uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: UPLOAD_DIR,
    filename: (req, file, cb) => {
      const ts = Date.now();
      const rand = crypto.randomBytes(3).toString('hex');
      const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';
      cb(null, `esm_${ts}_${rand}${ext}`);
    },
  }),
  limits: { fileSize: 30 * 1024 * 1024 },
});

// ─── SQLite DB (에스엠 전용: 학습매핑 + 처리이력) ──
const DB_PATH = path.join(__dirname, '..', 'data', 'esm-purchase.db');
let _db = null;
function getDB() {
  if (_db) return _db;
  _db = new Database(DB_PATH);
  _db.pragma('journal_mode = WAL');
  _db.exec(`
    CREATE TABLE IF NOT EXISTS learn (
      vendor_key TEXT NOT NULL,
      ocr_key TEXT NOT NULL,
      item TEXT NOT NULL,
      spec TEXT DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (vendor_key, ocr_key)
    );
    CREATE INDEX IF NOT EXISTS idx_learn_vendor ON learn(vendor_key);

    CREATE TABLE IF NOT EXISTS history (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER,
      user_id TEXT,
      user_name TEXT,
      image_filename TEXT,
      vendor_name TEXT,
      vendor_biz_no TEXT,
      trx_date TEXT,
      total_amt INTEGER DEFAULT 0,
      line_count INTEGER DEFAULT 0,
      matched_count INTEGER DEFAULT 0,
      status TEXT DEFAULT 'parsed',
      full_data TEXT,
      confirmed_by TEXT,
      confirmed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_hist_created ON history(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_hist_vendor ON history(vendor_name);
    CREATE INDEX IF NOT EXISTS idx_hist_status ON history(status);
  `);
  return _db;
}

// ─── 학습 매핑 (에스엠 전용 learn 테이블) ──
function findLearnedMapping(vendor, ocrText, ocrSpec) {
  try {
    const db = getDB();
    const ocrKey = `${ocrText}|${ocrSpec || ''}`;
    return db.prepare(`SELECT item, spec FROM learn WHERE vendor_key = ? AND ocr_key = ?`).get(vendor, ocrKey) || null;
  } catch (e) { return null; }
}
function saveLearnedMapping(vendor, ocrText, ocrSpec, item, spec) {
  try {
    const db = getDB();
    const ocrKey = `${ocrText}|${ocrSpec || ''}`;
    const now = Date.now();
    db.prepare(`INSERT INTO learn (vendor_key, ocr_key, item, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT(vendor_key, ocr_key) DO UPDATE SET item=excluded.item, spec=excluded.spec, updated_at=excluded.updated_at`)
      .run(vendor, ocrKey, item, spec || '', now, now);
  } catch (e) { console.error('[esm-purchase] saveLearn 실패:', e.message); }
}
function countLearn() {
  try { return getDB().prepare('SELECT COUNT(*) as c FROM learn').get().c; } catch (_) { return 0; }
}

// ─── 처리이력 ──
function appendHistoryRow(entry) {
  try {
    const db = getDB();
    db.prepare(`INSERT INTO history
      (id, created_at, user_id, user_name, image_filename, vendor_name, vendor_biz_no, trx_date,
       total_amt, line_count, matched_count, status, full_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        entry.id, entry.created_at, entry.user_id || '', entry.user_name || '',
        entry.image_filename || '',
        (entry.vendor && entry.vendor.name) || '', (entry.vendor && entry.vendor.biz_no) || '',
        entry.trx_date || '',
        entry.total_amt || 0,
        (entry.lines || []).filter(l => !l.skip).length,
        (entry.stats && entry.stats.matched) || 0,
        entry.status || 'parsed',
        JSON.stringify(entry)
    );
  } catch (e) { console.error('[esm-purchase] appendHistory 실패:', e.message); }
}
function readHistoryRows(limit = 100) {
  try {
    return getDB().prepare(`SELECT id, created_at, updated_at, user_name, vendor_name, trx_date,
                                   total_amt, line_count, matched_count, status, image_filename
                            FROM history ORDER BY created_at DESC LIMIT ?`).all(limit);
  } catch (e) { return []; }
}
function findHistoryRow(id) {
  try {
    const row = getDB().prepare(`SELECT * FROM history WHERE id = ?`).get(id);
    if (!row) return null;
    if (row.full_data) {
      try { return Object.assign(JSON.parse(row.full_data), { id: row.id, status: row.status }); }
      catch (_) { return row; }
    }
    return row;
  } catch (e) { return null; }
}
function updateHistoryRow(id, patch) {
  try {
    const db = getDB();
    const cur = db.prepare(`SELECT full_data FROM history WHERE id = ?`).get(id);
    if (!cur) return false;
    let merged = {}; try { merged = JSON.parse(cur.full_data || '{}'); } catch (_) {}
    merged = { ...merged, ...patch, updated_at: Date.now() };
    db.prepare(`UPDATE history SET
      updated_at = ?, trx_date = ?, total_amt = ?, line_count = ?, status = ?, full_data = ?,
      confirmed_by = COALESCE(?, confirmed_by), confirmed_at = COALESCE(?, confirmed_at)
      WHERE id = ?`).run(
        Date.now(), merged.trx_date || '', merged.total_amt || 0,
        (merged.lines || []).filter(l => !l.skip).length,
        merged.status || 'parsed', JSON.stringify(merged),
        merged.confirmed_by || null, merged.confirmed_at || null, id);
    return true;
  } catch (e) { return false; }
}
function deleteHistoryRow(id) {
  try {
    const db = getDB();
    const row = db.prepare(`SELECT image_filename FROM history WHERE id = ?`).get(id);
    db.prepare(`DELETE FROM history WHERE id = ?`).run(id);
    // 원본 이미지도 정리
    if (row && row.image_filename) {
      const fp = path.join(UPLOAD_DIR, path.basename(row.image_filename));
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch (_) {}
    }
    return true;
  } catch (e) { console.error('[esm-purchase] delete 실패:', e.message); return false; }
}

// ─── OCR 프롬프트 (매입명세서) ──
const OCR_PROMPT = `이 이미지는 매입명세서 또는 거래명세서야. 다음 JSON 형식으로 정확히 추출해줘:

{
  "vendor": {
    "biz_no": "공급자 사업자등록번호 (예: 705-81-02397)",
    "name": "공급자(매입처) 회사명"
  },
  "buyer": {
    "biz_no": "공급받는자 사업자번호",
    "name": "공급받는자 회사명"
  },
  "trx_date": "거래 일자 (YYYY-MM-DD, 명세서 발행일/납품년월일)",
  "lines": [
    {
      "row_no": 1,
      "ocr_text": "품명 (매입명세서에 적힌 그대로)",
      "spec": "규격 (예: 1270mmx61m)",
      "qty": 수량(숫자),
      "unit_price": 단가(숫자, 원),
      "supply_amt": 공급가액(숫자, 원),
      "vat_amt": 부가세(숫자, 원, 안 보이면 supply_amt*0.1)
    }
  ]
}

규칙:
- 합계/소계/총계/이월금/일계/합 행은 lines에 포함하지 않음
- ocr_text 와 spec 은 매입명세서 원본 그대로 (정규화 X)
- 숫자는 콤마 빼고
- JSON 외 다른 설명 절대 출력하지 말 것`;

function parseOcrJson(text) {
  let s = String(text || '').trim();
  const m = s.match(/```json\s*([\s\S]*?)\s*```/) || s.match(/```\s*([\s\S]*?)\s*```/);
  if (m) s = m[1];
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  return JSON.parse(s);
}

async function runOcr(filePath, mimeType) {
  const buf = fs.readFileSync(filePath);
  const mime = (mimeType && mimeType.startsWith('image/')) ? mimeType : 'image/jpeg';
  if (claudeClient.apiModeAvailable && claudeClient.apiModeAvailable()) {
    const r = await claudeClient.callClaudeApi([{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mime, data: buf.toString('base64') } },
        { type: 'text', text: OCR_PROMPT },
      ],
    }], { maxTokens: 8192, model: 'claude-sonnet-4-6' });
    return parseOcrJson(r.text || '');
  }
  const cliPrompt = `${OCR_PROMPT}\n\n이미지 경로: ${path.resolve(filePath)}`;
  const r = await claudeClient.runClaudeCli(cliPrompt, { timeoutMs: 120000 });
  return parseOcrJson(r.text || '');
}

// ─── 한 장 OCR + 매칭 ──
router.post('/parse', requireAuth, upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ ok: false, error: '파일 없음' });
  try {
    if (!pool.pool.ready) await pool.load();
    const ocr = await runOcr(req.file.path, req.file.mimetype);

    // 사업자번호 우선 매칭 (회사명 잘못 읽어도 정정)
    const corrected = vendorResolver.correctVendor(ocr.vendor || {});
    let vendorName = corrected.name || (ocr.vendor && ocr.vendor.name) || '';
    const trxDate = ocr.trx_date || '';
    const lines = Array.isArray(ocr.lines) ? ocr.lines : [];

    const matched = lines.map((line, i) => {
      const rawText = String(line.ocr_text || '');
      const specRaw = String(line.spec || '');

      const learned = findLearnedMapping(vendorName, rawText, specRaw);
      const masterResult = pool.matchSlideToProductMaster(rawText + ' ' + specRaw + ' ' + (line.qty || ''), {
        vendor: vendorName,
      });
      const m = pool.matchPurchaseLineToPool({
        ocr_text: rawText + ' ' + specRaw,
        qty: line.qty, unit_price: line.unit_price,
      }, { vendor: vendorName, dateStr: trxDate, dayRange: 60 });

      let status, finalItem, finalSpec, finalCode, finalPrice, source, reason;
      if (learned && learned.item) {
        status = 'matched'; source = 'learned';
        finalItem = learned.item; finalSpec = learned.spec || specRaw;
        finalCode = ''; finalPrice = Number(line.unit_price) || 0;
        reason = '사용자 학습';
      } else if (masterResult.status === 'matched') {
        status = 'matched'; source = 'master';
        finalItem = masterResult.item; finalSpec = masterResult.spec;
        finalCode = masterResult.code;
        finalPrice = Number(line.unit_price) || masterResult.priceIn || masterResult.priceOut || 0;
        reason = masterResult.reason;
      } else if (masterResult.status === 'predicted') {
        status = 'predicted'; source = 'master_predict';
        finalItem = masterResult.item; finalSpec = masterResult.spec;
        finalCode = '';
        finalPrice = Number(line.unit_price) || masterResult.priceOut || 0;
        reason = masterResult.reason;
      } else if (m.matched) {
        status = 'matched'; source = 'history';
        finalItem = m.matched.item; finalSpec = m.matched.spec;
        finalCode = '';
        finalPrice = Number(line.unit_price) || m.matched.price || 0;
        reason = m.reason;
      } else {
        status = 'unknown'; source = null;
        finalItem = ''; finalSpec = specRaw; finalCode = '';
        finalPrice = Number(line.unit_price) || 0;
        reason = '마스터에 없음 — 직접 입력 필요';
      }

      const supply = Number(line.supply_amt) || Math.round((line.qty || 0) * finalPrice);
      const vat = Number(line.vat_amt) || Math.round(supply * 0.1);

      return {
        row_no: line.row_no || (i + 1),
        ocr_text: rawText,
        ocr_spec: specRaw,
        item: finalItem,
        spec: finalSpec,
        code: finalCode,
        suggested_options: masterResult.options || [],
        qty: Number(line.qty) || 0,
        unit_price: finalPrice,
        supply_amt: supply,
        vat_amt: vat,
        total_amt: supply + vat,
        status,
        matched: status === 'matched',
        match_source: source,
        match_reason: reason,
        match_suggestion: masterResult.suggestion,
        skip: false,
      };
    });

    const histId = 'e' + Date.now() + crypto.randomBytes(2).toString('hex');
    const histEntry = {
      id: histId,
      created_at: Date.now(),
      user_id: req.session?.userId || 'unknown',
      user_name: req.session?.userName || req.session?.userId || 'unknown',
      image_filename: path.basename(req.file.path),
      vendor: ocr.vendor || null,
      buyer: ocr.buyer || null,
      trx_date: trxDate,
      lines: matched,
      stats: {
        total: matched.length,
        matched: matched.filter(m => m.status === 'matched').length,
        predicted: matched.filter(m => m.status === 'predicted').length,
        unknown: matched.filter(m => m.status === 'unknown').length,
      },
      total_amt: matched.reduce((s, m) => s + (Number(m.total_amt) || 0), 0),
      status: 'parsed',
    };
    appendHistoryRow(histEntry);

    res.json({
      ok: true,
      id: histId,
      vendor: ocr.vendor || null,
      buyer: ocr.buyer || null,
      trx_date: trxDate,
      lines: matched,
      stats: histEntry.stats,
      original_file: histEntry.image_filename,
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: 'OCR 실패: ' + e.message });
  }
});

// ─── 이카운트용 엑셀 출력 + 확정 ──
// (1단계: 이카운트 import용 엑셀. 실제 이카운트 API 등록은 2단계에서.)
function buildWorkbook(trxDate, lines) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('에스엠매입');
  const headers = ['일자', '상품분류', '상품명', '규격', '수량', '단가', '금액', '세액', '합계금액', '비고', '약어'];
  ws.addRow(headers);
  ws.getRow(1).font = { bold: true };
  for (const line of lines) {
    if (line.skip) continue;
    ws.addRow([
      trxDate || '', line.category || '', line.item || '', line.spec || '',
      Number(line.qty) || 0, Number(line.unit_price) || 0,
      Number(line.supply_amt) || 0, Number(line.vat_amt) || 0,
      Number(line.total_amt) || 0, line.memo || '', line.short || '',
    ]);
  }
  ws.columns.forEach((col, i) => { col.width = [12, 10, 30, 22, 8, 10, 12, 10, 12, 14, 8][i] || 12; });
  return wb;
}

router.post('/export', requireAuth, express.json({ limit: '5mb' }), async (req, res) => {
  try {
    const { id, trx_date, vendor_name, lines } = req.body || {};
    if (!Array.isArray(lines) || lines.length === 0) {
      return res.status(400).json({ ok: false, error: '라인 없음' });
    }
    if (id) {
      updateHistoryRow(id, {
        lines, trx_date, status: 'confirmed',
        total_amt: lines.filter(l => !l.skip).reduce((s, l) => s + (Number(l.total_amt) || 0), 0),
        confirmed_by: req.session?.userId || 'unknown',
        confirmed_at: Date.now(),
      });
    }
    // 학습 매핑 저장 (에스엠 전용 learn) — 사용자가 직접 입력/수정한 라인
    if (vendor_name) {
      for (const line of lines) {
        if (line.skip) continue;
        if (line.match_source === 'learned') continue;
        if (line.item && line.ocr_text) {
          saveLearnedMapping(vendor_name, line.ocr_text, line.ocr_spec || '', line.item, line.spec || '');
        }
      }
    }
    const wb = buildWorkbook(trx_date, lines);
    const fname = `에스엠매입_${trx_date || 'noday'}_${(vendor_name || 'vendor').replace(/[^\w가-힣]/g, '')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: '엑셀 생성 실패: ' + e.message });
  }
});

// ─── 처리이력 목록 (좌측 명세서 목록) ──
router.get('/history', requireAuth, (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  res.json({ ok: true, items: readHistoryRows(limit) });
});

// ─── 처리이력 상세 ──
router.get('/history/:id', requireAuth, (req, res) => {
  const h = findHistoryRow(req.params.id);
  if (!h) return res.status(404).json({ ok: false, error: '없음' });
  res.json({ ok: true, ...h });
});

// ─── 원본 이미지 ──
router.get('/history/:id/image', requireAuth, (req, res) => {
  const h = findHistoryRow(req.params.id);
  if (!h || !h.image_filename) return res.status(404).send('Not found');
  const fp = path.join(UPLOAD_DIR, path.basename(h.image_filename));
  if (!fs.existsSync(fp)) return res.status(404).send('Not found');
  res.sendFile(fp);
});

// ─── 이력에서 엑셀 재다운로드 ──
router.get('/history/:id/export.xlsx', requireAuth, async (req, res) => {
  const h = findHistoryRow(req.params.id);
  if (!h) return res.status(404).json({ ok: false, error: '없음' });
  try {
    const wb = buildWorkbook(h.trx_date, h.lines || []);
    const fname = `에스엠매입_${h.trx_date || 'noday'}_${(h.vendor?.name || 'vendor').replace(/[^\w가-힣]/g, '')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    await wb.xlsx.write(res);
    res.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ─── 명세서 삭제 (잘못 들어온 건 정리) ──
router.delete('/history/:id', requireAuth, (req, res) => {
  const h = findHistoryRow(req.params.id);
  if (!h) return res.status(404).json({ ok: false, error: '없음' });
  const ok = deleteHistoryRow(req.params.id);
  res.json({ ok });
});

// ─── Health ──
router.get('/health', (req, res) => {
  try {
    const learnCount = countLearn();
    const histCount = getDB().prepare('SELECT COUNT(*) c FROM history').get().c;
    res.json({ ok: true, company: COMPANY_LABEL, learnCount, historyCount: histCount });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
