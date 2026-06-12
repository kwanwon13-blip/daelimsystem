const assert = require('node:assert');
const lib = require('../routes/lib/workflow-rename');

// ---------------------------------------------------------------------------
// buildRenamedLeaf — 폴더 장식 보존하며 현장명 부분만 치환
// ---------------------------------------------------------------------------
assert.strictEqual(
  lib.buildRenamedLeaf('(수방사)25-A-00부대 시설공사(1028)', '25-A-00부대 시설공사', '25-B-01부대 개선공사'),
  '(수방사)25-B-01부대 개선공사(1028)',
  '장식 괄호 보존하고 현장명만 치환'
);
assert.strictEqual(lib.buildRenamedLeaf('검증현장', '검증현장', '새현장'), '새현장', '딱 일치하면 그대로 치환');
assert.strictEqual(
  lib.buildRenamedLeaf('25-A-00부대 A동 증축 A동', 'A동', 'B동'),
  '25-A-00부대 A동 증축 B동',
  '다중 일치 시 마지막 1회만 치환(장식 내부 부분일치 보호)'
);
assert.strictEqual(
  lib.buildRenamedLeaf('(검증현장보존회) 검증현장', '검증현장', '새현장'),
  '(검증현장보존회) 새현장',
  '장식 단어 내부 일치는 보존하고 마지막(실제 현장명)만 치환'
);
assert.strictEqual(lib.buildRenamedLeaf('아예다른폴더명', '검증현장', '새현장'), '새현장', '옛 이름이 없으면 새 이름으로');
assert.strictEqual(lib.buildRenamedLeaf('', '검증현장', '새현장'), '새현장', '빈 leaf → 새 이름');

// ---------------------------------------------------------------------------
// replacePathPrefix — 절대경로 prefix 치환 (대소문자 무시, 부분일치 방지)
// ---------------------------------------------------------------------------
const OLD = 'D:\\디자인\\★검증업체\\2026 시안작업\\검증현장';
const NEW = 'D:\\디자인\\★검증업체\\2026 시안작업\\새현장';
assert.strictEqual(
  lib.replacePathPrefix(OLD + '\\시안1.jpg', OLD, NEW),
  NEW + '\\시안1.jpg',
  '하위 파일 경로 prefix 치환'
);
assert.strictEqual(lib.replacePathPrefix(OLD, OLD, NEW), NEW, '폴더 자체 경로 치환');
assert.strictEqual(
  lib.replacePathPrefix('d:\\디자인\\★검증업체\\2026 시안작업\\검증현장\\a.ai', OLD, NEW),
  NEW + '\\a.ai',
  '대소문자(드라이브) 무시'
);
assert.strictEqual(
  lib.replacePathPrefix(OLD + '2\\b.jpg', OLD, NEW),
  OLD + '2\\b.jpg',
  '"검증현장2" 같은 부분일치 폴더는 건드리지 않음'
);
assert.strictEqual(lib.replacePathPrefix('', OLD, NEW), '', '빈 값 그대로');

// ---------------------------------------------------------------------------
// replaceBucketLeaf — 상대 버킷의 폴더 leaf 치환
// ---------------------------------------------------------------------------
assert.strictEqual(
  lib.replaceBucketLeaf('★검증업체\\2026 시안작업\\검증현장', '검증현장', '새현장'),
  '★검증업체\\2026 시안작업\\새현장',
  '버킷 leaf 치환'
);
assert.strictEqual(
  lib.replaceBucketLeaf('★검증업체/2026 시안작업/검증현장', '검증현장', '새현장'),
  '★검증업체\\2026 시안작업\\새현장',
  '슬래시 구분자도 인식(치환 후 백슬래시 통일)'
);
assert.strictEqual(
  lib.replaceBucketLeaf('★검증업체\\2026 시안작업\\다른폴더', '검증현장', '새현장'),
  '★검증업체\\2026 시안작업\\다른폴더',
  '일치 없으면 원본 유지'
);

console.log('workflow-rename: all assertions passed');
