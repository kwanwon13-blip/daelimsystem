const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'statements.js'), 'utf8');
const calls = [];
const patchBodies = [];
const context = {
  console,
  URLSearchParams,
  setInterval,
  clearInterval,
  alert: (message) => { throw new Error(`unexpected alert: ${message}`); },
  fetch: async (url, opts = {}) => {
    calls.push(`${opts.method || 'GET'} ${String(url)}`);
    if (String(url) === '/api/statements/101' && opts.method === 'PATCH') {
      patchBodies.push(JSON.parse(opts.body));
      return { json: async () => ({ ok: true, statement: { id: 101 } }) };
    }
    if (String(url).startsWith('/api/statements/list?')) {
      return {
        json: async () => ({
          ok: true,
          items: [{
            id: 101,
            source_file: 'new-company-purchase.jpg',
            vendor_name: '처음보는거래처',
            norm_vendor: '처음보는거래처',
            doc_date: '2026-05-28',
            supply_amount: 1000,
            vat_amount: 100,
            total_amount: 1100,
            notes: 'OCR 품목 미추출',
            uploaded_at: '2026-06-08T09:00:00.000Z',
          }],
        }),
      };
    }
    if (String(url) === '/api/statements/stats') {
      return {
        json: async () => ({ ok: true, total: 1, pending: 1, confirmed: 0, rejected: 0 }),
      };
    }
    if (String(url) === '/api/statements/101') {
      return {
        json: async () => ({
          ok: true,
          statement: {
            id: 101,
            items: [],
          },
        }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  },
};

vm.createContext(context);
vm.runInContext(source, context, { filename: 'public/statements.js' });

const app = context.statementsApp();
app.filterCompany = 'COMPANY';
app.filterClass = '매입';

(async () => {
  await app.loadModeRows();

  assert.deepStrictEqual(calls.slice(0, 2), [
    'GET /api/statements/list?companyCode=COMPANY&docClass=%EB%A7%A4%EC%9E%85&limit=1000',
    'GET /api/statements/101',
  ]);
  assert.strictEqual(app.modeRows.length, 1, '품목 없는 신규 명세서도 검토 행으로 보여야 한다.');

  const row = app.modeRows[0];
  assert.strictEqual(row.statement_id, 101);
  assert.strictEqual(row.vendor, '처음보는거래처');
  assert.strictEqual(row.name, '처음보는거래처 명세서 합계');
  assert.strictEqual(row.spec, '품목 라인 미추출');
  assert.strictEqual(row.amount, 1000);
  assert.strictEqual(row.vat, 100);
  assert.strictEqual(row.total, 1100);
  assert.strictEqual(row._synthetic, true);
  assert.ok(row.notes.includes('과거 데이터 매칭 여부와 관계없이 검토 대상으로 표시됨'));
  assert.strictEqual(app.selectedRowIdx, 0);

  await app.saveModeRows({ silent: true });
  assert.strictEqual(patchBodies.length, 1);
  assert.deepStrictEqual(patchBodies[0].items, [], '미수정 합계행은 가짜 품목으로 저장하면 안 된다.');
  assert.strictEqual(patchBodies[0].supply_amount, 1000);
  assert.strictEqual(patchBodies[0].vat_amount, 100);
  assert.strictEqual(patchBodies[0].total_amount, 1100);

  const editedRow = app.modeRows[0];
  editedRow.name = '신규 실물 품목';
  editedRow.spec = '25x25';
  editedRow.qty = 2;
  editedRow.price = 500;
  editedRow.amount = 1000;
  editedRow.vat = 100;
  editedRow.total = 1100;
  editedRow.notes = '직원 보정 완료';

  await app.saveModeRows({ silent: true });
  assert.strictEqual(patchBodies.length, 2);
  assert.deepStrictEqual(patchBodies[1].items, [{
    item_code: '',
    item_name: '신규 실물 품목',
    spec: '25x25',
    quantity: 2,
    unit: '',
    unit_price: 500,
    amount: 1000,
    vat: 100,
    notes: '직원 보정 완료',
  }], '직원이 합계행을 실제 품목으로 고치면 품목 라인으로 저장해야 한다.');

  console.log('PASS statement-mode-no-items');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
