/**
 * lib/vendor-resolver.js — 사업자번호 → 정식 거래처명 매핑
 *
 * OCR이 거래처명 잘못 읽어도 사업자번호로 정확히 정정.
 * (DSD 리테일 → DSD 리바트로 잘못 읽혀도 사업자번호 135-19-50642 → DSD리테일 정정)
 *
 * 데이터: data/vendor-biz-no.json
 */

const fs = require('fs');
const path = require('path');

const BIZ_NO_FILE = path.join(__dirname, '..', 'data', 'vendor-biz-no.json');

let _cache = null;
let _cacheTs = 0;
const CACHE_TTL = 30000; // 30초

function loadMap() {
  const now = Date.now();
  if (_cache && now - _cacheTs < CACHE_TTL) return _cache;
  try {
    const data = JSON.parse(fs.readFileSync(BIZ_NO_FILE, 'utf8'));
    _cache = {};
    for (const [bizNo, info] of Object.entries(data)) {
      if (bizNo.startsWith('_')) continue;
      if (info && info.canonical) _cache[bizNo] = info;
    }
    _cacheTs = now;
  } catch (e) {
    _cache = {};
    _cacheTs = now;
  }
  return _cache;
}

/**
 * 사업자번호로 정식 거래처명 조회
 * @returns { name, source, isBuyer, bizNo }
 */
function resolveByBizNo(bizNo, fallbackName) {
  if (!bizNo) return { name: fallbackName || '', source: 'no-biz-no' };
  const map = loadMap();
  const normBizNo = String(bizNo).replace(/[^\d-]/g, '');
  if (map[normBizNo]) {
    return {
      name: map[normBizNo].canonical,
      source: 'biz-no-exact',
      isBuyer: !!map[normBizNo].is_buyer,
      bizNo: normBizNo,
    };
  }
  return { name: fallbackName || '', source: 'biz-no-unknown', bizNo: normBizNo };
}

/**
 * 별칭(alias) 으로 정식명 조회 (사업자번호 없을 때 fallback)
 */
function resolveByName(vendorName) {
  if (!vendorName) return null;
  const map = loadMap();
  const norm = String(vendorName).replace(/\s/g, '').toLowerCase();
  for (const [bizNo, info] of Object.entries(map)) {
    if (info.is_buyer) continue; // 우리 회사 제외
    for (const alias of (info.aliases || [])) {
      if (norm === String(alias).replace(/\s/g, '').toLowerCase()) {
        return { name: info.canonical, source: 'alias-match', bizNo };
      }
    }
  }
  return null;
}

/**
 * 새 사업자번호 자동 학습 — OCR 결과 누적
 */
function learnBizNo(bizNo, vendorName) {
  if (!bizNo || !vendorName) return false;
  const normBizNo = String(bizNo).replace(/[^\d-]/g, '');
  if (!/^\d{3}-\d{2}-\d{5}$/.test(normBizNo)) return false;

  let raw;
  try { raw = JSON.parse(fs.readFileSync(BIZ_NO_FILE, 'utf8')); }
  catch (e) { return false; }

  if (raw[normBizNo]) {
    // 이미 등록됨 — 별칭에만 추가
    if (!raw[normBizNo].aliases) raw[normBizNo].aliases = [];
    if (!raw[normBizNo].aliases.includes(vendorName)) {
      raw[normBizNo].aliases.push(vendorName);
      try { fs.writeFileSync(BIZ_NO_FILE, JSON.stringify(raw, null, 2)); } catch (e) {}
      _cache = null; // 캐시 무효화
    }
    return false;
  }

  // 새 사업자번호 — 자동 등록
  raw[normBizNo] = {
    canonical: vendorName,
    aliases: [vendorName],
    auto_learned: true,
    learned_at: new Date().toISOString(),
  };
  try { fs.writeFileSync(BIZ_NO_FILE, JSON.stringify(raw, null, 2)); } catch (e) { return false; }
  _cache = null;
  return true;
}

/**
 * OCR 결과 vendor 객체를 정정
 * 입력: { biz_no, name }
 * 출력: { biz_no, name (정정된), source, isBuyer }
 */
function correctVendor(ocrVendor) {
  if (!ocrVendor) return { biz_no: '', name: '', source: 'empty' };
  const bizNo = ocrVendor.biz_no || ocrVendor.bizNo || '';
  const name = ocrVendor.name || '';

  // 1순위: 사업자번호 매칭
  const byBizNo = resolveByBizNo(bizNo, name);
  if (byBizNo.source === 'biz-no-exact') {
    return { biz_no: byBizNo.bizNo, name: byBizNo.name, source: 'biz-no-exact', isBuyer: byBizNo.isBuyer };
  }

  // 2순위: 별칭 매칭 (사업자번호 인식 실패 시)
  const byAlias = resolveByName(name);
  if (byAlias) {
    return { biz_no: byAlias.bizNo, name: byAlias.name, source: 'alias-match', isBuyer: false };
  }

  // 3순위: 자동 학습 (사업자번호는 있지만 매핑 없음)
  if (bizNo && /^\d{3}-\d{2}-\d{5}$/.test(String(bizNo).replace(/[^\d-]/g, ''))) {
    learnBizNo(bizNo, name);
    return { biz_no: bizNo, name, source: 'auto-learned' };
  }

  // 4순위: OCR 그대로
  return { biz_no: bizNo, name, source: 'ocr-raw' };
}

module.exports = {
  resolveByBizNo,
  resolveByName,
  correctVendor,
  learnBizNo,
};
