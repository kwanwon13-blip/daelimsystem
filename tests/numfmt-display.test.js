const assert = require('node:assert');
const { formatByNumFmt, excelSerialToYmd } = require('../lib/numfmt-display');

// 천단위
assert.strictEqual(formatByNumFmt(1234567, '#,##0'), '1,234,567');
// 통화 ₩
assert.strictEqual(formatByNumFmt(1234567, '₩#,##0'), '₩1,234,567');
// 백분율
assert.strictEqual(formatByNumFmt(0.15, '0%'), '15%');
assert.strictEqual(formatByNumFmt(0.1523, '0.00%'), '15.23%');
// 날짜 (Excel serial 44927 = 2023-01-01)
assert.strictEqual(excelSerialToYmd(44927), '2023-01-01');
assert.strictEqual(formatByNumFmt(44927, 'yyyy-mm-dd'), '2023-01-01');
// 소수 자릿수
assert.strictEqual(formatByNumFmt(1234.5, '0.00'), '1234.50');
// 텍스트는 그대로 (숫자 아님)
assert.strictEqual(formatByNumFmt('현금', '#,##0'), '현금');
// numFmt 없으면 원본
assert.strictEqual(formatByNumFmt(1000, ''), 1000);
assert.strictEqual(formatByNumFmt(1000, null), 1000);
// 빈값 그대로
assert.strictEqual(formatByNumFmt('', '#,##0'), '');
assert.strictEqual(formatByNumFmt(null, '#,##0'), null);

console.log('PASS numfmt-display');
