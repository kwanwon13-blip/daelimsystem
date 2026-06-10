const assert = require('node:assert');
const ac = require('../lib/ledger-autocheck');

(async () => {
  // --- judgeLedgerRun: 파일 없음 → fail ---
  {
    const v = ac.judgeLedgerRun({ files: [], stdout: '' });
    assert.strictEqual(v.status, 'fail');
    assert.ok(/생성되지/.test(v.reasons.join(' ')));
    assert.strictEqual(v.summary.fileCount, 0);
  }
  // --- judgeLedgerRun: 정상 → pass ---
  {
    const v = ac.judgeLedgerRun({ files: [{ name: 'a.xlsx', maxRows: 20 }, { name: 'b.xlsx', maxRows: 13 }], stdout: '[OK] 검증 통과' });
    assert.strictEqual(v.status, 'pass');
    assert.strictEqual(v.summary.fileCount, 2);
    assert.strictEqual(v.summary.totalRows, 33);
    assert.strictEqual(v.reasons.length, 0);
  }
  // --- judgeLedgerRun: 거의 빈 결과 파일 → warn ---
  {
    const v = ac.judgeLedgerRun({ files: [{ name: 'empty.xlsx', maxRows: 1 }], stdout: '' });
    assert.strictEqual(v.status, 'warn');
    assert.ok(/empty\.xlsx/.test(v.reasons.join(' ')));
  }
  // --- judgeLedgerRun: 스크립트 [WARN] → warn ---
  {
    const v = ac.judgeLedgerRun({ files: [{ name: 'a.xlsx', maxRows: 20 }], stdout: '[WARN] 데이터 이상 3건' });
    assert.strictEqual(v.status, 'warn');
    assert.ok(/경고/.test(v.reasons.join(' ')));
  }
  // --- formatVerdictKorean: pass ---
  {
    const t = ac.formatVerdictKorean({ status: 'pass', reasons: [], summary: { fileCount: 2, totalRows: 33 } });
    assert.ok(/✅ 점검 통과/.test(t));
    assert.ok(/생성 파일 2개/.test(t));
  }
  // --- formatVerdictKorean: warn ---
  {
    const t = ac.formatVerdictKorean({ status: 'warn', reasons: ['결과 파일 "x.xlsx"에 데이터가 거의 없습니다 (확인 필요).'], summary: { fileCount: 1, totalRows: 1 } });
    assert.ok(/🚩 확인 필요/.test(t));
    assert.ok(/x\.xlsx/.test(t));
  }

  // --- countNonEmptyRows: 실제 exceljs 워크시트(메모리) ---
  {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('s');
    ws.getCell('A1').value = '헤더';
    ws.getCell('A2').value = '값1';
    ws.getCell('B3').value = 123;
    // 4행은 비움
    assert.strictEqual(ac.countNonEmptyRows(ws), 3);
  }
  // --- countNonEmptyRows: 행 스캔 상한 (초대형 파일에서 점검이 오래 걸리지 않게) ---
  {
    const fakeWs = { rowCount: 999999, getRow: () => ({ eachCell: (opt, cb) => cb({ value: 'x' }) }) };
    assert.strictEqual(ac.countNonEmptyRows(fakeWs, 10), 10);
  }
  // --- autocheckLedger: 가짜 ExcelJS 주입 → 행 충분 → pass ---
  {
    const fakeWs = { rowCount: 3, getRow: () => ({ eachCell: (opt, cb) => cb({ value: 'x' }) }) };
    function FakeWB() { this.worksheets = [fakeWs]; this.xlsx = { readFile: async () => {} }; }
    const v = await ac.autocheckLedger({ files: [{ name: 'a.xlsx', relPath: 'a.xlsx' }], dir: '/tmp', stdout: '' }, { ExcelJS: { Workbook: FakeWB } });
    assert.strictEqual(v.status, 'pass');
    assert.ok(/자동점검/.test(v.text));
  }
  // --- autocheckLedger: 비-xlsx 산출물은 행검사 생략하고 통과(허위경보 방지) ---
  {
    const v = await ac.autocheckLedger({ files: [{ name: 'note.txt' }], dir: '/tmp', stdout: '' }, {});
    assert.strictEqual(v.status, 'pass');
  }
  // --- autocheckLedger: 산출물 0개 → fail ---
  {
    const v = await ac.autocheckLedger({ files: [], dir: '/tmp', stdout: '' }, {});
    assert.strictEqual(v.status, 'fail');
  }

  console.log('PASS ledger-autocheck');
})().catch(e => { console.error(e); process.exit(1); });
