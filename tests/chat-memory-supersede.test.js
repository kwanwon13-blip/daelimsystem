const assert = require('node:assert');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const Database = require('better-sqlite3');
const tmp = path.join(os.tmpdir(), 'cm_sup_' + process.pid + '.db'); try { fs.unlinkSync(tmp); } catch (_) {}
const db = new Database(tmp);
const mem = require('../lib/chat-memory'); mem._initForTest(db);

// 기존 active 사실
const a = mem.addMemory({ content: '한신공영은 부가세 별도', category: '규칙', sourceKind: 'manual' });
assert.strictEqual(a.status, 'active');
// 무관한 다른 거래처 규칙 (supersede 에 휩쓸리면 안 됨)
const other = mem.addMemory({ content: '나이스텍은 부가세 포함', category: '규칙', sourceKind: 'manual' });
assert.strictEqual(other.status, 'active');

// 부정/교정 발화 → pending(위험라우팅)
const b = mem.addMemory({ content: '한신공영은 이제 부가세 별도 아님', category: '규칙', sourceKind: 'auto' });
assert.strictEqual(b.status, 'pending');
assert.ok(mem.listMemory({ status: 'pending' }).some(x => x.id === b.id));

// 승인 → b active + 같은 거래처(한신공영) 옛 기억 archive, 무관 나이스텍은 유지
mem.approveMemory(b.id);
const byId = (id) => db.prepare('SELECT status, superseded_by FROM chat_memory WHERE id=?').get(id);
assert.strictEqual(byId(b.id).status, 'active');
assert.strictEqual(byId(a.id).status, 'archived');
assert.strictEqual(byId(a.id).superseded_by, b.id);
assert.strictEqual(byId(other.id).status, 'active');   // 나이스텍은 안 건드림

db.close(); try { fs.unlinkSync(tmp); } catch (_) {}
console.log('PASS chat-memory-supersede');
