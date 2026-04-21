/**
 * routes/vendorPrices.js — 업체별 단가 API
 * GET    /api/vendor-prices/:vendorId
 * POST   /api/vendor-prices
 * POST   /api/vendor-prices/:vendorId/copy-defaults
 * DELETE /api/vendor-prices/:vendorId/:categoryId
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getReqUser, requireAuth } = require('../middleware/auth');
const { savePriceHistory } = require('../middleware/audit');

// ── 업체별 단가 API는 모두 로그인 필수 ──
router.use(requireAuth);

// 특정 업체의 모든 카테고리 단가 조회
router.get('/vendor-prices/:vendorId', (req, res) => {
  if (db.sql) {
    return res.json(db.sql.vendorPrices.getByVendor(req.params.vendorId));
  }
  const data = db.load();
  if (!data.vendorPrices) data.vendorPrices = [];
  const vp = data.vendorPrices.filter(p => p.vendorId === req.params.vendorId);
  res.json(vp);
});

// 특정 업체 + 카테고리 단가 저장/수정 (upsert)
router.post('/vendor-prices', (req, res) => {
  if (db.sql) {
    const { vendorId, categoryId, tiers, widthTiers, qtyPrice, fixedPrice } = req.body;
    if (!vendorId || !categoryId) return res.status(400).json({ error: 'vendorId, categoryId 필요' });
    // 이력용 이전 단가 조회
    const prevEntry = db.sql.vendorPrices.getByVendor(vendorId).find(p => p.categoryId === categoryId);
    const entry = db.sql.vendorPrices.upsert({
      vendorId, categoryId,
      tiers: tiers || [],
      widthTiers: widthTiers || [],
      qtyPrice: Number(qtyPrice) || 0,
      fixedPrice: Number(fixedPrice) || 0
    });
    // 단가이력 저장
    const cat = db.sql.categories.getById(categoryId);
    savePriceHistory(
      getReqUser(req), categoryId, cat ? cat.name : categoryId, vendorId,
      prevEntry ? { tiers: prevEntry.tiers, widthTiers: prevEntry.widthTiers, qtyPrice: prevEntry.qtyPrice, fixedPrice: prevEntry.fixedPrice } : null,
      { tiers: entry.tiers, widthTiers: entry.widthTiers, qtyPrice: entry.qtyPrice, fixedPrice: entry.fixedPrice }
    );
    return res.json(entry);
  }
  const data = db.load();
  if (!data.vendorPrices) data.vendorPrices = [];
  const { vendorId, categoryId, tiers, widthTiers, qtyPrice, fixedPrice } = req.body;
  if (!vendorId || !categoryId) return res.status(400).json({ error: 'vendorId, categoryId 필요' });

  const existing = data.vendorPrices.findIndex(p => p.vendorId === vendorId && p.categoryId === categoryId);
  const prevEntry = existing >= 0 ? data.vendorPrices[existing] : null;
  const entry = {
    id: existing >= 0 ? data.vendorPrices[existing].id : db.generateId('vp'),
    vendorId, categoryId,
    tiers: tiers || [],
    widthTiers: widthTiers || [],
    qtyPrice: Number(qtyPrice) || 0,
    fixedPrice: Number(fixedPrice) || 0
  };

  if (existing >= 0) {
    data.vendorPrices[existing] = entry;
  } else {
    data.vendorPrices.push(entry);
  }
  db.save(data);
  // 단가이력 저장
  const cat = (data.categories || []).find(c => c.id === categoryId);
  savePriceHistory(
    getReqUser(req), categoryId, cat ? cat.name : categoryId, vendorId,
    prevEntry ? { tiers: prevEntry.tiers, widthTiers: prevEntry.widthTiers, qtyPrice: prevEntry.qtyPrice, fixedPrice: prevEntry.fixedPrice } : null,
    { tiers: entry.tiers, widthTiers: entry.widthTiers, qtyPrice: entry.qtyPrice, fixedPrice: entry.fixedPrice }
  );
  res.json(entry);
});

// 기본 단가를 업체 단가로 복사
router.post('/vendor-prices/:vendorId/copy-defaults', (req, res) => {
  if (db.sql) {
    const vendorId = req.params.vendorId;
    const categories = db.sql.categories.getAll();
    let copied = 0;
    for (const cat of categories) {
      const existing = db.sql.vendorPrices.getByVendor(vendorId).find(p => p.categoryId === cat.id);
      if (!existing) {
        copied++;
      }
    }
    db.sql.vendorPrices.copyDefaults(vendorId, categories);
    return res.json({ ok: true, copied, message: `${copied}개 카테고리 기본 단가 복사 완료` });
  }
  const data = db.load();
  if (!data.vendorPrices) data.vendorPrices = [];
  const vendorId = req.params.vendorId;
  let copied = 0;

  for (const cat of data.categories) {
    const exists = data.vendorPrices.find(p => p.vendorId === vendorId && p.categoryId === cat.id);
    if (!exists) {
      data.vendorPrices.push({
        id: db.generateId('vp'), vendorId, categoryId: cat.id,
        tiers: JSON.parse(JSON.stringify(cat.tiers || [])),
        widthTiers: JSON.parse(JSON.stringify(cat.widthTiers || [])),
        qtyPrice: cat.qtyPrice || 0,
        fixedPrice: cat.fixedPrice || 0
      });
      copied++;
    }
  }
  db.save(data);
  res.json({ ok: true, copied, message: `${copied}개 카테고리 기본 단가 복사 완료` });
});

// 업체별 단가 삭제 (특정 카테고리)
router.delete('/vendor-prices/:vendorId/:categoryId', (req, res) => {
  if (db.sql) {
    db.sql.vendorPrices.delete(req.params.vendorId, req.params.categoryId);
    return res.json({ ok: true });
  }
  const data = db.load();
  if (!data.vendorPrices) data.vendorPrices = [];
  data.vendorPrices = data.vendorPrices.filter(p => !(p.vendorId === req.params.vendorId && p.categoryId === req.params.categoryId));
  db.save(data);
  res.json({ ok: true });
});

module.exports = router;
