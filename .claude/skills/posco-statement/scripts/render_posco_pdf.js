#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');

const [, , payloadPath, outputPath] = process.argv;
if (!payloadPath || !outputPath) {
  console.error('Usage: node render_posco_pdf.js <payload.json> <output.pdf>');
  process.exit(2);
}

const payload = JSON.parse(fs.readFileSync(payloadPath, 'utf8'));

function fontCandidates() {
  const windir = process.env.WINDIR || 'C:\\Windows';
  return {
    regular: [
      path.join(windir, 'Fonts', 'malgun.ttf'),
      'C:\\Windows\\Fonts\\malgun.ttf',
    ],
    bold: [
      path.join(windir, 'Fonts', 'malgunbd.ttf'),
      'C:\\Windows\\Fonts\\malgunbd.ttf',
    ],
  };
}

function firstExisting(list) {
  return list.find((p) => {
    try { return fs.existsSync(p); } catch (_) { return false; }
  }) || null;
}

const fonts = fontCandidates();
const regularFont = firstExisting(fonts.regular);
const boldFont = firstExisting(fonts.bold) || regularFont;

function setFont(doc, bold = false) {
  const selected = bold ? boldFont : regularFont;
  if (selected) doc.font(selected);
  else doc.font(bold ? 'Helvetica-Bold' : 'Helvetica');
}

function cleanText(value) {
  return String(value == null ? '' : value).replace(/\r\n/g, '\n').trim();
}

function drawCell(doc, x, y, w, h, text, opts = {}) {
  doc.rect(x, y, w, h).stroke('#111111');
  setFont(doc, !!opts.bold);
  doc.fontSize(opts.fontSize || 8);
  doc.fillColor('#111111');
  doc.text(cleanText(text), x + 3, y + 4, {
    width: Math.max(1, w - 6),
    height: Math.max(1, h - 6),
    align: opts.align || 'left',
    lineGap: 1,
    ellipsis: true,
  });
}

function textHeight(doc, text, width, fontSize = 8, bold = false) {
  setFont(doc, bold);
  doc.fontSize(fontSize);
  return doc.heightOfString(cleanText(text), { width: Math.max(1, width - 6), lineGap: 1 }) + 8;
}

function drawHeader(doc, group) {
  const left = doc.page.margins.left;
  const top = doc.page.margins.top;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  setFont(doc, true);
  doc.fontSize(20).text('거래 명세표', left, top, { width, align: 'center' });

  let y = top + 32;
  const half = width / 2;
  drawCell(doc, left, y, half, 20, `작성일: ${group.issueDate}`, { fontSize: 8 });
  drawCell(doc, left + half, y, half, 20, `일자-No.: ${group.key}`, { align: 'right', fontSize: 8 });
  y += 20;
  drawCell(doc, left, y, half, 48, `공급받는자: ㈜ 포스코이앤씨\n현장: ${group.project}`, { fontSize: 8 });
  drawCell(doc, left + half, y, half, 48, '공급자: (주)엔투비\n등록번호: 220-81-96244\n서울시 강남구 봉은사로 514 포스코타워-삼성', { fontSize: 8 });
  y += 48;
  drawCell(doc, left, y, half, 22, `합계 금액: ${group.totalText} 원정`, { fontSize: 9, bold: true });
  drawCell(doc, left + half, y, half, 22, `공급가액 ${group.supplyText} / 부가세 ${group.taxText}`, { align: 'right', fontSize: 8 });
  return y + 30;
}

function drawStatement(doc, group) {
  let y = drawHeader(doc, group);
  const left = doc.page.margins.left;
  const cols = [
    ['월', 22, 'center'],
    ['일', 22, 'center'],
    ['구매사코드', 66, 'center'],
    ['품목', 142, 'left'],
    ['단가', 58, 'right'],
    ['단위', 35, 'center'],
    ['수량', 45, 'right'],
    ['금액', 68, 'right'],
    ['비고', 70, 'left'],
  ];
  let x = left;
  for (const [label, w] of cols) {
    doc.rect(x, y, w, 20).fillAndStroke('#eeeeee', '#111111');
    drawCell(doc, x, y, w, 20, label, { align: 'center', fontSize: 8, bold: true });
    x += w;
  }
  y += 20;

  for (const line of group.lines || []) {
    const values = [
      line.month, line.day, line.buyerCode, line.item, line.unitPrice,
      line.unit, line.qty, line.amount, line.note,
    ];
    const heights = values.map((v, i) => textHeight(doc, v, cols[i][1], i === 3 || i === 8 ? 7 : 8));
    const rowH = Math.max(20, Math.min(54, Math.max(...heights)));
    if (y + rowH > doc.page.height - doc.page.margins.bottom - 72) {
      doc.addPage();
      y = drawHeader(doc, group);
    }
    x = left;
    for (let i = 0; i < cols.length; i++) {
      drawCell(doc, x, y, cols[i][1], rowH, values[i], {
        align: cols[i][2],
        fontSize: i === 3 || i === 8 ? 7 : 8,
      });
      x += cols[i][1];
    }
    y += rowH;
  }

  y += 8;
  const totalX = left + 366;
  drawCell(doc, totalX, y, 70, 20, '공급가액', { align: 'center', fontSize: 8 });
  drawCell(doc, totalX + 70, y, 92, 20, group.supplyText, { align: 'right', fontSize: 8 });
  y += 20;
  drawCell(doc, totalX, y, 70, 20, '부가세', { align: 'center', fontSize: 8 });
  drawCell(doc, totalX + 70, y, 92, 20, group.taxText, { align: 'right', fontSize: 8 });
  y += 20;
  drawCell(doc, totalX, y, 70, 20, '합계', { align: 'center', fontSize: 8, bold: true });
  drawCell(doc, totalX + 70, y, 92, 20, group.totalText, { align: 'right', fontSize: 8, bold: true });
}

function drawWarnings(doc, warnings) {
  doc.addPage();
  const left = doc.page.margins.left;
  const width = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  let y = doc.page.margins.top;
  setFont(doc, true);
  doc.fontSize(18).text('확인 필요 항목', left, y, { width, align: 'center' });
  y += 34;
  setFont(doc, false);
  doc.fontSize(8);
  for (const warning of warnings) {
    const h = doc.heightOfString(`- ${warning}`, { width, lineGap: 2 }) + 6;
    if (y + h > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    doc.text(`- ${warning}`, left, y, { width, lineGap: 2 });
    y += h;
  }
}

const doc = new PDFDocument({
  size: 'A4',
  margins: { top: 28, bottom: 28, left: 34, right: 34 },
  info: { Title: '포스코 거래명세서' },
});

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
doc.pipe(fs.createWriteStream(outputPath));
for (let i = 0; i < (payload.groups || []).length; i++) {
  if (i > 0) doc.addPage();
  drawStatement(doc, payload.groups[i]);
}
if (payload.warnings && payload.warnings.length) drawWarnings(doc, payload.warnings);
doc.end();
