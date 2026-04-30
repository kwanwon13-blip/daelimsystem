

========================================
## Zone (idx=16)
========================================

# Zone API

개요
외부 서비스와 연계를 위한 호스트정보인 ZoneAPI를 제공합니다.

Open API 호출 실패(회사정보 오류) 방지 및 IP 차단 정책
차단 기준: 동일 IP에서 zone, login인 호출 실패가 10회 이상 반복 발생하는 경우

zone, login 유효성 검증
로그인 호출 전에 회사코드/인증정보 정확성 검증 로직을 포함합니다.
실패 재시도(리트라이) 제한
동일 파라미터로 실패가 반복될 경우 무한 재시도 금지
재시도 횟수/간격 제한, 일정 횟수 실패 시 즉시 중단하도록 설계합니다.
오류 발생 시 즉시 중단 및 알림
로그인 실패 누적 시 자동 호출을 중단하고, 운영자가 인지할 수 있도록 로그/알림을 남깁니다.

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi.ecount.com/OAPI/V2/Zone |
| Request URL | https://oapi.ecount.com/OAPI/V2/Zone |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| COM_CODE | 회사코드 | 6 | Y | 이카운트 ERP 로그인할 때 사용하는 회사코드 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| ZONE | Sub domain Zone | 6 | Y | 로그인API 호출시 사용될 Zone 정보 |
| DOMAIN | Domain | 30 | Y | 로그인API 호출시 사용될 도메인 정보 |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |

Example Parameter
URL : https://oapi.ecount.com/OAPI/V2/Zone
{
    "COM_CODE":"80001"
}
Example Result
[SUCCESS]
{
    "Data":
    {   
        "EXPIRE_DATE":"",
        "ZONE":"A",
        "DOMAIN":".ecount.com"
    },
    "Status":"200",
    "Error":null,
    "Timestamp":"2018년 6월 11일 오후 1:09:21"
}
[FAIL]
{
    "Data":null,
    "Status":"500",
    "Error":
    {
        "Code":201,
        "Message":Zone 정보가 없습니다.,
        "MessageDetail":""
    },
    "Timestamp":null
}
오류 종류별 설명
| Status | "Error" > "Code" | 설명 |
| 200 | 없음 | 정상 처리된 경우 |
| 404 | 없음 | API path가 잘못되어 존재하지 않는 API를 호출한 경우 |
| 412 | 없음 | API 전송 횟수 기준을 넘은 경우 |
| 500 | 100 | Zone 정보가 없습니다. |

* 서버요청 제한 건수를 초과하는 경우 HTTP 412 Forbidden, 302 Object Moved 오류가 발생합니다.
* Content-Type을 application/json로 보내지 않는 경우 Message에 'Unsupported Media Type' 이 표기됩니다.
* 입력값이 유효한 JSON 데이터가 아닐 경우 Message에 'Model validation state error'이 표기됩니다.



========================================
## 로그인 (idx=17)
========================================

# 로그인API

개요
외부 서비스와 연계를 위해서 로그인API를 제공합니다.

Open API 호출 실패(회사정보 오류) 방지 및 IP 차단 정책
차단 기준: 동일 IP에서 zone, login인 호출 실패가 10회 이상 반복 발생하는 경우

zone, login 유효성 검증
로그인 호출 전에 회사코드/인증정보 정확성 검증 로직을 포함합니다.
실패 재시도(리트라이) 제한
동일 파라미터로 실패가 반복될 경우 무한 재시도 금지
재시도 횟수/간격 제한, 일정 횟수 실패 시 즉시 중단하도록 설계합니다.
오류 발생 시 즉시 중단 및 알림
로그인 실패 누적 시 자동 호출을 중단하고, 운영자가 인지할 수 있도록 로그/알림을 남깁니다.

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/OAPILogin |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/OAPILogin |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| COM_CODE | 회사코드 | 6 | Y | 이카운트 ERP 로그인할 때 사용하는 회사코드 |
| USER_ID | 사용자ID | 30 | Y | 아래 API_CERT_KEY (테스트인증키)를 발급받은 이카운트 ID |
| API_CERT_KEY | 테스트인증키 | 50 | Y | 이카운트ERP 로그인 후, Self-Customizing > 정보관리 > API인증키발급 > API인증현황 > 테스트 인증키에서 발급받은 인증키 |
| LAN_TYPE | 언어설정 | 50 | Y | ko-KR : 한국어 (Default) en-US : English zh-CN : 简体中文 zh-TW : 繁体中文 ja-JP : 日本語 vi-VN : Việt Nam es : Español id-ID : Indonesian |
| ZONE | ZONE | 2 | Y | DOMAIN ZONE |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| COM_CODE | 회사코드 | 6 | Y | URL 호출시 입력한 COM_CODE(회사코드) |
| USER_ID | 사용자ID | 30 | Y | URL 호출시 입력한 USER_ID(발급ID) |
| SESSION_ID | 세션ID | 50 | Y | URL 호출 후 생성된 세션ID, 이후 인증으로 사용하는 SESSION_ID(세션ID) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| NOTICE | NOTICE |  | Y | 이카운트 API 공지사항 |

Example Parameter

{
    "COM_CODE":"80001",                  // USER COM_CODE input 
    "USER_ID":"USER_ID",                 // USER USER_ID input
    "API_CERT_KEY":"{API_CERT_KEY}",     // USER API_CERT_KEY input
    "LAN_TYPE":"ko-KR",                  // USER LAN_TYPE input   
    "ZONE":"C"                           // USER ZONE input
}
Example Result
[SUCCESS]
{
    "Data":
    {
        "EXPIRE_DATE":"",
        "NOTICE":"",
        "Code":"00",
        "Datas":
        {
            "COM_CODE":"80001",
            "USER_ID":"USER_ID",
            "SESSION_ID":"39313231367c256562253866253939256563253838253938:0HDD9DBtZt2e"
        },
        "Message":"",
        "RedirectUrl":""
    },
    "Status":"200",
    "Error":null,
    "Timestamp":"2018년 6월 11일 오후 1:09:21"
}
[FAIL]
{
    "Data":null,
    "Status":"200",
    "Error":
    {
        "Code":201,
        "Message":API_CERT_KEY가 유효하지 않습니다.,
        "MessageDetail":""
    },
    "Timestamp":null
}
오류 종류별 설명
| Status | "Error" > "Code" | 설명 |
| 200 | 없음 | 정상 처리된 경우 |
| 404 | 없음 | API path가 잘못되어 존재하지 않는 API를 호출한 경우 |
| 412 | 없음 | API 전송 횟수 기준을 넘은 경우 |
| 200 | 20 | 올바른 Code, ID, PW를 입력해주세요. 로그인 정보를 알 수 없는 경우에는 마스터ID 사용자에게 문의해주세요. |
| 21 | 임시접속차단이 설정되어 접속이 차단되었습니다. 마스터에게 문의 바랍니다 |
| 22 | [개인-접속제한시간설정] [FROM] ~ [TO]까지는 로그인할 수 없습니다.우리회사 마스터에게 문의하십시오. |
| 23 | [회사-접속제한시간설정] [FROM] ~ [TO]까지는 로그인할 수 없습니다.우리회사 마스터에게 문의하십시오. |
| 24 | [개인-IP별차단기능(PC)] 해당 IP에서는 로그인할 수 없습니다.우리회사 마스터에게 문의 바랍니다. |
| 25 | [회사-IP별차단기능(PC)] 해당 IP에서는 로그인할 수 없습니다.우리회사 마스터에게 문의 바랍니다. |
| 26 | 어플리케이션 사용이 제한되어 접속할 수 없습니다. |
| 27 | [모바일 로그인] 우리회사 마스터[OOO]에게 모바일로그인 허용을 요청 바랍니다. |
| 81, 82, 83 | 귀사는 미수차단되어 API를 이용할 수 없습니다. |
| 84 | 귀사는 가입비 미수차단되어 API를 이용할 수 없습니다. |
| 85 | 귀사는 사용차단되어 API를 이용할 수 없습니다. |
| 89 | 귀사는 탈퇴처리 되어 API를 이용할 수 없습니다. |
| 98 | 비밀번호를 5회 이상 잘못 입력했습니다.\n\n마스터에게 문의하여 비밀번호를 변경 하거나, 마스터인경우 비밀번호 재설정 후 다시 로그인 바랍니다. |
| 99 | 해당 아이디가 존재하지 않습니다. |
| 201 | API_CERT_KEY가 유효하지 않습니다. |
| 204 | 테스트용 인증키입니다. / 실서버용 인증키입니다. |
| 205 | [접속IP]허용되지 않은 IP입니다. ERP > API인증키발급 > IP등록을 진행하시기 바랍니다. |

* 서버요청 제한 건수를 초과하는 경우 HTTP 412 Forbidden, 302 Object Moved 오류가 발생합니다.
* Content-Type을 application/json로 보내지 않는 경우 Message에 'Unsupported Media Type' 이 표기됩니다.
* 입력값이 유효한 JSON 데이터가 아닐 경우 Message에 'Model validation state error'이 표기됩니다.



========================================
## 거래처등록 (idx=19)
========================================

# 거래처등록

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/AccountBasic/SaveBasicCust?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/AccountBasic/SaveBasicCust?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 입력필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| CustList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| BUSINESS_NO | 사업자등록번호 | STRING(30) | Y |  | ERP 거래처코드. 일반적으로 사업자번호 10자리를 입력. |
| CUST_NAME | 회사명 | STRING(100) | Y |  | 회사명 최대 100자 |
| BOSS_NAME | 대표자명 | STRING(50) |  |  | 대표자명 |
| UPTAE | 업태 | STRING(50) |  |  | 업태 |
| JONGMOK | 종목 | STRING(50) |  |  | 종목 |
| TEL | 전화번호 | STRING(50) |  |  | 전화번호 |
| EMAIL | 이메일 | STRING(100) |  |  | 이메일 |
| POST_NO | 우편번호 | STRING(8) |  |  | 우편번호 |
| ADDR | 주소 | STRING(500) |  |  | 주소 |
| G_GUBUN | 거래처코드구분 | STRING(2) |  |  | 거래처코드구분 : (01:사업자등록번호, 02:주민등록번호, 03:외국인)/ 미입력 시 01 이 기본값 |
| G_BUSINESS_TYPE | 세무신고거래처구분 | STRING(1) |  |  | 세무신고거래처 구분 ((1 or NULL) =거래처동일, 2=검색입력, 3=직접입력) 재고1 > 기초등록 > 거래처등록 > 신규 > 옵션 > 입력화면설정에서 반드시 항목설정이 되어있어야 함. |
| G_BUSINESS_CD | 세무신고거래처코드 | STRING(30) |  |  | 검색입력을 선택할 경우에는, 기 등록된 거래처 코드 또는 명을 입력 |
| TAX_REG_ID | 종사업장번호 | NUMERIC(4,0) |  |  | 종사업장번호 |
| FAX | Fax | STRING(50) |  |  | Fax |
| HP_NO | 모바일 | STRING(50) |  |  | 모바일 |
| DM_POST | DM우편번호 | STRING(8) |  |  | 회계1 > 기초등록 > 거래처등록 에서 주소2에 입력하는 우편번호. |
| DM_ADDR | DM주소 | STRING(500) |  |  | 회계1 > 기초등록 > 거래처등록 에서 주소2에 입력하는 주소 |
| REMARKS_WIN | 검색창내용 | STRING(50) |  |  | 검색창내용 |
| GUBUN | 구분 | STRING(2) |  |  | 일반거래처 : 11, 관세사거래처 : 13, 미입력 시 기본값은 일반(11). |
| FOREIGN_FLAG | 외환거래처사용여부 | STRING(1) |  |  | 외화거래처 : Y/N, 미입력 시 기본값은 N |
| EXCHANGE_CODE | 외화코드 | STRING(30) |  |  | 외화코드 : 외화거래처사용여부가 Y인 경우 입력. 회계1 > 기초등록 > 외화코드등록에서 확인 |
| CUST_GROUP1 | 업무관련그룹 | STRING(50) |  |  | 거래처그룹1코드 |
| CUST_GROUP2 | 회계관련그룹 | STRING(50) |  |  | 거래처그룹2코드 |
| URL_PATH | 홈페이지 | STRING(100) |  |  | 홈페이지 |
| REMARKS | 적요 | STRING(2000) |  |  | 적요 |
| OUTORDER_YN | 출하대상 거래처 구분 | STRING(1) |  |  | 출하대상거래처 : Y/N, 미입력 시 기본값은 N |
| IO_CODE_SL_BASE_YN | 거래유형(영업) 기본여부 | STRING(1) |  |  | 거래유형(영업) 기본여부 ; Y/N, 미입력 시 Y. N일 경우 위 거래유형(영업) 부가세코드 입력. |
| IO_CODE_SL | 거래유형(영업) | STRING(1) |  |  | 거래유형(영업) 부가세코드 : Self-Customizing > 환경설정 > 기능설정 > 공통 > 부가세 > 재고-부가세 > 매출(영업)> 부가세율적용 에서 확인, 미입력 시 기본설정. |
| IO_CODE_BY_BASE_YN | 거래유형(구매) 기본여부 | STRING(1) |  |  | 거래유형(구매) 기본여부 ; Y/N, 미입력 시 Y. N일 경우 위 거래유형(구매) 부가세코드 입력. |
| IO_CODE_BY | 거래유형(구매) | STRING(50) |  |  | 거래유형(구매) 부가세코드 : Self-Customizing > 환경설정 > 기능설정 > 공통 > 부가세 > 재고-부가세 > 매입(구매/외주) > 부가세율적용 에서 확인, 미입력 시 기본설정. |
| EMP_CD | 담당자코드 | STRING(50) |  |  | 담당자코드 : 재고1 > 기초등록 > 사원(담당)등록 의 담당자코드 |
| MANAGE_BOND_NO | 채권번호관리 | STRING(1) |  |  | 거래처의 채권번호관리구분 : (B:기본설정, M:필수입력, Y:선택입력, N:사용안함) |
| MANAGE_DEBIT_NO | 채무번호관리 | STRING(1) |  |  | 거래처의 채무번호관리구분 : (B:기본설정, M:필수입력, Y:선택입력, N:사용안함) |
| CUST_LIMIT | 거래처별여신한도 | NUMERIC(18,2) |  |  | 여신한도 |
| O_RATE | 출고조정률 | NUMERIC(5,2) |  |  | 출고조정률 |
| I_RATE | 입고조정률 | NUMERIC(5,2) |  |  | 입고조정률 |
| PRICE_GROUP | 영업단가그룹 | STRING(40) |  |  | 영업단가그룹 : 재고1 > 기초등록 > 특별단가등록 > 거래처특별단가그룹등록 |
| PRICE_GROUP2 | 구매단가그룹 | STRING(40) |  |  | 구매단가그룹 : 재고1 > 기초등록 > 특별단가등록 > 거래처특별단가그룹등록 |
| CUST_LIMIT_TERM | 여신기간 | NUMERIC(3,0) |  |  | 여신기간 : 최대 365일까지 설정. |
| CONT1 | 문자형추가항목1 | STRING(100) |  |  | 문자형추가항목1 |
| CONT2 | 문자형추가항목2 | STRING(100) |  |  | 문자형추가항목2 |
| CONT3 | 문자형추가항목3 | STRING(100) |  |  | 문자형추가항목3 |
| CONT4 | 문자형추가항목4 | STRING(100) |  |  | 문자형추가항목4 |
| CONT5 | 문자형추가항목5 | STRING(100) |  |  | 문자형추가항목5 |
| CONT6 | 문자형추가항목6 | STRING(100) |  |  | 문자형추가항목6 |
| NO_CUST_USER1 | 숫자형추가항목1 | NUMERIC(18,6) |  |  | 숫자형추가항목1 |
| NO_CUST_USER2 | 숫자형추가항목2 | NUMERIC(18,6) |  |  | 숫자형추가항목2 |
| NO_CUST_USER3 | 숫자형추가항목3 | NUMERIC(18,6) |  |  | 숫자형추가항목3 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y | 반복부분 |
| SlipNos | 전표번호(ERP) | STRING(20) | Y | 전표번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
    "CustList": [{
	    "BulkDatas": {
		    "BUSINESS_NO": "00001",
		    "CUST_NAME": "Test Cust",
		    "BOSS_NAME": "",
		    "UPTAE": "",
		    "JONGMOK": "",
		    "TEL": "",
		    "EMAIL": "",
		    "POST_NO": "",
		    "ADDR": "",
		    "G_GUBUN": "",
		    "G_BUSINESS_TYPE": "",
		    "G_BUSINESS_CD": "",
		    "TAX_REG_ID": "",
		    "FAX": "",
		    "HP_NO": "",
		    "DM_POST": "",
		    "DM_ADDR": "",
		    "REMARKS_WIN": "",
		    "GUBUN": "",
		    "FOREIGN_FLAG": "",
		    "EXCHANGE_CODE": "",
		    "CUST_GROUP1": "",
		    "CUST_GROUP2": "",
		    "URL_PATH": "",
		    "REMARKS": "",
		    "OUTORDER_YN": "",
		    "IO_CODE_SL_BASE_YN": "",
		    "IO_CODE_SL": "",
		    "IO_CODE_BY_BASE_YN": "",
		    "IO_CODE_BY": "",
		    "EMP_CD": "",
		    "MANAGE_BOND_NO": "",
		    "MANAGE_DEBIT_NO": "",
		    "CUST_LIMIT": "",
		    "O_RATE": "",
		    "I_RATE": "",
		    "PRICE_GROUP": "",
		    "PRICE_GROUP2": "",
		    "CUST_LIMIT_TERM": "",
		    "CONT1": "",
		    "CONT2": "",
		    "CONT3": "",
		    "CONT4": "",
		    "CONT5": "",
		    "CONT6": "",
		    "NO_CUST_USER1": "",
		    "NO_CUST_USER2": "",
		    "NO_CUST_USER3": ""
	    }
    },{
	    "BulkDatas": {
		    "BUSINESS_NO": "00002",
		    "CUST_NAME": "Test Cust1",
		    "BOSS_NAME": "",
		    "UPTAE": "",
		    "JONGMOK": "",
		    "TEL": "",
		    "EMAIL": "",
		    "POST_NO": "",
		    "ADDR": "",
		    "G_GUBUN": "",
		    "G_BUSINESS_TYPE": "",
		    "G_BUSINESS_CD": "",
		    "TAX_REG_ID": "",
		    "FAX": "",
		    "HP_NO": "",
		    "DM_POST": "",
		    "DM_ADDR": "",
		    "REMARKS_WIN": "",
		    "GUBUN": "",
		    "FOREIGN_FLAG": "",
		    "EXCHANGE_CODE": "",
		    "CUST_GROUP1": "",
		    "CUST_GROUP2": "",
		    "URL_PATH": "",
		    "REMARKS": "",
		    "OUTORDER_YN": "",
		    "IO_CODE_SL_BASE_YN": "",
		    "IO_CODE_SL": "",
		    "IO_CODE_BY_BASE_YN": "",
		    "IO_CODE_BY": "",
		    "EMP_CD": "",
		    "MANAGE_BOND_NO": "",
		    "MANAGE_DEBIT_NO": "",
		    "CUST_LIMIT": "",
		    "O_RATE": "",
		    "I_RATE": "",
		    "PRICE_GROUP": "",
		    "PRICE_GROUP2": "",
		    "CUST_LIMIT_TERM": "",
		    "CONT1": "",
		    "CONT2": "",
		    "CONT3": "",
		    "CONT4": "",
		    "CONT5": "",
		    "CONT6": "",
		    "NO_CUST_USER1": "",
		    "NO_CUST_USER2": "",
		    "NO_CUST_USER3": ""
		}
	}]
}
Example Result
[SUCCESS]
{
  "Data": {
    "EXPIRE_DATE": "",
    "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
    "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
    "SuccessCnt": 2,
    "FailCnt": 0,
    "ResultDetails": "[{"IsSuccess": true, "TotalError": "[1] OK", "Errors": [], "Code": null}, {"IsSuccess": true, "TotalError": "[2] OK", "Errors": [], "Code": null}]",
    "SlipNos": null
  },
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2020-03-12 14:58:18.141",
  "RequestKey": null,
  "IsEnableNoL4": false,
  "RefreshTimestamp": null,
  "AsyncActionKey": null
}
[FAIL - Validation]
{
  "Data": {
    "EXPIRE_DATE": "",
    "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 13/10000",
    "SuccessCnt": 0,
    "FailCnt": 2,
    "ResultDetails": "[{"IsSuccess": false, "TotalError": "[1]거래처코드 (필수)", "Errors": [{"ColCd": "BUSINESS_NO", "Message": "거래처코드 (필수)"}"], "Code": null},
                       {"IsSuccess": false, "TotalError": "[2]거래처코드 (필수)", "Errors": [{"ColCd": "BUSINESS_NO", "Message": "거래처코드 (필수)"}"], "Code": null}]",
    "SlipNos": null
  },
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2020-03-12 15:00:17.217",
  "RequestKey": null,
  "IsEnableNoL4": false,
  "RefreshTimestamp": null,
  "AsyncActionKey": null
}
오류 종류별 설명
상세보기



========================================
## 품목등록 (idx=20)
========================================

# 품목등록

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/InventoryBasic/SaveBasicProduct?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/InventoryBasic/SaveBasicProduct?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 입력필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| ProductList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| PROD_CD | 품목코드 | STRING(20) | Y |  | 품목코드 |
| PROD_DES | 품목명 | STRING(100) | Y |  | 품목명 |
| SIZE_FLAG | 규격구분 | STRING(1) |  |  | 규격구분설정(1:규격명, 2:규격그룹, 3:규격계산, 4:규격계산그룹) |
| SIZE_DES | 규격 | STRING(100) |  |  | 규격(규격그룹/규격계산그룹을 선택한 경우에는 등록된 그룹의 코드 또는 명 입력) |
| UNIT | 단위 | STRING(6) |  |  | 단위 |
| PROD_TYPE | 품목구분 | STRING(1) |  |  | 품목구분 : 원재료0, 부재료4, 제품1, 반제품2, 상품3, 무형상품7. 미입력 시 기본값은 3. |
| SET_FLAG | 세트여부 | STRING(1) |  |  | 세트여부 (1:사용, 0:미사용) |
| BAL_FLAG | 재고수량관리 | STRING(1) |  |  | 품목의 수량관리 여부(0:수량관리제외, 1:수량관리대상) |
| WH_CD | 생산공정 | STRING(5) |  |  | 생산공정코드 : 재고1 > 기초등록 > 창고등록 > 신규 > 구분 : 공장 > 생산공정 |
| IN_PRICE | 입고단가 | NUMERIC(18,6) |  |  | 입고단가 |
| IN_PRICE_VAT | 입고단가Vat포함여부 | STRING(1) |  |  | 입고단가부가세포함여부 : 미포함0, 포함1. 미입력 시 기본값은 0 |
| OUT_PRICE | 출고단가 | NUMERIC(18,6) |  |  | 출고단가 |
| OUT_PRICE_VAT | 출고단가Vat포함여부 | STRING(1) |  |  | 출고단가부가세포함여부 : 미포함0, 포함1. 미입력 시 기본값은 0 |
| REMARKS_WIN | 검색창내용 | STRING(100) |  |  | 검색창내용 |
| CLASS_CD | 그룹코드 | STRING(5) |  |  | 품목그룹1코드 |
| CLASS_CD2 | 그룹코드2 | STRING(5) |  |  | 품목그룹2코드 |
| CLASS_CD3 | 그룹코드3 | STRING(5) |  |  | 품목그룹3코드 |
| BAR_CODE | 바코드 | STRING(30) |  |  | 바코드 |
| TAX | 부가가치세율 | NUMERIC(6,3) |  |  | 판매전표입력시 반영될 부가세율 |
| VAT_RATE_BY | 부가세율(매입) | NUMERIC(6,3) |  |  | 구매전표입력시 반영될 부가세율 |
| CS_FLAG | C-Portal사용여부 | STRING(1) |  |  | C-Portal사용여부 (1:사용, 0:미사용) |
| REMARKS | 적요 | STRING(100) |  |  | 적요 |
| INSPECT_TYPE_CD | 품질검사유형 | STRING(30) |  |  | 품질검사유형 : 재고2 > 품질관리 > 품질검사 > 품질검사유형등록 |
| INSPECT_STATUS | 품질검사방법 | STRING(1) |  |  | 품질검사방법설정(L:전수, S:샘플링) |
| SAMPLE_PERCENT | 샘플링비율 | NUMERIC(4,2) |  |  | 샘플링비율 |
| SAFE_A0001 | 안전재고관리-주문서 | STRING(1) |  |  | 주문서 입력 시 품목의 재고 확인여부를 설정(1:사용, 2:사용안함) |
| SAFE_A0002 | 안전재고관리-판매 | STRING(1) |  |  | 판매 입력 시 품목의 재고 확인여부를 설정(1:사용, 2:사용안함) |
| SAFE_A0003 | 안전재고관리-생산불출 | STRING(1) |  |  | 생산불출 입력 시 품목의 재고 확인여부를 설정(1:사용, 2:사용안함) |
| SAFE_A0004 | 안전재고관리-생산입고 | STRING(1) |  |  | 생산입고 입력 시 품목의 재고 확인여부를 설정(1:사용, 2:사용안함) |
| SAFE_A0005 | 안전재고관리-창고이동 | STRING(1) |  |  | 창고이동 입력 시 품목의 재고 확인여부를 설정(1:사용, 2:사용안함) |
| SAFE_A0006 | 안전재고관리-자가사용 | STRING(1) |  |  | 자가사용 입력 시 품목의 재고 확인여부를 설정(1:사용, 2:사용안함) |
| SAFE_A0007 | 안전재고관리-불량처리 | STRING(1) |  |  | 불량처리 입력 시 품목의 재고 확인여부를 설정(1:사용, 2:사용안함) |
| CSORD_C0001 | C-Portal최소주문수량체크 | STRING(1) |  |  | C-Portal주문수량 입력 시 품목의 재고 확인여부를 설정(Y:사용, N:사용안함) |
| CSORD_TEXT | C-Portal최소주문수량 | NUMERIC(15,3) |  |  | C-Portal주문수량 입력 시 최소주문수량을 입력 |
| CSORD_C0003 | C-Portal최소주문단위 | STRING(1) |  |  | C-Portal주문수량 입력 시 최소주문단위을 설정(Y:사용, N:사용안함) |
| IN_TERM | 조달기간 | STRING(5) |  |  | 조달기간 |
| MIN_QTY | 최소구매단위 | STRING(7) |  |  | 최소구매단위 |
| CUST | 구매처 | STRING(30) |  |  | 구매처 |
| OUT_PRICE1 | 단가A | NUMERIC(18,6) |  |  | 단가A |
| OUT_PRICE1_VAT_YN | 단가A VAT포함여부 | STRING(1) |  |  | 단가A VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE2 | 단가B | NUMERIC(18,6) |  |  | 단가B |
| OUT_PRICE2_VAT_YN | 단가B VAT포함여부 | STRING(1) |  |  | 단가B VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE3 | 단가C | NUMERIC(18,6) |  |  | 단가C |
| OUT_PRICE3_VAT_YN | 단가C VAT포함여부 | STRING(1) |  |  | 단가C VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE4 | 단가D | NUMERIC(18,6) |  |  | 단가D |
| OUT_PRICE4_VAT_YN | 단가D VAT포함여부 | STRING(1) |  |  | 단가D VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE5 | 단가E | NUMERIC(18,6) |  |  | 단가E |
| OUT_PRICE5_VAT_YN | 단가E VAT포함여부 | STRING(1) |  |  | 단가E VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE6 | 단가F | NUMERIC(18,6) |  |  | 단가F |
| OUT_PRICE6_VAT_YN | 단가F VAT포함여부 | STRING(1) |  |  | 단가F VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE7 | 단가G | NUMERIC(18,6) |  |  | 단가G |
| OUT_PRICE7_VAT_YN | 단가G VAT포함여부 | STRING(1) |  |  | 단가G VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE8 | 단가H | NUMERIC(18,6) |  |  | 단가H |
| OUT_PRICE8_VAT_YN | 단가H VAT포함여부 | STRING(1) |  |  | 단가H VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE9 | 단가I | NUMERIC(18,6) |  |  | 단가I |
| OUT_PRICE9_VAT_YN | 단가I VAT포함여부 | STRING(1) |  |  | 단가I VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE10 | 단가J | NUMERIC(18,6) |  |  | 단가J |
| OUT_PRICE10_VAT_YN | 단가J VAT포함여부 | STRING(1) |  |  | 단가J VAT포함여부(N:포함안함, Y:포함) |
| OUTSIDE_PRICE | 외주비단가 | NUMERIC(18,6) |  |  | 외주비단가 |
| OUTSIDE_PRICE_VAT | 외주비단가 VAT포함여부 | STRING(1) |  |  | 외주비단가 VAT포함여부(0:포함안함, 1:포함) |
| LABOR_WEIGHT | 노무비단가 | NUMERIC(7,2) |  |  | 노무비단가 |
| EXPENSES_WEIGHT | 경비가중치 | NUMERIC(7,2) |  |  | 경비가중치 |
| MATERIAL_COST | 재료비표준원가 | NUMERIC(18,6) |  |  | 재료비표준원가 |
| EXPENSE_COST | 경비표준원가 | NUMERIC(18,6) |  |  | 경비표준원가 |
| LABOR_COST | 노무비표준원가 | NUMERIC(18,6) |  |  | 노무비표준원가 |
| OUT_COST | 외주비표준원가 | NUMERIC(18,6) |  |  | 외주비표준원가 |
| CONT1 | 문자형추가항목1 | STRING(100) |  |  | 문자형추가항목1 |
| CONT2 | 문자형추가항목2 | STRING(100) |  |  | 문자형추가항목2 |
| CONT3 | 문자형추가항목3 | STRING(100) |  |  | 문자형추가항목3 |
| CONT4 | 문자형추가항목4 | STRING(100) |  |  | 문자형추가항목4 |
| CONT5 | 문자형추가항목5 | STRING(100) |  |  | 문자형추가항목5 |
| CONT6 | 문자형추가항목6 | STRING(100) |  |  | 문자형추가항목6 |
| NO_USER1 | 숫자형추가항목1 | NUMERIC(18,6) |  |  | 숫자형추가항목1 |
| NO_USER2 | 숫자형추가항목2 | NUMERIC(18,6) |  |  | 숫자형추가항목2 |
| NO_USER3 | 숫자형추가항목3 | NUMERIC(18,6) |  |  | 숫자형추가항목3 |
| NO_USER4 | 숫자형추가항목4 | NUMERIC(18,6) |  |  | 숫자형추가항목4 |
| NO_USER5 | 숫자형추가항목5 | NUMERIC(18,6) |  |  | 숫자형추가항목5 |
| NO_USER6 | 숫자형추가항목6 | NUMERIC(18,6) |  |  | 숫자형추가항목6 |
| NO_USER7 | 숫자형추가항목7 | NUMERIC(18,6) |  |  | 숫자형추가항목7 |
| NO_USER8 | 숫자형추가항목8 | NUMERIC(18,6) |  |  | 숫자형추가항목8 |
| NO_USER9 | 숫자형추가항목9 | NUMERIC(18,6) |  |  | 숫자형추가항목9 |
| NO_USER10 | 숫자형추가항목10 | NUMERIC(18,6) |  |  | 숫자형추가항목10 |
| ITEM_TYPE | 관리항목 | STRING(1) |  |  | 관리항목(B:기본설정,M:필수입력,Y:선택입력,N:사용안함) |
| SERIAL_TYPE | 시리얼/로트 | STRING(1) |  |  | 시리얼(B:기본설정,M:필수입력,Y:선택입력,N:사용안함) |
| PROD_SELL_TYPE | 생산전표생성-판매 | STRING(1) |  |  | 생산전표생성-판매(B:기본설정,Y:사용,N:사용안함) |
| PROD_WHMOVE_TYPE | 생산전표생성-창고이동 | STRING(1) |  |  | 생산전표생성-창고이동(B:기본설정,Y:사용,N:사용안함) |
| QC_BUY_TYPE | 품질검사요청-구매 | STRING(1) |  |  | 품질검사요청-구매(B:기본설정,Y:사용,N:사용안함) |
| QC_YN | 품질검사요청여부 | STRING(1) |  |  | 품질검사요청여부(Y:사용, N:미사용) |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y | 반복부분 |
| SlipNos | 전표번호(ERP) | STRING(20) | Y | 전표번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{			
		"ProductList": [{			
		"BulkDatas": {	
			"PROD_CD": "00001",
			"PROD_DES": "Test Product",
			"SIZE_FLAG": "",
			"SIZE_DES": "",
			"UNIT": "",
			"PROD_TYPE": "",
			"SET_FLAG": "",
			"BAL_FLAG": "",
			"WH_CD": "",
			"IN_PRICE": "",
			"IN_PRICE_VAT": "",
			"OUT_PRICE": "",
			"OUT_PRICE_VAT": "",
			"REMARKS_WIN": "",
			"CLASS_CD": "",
			"CLASS_CD2": "",
			"CLASS_CD3": "",
			"BAR_CODE": "",
			"TAX": "",
			"VAT_RATE_BY": "",
			"CS_FLAG": "",
			"REMARKS": "",
			"INSPECT_TYPE_CD": "",
			"INSPECT_STATUS": "",
			"SAMPLE_PERCENT": "",			
			"EXCH_RATE": "",
			"DENO_RATE": "",
			"SAFE_A0001": "",
			"SAFE_A0002": "",
			"SAFE_A0003": "",
			"SAFE_A0004": "",
			"SAFE_A0005": "",
			"SAFE_A0006": "",
			"SAFE_A0007": "",
			"CSORD_C0001": "",
			"CSORD_TEXT": "",
			"CSORD_C0003": "",
			"IN_TERM": "",
			"MIN_QTY": "",
			"CUST": "",
			"OUT_PRICE1": "",
			"OUT_PRICE1_VAT_YN": "",
			"OUT_PRICE2": "",
			"OUT_PRICE2_VAT_YN": "",
			"OUT_PRICE3": "",
			"OUT_PRICE3_VAT_YN": "",
			"OUT_PRICE4": "",
			"OUT_PRICE4_VAT_YN": "",
			"OUT_PRICE5": "",
			"OUT_PRICE5_VAT_YN": "",
			"OUT_PRICE6": "",
			"OUT_PRICE6_VAT_YN": "",
			"OUT_PRICE7": "",
			"OUT_PRICE7_VAT_YN": "",
			"OUT_PRICE8": "",
			"OUT_PRICE8_VAT_YN": "",
			"OUT_PRICE9": "",
			"OUT_PRICE9_VAT_YN": "",
			"OUT_PRICE10": "",
			"OUT_PRICE10_VAT_YN": "",
			"OUTSIDE_PRICE": "",
			"OUTSIDE_PRICE_VAT": "",
			"LABOR_WEIGHT": "",
			"EXPENSES_WEIGHT": "",
			"MATERIAL_COST": "",
			"EXPENSE_COST": "",
			"LABOR_COST": "",
			"OUT_COST": "",
			"CONT1": "",
			"CONT2": "",
			"CONT3": "",
			"CONT4": "",
			"CONT5": "",
			"CONT6": "",
			"NO_USER1": "",
			"NO_USER2": "",
			"NO_USER3": "",
			"NO_USER4": "",
			"NO_USER5": "",
			"NO_USER6": "",
			"NO_USER7": "",
			"NO_USER8": "",
			"NO_USER9": "",
			"NO_USER10": "",
			"ITEM_TYPE": "",
			"SERIAL_TYPE": "",
			"PROD_SELL_TYPE": "",
			"PROD_WHMOVE_TYPE": "",
			"QC_BUY_TYPE": "",
			"QC_YN": ""
		}	
	},{		
		"BulkDatas": {	
			"PROD_CD": "00002",
			"PROD_DES": "Test Product1",
			"SIZE_FLAG": "",
			"SIZE_DES": "",
			"UNIT": "",
			"PROD_TYPE": "",
			"SET_FLAG": "",
			"BAL_FLAG": "",
			"WH_CD": "",
			"IN_PRICE": "",
			"IN_PRICE_VAT": "",
			"OUT_PRICE": "",
			"OUT_PRICE_VAT": "",
			"REMARKS_WIN": "",
			"CLASS_CD": "",
			"CLASS_CD2": "",
			"CLASS_CD3": "",
			"BAR_CODE": "",
			"VAT_YN": "",
			"VAT_RATE_BY": "",
			"CS_FLAG": "",
			"REMARKS": "",
			"INSPECT_TYPE_CD": "",
			"INSPECT_STATUS": "",
			"SAMPLE_PERCENT": "",			
			"EXCH_RATE": "",
			"DENO_RATE": "",
			"SAFE_A0001": "",
			"SAFE_A0002": "",
			"SAFE_A0003": "",
			"SAFE_A0004": "",
			"SAFE_A0005": "",
			"SAFE_A0006": "",
			"SAFE_A0007": "",
			"CSORD_C0001": "",
			"CSORD_TEXT": "",
			"CSORD_C0003": "",
			"IN_TERM": "",
			"MIN_QTY": "",
			"CUST": "",
			"OUT_PRICE1": "",
			"OUT_PRICE1_VAT_YN": "",
			"OUT_PRICE2": "",
			"OUT_PRICE2_VAT_YN": "",
			"OUT_PRICE3": "",
			"OUT_PRICE3_VAT_YN": "",
			"OUT_PRICE4": "",
			"OUT_PRICE4_VAT_YN": "",
			"OUT_PRICE5": "",
			"OUT_PRICE5_VAT_YN": "",
			"OUT_PRICE6": "",
			"OUT_PRICE6_VAT_YN": "",
			"OUT_PRICE7": "",
			"OUT_PRICE7_VAT_YN": "",
			"OUT_PRICE8": "",
			"OUT_PRICE8_VAT_YN": "",
			"OUT_PRICE9": "",
			"OUT_PRICE9_VAT_YN": "",
			"OUT_PRICE10": "",
			"OUT_PRICE10_VAT_YN": "",
			"OUTSIDE_PRICE": "",
			"OUTSIDE_PRICE_VAT": "",
			"LABOR_WEIGHT": "",
			"EXPENSES_WEIGHT": "",
			"MATERIAL_COST": "",
			"EXPENSE_COST": "",
			"LABOR_COST": "",
			"OUT_COST": "",
			"CONT1": "",
			"CONT2": "",
			"CONT3": "",
			"CONT4": "",
			"CONT5": "",
			"CONT6": "",
			"NO_USER1": "",
			"NO_USER2": "",
			"NO_USER3": "",
			"NO_USER4": "",
			"NO_USER5": "",
			"NO_USER6": "",
			"NO_USER7": "",
			"NO_USER8": "",
			"NO_USER9": "",
			"NO_USER10": "",
			"ITEM_TYPE": "",
			"SERIAL_TYPE": "",
			"PROD_SELL_TYPE": "",
			"PROD_WHMOVE_TYPE": "",
			"QC_BUY_TYPE": "",
			"QC_YN": ""
		}	
	}]
}
Example Result
[SUCCESS]
{
  "Data": {
    "EXPIRE_DATE": "",
    "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 13/10000",
    "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
    "SuccessCnt": 2,
    "FailCnt": 0,
    "ResultDetails": "[{"IsSuccess": true, "TotalError": "[1] OK", "Errors": [], "Code": null}, {"IsSuccess": true, "TotalError": "[2] OK", "Errors": [], "Code": null}]",
    "SlipNos": null
  },
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2020-03-12 15:33:48.958",
  "RequestKey": null,
  "IsEnableNoL4": false,
  "RefreshTimestamp": null,
  "AsyncActionKey": null
}
[FAIL - Validation]
{
  "Data":[{
    "EXPIRE_DATE": "",
    "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 13/10000",
    "SuccessCnt": 0,
    "FailCnt": 2,
    "ResultDetails": "[{"IsSuccess": false, "TotalError": "[1]거래처", "Errors": [{"ColCd": "CUST", "Message": "거래처"}], "Code": null}, 
                       {"IsSuccess": false, "TotalError": "[2]거래처", "Errors": [{"ColCd": "CUST", "Message": "거래처"}], "Code": null}]",
    "SlipNos": null
  }],
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2020-03-12 15:34:11.654",
  "RequestKey": null,
  "IsEnableNoL4": false,
  "RefreshTimestamp": null,
  "AsyncActionKey": null
}
오류 종류별 설명
상세보기




========================================
## 품목조회_단건 (idx=21)
========================================

# 품목조회API

개요
외부 서비스와 연계를 통해서 ERP의 품목을 조회할 수 있습니다.
요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/InventoryBasic/ViewBasicProduct?SESSION_ID={SESSION_ID}} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/InventoryBasic/ViewBasicProduct?SESSION_ID={SESSION_ID}} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| PROD_CD | 품목코드 | STRING(20) | Y |  | 입력내용 - 조회하기 원하는 품목 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| PROD_TYPE | 품목구분 | STRING(20) |  |  | 입력내용 - 조회하기 원하는 품목 타입을 입력합니다. - 여러 품목타입을 검색 시 구분값 '∬' 을 추가하여 조회할 수 있습니다.입력글자제한 - 품목타입을 입력합니다. 입력하지 않으면 전체검색됩니다. - 0 : 원재료 - 1 : 제품 - 2 : 반제품 - 3 : 상품 - 4 : 부재료 - 7 : 무형상품 - 최대 20자 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |
| Result |  |  |  |  |
| PROD_CD | 품목코드 | STRING(20) | Y | 품목코드 |
| PROD_DES | 품목명 | STRING(100) | Y | 품목명 |
| SIZE_FLAG | 규격구분 | STRING(1) |  | 규격구분설정(1:규격명, 2:규격그룹, 3:규격계산, 4:규격계산그룹) |
| SIZE_DES | 규격 | STRING(100) |  | 규격(규격그룹/규격계산그룹을 선택한 경우에는 등록된 그룹의 코드 또는 명 입력) |
| UNIT | 단위 | STRING(6) |  | 단위 |
| PROD_TYPE | 품목구분 | STRING(1) |  | 품목구분 : 원재료0, 부재료4, 제품1, 반제품2, 상품3, 무형상품7. 미입력 시 기본값은 3. |
| SET_FLAG | 세트여부 | STRING(1) |  | 세트여부 (1:사용, 0:미사용) |
| BAL_FLAG | 재고수량관리 | STRING(1) |  | 품목의 수량관리 여부(0:수량관리제외, 1:수량관리대상) |
| WH_CD | 생산공정 | STRING(5) |  | 생산공정코드 : 재고1 > 기초등록 > 창고등록 > 신규 > 구분 : 공장 > 생산공정 |
| IN_PRICE | 입고단가 | NUMERIC(18,6) |  | 입고단가 |
| IN_PRICE_VAT | 입고단가Vat포함여부 | STRING(1) |  | 입고단가부가세포함여부 : 미포함0, 포함1. 미입력 시 기본값은 0 |
| OUT_PRICE | 출고단가 | NUMERIC(18,6) |  | 출고단가 |
| OUT_PRICE_VAT | 출고단가Vat포함여부 | STRING(1) |  | 출고단가부가세포함여부 : 미포함0, 포함1. 미입력 시 기본값은 0 |
| REMARKS_WIN | 검색창내용 | STRING(100) |  | 검색창내용 |
| CLASS_CD | 그룹코드 | STRING(5) |  | 품목그룹1코드 |
| CLASS_CD2 | 그룹코드2 | STRING(5) |  | 품목그룹2코드 |
| CLASS_CD3 | 그룹코드3 | STRING(5) |  | 품목그룹3코드 |
| BAR_CODE | 바코드 | STRING(30) |  | 바코드 |
| TAX | 부가가치세율 | NUMERIC(6,3) |  | 판매전표입력시 반영될 부가세율 |
| VAT_RATE_BY | 부가세율(매입) | NUMERIC(6,3) |  | 구매전표입력시 반영될 부가세율 |
| CS_FLAG | C-Portal사용여부 | STRING(1) |  | C-Portal사용여부 (1:사용, 0:미사용) |
| REMARKS | 적요 | STRING(100) |  | 적요 |
| INSPECT_TYPE_CD | 품질검사유형 | STRING(30) |  | 품질검사유형 : 재고2 > 품질관리 > 품질검사 > 품질검사유형등록 |
| INSPECT_STATUS | 품질검사방법 | STRING(1) |  | 품질검사방법설정(L:전수, S:샘플링) |
| SAMPLE_PERCENT | 샘플링비율 | NUMERIC(4,2) |  | 샘플링비율 |
| CSORD_C0001 | C-Portal최소주문수량체크 | STRING(1) |  | C-Portal주문수량 입력 시 품목의 재고 확인여부를 설정(Y:사용, N:사용안함) |
| CSORD_TEXT | C-Portal최소주문수량 | NUMERIC(15,3) |  | C-Portal주문수량 입력 시 최소주문수량을 입력 |
| CSORD_C0003 | C-Portal최소주문단위 | STRING(1) |  | C-Portal주문수량 입력 시 최소주문단위을 설정(Y:사용, N:사용안함) |
| IN_TERM | 조달기간 | STRING(5) |  | 조달기간 |
| MIN_QTY | 최소구매단위 | STRING(7) |  | 최소구매단위 |
| CUST | 구매처 | STRING(30) |  | 구매처 |
| EXCH_RATE | 당수량(분자) | STRING(30) |  |  |
| DENO_RATE | 당수량(분모) | STRING(30) |  |  |
| OUT_PRICE1 | 단가A | NUMERIC(18,6) |  | 단가A |
| OUT_PRICE1_VAT_YN | 단가A VAT포함여부 | STRING(1) |  | 단가A VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE2 | 단가B | NUMERIC(18,6) |  | 단가B |
| OUT_PRICE2_VAT_YN | 단가B VAT포함여부 | STRING(1) |  | 단가B VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE3 | 단가C | NUMERIC(18,6) |  | 단가C |
| OUT_PRICE3_VAT_YN | 단가C VAT포함여부 | STRING(1) |  | 단가C VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE4 | 단가D | NUMERIC(18,6) |  | 단가D |
| OUT_PRICE4_VAT_YN | 단가D VAT포함여부 | STRING(1) |  | 단가D VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE5 | 단가E | NUMERIC(18,6) |  | 단가E |
| OUT_PRICE5_VAT_YN | 단가E VAT포함여부 | STRING(1) |  | 단가E VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE6 | 단가F | NUMERIC(18,6) |  | 단가F |
| OUT_PRICE6_VAT_YN | 단가F VAT포함여부 | STRING(1) |  | 단가F VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE7 | 단가G | NUMERIC(18,6) |  | 단가G |
| OUT_PRICE7_VAT_YN | 단가G VAT포함여부 | STRING(1) |  | 단가G VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE8 | 단가H | NUMERIC(18,6) |  | 단가H |
| OUT_PRICE8_VAT_YN | 단가H VAT포함여부 | STRING(1) |  | 단가H VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE9 | 단가I | NUMERIC(18,6) |  | 단가I |
| OUT_PRICE9_VAT_YN | 단가I VAT포함여부 | STRING(1) |  | 단가I VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE10 | 단가J | NUMERIC(18,6) |  | 단가J |
| OUT_PRICE10_VAT_YN | 단가J VAT포함여부 | STRING(1) |  | 단가J VAT포함여부(N:포함안함, Y:포함) |
| OUTSIDE_PRICE | 외주비단가 | NUMERIC(18,6) |  | 외주비단가 |
| OUTSIDE_PRICE_VAT | 외주비단가 VAT포함여부 | STRING(1) |  | 외주비단가 VAT포함여부(0:포함안함, 1:포함) |
| LABOR_WEIGHT | 노무비단가 | NUMERIC(7,2) |  | 노무비단가 |
| EXPENSES_WEIGHT | 경비가중치 | NUMERIC(7,2) |  | 경비가중치 |
| MATERIAL_COST | 재료비표준원가 | NUMERIC(18,6) |  | 재료비표준원가 |
| EXPENSE_COST | 경비표준원가 | NUMERIC(18,6) |  | 경비표준원가 |
| LABOR_COST | 노무비표준원가 | NUMERIC(18,6) |  | 노무비표준원가 |
| OUT_COST | 외주비표준원가 | NUMERIC(18,6) |  | 외주비표준원가 |
| CONT1 | 문자형추가항목1 | STRING(100) |  | 문자형추가항목1 |
| CONT2 | 문자형추가항목2 | STRING(100) |  | 문자형추가항목2 |
| CONT3 | 문자형추가항목3 | STRING(100) |  | 문자형추가항목3 |
| CONT4 | 문자형추가항목4 | STRING(100) |  | 문자형추가항목4 |
| CONT5 | 문자형추가항목5 | STRING(100) |  | 문자형추가항목5 |
| CONT6 | 문자형추가항목6 | STRING(100) |  | 문자형추가항목6 |
| NO_USER1 | 숫자형추가항목1 | NUMERIC(18,6) |  | 숫자형추가항목1 |
| NO_USER2 | 숫자형추가항목2 | NUMERIC(18,6) |  | 숫자형추가항목2 |
| NO_USER3 | 숫자형추가항목3 | NUMERIC(18,6) |  | 숫자형추가항목3 |
| NO_USER4 | 숫자형추가항목4 | NUMERIC(18,6) |  | 숫자형추가항목4 |
| NO_USER5 | 숫자형추가항목5 | NUMERIC(18,6) |  | 숫자형추가항목5 |
| NO_USER6 | 숫자형추가항목6 | NUMERIC(18,6) |  | 숫자형추가항목6 |
| NO_USER7 | 숫자형추가항목7 | NUMERIC(18,6) |  | 숫자형추가항목7 |
| NO_USER8 | 숫자형추가항목8 | NUMERIC(18,6) |  | 숫자형추가항목8 |
| NO_USER9 | 숫자형추가항목9 | NUMERIC(18,6) |  | 숫자형추가항목9 |
| NO_USER10 | 숫자형추가항목10 | NUMERIC(18,6) |  | 숫자형추가항목10 |
| ITEM_TYPE | 관리항목 | STRING(1) |  | 관리항목(B:기본설정,M:필수입력,Y:선택입력,N:사용안함) |
| SERIAL_TYPE | 시리얼/로트 | STRING(1) |  | 시리얼(B:기본설정,M:필수입력,Y:선택입력,N:사용안함) |
| PROD_SELL_TYPE | 생산전표생성-판매 | STRING(1) |  | 생산전표생성-판매(B:기본설정,Y:사용,N:사용안함) |
| PROD_WHMOVE_TYPE | 생산전표생성-창고이동 | STRING(1) |  | 생산전표생성-창고이동(B:기본설정,Y:사용,N:사용안함) |
| QC_BUY_TYPE | 품질검사요청-구매 | STRING(1) |  | 품질검사요청-구매(B:기본설정,Y:사용,N:사용안함) |
| QC_YN | 품질검사요청여부 | STRING(1) |  | 품질검사요청여부(Y:사용, N:미사용) |

Example Parameter

{"PROD_CD": "00001","PROD_TYPE":"0"}
Example Result
[SUCCESS]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 3/6000," 1일 허용량" : 4/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "Result": "[{"PROD_CD": "00001", 
    "PROD_DES": "test123", 
    "SIZE_FLAG": "1", 
    "SIZE_DES": "6", 
    "UNIT": "EA", 
    "PROD_TYPE": "3", 
    "SET_FLAG": "1", 
    "BAL_FLAG": "1",
    "WH_CD": "00002", 
    "IN_PRICE": "700.0000000000", 
    "SIZE_CD": "", 
    "IN_PRICE_VAT": "1", 
    "REMARKS_WIN": "test", 
    "CLASS_CD": "00001", 
    "CLASS_CD2": "", 
    "CLASS_CD3": "", 
    "BAR_CODE": "8801166053051", 
    "TAX": "20.000", 
    "VAT_RATE_BY": "20.00000", 
    "CS_FLAG": "1", 
    "REMARKS": "123", 
    "INSPECT_TYPE_CD": "1", 
    "INSPECT_STATUS": "L", 
    "SAMPLE_PERCENT": "0.00", 
    "IN_TERM": "0", 
    "MIN_QTY": "0.0000000000", 
    "CUST": "2118702818", 
    "EXCH_RATE": "0.0000000000", 
    "DENO_RATE": 1, 
    "OUT_PRICE": "12000.0000000000", 
    "OUT_PRICE1": "0.0000000000", 
    "OUT_PRICE2": "0.0000000000", 
    "OUT_PRICE3": "111.0000000000", 
    "OUT_PRICE4": "0.0000000000", 
    "OUT_PRICE5": "0.0000000000", 
    "OUT_PRICE6": "0.0000000000", 
    "OUT_PRICE7": "0.0000000000", 
    "OUT_PRICE8": "0.0000000000", 
    "OUT_PRICE9": "0.0000000000", 
    "OUT_PRICE10": "0.0000000000", 
    "OUT_PRICE_VAT": "1", 
    "OUT_PRICE1_VAT_YN": "N", 
    "OUT_PRICE2_VAT_YN": "Y",
    "OUT_PRICE3_VAT_YN": "N", 
    "OUT_PRICE4_VAT_YN": "Y", 
    "OUT_PRICE5_VAT_YN": "N", 
    "OUT_PRICE6_VAT_YN": "N", 
    "OUT_PRICE7_VAT_YN": "N", 
    "OUT_PRICE8_VAT_YN": "N", 
    "OUT_PRICE9_VAT_YN": "N", 
    "OUT_PRICE10_VAT_YN": "N", 
    "OUTSIDE_PRICE": "6000.0000000000", 
    "OUTSIDE_PRICE_VAT": "1", 
    "LABOR_WEIGHT": "1.0000000000", 
    "EXPENSES_WEIGHT": "1.00", 
    "MATERIAL_COST": "0.0000000000", 
    "EXPENSE_COST": "0.0000000000", 
    "LABOR_COST": "0.0000000000", 
    "OUT_COST": "0.0000000000", 
    "CONT1": "", 
    "CONT2": "", 
    "CONT3": "", 
    "CONT4": "", 
    "CONT5": "",
    "CONT6": "",
    "NO_USER1": "0.0000000000", 
    "NO_USER2": "0.0000000000", 
    "NO_USER3": "0.0000000000",
    "SERIAL_TYPE": "B", 
    "PROD_SELL_TYPE": "B", 
    "PROD_WHMOVE_TYPE": "B",
    "QC_BUY_TYPE": "B", 
    "QC_YN": "B", 
    "SAFE_QTY": "0.0000000000"
    }
    ]"
  },
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2020-01-00 00:00:00.000",
  "RequestKey": null,
  "IsEnableNoL4": true,
  "RefreshTimestamp": "0",
  "AsyncActionKey": null
}
오류 종류별 설명
상세보기



========================================
## 품목조회 (idx=22)
========================================

# 품목조회API

개요
외부 서비스와 연계를 통해서 ERP의 품목을 조회할 수 있습니다.
요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/InventoryBasic/GetBasicProductsList?SESSION_ID={SESSION_ID}} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/InventoryBasic/GetBasicProductsList?SESSION_ID={SESSION_ID}} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| PROD_CD | 품목코드 | STRING(20000) |  |  | 입력내용 - 조회하기 원하는 품목 코드를 입력합니다. - 여러 품목을 검색 시 구분값 '∬' 을 추가하여 조회할 수 있습니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20000자 |
| COMMA_FLAG | Comma 포함 여부 | CHAR(1) |  |  | 이카운트는 Comma(',')를 구분값인 '∬' 로 변경하여 전송합니다.따라서 품목코드에 콤마가 포함되어 있는 경우 Y로 입력합니다.기본값 'N'입력값 'Y', 'N' |
| PROD_TYPE | 품목구분 | STRING(20) |  |  | 입력내용 - 조회하기 원하는 품목 타입을 입력합니다. - 여러 품목타입을 검색 시 구분값 '∬' 을 추가하여 조회할 수 있습니다.입력글자제한 - 품목타입을 입력합니다. 입력하지 않으면 전체검색됩니다. - 0 : 원재료 - 1 : 제품 - 2 : 반제품 - 3 : 상품 - 4 : 부재료 - 7 : 무형상품 - 최대 20자 |
| FROM_PROD_CD | 품목코드 | STRING(20) |  |  | 입력내용 - 조회하기 원하는 품목 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| TO_PROD_CD | 품목코드 | STRING(20) |  |  | 입력내용 - 조회하기 원하는 품목 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |
| Result |  |  |  |  |
| PROD_CD | 품목코드 | STRING(20) | Y | 품목코드 |
| PROD_DES | 품목명 | STRING(100) | Y | 품목명 |
| SIZE_FLAG | 규격구분 | STRING(1) |  | 규격구분설정(1:규격명, 2:규격그룹, 3:규격계산, 4:규격계산그룹) |
| SIZE_DES | 규격 | STRING(100) |  | 규격(규격그룹/규격계산그룹을 선택한 경우에는 등록된 그룹의 코드 또는 명 입력) |
| UNIT | 단위 | STRING(6) |  | 단위 |
| PROD_TYPE | 품목구분 | STRING(1) |  | 품목구분 : 원재료0, 부재료4, 제품1, 반제품2, 상품3, 무형상품7. 미입력 시 기본값은 3. |
| SET_FLAG | 세트여부 | STRING(1) |  | 세트여부 (1:사용, 0:미사용) |
| BAL_FLAG | 재고수량관리 | STRING(1) |  | 품목의 수량관리 여부(0:수량관리제외, 1:수량관리대상) |
| WH_CD | 생산공정 | STRING(5) |  | 생산공정코드 : 재고1 > 기초등록 > 창고등록 > 신규 > 구분 : 공장 > 생산공정 |
| IN_PRICE | 입고단가 | NUMERIC(18,6) |  | 입고단가 |
| IN_PRICE_VAT | 입고단가Vat포함여부 | STRING(1) |  | 입고단가부가세포함여부 : 미포함0, 포함1. 미입력 시 기본값은 0 |
| OUT_PRICE | 출고단가 | NUMERIC(18,6) |  | 출고단가 |
| OUT_PRICE_VAT | 출고단가Vat포함여부 | STRING(1) |  | 출고단가부가세포함여부 : 미포함0, 포함1. 미입력 시 기본값은 0 |
| REMARKS_WIN | 검색창내용 | STRING(100) |  | 검색창내용 |
| CLASS_CD | 그룹코드 | STRING(5) |  | 품목그룹1코드 |
| CLASS_CD2 | 그룹코드2 | STRING(5) |  | 품목그룹2코드 |
| CLASS_CD3 | 그룹코드3 | STRING(5) |  | 품목그룹3코드 |
| BAR_CODE | 바코드 | STRING(30) |  | 바코드 |
| TAX | 부가가치세율 | NUMERIC(6,3) |  | 판매전표입력시 반영될 부가세율 |
| VAT_RATE_BY | 부가세율(매입) | NUMERIC(6,3) |  | 구매전표입력시 반영될 부가세율 |
| CS_FLAG | C-Portal사용여부 | STRING(1) |  | C-Portal사용여부 (1:사용, 0:미사용) |
| REMARKS | 적요 | STRING(100) |  | 적요 |
| INSPECT_TYPE_CD | 품질검사유형 | STRING(30) |  | 품질검사유형 : 재고2 > 품질관리 > 품질검사 > 품질검사유형등록 |
| INSPECT_STATUS | 품질검사방법 | STRING(1) |  | 품질검사방법설정(L:전수, S:샘플링) |
| SAMPLE_PERCENT | 샘플링비율 | NUMERIC(4,2) |  | 샘플링비율 |
| CSORD_C0001 | C-Portal최소주문수량체크 | STRING(1) |  | C-Portal주문수량 입력 시 품목의 재고 확인여부를 설정(Y:사용, N:사용안함) |
| CSORD_TEXT | C-Portal최소주문수량 | NUMERIC(15,3) |  | C-Portal주문수량 입력 시 최소주문수량을 입력 |
| CSORD_C0003 | C-Portal최소주문단위 | STRING(1) |  | C-Portal주문수량 입력 시 최소주문단위을 설정(Y:사용, N:사용안함) |
| IN_TERM | 조달기간 | STRING(5) |  | 조달기간 |
| MIN_QTY | 최소구매단위 | STRING(7) |  | 최소구매단위 |
| CUST | 구매처 | STRING(30) |  | 구매처 |
| EXCH_RATE | 당수량(분자) | STRING(30) |  |  |
| DENO_RATE | 당수량(분모) | STRING(30) |  |  |
| OUT_PRICE1 | 단가A | NUMERIC(18,6) |  | 단가A |
| OUT_PRICE1_VAT_YN | 단가A VAT포함여부 | STRING(1) |  | 단가A VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE2 | 단가B | NUMERIC(18,6) |  | 단가B |
| OUT_PRICE2_VAT_YN | 단가B VAT포함여부 | STRING(1) |  | 단가B VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE3 | 단가C | NUMERIC(18,6) |  | 단가C |
| OUT_PRICE3_VAT_YN | 단가C VAT포함여부 | STRING(1) |  | 단가C VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE4 | 단가D | NUMERIC(18,6) |  | 단가D |
| OUT_PRICE4_VAT_YN | 단가D VAT포함여부 | STRING(1) |  | 단가D VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE5 | 단가E | NUMERIC(18,6) |  | 단가E |
| OUT_PRICE5_VAT_YN | 단가E VAT포함여부 | STRING(1) |  | 단가E VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE6 | 단가F | NUMERIC(18,6) |  | 단가F |
| OUT_PRICE6_VAT_YN | 단가F VAT포함여부 | STRING(1) |  | 단가F VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE7 | 단가G | NUMERIC(18,6) |  | 단가G |
| OUT_PRICE7_VAT_YN | 단가G VAT포함여부 | STRING(1) |  | 단가G VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE8 | 단가H | NUMERIC(18,6) |  | 단가H |
| OUT_PRICE8_VAT_YN | 단가H VAT포함여부 | STRING(1) |  | 단가H VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE9 | 단가I | NUMERIC(18,6) |  | 단가I |
| OUT_PRICE9_VAT_YN | 단가I VAT포함여부 | STRING(1) |  | 단가I VAT포함여부(N:포함안함, Y:포함) |
| OUT_PRICE10 | 단가J | NUMERIC(18,6) |  | 단가J |
| OUT_PRICE10_VAT_YN | 단가J VAT포함여부 | STRING(1) |  | 단가J VAT포함여부(N:포함안함, Y:포함) |
| OUTSIDE_PRICE | 외주비단가 | NUMERIC(18,6) |  | 외주비단가 |
| OUTSIDE_PRICE_VAT | 외주비단가 VAT포함여부 | STRING(1) |  | 외주비단가 VAT포함여부(0:포함안함, 1:포함) |
| LABOR_WEIGHT | 노무비단가 | NUMERIC(7,2) |  | 노무비단가 |
| EXPENSES_WEIGHT | 경비가중치 | NUMERIC(7,2) |  | 경비가중치 |
| MATERIAL_COST | 재료비표준원가 | NUMERIC(18,6) |  | 재료비표준원가 |
| EXPENSE_COST | 경비표준원가 | NUMERIC(18,6) |  | 경비표준원가 |
| LABOR_COST | 노무비표준원가 | NUMERIC(18,6) |  | 노무비표준원가 |
| OUT_COST | 외주비표준원가 | NUMERIC(18,6) |  | 외주비표준원가 |
| CONT1 | 문자형추가항목1 | STRING(100) |  | 문자형추가항목1 |
| CONT2 | 문자형추가항목2 | STRING(100) |  | 문자형추가항목2 |
| CONT3 | 문자형추가항목3 | STRING(100) |  | 문자형추가항목3 |
| CONT4 | 문자형추가항목4 | STRING(100) |  | 문자형추가항목4 |
| CONT5 | 문자형추가항목5 | STRING(100) |  | 문자형추가항목5 |
| CONT6 | 문자형추가항목6 | STRING(100) |  | 문자형추가항목6 |
| NO_USER1 | 숫자형추가항목1 | NUMERIC(18,6) |  | 숫자형추가항목1 |
| NO_USER2 | 숫자형추가항목2 | NUMERIC(18,6) |  | 숫자형추가항목2 |
| NO_USER3 | 숫자형추가항목3 | NUMERIC(18,6) |  | 숫자형추가항목3 |
| NO_USER4 | 숫자형추가항목4 | NUMERIC(18,6) |  | 숫자형추가항목4 |
| NO_USER5 | 숫자형추가항목5 | NUMERIC(18,6) |  | 숫자형추가항목5 |
| NO_USER6 | 숫자형추가항목6 | NUMERIC(18,6) |  | 숫자형추가항목6 |
| NO_USER7 | 숫자형추가항목7 | NUMERIC(18,6) |  | 숫자형추가항목7 |
| NO_USER8 | 숫자형추가항목8 | NUMERIC(18,6) |  | 숫자형추가항목8 |
| NO_USER9 | 숫자형추가항목9 | NUMERIC(18,6) |  | 숫자형추가항목9 |
| NO_USER10 | 숫자형추가항목10 | NUMERIC(18,6) |  | 숫자형추가항목10 |
| ITEM_TYPE | 관리항목 | STRING(1) |  | 관리항목(B:기본설정,M:필수입력,Y:선택입력,N:사용안함) |
| SERIAL_TYPE | 시리얼/로트 | STRING(1) |  | 시리얼(B:기본설정,M:필수입력,Y:선택입력,N:사용안함) |
| PROD_SELL_TYPE | 생산전표생성-판매 | STRING(1) |  | 생산전표생성-판매(B:기본설정,Y:사용,N:사용안함) |
| PROD_WHMOVE_TYPE | 생산전표생성-창고이동 | STRING(1) |  | 생산전표생성-창고이동(B:기본설정,Y:사용,N:사용안함) |
| QC_BUY_TYPE | 품질검사요청-구매 | STRING(1) |  | 품질검사요청-구매(B:기본설정,Y:사용,N:사용안함) |
| QC_YN | 품질검사요청여부 | STRING(1) |  | 품질검사요청여부(Y:사용, N:미사용) |

Example Parameter

{"PROD_CD": "00001","PROD_TYPE":"0"}
Example Result
[SUCCESS]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 3/6000," 1일 허용량" : 4/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "Result": "[{"PROD_CD": "00001", 
    "PROD_DES": "test123", 
    "SIZE_FLAG": "1", 
    "SIZE_DES": "6", 
    "UNIT": "EA", 
    "PROD_TYPE": "3", 
    "SET_FLAG": "1", 
    "BAL_FLAG": "1",
    "WH_CD": "00002", 
    "IN_PRICE": "700.0000000000", 
    "SIZE_CD": "", 
    "IN_PRICE_VAT": "1", 
    "REMARKS_WIN": "test", 
    "CLASS_CD": "00001", 
    "CLASS_CD2": "", 
    "CLASS_CD3": "", 
    "BAR_CODE": "8801166053051", 
    "TAX": "20.000", 
    "VAT_RATE_BY": "20.00000", 
    "CS_FLAG": "1", 
    "REMARKS": "123", 
    "INSPECT_TYPE_CD": "1", 
    "INSPECT_STATUS": "L", 
    "SAMPLE_PERCENT": "0.00", 
    "IN_TERM": "0", 
    "MIN_QTY": "0.0000000000", 
    "CUST": "2118702818", 
    "EXCH_RATE": "0.0000000000", 
    "DENO_RATE": 1, 
    "OUT_PRICE": "12000.0000000000", 
    "OUT_PRICE1": "0.0000000000", 
    "OUT_PRICE2": "0.0000000000", 
    "OUT_PRICE3": "111.0000000000", 
    "OUT_PRICE4": "0.0000000000", 
    "OUT_PRICE5": "0.0000000000", 
    "OUT_PRICE6": "0.0000000000", 
    "OUT_PRICE7": "0.0000000000", 
    "OUT_PRICE8": "0.0000000000", 
    "OUT_PRICE9": "0.0000000000", 
    "OUT_PRICE10": "0.0000000000", 
    "OUT_PRICE_VAT": "1", 
    "OUT_PRICE1_VAT_YN": "N", 
    "OUT_PRICE2_VAT_YN": "Y",
    "OUT_PRICE3_VAT_YN": "N", 
    "OUT_PRICE4_VAT_YN": "Y", 
    "OUT_PRICE5_VAT_YN": "N", 
    "OUT_PRICE6_VAT_YN": "N", 
    "OUT_PRICE7_VAT_YN": "N", 
    "OUT_PRICE8_VAT_YN": "N", 
    "OUT_PRICE9_VAT_YN": "N", 
    "OUT_PRICE10_VAT_YN": "N", 
    "OUTSIDE_PRICE": "6000.0000000000", 
    "OUTSIDE_PRICE_VAT": "1", 
    "LABOR_WEIGHT": "1.0000000000", 
    "EXPENSES_WEIGHT": "1.00", 
    "MATERIAL_COST": "0.0000000000", 
    "EXPENSE_COST": "0.0000000000", 
    "LABOR_COST": "0.0000000000", 
    "OUT_COST": "0.0000000000", 
    "CONT1": "", 
    "CONT2": "", 
    "CONT3": "", 
    "CONT4": "", 
    "CONT5": "",
    "CONT6": "",
    "NO_USER1": "0.0000000000", 
    "NO_USER2": "0.0000000000", 
    "NO_USER3": "0.0000000000",
    "SERIAL_TYPE": "B", 
    "PROD_SELL_TYPE": "B", 
    "PROD_WHMOVE_TYPE": "B",
    "QC_BUY_TYPE": "B", 
    "QC_YN": "B", 
    "SAFE_QTY": "0.0000000000"
    }
    ]"
  },
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2020-01-00 00:00:00.000",
  "RequestKey": null,
  "IsEnableNoL4": true,
  "RefreshTimestamp": "0",
  "AsyncActionKey": null
}
오류 종류별 설명
상세보기



========================================
## 견적서입력 (idx=24)
========================================

# 견적서API

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/Quotation/SaveQuotation?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/Quotation/SaveQuotation?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| QuotationList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| UPLOAD_SER_NO | 순번 | SMALLINT(4,0) | Y |  | 순번* 입력내용- 동일한 전표로 묶고자 하는 경우 동일 순번을 부여합니다.- 입력된 순번 및 전표묶음기준 설정에 따라 한 장의 전표로 처리됩니다.* 입력글자제한- 최대 4자 |
| IO_DATE | 일자 | STRING(8) |  |  | 견적서일자 미 입력시 현재일로 입력됨 |
| CUST | 거래처코드 | STRING(30) |  |  | 견적거래처코드(ERP거래처코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| CUST_DES | 거래처명 | STRING(100) |  |  | 견적거래처명(ERP거래처명) 미 입력시 ERP거래처코드에 해당하는 거래처명이 입력됨 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| EMP_CD | 담당자 | STRING(30) |  |  | 담당자코드(ERP 담당자코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| WH_CD | 출하창고 | STRING(5) |  |  | 출하창고코드(ERP 창고코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| IO_TYPE | 구분(거래유형) | STRING(2) |  |  | 부가세유형코드 입력Self-Customizing > 환경설정 > 기능설정 > 공통탭 > 재고-부가세 설정 > 거래유형별 설정에 유형코드 참조미 입력시 기본값 입력됨 재고1> 영업관리 > (주문서, 견적서, 판매)입력 > 옵션 > 입력화면설정 > 상단탭에서 반드시 항목설정이 되어있어야 함. |
| EXCHANGE_TYPE | 외화종류 | STRING(5) |  |  | 외자(내외자구분 : 1)인 경우만 외화코드 입력함.재고 I > 기초등록 > 외화등록 참조 |
| EXCHANGE_RATE | 환율 | NUMERIC(18,4) |  |  | 외자인 경우만 환율 입력함.미 입력시 외화종류(외화코드)에 해당하는 환율을 적용함 |
| PJT_CD | 프로젝트 | STRING(14) |  |  | 프로젝트코드 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| DOC_NO | 견적No. | STRING(30) |  |  | 견적No. Self-Customizing > 환경설정 > 사용방법설정 > 공통탭 > 관리No 설정 > 견적No 생성기준이 직접입력인 경우에만 입력함. |
| TTL_CTT | 제목 | STRING(200) |  |  | 제목 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 제목 기본값 설정 > 직접입력인 경우에만 입력함. |
| REF_DES | 참조 | STRING(200) |  |  | 참조사항 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| COLL_TERM | 결제조건 | STRING(200) |  |  | 결제조건 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| AGREE_TERM | 유효기간 | STRING(200) |  |  | 유효기간 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO1 | 문자형식1 | STRING(6) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO2 | 문자형식2 | STRING(200) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO3 | 문자형식3 | STRING(200) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO4 | 문자형식4 | STRING(200) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO5 | 문자형식5 | STRING(200) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_TXT_01_T ~ ADD_TXT_10_T | 추가문자형식1 ~ 추가문자형식10 | STRING(200) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_NUM_01_T ~ ADD_NUM_05_T | 추가숫자형식1 ~ 추가숫자형식5 | NUMERIC(28,10) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_CD_01_T ~ ADD_CD_03_T | 추가코드형식1 ~ 추가코드형식3 | STRING(100) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_DATE_01_T ~ ADD_DATE_03_T | 추가일자형식1 ~ 추가일자형식3 | STRING(8) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_TXT1 | 장문형식1 | STRING(2000) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_LTXT_01_T ~ ADD_LTXT_03_T | 추가장문형식1 ~ 추가장문형식3 | STRING(2000) |  |  | 재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PROD_CD | 품목코드 | STRING(20) | Y |  | 품목코드(ERP품목코드) |
| PROD_DES | 품목명 | STRING(100) |  |  | 품목명(ERP품목명)미 입력시 ERP품목코드에 해당하는 품목명이 입력됨 |
| SIZE_DES | 규격 | STRING(100) |  |  | 규격(ERP규격)미 입력시 ERP품목코드에 해당하는 규격이 입력됨 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| UQTY | 추가수량 | NUMERIC(28,10) |  |  | 추가수량 사용할 경우만 입력(Self-Customizing > 환경설정 > 기능설정 > 재고탭 > 수량단위 설정 > 추가수량관리여부에 기본과추가수량사용 설정 한경우) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| QTY | 수량 | NUMERIC(28,10) | Y |  | 주문수량 |
| PRICE | 단가 | NUMERIC(18,6) |  |  | 견적단가 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| USER_PRICE_VAT | 단가(vat포함) | NUMERIC(28,10) |  |  | VAT포함 단가 재고1> 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭 > 단가(VAT) 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| SUPPLY_AMT | 공급가액(원화) | NUMERIC(28,4) |  |  | 공급가액(원화) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| SUPPLY_AMT_F | 공급가액[외화] | NUMERIC(28,4) |  |  | 외자인경우 외화금액 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| VAT_AMT | 부가세 | NUMERIC(28,4) |  |  | 부가세 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| REMARKS | 적요 | STRING(200) |  |  | 적요 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ITEM_CD | 관리항목 | STRING(14) |  |  | 관리항목코드 |
| P_AMT1 | 금액1 | NUMERIC(28,10) |  |  | 재고 > 견적서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_AMT2 | 금액2 | NUMERIC(28,10) |  |  | 재고 > 견적서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS1 | 적요1 | STRING(100) |  |  | 재고 > 견적서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS2 | 적요2 | STRING(100) |  |  | 재고 > 견적서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS3 | 적요3 | STRING(100) |  |  | 재고 > 견적서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_TXT_01 ~ ADD_TXT_06 | 추가문자형식1 ~ 추가문자형식6 | STRING(200) |  |  | 재고 > 견적서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가문자형식1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_NUM_01 ~ ADD_NUM_05 | 추가숫자형식1 ~ 추가숫자형식5 | NUMERIC(28,10) |  |  | 재고 > 견적서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가숫자형식1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_CD_01 ~ ADD_CD_03 | 추가코드형식코드1 ~ 추가코드형식코드3 | STRING(100) |  |  | 재고 > 견적서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가코드형식코드1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_CD_NM_01 ~ ADD_CD_NM_03 | 추가코드형식명1 ~ 추가코드형식명3 | STRING(100) |  |  | 재고 > 견적서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가코드형식명1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_DATE_01 ~ ADD_DATE_03 | 추가일자형식1 ~ 추가일자형식3 | STRING(8) |  |  | 재고 > 견적서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가일자형식1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 견적서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  | 반복부분 |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y |  |
| SlipNos | 견적번호(ERP) | STRING(20) | Y | 견적번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
     "QuotationList": [{
      "BulkDatas": {
       "IO_DATE": "20200213",
       "UPLOAD_SER_NO": "",
       "CUST": "",
       "CUST_DES": "",
       "EMP_CD": "",
       "WH_CD": "",
       "IO_TYPE": "",
       "EXCHANGE_TYPE": "",
       "EXCHANGE_RATE": "",
       "PJT_CD": "",
       "REF_DES": "",
       "COLL_TERM": "",
       "AGREE_TERM": "",
       "DOC_NO": "",
       "TTL_CTT": "",
       "U_MEMO1": "",
       "U_MEMO2": "",
       "U_MEMO3": "",
       "U_MEMO4": "",
       "U_MEMO5": "",
       "ADD_TXT_01_T": "",
       "ADD_TXT_02_T": "",
       "ADD_TXT_03_T": "",
       "ADD_TXT_04_T": "",
       "ADD_TXT_05_T": "",
       "ADD_TXT_06_T": "",
       "ADD_TXT_07_T": "",
       "ADD_TXT_08_T": "",
       "ADD_TXT_09_T": "",
       "ADD_TXT_10_T": "",
       "ADD_NUM_01_T": "",
       "ADD_NUM_02_T": "",
       "ADD_NUM_03_T": "",
       "ADD_NUM_04_T": "",
       "ADD_NUM_05_T": "",
       "ADD_CD_01_T": "",
       "ADD_CD_02_T": "",
       "ADD_CD_03_T": "",
       "ADD_DATE_01_T": "",
       "ADD_DATE_02_T": "",
       "ADD_DATE_03_T": "",
       "U_TXT1": "",
       "ADD_LTXT_01_T": "",
       "ADD_LTXT_02_T": "",
       "ADD_LTXT_03_T": "",
       "PROD_CD": "00001",
       "PROD_DES": "test",
       "SIZE_DES": "",
       "UQTY": "",
       "QTY": "1",
       "PRICE": "",
       "USER_PRICE_VAT": "",
       "SUPPLY_AMT": "",
       "SUPPLY_AMT_F": "",
       "VAT_AMT": "",
       "REMARKS": "",
       "ITEM_CD": "",
       "P_AMT1": "",
       "P_AMT2": "",
       "P_REMARKS1": "",
       "P_REMARKS2": "",
       "P_REMARKS3": "",
       "ADD_TXT_01": "",
       "ADD_TXT_02": "",
       "ADD_TXT_03": "",
       "ADD_TXT_04": "",
       "ADD_TXT_05": "",
       "ADD_TXT_06": "",
       "ADD_NUM_01": "",
       "ADD_NUM_02": "",
       "ADD_NUM_03": "",
       "ADD_NUM_04": "",
       "ADD_NUM_05": "",
       "ADD_CD_01": "",
       "ADD_CD_02": "",
       "ADD_CD_03": "",
       "ADD_CD_NM_01": "",
       "ADD_CD_NM_02": "",
       "ADD_CD_NM_03": "",
       "ADD_CDNM_01": "",
       "ADD_CDNM_02": "",
       "ADD_CDNM_03": "",
       "ADD_DATE_01": "",
       "ADD_DATE_02": "",
       "ADD_DATE_03": ""
      }
     },{
      "BulkDatas": {
       "IO_DATE": "20200213",
       "UPLOAD_SER_NO": "",
       "CUST": "",
       "CUST_DES": "",
       "EMP_CD": "",
       "WH_CD": "",
       "IO_TYPE": "",
       "EXCHANGE_TYPE": "",
       "EXCHANGE_RATE": "",
       "PJT_CD": "",
       "REF_DES": "",
       "COLL_TERM": "",
       "AGREE_TERM": "",
       "DOC_NO": "",
       "U_MEMO1": "",
       "U_MEMO2": "",
       "U_MEMO3": "",
       "U_MEMO4": "",
       "U_MEMO5": "",
       "ADD_TXT_01_T": "",
       "ADD_TXT_02_T": "",
       "ADD_TXT_03_T": "",
       "ADD_TXT_04_T": "",
       "ADD_TXT_05_T": "",
       "ADD_TXT_06_T": "",
       "ADD_TXT_07_T": "",
       "ADD_TXT_08_T": "",
       "ADD_TXT_09_T": "",
       "ADD_TXT_10_T": "",
       "ADD_NUM_01_T": "",
       "ADD_NUM_02_T": "",
       "ADD_NUM_03_T": "",
       "ADD_NUM_04_T": "",
       "ADD_NUM_05_T": "",
       "ADD_CD_01_T": "",
       "ADD_CD_02_T": "",
       "ADD_CD_03_T": "",
       "ADD_DATE_01_T": "",
       "ADD_DATE_02_T": "",
       "ADD_DATE_03_T": "",
       "U_TXT1": "",
       "ADD_LTXT_01_T": "",
       "ADD_LTXT_02_T": "",
       "ADD_LTXT_03_T": "",
       "PROD_CD": "00001",
       "PROD_DES": "test",
       "SIZE_DES": "",
       "UQTY": "",
       "QTY": "1",
       "PRICE": "",
       "USER_PRICE_VAT": "",
       "SUPPLY_AMT": "",
       "SUPPLY_AMT_F": "",
       "VAT_AMT": "",
       "REMARKS": "",
       "ITEM_CD": "",
       "P_AMT1": "",
       "P_AMT2": "",
       "P_REMARKS1": "",
       "P_REMARKS2": "",
       "P_REMARKS3": "",
       "ADD_TXT_01": "",
       "ADD_TXT_02": "",
       "ADD_TXT_03": "",
       "ADD_TXT_04": "",
       "ADD_TXT_05": "",
       "ADD_TXT_06": "",
       "ADD_NUM_01": "",
       "ADD_NUM_02": "",
       "ADD_NUM_03": "",
       "ADD_NUM_04": "",
       "ADD_NUM_05": "",
       "ADD_CD_01": "",
       "ADD_CD_02": "",
       "ADD_CD_03": "",
       "ADD_CD_NM_01": "",
       "ADD_CD_NM_02": "",
       "ADD_CD_NM_03": "",
       "ADD_CDNM_01": "",
       "ADD_CDNM_02": "",
       "ADD_CDNM_03": "",
       "ADD_DATE_01": "",
       "ADD_DATE_02": "",
       "ADD_DATE_03": ""
      }
     }]
}
Example Result
[SUCCESS]
{
  "Data": {
    "EXPIRE_DATE": "",
    "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
    "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
    "SuccessCnt": 2,
    "FailCnt": 0,
    "ResultDetails": "[{"IsSuccess": true, "TotalError": "[전표묶음 0] OK", "Errors": [], "Code": null}, 
                       {"IsSuccess": true, "TotalError": "[전표묶음 0] OK", "Errors": [], "Code": null}]",
    "SlipNos": "["20200213-2"]"
  },
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2020-03-12 15:56:02.378",
  "RequestKey": null,
  "IsEnableNoL4": false,
  "RefreshTimestamp": null,
  "AsyncActionKey": null
}
[FAIL - Validation]
        
{
  "Data": {
    "EXPIRE_DATE": "",
    "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
    "SuccessCnt": 0,
    "FailCnt": 2,
    "ResultDetails": "[{"IsSuccess": false, "TotalError": "[전표묶음 0] 일자 (편집제한일자)","Errors": [{"ColCd": "IO_DATE", "Message": "일자 (편집제한일자)"}], "Code": null}, 
                       {"IsSuccess": false, "TotalError": "[전표묶음 1] 일자 (편집제한일자)","Errors": [{"ColCd": "IO_DATE", "Message": "일자 (편집제한일자)"}], "Code": null}]",
    "SlipNos": null
  },
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2020-03-12 15:54:56.372",
  "RequestKey": null,
  "IsEnableNoL4": false,
  "RefreshTimestamp": null,
  "AsyncActionKey": null
}
오류 종류별 설명
상세보기



========================================
## 주문서입력 (idx=25)
========================================

# 주문API

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/SaleOrder/SaveSaleOrder?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/SaleOrder/SaveSaleOrder?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| SaleOrderList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| UPLOAD_SER_NO | 순번 | SMALLINT(4,0) | Y |  | 순번* 입력내용- 동일한 전표로 묶고자 하는 경우 동일 순번을 부여합니다.- 입력된 순번 및 전표묶음기준 설정에 따라 한 장의 전표로 처리됩니다.* 입력글자제한- 최대 4자 |
| IO_DATE | 일자 | STRING(8) |  |  | 주문일자 미 입력시 현재일로 입력됨 |
| CUST | 거래처코드 | STRING(30) | Y |  | 주문거래처코드(ERP거래처코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| CUST_DES | 거래처명 | STRING(100) |  |  | 주문거래처명(ERP거래처명)미 입력시 ERP거래처코드에 해당하는 거래처명이 입력됨 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| EMP_CD | 담당자 | STRING(30) |  |  | 담당자코드(ERP 담당자코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| WH_CD | 출하창고 | STRING(5) | Y |  | 출하창고코드(ERP 창고코드) |
| IO_TYPE | 구분(거래유형) | STRING(2) |  |  | 부가세유형코드 입력Self-Customizing > 환경설정 > 기능설정 > 공통탭 > 재고-부가세 설정 > 거래유형별 설정에 유형코드 참조미 입력시 기본값 입력됨 재고1> 영업관리 > (주문서, 견적서, 판매)입력 > 옵션 > 입력화면설정 > 상단탭에서 반드시 항목설정이 되어있어야 함. |
| EXCHANGE_TYPE | 외화종류 | STRING(5) |  |  | 외자(내외자구분 : 1)인 경우만 외화코드 입력함.재고 I > 기초등록 > 외화등록 참조 |
| EXCHANGE_RATE | 환율 | NUMERIC(18,4) |  |  | 외자인 경우만 환율 입력함.미 입력시 외화종류(외화코드)에 해당하는 환율을 적용함 |
| PJT_CD | 프로젝트 | STRING(14) |  |  | 프로젝트코드 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| DOC_NO | 주문No. | STRING(30) |  |  | 주문번호Self-Customizing > 환경설정 > 사용방법설정 > 공통탭 > 관리No 설정 > 주문No 생성기준이 직접입력인 경우에만 입력함. |
| TTL_CTT | 제목 | STRING(200) |  |  | 제목 재고 I > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 제목 기본값 설정 > 직접입력인 경우에만 입력함. |
| REF_DES | 참조 | STRING(200) |  |  | 참조사항 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| COLL_TERM | 결제조건 | STRING(200) |  |  | 결제조건 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| AGREE_TERM | 유효기간 | STRING(200) |  |  | 유효기간 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| TIME_DATE | 납기일자 | STRING(8) |  |  | 납기일자 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| REMARKS_WIN | 검색창내용 | STRING(50) |  |  | 검색창내용 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO1 | 문자형식1 | STRING(6) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO2 | 문자형식2 | STRING(200) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO3 | 문자형식3 | STRING(200) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO4 | 문자형식4 | STRING(200) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO5 | 문자형식5 | STRING(200) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_TXT_01_T ~ ADD_TXT_10_T | 추가문자형식1 ~ 추가문자형식10 | STRING(200) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_NUM_01_T ~ ADD_NUM_05_T | 추가숫자형식1 ~ 추가숫자형식5 | NUMERIC(28,10) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_CD_01_T ~ ADD_CD_03_T | 추가코드형식1 ~ 추가코드형식3 | STRING(100) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_DATE_01_T ~ ADD_DATE_03_T | 추가일자형식1 ~ 추가일자형식3 | STRING(8) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_TXT1 | 장문형식1 | STRING(2000) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_LTXT_01_T ~ ADD_LTXT_03_T | 추가장문형식1 ~ 추가장문형식3 | STRING(2000) |  |  | 재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PROD_CD | 품목코드 | STRING(20) | Y |  | 품목코드(ERP품목코드) |
| PROD_DES | 품목명 | STRING(100) |  |  | 품목명(ERP품목명)미 입력시 ERP품목코드에 해당하는 품목명이 입력됨 |
| SIZE_DES | 규격 | STRING(100) |  |  | 규격(ERP규격)미 입력시 ERP품목코드에 해당하는 규격이 입력됨 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| UQTY | 추가수량 | NUMERIC(28,10) |  |  | 추가수량 사용할 경우만 입력(Self-Customizing > 환경설정 > 기능설정 > 재고탭 > 수량단위 설정 > 추가수량관리여부에 기본과추가수량사용 설정 한경우) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| QTY | 수량 | NUMERIC(28,10) | Y |  | 주문수량 |
| PRICE | 단가 | NUMERIC(18,6) |  |  | 주문단가 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| USER_PRICE_VAT | 단가(vat포함) | NUMERIC(28,10) |  |  | VAT포함 단가 재고1> 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭 > 단가(VAT) 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| SUPPLY_AMT | 공급가액(원화) | NUMERIC(28,4) |  |  | 공급가액(원화) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| SUPPLY_AMT_F | 공급가액[외화] | NUMERIC(28,4) |  |  | 외자인경우 외화금액 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| VAT_AMT | 부가세 | NUMERIC(28,4) |  |  | 부가세 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ITEM_TIME_DATE | 품목별납기일자 | STRING(8) |  |  | 품목별납기일자(YYYYMMDD)미입력시 납기일자를 적용한다 |
| REMARKS | 적요 | STRING(200) |  |  | 적요 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ITEM_CD | 관리항목 | STRING(14) |  |  | 관리항목코드 |
| P_REMARKS1 | 적요1 | STRING(100) |  |  | 재고 > 주문서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS2 | 적요2 | STRING(100) |  |  | 재고 > 주문서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS3 | 적요3 | STRING(100) |  |  | 재고 > 주문서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| REL_DATE | 견적일자 | STRING(8) |  |  | 견적일자 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| REL_NO | 견적번호 | NUMERIC(5,0) |  |  | 견적번호 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_AMT1 | 금액1 | NUMERIC(28,10) |  |  | 재고 > 주문서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_AMT2 | 금액2 | NUMERIC(28,10) |  |  | 재고 > 주문서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_TXT_01 ~ ADD_TXT_06 | 추가문자형식1 ~ 추가문자형식6 | STRING(200) |  |  | 재고 > 주문서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가문자형식1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_NUM_01 ~ ADD_NUM_05 | 추가숫자형식1 ~ 추가숫자형식5 | NUMERIC(28,10) |  |  | 재고 > 주문서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가숫자형식1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_CD_01 ~ ADD_CD_03 | 추가코드형식코드1 ~ 추가코드형식코드3 | STRING(100) |  |  | 재고 > 주문서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가코드형식코드1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_CD_NM_01 ~ ADD_CD_NM_03 | 추가코드형식명1 ~ 추가코드형식명3 | STRING(100) |  |  | 재고 > 주문서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가코드형식명1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_DATE_01 ~ ADD_DATE_03 | 추가일자형식1 ~ 추가일자형식3 | STRING(8) |  |  | 재고 > 주문서 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가일자형식1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 주문서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  | 반복부분 |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y |  |
| SlipNos | 주문번호(ERP) | STRING(20) | Y | 주문번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
     "SaleOrderList": [{
        "BulkDatas": {
        "IO_DATE": "20180612",
        "UPLOAD_SER_NO": "",
        "CUST": "00016",
        "CUST_DES": "(주)동희산업",
        "EMP_CD": "",
        "WH_CD": "00009",
        "IO_TYPE": "",
        "EXCHANGE_TYPE": "",
        "EXCHANGE_RATE": "",
        "PJT_CD": "",
        "DOC_NO": "",
        "TTL_CTT": "",
        "REF_DES": "",
        "COLL_TERM": "",
        "AGREE_TERM": "",
        "TIME_DATE": "",
        "REMARKS_WIN": "",
        "U_MEMO1": "",
        "U_MEMO2": "",
        "U_MEMO3": "",
        "U_MEMO4": "",
        "U_MEMO5": "",
        "ADD_TXT_01_T": "",
        "ADD_TXT_02_T": "",
        "ADD_TXT_03_T": "",
        "ADD_TXT_04_T": "",
        "ADD_TXT_05_T": "",
        "ADD_TXT_06_T": "",
        "ADD_TXT_07_T": "",
        "ADD_TXT_08_T": "",
        "ADD_TXT_09_T": "",
        "ADD_TXT_10_T": "",
        "ADD_NUM_01_T": "",
        "ADD_NUM_02_T": "",
        "ADD_NUM_03_T": "",
        "ADD_NUM_04_T": "",
        "ADD_NUM_05_T": "",
        "ADD_CD_01_T": "",
        "ADD_CD_02_T": "",
        "ADD_CD_03_T": "",
        "ADD_DATE_01_T": "",
        "ADD_DATE_02_T": "",
        "ADD_DATE_03_T": "",
        "U_TXT1": "",
        "ADD_LTXT_01_T": "",
        "ADD_LTXT_02_T": "",
        "ADD_LTXT_03_T": "",
        "PROD_CD": "00001",
        "PROD_DES": "test",
        "SIZE_DES": "",
        "UQTY": "",
        "QTY": "1",
        "PRICE": "",
        "USER_PRICE_VAT": "",
        "SUPPLY_AMT": "",
        "SUPPLY_AMT_F": "",
        "VAT_AMT": "",
        "ITEM_TIME_DATE": "",
        "REMARKS": "",
        "ITEM_CD": "",
        "P_REMARKS1": "",
        "P_REMARKS2": "",
        "P_REMARKS3": "",
        "ADD_TXT_01": "",
        "ADD_TXT_02": "",
        "ADD_TXT_03": "",
        "ADD_TXT_04": "",
        "ADD_TXT_05": "",
        "ADD_TXT_06": "",
        "REL_DATE": "",
        "REL_NO": "",
        "P_AMT1": "",
        "P_AMT2": "",
        "ADD_NUM_01": "",
        "ADD_NUM_02": "",
        "ADD_NUM_03": "",
        "ADD_NUM_04": "",
        "ADD_NUM_05": "",
        "ADD_CD_01": "",
        "ADD_CD_02": "",
        "ADD_CD_03": "",
        "ADD_CD_NM_01": "",
        "ADD_CD_NM_02": "",
        "ADD_CD_NM_03": "",
        "ADD_CDNM_01": "",
        "ADD_CDNM_02": "",
        "ADD_CDNM_03": "",
        "ADD_DATE_01": "",
        "ADD_DATE_02": "",
        "ADD_DATE_03": ""
        }
        },{
        "BulkDatas": {
        "IO_DATE": "20180612",
        "UPLOAD_SER_NO": "",
        "CUST": "00016",
        "CUST_DES": "(주)동희산업",
        "EMP_CD": "",
        "WH_CD": "00009",
        "IO_TYPE": "",
        "EXCHANGE_TYPE": "",
        "EXCHANGE_RATE": "",
        "PJT_CD": "",
        "DOC_NO": "",
        "REF_DES": "",
        "COLL_TERM": "",
        "AGREE_TERM": "",
        "TIME_DATE": "",
        "REMARKS_WIN": "",
        "U_MEMO1": "",
        "U_MEMO2": "",
        "U_MEMO3": "",
        "U_MEMO4": "",
        "U_MEMO5": "",
        "ADD_TXT_01_T": "",
        "ADD_TXT_02_T": "",
        "ADD_TXT_03_T": "",
        "ADD_TXT_04_T": "",
        "ADD_TXT_05_T": "",
        "ADD_TXT_06_T": "",
        "ADD_TXT_07_T": "",
        "ADD_TXT_08_T": "",
        "ADD_TXT_09_T": "",
        "ADD_TXT_10_T": "",
        "ADD_NUM_01_T": "",
        "ADD_NUM_02_T": "",
        "ADD_NUM_03_T": "",
        "ADD_NUM_04_T": "",
        "ADD_NUM_05_T": "",
        "ADD_CD_01_T": "",
        "ADD_CD_02_T": "",
        "ADD_CD_03_T": "",
        "ADD_DATE_01_T": "",
        "ADD_DATE_02_T": "",
        "ADD_DATE_03_T": "",
        "U_TXT1": "",
        "ADD_LTXT_01_T": "",
        "ADD_LTXT_02_T": "",
        "ADD_LTXT_03_T": "",
        "PROD_CD": "00001",
        "PROD_DES": "test",
        "SIZE_DES": "",
        "UQTY": "",
        "QTY": "1",
        "PRICE": "",
        "USER_PRICE_VAT": "",
        "SUPPLY_AMT": "",
        "SUPPLY_AMT_F": "",
        "VAT_AMT": "",
        "ITEM_TIME_DATE": "",
        "REMARKS": "",
        "ITEM_CD": "",
        "P_REMARKS1": "",
        "P_REMARKS2": "",
        "P_REMARKS3": "",
        "ADD_TXT_01": "",
        "ADD_TXT_02": "",
        "ADD_TXT_03": "",
        "ADD_TXT_04": "",
        "ADD_TXT_05": "",
        "ADD_TXT_06": "",
        "REL_DATE": "",
        "REL_NO": "",
        "P_AMT1": "",
        "P_AMT2": "",
        "ADD_NUM_01": "",
        "ADD_NUM_02": "",
        "ADD_NUM_03": "",
        "ADD_NUM_04": "",
        "ADD_NUM_05": "",
        "ADD_CD_01": "",
        "ADD_CD_02": "",
        "ADD_CD_03": "",
        "ADD_CD_NM_01": "",
        "ADD_CD_NM_02": "",
        "ADD_CD_NM_03": "",
        "ADD_CDNM_01": "",
        "ADD_CDNM_02": "",
        "ADD_CDNM_03": "",
        "ADD_DATE_01": "",
        "ADD_DATE_02": "",
        "ADD_DATE_03": ""
        }
     }]
}
Example Result
[SUCCESS]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 8/6000," 1일 허용량" : 8/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "SuccessCnt": 2,
      "FailCnt": 0,
      "ResultDetails": [{"IsSuccess": true,"TotalError": "[전표묶음0] OK","Errors": [],"Code": null}
                        {"IsSuccess": true,"TotalError": "[전표묶음0] OK","Errors": [],"Code": null}],
      "SlipNos": ["20180612-2"]
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:25:55.585",
     "RequestKey": "",
     "IsEnableNoL4": false
}
[FAIL - Validation]
        
{
 "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
      "SuccessCnt": 0,
      "FailCnt": 2,
      "ResultDetails": [{"IsSuccess": false,"TotalError": "[전표묶음0] 품목코드 (필수)",
                        "Errors": [{"ColCd": "PROD_CD","Message": "품목코드 (필수)"}],"Code": null},
                        {"IsSuccess": false,"TotalError": "[전표묶음1] 품목코드 (필수)",
                        "Errors": [{"ColCd": "PROD_CD","Message": "품목코드 (필수)"}],"Code": null}],
      "SlipNos": null
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:24:25.651",
     "RequestKey": "",
     "IsEnableNoL4": false
}
오류 종류별 설명
상세보기



========================================
## 판매입력 (idx=26)
========================================

# 판매API

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/Sale/SaveSale?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/Sale/SaveSale?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| SaleList |  |  |  |  |  |
| [BulkDatas] | 판매 전표별 정보 |  |  |  | 반복부분 |
| UPLOAD_SER_NO | 순번 | SMALLINT(4,0) | Y |  | 순번* 입력내용- 동일한 전표로 묶고자 하는 경우 동일 순번을 부여합니다.- 입력된 순번 및 전표묶음기준 설정에 따라 한 장의 전표로 처리됩니다.* 입력글자제한- 최대 4자 |
| IO_DATE | 판매일자 | STRING(8) |  |  | 판매일자 미 입력시 현재일로 입력됨 |
| CUST | 거래처코드 | STRING(30) |  |  | 판매거래처코드(ERP거래처코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| CUST_DES | 거래처명 | STRING(50) |  |  | 판매거래처명(ERP거래처명)미 입력시 ERP거래처코드에 해당하는 거래처명이 입력됨 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| EMP_CD | 담당자 | STRING(30) |  |  | 담당자코드(ERP 담당자코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| WH_CD | 출하창고 | STRING(5) | Y |  | 출하창고코드(ERP 창고코드) |
| IO_TYPE | 구분(거래유형) | STRING(2) |  |  | 부가세유형코드 입력Self-Customizing > 환경설정 > 기능설정 > 공통탭 > 재고-부가세 설정 > 거래유형별 설정에 유형코드 참조미 입력시 기본값 입력됨 재고1> 영업관리 > (주문서, 견적서, 판매)입력 > 옵션 > 입력화면설정 > 상단탭에서 반드시 항목설정이 되어있어야 함. |
| EXCHANGE_TYPE | 외화종류 | STRING(5) |  |  | 외자(내외자구분 : 1)인 경우만 외화코드 입력함.재고 I > 기초등록 > 외화등록 참조 |
| EXCHANGE_RATE | 환율 | NUMERIC(18,4) |  |  | 외자인 경우만 환율 입력함.미 입력시 외화종류(외화코드)에 해당하는 환율을 적용함 |
| SITE | 부서 | STRING(100) |  |  | 부서코드 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PJT_CD | 프로젝트 | STRING(14) |  |  | 프로젝트코드 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| DOC_NO | 판매No. | STRING(30) |  |  | 판매번호Self-Customizing > 환경설정 > 사용방법설정 > 공통탭 > 관리No 설정 > 판매No 생성기준이 직접입력인 경우에만 입력함. |
| TTL_CTT | 제목 | STRING(200) |  |  | 제목 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 제목 기본값 설정 > 직접입력인 경우에만 입력함. |
| U_MEMO1 | 문자형식1 | STRING(200) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO2 | 문자형식2 | STRING(200) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO3 | 문자형식3 | STRING(200) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO4 | 문자형식4 | STRING(200) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO5 | 문자형식5 | STRING(200) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_TXT_01_T ~ ADD_TXT_10_T | 추가문자형식1 ~ 추가문자형식10 | STRING(200) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_NUM_01_T ~ ADD_NUM_05_T | 추가숫자형식1 ~ 추가숫자형식5 | NUMERIC(28,10) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_CD_01_T ~ ADD_CD_03_T | 추가코드형식1 ~ 추가코드형식3 | STRING(100) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_DATE_01_T ~ ADD_DATE_03_T | 추가일자형식1 ~ 추가일자형식3 | STRING(8) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_TXT1 | 장문형식1 | STRING(2000) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_LTXT_01_T ~ ADD_LTXT_03_T | 추가장문형식1 ~ 추가장문형식3 | STRING(2000) |  |  | 재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PROD_CD | 품목코드 | STRING(20) | Y |  | 품목코드(ERP품목코드) |
| PROD_DES | 품목명 | STRING(100) |  |  | 품목명(ERP품목명)미 입력시 ERP품목코드에 해당하는 품목명이 입력됨 |
| SIZE_DES | 규격 | STRING(100) |  |  | 규격(ERP규격)미 입력시 ERP품목코드에 해당하는 규격이 입력됨 |
| UQTY | 추가수량 | NUMERIC(28,10) |  |  | 추가수량 사용할 경우만 입력(Self-Customizing > 환경설정 > 기능설정 > 재고탭 > 수량단위 설정 > 추가수량관리여부에 기본과추가수량사용 설정 한경우) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| QTY | 수량 | NUMERIC(28,10) | Y |  | 판매수량 |
| PRICE | 단가 | NUMERIC(28,10) |  |  | 판매단가 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| USER_PRICE_VAT | 단가(vat포함) | NUMERIC(28,10) |  |  | VAT포함 단가 재고1> 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 하단탭 > 단가(VAT포함) 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| SUPPLY_AMT | 공급가액(원화) | NUMERIC(28,4) |  |  | 공급가액(원화) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| SUPPLY_AMT_F | 공급가액[외화] | NUMERIC(28,4) |  |  | 외자인경우 외화금액 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| VAT_AMT | 부가세 | NUMERIC(28,4) |  |  | 부가세 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| REMARKS | 적요 | STRING(200) |  |  | 적요 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| ITEM_CD | 관리항목 | STRING(14) |  |  | 관리항목코드 |
| P_REMARKS1 | 적요1 | STRING(100) |  |  | 재고 > 판매입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| P_REMARKS2 | 적요2 | STRING(100) |  |  | 재고 > 판매입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| P_REMARKS3 | 적요3 | STRING(100) |  |  | 재고 > 판매입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| P_AMT1 | 금액1 | NUMERIC(28,10) |  |  | 재고 > 판매입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| P_AMT2 | 금액2 | NUMERIC(28,10) |  |  | 재고 > 판매입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > > 하단탭에서 설정 가능) |
| ADD_TXT_01 ~ ADD_TXT_06 | 추가문자형식1 ~ 추가문자형식6 | STRING(200) |  |  | 재고 > 판매 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가문자형식1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_NUM_01 ~ ADD_NUM_05 | 추가숫자형식1 ~ 추가숫자형식5 | NUMERIC(28,10) |  |  | 재고 > 판매 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가숫자형식1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_CD_01 ~ ADD_CD_03 | 추가코드형식코드1 ~ 추가코드형식코드3 | STRING(100) |  |  | 재고 > 판매 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가코드형식코드1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_CD_NM_01 ~ ADD_CD_NM_03 | 추가코드형식명1 ~ 추가코드형식명3 | STRING(100) |  |  | 재고 > 판매 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가코드형식명1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ADD_DATE_01 ~ ADD_DATE_03 | 추가일자형식1 ~ 추가일자형식3 | STRING(8) |  |  | 재고 > 판매 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 추가일자형식1 사용인 경우에 입력필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 영업관리 > 판매입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| Data |  |  |  | 반복부분 |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y |  |
| SlipNos | 판매번호(ERP) | STRING(20) | Y | 판매번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
    "SaleList": [{
        "BulkDatas": {
            "IO_DATE": "20180612",
            "UPLOAD_SER_NO": "",
            "CUST": "",
            "CUST_DES": "",
            "EMP_CD": "",
            "WH_CD": "00009",
            "IO_TYPE": "",
            "EXCHANGE_TYPE": "",
            "EXCHANGE_RATE": "",
            "SITE": "",
            "PJT_CD": "",
            "DOC_NO": "",
            "TTL_CTT": "",
            "U_MEMO1": "",
            "U_MEMO2": "",
            "U_MEMO3": "",
            "U_MEMO4": "",
            "U_MEMO5": "",
            "ADD_TXT_01_T": "",
            "ADD_TXT_02_T": "",
            "ADD_TXT_03_T": "",
            "ADD_TXT_04_T": "",
            "ADD_TXT_05_T": "",
            "ADD_TXT_06_T": "",
            "ADD_TXT_07_T": "",
            "ADD_TXT_08_T": "",
            "ADD_TXT_09_T": "",
            "ADD_TXT_10_T": "",
            "ADD_NUM_01_T": "",
            "ADD_NUM_02_T": "",
            "ADD_NUM_03_T": "",
            "ADD_NUM_04_T": "",
            "ADD_NUM_05_T": "",
            "ADD_CD_01_T": "",
            "ADD_CD_02_T": "",
            "ADD_CD_03_T": "",
            "ADD_DATE_01_T": "",
            "ADD_DATE_02_T": "",
            "ADD_DATE_03_T": "",
            "U_TXT1": "",
            "ADD_LTXT_01_T": "",
            "ADD_LTXT_02_T": "",
            "ADD_LTXT_03_T": "",
            "PROD_CD": "00001",
            "PROD_DES": "test",
            "SIZE_DES": "",
            "UQTY": "",
            "QTY": "1",
            "PRICE": "",
            "USER_PRICE_VAT": "",
            "SUPPLY_AMT": "",
            "SUPPLY_AMT_F": "",
            "VAT_AMT": "",
            "REMARKS": "",
            "ITEM_CD": "",
            "P_REMARKS1": "",
            "P_REMARKS2": "",
            "P_REMARKS3": "",
            "ADD_TXT_01": "",
            "ADD_TXT_02": "",
            "ADD_TXT_03": "",
            "ADD_TXT_04": "",
            "ADD_TXT_05": "",
            "ADD_TXT_06": "",
            "REL_DATE": "",
            "REL_NO": "",
            "MAKE_FLAG": "",
            "CUST_AMT": "",
            "P_AMT1": "",
            "P_AMT2": "",
            "ADD_NUM_01": "",
            "ADD_NUM_02": "",
            "ADD_NUM_03": "",
            "ADD_CD_01": "",
            "ADD_CD_02": "",
            "ADD_CD_03": "",
            "ADD_CD_NM_01": "",
            "ADD_CD_NM_02": "",
            "ADD_CD_NM_03": "",
            "ADD_CDNM_01": "",
            "ADD_CDNM_02": "",
            "ADD_CDNM_03": "",
            "ADD_DATE_01": "",
            "ADD_DATE_02": "",
            "ADD_DATE_03": ""
      }
   }]
}
설명
[SUCCESS]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 9/6000," 1일 허용량" :9/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "SuccessCnt": 2,
      "FailCnt": 0,
      "ResultDetails": [{"IsSuccess": true,"TotalError": "[전표묶음0] OK","Errors": [],"Code": null}
                        {"IsSuccess": true,"TotalError": "[전표묶음0] OK","Errors": [],"Code": null}],
      "SlipNos": ["20180612-2"]
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:23:11.262",
     "RequestKey": "",
     "IsEnableNoL4": false
}
[FAIL - Validation]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 9/6000," 1일 허용량" : 9/10000",
      "SuccessCnt": 0,
      "FailCnt": 2,
      "ResultDetails": [{"IsSuccess": false,"TotalError": "[전표묶음0] 품목코드 (필수), 품목명 (필수), 수량 (필수)",
                         "Errors": [{"ColCd": "PROD_CD","Message": "품목코드 (필수)"}, {"ColCd": "PROD_DES","Message": "품목명 (필수)"}, "Code": null},
                        {"IsSuccess": false,"TotalError": "[전표묶음1] 품목코드 (필수), 품목명 (필수), 수량 (필수)",
                         "Errors": [{"ColCd": "PROD_CD","Message": "품목코드 (필수)"}, {"ColCd": "PROD_DES","Message": "품목명 (필수)"}, "Code": null}],
      "SlipNos": null
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:21:37.186",
     "RequestKey": "",
     "IsEnableNoL4": false
}
오류 종류별 설명
상세보기



========================================
## 발주서조회 (idx=28)
========================================

# 발주서조회API

개요
외부 서비스와 연계를 통해서 ERP의 발주서를 조회할 수 있습니다.
요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/Purchases/GetPurchasesOrderList?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/Purchases/GetPurchasesOrderList?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| PROD_CD | 품목코드 | STRING(1000) |  |  | 입력내용 - 조회하기 원하는 품목 코드를 입력합니다. - 여러 품목을 검색 시 구분값 '∬' 을 추가하여 조회할 수 있습니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| CUST_CD | 거래처코드 | STRING(1000) |  |  | 입력내용 - 조회하기 원하는 거래처코드를 입력합니다. - 여러 품목을 검색 시 구분값 '∬' 을 추가하여 조회할 수 있습니다.입력글자제한 - 기 등록된 거래처코드를 입력합니다. - 최대 30자 |
| ListParam |  |  |  |  |  |
| BASE_DATE_FROM | 검색 시작일시 | STRING(8) | Y |  | 입력내용 - 조회하기 원하는 시작 날짜를 입력합니다.입력글자제한 - YYYYMMDD |
| BASE_DATE_TO | 검색 종료일시 | STRING(8) | Y |  | 입력내용 - 조회하기 원하는 종료 날짜를 입력합니다.입력글자제한 - YYYYMMDD 최대 30일까지 조회 가능합니다. |
| PAGE_CURRENT | 페이지번호 | INT |  |  | 기본값 1 |
| PAGE_SIZE | 표시줄수 | INT |  |  | 기본값 26 최대값 100 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| TotalCnt | 성공건수 | Int | Y |  |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |
| Result |  |  |  | 반복부분 |
| ORD_NO | 발주번호 |  |  |  |
| ORD_DATE | 일자 |  |  |  |
| WH_CD | 창고코드 |  |  |  |
| WH_DES | 창고명 |  |  |  |
| PJT_CD | 프로젝트코드 |  |  |  |
| PJT_DES | 프로젝트명 |  |  |  |
| EMP_CD | 담당자코드 |  |  |  |
| CUST_NAME | 담당자명 |  |  |  |
| CUST | 거래처코드 |  |  |  |
| CUST_DES | 거래처명 |  |  |  |
| FOREIGN_FLAG | 내.외자구분 |  |  |  |
| EXCHANGE_TYPE | 외화종류 |  |  |  |
| CODE_DES | 외화명 |  |  |  |
| EXCHANGE_RATE | 환율 |  |  |  |
| REF_DES | 참조 |  |  |  |
| P_DES1 | 문자형식1 |  |  |  |
| P_DES2 | 문자형식2 |  |  |  |
| P_DES3 | 문자형식3 |  |  |  |
| P_DES4 | 문자형식4 |  |  |  |
| P_DES5 | 문자형식5 |  |  |  |
| P_DES6 | 장문형식1 |  |  |  |
| P_FLAG | 상태구분 |  |  | 1:진행중, 9:종결 - 재고1 > 구매관리 > 발주서 > 발주서조회 > 옵션 > 리스트탭설정의 진행상태코드 설정시 해당값을 보여줍니다. |
| IO_TYPE | 거래유형 |  |  | 1:영업, 2:구매, 4:생산 |
| SEND_FLAG | 발주서발송 |  |  | 0:미전송, E:전송 |
| PROD_DES | 품목명[규격명] |  |  |  |
| EDMS_DATE | 전자결재일자 |  |  |  |
| EDMS_NO | 전자결재번호 |  |  |  |
| EDMS_APP_TYPE | 전자결재상태 |  |  | 0:기안중, 1:결재중, 3:반려, 9:결재완료 |
| IO_DATE | 발주계획일자 |  |  |  |
| IO_NO | 발주계획번호 |  |  |  |
| WRITER_ID | 최초작성자 |  |  |  |
| WRITE_DT | 최초작성일자 |  |  |  |
| LOGID | 최종수정자 |  |  |  |
| UPDATE_DATE | 최종수정일자 |  |  |  |
| UQTY | 수량합계 (추가수량) |  |  |  |
| QTY | 발주수량합계 |  |  |  |
| BUY_AMT | 발주공급가액합계 |  |  |  |
| VAT_AMT | 발주부가세합계 |  |  |  |
| BUY_AMT_F | 발주외화금액합계 |  |  |  |
| TTL_CTT | 제목 |  |  |  |
| TIME_DATE | 납기일자 |  |  |  |

Example Parameter

{
    "PROD_CD":"",
    "CUST_CD":"",
    "ListParam":{
                    "PAGE_CURRENT":1,
                    "PAGE_SIZE":100,
                    "BASE_DATE_FROM":"20190701",
                    "BASE_DATE_TO":"20190730"
                }
}
Example Result
[SUCCESS]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 3/6000," 1일 허용량" : 11/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "Result": [
                {"ORD_NO":2,
                "ORD_DATE":"20190729",
                "WH_CD":"00001",
                "WH_DES":"test"
                ,"PJT_CD":"00001"
                ,"PJT_DES":"프로젝트A"
                ,"EMP_CD":"100"
                ,"CUST_NAME":"테스트"
                ,"CUST":"2312891"
                ,"CUST_DES":"bmt"
                ,"FOREIGN_FLAG":"0"
                ,"EXCHANGE_TYPE":""
                ,"CODE_DES":null
                ,"EXCHANGE_RATE":"0.0000"
                ,"REF_DES":""
                ,"P_DES1":""
                ,"P_DES2":""
                ,"P_DES3":""
                ,"P_DES4":""
                ,"P_DES5":""
                ,"P_DES6":""
                ,"P_FLAG":"9"
                ,"IO_TYPE":"21"
                ,"SEND_FLAG":"0"
                ,"PROD_DES":"20190212"
                ,"EDMS_DATE":""
                ,"EDMS_NO":0
                ,"EDMS_APP_TYPE":null
                ,"IO_DATE":""
                ,"IO_NO":0
                ,"WRITER_ID":"승원"
                ,"WRITE_DT":"2019-07-29T17:07:46.567"
                ,"LOGID":"승원"
                ,"UPDATE_DATE":"2019-07-29 17:10:01.569"
                ,"UQTY":"0.0000000000"
                ,"QTY":"11.0000000000"
                ,"BUY_AMT":"0.0000"
                ,"VAT_AMT":"0.0000"
                ,"BUY_AMT_F":"0.0000"
                ,"TTL_CTT":"2019/07/29-2 20190212"
                ,"TIME_DATE":"20190729"
                },
                {
                "ORD_NO":1
                ,"ORD_DATE":"20190729"
                ,"WH_CD":"00001"
                ,"WH_DES":"test"
                ,"PJT_CD":"00001"
                ,"PJT_DES":"프로젝트A"
                ,"EMP_CD":"100"
                ,"CUST_NAME":"테스트"
                ,"CUST":"2312891"
                ,"CUST_DES":"bmt"
                ,"FOREIGN_FLAG":"0"
                ,"EXCHANGE_TYPE":""
                ,"CODE_DES":null
                ,"EXCHANGE_RATE":"0.0000"
                ,"REF_DES":""
                ,"P_DES1":""
                ,"P_DES2":""
                ,"P_DES3":""
                ,"P_DES4":""
                ,"P_DES5":""
                ,"P_DES6":""
                ,"P_FLAG":"0"
                ,"IO_TYPE":"21"
                ,"SEND_FLAG":"0"
                ,"PROD_DES":"test1"
                ,"EDMS_DATE":""
                ,"EDMS_NO":0
                ,"EDMS_APP_TYPE":null
                ,"IO_DATE":""
                ,"IO_NO":0
                ,"WRITER_ID":"승원"
                ,"WRITE_DT":"2019-07-29T17:06:55.063"
                ,"LOGID":"승원"
                ,"UPDATE_DATE":"2019-07-29 17:06:55.064"
                ,"UQTY":"0.0000000000"
                ,"QTY":"1.0000000000"
                ,"BUY_AMT":"0.0000"
                ,"VAT_AMT":"0.0000"
                ,"BUY_AMT_F":"0.0000"
                ,"TTL_CTT":"2019/07/29-1 test1"
                ,"TIME_DATE":"20190729"
                }
        ],
      "TotalCnt": 10,
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:25:55.585",
     "RequestKey": "",
     "IsEnableNoL4": false
}
[FAIL - Validation]
        
{
    "Data":null
    ,"Status":"500
    ,""Errors":[
                    {
                    "ProgramId":"
                    ,""Name":"
                    ,""Code":"EXP00001
                    ,""Message":"Search Range Is Less Than 31
                    ,""Param":null
                    }
                ]
    ,"Error":{
                "Code":0
                ,"Message":"Search Range Is Less Than 31"
                ,"MessageDetail":""
            }
    ,"Timestamp":null
    ,"RequestKey":null
    ,"IsEnableNoL4":false
    ,"RefreshTimestamp":"0"
    ,"AsyncActionKey":null
}
오류 종류별 설명
상세보기



========================================
## 구매입력 (idx=29)
========================================

# 구매입력API

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/Purchases/SavePurchases?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/Purchases/SavePurchases?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| PurchasesList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| UPLOAD_SER_NO | 순번 | SMALLINT(4,0) | Y |  | 순번* 입력내용- 동일한 전표로 묶고자 하는 경우 동일 순번을 부여합니다.- 입력된 순번 및 전표묶음기준 설정에 따라 한 장의 전표로 처리됩니다.* 입력글자제한- 최대 4자 |
| IO_DATE | 일자 | STRING(8) |  |  | 일자* 입력내용 - 거래가 발생한 일자를 입력합니다. - 입력하지 않을 경우, 입력화면설정의 기본우선순위에 따라 일자가 입력됩니다.* 입력글자제한 - YYYYMMDD |
| CUST | 거래처코드 | STRING(30) |  |  | 거래처코드* 입력내용 - 전표자료의 거래처코드를 입력합니다. - 거래처코드만 입력한 경우, 자동으로 거래처명이 입력됩니다. - 거래처명만 입력하는 경우, 일치하는 거래처가 있으면 자동으로 거래처코드가 입력됩니다.* 입력글자제한 - 기 등록된 거래처코드를 입력합니다. - 최대 30자 |
| CUST_DES | 거래처명 | STRING(100) |  |  | 거래처명* 입력내용 - 전표자료의 거래처명을 입력합니다. - 거래처코드만 입력한 경우, 자동으로 거래처명이 입력됩니다. - 거래처명만 입력하는 경우, 일치하는 거래처가 있으면 자동으로 거래처코드가 입력됩니다.* 입력글자제한 - 최대 100자 |
| EMP_CD | 담당자 | STRING(30) |  |  | 담당자* 입력내용 - 전표자료를 담당하는 담당자코드 또는 명을 입력합니다.* 입력글자제한 - 기 등록된 담당자코드를 입력합니다. - 최대 코드 30자 , 명 50자 |
| WH_CD | 입고창고 | STRING(5) |  |  | 창고코드* 입력내용 - 창고코드를 입력합니다. - 기 등록된 창고코드를 입력합니다.* 입력글자제한 - 최대 코드 5자 |
| IO_TYPE | 구분(거래유형) | STRING(2) |  |  | * 입력내용 - 거래전표의 거래유형코드를 입력합니다. - Self-Customizing > 환경설정 > 기능설정 > 공통탭 > 재고-부가세 설정 > 거래유형별 설정에 유형코드 참조 - 입력하지 않을 경우, 기본 거래유형으로 적용됩니다. |
| EXCHANGE_TYPE | 외화종류 | STRING(5) |  |  | 외화코드* 입력내용 - 외화 거래인 경우 외화코드 또는 명을 입력합니다. - 입력하지 않을 경우, 기본양식의 기본값이 적용됩니다.* 입력글자제한 - 기 등록된 외화코드를 입력합니다. |
| EXCHANGE_RATE | 환율 | NUMERIC(18,4) |  |  | 환율* 입력내용 - 외화코드를 입력한 경우 거래시점의 환율을 입력합니다.* 입력글자제한 - 정수 최대 14자리 - 소수 최대 4자리 |
| SITE | 부서 | STRING(100) |  |  | 부서코드 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1> 구매관리 > 구매입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PJT_CD | 프로젝트 | STRING(14) |  |  | 프로젝트* 입력내용 - 거래자료의 프로젝트코드 또는 명을 입력합니다.* 입력글자제한 - 기 등록된 프로젝트를 입력합니다. - 최대 코드 14자 , 명 50자 |
| DOC_NO | 구매No. | STRING(30) |  |  | 구매No.* 입력내용 - 구매전표의 구매No.를 입력합니다.* 입력글자제한 - 최대 30자 |
| TTL_CTT | 제목 | STRING(200) |  |  | 제목 재고 I > 구매 > 구매입력 > 옵션 > 입력화면설정 > 상단탭 > 제목 기본값 설정 > 직접입력인 경우에만 입력함. |
| U_MEMO1 | 문자형식1 | STRING(200) |  |  | 문자형식1* 입력내용- 특이사항 및 메모사항을 입력합니다.- 별도의 입력형식은 없으며, 텍스트 형태로 자유롭게 입력합니다.* 입력글자제한- 최대 200자 |
| U_MEMO2 | 문자형식2 | STRING(200) |  |  | 문자형식2* 입력내용- 특이사항 및 메모사항을 입력합니다.- 별도의 입력형식은 없으며, 텍스트 형태로 자유롭게 입력합니다.* 입력글자제한- 최대 200자 |
| U_MEMO3 | 문자형식3 | STRING(200) |  |  | 문자형식3* 입력내용- 특이사항 및 메모사항을 입력합니다.- 별도의 입력형식은 없으며, 텍스트 형태로 자유롭게 입력합니다.* 입력글자제한- 최대 200자 |
| U_MEMO4 | 문자형식4 | STRING(200) |  |  | 문자형식4* 입력내용- 특이사항 및 메모사항을 입력합니다.- 별도의 입력형식은 없으며, 텍스트 형태로 자유롭게 입력합니다.* 입력글자제한- 최대 200자 |
| U_MEMO5 | 문자형식5 | STRING(200) |  |  | 문자형식5* 입력내용- 특이사항 및 메모사항을 입력합니다.- 별도의 입력형식은 없으며, 텍스트 형태로 자유롭게 입력합니다.* 입력글자제한- 최대 200자 |
| U_TXT1 | 장문형식1 | STRING(2000) |  |  | 장문형식1* 입력내용- 특이사항 및 메모사항을 입력합니다.- 별도의 입력형식은 없으며, 텍스트 형태로 자유롭게 입력합니다.* 입력글자제한- 최대 2000자 |
| ORD_DATE | 발주일자 | STRING(20) |  |  | 발주일자* 입력내용 - 발주내역과 연동하는 경우 ERP의 발주 일자를 입력합니다.* 입력글자제한 - 기 등록된 발주전표의 일자를 입력합니다. - YYYYMMDD |
| ORD_NO | 발주번호 | SMALLINT(4,0) |  |  | 발주번호* 입력내용 - 발주내역과 연동하는 경우 ERP의 발주 일자 뒤의 번호를 입력합니다.* 입력글자제한 - 기 등록된 발주전표의 번호를 입력합니다. |
| PROD_CD | 품목코드 | STRING(20) | Y |  | 품목코드* 입력내용 - 전표에 등록할 품목코드를 입력합니다. - 바코드를 입력해도 품목정보를 인식할 수 있습니다. - 품목코드만 입력한 경우, 자동으로 품목명이 입력됩니다. - 품목명만 입력하는 경우, 일치하는 품목이 있으면 자동으로 품목코드가 입력됩니다.* 입력글자제한 - 기 등록된 픔목코드를 입력합니다. - 최대 20자 |
| PROD_DES | 품목명 | STRING(100) |  |  | 품목명* 입력내용 - 전표에 등록하는 품목의 명칭을 입력합니다. - 품목코드만 입력한 경우, 자동으로 품목명이 입력됩니다. - 품목명만 입력하는 경우, 일치하는 품목이 있으면 자동으로 품목코드가 입력됩니다.* 입력글자제한 - 최대 100자 |
| SIZE_DES | 규격 | STRING(100) |  |  | 규격* 입력내용 - 전표에 등록하는 품목의 규격을 입력합니다. * 입력글자제한 - 최대 100자 |
| QTY | 수량 | NUMERIC(28,10) | Y |  | 수량* 입력내용 - 품목의 입/출고수량을 입력합니다.* 입력글자제한 - 정수: 최대 12자리 - 소수: 최대 2자리 |
| UQTY | 추가수량 | NUMERIC(28,10) |  |  | 추가수량* 입력내용 - 품목의 입/출고 추가수량을 입력합니다.* 입력글자제한 - 정수 최대 12자리 - 소수 최대 6자리 |
| PRICE | 단가 | NUMERIC(18,6) |  |  | 단가* 입력내용 - 품목의 거래단가를 입력합니다. - 입력하지 않을 경우 0원 처리됩니다. * 입력글자제한 - 정수 최대 12자리 - 소수 최대 0자리 |
| USER_PRICE_VAT | 단가(vat포함) | NUMERIC(28,10) |  |  | 단가(vat포함)* 입력내용 - 품목의 거래단가(vat포함)를 입력합니다. - 입력하지 않을 경우 0원 처리됩니다. - 단가(vat포함)을 입력해도 공급가액과 부가세가 자동계산 되지는 않습니다.* 입력글자제한 - 정수 최대 12자리 - 소수 최대 4자리 |
| SUPPLY_AMT_F | 공급가액[외화] | NUMERIC(28,4) |  |  | 외화금액* 입력내용 - 외화거래인 경우 품목의 외화금액을 입력합니다. - 입력하지 않을 경우 0원 처리됩니다. - 수량, 단가, 환율을 입력해도 외화금액이 자동계산 되지는 않습니다.* 입력글자제한 - 정수 최대 15자리 - 소수 최대 4자리 |
| SUPPLY_AMT | 공급가액(원화) | NUMERIC(28,4) |  |  | 공급가액* 입력내용 - 품목의 공급가액을 입력합니다. - 입력하지 않을 경우 0원 처리됩니다. - 수량, 단가를 입력해도 공급가액이 자동계산 되지는 않습니다.* 입력글자제한 - 정수 최대 12자리 - 소수 최대 0자리 |
| VAT_AMT | 부가세 | NUMERIC(28,4) |  |  | 부가세* 입력내용 - 품목의 부가세액을 입력합니다. - 입력하지 않을 경우 0원 처리됩니다. - 공급가액을 입력해도 부가세액이 자동계산 되지는 않습니다.* 입력글자제한 - 정수 최대 12자리 - 소수 최대 0자리 |
| REMARKS | 적요 | STRING(200) |  |  | 적요* 입력내용 - 거래품목에 대한 특이사항 및 메모사항을 입력합니다. - 별도의 입력형식은 없으며, 텍스트 형태로 자유롭게 입력합니다.* 입력글자제한 - 최대 200자 |
| ITEM_CD | 관리항목 | STRING(14) |  |  | 관리항목* 입력내용 - 거래품목의 관리항목코드 또는 명을 입력합니다.* 입력글자제한 - 기 등록된 관리항목을 입력합니다. - 최대 코드 14자 , 명 60자 |
| P_AMT1 | 금액1 | NUMERIC(28,10) |  |  | 금액1* 입력내용 - 숫자 형태의 추가내용을 입력합니다.* 입력글자제한 - 정수 최대 15자리 - 소수 최대 6자리 |
| P_AMT2 | 금액2 | NUMERIC(28,10) |  |  | 금액2* 입력내용 - 숫자 형태의 추가내용을 입력합니다.* 입력글자제한 - 정수 최대 15자리 - 소수 최대 6자리 |
| P_REMARKS1 | 적요1 | STRING(100) |  |  | 적요1* 입력내용 - 추가 적요를 입력합니다.* 입력글자제한 - 최대 100자 |
| P_REMARKS2 | 적요2 | STRING(100) |  |  | 적요2* 입력내용 - 추가 적요를 입력합니다.* 입력글자제한 - 최대 100자 |
| P_REMARKS3 | 적요3 | STRING(100) |  |  | 적요3* 입력내용 - 추가 적요를 입력합니다.* 입력글자제한 - 최대 100자 |
| CUST_AMT | 부대비용 | NUMERIC(28,10) |  |  | 부대비용* 입력내용 - 거래품목에 추가적으로 발생한 비용을 입력합니다. (택배비, 인지대 등) - 거래 전체에 대해 비용이 발생한 경우, 품목별로 직접 안분하여 입력합니다.* 입력글자제한 - 정수 12자리 - 소수 0자리 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  | 반복부분 |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y |  |
| SlipNos | 구매번호 (ERP) | STRING(20) | Y | 구매번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
     "PurchasesList": [{
      "BulkDatas": {
       "ORD_DATE": "",
       "ORD_NO": "",
       "IO_DATE": "20191012",
       "UPLOAD_SER_NO": "",
       "CUST": "00001",
       "CUST_DES": "(주)OO산업",
       "EMP_CD": "",
       "WH_CD": "00001",
       "IO_TYPE": "",
       "EXCHANGE_TYPE": "",
       "EXCHANGE_RATE": "",
       "SITE": "",
       "PJT_CD": "",
       "DOC_NO":"",
       "U_MEMO1": "",
       "U_MEMO2": "",
       "U_MEMO3": "",
       "U_MEMO4": "",
       "U_MEMO5": "",
       "U_TXT1": "",
       "TTL_CTT": "",
       "PROD_CD": "00001",
       "PROD_DES": "test",
       "SIZE_DES": "",
       "UQTY": "",
       "QTY": "1",
       "PRICE": "",
       "USER_PRICE_VAT": "",
       "SUPPLY_AMT": "",
       "SUPPLY_AMT_F": "",
       "VAT_AMT": "",
       "REMARKS": "",
       "ITEM_CD": "",
       "P_AMT1": "",
       "P_AMT2": "",
       "P_REMARKS1": "",
       "P_REMARKS2": "",
       "P_REMARKS3": "",
       "CUST_AMT": ""
      }
     },{
      "BulkDatas": {
       "ORD_DATE": "",
       "ORD_NO": "",
       "IO_DATE": "20191012",
       "UPLOAD_SER_NO": "",
       "CUST": "00001",
       "CUST_DES": "(주)OO산업",
       "EMP_CD": "",
       "WH_CD": "00001",
       "IO_TYPE": "",
       "EXCHANGE_TYPE": "",
       "EXCHANGE_RATE": "",
       "PJT_CD": "",
       "DOC_NO":"",
       "U_MEMO1": "",
       "U_MEMO2": "",
       "U_MEMO3": "",
       "U_MEMO4": "",
       "U_MEMO5": "",
       "U_TXT1": "",
       "TTL_CTT": "",
       "PROD_CD": "00001",
       "PROD_DES": "test",
       "SIZE_DES": "",
       "UQTY": "",
       "QTY": "1",
       "PRICE": "",
       "USER_PRICE_VAT": "",
       "SUPPLY_AMT": "",
       "SUPPLY_AMT_F": "",
       "VAT_AMT": "",
       "REMARKS": "",
       "ITEM_CD": "",
       "P_AMT1": "",
       "P_AMT2": "",
       "P_REMARKS1": "",
       "P_REMARKS2": "",
       "P_REMARKS3": "",
       "CUST_AMT": ""
      }
     }]
}
Example Result
[SUCCESS]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 5/6000," 1일 허용량" : 12/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "SuccessCnt": 1,
      "FailCnt": 0,
      "ResultDetails": [{"IsSuccess": true,"TotalError": "[전표묶음1] OK","Errors": [],"Code": null}
                        {"IsSuccess": true,"TotalError": "[전표묶음1] OK","Errors": [],"Code": null}],
      "SlipNos": null
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:25:55.585",
     "RequestKey": "",
     "IsEnableNoL4": false
}
[FAIL - Validation]
        
{
 "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
      "SuccessCnt": 0,
      "FailCnt": 1,
      "ResultDetails": [{"IsSuccess": false,"TotalError": "[전표묶음1] 품목코드 (필수), 품목명 (필수), 수량 (필수)",
                        "Errors": [{"ColCd": "PROD_CD","Message": "품목코드 (필수)"},{"ColCd": "PROD_DES","Message": "품목명 (필수)"}],"Code": null},
                        {"IsSuccess": false,"TotalError": "[전표묶음1] 품목코드 (필수), 품목명 (필수), 수량 (필수)",
                        "Errors": [{"ColCd": "PROD_CD","Message": "품목코드 (필수)"},{"ColCd": "PROD_DES","Message": "품목명 (필수)"}],"Code": null}]
        "SlipNos": null
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:24:25.651",
     "RequestKey": "",
     "IsEnableNoL4": false
}
오류 종류별 설명
상세보기



========================================
## 작업지시서입력 (idx=31)
========================================

# 작업지시서 API

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/JobOrder/SaveJobOrder?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/JobOrder/SaveJobOrder?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| JobOrderList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| UPLOAD_SER_NO | 순번 | SMALLINT(4,0) | Y |  | 순번* 입력내용- 동일한 전표로 묶고자 하는 경우 동일 순번을 부여합니다.- 입력된 순번 및 전표묶음기준 설정에 따라 한 장의 전표로 처리됩니다.* 입력글자제한- 최대 4자 |
| IO_DATE | 일자 | STRING(8) |  |  | 작업지시서일자 미 입력시 현재일로 입력됨 |
| CUST | 납품처 코드 | STRING(30) |  |  | 작업지시 납품처코드(ERP거래처코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| CUST_DES | 납품처명 | STRING(100) |  |  | 작업지시 납품처명(ERP거래처명) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| EMP_CD | 담당자 | STRING(30) |  |  | 담당자코드(ERP 담당자코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PJT_CD | 프로젝트 | STRING(14) |  |  | 프로젝트코드 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| DOC_NO | 작업지시서 No. | STRING(30) |  |  | 작업지시서 No. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| TTL_CTT | 제목 | STRING(200) |  |  | 제목 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭 > 제목 기본값 설정 > 직접입력인 경우에만 입력함. |
| TIME_DATE | 납기일자 | STRING(8) |  |  | 납기일자 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO1 | 문자형식1 | STRING(200) |  |  | 재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO2 | 문자형식2 | STRING(200) |  |  | 재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO3 | 문자형식3 | STRING(200) |  |  | 재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO4 | 문자형식4 | STRING(200) |  |  | 재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO5 | 문자형식5 | STRING(200) |  |  | 재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_TXT1 | 장문형식1 | STRING(2000) |  |  | 재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PROD_CD | 품목코드 | STRING(20) | Y |  | 품목코드(ERP품목코드) |
| PROD_DES | 품목명 | STRING(100) |  |  | 품목명(ERP품목명)미 입력시 ERP품목코드에 해당하는 품목명이 입력됨 |
| SIZE_DES | 규격 | STRING(100) |  |  | 규격(ERP규격)미 입력시 ERP품목코드에 해당하는 규격이 입력됨 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| UQTY | 추가수량 | NUMERIC(28,10) |  |  | 추가수량 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| QTY | 수량 | NUMERIC(28,10) |  |  | 작업지시수량 |
| WH_CD | 창고코드 | STRING(5) |  |  | 작업지시 창고코드 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| REMARKS | 적요 | STRING(200) |  |  | 적요 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ITEM_CD | 관리항목 | STRING(14) |  |  | 관리항목코드 |
| P_AMT1 | 금액1 | NUMERIC(28,10) |  |  | 재고 > 작업지시서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_AMT2 | 금액2 | NUMERIC(28,10) |  |  | 재고 > 작업지시서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS1 | 적요1 | STRING(100) |  |  | 재고 > 작업지시서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS2 | 적요2 | STRING(100) |  |  | 재고 > 작업지시서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS3 | 적요3 | STRING(100) |  |  | 재고 > 작업지시서입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 작업지시서입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| PROD_BOM_DES | BOM버전 | STRING(100) |  |  | 생산품 BOM 버전생산품의 BOM 버전을 입력미입력 시 기본 BOM 버전이 입력됨 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  | 반복부분 |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y |  |
| SlipNos | 작업지시서번호(ERP) | STRING(20) | Y | 작업지시서번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
     "JobOrderList": [{
      "BulkDatas": {
       "IO_DATE": "20180612",
       "UPLOAD_SER_NO": "",
       "CUST": "",
       "CUST_DES": "",
       "PJT_CD": "",
       "EMP_CD": "",
       "TIME_DATE": "",
       "DOC_NO": "",
       "TTL_CTT": "",
       "U_MEMO1": "",
       "U_MEMO2": "",
       "U_MEMO3": "",
       "U_MEMO4": "",
       "U_MEMO5": "",
       "U_TXT1": "",
       "PROD_CD": "00001",
       "PROD_DES": "test",
       "SIZE_DES": "",
       "UQTY": "",
       "QTY": "1",
       "WH_CD": "",
       "REMARKS": "",
       "ITEM_CD": "",
       "P_AMT1": "",
       "P_AMT2": "",
       "P_REMARKS1": "",
       "P_REMARKS2": "",
       "P_REMARKS3": "",
       "PROD_BOM_DES": ""
      }
     },{
      "BulkDatas": {
       "IO_DATE": "20180612",
       "UPLOAD_SER_NO": "",
       "CUST": "",
       "CUST_DES": "",
       "PJT_CD": "",
       "EMP_CD": "",
       "TIME_DATE": "",
       "DOC_NO": "",
       "U_MEMO1": "",
       "U_MEMO2": "",
       "U_MEMO3": "",
       "U_MEMO4": "",
       "U_MEMO5": "",
       "U_TXT1": "",
       "PROD_CD": "00001",
       "PROD_DES": "test",
       "SIZE_DES": "",
       "UQTY": "",
       "QTY": "1",
       "WH_CD": "",
       "REMARKS": "",
       "ITEM_CD": "",
       "P_AMT1": "",
       "P_AMT2": "",
       "P_REMARKS1": "",
       "P_REMARKS2": "",
       "P_REMARKS3": "",
       "PROD_BOM_DES": ""
      }
     }]
}
Example Result
[SUCCESS]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "SuccessCnt": 2,
      "FailCnt": 0,
      "ResultDetails": [{"IsSuccess": true, "TotalError": "[전표묶음1] OK","Errors": [],"Code": null}
                        {"IsSuccess": true, "TotalError": "[전표묶음1] OK","Errors": [],"Code": null}]",
    ],
      "SlipNos": ["20180612-1"]
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:15:47.613",
     "RequestKey": "",
     "IsEnableNoL4": false
}
[FAIL - Validation]
        
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
      "SuccessCnt": 0,
      "FailCnt": 1,
      "ResultDetails": "[{"IsSuccess": false, "TotalError": "[전표묶음 1] 일자 (편집제한일자)","Errors": [{"ColCd": "IO_DATE", "Message": "일자 (편집제한일자)"}], "Code": null}, 
                         {"IsSuccess": false, "TotalError": "[전표묶음 2] 일자 (편집제한일자)","Errors": [{"ColCd": "IO_DATE", "Message": "일자 (편집제한일자)"}], "Code": null}]"
      "SlipNos": null
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:15:10.034",
     "RequestKey": "",
     "IsEnableNoL4": false
}
오류 종류별 설명
상세보기
returnBaseUrl("/OAPI/V2/JobOrder/SaveJobOrder?SESSION_ID={SESSION_ID}", true);



========================================
## 생산불출입력 (idx=32)
========================================

# 생산불출 API

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/GoodsIssued/SaveGoodsIssued?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/GoodsIssued/SaveGoodsIssued?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| GoodsIssuedList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| UPLOAD_SER_NO | 순번 | SMALLINT(4,0) | Y |  | 순번* 입력내용- 동일한 전표로 묶고자 하는 경우 동일 순번을 부여합니다.- 입력된 순번 및 전표묶음기준 설정에 따라 한 장의 전표로 처리됩니다.* 입력글자제한- 최대 4자 |
| IO_DATE | 일자 | STRING(8) |  |  | 생산불출 일자 미 입력시 현재일로 입력됨 |
| EMP_CD | 담당자 | STRING(30) |  |  | 담당자코드(ERP 담당자코드) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| WH_CD_F | 보내는창고 | STRING(5) | Y |  | 보내는창고(ERP 창고코드) |
| WH_CD_T | 받는공장 | STRING(5) | Y |  | 받는공장(ERP 창고코드) |
| PJT_CD | 프로젝트 | STRING(14) |  |  | 프로젝트코드 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| DOC_NO | 생산불출No. | STRING(30) |  |  | 생산불출 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| TTL_CTT | 제목 | STRING(200) |  |  | 제목 재고 I > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭 > 제목 기본값 설정 > 직접입력인 경우에만 입력함. |
| U_MEMO1 | 문자형식1 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO2 | 문자형식2 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO3 | 문자형식3 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO4 | 문자형식4 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO5 | 문자형식5 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_TXT1 | 장문형식1 | STRING(2000) |  |  | 재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PLAN_DATE | 작업지시서일자 | STRING(8) |  |  | 작지(일자-번호 품목) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| PLAN_NO | 작업지시서번호 | NUMERIC(5,0) |  |  | 재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. |
| PLAN_PROD | 작업지시품목 | STRING(20) |  |  | 작업지시품목코드 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| PROD_CD | 품목코드 | STRING(20) | Y |  | 품목코드(ERP품목코드) |
| PROD_DES | 품목명 | STRING(100) |  |  | 품목명(ERP품목명)미 입력시 ERP품목코드에 해당하는 품목명이 입력됨 |
| SIZE_DES | 규격 | STRING(100) |  |  | 규격(ERP규격)미 입력시 ERP품목코드에 해당하는 규격이 입력됨 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| UQTY | 추가수량 | NUMERIC(28,10) |  |  | 추가수량 사용할 경우만 입력(Self-Customizing > 환경설정 > 기능설정 > 재고탭 > 수량단위 설정 > 추가수량관리여부에 기본과추가수량사용 설정 한경우) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| QTY | 수량 | NUMERIC(28,10) | Y |  | 생산불출수량 추가수량 사용할 경우만 입력(Self-Customizing > 환경설정 > 기능설정 > 재고탭 > 수량단위 설정 > 추가수량관리여부에 기본과추가수량사용 설정 한경우) 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| REMARKS | 적요 | STRING(200) |  |  | 적요 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ITEM_CD | 관리항목 | STRING(14) |  |  | 관리항목코드 |
| P_AMT1 | 금액1 | NUMERIC(28,10) |  |  | 재고 > 생산불출입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_AMT2 | 금액2 | NUMERIC(28,10) |  |  | 재고 > 생산불출입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS1 | 적요1 | STRING(100) |  |  | 재고 > 생산불출입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요1 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS2 | 적요2 | STRING(100) |  |  | 재고 > 생산불출입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요2 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| P_REMARKS3 | 적요3 | STRING(100) |  |  | 재고 > 생산불출입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 필수항목설정 되어 있으면 반드시 입력해야 함.(재고1 > 생산/외주 > 생산불출입력 > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  | 반복부분 |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y |  |
| SlipNos | 생산불출번호(ERP) | STRING(20) | Y | 생산불출번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
     "GoodsIssuedList": [{
      "BulkDatas": {
       "IO_DATE": "20180612",
       "UPLOAD_SER_NO": "",
       "EMP_CD": "",
       "WH_CD_F": "00009",
       "WH_CD_T": "00022",
       "PJT_CD": "",
       "DOC_NO": "",
       "TTL_CTT": "",
       "U_MEMO1": "",
       "U_MEMO2": "",
       "U_MEMO3": "",
       "U_MEMO4": "",
       "U_MEMO5": "",
       "U_TXT1": "",
       "PLAN_DATE": "",
       "PLAN_NO": "",
       "PLAN_PROD": "",
       "PROD_CD": "00002",
       "PROD_DES": "테스트",
       "SIZE_DES": "",
       "UQTY": "",
       "QTY": "1",
       "REMARKS": "",
       "ITEM_CD": "",
       "P_AMT1": "",
       "P_AMT2": "",
       "P_REMARKS1": "",
       "P_REMARKS2": "",
       "P_REMARKS3": ""
      }
     },{
      "BulkDatas": {
       "IO_DATE": "20180612",
       "UPLOAD_SER_NO": "",
       "EMP_CD": "",
       "WH_CD_F": "00009",
       "WH_CD_T": "00022",
       "PJT_CD": "",
       "DOC_NO": "",
       "TTL_CTT": "",
       "U_MEMO1": "",
       "U_MEMO2": "",
       "U_MEMO3": "",
       "U_MEMO4": "",
       "U_MEMO5": "",
       "U_TXT1": "",
       "PLAN_DATE": "",
       "PLAN_NO": "",
       "PLAN_PROD": "",
       "PROD_CD": "00002",
       "PROD_DES": "테스트",
       "SIZE_DES": "",
       "UQTY": "",
       "QTY": "1",
       "REMARKS": "",
       "ITEM_CD": "",
       "P_AMT1": "",
       "P_AMT2": "",
       "P_REMARKS1": "",
       "P_REMARKS2": "",
       "P_REMARKS3": ""
      }
     }]
}
Example Result
[SUCCESS]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "SuccessCnt": 2,
      "FailCnt": 0,
      "ResultDetails": [{"IsSuccess": true,"TotalError": "[전표묶음1] OK","Errors": [],"Code": null}
                        {"IsSuccess": true,"TotalError": "[전표묶음1] OK","Errors": [],"Code": null}],
      "SlipNos": ["20180612-1"]
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:20:30.218",
     "RequestKey": "",
     "IsEnableNoL4": false
}
[FAIL - Validation]
        
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
      "SuccessCnt": 0,
      "FailCnt": 2,
      "ResultDetails": 
      [
      {"IsSuccess": false,"TotalError": "[전표묶음1] 보내는창고 (필수) , 받는공장 (필수), 품목코드 (필수), 품목명 (필수),수량 (필수), 보내는창고 (보내는창고와 받는공장이 같습니다.)",
       "Errors": [{"ColCd": "WH_CD_F","Message": "보내는창고 (필수)}, 
                  {"ColCd": "WH_CD_T","Message": "받는공장 (필수)"}, 
                  {"ColCd": "PROD_CD","Message": "품목코드 (필수)"}, 
                  {"ColCd": "PROD_DES","Message": "품목명 (필수)"},         
                  {"ColCd": "QTY","Message": "수량 (필수)"}, 
                  {"ColCd": "WH_CD_F","Message": "보내는창고 (보내는창고와 받는공장이 같습니다.)"}},
      {"IsSuccess": false,"TotalError": "[전표묶음1] 보내는창고 (필수) , 받는공장 (필수), 품목코드 (필수), 품목명 (필수),수량 (필수), 보내는창고 (보내는창고와 받는공장이 같습니다.)",
        "Errors": [{"ColCd": "WH_CD_F","Message": "보내는창고 (필수)}, 
                  {"ColCd": "WH_CD_T","Message": "받는공장 (필수)"}, 
                  {"ColCd": "PROD_CD","Message": "품목코드 (필수)"}, 
                  {"ColCd": "PROD_DES","Message": "품목명 (필수)"},         
                  {"ColCd": "QTY","Message": "수량 (필수)"}, 
                  {"ColCd": "WH_CD_F","Message": "보내는창고 (보내는창고와 받는공장이 같습니다.)"}
      ],"Code": null}],
      "SlipNos": null
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:17:38.181",
     "RequestKey": "",
     "IsEnableNoL4": false
}
오류 종류별 설명
상세보기



========================================
## 생산입고 (idx=33)
========================================

# 생산입고 I

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/GoodsReceipt/SaveGoodsReceipt?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/GoodsReceipt/SaveGoodsReceipt?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| GoodsReceiptList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| UPLOAD_SER_NO | 순번 | SMALLINT(4,0) | Y |  | 순번* 입력내용- 동일한 전표로 묶고자 하는 경우 동일 순번을 부여합니다.- 입력된 순번 및 전표묶음기준 설정에 따라 한 장의 전표로 처리됩니다.* 입력글자제한- 최대 4자 |
| IO_DATE | 일자 | STRING(8) |  |  | 생산입고Ⅰ일자 미 입력시 현재일로 입력됨 |
| EMP_CD | 담당자 | STRING(30) |  |  | 담당자코드(ERP 담당자코드) 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| SITE | 부서 | STRING(100) |  |  | 부서코드 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PJT_CD | 프로젝트 | STRING(14) |  |  | 프로젝트코드 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| WH_CD_F | 생산된공장 | STRING(14) |  |  | 생산된공장(ERP 창고코드) |
| WH_CD_T | 받는창고 | STRING(14) |  |  | 받는창고(ERP 창고코드) |
| DOC_NO | 생산입고No. | STRING(30) |  |  | 생산입고No. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| PLAN_DATE | 작지(일자-번호 품목) | STRING(30) |  |  | 작지(일자-번호 품목) 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| PLAN_NO | 작업지시서번호 | STRING(30) |  |  | 작업지시서번호 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. |
| PLAN_PROD | 작업지시품목코드 | STRING(30) |  |  | 작업지시품목코드 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| U_MEMO1 | 문자형식1 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO2 | 문자형식2 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO3 | 문자형식3 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO4 | 문자형식4 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_MEMO5 | 문자형식5 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_TXT_01_T ~ ADD_TXT_10_T | 추가문자형식1 ~ 추가문자형식10 | STRING(200) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_NUM_01_T ~ ADD_NUM_05_T | 추가숫자형식1 ~ 추가숫자형식5 | NUMERIC(28,10) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_CD_01_T ~ ADD_CD_03_T | 추가코드형식1 ~ 추가코드형식3 | STRING(100) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_DATE_01_T ~ ADD_DATE_03_T | 추가일자형식1 ~ 추가일자형식3 | STRING(8) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| U_TXT1 | 장문형식1 | STRING(2000) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| ADD_LTXT_01_T ~ ADD_LTXT_03_T | 추가장문형식1 ~ 추가장문형식3 | STRING(2000) |  |  | 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 상단탭에서 설정 가능) |
| TTL_CTT | 제목 | STRING(200) |  |  | 제목 재고 I > 생산/외주 > 생산입고 I > 옵션 > 입력화면설정 > 상단탭 > 제목 기본값 설정 > 직접입력인 경우에만 입력함. |
| PROD_CD | 품목코드 | STRING(20) | Y |  | 품목코드(ERP품목코드) |
| PROD_DES | 품목명 | STRING(100) |  |  | 품목명(ERP품목명)미 입력시 ERP품목코드에 해당하는 품목명이 입력됨 |
| SIZE_DES | 규격 | STRING(100) |  |  | 규격(ERP규격)미 입력시 ERP품목코드에 해당하는 규격이 입력됨 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| BOM_NO | BOM버전 | STRING(100) |  |  | 생산품의 BOM버전을 입력합니다.미 입력시 기본 BOM버전으로 적용됩니다. |
| QTY | 수량 | NUMERIC(28,10) |  |  | 작업지시수량 |
| UQTY | 추가수량 | NUMERIC(28,10) |  |  | 추가수량 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| PRICE | 단가 | NUMERIC(28,10) |  |  | 판매단가 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| USER_PRICE_VAT | 단가(vat포함) | NUMERIC(28,10) |  |  | VAT포함 단가 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| SUPPLY_AMT | 공급가액(원화) | NUMERIC(28,4) |  |  | 공급가액(원화) 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| SUPPLY_AMT_F | 공급가액[외화] | NUMERIC(28,4) |  |  | 외자인경우 외화금액 입력 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| VAT_AMT | 부가세 | NUMERIC(28,4) |  |  | 부가세 필수항목설정 되어 있으면 반드시 입력해야 함. (재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭에서 설정 가능) |
| ITEM_CD | 관리항목 | STRING(14) |  |  | 관리항목코드 |
| OTH_NUM | 노무시간 | STRING(200) |  |  | 숫자형태의 시간을 입력합니다.* 입력글자제한- 정수 최대 8자리- 소수 최대 4자리 |
| REMARKS | 적요 | STRING(200) |  |  | 적요 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| P_AMT1 | 금액1 | NUMERIC(28,10) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액1 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| P_AMT2 | 금액2 | NUMERIC(28,10) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 금액2 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| P_REMARKS1 | 적요1 | STRING(100) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요1 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| P_REMARKS2 | 적요2 | STRING(100) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요2 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| P_REMARKS3 | 적요3 | STRING(100) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| ADD_TXT_01 ~ ADD_TXT_06 | 추가문자형식1 ~ 추가문자형식6 | STRING(200) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| ADD_NUM_01 ~ ADD_NUM_05 | 추가숫자형식1 ~ 추가숫자형식5 | NUMERIC(28,10) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| ADD_CD_01 ~ ADD_CD_03 | 추가코드형식코드1 ~ 추가코드형식코드3 | STRING(100) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| ADD_CD_NM_01 ~ ADD_CD_NM_03 | 추가코드형식명1 ~ 추가코드형식명3 | STRING(100) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |
| ADD_DATE_01 ~ ADD_DATE_03 | 추가일자형식1 ~ 추가일자형식3 | STRING(8) |  |  | 재고 > 생산입고 I 입력화면 > 옵션 > 입력화면설정 > 하단탭 > 적요3 사용인 경우에 입력 재고1 > 생산/외주 > 생산입고Ⅰ > 옵션 > 입력화면설정 > 하단탭 > 항목설정한 경우에 입력함. |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  | 반복부분 |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y |  |
| SlipNos | 작업지시서번호(ERP) | STRING(20) | Y | 작업지시서번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
  "GoodsReceiptList": [
    {
      "BulkDatas": {
        "IO_DATE": "20210627",
        "UPLOAD_SER_NO": "1",
        "EMP_CD": "94830",
        "WH_CD_F": "00002",
        "WH_CD_T": "100",
        "U_MEMO1": "3",
        "U_MEMO2": "4",
        "U_MEMO3": "5",
        "U_MEMO4": "6",
        "U_MEMO5": "7",
        "U_TXT1": "8",
        "SITE": "",
        "PJT_CD": "00001",
        "DOC_NO": "세트0",
        "PLAN_DATE": "",
        "PLAN_NO": "",
        "PLAN_PROD": "",
        "TTL_CTT": "",
        "PROD_CD": "01249",
        "PROD_DES": "세트0",
        "SIZE_DES": "1",
        "PROD_BOM_DES": "",
        "UQTY": "",
        "QTY": "1",
        "PRICE": "3000",
        "SUPPLY_AMT": "3000",
        "VAT_AMT": "30",
        "OTH_NUM": "1",
        "REMARKS": "",
        "P_REMARKS1": "",
        "P_REMARKS2": "",
        "P_REMARKS3": "",
        "P_AMT1": "",
        "P_AMT2": "",
        "SERIAL_IDX": "",
        "checkSuccess": ""
      }
    }
  ]
}
Example Result
[SUCCESS]
{
  "Data": {
    "EXPIRE_DATE": "",    
    "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 2/30000," 1일 허용량" : 3/100000",
    "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
    "SuccessCnt": 2,
    "FailCnt": 0,
    "ResultDetails": [  {"IsSuccess": true, "TotalError": "[전표묶음0] OK", "Errors": null, "Code": null},
                        {"IsSuccess": true, "TotalError": "[전표묶음1] OK", "Errors": null, "Code": null} ],
    "SlipNos": [ "20210627-3", "20210627-4"]
  },
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2021-06-28 11:04:51.842",
  "RequestKey": null,
  "IsEnableNoL4": true,
  "RefreshTimestamp": "0",
  "AsyncActionKey": null
}
[FAIL - Validation]
{
  "Data": {
    "EXPIRE_DATE": "",
    "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 2/30," 1시간 허용량" : 8/30000," 1일 허용량" : 9/100000",
    "SuccessCnt": 0,
    "FailCnt": 2,
    "ResultDetails": [  {"IsSuccess": false, "TotalError": "[전표묶음0] 담당자(미등록코드[7777])", "Errors": null, "Code": null},
                        {"IsSuccess": false, "TotalError": "[전표묶음1] 생산된공장(미등록코드[987654]), 생산된공장(공장(외주비관리))", "Errors": null, "Code": null}],
    "SlipNos": []
  },
  "Status": "200",
  "Errors": null,
  "Error": null,
  "Timestamp": "2021-06-28 11:09:50.360",
  "RequestKey": null,
  "IsEnableNoL4": true,
  "RefreshTimestamp": "0",
  "AsyncActionKey": null
}
오류 종류별 설명
상세보기



========================================
## 재고현황_단건 (idx=35)
========================================

# 재고현황API

개요
외부 서비스와 연계를 통해서 ERP의 재고현황을 조회할 수 있습니다.
요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatus?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatus?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| BASE_DATE | 검색 일시 | STRING(8) | Y |  | 입력내용- 조회하기 원하는 날짜를 입력합니다.입력글자제한- YYYYMMDD |
| WH_CD | 창고코드 | STRING(8000) |  |  | 입력내용 - 조회하기 원하는 창고 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| PROD_CD | 품목코드 | TEXT | Y |  | 입력내용 - 조회하기 원하는 품목 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| ZERO_FLAG | 재고수량0포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| BAL_FLAG | 수량관리제외품목포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| DEL_GUBUN | 사용중단품목포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| SAFE_FLAG | 안전재고설정미만표시 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |
| TotalCnt | 성공건수 | INT | Y | 조회에 성공한 창고별 품목 수 (사용중단/삭제창고포함) |
| Result |  |  |  |  |
| PROD_CD | 품목코드 | STRING(20) | Y | 품목코드 |
| BAL_QTY | 재고수량 | INT | Y | 재고수량 |

Example Parameter

{"PROD_CD":"00001","WH_CD":"","BASE_DATE":"20190606"}
Example Result
[SUCCESS]
{
     "Data": {
      "IsSuccess":true,
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 8/6000," 1일 허용량" : 8/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "TotalCnt": 1,
      "Result":[
                    {
                    "PROD_CD":"00001",
                    "BAL_QTY":"-1.0000000000"
                    }
                ]
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2019-10-10 13:25:55.585",
     "RequestKey": "",
     "IsEnableNoL4": false
}
[FAIL - Validation]
        
{
    "Data":null,
    "Status":"500",
    "Errors":[
        {
        "ProgramId":"",
        "Name":"",
        "Code":"EXP00001",
        "Message":"Check Parameter [BASE_DATE]",
        "Param":null
        }
    ],
    "Error":{
            "Code":0,
            "Message":"Check Parameter [BASE_DATE]",
            "MessageDetail":""
            },
    "Timestamp":null,
    "RequestKey":null,
    "IsEnableNoL4":false,
    "RefreshTimestamp":"0",
    "AsyncActionKey":null
}
오류 종류별 설명
상세보기



========================================
## 재고현황 (idx=36)
========================================

# 재고현황API

개요
외부 서비스와 연계를 통해서 ERP의 재고현황을 조회할 수 있습니다.
요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatus?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatus?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| BASE_DATE | 검색 일시 | STRING(8) | Y |  | 입력내용- 조회하기 원하는 날짜를 입력합니다.입력글자제한- YYYYMMDD |
| WH_CD | 창고코드 | STRING(8000) |  |  | 입력내용 - 조회하기 원하는 창고 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| PROD_CD | 품목코드 | TEXT |  |  | 입력내용 - 조회하기 원하는 품목 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| ZERO_FLAG | 재고수량0포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| BAL_FLAG | 수량관리제외품목포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| DEL_GUBUN | 사용중단품목포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| SAFE_FLAG | 안전재고설정미만표시 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |
| TotalCnt | 성공건수 | Int | Y | 조회에 성공한 창고별 품목 수 (사용중단/삭제창고포함) |
| Result |  |  |  |  |
| PROD_CD | 품목코드 | STRING(20) | Y | 품목코드 |
| BAL_QTY | 재고수량 | INT | Y | 재고수량 |

Example Parameter

{"PROD_CD":"","WH_CD":"","BASE_DATE":"20190606"}
Example Result
[SUCCESS]
{
     "Data": {
      "IsSuccess":true,
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 8/6000," 1일 허용량" : 8/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "TotalCnt": 1,
      "Result":[
                    {
                    "PROD_CD":"00001",
                    "BAL_QTY":"-1.0000000000"
                    }
                ]
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2019-10-10 13:25:55.585",
     "RequestKey": "",
     "IsEnableNoL4": false
}
[FAIL - Validation]
        
{
    "Data":null,
    "Status":"500",
    "Errors":[
        {
        "ProgramId":"",
        "Name":"",
        "Code":"EXP00001",
        "Message":"Check Parameter [BASE_DATE]",
        "Param":null
        }
    ],
    "Error":{
            "Code":0,
            "Message":"Check Parameter [BASE_DATE]",
            "MessageDetail":""
            },
    "Timestamp":null,
    "RequestKey":null,
    "IsEnableNoL4":false,
    "RefreshTimestamp":"0",
    "AsyncActionKey":null
}
오류 종류별 설명
상세보기



========================================
## 창고별재고현황_단건 (idx=37)
========================================

# 창고별재고현황(단건)

개요
외부 서비스와 연계를 통해서 ERP의 재고현황을 조회할 수 있습니다.
요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatusByLocation?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/InventoryBalance/ViewInventoryBalanceStatusByLocation?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| BASE_DATE | 검색 일시 | STRING(8) | Y |  | 입력내용- 조회하기 원하는 날짜를 입력합니다.입력글자제한- YYYYMMDD |
| PROD_CD | 품목코드 | STRING(2000) | Y |  | 입력내용 - 조회하기 원하는 품목 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| WH_CD | 창고코드 | STRING(700) |  |  | 입력내용 - 조회하기 원하는 창고 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| BAL_FLAG | 수량관리제외품목포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| DEL_GUBUN | 사용중단품목포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| DEL_LOCATION_YN | 사용중단/삭제창고포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |
| TotalCnt | 성공건수 | Int | Y | 조회에 성공한 창고별 품목 수 |
| Result |  |  |  |  |
| WH_CD | 창고코드 | STRING(20) | Y | 창고코드 |
| WH_DES | 창고명 | STRING(100) | Y | 창고명 |
| PROD_CD | 품목코드 | STRING(20) | Y | 품목코드 |
| PROD_DES | 품목명 | STRING(100) | Y | 품목명 |
| PROD_SIZE_DES | 품목명[규격] | STRING(100) | Y | 품목명[규격] |
| BAL_QTY | 재고수량 | INT | Y | 재고수량 |

Example Parameter

{"PROD_CD": "00001", "WH_CD": "", "BASE_DATE": "20210629"}
Example Result
[SUCCESS]
{
     "Data": {
      "IsSuccess":true,
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 8/6000," 1일 허용량" : 8/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "TotalCnt": 3,
      "Result":[{"WH_CD": "00035", "WH_DES": "123", "PROD_CD": "00016", "PROD_DES": "new", "PROD_SIZE_DES": "new", "BAL_QTY": "3.0000000000"}, 
                {"WH_CD": "00033", "WH_DES": "22323", "PROD_CD": "00016", "PROD_DES": "new", "PROD_SIZE_DES": "new", "BAL_QTY": "1.0000000000"}, 
                {"WH_CD": "00014", "WH_DES": "창고14", "PROD_CD": "00016", "PROD_DES": "new", "PROD_SIZE_DES": "new", "BAL_QTY": "-1.0000000000"}]
      },
      "Status": "200",
      "Errors": null,
      "Error": null,
      "Timestamp": "2021-07-02 14:40:52.247",
      "RequestKey": null,
      "IsEnableNoL4": true,
      "RefreshTimestamp": "0",
      "AsyncActionKey": null
}
[FAIL - Validation]
        
{
    "Data":null,
    "Status":"500",
    "Errors":[
        {
        "ProgramId":"",
        "Name":"",
        "Code":"EXP00001",
        "Message":"Check Parameter [BASE_DATE]",
        "Param":null
        }
    ],
    "Error":{
            "Code":0,
            "Message":"Check Parameter [BASE_DATE]",
            "MessageDetail":""
            },
    "Timestamp":null,
    "RequestKey":null,
    "IsEnableNoL4":false,
    "RefreshTimestamp":"0",
    "AsyncActionKey":null
}
오류 종류별 설명
상세보기



========================================
## 창고별재고현황 (idx=38)
========================================

# 창고별재고현황

개요
외부 서비스와 연계를 통해서 ERP의 재고현황을 조회할 수 있습니다.
요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/InventoryBalance/GetListInventoryBalanceStatusByLocation?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| BASE_DATE | 검색 일시 | STRING(8) | Y |  | 입력내용- 조회하기 원하는 날짜를 입력합니다.입력글자제한- YYYYMMDD |
| WH_CD | 창고코드 | STRING(700) |  |  | 입력내용 - 조회하기 원하는 창고 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| PROD_CD | 품목코드 | STRING(2000) |  |  | 입력내용 - 조회하기 원하는 품목 코드를 입력합니다.입력글자제한 - 기 등록된 품목코드를 입력합니다. - 최대 20자 |
| BAL_FLAG | 수량관리제외품목포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| DEL_GUBUN | 사용중단품목포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |
| DEL_LOCATION_YN | 사용중단/삭제창고포함 | CHAR(1) |  |  | 기본값 'N'입력값 'Y', 'N' |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |
| TotalCnt | 성공건수 | Int | Y | 조회에 성공한 창고별 품목 수 |
| Result |  |  |  |  |
| WH_CD | 창고코드 | STRING(20) | Y | 창고코드 |
| WH_DES | 창고명 | STRING(100) | Y | 창고명 |
| PROD_CD | 품목코드 | STRING(20) | Y | 품목코드 |
| PROD_DES | 품목명 | STRING(100) | Y | 품목명 |
| PROD_SIZE_DES | 품목명[규격] | STRING(100) | Y | 품목명[규격] |
| BAL_QTY | 재고수량 | INT | Y | 재고수량 |

Example Parameter

{"PROD_CD": "", "WH_CD": "", "BASE_DATE": "20210629"}
Example Result
[SUCCESS]
{
     "Data": {
      "IsSuccess":true,
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 8/6000," 1일 허용량" : 8/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",  
      "TotalCnt": 3,
      "Result":[{"WH_CD": "00035", "WH_DES": "123", "PROD_CD": "00016", "PROD_DES": "new", "PROD_SIZE_DES": "new", "BAL_QTY": "3.0000000000"}, 
                {"WH_CD": "00033", "WH_DES": "22323", "PROD_CD": "00016", "PROD_DES": "new", "PROD_SIZE_DES": "new", "BAL_QTY": "1.0000000000"}, 
                {"WH_CD": "00014", "WH_DES": "창고14", "PROD_CD": "00016", "PROD_DES": "new", "PROD_SIZE_DES": "new", "BAL_QTY": "-1.0000000000"}]
      },
      "Status": "200",
      "Errors": null,
      "Error": null,
      "Timestamp": "2021-07-02 14:40:52.247",
      "RequestKey": null,
      "IsEnableNoL4": true,
      "RefreshTimestamp": "0",
      "AsyncActionKey": null
}
[FAIL - Validation]
        
{
    "Data":null,
    "Status":"500",
    "Errors":[
        {
        "ProgramId":"",
        "Name":"",
        "Code":"EXP00001",
        "Message":"Check Parameter [BASE_DATE]",
        "Param":null
        }
    ],
    "Error":{
            "Code":0,
            "Message":"Check Parameter [BASE_DATE]",
            "MessageDetail":""
            },
    "Timestamp":null,
    "RequestKey":null,
    "IsEnableNoL4":false,
    "RefreshTimestamp":"0",
    "AsyncActionKey":null
}
오류 종류별 설명
상세보기



========================================
## 매출_매입전표_자동분개 (idx=40)
========================================

# 매출·매입전표 II 자동분개

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/InvoiceAuto/SaveInvoiceAuto?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/InvoiceAuto/SaveInvoiceAuto?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| InvoiceAutoList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| TRX_DATE | 일자 | STRING(8) |  |  | 전표일자 미 입력시 현재일로 입력됨 |
| ACCT_DOC_NO | 회계전표No. | STRING(30) |  |  | 회계관리번호Self-Customizing > 환경설정 > 기능설정 > 공통탭 > 관리No. 설정 > 회계No. 사용이며 생성기준이 직접입력인 경우에 입력함. |
| TAX_GUBUN | 매출/매입구분 | STRING(2) | Y |  | 매출: Self-Customizing > 환경설정 > 기능설정 > 공통탭 > 회계-부가세 설정 > 부가세유형(매출)에 있는 코드를 입력.매입:Self-Customizing > 환경설정 > 기능설정 > 공통탭 > 회계-부가세 설정 > 부가세유형(매입)에 있는 코드를 입력. |
| S_NO | 지급구분 | STRING(20) |  |  | 신용카드 또는 승인번호 입력. |
| CUST | 거래처 | STRING(30) |  |  | 거래처 |
| CUST_DES | 거래처명 | STRING(50) |  |  | 거래처명 |
| CR_CODE | 매출계정코드 | STRING(8) | Y |  | 매출: 매출계정코드 입력 예) 4019(상품매출) |
| DR_CODE | 매입계정코드 | STRING(8) | Y |  | 매입: 매입계정코드 입력 예) 1469(상품) |
| SUPPLY_AMT | 공급가액 | NUMERIC(16,0) |  |  | 공급가액 |
| VAT_AMT | 부가세 | NUMERIC(16,0) |  |  | 부가세 |
| ACCT_NO | 수금구분 | STRING(30) |  |  | (매입전표II) 돈들어온계좌번호 / (매출전표II) 돈나간계좌번호의 코드 또는 명을 입력. |
| REMARKS | 적요 | STRING(200) |  |  | 적요 |
| SITE_CD | 부서코드 | STRING(14) |  |  | 부서코드 |
| PJT_CD | 프로젝트 | STRING(14) |  |  | 프로젝트 |
| ITEM1_CD | 추가항목1 | STRING(10) |  |  | 추가항목1(코드형)회계1 > FastEntry > 일반전표 > 옵션 > 입력화면설정에서 설정한 경우 입력함.필수항목체크하면 반드시 입력해야 함.회계1 > 기초등록 > 추가항목등록의 추가항목1 탭에 등록된 코드를 입력함. |
| ITEM2_CD | 추가항목2 | STRING(10) |  |  | 추가항목2(코드형)회계1 > FastEntry > 일반전표 > 옵션 > 입력화면설정에서 설정한 경우 입력함.필수항목체크하면 반드시 입력해야 함.회계1 > 기초등록 > 추가항목등록의 추가항목2 탭에 등록된 코드를 입력함. |
| ITEM3_CD | 추가항목3 | STRING(10) |  |  | 추가항목3(코드형)회계1 > FastEntry > 일반전표 > 옵션 > 입력화면설정에서 설정한 경우 입력함.필수항목체크하면 반드시 입력해야 함.회계1 > 기초등록 > 추가항목등록의 추가항목3 탭에 등록된 코드를 입력함. |
| ITEM4 | 추가항목4 | STRING(100) |  |  | 추가항목4(문자형)회계1 > FastEntry > 일반전표 > 옵션 > 입력화면설정에서 설정한 경우 입력함.필수항목체크하면 반드시 입력해야 함. |
| ITEM5 | 추가항목5 | STRING(100) |  |  | 추가항목5(문자형)회계1 > FastEntry > 일반전표 > 옵션 > 입력화면설정에서 설정한 경우 입력함.필수항목체크하면 반드시 입력해야 함. |
| ITEM6 | 추가항목6 | NUMERIC(16,0) |  |  | 추가항목6(숫자형)회계1 > FastEntry > 일반전표 > 옵션 > 입력화면설정에서 설정한 경우 입력함.필수항목체크하면 반드시 입력해야 함. |
| ITEM7 | 추가항목7 | NUMERIC(16,0) |  |  | 추가항목7(숫자형)회계1 > FastEntry > 일반전표 > 옵션 > 입력화면설정에서 설정한 경우 입력함.필수항목체크하면 반드시 입력해야 함. |
| ITEM8 | 추가항목8 | STRING(8) |  |  | 추가항목8(일자형)회계1 > FastEntry > 일반전표 > 옵션 > 입력화면설정에서 설정한 경우 입력함.미 입력시 현재일자로 입력됨.필수항목체크하면 반드시 입력해야 함. |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y | 반복부분 |
| SlipNos | 전표번호(ERP) | STRING(20) | Y | 전표번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

매출전표 II Example Parameter1

{
	"InvoiceAutoList": [{
		"BulkDatas": {
			"TRX_DATE": "20181113",
			"ACCT_DOC_NO":"",			
			"TAX_GUBUN": "11",
			"S_NO":"",
			"CUST": "0017",
			"CUST_DES": "",
			"SUPPLY_AMT": "50000",
			"VAT_AMT": "5000",
			"ACCT_NO": "",
			"CR_CODE": "4019",
			"DR_CODE": "",
			"REMARKS_CD": "",
			"REMARKS": "",
			"SITE_CD": "",
			"PJT_CD": "",
			"ITEM1_CD": "",
			"ITEM2_CD": "",
			"ITEM3_CD": "",
			"ITEM4": "",
			"ITEM5": "",
			"ITEM6": "",
			"ITEM7": "",
			"ITEM8": ""
		}
	}]
}
매입전표 II Example Parameter2
{
	"InvoiceAutoList": [{
		"BulkDatas": {
			"TRX_DATE": "20181113",
			"ACCT_DOC_NO":"",			
			"TAX_GUBUN": "21",
			"S_NO":"",
			"CUST": "0017",
			"CUST_DES": "",
			"SUPPLY_AMT": "50000",
			"VAT_AMT": "5000",
			"ACCT_NO": "",
			"CR_CODE": "",
			"DR_CODE": "1469",
			"REMARKS_CD": "",
			"REMARKS": "",
			"SITE_CD": "",
			"PJT_CD": "",
			"ITEM1_CD": "",
			"ITEM2_CD": "",
			"ITEM3_CD": "",
			"ITEM4": "",
			"ITEM5": "",
			"ITEM6": "",
			"ITEM7": "",
			"ITEM8": ""
		}
	}]
}
Example Result
[SUCCESS]
{
    "Data":[
    {
        "EXPIRE_DATE":"",
        "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 10/6000," 1일 허용량" : 12/10000",
        "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
        "SuccessCnt": 2,
        "FailCnt": 0,
        "ResultDetails": "[{"IsSuccess": true, "TotalError": "OK", "Errors": [], "Code": null}, {"IsSuccess": true, "TotalError": "OK", "Errors": [], "Code": null}]",
        "SlipNos": "["20181113-1", "20181113-2"]"
    }],
    "Status":"200",
    "Error":null,
    "Timestamp":"2018-11-12 15:00:49.352"
}
[FAIL - Validation]
{
    "Data":[
    {
        "EXPIRE_DATE":"",
        "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 10/6000," 1일 허용량" : 12/10000",
        "SuccessCnt": 0,
        "FailCnt": 2,
        "ResultDetails":"[{"IsSuccess": false, "TotalError": "거래처", "Errors": [{"ColCd": "CUST", "Message": 거래처}], "Code": null}, { "IsSuccess": false, "TotalError": 거래처, "Errors": [{"ColCd": "CUST", "Message": 거래처}], "Code": null}]",    
        "SlipNos": "[]"
    }],
    "Status":"200",
    "Error":null,
    "Timestamp":"2018년 6월 11일 오후 4:00:00"
}
오류 종류별 설명
상세보기



========================================
## 쇼핑몰_주문API (idx=42)
========================================

# 주문API(쇼핑몰관리)

개요
외부 서비스와 연계를 통해서 ERP의 주문(쇼핑몰관리)을 입력할 수 있습니다.
요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/OpenMarket/SaveOpenMarketOrderNew?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/OpenMarket/SaveOpenMarketOrderNew?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| OPENMARKET_CD | 쇼핑몰코드 | STRING(5) | Y | 쇼핑몰코드 |
| [ORDERS] | 오픈마켓 신규 주문 |  |  | OPENMARKET_CD, GROUP_NO, ORDER_NO 중복 체크 |
| GROUP_NO | 묶음주문번호 | STRING(500) | Y | 묶음주문번호 |
| ORDER_NO | 주문번호 | STRING(500) | Y | 주문번호 |
| ORDER_DATE | 주문일자 | DATETIME | Y | 주문일자 |
| PAY_DATE | 결제일자 | DATETIME | Y | 결제일자 |
| PROD_CD | 쇼핑몰상품코드 | STRING(100) | Y | 쇼핑몰상품코드 |
| PROD_NM | 쇼핑몰상품명 | STRING(500) | Y | 쇼핑몰상품명 |
| PROD_OPT | 주문옵션 | STRING(500) | Y | 주문옵션 |
| ORDER_QTY | 수량 | NUMERIC(28, 10) | Y | 수량 |
| ORDER_AMT | 주문금액 | NUMERIC(28, 4) | Y | 주문금액 |
| ORDERER | 주문자 | STRING(500) | Y | 주문자 |
| ORDERER_TEL | 주문자연락처 | STRING(500) | Y | 주문자연락처 |
| RECEIVER | 수취인 | STRING(500) | Y | 수취인 |
| RECEIVER_TEL | 수취인연락처1 | STRING(500) | Y | 수취인연락처1 |
| RECEIVER_TEL2 | 수취인연락처2 | STRING(500) |  | 수취인연락처2 |
| ZIP_CODE | 우편번호 | STRING(500) |  | 우편번호 |
| ADDR | 주소 | STRING(1000) | Y | 주소 |
| DELIVERY_REQUEST | 배송요청사항 | STRING(4000) |  | 배송요청사항 |
| SHIPPING_CHARGE_TYPE | 배송비(선불/후불) | STRING(1) |  | 배송비(선불/후불) - P:선불, A:착불 |
| SHIPPING_CHARGE | 배송비금액 | NUMERIC(28, 4) |  | 배송비금액 |
| MEMO | 메모 | STRING(500) |  | 메모 |
| SHOP_NM | 쇼핑몰명 | STRING(400) | Y | 쇼핑몰명 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  |  |
|  | ECOUNT 주문번호 |  |  | 반복부분 |
| OPENMARKET_CD | 쇼핑몰코드 | STRING(5) | Y | 쇼핑몰코드 |
| SLIP_NO | ECOUNT 주문번호 | BIGINT | Y | ECOUNT 주문번호 |
| SLIP_SER | ECOUNT 순번 | INT | Y | ECOUNT 순번 |
| GROUP_NO | 묶음주문번호 | STRING(500) | Y | 묶음주문번호 |
| ORDER_NO | 주문번호 | STRING(500) | Y | 주문번호 |
| Result | 결과 메시지 | STRING(500) | Y | 결과 메시지 |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
        "OPENMARKET_CD": "00001",
        "ORDERS": [{
            "GROUP_NO": "1212121222342343",
            "ORDER_NO": "12122323223423423",
            "ORDER_DATE": "2018-05-25 13:06:29.000",
            "PAY_DATE": "2018-05-25 13:06:29.000",
            "PROD_CD": "1372431020",
            "PROD_NM": "TEST 상품",
            "PROD_OPT": "색상:빨간색,사이즈:A1",
            "ORDER_QTY": 10,
            "ORDER_AMT": 100000,
            "ORDERER": "TEST",
            "ORDERER_TEL": "010-0000-0000",
            "RECEIVER": "TEST",
            "RECEIVER_TEL": "010-0000-0000",
            "RECEIVER_TEL2": "010-0000-0000",
            "ZIP_CODE": "",
            "ADDR": "서울특별시 구로구 디지털로26길 61 (구로동) 에이스하이엔드타워",
            "DELIVERY_REQUEST": "빠른 배송 해주세요.",
            "SHIPPING_CHARGE_TYPE": "P",
            "SHIPPING_CHARGE": "2500",
            "MEMO": "",
            "SHOP_NM": "이카운트쇼핑몰"
        },
        {
            "GROUP_NO": "1212121222343332343",
            "ORDER_NO": "12122323224443423423",
            "ORDER_DATE": "2018-05-25 13:06:29.000",
            "PAY_DATE": "2018-05-25 13:06:29.000",
            "PROD_CD": "1372431020",
            "PROD_NM": "TEST 상품",
            "PROD_OPT": "색상:빨간색,사이즈:A1",
            "ORDER_QTY": 10,
            "ORDER_AMT": 100000,
            "ORDERER": "TEST",
            "ORDERER_TEL": "010-0000-0000",
            "RECEIVER": "TEST",
            "RECEIVER_TEL": "010-0000-0000",
            "RECEIVER_TEL2": "010-0000-0000",
            "ZIP_CODE": "",
            "ADDR": "서울특별시 구로구 디지털로26길 61 (구로동) 에이스하이엔드타워",
            "DELIVERY_REQUEST": "빠른 배송 해주세요.",
            "SHIPPING_CHARGE_TYPE": "P",
            "SHIPPING_CHARGE": "2500",
            "MEMO": "",
            "SHOP_NM": "이카운트쇼핑몰"
        }]
}
Example Result
[SUCCESS]
{

    "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 2/6000," 1일 허용량" : 6/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "ResultDetails": [{
       "OPENMARKET_CD":"1",
        "SLIP_NO":"123456",
        "SLIP_SER":"1",
        "GROUP_NO":"12356966",
        "ORDER_NO":"2018052822222",
        "Result": ""
      }]
     },
    "Status":"200",
    "Error":null,
    "Timestamp":"2018년 6월 11일 오후 4:31:00"
}
[FAIL - Validation]
{
    "Data":
    {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 6/6000," 1일 허용량" : 11/10000",
      "ResultDetails": [{
        "OPENMARKET_CD":"1",
        "SLIP_NO":"123456",
        "SLIP_SER":"1",
        "GROUP_NO":"12356966",
        "ORDER_NO":"2018052822222",
        "Result": "중복 주문"
        }],
     },
    "Status":"200",
    "Error":null,
    "Timestamp":"2018년 6월 11일 오후 4:25:47"
}
오류 종류별 설명
상세보기



========================================
## 출퇴근기록부 (idx=44)
========================================

# 근태관리 API

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/OAPI/V2/TimeMgmt/SaveClockInOut?SESSION_ID={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/OAPI/V2/TimeMgmt/SaveClockInOut?SESSION_ID={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| ClockInOutList |  |  |  |  |  |
| [BulkDatas] | 주문서 전표별 정보 |  |  |  | 반복부분 |
| ATTDC_DTM_I | 출근일시 | STRING(30) | Y |  | 출근일시* 입력내용- 형식: {0}* 입력글자제한- 최대 30자 |
| ATTDC_DTM_O | 퇴근일시 | STRING(30) | Y |  | 퇴근일시* 입력내용- 형식: {0}* 입력글자제한- 최대 30자 |
| ATTDC_PLACE_I | 출근장소 | STRING(100) |  |  | 출근장소* 입력내용- 출근장소를 입력바랍니다.* 입력글자제한- 최대 100자 |
| ATTDC_PLACE_O | 퇴근장소 | STRING(100) |  |  | 퇴근장소* 입력내용- 퇴근장소를 입력바랍니다.* 입력글자제한- 최대 100자 |
| ATTDC_RSN_I | LBL18163 | STRING(400) |  |  | 출근사유* 입력내용- 출근사유를 입력바랍니다.* 입력글자제한- 최대 400자 |
| ATTDC_RSN_O | LBL18164 | STRING(400) |  |  | 퇴근사유* 입력내용- 퇴근사유를 입력바랍니다.* 입력글자제한- 최대 400자 |
| EMP_CD | 사원번호 | STRING(50) | Y |  | 사원* 입력내용- 사원코드 또는 명을 입력합니다.* 입력글자제한- 기 등록된 사원코드를 입력합니다.- 최대 코드 14자 , 명 50자 |
| HDOFF_TYPE_CD_I | 출근시오전반차여부 | STRING(1) | Y |  | 출근시오전반차여부* 입력내용- 오전반차아님 : N, 오전반차 : Y* 입력글자제한- 최대 1자 |
| HDOFF_TYPE_CD_O | 퇴근시오후반차여부 | STRING(1) | Y |  | 퇴근시오후반차여부* 입력내용- 오후반차아님 : N, 오후반차 : Y* 입력글자제한- 최대 1자 |
| OUT_WORK_TF | 출근시외근구분 | STRING(1) | Y |  | 출근시외근구분* 입력내용- 내근 : N, 외근 : Y* 입력글자제한- 최대 1자 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| MessageDetail | 오류상세정보 |  |  |  |
| Data |  |  |  | 반복부분 |
| SuccessCnt | 성공건수 | STRING(20) | Y |  |
| FailCnt | 실패건수 | STRING(20) | Y |  |
| ResultDetails | 처리결과 | STRING(4000) | Y |  |
| SlipNos | 구매번호 (ERP) | STRING(20) | Y | 구매번호(실패시 공백) |
| EXPIRE_DATE | EXPIRE_DATE |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| QUANTITY_INFO | 허용수량 |  | Y | 1시간, 1일 동안 전송할 수 있는 허용 수량 |
| TRACE_ID | 로그확인용 일련번호 |  | Y | 오류발생시 로그 확인을 위한 일련번호 |

Example Parameter

{
            "ClockInOutList": [{
              "BulkDatas": {
                 "ATTDC_DTM_I" : "2025-02-12 08:25:47",
                 "ATTDC_DTM_O" : "2025-02-12 18:17:48",
                 "ATTDC_PLACE_I" : "", 
                 "ATTDC_PLACE_O" : "", 
                 "ATTDC_RSN_I" : "", 
                 "ATTDC_RSN_O" : "", 
                 "EMP_CD" : "00001", 
                 "HDOFF_TYPE_CD_I" : "N", 
                 "HDOFF_TYPE_CD_O" : "N", 
                 "OUT_WORK_TF" : "N"
              }
           },
           {
              "BulkDatas": {
                 "ATTDC_DTM_I" : "2025-02-12 08:25:47",
                 "ATTDC_DTM_O" : "2025-02-12 18:17:48",
                 "ATTDC_PLACE_I" : "", 
                 "ATTDC_PLACE_O" : "", 
                 "ATTDC_RSN_I" : "", 
                 "ATTDC_RSN_O" : "", 
                 "EMP_CD" : "00001", 
                 "HDOFF_TYPE_CD_I" : "N", 
                 "HDOFF_TYPE_CD_O" : "N", 
                 "OUT_WORK_TF" : "N"
              }
           }]
        }
Example Result
[SUCCESS]
{
     "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 0/30," 1시간 허용량" : 5/6000," 1일 허용량" : 12/10000",
      "TRACE_ID":"db6138411aad40e42dc5e209f65f6f3c",
      "SuccessCnt": 1,
      "FailCnt": 0,
      "ResultDetails": [{"IsSuccess": true,"TotalError": "[전표묶음1] OK","Errors": [],"Code": null}
                        {"IsSuccess": true,"TotalError": "[전표묶음1] OK","Errors": [],"Code": null}],
      "SlipNos": null
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:25:55.585",
     "RequestKey": "",
     "IsEnableNoL4": false
}
[FAIL - Validation]
        
{
 "Data": {
      "EXPIRE_DATE":"",
      "QUANTITY_INFO": 시간당 연속 오류 제한 건수" : 1/30," 1시간 허용량" : 3/6000," 1일 허용량" : 3/10000",
      "SuccessCnt": 0,
      "FailCnt": 1,
      "ResultDetails": [{"IsSuccess": false,"TotalError": "[전표묶음1] 품목코드 (필수), 품목명 (필수), 수량 (필수)",
                        "Errors": [{"ColCd": "PROD_CD","Message": "품목코드 (필수)"},{"ColCd": "PROD_DES","Message": "품목명 (필수)"}],"Code": null},
                        {"IsSuccess": false,"TotalError": "[전표묶음1] 품목코드 (필수), 품목명 (필수), 수량 (필수)",
                        "Errors": [{"ColCd": "PROD_CD","Message": "품목코드 (필수)"},{"ColCd": "PROD_DES","Message": "품목명 (필수)"}],"Code": null}]
        "SlipNos": null
     },
     "Status": "200",
     "Error": null,
     "Timestamp": "2018-06-12 13:24:25.651",
     "RequestKey": "",
     "IsEnableNoL4": false
}
오류 종류별 설명
상세보기



========================================
## 게시판입력 (idx=46)
========================================

# 게시판

개요

요청 데이터 형식
| 항목 | 설명 |
| 호출방식 | POST |
| Content-Type | application/json |
| Test URL | https://sboapi{ZONE}.ecount.com/ec5/api/app.oapi.v3/action/CreateOApiBoardAction?session_Id={SESSION_ID} |
| Request URL | https://oapi{ZONE}.ecount.com/ec5/api/app.oapi.v3/action/CreateOApiBoardAction?session_Id={SESSION_ID} |
| 자료포맷 종류 | JSON(Paramenter, Result) |

자료포맷 종류
| 변수 | 변수명 | 자릿수 | 이카운트필수 | 양식필수 | 설명 |
| SESSION_ID | 세션ID | STRING(50) | Y |  | 로그인 API 호출 후 받은 SESSION_ID(세션ID) |
| data |  |  |  |  | 반복부분 |
| master | 게시글 상단 |  |  |  |  |
| bizz_sid | 게시판 ID | STRING(15) | Y |  | 게시판ID확인 |
| title | 제목 | STRING(200) |  |  | 제목* 입력내용- 제목을 입력합니다.* 입력글자제한- 최대 200자 |
| body_ctt | 내용 | TEXT(5MB) |  |  | 내용1*입력내용- 내용1을 입력합니다.*입력글자제한- 텍스트 형식으로만 입력 가능합니다.- 최대 5MB |
| progress_status | 진행상태 | STRING(100) |  |  | 진행상태* 입력내용- 코드 또는 명을 입력합니다.- 입력하지 않을 경우, 항목설정의 확인시기본값에 따라 진행상태가 입력됩니다.* 입력글자제한- 기 등록된 진행상태코드를 입력합니다. - 최대 20자(코드), 최대 100자(명) |
| label | 라벨 | STRING(20) |  |  | 라벨*입력내용- 코드 또는 명을 입력합니다.*입력글자제한- 하나의 라벨만 입력 가능합니다.- 최대 5자(코드), 최대 20자(명) |
| cust | 거래처코드 | STRING(30) |  |  | 거래처코드* 입력내용- 코드 또는 명을 입력합니다.- 코드만 입력한 경우 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.*입력글자제한- 최대 30자(코드), 최대 100자(명) |
| cust_nm | 거래처명 | STRING(100) |  |  | 거래처명* 입력내용- 명을 입력합니다.- 코드만 입력한 경우, 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.* 입력글자제한- 최대 100자 |
| prod | 품목코드 | STRING(20) |  |  | 품목코드*입력내용- 코드 또는 명을 입력합니다.- 코드만 입력한 경우 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.- 바코드를 입력해도 인식할 수 있습니다.*입력글자제한- 최대 20자(코드), 최대 100자(명) |
| prod_nm | 품목명 | STRING(100) |  |  | 품목명*입력내용- 명을 입력합니다.- 코드만 입력한 경우, 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.*입력글자제한- 최대 100자 |
| dept | 부서코드 | STRING(14) |  |  | 부서코드* 입력내용- 코드 또는 명을 입력합니다.- 코드만 입력한 경우 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.*입력글자제한- 최대 14자(코드), 최대 50자(명) |
| dept_nm | 부서명 | STRING(50) |  |  | 부서명* 입력내용- 명을 입력합니다.- 코드만 입력한 경우, 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.*입력글자제한- 최대 50자 |
| pjt | 프로젝트코드 | STRING(14) |  |  | 프로젝트코드* 입력내용- 코드 또는 명을 입력합니다.- 코드만 입력한 경우 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.*입력글자제한- 최대 14자(코드), 최대 50자(명) |
| pjt_nm | 프로젝트명 | STRING(50) |  |  | 프로젝트명* 입력내용- 명을 입력합니다.- 코드만 입력한 경우, 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.*입력글자제한- 최대 50자 |
| pic | 담당자코드 | STRING(30) |  |  | 담당자코드* 입력내용- 코드 또는 명을 입력합니다.- 코드만 입력한 경우 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.*입력글자제한- 최대 30자(코드), 최대 50자(명) |
| pic_nm | 담당자명 | STRING(50) |  |  | 담당자명* 입력내용- 명을 입력합니다.- 코드만 입력한 경우, 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.* 입력글자제한- 최대 50자 |
| complt_dtm | 완료일시 | STRING(14) |  |  | 완료일시* 입력내용- 완료일시를 입력합니다.- 입력하지 않을 경우, [저장시값변경] 설정이 적용됩니다.* 입력글자제한- YYYYMMDD HH:MM- S/C>환경설정>기본값설정>입력기본값설정>날짜형식에 설정된 연월일순서로 입력 가능합니다. |
| record_range_dtm | 날짜/시간 | STRING(20) |  |  | 날짜/시간* 입력내용- 날짜/시간을 입력합니다.- 입력하지 않을 경우, [저장시값변경]설정이 적용됩니다.* 입력글자제한- YYYYMMDD HH:MM HH:MM- S/C>환경설정>기본값설정>입력기본값설정>날짜형식에 설정된 연월일순서로 입력 가능합니다. |
| txt_001 ~ txt_020 | 문자형식1 ~ 문자형식20 | STRING(200) |  |  | 문자형식* 입력내용- 부가정보를 입력합니다.* 입력글자제한- 최대 200자 |
| num_001 ~ num_020 | 숫자형식1 ~ 숫자형식20 | NUMERIC(15,2) |  |  | 숫자형식* 입력내용- 부가정보를 입력합니다.* 입력글자제한- 정수: 최대 15자리- 소수: 최대 3자리 |
| tf_001 ~ tf_020 | Y/N1 ~ Y/N20 | STRING(1) |  |  | Y/N형식*입력내용- Y 또는 N으로 입력합니다.*입력글자제한- 최대 1자 |
| date_001 ~ date_020 | 일자형식1 ~ 일자형식20 | STRING(8) |  |  | 일자형식*입력내용- 일자를 입력합니다.*입력글자제한- YYYYMMDD |
| cd_001 ~ cd_020 | 코드형식1코드 ~ 코드형식20코드 | STRING(100) |  |  | 코드형식코드* 입력내용- 명을 입력합니다.- 코드만 입력한 경우, 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.* 입력글자제한- 최대 20자(코드), 최대 100자(명) |
| cd_nm_001 ~ cd_nm_020 | 코드형식1명 ~ 코드형식20명 | STRING(100) |  |  | 코드형식명* 입력내용- 명을 입력합니다.- 코드만 입력한 경우, 자동으로 명이 입력됩니다.- 명만 입력한 경우, 일치하는 코드가 있으면 자동으로 입력됩니다.* 입력글자제한- 최대 100자 |
| cryp_001 | 보안형 | STRING(50) |  |  | 보안형* 입력내용- 암호화가 필요한 정보를 입력합니다.* 입력글자제한- 최대 50자 |

Result
| 변수 | 변수명 | 자릿수 | 필수여부 | 설명 |
| Status | 처리결과 |  | Y | 200(정상) |
| expire_date | 인증키유효기간 |  | Y | 주어진 날짜의 이카운트 API 현재버전서비스가 종료됩니다. |
| Error | 오류 |  |  | 오류가 발생할 경우 |
| Code | 오류코드 |  |  |  |
| Message | 오류내용 |  |  |  |
| data |  |  |  | 반복부분 |
| seq | 순번 | STRING(20) | Y |  |
| result | 일자-번호 | STRING(20) | Y |  |
| error | 오류상세정보 | STRING(4000) |  |  |

Example Parameter

{
	"data": [
		{
			"master": {
				"bizz_sid": "B_000000E072000",
				"title": "title test",
				"body_ctt": "body test",
				"progress_status": "1",
				"label": "",
				"cust": "",
				"cust_nm": "",
				"prod": "",
				"prod_nm": "",
				"dept": "",
				"dept_nm": "",
				"pjt": "",
				"pjt_nm": "",
				"pic": "",
				"pic_nm": "",
				"complt_dtm": "20250807 12:34",
				"record_range_dtm": "20250807 12:34 23:45",
				"txt_001": "",
				"num_001": "",
				"tf_001": "",
				"dt_001": "",
				"cd_001": "",
				"cd_nm_001": "",
				"cryp_001": ""
			}
		}
	]
}
Example Result
[SUCCESS]
{
  "Status": 200,
  "EnableNoL4": false,
  "RefreshTimestamp": "638911012541279301:1",
  "UtcOffeset": -540,
  "data": [{"seq": 0, "result": "20250819-9"}],
  "expire_date": "20250902",
  "time_stamp": "2025-08-19 16:24:14",
  "trace_id": "CreateOApiBoardAction::T_1755588254708"
}
[FAIL - Validation]
{
  "Status": "500",
  "EnableNoL4": false,
  "RefreshTimestamp": "638911012541279301:1",
  "UtcOffeset": -540,
  "data": [{"seq": 0, "result": "", "error": [{"target": "num_001", "code": "", "message": "숫자형식 1(필수)"}, {"target": "txt_001", "code": "", "message": "문자형식 1(필수)"}]}],
  "expire_date": "20250902",
  "time_stamp": "2025-08-19 16:09:44",
  "trace_id": "CreateOApiBoardAction::T_1755587384311",
  "Error": {
    "Code": "EXP0001",
    "Message": "숫자형식 1(필수)"
  }
}
오류 종류별 설명
상세보기
