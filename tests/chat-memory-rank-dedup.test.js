// IDF 랭킹 + 퍼지(bigram+숫자가드) 중복제거 회귀 테스트
const assert = require('node:assert');
const path = require('node:path'); const fs = require('node:fs'); const os = require('node:os');
const Database = require('better-sqlite3');
const tmp = path.join(os.tmpdir(), 'cm_rd_' + process.pid + '.db'); try { fs.unlinkSync(tmp); } catch (_) {}
const mem = require('../lib/chat-memory'); mem._initForTest(new Database(tmp));

// ── IDF 랭킹: 희귀 거래처명이 흔한 "단가" 사실들보다 위로 주입 ──
mem.addMemory({ content: '이노텍과 이노사인은 같은 회사', category: '거래처', sourceKind: 'manual' });
mem.addMemory({ content: '모든 견적 단가는 부가세 별도', category: '규칙', sourceKind: 'manual' });
mem.addMemory({ content: '배너 단가표는 거래처별로 다름', category: '규칙', sourceKind: 'manual' });
const block = mem.getInjectionContext({ prompt: '이노텍 단가', maxChars: 4000 });
assert.ok(block.includes('이노텍'), '이노텍 사실이 주입돼야 함');
assert.ok(block.indexOf('이노텍') < block.indexOf('모든 견적'), 'IDF: 희귀 이노텍이 흔한 단가 사실보다 앞');

// ── 퍼지 dedup: 한국어 재서술은 norm_key가 달라도 흡수 ──
const d1 = mem.addMemory({ content: '한신공영은 부가세 별도', category: '규칙', sourceKind: 'manual' });
assert.strictEqual(d1.status, 'active');
const d2 = mem.addMemory({ content: '한신공영 부가세 별도임', category: '규칙', sourceKind: 'auto' });
assert.strictEqual(d2.deduped, true, '재서술은 퍼지로 중복 차단');
assert.strictEqual(d2.fuzzy, true);

// ── 숫자 가드: 단가가 다르면 다른 사실 → 둘 다 저장 ──
const p1 = mem.addMemory({ content: '현수막 단가 3500원', category: '품목', sourceKind: 'manual' });
const p2 = mem.addMemory({ content: '현수막 단가 5000원', category: '품목', sourceKind: 'manual' });
assert.ok(p1.id && p2.id && p1.id !== p2.id, '서로 다른 단가는 병합 금지');

// ── 교정(부정) 발화는 퍼지에 안 먹히고 pending 으로 라우팅 ──
const neg = mem.addMemory({ content: '한신공영은 이제 부가세 별도 아님', category: '규칙', sourceKind: 'auto' });
assert.strictEqual(neg.status, 'pending', '교정 발화는 퍼지 우회 → pending(검토 경로 유지)');

try { fs.unlinkSync(tmp); } catch (_) {}
console.log('PASS chat-memory-rank-dedup');
