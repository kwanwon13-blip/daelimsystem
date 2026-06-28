const assert = require('node:assert');
const L = require('../lib/pickup-logic');

// ── computeRequestStatus: 롤업 ──
assert.strictEqual(L.computeRequestStatus([]), 'requested');
assert.strictEqual(L.computeRequestStatus([], { courseConfirmed: true }), 'inCourse');
assert.strictEqual(L.computeRequestStatus([{ status: 'cancelled' }, { status: 'cancelled' }]), 'cancelled');
assert.strictEqual(L.computeRequestStatus([{ status: 'pickedUp' }, { status: 'pickedUp' }]), 'completed');
assert.strictEqual(L.computeRequestStatus([{ status: 'pickedUp' }, { status: 'cancelled' }]), 'completed'); // 취소 제외 전부 수거
assert.strictEqual(L.computeRequestStatus([{ status: 'pickedUp' }, { status: 'notPicked' }]), 'partial');
assert.strictEqual(L.computeRequestStatus([{ status: 'pickedUp' }, { status: 'requested' }]), 'partial');
assert.strictEqual(L.computeRequestStatus([{ status: 'notPicked' }, { status: 'notPicked' }]), 'notPicked');
assert.strictEqual(L.computeRequestStatus([{ status: 'requested' }, { status: 'requested' }]), 'requested');
assert.strictEqual(L.computeRequestStatus([{ status: 'requested' }], { courseConfirmed: true }), 'inCourse');

// ── computeIsLate: 같은날 + 마감 이후만 late ──
const at0930 = new Date(2026, 5, 25, 9, 30); // 6/25 09:30 (로컬)
const at1030 = new Date(2026, 5, 25, 10, 30);
assert.strictEqual(L.computeIsLate(at0930, '10:00', '2026-06-25', '2026-06-25'), false); // 마감 전
assert.strictEqual(L.computeIsLate(at1030, '10:00', '2026-06-25', '2026-06-25'), true);  // 마감 후
assert.strictEqual(L.computeIsLate(at1030, '10:00', '2026-06-26', '2026-06-25'), false); // 픽업이 내일 → late 아님
assert.strictEqual(L.computeIsLate(at1030, '', '2026-06-25', '2026-06-25'), false);       // 마감 미설정

// ── parseKakaoPickup: #업체 기준 그룹 + 품목/규격/수량 추출 ──
const parsed = L.parseKakaoPickup('#라코스\n현수막 600x900 3개\n배너 2장\n#세원계측기\n압력계 1');
assert.strictEqual(parsed.length, 2);
assert.strictEqual(parsed[0].vendorGuess, '라코스');
assert.strictEqual(parsed[0].items.length, 2);
assert.deepStrictEqual(parsed[0].items[0], { itemName: '현수막', spec: '600x900', qty: 3, unit: '개' });
assert.deepStrictEqual(parsed[0].items[1], { itemName: '배너', spec: '', qty: 2, unit: '장' });
assert.strictEqual(parsed[1].vendorGuess, '세원계측기');
assert.deepStrictEqual(parsed[1].items[0], { itemName: '압력계', spec: '', qty: 1, unit: '' });

// 업체헤더 없이 시작하면 vendorGuess '' 그룹
const noHeader = L.parseKakaoPickup('볼트 5개');
assert.strictEqual(noHeader.length, 1);
assert.strictEqual(noHeader[0].vendorGuess, '');
assert.strictEqual(noHeader[0].items[0].itemName, '볼트');

// ── parseItemLine: 단일 숫자 규격 (k2-17 270 3ea → 품목 k2-17 / 규격 270 / 3 ea) ──
assert.deepStrictEqual(L.parseItemLine('k2-17 270 3ea'), { itemName: 'k2-17', spec: '270', qty: 3, unit: 'ea' });
assert.deepStrictEqual(L.parseItemLine('현수막 600x900 3개'), { itemName: '현수막', spec: '600x900', qty: 3, unit: '개' });
assert.deepStrictEqual(L.parseItemLine('배너 2장'), { itemName: '배너', spec: '', qty: 2, unit: '장' });
assert.deepStrictEqual(L.parseItemLine('볼트 M8 2개'), { itemName: '볼트 M8', spec: '', qty: 2, unit: '개' }); // 글자시작 토큰은 규격 아님

// ── buildShareText ──
const text = L.buildShareText('2026-06-25', [
  { vendorName: '라코스', items: [{ itemName: '현수막', spec: '600x900', qty: 3, unit: '개' }] },
  { vendorName: '세원', items: [{ itemName: '압력계', spec: '', qty: 1, unit: '' }] },
]);
assert.ok(text.includes('2026-06-25'));
assert.ok(text.includes('[라코스]'));
assert.ok(text.includes('현수막 600x900 3개'));
assert.ok(text.includes('[세원]'));

// ── normVendorName: 소문자·공백 + 법인격·괄호·특수문자 무시 ──
assert.strictEqual(L.normVendorName('라코스'), '라코스');
assert.strictEqual(L.normVendorName('라코스(주)'), '라코스');
assert.strictEqual(L.normVendorName('㈜라코스'), '라코스');
assert.strictEqual(L.normVendorName('주식회사 라코스'), '라코스');
assert.strictEqual(L.normVendorName(' 라 코 스 '), '라코스');
assert.strictEqual(L.normVendorName('ABC-Corp'), 'abccorp');
// 세 표기가 모두 같은 norm
assert.strictEqual(L.normVendorName('라코스'), L.normVendorName('라코스(주)'));
assert.strictEqual(L.normVendorName('라코스(주)'), L.normVendorName('㈜라코스'));

// ── groupByVendor ──
const grouped = L.groupByVendor([
  { vendorId: 'v1', vendorName: '라코스', items: [{ itemName: 'A' }] },
  { vendorId: 'v1', vendorName: '라코스', items: [{ itemName: 'B' }] },
  { vendorId: 'v2', vendorName: '세원', items: [{ itemName: 'C' }] },
]);
assert.strictEqual(grouped.length, 2);
const g1 = grouped.find(g => g.vendorId === 'v1');
assert.strictEqual(g1.items.length, 2); // 두 요청의 품목 합쳐짐
assert.strictEqual(g1.groupKey, 'v1');  // vendorId 있으면 groupKey = vendorId

// 자유 업체명(vendorId 없음): 정규화한 이름 다른 표기도 한 그룹 + groupKey 노출
const groupedFree = L.groupByVendor([
  { vendorId: null, vendorName: '라코스', items: [{ itemName: 'A' }] },
  { vendorId: null, vendorName: '㈜라코스', items: [{ itemName: 'B' }] },
]);
assert.strictEqual(groupedFree.length, 1); // 정규화로 한 업체
assert.strictEqual(groupedFree[0].groupKey, 'name:' + L.normVendorName('라코스'));
assert.strictEqual(groupedFree[0].items.length, 2);

console.log('✅ pickup-logic 테스트 통과');
