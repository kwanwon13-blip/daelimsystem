---
name: ecount-api
description: "iCOUNT(이카운트) ERP Open API 통합 가이드. 이카운트 API 연동, 인증, 품목 조회, 세션 관리, 페이지네이션 전략을 다룹니다. 이카운트, ecount, ERP, 품목 조회, 단가표, 재고, 매출, 매입 등 이카운트 관련 작업 시 반드시 이 스킬을 사용하세요."
---

# iCOUNT (이카운트) ERP Open API 통합 가이드

이카운트 ERP의 Open API를 활용한 서버 연동 시 참고할 완전한 레퍼런스 문서입니다.

## 1. 서버 구분

이카운트 API는 **테스트 서버**와 **실서버(운영)** 두 가지 환경을 제공합니다.

| 구분 | 호스트 패턴 | 용도 |
|------|------------|------|
| 테스트 서버 | `sboapi{ZONE}.ecount.com` | 개발/테스트용 |
| 실서버 (운영) | `oapi{ZONE}.ecount.com` | 실제 운영 데이터 |

**중요**: Zone 조회 API는 서버 타입에 관계없이 항상 `sboapi.ecount.com`을 사용합니다 (oapi 아님).

## 2. 인증 플로우

인증은 3단계로 진행됩니다:

### 2-1. Zone 조회

```
POST https://sboapi.ecount.com/OAPI/V2/Zone
Content-Type: application/json

{
  "COM_CODE": "회사코드"
}
```

응답에서 `Data.ZONE` 값(예: `"5"`)을 추출합니다. 이 값으로 이후 API 호스트를 결정합니다.

### 2-2. 로그인 (세션 발급)

```
POST https://{HOST}/OAPI/V2/OAPILogin
Content-Type: application/json

{
  "COM_CODE": "회사코드",
  "USER_ID": "사용자ID",
  "API_CERT_KEY": "API인증키",
  "LAN_TYPE": "ko-KR",
  "ZONE": "5"
}
```

- `{HOST}` = 실서버: `oapi{ZONE}.ecount.com` / 테스트: `sboapi{ZONE}.ecount.com`
- 응답의 `Data.Datas.SESSION_ID`를 저장하여 이후 모든 API 호출에 사용

### 2-3. 에러 코드

| 코드 | 의미 | 대응 |
|------|------|------|
| 1 | 성공 | - |
| 204 | 인증키 불일치 | "실서버용 인증키입니다" → 서버 타입을 `oapi`로 변경. "테스트서버용 인증키입니다" → `sboapi`로 변경 |
| 그 외 | 로그인 실패 | Status.Message 확인 |

## 3. 품목 조회 API (GetBasicProductsList)

### 3-1. 엔드포인트

```
POST https://{HOST}/OAPI/V2/InventoryBasic/GetBasicProductsList?SESSION_ID={세션ID}
Content-Type: application/json
```

### 3-2. 요청 파라미터

| 파라미터 | 타입 | 필수 | 설명 |
|----------|------|------|------|
| SESSION_ID | String | Y | 쿼리스트링으로 전달 |
| PROD_CD | String | N | 품목코드 (정확히 일치) |
| COMMA_FLAG | String | N | "Y"이면 PROD_CD를 콤마로 분리하여 복수 조회 |
| PROD_TYPE | String | N | 품목유형 필터 (아래 참조) |
| FROM_PROD_CD | String | N | 품목코드 범위 시작 |
| TO_PROD_CD | String | N | 품목코드 범위 끝 |

**주의**: `START_NUM`, `END_NUM`, `PAGE`, `OFFSET` 같은 페이지네이션 파라미터는 존재하지 않습니다.

### 3-3. PROD_TYPE 값

품목 유형 코드와 구분자:

| 코드 | 유형 |
|------|------|
| 0 | 원자재 |
| 1 | 제품 |
| 2 | 반제품 |
| 3 | 상품 |
| 4 | 부재료 |
| 7 | 무형상품 |

복수 유형 조회 시 구분자는 `∬` (더블 인테그럴, U+222C)을 사용합니다.
예: `"0∬1∬3"` → 원자재 + 제품 + 상품

### 3-4. 응답 구조

```json
{
  "Status": "200",
  "Data": {
    "EXPIRE_DATE": "",
    "QUANTITY_INFO": "시간당 연속 오류 제한 건수:0/30, 1시간 허용량:3/6000, 1일 허용량:4/10000",
    "TRACE_ID": "...",
    "Result": [
      {
          "PROD_CD": "품목코드",
          "PROD_DES": "품목명",
          "PROD_TYPE": "3",
          "SIZE_DES": "규격",
          "UNIT": "단위",
          "IN_PRICE": "입고단가",
          "OUT_PRICE": "출고단가",
          "OUT_PRICE1": "단가A",
          "OUT_PRICE2": "단가B",
          "OUT_PRICE3": "단가C",
          "OUT_PRICE4": "단가D",
          "OUT_PRICE5": "단가E",
          "OUT_PRICE6": "단가F",
          "OUT_PRICE7": "단가G",
          "OUT_PRICE8": "단가H",
          "OUT_PRICE9": "단가I",
          "OUT_PRICE10": "단가J",
          "BAL_FLAG": "사용여부",
          "CLASS_CD": "분류코드1",
          "CLASS_CD2": "분류코드2",
          "CLASS_CD3": "분류코드3",
          "CONT1": "적요",
          "WH_CD": "창고코드",
          "SET_FLAG": "세트여부",
          "CS_FLAG": "CS품목여부"
        }
      ]
    }
  }
}
```

**중요**: 응답 배열 경로는 `r.Data.Result` (문서에 명시됨). `TotalCnt`는 공식 Result 필드에 없으나 응답에 포함될 수 있고 10,000에서 잘릴 수 있어 신뢰 불가.

### 3-5. 10,000건 제한과 페이지네이션 전략

API는 한 번의 호출에 최대 약 10,000건만 반환합니다. **공식 페이지네이션 파라미터는 없습니다.**

**실측 결과 (2025년 확인)**:
- `FROM_PROD_CD` 단독 사용 시 **무시됨** (같은 10,000건 반환)
- `START_NUM` / `END_NUM` / `PAGE` 같은 파라미터는 **존재하지 않음**
- 빈 결과(0건)도 `QUANTITY_INFO`의 "연속 오류 제한 건수"에 카운트됨

**권장 전략: 스마트 PROD_TYPE 분할**

1단계: 필터 없이 전체 조회 (최대 10,000개)
2단계: 10,000개 도달 시, 1단계 결과에서 실제 존재하는 PROD_TYPE 파악
3단계: 존재하는 PROD_TYPE별로 개별 요청 (빈 타입은 건너뜀!)
4단계: 1단계에 없던 PROD_TYPE도 확인 (10,000 컷에서 빠졌을 수 있음)

```javascript
// 1차: 필터 없이 조회
const r1 = await ecountPost(host, path, {}, timeout);
const batch1 = extractBatch(r1);
if (batch1.length < 9900) { /* 전체 데이터 */ }
else {
  // 1차 결과에서 PROD_TYPE 분포 파악
  const typeCounts = {};
  for (const item of batch1) typeCounts[item.PROD_TYPE] = (typeCounts[item.PROD_TYPE]||0) + 1;

  // 데이터 있는 타입만 개별 요청 (10초 딜레이)
  for (const pt of Object.keys(typeCounts)) {
    await delay(10000);
    const rn = await ecountPost(host, path, { PROD_TYPE: pt }, timeout);
    // 중복 제거 후 합산
  }

  // 1차에 없던 타입도 확인
  for (const pt of missingTypes) { /* ... */ }
}
```

**핵심 주의사항**:
- **요청 간 최소 10초 딜레이** (3초는 412 에러 유발 확인됨)
- 빈 PROD_TYPE 조회를 피해야 함 (연속 오류 카운트 낭비)
- PROD_CD 기준으로 중복 제거 필수
- 단일 PROD_TYPE 내 10,000개 초과 시 추가 분할 불가능 (API 한계)

## 4. API 제한 (Rate Limits)

| 제한 | 값 |
|------|-----|
| 시간당 요청 수 | 6,000회 |
| 일일 요청 수 | 5,000~10,000회 (회사별 상이) |
| 시간당 연속 에러 | 30회 초과 시 차단 |

412 Precondition Failed가 반환되면 요청 간격을 늘려야 합니다 (최소 3초). 연속 에러가 30회를 넘기면 해당 시간 동안 API 접근이 차단됩니다.

## 5. 세션 관리

- SESSION_ID는 로그인 후 발급되며, 일정 시간 후 만료됩니다
- 만료 시 다시 로그인하여 새 SESSION_ID를 발급받아야 합니다
- 동시에 여러 세션을 유지하면 이전 세션이 무효화될 수 있습니다

## 6. Node.js 구현 팁

### 6-1. 호스트 결정 함수

```javascript
function ecountApiHost(zone, serverType) {
  const prefix = serverType === 'real' ? 'oapi' : 'sboapi';
  return zone ? `${prefix}${zone}.ecount.com` : `${prefix}.ecount.com`;
}
```

### 6-2. 타임아웃 설정

대량 데이터 응답(10,000건)은 시간이 오래 걸릴 수 있으므로:
- 일반 API: 15초
- 품목 전체 조회: 120초 이상 권장

### 6-3. 캐시 전략

전체 품목 데이터가 60,000건 이상인 경우:
- 서버 메모리에 전체 캐시 유지
- TTL 2시간으로 설정하여 주기적 갱신
- 캐시 로딩 중 상태를 프론트엔드에 전달 (SSE 또는 폴링)

## 7. 기타 참고사항

- API 인증키는 이카운트 관리자 페이지에서 발급
- 실서버용/테스트서버용 인증키가 별도이므로 서버 타입에 맞는 키 사용 필수
- LAN_TYPE: `"ko-KR"` (한국어), `"en-US"` (영어), `"zh-CN"` (중국어), `"ja-JP"` (일본어), `"vi-VN"` (베트남어)
- API 응답의 숫자값은 대부분 문자열로 반환되므로 파싱 시 주의
