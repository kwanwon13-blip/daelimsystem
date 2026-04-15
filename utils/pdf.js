/**
 * utils/pdf.js — 견적서 PDF 생성 + HTML 이스케이프
 * 사용처: routes/mail.js (이메일 첨부 견적서)
 */
const path = require('path');
const fs = require('fs');

const APP_ROOT = path.join(__dirname, '..');
const PDFDocument = require('pdfkit');

// HTML 이스케이프 유틸
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 견적서 PDF 생성 함수 (Puppeteer — 인쇄 버튼과 동일한 결과) ──
async function generateQuotePdf(quoteData, namecardImgPath) {
  let puppeteer;
  try { puppeteer = require('puppeteer'); } catch(e) {
    console.warn('[PDF] puppeteer 미설치 → pdfkit 폴백');
    return generateQuotePdfLegacy(quoteData, namecardImgPath);
  }

  const supplyTotal = quoteData.items.reduce((s, it) => s + ((it.qty||0)*(it.unitPrice||0)), 0);
  const vatTotal = Math.round(supplyTotal * 0.1);
  const grandTotal = supplyTotal + vatTotal;

  // quote-print.html 읽기
  const templatePath = path.join(APP_ROOT, 'public', 'quote-print.html');
  let html = fs.readFileSync(templatePath, 'utf8');

  // Alpine.js 대신 데이터를 직접 주입 (서버사이드 렌더링)
  const itemsHtml = quoteData.items.map((item, idx) => `
    <tr>
      <td class="no c">${String(idx+1).padStart(2,'0')}</td>
      <td class="name">${escHtml(item.name||'')}</td>
      <td class="c">${escHtml(item.unit||'')}</td>
      <td class="r">${(item.qty||0).toLocaleString()}</td>
      <td class="r">${Number(item.unitPrice||0).toLocaleString()}</td>
      <td class="amt r">${Number(item.amount||0).toLocaleString()}</td>
      <td class="rmk">${escHtml(item.remark||'')}</td>
    </tr>`).join('');

  // Alpine.js 제거 후 데이터 직접 삽입
  html = html
    .replace(/<script src="https:\/\/unpkg.com\/alpinejs[^"]*"[^>]*><\/script>/g, '')
    .replace(/x-data="quotePrint\(\)"\s*x-init="init\(\)"/, '')
    .replace(/<div class="ctrl no-print">[\s\S]*?<\/div>\s*\n/, '')
    .replace(/x-text="quoteTitle"/, '')
    .replace(/x-text="siteName \|\| '-'"/, `>${escHtml(quoteData.siteName||'-')}<span style="display:none"`)
    .replace(/x-text="quoteName \|\| '-'"/, `>${escHtml(quoteData.quoteName||'-')}<span style="display:none"`)
    .replace(/x-text="manager \|\| '-'"/, `>${escHtml(quoteData.manager||'-')}<span style="display:none"`)
    .replace(/x-text="vendorManager \|\| '-'"/, `>${escHtml(quoteData.vendorManager||'-')}<span style="display:none"`)
    .replace(/x-text="quoteDate"/, `>${escHtml(quoteData.quoteDate||new Date().toISOString().slice(0,10))}<span style="display:none"`)
    .replace(/x-text="'₩ ' \+ Number\(grandTotal\)\.toLocaleString\(\)"/, `>₩ ${grandTotal.toLocaleString()}<span style="display:none"`)
    .replace(/x-text="'₩ ' \+ Number\(supplyTotal\)\.toLocaleString\(\)"[\s\S]*?<\/span>/, `>₩ ${supplyTotal.toLocaleString()}</span>`)
    .replace(/x-text="'₩ ' \+ Number\(vatTotal\)\.toLocaleString\(\)"[\s\S]*?<\/span>/, `>₩ ${vatTotal.toLocaleString()}</span>`);

  // 품목 테이블 교체
  html = html.replace(
    /<template x-for[\s\S]*?<\/template>\s*<tr x-show[\s\S]*?<\/tr>/,
    itemsHtml || '<tr><td colspan="7" style="text-align:center;padding:48px;color:#d1d5db;">품목 없음</td></tr>'
  );

  // 합계 직접 삽입
  html = html
    .replace(/x-text="'₩ ' \+ Number\(supplyTotal\)\.toLocaleString\(\)"/, `>₩ ${supplyTotal.toLocaleString()}<span style="display:none"`)
    .replace(/x-text="'₩ ' \+ Number\(vatTotal\)\.toLocaleString\(\)"/, `>₩ ${vatTotal.toLocaleString()}<span style="display:none"`)
    .replace(/x-text="'₩ ' \+ Number\(grandTotal\)\.toLocaleString\(\)"/, `>₩ ${grandTotal.toLocaleString()}<span style="display:none"`);

  // 이미지 경로를 절대경로로 변환
  const dataDir = path.join(APP_ROOT, 'data').replace(/\\/g, '/');
  html = html.replace(/src="\/data\//g, `src="file:///${dataDir}/`);
  html = html.replace(/<script>[\s\S]*?<\/script>$/, '');

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'domcontentloaded' });
    await page.emulateMediaType('print');
    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0', bottom: '0', left: '0', right: '0' },
      printBackground: true
    });
    return pdfBuffer;
  } finally {
    await browser.close();
  }
}

// ── 레거시 pdfkit 폴백 (puppeteer 미설치 시) ──
const LOGO_PATH = path.join(APP_ROOT, 'data', 'logo.png');
const STAMP_PATH = path.join(APP_ROOT, 'data', 'stamp.png');
const WIN_FONT = 'C:\\Windows\\Fonts\\malgun.ttf';
const WIN_FONT_BOLD = 'C:\\Windows\\Fonts\\malgunbd.ttf';
const FONT_PATH = fs.existsSync(WIN_FONT) ? WIN_FONT : path.join(APP_ROOT, 'data', 'NotoSansKR-Regular.ttf');
const FONT_BOLD_PATH = fs.existsSync(WIN_FONT_BOLD) ? WIN_FONT_BOLD : path.join(APP_ROOT, 'data', 'NotoSansKR-Bold.ttf');

function generateQuotePdfLegacy(quoteData, namecardImgPath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hasFont = fs.existsSync(FONT_PATH);
      const hasBold = fs.existsSync(FONT_BOLD_PATH);
      if (hasFont) doc.registerFont('Korean', FONT_PATH);
      if (hasBold) doc.registerFont('KoreanBold', FONT_BOLD_PATH);
      const f = hasFont ? 'Korean' : 'Helvetica';
      const fb = hasBold ? 'KoreanBold' : (hasFont ? 'Korean' : 'Helvetica-Bold');

      const pw = 595.28; // A4 width
      const ml = 50, mr = 50;
      const cw = pw - ml - mr; // content width
      let y = 50;

      // ── 헤더: 로고 + 회사정보 ──
      if (fs.existsSync(LOGO_PATH)) {
        try { doc.image(LOGO_PATH, ml, y, { height: 36 }); } catch(e) {}
      }
      doc.font(fb).fontSize(22).fillColor('#1a1a1a').text('견적내역서', ml, y + 42, { width: cw * 0.55 });
      doc.font(f).fontSize(8).fillColor('#9ca3af').text('OFFICIAL BUSINESS QUOTATION', ml, y + 66, { width: cw * 0.55 });

      // 오른쪽 회사 정보
      const rx = ml + cw * 0.55;
      const rw = cw * 0.45;
      doc.font(fb).fontSize(14).fillColor('#1a1a1a').text('DAELIM SM', rx, y, { width: rw, align: 'right' });
      doc.font(f).fontSize(8).fillColor('#4b5563').text('서울 구로구 경인로 393-7(고척동 73-3)', rx, y + 20, { width: rw, align: 'right' });
      doc.text('일이삼전자타운 2동 4층 4101호', rx, y + 31, { width: rw, align: 'right' });
      doc.text('TEL: 02.2682.8940 | FAX: 02.2672.3620', rx, y + 42, { width: rw, align: 'right' });
      doc.font(fb).fontSize(9).fillColor('#1a1a1a').text('대표이사 이 정 호', rx, y + 58, { width: rw, align: 'right' });

      // 직인
      if (fs.existsSync(STAMP_PATH)) {
        try { doc.image(STAMP_PATH, pw - mr - 48, y + 2, { width: 44, height: 44 }); } catch(e) {}
      }

      y += 90;
      doc.moveTo(ml, y).lineTo(pw - mr, y).strokeColor('#e5e7eb').lineWidth(1).stroke();
      y += 16;

      // ── 현장명 / 견적명 ──
      doc.font(f).fontSize(8).fillColor('#9ca3af').text('현장명', ml, y);
      y += 12;
      doc.font(fb).fontSize(13).fillColor('#1a1a1a').text(quoteData.siteName || '-', ml, y, { width: cw * 0.55 });
      y += 20;
      doc.moveTo(ml, y).lineTo(ml + cw * 0.55, y).strokeColor('#1a1a1a').lineWidth(1.5).stroke();
      y += 10;
      doc.font(f).fontSize(8).fillColor('#9ca3af').text('견적명', ml, y);
      y += 12;
      doc.font(fb).fontSize(13).fillColor('#1a1a1a').text(quoteData.quoteName || '-', ml, y, { width: cw * 0.55 });
      y += 20;
      doc.moveTo(ml, y).lineTo(ml + cw * 0.55, y).strokeColor('#1a1a1a').lineWidth(1.5).stroke();
      y += 14;

      // 담당자 / 우리측 담당 / 견적일
      const colW = cw * 0.55 / 3;
      const labels = ['담당자', '우리측 담당', '견적일'];
      const values = [quoteData.manager || '-', quoteData.vendorManager || '-', quoteData.quoteDate || new Date().toISOString().slice(0,10)];
      for (let i = 0; i < 3; i++) {
        const cx = ml + colW * i;
        doc.font(f).fontSize(7).fillColor('#9ca3af').text(labels[i], cx, y);
        doc.font(f).fontSize(10).fillColor('#1a1a1a').text(values[i], cx, y + 11, { width: colW - 8 });
      }
      y += 28;
      doc.moveTo(ml, y).lineTo(ml + cw * 0.55, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();

      // ── 총 견적금액 박스 (오른쪽) ──
      const supplyTotal = quoteData.items.reduce((s, it) => s + ((it.qty || 0) * (it.unitPrice || 0)), 0);
      const vatAmount = Math.round(supplyTotal * 0.1);
      const grandTotal = supplyTotal + vatAmount;
      const boxX = ml + cw * 0.58, boxY = y - 90, boxW = cw * 0.42, boxH = 80;
      doc.roundedRect(boxX, boxY, boxW, boxH, 6).fillColor('#fdf6ed').fill();
      doc.font(f).fontSize(8).fillColor('#8b5e3c').text('총 견적금액 (VAT 포함)', boxX + 12, boxY + 12, { width: boxW - 24 });
      doc.font(fb).fontSize(22).fillColor('#1a1a1a').text('₩ ' + grandTotal.toLocaleString(), boxX + 12, boxY + 26, { width: boxW - 24 });
      doc.font(f).fontSize(8).fillColor('#8b5e3c').text(`공급가액 ₩${supplyTotal.toLocaleString()} + VAT ₩${vatAmount.toLocaleString()}`, boxX + 12, boxY + 54, { width: boxW - 24 });

      y += 20;

      // ── 품목 테이블 ──
      const cols = [
        { label: 'No', w: 28, align: 'center' },
        { label: '품명', w: cw * 0.28, align: 'left' },
        { label: '단위', w: 40, align: 'center' },
        { label: '수량', w: 45, align: 'right' },
        { label: '단가', w: 65, align: 'right' },
        { label: '금액', w: 70, align: 'right' },
        { label: '비고', w: 0, align: 'left' } // 나머지
      ];
      // 비고 폭 계산
      const usedW = cols.slice(0, 6).reduce((s, c) => s + c.w, 0);
      cols[6].w = cw - usedW;

      const rh = 26; // row height (글씨 잘림 방지)
      // 헤더
      doc.rect(ml, y, cw, rh).fillColor('#f9fafb').fill();
      let cx = ml;
      for (const col of cols) {
        doc.font(fb).fontSize(8).fillColor('#6b7280');
        const tx = col.align === 'right' ? cx + col.w - 6 : (col.align === 'center' ? cx + col.w / 2 : cx + 6);
        doc.text(col.label, tx - (col.align === 'center' ? 20 : 0), y + 7, { width: col.align === 'center' ? 40 : col.w - 6, align: col.align });
        cx += col.w;
      }
      doc.moveTo(ml, y + rh).lineTo(pw - mr, y + rh).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      y += rh;

      // 데이터 행
      quoteData.items.forEach((item, idx) => {
        const amt = (item.qty || 0) * (item.unitPrice || 0);
        if (y > 720) { doc.addPage(); y = 50; }
        cx = ml;
        const vals = [
          String(idx + 1).padStart(2, '0'),
          item.name || '',
          item.unit || '',
          String(item.qty || 0),
          (item.unitPrice || 0).toLocaleString(),
          amt.toLocaleString(),
          item.remark || ''
        ];
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
          const isName = i === 1;
          doc.font(isName ? fb : f).fontSize(9).fillColor(i === 0 ? '#9ca3af' : '#1a1a1a');
          const tx = col.align === 'right' ? cx + col.w - 6 : (col.align === 'center' ? cx + col.w / 2 : cx + 6);
          doc.text(vals[i], tx - (col.align === 'center' ? 20 : 0), y + 7, { width: col.align === 'center' ? 40 : col.w - 12, align: col.align, lineBreak: false });
          cx += col.w;
        }
        doc.moveTo(ml, y + rh).lineTo(pw - mr, y + rh).strokeColor('#e5e7eb').lineWidth(0.3).stroke();
        y += rh;
      });

      // 합계 영역
      const sumLabelW = cw - cols[5].w - cols[6].w;
      // 공급가액
      doc.font(f).fontSize(8).fillColor('#6b7280').text('공급가액', ml, y + 5, { width: sumLabelW - 6, align: 'right' });
      doc.font(fb).fontSize(10).fillColor('#1a1a1a').text('₩ ' + supplyTotal.toLocaleString(), ml + sumLabelW, y + 4, { width: cols[5].w + cols[6].w, align: 'right' });
      doc.moveTo(ml, y + rh).lineTo(pw - mr, y + rh).strokeColor('#e5e7eb').lineWidth(0.3).stroke();
      y += rh;
      // 부가세
      doc.font(f).fontSize(8).fillColor('#6b7280').text('부가세 (10%)', ml, y + 5, { width: sumLabelW - 6, align: 'right' });
      doc.font(fb).fontSize(10).fillColor('#1a1a1a').text('₩ ' + vatAmount.toLocaleString(), ml + sumLabelW, y + 4, { width: cols[5].w + cols[6].w, align: 'right' });
      doc.moveTo(ml, y + rh).lineTo(pw - mr, y + rh).strokeColor('#e5e7eb').lineWidth(0.3).stroke();
      y += rh;
      // 합계
      doc.rect(ml, y, cw, rh + 4).fillColor('#f9fafb').fill();
      doc.font(fb).fontSize(10).fillColor('#4b5563').text('합 계', ml, y + 7, { width: sumLabelW - 6, align: 'right' });
      doc.font(fb).fontSize(16).fillColor('#1a1a1a').text('₩ ' + grandTotal.toLocaleString(), ml + sumLabelW, y + 3, { width: cols[5].w + cols[6].w, align: 'right' });
      y += rh + 8;

      // 유효기간
      doc.font(f).fontSize(7).fillColor('#94a3b8').text('※ 견적 유효기간: 견적일로부터 30일', ml, y, { width: cw, align: 'right' });
      y += 16;

      // ── 하단 ──
      y = Math.max(y, 700);
      doc.moveTo(ml, y).lineTo(pw - mr, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font(f).fontSize(7).fillColor('#9ca3af').text('품질과 안전을 최우선으로 고객을 위해 항상 최선을 다하겠습니다', ml, y + 6, { width: cw, align: 'center' });
      doc.text('DAELIM SM - Total Safety Group Co., Ltd.', ml, y + 16, { width: cw, align: 'center' });

      doc.end();
    } catch(e) { reject(e); }
  });
}

module.exports = { escHtml, generateQuotePdf, generateQuotePdfLegacy };
