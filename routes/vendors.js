/**
 * routes/vendors.js — 업체 CRUD
 */
const express = require('express');
const router = express.Router();
const fs = require('fs');
const path = require('path');
const db = require('../db');
const { getReqUser } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

router.get('/', (req, res) => {
  try {
    if (db.sql) return res.json(db.sql.vendors.getAll() || []);
    if (db['업체관리']) return res.json(db['업체관리'].load().vendors || []);
    res.json(db.load().vendors || []);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    if (db.sql) {
      const v = db.sql.vendors.create({
        name: req.body.name || '', bizNo: req.body.bizNo || '',
        ceo: req.body.ceo || '', phone: req.body.phone || '', email: req.body.email || '',
        address: req.body.address || '', note: req.body.note || ''
      });
      auditLog(getReqUser(req), '업체 추가', v.name);
      return res.json(v);
    }
    const loadVendors = () => db['업체관리'] ? db['업체관리'].load() : db.load();
    const saveVendors = (d) => db['업체관리'] ? db['업체관리'].save(d) : db.save(d);
    const data = loadVendors();
    if (!data.vendors) data.vendors = [];
    const v = { id: db.generateId('v'), name: req.body.name || '', bizNo: req.body.bizNo || '',
      ceo: req.body.ceo || '', phone: req.body.phone || '', email: req.body.email || '',
      address: req.body.address || '', note: req.body.note || '' };
    data.vendors.push(v); saveVendors(data);
    auditLog(getReqUser(req), '업체 추가', v.name);
    res.json(v);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// JSON → SQLite 마이그레이션
router.post('/migrate-from-json', (req, res) => {
  try {
    if (!db.sql) return res.status(400).json({ error: 'SQLite 모드가 아닙니다' });
    const existing = db.sql.vendors.getAll();
    if (existing.length > 0) return res.json({ ok: true, message: '이미 데이터 있음', count: existing.length });
    const jsonPath = path.join(__dirname, '../data', '업체관리.json');
    if (!fs.existsSync(jsonPath)) return res.status(404).json({ error: '업체관리.json 없음' });
    const jsonData = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    const vendors = jsonData.vendors || [];
    let added = 0;
    for (const v of vendors) {
      try { db.sql.vendors.create(v); added++; } catch (e2) {}
    }
    res.json({ ok: true, added, total: vendors.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.put('/:id', (req, res) => {
  if (db.sql) {
    const before = db.sql.vendors.getById(req.params.id);
    const v = db.sql.vendors.update(req.params.id, req.body);
    if (!v) return res.status(404).json({ error: 'not found' });
    auditLog(getReqUser(req), '업체 수정', before ? before.name : req.params.id);
    return res.json(v);
  }
  const loadVendors = () => db['업체관리'] ? db['업체관리'].load() : db.load();
  const saveVendors = (d) => db['업체관리'] ? db['업체관리'].save(d) : db.save(d);
  const data = loadVendors();
  if (!data.vendors) data.vendors = [];
  const idx = data.vendors.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const before = data.vendors[idx];
  data.vendors[idx] = { ...data.vendors[idx], ...req.body, id: req.params.id };
  saveVendors(data);
  auditLog(getReqUser(req), '업체 수정', before.name);
  res.json(data.vendors[idx]);
});

router.delete('/:id', (req, res) => {
  let vendorName = req.params.id;
  if (db.sql) {
    const v = db.sql.vendors.getById(req.params.id);
    if (v) vendorName = v.name;
    db.sql.vendors.delete(req.params.id);
    auditLog(getReqUser(req), '업체 삭제', vendorName);
    return res.json({ ok: true });
  }
  const loadVendors = () => db['업체관리'] ? db['업체관리'].load() : db.load();
  const saveVendors = (d) => db['업체관리'] ? db['업체관리'].save(d) : db.save(d);
  const data = loadVendors();
  if (!data.vendors) data.vendors = [];
  const v = data.vendors.find(v => v.id === req.params.id);
  if (v) vendorName = v.name;
  data.vendors = data.vendors.filter(v => v.id !== req.params.id);
  saveVendors(data);
  auditLog(getReqUser(req), '업체 삭제', vendorName);
  res.json({ ok: true });
});

module.exports = router;
