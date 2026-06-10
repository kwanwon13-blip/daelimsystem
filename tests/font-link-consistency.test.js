const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// 아이콘 폰트는 셀프호스팅(/fonts/material-symbols.css)만 사용한다.
// (2026-06: ai-chat.html 만 구형 구글 /icon 주소를 써서 직원 PC에서 아이콘이 글자로 깨진 사고.
//  구글 의존 제거로 재발 차단 — 어떤 페이지도 구글 Material Symbols 링크를 쓰면 안 된다.)
const PUB = path.join(__dirname, '..', 'public');
const LOCAL_CSS = '/fonts/material-symbols.css';

// 1) 자기 <head>를 가진 독립 페이지가 아이콘 클래스를 쓰면 반드시 로컬 CSS를 링크해야 함
for (const name of fs.readdirSync(PUB).filter(f => f.endsWith('.html'))) {
  const html = fs.readFileSync(path.join(PUB, name), 'utf8');
  // 구글 Material Symbols 링크 전면 금지 (css2 / 구형 icon 모두)
  assert.ok(!/fonts\.googleapis\.com[^"']*Material\+Symbols/.test(html),
    `${name}: 구글 Material Symbols 링크 금지 — ${LOCAL_CSS} 를 쓰세요`);
  const usesIcons = html.includes('material-symbols-outlined');
  const hasOwnHead = html.includes('<head>');
  if (usesIcons && hasOwnHead) {
    assert.ok(html.includes(LOCAL_CSS), `${name}: 아이콘을 쓰는 독립 페이지는 ${LOCAL_CSS} 링크 필요`);
  }
}

// 2) 폰트 파일이 실제로 존재하고 유효한 woff2 여야 함
const woff2 = path.join(PUB, 'fonts', 'material-symbols-outlined.woff2');
assert.ok(fs.existsSync(woff2), 'public/fonts/material-symbols-outlined.woff2 가 없습니다');
const buf = fs.readFileSync(woff2);
assert.strictEqual(buf.subarray(0, 4).toString('ascii'), 'wOF2', 'woff2 시그니처가 아닙니다');
assert.ok(buf.length > 100 * 1024, `woff2 가 너무 작습니다 (${buf.length} bytes) — 다운로드 깨짐 의심`);

// 3) 로컬 CSS 가 @font-face 로 그 파일을 가리켜야 함
const css = fs.readFileSync(path.join(PUB, 'fonts', 'material-symbols.css'), 'utf8');
assert.ok(/@font-face/.test(css), 'material-symbols.css 에 @font-face 필요');
assert.ok(css.includes('/fonts/material-symbols-outlined.woff2'), 'CSS 가 로컬 woff2 를 가리켜야 함');
assert.ok(css.includes("font-feature-settings: 'liga'"), '리거처(liga) 설정 필요 — 없으면 아이콘이 글자로 보임');

console.log('PASS font-link-consistency');
