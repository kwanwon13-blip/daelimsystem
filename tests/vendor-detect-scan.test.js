const assert = require('node:assert');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const ExcelJS = require('exceljs');
const rt = require('../lib/agent-runtime');

async function makeXlsx(name, cells) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('판매현황');
  for (const [addr, val] of Object.entries(cells)) ws.getCell(addr).value = val;
  const p = path.join(os.tmpdir(), name);
  await wb.xlsx.writeFile(p);
  return p;
}

(async () => {
  // ① 거래처명이 A1 이 아니라 안쪽(B3)에 있는 이카운트형 랜덤 export → 내용 스캔으로 감지
  const f1 = await makeXlsx('vd_persys_' + process.pid + '.xlsx', { A1: '판매현황', A2: '거래처명', B3: '주식회사 퍼시스' });
  assert.strictEqual(await rt.detectVendorFromAttachments([{ path: f1 }]), 'persys-ledger');

  // ② A1 에 있는 경우도 여전히 동작(하위호환)
  const f2 = await makeXlsx('vd_haatz_' + process.pid + '.xlsx', { A1: '하츠 판매현황' });
  assert.strictEqual(await rt.detectVendorFromAttachments([{ path: f2 }]), 'haatz-ledger');

  // ③ 거래처 단서 없음 → '' (오탐 안 함)
  const f3 = await makeXlsx('vd_none_' + process.pid + '.xlsx', { A1: '판매현황', B3: '그냥상사' });
  assert.strictEqual(await rt.detectVendorFromAttachments([{ path: f3 }]), '');

  for (const f of [f1, f2, f3]) { try { fs.unlinkSync(f); } catch (_) {} }
  console.log('PASS vendor-detect-scan');
})().catch(e => { console.error('FAIL', e.message); process.exit(1); });
