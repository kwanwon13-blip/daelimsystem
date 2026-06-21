/**
 * lib/file-extract.js — 첨부 파일 텍스트 추출 / 종류 감지 / 이미지 OCR 유틸
 *
 * routes/ai-history.js 내부에만 있던 추출 헬퍼를 '복제'해 export 한다.
 * (ai-history.js 는 무수정. 변경 최소화를 위해 중복 허용.)
 *
 * export:
 *   detectKind(mime, ext)            → 'image'|'pdf'|'excel'|'word'|'text'|'file'
 *   fixKoreanFilename(name)          → multer latin1 깨짐 복원
 *   extractExcel(filePath, name)     → 엑셀/CSV 텍스트 (exceljs + zip fallback)
 *   extractPdf(filePath)             → PDF 텍스트 (pdf-parse optional)
 *   extractText(filePath)            → 텍스트 파일
 *   isReadFailureExcerpt(text)       → 추출 실패 텍스트 판별
 *   attachmentForClient(a)           → ai_attachments row → 클라 안전형(text_excerpt 제거)
 *   ocrImageToText(absPath, mode)    → 이미지 OCR (CLI 비전 / API multimodal)
 *
 * exceljs · jszip · pdf-parse 는 lazy require + try/catch graceful.
 */
const path = require('path');
const fs = require('fs');
const claudeClient = require('./claude-client');

// ──────────────────────────────────────────────────────────
// 종류 감지 (ai-history.js:3259-3267 복사)
// ──────────────────────────────────────────────────────────
function detectKind(mime, ext) {
  ext = (ext || '').toLowerCase();
  mime = String(mime || '');
  if (/^image\//.test(mime) || /\.(jpe?g|png|gif|webp|bmp)$/.test(ext)) return 'image';
  if (/pdf/.test(mime) || /\.pdf$/.test(ext)) return 'pdf';
  if (/spreadsheet|excel/.test(mime) || /\.(xlsx?|xlsm|xlsb|csv)$/.test(ext)) return 'excel';
  if (/word|msword/.test(mime) || /\.docx?$/.test(ext)) return 'word';
  if (/^text\//.test(mime) || /\.(txt|md|json|log)$/.test(ext)) return 'text';
  return 'file';
}

// ──────────────────────────────────────────────────────────
// XML 디코드 / 엑셀 셀 (ai-history.js 복사)
// ──────────────────────────────────────────────────────────
function decodeXmlText(value) {
  let text = String(value || '');
  for (let i = 0; i < 3; i++) {
    const before = text;
    text = text
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&')
      .replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => {
        try { return String.fromCodePoint(parseInt(hex, 16)); } catch (_) { return ''; }
      })
      .replace(/&#(\d+);/g, (_, dec) => {
        try { return String.fromCodePoint(parseInt(dec, 10)); } catch (_) { return ''; }
      });
    if (text === before) break;
  }
  return text.replace(/_x([0-9A-Fa-f]{4})_/g, (_, hex) => {
    try { return String.fromCharCode(parseInt(hex, 16)); } catch (_) { return ''; }
  });
}

function excelCellToText(cellOrValue) {
  const value = cellOrValue && typeof cellOrValue === 'object' && 'value' in cellOrValue
    ? cellOrValue.value
    : cellOrValue;
  if (value == null) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value !== 'object') return decodeXmlText(value);
  if (Object.prototype.hasOwnProperty.call(value, 'result')) return excelCellToText(value.result);
  if (Object.prototype.hasOwnProperty.call(value, 'text')) return decodeXmlText(value.text || '');
  if (Array.isArray(value.richText)) return decodeXmlText(value.richText.map(r => r.text || '').join(''));
  if (value.hyperlink && value.text) return decodeXmlText(value.text);
  if (value.formula) return value.result == null ? '' : excelCellToText(value.result);
  try { return JSON.stringify(value); } catch (_) { return String(value); }
}

function sheetToRows(sheet, limitRows = 300, limitCols = 60) {
  const rows = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (rows.length >= limitRows) return;
    const maxCol = Math.min(limitCols, row.cellCount || row.actualCellCount || 0);
    const vals = [];
    for (let c = 1; c <= maxCol; c++) vals.push(excelCellToText(row.getCell(c)));
    while (vals.length && vals[vals.length - 1] === '') vals.pop();
    if (vals.some(v => v !== '')) rows.push(vals);
  });
  return rows;
}

function workbookToText(wb) {
  const parts = [];
  wb.eachSheet((sheet) => {
    const rows = sheetToRows(sheet, 1000, 80).map(vals => vals.join('\t'));
    if (rows.length > 0) parts.push(`# ${sheet.name}\n${rows.join('\n')}`);
  });
  return parts.join('\n\n').slice(0, 1000000);
}

// ── XLSX zip fallback (ExcelJS 실패 시) ──
function xmlAttrs(tag) {
  const attrs = {};
  String(tag || '').replace(/([\w:.-]+)="([^"]*)"/g, (_, key, value) => {
    attrs[key] = decodeXmlText(value);
    return _;
  });
  return attrs;
}

function columnNameToIndex(ref) {
  const letters = String(ref || '').match(/[A-Z]+/i);
  if (!letters) return 1;
  let n = 0;
  for (const ch of letters[0].toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return Math.max(1, n);
}

function normalizeZipPath(baseDir, target) {
  let t = String(target || '').replace(/\\/g, '/');
  if (!t) return '';
  if (t.startsWith('/')) t = t.slice(1);
  else if (!t.startsWith('xl/')) t = baseDir.replace(/\/?$/, '/') + t;
  const parts = [];
  for (const part of t.split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return parts.join('/');
}

async function zipText(zip, name) {
  const f = zip.file(name);
  return f ? f.async('string') : '';
}

function parseSharedStringsXml(xml) {
  const shared = [];
  for (const m of String(xml || '').matchAll(/<si\b[\s\S]*?<\/si>/g)) {
    const si = m[0];
    const texts = [];
    for (const tm of si.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) {
      texts.push(decodeXmlText(tm[1]));
    }
    shared.push(texts.join(''));
  }
  return shared;
}

function isBuiltInDateNumFmt(numFmtId) {
  const id = parseInt(numFmtId, 10);
  return (id >= 14 && id <= 22)
    || (id >= 27 && id <= 36)
    || (id >= 45 && id <= 47)
    || (id >= 50 && id <= 58)
    || (id >= 71 && id <= 81);
}

function isDateFormatCode(formatCode) {
  let fmt = decodeXmlText(formatCode || '');
  fmt = fmt
    .replace(/"[^"]*"/g, '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/\\./g, '')
    .toLowerCase();
  return /(yyyy|yy|년|월|일|am\/pm|a\/p)/i.test(fmt)
    || /(^|[^a-z])d{1,4}([^a-z]|$)/i.test(fmt)
    || /(^|[^a-z])h{1,2}([^a-z]|$)/i.test(fmt)
    || /(시|분|초)/.test(fmt);
}

function parseDateStyleIds(stylesXml) {
  const xml = String(stylesXml || '');
  const customFormats = {};
  for (const m of xml.matchAll(/<numFmt\b[^>]*\/?>/g)) {
    const attrs = xmlAttrs(m[0]);
    if (attrs.numFmtId) customFormats[attrs.numFmtId] = attrs.formatCode || '';
  }
  const dateStyles = new Set();
  const cellXfs = (xml.match(/<cellXfs\b[^>]*>([\s\S]*?)<\/cellXfs>/) || [null, ''])[1];
  let idx = 0;
  for (const m of cellXfs.matchAll(/<xf\b[^>]*\/?>/g)) {
    const attrs = xmlAttrs(m[0]);
    const numFmtId = attrs.numFmtId || '0';
    if (isBuiltInDateNumFmt(numFmtId) || isDateFormatCode(customFormats[numFmtId])) {
      dateStyles.add(idx);
    }
    idx++;
  }
  return dateStyles;
}

function excelSerialDateToText(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || n > 100000) return String(raw || '');
  const millis = Math.round((n - 25569) * 86400 * 1000);
  const d = new Date(millis);
  if (Number.isNaN(d.getTime())) return String(raw || '');
  const datePart = d.toISOString().slice(0, 10);
  const fraction = Math.abs(n - Math.floor(n));
  if (fraction < 0.000001) return datePart;
  return `${datePart} ${d.toISOString().slice(11, 19)}`;
}

function parseWorkbookSheets(workbookXml, relsXml) {
  const rels = {};
  for (const m of String(relsXml || '').matchAll(/<Relationship\b[^>]*\/?>/g)) {
    const a = xmlAttrs(m[0]);
    if (a.Id && a.Target) rels[a.Id] = normalizeZipPath('xl', a.Target);
  }
  const sheets = [];
  for (const m of String(workbookXml || '').matchAll(/<sheet\b[^>]*\/?>/g)) {
    const a = xmlAttrs(m[0]);
    const rid = a['r:id'] || a.id || a.Id;
    const pathName = rels[rid];
    if (pathName) sheets.push({ name: a.name || `Sheet${sheets.length + 1}`, path: pathName });
  }
  return sheets;
}

function parseWorksheetRows(xml, sharedStrings, dateStyleIds, limitRows = 1000, limitCols = 80) {
  const rows = [];
  for (const rm of String(xml || '').matchAll(/<row\b[^>]*>[\s\S]*?<\/row>/g)) {
    if (rows.length >= limitRows) break;
    const vals = [];
    for (const cm of rm[0].matchAll(/<c\b([^>]*)>[\s\S]*?<\/c>/g)) {
      const cXml = cm[0];
      const attrs = xmlAttrs(cm[0]);
      const col = Math.min(limitCols, columnNameToIndex(attrs.r));
      if (col < 1 || col > limitCols) continue;
      let text = '';
      const inline = cXml.match(/<is\b[\s\S]*?<\/is>/);
      if (inline) {
        const pieces = [];
        for (const tm of inline[0].matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)) pieces.push(decodeXmlText(tm[1]));
        text = pieces.join('');
      } else {
        const vm = cXml.match(/<v\b[^>]*>([\s\S]*?)<\/v>/);
        const raw = vm ? decodeXmlText(vm[1]) : '';
        if (attrs.t === 's') text = sharedStrings[parseInt(raw, 10)] || '';
        else if (attrs.t === 'b') text = raw === '1' ? 'TRUE' : raw === '0' ? 'FALSE' : raw;
        else if (attrs.s != null && dateStyleIds && dateStyleIds.has(parseInt(attrs.s, 10))) text = excelSerialDateToText(raw);
        else text = raw;
      }
      text = decodeXmlText(text);
      vals[col - 1] = text;
    }
    for (let i = 0; i < vals.length; i++) if (vals[i] == null) vals[i] = '';
    while (vals.length && vals[vals.length - 1] === '') vals.pop();
    if (vals.some(v => v !== '')) rows.push(vals);
  }
  return rows;
}

async function extractXlsxZipSheets(filePath, limitRows = 1000, limitCols = 80) {
  const JSZip = require('jszip');
  const zip = await JSZip.loadAsync(fs.readFileSync(filePath));
  const sharedStrings = parseSharedStringsXml(await zipText(zip, 'xl/sharedStrings.xml'));
  const dateStyleIds = parseDateStyleIds(await zipText(zip, 'xl/styles.xml'));
  let sheets = parseWorkbookSheets(
    await zipText(zip, 'xl/workbook.xml'),
    await zipText(zip, 'xl/_rels/workbook.xml.rels')
  );
  if (!sheets.length) {
    sheets = Object.keys(zip.files)
      .filter(name => /^xl\/worksheets\/sheet\d+\.xml$/i.test(name))
      .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      .map((name, i) => ({ name: `Sheet${i + 1}`, path: name }));
  }
  const parsed = [];
  for (const sheet of sheets.slice(0, 30)) {
    const xml = await zipText(zip, sheet.path);
    const rows = parseWorksheetRows(xml, sharedStrings, dateStyleIds, limitRows, limitCols);
    if (rows.length) parsed.push({ name: sheet.name, rows });
  }
  return parsed;
}

async function extractXlsxZipText(filePath) {
  const sheets = await extractXlsxZipSheets(filePath, 1000, 80);
  return sheets
    .map(sheet => `# ${sheet.name}\n${sheet.rows.map(row => row.join('\t')).join('\n')}`)
    .join('\n\n')
    .slice(0, 1000000);
}

// 엑셀 텍스트 추출 (ai-history.js:3676-3702)
async function extractExcel(filePath, originalName = '') {
  const ext = path.extname(originalName || filePath).toLowerCase();
  try {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    if (ext === '.csv') {
      const ws = await wb.csv.readFile(filePath);
      ws.name = 'CSV';
      return workbookToText(wb);
    }
    if (ext === '.xls' || ext === '.xlsb') {
      return '[Excel read failed: .xls/.xlsb format is not supported on this server. Please save the file as .xlsx or .csv and upload again.]';
    }
    await wb.xlsx.readFile(filePath);
    return workbookToText(wb);
  } catch (e) {
    if (ext === '.xlsx' || ext === '.xlsm') {
      try {
        const fallback = await extractXlsxZipText(filePath);
        if (fallback && fallback.trim()) return fallback;
      } catch (fallbackErr) {
        console.warn('[file-extract] xlsx zip fallback failed:', fallbackErr.message);
      }
    }
    return '[엑셀 읽기 실패: ' + e.message + ']';
  }
}

// PDF 텍스트 추출 — pdf-parse 있으면 사용, 없으면 미추출 (ai-history.js:3705-3716)
async function extractPdf(filePath) {
  try {
    const mod = require('pdf-parse');
    // pdf-parse 2.x: PDFParse 클래스 (new PDFParse({data}).getText())
    if (mod && typeof mod.PDFParse === 'function') {
      const parser = new mod.PDFParse({ data: fs.readFileSync(filePath) });
      try {
        const r = await parser.getText();
        return String((r && r.text) || '').slice(0, 50000);
      } finally { try { if (parser.destroy) await parser.destroy(); } catch (_) {} }
    }
    // pdf-parse 1.x: 함수 (pdf(buffer).then)
    const fn = (typeof mod === 'function') ? mod : (mod && mod.default);
    if (typeof fn !== 'function') return '[PDF 읽기 실패: pdf-parse 형식 오류]';
    const data = await fn(fs.readFileSync(filePath));
    return (data.text || '').slice(0, 50000);
  } catch (e) {
    if (/Cannot find module/.test(e.message)) {
      return '[PDF 텍스트 추출 미설치 — npm install pdf-parse 하면 추출 가능]';
    }
    return '[PDF 읽기 실패: ' + e.message + ']';
  }
}

// 텍스트 파일 (ai-history.js:3719-3723)
function extractText(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8').slice(0, 50000);
  } catch (e) { return ''; }
}

// multer 가 파일명을 latin1 로 해석 → utf8 복원 (ai-history.js:3726-3734)
function fixKoreanFilename(name) {
  if (!name) return '';
  try {
    return Buffer.from(name, 'latin1').toString('utf8');
  } catch (e) {
    return name;
  }
}

// 추출 실패 텍스트 판별 (ai-history.js:1486-1490)
function isReadFailureExcerpt(text) {
  const s = String(text || '');
  return !s.trim()
    || /읽기 실패|read failed|Cannot read properties of undefined|reading ['"]anchors['"]|not supported on this server/i.test(s);
}

// ai_attachments row → 클라 안전형. 화이트리스트 필드만 노출
//   (text_excerpt·owner_id·stored_name·created_at 등 내부 필드 절대 미노출 — 정보누설/IDOR 표면 축소).
function attachmentForClient(a) {
  if (!a) return a;
  const text = String(a.text_excerpt || '');
  const needsText = ['excel', 'pdf', 'word', 'text'].includes(String(a.kind || '').toLowerCase());
  const failed = needsText && isReadFailureExcerpt(text);
  return {
    id: a.id,
    original_name: a.original_name,
    mime: a.mime,
    size: a.size,
    kind: a.kind,
    text_chars: failed ? 0 : text.length,
    parse_status: !needsText ? 'stored' : (failed ? 'failed' : 'ready'),
    parse_note: failed
      ? (text.replace(/^\[/, '').replace(/\]$/, '').slice(0, 180) || '텍스트 추출 실패')
      : (needsText ? '읽기 완료' : '원본 보관'),
  };
}

// ──────────────────────────────────────────────────────────
// 이미지 OCR (ai-ocr.js:48-91 의 CLI/API 분기를 함수화)
// ──────────────────────────────────────────────────────────
const OCR_PROMPTS = {
  plain: '이 이미지의 모든 텍스트를 정확히 추출해줘. 줄바꿈도 그대로 유지. 다른 설명/번역/마크업 없이 추출된 텍스트만 출력.',
  multilingual: '이 사진/이미지 안의 모든 문자를 원문 언어 그대로 정확히 OCR 해줘. 한국어, 영어, 중국어, 태국어, 미얀마어 등 여러 언어가 섞여 있으면 보이는 순서와 줄바꿈을 최대한 유지하고, 번역하지 마라. 숫자/영문/기호도 문맥에 붙어 있으면 함께 적어라. 흐리거나 안 보이는 글자는 추측하지 말고, 다른 설명/마크업 없이 추출된 텍스트만 출력.',
};

// 절대경로 이미지 → 추출 텍스트(string). 실패 시 throw 하지 않고 빈/에러문자열 반환은 호출부에서 처리.
async function ocrImageToText(absPath, mode = 'plain') {
  const prompt = OCR_PROMPTS[mode] || OCR_PROMPTS.plain;
  const safeAbs = path.resolve(absPath);     // 프롬프트엔 절대경로만 주입
  if (claudeClient.apiModeAvailable && claudeClient.apiModeAvailable()) {
    const fileBuffer = fs.readFileSync(safeAbs);
    let mime = 'image/png';
    const ext = path.extname(safeAbs).toLowerCase();
    if (/\.jpe?g$/.test(ext)) mime = 'image/jpeg';
    else if (/\.gif$/.test(ext)) mime = 'image/gif';
    else if (/\.webp$/.test(ext)) mime = 'image/webp';
    else if (/\.bmp$/.test(ext)) mime = 'image/bmp';
    const b64 = fileBuffer.toString('base64');
    const result = await claudeClient.callClaudeApi(
      [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mime, data: b64 } },
          { type: 'text', text: prompt },
        ],
      }],
      { maxTokens: 4096 }
    );
    return String((result && result.text) || '').trim();
  }
  // CLI 모드 — Read 도구로 절대경로 이미지 읽기
  const cliPrompt = prompt + '\n\n이미지 파일: ' + safeAbs
    + '\n\n위 파일을 Read 도구로 읽고 위 지시대로 텍스트만 출력해줘.';
  const result = await claudeClient.runClaudeCli(cliPrompt, { allowedTools: 'Read' });
  return String((result && result.text) || '').trim();
}

module.exports = {
  detectKind,
  fixKoreanFilename,
  extractExcel,
  extractPdf,
  extractText,
  isReadFailureExcerpt,
  attachmentForClient,
  ocrImageToText,
};
