const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// public/workflow.js 의 순수 헬퍼(단계 라벨 + 외부 받기 링크)를 vm 으로 로드해 검증한다.
const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'workflow.js'), 'utf8');
const win = {
  location: { origin: 'https://tunnel.example.com', hostname: 'tunnel.example.com' },
  prompt: () => '',
};
const context = {
  console, URL, URLSearchParams, setInterval, clearInterval,
  window: win,
  navigator: { clipboard: { writeText: async () => {} } },
  alert: () => {},
  document: { addEventListener() {} },
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'public/workflow.js' });

const app = context.workflowApp();
app.stages = [
  { id: 'design', label: '디자인팀' },
  { id: 'factory', label: '대림컴퍼니' },
  { id: 'delivery', label: '영업지원팀' },
];

// --- A#4: 단계 전환 라벨 (design→완료가능일 확정, factory→완료, delivery→납품준비) ---
assert.strictEqual(app.stageHandoffLabel('design'), '완료가능일 확정');
assert.strictEqual(app.stageHandoffLabel('factory'), '완료');
assert.strictEqual(app.stageHandoffLabel('delivery'), '납품준비');

assert.strictEqual(app.cardNextLabel({ currentStage: 'design' }), '완료가능일 확정');
assert.strictEqual(app.cardNextLabel({ currentStage: 'factory' }), '완료');
assert.strictEqual(app.cardNextLabel({ currentStage: 'delivery' }), '납품준비');
assert.strictEqual(app.cardNextLabel({}), '완료가능일 확정', 'currentStage 없으면 design 으로 간주');

// handoffLabel 은 상세 작업의 현재 단계를 따른다
app.detail = { job: { currentStage: 'factory', stageChecks: {} } };
app.selectedWorkStageId = '';
assert.strictEqual(app.handoffLabel(), '완료');

console.log('workflow-frontend-labels: all assertions passed');
