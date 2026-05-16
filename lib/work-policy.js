const fs = require('fs');
const path = require('path');

const POLICY_PATH = path.join(__dirname, '..', 'data', '근무정책.json');

const DEFAULT_POLICIES = [
  {
    id: 'p_default',
    name: '기본 정책 (~2026-04)',
    effectiveFrom: '2020-01-01',
    workStart: '08:30',
    workEnd: '19:00',
    lunchStart: '13:00',
    lunchEnd: '14:00',
    halfAMIn: '14:00',
    halfPMOut: '11:30',
    overtimeStart: '19:00',
    note: '1~4월 정책: 점심 13~14시, 퇴근 19시',
  },
  {
    id: 'p_2026_05',
    name: '5월 정책 (점심 12~13시)',
    effectiveFrom: '2026-05-01',
    workStart: '08:30',
    workEnd: '17:30',
    lunchStart: '12:00',
    lunchEnd: '13:00',
    halfAMIn: '13:30',
    halfPMOut: '12:00',
    overtimeStart: '18:00',
    note: '2026-05-01부터 시행: 퇴근 17:30, 점심 12~13시, 반차=12시 퇴근/13:30 출근, 야근=18시 이후',
  },
];

const DEFAULT_POLICY = DEFAULT_POLICIES[0];

function timeToMin(s) {
  if (!s || typeof s !== 'string') return 0;
  const [h, m] = s.split(':').map(Number);
  if (Number.isNaN(h) || Number.isNaN(m)) return 0;
  return h * 60 + m;
}

function normalizePolicies(policies) {
  const byId = new Map(DEFAULT_POLICIES.map(policy => [policy.id, policy]));

  for (const policy of policies || []) {
    if (!policy || !policy.id) continue;
    byId.set(policy.id, { ...byId.get(policy.id), ...policy });
  }

  return [...byId.values()]
    .filter(policy => policy.effectiveFrom)
    .sort((a, b) => (a.effectiveFrom || '').localeCompare(b.effectiveFrom || ''));
}

function loadPolicies() {
  try {
    if (!fs.existsSync(POLICY_PATH)) {
      return { policies: [...DEFAULT_POLICIES] };
    }

    const raw = fs.readFileSync(POLICY_PATH, 'utf8');
    const data = JSON.parse(raw);
    return { ...data, policies: normalizePolicies(data.policies) };
  } catch (e) {
    console.error('[work-policy] failed to load policy file:', e.message);
    return { policies: [...DEFAULT_POLICIES] };
  }
}

function getPolicyForDate(dateStr) {
  const { policies } = loadPolicies();
  const sorted = [...policies].sort((a, b) => (b.effectiveFrom || '').localeCompare(a.effectiveFrom || ''));
  const matched = sorted.find(policy => dateStr >= (policy.effectiveFrom || '0000-01-01'));
  return matched || DEFAULT_POLICY;
}

function getPolicyMinutesForDate(dateStr) {
  const policy = getPolicyForDate(dateStr);
  return {
    ...policy,
    workStartMin: timeToMin(policy.workStart),
    workEndMin: timeToMin(policy.workEnd),
    lunchStartMin: timeToMin(policy.lunchStart),
    lunchEndMin: timeToMin(policy.lunchEnd),
    halfAMInMin: timeToMin(policy.halfAMIn),
    halfPMOutMin: timeToMin(policy.halfPMOut),
    overtimeStartMin: timeToMin(policy.overtimeStart),
  };
}

function addFiveMinutes(timeStr) {
  const min = timeToMin(timeStr) + 5;
  return { h: Math.floor(min / 60), m: min % 60 };
}

function getAutoSyncTimesForToday() {
  const today = new Date().toISOString().slice(0, 10);
  const policy = getPolicyForDate(today);

  return [
    { ...addFiveMinutes(policy.workStart), label: '출근 체크' },
    { ...addFiveMinutes(policy.halfPMOut), label: '오후반차 퇴근 체크' },
    { ...addFiveMinutes(policy.halfAMIn), label: '오전반차 출근 체크' },
    { ...addFiveMinutes(policy.workEnd), label: '퇴근 체크' },
  ];
}

module.exports = {
  getPolicyForDate,
  getPolicyMinutesForDate,
  getAutoSyncTimesForToday,
  loadPolicies,
  DEFAULT_POLICY,
  DEFAULT_POLICIES,
  timeToMin,
};
