/**
 * lib/ecount-client.js — 이카운트 OpenAPI 클라이언트
 *
 * .env 필수 키:
 *   ECOUNT_COMPANY_CODE  - 회사코드
 *   ECOUNT_USER_ID       - 로그인ID
 *   ECOUNT_API_CERT_KEY  - API 인증키
 *   ECOUNT_ZONE          - 존 코드 (예: Z01)
 *   ECOUNT_LAN_TYPE      - 언어 (ko-KR)
 *
 * 안전장치:
 *   - dryRun 옵션: 실제 호출 없이 양식 JSON 만 반환
 *   - 세션 캐시: 1시간 (토큰은 일정시간 후 만료)
 *
 * 기본 엔드포인트 (이카운트 표준):
 *   POST /OAPI/V2/OAPILogin/GetEncryptedSessionID  → 세션 발급
 *   POST /OAPI/V2/Sale/SaveSale                    → 매출(판매) 등록
 *   POST /OAPI/V2/Purchase/SavePurchases           → 매입(구매) 등록
 *
 * NOTE: 이카운트 API 매뉴얼 정확한 스펙 따라 필드명/엔드포인트 미세조정 필요.
 *       처음 호출 시 사장님과 함께 응답 보면서 검증.
 */
require('dotenv').config();

const COMPANY_CODE = process.env.ECOUNT_COMPANY_CODE;
const USER_ID      = process.env.ECOUNT_USER_ID;
const API_CERT_KEY = process.env.ECOUNT_API_CERT_KEY;
const ZONE         = process.env.ECOUNT_ZONE || 'Z01';
const LAN_TYPE     = process.env.ECOUNT_LAN_TYPE || 'ko-KR';

const HOST = `https://oapi${ZONE.toLowerCase().replace(/[^0-9a-z]/g,'')}.ecount.com`;

let sessionId = null;
let sessionExpiresAt = 0;

function isConfigured() {
  return !!(COMPANY_CODE && USER_ID && API_CERT_KEY && ZONE);
}

async function login(force = false) {
  if (!isConfigured()) throw new Error('이카운트 API 키 미설정 (.env)');
  if (!force && sessionId && Date.now() < sessionExpiresAt) return sessionId;

  const url = `${HOST}/OAPI/V2/OAPILogin/GetEncryptedSessionID`;
  const body = {
    COM_CODE: COMPANY_CODE,
    USER_ID: USER_ID,
    API_CERT_KEY: API_CERT_KEY,
    LAN_TYPE,
    ZONE,
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  // 응답 구조: { Status, Data: { Datas: { SESSION_ID }, ExpireDate, ... }, Errors }
  const sid = json?.Data?.Datas?.SESSION_ID;
  if (!sid) {
    const err = json?.Errors?.[0]?.Message || JSON.stringify(json);
    throw new Error('이카운트 로그인 실패: ' + err);
  }
  sessionId = sid;
  sessionExpiresAt = Date.now() + 50 * 60 * 1000; // 50분 캐시 (안전 마진)
  return sessionId;
}

async function callApi(endpoint, body, opts = {}) {
  if (!isConfigured()) throw new Error('이카운트 API 키 미설정 (.env)');
  if (opts.dryRun) {
    return { ok: true, dryRun: true, endpoint, body, message: 'dryRun 모드 - 실제 호출 안함' };
  }
  const sid = await login();
  const url = `${HOST}${endpoint}?SESSION_ID=${encodeURIComponent(sid)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  if (json?.Status !== '200' && json?.Errors?.length) {
    return { ok: false, error: json.Errors[0]?.Message || 'API 오류', raw: json };
  }
  return { ok: true, raw: json };
}

// ─── 매출 등록 ───
// item 형식: { date, vendor_code, item_code, item_name, spec, qty, price, supply, vat, note }
async function saveSale(items, opts = {}) {
  const SaleList = items.map((it, i) => ({
    Line: i + 1,
    BulkDatas: {
      IO_DATE: (it.date || '').replace(/-/g, ''),       // YYYYMMDD
      CUST: it.vendor_code || '',                       // 거래처 코드
      WH_CD: it.warehouse_code || '100',                // 창고 (기본 100=본사창고)
      PROD_CD: it.item_code || '',                      // 품목 코드
      PROD_DES: it.item_name || '',                     // 품목명 (코드 없을 때)
      SIZE_DES: it.spec || '',                          // 규격
      QTY: it.qty || 0,                                 // 수량
      PRICE: it.price || 0,                             // 단가
      SUPPLY_AMT: it.supply || (it.qty * it.price),     // 공급가액
      VAT_AMT: it.vat || Math.round((it.supply || it.qty*it.price) * 0.1),
      REMARKS: it.note || '',                           // 적요
      U_MEMO1: it.project || '',                        // 프로젝트명
    },
  }));
  return callApi('/OAPI/V2/Sale/SaveSale', { SaleList }, opts);
}

// ─── 매입 등록 ───
async function savePurchase(items, opts = {}) {
  const PurchasesList = items.map((it, i) => ({
    Line: i + 1,
    BulkDatas: {
      IO_DATE: (it.date || '').replace(/-/g, ''),
      CUST: it.vendor_code || '',
      WH_CD: it.warehouse_code || '100',
      PROD_CD: it.item_code || '',
      PROD_DES: it.item_name || '',
      SIZE_DES: it.spec || '',
      QTY: it.qty || 0,
      PRICE: it.price || 0,
      SUPPLY_AMT: it.supply || (it.qty * it.price),
      VAT_AMT: it.vat || Math.round((it.supply || it.qty*it.price) * 0.1),
      REMARKS: it.note || '',
    },
  }));
  return callApi('/OAPI/V2/Purchase/SavePurchases', { PurchasesList }, opts);
}

// ─── 거래처 마스터 조회 ───
async function listCustomers(opts = {}) {
  return callApi('/OAPI/V2/CustomerBasic/GetBasicCustomersList', {
    SEARCH_DATA: { CUST_LEVEL: '', BUSINESS_NO: '', CUST_NAME: '' },
  }, opts);
}

// ─── 품목 마스터 조회 ───
async function listProducts(opts = {}) {
  return callApi('/OAPI/V2/InventoryBasic/GetBasicProductsList', {
    SEARCH_DATA: { PROD_CD: '', PROD_DES: '' },
  }, opts);
}

module.exports = {
  isConfigured,
  login,
  saveSale,
  savePurchase,
  listCustomers,
  listProducts,
};
