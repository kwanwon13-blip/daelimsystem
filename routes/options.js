/**
 * routes/options.js — 옵션 CRUD
 */
const express = require('express');
const router = express.Router();
const db = require('../db');
const { requireAuth } = require('../middleware/auth');
const { safeBody } = require('../middleware/sanitize');

// ── 모든 옵션 CRUD는 로그인 필수 ──
router.use(requireAuth);

router.get('/', (req, res) => {
  if (db.sql) return res.json(db.sql.options.getAll());
  res.json(db.load().options || []);
});

router.post('/', (req, res) => {
  if (db.sql) {
    const opt = db.sql.options.create({
      code: req.body.code || '', name: req.body.name || '',
      price: Number(req.body.price) || 0, unit: req.body.unit || '개',
      categoryIds: req.body.categoryIds || [],
      pricingType: req.body.pricingType || 'fixed',
      variants: Array.isArray(req.body.variants) ? req.body.variants : []
    });
    return res.json(opt);
  }
  const data = db.load();
  if (!data.options) data.options = [];
  const opt = {
    id: db.generateId('opt'), code: req.body.code || '', name: req.body.name || '',
    price: Number(req.body.price) || 0, unit: req.body.unit || '개',
    categoryIds: req.body.categoryIds || [],
    pricingType: req.body.pricingType || 'fixed',
    variants: Array.isArray(req.body.variants) ? req.body.variants : [],
    quotes: []
  };
  data.options.push(opt); db.save(data); res.json(opt);
});

router.put('/:id', (req, res) => {
  // Mass Assignment / Prototype Pollution 차단
  req.body = safeBody(req.body, ['id']);
  if (db.sql) {
    if (req.body.price !== undefined) req.body.price = Number(req.body.price);
    if (req.body.variants !== undefined) req.body.variants = Array.isArray(req.body.variants) ? req.body.variants : [];
    const opt = db.sql.options.update(req.params.id, req.body);
    if (!opt) return res.status(404).json({ error: 'not found' });
    return res.json(opt);
  }
  const data = db.load();
  if (!data.options) data.options = [];
  const idx = data.options.findIndex(o => o.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.options[idx] = { ...data.options[idx], ...req.body, id: req.params.id };
  if (req.body.price !== undefined) data.options[idx].price = Number(req.body.price);
  if (req.body.pricingType !== undefined) data.options[idx].pricingType = req.body.pricingType;
  if (req.body.variants !== undefined) data.options[idx].variants = Array.isArray(req.body.variants) ? req.body.variants : [];
  db.save(data); res.json(data.options[idx]);
});

router.delete('/:id', (req, res) => {
  if (db.sql) { db.sql.options.delete(req.params.id); return res.json({ ok: true }); }
  const data = db.load();
  if (!data.options) data.options = [];
  data.options = data.options.filter(o => o.id !== req.params.id);
  db.save(data); res.json({ ok: true });
});

// 옵션 업체별 견적 추가
router.post('/:id/quotes', (req, res) => {
  if (db.sql) {
    const opt = db.sql.options.getById(req.params.id);
    if (!opt) return res.status(404).json({ error: 'not found' });
    const quotes = Array.isArray(opt.quotes) ? opt.quotes : [];
    const q = { id: db.generateId('oq'), vendor: req.body.vendor || '', price: Number(req.body.price) || 0, quoteDate: req.body.quoteDate || new Date().toISOString().slice(0,10), note: req.body.note || '' };
    quotes.push(q);
    db.sql.options.update(req.params.id, { quotes });
    return res.json(db.sql.options.getById(req.params.id));
  }
  const data = db.load();
  const opt = (data.options || []).find(o => o.id === req.params.id);
  if (!opt) return res.status(404).json({ error: 'not found' });
  if (!opt.quotes) opt.quotes = [];
  const q = { id: db.generateId('oq'), vendor: req.body.vendor || '', price: Number(req.body.price) || 0, quoteDate: req.body.quoteDate || new Date().toISOString().slice(0,10), note: req.body.note || '' };
  opt.quotes.push(q); db.save(data); res.json(opt);
});

// 옵션 업체별 견적 삭제
router.delete('/:id/quotes/:qid', (req, res) => {
  if (db.sql) {
    const opt = db.sql.options.getById(req.params.id);
    if (!opt) return res.status(404).json({ error: 'not found' });
    const quotes = (opt.quotes || []).filter(q => q.id !== req.params.qid);
    db.sql.options.update(req.params.id, { quotes });
    return res.json(db.sql.options.getById(req.params.id));
  }
  const data = db.load();
  const opt = (data.options || []).find(o => o.id === req.params.id);
  if (!opt) return res.status(404).json({ error: 'not found' });
  opt.quotes = (opt.quotes || []).filter(q => q.id !== req.params.qid);
  db.save(data); res.json(opt);
});

module.exports = router;
