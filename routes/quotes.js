/**
 * routes/quotes.js — 견적 계산/저장/Excel 내보내기 + 통계 + 명함
 * Mounted at: app.use('/api', require('./routes/quotes'))
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const db = require('../db');
const { sessions, parseCookies, getReqUser } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { notify } = require('../utils/notify');
const JSZip = require('jszip');

const TEMPLATE_PATH = path.join(__dirname, '..', 'data', 'template.xlsx');

// ── 견적 계산 ─────────────────────────────────────────────
router.post('/quote/calculate', (req, res) => {
  const { categoryId, widthMm, heightMm, qty, optionSelections, vendorId } = req.body;

  let cat, options, vendorPrices;
  if (db.sql) {
    cat = db.sql.categories.getById(categoryId);
    options = db.sql.options.getAll();
    if (vendorId) {
      vendorPrices = db.sql.vendorPrices.getByVendor(vendorId);
    } else {
      vendorPrices = [];
    }
  } else {
    const data = db.load();
    cat = data.categories.find(c => c.id === categoryId);
    options = data.options || [];
    vendorPrices = vendorId && data.vendorPrices ? data.vendorPrices.filter(p => p.vendorId === vendorId) : [];
  }

  if (!cat) return res.status(404).json({ error: '카테고리 없음' });

  let pricing = cat;
  if (vendorId && vendorPrices) {
    const vp = vendorPrices.find(p => p.vendorId === vendorId && p.categoryId === categoryId);
    if (vp) {
      pricing = { ...cat, tiers: vp.tiers, widthTiers: vp.widthTiers, qtyPrice: vp.qtyPrice, fixedPrice: vp.fixedPrice };
    }
  }

  const q = Math.max(1, Number(qty) || 1);
  let basePrice = 0, sqm = 0, matchedTier = null;
  let lengthM = 0, matchedWidthTier = null;
  let matchedVariant = null;

  if (cat.pricingType === 'SIZE') {
    const w = Number(widthMm) || 0, h = Number(heightMm) || 0;
    sqm = (w / 1000) * (h / 1000);
    const tiers = (pricing.tiers || []).sort((a, b) => (a.areaMin || 0) - (b.areaMin || 0));
    for (const t of tiers) {
      const min = Number(t.areaMin) || 0;
      const max = t.areaMax == null || t.areaMax === '' ? Infinity : Number(t.areaMax);
      if (sqm >= min && sqm < max) { matchedTier = t; break; }
    }
    if (!matchedTier && tiers.length > 0) matchedTier = tiers[tiers.length - 1];
    basePrice = sqm * (matchedTier ? Number(matchedTier.pricePerSqm) || 0 : 0) * q;
  } else if (cat.pricingType === 'LENGTH') {
    const w = Number(widthMm) || 0, h = Number(heightMm) || 0;
    lengthM = h / 1000;
    sqm = (w / 1000) * lengthM;
    const wTiers = (pricing.widthTiers || []).sort((a, b) => (Number(a.widthMm) || 0) - (Number(b.widthMm) || 0));
    for (const t of wTiers) {
      if (w <= Number(t.widthMm)) { matchedWidthTier = t; break; }
    }
    if (!matchedWidthTier && wTiers.length > 0) matchedWidthTier = wTiers[wTiers.length - 1];
    const pricePerM = matchedWidthTier ? Number(matchedWidthTier.pricePerM) || 0 : 0;
    basePrice = lengthM * pricePerM * q;
  } else if (cat.pricingType === 'VARIANTS') {
    const variants = pricing.variants || [];
    const variantIdx = req.body.variantIdx != null ? Number(req.body.variantIdx) : -1;
    matchedVariant = variants[variantIdx] || null;
    basePrice = matchedVariant ? Number(matchedVariant.price) * q : 0;
  } else if (cat.pricingType === 'QTY') {
    basePrice = (Number(pricing.qtyPrice) || 0) * q;
  } else {
    basePrice = (Number(pricing.fixedPrice) || 0) * q;
  }

  let optionTotal = 0;
  const optionDetails = [];
  if (Array.isArray(optionSelections)) {
    for (const sel of optionSelections) {
      const opt = options.find(o => o.id === sel.optionId);
      if (!opt) continue;
      const oQty = Math.max(1, Number(sel.qty) || 1);
      const optType = opt.pricingType || 'fixed';
      let oPrice = 0;
      let optLabel = opt.name;

      if (optType === 'perSqm') {
        // 면적 수정이 있으면 override 사용, 없으면 상품 면적 사용
        let optSqm = sqm;
        if (sel.areaOverride && sel.areaOverride.widthMm && sel.areaOverride.heightMm) {
          optSqm = (Number(sel.areaOverride.widthMm) / 1000) * (Number(sel.areaOverride.heightMm) / 1000);
        }
        oPrice = Math.round(Number(opt.price) * optSqm) * oQty;
        optLabel = `${opt.name}(${optSqm.toFixed(2)}㎡)`;
      } else if (optType === 'variants' && Array.isArray(opt.variants) && sel.variantIdx !== undefined) {
        const variant = opt.variants[Number(sel.variantIdx)];
        if (variant) {
          oPrice = Number(variant.price) * oQty;
          optLabel = `${opt.name}(${variant.label})`;
        }
      } else {
        oPrice = Number(opt.price) * oQty;
      }

      optionTotal += oPrice;
      optionDetails.push({ id: opt.id, name: optLabel, code: opt.code, unitPrice: Math.round(oPrice / oQty), qty: oQty, total: oPrice, unit: opt.unit });
    }
  }

  const totalExVat = Math.round(basePrice + optionTotal);
  const vat = Math.round(totalExVat * 0.1);
  const usingVendorPrice = !!(vendorId && vendorPrices && vendorPrices.find(p => p.vendorId === vendorId && p.categoryId === categoryId));

  res.json({
    sqm: Math.round(sqm * 10000) / 10000,
    pricePerSqm: matchedTier ? Number(matchedTier.pricePerSqm) : null,
    tierLabel: matchedTier ? `${matchedTier.areaMin || 0}~${matchedTier.areaMax || '∞'}㎡` : null,
    lengthM: Math.round(lengthM * 1000) / 1000,
    pricePerM: matchedWidthTier ? Number(matchedWidthTier.pricePerM) : null,
    widthTierLabel: matchedWidthTier ? `${matchedWidthTier.widthMm}mm폭` : null,
    basePrice: Math.round(basePrice), optionTotal, optionDetails,
    totalExVat, vat, totalIncVat: totalExVat + vat,
    optionRemark: optionDetails.map(o => o.qty > 1 ? `${o.name} ${o.qty}${o.unit||'개'}` : o.name).join(', '),
    usingVendorPrice,
    variantLabel: matchedVariant ? matchedVariant.label : null
  });
});

// ── 견적서 저장/목록/조회 ─────────────────────────────────
router.get('/quotes', (req, res) => {
  if (db.sql) {
    const quotes = db.sql.quotes.getAll().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return res.json(quotes.map(q => ({
      id: q.id, siteName: q.siteName, quoteName: q.quoteName, vendorName: q.vendorName,
      manager: q.manager, createdBy: q.createdBy, createdAt: q.createdAt,
      totalAmount: q.totalAmount, itemCount: (q.items || []).length, status: q.status || 'draft'
    })));
  }
  const data = db['견적관리'] ? db['견적관리'].load() : db.load();
  const quotes = (data.quotes || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(quotes.map(q => ({
    id: q.id, siteName: q.siteName, quoteName: q.quoteName, vendorName: q.vendorName,
    manager: q.manager, createdBy: q.createdBy, createdAt: q.createdAt,
    totalAmount: q.totalAmount, itemCount: (q.items || []).length, status: q.status || 'draft'
  })));
});

router.get('/quotes/:id', (req, res) => {
  if (db.sql) {
    const quote = db.sql.quotes.getById(req.params.id);
    if (!quote) return res.status(404).json({ error: '견적서 없음' });
    return res.json(quote);
  }
  const data = db['견적관리'] ? db['견적관리'].load() : db.load();
  const quote = (data.quotes || []).find(q => q.id === req.params.id);
  if (!quote) return res.status(404).json({ error: '견적서 없음' });
  res.json(quote);
});

router.post('/quotes', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const user = token ? sessions[token] : null;

  if (db.sql) {
    const items = req.body.items || [];
    const quote = db.sql.quotes.create({
      id: req.body.id || undefined,
      siteName: req.body.siteName || '',
      quoteName: req.body.quoteName || '',
      manager: req.body.manager || '',
      vendorManager: req.body.vendorManager || '',
      vendorId: req.body.vendorId || '',
      vendorName: req.body.vendorName || '',
      vendorBizNo: req.body.vendorBizNo || '',
      items,
      totalAmount: items.reduce((sum, it) => sum + (Number(it.amount) || 0), 0),
      status: req.body.status || 'draft',
      createdAt: req.body.createdAt || new Date().toISOString(),
      createdBy: user ? user.userId : (req.body.createdBy || '')
    });
    auditLog(user ? user.userId : '비로그인', '견적 생성', `${quote.siteName || ''} ${quote.quoteName || ''}`);
    return res.json(quote);
  }

  const loadQuotes = () => db['견적관리'] ? db['견적관리'].load() : db.load();
  const saveQuotes = (d) => db['견적관리'] ? db['견적관리'].save(d) : db.save(d);
  const data = loadQuotes();
  if (!data.quotes) data.quotes = [];

  const quote = {
    id: req.body.id || db.generateId('q'),
    siteName: req.body.siteName || '',
    quoteName: req.body.quoteName || '',
    manager: req.body.manager || '',
    vendorManager: req.body.vendorManager || '',
    vendorId: req.body.vendorId || '',
    vendorName: req.body.vendorName || '',
    vendorBizNo: req.body.vendorBizNo || '',
    items: req.body.items || [],
    totalAmount: (req.body.items || []).reduce((sum, it) => sum + (Number(it.amount) || 0), 0),
    createdBy: user ? user.userId : (req.body.createdBy || ''),
    createdAt: req.body.createdAt || new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: req.body.status || 'draft'
  };

  data.quotes.push(quote);
  saveQuotes(data);
  auditLog(user ? user.userId : '비로그인', '견적 생성', `${quote.siteName || ''} ${quote.quoteName || ''}`);
  res.json(quote);
});

router.get('/quotes-test-v2', (req, res) => { res.json({version: 'v2-createdAt-fix', ok: true}); });

router.put('/quotes/:id', (req, res) => {
  if (db.sql) {
    const updates = { ...req.body };
    if (req.body.items) {
      updates.totalAmount = req.body.items.reduce((sum, it) => sum + (it.amount || 0), 0);
    }
    const quote = db.sql.quotes.update(req.params.id, updates);
    if (!quote) return res.status(404).json({ error: 'not found' });
    return res.json(quote);
  }
  const loadQuotes = () => db['견적관리'] ? db['견적관리'].load() : db.load();
  const saveQuotes = (d) => db['견적관리'] ? db['견적관리'].save(d) : db.save(d);
  const data = loadQuotes();
  if (!data.quotes) data.quotes = [];
  const idx = data.quotes.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const qBefore = data.quotes[idx];
  data.quotes[idx] = { ...data.quotes[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  if (req.body.items) {
    data.quotes[idx].totalAmount = req.body.items.reduce((sum, it) => sum + (it.amount || 0), 0);
  }
  saveQuotes(data);
  auditLog(getReqUser(req), '견적 수정', `${qBefore.siteName || ''} ${qBefore.quoteName || ''}`.trim() || req.params.id);
  res.json(data.quotes[idx]);
});

router.delete('/quotes/:id', (req, res) => {
  let qName = req.params.id;
  if (db.sql) {
    const q = db.sql.quotes.getById(req.params.id);
    if (q) qName = `${q.siteName || ''} ${q.quoteName || ''}`.trim() || q.id;
    db.sql.quotes.delete(req.params.id);
    auditLog(getReqUser(req), '견적 삭제', qName);
    return res.json({ ok: true });
  }
  const loadQuotes = () => db['견적관리'] ? db['견적관리'].load() : db.load();
  const saveQuotes = (d) => db['견적관리'] ? db['견적관리'].save(d) : db.save(d);
  const data = loadQuotes();
  if (!data.quotes) data.quotes = [];
  const q = data.quotes.find(q => q.id === req.params.id);
  if (q) qName = `${q.siteName || ''} ${q.quoteName || ''}`.trim() || q.id;
  data.quotes = data.quotes.filter(q => q.id !== req.params.id);
  saveQuotes(data);
  auditLog(getReqUser(req), '견적 삭제', qName);
  res.json({ ok: true });
});

// 견적 복사
router.post('/quotes/:id/copy', (req, res) => {
  if (db.sql) {
    const copied = db.sql.quotes.duplicate(req.params.id);
    if (!copied) return res.status(404).json({ error: 'not found' });
    return res.json(copied);
  }
  const data = db['견적관리'] ? db['견적관리'].load() : db.load();
  const src = (data.quotes || []).find(q => q.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'not found' });
  const copied = { ...JSON.parse(JSON.stringify(src)), id: db.generateId('q'), siteName: '[복사] ' + src.siteName, status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mailHistory: [] };
  data.quotes.push(copied);
  (db['견적관리'] ? db['견적관리'].save(data) : db.save(data));
  res.json(copied);
});

// 견적 상태 변경
const QUOTE_STATUS_FLOW = {
  'draft':     ['review', 'sent', 'won', 'lost'],
  'review':    ['approved', 'rejected', 'draft'],
  'rejected':  ['draft', 'review'],
  'approved':  ['sent', 'draft'],
  'sent':      ['won', 'lost', 'draft'],
  'won':       ['completed', 'draft'],
  'lost':      ['draft'],
  'completed': ['draft']
};

router.post('/quotes/:id/status', (req, res) => {
  const newStatus = req.body.status;
  const userId = getReqUser(req);

  if (db.sql) {
    const before = db.sql.quotes.getById(req.params.id);
    if (!before) return res.status(404).json({ error: 'not found' });
    const current = before.status || 'draft';
    const allowed = QUOTE_STATUS_FLOW[current] || [];
    if (!allowed.includes(newStatus)) {
      return res.status(400).json({ error: `'${current}' → '${newStatus}' 전환 불가`, 허용: allowed });
    }
    const quote = db.sql.quotes.updateStatus(req.params.id, newStatus);
    const qName = `${before.siteName || ''} ${before.quoteName || ''}`.trim();
    auditLog(userId, `견적 상태변경 (${current}→${newStatus})`, qName);
    if (newStatus === 'approved' && before.createdBy) notify(before.createdBy, 'quote', `견적서 "${qName}"이 승인되었습니다`, 'history');
    if (newStatus === 'rejected' && before.createdBy) notify(before.createdBy, 'quote', `견적서 "${qName}"이 반려되었습니다`, 'history');
    return res.json(quote);
  }
  const loadQuotes = () => db['견적관리'] ? db['견적관리'].load() : db.load();
  const saveQuotes = (d) => db['견적관리'] ? db['견적관리'].save(d) : db.save(d);
  const data = loadQuotes();
  const q = (data.quotes || []).find(q => q.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'not found' });
  const current = q.status || 'draft';
  const allowed = QUOTE_STATUS_FLOW[current] || [];
  if (!allowed.includes(newStatus)) {
    return res.status(400).json({ error: `'${current}' → '${newStatus}' 전환 불가`, 허용: allowed });
  }
  q.status = newStatus; q.updatedAt = new Date().toISOString();
  if (newStatus === 'won' && !q.wonAt) q.wonAt = new Date().toISOString();
  if (newStatus === 'lost' && !q.lostAt) q.lostAt = new Date().toISOString();
  saveQuotes(data);
  const qName = `${q.siteName || ''} ${q.quoteName || ''}`.trim();
  auditLog(userId, `견적 상태변경 (${current}→${newStatus})`, qName);
  if (newStatus === 'approved' && q.createdBy) notify(q.createdBy, 'quote', `견적서 "${qName}"이 승인되었습니다`, 'history');
  if (newStatus === 'rejected' && q.createdBy) notify(q.createdBy, 'quote', `견적서 "${qName}"이 반려되었습니다`, 'history');
  res.json(q);
});

// 통계
router.get('/stats', (req, res) => {
  const quotes = db.sql ? db.sql.quotes.getAll()
    : (db['견적관리'] ? db['견적관리'].load().quotes : db.load().quotes) || [];
  const byMonth = {};
  quotes.forEach(q => {
    const m = (q.createdAt || '').slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { count: 0, amount: 0, won: 0, lost: 0 };
    byMonth[m].count++;
    byMonth[m].amount += q.totalAmount || 0;
    if (q.status === 'won') byMonth[m].won++;
    if (q.status === 'lost') byMonth[m].lost++;
  });
  const byVendor = {};
  quotes.forEach(q => {
    const v = q.vendorName || '미지정';
    if (!byVendor[v]) byVendor[v] = { count: 0, amount: 0 };
    byVendor[v].count++; byVendor[v].amount += q.totalAmount || 0;
  });
  const byCategory = {};
  quotes.forEach(q => (q.items || []).forEach(it => {
    const c = it.category || it.name || '기타';
    if (!byCategory[c]) byCategory[c] = 0;
    byCategory[c]++;
  }));
  const statusCount = { draft: 0, sent: 0, won: 0, lost: 0, completed: 0 };
  quotes.forEach(q => { const s = q.status || 'draft'; if (statusCount[s] !== undefined) statusCount[s]++; });
  res.json({
    total: quotes.length,
    totalAmount: quotes.reduce((s, q) => s + (q.totalAmount || 0), 0),
    statusCount,
    byMonth: Object.entries(byMonth).sort((a,b)=>a[0]<b[0]?1:-1).slice(0, 12).reverse(),
    topVendors: Object.entries(byVendor).sort((a,b)=>b[1].amount-a[1].amount).slice(0,5).map(([name,v])=>({name,...v})),
    topCategories: Object.entries(byCategory).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([name,count])=>({name,count}))
  });
});

// ── 명함 (본인) ──────────────────────────────────────────
router.post('/me/namecard', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.userId === session.userId);
  if (!user) return res.status(404).json({ error: 'not found' });
  user.namecard = { mobile: req.body.mobile || '', tel: req.body.tel || '', fax: req.body.fax || '', email: req.body.email || '', dept: req.body.dept || '', tagline: req.body.tagline || '' };
  db.saveUsers(uData); res.json({ ok: true });
});

router.get('/me/namecard', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.userId === session.userId);
  res.json(user ? (user.namecard || {}) : {});
});

router.post('/me/namecard-image', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: '이미지 없음' });
  const ext = (mimeType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
  const filename = `namecard_${session.userId}.${ext}`;
  const filepath = path.join(__dirname, '..', 'data', filename);
  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.userId === session.userId);
  if (user) { user.namecardImage = filename; db.saveUsers(uData); }
  res.json({ ok: true, url: `/data/${filename}` });
});

router.get('/me/namecard-image', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.userId === session.userId);
  if (user && user.namecardImage) {
    res.json({ url: `/data/${user.namecardImage}` });
  } else {
    res.json({ url: null });
  }
});

router.delete('/me/namecard-image', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const uData = db.loadUsers();
  const user = (uData.users || []).find(u => u.userId === session.userId);
  if (user && user.namecardImage) {
    const filepath = path.join(__dirname, '..', 'data', user.namecardImage);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    user.namecardImage = null;
    db.saveUsers(uData);
  }
  res.json({ ok: true });
});

// ── 견적서 Excel 내보내기 ─────────────────────────────────
async function generateQuoteExcel(quoteData) {
  const { siteName, quoteName, manager, vendorManager, quoteDate, items } = quoteData;
  const templateBuf = fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBuf);

  const drawFile = zip.file('xl/drawings/drawing1.xml');
  if (drawFile) {
    let drawXml = await drawFile.async('string');
    drawXml = drawXml.replace(/<a:r><a:rPr[^>]*>(?:<[^>]*>)*<\/a:rPr><a:t>,<\/a:t><\/a:r>/g, '');
    drawXml = drawXml.replace(/<a:r><a:rPr[^>]*>(?:<[^>]*>)*<\/a:rPr><a:t> 남 중 석<\/a:t><\/a:r>/g, '');
    zip.file('xl/drawings/drawing1.xml', drawXml);
  }

  let ssXml = await zip.file('xl/sharedStrings.xml').async('string');
  const ssMatches = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)];
  const sharedStrings = ssMatches.map(m => {
    const tMatch = m[1].match(/<t[^>]*>([^<]*)<\/t>/);
    return tMatch ? tMatch[1] : '';
  });

  function addSharedString(text) {
    const idx = sharedStrings.length;
    sharedStrings.push(text);
    return idx;
  }

  const idxSiteName = addSharedString('현 장 명: ' + (siteName || ''));
  const idxQuoteName = addSharedString('견 적 명: ' + (quoteName || ''));
  const idxManager = addSharedString('담 당 자: ' + (manager || ''));
  const idxVendorMgr = addSharedString('담당자 : ' + (vendorManager || ''));

  const itemStrIndices = items.map(item => ({
    name: addSharedString(item.name || ''),
    spec: addSharedString(item.spec || ''),
    unit: addSharedString(item.unit || ''),
    remark: addSharedString(item.remark || '')
  }));

  let sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');

  sheetXml = sheetXml.replace(/(<c r="B4"[^>]*t="s"[^>]*><v>)\d+(<\/v><\/c>)/, `$1${idxSiteName}$2`);
  sheetXml = sheetXml.replace(/(<c r="B5"[^>]*t="s"[^>]*><v>)\d+(<\/v><\/c>)/, `$1${idxQuoteName}$2`);
  sheetXml = sheetXml.replace(/(<c r="B6"[^>]*t="s"[^>]*><v>)\d+(<\/v><\/c>)/, `$1${idxManager}$2`);
  sheetXml = sheetXml.replace(/(<c r="G8"[^>]*t="s"[^>]*><v>)\d+(<\/v><\/c>)/, `$1${idxVendorMgr}$2`);

  const dateStr = quoteDate || new Date().toISOString().slice(0, 10);
  const formattedDate = '견적일:' + dateStr.replace(/-/g, '.');
  const idxDate = addSharedString(formattedDate);
  sheetXml = sheetXml.replace(/<c r="B8"[^>]*>[\s\S]*?<\/c>/, `<c r="B8" s="42" t="s"><v>${idxDate}</v></c>`);

  const newSiEntries2 = sharedStrings.map(s => {
    const escaped = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<si><t>${escaped}</t></si>`;
  });
  ssXml = ssXml.replace(
    /<sst[^>]*>[\s\S]*<\/sst>/,
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${newSiEntries2.join('')}</sst>`
  );
  zip.file('xl/sharedStrings.xml', ssXml);

  const DATA_START = 11;
  const DATA_END = 34;
  const itemCount = Math.min(items.length, DATA_END - DATA_START + 1);

  for (let i = 0; i < 24; i++) {
    const rowNum = DATA_START + i;
    const rowRegex = new RegExp(`<row r="${rowNum}"[^>]*>[\\s\\S]*?</row>`);
    const rowMatch = sheetXml.match(rowRegex);
    if (!rowMatch) continue;

    if (i < itemCount) {
      const item = items[i];
      const si = itemStrIndices[i];
      const newRow = `<row r="${rowNum}" spans="1:9" ht="19.5" customHeight="1" x14ac:dyDescent="0.15">` +
        `<c r="A${rowNum}" s="17"/>` +
        `<c r="B${rowNum}" s="21"><v>${i + 1}</v></c>` +
        `<c r="C${rowNum}" s="21" t="s"><v>${si.name}</v></c>` +
        `<c r="D${rowNum}" s="21" t="s"><v>${si.spec}</v></c>` +
        `<c r="E${rowNum}" s="21" t="s"><v>${si.unit}</v></c>` +
        `<c r="F${rowNum}" s="23"><v>${item.qty || 0}</v></c>` +
        `<c r="G${rowNum}" s="22"><v>${item.unitPrice || 0}</v></c>` +
        `<c r="H${rowNum}" s="22"><f>F${rowNum}*G${rowNum}</f><v>${(item.qty || 0) * (item.unitPrice || 0)}</v></c>` +
        `<c r="I${rowNum}" s="21" t="s"><v>${si.remark}</v></c>` +
        `</row>`;
      sheetXml = sheetXml.replace(rowRegex, newRow);
    } else {
      const emptyRow = `<row r="${rowNum}" spans="2:9" ht="19.5" customHeight="1" x14ac:dyDescent="0.15">` +
        `<c r="B${rowNum}" s="21"/><c r="C${rowNum}" s="21"/><c r="D${rowNum}" s="21"/>` +
        `<c r="E${rowNum}" s="21"/><c r="F${rowNum}" s="23"/><c r="G${rowNum}" s="22"/>` +
        `<c r="H${rowNum}" s="22"/><c r="I${rowNum}" s="21"/>` +
        `</row>`;
      sheetXml = sheetXml.replace(rowRegex, emptyRow);
    }
  }

  const lastDataRow = DATA_START + itemCount - 1;
  sheetXml = sheetXml.replace(
    /(<c r="H35"[^>]*>)<f>[^<]*<\/f><v>[^<]*<\/v>/,
    `$1<f>SUM(H${DATA_START}:H${lastDataRow})</f><v>${items.slice(0, itemCount).reduce((s, it) => s + (it.qty || 0) * (it.unitPrice || 0), 0)}</v>`
  );
  const total = items.slice(0, itemCount).reduce((s, it) => s + (it.qty || 0) * (it.unitPrice || 0), 0);
  sheetXml = sheetXml.replace(
    /(<c r="B7"[^>]*>)<f>[^<]*<\/f><v>[^<]*<\/v>/,
    `$1<f>H35</f><v>${total}</v>`
  );

  zip.file('xl/worksheets/sheet1.xml', sheetXml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

router.post('/quote/export', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: '품목이 없습니다' });
    const buffer = await generateQuoteExcel(req.body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const filename = (req.body.siteName || 'quote') + '_' + new Date().toISOString().slice(0, 10) + '.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (e) {
    console.error('견적서 오류:', e);
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;
