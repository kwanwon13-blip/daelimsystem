# ERP AI 업무 처리기 — 점검 강화 + 입력 견고화 설계

작성일: 2026-06-09
상태: 설계 확정 (구현 전 / 검토 대기)
선행 스펙: `docs/superpowers/specs/2026-06-08-ai-work-processor-design.md`

## 1. 한 줄

처리기를 "더 똑똑하게" — **① 결과가 진짜 맞는지 검산하고(정확), ② 어떤 엑셀 형식을 올려도 안 깨지게(견고)**. 두 가지 모두 한 원칙: **조용히 틀리거나 조용히 실패하지 않는다.**

## 2. 배경 (왜)

- **검산**: 현재 자동점검은 "결과 파일이 비었나"만 본다. 합계가 틀려도 통과한다. 사장님이 결과를 믿으려면 "숫자가 맞다"를 시스템이 보증해야 한다.
- **입력**: 업로드는 `.xls/.csv/.xlsm`을 받지만(`public/ai-chat.html:335`), 감지·분류·라우팅 4곳이 모두 `/\.xlsx$/i`만 처리한다(`agent-runtime.js:312,489,594`, `ledger-router.js:13,23`). 이카운트는 `.xls/.csv`로도 내보내므로 → **올렸는데 조용히 아무 일도 안 일어남.** (입력 인식 집중 리뷰에서 확정 12곳.)

## 3. Part A — 스크립트 자가검산

### 3.1 핵심
원본 합계와 결과 합계는 **원래 다르다**(매출할인 제외·부가세 추가·현장 분할 등 정당한 변환). 그래서 무작정 비교하면 멀쩡한 걸 🚩로 오인한다. → **변환을 수행한 스크립트가 직접 검산표를 출력**하고, 시스템은 그 숫자로 균형을 판정한다.

### 3.2 검산표 계약 (스크립트 stdout)
마감 스크립트가 결과 생성 후 한 줄:
```
[RECON] {"raw_rows":120,"raw_total":45000000,"excluded_rows":3,"excluded_total":150000,"excluded_note":"매출할인","out_rows":117,"out_total":44850000}
```
- 스크립트는 이미 이 숫자를 안다(자기가 합산·제외했으니). 출력 한 줄만 추가.

### 3.3 판정 규칙 (`lib/ledger-autocheck.js`, 순수)
- `parseRecon(stdout)` → 마지막 `[RECON] {json}` 추출, 없으면 null.
- `judgeRecon(recon, {amountTol, rowTol})`:
  - **합계 균형**: `|raw_total - (out_total + excluded_total)| <= amountTol` (반올림 흡수, 기본 amountTol = 행수×1 + 10원).
  - **행 커버리지**: `|raw_rows - (out_rows + excluded_rows)| <= rowTol` (기본 0).
  - 둘 다 OK → `pass`. 어긋나면 `warn` + 구체 사유("합계 100만 안 맞음").
- `autocheckLedger`: recon 있으면 `judgeRecon` 우선, **없으면 기존 보수적 점검으로 폴백**(+ "정밀검산 미적용" 표시). 점검 코드가 죽어도 결과 반환은 안 막힘(try/catch).

### 3.4 표시
- ✅ `점검 통과 — 입력 120행 4,500만 = 결과 117행 4,485만 + 제외 15만(매출할인 3건)`
- 🚩 `확인 필요 — 합계 100만 안 맞음` (숫자 근거 포함)

### 3.5 적용 범위
- `make_persys.py`를 레퍼런스로 `[RECON]` 출력 추가 → 나머지 4개(nicetech/haatz/partner/posco) 동일 패턴 점진(폴백 덕에 안 급함).
- `buildGenerationInstruction`(ledger-router.js): AI 생성 스크립트도 `[RECON]` 출력하도록 지시 추가.

## 4. Part B — 입력 정규화 & 인식 견고화

### 4.1 문 앞 정규화 (한 곳에서)
감지 4곳을 각각 고치는 대신, **업로드 들어오는 순간 1곳에서** 스프레드시트를 `.xlsx`로 통일:
```
.xls / .csv / .xlsm  →  [SheetJS 변환]  →  .xlsx  →  기존 파이프라인 그대로
.xlsx                →  그대로
```
- 신규 모듈 `lib/spreadsheet-normalize.js`: `normalizeToXlsx(srcPath)` → `{ path, converted, originalExt }`. SheetJS(`xlsx`)가 `.xls`(BIFF)·`.csv` 읽고 `.xlsx`로 write. `.xlsx`는 그대로 반환.
- 호출 지점: 업로드 핸들러(`POST /api/ai/attachments`)에서 multer 저장 직후 — 스프레드시트면 변환해 **`.xlsx`를 정식 저장**(원본 확장자는 메타에 기록). 이후 감지·스크립트·미리보기 전부 `.xlsx`만 보면 됨(다운스트림 무변경 = 올바른 깊이의 수정).

### 4.2 못 읽는 입력 → 명확 안내 (조용한 실패 0)
- 변환 실패(손상 파일 등) → "이 파일은 못 읽었어요 — 이카운트에서 **.xlsx**로 저장해 다시 올려주세요" (조용히 넘기지 않음).
- `.pdf`/이미지 + 마감 의도 → "마감은 엑셀(.xlsx/.csv) 파일이 필요해요" 안내.
- 감지·복사(harvestFiles)·추출 실패의 빈 `catch`에 **사용자에게 가는 한 줄 신호** 추가.

### 4.3 의존성 / 보안
- 신규 패키지 `xlsx`(SheetJS) — 로컬+서버 PC `npm install`. **유지보수되는 최신 버전** 사용(외부 파일 파싱 CVE 회피).
- 외부 서비스 전송 ❌ — 변환은 100% 로컬.

## 5. 구성요소 (단위)
| 단위 | 책임 | 의존 |
|------|------|------|
| `lib/ledger-autocheck.js` | `parseRecon`·`judgeRecon` 추가, 기존 판정에 우선·폴백 | (순수) |
| `lib/spreadsheet-normalize.js` (신규) | `.xls/.csv/.xlsm → .xlsx` 변환, 실패 시 명확 에러 | SheetJS |
| `routes/ai-history.js` 업로드 핸들러 | 저장 직후 정규화 호출 | normalize |
| `make_persys.py` (+ 점진 4개) | `[RECON]` 출력 | — |
| `lib/ledger-router.js` `buildGenerationInstruction` | 생성 스크립트도 `[RECON]` | — |

## 6. 데이터 흐름
```
업로드(.xls/.csv/.xlsm/.xlsx)
  → 정규화 → .xlsx (실패 시 안내, 끝)
  → (기존) 감지/분류/마감 실행
  → 스크립트가 [RECON] 출력
  → autocheck: recon 파싱 → 균형·커버리지 판정 → ✅/🚩 (없으면 보수적 폴백)
  → 결과 + 점검 표시 (실패해도 결과는 줌)
```

## 7. 에러 처리 원칙
- **안 막음**: 검산·정규화 보조 단계가 실패해도 가능한 결과는 반환.
- **조용한 실패 0**: 못 읽음/못 변환/점검 실패는 항상 사용자에게 한 줄로 표시.

## 8. 테스트 전략
- `judgeRecon`/`parseRecon`/`formatVerdictKorean`: 순수 단위테스트(균형 OK/합계 어긋남/커버리지 어긋남/recon 없음 폴백).
- `normalizeToXlsx`: SheetJS로 `.csv`·`.xls` 픽스처 생성 → 변환 → exceljs로 다시 열려 데이터 일치 확인 / 손상 입력 → 에러.
- 회귀: 기존 `ledger-autocheck`·`vendor-detect-scan` 테스트 유지.

## 9. 범위
- **포함**: 자가검산(JS측 + persys 레퍼런스 + 생성지시문), 입력 정규화(.xls/.csv/.xlsm→.xlsx), 조용한 실패 제거.
- **비포함(별도)**: 나머지 4개 스크립트 `[RECON]`(점진), `.xls→.xlsx` 양식(template) 서식 완전보존, **엑셀 미리보기 충실도**(별도 조사 진행 중).

## 10. 구현 시 정할 것
- 검산 허용오차(amountTol/rowTol) 기본값 — persys 실제 파일로 보정.
- 정규화를 업로드 핸들러 vs 첨부 해소 시점 중 어디서 — 업로드 권장(정식 .xlsx 1개).
- `.xlsm` 매크로 손실 허용(마감엔 데이터만 필요) 확인.
- SheetJS 버전 고정·설치 가이드(서버 PC 포함).
