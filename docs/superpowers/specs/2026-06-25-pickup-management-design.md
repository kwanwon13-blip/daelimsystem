# 픽업관리 (Pickup Management) — 1차 설계서

- 작성일: 2026-06-25
- 상태: 설계 확정 (구현 전)
- 대상: 경영관리팀(요청 등록) + 납품팀(현장 수거 체크)

---

## 1. 목적 / 한 줄 정의

> **경영관리팀이 각자 "어디서 / 무엇을 / 언제 가져와줘"를 등록하면, 날짜별·업체별로 자동 취합되어 하루 픽업표가 되고, 납품팀이 품목 하나하나 수거 여부를 체크하는 시스템.**

핵심 원칙: **"요청은 사람별로 등록하지만, 실행은 날짜 + 업체 기준으로 본다."**

현재는 직원 각자가 카카오톡에 픽업할 물건을 정리해 올리고 있어 취합·누락방지·완료추적이 안 된다. 이를 ERP 기능으로 구조화한다.

---

## 2. 확정된 결정사항 (브레인스토밍 + 코드정찰 결과)

| # | 결정 | 선택 | 근거 |
|---|------|------|------|
| D1 | 화면 위치 | **독립 새 탭 `pickup`** | 워크플로(4단계 직렬 제작)와 픽업(병렬 수거)은 데이터 모델이 충돌. 섞으면 복잡, 분리하면 회귀위험 0 |
| D2 | 아키텍처 | **하이브리드** — 데이터는 픽업 전용 SQLite, 인프라는 기존 재사용 | 막연한 통합이 아닌 코드근거. `notify()`·권한·지도딥링크·vendors는 함수/미들웨어 단위로 이미 재사용 가능 |
| D3 | 1차 범위 | **등록 + 취합 + 라인체크 + 카톡파싱** | 사장님 "즉시·가벼운 UX". 핵심가치 전부 + 적응장벽 최소 |
| D4 | 납품팀 모바일 | **2차로 분리** | 1차는 PC 라인체크까지. 모바일은 `contacts-mobile.html` 패턴 복제라 2차에 빠르게 |
| D5 | 연락처↔업체등록 통합 | **픽업 출시 후 별도 단계** | 연락처는 JSON 3단계층, 스코프 비대화 방지 |
| D6 | 워크플로→픽업 연동 | **1차 포함 (단방향 최소버전)** | 작업량 작고 사장님이 원함. `sourceJobId` 칸 1개 + 버튼 1개 |
| D7 | 수거완료→워크플로 반영 | **단방향 (출처 링크만)** | 양방향은 workflow.json 쓰기 발생 → 민감코드 회귀, 2차로 |
| D8 | 코스 자동묶기 수준 | **날짜 + vendorId GROUP BY** | FK 있어 "같은 업체 묶기"는 공짜. 동선최적화는 과한 구현, 3차로 |
| D9 | 저장 방식 | **SQLite (better-sqlite3 미설치 시 JSON 폴백 동반)** | 사장님 지시 "새 저장은 무조건 SQLite" |
| D10 | 업체등록 정비 | **1차에 ALTER + 입력UI 같이** | 배포 1회로 끝내기 (스키마 변경 두 번 배포 회피) |
| D11 | 입력 소스 | **1차: 수동 등록 + 카톡 붙여넣기 / 2차: eCount 판매현황(매출)+발주 업로드 import** | eCount Open API는 **매출·매입 거래내역 *조회* API가 없음**(확정 — `docs/ecount-api-manual.md`/`lib/ecount-client.js`, 마스터 조회·전표 등록만 가능). '긁어오기'는 화면 CSV/Excel export→업로드뿐(기존 `매입자동` 패턴). 자동분류는 불가(사람 선별) → **1차 데이터모델을 import 호환 설계**, 본 기능은 2차. 상세 §15 |

---

## 3. 아키텍처 — 하이브리드 (재사용 맵)

데이터는 **픽업 전용 신규 SQLite 테이블**로 깨끗하게. 주변 인프라는 **기존 검증된 코드를 호출/복사**한다. `workflow.json`은 절대 건드리지 않는다.

| 픽업에 필요한 것 | 재사용 출처 | 방법 |
|---|---|---|
| 매입처 마스터(주소·전화·담당자·지도·픽업메모) | `vendors` 테이블 + `routes/vendors.js` | 컬럼 7개 ALTER 추가, 픽업은 `vendorId` FK 참조만 → **단일 마스터, 이중입력 제거** |
| 등록·추가요청·수거완료 알림 | `utils/notify.js` `notify(userId,type,msg,link)` | 라우트에서 직접 호출. 실시간은 기존 30초 폴링 유지 |
| 지도 길찾기(카카오/T맵/네이버) | `contacts-mobile.html` `openMap(q,route)` 딥링크 | vendors에 주소·지도검색어(중립정보)만 저장 → 렌더 시 3버튼 자동생성 |
| 회사별 담당자 자동수신 | `DEFAULT_COMPANY_MANAGERS` / `managerNameForCompany()` | 픽업용 함수로 **복사·개작**(workflow-notify-recipients는 stageId 전제라 import 금지) |
| 탭 노출 + 권한 게이트 | `index.html` allMenus/getTabs/menuGroups + `middleware/auth.js` requireAuth + `req.user.permissions[]` | 신규 탭·권한 배선 |
| DB CRUD·JSON폴백·감사로그 | `db-sqlite.js` 템플릿 + `db.js` 폴백 + `routes/vendors.js` 구조 + `auditLog` | `routes/pickup.js`에 동일 패턴 이식 |
| 카톡 파싱 / 공유텍스트 | 신규 (재사용처 없음) | 순수함수 + TDD |

**금지:** 워크플로 데이터레이어(`workflow.json`, `stageChecks`, `saveStore()`) 재사용. 픽업을 여기 얹으면 (a) SQLite 지시 위반 (b) 섀도이관 중 민감코드 회귀 (c) 4단계↔6상태 억지매핑.

---

## 4. 데이터 모델 (SQLite)

> 인코딩 규약: 상태/우선순위는 **영문 코드**로 저장하고 UI에서 한글 라벨로 변환. `vendorType`은 사용자 관리 카테고리라 한글 라벨로 저장.

### 4.1 vendors — 기존 테이블에 컬럼 7개 추가 (ALTER)

기존: `id, name, bizNo, ceo, phone, email, address, note` (db-sqlite.js 66~76줄)
→ 기존 `phone`(대표전화)·`address`는 그대로 재사용. 아래만 신규 추가.

```sql
-- 서버 시작 시 PRAGMA table_info(vendors)로 존재 확인 후 없으면 ALTER (quote_items.meta 마이그레이션 패턴, db-sqlite.js ~127줄)
ALTER TABLE vendors ADD COLUMN vendorType        TEXT    DEFAULT '기타';   -- 매입처/판매처/둘다/기타
ALTER TABLE vendors ADD COLUMN mapSearchKeyword  TEXT    DEFAULT '';       -- 주소로 안 잡힐 때 검색용(예: "라코스 본사")
ALTER TABLE vendors ADD COLUMN contactPerson     TEXT    DEFAULT '';       -- 담당자명(대표 ceo와 별개)
ALTER TABLE vendors ADD COLUMN contactPhone      TEXT    DEFAULT '';       -- 담당자 연락처
ALTER TABLE vendors ADD COLUMN pickupMemo        TEXT    DEFAULT '';       -- "후문 창고", "점심시간 피하기"
ALTER TABLE vendors ADD COLUMN parkingAccessMemo TEXT    DEFAULT '';       -- 주차/출입
ALTER TABLE vendors ADD COLUMN isActive          INTEGER DEFAULT 1;        -- 소프트삭제/사용여부
```

### 4.2 pickup_requests — "누가 / 언제 / 어느 업체에서" 한 건

한 건 = (등록자, 픽업날짜, 업체) 단위. 한 사람이 "#라코스 …  #세원 …" 올리면 업체별로 2건 생성.

```sql
CREATE TABLE IF NOT EXISTS pickup_requests (
  id                TEXT PRIMARY KEY,
  registrarId       TEXT NOT NULL,                    -- 등록 직원(조직관리.users.id)
  registrarName     TEXT,                             -- 표시용 캐시
  pickupDate        TEXT NOT NULL,                    -- 희망 픽업일 YYYY-MM-DD
  vendorId          TEXT NOT NULL,                    -- vendors.id
  vendorName        TEXT,                             -- 표시용 캐시(업체명 변경돼도 이력 보존)
  preferredTimeSlot TEXT    DEFAULT '',               -- "오전" / "오후" / "15시 전" 등 자유
  priority          TEXT    DEFAULT 'normal',         -- normal | urgent | todayMust
  status            TEXT    DEFAULT 'requested',      -- requested|inCourse|completed|partial|notPicked|cancelled (라인에서 롤업)
  sourceType        TEXT    DEFAULT 'manual',         -- manual | workflow | ecount_sale | ecount_order(2차)
  sourceJobId       TEXT    DEFAULT NULL,             -- 워크플로 잡 id (sourceType=workflow일 때)
  sourceRef         TEXT    DEFAULT NULL,             -- 외부 출처 식별자(2차 eCount 전표/행번호, 중복 import 방지) — v1에 미리 추가
  memo              TEXT    DEFAULT '',               -- "바로 공장", "시안", 현장/용도 등 자유
  isLate            INTEGER DEFAULT 0,                -- 마감시각 이후 등록(추가요청 표시)
  requestedAt       TEXT    DEFAULT (datetime('now')),-- 등록시간(자동)
  courseConfirmedAt TEXT    DEFAULT NULL,
  updatedAt         TEXT    DEFAULT (datetime('now')),
  cancelledAt       TEXT    DEFAULT NULL,
  cancelledBy       TEXT    DEFAULT NULL,
  cancelReason      TEXT    DEFAULT '',
  courseId          TEXT    DEFAULT NULL,             -- pickup_courses.id (2차용, 1차 NULL)
  FOREIGN KEY (vendorId) REFERENCES vendors(id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS idx_pickup_req_date   ON pickup_requests(pickupDate);
CREATE INDEX IF NOT EXISTS idx_pickup_req_vendor ON pickup_requests(vendorId);
CREATE INDEX IF NOT EXISTS idx_pickup_req_status ON pickup_requests(status);
CREATE INDEX IF NOT EXISTS idx_pickup_req_source ON pickup_requests(sourceJobId);
```

### 4.3 pickup_items — 요청 안의 품목 줄들 ⭐라인 단위 상태 (핵심)

"라코스 10개 중 8개만 수거"가 정확히 기록되는 곳.

```sql
CREATE TABLE IF NOT EXISTS pickup_items (
  id         TEXT PRIMARY KEY,
  requestId  TEXT NOT NULL,                  -- pickup_requests.id
  lineNo     INTEGER DEFAULT 0,
  itemName   TEXT NOT NULL,
  spec       TEXT    DEFAULT '',             -- 규격/모델
  qty        REAL    DEFAULT 0,
  unit       TEXT    DEFAULT '개',
  status     TEXT    DEFAULT 'requested',    -- requested | pickedUp | notPicked | cancelled
  pickedQty  REAL    DEFAULT NULL,           -- 실제 수거 수량(수량 일부만 가져온 경우)
  failReason TEXT    DEFAULT '',             -- 미수거 사유(부재/재고없음/위치불명/시간부족 등)
  checkedAt  TEXT    DEFAULT NULL,
  checkedBy  TEXT    DEFAULT NULL,
  FOREIGN KEY (requestId) REFERENCES pickup_requests(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_pickup_items_req ON pickup_items(requestId);
```

### 4.4 pickup_courses — 2차용 (1차엔 스키마만 생성, 미사용)

기사/차량/순서 배정 자리. 1차의 "업체별 묶기"는 테이블 없이 `GROUP BY pickupDate, vendorId`로 처리. 배포 1회로 끝내려 칸만 미리 만든다.

```sql
CREATE TABLE IF NOT EXISTS pickup_courses (
  id             TEXT PRIMARY KEY,
  pickupDate     TEXT NOT NULL,
  courseNumber   INTEGER,                    -- 당일 순번(완료코드처럼)
  vendorId       TEXT,
  vendorName     TEXT,
  status         TEXT    DEFAULT 'draft',    -- draft|confirmed|inProgress|completed
  assignedDriver TEXT    DEFAULT '',
  vehicle        TEXT    DEFAULT '',
  sortOrder      INTEGER DEFAULT 0,
  confirmedAt    TEXT    DEFAULT NULL,
  completedAt    TEXT    DEFAULT NULL,
  notes          TEXT    DEFAULT '',
  createdAt      TEXT    DEFAULT (datetime('now')),
  updatedAt      TEXT    DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_pickup_courses_date ON pickup_courses(pickupDate);
```

### 4.5 JSON 폴백 (better-sqlite3 미설치 시)

`db.sql === null`이면 `data/픽업관리.json` = `{ requests:[], items:[], courses:[] }`. `routes/pickup.js`가 `if (db.sql) {…} else {…}` 분기. **단 SQLite가 진짜 타깃**이므로 서버PC `better-sqlite3` 설치 확인. JSON 폴백은 동시쓰기 경합 취약 → 문서에 "픽업은 SQLite 강권" 명시.

---

## 5. 상태 머신

### 5.1 라인(품목) 상태 — `pickup_items.status`
```
requested(요청됨) ──┬─▶ pickedUp(수거완료)      (+ pickedQty 일부면 부분수량)
                    ├─▶ notPicked(미수거)        (+ failReason)
                    └─▶ cancelled(취소)
```

### 5.2 요청 상태 — `pickup_requests.status` (라인에서 자동 롤업, 라인 변경 시 재계산)
- 모든 라인 `cancelled` → **cancelled**
- 취소 제외 전부 `pickedUp` → **completed(수거완료)**
- 일부만 `pickedUp` → **partial(부분수거)**
- 코스 확정됐고 아직 수거 전 → **inCourse(코스포함)**
- 그 외 → **requested(요청됨)**

### 5.3 업체 카드 롤업 (취합 뷰, 읽을 때 계산)
같은 `pickupDate + vendorId`의 모든 요청/라인을 모아 뱃지 표시: `"5개 중 3개 완료"`, `부분`, `미수거` 등.

### 5.4 마감시각 / 추가요청
`설정`에 `pickup.cutoffTime`(기본 `"10:00"`). 오늘 날짜로 그 시각 이후 등록 시 `isLate=1` → 취합 뷰에서 🔴**추가요청** 뱃지. ("출발 후 들어온 건"임을 기록으로 남김.)

---

## 6. API (routes/pickup.js 신규, server.js에 `app.use('/api/pickup', …)` 마운트)

모든 라우트 `router.use(requireAuth)`. **mutation은 권한 분기 필수** (신규 라우트 게이트 규약).

| Method · Path | 권한 | 설명 |
|---|---|---|
| `GET  /api/pickup/requests?date=YYYY-MM-DD` | pickup_view | 날짜별 취합(요청+라인+업체정보 조인). 업체별 그룹 메타 포함 |
| `GET  /api/pickup/requests/mine?date=` | pickup_view | 내가 오늘 등록한 것 |
| `POST /api/pickup/requests` | pickup_register | 요청+라인 생성. `registrarId`=세션, `requestedAt`=now, `isLate` 계산. body: `{pickupDate, vendorId, preferredTimeSlot, priority, memo, sourceType?, sourceJobId?, items:[{itemName,spec,qty,unit}]}` |
| `PUT  /api/pickup/requests/:id` | pickup_register(본인/admin) | 요청·라인 수정 |
| `POST /api/pickup/requests/:id/cancel` | pickup_register(본인/admin) | 소프트 취소(+사유) |
| `PATCH /api/pickup/items/:id/status` | pickup_check | 라인 체크 `{status, pickedQty?, failReason?}` → 요청 롤업 재계산. 완료 시 notify |
| `POST /api/pickup/parse-kakao` | pickup_register | `{text}` → 파싱 후보(저장 아님). 순수함수 `parseKakaoPickup` |
| `GET  /api/pickup/requests/:date/share-text` | pickup_view | 카톡 공유텍스트. 순수함수 `buildShareText` |

- 업체 목록(픽업 등록 셀렉터)은 기존 `GET /api/vendors` 재사용(`isActive=1` 필터). 신규 라우트 불필요.
- 감사로그는 **요청/코스 단위로만**(라인마다 호출 금지 — `auditLog` 동기 write 병목).

---

## 7. 화면 / UI

독립 탭 `pickup` 하나 안에 2개 뷰(서브탭 전환). `public/tab-pickup.html`(마크업) + `index.html` `function app()`(상태/메서드) + SSI INCLUDE 1줄.

### 7.1 Ⓐ 등록 뷰 (경영관리팀)
- **정식 폼:** 픽업날짜 · 업체 선택(vendors) · 희망시간대 · 우선순위 · 품목 줄 추가(품목/규격/수량/단위) · 메모 → 저장. 업체 선택 시 주소·전화·픽업메모 자동 미리보기.
- **카톡 붙여넣기:** 텍스트 붙임 → `POST /parse-kakao` → `#업체` 기준 후보 카드로 분리 표시 → 직원이 업체 매칭/수정 확인 → 일괄 저장.
- **내가 오늘 올린 것** 목록(수정/취소).

### 7.2 Ⓑ 취합·체크 뷰 (납품팀)
- 날짜 선택 → **업체별 카드**로 자동 묶임(여러 사람·여러 요청이 같은 업체면 한 카드).
- 카드 헤더: 업체명 · 주소 · 전화 · **[네이버][카카오][T맵]** 길찾기 · 픽업/주차메모 · 롤업 뱃지 · 🔴추가요청.
- 카드 본문: 품목 체크리스트. 품목마다 ✅수거완료 / ❌미수거(사유) / 🚫취소, 수량 일부면 실수거수량.
- **카톡 공유텍스트 생성** 버튼 → `GET /share-text` → 클립보드 복사.

### 7.3 워크플로 → 픽업 버튼 (D6)
- `tab-workflow.html` 카드/상세에 **"픽업에 추가"** 버튼.
- 클릭 → `app().openPickupFromJob(job)`: 픽업 탭으로 전환 + 등록폼을 잡 정보로 프리필
  - `sourceType:'workflow'`, `sourceJobId: job.id`
  - 품목/메모에 현장·시안명 자동, 직원은 **업체(픽업 장소) + 품목/수량만 확정**.
- 취합 뷰에서 해당 건은 🎨**시안** 뱃지 + **[워크플로 잡 보기]** 링크(`sourceJobId`로 이동). **단방향** — 수거완료는 픽업 쪽에만 기록.

---

## 8. 카톡 파싱 / 공유텍스트 (순수함수 + TDD)

별도 모듈 `routes/lib/pickup-text.js` (또는 유사). 라우트는 이 함수만 호출.

- `parseKakaoPickup(text) -> [{ vendorGuess, memo, items:[{itemName, spec?, qty?}] }]`
  - `#업체` 또는 업체명으로 시작하는 줄을 구분자로 그룹핑. 이어지는 줄을 품목 후보로. 수량/규격 패턴 best-effort 추출. **저장 전 사람이 검토**하는 후보 생성기.
- `buildShareText(date, groupedRequests) -> string`
  - 날짜별·업체별 카톡 친화 텍스트.

먼저 `pickup-text.test.js`로 단위테스트 작성(최근 커밋들의 순수함수 TDD 관행). 다양한 카톡 입력 케이스 + 엣지(빈줄, 업체없는 줄, 수량 누락).

---

## 9. 권한 모델

신규 권한 3개(카탈로그 `allMenus`/권한 목록에 추가):

| 권한 | 의미 |
|---|---|
| `pickup_view` | 픽업 목록/취합 조회 |
| `pickup_register` | 요청 등록·수정·취소 |
| `pickup_check` | 품목 수거 체크 |

ROLE_PRESETS: **경영관리팀** = `[pickup_view, pickup_register]`, **납품팀** = `[pickup_view, pickup_check]`. admin은 전부.

배선 3곳: `index.html` `allMenus`(~6490), `getTabs` getter(~6617, admin 또는 `pickup_view` 보유 시 탭 노출), `menuGroups`('관리' 그룹 vendors 옆). 라우트는 `requireAuth` 후 `req.user.permissions` 직접 체크(vendors.js 패턴). **탭 노출 권한과 데이터 변경 권한은 별개** — 라우트에서 따로 검증.

---

## 10. 알림 (1차 최소)

- 신규 요청 등록 시 **납품팀(`pickup_check` 보유자)** 에게 `notify(userId,'pickup', msg, '/?tab=pickup')`.
- `isLate`(추가요청)는 메시지에 🔴 강조.
- 회사별 담당자 1명 추가수신은 `DEFAULT_COMPANY_MANAGERS` 로직을 **픽업용으로 복사**(`resolvePickupRecipients`, stageId 비의존). 1차는 선택사항 — 우선 역할기반 수신만, 회사담당자 라우팅은 여유되면.
- 실시간 전달은 기존 30초 폴링 그대로(SSE/웹푸시 미구현 유지).

---

## 11. 1차에서 의도적으로 제외 (명시)

- 납품팀 **모바일 전용화면**(`pickup-mobile.html` + 토큰) → **2차** (지도딥링크 이미 존재, 복제만)
- **연락처 ↔ 업체등록 매입처 통합표시(읽기전용)** → 픽업 안정화 후 별도 단계
- 코스 **순서조정 · 동선최적화 · 기사/차량 배정 · 통계 · 미수거 이월** → 2·3차 (`pickup_courses` 스키마만 선반영)
- **수거완료 → 워크플로 양방향 반영** → 2차
- 사진 첨부, 수정이력 → 2차

---

## 12. 리스크 & 완화

| 리스크 | 완화 |
|---|---|
| 이중입력(vendors vs 연락처.json) | 픽업은 **vendors만** 유일 마스터로 참조. 연락처 통합은 후속 단계로 명확 분리 |
| 워크플로 데이터 오염 | 픽업은 별도 SQLite. 워크플로는 잡정보 **읽기만**, `sourceJobId` 문자열만 저장 |
| JSON 폴백 동시쓰기 경합 | 폴백 구현하되 서버PC `better-sqlite3` 설치 확인, "SQLite 강권" 문서화 |
| `auditLog` 동기 write 병목 | 라인마다 말고 **요청/코스 단위**로만 감사로그 |
| FK `ON DELETE RESTRICT` 삭제 충돌 | `isActive=0` 소프트삭제 UX + UI "삭제 불가" 안내 |
| 권한 게이트 누락 | 모든 `/api/pickup/*` mutation에 권한 분기 체크리스트 필수 |
| 배포 타이밍 | vendors ALTER + 신규 3테이블 = 서버재시작 필요 → **스키마 1차에 전부 포함, 일과 후 1회 배포** |

---

## 13. 변경 지점 (코드정찰 기준, 줄번호는 대략)

| 파일 | 변경 |
|---|---|
| `db-sqlite.js` | vendors ALTER(PRAGMA 체크, ~127줄 패턴) · pickup_* CREATE · pickup CRUD 객체(vendors 객체 형태) |
| `db.js` | pickup 스토어 export / JSON 폴백 배선 |
| `routes/pickup.js` | **신규** — 위 API, requireAuth + 권한분기 + (db.sql?SQLite:JSON) + safeBody + auditLog |
| `routes/vendors.js` | POST/PUT 화이트리스트에 신규 vendor 필드 7개 추가 |
| `server.js` | `app.use('/api/pickup', require('./routes/pickup'))` 마운트 |
| `public/index.html` | allMenus/getTabs/menuGroups 배선 · 업체팝업모달(~1562) 신규필드 입력 · `function app()` 픽업 state/method(`openPickupFromJob` 포함) · SSI `<!--INCLUDE:tab-pickup.html-->` |
| `public/tab-pickup.html` | **신규** — 등록 뷰 + 취합·체크 뷰 |
| `public/tab-workflow.html` + `public/workflow.js` | "픽업에 추가" 버튼 → `app().openPickupFromJob(job)` |
| `routes/lib/pickup-text.js` + `*.test.js` | **신규** 순수함수 `parseKakaoPickup` / `buildShareText` + 단위테스트 |
| `data/설정.json` (db.설정) | `pickup.cutoffTime` 기본 `"10:00"` |
| `migrate-to-sqlite.js` | 신규 테이블은 이관할 JSON 없음 → 마이그레이션 섹션 불필요. vendors ALTER만 startup 보장 |

---

## 14. 추후 결정(2차 진입 시)

- 모바일 공유토큰 `PICKUP_MOBILE_TOKEN` env + 만료/QR 재발급 정책
- 회사담당자 픽업 알림 라우팅 활성화 여부
- 코스 순서/동선 UI, 기사/차량 마스터
- 미수거건 다음날 이월 규칙
- 통계(업체별 픽업 빈도, 요청자별 건수, 미수거 사유)
- **eCount 판매현황(매출)+발주 업로드 import** — 별도 상세: **§15** (API 조회 불가 확정 → export-upload 방식, 품목↔수거처 누적매핑). 1차에 import 호환 훅(`sourceType`/`sourceRef`) 선반영
- **픽업 → eCount 매입등록 API 연동 (장기 비전)** — 별도 상세: **§16**. eCount는 전표 *등록*은 API 가능(`SavePurchases`) → 픽업 수거완료를 매입전표로 자동화. DB 히스토리가 토대
- **픽업 목록 Excel/인쇄 내보내기 (선택)** — 1차는 카톡 공유텍스트가 '내보내기' 역할. 기사용 인쇄본/Excel이 필요하면 `xlsx` 스킬로 손쉽게 추가

---

## 15. (2차 설계 예약) eCount 판매현황·발주 업로드 import

> 사장님이 가장 원하던 *"등록된 걸 긁어와서 찾아올 것/아닐 것 나누기"*. 1차엔 안 넣되, v1 데이터모델을 여기에 맞춰 미리 설계한다.

### 15.1 확정 사실 (검증 완료)
eCount Open API는 **매출·매입 거래내역 *조회* API가 없다.**
- 근거: `docs/ecount-api-manual.md` — *"매입 전표(거래내역) 조회 ❌ 없음 → 이카운트 화면에서 csv export"*. `lib/ecount-client.js`의 읽기 함수는 `listCustomers`(거래처)·`listProducts`(품목) **마스터 조회뿐**, 거래내역 조회 없음. 전표는 **등록(`SaveSale`/`SavePurchases`)만** 가능.
- 결론: "등록된 매출 긁어오기"는 **eCount 화면에서 CSV/Excel export → ERP 업로드** 경로만 가능. API 자동연동 불가.

### 15.2 근거 패턴 (이미 존재)
`매입 자동(purchase-auto)` 기능(`routes/ecount-purchase.js`, `public/purchase-auto.js`)이 *"eCount csv export → 업로드 → 자동처리"* 흐름으로 이미 동작 중. 픽업 import는 이 검증된 패턴을 복제한다.

### 15.3 흐름
1. eCount 화면에서 **판매현황(매출) / 발주** CSV·Excel export (둘 다 지원)
2. ERP 픽업 탭에 업로드 → 줄들을 **픽업 후보**로 펼침(거래처·품목·규격·수량·날짜 매핑)
3. 경영관리팀이 *찾아올 것만 선택* + 픽업날짜 확정
4. **수거처(업체) 배정** — 아래 누적매핑으로 점점 자동화

### 15.4 수거처 배정 전략 (사용자 통찰 반영)
- 처음엔 줄마다 수동 지정(귀찮음 인정). 단 **품목↔수거처 매핑이 누적**되어 같은 품목이 다시 들어오면 **자동제안** → "어느정도 매칭되면 편해진다".
- **같은 품목 ↔ 여러 수거처 (1:N):** 한 품목을 여러 곳에서 가져올 수 있음. 매핑은 품목→*후보 수거처 목록*으로 저장하고, 등록/배정 시 **담당자가 어디서 가져올지 선택**(자동제안은 후보를 띄워주되 강제 아님). v1 등록폼은 매번 업체를 직접 고르므로 '선택'을 이미 지원 — 2차는 그 선택을 후보 추천으로 거들 뿐.
- 매출처(고객)별 담당자 매핑(`DEFAULT_COMPANY_MANAGERS`: 포스코→김선율 등)을 소유/알림 라우팅에 재사용.
- 품목 매칭은 기존 `lib/learning-pool.js` / `learning-data/` 패턴 참고 가능.

### 15.5 v1에 미리 깔아두는 import 호환 훅 (2차 ALTER 회피)
- `pickup_requests.sourceType` 확장 설계: `'manual' | 'workflow' | 'ecount_sale' | 'ecount_order'`.
- `pickup_requests.sourceRef` (신규, **v1에 미리 추가**) — eCount 전표번호/행 식별자 보관(중복 import 방지).
- `pickup_items`가 (품목명 + 소속 요청의 `vendorId`)를 자연히 쌓음 → **미래 품목↔수거처 매핑의 시드 데이터**.
- 품목↔수거처 매핑 테이블 `pickup_item_vendor_map`(품목 → **후보 수거처 N개**, 사용빈도/최근순)은 **2차 신설**. 1:N이라 담당자가 후보 중 선택.

### 15.6 2차 진입 시 확정할 것
export 파일의 정확한 컬럼/시트 구조, 중복 import 키, 부분/재import 규칙, 품목코드 매칭 정확도.

---

## 16. (장기 비전) 픽업 → eCount 매입등록 API 자동화 ★사장님 핵심 목표

> **현 업무(사장님 확인):** 발주/매출 API는 안 쓰고, 직원이 각자 물건 체크해서 **매입(매입처)을 eCount에 손으로 등록.** → 이 수작업을 픽업이 흡수해 **수거완료 → 매입 자동등록**으로 없애는 게 최종 목표. 매출을 거치지 않으므로 §15.1의 '매출 읽기 불가' 문제는 **이 경로엔 해당 없음.**

- **현실 점검(사장님 확인):** 명세서 스캔(`매입자동`) 코드는 있으나 **OCR 정확도가 낮아 실사용 못 함(셸프웨어).** (이유: 매입처가 매우 많고 명세서 사진 **레이아웃이 업체마다 제각각**이라 고정위치 파싱 불가 — 향후 OCR 숙제의 출발점.) → 3차 매입 자동등록의 진짜 관문은 'eCount 등록 배선'이 아니라 **OCR/매칭 정확도**(별개의 큰 숙제). ★단 **픽업이 (매입처·품목·수량)을 구조화로 미리 잡아주면, 명세서 OCR은 '가격만 확인'하면 돼 부담이 급감** → 픽업이 오히려 이 자동화를 현실화하는 디딤돌. 전부를 OCR에 의존 안 해도 됨.
- **기술적으로 가능 — 읽기와 반대편:** eCount API는 전표 *조회*는 막혀도(매출·매입 거래내역 ❌) **전표 *등록*은 됨.** `lib/ecount-client.js`의 `savePurchase()`(`SavePurchases`)·`SaveInvoiceAuto` 이미 구현 → 픽업→매입등록 **API로 진짜 가능.** ([[ecount-api-no-transaction-read]] 반대편)
- **API 읽기 매트릭스(참고):** 매출/매입 전표 조회 ❌ / **발주서 조회 ✅**(`GetPurchasesOrderList`, 30일·페이징) / 재고 조회 ✅ / 품목·거래처 마스터 조회 ✅. → 훗날 발주를 쓰게 되면 '발주 읽기 → 픽업 → 매입 쓰기' 풀자동도 열림. 현재는 발주 안 쓰므로 **픽업이 원천.**
- **흐름(구상):** 픽업 수거완료 → (수거처 vendor + 품목 + 수량)으로 매입 전표 초안 → 단가는 기존 **`vendor_prices`** 조인 → dryRun으로 사장님 확인 → `SavePurchases` 호출 → eCount 전표번호(`SlipNos`) 보관. (기존 `매입자동` dryRun→확정 패턴 재사용.)
- **3차 전제(매핑):** eCount 등록엔 거래처코드(`CUST`)·품목코드(`PROD_CD`)가 필요. 품목명→`PROD_CD`는 **품목 마스터 API 조회(가능)**로 매칭, 업체→`CUST`는 vendors에 `ecountVendorCode` 칼럼 추가(3차 ALTER, 별도 배포라 OK). 단가는 `vendor_prices`.
- **데이터 토대:** v1부터 쌓이는 픽업 히스토리(수거처·품목·수량·날짜·완료시점)가 자동화의 원천. **"DB 히스토리 잘 쌓기"가 핵심** — `pickup_items`(품목 + 요청 `vendorId` + 수량 + 완료시점) 누적이 이미 그 방향.
- **단계:** v1(픽업 핵심·히스토리 축적) → 2차(매출 export-upload import, 품목↔수거처 매핑) → **3차(픽업 수거완료 → 매입 API 자동등록 = 현 수작업 대체).**
