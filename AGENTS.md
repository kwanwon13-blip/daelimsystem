# Project Environment Rules

## ⚠️ 실수 방지 — PC 2대 구성 (반드시 먼저 읽을 것)

이 프로젝트는 **2대의 Windows PC**에서 운영된다. Codex는 자주 두 PC를 혼동하므로 아래 표를 항상 참조할 것.

| 구분 | PC 이름 | IP | 실제 경로 | 역할 |
|------|---------|----|-----------|----|
| **로컬 PC** | 남관원(admin) PC, "내 컴터" | `192.168.0.30` | `C:\Users\NAMGW\Documents\Codex\Projects\업체별 단가표 만들기!!!\price-list-app` | 코드 편집 + Cowork 샌드박스 마운트 위치 + salary-daemon 실행 |
| **서버 PC** | "서버" | `192.168.0.133` | `D:\price-list-app` | 메인 서버(포트 3000) + 트레이 + control-daemon(포트 3002) 실행 |

### Codex 샌드박스 마운트
- `/sessions/tender-great-thompson/mnt/price-list-app` ← **로컬 PC** 의 위 경로에 마운트됨 (Cowork가 선택한 폴더)
- 서버 PC의 `D:\price-list-app`은 **직접 접근 불가**. 오직 원격 배포(git push/pull 또는 수동 복사)로만 반영됨
- 따라서 내가 파일을 수정/생성하면 → **로컬 PC**에 먼저 반영됨 → 그 다음 서버 PC로 전송돼야 실제 서비스에 반영

### 배포 흐름 (배포순서.md 참고)
1. 로컬 PC에서 코드 수정
2. 로컬 PC에서 `git-setup.bat` 실행 → GitHub에 push
3. 서버 PC에서 `git-pull-server.bat` 실행 → GitHub에서 pull + 서버 재시작
4. **주의**: `*.bat`, `*.vbs`, `*.ps1`은 `.gitignore`에 등록돼 있어서 git으로 동기화 안 됨 → 이 파일들은 네트워크 공유 복사 또는 gitignore 예외 추가 필요

### PowerShell/bat 명령을 사용자가 보여줄 때 PC 구분법
- 프롬프트가 `PS D:\price-list-app>` → **서버 PC**
- 프롬프트가 `C:\Users\NAMGW\...>` 또는 로컬 PC 경로 → **로컬 PC**
- `New-NetFirewallRule`, `taskkill /im node.exe` 같은 관리자 권한 명령이 서버에서 실행되면 서버 PC의 서비스에 영향

### 서버 PC에서 실행되는 백그라운드 프로세스 (포트별)
| 포트 | 프로세스 | 파일 | 용도 |
|------|----------|------|------|
| 3000 | 메인 서버 (node server.js) | `proxy-watchdog.bat` → `proxy-hidden-start.vbs` → `server.js` | ERP 전체 |
| 3002 | control-daemon | `control-daemon-watchdog.bat` → `control-daemon-hidden.vbs` → `control-daemon.js` | 원격 start/stop/restart |

### 로컬 PC(관리자 PC, 192.168.0.30)에서 실행되는 백그라운드 프로세스
| 포트 | 프로세스 | 용도 |
|------|----------|------|
| 3001 | **CAPS Bridge** (caps-bridge/caps-bridge.js) | CAPS ACCESS.mdb → REST API. 출퇴근 원본 데이터 제공 (`/api/attendance`) |
| 3002 | salary-daemon (salary-daemon.js) | 급여 DB 전용 (CAPS 격리) — 서버 PC가 프록시로 호출 |

> **⚠️ 포트 3001은 반드시 CAPS Bridge 전용**. salary-daemon 자동시작 bat이
> 과거에 `netstat :3001` 으로 CAPS Bridge를 죽이는 사고를 냈으므로, salary-daemon은 3002 고정.
> 서버 PC(192.168.0.133)의 3002(control-daemon)와는 IP가 달라 충돌하지 않음.

---

## 실행 환경: Windows 10/11 (한국어)
- 이 프로젝트는 **Windows** 환경에서 실행됨
- Codex 샌드박스는 Linux이지만, 최종 실행은 반드시 Windows

## .bat 파일 작성 규칙
- **절대 사용 금지**: `/dev/null` → 반드시 `nul` 사용
- **줄바꿈**: CRLF (`\r\n`) 필수
- **인코딩**: 한글 포함 시 CP949, 영문만 있으면 ASCII
- **UTF-8 BOM 사용 금지**: Windows cmd에서 BOM이 깨짐
- **`chcp 65001` 사용 금지**: cmd에서 한글 깨짐 원인
- **한글 메시지 최소화**: echo 메시지는 영문으로 작성 권장
- 경로 구분자: `\` (백슬래시)

## Node.js / JavaScript
- 경로: `path.join()` 사용 (OS 무관하게 동작)
- 파일 인코딩: UTF-8 (Node.js는 UTF-8 기본이라 문제없음)

## 파일 인코딩 체크리스트
| 파일 유형 | 인코딩 | BOM | 줄바꿈 |
|-----------|--------|-----|--------|
| .bat      | ASCII/CP949 | 없음 | CRLF |
| .html     | UTF-8  | 없음 | LF/CRLF |
| .js       | UTF-8  | 없음 | LF/CRLF |
| .json     | UTF-8  | 없음 | LF/CRLF |

---

# 아키텍처 전체 맵

## 서버 구조
- **런타임**: Node.js + Express.js, 포트 3000
- **프론트엔드**: Alpine.js v3 SPA (CDN)
- **DB**: `db.js` (SQLite + JSON 하이브리드, `data/` 폴더)
- **서버 주소**: http://localhost:3000

## 데이터베이스 아키텍처 (SQLite + JSON 하이브리드)

### SQLite (업무데이터.db) — 대용량/성장하는 데이터
| 테이블 | 설명 | 접근 방법 |
|--------|------|-----------|
| categories | 품목 | `db.sql.categories.*` |
| options | 옵션 | `db.sql.options.*` |
| vendors | 업체 | `db.sql.vendors.*` |
| vendor_prices | 업체별 단가 | `db.sql.vendorPrices.*` |
| quotes | 견적서 | `db.sql.quotes.*` |
| quote_items | 견적 항목 | `db.sql.quotes.create()` 내부 트랜잭션 |

- WAL 모드, 외래키 활성화
- JSON 필드(tiers, variants 등)는 TEXT로 저장, 읽기/쓰기 시 자동 파싱
- `better-sqlite3` 패키지 필요 (미설치 시 JSON 폴백)

### JSON (한글 파일명) — 소규모/설정 데이터
| 파일명 | 내용 | 접근 방법 |
|--------|------|-----------|
| 조직관리.json | 사용자, 부서 | `db.조직관리.load()` / `.save()` |
| 결재관리.json | 결재 | `db.결재관리.load()` / `.save()` |
| 연락처.json | 연락처 | `db.연락처.load()` / `.save()` |
| 설정.json | SMTP, 일반 설정 | `db.설정.load()` / `.save()` |

### SQLite 미설치 시 JSON 폴백
- `better-sqlite3` 미설치 → `db.sql = null`
- 서버 코드: `if (db.sql) { /* SQLite */ } else { /* JSON 폴백 */ }`
- 폴백 시 품목관리.json, 업체관리.json, 견적관리.json 사용

### 하위 호환 메서드
```js
db.loadUsers()     // → 조직관리.json
db.saveUsers()     // → 조직관리.json
db.loadContacts()  // → 연락처.json
db.saveContacts()  // → 연락처.json
db.load()          // → SQLite 있으면 SQLite, 없으면 품목관리.json
```

### SQLite 설치 방법
1. `SQLite설치가이드.bat` 실행 (npm install + 마이그레이션)
2. 또는 수동: `npm install better-sqlite3` → `node migrate-to-sqlite.js`

### 새 JSON 메뉴 추가 방법
`db.js`의 `jsonStores` 객체에 한 줄 추가:
```js
const jsonStores = {
  '조직관리': { users: [], departments: [] },
  '새메뉴이름': { 데이터키: [] },  // ← 이것만 추가
};
```

## 핵심 파일 구조
```
price-list-app/
├── server.js              # Express 서버 + 모든 API 엔드포인트
├── db.js                  # 통합 DB 모듈 (SQLite + JSON 라우팅)
├── db-sqlite.js           # SQLite CRUD 로직 (better-sqlite3)
├── migrate-to-sqlite.js   # JSON → SQLite 마이그레이션 스크립트
├── SQLite설치가이드.bat    # Windows용 SQLite 설치 + 마이그레이션
├── data/
│   ├── 업무데이터.db      # SQLite DB (품목/옵션/업체/견적)
│   ├── 조직관리.json      # 사용자 + 부서
│   ├── 결재관리.json      # 결재
│   ├── 연락처.json        # 연락처
│   ├── 설정.json          # SMTP + 일반 설정
│   ├── 품목관리.json      # (SQLite 폴백용)
│   ├── 업체관리.json      # (SQLite 폴백용)
│   ├── 견적관리.json      # (SQLite 폴백용)
│   └── _기존백업/         # 마이그레이션 전 원본 백업
├── public/
│   ├── index.html         # 메인 SPA (Alpine.js app())
│   ├── tab-pricing.html   # 단가관리 탭 UI
│   ├── tab-options.html   # 옵션관리 탭 UI
│   └── contacts.js        # 연락처 탭 (독립 컴포넌트)
└── 이카운트_API_연동_가이드.xlsx  # eCount API 문서
```

## 서버사이드 인클루드 (SSI)
`server.js` 209~238번 줄이 `GET /` 요청 시 `<!--INCLUDE:파일명.html-->` 주석을 해당 파일 내용으로 치환해 서빙한다.

```
index.html (845번 줄)  -->  <!--INCLUDE:tab-pricing.html-->
index.html (850번 줄)  -->  <!--INCLUDE:tab-options.html-->
```

**결과**: 브라우저는 하나의 완성된 HTML을 받는다. 개발할 때는 탭 파일만 수정해도 된다.

---

# 파일 수정 가이드 — 어디를 건드려야 하는가

## ① 단가 관리 탭 (tab-pricing.html)
**수정 대상 파일**
| 변경 내용 | 편집 파일 |
|-----------|-----------|
| 테이블 UI, 레이아웃, 버튼 추가/제거 | `public/tab-pricing.html` |
| 상태(state) 변수 추가/변경 | `public/index.html` → `function app()` 내부 |
| 비즈니스 로직(메서드) 추가/변경 | `public/index.html` → `function app()` 내부 |
| 새 API 엔드포인트 추가 | `server.js` |

**연관 state 변수** (`index.html` 2157~2164번 줄)
```js
pricingVendorId: ''          // 선택된 업체 ID
vendorPrices: []             // 업체별 단가 목록
showAddCategory: false       // 품목 추가 폼 표시 여부
newCat: { name, code, pricingType, unit }  // 새 품목 입력값
pricingSearch: ''            // 검색어
selectedPricingCat: null     // 인라인 편집 중인 품목 ID
```

**연관 computed**
```js
filteredPricingCategories    // pricingSearch 기반 필터링된 카테고리
canEditPricing               // 편집 권한 여부 (admin 또는 pricing_edit 권한)
```

**연관 메서드** (`index.html` 2290번 줄 이후)
```
createCategory()             → POST /api/categories
updateCatField(id, f, v)     → PUT  /api/categories/:id
deleteCategory(id)           → DELETE /api/categories/:id
onPricingVendorChange()      → 업체 변경 시 vendorPrices 로드
saveVendorPrice(catId, data) → POST /api/vendor-prices
copyDefaultsToVendor()       → POST /api/vendor-prices/:vendorId/copy-defaults
addVendorTier(catId)         → saveVendorPrice 경유
updateVendorTier(catId, ti, field, value)
removeVendorTier(catId, ti)
addWidthTier(catId)
addWidthTierBulk(catId)      → 300~1800mm 일괄 추가
updateWidthTier(catId, wi, field, value)
removeWidthTier(catId, wi)
getDisplayTiers(cat)         → 업체 단가 또는 기본 단가 반환
getDisplayWidthTiers(cat)
getDisplayQtyPrice(cat)
getDisplayFixedPrice(cat)
getCatPurchaseSpecs(catId)   → 해당 품목 사양 목록
addPurchaseSpec(catId)       → PUT /api/categories/:id (specs 업데이트)
removePurchaseSpec(catId, idx)
updatePurchaseSpec(catId, idx, field, value)
getSpecQuotes(spec)          → 사양의 매입견적 목록
getLowestQuote(spec)         → 최저가 견적
addSpecQuote(catId, specIdx)
updateSpecQuote(catId, specIdx, quoteIdx, field, value)
removeSpecQuote(catId, specIdx, quoteIdx)
uploadSpecImage(catId, idx, event) → POST /api/upload-image
openSpecSearchModal(catId)   → specSearchModal.open = true
importDesignAsSpec(item)     → 시안 검색 결과를 사양으로 추가
setPasteTarget(target)       → 이미지 붙여넣기 대상 설정
pasteTarget                  → { type:'spec', catId, idx }
```

**연관 API 엔드포인트** (`server.js`)
```
GET    /api/categories
POST   /api/categories
PUT    /api/categories/:id
DELETE /api/categories/:id
GET    /api/vendor-prices/:vendorId
POST   /api/vendor-prices
POST   /api/vendor-prices/:vendorId/copy-defaults
DELETE /api/vendor-prices/:vendorId/:categoryId
POST   /api/upload-image
```

---

## ② 옵션 관리 탭 (tab-options.html)
**수정 대상 파일**
| 변경 내용 | 편집 파일 |
|-----------|-----------|
| 테이블 UI, 레이아웃 | `public/tab-options.html` |
| 상태(state) 변수 | `public/index.html` → `function app()` |
| 메서드 | `public/index.html` → `function app()` |
| API | `server.js` |

**연관 state 변수** (`index.html` 2165~2167번 줄)
```js
showAddOption: false
newOpt: { code, name, price, unit, categoryIds, pricingType, variants }
expandedOptId: null          // 펼쳐진 옵션 행의 ID
showAddOptQuote: false
newOptQuote: { vendor, price, quoteDate, note }
```

**연관 메서드** (`index.html` 2424번 줄 이후)
```
createOption()               → POST /api/options
deleteOption(id)             → DELETE /api/options/:id
addOptQuote(optId)           → POST /api/options/:id/quotes
deleteOptQuote(optId, qId)   → DELETE /api/options/:id/quotes/:qid
```

**연관 API 엔드포인트**
```
GET    /api/options
POST   /api/options
PUT    /api/options/:id
DELETE /api/options/:id
POST   /api/options/:id/quotes
DELETE /api/options/:id/quotes/:qid
```

---

## ③ 연락처 탭 (contacts.js — 별도 파일)
**수정 대상 파일**: `public/contacts.js` (180줄, 단일 파일로 완전 격리)

- Alpine.js 컴포넌트 이름: `contactsApp()` — `app()`과 완전히 별개
- `index.html`에서 `x-data="contactsApp()"` 으로 마운트
- 연락처 탭 수정 시 **contacts.js만 편집하면 됨**, index.html 건드릴 필요 없음

**연관 state**
```js
contacts: [], loading, searchQ, filterCompany, companyList
expandedGroups, inlineEditing, inlineEditField, inlineEditValue
```

**연관 API 엔드포인트** (`server.js`)
```
GET  /api/contacts/all   ← 검색/필터 파라미터: q, company
```

---

## ④ 다른 탭/메뉴 (index.html 내부)
| 탭 | index.html 위치 | 주요 state |
|----|-----------------|------------|
| 견적 작성 (quote) | ~500~850번 줄 | `newItem`, `quoteItems`, `quoteHeader` |
| 견적 목록 (history) | ~860~1000번 줄 | `savedQuotes`, `quoteStatusFilter` |
| 업체 관리 (vendors) | ~1100번 줄 | `showAddVendor`, `newVendor` |
| 사용자 관리 (admin) | ~1050번 줄 | `adminUsers`, `editingPermUserId` |
| 통계 (stats) | ~950번 줄 | `stats`, `statsLoading` |
| 시안 검색 (design) | ~1124번 줄 | `specSearchModal` |
| 연락처 (contacts) | ~1375번 줄 | contacts.js에 별도 관리 |
| 공지사항 (notices) | ~1300번 줄 | `notices` |
| 설정 (settings) | ~1800번 줄 | `smtpSettings`, `namecardForm` |

**탭 전환 로직** (`index.html` 2116~2138번 줄 `get tabs()`)
- admin: 모든 탭 표시
- 일반 사용자: `permissions` 배열에 따라 표시
- `pricing_view` 또는 `pricing_edit` 권한 → 品목 관리 탭 표시

---

## ④ 공유 데이터 (모든 탭에서 사용)
```js
// 공통 데이터 (init() 시 로드)
categories: []     // loadCategories() → GET /api/categories
options: []        // loadOptions()    → GET /api/options
vendors: []        // loadVendors()    → GET /api/vendors
auth: {}           // 현재 로그인 사용자 정보
```

**init() 흐름** (`index.html` 2219번 줄)
1. `checkAuth()` → `/api/auth/me`
2. 로그인 성공 시 `loadCategories()`, `loadOptions()`, `loadVendors()`
3. 탭 렌더링

---

# 수정 작업 프로토콜

## 탭 UI만 변경할 때
1. 해당 탭 파일만 편집 (`tab-pricing.html` 또는 `tab-options.html`)
2. 기존 Alpine.js 디렉티브(`x-data`, `x-model`, `x-show`, `@click` 등) 문법 유지
3. 새 상태/메서드 참조 시 → index.html `function app()` 내부에 추가 필요

## 새 기능 추가할 때 (크로스파일 수정)
1. `tab-*.html` — UI 마크업 추가
2. `index.html` → `function app()` — 필요한 state/method 추가
3. `server.js` — 필요한 API 엔드포인트 추가
4. 변경사항이 다른 탭에 영향을 줄 경우 관련 탭 파일도 확인

## 절대 하지 말 것
- `<!--INCLUDE:...-->` 주석 삭제 또는 이동
- `function app()` 이름 변경
- `x-data="app()"` 속성 수정 (index.html `<body>` 태그)
- SSI 캐시 변수 `_indexCache` 직접 수정

---

# 디버깅 가이드

## 서버 상태 확인
```bash
# 서버 실행 중인지 확인
curl http://localhost:3000/api/auth/me

# 응답 예시 (정상): {"loggedIn":false}
# 응답 없음: 서버 미실행 → 테스트서버실행.bat 실행 필요
```

## 자주 발생하는 오류 패턴
| 증상 | 원인 | 해결 |
|------|------|------|
| 탭 내용이 안 보임 | SSI 파일 문법 오류 | 탭 HTML에서 여는 태그 미닫힘 확인 |
| Alpine.js 오류 | x-data 속성 오류 | 브라우저 콘솔 확인 (`Alpine Error`) |
| API 404 | 엔드포인트 미등록 | server.js에 라우트 추가 |
| API 500 | DB 구조 불일치 | `data/*.json` 또는 `data/업무데이터.db` 확인 |
| 변경사항 미반영 | SSI 캐시 | 서버 재시작 (캐시는 첫 요청 후 저장됨) |

## gstack 브라우저 디버깅 (Codex in Chrome 사용 시)
```
URL: http://localhost:3000
콘솔 오류 키워드: "Alpine", "Error", "TypeError", "fetch"
네트워크 탭: /api/* 엔드포인트 응답 코드 확인
```

## 서버 재시작
- Windows: `서버중지.bat` 실행 후 `테스트서버실행.bat` 실행
- 재시작 후 캐시 초기화됨 (SSI 재빌드)
