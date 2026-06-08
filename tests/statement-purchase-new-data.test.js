const assert = require('node:assert');
const workflow = require('../lib/statement-workflow');

const basePurchase = {
  company_code: 'COMPANY',
  doc_class: '매입',
  target_erp: 'E2E',
  doc_date: '2026-05-28',
  vendor_name: '처음보는거래처',
  norm_vendor: '처음보는거래처',
  supply_amount: 1000,
  vat_amount: 100,
  total_amount: 1100,
};

const newPurchaseLine = {
  item_name: '처음보는품목',
  spec: '신규규격',
  quantity: 1,
  unit_price: 1000,
  amount: 1000,
  vat: 100,
};

const withNewData = workflow.validateStatement(basePurchase, [newPurchaseLine], []);
assert.strictEqual(withNewData.canConfirm, true, '신규 거래처/품목은 과거 데이터가 없어도 확정 가능해야 한다.');
assert.strictEqual(withNewData.blockingIssues.length, 0);

const withoutItems = workflow.validateStatement(basePurchase, [], []);
assert.strictEqual(withoutItems.canConfirm, false, '품목 라인이 없으면 검토는 가능하지만 확정은 막아야 한다.');
assert.ok(
  withoutItems.issues.some((issue) => issue.field === 'items' && issue.message.includes('품목 라인')),
  '품목 라인 누락 사유를 명확히 보여줘야 한다.'
);

const duplicateCandidate = {
  id: 42,
  reason: 'similar_business_key',
  source_file: 'same-total.jpg',
  status: 'pending',
};
const withDuplicateWarning = workflow.validateStatement(basePurchase, [newPurchaseLine], [duplicateCandidate]);
assert.strictEqual(withDuplicateWarning.canConfirm, true, '유사 중복은 직원 확인 경고이지 신규 데이터 차단 조건이 아니다.');
assert.ok(
  withDuplicateWarning.warningIssues.some((issue) => issue.field === 'duplicate'),
  '거래처/일자/금액 유사 중복은 경고로 남아야 한다.'
);

console.log('PASS statement-purchase-new-data');
