const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 모든 페이지가 같은 Material Symbols 주소(css2)를 쓰는지 — 다르면 한쪽만 캐시 미스로 깨진다.
// (2026-06: ai-chat.html 만 구형 /icon 주소를 써서 직원 PC에서 아이콘이 글자로 깨진 사고 재발 방지)
const PUB = path.join(__dirname, '..', 'public');
const CSS2 = 'fonts.googleapis.com/css2?family=Material+Symbols+Outlined';
const LEGACY = 'fonts.googleapis.com/icon?family=';

const indexHtml = fs.readFileSync(path.join(PUB, 'index.html'), 'utf8');
const chatHtml = fs.readFileSync(path.join(PUB, 'ai-chat.html'), 'utf8');

assert.ok(indexHtml.includes(CSS2), 'index.html 은 css2 Material Symbols 링크를 써야 함');
assert.ok(chatHtml.includes(CSS2), 'ai-chat.html 은 index.html 과 같은 css2 링크를 써야 함');
assert.ok(!chatHtml.includes(LEGACY), 'ai-chat.html 에 구형 /icon 엔드포인트 금지');
assert.ok(!indexHtml.includes(LEGACY), 'index.html 에 구형 /icon 엔드포인트 금지');

// 캐시 적중을 위해 두 파일의 css2 URL 이 "완전히 동일"해야 함 (한 글자라도 다르면 별개 캐시)
const urlRe = /https:\/\/fonts\.googleapis\.com\/css2\?family=Material\+Symbols\+Outlined[^"']*/;
const a = (indexHtml.match(urlRe) || [])[0];
const b = (chatHtml.match(urlRe) || [])[0];
assert.ok(a && b && a === b, `두 파일의 Material Symbols URL 이 달라요:\n index: ${a}\n chat : ${b}`);

console.log('PASS font-link-consistency');
