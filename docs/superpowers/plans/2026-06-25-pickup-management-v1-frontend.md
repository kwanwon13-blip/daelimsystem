# 픽업관리 v1 — 프론트엔드 구현 플랜 (B)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 픽업관리 탭(등록 뷰 + 취합·체크 뷰)을 SPA에 붙이고, 권한·메뉴 노출, 업체 모달 신규필드, 워크플로 "픽업에 추가" 버튼까지 배선해 백엔드(`/api/pickup`)를 실제로 쓸 수 있게 만든다. (백엔드 API는 플랜 A에서 완성, 본 플랜은 변경하지 않음.)

**Architecture:** 픽업 탭은 `tab-options.html`/`tab-pricing.html`과 동일하게 **별도 `x-data` 없이** SSI INCLUDE 되어 `function app()` 스코프를 그대로 쓴다(연락처처럼 독립 컴포넌트가 아님). 상태/메서드는 `index.html`의 `app()`에 추가하고, 모든 데이터는 기존 `fetch('/api/pickup/...')` 호출로 가져온다. 워크플로 탭은 **별도 Alpine 루트(`workflowApp()`)**라 직접 `currentTab`을 못 건드리므로, 이미 검증된 이벤트 브리지 패턴(`openStatementEntry` → `window.__statementEntry` + `CustomEvent('statement-entry')` → `statements.js`의 `window.addEventListener`)을 그대로 복제해 `window.__pickupFromJob` + `CustomEvent('pickup-from-job')`로 `app()`에 전달한다.

**Tech Stack:** Alpine.js v3(CDN, 기존), 서버사이드 인클루드(SSI, `server.js`가 `<!--INCLUDE:파일명.html-->` 치환), `fetch`, `navigator.clipboard`. 새 라이브러리 없음.

**참조 스펙:** `docs/superpowers/specs/2026-06-25-pickup-management-design.md` (§7 화면, §7.3 워크플로 버튼, §9 권한) · **참조 플랜 A(백엔드):** `docs/superpowers/plans/2026-06-25-pickup-management-v1-backend.md` (API 시그니처)

---

## 정찰로 확정한 좌표 (구현 전 필독)

> 줄번호는 정찰 시점 기준. 실제 편집 전 **앵커 문자열로 재확인**(파일이 그동안 바뀌었을 수 있음). 각 Step은 앵커 문자열을 같이 제시한다.

| 대상 | 파일 | 위치(대략) | 앵커 |
|------|------|-----------|------|
| `allMenus` 배열 | `public/index.html` | 6487~6519 | `allMenus: [` / `{ id: 'gpsAttendance', label: 'GPS 출퇴근' }` |
| `menuGroups` '관리' 그룹 | `public/index.html` | 6581~6585 | `{ id: 'vendors', label: '업체 관리', icon: 'storefront' },` |
| `get tabs()` admin 분기 | `public/index.html` | 6619~6645 | `{ id: 'vendors', label: '업체 관리' }, { id: 'admin', label: '사용자 관리' },` |
| `get tabs()` 일반 분기 | `public/index.html` | 6647~6671 | `for (const menu of this.allMenus) {` |
| 업체 모달 마크업 | `public/index.html` | 1558~1588 | `<textarea x-model="vendorPopup.form.note"` |
| `vendorPopup` state | `public/index.html` | 7098 | `vendorPopup: { open: false,` |
| `openVendorPopup` / `saveVendorPopup` | `public/index.html` | 8849~8877 | `openVendorPopup(v) {` |
| SSI INCLUDE 지점(워크플로 뒤) | `public/index.html` | 5427~5429 | `<template x-if="currentTab === 'workflow'">` ... `</template>` |
| `app().init()` (이벤트 리스너 등록처) | `public/index.html` | 7566 | `async init() {` |
| 워크플로 상세 헤더 액션행 | `public/tab-workflow.html` | 525~530 | `x-text="detailMoreOpen ? '상세 접기' : '상세'"></button>` |
| 권한 프리셋 저장 API(관리자 UI에서 사용) | `routes/admin.js` | 372 | `POST /api/admin/perm-presets` |
| 지도 딥링크 참고(모바일) | `public/contacts-mobile.html` | 687 | `async function openMap(q, route)` |

**픽업 신규 권한 코드(전 Task 공통):** `pickup_view`(조회) · `pickup_register`(등록·수정·취소) · `pickup_check`(라인체크). 상태/우선순위 코드값은 플랜 A와 동일: item.status `requested|pickedUp|notPicked|cancelled`, priority `normal|urgent|todayMust`, sourceType `manual|workflow`.

---

## Task 1: 권한 · 메뉴 노출 (`public/index.html`)

**Files:**
- Modify: `public/index.html` (`allMenus` 6487~6519, `menuGroups` 6581~6585, `get tabs()` 6619~6671)

탭 노출은 `pickup_view` 보유 시. ROLE_PRESETS(경영관리팀/납품팀)는 이 코드베이스에서 **하드코딩 상수가 아니라 관리자 화면에서 `POST /api/admin/perm-presets`로 저장하는 명명 프리셋**이다(정찰: `routes/admin.js:372`, 저장소 `설정.json.permPresets`). 따라서 Step 4에서 **`permPresets` 기본 시드를 클라이언트에 추가**해, 서버에 프리셋이 비어 있으면 관리자 권한 UI에서 경영관리팀/납품팀을 한 번에 적용할 수 있게 한다.

- [ ] **Step 1: `allMenus`에 픽업 권한 3개 추가**

`public/index.html`에서 아래 라인(6518)을 찾는다:

```javascript
      { id: 'gpsAttendance', label: 'GPS 출퇴근' }
    ],
```

`{ id: 'gpsAttendance', label: 'GPS 출퇴근' }` 뒤에 콤마를 붙이고 픽업 3개를 추가한다:

```javascript
      { id: 'gpsAttendance', label: 'GPS 출퇴근' },
      { id: 'pickup_view', label: '픽업 조회' },
      { id: 'pickup_register', label: '픽업 등록' },
      { id: 'pickup_check', label: '픽업 체크' }
    ],
```

> `allMenus`는 권한 설정 체크박스 목록(3438/3506 `x-for="menu in allMenus"`)의 소스이므로, 이 3줄이 그대로 관리자 권한 UI에 픽업 권한 3개로 노출된다.

- [ ] **Step 2: `menuGroups` '관리' 그룹에 픽업 탭 추가**

`public/index.html`에서 '관리' 그룹의 vendors 라인(6584)을 찾는다:

```javascript
      { group: '관리', icon: 'inventory_2', items: [
        { id: 'pricing', label: '품목 관리', icon: 'payments' },
        { id: 'options', label: '옵션 관리', icon: 'tune' },
        { id: 'vendors', label: '업체 관리', icon: 'storefront' },
      ]},
```

vendors 다음 줄에 픽업을 추가한다:

```javascript
      { group: '관리', icon: 'inventory_2', items: [
        { id: 'pricing', label: '품목 관리', icon: 'payments' },
        { id: 'options', label: '옵션 관리', icon: 'tune' },
        { id: 'vendors', label: '업체 관리', icon: 'storefront' },
        { id: 'pickup', label: '픽업 관리', icon: 'local_shipping' },
      ]},
```

> `menuGroups`의 `id`는 **탭 id**(`pickup`)이지 권한 id가 아니다. `filteredMenuGroups`(6673)가 `this.tabs.map(t => t.id)`로 거른다 → Step 3에서 `get tabs()`가 `pickup`을 내보내야 사이드바에 보인다.

- [ ] **Step 3: `get tabs()`에 pickup 노출 — admin 분기와 일반 분기 둘 다**

(3-a) admin 분기: `public/index.html` 6624 라인을 찾는다:

```javascript
          { id: 'vendors', label: '업체 관리' }, { id: 'admin', label: '사용자 관리' },
```

이 줄의 `{ id: 'vendors', label: '업체 관리' },` 와 `{ id: 'admin', ... }` 사이에 픽업을 끼운다(같은 줄 그대로 교체):

```javascript
          { id: 'vendors', label: '업체 관리' }, { id: 'pickup', label: '픽업 관리' }, { id: 'admin', label: '사용자 관리' },
```

(3-b) 일반(비admin) 분기: `public/index.html` 6655~6660의 루프 직후를 찾는다:

```javascript
      const hasPricing = allowed.includes('pricing_view') || allowed.includes('pricing_edit');
      for (const menu of this.allMenus) {
        if (menu.id === 'pricing_view' || menu.id === 'pricing_edit') continue;
        if (allowed.includes(menu.id)) t.push(menu);
      }
      if (hasPricing) t.splice(2, 0, { id: 'pricing', label: '품목 관리' });
```

이 블록을 아래로 교체한다(pricing_*처럼 pickup_* 권한 id는 탭 목록에서 제외하고, `pickup_view` 보유 시 `pickup` 탭을 별도로 push):

```javascript
      const hasPricing = allowed.includes('pricing_view') || allowed.includes('pricing_edit');
      const hasPickup = allowed.includes('pickup_view');
      for (const menu of this.allMenus) {
        if (menu.id === 'pricing_view' || menu.id === 'pricing_edit') continue;
        if (menu.id === 'pickup_view' || menu.id === 'pickup_register' || menu.id === 'pickup_check') continue;
        if (allowed.includes(menu.id)) t.push(menu);
      }
      if (hasPricing) t.splice(2, 0, { id: 'pricing', label: '품목 관리' });
      if (hasPickup && !t.find(m => m.id === 'pickup')) t.push({ id: 'pickup', label: '픽업 관리' });
```

> 이유: `allMenus`엔 권한 id(`pickup_view` 등)가 들어 있지만 **탭 id는 `pickup`** 하나다. pricing과 똑같이 권한 id는 루프에서 걸러내고 탭 한 개를 따로 push해야 사이드바·메뉴그룹과 id가 일치한다.

- [ ] **Step 4: ROLE_PRESETS 기본 시드 추가 (경영관리팀 / 납품팀)**

`public/index.html`에서 `permPresets` 선언(6521)을 찾는다:

```javascript
    // 권한 그룹 프리셋 (서버에서 로드)
    permPresets: [],
```

이를 아래로 교체한다(서버 로드 전/비어있을 때 쓸 기본 프리셋 시드 + 머지 헬퍼 추가):

```javascript
    // 권한 그룹 프리셋 (서버에서 로드). 서버가 비어있으면 아래 기본 프리셋을 합쳐 노출
    permPresets: [],
    pickupRolePresetSeed: [
      { name: '경영관리팀', perms: ['pickup_view', 'pickup_register'] },
      { name: '납품팀', perms: ['pickup_view', 'pickup_check'] },
    ],
    get effectivePermPresets() {
      const byName = new Map((this.permPresets || []).map(p => [p.name, p]));
      const merged = [...(this.permPresets || [])];
      for (const seed of this.pickupRolePresetSeed) {
        if (!byName.has(seed.name)) merged.push(seed);
      }
      return merged;
    },
```

> 관리자 권한 UI가 `permPresets`를 직접 쓰고 있으면, 그 바인딩을 `effectivePermPresets`로 바꾸면 경영관리팀/납품팀이 항상 보인다. (UI 바인딩 변경은 선택 — 최소 변경으로 시드만 노출시키려면 관리자 권한 패널의 `x-for="preset in permPresets"`를 `x-for="preset in effectivePermPresets"`로 1곳 교체.) `pickupRolePresetSeed`는 admin이 전부 보유하므로 admin엔 영향 없음.

- [ ] **Step 5: 모듈 로드 점검 + 커밋**

`index.html`은 require로 못 켜므로(서버가 listen) **문법만** 점검한다. 서버를 켤 필요 없이 Node로 JS 블록만 빠르게 검증하려면, 변경한 객체 리터럴이 유효한지 브라우저 콘솔(로컬 ERP 접속)에서 `app().allMenus.length`, `app().effectivePermPresets`를 확인하거나, 최소한 편집 후 에디터의 괄호/콤마 매칭으로 확인한다.

Run: 로컬 ERP를 이미 띄워둔 상태라면 브라우저 콘솔에서 확인:
```javascript
// Alpine 컴포넌트 인스턴스에서
$el.closest('[x-data]')._x_dataStack // 무시 — 대신 화면에서 사이드바 '관리 > 픽업 관리' 표시 확인
```
Expected: admin 계정으로 사이드바 '관리' 그룹에 **픽업 관리**가 보임. (서버 재시작은 사용자 몫 — 하지 말 것.)

```bash
git add public/index.html
git commit -m "feat(pickup): 픽업 권한 3개(allMenus)+탭 노출(getTabs)+관리 메뉴그룹+ROLE_PRESETS 시드(경영관리팀/납품팀)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: `tab-pickup.html` 생성 + `app()` 배선

**Files:**
- Create: `public/tab-pickup.html`
- Modify: `public/index.html` (SSI INCLUDE 1줄 추가 5429 근처, `app()`에 픽업 state/method 추가 7098 근처, `init()`에 이벤트 리스너 7566)

픽업 탭은 **별도 `x-data` 없이** SSI INCLUDE되어 `app()` 스코프를 그대로 쓴다(tab-pricing/tab-options와 동일). 서브탭 2개: 등록(register) / 취합·체크(collect).

- [ ] **Step 1: `public/tab-pickup.html` 생성** — 전체 마크업

```html
<div class="space-y-3 fade-in">
  <!-- 헤더 + 서브탭 전환 -->
  <div class="card" style="padding:0;overflow:hidden;">
    <div style="padding:14px 22px;background:linear-gradient(135deg,#eff6ff,#dbeafe);border-bottom:1px solid #bfdbfe;">
      <h3 class="font-work text-[13px] font-bold text-gray-800 flex items-center gap-2 m-0">
        <span class="material-symbols-outlined" style="font-size:16px;color:#2563eb;">local_shipping</span> 픽업 관리
      </h3>
    </div>
    <div style="padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
      <button class="btn-sm" :class="pickupView === 'register' ? 'btn-primary' : 'btn-ghost'" @click="pickupView = 'register'; loadPickupMine()">
        <span class="material-symbols-outlined" style="font-size:14px;">edit_note</span> 등록
      </button>
      <button class="btn-sm" :class="pickupView === 'collect' ? 'btn-primary' : 'btn-ghost'" @click="pickupView = 'collect'; loadPickupRequests()">
        <span class="material-symbols-outlined" style="font-size:14px;">checklist</span> 취합·체크
      </button>
      <div style="margin-left:auto;display:flex;align-items:center;gap:6px;">
        <label class="label-base m-0">픽업 날짜</label>
        <input type="date" x-model="pickupDate" @change="pickupView === 'collect' ? loadPickupRequests() : loadPickupMine()" class="input-base" style="width:160px;">
      </div>
    </div>
  </div>

  <!-- ════════ Ⓐ 등록 뷰 ════════ -->
  <template x-if="pickupView === 'register'">
    <div class="space-y-3">
      <!-- 카톡 붙여넣기 -->
      <div class="card" style="padding:0;overflow:hidden;">
        <div style="padding:10px 14px;background:#fef9c3;border-bottom:1px solid #fde68a;">
          <h3 class="font-work text-[12px] font-bold text-gray-800 flex items-center gap-2 m-0">
            <span class="material-symbols-outlined" style="font-size:15px;color:#ca8a04;">content_paste</span> 카톡 붙여넣기 → 후보 자동 분리
          </h3>
        </div>
        <div style="padding:12px 14px;" class="space-y-2">
          <textarea x-model="pickupKakaoText" class="input-base" rows="4" style="resize:vertical;"
            placeholder="#라코스&#10;현수막 600x900 3개&#10;배너 2장&#10;#세원계측기&#10;압력계 1"></textarea>
          <div class="flex gap-2">
            <button class="btn-secondary btn-sm" @click="parsePickupKakao()" :disabled="pickupParsing">
              <span class="material-symbols-outlined" style="font-size:14px;">auto_fix_high</span>
              <span x-text="pickupParsing ? '분석 중...' : '후보 만들기'"></span>
            </button>
            <button class="btn-ghost btn-sm" x-show="pickupKakaoCandidates.length" @click="pickupKakaoCandidates=[]">지우기</button>
          </div>
          <!-- 파싱 후보 카드들 -->
          <template x-for="(cand, ci) in pickupKakaoCandidates" :key="'cand'+ci">
            <div class="card" style="padding:10px 12px;border:1px solid #e5e7eb;">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="material-symbols-outlined" style="font-size:14px;color:#6b7280;">store</span>
                <select x-model="cand.vendorId" class="input-base" style="width:200px;">
                  <option value="">업체 선택 (추정: <span x-text="cand.vendorGuess"></span>)</option>
                  <template x-for="v in activePickupVendors" :key="v.id">
                    <option :value="v.id" x-text="v.name"></option>
                  </template>
                </select>
                <span class="text-xs text-gray-500" x-text="'추정: ' + (cand.vendorGuess || '없음')"></span>
                <button class="btn-ghost btn-sm" style="margin-left:auto;" @click="pickupKakaoCandidates.splice(ci,1)">제외</button>
              </div>
              <div style="margin-top:8px;" class="space-y-1">
                <template x-for="(it, ii) in cand.items" :key="'ci'+ci+'it'+ii">
                  <div class="flex gap-1 items-center">
                    <input x-model="it.itemName" class="input-base" style="flex:2;" placeholder="품목">
                    <input x-model="it.spec" class="input-base" style="flex:1;" placeholder="규격">
                    <input x-model.number="it.qty" type="number" class="input-base" style="width:64px;" placeholder="수량">
                    <input x-model="it.unit" class="input-base" style="width:56px;" placeholder="단위">
                    <button class="btn-ghost btn-sm" @click="cand.items.splice(ii,1)">×</button>
                  </div>
                </template>
              </div>
            </div>
          </template>
          <button class="btn-primary btn-sm" x-show="pickupKakaoCandidates.length" @click="savePickupCandidates()" :disabled="pickupSaving">
            <span class="material-symbols-outlined" style="font-size:14px;">save</span>
            <span x-text="pickupSaving ? '저장 중...' : '후보 일괄 저장 (' + pickupKakaoCandidates.filter(c=>c.vendorId).length + '건)'"></span>
          </button>
        </div>
      </div>

      <!-- 정식 등록 폼 -->
      <div class="card" style="padding:0;overflow:hidden;">
        <div style="padding:10px 14px;background:linear-gradient(135deg,#eff6ff,#dbeafe);border-bottom:1px solid #bfdbfe;">
          <h3 class="font-work text-[12px] font-bold text-gray-800 flex items-center gap-2 m-0">
            <span class="material-symbols-outlined" style="font-size:15px;color:#2563eb;">add_box</span> 픽업 요청 등록
          </h3>
        </div>
        <div style="padding:12px 14px;" class="space-y-3">
          <div class="grid grid-cols-2 gap-3">
            <div>
              <label class="label-base">업체 <span style="color:#ef4444;">*</span></label>
              <select x-model="pickupForm.vendorId" @change="onPickupVendorChange()" class="input-base">
                <option value="">업체 선택</option>
                <template x-for="v in activePickupVendors" :key="v.id">
                  <option :value="v.id" x-text="v.name"></option>
                </template>
              </select>
            </div>
            <div>
              <label class="label-base">픽업 날짜 <span style="color:#ef4444;">*</span></label>
              <input type="date" x-model="pickupForm.pickupDate" class="input-base">
            </div>
            <div>
              <label class="label-base">희망 시간대</label>
              <input x-model="pickupForm.preferredTimeSlot" class="input-base" placeholder="오전 / 오후 / 15시 전 등">
            </div>
            <div>
              <label class="label-base">우선순위</label>
              <select x-model="pickupForm.priority" class="input-base">
                <option value="normal">보통</option>
                <option value="urgent">긴급</option>
                <option value="todayMust">오늘 필수</option>
              </select>
            </div>
          </div>
          <!-- 업체 자동 미리보기 -->
          <template x-if="pickupVendorPreview">
            <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;padding:8px 10px;font-size:12px;color:#475569;" class="space-y-0.5">
              <div x-show="pickupVendorPreview.address"><span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px;">place</span> <span x-text="pickupVendorPreview.address"></span></div>
              <div x-show="pickupVendorPreview.phone || pickupVendorPreview.contactPhone"><span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px;">call</span> <span x-text="[pickupVendorPreview.contactPerson, pickupVendorPreview.contactPhone || pickupVendorPreview.phone].filter(Boolean).join(' ')"></span></div>
              <div x-show="pickupVendorPreview.pickupMemo" style="color:#b45309;"><span class="material-symbols-outlined" style="font-size:13px;vertical-align:-2px;">sticky_note_2</span> <span x-text="pickupVendorPreview.pickupMemo"></span></div>
            </div>
          </template>
          <!-- 품목 줄 -->
          <div>
            <label class="label-base">품목</label>
            <div class="space-y-1">
              <template x-for="(it, i) in pickupForm.items" :key="'fi'+i">
                <div class="flex gap-1 items-center">
                  <input x-model="it.itemName" class="input-base" style="flex:2;" placeholder="품목명">
                  <input x-model="it.spec" class="input-base" style="flex:1;" placeholder="규격">
                  <input x-model.number="it.qty" type="number" class="input-base" style="width:72px;" placeholder="수량">
                  <input x-model="it.unit" class="input-base" style="width:60px;" placeholder="단위">
                  <button class="btn-ghost btn-sm" @click="removePickupItemRow(i)" x-show="pickupForm.items.length > 1">×</button>
                </div>
              </template>
            </div>
            <button class="btn-ghost btn-sm" style="margin-top:4px;" @click="addPickupItemRow()">+ 품목 줄 추가</button>
          </div>
          <div>
            <label class="label-base">메모</label>
            <input x-model="pickupForm.memo" class="input-base" placeholder="바로 공장 / 시안 / 현장명 등">
          </div>
          <div class="flex gap-2">
            <button class="btn-primary btn-sm" @click="submitPickupForm()" :disabled="pickupSaving">
              <span class="material-symbols-outlined" style="font-size:14px;">save</span>
              <span x-text="pickupSaving ? '저장 중...' : '요청 등록'"></span>
            </button>
            <button class="btn-ghost btn-sm" @click="resetPickupForm()">초기화</button>
          </div>
        </div>
      </div>

      <!-- 내가 오늘 올린 것 -->
      <div class="card" style="padding:0;overflow:hidden;">
        <div style="padding:10px 14px;background:#f9fafb;border-bottom:1px solid #e5e7eb;">
          <h3 class="font-work text-[12px] font-bold text-gray-800 flex items-center gap-2 m-0">
            <span class="material-symbols-outlined" style="font-size:15px;color:#6b7280;">history</span> 내가 등록한 요청 (<span x-text="pickupDate"></span>)
          </h3>
        </div>
        <div style="padding:10px 14px;" class="space-y-2">
          <div x-show="!pickupMine.length" class="text-xs text-gray-400">등록한 요청이 없습니다.</div>
          <template x-for="req in pickupMine" :key="req.id">
            <div class="card" style="padding:8px 10px;border:1px solid #e5e7eb;">
              <div class="flex items-center gap-2 flex-wrap">
                <span class="font-semibold text-sm" x-text="req.vendorName"></span>
                <span class="text-xs px-2 py-0.5 rounded-full" :style="pickupStatusStyle(req.status)" x-text="pickupStatusLabel(req.status)"></span>
                <span class="text-xs text-gray-400" x-show="req.isLate" style="color:#dc2626;">🔴 추가요청</span>
                <button class="btn-ghost btn-sm" style="margin-left:auto;" x-show="req.status==='requested'" @click="cancelPickupRequest(req.id)">취소</button>
              </div>
              <div class="text-xs text-gray-500" style="margin-top:3px;" x-text="(req.items||[]).map(it => it.itemName + (it.spec?(' '+it.spec):'') + (it.qty?(' '+it.qty+(it.unit||'')):'')).join(', ')"></div>
            </div>
          </template>
        </div>
      </div>
    </div>
  </template>

  <!-- ════════ Ⓑ 취합·체크 뷰 ════════ -->
  <template x-if="pickupView === 'collect'">
    <div class="space-y-3">
      <div class="card" style="padding:10px 14px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <span class="text-xs text-gray-500" x-text="pickupGroups.length + '개 업체 · 요청 ' + pickupRequests.length + '건'"></span>
        <button class="btn-secondary btn-sm" style="margin-left:auto;" @click="copyPickupShareText()">
          <span class="material-symbols-outlined" style="font-size:14px;">share</span> 카톡 공유텍스트 복사
        </button>
      </div>

      <div x-show="!pickupGroups.length" class="card" style="padding:24px;text-align:center;color:#9ca3af;font-size:13px;">
        해당 날짜에 픽업 요청이 없습니다.
      </div>

      <!-- 업체 카드 -->
      <template x-for="g in pickupGroups" :key="g.vendorId">
        <div class="card" style="padding:0;overflow:hidden;">
          <!-- 카드 헤더 -->
          <div style="padding:10px 14px;background:linear-gradient(135deg,#f0fdf4,#dcfce7);border-bottom:1px solid #bbf7d0;">
            <div class="flex items-center gap-2 flex-wrap">
              <span class="material-symbols-outlined" style="font-size:16px;color:#16a34a;">store</span>
              <span class="font-bold text-sm" x-text="g.vendorName || '미지정'"></span>
              <span class="text-xs px-2 py-0.5 rounded-full" :style="pickupStatusStyle(pickupGroupRollup(g).status)" x-text="pickupGroupRollup(g).label"></span>
              <span class="text-xs" x-show="pickupGroupHasLate(g)" style="color:#dc2626;font-weight:600;">🔴 추가요청</span>
              <span class="text-xs" x-show="pickupGroupHasWorkflow(g)" style="color:#7c3aed;font-weight:600;">🎨 시안</span>
            </div>
            <div class="text-xs text-gray-500" style="margin-top:3px;" x-show="pickupGroupVendor(g)">
              <span x-show="pickupGroupVendor(g).address" x-text="pickupGroupVendor(g).address"></span>
              <span x-show="pickupGroupVendor(g).phone || pickupGroupVendor(g).contactPhone"> · <span x-text="pickupGroupVendor(g).contactPhone || pickupGroupVendor(g).phone"></span></span>
            </div>
            <div x-show="pickupGroupVendor(g) && (pickupGroupVendor(g).pickupMemo || pickupGroupVendor(g).parkingAccessMemo)" class="text-xs" style="margin-top:3px;color:#b45309;">
              <span x-show="pickupGroupVendor(g).pickupMemo" x-text="'📦 ' + pickupGroupVendor(g).pickupMemo"></span>
              <span x-show="pickupGroupVendor(g).parkingAccessMemo" x-text="' 🅿 ' + pickupGroupVendor(g).parkingAccessMemo"></span>
            </div>
            <!-- 길찾기 3버튼 -->
            <div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">
              <button class="btn-ghost btn-sm" @click="openPickupMap(pickupGroupVendor(g), 'naver')">네이버</button>
              <button class="btn-ghost btn-sm" @click="openPickupMap(pickupGroupVendor(g), 'kakao')">카카오</button>
              <button class="btn-ghost btn-sm" @click="openPickupMap(pickupGroupVendor(g), 'tmap')">T맵</button>
            </div>
          </div>
          <!-- 카드 본문: 요청별 품목 체크리스트 -->
          <div style="padding:8px 14px;" class="space-y-2">
            <template x-for="req in g.requests" :key="req.id">
              <div>
                <div class="text-xs text-gray-400" style="margin-bottom:2px;">
                  <span x-text="req.registrarName || '등록자'"></span>
                  <span x-show="req.memo"> · <span x-text="req.memo"></span></span>
                  <a x-show="req.sourceType==='workflow' && req.sourceJobId" :href="'#workflow:' + encodeURIComponent(req.sourceJobId)" style="color:#7c3aed;margin-left:4px;">[워크플로 잡 보기]</a>
                </div>
                <template x-for="it in req.items" :key="it.id">
                  <div class="flex items-center gap-2 flex-wrap" style="padding:4px 0;border-bottom:1px dashed #f1f5f9;">
                    <span class="text-sm" style="flex:1;min-width:120px;" :style="it.status==='cancelled' ? 'text-decoration:line-through;color:#9ca3af;' : ''"
                      x-text="it.itemName + (it.spec?(' '+it.spec):'') + (it.qty?(' '+it.qty+(it.unit||'')):'')"></span>
                    <span class="text-xs px-2 py-0.5 rounded-full" :style="pickupItemStatusStyle(it.status)" x-text="pickupItemStatusLabel(it.status)"></span>
                    <template x-if="canCheckPickup">
                      <div class="flex gap-1 items-center">
                        <input type="number" x-model.number="it._pickedQty" class="input-base" style="width:60px;" placeholder="실수거" :value="it.pickedQty ?? ''">
                        <button class="btn-ghost btn-sm" title="수거완료" @click="setPickupItem(it, 'pickedUp', (it._pickedQty != null && it._pickedQty !== '') ? { pickedQty: it._pickedQty } : undefined)">✅</button>
                        <button class="btn-ghost btn-sm" title="미수거" @click="setPickupItemNotPicked(it)">❌</button>
                        <button class="btn-ghost btn-sm" title="취소" @click="setPickupItem(it, 'cancelled')">🚫</button>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </template>
          </div>
        </div>
      </template>
    </div>
  </template>
</div>
```

- [ ] **Step 2: SSI INCLUDE 추가** — `public/index.html`에서 워크플로 INCLUDE 블록(5427~5429)을 찾는다:

```html
      <template x-if="currentTab === 'workflow'">
        <!--INCLUDE:tab-workflow.html-->
      </template>
```

이 블록 **바로 아래**에 픽업 탭 블록을 추가한다(워크플로 INCLUDE 주석은 절대 건드리지 말 것):

```html
      <template x-if="currentTab === 'workflow'">
        <!--INCLUDE:tab-workflow.html-->
      </template>

      <!-- PICKUP TAB (픽업 관리) -->
      <template x-if="currentTab === 'pickup'">
        <!--INCLUDE:tab-pickup.html-->
      </template>
```

> SSI는 `server.js`가 `GET /`에서 `<!--INCLUDE:tab-pickup.html-->`를 파일 내용으로 치환한다(CLAUDE.md SSI 절). 새 INCLUDE를 추가하면 서버 재시작 후 캐시가 재빌드된다(재시작은 사용자 몫).

- [ ] **Step 3: `app()`에 픽업 state + 메서드 추가** — `public/index.html`에서 `vendorPopup` state 라인(7098)을 찾는다:

```javascript
    vendorPopup: { open: false, x: 80, y: 80, dragging: false, _ox: 0, _oy: 0, editId: null, form: { name:'', bizNo:'', ceo:'', phone:'', email:'', address:'', note:'' } },
```

이 줄 **바로 아래**에 픽업 블록 전체를 추가한다:

```javascript
    // ── 픽업 관리 (pickup) ──────────────────────────────
    pickupView: 'register',              // 'register' | 'collect'
    pickupDate: new Date().toISOString().slice(0, 10),
    pickupForm: { vendorId: '', pickupDate: new Date().toISOString().slice(0, 10), preferredTimeSlot: '', priority: 'normal', memo: '', items: [{ itemName: '', spec: '', qty: null, unit: '개' }], sourceType: 'manual', sourceJobId: null },
    pickupVendorPreview: null,
    pickupKakaoText: '',
    pickupKakaoCandidates: [],
    pickupMine: [],
    pickupRequests: [],
    pickupGroups: [],
    pickupParsing: false,
    pickupSaving: false,
    get activePickupVendors() {
      return (this.vendors || []).filter(v => v.isActive === undefined || v.isActive === 1 || v.isActive === true);
    },
    get canCheckPickup() {
      if (this.auth.role === 'admin') return true;
      return (this.auth.permissions || []).includes('pickup_check');
    },
    get canRegisterPickup() {
      if (this.auth.role === 'admin') return true;
      return (this.auth.permissions || []).includes('pickup_register');
    },
    // 상태 라벨/색상
    pickupStatusLabel(s) {
      return ({ requested: '요청됨', inCourse: '코스포함', completed: '수거완료', partial: '부분수거', notPicked: '미수거', cancelled: '취소' })[s] || s || '요청됨';
    },
    pickupStatusStyle(s) {
      const m = { requested: 'background:#e0e7ff;color:#4338ca;', inCourse: 'background:#e0f2fe;color:#0369a1;', completed: 'background:#dcfce7;color:#15803d;', partial: 'background:#fef9c3;color:#a16207;', notPicked: 'background:#fee2e2;color:#b91c1c;', cancelled: 'background:#f3f4f6;color:#6b7280;' };
      return m[s] || m.requested;
    },
    pickupItemStatusLabel(s) {
      return ({ requested: '요청', pickedUp: '수거완료', notPicked: '미수거', cancelled: '취소' })[s] || s || '요청';
    },
    pickupItemStatusStyle(s) {
      const m = { requested: 'background:#e0e7ff;color:#4338ca;', pickedUp: 'background:#dcfce7;color:#15803d;', notPicked: 'background:#fee2e2;color:#b91c1c;', cancelled: 'background:#f3f4f6;color:#6b7280;' };
      return m[s] || m.requested;
    },
    // 업체 미리보기
    onPickupVendorChange() {
      const v = (this.vendors || []).find(x => x.id === this.pickupForm.vendorId);
      this.pickupVendorPreview = v || null;
    },
    // 품목 줄 조작
    addPickupItemRow() { this.pickupForm.items.push({ itemName: '', spec: '', qty: null, unit: '개' }); },
    removePickupItemRow(i) { this.pickupForm.items.splice(i, 1); if (!this.pickupForm.items.length) this.addPickupItemRow(); },
    resetPickupForm() {
      this.pickupForm = { vendorId: '', pickupDate: this.pickupDate, preferredTimeSlot: '', priority: 'normal', memo: '', items: [{ itemName: '', spec: '', qty: null, unit: '개' }], sourceType: 'manual', sourceJobId: null };
      this.pickupVendorPreview = null;
    },
    // 정식 등록
    async submitPickupForm() {
      if (this.pickupSaving) return;
      if (!this.pickupForm.vendorId) { this.showToast('업체를 선택하세요', 'error'); return; }
      if (!this.pickupForm.pickupDate) { this.showToast('픽업 날짜를 선택하세요', 'error'); return; }
      const items = this.pickupForm.items.filter(it => (it.itemName || '').trim());
      if (!items.length) { this.showToast('품목을 1개 이상 입력하세요', 'error'); return; }
      this.pickupSaving = true;
      try {
        const r = await fetch('/api/pickup/requests', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            pickupDate: this.pickupForm.pickupDate, vendorId: this.pickupForm.vendorId,
            preferredTimeSlot: this.pickupForm.preferredTimeSlot, priority: this.pickupForm.priority,
            memo: this.pickupForm.memo, sourceType: this.pickupForm.sourceType || 'manual',
            sourceJobId: this.pickupForm.sourceJobId || null, items,
          }),
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); this.showToast(d.error || '등록 실패', 'error'); return; }
        this.showToast('픽업 요청이 등록되었습니다');
        this.resetPickupForm();
        await this.loadPickupMine();
      } catch (e) { this.showToast('등록 실패: ' + e.message, 'error'); }
      finally { this.pickupSaving = false; }
    },
    // 카톡 파싱
    async parsePickupKakao() {
      if (this.pickupParsing) return;
      const text = (this.pickupKakaoText || '').trim();
      if (!text) { this.showToast('붙여넣을 텍스트가 없습니다', 'error'); return; }
      this.pickupParsing = true;
      try {
        const r = await fetch('/api/pickup/parse-kakao', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text }),
        });
        const d = await r.json();
        if (!r.ok) { this.showToast(d.error || '분석 실패', 'error'); return; }
        // 업체명 추정 → vendorId 자동매칭 시도
        this.pickupKakaoCandidates = (d.groups || []).map(g => {
          const guess = (g.vendorGuess || '').trim();
          const match = guess ? (this.vendors || []).find(v => (v.name || '').includes(guess) || guess.includes(v.name || '')) : null;
          return { vendorGuess: guess, vendorId: match ? match.id : '', items: (g.items || []).map(it => ({ itemName: it.itemName || '', spec: it.spec || '', qty: it.qty || null, unit: it.unit || '' })) };
        });
        if (!this.pickupKakaoCandidates.length) this.showToast('후보를 찾지 못했습니다', 'error');
      } catch (e) { this.showToast('분석 실패: ' + e.message, 'error'); }
      finally { this.pickupParsing = false; }
    },
    // 카톡 후보 일괄 저장
    async savePickupCandidates() {
      if (this.pickupSaving) return;
      const ready = this.pickupKakaoCandidates.filter(c => c.vendorId && (c.items || []).some(it => (it.itemName || '').trim()));
      if (!ready.length) { this.showToast('업체가 지정된 후보가 없습니다', 'error'); return; }
      this.pickupSaving = true;
      let ok = 0;
      try {
        for (const c of ready) {
          const items = c.items.filter(it => (it.itemName || '').trim());
          const r = await fetch('/api/pickup/requests', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pickupDate: this.pickupDate, vendorId: c.vendorId, priority: 'normal', memo: '', sourceType: 'manual', items }),
          });
          if (r.ok) ok++;
        }
        this.showToast(ok + '건 등록되었습니다');
        this.pickupKakaoCandidates = [];
        this.pickupKakaoText = '';
        await this.loadPickupMine();
      } catch (e) { this.showToast('저장 실패: ' + e.message, 'error'); }
      finally { this.pickupSaving = false; }
    },
    // 조회: 내가 등록한 것
    async loadPickupMine() {
      try {
        const r = await fetch('/api/pickup/requests/mine?date=' + encodeURIComponent(this.pickupDate));
        this.pickupMine = r.ok ? await r.json() : [];
      } catch (e) { this.pickupMine = []; }
    },
    // 조회: 날짜별 취합
    async loadPickupRequests() {
      try {
        const r = await fetch('/api/pickup/requests?date=' + encodeURIComponent(this.pickupDate));
        const d = r.ok ? await r.json() : { requests: [], groups: [] };
        this.pickupRequests = d.requests || [];
        this.pickupGroups = d.groups || [];
      } catch (e) { this.pickupRequests = []; this.pickupGroups = []; }
    },
    // 그룹 헬퍼 (취합 뷰)
    pickupGroupVendor(g) {
      const req = (g.requests || [])[0];
      return (req && req.vendor) || null;
    },
    pickupGroupHasLate(g) { return (g.requests || []).some(r => r.isLate); },
    pickupGroupHasWorkflow(g) { return (g.requests || []).some(r => r.sourceType === 'workflow'); },
    pickupGroupRollup(g) {
      const items = [];
      for (const r of (g.requests || [])) for (const it of (r.items || [])) items.push(it);
      const active = items.filter(it => it.status !== 'cancelled');
      let status = 'requested';
      if (items.length && !active.length) status = 'cancelled';
      else if (active.length) {
        const picked = active.filter(it => it.status === 'pickedUp').length;
        const notPicked = active.filter(it => it.status === 'notPicked').length;
        if (picked === active.length) status = 'completed';
        else if (picked > 0) status = 'partial';
        else if (notPicked === active.length) status = 'notPicked';
      }
      const done = active.filter(it => it.status === 'pickedUp').length;
      return { status, label: this.pickupStatusLabel(status) + (active.length ? ` (${done}/${active.length})` : '') };
    },
    // 라인 체크
    async setPickupItem(it, status, extra) {
      if (!this.canCheckPickup) { this.showToast('체크 권한이 없습니다', 'error'); return; }
      try {
        const body = Object.assign({ status }, extra || {});
        const r = await fetch('/api/pickup/items/' + encodeURIComponent(it.id) + '/status', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); this.showToast(d.error || '체크 실패', 'error'); return; }
        await this.loadPickupRequests();
      } catch (e) { this.showToast('체크 실패: ' + e.message, 'error'); }
    },
    setPickupItemNotPicked(it) {
      const reason = prompt('미수거 사유를 입력하세요 (부재/재고없음/위치불명/시간부족 등)', it.failReason || '');
      if (reason === null) return;
      this.setPickupItem(it, 'notPicked', { failReason: reason });
    },
    // 실수거 수량은 체크 시 함께 전송 (✅ 누를 때 _pickedQty 있으면 포함)
    // (위 setPickupItem 호출 전 ✅ 버튼에서 extra 구성)
    // 취소
    async cancelPickupRequest(id) {
      if (!confirm('이 픽업 요청을 취소하시겠습니까?')) return;
      const reason = prompt('취소 사유 (선택)', '') || '';
      try {
        const r = await fetch('/api/pickup/requests/' + encodeURIComponent(id) + '/cancel', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ reason }),
        });
        if (!r.ok) { const d = await r.json().catch(() => ({})); this.showToast(d.error || '취소 실패', 'error'); return; }
        this.showToast('취소되었습니다');
        await this.loadPickupMine();
      } catch (e) { this.showToast('취소 실패: ' + e.message, 'error'); }
    },
    // 카톡 공유텍스트
    async copyPickupShareText() {
      try {
        const r = await fetch('/api/pickup/requests/' + encodeURIComponent(this.pickupDate) + '/share-text');
        const d = await r.json();
        if (!r.ok) { this.showToast(d.error || '생성 실패', 'error'); return; }
        const text = d.text || '';
        if (navigator.clipboard && window.isSecureContext) {
          await navigator.clipboard.writeText(text);
          this.showToast('카톡 공유텍스트가 복사되었습니다');
        } else {
          window.prompt('아래 텍스트를 복사하세요 (Ctrl+C)', text);
        }
      } catch (e) { this.showToast('생성 실패: ' + e.message, 'error'); }
    },
    // 지도 길찾기 (네이버/카카오/T맵 웹 검색 — PC용 새 탭)
    openPickupMap(vendor, app) {
      if (!vendor) { this.showToast('업체 정보가 없습니다', 'error'); return; }
      const q = (vendor.mapSearchKeyword || '').trim() || (vendor.address || '').trim() || (vendor.name || '').trim();
      if (!q) { this.showToast('주소/검색어가 없습니다. 업체에 주소를 등록하세요', 'error'); return; }
      const eq = encodeURIComponent(q);
      let url;
      if (app === 'kakao') url = 'https://map.kakao.com/?q=' + eq;
      else if (app === 'tmap') url = 'https://tmap.life/search?name=' + eq;
      else url = 'https://map.naver.com/v5/search/' + eq;
      window.open(url, '_blank', 'noopener');
    },
    // 워크플로 → 픽업 프리필 (이벤트 브리지로 호출됨)
    openPickupFromJob(job) {
      if (!job) return;
      this.pickupView = 'register';
      const siteLabel = [job.companyName, job.projectName].filter(Boolean).join(' ');
      const designLabel = job.title || '';
      this.pickupForm = {
        vendorId: '', pickupDate: this.pickupDate, preferredTimeSlot: '', priority: 'normal',
        memo: [siteLabel, designLabel].filter(Boolean).join(' / '),
        items: [{ itemName: designLabel || '시안', spec: '', qty: null, unit: '개' }],
        sourceType: 'workflow', sourceJobId: job.id || null,
      };
      this.pickupVendorPreview = null;
      this.currentTab = 'pickup';
      this.showToast('워크플로 정보로 픽업 등록폼을 채웠습니다. 업체와 품목을 확정하세요');
    },
```

> 실수거 수량 배선(중요): Step 1 마크업의 ✅ 버튼 `@click`은 `setPickupItem(it, 'pickedUp', (it._pickedQty != null && it._pickedQty !== '') ? { pickedQty: it._pickedQty } : undefined)` 형태로, 줄에 `it._pickedQty`가 입력돼 있으면 `pickedQty`를 함께 전송하도록 이미 작성돼 있다(위 `setPickupItem(it, status, extra)` 메서드와 정확히 맞물림). 마크업을 그대로 쓰면 추가 정정 불필요.

- [ ] **Step 4: `app().init()`에 이벤트 리스너 등록** — `public/index.html`의 `async init() {`(7566) 본문 **시작부**(첫 `this._suppressHashUpdate = false;` 줄 바로 위 또는 아래)에 추가:

```javascript
      // 워크플로 → 픽업 등록폼 프리필 (workflowApp은 별도 루트라 이벤트로 받음)
      this._pickupFromJobHandler = (e) => {
        const job = (e && e.detail) || window.__pickupFromJob || null;
        if (job) this.openPickupFromJob(job);
        window.__pickupFromJob = null;
      };
      window.addEventListener('pickup-from-job', this._pickupFromJobHandler);
```

- [ ] **Step 5: 탭 진입 시 자동 로드 (선택, 권장)** — 픽업 탭으로 전환될 때 데이터가 비어 보이지 않도록, `currentTab` 변경을 감지하는 기존 패턴이 있으면 거기에 한 줄을 추가하거나, 없으면 탭 버튼 클릭 시점에 로드한다. 최소구현으로는 **서브탭 버튼이 이미 `loadPickupMine()`/`loadPickupRequests()`를 호출**하므로 추가 작업 불필요. 단, 탭 첫 진입을 매끄럽게 하려면 `app()`에 `$watch`를 init에 추가:

`init()`의 위 리스너 등록 근처에 추가:
```javascript
      this.$watch('currentTab', (v) => {
        if (v === 'pickup') {
          if (this.pickupView === 'collect') this.loadPickupRequests();
          else this.loadPickupMine();
        }
      });
```

- [ ] **Step 6: 화면 점검 (서버 재시작 없이는 SSI 미반영일 수 있음 → 사용자 안내)**

서버가 이미 새 코드로 재시작된 상태라면(사용자가 재시작), 로컬 ERP에서 admin 로그인 → 사이드바 '관리 > 픽업 관리' 클릭 → 등록 폼·취합 뷰가 보이고, 카톡 붙여넣기 `#라코스\n현수막 600x900 3개`로 후보가 분리되는지 확인. **서버 재시작은 하지 말 것**(사용자 몫). SSI 캐시 특성상 INCLUDE 추가는 재시작 후 반영됨.

- [ ] **Step 7: 커밋**

```bash
git add public/tab-pickup.html public/index.html
git commit -m "feat(pickup): tab-pickup.html(등록 뷰+취합·체크 뷰)+SSI INCLUDE+app() 픽업 state/메서드(이벤트 브리지 openPickupFromJob 포함)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: 업체 모달 신규필드 (`public/index.html`)

**Files:**
- Modify: `public/index.html` (업체 모달 마크업 1558~1588, `vendorPopup` state 7098, `openVendorPopup`/`saveVendorPopup` 8849~8877)

업체(`vendorPopup`) 모달에 픽업용 7필드(거래처유형·지도검색어·담당자·담당자전화·픽업메모·주차출입메모·사용여부)를 입력으로 추가한다. 백엔드는 플랜 A에서 이미 `routes/vendors.js` POST 화이트리스트 + `db-sqlite.js` vendors CRUD에 이 필드들을 받도록 되어 있다.

- [ ] **Step 1: 모달 마크업에 신규 필드 추가** — `public/index.html`에서 비고 textarea(1584~1587)를 찾는다:

```html
        <div class="col-span-2">
          <label class="label-base">비고</label>
          <textarea x-model="vendorPopup.form.note" class="input-base" style="resize:vertical;min-height:64px;" placeholder="팩스, 업태, 종목 등" rows="3"></textarea>
        </div>
```

이 `<div class="col-span-2">...비고...</div>` 블록 **바로 위**에 픽업 필드 묶음을 추가한다(grid 안에 같은 자식으로):

```html
        <div>
          <label class="label-base">거래처 유형</label>
          <select x-model="vendorPopup.form.vendorType" class="input-base">
            <option value="매입처">매입처</option>
            <option value="판매처">판매처</option>
            <option value="둘다">둘다</option>
            <option value="기타">기타</option>
          </select>
        </div>
        <div>
          <label class="label-base">사용 여부</label>
          <label style="display:flex;align-items:center;gap:6px;height:34px;font-size:13px;color:#374151;">
            <input type="checkbox" x-model="vendorPopup.form.isActive"> 사용함 (체크 해제 시 픽업 목록에서 숨김)
          </label>
        </div>
        <div class="col-span-2">
          <label class="label-base">지도 검색어 <span style="color:#9ca3af;font-weight:400;">(주소로 안 잡힐 때)</span></label>
          <input x-model="vendorPopup.form.mapSearchKeyword" class="input-base" placeholder='예: "라코스 본사"'>
        </div>
        <div>
          <label class="label-base">담당자</label>
          <input x-model="vendorPopup.form.contactPerson" class="input-base" placeholder="담당자명">
        </div>
        <div>
          <label class="label-base">담당자 전화</label>
          <input x-model="vendorPopup.form.contactPhone" class="input-base" placeholder="010-0000-0000">
        </div>
        <div class="col-span-2">
          <label class="label-base">픽업 메모</label>
          <input x-model="vendorPopup.form.pickupMemo" class="input-base" placeholder="후문 창고 / 점심시간 피하기 등">
        </div>
        <div class="col-span-2">
          <label class="label-base">주차 / 출입 메모</label>
          <input x-model="vendorPopup.form.parkingAccessMemo" class="input-base" placeholder="지하주차 가능 / 정문 경비 호출 등">
        </div>
```

- [ ] **Step 2: `vendorPopup` state form에 신규필드 추가** — `public/index.html` 7098의 `vendorPopup` 선언을 아래로 교체:

```javascript
    vendorPopup: { open: false, x: 80, y: 80, dragging: false, _ox: 0, _oy: 0, editId: null, form: { name:'', bizNo:'', ceo:'', phone:'', email:'', address:'', note:'', vendorType:'기타', mapSearchKeyword:'', contactPerson:'', contactPhone:'', pickupMemo:'', parkingAccessMemo:'', isActive:true } },
```

- [ ] **Step 3: `openVendorPopup`에 신규필드 초기화** — `public/index.html` 8849~8860의 `openVendorPopup`을 아래로 교체:

```javascript
    openVendorPopup(v) {
      if (v) {
        this.vendorPopup.editId = v.id;
        this.vendorPopup.form = {
          name:v.name||'', bizNo:v.bizNo||'', ceo:v.ceo||'', phone:v.phone||'', email:v.email||'', address:v.address||'', note:v.note||'',
          vendorType:v.vendorType||'기타', mapSearchKeyword:v.mapSearchKeyword||'', contactPerson:v.contactPerson||'', contactPhone:v.contactPhone||'',
          pickupMemo:v.pickupMemo||'', parkingAccessMemo:v.parkingAccessMemo||'', isActive: (v.isActive === undefined ? true : (v.isActive === 1 || v.isActive === true))
        };
      } else {
        this.vendorPopup.editId = null;
        this.vendorPopup.form = { name:'', bizNo:'', ceo:'', phone:'', email:'', address:'', note:'', vendorType:'기타', mapSearchKeyword:'', contactPerson:'', contactPhone:'', pickupMemo:'', parkingAccessMemo:'', isActive:true };
      }
      this.vendorPopup.x = Math.max(20, Math.round((window.innerWidth - 540) / 2));
      this.vendorPopup.y = Math.round((window.innerHeight - 480) / 2);
      this.vendorPopup.open = true;
    },
```

> `saveVendorPopup`(8861)은 `JSON.stringify(this.vendorPopup.form)` 전체를 그대로 POST/PUT 하므로 **수정 불필요** — form에 신규필드가 들어 있으면 자동 전송된다. (백엔드 화이트리스트는 플랜 A에서 처리됨.)

- [ ] **Step 4: 점검 + 커밋**

로컬 ERP가 새 코드로 떠 있으면 업체 관리 → 업체 추가/수정 모달에서 신규 7필드가 보이고, 저장 후 다시 열었을 때 값이 유지되는지 확인. (서버 재시작은 사용자 몫.)

```bash
git add public/index.html
git commit -m "feat(pickup): 업체 모달 픽업필드 7종(거래처유형·지도검색어·담당자·담당자전화·픽업메모·주차출입메모·사용여부) 입력 추가

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: 워크플로 "픽업에 추가" 버튼 (`tab-workflow.html` + 이벤트 브리지)

**Files:**
- Modify: `public/tab-workflow.html` (상세 헤더 액션행 525~530)

워크플로 상세 패널 헤더에 "픽업에 추가" 버튼을 달고, `workflowApp()`(별도 Alpine 루트)에서 `app()`으로 이벤트 브리지(`CustomEvent('pickup-from-job')` + `window.__pickupFromJob`)를 통해 잡 정보를 넘긴다. `app().init()`의 리스너(Task 2 Step 5)가 이를 받아 `openPickupFromJob(job)`을 호출한다.

> **왜 이벤트인가:** 워크플로 리스트 카드는 단일 `<button @click="selectJob(...)">`(tab-workflow.html:459)이라 내부에 버튼을 못 넣는다(HTML 위반). 그래서 액션은 **상세 패널**에 둔다. 또한 워크플로는 `x-data="workflowApp()"`로 `app()`과 분리된 루트라 `currentTab`을 직접 못 바꾼다 → 이미 검증된 `statement-entry` 브리지(index.html `openStatementEntry` → statements.js 리스너)와 동일 방식 사용.

- [ ] **Step 1: 상세 헤더에 버튼 추가** — `public/tab-workflow.html`에서 '상세' 토글 버튼(529)을 찾는다:

```html
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;">
              <span class="wf-chip" :class="detail.job.priority" x-text="priorityLabel(detail.job.priority)"></span>
              <span class="wf-chip" :class="detail.job.status === 'done' ? 'done' : (detail.job.status === 'hold' || detail.job.status === 'cancelled' ? 'blocked' : 'ready')" x-text="statuses[detail.job.status] || detail.job.status || '진행'"></span>
              <span class="wf-chip" :class="detail.job.canComplete ? 'ready' : 'not_ready'" x-text="completionBlockerShortText(detail.job)"></span>
              <button class="wf-btn ghost" @click="detailMoreOpen = !detailMoreOpen" x-text="detailMoreOpen ? '상세 접기' : '상세'"></button>
            </div>
```

'상세' 토글 버튼 **뒤**에 픽업 버튼을 추가한다:

```html
            <div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;margin-top:8px;">
              <span class="wf-chip" :class="detail.job.priority" x-text="priorityLabel(detail.job.priority)"></span>
              <span class="wf-chip" :class="detail.job.status === 'done' ? 'done' : (detail.job.status === 'hold' || detail.job.status === 'cancelled' ? 'blocked' : 'ready')" x-text="statuses[detail.job.status] || detail.job.status || '진행'"></span>
              <span class="wf-chip" :class="detail.job.canComplete ? 'ready' : 'not_ready'" x-text="completionBlockerShortText(detail.job)"></span>
              <button class="wf-btn ghost" @click="detailMoreOpen = !detailMoreOpen" x-text="detailMoreOpen ? '상세 접기' : '상세'"></button>
              <button class="wf-btn" @click="addJobToPickup(detail.job)" title="이 작업의 현장·시안 정보로 픽업 등록폼을 채웁니다">
                <span class="material-symbols-outlined" style="font-size:15px;">local_shipping</span>픽업에 추가
              </button>
            </div>
```

- [ ] **Step 2: `workflowApp()`에 `addJobToPickup` 메서드 추가** — `public/workflow.js`에 메서드를 추가한다. 기존 메서드들 사이(예: `openContact` 류 헬퍼들 근처, 어디든 `workflowApp()` 반환 객체의 메서드로) 한 메서드를 추가:

```javascript
    // 워크플로 잡 → 픽업 등록폼으로 전달 (app()이 별도 루트라 이벤트 브리지 사용)
    addJobToPickup(job) {
      const j = job || (this.detail && this.detail.job);
      if (!j) return;
      const payload = { id: j.id, title: j.title || '', companyName: j.companyName || '', projectName: j.projectName || '' };
      window.__pickupFromJob = payload;
      window.dispatchEvent(new CustomEvent('pickup-from-job', { detail: payload }));
    },
```

> 정확한 삽입 위치: `workflow.js`에서 `methods` 객체나 컴포넌트 반환 객체의 메서드 나열 구간 아무 곳(콤마 구분 유지). 기존 메서드 하나(예: `selectJob` 또는 `currentUserLabel`)를 Grep으로 찾아 그 정의 **뒤**에 콤마 맞춰 붙이면 안전하다.

- [ ] **Step 3: 동작 점검** — (서버가 새 코드로 떠 있을 때) 워크플로 탭 → 잡 선택 → 상세 헤더의 "픽업에 추가" 클릭 → 픽업 탭으로 전환되고 등록폼 메모/품목에 현장·시안명이 채워지며 `sourceType:'workflow'`가 설정됨. 업체 선택 후 등록하면 취합 뷰에서 🎨시안 뱃지 + [워크플로 잡 보기] 링크가 보임. **서버 재시작은 하지 말 것.**

- [ ] **Step 4: 커밋**

```bash
git add public/tab-workflow.html public/workflow.js
git commit -m "feat(pickup): 워크플로 상세에 '픽업에 추가' 버튼 → 이벤트 브리지로 픽업 등록폼 프리필(sourceType:workflow)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## 셀프리뷰 (작성자 체크)

**스펙 커버리지 (플랜 B 범위):**
- §9 권한 노출: `allMenus` pickup_view/register/check, `getTabs`(admin+일반 분기 `pickup_view`), `menuGroups` '관리', ROLE_PRESETS 시드(경영관리팀/납품팀) → Task 1 ✅
- §7.1 등록 뷰(업체·날짜·시간대·우선순위·품목줄·메모 + 카톡 붙여넣기→parse-kakao→후보→저장 + 내가 올린 것) → Task 2 Step 1·3 ✅
- §7.2 취합·체크 뷰(날짜→업체카드 그룹, 헤더: 주소·전화·[네이버][카카오][T맵]·픽업/주차메모·롤업뱃지·🔴추가요청, 품목 ✅/❌(사유)/🚫·실수거수량, 카톡 공유텍스트) → Task 2 Step 1·3 ✅
- §7.3 / D6 워크플로 "픽업에 추가" → Task 4 + Task 2(openPickupFromJob, sourceType/ sourceJobId, 🎨시안 뱃지·[워크플로 잡 보기]) ✅
- §4.1 업체 ALTER 7필드 입력 UI → Task 3 ✅
- §5.3 업체 카드 롤업(읽을 때 계산) → Task 2 `pickupGroupRollup` (백엔드 `groups`도 제공하나 클라 롤업으로 뱃지 표기) ✅

**API 시그니처 일치(플랜 A 대조):**
- `GET /api/pickup/requests?date=` → `{requests, groups}` ← `loadPickupRequests` ✅
- `GET /api/pickup/requests/mine?date=` → 배열 ← `loadPickupMine` ✅
- `POST /api/pickup/requests {pickupDate,vendorId,preferredTimeSlot,priority,memo,sourceType,sourceJobId,items[]}` ← `submitPickupForm`/`savePickupCandidates`/`openPickupFromJob` ✅
- `POST /api/pickup/requests/:id/cancel {reason}` ← `cancelPickupRequest` ✅
- `PATCH /api/pickup/items/:id/status {status,pickedQty,failReason}` ← `setPickupItem`/`setPickupItemNotPicked` ✅
- `POST /api/pickup/parse-kakao {text}` → `{groups:[{vendorGuess,items}]}` ← `parsePickupKakao` ✅
- `GET /api/pickup/requests/:date/share-text` → `{text}` ← `copyPickupShareText` ✅
- 업체 목록은 기존 `GET /api/vendors` 재사용(`activePickupVendors` 필터) ✅ — `PUT /api/pickup/requests/:id`(수정)은 v1 등록폼이 신규 생성 위주라 미사용(가능: 추후 인라인 수정에서 연결).

**플레이스홀더 스캔:** TBD/TODO/"적절히 처리" 없음. 모든 코드 블록 완전 기재. ✅

**타입/이름 일관성:**
- 탭 id는 `pickup`(단수) 하나 — `menuGroups`/`getTabs`/SSI INCLUDE `currentTab==='pickup'` 모두 일치. 권한 id는 `pickup_view/register/check`로 `allMenus`·`getTabs` 필터·`canCheckPickup`/`canRegisterPickup` 동일.
- 메서드명 일관: `loadPickupMine`/`loadPickupRequests`/`submitPickupForm`/`parsePickupKakao`/`savePickupCandidates`/`setPickupItem`/`setPickupItemNotPicked`/`cancelPickupRequest`/`copyPickupShareText`/`openPickupMap`/`openPickupFromJob`/`addJobToPickup`(workflow.js) — 마크업 `@click`과 정의가 정확히 매칭.
- 상태 코드값(item: requested/pickedUp/notPicked/cancelled, req: requested/inCourse/completed/partial/notPicked/cancelled, priority: normal/urgent/todayMust)이 플랜 A와 동일.

**이벤트 브리지 정합성:** 워크플로 `addJobToPickup`이 `window.__pickupFromJob` + `CustomEvent('pickup-from-job')` 발행 → `app().init()`의 `_pickupFromJobHandler`가 수신 → `openPickupFromJob(job)` 호출. 기존 `statement-entry` 패턴과 동형. ✅

**주의·미해결(실행 전 확인):**
- SSI INCLUDE 추가·`app()` 변경은 **서버 재시작 후** 반영(SSI 캐시). 재시작은 사용자 몫(본 작업에서 금지).
- ROLE_PRESETS는 하드코딩 상수가 아님 → 시드(`pickupRolePresetSeed`)를 노출하려면 관리자 권한 패널의 프리셋 `x-for` 바인딩을 `effectivePermPresets`로 1곳 교체해야 화면에 보임(Task 1 Step 4 주석). 바인딩 위치는 권한관리 모달에서 `x-for="... permPresets"`를 Grep해 확인.
- `openVendorPopup`/`saveVendorPopup`은 `vendorPopup`을 쓰는 정식 모달. 같은 파일의 레거시 인라인 폼(`newVendor`/`createVendor`/`editingVendor`)은 픽업필드 미포함이나, 픽업은 정식 모달만 쓰면 충분(레거시 폼 보강은 불필요 — YAGNI).
