/**
 * routes/design-codes.js
 * 디자이너 시안 작성기 — 표준 코드 CSV 검색 + 엑셀 출력
 *
 * 엔드포인트:
 *   GET  /api/design-codes/list             — 전체 CSV (시안제외 빼고)
 *   GET  /api/design-codes/search?q=...     — typeahead 검색
 *   POST /api/design-codes/export           — 시안 데이터 → 엑셀 다운로드 (검수표시 포함)
 *
 * Mounted at: app.use('/api/design-codes', require('./routes/design-codes'))
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const ExcelJS = require('exceljs');
const { requireAuth, sessions, parseCookies } = require('../middleware/auth');

// 세션 또는 디자이너 토큰 허용 (UXP 패널 호출용)
function authOrDesignerToken(req, res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies.session_token || req.headers['x-session-token'];
    if (token && sessions[token]) { req.session = sessions[token]; return next(); }
  } catch(_){}
  const desToken = req.headers['x-designer-token'];
  const expected = process.env.DESIGNER_TOKEN || 'designer-default-key-change-in-env';
  if (desToken && desToken === expected) {
    req.session = { role: 'designer', userId: 'designer-script' };
    return next();
  }
  return res.status(401).json({ error: '로그인 또는 디자이너 토큰 필요' });
}

const CODES_PATH = path.join(__dirname, '..', 'data', 'design-codes', 'standard-codes.json');

// 메모리 캐시 (재시작 시 다시 로드)
let codesCache = null;
let codesLoadedAt = 0;
const CACHE_TTL = 60 * 60 * 1000; // 1시간

function loadCodes() {
  if (codesCache && (Date.now() - codesLoadedAt) < CACHE_TTL) return codesCache;
  if (!fs.existsSync(CODES_PATH)) {
    throw new Error(`표준 코드 CSV 없음. 먼저 node _extract_standard_codes.js 실행하세요.`);
  }
  codesCache = JSON.parse(fs.readFileSync(CODES_PATH, 'utf8'));
  codesLoadedAt = Date.now();
  return codesCache;
}

// 검색 토큰화 (한글/영문 모두)
function norm(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, '');
}

router.get('/list', authOrDesignerToken, (req, res) => {
  try {
    const all = loadCodes();
    // 시안제외 항목은 빼고 반환 (디자이너 폼에 안 보임)
    const filtered = all.filter(r => r.시안제외 !== 'Y');
    res.json({ ok: true, items: filtered, total: filtered.length, hidden: all.length - filtered.length });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

router.get('/search', authOrDesignerToken, (req, res) => {
  try {
    const q = norm(req.query.q || '');
    if (!q || q.length < 1) return res.json({ ok: true, items: [] });
    const codes = loadCodes();
    const matches = [];
    for (const r of codes) {
      if (r.시안제외 === 'Y') continue;
      const fields = [r.표준명, r.재질, r.두께, r.면, r.옵션].map(norm).join('|');
      if (fields.includes(q)) {
        matches.push(r);
        if (matches.length >= 30) break;
      }
    }
    // 빈도순 정렬 (이미 정렬되어 있긴 하지만 한번 더)
    matches.sort((a, b) => b.사용빈도 - a.사용빈도);
    res.json({ ok: true, items: matches });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * 시안 데이터 → 엑셀 출력
 *
 * Request body:
 *   {
 *     meta: { 일자, 거래처, 현장, 카테고리 },
 *     products: [
 *       {
 *         품명, 재질, 두께, 면, 옵션, 사이즈, 수량,
 *         _matched: true/false (CSV 매칭 됐는지),
 *         _reviewNote: "검수 필요 사유"
 *       }
 *     ]
 *   }
 */
router.post('/export', authOrDesignerToken, async (req, res) => {
  try {
    const { meta, products } = req.body || {};
    if (!Array.isArray(products) || products.length === 0) {
      return res.status(400).json({ ok: false, error: '제품 목록이 비어있습니다.' });
    }

    const wb = new ExcelJS.Workbook();
    wb.creator = '대림에스엠 ERP — 시안 작성기';
    wb.created = new Date();
    const ws = wb.addWorksheet('시안 등록 양식');

    // 메타 정보 (1~5행)
    ws.mergeCells('A1:H1');
    ws.getCell('A1').value = `시안 등록 — ${meta?.일자 || '-'}`;
    ws.getCell('A1').font = { bold: true, size: 14, color: { argb: 'FFFFFFFF' } };
    ws.getCell('A1').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
    ws.getCell('A1').alignment = { horizontal: 'center', vertical: 'middle' };
    ws.getRow(1).height = 28;

    ws.getCell('A2').value = '거래처';  ws.getCell('B2').value = meta?.거래처 || '';
    ws.getCell('A3').value = '현장';    ws.getCell('B3').value = meta?.현장 || '';
    ws.getCell('A4').value = '일자';    ws.getCell('B4').value = meta?.일자 || '';
    ws.getCell('A5').value = '카테고리'; ws.getCell('B5').value = meta?.카테고리 || '';
    for (let r = 2; r <= 5; r++) {
      ws.getCell(`A${r}`).font = { bold: true };
      ws.getCell(`A${r}`).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE7EFFA' } };
    }

    // 헤더 (7행)
    const headers = ['No', '품명', '재질', '두께', '면', '옵션', '사이즈', '수량', '검수'];
    const headerRow = ws.addRow([]);
    headerRow.getCell(1).value = ''; // empty for spacing
    const headerRowNum = ws.addRow(headers).number;
    const headerRowObj = ws.getRow(headerRowNum);
    headerRowObj.eachCell((cell) => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { bottom: { style: 'thin' } };
    });
    headerRowObj.height = 22;

    // 제품 행
    products.forEach((p, idx) => {
      const row = ws.addRow([
        idx + 1,
        p.품명 || '',
        p.재질 || '',
        p.두께 || '',
        p.면 || '',
        p.옵션 || '',
        p.사이즈 || '',
        p.수량 ?? '',
        p._matched === false ? '⚠ 검수 필요' : (p._reviewNote ? `⚠ ${p._reviewNote}` : '✓'),
      ]);
      // 검수 필요한 행은 노란색 배경
      const needsReview = p._matched === false || !!p._reviewNote;
      if (needsReview) {
        row.eachCell((cell) => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF3CD' } };
          cell.font = { color: { argb: 'FF92400E' } };
        });
      }
      row.eachCell((cell) => {
        cell.alignment = { vertical: 'middle' };
        cell.border = { bottom: { style: 'hair', color: { argb: 'FFE5E7EB' } } };
      });
    });

    // 컬럼 너비
    ws.getColumn(1).width = 5;
    ws.getColumn(2).width = 32;
    ws.getColumn(3).width = 14;
    ws.getColumn(4).width = 8;
    ws.getColumn(5).width = 8;
    ws.getColumn(6).width = 24;
    ws.getColumn(7).width = 14;
    ws.getColumn(8).width = 8;
    ws.getColumn(9).width = 16;

    // 검수 안내 (맨 아래)
    const lastRow = ws.lastRow.number;
    ws.mergeCells(`A${lastRow + 2}:I${lastRow + 2}`);
    ws.getCell(`A${lastRow + 2}`).value = '※ 노란색 강조 행은 표준 코드와 불일치하므로 등록 전 확인 필요';
    ws.getCell(`A${lastRow + 2}`).font = { italic: true, size: 11, color: { argb: 'FF92400E' } };

    const buf = await wb.xlsx.writeBuffer();
    const fname = `시안_${(meta?.일자 || '').replace(/-/g, '')}_${(meta?.현장 || '').replace(/[^\w가-힣]/g, '')}.xlsx`;
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`);
    res.send(buf);
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
