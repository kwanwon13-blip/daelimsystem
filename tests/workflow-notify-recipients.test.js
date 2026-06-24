const assert = require('node:assert');
const { resolveWorkflowEventRecipients } = require('../routes/lib/workflow-notify-recipients');

// 라이브 부서 구조 모사: 경영관리팀 4명(우정은·안소현·김다한·김선율) 같은 부서, 디자인 2명, 공장 2명
const USERS = [
  { userId: 'designer1',    name: '장은지', department: 'design',  status: 'approved' },
  { userId: 'designer2',    name: '김윤섭', department: 'design',  status: 'approved' },
  { userId: 'kimdahan0933', name: '김다한', department: 'mgmt',    status: 'approved' }, // 퍼시스 담당
  { userId: 'ksy0709',      name: '김선율', department: 'mgmt',    status: 'approved' }, // 포스코 담당
  { userId: 'woo',          name: '우정은', department: 'mgmt',    status: 'approved' }, // 기본 담당
  { userId: 'sohyun011',    name: '안소현', department: 'mgmt',    status: 'approved' }, // DL 담당
  { userId: 'factory1',     name: '전상현', department: 'factory', status: 'approved' },
  { userId: 'factory2',     name: '안희찬', department: 'factory', status: 'approved' },
  { userId: 'pending1',     name: '대기자', department: 'design',  status: 'pending'  },
];
const factoryDept = (u) => u.department === 'factory';
const noExplicit = () => false;
const ids = (arr) => arr.map((u) => u.userId).sort();

// 1) 경영관리(delivery) 이벤트 → 회사 담당자 1명만. 경영관리팀 4명 전원 수신 아님(★핵심 버그 수정).
{
  const r = resolveWorkflowEventRecipients({
    users: USERS, stageIds: ['delivery'], actorId: 'designer1',
    creatorUserId: 'designer1', managerName: '김다한',
    isExplicitTarget: noExplicit, matchesFactoryDept: factoryDept,
  });
  assert.deepStrictEqual(ids(r), ['kimdahan0933'], 'delivery → 담당자(김다한) 1명만, 경영관리팀 전원 아님');
}

// 2) 디자인 이벤트 → 발주자(작성자) + 회사담당자. 디자인팀 전원 아님.
{
  const r = resolveWorkflowEventRecipients({
    users: USERS, stageIds: ['design'], actorId: 'someoneElse',
    creatorUserId: 'designer1', managerName: '김다한',
    isExplicitTarget: noExplicit, matchesFactoryDept: factoryDept,
  });
  assert.deepStrictEqual(ids(r), ['designer1', 'kimdahan0933'], 'design → 발주자+담당자만, 디자인팀 전원 아님');
}

// 3) 공장 이벤트 → 공장팀 전원 + 회사담당자 (공장은 부서 유지).
{
  const r = resolveWorkflowEventRecipients({
    users: USERS, stageIds: ['factory'], actorId: 'x',
    creatorUserId: 'designer1', managerName: '우정은',
    isExplicitTarget: noExplicit, matchesFactoryDept: factoryDept,
  });
  assert.deepStrictEqual(ids(r), ['factory1', 'factory2', 'woo'], 'factory → 공장팀 + 담당자');
}

// 4) 행위자(actor) 제외 — 발주자가 본인이면 자기 알림은 안 옴.
{
  const r = resolveWorkflowEventRecipients({
    users: USERS, stageIds: ['design'], actorId: 'designer1',
    creatorUserId: 'designer1', managerName: '김다한',
    isExplicitTarget: noExplicit, matchesFactoryDept: factoryDept,
  });
  assert.deepStrictEqual(ids(r), ['kimdahan0933'], '행위자(발주자 본인)는 제외');
}

// 5) 명시 지목 → 그 사람 + 담당자.
{
  const r = resolveWorkflowEventRecipients({
    users: USERS, stageIds: [], actorId: 'x',
    creatorUserId: 'designer1', managerName: '김선율',
    isExplicitTarget: (u) => u.userId === 'designer2', matchesFactoryDept: factoryDept,
  });
  assert.deepStrictEqual(ids(r), ['designer2', 'ksy0709'], '명시 지목 + 담당자');
}

// 6) 미승인 사용자는 제외(발주자가 미승인이어도 대상 아님).
{
  const r = resolveWorkflowEventRecipients({
    users: USERS, stageIds: ['design'], actorId: 'x',
    creatorUserId: 'pending1', managerName: '',
    isExplicitTarget: noExplicit, matchesFactoryDept: factoryDept,
  });
  assert.deepStrictEqual(ids(r), [], '미승인 발주자는 알림 대상 아님');
}

// 7) 발주자 == 회사담당자면 중복 제거(1회).
{
  const r = resolveWorkflowEventRecipients({
    users: USERS, stageIds: ['design'], actorId: 'x',
    creatorUserId: 'kimdahan0933', managerName: '김다한',
    isExplicitTarget: noExplicit, matchesFactoryDept: factoryDept,
  });
  assert.deepStrictEqual(ids(r), ['kimdahan0933'], '발주자=담당자면 중복 제거');
}

// 8) 회사담당자는 단계 무관 항상 1명 수신(회사별 추적).
{
  const r = resolveWorkflowEventRecipients({
    users: USERS, stageIds: ['factory'], actorId: 'x',
    creatorUserId: 'designer1', managerName: '김다한',
    isExplicitTarget: noExplicit, matchesFactoryDept: factoryDept,
  });
  assert.ok(r.some((u) => u.userId === 'kimdahan0933'), '담당자는 공장 이벤트에도 수신');
}

// 9) 빈 입력 안전(수신자 없음).
{
  const r = resolveWorkflowEventRecipients({ users: [], stageIds: ['delivery'] });
  assert.deepStrictEqual(r, [], '사용자 없으면 빈 배열');
}

console.log('workflow-notify-recipients: all assertions passed');
