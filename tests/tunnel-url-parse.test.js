const assert = require('node:assert');
const { parseTunnelUrl } = require('../scripts/cloudflare-tunnel/tunnel-quick.js');

// cloudflared quick tunnel 출력에서 공개 URL 추출
assert.strictEqual(
  parseTunnelUrl('2026-06-10T01:02:03Z INF |  https://abc-def-123.trycloudflare.com  |'),
  'https://abc-def-123.trycloudflare.com',
  '박스 로그 라인에서 URL 추출',
);
assert.strictEqual(
  parseTunnelUrl('Your quick Tunnel has been created! Visit it at https://x9.trycloudflare.com'),
  'https://x9.trycloudflare.com',
  '문장형 라인에서도 추출',
);
assert.strictEqual(parseTunnelUrl('INF Starting tunnel tunnelID=...'), '', 'URL 없는 라인은 빈값');
assert.strictEqual(parseTunnelUrl(''), '', '빈 라인 안전');
// named tunnel(고정 도메인) 출력도 지원: https://erp.example.com 형태는 trycloudflare가 아니라서 추출 안 함(등록은 quick 전용)
assert.strictEqual(parseTunnelUrl('serving at https://erp.daelim.com'), '', 'trycloudflare 외 도메인은 무시');

console.log('tunnel-url-parse: all assertions passed');
