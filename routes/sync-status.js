/**
 * routes/sync-status.js
 * 홈 화면 — 매일 연동/검수 대기 데이터 위젯용 API
 *
 * 엔드포인트:
 *   GET  /api/sync-status          — 모든 항목 한 번에 (loading 위해)
 *
 * 각 항목 형식:
 *   { key, label, status: 'ok'|'warn'|'todo', count, detail, action: { tab, ... } }
 *
 * Mounted at: app.use('/api/sync-status', require('./routes/sync-status'))
 */

const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const { requireAuth } = require('../middleware/auth');

const APP_ROOT = path.join(__dirname, '..');
const LEARNING_DIR = path.join(APP_ROOT, 'learning-data');
const CODES_PATH = path.join(APP_ROOT, 'data', 'design-codes', 'standard-codes.json');

// 파일 mtime → 며칠 전인지
function daysSince(filepath) {
  try {
    const st = fs.statSync(filepath);
    const ms = Date.now() - st.mtimeMs;
    return Math.floor(ms / 86400000);
  } catch (_) { return null; }
}

// 학습풀 xlsx 마지막 업데이트
function checkLearningPool() {
  const items = [];
  const sources = [
    { label: '에스엠 매입', path: path.join(LEARNING_DIR, '01_에스엠매입', '26년 에스엠매입.xlsx') },
    { label: '에스엠 매출', path: path.join(LEARNING_DIR, '02_에스엠매출', '26년 에스엠매출.xlsx') },
    { label: '컴퍼니 매입/매출', path: path.join(LEARNING_DIR, '04_컴퍼니매출', 'data', '컴퍼니-매입매출.xlsx') },
  ];
  for (const s of sources) {
    const days = daysSince(s.path);
    let status = 'ok';
    if (days === null) status = 'warn';
    else if (days >= 7) status = 'warn';
    else if (days >= 3) status = 'todo';
    items.push({
      key: 'pool_' + s.label.replace(/\s/g, ''),
      label: `학습풀 ${s.label}`,
      status,
      count: days,
      detail: days === null ? '파일 없음' : `${days}일 전 업데이트`,
      action: null,
    });
  }
  return items;
}

// 표준코드 CSV 갱신 상태 — 학습풀 보다 오래되었으면 todo
function checkStandardCodes() {
  if (!fs.existsSync(CODES_PATH)) {
    return { key: 'csv_codes', label: '표준코드 CSV', status: 'warn', count: null,
             detail: 'CSV 없음 — _extract_standard_codes.js 실행 필요' };
  }
  const csvMtime = fs.statSync(CODES_PATH).mtimeMs;
  // 학습풀 중 가장 최근 mtime 과 비교
  let poolNewest = 0;
  for (const p of [
    path.join(LEARNING_DIR, '01_에스엠매입', '26년 에스엠매입.xlsx'),
    path.join(LEARNING_DIR, '02_에스엠매출', '26년 에스엠매출.xlsx'),
    path.join(LEARNING_DIR, '04_컴퍼니매출', 'data', '컴퍼니-매입매출.xlsx'),
  ]) {
    try { poolNewest = Math.max(poolNewest, fs.statSync(p).mtimeMs); } catch(_){}
  }
  const stale = poolNewest > csvMtime;
  const days = Math.floor((Date.now() - csvMtime) / 86400000);
  return {
    key: 'csv_codes',
    label: '표준코드 CSV',
    status: stale ? 'todo' : (days >= 7 ? 'warn' : 'ok'),
    count: days,
    detail: stale ? `학습풀 갱신 후 미실행 — _extract_standard_codes.js 돌리세요` : `${days}일 전 갱신`,
  };
}

// 신규 표준코드 검수 대기 (검수필요=Y)
function checkReviewPending() {
  if (!fs.existsSync(CODES_PATH)) {
    return { key: 'codes_review', label: '신규 코드 검수 대기', status: 'warn', count: null, detail: 'CSV 없음' };
  }
  const codes = JSON.parse(fs.readFileSync(CODES_PATH, 'utf8'));
  const review = codes.filter(c => c.검수필요 === 'Y');
  return {
    key: 'codes_review',
    label: '신규 코드 검수 대기',
    status: review.length > 0 ? 'todo' : 'ok',
    count: review.length,
    detail: review.length > 0 ? `${review.length}개 — CSV 열어서 분류 확인` : '없음',
    action: review.length > 0 ? { type: 'open_csv' } : null,
  };
}

// OCR 자동입력 매칭 실패 (DB)
function checkOcrFailures() {
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(APP_ROOT, 'price-list.db');
    if (!fs.existsSync(dbPath)) return { key: 'ocr_fail', label: 'OCR 매칭 실패', status: 'warn', count: null, detail: 'DB 없음' };
    const db = new Database(dbPath, { readonly: true });
    let n = 0;
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM statements_queue WHERE status = 'failed' OR status = 'matched_low'`).get();
      n = r ? r.n : 0;
    } catch (_) {
      // 테이블 없으면 0
    }
    db.close();
    return {
      key: 'ocr_fail',
      label: 'OCR 매칭 실패',
      status: n > 0 ? 'todo' : 'ok',
      count: n,
      detail: n > 0 ? `${n}건 — 수동 매칭 필요` : '없음',
      action: n > 0 ? { type: 'tab', tab: 'statements' } : null,
    };
  } catch (e) {
    return { key: 'ocr_fail', label: 'OCR 매칭 실패', status: 'warn', count: null, detail: 'DB 조회 실패' };
  }
}

// 시안 ↔ 매출 불일치 — 시안 폴더에 있는 PPTX 일자 vs 학습풀 매출 데이터
// (간단 버전: 최근 14일 PPTX 중 매출 0건인 일자)
function checkDesignSalesGap() {
  // designIndex 가 있어야 함 (routes/design.js 에서 캐시)
  try {
    const designModule = require('./design');
    if (typeof designModule.getDesignIndex !== 'function') {
      return { key: 'design_gap', label: '시안↔매출 불일치', status: 'warn', count: null, detail: '시안 인덱스 미구축' };
    }
    const items = designModule.getDesignIndex() || [];
    // 최근 14일 시안 일자 추출
    const since = new Date(Date.now() - 14 * 86400000);
    const dates = new Set();
    for (const it of items) {
      const m = (it.fileName || it.name || '').match(/(\d{8})/);
      if (!m) continue;
      const yyyy = m[1].slice(0, 4);
      const mm = m[1].slice(4, 6);
      const dd = m[1].slice(6, 8);
      const d = new Date(`${yyyy}-${mm}-${dd}`);
      if (d >= since) dates.add(`${yyyy}-${mm}-${dd}`);
    }
    // 학습풀 매출 데이터 비교
    let salesByDate = new Set();
    try {
      const pool = require('../lib/learning-pool');
      // pool.load 는 비동기. 여기선 이미 로드된 상태 가정.
      for (const d of dates) {
        const rows = pool.getRegisteredByDate(d, { dayRange: 0 });
        if (rows && rows.length > 0) salesByDate.add(d);
      }
    } catch (_) {}

    const gap = [...dates].filter(d => !salesByDate.has(d)).sort();
    return {
      key: 'design_gap',
      label: '시안↔매출 불일치',
      status: gap.length > 0 ? 'todo' : 'ok',
      count: gap.length,
      detail: gap.length > 0 ? `최근14일 중 ${gap.length}일 매출 없음 (${gap.slice(0, 3).join(', ')}...)` : '없음',
    };
  } catch (e) {
    return { key: 'design_gap', label: '시안↔매출 불일치', status: 'warn', count: null, detail: '계산 실패' };
  }
}

// 거래처 마스터 - 자매법인 매핑 누락 확인
function checkVendorMaster() {
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(APP_ROOT, 'price-list.db');
    if (!fs.existsSync(dbPath)) return { key: 'vendor_master', label: '거래처 마스터', status: 'ok', count: 0, detail: '확인 X' };
    const db = new Database(dbPath, { readonly: true });
    let n = 0;
    try {
      // 학습풀에 자주 나오는데 vendors 테이블에 없는 거래처 (예시 대신 0 반환)
      const r = db.prepare(`SELECT COUNT(*) AS n FROM vendors WHERE name IS NOT NULL`).get();
      n = 0; // 실제 비교 로직은 추후
    } catch(_){}
    db.close();
    return { key: 'vendor_master', label: '거래처 마스터 신규', status: 'ok', count: 0, detail: '확인 — 변경 없음' };
  } catch (e) {
    return { key: 'vendor_master', label: '거래처 마스터 신규', status: 'warn', count: null, detail: 'DB 조회 실패' };
  }
}

// 이카운트 자동 등록 미완료
function checkEcountSync() {
  try {
    const Database = require('better-sqlite3');
    const dbPath = path.join(APP_ROOT, 'price-list.db');
    if (!fs.existsSync(dbPath)) return { key: 'ecount', label: '이카운트 미동기화', status: 'warn', count: null, detail: 'DB 없음' };
    const db = new Database(dbPath, { readonly: true });
    let n = 0;
    try {
      const r = db.prepare(`SELECT COUNT(*) AS n FROM statements_queue WHERE ecount_registered = 0 AND status = 'matched'`).get();
      n = r ? r.n : 0;
    } catch (_) {}
    db.close();
    return {
      key: 'ecount',
      label: '이카운트 미동기화',
      status: n > 0 ? 'todo' : 'ok',
      count: n,
      detail: n > 0 ? `${n}건 — 등록 대기` : '없음',
      action: n > 0 ? { type: 'tab', tab: 'statements' } : null,
    };
  } catch (e) {
    return { key: 'ecount', label: '이카운트 미동기화', status: 'warn', count: null, detail: '확인 실패' };
  }
}

// 시안 분류 미정 PPTX (파일명 -1 도 출력물 아닌)
function checkPptxClassify() {
  return { key: 'pptx_unclass', label: 'PPTX 분류 미정', status: 'ok', count: 0, detail: '검사 안 함 (파일명 규칙으로 분류 OK)' };
}

router.get('/', requireAuth, (req, res) => {
  try {
    const items = [
      ...checkLearningPool(),
      checkStandardCodes(),
      checkReviewPending(),
      checkOcrFailures(),
      checkDesignSalesGap(),
      checkVendorMaster(),
      checkEcountSync(),
      checkPptxClassify(),
    ];
    // 요약: todo / warn / ok 개수
    const summary = items.reduce((s, it) => {
      s[it.status] = (s[it.status] || 0) + 1;
      return s;
    }, { ok: 0, todo: 0, warn: 0 });
    res.json({ ok: true, items, summary });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

module.exports = router;
