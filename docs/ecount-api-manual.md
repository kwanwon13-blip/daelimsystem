# 이카운트 OpenAPI — 매뉴얼 정리 (대림에스엠 / Zone CB)

> **출처**: 사장님 이카운트 세션 매뉴얼 (sboapicb.ecount.com 도메인)
> **수집일**: 2026-04-30
> **회사 Zone**: `CB` (한국 일부 회사 라우팅 zone)
> **인증정보 위치**: `.env` 의 `ECOUNT_*` 변수
> **원본**: `docs/ecount-api-manual-raw.md` (236KB, 22개 섹션 전체)

---

## 1. 우리 환경의 정확한 URL 패턴

### 테스트 (Sandbox)
- 기본: `https://sboapi{ZONE}.ecount.com/...` → `https://sboapicb.ecount.com/...`
- 예: `https://sboapicb.ecount.com/OAPI/V2/OAPILogin`

### 운영 (Production)
- 기본: `https://oapi{ZONE}.ecount.com/...` → `https://oapicb.ecount.com/...`
- 예: `https://oapicb.ecount.com/OAPI/V2/OAPILogin`

> 우리 .env의 `ECOUNT_API_CERT_KEY` 가 테스트 키인지 운영 키인지에 따라 URL 분기 필요. 로그인 시 Code 204 ("테스트용 / 실서버용 인증키") 응답으로 판별 가능.

---

## 2. ⚠️ 가장 중요한 발견 — 조회/등록 매트릭스

이카운트 OpenAPI는 **조회/등록 비대칭**이 큽니다. 매입 자동화 설계에 결정적 영향:

| 데이터 | 조회 API | 등록 API | 우회 방법 |
|---|---|---|---|
| **매입처 마스터** | ❌ 없음 | ✅ `SaveBasicCust` | 이카운트 화면에서 csv export |
| **품목 마스터** | ✅ `GetBasicProductsList` (1만 cap, 코드범위로 분할 가능) | ✅ `SaveBasicProduct` | 둘 다 가능 |
| **품목 단건 조회** | ✅ `GetBasicProduct` | — | |
| **발주서** | ✅ `GetPurchasesOrderList` (30일 limit, 페이징) | — (별도 등록 메뉴) | |
| **매입 전표 (매입 거래내역)** | ❌ 없음 | ✅ `SaveInvoiceAuto` (자동분개) | 이카운트 화면에서 csv export |
| **재고/창고별재고** | ✅ 단건/리스트 둘 다 | — | |
| **견적서/주문서/판매전표** | — | ✅ Save 시리즈 | |
| **구매전표(구매입력)** | — | ✅ `SavePurchases` | |

### 결론: 매입 자동화의 데이터 흐름

```
[Phase 1] 사장님이 csv export로 한 번 떨어뜨림
   ├─ 매입처 마스터 csv
   ├─ 매입 거래내역 csv (6개월치) ← 이게 매핑 학습의 정답지
   └─ (품목 마스터는 이미 받음 — ESA009M.csv 5만 8천건)

[Phase 2] 우리 ERP에서 매입명세서 OCR
   ├─ 추출된 행 [품명 / 규격 / 수량 / 단가]
   └─ 위 csv 데이터로 매핑 학습 → 후보 추천

[Phase 3] 자동 등록
   └─ SaveInvoiceAuto 호출 → 이카운트에 매입전표 자동 생성
      └─ 필수 필드: TAX_GUBUN(매입), CUST(거래처코드), DR_CODE(매입계정), SUPPLY_AMT, VAT_AMT, TRX_DATE
```

매입 거래내역 자동 동기화는 OpenAPI로 **불가능**. csv export로만 가능.

---

## 3. 공통 (필수) API

### 3-1. Zone API
- **POST** `https://sboapicb.ecount.com/OAPI/V2/Zone` (테스트)
- **POST** `https://oapicb.ecount.com/OAPI/V2/Zone` (운영)
- **요청**: `{ "COM_CODE": "회사코드6자리" }`
- **응답**: `Data.ZONE`, `Data.DOMAIN` — 후속 로그인 호출에 사용
- ⚠️ **차단정책**: 동일 IP에서 zone/login 실패 10회 이상 → IP 차단 (Open API뿐 아니라 ERP 로그인까지 전반 차단)

### 3-2. 로그인 API
- **POST** `https://sboapi{ZONE}.ecount.com/OAPI/V2/OAPILogin`
- **요청**:
  ```json
  {
    "COM_CODE": "회사코드",
    "USER_ID": "이카운트ID",
    "API_CERT_KEY": "API인증키",
    "LAN_TYPE": "ko-KR",
    "ZONE": "CB"
  }
  ```
- **응답 (성공)**: `Data.Datas.SESSION_ID` — 이후 모든 API 호출의 query string `?SESSION_ID=...`
- **응답 (실패) Code별 의미**:
  - 20: 잘못된 ID/PW
  - 24/25: IP 차단 (개인/회사 IP별차단)
  - 81~85, 89: 미수/탈퇴 차단
  - 98: 비밀번호 5회 실패
  - 201: API_CERT_KEY 무효
  - 204: 테스트키/실서버키 구분 (URL 잘못 사용)
  - 205: 허용되지 않은 IP (어드민에서 IP 등록 필요)

### 안전 호출 가이드 (매뉴얼 권고사항)
1. 회사코드/인증정보 사전 검증
2. 실패 시 무한 재시도 금지 — 횟수/간격 제한
3. 실패 누적 시 자동 호출 중단 + 운영자 알림
4. Rate limit: HTTP 412 "API 전송 횟수 기준 초과" 발생 시 백오프

---

## 4. 기초등록 API

### 4-1. 거래처등록 (`SaveBasicCust`)
- **POST** `/OAPI/V2/AccountBasic/SaveBasicCust?SESSION_ID=...`
- ⚠️ **등록만 가능. 조회 API 없음.**
- 핵심 필드: `BUSINESS_NO`(사업자번호=거래처코드), `CUST_NAME`, `BOSS_NAME`, `TEL`, `EMAIL`, `ADDR`, `CUST_GROUP1/2`(그룹), `IO_CODE_BY`(거래유형 매입)
- 일괄 등록: `CustList: [{BulkDatas: {...}}, ...]`
- 응답: `SuccessCnt`, `FailCnt`, `ResultDetails`

### 4-2. 품목등록 (`SaveBasicProduct`)
- **POST** `/OAPI/V2/InventoryBasic/SaveBasicProduct?SESSION_ID=...`
- 같은 양식 (`ProdList: [{BulkDatas: {...}}]`)

### 4-3. 품목조회 (`GetBasicProductsList`) ⭐ 우리에게 핵심
- **POST** `/OAPI/V2/InventoryBasic/GetBasicProductsList?SESSION_ID=...`
- **요청 파라미터**:
  - `PROD_CD`: 특정 코드들 (`∬` 구분자, 최대 20000자)
  - `PROD_TYPE`: 품목구분 (0:원재료/1:제품/2:반제품/3:상품/4:부재료/7:무형상품)
  - **`FROM_PROD_CD` ~ `TO_PROD_CD`: 코드 범위** ← 1만 cap 우회 핵심
- **응답**: 약 100개 필드 (PROD_CD/PROD_DES/SIZE_DES/UNIT/IN_PRICE/OUT_PRICE/CLASS_CD/BAR_CODE/TAX/VAT_RATE_BY/CONT1~6/NO_USER1~10 등)
- ⚠️ **사장님 경험: 한 번에 1만개까지** → 우리 5만 8천건은 7회 분할 호출 필요

#### 분할 호출 전략 (확정)
```
호출 1: FROM_PROD_CD=A0000000000  TO_PROD_CD=A0000040712  (~9000개)
호출 2: FROM_PROD_CD=A0000040713  TO_PROD_CD=A0000050625  (~9000개)
호출 3: FROM_PROD_CD=A0000050626  TO_PROD_CD=A0000060623  (~9000개)
호출 4: FROM_PROD_CD=A0000060624  TO_PROD_CD=A0000070370  (~9000개)
호출 5: FROM_PROD_CD=A0000070371  TO_PROD_CD=A0000080166  (~9000개)
호출 6: FROM_PROD_CD=A0000080167  TO_PROD_CD=A1000000359  (~9000개)
호출 7: FROM_PROD_CD=A1000000360  TO_PROD_CD=A1000005077  (~4611개)
```
(ESA009M.csv 분석 결과 기반)

### 4-4. 품목조회(단건) (`GetBasicProduct`)
- **POST** `/OAPI/V2/InventoryBasic/GetBasicProduct?SESSION_ID=...`
- 단건 조회 — `PROD_CD` 한 개

---

## 5. 영업관리 API (등록 전용)

### 5-1. 견적서입력 (`SaveQuotation`)
### 5-2. 주문서입력 (`SaveSale`)
### 5-3. 판매입력 (`SaveSale`)

→ 우리 ERP에서 견적서 발행 시 → 이카운트로 자동 전송 가능. 향후 양방향 동기화 활용.

---

## 6. 구매관리 API

### 6-1. 발주서조회 (`GetPurchasesOrderList`)
- **POST** `/OAPI/V2/Purchases/GetPurchasesOrderList?SESSION_ID=...`
- ⚠️ **검색기간 최대 30일** — 6개월치 받으려면 6회 분할 호출
- ⚠️ 페이징: `PAGE_CURRENT` (기본 1), `PAGE_SIZE` (기본 26, 최대 100)
- 입력: `PROD_CD`, `CUST_CD`, `BASE_DATE_FROM/TO` (YYYYMMDD), `ListParam: { PAGE_CURRENT, PAGE_SIZE }`
- 응답 필드: ORD_NO/ORD_DATE/CUST/CUST_DES/PROD_DES/QTY/BUY_AMT/VAT_AMT/P_FLAG (1진행/9종결)/WRITER_ID/...

### 6-2. 구매입력 (`SavePurchases`)
- 매입 전표 등록 (재고 연동)

---

## 7. 회계 API ⭐ 매입 자동 등록의 핵심

### 7-1. 매출·매입전표 II 자동분개 (`SaveInvoiceAuto`)
- **POST** `/OAPI/V2/InvoiceAuto/SaveInvoiceAuto?SESSION_ID=...`
- ⚠️ **저장만 가능** (조회 API 없음)
- 매입전표 등록 핵심 필드:
  - `TRX_DATE`: 일자 (YYYYMMDD)
  - `TAX_GUBUN`: 매입은 `21` (Self-Customizing > 부가세유형(매입) 코드)
  - `CUST`: 거래처코드
  - `CUST_DES`: 거래처명 (선택)
  - `SUPPLY_AMT`: 공급가액
  - `VAT_AMT`: 부가세
  - `DR_CODE`: 매입계정코드 (예: `1469` 상품)
  - `REMARKS`: 적요
  - `SITE_CD`/`PJT_CD`: 부서/프로젝트 (옵션)
- 일괄: `InvoiceAutoList: [{BulkDatas: {...}}]`
- 응답: `SuccessCnt`/`FailCnt`/`SlipNos` (생성된 전표번호)

→ **매입명세서 OCR → 이 API로 자동 등록**이 최종 목표

---

## 8. 재고 API (조회 전용)

| API | URL | 용도 |
|---|---|---|
| 재고현황(단건) | `/Inventory/GetStockBalance` | 품목 1개 재고 |
| 재고현황 | `/Inventory/GetStockBalanceList` | 다건 |
| 창고별재고현황(단건) | `/Inventory/GetWarehouseStock` | 창고별 1품목 |
| 창고별재고현황 | `/Inventory/GetWarehouseStockList` | 다건 |

---

## 9. 기타 API

- **생산관리**: 작업지시서/생산불출/생산입고 (등록)
- **쇼핑몰 주문API**: 쇼핑몰 주문 연동
- **출/퇴근기록부(사원)**: 근태 — CAPS 데이터를 이카운트로 보낼 때 사용 가능
- **게시판입력**: 사내 게시판

---

## 10. Rate Limit / 차단

매뉴얼에서 명시된 한도:
- **시간당 연속 오류 제한**: `1/30`, `2/30` 같은 방식 (응답 `QUANTITY_INFO`에 표시됨)
- **1시간 허용량**: 보통 `6000` 건
- **1일 허용량**: 보통 `10000` 건
- HTTP 412: rate limit 초과
- HTTP 302: 잘못된 호출
- 모든 응답에 `QUANTITY_INFO` 포함되니 모니터링 필수

---

## 11. 우리 ERP 연동 로드맵

### 즉시 가능 (사장님 csv 받으면)
- [ ] 매입처 마스터 csv → SQLite `ecount_vendors` 테이블
- [ ] 매입 거래내역 csv (6개월) → SQLite `ecount_purchase_history` 테이블
- [ ] 품목 마스터 csv (이미 받음) → SQLite `ecount_products` 테이블

### Phase 1 — API 연결 검증
- [ ] Zone API 호출 → 정상 응답 확인
- [ ] Login API 호출 → SESSION_ID 받기 + .env 키 종류 식별
- [ ] 품목조회 1회 호출 → 응답 구조 확인 (실측)
- [ ] 발주서조회 1회 호출 (최근 30일) → 응답 구조 확인

### Phase 2 — 동기화 자동화
- [ ] 품목 마스터 7회 분할 호출 → DB 캐시 (초기 1회)
- [ ] 품목 마스터 일별 증분 동기화 (변경분만)
- [ ] 발주서 6개월치 6회 분할 호출 → DB 캐시
- [ ] 발주서 일별 증분 동기화

### Phase 3 — 매입명세서 OCR + 매핑
- [ ] OCR로 매입명세서 텍스트 추출
- [ ] (거래처, 품명, 규격) → 우리 품목코드 매핑 학습 (csv 매입이력 기반)
- [ ] 후보 1~5개 표시 + 사용자 선택 → 매핑 테이블 누적

### Phase 4 — 자동 등록
- [ ] 확정된 매입전표 → SaveInvoiceAuto 호출
- [ ] 성공/실패 로그 + 이카운트 전표번호(SlipNos) 보관

---

## 12. 보안/안정성 체크리스트

- [x] `.env` 에 인증정보 저장 (git 무관)
- [ ] 호출 코드에 재시도 횟수 제한 (max 3회)
- [ ] 실패 누적 카운터 + 자동 중단
- [ ] `QUANTITY_INFO` 응답 모니터링 — 80% 도달 시 알림
- [ ] SESSION_ID 만료 처리 (재로그인 자동화)
- [ ] IP 화이트리스트 등록 확인 (Code 205 방지)

---

> 이 매뉴얼은 사장님 이카운트 세션을 통해 추출한 정보입니다. 매뉴얼 원본은 `docs/ecount-api-manual-raw.md` 에 있고, 향후 수정 시 그 파일에서 해당 섹션 라인 번호 참고: `^## ` grep으로 22개 섹션 인덱스 확인 가능.
