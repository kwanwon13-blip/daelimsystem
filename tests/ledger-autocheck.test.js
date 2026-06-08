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

  console.log('PASS ledger-autocheck');
})().catch(e => { console.error(e); process.exit(1); });
