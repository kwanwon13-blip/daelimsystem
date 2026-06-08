const assert = require('node:assert');
const http = require('node:http');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const Database = require('better-sqlite3');
const express = require('express');
const auth = require('../middleware/auth');

// 회사기억을 임시 DB 로 격리 — 라우트도 같은 chat-memory 싱글턴을 쓰므로
// _initForTest 로 핸들을 주입하면 운영 ai기록.db 를 건드리지 않고 멱등 테스트 가능.
const tmp = path.join(os.tmpdir(), 'cm_routes_' + process.pid + '.db');
try { fs.unlinkSync(tmp); } catch (_) {}
require('../lib/chat-memory')._initForTest(new Database(tmp));

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
    // 위험(개인정보) → pending 으로 라우팅되어 active 에 안 보임
    const risky = await req('POST', '/api/ai/memory', { content: '박과장 010-1234-5678', category: '거래처' });
    assert.strictEqual(risky.s, 200);
    const actList = await req('GET', '/api/ai/memory?status=active');
    assert.ok(!actList.j.items.some(i => i.content.includes('010-1234-5678')));
    const pendList = await req('GET', '/api/ai/memory?status=pending');
    assert.ok(pendList.j.items.some(i => i.content.includes('010-1234-5678')));
    // 비admin 차단
    const tok2 = 'emp_' + Date.now(); auth.sessions[tok2] = { userId: 'e1', role: 'employee', permissions: [] };
    const denied = await new Promise(r => { const x = http.request({ host: '127.0.0.1', port: app._port, path: '/api/ai/memory', headers: { 'x-session-token': tok2 } }, y => r(y.statusCode)); x.end(); });
    assert.strictEqual(denied, 403);
    console.log('PASS chat-memory-routes');
    srv.close(() => { try { fs.unlinkSync(tmp); } catch (_) {} process.exit(0); });
  } catch (e) { console.error('FAIL', e.message); srv.close(() => process.exit(1)); }
});
setTimeout(() => { console.error('TIMEOUT'); process.exit(1); }, 15000);
