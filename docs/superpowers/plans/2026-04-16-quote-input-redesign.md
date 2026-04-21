# 견적 입력 UI 전면 개편 구현 계획

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 견적 입력 화면을 전체화면 팝업 + 인라인 테이블 입력 + 키워드 분리 검색 + A4 미리보기로 전면 개편

**Architecture:** 기존 quotePopup을 95vw×90vh로 확장하고, itemEditPopup을 제거하여 인라인 테이블 입력으로 전환. 과거단가 사이드바는 기존과 동일하게 우측에 유지. 검색 API는 키워드 분리 로직 추가. 미리보기는 iframe 대신 인라인 A4 HTML로 교체.

**Tech Stack:** Alpine.js, Tailwind CSS, Express.js, better-sqlite3

**프로젝트 경로:** `C:\Users\NAMGW\Documents\Claude\Projects\업체별 단가표 만들기!!!\price-list-app` (로컬 PC = localhost:3000)

---

## 파일 구조

| 파일 | 작업 | 역할 |
|------|------|------|
| `db-sales-history.js` | 수정 | 키워드 분리 검색 로직 추가 (search 함수) |
| `public/tab-sales-lookup.html` | 수정 | 프론트엔드 검색 UI에 키워드 분리 적용 |
| `public/index.html` | 수정 | quotePopup HTML 전면 교체, itemEditPopup 제거, JS 메서드 교체 |

> **주의:** `index.html`은 8661줄 짜리 모놀리식 파일. 각 태스크에서 정확한 줄 번호와 교체 대상 블록을 명시.

---

### Task 1: 키워드 분리 검색 — 백엔드

**Files:**
- Modify: `db-sales-history.js:86-105` (search 함수)

이 태스크는 독립적으로 진행 가능. 검색 API가 `"포맥스 3t 600"` 같은 입력을 `[포맥스, 3t, 600]`으로 분리하여 각각이 `product_name + raw_spec`에 모두 포함될 때만 매칭.

- [ ] **Step 1: db-sales-history.js의 search 함수 수정**

`db-sales-history.js` 파일의 기존 `search` 함수(86~105줄)를 아래로 교체:

```javascript
// ── 검색 ──
function search({ vendor, keyword, limit = 20 }) {
  let sql = `SELECT * FROM sales_history WHERE 1=1`;
  const params = {};

  if (vendor) {
    sql += ` AND vendor LIKE @vendor`;
    params.vendor = `%${vendor}%`;
  }

  if (keyword) {
    // 키워드 분리: 띄어쓰기로 분할, 각 키워드가 product_name+raw_spec에 모두 포함
    const keywords = keyword.trim().split(/\s+/).filter(k => k.length > 0);
    if (keywords.length === 1) {
      // 단일 키워드: 기존 로직 유지 (base_name prefix OR product_name contains)
      sql += ` AND (base_name LIKE @kwPrefix OR product_name LIKE @kwContains OR raw_spec LIKE @kwContains)`;
      params.kwPrefix = `${keywords[0]}%`;
      params.kwContains = `%${keywords[0]}%`;
    } else {
      // 복수 키워드: 각각이 (product_name || ' ' || COALESCE(raw_spec,''))에 포함
      keywords.forEach((kw, i) => {
        const paramName = `kw${i}`;
        sql += ` AND (LOWER(product_name) || ' ' || LOWER(COALESCE(raw_spec,''))) LIKE @${paramName}`;
        params[paramName] = `%${kw.toLowerCase()}%`;
      });
    }
  }

  sql += ` ORDER BY sale_date DESC LIMIT @limit`;
  params.limit = limit;

  return db.prepare(sql).all(params);
}
```

- [ ] **Step 2: 로컬에서 서버 재시작 후 API 테스트**

브라우저에서 직접 테스트:
```
http://localhost:3000/api/sales-history/search?keyword=포맥스+3t&limit=5
```

기대 결과: `포맥스3T`, `3T포맥스`, `3t 포맥스` 등 순서 무관하게 모두 매칭

- [ ] **Step 3: 커밋**

```bash
git add db-sales-history.js
git commit -m "feat: keyword-splitting search for sales history"
```

---

### Task 2: 키워드 분리 검색 — 프론트엔드 (과거단가조회 탭)

**Files:**
- Modify: `public/tab-sales-lookup.html` (검색 안내 문구 변경)

검색 로직은 이미 백엔드에서 처리하므로, 프론트엔드는 UI 안내만 수정하면 됨.

- [ ] **Step 1: tab-sales-lookup.html 검색 placeholder 수정**

키워드 검색 input의 `placeholder`를 수정하여 사용자에게 분리 검색이 가능함을 알림:

기존: `placeholder="품명 검색..."` (또는 유사한 문구)
변경: `placeholder="품명 검색 (예: 포맥스 3t 600)"`

- [ ] **Step 2: 견적 팝업 사이드바 검색 placeholder도 수정**

`public/index.html` 693줄의 과거단가 사이드바 검색 input:

기존: `placeholder="품명 검색"`
변경: `placeholder="품명 검색 (예: 포맥스 3t)"`

- [ ] **Step 3: 브라우저에서 테스트**

과거단가조회 탭에서 `포맥스 3t` 입력 → 순서 무관하게 결과 표시 확인.

- [ ] **Step 4: 커밋**

```bash
git add public/tab-sales-lookup.html public/index.html
git commit -m "feat: update search placeholders for keyword-splitting"
```

---

### Task 3: 견적 팝업 레이아웃 확장 + 인라인 품목 테이블

**Files:**
- Modify: `public/index.html:376-798` (quotePopup HTML 전체 교체)
- Modify: `public/index.html:5280-5290` (quotePopup 초기값)

이 태스크가 가장 큰 변경. 기존 quotePopup HTML (376~798줄)을 전면 교체.

**핵심 변경사항:**
1. 팝업 크기: `width: 95vw, height: 90vh` (기존 1200×720)
2. 기존 "항목 추가" 섹션 (카테고리 드롭다운 + 추가 버튼) 제거
3. 품목 테이블을 인라인 편집 가능하게 교체
4. 각 행에 아코디언 (옵션/매입정보)
5. 과거단가 사이드바는 기존 구조 유지

- [ ] **Step 1: quotePopup 초기값 수정**

`index.html` ~5281줄의 quotePopup 초기값 수정:

```javascript
quotePopup: { open: false, x: 20, y: 20, dragging: false, _ox: 0, _oy: 0, minimized: false, tab: 'form', width: Math.round(window.innerWidth * 0.95), height: Math.round(window.innerHeight * 0.9), resizing: false, _rEdge: '', _rx: 0, _ry: 0, _rw: 0, _rh: 0 },
```

- [ ] **Step 2: 인라인 편집용 Alpine.js 상태 추가**

`index.html`의 Alpine data 영역 (quotePopup 아래)에 인라인 편집 상태 추가:

```javascript
// 인라인 품목 편집 상태
inlineEdit: {
  activeRow: -1,        // 현재 편집 중인 행 인덱스 (-1 = 없음)
  accordionRow: -1,     // 아코디언 펼침 행 인덱스
},

// 새 행 추가용 빈 항목 (테이블 하단)
newRow: {
  categoryId: '',
  categoryType: 'QTY',
  catSearch: '',
  catOpen: false,
  catHighlight: -1,
  widthMm: 0,
  heightMm: 0,
  qty: 1,
  unitType: 'area',     // 'area' | 'qty' | 'length'
  manualPrice: false,
  manualUnitPrice: 0,
  selectedOptions: [],
  optionQtys: {},
  optionVariants: {},
  customName: '',
  customSpec: '',
},
```

- [ ] **Step 3: quotePopup HTML 교체 — 전체 레이아웃**

기존 `index.html` 376~798줄 (quotePopup backdrop + popup div + footer)을 교체.

**교체 대상 시작점:** `<!-- ════════════════════════════════════════════` (376줄)
**교체 대상 끝점:** `</template>` (798줄 — quotePopup 닫는 template)

새 HTML 구조:

```html
<!-- ════════════════════════════════════════════
     견적 작성 팝업 (전체화면 레이아웃)
     ════════════════════════════════════════════ -->
<template x-if="quotePopup.open">
  <div class="ec-popup-backdrop" @click.self="quotePopup.open=false"
       @mousemove.window="onPopupDrag(quotePopup, $event); onPopupResize(quotePopup, $event)"
       @mouseup.window="quotePopup.dragging=false; quotePopup.resizing=false;"
       style="cursor:default;"></div>
</template>

<template x-if="quotePopup.open">
  <div class="ec-popup"
       :style="`left:${quotePopup.x}px; top:${quotePopup.y}px; width:${quotePopup.minimized ? '340px' : quotePopup.width+'px'}; max-width:95vw; ${quotePopup.minimized ? '' : 'height:'+quotePopup.height+'px;'}`"
       @mousemove.window="onPopupDrag(quotePopup, $event); onPopupResize(quotePopup, $event)"
       @mouseup.window="quotePopup.dragging=false; quotePopup.resizing=false;">

    <!-- 타이틀바 -->
    <div class="ec-popup-title" style="justify-content:space-between;"
         @mousedown="startPopupDrag(quotePopup, $event)">
      <div class="flex items-center gap-2">
        <div class="ec-popup-title-icon">
          <span class="material-symbols-outlined" style="font-size:14px;color:#8fabff;">edit_note</span>
        </div>
        <span style="font-size:13px;font-weight:700;letter-spacing:.01em;"
              x-text="editingQuoteId ? '견적 수정' : '새 견적 작성'"></span>
        <span x-show="quoteHeader.siteName" class="text-[11px] font-normal" style="color:rgba(255,255,255,.45);" x-text="'— ' + quoteHeader.siteName"></span>
        <span x-show="quoteHeader.vendorId" class="text-[10px] font-semibold px-2 py-0.5 rounded-full ml-1" style="background:rgba(99,179,237,.3);color:#bfdbfe;" x-text="vendors.find(v=>v.id===quoteHeader.vendorId)?.name||''"></span>
      </div>
      <div class="flex items-center gap-1.5">
        <button class="ec-popup-ctrl-btn" @click.stop="quotePopup.minimized = !quotePopup.minimized" title="최소화">
          <span class="material-symbols-outlined" style="font-size:14px;" x-text="quotePopup.minimized ? 'add' : 'remove'"></span>
        </button>
        <button class="ec-popup-ctrl-btn close" @click.stop="quotePopup.open=false" title="닫기">
          <span class="material-symbols-outlined" style="font-size:14px;">close</span>
        </button>
      </div>
    </div>

    <!-- 본문 -->
    <template x-if="!quotePopup.minimized">
      <div class="ec-popup-body" style="padding:0;display:flex;overflow:hidden;">
        <!-- 왼쪽 70%: 입력/미리보기 -->
        <div style="flex:7;min-width:0;overflow-y:auto;display:flex;flex-direction:column;">

          <!-- 탭 바 -->
          <div style="display:flex;border-bottom:2px solid #e5e7eb;background:#fff;padding:0 16px;position:sticky;top:0;z-index:10;">
            <button @click.stop="quotePopup.tab='form'"
              style="padding:9px 18px;font-size:12px;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s;display:flex;align-items:center;gap:5px;"
              :style="quotePopup.tab==='form' ? 'color:#4f6ef7;border-bottom-color:#4f6ef7;' : 'color:#9ca3af;'">
              <span class="material-symbols-outlined" style="font-size:14px;">edit_note</span> 입력
            </button>
            <button @click.stop="quotePopup.tab='preview'"
              style="padding:9px 18px;font-size:12px;font-weight:600;border:none;background:none;cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-2px;transition:all .15s;display:flex;align-items:center;gap:5px;"
              :style="quotePopup.tab==='preview' ? 'color:#4f6ef7;border-bottom-color:#4f6ef7;' : 'color:#9ca3af;'">
              <span class="material-symbols-outlined" style="font-size:14px;">preview</span> 미리보기
            </button>
          </div>

          <!-- ═══ 입력 탭 ═══ -->
          <div x-show="quotePopup.tab === 'form'" style="padding:14px 16px;flex:1;">
            <div class="space-y-4">

              <!-- 견적 정보 헤더 (컴팩트 2행) -->
              <div style="padding:10px 14px;background:#f8faff;border:1px solid #e5eaf4;border-radius:10px;">
                <div style="display:grid;grid-template-columns:1.2fr 1fr 1fr 0.8fr;gap:8px;margin-bottom:6px;">
                  <div>
                    <label class="label-base" style="color:#1d4ed8;font-weight:700;font-size:10px;">거래처</label>
                    <select x-model="quoteHeader.vendorId" @change="onVendorSelect()" class="input-base" style="font-weight:600;font-size:12px;">
                      <option value="">-- 선택 --</option>
                      <template x-for="v in vendors" :key="v.id">
                        <option :value="v.id" x-text="v.name"></option>
                      </template>
                    </select>
                  </div>
                  <div>
                    <label class="label-base" style="font-size:10px;">현장명</label>
                    <input x-model="quoteHeader.siteName" class="input-base" style="font-size:12px;" placeholder="현장명">
                  </div>
                  <div>
                    <label class="label-base" style="font-size:10px;">견적명</label>
                    <input x-model="quoteHeader.quoteName" class="input-base" style="font-size:12px;" placeholder="견적명">
                  </div>
                  <div>
                    <label class="label-base" style="font-size:10px;">견적일</label>
                    <input type="date" x-model="quoteHeader.quoteDate" class="input-base" style="font-size:12px;">
                  </div>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
                  <div>
                    <label class="label-base" style="font-size:10px;">현장담당자</label>
                    <input x-model="quoteHeader.manager" class="input-base" style="font-size:12px;" placeholder="현장 담당자명">
                  </div>
                  <div>
                    <label class="label-base" style="font-size:10px;">거래처 담당자</label>
                    <input x-model="quoteHeader.vendorManager" class="input-base" style="font-size:12px;" placeholder="거래처 담당자명">
                  </div>
                </div>
              </div>

              <!-- ═══ 품목 인라인 테이블 ═══ -->
              <div style="border:1px solid #e5e7eb;border-radius:10px;overflow:hidden;">
                <!-- 테이블 헤더 -->
                <div style="display:grid;grid-template-columns:28px 44px 1.5fr 80px 80px 80px 80px 100px 100px 32px;gap:0;background:#f3f4f6;border-bottom:1px solid #e5e7eb;padding:6px 8px;font-size:10px;font-weight:700;color:#6b7280;">
                  <span style="text-align:center;">#</span>
                  <span style="text-align:center;">순서</span>
                  <span>품목명</span>
                  <span>단위</span>
                  <span>가로(mm)</span>
                  <span>세로(mm)</span>
                  <span style="text-align:right;">수량</span>
                  <span style="text-align:right;">단가</span>
                  <span style="text-align:right;">금액</span>
                  <span></span>
                </div>

                <!-- 기존 항목 행 -->
                <template x-for="(item, idx) in quoteItems" :key="idx">
                  <div>
                    <!-- 메인 행 -->
                    <div style="display:grid;grid-template-columns:28px 44px 1.5fr 80px 80px 80px 80px 100px 100px 32px;gap:0;padding:4px 8px;border-bottom:1px solid #f0f1f3;align-items:center;font-size:12px;"
                         :style="inlineEdit.accordionRow === idx ? 'background:#f0f5ff;' : ''"
                         @click="inlineEdit.accordionRow = (inlineEdit.accordionRow === idx ? -1 : idx)">
                      <span style="text-align:center;color:#9ca3af;font-size:11px;" x-text="idx+1"></span>
                      <!-- 순서 변경 ▲▼ -->
                      <div style="display:flex;flex-direction:column;align-items:center;gap:0;" @click.stop>
                        <button @click="if(idx>0){const t=quoteItems[idx];quoteItems.splice(idx,1);quoteItems.splice(idx-1,0,t);if(inlineEdit.accordionRow===idx)inlineEdit.accordionRow=idx-1;}"
                          :style="idx===0?'opacity:.2;cursor:default;':'cursor:pointer;'"
                          style="border:none;background:none;padding:0;line-height:1;color:#9ca3af;font-size:11px;"
                          onmouseover="this.style.color='#4f6ef7'" onmouseout="this.style.color='#9ca3af'">▲</button>
                        <button @click="if(idx<quoteItems.length-1){const t=quoteItems[idx];quoteItems.splice(idx,1);quoteItems.splice(idx+1,0,t);if(inlineEdit.accordionRow===idx)inlineEdit.accordionRow=idx+1;}"
                          :style="idx===quoteItems.length-1?'opacity:.2;cursor:default;':'cursor:pointer;'"
                          style="border:none;background:none;padding:0;line-height:1;color:#9ca3af;font-size:11px;"
                          onmouseover="this.style.color='#4f6ef7'" onmouseout="this.style.color='#9ca3af'">▼</button>
                      </div>
                      <span style="font-weight:600;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" x-text="item.name"></span>
                      <span style="color:#6b7280;font-size:11px;" x-text="item.categoryType === 'SIZE' ? '㎡' : item.categoryType === 'LENGTH' ? 'm' : '개'"></span>
                      <span style="color:#6b7280;" x-text="item.widthMm || '-'"></span>
                      <span style="color:#6b7280;" x-text="item.heightMm || '-'"></span>
                      <span style="text-align:right;color:#374151;" x-text="(item.qty||1)"></span>
                      <span style="text-align:right;color:#1d4ed8;font-weight:600;" x-text="(item.unitPrice||0).toLocaleString()"></span>
                      <span style="text-align:right;font-weight:700;color:#374151;" x-text="(item.amount||0).toLocaleString()"></span>
                      <button @click.stop="quoteItems.splice(idx, 1); if(inlineEdit.accordionRow===idx) inlineEdit.accordionRow=-1;"
                        style="width:20px;height:20px;border:none;background:none;cursor:pointer;color:#d1d5db;font-size:14px;display:flex;align-items:center;justify-content:center;border-radius:4px;"
                        onmouseover="this.style.color='#ef4444';this.style.background='#fef2f2'" onmouseout="this.style.color='#d1d5db';this.style.background='none'">×</button>
                    </div>

                    <!-- 아코디언 (옵션/매입 정보) -->
                    <div x-show="inlineEdit.accordionRow === idx" x-transition
                      style="padding:10px 16px 10px 40px;background:#f8faff;border-bottom:1px solid #e5eaf4;">
                      <div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">

                        <!-- 왼쪽: 규격/옵션 편집 -->
                        <div>
                          <p style="font-size:10px;font-weight:700;color:#4f6ef7;margin-bottom:6px;">규격 / 옵션</p>
                          <div class="space-y-2">
                            <!-- 규격 수정 (면적형/길이형) -->
                            <div x-show="item.categoryType === 'SIZE' || item.categoryType === 'LENGTH'" class="flex gap-2">
                              <div>
                                <label class="text-[10px] text-gray-500">가로(mm)</label>
                                <input type="number" :value="item.widthMm" @change="item.widthMm=Number($el.value); recalcInlineItem(idx)" class="input-base py-1 text-xs" style="width:80px;">
                              </div>
                              <div>
                                <label class="text-[10px] text-gray-500">세로(mm)</label>
                                <input type="number" :value="item.heightMm" @change="item.heightMm=Number($el.value); recalcInlineItem(idx)" class="input-base py-1 text-xs" style="width:80px;">
                              </div>
                              <div>
                                <label class="text-[10px] text-gray-500">수량</label>
                                <input type="number" :value="item.qty" min="1" @change="item.qty=Number($el.value)||1; recalcInlineItem(idx)" class="input-base py-1 text-xs" style="width:60px;">
                              </div>
                            </div>
                            <!-- 수동 단가 수정 -->
                            <div x-show="item.manualPrice || item.categoryType === 'QTY' || item.categoryType === 'FIXED'" class="flex gap-2">
                              <div>
                                <label class="text-[10px] text-gray-500">단가(원)</label>
                                <input type="number" :value="item.unitPrice" @change="item.unitPrice=Number($el.value); item.amount=item.unitPrice*(item.qty||1);" class="input-base py-1 text-xs" style="width:100px;">
                              </div>
                              <div>
                                <label class="text-[10px] text-gray-500">수량</label>
                                <input type="number" :value="item.qty" min="1" @change="item.qty=Number($el.value)||1; item.amount=item.unitPrice*(item.qty||1);" class="input-base py-1 text-xs" style="width:60px;">
                              </div>
                            </div>
                            <!-- 옵션 체크박스 -->
                            <template x-if="(options||[]).filter(o=>(o.categoryIds||[]).includes(item.categoryId)).length > 0">
                              <div style="padding:6px 8px;background:#faf8ff;border:1px solid #e5e0f0;border-radius:6px;">
                                <p style="font-size:10px;font-weight:600;color:#7c3aed;margin-bottom:4px;">옵션</p>
                                <div class="space-y-1.5">
                                  <template x-for="opt in (options||[]).filter(o=>(o.categoryIds||[]).includes(item.categoryId))" :key="opt.id">
                                    <div>
                                      <label class="flex items-center gap-2 text-xs cursor-pointer">
                                        <input type="checkbox" :checked="(item.selectedOptions||[]).includes(opt.id)"
                                          @change="
                                            if($el.checked) { if(!item.selectedOptions) item.selectedOptions=[]; item.selectedOptions.push(opt.id); if(!item.optionQtys) item.optionQtys={}; item.optionQtys[opt.id]=1; }
                                            else { item.selectedOptions=(item.selectedOptions||[]).filter(id=>id!==opt.id); }
                                            recalcInlineItem(idx);
                                          " class="w-3.5 h-3.5">
                                        <span x-text="opt.name" class="text-gray-700"></span>
                                        <span x-show="(opt.pricingType||'fixed')==='fixed'" class="text-gray-400" x-text="'(' + (opt.price||0).toLocaleString() + '원)'"></span>
                                        <span x-show="opt.pricingType==='perSqm'" class="text-blue-500" x-text="'(' + (opt.price||0).toLocaleString() + '원/㎡)'"></span>
                                        <span x-show="opt.pricingType==='variants'" class="text-amber-600">(규격선택)</span>
                                        <!-- 수량 (perSqm 아닌 경우) -->
                                        <input x-show="(item.selectedOptions||[]).includes(opt.id) && opt.pricingType!=='perSqm'" type="number"
                                          :value="(item.optionQtys||{})[opt.id]||1" min="1"
                                          @change="if(!item.optionQtys)item.optionQtys={}; item.optionQtys[opt.id]=Number($el.value)||1; recalcInlineItem(idx);"
                                          @click.stop class="input-base py-0.5 text-xs" style="width:50px;" placeholder="수량">
                                        <!-- 규격선택형 옵션 -->
                                        <select x-show="(item.selectedOptions||[]).includes(opt.id) && opt.pricingType==='variants'"
                                          :value="(item.optionVariants||{})[opt.id] ?? 0"
                                          @change="if(!item.optionVariants)item.optionVariants={}; item.optionVariants[opt.id]=Number($el.value); recalcInlineItem(idx);"
                                          @click.stop class="input-base py-0.5 text-xs" style="width:120px;">
                                          <template x-for="(v, vi) in (opt.variants||[])" :key="vi">
                                            <option :value="vi" x-text="v.label + ' (' + Number(v.price).toLocaleString() + '원)'"></option>
                                          </template>
                                        </select>
                                      </label>
                                      <!-- perSqm 옵션: 면적 오버라이드 -->
                                      <div x-show="(item.selectedOptions||[]).includes(opt.id) && opt.pricingType==='perSqm'"
                                        style="margin-left:22px;margin-top:3px;" @click.stop>
                                        <button type="button"
                                          @click="if(!item.optionAreas)item.optionAreas={}; if(!item.optionAreas[opt.id])item.optionAreas[opt.id]={useCustom:false,widthMm:item.widthMm,heightMm:item.heightMm}; item.optionAreas[opt.id].useCustom=!item.optionAreas[opt.id].useCustom; recalcInlineItem(idx)"
                                          :class="(item.optionAreas||{})[opt.id]&&(item.optionAreas||{})[opt.id].useCustom ? 'bg-orange-100 text-orange-700 border-orange-300' : 'bg-gray-100 text-gray-500 border-gray-300'"
                                          class="text-[10px] px-2 py-0.5 rounded border font-medium">범위 수정</button>
                                        <template x-if="(item.optionAreas||{})[opt.id]&&(item.optionAreas||{})[opt.id].useCustom">
                                          <div class="flex items-center gap-1 mt-1">
                                            <input type="number" placeholder="가로"
                                              :value="((item.optionAreas||{})[opt.id]||{}).widthMm||0"
                                              @input="if(!item.optionAreas)item.optionAreas={}; item.optionAreas[opt.id]={...(item.optionAreas[opt.id]||{}),widthMm:Number($el.value)||0}; recalcInlineItem(idx)"
                                              class="input-base w-16 py-0.5 text-xs">
                                            <span class="text-gray-400 text-xs">×</span>
                                            <input type="number" placeholder="세로"
                                              :value="((item.optionAreas||{})[opt.id]||{}).heightMm||0"
                                              @input="if(!item.optionAreas)item.optionAreas={}; item.optionAreas[opt.id]={...(item.optionAreas[opt.id]||{}),heightMm:Number($el.value)||0}; recalcInlineItem(idx)"
                                              class="input-base w-16 py-0.5 text-xs">
                                            <span class="text-[10px] text-blue-500" x-text="'= '+((((item.optionAreas||{})[opt.id]||{}).widthMm||0)/1000*(((item.optionAreas||{})[opt.id]||{}).heightMm||0)/1000).toFixed(4)+'㎡'"></span>
                                          </div>
                                        </template>
                                        <span x-show="!((item.optionAreas||{})[opt.id]&&(item.optionAreas||{})[opt.id].useCustom)" class="text-[10px] text-gray-400 ml-2"
                                          x-text="'상품과 동일 ('+((item.widthMm||0)/1000*(item.heightMm||0)/1000).toFixed(4)+'㎡)'"></span>
                                      </div>
                                    </div>
                                  </template>
                                </div>
                              </div>
                            </template>
                          </div>
                        </div>

                        <!-- 오른쪽: 매입 정보 -->
                        <div>
                          <p style="font-size:10px;font-weight:700;color:#16a34a;margin-bottom:6px;">매입 정보</p>
                          <div class="space-y-2">
                            <div class="flex gap-2">
                              <div class="flex-1">
                                <label class="text-[10px] text-gray-500">매입처</label>
                                <input x-model="item.supplier" class="input-base py-1 text-xs" placeholder="업체명" @click.stop>
                              </div>
                              <div style="width:100px;">
                                <label class="text-[10px] text-gray-500">매입단가</label>
                                <input type="number" x-model="item.purchasePrice" class="input-base py-1 text-xs" placeholder="0" @click.stop>
                              </div>
                            </div>
                            <div x-show="(item.purchasePrice||0) > 0" class="text-xs">
                              <span class="text-gray-500">매입합계:</span>
                              <span class="font-semibold text-gray-700" x-text="((item.purchasePrice||0)*(item.qty||1)).toLocaleString()+'원'"></span>
                              <span class="ml-2 text-gray-500">마진:</span>
                              <span class="font-semibold"
                                :class="(item.amount||0)-(item.purchasePrice||0)*(item.qty||1) >= 0 ? 'text-green-600' : 'text-red-500'"
                                x-text="((item.amount||0)-(item.purchasePrice||0)*(item.qty||1)).toLocaleString()+'원'"></span>
                            </div>
                            <div>
                              <label class="text-[10px] text-gray-500">메모</label>
                              <input x-model="item.purchaseMemo" class="input-base py-1 text-xs" placeholder="매입 메모" @click.stop>
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                </template>

                <!-- ═══ 새 행 추가 영역 ═══ -->
                <div style="display:grid;grid-template-columns:28px 44px 1.5fr 80px 80px 80px 80px 100px 100px 32px;gap:0;padding:4px 8px;background:#f0fdf4;border-bottom:1px solid #bbf7d0;align-items:center;">
                  <span style="text-align:center;color:#16a34a;font-size:14px;">+</span>
                  <span></span><!-- 순서 컬럼 빈칸 -->
                  <!-- 품목 검색 드롭다운 -->
                  <div class="relative" @click.stop>
                    <input type="text" x-model="newRow.catSearch"
                      @focus="newRow.catOpen = true; newRow.catHighlight = -1"
                      @click="newRow.catOpen = true"
                      @input="newRow.catOpen = true; newRow.catHighlight = 0"
                      @keydown.escape="newRow.catOpen = false"
                      @keydown.arrow-down.prevent="
                        const list = newRow.catSearch ? categories.filter(c=>c.name.toLowerCase().includes(newRow.catSearch.toLowerCase())) : categories;
                        if(!newRow.catOpen){newRow.catOpen=true;newRow.catHighlight=0;}
                        else if(newRow.catHighlight < list.length-1){newRow.catHighlight++;}
                      "
                      @keydown.arrow-up.prevent="if(newRow.catHighlight>0)newRow.catHighlight--;"
                      @keydown.enter.prevent="
                        const list = newRow.catSearch ? categories.filter(c=>c.name.toLowerCase().includes(newRow.catSearch.toLowerCase())) : categories;
                        if(newRow.catHighlight>=0 && newRow.catHighlight<list.length){
                          selectNewRowCategory(list[newRow.catHighlight]);
                        } else if(list.length===1){
                          selectNewRowCategory(list[0]);
                        }
                      "
                      placeholder="품목 검색..."
                      class="input-base py-1 text-xs" style="border-color:#86efac;" autocomplete="off">
                    <div x-show="newRow.catOpen" @click.outside="newRow.catOpen=false"
                      class="absolute left-0 right-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg max-h-44 overflow-y-auto" style="z-index:1200;min-width:200px;">
                      <template x-for="(c,ci) in (newRow.catSearch ? categories.filter(cc=>cc.name.toLowerCase().includes(newRow.catSearch.toLowerCase())) : categories)" :key="c.id">
                        <div @click="selectNewRowCategory(c)" @mouseenter="newRow.catHighlight=ci"
                          class="px-3 py-1.5 cursor-pointer text-xs text-gray-700"
                          :class="newRow.catHighlight===ci ? 'bg-blue-100 font-semibold text-blue-700' : 'hover:bg-gray-50'"
                          x-text="c.name"></div>
                      </template>
                      <div x-show="(newRow.catSearch ? categories.filter(cc=>cc.name.toLowerCase().includes(newRow.catSearch.toLowerCase())) : categories).length===0"
                        class="px-3 py-2 text-xs text-gray-400 text-center">검색 결과 없음</div>
                    </div>
                  </div>
                  <!-- 단위 -->
                  <select x-model="newRow.unitType" class="input-base py-1 text-xs" style="border-color:#86efac;" @click.stop>
                    <option value="area">㎡</option>
                    <option value="qty">개</option>
                    <option value="length">m</option>
                  </select>
                  <!-- 가로 -->
                  <input type="number" x-model="newRow.widthMm" class="input-base py-1 text-xs" style="border-color:#86efac;" placeholder="가로" @click.stop>
                  <!-- 세로 -->
                  <input type="number" x-model="newRow.heightMm" class="input-base py-1 text-xs" style="border-color:#86efac;" placeholder="세로" @click.stop>
                  <!-- 수량 -->
                  <input type="number" x-model="newRow.qty" min="1" class="input-base py-1 text-xs" style="text-align:right;border-color:#86efac;" @click.stop>
                  <!-- 단가 (수동 입력 시) -->
                  <input type="number" x-model="newRow.manualUnitPrice" class="input-base py-1 text-xs" style="text-align:right;border-color:#86efac;" placeholder="단가" @click.stop>
                  <!-- 추가 버튼 -->
                  <button @click="addInlineItem()"
                    :disabled="!newRow.categoryId"
                    style="background:#16a34a;color:#fff;border:none;border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;cursor:pointer;"
                    :style="!newRow.categoryId ? 'opacity:.4;cursor:not-allowed;' : ''">
                    추가
                  </button>
                  <span></span>
                </div>

                <!-- 합계 바 -->
                <div style="display:grid;grid-template-columns:28px 44px 1.5fr 80px 80px 80px 80px 100px 100px 32px;gap:0;padding:8px 8px;background:#f9fafb;font-size:12px;font-weight:700;">
                  <span></span>
                  <span></span>
                  <span style="color:#6b7280;">합계 (<span x-text="quoteItems.length"></span>건)</span>
                  <span></span><span></span><span></span><span></span>
                  <span></span>
                  <span style="text-align:right;color:#1d4ed8;" x-text="quoteTotals.supplyTotal.toLocaleString() + '원'"></span>
                  <span></span>
                </div>
              </div>

              <!-- 합계 통계 카드 -->
              <div x-show="quoteItems.length > 0" class="grid grid-cols-4 gap-2">
                <div class="stat-card">
                  <p class="stat-label">공급가 (매출)</p>
                  <p class="stat-value text-sm" x-text="quoteTotals.supplyTotal.toLocaleString() + '원'"></p>
                </div>
                <div class="stat-card">
                  <p class="stat-label">매입 합계</p>
                  <p class="stat-value text-sm" x-text="quoteTotals.purchaseTotal.toLocaleString() + '원'"></p>
                </div>
                <div class="stat-card" :style="quoteTotals.margin >= 0 ? 'background:#f0fdf4;border-color:#bbf7d0' : 'background:#fef2f2;border-color:#fecaca'">
                  <p class="stat-label" :style="quoteTotals.margin >= 0 ? 'color:#16a34a' : 'color:#dc2626'">마진</p>
                  <p class="stat-value text-sm" :style="quoteTotals.margin >= 0 ? 'color:#15803d' : 'color:#b91c1c'" x-text="quoteTotals.margin.toLocaleString() + '원'"></p>
                  <p class="text-xs font-semibold" :style="quoteTotals.margin >= 0 ? 'color:#22c55e' : 'color:#ef4444'" x-show="quoteTotals.supplyTotal > 0" x-text="(quoteTotals.margin / quoteTotals.supplyTotal * 100).toFixed(1) + '%'"></p>
                </div>
                <div class="stat-card" style="background:linear-gradient(135deg,#eff6ff,#dbeafe);border-color:#93c5fd;">
                  <p class="stat-label" style="color:#2563eb;">합계 (VAT 포함)</p>
                  <p class="stat-value text-base" style="color:#1d4ed8;" x-text="quoteTotals.grandTotal.toLocaleString() + '원'"></p>
                </div>
              </div>

            </div>
          </div><!-- /입력 탭 -->

          <!-- ═══ 미리보기 탭 (A4 견적서) ═══ -->
          <div x-show="quotePopup.tab === 'preview'" style="flex:1;overflow-y:auto;background:#e8ecf0;padding:20px;display:flex;justify-content:center;">
            <!-- A4 용지 -->
            <div style="width:210mm;max-width:100%;background:#fff;box-shadow:0 2px 20px rgba(0,0,0,.15);padding:20mm 15mm;font-family:'Malgun Gothic','맑은 고딕',sans-serif;min-height:297mm;">
              <!-- 상단: 회사명 + 견적서 -->
              <div style="text-align:center;margin-bottom:10mm;">
                <h1 style="font-size:24pt;font-weight:900;letter-spacing:2px;color:#1a1d23;margin:0;">견 적 서</h1>
                <div style="width:60px;height:3px;background:#1d4ed8;margin:8px auto 0;"></div>
              </div>

              <!-- 거래처 정보 -->
              <div style="display:flex;justify-content:space-between;margin-bottom:8mm;font-size:10pt;">
                <div>
                  <table style="border-collapse:collapse;">
                    <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;">거래처</td><td style="padding:2px 0;" x-text="vendors.find(v=>v.id===quoteHeader.vendorId)?.name || '-'"></td></tr>
                    <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;">현장명</td><td style="padding:2px 0;" x-text="quoteHeader.siteName || '-'"></td></tr>
                    <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;">견적명</td><td style="padding:2px 0;" x-text="quoteHeader.quoteName || '-'"></td></tr>
                  </table>
                </div>
                <div style="text-align:right;">
                  <table style="border-collapse:collapse;">
                    <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;">견적일</td><td style="padding:2px 0;" x-text="quoteHeader.quoteDate || '-'"></td></tr>
                    <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;">담당자</td><td style="padding:2px 0;" x-text="quoteHeader.manager || '-'"></td></tr>
                    <tr x-show="quoteHeader.vendorManager"><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;">거래처 담당</td><td style="padding:2px 0;" x-text="quoteHeader.vendorManager || ''"></td></tr>
                    <tr><td style="padding:2px 8px 2px 0;font-weight:700;color:#374151;">공급자</td><td style="padding:2px 0;">대림컴퍼니</td></tr>
                  </table>
                </div>
              </div>

              <!-- 합계 금액 강조 -->
              <div style="background:#f0f5ff;border:2px solid #3b82f6;border-radius:6px;padding:8px 16px;margin-bottom:8mm;display:flex;justify-content:space-between;align-items:center;">
                <span style="font-size:11pt;font-weight:700;color:#1d4ed8;">합계금액 (VAT 포함)</span>
                <span style="font-size:16pt;font-weight:900;color:#1d4ed8;" x-text="quoteTotals.grandTotal.toLocaleString() + ' 원'"></span>
              </div>

              <!-- 품목 테이블 -->
              <table style="width:100%;border-collapse:collapse;font-size:9pt;margin-bottom:6mm;">
                <thead>
                  <tr style="background:#374151;color:#fff;">
                    <th style="padding:6px 4px;border:1px solid #4b5563;width:28px;text-align:center;">No</th>
                    <th style="padding:6px 4px;border:1px solid #4b5563;text-align:left;">품명</th>
                    <th style="padding:6px 4px;border:1px solid #4b5563;text-align:left;width:120px;">규격</th>
                    <th style="padding:6px 4px;border:1px solid #4b5563;text-align:center;width:40px;">단위</th>
                    <th style="padding:6px 4px;border:1px solid #4b5563;text-align:right;width:45px;">수량</th>
                    <th style="padding:6px 4px;border:1px solid #4b5563;text-align:right;width:80px;">단가</th>
                    <th style="padding:6px 4px;border:1px solid #4b5563;text-align:right;width:90px;">금액</th>
                    <th style="padding:6px 4px;border:1px solid #4b5563;text-align:left;width:80px;">비고</th>
                  </tr>
                </thead>
                <tbody>
                  <template x-for="(item, idx) in quoteItems" :key="idx">
                    <tr :style="idx % 2 === 1 ? 'background:#f9fafb;' : ''">
                      <td style="padding:5px 4px;border:1px solid #e5e7eb;text-align:center;" x-text="idx+1"></td>
                      <td style="padding:5px 4px;border:1px solid #e5e7eb;font-weight:600;" x-text="item.name"></td>
                      <td style="padding:5px 4px;border:1px solid #e5e7eb;color:#6b7280;" x-text="item.spec || '-'"></td>
                      <td style="padding:5px 4px;border:1px solid #e5e7eb;text-align:center;" x-text="item.unit || 'ea'"></td>
                      <td style="padding:5px 4px;border:1px solid #e5e7eb;text-align:right;" x-text="(item.qty||1)"></td>
                      <td style="padding:5px 4px;border:1px solid #e5e7eb;text-align:right;" x-text="(item.unitPrice||0).toLocaleString()"></td>
                      <td style="padding:5px 4px;border:1px solid #e5e7eb;text-align:right;font-weight:600;" x-text="(item.amount||0).toLocaleString()"></td>
                      <td style="padding:5px 4px;border:1px solid #e5e7eb;font-size:8pt;color:#6b7280;" x-text="item.remark || ''"></td>
                    </tr>
                  </template>
                </tbody>
                <tfoot>
                  <tr style="background:#f3f4f6;font-weight:700;">
                    <td colspan="6" style="padding:6px 8px;border:1px solid #e5e7eb;text-align:right;">공급가액</td>
                    <td style="padding:6px 4px;border:1px solid #e5e7eb;text-align:right;" x-text="quoteTotals.supplyTotal.toLocaleString()"></td>
                    <td style="border:1px solid #e5e7eb;"></td>
                  </tr>
                  <tr style="font-weight:600;">
                    <td colspan="6" style="padding:4px 8px;border:1px solid #e5e7eb;text-align:right;">부가세(10%)</td>
                    <td style="padding:4px 4px;border:1px solid #e5e7eb;text-align:right;" x-text="Math.round(quoteTotals.supplyTotal * 0.1).toLocaleString()"></td>
                    <td style="border:1px solid #e5e7eb;"></td>
                  </tr>
                  <tr style="background:#1d4ed8;color:#fff;font-weight:800;font-size:10pt;">
                    <td colspan="6" style="padding:8px 8px;border:1px solid #1d4ed8;text-align:right;">합계</td>
                    <td style="padding:8px 4px;border:1px solid #1d4ed8;text-align:right;" x-text="quoteTotals.grandTotal.toLocaleString()"></td>
                    <td style="border:1px solid #1d4ed8;"></td>
                  </tr>
                </tfoot>
              </table>

              <!-- 비고 -->
              <div style="margin-top:10mm;font-size:9pt;color:#6b7280;">
                <p style="font-weight:700;margin-bottom:4px;">비고</p>
                <p>- 상기 견적은 발행일로부터 30일간 유효합니다.</p>
                <p>- 부가세 별도 / 배송비 별도</p>
              </div>
            </div>
          </div><!-- /미리보기 탭 -->

        </div><!-- /왼쪽 -->

        <!-- ═══ 오른쪽 30%: 과거단가 사이드바 (입력 탭일 때만) ═══ -->
        <div x-show="quotePopup.tab === 'form'"
          style="flex:3;flex-shrink:0;border-left:1px solid #e5e7eb;background:#fafbfc;display:flex;flex-direction:column;overflow:hidden;min-width:280px;max-width:380px;">
          <!-- 사이드바 헤더 -->
          <div style="padding:10px 12px;border-bottom:1px solid #e5e7eb;background:linear-gradient(135deg,#f0f5ff,#e8efff);flex-shrink:0;">
            <div style="display:flex;align-items:center;gap:6px;margin-bottom:8px;">
              <span class="material-symbols-outlined" style="font-size:15px;color:#3b82f6;">manage_search</span>
              <span style="font-size:12px;font-weight:700;color:#374151;">과거단가</span>
              <span x-show="pastPriceVendorName" style="font-size:10px;background:#dbeafe;color:#1d4ed8;padding:2px 8px;border-radius:10px;font-weight:600;"
                x-text="pastPriceVendorName"></span>
            </div>
            <div style="display:flex;gap:6px;">
              <input type="text" x-model="pastPriceKeyword" @keydown.enter="searchPastPrices()"
                placeholder="품명 검색 (예: 포맥스 3t)"
                style="flex:1;padding:5px 8px;font-size:11px;border:1px solid #d1d5db;border-radius:6px;outline:none;min-width:0;"
                @focus="$el.style.borderColor='#4f6ef7'" @blur="$el.style.borderColor='#d1d5db'">
              <button @click="searchPastPrices()"
                style="padding:5px 10px;background:#4f6ef7;color:#fff;border:none;border-radius:6px;font-size:10px;font-weight:600;cursor:pointer;white-space:nowrap;">
                검색
              </button>
            </div>
          </div>
          <!-- 과거단가 결과 (스크롤) -->
          <div style="flex:1;overflow-y:auto;">
            <div x-show="!pastPriceSearched && !pastPriceLoading" style="text-align:center;padding:40px 16px;color:#b0b8c4;">
              <span class="material-symbols-outlined" style="font-size:32px;">history</span>
              <p style="font-size:11px;margin-top:10px;line-height:1.6;">품목을 선택하면<br>과거 거래 내역이<br>자동으로 표시됩니다</p>
            </div>
            <div x-show="pastPriceLoading" style="text-align:center;padding:30px;color:#9ca3af;">
              <span class="material-symbols-outlined animate-spin" style="font-size:18px;">progress_activity</span>
            </div>
            <div x-show="!pastPriceLoading && pastPriceSearched && pastPriceResults.length === 0"
              style="text-align:center;padding:30px;color:#9ca3af;">
              <span class="material-symbols-outlined" style="font-size:24px;">search_off</span>
              <p style="font-size:11px;margin-top:4px;">결과 없음</p>
            </div>
            <div x-show="!pastPriceLoading && pastPriceResults.length > 0">
              <template x-for="row in pastPriceResults" :key="row.id">
                <div style="padding:7px 12px;border-bottom:1px solid #f0f1f3;cursor:default;transition:background .1s;"
                  onmouseover="this.style.background='#eff6ff'" onmouseout="this.style.background=''">
                  <div style="display:flex;justify-content:space-between;align-items:baseline;">
                    <span style="font-size:11px;font-weight:600;color:#374151;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:170px;" x-text="row.product_name"></span>
                    <span style="font-size:12px;font-weight:700;color:#1d4ed8;white-space:nowrap;" x-text="row.unit_price.toLocaleString() + '원'"></span>
                  </div>
                  <div style="display:flex;justify-content:space-between;margin-top:2px;">
                    <span style="font-size:10px;color:#9ca3af;" x-text="row.sale_date + (row.raw_spec ? ' · ' + row.raw_spec : '')"></span>
                    <span style="font-size:10px;white-space:nowrap;"
                      :style="row.price_per_sqm ? 'color:#3b82f6;font-weight:500;' : ''"
                      x-text="row.price_per_sqm ? row.price_per_sqm.toLocaleString() + '원/㎡' : ''"></span>
                  </div>
                </div>
              </template>
              <div x-show="pastPriceOthers.length > 0" style="padding:8px 12px;border-top:1px solid #e5e7eb;">
                <button @click="pastPriceShowOthers = !pastPriceShowOthers"
                  style="font-size:10px;color:#6b7280;background:none;border:none;cursor:pointer;display:flex;align-items:center;gap:3px;padding:0;">
                  <span class="material-symbols-outlined" style="font-size:12px;transition:transform .15s;"
                    :style="pastPriceShowOthers ? '' : 'transform:rotate(-90deg)'">expand_more</span>
                  다른 거래처 (<span x-text="pastPriceOthers.length"></span>건)
                </button>
                <template x-if="pastPriceShowOthers">
                  <div style="margin-top:6px;">
                    <template x-for="row in pastPriceOthers" :key="row.id">
                      <div style="padding:4px 0;border-bottom:1px solid #f9fafb;opacity:.7;">
                        <div style="display:flex;justify-content:space-between;">
                          <span style="font-size:10px;color:#6b7280;" x-text="row.vendor"></span>
                          <span style="font-size:10px;font-weight:600;color:#374151;" x-text="row.unit_price.toLocaleString() + '원'"></span>
                        </div>
                        <span style="font-size:9px;color:#9ca3af;" x-text="row.sale_date + (row.raw_spec ? ' · ' + row.raw_spec : '')"></span>
                      </div>
                    </template>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div><!-- /과거단가 사이드바 -->

      </div>
    </template>

    <!-- 팝업 푸터 -->
    <template x-if="!quotePopup.minimized">
      <div class="ec-popup-footer">
        <button @click="saveQuote(); quotePopup.open=false;" class="btn-primary btn-sm">
          <span class="material-symbols-outlined" style="font-size:15px;">save</span> 저장 후 닫기
        </button>
        <button @click="saveQuote()" class="btn-secondary btn-sm">
          <span class="material-symbols-outlined" style="font-size:15px;">save</span> 저장
        </button>
        <button @click="openPrintView()" class="btn-ghost btn-sm">
          <span class="material-symbols-outlined" style="font-size:15px;">print</span> 인쇄
        </button>
        <button @click="exportQuote()" class="btn-ghost btn-sm">
          <span class="material-symbols-outlined" style="font-size:15px;">download</span> 내보내기
        </button>
        <button @click="openMailModal()" class="btn-ghost btn-sm">
          <span class="material-symbols-outlined" style="font-size:15px;">mail</span> 메일
        </button>
        <div style="flex:1;"></div>
        <button @click="quotePopup.open=false" class="btn-ghost btn-sm">닫기</button>
      </div>
    </template>

    <!-- 크기 조절 핸들 -->
    <template x-if="!quotePopup.minimized">
      <div>
        <div class="ec-resize-r" @mousedown.prevent.stop="startPopupResize(quotePopup,'r',$event)"></div>
        <div class="ec-resize-b" @mousedown.prevent.stop="startPopupResize(quotePopup,'b',$event)"></div>
        <div class="ec-resize-br" @mousedown.prevent.stop="startPopupResize(quotePopup,'br',$event)"></div>
      </div>
    </template>
  </div>
</template>
```

- [ ] **Step 4: 테스트 — 기존 견적 열기 + 새 견적 작성**

1. 브라우저에서 새 견적 작성 클릭 → 팝업이 화면 거의 가득 차게 열리는지 확인
2. 기존 견적 클릭 → 항목들이 인라인 테이블에 표시되는지 확인
3. 행 클릭 → 아코디언이 펼쳐지면서 규격/옵션/매입정보가 표시되는지 확인
4. 미리보기 탭 → A4 견적서 양식으로 표시되는지 확인
5. 과거단가 사이드바가 우측에 정상 표시되는지 확인

- [ ] **Step 5: 커밋**

```bash
git add public/index.html
git commit -m "feat: redesign quote popup - fullscreen layout, inline table, A4 preview"
```

---

### Task 4: 인라인 품목 추가/편집 JS 메서드

**Files:**
- Modify: `public/index.html` (Alpine.js methods 영역)

새 인라인 편집 방식에 필요한 JS 메서드 추가.

- [ ] **Step 1: selectNewRowCategory 메서드 추가**

`index.html`의 `searchPastPrices()` 메서드 바로 위에 추가:

```javascript
selectNewRowCategory(cat) {
  this.newRow.categoryId = cat.id;
  this.newRow.catSearch = cat.name;
  this.newRow.catOpen = false;
  this.newRow.categoryType = cat.pricingType || 'QTY';
  this.newRow.customName = cat.name;
  // 단위 유형 자동 설정
  if (cat.pricingType === 'SIZE') this.newRow.unitType = 'area';
  else if (cat.pricingType === 'LENGTH') this.newRow.unitType = 'length';
  else this.newRow.unitType = 'qty';
  // 과거단가 자동 검색
  this.pastPriceKeyword = cat.name;
  this.searchPastPrices();
},
```

- [ ] **Step 2: addInlineItem 메서드 추가**

`selectNewRowCategory` 바로 아래에 추가:

```javascript
async addInlineItem() {
  const nr = this.newRow;
  if (!nr.categoryId) return;
  const cat = this.categories.find(c => c.id === nr.categoryId);
  if (!cat) return;

  const catType = nr.categoryType || cat.pricingType || 'QTY';
  let name = nr.customName || cat.name;
  let spec = '';
  let unitPrice = 0;
  let amount = 0;

  if (catType === 'QTY' || catType === 'FIXED' || nr.manualPrice) {
    // 수동 입력
    unitPrice = Number(nr.manualUnitPrice) || 0;
    amount = unitPrice * (Number(nr.qty) || 1);
    spec = nr.customSpec || '';
  } else {
    // 자동 계산 (서버에 요청)
    try {
      const r = await fetch('/api/quote/calculate', {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({
          categoryId: nr.categoryId,
          widthMm: Number(nr.widthMm) || 0,
          heightMm: Number(nr.heightMm) || 0,
          qty: Number(nr.qty) || 1,
          variantIdx: -1,
          optionSelections: [],
          vendorId: this.quoteHeader.vendorId || ''
        })
      });
      if (r.ok) {
        const calc = await r.json();
        amount = calc.totalExVat || 0;
        unitPrice = Math.round(amount / Math.max(1, Number(nr.qty) || 1));
      }
    } catch(e) { console.error('calc error', e); }

    if (catType === 'SIZE') spec = (nr.widthMm||0) + '×' + (nr.heightMm||0) + 'mm';
    else if (catType === 'LENGTH') spec = (nr.heightMm||0) + '×' + (nr.widthMm||0) + 'mm';
  }

  const itemUnit = (catType === 'SIZE' || catType === 'LENGTH') ? 'ea' : (cat.unit || '개');

  this.quoteItems.push({
    name, spec, unit: itemUnit, qty: Number(nr.qty)||1, unitPrice, amount,
    remark: '', supplier: '', purchasePrice: 0, purchaseMemo: '', purchaseImage: '',
    categoryId: nr.categoryId, categoryType: catType,
    widthMm: Number(nr.widthMm)||0, heightMm: Number(nr.heightMm)||0,
    variantIdx: -1,
    selectedOptions: [], optionQtys: {}, optionVariants: {}, optionAreas: {},
    customName: name, customSpec: spec,
    manualPrice: (catType === 'QTY' || catType === 'FIXED'),
    purchaseQuotes: [], designImage: ''
  });

  // 새 행 초기화
  this.newRow = {
    categoryId: '', categoryType: 'QTY', catSearch: '', catOpen: false, catHighlight: -1,
    widthMm: 0, heightMm: 0, qty: 1, unitType: 'area',
    manualPrice: false, manualUnitPrice: 0,
    selectedOptions: [], optionQtys: {}, optionVariants: {},
    customName: '', customSpec: ''
  };

  this.showToast('항목이 추가되었습니다');
},
```

- [ ] **Step 3: recalcInlineItem 메서드 추가**

아코디언에서 규격/수량 변경 시 자동 재계산:

```javascript
async recalcInlineItem(idx) {
  const item = this.quoteItems[idx];
  if (!item) return;
  if (item.manualPrice || item.categoryType === 'QTY' || item.categoryType === 'FIXED') {
    // 수동 입력: amount만 재계산
    item.amount = (item.unitPrice || 0) * (item.qty || 1);
    if (item.categoryType === 'SIZE') item.spec = (item.widthMm||0) + '×' + (item.heightMm||0) + 'mm';
    return;
  }
  try {
    const os = (item.selectedOptions || []).map(id => {
      const a = (item.optionAreas||{})[id];
      return {
        optionId: id,
        qty: (item.optionQtys||{})[id] || 1,
        variantIdx: (item.optionVariants||{})[id] !== undefined ? (item.optionVariants||{})[id] : 0,
        areaOverride: (a && a.useCustom) ? { widthMm: Number(a.widthMm)||0, heightMm: Number(a.heightMm)||0 } : null
      };
    });
    const r = await fetch('/api/quote/calculate', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({
        categoryId: item.categoryId,
        widthMm: Number(item.widthMm) || 0,
        heightMm: Number(item.heightMm) || 0,
        qty: Number(item.qty) || 1,
        variantIdx: item.variantIdx !== undefined ? Number(item.variantIdx) : -1,
        optionSelections: os,
        vendorId: this.quoteHeader.vendorId || ''
      })
    });
    if (r.ok) {
      const calc = await r.json();
      item.amount = calc.totalExVat || 0;
      item.unitPrice = Math.round(item.amount / Math.max(1, item.qty || 1));
      item.remark = calc.optionRemark || '';
      if (item.categoryType === 'SIZE') item.spec = (item.widthMm||0) + '×' + (item.heightMm||0) + 'mm';
      else if (item.categoryType === 'LENGTH') item.spec = (item.heightMm||0) + '×' + (item.widthMm||0) + 'mm';
    }
  } catch(e) { console.error('recalc error', e); }
},
```

- [ ] **Step 4: openQuotePopup 수정 — 센터링 + inlineEdit 초기화**

`openQuotePopup` 메서드(5343줄)에서 팝업 위치와 크기 계산 부분 수정:

기존의 `this.quotePopup.x = Math.max(20, Math.round((window.innerWidth - (this.quotePopup.width||920)) / 2));` 를 아래로 교체 (두 곳 모두):

```javascript
this.quotePopup.width = Math.round(window.innerWidth * 0.95);
this.quotePopup.height = Math.round(window.innerHeight * 0.9);
this.quotePopup.x = Math.round(window.innerWidth * 0.025);
this.quotePopup.y = Math.round(window.innerHeight * 0.05);
```

그리고 `this.quotePopup.open = true;` 바로 위에 추가:

```javascript
this.inlineEdit = { activeRow: -1, accordionRow: -1 };
this.newRow = { categoryId: '', categoryType: 'QTY', catSearch: '', catOpen: false, catHighlight: -1, widthMm: 0, heightMm: 0, qty: 1, unitType: 'area', manualPrice: false, manualUnitPrice: 0, selectedOptions: [], optionQtys: {}, optionVariants: {}, customName: '', customSpec: '' };
```

- [ ] **Step 5: 테스트**

1. 새 견적 → 품목 검색 → 추가 → 행이 테이블에 나타나는지
2. 행 클릭 → 아코디언 펼침 → 규격 수정 → 단가 재계산
3. 기존 견적 열기 → 항목 편집 가능 여부
4. 저장 → 정상 저장 확인

- [ ] **Step 6: 커밋**

```bash
git add public/index.html
git commit -m "feat: add inline item editing methods (add, recalc, category select)"
```

---

### Task 5: itemEditPopup 제거

**Files:**
- Modify: `public/index.html:800-1170` (itemEditPopup HTML 제거)
- Modify: `public/index.html` (관련 JS 메서드를 주석처리 또는 제거)

기존 itemEditPopup은 더 이상 사용하지 않으므로 제거.

- [ ] **Step 1: itemEditPopup HTML 블록 제거**

`index.html` 800~1170줄의 itemEditPopup 관련 HTML 전체를 제거:

시작: `<!-- ════════════════════════════════════════════` (800줄 — "이카운트 스타일 팝업 ③ : 견적 항목 편집")
끝: 해당 `</template>` 닫는 태그까지 (1170줄 근처)

> **주의:** 기존 `openItemEdit`, `saveItemEdit`, `itemEditRecalc` 메서드는 주석 처리만 해둔다 (완전 삭제는 안정화 후).

- [ ] **Step 2: 기존 항목 추가 섹션의 openItemEdit 참조 제거**

기존 "항목 추가" 섹션 (486~569줄)은 Task 3에서 이미 교체됨. 만약 잔여 `openItemEdit` 참조가 있으면 제거.

- [ ] **Step 3: 테스트**

1. 견적 팝업 열기 → itemEditPopup이 더 이상 뜨지 않는지 확인
2. 인라인 테이블에서 항목 추가/편집이 정상 작동하는지 확인
3. 기존 견적 열기 → 기존 데이터가 정상 표시되는지 확인

- [ ] **Step 4: 커밋**

```bash
git add public/index.html
git commit -m "refactor: remove itemEditPopup (replaced by inline editing)"
```

---

### Task 6: 배포 + 최종 테스트

**Files:** 없음 (서버 배포 작업)

로컬 PC에서 테스트가 완료되면 서버 PC(192.168.0.133)에 배포.

- [ ] **Step 1: 서버 PC에 파일 복사**

아래 파일들을 서버 PC `D:\price-list-app\`에 복사:
- `db-sales-history.js`
- `public/index.html`
- `public/tab-sales-lookup.html`

복사 방법: 공유 폴더 또는 USB.

- [ ] **Step 2: 서버 재시작**

서버 PC 터미널에서:
```bash
cd D:\price-list-app
node server.js
```

- [ ] **Step 3: 최종 테스트 체크리스트**

1. ✅ 과거단가조회 탭에서 `포맥스 3t` 검색 → 결과 표시
2. ✅ 새 견적 작성 → 전체화면 팝업 열림
3. ✅ 거래처 선택 → 현장명, 견적일 입력
4. ✅ 품목 검색 → 추가 → 테이블에 행 추가
5. ✅ 행 클릭 → 아코디언 (규격/옵션/매입) 편집
6. ✅ 저장 → 정상 저장
7. ✅ 기존 견적 열기 → 모든 항목 정상 표시 + 편집 가능
8. ✅ 미리보기 탭 → A4 견적서 양식 표시
9. ✅ 과거단가 사이드바 → 검색 동작

- [ ] **Step 4: 커밋 (배포 완료)**

```bash
git add -A
git commit -m "chore: deploy v5.1 quote input redesign"
```

---

## 참고: 기존 코드 위치 요약

| 코드 블록 | 위치 (index.html 줄 번호) |
|-----------|--------------------------|
| quotePopup HTML | 376~798 |
| itemEditPopup HTML | 800~1170 |
| quotePopup 초기 데이터 | ~5281 |
| itemEditPopup 초기 데이터 | ~5291 |
| openQuotePopup() | 5343 |
| openItemEdit() | 6529 |
| itemEditRecalc() | 6579 |
| saveItemEdit() | 6604 |
| searchPastPrices() | 6673 |
| saveQuote() | 6697 |
| onCategoryChange() | ~6331 |
| pastPrice 관련 데이터 | quotePopup 아래 |
