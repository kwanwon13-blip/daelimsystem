/**
 * routes/categories.js — 품목(카테고리) CRUD
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { getReqUser, requireAuth } = require('../middleware/auth');
const { auditLog, savePriceHistory } = require('../middleware/audit');
const { safeBody } = require('../middleware/sanitize');

// ── 모든 카테고리 CRUD는 로그인 필수 ──
router.use(requireAuth);

router.get('/', (req, res) => {
  if (db.sql) return res.json(db.sql.categories.getAll());
  res.json(db.load().categories);
});

router.post('/', (req, res) => {
  if (db.sql) {
    const cat = db.sql.categories.create({
      name: req.body.name || '', code: req.body.code || '',
      pricingType: req.body.pricingType || 'QTY', unit: req.body.unit || '개',
      tiers: req.body.tiers || [], qtyPrice: req.body.qtyPrice || 0, fixedPrice: req.body.fixedPrice || 0
    });
    auditLog(getReqUser(req), '품목 추가', `${cat.name} (${cat.code})`);
    return res.json(cat);
  }
  const data = db.load();
  const cat = {
    id: db.generateId('cat'), name: req.body.name || '', code: req.body.code || '',
    pricingType: req.body.pricingType || 'QTY', unit: req.body.unit || '개',
    tiers: req.body.tiers || [], qtyPrice: req.body.qtyPrice || 0, fixedPrice: req.body.fixedPrice || 0
  };
  data.categories.push(cat); db.save(data);
  auditLog(getReqUser(req), '품목 추가', `${cat.name} (${cat.code})`);
  res.json(cat);
});

router.put('/:id', (req, res) => {
  // Mass Assignment / Prototype Pollution 차단 — id는 URL에서만 설정되도록 막음
  req.body = safeBody(req.body, ['id']);
  const priceFields = ['tiers', 'widthTiers', 'qtyPrice', 'fixedPrice'];
  const hasPriceChange = priceFields.some(f => req.body[f] !== undefined);
  if (db.sql) {
    const before = db.sql.categories.getById(req.params.id);
    const cat = db.sql.categories.update(req.params.id, req.body);
    if (!cat) return res.status(404).json({ error: 'not found' });
    auditLog(getReqUser(req), '품목 수정', before ? before.name : req.params.id);
    if (hasPriceChange && before) {
      savePriceHistory(
        getReqUser(req), req.params.id, before.name, 'default',
        { tiers: before.tiers, widthTiers: before.widthTiers, qtyPrice: before.qtyPrice, fixedPrice: before.fixedPrice },
        { tiers: cat.tiers, widthTiers: cat.widthTiers, qtyPrice: cat.qtyPrice, fixedPrice: cat.fixedPrice }
      );
    }
    return res.json(cat);
  }
  const data = db.load();
  const idx = data.categories.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const before = data.categories[idx];
  data.categories[idx] = { ...data.categories[idx], ...req.body, id: req.params.id };
  db.save(data);
  auditLog(getReqUser(req), '품목 수정', before.name);
  if (hasPriceChange) {
    const after = data.categories[idx];
    savePriceHistory(
      getReqUser(req), req.params.id, before.name, 'default',
      { tiers: before.tiers, widthTiers: before.widthTiers, qtyPrice: before.qtyPrice, fixedPrice: before.fixedPrice },
      { tiers: after.tiers, widthTiers: after.widthTiers, qtyPrice: after.qtyPrice, fixedPrice: after.fixedPrice }
    );
  }
  res.json(data.categories[idx]);
});

router.delete('/:id', (req, res) => {
  let catName = req.params.id;
  if (db.sql) {
    const cat = db.sql.categories.getById(req.params.id);
    if (cat) catName = cat.name;
    db.sql.categories.delete(req.params.id);
    auditLog(getReqUser(req), '품목 삭제', catName);
    return res.json({ ok: true });
  }
  const data = db.load();
  const cat = data.categories.find(c => c.id === req.params.id);
  if (cat) catName = cat.name;
  data.categories = data.categories.filter(c => c.id !== req.params.id);
  db.save(data);
  auditLog(getReqUser(req), '품목 삭제', catName);
  res.json({ ok: true });
});

module.exports = router;
