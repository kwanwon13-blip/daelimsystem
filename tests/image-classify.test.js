'use strict';
// lib/image-classify.js 의 classifyImage 결정적(rule-based) 동작 검증.
// 순수 node·의존성 0. 실행: node tests/image-classify.test.js
// 모든 케이스 통과 시 'CLASSIFY OK' 출력, 하나라도 불일치하면 exit 1.

const { classifyImage, KNOWN_CLIENTS, IMAGE_TYPES } = require('../lib/image-classify');

let failed = 0;

// ── 단언 헬퍼 ──────────────────────────────────────────────────────────────
function assertEq(label, actual, expected) {
  if (actual !== expected) {
    failed++;
    console.error(`  [FAIL] ${label}\n         expected: ${JSON.stringify(expected)}\n         actual:   ${JSON.stringify(actual)}`);
  } else {
    console.log(`  [ok]   ${label} = ${JSON.stringify(actual)}`);
  }
}

// keywords(쉼표연결 문자열)에 특정 토큰이 들어있는지.
function assertKwIncludes(label, keywords, anyOf) {
  const set = new Set(String(keywords || '').split(',').filter(Boolean));
  const hit = anyOf.find(t => set.has(t));
  if (!hit) {
    failed++;
    console.error(`  [FAIL] ${label}\n         keywords "${keywords}" should include one of ${JSON.stringify(anyOf)}`);
  } else {
    console.log(`  [ok]   ${label} keywords "${keywords}" contains "${hit}"`);
  }
}

// ── 케이스 ──────────────────────────────────────────────────────────────────
console.log('image-classify cases:');

// 1) 현수막+시안 → banner, 포스코, keywords에 준공/현수막
{
  const r = classifyImage('포스코 본사 준공 행사 현수막 시안, 블루 톤');
  assertEq('case1.type', r.type, 'banner');
  assertEq('case1.client', r.client, '포스코');
  assertKwIncludes('case1', r.keywords, ['준공', '현수막']);
}

// 2) 로고 → logo, 퍼시스
{
  const r = classifyImage('퍼시스 사무가구 로고 리뉴얼');
  assertEq('case2.type', r.type, 'logo');
  assertEq('case2.client', r.client, '퍼시스');
}

// 3) 제품 패키지 목업 → product, client 없음
{
  const r = classifyImage('제품 패키지 목업 3종');
  assertEq('case3.type', r.type, 'product');
  assertEq('case3.client', r.client, '');
}

// 4) 썸네일/피드 → social
{
  const r = classifyImage('인스타 피드용 썸네일');
  assertEq('case4.type', r.type, 'social');
}

// 5) 캐릭터/마스코트 → character
{
  const r = classifyImage('강아지 캐릭터 마스코트');
  assertEq('case5.type', r.type, 'character');
}

// 6) 홍보물 → poster, DL(디엘 alias)
{
  const r = classifyImage('DL 디엘 아파트 분양 홍보물');
  assertEq('case6.client', r.client, 'DL');
  assertEq('case6.type', r.type, 'poster');
}

// 7) 배경화면 → background (poster '전단'보다 우선순위 위, 일반 토큰)
{
  const r = classifyImage('미니멀 배경화면 그라데이션');
  assertEq('case7.type', r.type, 'background');
}

// 8) 매칭 키워드/거래처 전무 → etc, client '', keywords는 일반 토큰
{
  const r = classifyImage('우주 비행사 일러스트');
  assertEq('case8.type', r.type, 'etc');
  assertEq('case8.client', r.client, '');
  // 토큰 추출이 비어있지 않아야(불용어로 다 안 날아갔는지) — '비행사' 같은 토큰 존재
  assertEq('case8.keywords.nonEmpty', r.keywords.length > 0, true);
}

// 9) context 인자로 client 보강(프롬프트 본문엔 거래처 없음)
{
  const r = classifyImage('신규 매장 오픈 현수막', { context: '두산 발주 건' });
  assertEq('case9.type', r.type, 'banner');
  assertEq('case9.client(viaContext)', r.client, '두산');
}

// 10) 결정적성: 같은 입력 두 번 → 동일 결과
{
  const a = classifyImage('포스코 준공 현수막 시안');
  const b = classifyImage('포스코 준공 현수막 시안');
  assertEq('case10.deterministic', JSON.stringify(a), JSON.stringify(b));
}

// ── export 형태 sanity ──────────────────────────────────────────────────────
assertEq('export.IMAGE_TYPES.includes(banner)', IMAGE_TYPES.includes('banner'), true);
assertEq('export.IMAGE_TYPES.includes(etc)', IMAGE_TYPES.includes('etc'), true);
assertEq('export.KNOWN_CLIENTS.isArray', Array.isArray(KNOWN_CLIENTS), true);

// ── 결과 ────────────────────────────────────────────────────────────────────
if (failed > 0) {
  console.error(`\nCLASSIFY FAIL — ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nCLASSIFY OK');
