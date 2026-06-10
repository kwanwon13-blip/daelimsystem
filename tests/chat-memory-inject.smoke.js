const assert = require('node:assert');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const Database = require('better-sqlite3');
const tmp = path.join(os.tmpdir(), 'cm_inj_' + process.pid + '.db');
try { fs.unlinkSync(tmp); } catch (_) {}
const mem = require('../lib/chat-memory');
mem._initForTest(new Database(tmp));
mem.addMemory({ content: '한신공영은 부가세 별도', category: '규칙', sourceKind: 'manual' });
const block = mem.getInjectionContext({ prompt: '한신공영 견적 어떻게', maxChars: 4000 });
assert.ok(block.includes('한신공영은 부가세 별도'));
assert.ok(block.startsWith('<<<회사기억>>>'));
console.log('PASS inject smoke');
