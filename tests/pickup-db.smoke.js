// 실제 업무데이터.db에 픽업요청을 만들고 라인체크/롤업/삭제까지 라운드트립 검증 후 정리
const assert = require('node:assert');
const sql = require('../db-sqlite');

// 업체가 0개면 스모크용 임시 업체를 만들고 finally에서 제거한다.
let vendor = sql.vendors.getAll()[0];
let tempVendorId = null;
if (!vendor) {
  vendor = sql.vendors.create({ name: '__pickup_smoke_vendor__' });
  tempVendorId = vendor.id;
  assert.ok(vendor, '임시 업체 생성 실패');
}

const req = sql.pickupRequests.create(
  { registrarId: 'smoke', registrarName: '스모크', pickupDate: '2099-01-01', vendorId: vendor.id, vendorName: vendor.name, isLate: false },
  [{ itemName: 'A', spec: '600x900', qty: 2, unit: '개' }, { itemName: 'B', qty: 1 }]
);
try {
  assert.strictEqual(req.status, 'requested');
  assert.strictEqual(req.items.length, 2);
  assert.ok(req.vendor && req.vendor.name === vendor.name, 'vendor 픽업정보 하이드레이션');

  // 한 품목 수거완료 → partial
  let after = sql.pickupRequests.setItemStatus(req.items[0].id, { status: 'pickedUp' }, 'smoke');
  assert.strictEqual(after.status, 'partial');
  // 나머지도 완료 → completed
  after = sql.pickupRequests.setItemStatus(req.items[1].id, { status: 'pickedUp' }, 'smoke');
  assert.strictEqual(after.status, 'completed');

  // 날짜 조회에 잡힘
  const byDate = sql.pickupRequests.getByDate('2099-01-01');
  assert.ok(byDate.find(r => r.id === req.id));

  // update: items 배열 교체 라운드트립 (기존 2줄 → 1줄로 교체 + 상태 재계산)
  const rep = sql.pickupRequests.update(req.id, { memo: '수정', items: [{ itemName: 'C', qty: 5, unit: '박스' }] });
  assert.strictEqual(rep.items.length, 1, 'items 교체 후 1줄');
  assert.strictEqual(rep.items[0].itemName, 'C');
  assert.strictEqual(rep.items[0].lineNo, 0, 'lineNo 재부여');
  assert.strictEqual(rep.memo, '수정');
  assert.strictEqual(rep.status, 'requested', '새 라인 requested → 요청 requested로 재계산');
} finally {
  sql.pickupRequests.delete(req.id);
  assert.strictEqual(sql.pickupRequests.getById(req.id), null);
  if (tempVendorId) sql.vendors.delete(tempVendorId);
}
console.log('✅ pickup-db 스모크 통과');
