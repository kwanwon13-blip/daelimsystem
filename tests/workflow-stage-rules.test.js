const assert = require('node:assert');
const rules = require('../routes/lib/workflow-stage-rules');

// ---------------------------------------------------------------------------
// A. 날짜 역할 가드 (요청날짜=dueDate / 완료가능일=factoryAvailableDate)
//    - design 단계 편집만 요청날짜(dueDate) 저장
//    - factory 단계 편집만 완료가능일(factoryAvailableDate) 저장
//    - delivery(및 그 외) 단계 편집은 둘 다 읽기전용 → 기존값 유지
// ---------------------------------------------------------------------------
{
  // design 단계: 요청날짜는 새 값 유지, 완료가능일은 기존값으로 되돌림
  const existing = { currentStage: 'design', dueDate: '2026-06-01', factoryAvailableDate: '2026-06-20' };
  const payload = { dueDate: '2026-06-05', factoryAvailableDate: '2026-06-30' };
  rules.applyDateRoleGuard(existing, payload);
  assert.strictEqual(payload.dueDate, '2026-06-05', 'design 단계는 요청날짜를 저장해야 함');
  assert.strictEqual(payload.factoryAvailableDate, '2026-06-20', 'design 단계는 완료가능일을 바꿀 수 없음(기존값 유지)');
}

{
  // factory 단계: 완료가능일은 새 값 유지, 요청날짜는 기존값으로 되돌림(읽기전용)
  const existing = { currentStage: 'factory', dueDate: '2026-06-01', factoryAvailableDate: '2026-06-20' };
  const payload = { dueDate: '2026-06-05', factoryAvailableDate: '2026-06-30' };
  rules.applyDateRoleGuard(existing, payload);
  assert.strictEqual(payload.dueDate, '2026-06-01', 'factory 단계는 요청날짜를 바꿀 수 없음(기존값 유지)');
  assert.strictEqual(payload.factoryAvailableDate, '2026-06-30', 'factory 단계는 완료가능일을 저장해야 함');
}

{
  // delivery 단계: 둘 다 읽기전용 → 기존값 유지
  const existing = { currentStage: 'delivery', dueDate: '2026-06-01', factoryAvailableDate: '2026-06-20' };
  const payload = { dueDate: '2026-06-05', factoryAvailableDate: '2026-06-30' };
  rules.applyDateRoleGuard(existing, payload);
  assert.strictEqual(payload.dueDate, '2026-06-01', 'delivery 단계는 요청날짜 읽기전용');
  assert.strictEqual(payload.factoryAvailableDate, '2026-06-20', 'delivery 단계는 완료가능일 읽기전용');
}

{
  // currentStage 누락 → design 으로 간주(요청날짜만 허용)
  const existing = { dueDate: '2026-06-01', factoryAvailableDate: '' };
  const payload = { dueDate: '2026-06-05', factoryAvailableDate: '2026-06-30' };
  rules.applyDateRoleGuard(existing, payload);
  assert.strictEqual(payload.dueDate, '2026-06-05', 'stage 누락 시 design 으로 간주');
  assert.strictEqual(payload.factoryAvailableDate, '', 'stage 누락 시 완료가능일 차단');
}

// ---------------------------------------------------------------------------
// 완료코드 발번 (일별 순번 YYYYMMDD-NNN, completedAt 기준)
// ---------------------------------------------------------------------------
{
  // 같은 날 첫 코드 → -001
  const jobs = [];
  const job = { completedAt: '2026-06-09T03:00:00.000Z' };
  jobs.push(job);
  const code = rules.assignCompletionCode(jobs, job);
  assert.strictEqual(code, '20260609-001', '그 날 첫 완료 → 001');
  assert.strictEqual(job.completionCode, '20260609-001');
}

{
  // 같은 날 두 번째 → -002
  const jobs = [{ completionCode: '20260609-001', completedAt: '2026-06-09T01:00:00.000Z' }];
  const job = { completedAt: '2026-06-09T05:00:00.000Z' };
  jobs.push(job);
  const code = rules.assignCompletionCode(jobs, job);
  assert.strictEqual(code, '20260609-002', '같은 날 두 번째 → 002');
}

{
  // 멱등: 같은 날짜에 재발번하면 코드 유지
  const jobs = [];
  const job = { completedAt: '2026-06-09T03:00:00.000Z' };
  jobs.push(job);
  rules.assignCompletionCode(jobs, job);
  const again = rules.assignCompletionCode(jobs, job);
  assert.strictEqual(again, '20260609-001', '같은 날짜 재발번은 코드 유지(멱등)');
}

{
  // completedAt 없으면 발번 불가(빈 문자열)
  const jobs = [];
  const job = {};
  jobs.push(job);
  const code = rules.assignCompletionCode(jobs, job);
  assert.strictEqual(code, '', 'completedAt 없으면 코드 없음');
}

// ---------------------------------------------------------------------------
// 제작완료(factory) 동기화 — completionCode/completedAt 는 제작완료 단계에 종속
//    - factory 단계가 done 이면 completedAt(제작완료일)+코드 발번
//    - factory 단계가 done 이 아니면 완료필드 초기화
// ---------------------------------------------------------------------------
{
  // factory done → 제작완료일 + 코드 세팅
  const jobs = [];
  const job = {
    stageChecks: { factory: { status: 'done', completedAt: '2026-06-09T02:00:00.000Z' } },
  };
  jobs.push(job);
  rules.syncFactoryCompletion(jobs, job, '2026-06-09T09:00:00.000Z', { userId: 'u1', userName: '공장장' });
  assert.strictEqual(job.completedAt, '2026-06-09T02:00:00.000Z', '제작완료일 = factory 단계 완료시각');
  assert.strictEqual(job.completionCode, '20260609-001', '제작완료 시 코드 발번');
  assert.strictEqual(job.completedByName, '공장장', '제작완료자 기록');
}

{
  // factory 단계 완료시각이 없으면 at 으로 대체
  const jobs = [];
  const job = { stageChecks: { factory: { status: 'done', completedAt: '' } } };
  jobs.push(job);
  rules.syncFactoryCompletion(jobs, job, '2026-06-09T09:00:00.000Z', {});
  assert.strictEqual(job.completedAt, '2026-06-09T09:00:00.000Z', 'factory completedAt 없으면 at 사용');
  assert.strictEqual(job.completionCode, '20260609-001');
}

{
  // factory 미완료 → 완료필드 초기화
  const jobs = [];
  const job = {
    completedAt: '2026-06-09T02:00:00.000Z',
    completionCode: '20260609-001',
    completedByName: '공장장',
    stageChecks: { factory: { status: 'ready' } },
  };
  jobs.push(job);
  rules.syncFactoryCompletion(jobs, job, '2026-06-09T09:00:00.000Z', {});
  assert.strictEqual(job.completedAt, '', 'factory 미완료면 제작완료일 초기화');
  assert.strictEqual(job.completionCode, '', 'factory 미완료면 코드 초기화');
}

{
  // 멱등: 이미 제작완료면 같은 날 재호출해도 코드 유지
  const jobs = [];
  const job = {
    completedAt: '2026-06-09T02:00:00.000Z',
    completionCode: '20260609-001',
    stageChecks: { factory: { status: 'done', completedAt: '2026-06-09T02:00:00.000Z' } },
  };
  jobs.push(job);
  rules.syncFactoryCompletion(jobs, job, '2026-06-10T09:00:00.000Z', {});
  assert.strictEqual(job.completedAt, '2026-06-09T02:00:00.000Z', '이미 설정된 제작완료일 유지');
  assert.strictEqual(job.completionCode, '20260609-001', '코드 유지');
}

// ---------------------------------------------------------------------------
// ensureStagesDone — 수령(완료/보관)은 전 단계 완료를 의미. 모든 단계를 done 으로 확정.
//   → factory 가 도중 reopen 됐더라도 수령 시 done 으로 되돌려 제작완료일/코드를 보존
// ---------------------------------------------------------------------------
{
  const job = {
    stageChecks: {
      design: { status: 'done', completedAt: '2026-06-08T01:00:00.000Z' },
      factory: { status: 'ready', completedAt: '' }, // 도중 reopen 된 상태
      delivery: { status: 'done', completedAt: '2026-06-09T05:00:00.000Z' },
    },
  };
  rules.ensureStagesDone(job, ['design', 'factory', 'delivery'], '2026-06-09T09:00:00.000Z');
  assert.strictEqual(job.stageChecks.factory.status, 'done', 'reopen 된 factory 를 done 으로 확정');
  assert.strictEqual(job.stageChecks.factory.completedAt, '2026-06-09T09:00:00.000Z', '비어있던 factory 완료시각은 at 으로 채움');
  assert.strictEqual(job.stageChecks.design.completedAt, '2026-06-08T01:00:00.000Z', '기존 완료시각은 보존');
  assert.strictEqual(job.stageChecks.delivery.status, 'done');
}

{
  // ensureStagesDone 직후 syncFactoryCompletion 이 코드를 유지/발번해야 함(수령 시 미발번 방지)
  const jobs = [];
  const job = {
    completedAt: '2026-06-09T02:00:00.000Z',
    completionCode: '20260609-001',
    stageChecks: {
      design: { status: 'done' },
      factory: { status: 'ready' }, // reopen
      delivery: { status: 'done' },
    },
  };
  jobs.push(job);
  rules.ensureStagesDone(job, ['design', 'factory', 'delivery'], '2026-06-09T09:00:00.000Z');
  rules.syncFactoryCompletion(jobs, job, '2026-06-09T09:00:00.000Z', {});
  assert.strictEqual(job.completionCode, '20260609-001', '수령 시 발번된 코드 보존(미발번 방지)');
  assert.strictEqual(job.completedAt, '2026-06-09T02:00:00.000Z', '제작완료일 보존');
}

console.log('workflow-stage-rules: all assertions passed');
