// ═══════════════════════════════════════════════
// 매입명세서 자동 매칭 엔진
// 매입명세서 OCR 결과 → 우리 ERP 품목코드 매핑
// ═══════════════════════════════════════════════
//
// 핵심 알고리즘:
// 1. 정규화 — 매입명세서 노이즈 제거 (인쇄 사양/위치/회사명 등)
// 2. 거래처 식별 — 사업자번호 우선, 회사명 fuzzy fallback
// 3. 후보 풀 — 그 거래처의 매입 이력에서 추출 (좁은 풀)
// 4. fuzzy 매칭 — 정규화 후 텍스트 유사도
// 5. 학습 매핑 — 사용자 컨펌 시 ecount_mapping 누적
// 6. 운송비 단축 — 정규식으로 항상 택배비 매핑

const path = require('path');

// ─── 정규화 함수 ───────────────────────────────────
// 매입명세서의 노이즈를 제거하고 핵심 키워드만 남김
// 사장님 피드백: "우리 ERP는 인쇄 사양 표시 안 함"
function normalize(text) {
  if (!text) return '';
  let s = String(text);

  // 1. [별도] / [운송비] 등 옵션/마커 제거
  s = s.replace(/\[[^\]]*\]/g, '');

  // 2. 우리 회사명 표기 — 매입명세서엔 들어가지만 우리 ERP엔 안 들어감
  s = s.replace(/\(대림에스엠\)|\(대림컴퍼니\)|대림에스엠|대림컴퍼니/g, '');

  // 3. 인쇄 위치/도안 디테일 — 우리 ERP는 사양 표시 안 함
  const noiseWords = [
    '오른쪽', '왼쪽', '우측', '좌측',
    '윗부분', '아랫부분', '윗쪽', '아래쪽',
    '등 하단', '등하단', '등 상단', '등상단',
    '좌측가슴', '우측가슴', '왼쪽가슴', '오른쪽가슴',
    '위', '아래', '상단', '하단',
    '(착용)', '착용',
    '반사띠',
    '*'
  ];
  for (const w of noiseWords) {
    s = s.split(w).join(' ');
  }

  // 4. 언더바 → 공백
  s = s.replace(/_+/g, ' ');

  // 5. 다중 공백 → 단일 공백
  s = s.replace(/\s+/g, ' ').trim();

  return s;
}

// 비교용으로 더 강하게 정규화 (공백/대소문자 무시)
function normalizeForCompare(text) {
  return normalize(text).toLowerCase().replace(/\s/g, '');
}

// ─── 운송비/택배 단축 ──────────────────────────────
// 정규식으로 항상 택배비(A0000018490) 매핑
const SHIPPING_PATTERN = /\[운송비\]|로젠택배|cj대한통운|한진(특송|택배)|우체국|택배비|운임|배송비|운송비/i;
const SHIPPING_PROD_CD = 'A0000018490'; // 우리 매입이력 1위 빈도(229회)
const SHIPPING_PROD_NAME = '택배비';

function shippingShortcut(text) {
  if (SHIPPING_PATTERN.test(text)) {
    return {
      prod_cd: SHIPPING_PROD_CD,
      prod_name: SHIPPING_PROD_NAME,
      confidence: 1.0,
      method: 'shipping_shortcut'
    };
  }
  return null;
}

// ─── 거래처 식별 ───────────────────────────────────
// 매입명세서 헤더에서 사업자번호 또는 회사명 추출
function extractVendorInfo(pdfText) {
  if (!pdfText) return { biz_no: null, name: null };

  // 사업자번호 패턴 (예: 113-81-66743)
  // 매입명세서엔 "공급자 사업자등록번호: ..." 형태
  const bizNoMatches = pdfText.match(/(\d{3}-\d{2}-\d{5})/g);

  // 우리 회사(대림에스엠) 사업자번호: 113-81-66743 — 공급받는자
  // 그 외 사업자번호 = 매입처(공급자)
  const OUR_BIZ_NOS = ['113-81-66743', '162-81-01738']; // 대림에스엠 + 대림컴퍼니
  let vendorBizNo = null;
  if (bizNoMatches) {
    for (const bn of bizNoMatches) {
      if (!OUR_BIZ_NOS.includes(bn)) {
        vendorBizNo = bn;
        break;
      }
    }
  }

  // 회사명 추출 — "상호: ㈜삼성라코스산업안전" 같은 패턴
  // 또는 헤더 영역에서 (주)/(株)/㈜/주식회사 패턴
  const nameRegexes = [
    /상호\s*[:：]\s*(\(주\)|㈜|주식회사)?\s*([^\s\n]{2,30})/g,
  ];
  let vendorName = null;
  for (const re of nameRegexes) {
    let m;
    while ((m = re.exec(pdfText)) !== null) {
      const cand = (m[1] || '') + (m[2] || '');
      // 우리 회사 이름이 아니면 매입처
      if (!cand.includes('대림에스엠') && !cand.includes('대림컴퍼니')) {
        vendorName = cand.trim();
        break;
      }
    }
    if (vendorName) break;
  }

  return { biz_no: vendorBizNo, name: vendorName };
}

// ─── 거래처 식별 (DB 매칭) ─────────────────────────
function identifyVendor(extractedInfo, db) {
  // 1차: 사업자번호 매칭 (가장 정확) — 추후 거래처 마스터 받으면 활용
  // 2차: 회사명 LIKE 매칭
  if (extractedInfo.name) {
    const cleaned = extractedInfo.name
      .replace(/\(주\)|㈜|주식회사|\(株\)/g, '')
      .trim();
    const tokens = cleaned.split(/\s+/).filter(t => t.length >= 2);

    // 첫 토큰으로 LIKE 검색
    if (tokens.length > 0) {
      const stmt = db.prepare(`
        SELECT vendor_name, COUNT(*) AS line_count
        FROM ecount_purchase_history
        WHERE vendor_name LIKE ?
        GROUP BY vendor_name
        ORDER BY line_count DESC
        LIMIT 5
      `);
      const rows = stmt.all('%' + tokens[0] + '%');
      if (rows.length > 0) {
        return { vendor_name: rows[0].vendor_name, confidence: 0.9, method: 'name_like' };
      }
    }
  }
  return { vendor_name: null, confidence: 0, method: 'unknown' };
}

// ─── 후보 풀 조회 ──────────────────────────────────
// 그 거래처에서 매입한 적 있는 품목들
function getCandidatePool(vendorName, db) {
  const stmt = db.prepare(`
    SELECT prod_cd, prod_name,
           COUNT(*) AS times,
           AVG(unit_price) AS avg_price,
           MAX(trx_date) AS last_date
    FROM ecount_purchase_history
    WHERE vendor_name = ?
    GROUP BY prod_cd, prod_name
    ORDER BY times DESC
  `);
  return stmt.all(vendorName);
}

// ─── 학습된 매핑 조회 ──────────────────────────────
function getLearnedMapping(vendorName, ocrText, db) {
  const stmt = db.prepare(`
    SELECT prod_cd, prod_name, use_count
    FROM ecount_mapping
    WHERE vendor_name = ? AND ocr_text = ?
  `);
  return stmt.get(vendorName, ocrText);
}

// ─── fuzzy 매칭 ────────────────────────────────────
// difflib.SequenceMatcher 비슷한 ratio (단순 구현)
function similarity(a, b) {
  const A = normalizeForCompare(a);
  const B = normalizeForCompare(b);
  if (!A || !B) return 0;
  if (A === B) return 1.0;

  // LCS-based ratio — Python difflib와 비슷
  const m = A.length, n = B.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (A[i - 1] === B[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
      } else {
        dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
      }
    }
  }
  return (2.0 * dp[m][n]) / (m + n);
}

// ─── 메인 매칭 함수 ────────────────────────────────
// 매입명세서 한 행에 대해 우리 품목코드 매칭
function matchProduct(vendorName, ocrText, db) {
  // 1. 운송비 단축
  const ship = shippingShortcut(ocrText);
  if (ship) return { ...ship, candidates: [] };

  // 2. 학습된 매핑
  const learned = getLearnedMapping(vendorName, ocrText, db);
  if (learned) {
    return {
      prod_cd: learned.prod_cd,
      prod_name: learned.prod_name,
      confidence: 1.0,
      method: 'learned',
      candidates: []
    };
  }

  // 3. 후보 풀에서 fuzzy 매칭
  const pool = getCandidatePool(vendorName, db);
  if (pool.length === 0) {
    return { prod_cd: null, prod_name: null, confidence: 0, method: 'no_history', candidates: [] };
  }

  const scored = pool.map(p => ({
    prod_cd: p.prod_cd,
    prod_name: p.prod_name,
    times: p.times,
    avg_price: p.avg_price,
    last_date: p.last_date,
    score: similarity(ocrText, p.prod_name)
  }));

  scored.sort((a, b) => b.score - a.score);

  const top = scored[0];
  let method, confidence;
  if (top.score >= 0.7) {
    method = 'auto'; confidence = top.score;
  } else if (top.score >= 0.45) {
    method = 'candidate'; confidence = top.score;
  } else {
    method = 'manual'; confidence = top.score;
  }

  return {
    prod_cd: top.prod_cd,
    prod_name: top.prod_name,
    confidence,
    method,
    candidates: scored.slice(0, 5)  // 상위 5개 후보
  };
}

// ─── 학습 저장 ────────────────────────────────────
// 사용자가 매핑 컨펌하면 ecount_mapping에 저장
function saveLearnedMapping(vendorName, ocrText, prodCd, prodName, userId, db) {
  const now = new Date().toISOString();
  const stmt = db.prepare(`
    INSERT INTO ecount_mapping (vendor_name, ocr_text, prod_cd, prod_name, confirmed_by, confirmed_at, use_count)
    VALUES (?, ?, ?, ?, ?, ?, 1)
    ON CONFLICT(vendor_name, ocr_text) DO UPDATE SET
      prod_cd=excluded.prod_cd,
      prod_name=excluded.prod_name,
      confirmed_by=excluded.confirmed_by,
      confirmed_at=excluded.confirmed_at,
      use_count=use_count+1
  `);
  return stmt.run(vendorName, ocrText, prodCd, prodName, userId || 'system', now);
}

module.exports = {
  normalize,
  normalizeForCompare,
  shippingShortcut,
  extractVendorInfo,
  identifyVendor,
  getCandidatePool,
  getLearnedMapping,
  similarity,
  matchProduct,
  saveLearnedMapping,
};
