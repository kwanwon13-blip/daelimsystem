'use strict';
/*
 * 권한→탭 동치성 테스트 (순수 node, 의존성 0)
 *   실행:  node tests/perm-tabs-equivalence.test.js
 *
 * 목적: index.html 의 `get tabs()` 를 "단일 카탈로그(enrich된 allMenus) 구동" 으로
 *       리팩터한 결과(newTabs)가 구버전 로직(oldTabs)과 **탭 id 집합**이 100% 동일함을 증명.
 *
 * ⚠️ 규칙: 아래 newTabs() 의 본문은 index.html `get tabs()` 본문과 **글자 그대로 동일**해야 한다.
 *          (this.auth -> ctx, this.allMenus -> ALL_MENUS 치환만 차이)
 *          불일치가 발견되면 테스트가 아니라 로직을 고쳐 구버전 동작에 맞춘다(구버전이 정답).
 */

// ─────────────────────────────────────────────────────────────────────────────
// enrich된 allMenus (index.html 과 동일한 데이터)
// ─────────────────────────────────────────────────────────────────────────────
const ALL_MENUS = [
  { id: 'home',            label: '홈',                      tabId: 'home',           group: '공용',     company: 'both',    alwaysOn: true,  desc: '로그인하면 누구나 보는 시작 화면(대시보드)' },
  { id: 'quote',           label: '견적 작성',               tabId: 'quote',          group: '업무',     company: 'both',    defaultOnly: true, desc: '견적서를 새로 작성' },
  { id: 'history',         label: '견적 목록',               tabId: 'history',        group: '업무',     company: 'both',    defaultOnly: true, desc: '지난 견적서들을 모아보고 다시 염' },
  { id: 'stats',           label: '통계',                    tabId: 'stats',          group: '업무',     company: 'both',    desc: '매출·견적 통계 화면' },
  { id: 'pricing_view',    label: '단가 조회',               tabId: 'pricing',        group: '단가·품목', company: 'both',   segmentGroup: 'pricing', desc: '업체별 단가를 열람만(수정 불가)' },
  { id: 'pricing_edit',    label: '단가 수정',               tabId: 'pricing',        group: '단가·품목', company: 'both',   segmentGroup: 'pricing', desc: '업체별 단가를 직접 고침(저장 권한)' },
  { id: 'salesLookup',     label: '과거단가조회',            tabId: 'salesLookup',    group: '업무',     company: 'both',    defaultOnly: true, desc: '예전에 나간 단가를 거슬러 조회' },
  { id: 'attendance_all',  label: '출퇴근 기록부 (팀 전체)', tabId: 'attendance',     group: '인사',     company: 'both',    forcedNonAdmin: true, desc: '우리 팀 전원의 출퇴근 기록을 봄' },
  { id: 'leave',           label: '연차 관리',               tabId: 'leave',          group: '인사',     company: 'both',    forcedNonAdmin: true, desc: '연차 신청·잔여일수 관리' },
  { id: 'options',         label: '옵션 관리',               tabId: 'options',        group: '단가·품목', company: 'both',   desc: '품목 옵션(후가공 등) 단가 관리' },
  { id: 'vendors',         label: '업체 관리',               tabId: 'vendors',        group: '단가·품목', company: 'both',   desc: '거래 업체 등록·관리' },
  { id: 'pickup_view',     label: '픽업 조회',               tabId: 'pickup',         group: '단가·품목', company: 'both',   segmentGroup: 'pickup', desc: '픽업 요청 취합·체크 화면 열람' },
  { id: 'pickup_register', label: '픽업 등록',               tabId: 'pickup',         group: '단가·품목', company: 'both',   segmentGroup: 'pickup', desc: '픽업 요청 등록·수정·취소' },
  { id: 'pickup_check',    label: '픽업 체크',               tabId: 'pickup',         group: '단가·품목', company: 'both',   segmentGroup: 'pickup', desc: '픽업 라인 수거완료/미수거 체크' },
  { id: 'design',          label: '시안 검색',               tabId: 'design',         group: '공용',     company: 'both',    alwaysOn: true,  desc: '과거 시안을 이미지로 검색' },
  { id: 'photos',          label: '사진 라이브러리',         tabId: 'photos',         group: '공용',     company: 'both',    alwaysOn: true,  desc: '현장·제품 사진 보관함' },
  { id: 'esmPurchase',     label: '에스엠 매입',             tabId: 'esmPurchase',    group: '매입',     company: 'sm',      desc: '대림에스엠 매입명세서 OCR·등록' },
  { id: 'companyPurchase', label: '컴퍼니 매입',             tabId: 'companyPurchase',group: '매입',     company: 'company', desc: '대림컴퍼니 매입명세서 OCR·등록' },
  { id: 'contacts',        label: '연락처',                  tabId: 'contacts',       group: '공용',     company: 'both',    alwaysOn: true,  desc: '거래처·직원 연락처 모음' },
  { id: 'workflow',        label: '워크플로우',              tabId: 'workflow',       group: '공용',     company: 'both',    alwaysOn: true,  desc: '제작 진행상황 카드보드' },
  { id: 'calendar',        label: '캘린더',                  tabId: 'calendar',       group: '공용',     company: 'both',    desc: '일정·납기 달력' },
  { id: 'approval',        label: '결재',                    tabId: 'approval',       group: '인사',     company: 'both',    forcedNonAdmin: true, desc: '전자결재 상신·승인' },
  { id: 'orgchart',        label: '조직도',                  tabId: 'orgchart',       group: '인사',     company: 'both',    desc: '부서·직원 조직도' },
  { id: 'notices',         label: '공지사항',                tabId: 'notices',        group: '관리',     company: 'both',    desc: '회사 공지 등록·열람' },
  { id: 'settings',        label: '설정',                    tabId: 'settings',       group: '관리',     company: 'both',    desc: 'SMTP·명함 등 시스템 설정' },
  { id: 'admin',           label: '사용자 관리',             tabId: 'admin',          group: '관리',     company: 'both',    desc: '직원 계정·권한 관리' },
  { id: 'workspace',       label: '워크스페이스',            tabId: 'workspace',      group: '공용',     company: 'both',    defaultOnly: true, desc: '개인 메모·문서 작업공간' },
  { id: 'ai',              label: 'AI 챗',                   tabId: 'ai',             group: '공용',     company: 'both',    alwaysOn: true,    desc: 'AI 비서 채팅' },
  { id: 'aiImages',        label: 'AI 이미지',               tabId: 'aiImages',       group: '공용',     company: 'both',    alwaysOn: true,    desc: '생성한 AI 이미지 저장소' },
  { id: 'gpsAttendance',   label: 'GPS 출퇴근',              tabId: 'gpsAttendance',  group: '인사',     company: 'both',    defaultOnly: true, desc: 'GPS 기반 출퇴근 체크' },
];

const ROLE_PRESETS = [
  { id: 'sales',      label: '영업',      icon: 'businessplan',     perms: ['pricing_view', 'stats', 'esmPurchase'] },
  { id: 'designer',   label: '디자이너',  icon: 'palette',          perms: ['calendar'] },
  { id: 'factory',    label: '공장',      icon: 'building-factory',  perms: ['companyPurchase', 'calendar'] },
  { id: 'accounting', label: '경리',      icon: 'calculator',       perms: ['pricing_view', 'stats', 'esmPurchase', 'companyPurchase', 'approval', 'leave'] },
  { id: 'manager',    label: '관리',      icon: 'shield-lock',      perms: ['admin', 'orgchart', 'notices', 'settings', 'attendance_all', 'approval', 'leave'] },
  { id: 'mgmtTeam',   label: '경영관리팀', icon: 'clipboard-check',  perms: ['pickup_view', 'pickup_register'] },
  { id: 'deliveryTeam', label: '납품팀',   icon: 'truck-delivery',   perms: ['pickup_view', 'pickup_check'] },
];

// ─────────────────────────────────────────────────────────────────────────────
// OLD: 구버전 get tabs() 로직을 그대로 복제 (정답)
//   index.html (리팩터 전) 6547-6597 줄과 동일. allMenus 원본 순서/splice/치환 포함.
// ─────────────────────────────────────────────────────────────────────────────
const OLD_ALL_MENUS = [
  { id: 'home', label: '홈' },
  { id: 'quote', label: '견적 작성' },
  { id: 'history', label: '견적 목록' },
  { id: 'stats', label: '통계' },
  { id: 'pricing_view', label: '단가 조회' },
  { id: 'pricing_edit', label: '단가 수정' },
  { id: 'salesLookup', label: '과거단가조회' },
  { id: 'attendance_all', label: '출퇴근 기록부 (팀 전체)' },
  { id: 'leave', label: '연차 관리' },
  { id: 'options', label: '옵션 관리' },
  { id: 'vendors', label: '업체 관리' },
  { id: 'pickup_view', label: '픽업 조회' },
  { id: 'pickup_register', label: '픽업 등록' },
  { id: 'pickup_check', label: '픽업 체크' },
  { id: 'design', label: '시안 검색' },
  { id: 'photos', label: '사진 라이브러리' },
  { id: 'esmPurchase', label: '에스엠 매입' },
  { id: 'companyPurchase', label: '컴퍼니 매입' },
  { id: 'contacts', label: '연락처' },
  { id: 'workflow', label: '워크플로우' },
  { id: 'calendar', label: '캘린더' },
  { id: 'approval', label: '결재' },
  { id: 'orgchart', label: '조직도' },
  { id: 'notices', label: '공지사항' },
  { id: 'settings', label: '설정' },
  { id: 'admin', label: '사용자 관리' },
  { id: 'workspace', label: '워크스페이스' },
  { id: 'ai', label: 'AI 챗' },
  { id: 'aiImages', label: 'AI 이미지' },
  { id: 'gpsAttendance', label: 'GPS 출퇴근' },
];

function oldTabs(ctx) {
  if (ctx.auth.role === 'admin') {
    const adminTabs = [
      { id: 'home', label: '홈' },
      { id: 'quote', label: '견적 작성' }, { id: 'history', label: '견적 목록' },
      { id: 'pricing', label: '품목 관리' }, { id: 'options', label: '옵션 관리' },
      { id: 'vendors', label: '업체 관리' }, { id: 'pickup', label: '픽업 관리' }, { id: 'admin', label: '사용자 관리' },
      { id: 'attendance', label: '출퇴근 기록부' }, { id: 'leave', label: '연차 관리' },
      { id: 'approval', label: '결재' }, { id: 'orgchart', label: '조직도' },
      { id: 'salesLookup', label: '과거단가조회' },
      { id: 'stats', label: '통계' }, { id: 'design', label: '시안 검색' },
      { id: 'photos', label: '사진 라이브러리' },
      { id: 'esmPurchase', label: '에스엠 매입' },
      { id: 'companyPurchase', label: '컴퍼니 매입' },
      { id: 'contacts', label: '연락처' }, { id: 'workflow', label: '워크플로우' }, { id: 'calendar', label: '캘린더' }, { id: 'notices', label: '공지사항' }, { id: 'settings', label: '설정' },
      { id: 'workspace', label: '워크스페이스' },
      { id: 'ai', label: 'AI 챗' },
      { id: 'aiImages', label: 'AI 이미지' },
      { id: 'gpsAttendance', label: 'GPS 출퇴근' }
    ];
    return adminTabs;
  }
  const perms = ctx.auth.permissions || [];
  const universalMenus = ['design', 'photos', 'contacts', 'workflow', 'ai', 'aiImages'];  // 'ai' 추가: AI 챗 전 직원 공용(2026-06-25) / 'aiImages' 추가: AI 이미지 저장소 공용
  const defaultMenus = ['home', 'quote', 'history', 'salesLookup', 'workspace', 'gpsAttendance', ...universalMenus];
  const allowed = perms.length > 0
    ? ['home', ...perms, ...universalMenus]
    : defaultMenus;
  const t = [];
  const hasPricing = allowed.includes('pricing_view') || allowed.includes('pricing_edit');
  const hasPickup = allowed.includes('pickup_view');
  for (const menu of OLD_ALL_MENUS) {
    if (menu.id === 'pricing_view' || menu.id === 'pricing_edit') continue;
    if (menu.id === 'pickup_view' || menu.id === 'pickup_register' || menu.id === 'pickup_check') continue;
    if (allowed.includes(menu.id)) t.push(menu);
  }
  if (hasPricing) t.splice(2, 0, { id: 'pricing', label: '품목 관리' });
  if (hasPickup && !t.find(m => m.id === 'pickup')) t.push({ id: 'pickup', label: '픽업 관리' });
  if (!t.find(m => m.id === 'attendance_all')) {
    t.push({ id: 'attendance', label: '출퇴근 기록부' });
  } else {
    const idx = t.findIndex(m => m.id === 'attendance_all');
    if (idx >= 0) t[idx].id = 'attendance';
  }
  if (!t.find(m => m.id === 'leave')) t.push({ id: 'leave', label: '연차 관리' });
  if (!t.find(m => m.id === 'approval')) t.push({ id: 'approval', label: '결재' });
  return t;
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW: 카탈로그(enrich된 ALL_MENUS) 구동 — index.html get tabs() 본문과 글자 그대로 동일해야 함.
//   (this. -> ctx. / this.allMenus -> ALL_MENUS 치환만 차이)
// ─────────────────────────────────────────────────────────────────────────────
function newTabs(ctx) {
  // 단일 카탈로그(allMenus) 구동 — 합쳐진 탭은 tabId 로 dedup, 라벨은 mergedTabLabel 로.
  const mergedTabLabel = { pricing: '품목 관리', attendance: '출퇴근 기록부' };
  const labelOf = (m) => mergedTabLabel[m.tabId] || m.label;
  const isAdmin = ctx.auth.role === 'admin';

  if (isAdmin) {
    // 관리자: 카탈로그의 모든 tabId 를 중복제거해 노출 (forcedNonAdmin 은 비admin 전용 플래그라 무시)
    const out = [];
    const seen = new Set();
    for (const m of ALL_MENUS) {
      if (seen.has(m.tabId)) continue;
      seen.add(m.tabId);
      out.push({ id: m.tabId, label: labelOf(m) });
    }
    return out;
  }

  const perms = ctx.auth.permissions || [];
  const hasPerms = perms.length > 0;
  // 노출 판정: 권한키(menu.id) 가 노출되는가?
  const idShown = (m) => {
    if (m.alwaysOn) return true;                 // 공용 (design/photos/contacts/workflow/home)
    if (perms.includes(m.id)) return true;        // 명시적으로 부여된 권한
    if (!hasPerms && m.defaultOnly) return true;  // 권한 0개일 때만 노출되는 기본 메뉴
    return false;
  };

  const out = [];
  const seenTab = new Set();
  for (const m of ALL_MENUS) {
    // segmentGroup(pricing) 은 pricing_view/edit 중 하나라도 부여되면 합친 'pricing' 탭 1개
    if (m.segmentGroup === 'pricing') {
      const hasPricing = perms.includes('pricing_view') || perms.includes('pricing_edit');
      if (hasPricing && !seenTab.has(m.tabId)) { seenTab.add(m.tabId); out.push({ id: m.tabId, label: labelOf(m) }); }
      continue;
    }
    // segmentGroup(pickup) 은 pickup_view 보유 시에만 'pickup' 탭 노출 (register/check 는 capability 전용)
    if (m.segmentGroup === 'pickup') {
      const hasPickup = perms.includes('pickup_view');
      if (hasPickup && !seenTab.has(m.tabId)) { seenTab.add(m.tabId); out.push({ id: m.tabId, label: labelOf(m) }); }
      continue;
    }
    // forcedNonAdmin: 비admin 은 권한 유무와 무관하게 해당 tabId 항상 노출 (capability 는 데이터 범위용)
    if (m.forcedNonAdmin) {
      if (!seenTab.has(m.tabId)) { seenTab.add(m.tabId); out.push({ id: m.tabId, label: labelOf(m) }); }
      continue;
    }
    if (idShown(m) && !seenTab.has(m.tabId)) { seenTab.add(m.tabId); out.push({ id: m.tabId, label: labelOf(m) }); }
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// 동치성 검증: 탭 id 집합(정렬) 비교
// ─────────────────────────────────────────────────────────────────────────────
function idSet(tabs) {
  return [...new Set(tabs.map(t => t.id))].sort();
}
function eqSets(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

const ALL_PERM_KEYS = ALL_MENUS.map(m => m.id);

// 조합 생성
const combos = [];
combos.push({ name: 'admin (perms 무관)', role: 'admin', perms: [] });
combos.push({ name: 'admin (perms 가득)', role: 'admin', perms: ALL_PERM_KEYS.slice() });
combos.push({ name: 'user perms=[]', role: 'user', perms: [] });
// 모든 단일 권한키
for (const k of ALL_PERM_KEYS) combos.push({ name: `user [${k}]`, role: 'user', perms: [k] });
// ROLE_PRESETS 5개
for (const p of ROLE_PRESETS) combos.push({ name: `preset:${p.id}`, role: 'user', perms: p.perms.slice() });
// 의미있는 페어/세트
combos.push({ name: 'user [pricing_view]', role: 'user', perms: ['pricing_view'] });
combos.push({ name: 'user [pricing_edit]', role: 'user', perms: ['pricing_edit'] });
combos.push({ name: 'user [pricing_view,pricing_edit]', role: 'user', perms: ['pricing_view', 'pricing_edit'] });
combos.push({ name: 'user [attendance_all]', role: 'user', perms: ['attendance_all'] });
combos.push({ name: 'user [stats,options]', role: 'user', perms: ['stats', 'options'] });
combos.push({ name: 'user [esmPurchase,companyPurchase]', role: 'user', perms: ['esmPurchase', 'companyPurchase'] });
combos.push({ name: 'user [leave,approval,orgchart]', role: 'user', perms: ['leave', 'approval', 'orgchart'] });
combos.push({ name: 'user [admin,settings,notices,vendors,calendar]', role: 'user', perms: ['admin', 'settings', 'notices', 'vendors', 'calendar'] });

let failures = 0;
for (const c of combos) {
  const ctx = { auth: { role: c.role, permissions: c.perms } };
  const oldSet = idSet(oldTabs(ctx));
  const newSet = idSet(newTabs(ctx));
  if (!eqSets(oldSet, newSet)) {
    failures++;
    const onlyOld = oldSet.filter(x => !newSet.includes(x));
    const onlyNew = newSet.filter(x => !oldSet.includes(x));
    console.error(`\n✗ MISMATCH — ${c.name}`);
    console.error(`   perms: [${c.perms.join(', ')}]`);
    console.error(`   old : ${oldSet.join(', ')}`);
    console.error(`   new : ${newSet.join(', ')}`);
    if (onlyOld.length) console.error(`   old 에만 있음: ${onlyOld.join(', ')}`);
    if (onlyNew.length) console.error(`   new 에만 있음: ${onlyNew.join(', ')}`);
  }
}

if (failures > 0) {
  console.error(`\nEQUIVALENCE FAILED — ${failures}/${combos.length} combos mismatched`);
  process.exit(1);
}
console.log(`EQUIVALENCE OK — ${combos.length} combos`);
process.exit(0);
