# ERP 상세 개발 계획

> 최초 작성: 2026-04-10 / 최종 업데이트: 2026-04-15  
> 개발 환경: Node.js + Express + Alpine.js + SQLite  
> 제외 항목: 평가/교육 관리, 회계/예산 연계 (불필요)

---

## 개발 우선순위 요약

```
A. 제작흐름보드 (ERP 연동)          ← 현업 즉시 필요
B. 급여 모듈                        ← 핵심 인사 기능
C. 근태 고도화                      ← 급여 연계 필수
D. 인사기록 고도화 + 제증명 발급     ← 완성도
```

---

# A. 제작흐름보드 (ERP 통합)

> 현재 상태: 독립 HTML 프로토타입, 데이터 저장 없음  
> 목표: ERP 서버 통합, SQLite 연동, 실시간 다중 사용자 지원

## A-0. 현재 업무 프로세스 (as-is)

```
디자이너
  └─ 공장에 메일로 발주 (시안 파일 첨부)
       └─ 공장: 인쇄 완료
            └─ 경영관리팀: 수령 후 이카운트에 기록
                 └─ 카톡으로 "완료됐으니 찾아오세요" 알림
                      └─ 영업지원팀: 명세서/카톡 확인 후 픽업
```

## A-1. 개선 후 프로세스 (to-be)

```
디자이너
  └─ ERP 제작보드에 발주 카드 등록 (시안 파일 첨부)
       └─ 공장: 카드 확인 → 수락 클릭 (타임스탬프 기록)
            └─ 인쇄 완료 → 완료 클릭 (타임스탬프 기록)
                 └─ 경영관리팀: 카드 상태 자동 업데이트 (이카운트 수동 기록은 별도 유지)
                      └─ 영업지원팀: 알림 수신 → 픽업 완료 클릭 (카메라 촬영)
```

## A-2. DB 설계 (SQLite — 업무데이터.db)

### `production_teams` — 팀 목록

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| name | TEXT | 팀명 (출력팀, 시공팀 등) |
| icon | TEXT | 이모지 |
| color | TEXT | 카드 테두리 색상 |
| sortOrder | INTEGER | 보드 표시 순서 |

### `production_jobs` — 제작 작업 카드

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| title | TEXT | 작업명 |
| client | TEXT | 거래처명 |
| teamId | TEXT | 담당 팀 ID |
| assignDate | TEXT | 배정일 YYYY-MM-DD |
| dueDate | TEXT | 납기일 |
| status | TEXT | ready / progress / done |
| quoteId | TEXT | 연결된 견적서 ID (선택, 없으면 null) |
| designFileId | TEXT | 연결된 시안 ID (선택) |
| note | TEXT | 메모 |
| sortOrder | INTEGER | 같은 날/팀 내 순서 |
| createdBy | TEXT | 등록자 userId |
| createdAt | TEXT | |
| updatedAt | TEXT | |

### `production_job_timestamps` — 단계별 타임스탬프

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| jobId | TEXT | 작업 ID |
| event | TEXT | DESIGNER_SENT / FACTORY_CONFIRMED / FACTORY_DONE / TEAM_CONFIRMED / PICKUP_DONE |
| teamId | TEXT | 해당 팀 ID (TEAM_CONFIRMED 시) |
| userId | TEXT | 처리한 사람 |
| memo | TEXT | 비고 |
| occurredAt | TEXT | 이벤트 발생 일시 |

### `production_history` — 완료 작업 영구 보존

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| jobId | TEXT | 원본 job ID |
| snapshot | TEXT | JSON — 완료 시점 전체 데이터 스냅샷 |
| pickupPhoto | TEXT | 픽업 사진 경로 |
| completedAt | TEXT | 완료 일시 |

## A-3. 카드 타임라인 UI (예시)

```
[현수막 OO행사] — 출력팀 — 납기 4/15
──────────────────────────────
✅ 발주    04/10 14:23  (디자이너)
✅ 공장확인 04/10 15:01  (공장담당)
✅ 인쇄완료 04/11 09:15
✅ 출력팀   04/11 10:00
⬜ 픽업     미완료
──────────────────────────────
[픽업완료] 버튼
```

## A-4. API 엔드포인트 (`routes/production.js`)

```
GET    /api/production/jobs?month=YYYY-MM        월별 전체 작업 조회
POST   /api/production/jobs                      작업 생성 (견적 연결 또는 독립)
PUT    /api/production/jobs/:id                  작업 수정 (드래그 이동 포함)
DELETE /api/production/jobs/:id                  작업 삭제
POST   /api/production/jobs/:id/event            타임스탬프 이벤트 기록
POST   /api/production/jobs/:id/pickup           픽업 완료 (사진 업로드)
GET    /api/production/history?q=검색어           완료 이력 검색
GET    /api/production/teams                     팀 목록
POST   /api/production/teams                     팀 추가
PUT    /api/production/teams/:id                 팀 수정/순서
DELETE /api/production/teams/:id                 팀 삭제
```

## A-5. 프론트엔드 (`public/tab-production.html`)

기능 목록:
- [ ] 월별 캘린더 보드 (팀 행 × 날짜 열)
- [ ] 카드 드래그&드롭 → 날짜/팀 이동 자동 저장
- [ ] 작업 추가 모달 (견적서 연결 or 독립 생성)
- [ ] 카드 클릭 → 타임라인 상세 팝업
- [ ] 단계별 확인 버튼 (공장확인/인쇄완료/팀확인/픽업)
- [ ] 픽업 완료 → 카메라 촬영 or 이미지 업로드
- [ ] 시안 파일 첨부 + 다운로드
- [ ] 우클릭 컨텍스트 메뉴 (상태변경/수정/삭제)
- [ ] 납기 D-day 표시 (당일 빨간색 강조)
- [ ] 완료 이력 검색 탭 (날짜/거래처/팀 필터)
- [ ] 브라우저 알림 (납기 당일/전날)
- [ ] 팀 관리 (추가/수정/삭제/순서)
- [ ] 견적서 탭 → "제작보드 등록" 버튼 연동

## A-6. 권한 설계

| 권한 | 할 수 있는 것 |
|------|--------------|
| admin | 모든 기능 + 팀 관리 |
| production_manage | 작업 생성/수정/삭제/이동 |
| production_view | 읽기 전용 |
| 로그인 사용자 | 본인 픽업 처리, 타임스탬프 찍기 |

---

# B. 급여 모듈

> 보안 기반 완료 (requireSalaryAccess, PIN 재인증 30분)  
> 신규: `routes/salary.js`, `public/tab-salary.html`  
> **기준: 대림에스엠 / 대림컴퍼니 실사용 엑셀 양식 완전 분석 반영 (2026-04-15)**

## B-0. 확정 운영 방식

- 전원 **월급제**
- **두 회사 분리 관리** — `companyId`: `dalim-sm` / `dalim-company`
- 매월 **초에 전월 급여 확정**, 급여지급일 별도 기록
- 급여명세서: **PDF 생성 → 개별 저장 or 이메일 발송 (일괄/개별)**
- 소득세: **국세청 근로소득 간이세액표 기준** (부양가족 수 + 자녀 수 입력)
- 소득세 유형: `근로소득 100%` / `근로소득 80%` / `근로소득 120%` / `10%~90%감면` / `사업소득 3.3%` / `기타소득 8.8%`
- **4대보험 상한/하한 및 요율 설정 화면 제공** (매년 변경 대응)
- **월 소정근로시간 직종별 별도 설정** (사무 209 / 외근 224.75 / 공장 241.55 등)
- **통상시급 자동 계산** = 통상임금 ÷ 월 소정근로시간

## B-1. DB 설계 (SQLite)

### `salary_configs` — 직원별 급여 기초 설정

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| userId | TEXT | 직원 ID |
| companyId | TEXT | dalim-sm / dalim-company |
| baseSalary | INTEGER | 기본급 |
| fixedOvertimePay | INTEGER | 고정연장수당 (포괄임금) |
| fixedHolidayPay | INTEGER | 고정휴일수당 (포괄임금) |
| mealAllowance | INTEGER | 식대 |
| transportAllowance | INTEGER | 차량유지비 |
| teamLeaderAllowance | INTEGER | 팀장수당 |
| normalWage | INTEGER | 통상임금 (기본급+고정수당 합계) |
| workingHours | REAL | 월 소정근로시간 (209 / 216.875 / 224.75 / 241.55 등) |
| hourlyRate | REAL | 통상시급 (자동계산: 통상임금 ÷ workingHours) |
| fixedOvertimeHours | REAL | 고정연장 시간 |
| fixedHolidayHours | REAL | 고정휴일 시간 |
| dependents | INTEGER | 부양가족 수 (본인 포함) |
| childrenCount | INTEGER | 7~20세 이하 자녀 수 |
| incomeTaxType | TEXT | 근로소득 100% / 80% / 120% / 90%감면 등 |
| pensionOpt | TEXT | 국민연금 가입 (○ / X) |
| pensionBasisManual | INTEGER | 기준소득월액 수동입력 (null이면 과세합계 자동 적용) |
| healthOpt | TEXT | 건강보험 가입 (○ / X) |
| healthBasisManual | INTEGER | 보수월액 수동입력 (null이면 과세합계 자동 적용) |
| ltcOpt | TEXT | 장기요양보험 가입 (○ / X) |
| employmentOpt | TEXT | 고용보험 가입 (○ / X) |
| bankName | TEXT | 금융기관명 |
| bankAccount | TEXT | 계좌번호 (AES-256-GCM 암호화 저장) |
| email | TEXT | 급여명세서 발송 이메일 |
| effectiveFrom | TEXT | 적용 시작일 YYYY-MM-DD |
| createdAt | TEXT | |

### `salary_records` — 월별 급여 명세 (1행 = 직원 1명 × 1개월)

#### 지급 항목

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| userId | TEXT | 직원 ID |
| companyId | TEXT | |
| yearMonth | TEXT | YYYY-MM |
| payDate | TEXT | 급여지급일 YYYY-MM-DD |
| workDays | INTEGER | 근무일수 |
| workHours | REAL | 기본근무시간 (통상: 209) |
| baseSalary | INTEGER | 기본급 |
| overtimeHours | REAL | 연장근무 시간 |
| overtimePay | INTEGER | 연장수당 |
| nightHours | REAL | 야간근무 시간 |
| nightPay | INTEGER | 야간수당 |
| holidayHours | REAL | 휴일기본 시간 |
| holidayPay | INTEGER | 휴일기본수당 |
| holidayOtHours | REAL | 휴일연장 시간 |
| holidayOtPay | INTEGER | 휴일연장수당 |
| fixedOvertimePay | INTEGER | 고정연장수당 (포괄임금) |
| fixedHolidayPay | INTEGER | 고정휴일수당 (포괄임금) |
| mealAllowance | INTEGER | 식대 |
| transportAllowance | INTEGER | 차량유지비 |
| teamLeaderAllowance | INTEGER | 팀장수당 |
| bonusPay | INTEGER | 상여 (명절/성과 등) |
| retroPay | INTEGER | 소급 (과거 미지급 소급분) |
| leavePay | INTEGER | 연차수당 |
| extraPay1 | INTEGER | 자유 지급 항목 1 |
| extraPay2 | INTEGER | 자유 지급 항목 2 |
| extraPay3 | INTEGER | 자유 지급 항목 3 |
| taxableTotal | INTEGER | 과세합계 |
| nonTaxableTotal | INTEGER | 비과세합계 |
| grossPay | INTEGER | 지급합계 |

#### 공제 항목

| 컬럼 | 타입 | 설명 |
|------|------|------|
| nationalPension | INTEGER | 국민연금 |
| healthInsurance | INTEGER | 건강보험 |
| longTermCare | INTEGER | 장기요양보험 |
| employmentInsurance | INTEGER | 고용보험 |
| incomeTax | INTEGER | 소득세 |
| localTax | INTEGER | 지방소득세 |
| incomeTaxAdj | INTEGER | 정산소득세 (연말정산/중도퇴사 차액) |
| localTaxAdj | INTEGER | 정산지방소득세 |
| healthAnnual | INTEGER | 건강보험 연말정산 추가분 |
| ltcAnnual | INTEGER | 장기요양보험 연말정산 추가분 |
| healthInstallment | INTEGER | 건강보험 분할납부분 (10회분) |
| ltcInstallment | INTEGER | 장기요양보험 분할납부분 (10회분) |
| healthAprExtra | INTEGER | 4월 건강보험 추가분 (전년도 보수 재산정) |
| ltcAprExtra | INTEGER | 4월 장기요양보험 추가분 |
| healthRefundInterest | INTEGER | 건강보험 환급금이자 (음수) |
| ltcRefundInterest | INTEGER | 요양보험 환급금이자 (음수) |
| miscDeduction1 | INTEGER | 과태료 및 주차비 |
| miscDeduction2 | INTEGER | 과태료 및 주차비 2차 |
| extraDeduction1 | INTEGER | 자유 공제 항목 1 |
| extraDeduction2 | INTEGER | 자유 공제 항목 2 |
| extraDeduction3 | INTEGER | 자유 공제 항목 3 |
| totalDeductions | INTEGER | 공제합계 |
| netPay | INTEGER | 실지급액 |

#### 상태 관리

| 컬럼 | 타입 | 설명 |
|------|------|------|
| status | TEXT | draft / confirmed / paid |
| confirmedAt | TEXT | 확정 일시 |
| confirmedBy | TEXT | 확정자 userId |
| paidAt | TEXT | 지급 처리일 |
| note | TEXT | 메모 |

### `salary_item_labels` — 자유 항목명 관리 (월별)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| companyId | TEXT | |
| yearMonth | TEXT | YYYY-MM |
| extraPay1Name | TEXT | 예: '명절상여', '하계휴가비' |
| extraPay2Name | TEXT | |
| extraPay3Name | TEXT | |
| extraDeduction1Name | TEXT | 예: '과태료', '주차비' |
| extraDeduction2Name | TEXT | |
| extraDeduction3Name | TEXT | |

### `salary_edi_records` — EDI 신고 보험료 (공단 고지값)

> 수동 입력 또는 EDI 파일 업로드로 등록 → 시스템 계산값과 자동 비교  
> **건강보험공단 파일 컬럼 구조 분석 완료 (2026-04-15 실파일 기준)**

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| userId | TEXT | 직원 ID (성명으로 매핑) |
| companyId | TEXT | |
| yearMonth | TEXT | YYYY-MM (고지년월 YYYYMM → 변환) |
| healthBasis | INTEGER | EDI 보수월액 (건강보험 기준) |
| healthCalc | INTEGER | EDI 건강보험 산출보험료 |
| healthBilled | INTEGER | EDI 건강보험 고지금액 (실납부액) |
| healthAnnual | INTEGER | EDI 건강보험 연말정산액 |
| ltcCalc | INTEGER | EDI 장기요양 산출보험료 |
| ltcBilled | INTEGER | EDI 장기요양 고지보험료 (실납부액) |
| ltcAnnual | INTEGER | EDI 장기요양 연말정산액 |
| healthRefundInterest | INTEGER | EDI 건강환급금이자 |
| ltcRefundInterest | INTEGER | EDI 요양환급금이자 |
| totalBilled | INTEGER | EDI 가입자 총납부할보험료 |
| pensionBilled | INTEGER | EDI 국민연금 고지액 (국민연금공단 파일 업로드 시) |
| employmentBilled | INTEGER | EDI 고용보험 고지액 (근로복지공단 파일 업로드 시) |
| source | TEXT | manual / health-edi / pension-edi / employment-edi |
| memo | TEXT | 비고 |
| uploadedAt | TEXT | 등록 일시 |
| uploadedBy | TEXT | 등록자 |

#### EDI 파일 파싱 매핑표 (건강보험공단 xls 기준)

| DB 컬럼 | 파일 컬럼명 | 비고 |
|---------|-----------|------|
| yearMonth | 고지년월 | YYYYMM → YYYY-MM 변환 |
| userId | 성명 | salary_configs.name으로 매핑 |
| healthBasis | 보수월액 | |
| healthCalc | 산출보험료 | |
| healthBilled | 고지금액 | 실제 납부액 |
| healthAnnual | 연말정산 | |
| ltcCalc | 요양산출보험료 | |
| ltcBilled | 요양고지보험료 | |
| ltcAnnual | 요양연말정산보험료 | |
| healthRefundInterest | 건강환급금이자 | |
| ltcRefundInterest | 요양환급금이자 | |
| totalBilled | 가입자총납부할보험료 | |

> 국민연금(국민연금공단), 고용보험(근로복지공단)은 별도 파일 → 동일 테이블에 source 구분으로 병합

### `salary_issuances` — 급여명세서 발급대장

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| yearMonth | TEXT | 귀속연월 |
| userId | TEXT | 직원 ID |
| companyId | TEXT | |
| issuedAt | TEXT | 발급 일시 |
| issuedType | TEXT | pdf / email |
| recipient | TEXT | 수신 이메일 (email 발송 시) |
| issuedBy | TEXT | 발급자 userId |
| filePath | TEXT | 저장된 PDF 경로 |

### `income_tax_table` — 근로소득 간이세액표

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | INTEGER PK | |
| year | INTEGER | 적용 연도 |
| salaryFrom | INTEGER | 월급여 구간 시작 (천원 단위) |
| salaryTo | INTEGER | 월급여 구간 끝 |
| dep1 | INTEGER | 부양가족 1명 세액 |
| dep2 | INTEGER | 부양가족 2명 세액 |
| dep3 | INTEGER | 부양가족 3명 세액 |
| dep4 | INTEGER | 부양가족 4명 세액 |
| dep5 | INTEGER | 부양가족 5명 세액 |
| dep6 | INTEGER | 부양가족 6명 세액 |
| dep7 | INTEGER | 부양가족 7명 세액 |
| dep8 | INTEGER | 부양가족 8명 세액 |
| dep9 | INTEGER | 부양가족 9명 세액 |
| dep10 | INTEGER | 부양가족 10명 세액 |
| dep11 | INTEGER | 부양가족 11명 이상 세액 |

### `salary_settings` — 4대보험 요율 설정

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| companyId | TEXT | |
| effectiveFrom | TEXT | 적용 시작일 |
| pensionRate | REAL | 국민연금 요율 (기본 4.5) |
| pensionMax | INTEGER | 국민연금 기준소득 상한 (기본 6,370,000) |
| pensionMin | INTEGER | 국민연금 기준소득 하한 (기본 400,000) |
| healthRate | REAL | 건강보험 요율 (기본 3.545) |
| healthMax | INTEGER | 건강보험 보수 상한 |
| healthMin | INTEGER | 건강보험 보수 하한 |
| ltcRate | REAL | 장기요양보험 요율 (기본 12.95, 건보료 대비) |
| employmentRate | REAL | 고용보험 요율 (기본 0.9) |
| overtimeMultiple | REAL | 연장수당 배수 (기본 1.5) |
| nightMultiple | REAL | 야간수당 배수 (기본 0.5) |
| holidayMultiple | REAL | 휴일기본수당 배수 (기본 1.5) |
| holidayOtMultiple | REAL | 휴일연장수당 배수 (기본 2.0) |
| roundingUnit | TEXT | 절사단위 (원단위/십단위/백단위/천단위) |

## B-2. 급여 계산 로직 (2026년 기준)

```
── 4대보험 ──────────────────────────────────────────
국민연금:       과세합계 × 4.5%  (상한 6,370,000 / 하한 400,000)
                단, 기준소득월액 수동입력 시 해당 금액 기준 적용
건강보험:       과세합계 × 3.545%
                단, 보수월액 수동입력 시 해당 금액 기준 적용
장기요양보험:   건강보험료 × 12.95%
고용보험:       과세합계 × 0.9%
산재보험:       사업주 전액 부담 → 근로자 공제 없음

── 소득세 ───────────────────────────────────────────
과세합계(비과세 제외)를 간이세액표에서 조회
소득세 유형별 배율 적용:
  근로소득 100% → 표준
  근로소득 120% → 표준의 120%
  근로소득 80%  → 표준의 80%
  근로소득 90%감면 → 표준의 10%  (청년 세액감면)
  근로소득 80%감면 → 표준의 20%  ...
  사업소득 3.3% → 과세합계 × 3%  (지방소득세 별도: ×0.3%)
  기타소득 8.8% → 과세합계 × 8%  (지방소득세 별도: ×0.8%)
지방소득세:     소득세 × 10%

── 통상시급 ─────────────────────────────────────────
통상시급 = 통상임금 ÷ 월 소정근로시간
연장수당 = 연장시간 × 통상시급 × 연장배수(1.5)
야간수당 = 야간시간 × 통상시급 × 야간배수(0.5)  ← 연장수당에 추가
휴일기본수당 = 휴일기본시간 × 통상시급 × 휴일배수(1.5)
휴일연장수당 = 휴일연장시간 × 통상시급 × 휴일연장배수(2.0)

── 일할계산 (중도 입/퇴사) ──────────────────────────
1일 급여 = (기본급 + 고정수당) ÷ 정산기간 일수
실지급 = 1일 급여 × 실근무일수

── 과세 / 비과세 구분 ───────────────────────────────
비과세: 식대(월 20만원 한도), 차량유지비, 기타 비과세 항목
과세: 기본급 + 각종 수당 + 상여 + 소급 + 연차수당 - 비과세
```

## B-3. API 엔드포인트 (`routes/salary.js`)

```
모든 엔드포인트: requireSalaryAccess 미들웨어 (로그인 + salary_view 권한 + PIN 재인증)

── 설정 ─────────────────────────────────────────────
GET    /api/salary/settings/:companyId           4대보험 요율 설정 조회
PUT    /api/salary/settings/:companyId           요율 설정 수정

── 직원별 급여 기초 설정 ─────────────────────────────
GET    /api/salary/config?company=&userId=       급여 설정 조회 (회사별/직원별)
POST   /api/salary/config                        급여 설정 저장
PUT    /api/salary/config/:id                    급여 설정 수정

── 월별 급여 ─────────────────────────────────────────
GET    /api/salary/records?company=&month=       월별 급여 목록 (급여대장)
GET    /api/salary/records/:userId/:month        개인 급여 상세
POST   /api/salary/calculate                     급여 자동계산 → draft 생성
PUT    /api/salary/records/:id                   급여 수동 수정 (draft만)
PUT    /api/salary/records/:id/confirm           급여 확정 (수정 잠금)
PUT    /api/salary/records/:id/paid              지급 처리
DELETE /api/salary/records/:id                   draft 삭제

── 자유 항목명 ───────────────────────────────────────
GET    /api/salary/labels?company=&month=        자유 항목명 조회
PUT    /api/salary/labels                        자유 항목명 저장

── 급여명세서 ────────────────────────────────────────
GET    /api/salary/slip/:userId/:month           개인 급여명세서 PDF 생성
POST   /api/salary/slip/bulk                     일괄 PDF 생성
POST   /api/salary/slip/email/:userId/:month     개인 이메일 발송
POST   /api/salary/slip/email/bulk               일괄 이메일 발송

── 조회/다운로드 ─────────────────────────────────────
GET    /api/salary/export?company=&month=        급여대장 엑셀 다운로드
GET    /api/salary/annual/:userId/:year          직원 연간 급여현황
GET    /api/salary/issuances?company=&month=     발급대장 조회

── 간이세액표 ────────────────────────────────────────
GET    /api/salary/tax-table/:year               간이세액표 조회
POST   /api/salary/tax-table                     간이세액표 등록/업데이트

── EDI 보험료 비교 ───────────────────────────────────
GET    /api/salary/edi?company=&month=           EDI 신고값 목록 조회
POST   /api/salary/edi                           EDI 수동 입력 (직원별)
POST   /api/salary/edi/upload                    EDI 파일 업로드 (CSV/엑셀 파싱)
DELETE /api/salary/edi/:id                       EDI 데이터 삭제
GET    /api/salary/edi/compare?company=&month=   시스템 계산값 vs EDI 비교 결과
```

## B-4. 급여명세서 PDF 양식

```
────────────────────────────────────────────────────
        [대림에스엠]   급여명세서
────────────────────────────────────────────────────
 사원번호: WS-016    입사일: 2020-07-01
 성    명: 남관원    부서: 경영관리팀 / 팀장
────────────────────────────────────────────────────
 급여정산기간: 2026-03-01 ~ 2026-03-31
 통상시급: 21,531원   근무: 22일 / 209시간
 급여지급일: 2026-04-05
────────────────────────────────────────────────────
 【지급 내역】                           시간      금액
   기본급                              209    4,300,000
   고정연장수당                                       0
   식대                                          200,000
   팀장수당                                            0
   연장수당                                            0
   상여                                                0
   연차수당                                            0
   소급                                                0
   ────────────────────────────────────────────────
   과세합계                                    4,300,000
   비과세합계                                    200,000
   지급합계                                    4,500,000
────────────────────────────────────────────────────
 【공제 내역】
   국민연금   (4.5%)                           131,310
   건강보험   (3.545%)                         105,160
   장기요양   (12.95%)                          13,610
   고용보험   (0.9%)                            38,700
   소득세                                      249,320
   지방소득세                                    24,930
   정산소득세                                         0
   정산지방소득세                                      0
   건강보험 연말정산                                   0
   장기요양 연말정산                                   0
   과태료 및 주차비                                    0
   ────────────────────────────────────────────────
   공제합계                                      563,030
────────────────────────────────────────────────────
 실지급액                               3,936,970 원
────────────────────────────────────────────────────
 【산출근거】
   4대보험/소득세: 관련 법률 규정에 근거함
   연장수당: 연장시간 × 통상시급 × 1.5배 (야간근무 +0.5배)
   휴일수당: 휴일기본시간 × 통상시급 × 1.5배 (연장 +0.5배)
────────────────────────────────────────────────────
```

## B-5. 프론트엔드 (`public/tab-salary.html`)

기능 목록:
- [ ] PIN 입력 화면 (salary_token 없으면 진입 차단)
- [ ] 회사 선택 탭 (대림에스엠 / 대림컴퍼니)
- [ ] 4대보험 요율 설정 화면 (연도별 변경 대응)
- [ ] 직원별 급여 기초 설정 (기본급, 각종수당, 보험, 세금유형, 계좌)
- [ ] 월별 자유 항목명 설정 (상여/소급/연차수당 외 추가 지급·공제 명칭)
- [ ] 급여 자동계산 버튼 → 연장근무 연동 → draft 생성
- [ ] 급여대장 테이블 (직원 전체 월별 한 화면)
- [ ] 개인 급여명세서 상세 보기 / 항목별 수동 수정
- [ ] 급여 확정 → 수정 잠금 처리
- [ ] 지급 처리 + 지급일 기록
- [ ] 급여명세서 PDF 개별/일괄 생성
- [ ] 급여명세서 이메일 개별/일괄 발송
- [ ] 발급대장 조회 (언제 누가 발급/발송했는지)
- [ ] 직원별 연간 급여현황 (월별 집계 표)
- [ ] 급여대장 엑셀 다운로드
- [ ] 간이세액표 등록/조회 화면
- [ ] **EDI 보험료 비교 화면**
  - 수동 입력: 직원별 국민연금/건강보험/장기요양/고용보험 EDI 고지값 입력
  - 파일 업로드: 4대보험 포털 다운로드 파일(CSV/엑셀) 업로드 → 자동 파싱
  - 비교 테이블: 시스템 계산값 vs EDI 신고값 나란히 표시
  - 차이 강조: 불일치 항목 자동 ⚠️ 표시 + 차액 표시
  - 전체 일치 여부 월별 요약 배지

---

# C. 근태 고도화

> 현재: 출퇴근 기록 있음, 연차 관리 있음  
> 추가: 시간외 자동계산, 급여 연계

## C-0. 확정 근태 규칙

```
정규 근무:
  출근    08:30
  점심    11:30 ~ 13:00 (1.5시간, 실근무 제외)
  퇴근    18:00
  실근무  8시간

야근 규칙:
  18:00 ~ 18:30  → 버퍼 시간 (수당 없음)
  18:30 이후 야근 선언 시 수당 발생
    ├─ 저녁 안 먹은 경우 → 18:00부터 야근 시간 카운트
    └─ 저녁 먹은 경우   → 19:00부터 야근 시간 카운트

주말 영업지원 로테이션:
  월 1회, 1명씩 → 포괄임금제 포함 (별도 수당 없음)

주말 특근:
  케바케 → 5만원 or 10만원 수동 입력
  시간/작업량에 따라 관리자 판단
```

## C-1. DB 설계 (SQLite)

### `overtime_records` — 연장/야간/휴일 근무 기록

> 엑셀 `연장근무` 시트 구조 그대로 반영  
> 귀속월 단위로 등록 (날짜 선택 후 귀속월 자동 계산)

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| userId | TEXT | 직원 ID |
| companyId | TEXT | dalim-sm / dalim-company |
| yearMonth | TEXT | 귀속월 YYYY-MM |
| workDate | TEXT | 실제 근무일 YYYY-MM-DD |
| hourlyRate | REAL | 당시 통상시급 (자동입력, 수정가능) |
| overtimeHours | REAL | 연장근무 시간 |
| overtimePay | INTEGER | 연장수당 (자동계산) |
| nightHours | REAL | 야간근무 시간 |
| nightPay | INTEGER | 야간수당 (자동계산) |
| holidayHours | REAL | 휴일기본 시간 |
| holidayPay | INTEGER | 휴일기본수당 (자동계산) |
| holidayOtHours | REAL | 휴일연장 시간 |
| holidayOtPay | INTEGER | 휴일연장수당 (자동계산) |
| totalPay | INTEGER | 합계금액 |
| memo | TEXT | 메모 |
| createdAt | TEXT | |

## C-2. 시간외 수당 계산 로직

```
── 통상시급 ──────────────────────────────────────────
통상시급 = 통상임금 ÷ 월 소정근로시간
  (salary_configs.hourlyRate 자동 적용, 등록 시 스냅샷 저장)

── 연장수당 ──────────────────────────────────────────
연장수당 = 연장시간 × 통상시급 × 1.5

── 야간수당 ──────────────────────────────────────────
야간수당 = 야간시간 × 통상시급 × 0.5
  (야간은 연장에 추가로 발생 → 연장+야간 동시 적용 가능)

── 휴일수당 ──────────────────────────────────────────
휴일기본수당   = 휴일기본시간 × 통상시급 × 1.5
휴일연장수당   = 휴일연장시간 × 통상시급 × 2.0

── 야근 시간 계산 규칙 (대림에스엠 사내 기준) ───────────
18:00 ~ 18:30  → 버퍼 (수당 없음)
18:30 이후 야근 선언 시:
  저녁 안 먹은 경우 → 18:00부터 카운트 (버퍼 제외 → 실제 18:30부터)
  저녁 먹은 경우   → 19:00부터 카운트
```

## C-3. API 엔드포인트

```
GET    /api/attendance/overtime?company=&userId=&month=   시간외 기록 조회
POST   /api/attendance/overtime                            시간외 기록 등록
PUT    /api/attendance/overtime/:id                        수정
DELETE /api/attendance/overtime/:id                        삭제
GET    /api/attendance/overtime/summary?company=&month=    월별 전체 집계 (급여계산용)
GET    /api/attendance/summary/:userId/:month              개인 월별 근태 요약
```

## C-4. 프론트엔드 수정

`public/tab-attendance.html` 수정:
- [ ] 연장근무 입력 폼 (귀속월 / 근무일 / 연장H / 야간H / 휴일기본H / 휴일연장H / 메모)
- [ ] 통상시급 자동 불러오기 (salary_configs 연동), 수동 수정 가능
- [ ] 수당 자동계산 미리보기 (입력하면 실시간으로 금액 표시)
- [ ] 월별 직원별 연장근무 집계표 (연장/야간/휴일/합계금액)
- [ ] "이 데이터로 급여 계산" 버튼 → 급여 모듈 연동
- [ ] 기존 연장근무 이력 목록 + 수정/삭제

---

# D. 인사기록 고도화 + 제증명 발급

> 현재: 기본 사용자 정보만 있음  
> 추가: 인사기록카드, 발령이력, 제증명 PDF, 서류 요청/수령 시스템

## D-0. 확정 운영 방식

- 근로계약서: 시스템에서 자동 채움 → **마우스/터치 전자서명** → PDF 저장
- 접근: **해당 직원 + 관리자만** (다른 직원 완전 차단)
- 재직/경력증명서 발급: 실제 요청 있음 (자주는 아님)
- 도장 이미지: 기존 `data/stamp.png` 활용

## D-1. 서류 요청/업로드 시스템

```
관리자 흐름:
  직원 선택 → 요청 서류 목록 작성 → 제출 기한 설정 → 발송

  예) 한윤호 → [주민등록등본, 가족관계증명서, 통장사본] → 기한: 04/20

직원 흐름:
  알림 수신 → 서류별 파일 업로드 (항목 하나씩)
  ✅ 주민등록등본   [업로드 완료] 04/12 09:30
  ⬜ 가족관계증명서 [파일 선택...]
  ⬜ 통장사본       [파일 선택...]

관리자 흐름:
  제출 현황 확인 → 파일 다운로드 → 완료 처리
```

보안 규칙:
- 파일 접근: 해당 직원 본인 + admin 권한자만
- 파일 저장 경로: `data/hr-docs/{userId}/` (외부 접근 불가)
- API에 `requireAuth` + 본인 여부 체크 필수

## D-2. DB 설계 (SQLite)

### `employee_records` — 직원 상세 인사기록

| 컬럼 | 타입 | 설명 |
|------|------|------|
| userId | TEXT PK | 직원 ID |
| birthDate | TEXT | 생년월일 |
| gender | TEXT | 성별 |
| address | TEXT | 주소 |
| emergencyContact | TEXT | 비상연락처 이름/관계/전화 |
| education | TEXT | JSON — 학력 목록 |
| career | TEXT | JSON — 경력 목록 |
| certificates | TEXT | JSON — 자격증 목록 |
| family | TEXT | JSON — 가족관계 |
| bankAccount | TEXT | 급여 계좌 (암호화) |
| contractType | TEXT | 정규직 / 계약직 / 파트타임 |
| contractStart | TEXT | 계약 시작일 |
| contractEnd | TEXT | 계약 종료일 (정규직 null) |
| photo | TEXT | 증명사진 경로 |
| updatedAt | TEXT | |

### `personnel_history` — 인사발령 이력

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| userId | TEXT | 직원 ID |
| type | TEXT | hire / promotion / transfer / leave / return / retire |
| fromDept | TEXT | 이전 부서 |
| toDept | TEXT | 변경 부서 |
| fromPosition | TEXT | 이전 직위 |
| toPosition | TEXT | 변경 직위 |
| effectiveDate | TEXT | 발령일 |
| reason | TEXT | 사유 |
| createdAt | TEXT | |

### `document_requests` — 서류 요청

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| targetUserId | TEXT | 요청 대상 직원 |
| requestedBy | TEXT | 요청자 (admin) |
| documents | TEXT | JSON — 요청 서류 목록 |
| dueDate | TEXT | 제출 기한 |
| status | TEXT | pending / partial / completed |
| createdAt | TEXT | |

### `document_submissions` — 서류 제출

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| requestId | TEXT | 요청 ID |
| userId | TEXT | 제출자 |
| docName | TEXT | 서류명 |
| filePath | TEXT | 저장 경로 |
| submittedAt | TEXT | 제출 일시 |

### `document_issuances` — 제증명 발급 이력

| 컬럼 | 타입 | 설명 |
|------|------|------|
| id | TEXT PK | |
| userId | TEXT | 직원 ID |
| docType | TEXT | employment_cert / career_cert / contract |
| issuedAt | TEXT | 발급 일시 |
| issuedBy | TEXT | 발급자 |
| purpose | TEXT | 제출처 |
| filePath | TEXT | 생성된 PDF 경로 |

## D-3. 근로계약서 전자서명 흐름

```
1. 관리자: 직원 선택 → 계약 조건 입력
   (기본급, 직무, 근무장소, 계약기간 등)

2. 시스템: 근로계약서 양식 자동 채움 → 미리보기

3. 관리자 먼저 서명:
   서명란에 마우스/터치로 직접 서명 → 완료

4. 직원에게 서명 요청 알림 전송

5. 직원: 본인 확인 후 서명란에 서명

6. 시스템: 양 측 서명 + 도장(stamp.png) 삽입 → PDF 저장
   → 관리자/직원 둘 다 다운로드 가능

접근 권한: 해당 직원 본인 + admin만
```

## D-4. 제증명 문서 양식

### 재직증명서

```
[회사명]  재직증명서
─────────────────────────────────
성    명: OOO
생년월일: YYYY-MM-DD
부    서: OOO
직    위: OOO
입 사 일: YYYY-MM-DD
고용형태: 정규직

위 사람은 현재 당사에 재직 중임을 증명합니다.

발급일: YYYY년 MM월 DD일
[회사명]       [직인]
```

### 경력증명서

```
[회사명]  경력증명서
─────────────────────────────────
성    명: OOO
재직기간: YYYY-MM-DD ~ 현재
부    서: OOO
직    위: OOO
담당업무: OOO

위 사람의 경력을 증명합니다.

발급일: YYYY년 MM월 DD일
[회사명]       [직인]
```

## D-5. API 엔드포인트 (`routes/hr.js`)

```
GET    /api/hr/records/:userId               인사기록 조회
PUT    /api/hr/records/:userId               인사기록 수정
GET    /api/hr/history/:userId               발령 이력 조회
POST   /api/hr/history                       발령 등록
GET    /api/hr/stats                         인사현황 통계

POST   /api/hr/doc-requests                  서류 요청 생성
GET    /api/hr/doc-requests/:userId          직원별 요청 목록
POST   /api/hr/doc-requests/:id/submit       서류 업로드 (직원)
GET    /api/hr/doc-requests/:id/files/:doc   파일 다운로드

POST   /api/hr/documents/employment-cert     재직증명서 PDF 생성
POST   /api/hr/documents/career-cert         경력증명서 PDF 생성
POST   /api/hr/documents/contract            근로계약서 초안 생성
PUT    /api/hr/documents/contract/:id/sign   서명 저장 (관리자/직원)
GET    /api/hr/documents/history/:userId     발급 이력
```

## D-6. 프론트엔드 (`public/tab-hr.html`)

기능 목록:
- [ ] 직원별 인사기록카드 (상세 정보 입력/조회)
- [ ] 발령이력 타임라인 UI
- [ ] 서류 요청 생성 (서류 목록 지정 + 기한)
- [ ] 직원: 서류 항목별 업로드 화면
- [ ] 서류 요청 현황 (누가 냈고 누가 안 냈는지)
- [ ] 재직증명서 PDF 즉시 발급
- [ ] 경력증명서 PDF 즉시 발급
- [ ] 근로계약서 생성 → 관리자 서명 → 직원 서명 요청 → 완료
- [ ] 마우스/터치 서명 캔버스
- [ ] 발급 이력 조회

---

# 개발 스프린트 계획

## Sprint 1 — 제작흐름보드 ERP 통합
```
① db-sqlite.js: production_teams / production_jobs / production_job_timestamps / production_history 테이블 추가
② routes/production.js: 전체 API 작성
③ server.js: 라우트 등록
④ tab-production.html: 프로토타입 → Alpine.js 변환 + 서버 연동
⑤ index.html: 탭 추가 + state/method 연동
⑥ 권한 추가: production_manage / production_view
⑦ 견적 탭 → 제작보드 등록 버튼 연동
```

## Sprint 2 — 급여 모듈
```
① db-sqlite.js: 아래 테이블 전체 추가
   - salary_configs       (직원별 급여 기초 설정)
   - salary_records       (월별 급여 명세 — 지급 25칸 + 공제 21칸)
   - salary_item_labels   (월별 자유 항목명)
   - salary_issuances     (명세서 발급대장)
   - salary_settings      (4대보험 요율 / 수당 배수 설정)
   - income_tax_table     (근로소득 간이세액표 — 연도별, 구간별, 가족수별)

② income_tax_table: 2023년 개정 간이세액표 데이터 입력
   (부양가족 1~11명, 월급여 770천원 이상 전 구간)

③ routes/salary.js: 전체 API 구현 (requireSalaryAccess 전 엔드포인트 적용)
   - 4대보험 요율 설정 CRUD
   - 직원별 급여 설정 CRUD
   - 월별 급여 자동계산 (overtime_records 연동)
   - 급여 확정/지급 처리
   - 발급대장 관리

④ utils/salary-calc.js: 급여 계산 함수 모듈
   - 4대보험 계산 (기준소득월액/보수월액 수동입력 분기)
   - 소득세 유형별 계산 (100% / 90%감면 / 120% / 사업소득 3.3% 등)
   - 통상시급 계산
   - 과세/비과세 분리
   - 일할계산 (중도 입/퇴사)

⑤ tab-salary.html: 전체 UI
   - PIN 화면
   - 회사 선택 (대림에스엠 / 대림컴퍼니)
   - 4대보험 요율 설정 화면
   - 직원별 기초 설정 (계좌 AES 암호화 포함)
   - 급여대장 (월별 전체 직원 테이블)
   - 개인 명세서 상세 + 수동 수정
   - 자유 항목명 설정

⑥ 급여명세서 PDF 생성 (pdfkit + NanumGothic.ttf)
   - 산출근거 섹션 자동 생성
   - 발급대장 자동 기록

⑦ 급여명세서 이메일 발송 (개별 / 일괄)

⑧ 급여대장 엑셀 다운로드 (exceljs)

⑨ 연간 급여현황 조회 화면

⑩ 간이세액표 관리 화면

⑪ EDI 보험료 비교 기능
   - salary_edi_records 테이블 추가
   - /api/salary/edi/* 엔드포인트
   - EDI 파일 파싱 (4대보험 포털 다운로드 형식)
   - 비교 화면: 시스템 계산값 vs EDI 신고값, 차이 자동 강조
```

## Sprint 3 — 근태 고도화
```
① db-sqlite.js: overtime_records 테이블 추가
   (귀속월 / 근무일 / 통상시급 / 연장H+수당 / 야간H+수당 / 휴일기본H+수당 / 휴일연장H+수당 / 합계 / 메모)

② routes/attendance.js: 시간외 API 추가
   - 월별/직원별 조회
   - 등록/수정/삭제
   - 월별 전체 집계 (급여계산 연동용)

③ utils/overtime-calc.js: 시간외 계산 모듈
   - 통상시급 자동 불러오기 (salary_configs 연동)
   - 연장/야간/휴일기본/휴일연장 배수 자동 적용 (salary_settings 연동)

④ tab-attendance.html 수정
   - 연장근무 입력 폼 (귀속월/근무일/각 근무유형 시간/메모)
   - 수당 실시간 자동계산 미리보기
   - 월별 직원별 집계표
   - "이 데이터로 급여 계산" 버튼 → salary_records 생성

⑤ 급여 모듈 연동: overtime_records → salary_records 자동 반영
```

## Sprint 4 — 인사기록 + 제증명
```
① db-sqlite.js: 아래 테이블 추가
   - employee_records     (직원 상세 인사기록)
   - personnel_history    (인사발령 이력)
   - document_requests    (서류 요청)
   - document_submissions (서류 제출)
   - document_issuances   (제증명 발급 이력)

② routes/hr.js: 전체 API
③ 서류 요청/업로드 시스템 (보안: 본인+admin만 접근)
④ 재직/경력증명서 PDF 생성 (stamp.png 직인 삽입)
⑤ 근로계약서 자동채움 + 전자서명 캔버스 (관리자→직원 순서)
⑥ tab-hr.html 전체 구현
```

---

# 기술 메모

## PDF 생성
- `pdfkit` (npm) + NanumGothic.ttf 한글 폰트
- 도장: `data/stamp.png` 삽입
- 서명: canvas → base64 → PDF에 이미지로 삽입

## 엑셀 생성
- `exceljs` (npm) — 스타일링 자유도 높음

## 파일 보안
- HR 서류 저장: `data/hr-docs/{userId}/` (라우트에서만 접근)
- 직접 URL 접근 차단 (Express static 제외)

## 암호화 (급여 계좌번호 등)
- `crypto.createCipheriv` AES-256-GCM
- 키: `data/설정.json` 또는 환경변수

## 근로계약서 법적 필수 항목 (근로기준법 제17조)
1. 임금 구성항목·계산방법·지급방법
2. 소정근로시간
3. 휴일 (제55조)
4. 연차 유급휴가 (제60조)
5. 취업 장소 및 담당 업무
