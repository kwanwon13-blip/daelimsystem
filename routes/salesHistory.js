/**
 * routes/salesHistory.js — 과거 매출 데이터 검색 API
 */
const express = require('express');
const router = express.Router();
const salesHistory = require('../db-sales-history');
const db = require('../db');
const { requireAuth } = require('../middleware/auth');

// ── 매출 이력 검색 API는 모두 로그인 필수 ──
router.use(requireAuth);

/**
 * 옵션 DB에서 부자재 단가 맵 로드
 * 품명 키워드 → 개당 단가  (예: 'msds' → 13000, '파일케이스' → 2500)
 */
function loadOptionPriceMap() {
  const map = [];
  try {
    const options = db.sql ? db.sql.options.getAll() : (db.load().options || []);
    for (const opt of options) {
      if (opt.price > 0 && opt.name) {
        // 옵션 이름에서 키워드 추출 (소문자로 통일)
        map.push({ keyword: opt.name.toLowerCase(), price: opt.price });
      }
    }
  } catch (e) { /* 옵션 DB 없으면 무시 */ }
  return map;
}

/**
 * +로 연결된 복합품목에서 옵션 비용 차감
 * 예: "3t포맥스+MSDS케이스2개+파일케이스1개" → MSDS 13000×2 + 파일케이스 2500×1 = 28500 차감
 */
function subtractAddonCost(productName, unitPrice, optionMap) {
  if (!productName || !productName.includes('+')) return unitPrice;

  const parts = productName.split('+').slice(1); // 첫 번째는 본품
  let addonTotal = 0;

  for (const part of parts) {
    const partLower = part.trim().toLowerCase();
    // 수량 추출 (끝에 붙는 숫자, 예: "2개", "1개", "2장")
    const qtyMatch = partLower.match(/(\d+)\s*[개장매ea]?\s*$/);
    const qty = qtyMatch ? parseInt(qtyMatch[1]) : 1;

    // 옵션 맵에서 매칭
    for (const opt of optionMap) {
      if (partLower.includes('msds') && opt.keyword.includes('msds')) {
        addonTotal += opt.price * qty;
        break;
      } else if (partLower.includes('파일케이스') && opt.keyword.includes('파일케이스')) {
        addonTotal += opt.price * qty;
        break;
      } else if (partLower.includes('아크릴케이스') && opt.keyword.includes('아크릴케이스')) {
        addonTotal += opt.price * qty;
        break;
      } else if (partLower.includes('벨크로') && opt.keyword.includes('벨크로')) {
        addonTotal += opt.price * qty;
        break;
      } else if (partLower.includes('집게클립') && opt.keyword.includes('집게클립')) {
        addonTotal += opt.price * qty;
        break;
      } else if (partLower.includes('각목') && opt.keyword.includes('각목')) {
        addonTotal += opt.price * qty;
        break;
      } else if (partLower.includes('아크릴포켓') && opt.keyword.includes('아크릴포켓')) {
        addonTotal += opt.price * qty;
        break;
      }
    }
  }

  const net = unitPrice - addonTotal;
  return net > 0 ? net : unitPrice; // 차감 결과가 음수면 원본 유지 (매칭 오류 방지)
}

/**
 * GET /api/sales-history/search?vendor=라코스&keyword=3t포맥스&limit=20
 */
router.get('/search', (req, res) => {
  try {
    const { vendor, keyword, limit } = req.query;
    const lim = Math.min(parseInt(limit) || 20, 100);

    // 1단계: 같은 거래처 결과
    const vendorResults = salesHistory.search({
      vendor: vendor || null,
      keyword: keyword || null,
      limit: lim
    });

    // 2단계: 다른 거래처 결과 (vendor가 지정된 경우에만)
    let otherResults = [];
    if (vendor && keyword) {
      const allResults = salesHistory.search({
        vendor: null,
        keyword: keyword,
        limit: lim
      });
      const vendorIds = new Set(vendorResults.map(r => r.id));
      otherResults = allResults.filter(r => {
        if (vendorIds.has(r.id)) return false;
        if (vendor && r.vendor.includes(vendor)) return false;
        return true;
      }).slice(0, 10);
    }

    // 옵션 단가 맵 로드 (매 요청마다 — 옵션이 바뀔 수 있으므로)
    const optionMap = loadOptionPriceMap();

    // ㎡당 단가 계산 (+품목은 옵션 비용 차감 후 순수 제작단가로 계산)
    function addAreaPrice(row) {
      let pricePerSqm = null;
      if (row.area_price_type === 'area' && row.width_mm && row.height_mm && row.unit_price > 0) {
        const netPrice = subtractAddonCost(row.product_name, row.unit_price, optionMap);
        const areaSqm = (row.width_mm * row.height_mm) / 1000000;
        if (areaSqm > 0) {
          pricePerSqm = Math.round(netPrice / areaSqm);
        }
      }
      return { ...row, price_per_sqm: pricePerSqm };
    }

    res.json({
      vendor_results: vendorResults.map(addAreaPrice),
      other_results: otherResults.map(addAreaPrice),
      total_vendor: vendorResults.length,
      total_other: otherResults.length
    });
  } catch (err) {
    console.error('sales-history search error:', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sales-history/vendors
 */
router.get('/vendors', (req, res) => {
  try {
    const vendors = salesHistory.getVendors();
    res.json(vendors);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/sales-history/stats
 */
router.get('/stats', (req, res) => {
  try {
    const count = salesHistory.getCount();
    const vendors = salesHistory.getVendors();
    res.json({ total: count, vendors });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
