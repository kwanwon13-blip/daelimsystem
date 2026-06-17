'use strict';

// 워크플로우 단계별 날짜 역할 + 제작완료 코드 발번 (순수 로직, 외부 의존성 없음 → 단위 테스트 용이)
//
// 단계: design(디자인팀) → factory(대림컴퍼니=공장) → delivery(영업지원팀) → done(수령/과거내역)
// 날짜 역할:
//   - 요청날짜  = job.dueDate              (디자인팀이 정함)
//   - 완료가능일 = job.factoryAvailableDate (대림컴퍼니가 정함)
// 완료코드/제작완료일:
//   - job.completedAt / job.completionCode 는 "제작완료(factory 단계 done)" 에 종속한다.
//     (수령/과거내역 보관 status='done' 과는 별개)

// 단계별 날짜 역할 가드: 저장 페이로드의 날짜 필드를 현재 단계 권한에 맞게 강제한다.
//   - design  : 요청날짜만 편집 가능, 완료가능일은 기존값 유지
//   - factory : 완료가능일만 편집 가능, 요청날짜는 기존값 유지(읽기전용)
//   - 그 외   : 둘 다 읽기전용(기존값 유지)
function applyDateRoleGuard(existingJob, payload) {
  const stage = (existingJob && existingJob.currentStage) || 'design';
  const prevDue = (existingJob && existingJob.dueDate) || '';
  const prevFactory = (existingJob && existingJob.factoryAvailableDate) || '';
  if (stage !== 'design') payload.dueDate = prevDue;
  if (stage !== 'factory') payload.factoryAvailableDate = prevFactory;
  return payload;
}

// completedAt(제작완료일)에서 KST(UTC+9) 기준 YYYYMMDD 추출.
// completedAt은 toISOString()=UTC라 그대로 자르면 한국 새벽 0~9시 완료건이 전날 코드로 발번된다
// → +9h 보정해 한국 날짜로 통일(등록코드 kstDay와 동일 기준, 2026-06-17).
function completionCodeDatePart(job) {
  const t = Date.parse(String((job && job.completedAt) || ''));
  if (!Number.isFinite(t)) return '';
  return new Date(t + 9 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
}

// 일별 순번 완료코드(YYYYMMDD-NNN) 발번. 한 번 발급되면 영구 고정(송장번호) — reopen·재완료해도 안 바뀜.
function assignCompletionCode(jobs, job) {
  if (job.completionCode) return job.completionCode; // 영구고정
  const ymd = completionCodeDatePart(job);
  if (!ymd) return '';
  let max = 0;
  for (const j of (jobs || [])) {
    if (j === job) continue;
    const c = String(j.completionCode || '');
    if (c.slice(0, 8) === ymd && c.charAt(8) === '-') {
      const n = parseInt(c.slice(9), 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  job.completionCode = `${ymd}-${String(max + 1).padStart(3, '0')}`;
  return job.completionCode;
}

// 제작완료 동기화: factory 단계 done 여부에 따라 제작완료일/코드/완료자를 세팅 또는 초기화.
function syncFactoryCompletion(jobs, job, at, actor = {}) {
  const checks = (job && job.stageChecks) || {};
  // 제작완료 = factory done AND 앞단계(design) done (순서 종속 — 정합성)
  const designDone = !!(checks.design && checks.design.status === 'done');
  const factoryCheck = checks.factory;
  const factoryDone = !!(factoryCheck && factoryCheck.status === 'done' && designDone);
  if (factoryDone) {
    if (!job.completedAt) job.completedAt = factoryCheck.completedAt || at || '';
    if (!job.completedBy) job.completedBy = actor.userId || '';
    if (!job.completedByName) job.completedByName = actor.userName || '';
    assignCompletionCode(jobs, job);
  } else {
    job.completedAt = '';
    job.completedBy = '';
    job.completedByName = '';
    // completionCode 는 영구고정(송장번호) — reopen 해도 보존
  }
  return job;
}

// 수령(완료/보관)은 전 단계 완료를 의미. 주어진 단계들을 done 으로 확정한다.
// (factory 가 도중 reopen 됐더라도 수령 시 done 으로 되돌려 제작완료일/코드를 보존)
function ensureStagesDone(job, stageIds, at) {
  if (!job || !job.stageChecks) return job;
  for (const id of (stageIds || [])) {
    const check = job.stageChecks[id];
    if (check && check.status !== 'done') {
      check.status = 'done';
      check.completedAt = check.completedAt || at || '';
    }
  }
  return job;
}

module.exports = {
  applyDateRoleGuard,
  completionCodeDatePart,
  assignCompletionCode,
  syncFactoryCompletion,
  ensureStagesDone,
};
