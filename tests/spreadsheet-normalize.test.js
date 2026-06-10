const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { normalizeToXlsx } = require('../lib/spreadsheet-normalize');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'norm-'));
try {
  // .xlsx → 변환 없음 (그대로 통과)
  const xlsxSrc = path.join(tmp, 'a.xlsx');
  fs.writeFileSync(xlsxSrc, 'dummy');
  const r1 = normalizeToXlsx(xlsxSrc, { XLSX: null });
  assert.strictEqual(r1.converted, false);
  assert.strictEqual(r1.path, xlsxSrc);

  // .pdf → 패스스루 (스프레드시트 아님, 변환 대상 X)
  const pdfSrc = path.join(tmp, 'b.pdf');
  fs.writeFileSync(pdfSrc, 'pdf');
  assert.strictEqual(normalizeToXlsx(pdfSrc, { XLSX: null }).converted, false);

  // .csv + (가짜) XLSX → .xlsx 로 변환
  const csvSrc = path.join(tmp, 'c.csv');
  fs.writeFileSync(csvSrc, 'a,b\n1,2');
  const fakeXLSX = {
    readFile: (p) => { assert.ok(fs.existsSync(p)); return { sheets: 'ok' }; },
    writeFile: (wb, out) => { fs.writeFileSync(out, 'converted-xlsx'); },
  };
  const r2 = normalizeToXlsx(csvSrc, { XLSX: fakeXLSX });
  assert.strictEqual(r2.converted, true);
  assert.ok(/\.xlsx$/.test(r2.path) && fs.existsSync(r2.path));
  assert.strictEqual(r2.originalExt, '.csv');

  // .xls + 라이브러리 없음 → 명확 에러 (조용한 실패 X)
  const xlsSrc = path.join(tmp, 'd.xls');
  fs.writeFileSync(xlsSrc, 'xls');
  assert.throws(() => normalizeToXlsx(xlsSrc, { XLSX: null }), /미설치|LIB_MISSING/);

  // .xls + 읽기 실패(손상) → 명확 에러
  const badXLSX = { readFile: () => { throw new Error('corrupt'); }, writeFile: () => {} };
  assert.throws(() => normalizeToXlsx(xlsSrc, { XLSX: badXLSX }), /읽|UNREADABLE/);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log('PASS spreadsheet-normalize');
