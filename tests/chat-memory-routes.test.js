const assert = require('node:assert');
const http = require('node:http');
const express = require('express');
const auth = require('../middleware/auth');
const TOKEN = 'cmadmin_' + Date.now();
auth.sessions[TOKEN] = { userId: 'admin', name: 't', role: 'admin', permissions: [] };
const app = express(); app.use(express.json());
app.use('/api/ai', require('../routes/ai-history'));
function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const b = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: app._port, path: p, method,
      headers: Object.assign({ 'x-session-token': TOKEN }, b ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(b) } : {}) },
      x => { let d = ''; x.on('data', c => d += c); x.on('end', () => resolve({ s: x.statusCode, j: (() => { try { return JSON.parse(d); } catch { return d; } })() })); });
    r.on('error', reject); if (b) r.write(b); r.end();
  });
}
const srv = app.listen(0, async () => {
  app._port = srv.address().port;
  try {
    const add = await req('POST', '/api/ai/memory', { content: '나이스텍은 안전시트 1장', category: '규칙' });
    assert.strictEqual(add.s, 200); assert.ok(add.j.ok);
    const list = await req('GET', '/api/ai/memory?status=active');
    assert.ok(list.j.items.some(i => i.content.includes('나이스텍')));
    // 비admin 차단
    const tok2 = 'emp_' + Date.now(); auth.sessions[tok2] = { userId: 'e1', role: 'employee', permissions: [] };
    const denied = await new Promise(r => { const x = http.request({ host: '127.0.0.1', port: app._port, path: '/api/ai/memory', headers: { 'x-session-token': tok2 } }, y => r(y.statusCode)); x.end(); });
    assert.strictEqual(denied, 403);
    // 정리(테스트 행 archive — 운영 DB 오염 방지)
    try { require('../db-ai').db.prepare("UPDATE chat_memory SET status='archived' WHERE content LIKE '%나이스텍은 안전시트%' AND status='active'").run(); } catch (_) {}
    console.log('PASS chat-memory-routes');
    srv.close(() => process.exit(0));
  } catch (e) { console.error('FAIL', e.message); srv.close(() => process.exit(1)); }
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
