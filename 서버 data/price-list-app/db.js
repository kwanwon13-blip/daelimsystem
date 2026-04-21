/**
 * db.js — JSON 파일 기반 데이터베이스
 *
 * 데이터 구조:
 * {
 *   categories: [{
 *     id, name, code,
 *     pricingType: 'SIZE' | 'QTY' | 'FIXED',
 *     unit: '㎡' | '개' | '식',
 *     tiers: [{ areaMin, areaMax, pricePerSqm }],   // SIZE 타입
 *     qtyPrice: number,                               // QTY 타입 (개당 단가)
 *     fixedPrice: number                               // FIXED 타입
 *   }],
 *   options: [{
 *     id, code, name, price, unit: '개'|'식',
 *     categoryIds: []  // 빈 배열이면 모든 카테고리에 적용
 *   }],
 *   vendors: [{ id, name, bizNo, ceo, phone, email, note }],
 *   products: [{ id, categoryId, name, spec, unit, ecountCode, vendorPrices, note, updatedAt }]
 * }
 */

const fs = require('fs');
const path = require('path');

const DB_PATH = path.join(__dirname, 'data', 'db.json');
const CONTACTS_DB_PATH = path.join(__dirname, 'data', 'contacts-db.json');

function ensureDir() {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function load() {
  ensureDir();
  if (!fs.existsSync(DB_PATH)) {
    const init = {
      categories: [
        { id: 'cat_bn', name: '현수막', code: 'BN', pricingType: 'SIZE', unit: '㎡', tiers: [] },
        { id: 'cat_fm', name: '포맥스', code: 'FM', pricingType: 'SIZE', unit: '㎡', tiers: [] },
        { id: 'cat_st', name: '스티커', code: 'ST', pricingType: 'SIZE', unit: '㎡', tiers: [] },
        { id: 'cat_sb', name: '간판', code: 'SB', pricingType: 'SIZE', unit: '㎡', tiers: [] },
        { id: 'cat_sg', name: '표지판', code: 'SG', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
        { id: 'cat_hm', name: '안전모', code: 'HM', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
        { id: 'cat_tp', name: '타포린', code: 'TP', pricingType: 'SIZE', unit: '㎡', tiers: [] },
        { id: 'cat_fx', name: '후렉스', code: 'FX', pricingType: 'SIZE', unit: '㎡', tiers: [] },
        { id: 'cat_vs', name: '조끼', code: 'VS', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
        { id: 'cat_pv', name: 'PVC망', code: 'PV', pricingType: 'SIZE', unit: '㎡', tiers: [] },
        { id: 'cat_bb', name: '게시판', code: 'BB', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
        { id: 'cat_mg', name: '고무자석', code: 'MG', pricingType: 'SIZE', unit: '㎡', tiers: [] },
        { id: 'cat_wb', name: '화이트보드', code: 'WB', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
        { id: 'cat_wd', name: '윈드배너', code: 'WD', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
        { id: 'cat_tl', name: '공도구', code: 'TL', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
        { id: 'cat_rs', name: '근로자휴게실', code: 'RS', pricingType: 'FIXED', unit: '식', fixedPrice: 0, tiers: [] },
        { id: 'cat_cp', name: '캠페인', code: 'CP', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
        { id: 'cat_pe', name: 'PE/아크릴용품', code: 'PE', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
        { id: 'cat_fb', name: '폼보드', code: 'FB', pricingType: 'SIZE', unit: '㎡', tiers: [] },
        { id: 'cat_etc', name: '기타', code: 'ETC', pricingType: 'QTY', unit: '개', qtyPrice: 0, tiers: [] },
      ],
      options: [],
      vendors: [],
      products: []
    };
    save(init);
    return init;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(DB_PATH, 'utf8').replace(/\0/g, ''));
  } catch(e) {
    // 파일이 깨졌으면 백업에서 복구 시도
    const backupPath = DB_PATH + '.bak';
    if (fs.existsSync(backupPath)) {
      console.warn('⚠️ db.json 손상 감지 → 백업에서 복구합니다');
      data = JSON.parse(fs.readFileSync(backupPath, 'utf8').replace(/\0/g, ''));
      fs.copyFileSync(backupPath, DB_PATH);
    } else {
      throw new Error('db.json 손상됨 (백업 없음): ' + e.message);
    }
  }
  // 마이그레이션: 필수 배열 없으면 추가
  if (!data.options) data.options = [];
  if (!data.vendorPrices) data.vendorPrices = [];
  if (!data.users) data.users = [];
  return data;
}

function save(data) {
  ensureDir();
  const json = JSON.stringify(data, null, 2);
  // 안전장치: 먼저 임시 파일에 쓰고, 성공하면 rename (atomic write)
  const tmpPath = DB_PATH + '.tmp';
  const backupPath = DB_PATH + '.bak';
  try {
    fs.writeFileSync(tmpPath, json, 'utf8');
    // 검증: 임시 파일이 정상 JSON인지 확인
    JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    // 기존 파일 백업
    if (fs.existsSync(DB_PATH)) {
      try { fs.copyFileSync(DB_PATH, backupPath); } catch(e) {}
    }
    // 원자적 교체
    fs.renameSync(tmpPath, DB_PATH);
  } catch(e) {
    // 실패 시 임시 파일 정리
    try { fs.unlinkSync(tmpPath); } catch(e2) {}
    console.error('❌ db.json 저장 실패:', e.message);
    throw e;
  }
}

function generateId(prefix = 'id') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
}

// ── 연락처 전용 DB ──
function loadContacts() {
  ensureDir();
  if (!fs.existsSync(CONTACTS_DB_PATH)) {
    // 최초 실행: 기존 db.json에서 연락처 데이터 분리
    const main = load();
    const contactData = {
      contactCompanies: main.contactCompanies || [],
      contactProjects: main.contactProjects || [],
      contacts: main.contacts || []
    };
    saveContacts(contactData);
    // 기존 db.json에서 연락처 키 제거
    delete main.contactCompanies;
    delete main.contactProjects;
    delete main.contacts;
    save(main);
    return contactData;
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(CONTACTS_DB_PATH, 'utf8').replace(/\0/g, ''));
  } catch(e) {
    const backupPath = CONTACTS_DB_PATH + '.bak';
    if (fs.existsSync(backupPath)) {
      console.warn('⚠️ contacts-db.json 손상 감지 → 백업에서 복구합니다');
      data = JSON.parse(fs.readFileSync(backupPath, 'utf8').replace(/\0/g, ''));
      fs.copyFileSync(backupPath, CONTACTS_DB_PATH);
    } else {
      throw new Error('contacts-db.json 손상됨 (백업 없음): ' + e.message);
    }
  }
  if (!data.contactCompanies) data.contactCompanies = [];
  if (!data.contactProjects) data.contactProjects = [];
  if (!data.contacts) data.contacts = [];
  return data;
}

function saveContacts(data) {
  ensureDir();
  const json = JSON.stringify(data, null, 2);
  const tmpPath = CONTACTS_DB_PATH + '.tmp';
  const backupPath = CONTACTS_DB_PATH + '.bak';
  try {
    fs.writeFileSync(tmpPath, json, 'utf8');
    JSON.parse(fs.readFileSync(tmpPath, 'utf8'));
    if (fs.existsSync(CONTACTS_DB_PATH)) {
      try { fs.copyFileSync(CONTACTS_DB_PATH, backupPath); } catch(e) {}
    }
    fs.renameSync(tmpPath, CONTACTS_DB_PATH);
  } catch(e) {
    try { fs.unlinkSync(tmpPath); } catch(e2) {}
    console.error('❌ contacts-db.json 저장 실패:', e.message);
    throw e;
  }
}

module.exports = { load, save, loadContacts, saveContacts, generateId };
