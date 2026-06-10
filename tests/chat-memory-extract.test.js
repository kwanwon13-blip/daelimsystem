const assert = require('node:assert');
const mem = require('../lib/chat-memory');
// 가짜 LLM: 프롬프트 받아 JSON 배열 문자열 반환
const fakeLlm = async () => '```json\n[{"category":"규칙","content":"한신공영은 부가세 별도"},{"category":"품목","content":"포맥스 3T 단가 12000"}]\n```';
(async () => {
  const facts = await mem.extractFacts(fakeLlm, { userText: '한신공영 부가세 별도로 끊어, 포맥스 3T는 12000', aiText: '네' });
  assert.strictEqual(facts.length, 2);
  assert.strictEqual(facts[0].category, '규칙');
  assert.ok(facts[0].content.includes('한신공영'));
  // 빈/깨진 응답 → 빈 배열, throw 안 함
  assert.deepStrictEqual(await mem.extractFacts(async () => 'not json', {}), []);
  assert.deepStrictEqual(await mem.extractFacts(async () => { throw new Error('x'); }, {}), []);
  console.log('PASS chat-memory-extract');
})();
