'use strict';
/**
 * routes/lib/workflow-notify-recipients.js
 * 워크플로 이벤트 알림 수신자 결정 — 순수 함수(부서·설정·DB 의존성은 주입).
 *
 * 정책(2026-06 사장님 지시 — 과다발송 차단):
 *  - 디자인 단계 알림        → 발주자(작성자) 본인만. 디자인팀 '전원' 푸시 안 함.
 *  - 경영관리(delivery) 알림 → 그 회사 담당자 1명만. 경영관리팀 '전원' 푸시 안 함.
 *  - 공장(factory) 알림      → 공장팀(부서 전원) 유지(가져갈 사람이 봐야 함).
 *  - 명시 지목(targetUserId/Name/라벨=이름) → 그 사람.
 *  - 회사 담당자는 회사별 1명, 단계와 무관하게 항상 수신(회사별 추적).
 *  - 행위자 본인·미승인 사용자는 제외, 중복은 1회.
 *
 * 부서 매칭(공장)·식별 매칭(명시 지목)은 워크플로 본체의 기존 로직을 그대로 주입받는다
 * (matchesFactoryDept / isExplicitTarget). 이 모듈은 '어느 단계를 어디로 보낼지'의
 * 오케스트레이션만 담당해 단위 테스트가 쉽다.
 */

function lower(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

function isApproved(u) {
  return !!(u && u.userId && (!u.status || u.status === 'approved'));
}

/**
 * @param {object} input
 * @param {Array}  input.users            승인 후보 사용자 [{userId,name,status,...}]
 * @param {string[]} input.stageIds       이 이벤트가 가리키는 단계 ('design'|'factory'|'delivery')
 * @param {string} input.actorId          행위자(제외)
 * @param {string} input.creatorUserId    job.createdBy (발주자)
 * @param {string} input.managerName      managerNameForCompany(job.companyName) — 회사 담당자 이름
 * @param {(u:object)=>boolean} input.isExplicitTarget  targetUserId/Name/라벨 식별 매칭(주입)
 * @param {(u:object)=>boolean} input.matchesFactoryDept 공장 부서 매칭(주입)
 * @returns {Array} 수신자 사용자 객체 배열(중복 제거)
 */
function resolveWorkflowEventRecipients(input) {
  const {
    users = [],
    stageIds = [],
    actorId = '',
    creatorUserId = '',
    managerName = '',
    isExplicitTarget = () => false,
    matchesFactoryDept = () => false,
  } = input || {};

  const actor = lower(actorId);
  const creator = lower(creatorUserId);
  const manager = lower(managerName);
  const wantDesign = stageIds.includes('design');
  const wantFactory = stageIds.includes('factory');

  const picked = new Map();
  const add = (u) => {
    if (!isApproved(u)) return;
    if (actor && lower(u.userId) === actor) return; // 행위자 본인 제외
    picked.set(String(u.userId), u);
  };

  for (const u of (Array.isArray(users) ? users : [])) {
    if (isExplicitTarget(u)) add(u);                                  // 명시 지목(그 사람)
    if (wantFactory && matchesFactoryDept(u)) add(u);                 // 공장 → 공장팀(부서)
    if (wantDesign && creator && lower(u.userId) === creator) add(u); // 디자인 → 발주자
    if (manager && lower(u.name) === manager) add(u);                 // 회사 담당자(1명) 항상
  }

  return Array.from(picked.values());
}

module.exports = { resolveWorkflowEventRecipients };
