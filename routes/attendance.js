/**
 * routes/attendance.js — 출퇴근 관리 (CAPS Bridge) + 연차관리
 * Mounted at: app.use('/api', require('./routes/attendance'))
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
const tls = require('tls');
const db = require('../db');
const { requireAuth, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { safeBody } = require('../middleware/sanitize');
const { notify, notifyRole } = require('../utils/notify');

// ── 출퇴근 관리 (CAPS Bridge 연동) ───────────────────────
// ══════════════════════════════════════════════════════════

const CAPS_BRIDGE_URL = 'http://192.168.0.30:3001';
const http = require('http');

// ── CAPS 데이터 캐시 ──────────────────────────────────
// ── attendanceNotes 마이그레이션 (품목관리.json → 출퇴근관리.json) ──
(function migrateAttendanceNotes() {
  try {
    const oldPath = path.join(__dirname, '..', 'data', '품목관리.json');
    if (!fs.existsSync(oldPath)) return;
    const oldData = JSON.parse(fs.readFileSync(oldPath, 'utf8'));
    const hasNotes = oldData.attendanceNotes && Object.keys(oldData.attendanceNotes).length > 0;
    const hasRequests = oldData.attendanceRequests && oldData.attendanceRequests.length > 0;
    if (!hasNotes && !hasRequests) return;

    const newData = db.출퇴근관리.load();
    if (hasNotes && (!newData.attendanceNotes || Object.keys(newData.attendanceNotes).length === 0)) {
      newData.attendanceNotes = oldData.attendanceNotes;
      console.log(`✅ attendanceNotes ${Object.keys(oldData.attendanceNotes).length}건 마이그레이션 완료`);
    }
    if (hasRequests && (!newData.attendanceRequests || newData.attendanceRequests.length === 0)) {
      newData.attendanceRequests = oldData.attendanceRequests;
      console.log(`✅ attendanceRequests ${oldData.attendanceRequests.length}건 마이그레이션 완료`);
    }
    db.출퇴근관리.save(newData);

    // 원본에서 제거
    delete oldData.attendanceNotes;
    delete oldData.attendanceRequests;
    fs.writeFileSync(oldPath, JSON.stringify(oldData, null, 2), 'utf8');
    console.log('✅ 품목관리.json에서 출퇴근 데이터 분리 완료');
  } catch(e) {
    console.warn('⚠️ attendanceNotes 마이그레이션 실패 (무시 가능):', e.message);
  }
})();

// ── 출퇴근 데이터 영구 저장소 (키별 개별 파일) ──────────────
const ATTENDANCE_STORE_DIR = path.join(__dirname, '..', 'data', 'attendance-store');
if (!fs.existsSync(ATTENDANCE_STORE_DIR)) fs.mkdirSync(ATTENDANCE_STORE_DIR, { recursive: true });

// 캐시 키 → 안전한 파일명 변환
function cacheKeyToFile(key) {
  // 한글 포함 키를 안전한 파일명으로 변환 (hex 인코딩)
  const safe = Buffer.from(key, 'utf8').toString('hex');
  return path.join(ATTENDANCE_STORE_DIR, safe + '.json');
}

// 기존 캐시 파일 마이그레이션 (구버전 파일명 → hex 파일명)
(function migrateOldCacheFiles() {
  try {
    const files = fs.readdirSync(ATTENDANCE_STORE_DIR).filter(f => f.endsWith('.json'));
    let migrated = 0;
    for (const f of files) {
      // hex 파일은 [0-9a-f]+ 패턴이므로 그 외 문자가 있으면 구버전
      const baseName = f.replace('.json', '');
      if (/^[0-9a-f]+$/.test(baseName)) continue; // 이미 hex
      const filePath = path.join(ATTENDANCE_STORE_DIR, f);
      try {
        const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (d._key) {
          const newPath = cacheKeyToFile(d._key);
          if (!fs.existsSync(newPath)) {
            fs.copyFileSync(filePath, newPath);
          }
          fs.unlinkSync(filePath);
          migrated++;
        }
      } catch(e) { /* 개별 파일 실패 무시 */ }
    }
    if (migrated > 0) console.log(`✅ 캐시 파일 ${migrated}건 마이그레이션 완료 (hex 파일명)`);
  } catch(e) { /* 무시 */ }
})();

function loadAttendanceCache() {
  // 하위 호환: 기존 단일 캐시 파일 (bridge-status용)
  const files = fs.readdirSync(ATTENDANCE_STORE_DIR).filter(f => f.endsWith('.json'));
  const cache = {};
  for (const f of files) {
    try {
      const d = JSON.parse(fs.readFileSync(path.join(ATTENDANCE_STORE_DIR, f), 'utf8'));
      cache[d._key || f.replace('.json', '')] = d;
    } catch(e) { /* 개별 파일 깨져도 무시 */ }
  }
  return cache;
}

function setCacheEntry(cacheKey, data) {
  const filePath = cacheKeyToFile(cacheKey);
  const tmpPath = filePath + '.tmp';
  try {
    const content = JSON.stringify({ _key: cacheKey, data, savedAt: new Date().toISOString() });
    fs.writeFileSync(tmpPath, content, 'utf8');
    fs.renameSync(tmpPath, filePath); // atomic replace
    console.log(`[저장] ${cacheKey} → ${path.basename(filePath)} (${Math.round(content.length/1024)}KB)`);
  } catch(e) {
    console.error('[저장 오류]', cacheKey, e.message);
    try { fs.unlinkSync(tmpPath); } catch(_) {}
  }
}

function getCacheEntry(cacheKey) {
  const filePath = cacheKeyToFile(cacheKey);
  try {
    if (fs.existsSync(filePath)) {
      const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return d.data;
    }
  } catch(e) { console.error('[읽기 오류]', cacheKey, e.message); }
  return null;
}

// 기존 단일 캐시 파일 → 개별 파일로 마이그레이션
const OLD_CACHE_FILE = path.join(__dirname, '..', 'data', 'attendance-cache.json');
if (fs.existsSync(OLD_CACHE_FILE)) {
  try {
    const old = JSON.parse(fs.readFileSync(OLD_CACHE_FILE, 'utf8'));
    let count = 0;
    for (const [k, v] of Object.entries(old)) {
      if (v && v.data) { setCacheEntry(k, v.data); count++; }
    }
    if (count > 0) {
      console.log(`[마이그레이션] 기존 캐시 ${count}건 → 개별 파일 변환 완료`);
      fs.renameSync(OLD_CACHE_FILE, OLD_CACHE_FILE + '.bak');
    }
  } catch(e) {
    console.log('[마이그레이션] 기존 캐시 파일 깨짐, 무시:', e.message);
    fs.renameSync(OLD_CACHE_FILE, OLD_CACHE_FILE + '.broken');
  }
}

// CAPS bridge HTTP GET helper (외부 모듈 없이 내장 http 사용)
function capsGet(path, timeoutMs) {
  const socketTimeout = timeoutMs || 5000;   // 기본 5초 (기존 8초에서 단축)
  const hardTimeout = socketTimeout + 2000;   // 하드 타임아웃: 소켓 + 2초
  return new Promise((resolve, reject) => {
    const url = CAPS_BRIDGE_URL + path;
    let settled = false;
    const done = (fn, val) => { if (!settled) { settled = true; fn(val); } };
    const req = http.get(url, { timeout: socketTimeout }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { done(resolve, JSON.parse(data)); }
        catch (e) { done(reject, new Error('JSON 파싱 오류: ' + data.slice(0, 100))); }
      });
    });
    req.on('error', (e) => done(reject, e));
    req.on('timeout', () => { req.destroy(); done(reject, new Error('CAPS Bridge 연결 시간초과')); });
    // 하드 타임아웃: req.destroy()로 TCP 연결 강제 종료 (연결 누적 방지)
    setTimeout(() => { req.destroy(); done(reject, new Error('CAPS Bridge 하드 타임아웃')); }, hardTimeout);
  });
}

// ─────────────────────────────────────────────────────────
// 출퇴근 계산 로직
// ─────────────────────────────────────────────────────────
// 시간 문자열 "HH:MM" → 분 변환
function timeToMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// 분 → "H시간 M분" 문자열
function minToHHMM(min) {
  if (min === null || min === undefined || min <= 0) return '0분';
  const h = Math.floor(min / 60);
  const m = min % 60;
  if (h === 0) return `${m}분`;
  if (m === 0) return `${h}시간`;
  return `${h}시간 ${m}분`;
}

// 분 → 소수점 시간 (1시간=1.00, 30분=0.50, 소수점 2자리)
function minToDecimalHours(min) {
  if (min === null || min === undefined || min <= 0) return 0;
  return Math.round((min / 60) * 100) / 100;
}

// ── 한국 공휴일 (2025~2027) ──
const KOREAN_HOLIDAYS = {
  // 2025
  '2025-01-01': '신정', '2025-01-28': '설날 전날', '2025-01-29': '설날', '2025-01-30': '설날 다음날',
  '2025-03-01': '삼일절', '2025-03-03': '삼일절 대체공휴일',
  '2025-05-05': '어린이날', '2025-05-06': '석가탄신일',
  '2025-06-06': '현충일', '2025-08-15': '광복절',
  '2025-10-03': '개천절', '2025-10-05': '추석 전날', '2025-10-06': '추석', '2025-10-07': '추석 다음날', '2025-10-08': '추석 대체공휴일', '2025-10-09': '한글날',
  '2025-12-25': '성탄절',
  // 2026
  '2026-01-01': '신정', '2026-02-16': '설날 전날', '2026-02-17': '설날', '2026-02-18': '설날 다음날',
  '2026-03-01': '삼일절', '2026-03-02': '삼일절 대체공휴일',
  '2026-05-05': '어린이날', '2026-05-24': '석가탄신일', '2026-05-25': '석가탄신일 대체공휴일',
  '2026-06-06': '현충일',
  '2026-08-15': '광복절', '2026-08-17': '광복절 대체공휴일',
  '2026-09-24': '추석 전날', '2026-09-25': '추석', '2026-09-26': '추석 다음날',
  '2026-10-03': '개천절', '2026-10-05': '개천절 대체공휴일', '2026-10-09': '한글날',
  '2026-12-25': '성탄절',
  // 2027
  '2027-01-01': '신정', '2027-02-06': '설날 전날', '2027-02-07': '설날', '2027-02-08': '설날 다음날', '2027-02-09': '설날 대체공휴일',
  '2027-03-01': '삼일절', '2027-05-05': '어린이날', '2027-05-13': '석가탄신일',
  '2027-06-06': '현충일', '2027-06-07': '현충일 대체공휴일',
  '2027-08-15': '광복절', '2027-08-16': '광복절 대체공휴일',
  '2027-09-14': '추석 전날', '2027-09-15': '추석', '2027-09-16': '추석 다음날',
  '2027-10-03': '개천절', '2027-10-04': '개천절 대체공휴일', '2027-10-09': '한글날', '2027-10-11': '한글날 대체공휴일',
  '2027-12-25': '성탄절',
};

function isKoreanHoliday(dateStr) {
  return KOREAN_HOLIDAYS[dateStr] || null;
}

// 공휴일 목록 API
router.get('/holidays', (req, res) => {
  res.json(KOREAN_HOLIDAYS);
});

/**
 * 출퇴근 기록 1건 분석
 * @param {Object} rec - caps-bridge에서 받은 레코드 (inTime, outTime, date 등)
 * @returns {Object} 분석 결과
 */
function analyzeRecord(rec) {
  const holidayName = isKoreanHoliday(rec.date);
  const result = {
    employeeId: rec.name,
    employeeName: rec.name,
    date: rec.date,
    inTime: rec.inTime,
    outTime: rec.outTime,
    leaveType: 'normal',
    leaveLabel: '정상',
    reviewStatus: 'normal',  // normal | needsReview | confirmed
    late: false,
    lateMinutes: 0,
    overtime: 0,
    overtimeLabel: '',
    overtimeHours: 0,
    note: '',
    holiday: holidayName || null,
  };

  const inMin  = timeToMin(rec.inTime);
  const outMin = timeToMin(rec.outTime);

  const WORK_START  = 8 * 60 + 30;   // 08:30
  const HALF_AM_IN  = 14 * 60;        // 오전반차 출근 = 14:00
  const HALF_PM_OUT = 11 * 60 + 30;   // 오후반차 퇴근 = 11:30
  const OT_BASE     = 19 * 60;        // 추가근무 기준
  const PREP_MIN    = 15;

  // ── 주말/공휴일
  const dt = new Date(rec.date + 'T00:00:00');
  const dayOfWeek = dt.getDay();
  if (holidayName && !inMin && !outMin) {
    result.leaveType = 'holiday';
    result.leaveLabel = holidayName;
    return result;
  }
  if ((dayOfWeek === 0 || dayOfWeek === 6) && !inMin && !outMin) {
    result.leaveType = 'weekend';
    result.leaveLabel = dayOfWeek === 0 ? '일요일' : '토요일';
    return result;
  }

  // ── 출퇴근 미기록 → 확인필요
  if (!inMin && !outMin && dayOfWeek !== 0 && dayOfWeek !== 6) {
    result.leaveType = 'noRecord';
    result.leaveLabel = '전체미기록';
    result.reviewStatus = 'needsReview';
    return result;
  }
  if (!inMin && outMin) {
    result.leaveType = 'noSwipeIn';
    result.leaveLabel = '출근미기록';
    result.reviewStatus = 'needsReview';
    return result;
  }
  if (inMin && !outMin && dayOfWeek !== 0 && dayOfWeek !== 6) {
    result.leaveType = 'noSwipeOut';
    result.leaveLabel = '퇴근미기록';
    result.reviewStatus = 'needsReview';
    return result;
  }

  // ── 오전반차 추정: 13:30~14:30 출근 → 확인필요
  if (inMin >= HALF_AM_IN - 30 && inMin <= HALF_AM_IN + 30) {
    result.leaveType = 'halfAM';
    result.leaveLabel = '오전반차(추정)';
    result.reviewStatus = 'needsReview';
  }
  // ── 오후반차 추정: 11:00~12:00 퇴근 → 확인필요
  else if (outMin && outMin >= HALF_PM_OUT - 30 && outMin <= HALF_PM_OUT + 30) {
    result.leaveType = 'halfPM';
    result.leaveLabel = '오후반차(추정)';
    result.reviewStatus = 'needsReview';
  }
  // ── 16시 이후 출근 → 확인필요
  else if (inMin >= 16 * 60) {
    result.leaveType = 'unknown';
    result.leaveLabel = '확인필요';
    result.reviewStatus = 'needsReview';
  }
  else {
    result.leaveType = 'normal';
    result.leaveLabel = '정상';
    result.reviewStatus = 'normal';
  }

  // ── 지각 체크 (반차/확인필요 제외)
  if (result.leaveType === 'normal' && inMin > WORK_START) {
    result.late = true;
    result.lateMinutes = inMin - WORK_START;
  }

  // ── 추가근무 계산
  if (outMin && result.leaveType !== 'unknown') {
    if (outMin > OT_BASE) {
      const raw = outMin - OT_BASE - PREP_MIN;
      result.overtime = Math.max(0, raw);
    }
    if (result.overtime > 0) {
      result.overtimeLabel = minToHHMM(result.overtime);
      result.overtimeHours = minToDecimalHours(result.overtime);
    }
  }

  return result;
}

// ─────────────────────────────────────────────────────────
// API: 브릿지 헬스체크 (30초 캐시 — 반복 호출 시 CAPS 브릿지 안 찔름)
// GET /api/attendance/bridge-status
// ─────────────────────────────────────────────────────────
let _bridgeStatusCache = null;  // { ts, data }
const BRIDGE_CACHE_TTL = 30000; // 30초

router.get('/attendance/bridge-status', requireAuth, async (req, res) => {
  // admin 아닌 사용자: 항상 캐시 모드 OK 반환 (브릿지 체크 불필요)
  if (req.user.role !== 'admin') {
    const files = fs.readdirSync(ATTENDANCE_STORE_DIR).filter(f => f.endsWith('.json'));
    return res.json({ connected: false, hasCache: files.length > 0, cacheOnly: true });
  }
  // 30초 이내 재요청 시 캐시된 결과 즉시 반환 (브라우저 연결 점유 방지)
  if (_bridgeStatusCache && (Date.now() - _bridgeStatusCache.ts) < BRIDGE_CACHE_TTL) {
    return res.json(_bridgeStatusCache.data);
  }
  try {
    const data = await capsGet('/health', 3000);  // 헬스체크는 3초 타임아웃
    const result = { connected: true, hasCache: true, ...data };
    _bridgeStatusCache = { ts: Date.now(), data: result };
    res.json(result);
  } catch (err) {
    const files = fs.readdirSync(ATTENDANCE_STORE_DIR).filter(f => f.endsWith('.json'));
    const result = { connected: false, hasCache: files.length > 0, error: err.message };
    _bridgeStatusCache = { ts: Date.now(), data: result };
    res.json(result);
  }
});

// ─────────────────────────────────────────────────────────
// API: 출퇴근 수동 노트 (잘못된 분류 수정용)
// GET  /api/attendance/notes        → 전체 노트 반환
// PUT  /api/attendance/notes/:key   → 노트 저장 (key = "이름_YYYY-MM-DD")
// DELETE /api/attendance/notes/:key → 노트 삭제 (자동 분류로 복원)
// ─────────────────────────────────────────────────────────
router.get('/attendance/notes', requireAuth, (req, res) => {
  const data = db.출퇴근관리.load();
  res.json(data.attendanceNotes || {});
});

router.put('/attendance/notes/:key', requireAuth, (req, res) => {
  const canEdit = req.user.role === 'admin';
  if (!canEdit) return res.status(403).json({ error: '권한 없음' });
  const data = db.출퇴근관리.load();
  if (!data.attendanceNotes) data.attendanceNotes = {};
  const existing = data.attendanceNotes[req.params.key] || {};
  const updated = {
    ...existing,
    leaveType:  req.body.leaveType  ?? existing.leaveType ?? '',
    leaveLabel: req.body.leaveLabel ?? existing.leaveLabel ?? '',
    note:       req.body.note       ?? existing.note ?? '',
    updatedBy:  req.user.name,
    updatedAt:  new Date().toISOString(),
  };
  // 출퇴근 시간 수정 저장 (관리자 전용)
  if (req.body.modifiedInTime !== undefined) updated.modifiedInTime = req.body.modifiedInTime;
  if (req.body.modifiedOutTime !== undefined) updated.modifiedOutTime = req.body.modifiedOutTime;
  data.attendanceNotes[req.params.key] = updated;
  db.출퇴근관리.save(data);

  // ── 연차관리 연동: 연차/반차이면 leaveRecords에 동기화 ──
  const parts = req.params.key.match(/^(.+)_(\d{4}-\d{2}-\d{2})$/);
  if (parts) {
    const [, empName, dateStr] = parts;
    const lt = updated.leaveType;
    const leaveData = db['연차관리'].load();
    if (!leaveData.leaveRecords) leaveData.leaveRecords = [];
    // 기존 출결연동 레코드 제거
    leaveData.leaveRecords = leaveData.leaveRecords.filter(r =>
      !(r.employeeName === empName && r.date === dateStr && r.source === 'attendance')
    );
    // 연차/반차이면 새로 추가 (단, 같은 날 결재 승인 연차가 이미 있으면 중복 추가 안 함)
    if (lt === 'annual' || lt === 'halfAM' || lt === 'halfPM') {
      const alreadyHasApproval = leaveData.leaveRecords.some(r =>
        r.employeeName === empName && r.date === dateStr && r.approvalId
      );
      if (!alreadyHasApproval) {
        const annualDays = lt === 'annual' ? 1 : 0.5;
        leaveData.leaveRecords.push({
          id: Date.now(),
          employeeName: empName,
          date: dateStr,
          leaveType: lt === 'annual' ? '연차' : (lt === 'halfAM' ? '오전반차' : '오후반차'),
          annualDays,
          nonAnnualDays: 0,
          note: '출결기록 자동연동',
          source: 'attendance',
          createdAt: new Date().toISOString(),
        });
      }
    }
    db['연차관리'].save(leaveData);
  }

  res.json({ ok: true });
});

router.delete('/attendance/notes/:key', requireAuth, (req, res) => {
  const canEdit = req.user.role === 'admin';
  if (!canEdit) return res.status(403).json({ error: '권한 없음' });
  const data = db.출퇴근관리.load();
  if (data.attendanceNotes) {
    delete data.attendanceNotes[req.params.key];
    db.출퇴근관리.save(data);
  }
  // ── 연차관리에서도 해당 날짜 레코드 제거 (결재승인 제외) ──
  const parts = req.params.key.match(/^(.+)_(\d{4}-\d{2}-\d{2})$/);
  if (parts) {
    const [, empName, dateStr] = parts;
    const leaveData = db['연차관리'].load();
    if (leaveData.leaveRecords) {
      leaveData.leaveRecords = leaveData.leaveRecords.filter(r =>
        // 결재 승인된 기록은 결재 탭에서 별도 관리하므로 유지, 나머지는 삭제
        !(r.employeeName === empName && r.date === dateStr && !r.approvalId)
      );
      db['연차관리'].save(leaveData);
    }
  }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────
// API: 출퇴근 시간 수정 요청 (일반 사용자 → 관리자)
// ─────────────────────────────────────────────────────────
router.get('/attendance/requests', requireAuth, (req, res) => {
  const data = db.출퇴근관리.load();
  const requests = data.attendanceRequests || [];
  const isAdmin = req.user.role === 'admin' || (req.user.permissions || []).includes('attendance_all');
  // 관리자: 전체, 일반: 본인만
  const filtered = isAdmin ? requests : requests.filter(r => r.empName === req.user.name);
  res.json(filtered);
});

router.post('/attendance/requests', requireAuth, (req, res) => {
  const { date, requestedInTime, requestedOutTime, reason } = req.body;
  if (!date) return res.status(400).json({ error: 'date 필요' });
  const data = db.출퇴근관리.load();
  if (!data.attendanceRequests) data.attendanceRequests = [];
  const newReq = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    empName: req.user.name,
    date,
    requestedInTime: requestedInTime || null,
    requestedOutTime: requestedOutTime || null,
    reason: reason || '',
    status: 'pending', // pending | approved | rejected
    createdAt: new Date().toISOString(),
  };
  data.attendanceRequests.push(newReq);
  db.출퇴근관리.save(data);
  res.json(newReq);
});

router.put('/attendance/requests/:id', requireAuth, (req, res) => {
  const isAdmin = req.user.role === 'admin' || (req.user.permissions || []).includes('attendance_all');
  if (!isAdmin) return res.status(403).json({ error: '관리자만 처리 가능' });
  const data = db.출퇴근관리.load();
  const requests = data.attendanceRequests || [];
  const reqItem = requests.find(r => r.id === req.params.id);
  if (!reqItem) return res.status(404).json({ error: '요청 없음' });

  reqItem.status = req.body.status || reqItem.status;
  reqItem.reviewedBy = req.user.name;
  reqItem.reviewedAt = new Date().toISOString();

  // 승인 시 → notes에 시간 자동 반영
  if (reqItem.status === 'approved') {
    if (!data.attendanceNotes) data.attendanceNotes = {};
    const nKey = `${reqItem.empName}_${reqItem.date}`;
    const existing = data.attendanceNotes[nKey] || {};
    if (reqItem.requestedInTime) existing.modifiedInTime = reqItem.requestedInTime;
    if (reqItem.requestedOutTime) existing.modifiedOutTime = reqItem.requestedOutTime;
    existing.updatedBy = req.user.name;
    existing.updatedAt = new Date().toISOString();
    data.attendanceNotes[nKey] = existing;
  }

  db.출퇴근관리.save(data);
  res.json(reqItem);
});

// ─────────────────────────────────────────────────────────
// API: 직원 목록 (CAPS)
// GET /api/attendance/employees
// ─────────────────────────────────────────────────────────
router.get('/attendance/employees', requireAuth, async (req, res) => {
  const cacheKey = 'employees';
  let data;

  if (req.user.role !== 'admin') {
    // 일반/팀장: 캐시에서만
    data = getCacheEntry(cacheKey);
    if (!data) return res.json([]); // 캐시 없으면 빈 목록
  } else {
    // admin: 브릿지 시도 → 실패 시 캐시
    try {
      data = await capsGet('/api/employees');
      setCacheEntry(cacheKey, data);
    } catch (err) {
      const cached = getCacheEntry(cacheKey);
      if (cached) { data = cached; }
      else return res.status(502).json({ error: 'CAPS 브릿지 연결 실패: ' + err.message });
    }
  }

  // 팀장 부서 필터: admin 아닌 attendance_all 권한자 또는 조직도 리더는 같은 부서 팀원만
  const userPerms = req.user.permissions || [];
  let canViewTeamEmp = userPerms.includes('attendance_all');
  let userDeptIdEmp = req.user.department;
  if (!canViewTeamEmp && req.user.role !== 'admin') {
    const uData2 = db.loadUsers();
    const me2 = (uData2.users || []).find(u => u.userId === req.user.userId);
    if (me2 && me2.department) {
      userDeptIdEmp = me2.department;
      const myDept = (uData2.departments || []).find(d => d.id === me2.department);
      if (myDept && myDept.leaderId === me2.id) canViewTeamEmp = true;
    }
  }
  if (req.user.role !== 'admin' && canViewTeamEmp && userDeptIdEmp) {
    const uData = db.loadUsers();
    const teamNames = (uData.users || [])
      .filter(u => u.department === userDeptIdEmp && u.status === 'approved')
      .map(u => u.name);
    if (!teamNames.includes(req.user.name)) teamNames.push(req.user.name);
    data = data.filter(emp => teamNames.includes(emp.name || emp.id));
  }

  res.json(data);
});

// ─────────────────────────────────────────────────────────
// API: 출퇴근 기록 + 분석
// GET /api/attendance/records?from=YYYY-MM-DD&to=YYYY-MM-DD[&employeeId=]
// ─────────────────────────────────────────────────────────
router.get('/attendance/records', requireAuth, async (req, res) => {
  const { from, to, employeeId } = req.query;
  if (!from || !to) return res.status(400).json({ error: 'from, to 파라미터 필요' });

  let url = `/api/attendance?from=${from}&to=${to}`;
  if (employeeId) url += `&employeeId=${encodeURIComponent(employeeId)}`;
  const cacheKey = `rec_${from}_${to}_${employeeId||'all'}`;

  let raw;
  let fromCache = false;

  if (req.user.role !== 'admin') {
    const allCacheKey = `rec_${from}_${to}_all`;
    raw = getCacheEntry(allCacheKey);
    if (!raw) return res.status(404).json({ error: '저장된 데이터가 없습니다. 관리자가 해당 월을 먼저 조회해야 합니다.' });
    fromCache = true;
  } else {
    try {
      raw = await capsGet(url);
      setCacheEntry(cacheKey, raw);
    } catch (err) {
      raw = getCacheEntry(cacheKey);
      if (!raw) return res.status(502).json({ error: 'CAPS 브릿지 연결 실패 (캐시 없음): ' + err.message });
      fromCache = true;
    }
  }

  const analyzed = raw.map(analyzeRecord);
  // 수동 노트 병합
  const dbData = db.출퇴근관리.load();
  const notes = dbData.attendanceNotes || {};
  const existingKeys = new Set(analyzed.map(r => `${r.employeeId}_${r.date}`));
  for (const r of analyzed) {
    const nKey = `${r.employeeId}_${r.date}`;
    if (notes[nKey]) {
      r.leaveType  = notes[nKey].leaveType  || r.leaveType;
      r.leaveLabel = notes[nKey].leaveLabel || r.leaveLabel;
      r.note       = notes[nKey].note || '';
      r.manuallySet = true;
      r.reviewStatus = 'confirmed';
      if (notes[nKey].modifiedInTime !== undefined) {
        r.originalInTime = r.originalInTime || r.inTime;
        r.inTime = notes[nKey].modifiedInTime;
        r.timeModified = true;
      }
      if (notes[nKey].modifiedOutTime !== undefined) {
        r.originalOutTime = r.originalOutTime || r.outTime;
        r.outTime = notes[nKey].modifiedOutTime;
        r.timeModified = true;
      }
    }
  }
  // CAPS에 기록이 없지만 수동 노트가 있는 날짜 → 가상 레코드 생성
  for (const [nKey, note] of Object.entries(notes)) {
    if (existingKeys.has(nKey)) continue;
    const parts = nKey.match(/^(.+)_(\d{4}-\d{2}-\d{2})$/);
    if (!parts) continue;
    const [, empName, date] = parts;
    if (date < from || date > to) continue;
    if (employeeId && empName !== employeeId) continue;
    analyzed.push({
      employeeId: empName, employeeName: empName, date,
      inTime: note.modifiedInTime || null, outTime: note.modifiedOutTime || null,
      leaveType: note.leaveType || 'annual', leaveLabel: note.leaveLabel || '연차',
      late: false, lateMinutes: 0, overtime: 0, overtimeLabel: '',
      note: note.note || '', manuallySet: true, reviewStatus: 'confirmed',
      timeModified: !!(note.modifiedInTime || note.modifiedOutTime),
    });
  }
  if (fromCache) {
    res.set('X-Data-Source', 'cache');
  }
  res.json(analyzed);
});

// ─────────────────────────────────────────────────────────
// API: 특정 월 캐시 강제 삭제 (응급 복구용)
// POST /api/attendance/purge-cache  body: { year, month }
// 출퇴근 요약 조회가 서버에서 행 걸릴 때 관리자가 UI에서 눌러 캐시를 지운다.
// 삭제 대상: sum_YYYY-MM-01_...__all, rec_YYYY-MM-01_...__all (+ employeeId별)
// ─────────────────────────────────────────────────────────
router.post('/attendance/purge-cache', requireAdmin, (req, res) => {
  const { year, month } = req.body || {};
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });
  const y = parseInt(year), m = parseInt(month);
  const from = `${y}-${String(m).padStart(2,'0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2,'0')}-${lastDay}`;
  // 삭제할 키 접두어: sum_YYYY-MM-01_YYYY-MM-LL_ / rec_YYYY-MM-01_YYYY-MM-LL_
  const prefixes = [ `sum_${from}_${to}_`, `rec_${from}_${to}_` ];
  const deleted = [];
  const errors = [];
  try {
    const files = fs.readdirSync(ATTENDANCE_STORE_DIR).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const filePath = path.join(ATTENDANCE_STORE_DIR, f);
      try {
        const d = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        const key = d._key || '';
        if (prefixes.some(p => key.startsWith(p))) {
          fs.unlinkSync(filePath);
          deleted.push(key);
        }
      } catch(e) { errors.push({ file: f, err: e.message }); }
    }
    console.log(`[캐시 강제삭제] admin=${req.user.name} ${from}~${to} 삭제=${deleted.length}건`);
    return res.json({ ok: true, deletedCount: deleted.length, deleted, errors });
  } catch (e) {
    return res.status(500).json({ error: '캐시 삭제 실패: ' + e.message });
  }
});

// ─────────────────────────────────────────────────────────
// API: 월별 요약
// GET /api/attendance/summary?year=2025&month=3[&employeeId=]
// ─────────────────────────────────────────────────────────
router.get('/attendance/summary', requireAuth, async (req, res) => {
  const { year, month, employeeId } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year, month 파라미터 필요' });

  const y = parseInt(year), m = parseInt(month);
  const from = `${y}-${String(m).padStart(2,'0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2,'0')}-${lastDay}`;

  // ── 권한별 필터: admin=전체, 팀장=부서원, 일반=본인 ──
  let teamMemberNames = null; // null이면 전체, 배열이면 해당 이름만
  const userPerms = req.user.permissions || [];
  // attendance_all 권한이 있거나, 조직도에서 부서 리더인 경우 팀 전체 조회 가능
  let canViewTeam = userPerms.includes('attendance_all');
  let userDeptId = req.user.department;
  const uDataOnce = (req.user.role !== 'admin') ? db.loadUsers() : null;
  if (!canViewTeam && req.user.role !== 'admin') {
    // 조직도에서 리더인지 자동 감지
    const me2 = (uDataOnce.users || []).find(u => u.userId === req.user.userId);
    if (me2 && me2.department) {
      userDeptId = me2.department;
      const myDept = (uDataOnce.departments || []).find(d => d.id === me2.department);
      if (myDept && myDept.leaderId === me2.id) canViewTeam = true;
    }
  }
  if (req.user.role !== 'admin' && canViewTeam && userDeptId) {
    // 팀장: 같은 부서 팀원만
    teamMemberNames = (uDataOnce.users || [])
      .filter(u => u.department === userDeptId && u.status === 'approved')
      .map(u => u.name);
    if (!teamMemberNames.includes(req.user.name)) teamMemberNames.push(req.user.name);
  } else if (req.user.role !== 'admin' && !canViewTeam) {
    // 일반 직원: 본인만
    teamMemberNames = [req.user.name];
  }

  let url = `/api/attendance?from=${from}&to=${to}`;
  if (employeeId) url += `&employeeId=${encodeURIComponent(employeeId)}`;
  const cacheKey = `sum_${from}_${to}_${employeeId||'all'}`;

  let raw;
  let fromCache = false;

  // admin이 아닌 사용자: 항상 'all' 캐시에서 읽음 (관리자가 동기화한 전체 데이터)
  if (req.user.role !== 'admin') {
    const allCacheKey = `sum_${from}_${to}_all`;
    raw = getCacheEntry(allCacheKey);
    if (!raw) return res.status(404).json({ error: '저장된 출퇴근 데이터가 없습니다. 관리자가 해당 월을 먼저 조회해야 합니다.' });
    fromCache = true;
  } else {
    // admin: 항상 캐시 우선, refresh=true일 때만 CAPS 요청
    const forceRefresh = req.query.refresh === 'true';
    const cached = getCacheEntry(cacheKey);
    if (forceRefresh) {
      try {
        raw = await capsGet(url);
        setCacheEntry(cacheKey, raw);
      } catch (err) {
        if (cached) { raw = cached; fromCache = true; }
        else return res.status(502).json({ error: 'CAPS 브릿지 연결 실패 (캐시 없음): ' + err.message });
      }
    } else if (cached) {
      raw = cached;
      fromCache = true;
    } else {
      return res.status(404).json({ error: '저장된 데이터가 없습니다. CAPS 동기화를 먼저 실행해주세요.' });
    }
  }

  let records = raw.map(analyzeRecord);

  // CAPS 이름 → 앱 이름 매핑 (capsName 필드 설정된 경우)
  // 예: CAPS에 "관리자"로 등록됐지만 앱 이름이 "남관원"인 경우 통합
  const uDataForMap = uDataOnce || db.loadUsers();
  const capsNameMap = {}; // { 'CAPS이름': '앱이름' }
  const adminNamesToExclude = new Set(); // admin 이름 수집
  for (const u of (uDataForMap.users || [])) {
    if (u.capsName && u.capsName !== u.name) capsNameMap[u.capsName] = u.name;
    if (u.role === 'admin') {
      adminNamesToExclude.add(u.name);
      if (u.capsName) adminNamesToExclude.add(u.capsName);
    }
  }
  if (Object.keys(capsNameMap).length > 0) {
    for (const r of records) {
      if (capsNameMap[r.employeeName]) {
        r.employeeId = capsNameMap[r.employeeName];
        r.employeeName = capsNameMap[r.employeeName];
      }
    }
  }
  // admin 역할 사용자의 CAPS 기록 조기 제거 (이후 모든 처리에서 제외)
  if (adminNamesToExclude.size > 0) {
    records = records.filter(r => !adminNamesToExclude.has(r.employeeName) && !adminNamesToExclude.has(r.employeeId));
  }

  // 퇴근 미기록 체크 제외 / 기록 제외 직원 목록 (★ excludeEmpNames 사용 전에 선언)
  const workData = db.출퇴근관리.load();
  const skipCheckoutNames = new Set(workData.skipCheckoutReview || []);
  const excludeEmpNames = new Set(workData.excludeEmployees || []);

  // 기록 제외(exclude) 설정된 직원 CAPS 기록 조기 제거
  if (excludeEmpNames.size > 0) {
    records = records.filter(r => !excludeEmpNames.has(r.employeeName) && !excludeEmpNames.has(r.employeeId));
  }

  // 수동 노트 병합 (leaveType 재분류 + reviewStatus 확정)
  const dbData = workData;
  const notes = dbData.attendanceNotes || {};
  const existingKeys = new Set(records.map(r => `${r.employeeId}_${r.date}`));
  for (const r of records) {
    // 퇴근 미기록 체크 제외 직원: noSwipeOut → normal 처리
    if (r.leaveType === 'noSwipeOut' && skipCheckoutNames.has(r.employeeName)) {
      r.leaveType = 'normal'; r.leaveLabel = '정상'; r.reviewStatus = 'normal';
    }
    const nKey = `${r.employeeId}_${r.date}`;
    if (notes[nKey]) {
      r.leaveType  = notes[nKey].leaveType  || r.leaveType;
      r.leaveLabel = notes[nKey].leaveLabel || r.leaveLabel;
      r.note       = notes[nKey].note || '';
      r.manuallySet = true;
      r.leaveSource = 'manual';  // 관리자 수동 체크
      r.reviewStatus = 'confirmed'; // 관리자가 확인한 건 → 확정
      // 수정된 출퇴근 시간 병합 (원본 보존)
      if (notes[nKey].modifiedInTime !== undefined) {
        r.originalInTime = r.originalInTime || r.inTime;
        r.inTime = notes[nKey].modifiedInTime;
        r.timeModified = true;
      }
      if (notes[nKey].modifiedOutTime !== undefined) {
        r.originalOutTime = r.originalOutTime || r.outTime;
        r.outTime = notes[nKey].modifiedOutTime;
        r.timeModified = true;
      }
      // 지각 재계산
      if (r.leaveType === 'normal' || r.leaveType === 'noSwipeIn') {
        const inMin = timeToMin(r.inTime);
        const WORK_START = 8 * 60 + 30;
        if (inMin && inMin > WORK_START) { r.late = true; r.lateMinutes = inMin - WORK_START; }
        else { r.late = false; r.lateMinutes = 0; }
      }
    }
  }
  // CAPS에 기록이 없지만 수동 노트가 있는 날짜 → 가상 레코드 생성
  for (const [nKey, note] of Object.entries(notes)) {
    if (existingKeys.has(nKey)) continue;
    const parts = nKey.match(/^(.+)_(\d{4}-\d{2}-\d{2})$/);
    if (!parts) continue;
    const [, empName, date] = parts;
    if (date < from || date > to) continue;
    if (employeeId && empName !== employeeId) continue;
    if (adminNamesToExclude.has(empName)) continue; // admin 제외
    records.push({
      employeeId: empName, employeeName: empName, date,
      inTime: note.modifiedInTime || null, outTime: note.modifiedOutTime || null,
      leaveType: note.leaveType || 'annual', leaveLabel: note.leaveLabel || '연차',
      late: false, lateMinutes: 0, overtime: 0, overtimeLabel: '',
      note: note.note || '', manuallySet: true, reviewStatus: 'confirmed',
    });
  }

  // 직원별 집계
  const byEmp = {};
  for (const r of records) {
    const key = r.employeeId;
    if (!byEmp[key]) {
      byEmp[key] = {
        employeeId: r.employeeId,
        employeeName: r.employeeName,
        normalDays: 0,
        halfAM: 0,
        halfPM: 0,
        annualDays: 0,
        absentDays: 0,
        lateDays: 0,
        totalLateMin: 0,
        totalOvertimeMin: 0,
        needsReviewCount: 0,
        records: [],
      };
    }
    const e = byEmp[key];
    e.records.push(r);
    if (r.leaveType === 'normal') e.normalDays++;
    else if (r.leaveType === 'halfAM') e.halfAM++;
    else if (r.leaveType === 'halfPM') e.halfPM++;
    else if (r.leaveType === 'annual') e.annualDays++;
    else if (r.leaveType === 'absent') e.absentDays = (e.absentDays || 0) + 1;
    if (r.late) { e.lateDays++; e.totalLateMin += r.lateMinutes; }
    if (r.reviewStatus === 'needsReview') e.needsReviewCount++;
    e.totalOvertimeMin += (r.overtime || 0);
  }

  // ── 연차관리 leaveRecords 병합 ──────────────────────────────
  // 결재로 승인된 연차가 CAPS에 미반영된 경우에도 출퇴근 기록부에 표시되도록 함
  // (attendanceNotes와 이중 적용되지 않도록 manuallySet 여부 확인)
  try {
    const leaveData = db['연차관리'].load();
    const ltCode = { '연차':'annual','반차':'halfAM','오전반차':'halfAM','오후반차':'halfPM','병가':'sick','특별휴가':'special' };
    const monthLeaves = (leaveData.leaveRecords || []).filter(r => r.date >= from && r.date <= to);

    for (const lr of monthLeaves) {
      // admin 역할 사용자의 연차는 출퇴근 기록부에 표시하지 않음
      if (adminNamesToExclude.has(lr.employeeName)) continue;
      const attLeaveType  = ltCode[lr.leaveType] || 'annual';
      const attLeaveLabel = lr.leaveType;

      // byEmp에서 이름으로 직원 키 찾기 (CAPS는 이름을 employeeId로 사용)
      const empKey = Object.keys(byEmp).find(k => byEmp[k].employeeName === lr.employeeName);

      if (empKey) {
        const emp = byEmp[empKey];
        const recIdx = emp.records.findIndex(r => r.date === lr.date);

        if (recIdx !== -1) {
          const rec = emp.records[recIdx];
          // 이미 수동 노트로 처리됐거나 연차/반차로 분류된 건 건드리지 않음
          if (rec.manuallySet) continue;
          if (rec.leaveType === 'annual' || rec.leaveType === 'halfAM' || rec.leaveType === 'halfPM') continue;

          // 정상/기타 → 연차로 오버라이드
          const oldType = rec.leaveType;
          rec.leaveType    = attLeaveType;
          rec.leaveLabel   = attLeaveLabel;
          rec.reviewStatus = 'confirmed';
          rec.fromLeaveRecord = true;
          rec.leaveSource  = lr.approvalId ? 'approval' : (lr.source === 'attendance' ? 'manual' : 'direct');
          // 집계 재계산
          if (oldType === 'normal') emp.normalDays = Math.max(0, emp.normalDays - 1);
          else if (oldType === 'needsReview') emp.needsReviewCount = Math.max(0, emp.needsReviewCount - 1);
          if (attLeaveType === 'annual')  emp.annualDays++;
          else if (attLeaveType === 'halfAM') emp.halfAM++;
          else if (attLeaveType === 'halfPM') emp.halfPM++;

        } else {
          // CAPS 기록 자체가 없는 날 → 가상 레코드 추가
          const dow = new Date(lr.date).getDay();
          if (dow === 0 || dow === 6) continue; // 주말 제외
          emp.records.push({
            employeeId: emp.employeeId, employeeName: emp.employeeName,
            date: lr.date, inTime: null, outTime: null,
            leaveType: attLeaveType, leaveLabel: attLeaveLabel,
            late: false, lateMinutes: 0, overtime: 0,
            reviewStatus: 'confirmed', fromLeaveRecord: true,
            leaveSource: lr.approvalId ? 'approval' : (lr.source === 'attendance' ? 'manual' : 'direct')
          });
          if (attLeaveType === 'annual')  emp.annualDays++;
          else if (attLeaveType === 'halfAM') emp.halfAM++;
          else if (attLeaveType === 'halfPM') emp.halfPM++;
        }
      }
      // byEmp에 없는 직원(CAPS 기록 없음)은 달력 표시를 위해 별도 entry 생성
      else {
        const dow = new Date(lr.date).getDay();
        if (dow === 0 || dow === 6) continue;
        byEmp[lr.employeeName] = byEmp[lr.employeeName] || {
          employeeId: lr.employeeName, employeeName: lr.employeeName,
          normalDays: 0, halfAM: 0, halfPM: 0, annualDays: 0,
          lateDays: 0, totalLateMin: 0, totalOvertimeMin: 0,
          needsReviewCount: 0, records: []
        };
        const emp2 = byEmp[lr.employeeName];
        if (!emp2.records.find(r => r.date === lr.date)) {
          emp2.records.push({
            employeeId: lr.employeeName, employeeName: lr.employeeName,
            date: lr.date, inTime: null, outTime: null,
            leaveType: attLeaveType, leaveLabel: attLeaveLabel,
            late: false, lateMinutes: 0, overtime: 0,
            reviewStatus: 'confirmed', fromLeaveRecord: true
          });
          if (attLeaveType === 'annual')  emp2.annualDays++;
          else if (attLeaveType === 'halfAM') emp2.halfAM++;
          else if (attLeaveType === 'halfPM') emp2.halfPM++;
        }
      }
    }
  } catch(e) { console.error('leaveRecords 병합 실패:', e.message); }

  let summary = Object.values(byEmp).map(e => ({
    ...e,
    totalOvertimeLabel: minToHHMM(e.totalOvertimeMin),
    totalOvertimeHours: minToDecimalHours(e.totalOvertimeMin),
    usedLeave: e.annualDays + (e.halfAM + e.halfPM) * 0.5,
  }));

  // ── 입사일 이전 레코드 제거 (CAPS에서 온 실제 기록 포함) ──
  {
    const hireDateMap2 = {};
    try {
      const leaveData3 = db['연차관리'].load();
      for (const emp of (leaveData3.employees || [])) {
        if (emp.name && emp.hireDate) hireDateMap2[emp.name] = emp.hireDate;
      }
    } catch(e) {}
    try {
      const uData3 = db.loadUsers();
      for (const u of (uData3.users || [])) {
        if (u.name && u.hireDate && !hireDateMap2[u.name]) hireDateMap2[u.name] = u.hireDate;
      }
    } catch(e) {}
    for (const e of summary) {
      const hd = hireDateMap2[e.employeeName];
      if (!hd) continue;
      const before = e.records.filter(r => r.date < hd);
      if (before.length === 0) continue;
      // 집계에서 입사일 이전 건 차감
      for (const r of before) {
        if (r.leaveType === 'normal') e.normalDays = Math.max(0, e.normalDays - 1);
        else if (r.leaveType === 'annual') e.annualDays = Math.max(0, e.annualDays - 1);
        else if (r.leaveType === 'halfAM') e.halfAM = Math.max(0, e.halfAM - 1);
        else if (r.leaveType === 'halfPM') e.halfPM = Math.max(0, e.halfPM - 1);
        if (r.reviewStatus === 'needsReview') e.needsReviewCount = Math.max(0, e.needsReviewCount - 1);
        if (r.late) { e.lateDays = Math.max(0, e.lateDays - 1); e.totalLateMin = Math.max(0, e.totalLateMin - (r.lateMinutes || 0)); }
      }
      e.records = e.records.filter(r => r.date >= hd);
    }
  }

  // 팀장 부서 필터 적용
  if (teamMemberNames) {
    summary = summary.filter(e => teamMemberNames.includes(e.employeeName));
  }

  // admin 역할 사용자 자동 제외 (CAPS에 관리자 계정이 등록돼 있어도 직원 목록에서 숨김)
  const uDataAll = uDataOnce || db.loadUsers();
  const adminNames = new Set((uDataAll.users || []).filter(u => u.role === 'admin').map(u => u.name));
  // capsName도 제외 대상에 포함
  for (const u of (uDataAll.users || [])) {
    if (u.role === 'admin' && u.capsName) adminNames.add(u.capsName);
  }
  if (adminNames.size > 0) {
    summary = summary.filter(e => !adminNames.has(e.employeeName));
  }

  // 부서/순서 적용
  const attData = db.출퇴근관리.load();
  const depts = attData.departments || [];
  const empOrder = attData.employeeOrder || {};
  const flexDepts = (attData.flexDepts || []).map(d => d.toLowerCase());
  const satWorkDepts = (attData.saturdayWorkDepts || []).map(d => d.toLowerCase());
  const exemptDeptsList = (attData.exemptDepts || []).map(d => d.toLowerCase());
  // 직원에 부서 정보 붙이기
  for (const e of summary) {
    e.department = '';
    for (const dept of depts) {
      const order = empOrder[dept] || [];
      if (order.includes(e.employeeName)) {
        e.department = dept;
        e.sortIdx = order.indexOf(e.employeeName);
        break;
      }
    }
    if (!e.department) e.sortIdx = 9999;
    // 유연근무/토요근무/근태면제 부서 플래그
    const deptLower = (e.department || '').toLowerCase();
    e.flexDept = flexDepts.some(fd => deptLower.includes(fd) || fd.includes(deptLower));
    e.saturdayWork = satWorkDepts.some(sd => deptLower.includes(sd) || sd.includes(deptLower));
    e.exemptDept = exemptDeptsList.some(ed => deptLower.includes(ed) || ed.includes(deptLower));
    // 근태면제 부서: 지각/출근미기록 보정
    if (e.exemptDept) {
      e.lateDays = 0;
      e.totalLateMin = 0;
      for (const r of e.records) {
        r.late = false;
        r.lateMinutes = 0;
        // 출근미기록(noswipe) → 정상으로 변경 (퇴근만 찍는 부서)
        if (r.leaveType === 'noswipe') {
          r.leaveType = 'normal';
          r.leaveLabel = '정상';
        }
      }
      // normalDays 재계산
      e.normalDays = e.records.filter(r => r.leaveType === 'normal' || r.leaveType === 'noswipe').length;
    }
    // 토요일 근무 부서: 토요일 출근 기록 카운트
    if (e.saturdayWork) {
      e.saturdayDays = 0;
      for (const r of e.records) {
        if (new Date(r.date).getDay() === 6 && (r.inTime || r.outTime)) e.saturdayDays++;
      }
    }
  }
  // ── 과거 근무일 중 CAPS 기록이 없는 날 → noRecord 가상 레코드 생성 ──
  // (근태면제 부서 제외, 퇴근 미기록(noSwipeOut)은 기존 레코드로 처리되므로 해당 없음)
  {
    // 직원별 입사일 맵 (입사일 이전 날짜는 미기록 생성 제외)
    const hireDateMap = {};
    try {
      const leaveData2 = db['연차관리'].load();
      for (const emp of (leaveData2.employees || [])) {
        if (emp.name && emp.hireDate) hireDateMap[emp.name] = emp.hireDate;
      }
    } catch(e) {}
    // 조직관리 users에서도 보완
    try {
      const uData2 = db.loadUsers();
      for (const u of (uData2.users || [])) {
        if (u.name && u.hireDate && !hireDateMap[u.name]) hireDateMap[u.name] = u.hireDate;
      }
    } catch(e) {}

    const todayStr = new Date().toISOString().slice(0, 10);
    const endDate = to < todayStr ? to : todayStr;
    for (const e of summary) {
      if (e.exemptDept) continue; // 근태면제 부서 제외
      const empHireDate = hireDateMap[e.employeeName] || null;
      const existingDates = new Set(e.records.map(r => r.date));
      let cursor = new Date(from + 'T00:00:00');
      const end = new Date(endDate + 'T00:00:00');
      while (cursor <= end) {
        const dateStr = cursor.toISOString().slice(0, 10);
        const dow = cursor.getDay();
        // 입사일 이전 날짜는 미기록 생성 제외
        if (empHireDate && dateStr < empHireDate) { cursor.setDate(cursor.getDate() + 1); continue; }
        // 주말·공휴일·이미 기록 있는 날 건너뜀
        if (dow !== 0 && dow !== 6 && !isKoreanHoliday(dateStr) && !existingDates.has(dateStr)) {
          e.records.push({
            employeeId: e.employeeId, employeeName: e.employeeName,
            date: dateStr, inTime: null, outTime: null,
            leaveType: 'noRecord', leaveLabel: '전체미기록',
            late: false, lateMinutes: 0, overtime: 0, overtimeLabel: '',
            reviewStatus: 'needsReview', synthetic: true,
          });
          e.needsReviewCount++;
        }
        cursor.setDate(cursor.getDate() + 1);
      }
      // records를 날짜 순으로 재정렬
      e.records.sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);
    }
  }

  // 부서 순서대로, 부서 내 순서대로 정렬
  summary.sort((a, b) => {
    const ai = depts.indexOf(a.department);
    const bi = depts.indexOf(b.department);
    const da = ai >= 0 ? ai : 9999;
    const db2 = bi >= 0 ? bi : 9999;
    if (da !== db2) return da - db2;
    return (a.sortIdx || 0) - (b.sortIdx || 0);
  });

  // ── 최종 안전장치: admin 역할 사용자 + 기록 제외 직원 응답에서 완전 제거 ──
  // (CAPS 실시간 데이터, leaveRecords 병합 등으로 다시 추가될 수 있으므로 응답 직전에 한 번 더 필터)
  const finalAdminNames = new Set();
  for (const u of (db.loadUsers().users || [])) {
    if (u.role === 'admin') {
      finalAdminNames.add(u.name);
      if (u.capsName) finalAdminNames.add(u.capsName);
    }
  }
  if (finalAdminNames.size > 0) {
    summary = summary.filter(e => !finalAdminNames.has(e.employeeName));
  }
  // 기록 제외(exclude) 직원 최종 제거
  if (excludeEmpNames.size > 0) {
    summary = summary.filter(e => !excludeEmpNames.has(e.employeeName));
  }

  if (fromCache) {
    res.set('X-Data-Source', 'cache');
  }
  res.json(summary);
});

// ─── 월간 근무시간 집계 ───
router.get('/attendance/monthly-summary', requireAuth, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year, month 파라미터 필요' });

  const y = parseInt(year), m = parseInt(month);
  const from = `${y}-${String(m).padStart(2,'0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2,'0')}-${lastDay}`;

  try {
    // /api/attendance/summary에서 데이터 가져오기
    const url = `/api/attendance?from=${from}&to=${to}`;
    let raw;
    const cacheKey = `sum_${from}_${to}_all`;
    raw = getCacheEntry(cacheKey);

    if (!raw) {
      return res.status(404).json({ error: '저장된 출퇴근 데이터가 없습니다' });
    }

    let records = raw.map(analyzeRecord);
    const uData = db.loadUsers();

    // 직원별 집계
    const summary = {};
    for (const rec of records) {
      const empName = rec.name || rec.employee_name || '미식별';
      if (!summary[empName]) {
        summary[empName] = {
          이름: empName,
          근무일: 0,
          정규근무시간: 0,
          초과근무시간: 0,
          지각횟수: 0,
          조퇴횟수: 0,
          결근일: 0
        };
      }

      if (rec.in && rec.out) {
        const work = calcWorkHours(rec.in, rec.out);
        summary[empName].근무일 += 1;
        summary[empName].정규근무시간 += work.근무;
        summary[empName].초과근무시간 += work.초과;
        if (work.지각) summary[empName].지각횟수 += 1;
        if (work.조퇴) summary[empName].조퇴횟수 += 1;
      } else if (!rec.in && !rec.out) {
        // 출퇴근 기록 없음 = 결근
        summary[empName].결근일 += 1;
      }
    }

    const result = Object.values(summary);
    res.json({
      year: y,
      month: m,
      from,
      to,
      summary: result.sort((a, b) => a.이름.localeCompare(b.이름, 'ko'))
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── 출퇴근 기록부 엑셀 다운로드 ───
router.get('/attendance/export-excel', requireAdmin, async (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });

  // summary API와 동일한 데이터 수집 로직 재사용
  const y = parseInt(year), m = parseInt(month);
  const from = `${y}-${String(m).padStart(2,'0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2,'0')}-${lastDay}`;

  let teamMemberNames = null;
  const userPerms = req.user.permissions || [];
  let canViewTeam2 = userPerms.includes('attendance_all');
  let userDeptId2 = req.user.department;
  if (!canViewTeam2 && req.user.role !== 'admin') {
    const uData2 = db.loadUsers();
    const me2 = (uData2.users || []).find(u => u.userId === req.user.userId);
    if (me2 && me2.department) {
      userDeptId2 = me2.department;
      const myDept = (uData2.departments || []).find(d => d.id === me2.department);
      if (myDept && myDept.leaderId === me2.id) canViewTeam2 = true;
    }
  }
  if (req.user.role !== 'admin' && canViewTeam2 && userDeptId2) {
    const uData = db.loadUsers();
    teamMemberNames = (uData.users || [])
      .filter(u => u.department === userDeptId2 && u.status === 'approved')
      .map(u => u.name);
    if (!teamMemberNames.includes(req.user.name)) teamMemberNames.push(req.user.name);
  } else if (req.user.role !== 'admin' && !canViewTeam2) {
    teamMemberNames = [req.user.name];
  }

  let raw;
  if (req.user.role !== 'admin') {
    const allCacheKey = `sum_${from}_${to}_all`;
    raw = getCacheEntry(allCacheKey);
    if (!raw) return res.status(404).json({ error: '저장된 출퇴근 데이터가 없습니다.' });
  } else {
    try { raw = await capsGet(`/api/attendance?from=${from}&to=${to}`); setCacheEntry(`sum_${from}_${to}_all`, raw); }
    catch (err) { raw = getCacheEntry(`sum_${from}_${to}_all`); if (!raw) return res.status(502).json({ error: 'CAPS 연결 실패 (캐시 없음)' }); }
  }

  const records = raw.map(analyzeRecord);
  const dbData = db.출퇴근관리.load();
  const notes = dbData.attendanceNotes || {};
  const existingKeys = new Set(records.map(r => `${r.employeeId}_${r.date}`));
  for (const r of records) {
    const nKey = `${r.employeeId}_${r.date}`;
    if (notes[nKey]) {
      r.leaveType = notes[nKey].leaveType || r.leaveType;
      r.leaveLabel = notes[nKey].leaveLabel || r.leaveLabel;
      r.note = notes[nKey].note || '';
      if (notes[nKey].modifiedInTime !== undefined) r.inTime = notes[nKey].modifiedInTime;
      if (notes[nKey].modifiedOutTime !== undefined) r.outTime = notes[nKey].modifiedOutTime;
      if (r.leaveType === 'normal' || r.leaveType === 'noswipe') {
        const inMin = timeToMin(r.inTime);
        const WORK_START = 8 * 60 + 30;
        if (inMin && inMin > WORK_START) { r.late = true; r.lateMinutes = inMin - WORK_START; }
        else { r.late = false; r.lateMinutes = 0; }
      }
    }
  }
  for (const [nKey, note] of Object.entries(notes)) {
    if (existingKeys.has(nKey)) continue;
    const parts = nKey.match(/^(.+)_(\d{4}-\d{2}-\d{2})$/);
    if (!parts) continue;
    const [, empName, date] = parts;
    if (date < from || date > to) continue;
    records.push({ employeeId: empName, employeeName: empName, date, inTime: null, outTime: null,
      leaveType: note.leaveType || 'annual', leaveLabel: note.leaveLabel || '연차',
      late: false, lateMinutes: 0, overtime: 0, note: note.note || '', manuallySet: true });
  }

  const byEmp = {};
  for (const r of records) {
    const key = r.employeeId;
    if (!byEmp[key]) byEmp[key] = { employeeId: r.employeeId, employeeName: r.employeeName, normalDays:0, halfAM:0, halfPM:0, annualDays:0, absentDays:0, lateDays:0, totalLateMin:0, totalOvertimeMin:0, records:[] };
    const e = byEmp[key];
    e.records.push(r);
    if (r.leaveType === 'normal' || r.leaveType === 'noswipe') e.normalDays++;
    else if (r.leaveType === 'halfAM') e.halfAM++;
    else if (r.leaveType === 'halfPM') e.halfPM++;
    else if (r.leaveType === 'annual') e.annualDays++;
    else if (r.leaveType === 'absent') e.absentDays++;
    if (r.late) { e.lateDays++; e.totalLateMin += r.lateMinutes; }
    e.totalOvertimeMin += (r.overtime || 0);
  }
  let summary = Object.values(byEmp).map(e => ({ ...e, usedLeave: e.annualDays + (e.halfAM + e.halfPM) * 0.5 }));
  if (teamMemberNames) summary = summary.filter(e => teamMemberNames.includes(e.employeeName));

  const depts = dbData.departments || [];
  const empOrder = dbData.employeeOrder || {};
  const flexDeptsExport = (dbData.flexDepts || []).map(d => d.toLowerCase());
  const satWorkDeptsExport = (dbData.saturdayWorkDepts || []).map(d => d.toLowerCase());
  const exemptDeptsExport = (dbData.exemptDepts || []).map(d => d.toLowerCase());
  for (const e of summary) {
    e.department = '';
    for (const dept of depts) { const order = empOrder[dept] || []; if (order.includes(e.employeeName)) { e.department = dept; e.sortIdx = order.indexOf(e.employeeName); break; } }
    if (!e.department) e.sortIdx = 9999;
    const deptL = (e.department || '').toLowerCase();
    e.exemptDept = exemptDeptsExport.some(ed => deptL.includes(ed) || ed.includes(deptL));
    if (e.exemptDept) {
      e.lateDays = 0; e.totalLateMin = 0;
      for (const r of e.records) { r.late = false; if (r.leaveType === 'noswipe') { r.leaveType = 'normal'; r.leaveLabel = '정상'; } }
      e.normalDays = e.records.filter(r => r.leaveType === 'normal' || r.leaveType === 'noswipe').length;
    }
    e.saturdayWork = satWorkDeptsExport.some(sd => deptL.includes(sd) || sd.includes(deptL));
    if (e.saturdayWork) {
      e.saturdayDays = 0;
      for (const r of e.records) { if (new Date(r.date).getDay() === 6 && r.inTime) e.saturdayDays++; }
    }
  }
  summary.sort((a, b) => { const da = depts.indexOf(a.department) >= 0 ? depts.indexOf(a.department) : 9999; const db2 = depts.indexOf(b.department) >= 0 ? depts.indexOf(b.department) : 9999; if (da !== db2) return da - db2; return (a.sortIdx||0) - (b.sortIdx||0); });

  // ── 엑셀 생성 ──
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  wb.creator = '출퇴근관리시스템';

  // 시트1: 월간 요약
  const ws1 = wb.addWorksheet(`${y}년 ${m}월 요약`);
  const headerFill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FF4F6EF7' } };
  const headerFont = { bold:true, color:{ argb:'FFFFFFFF' }, size:10, name:'맑은 고딕' };
  const bodyFont = { size:10, name:'맑은 고딕' };
  const thinBorder = { top:{style:'thin'}, bottom:{style:'thin'}, left:{style:'thin'}, right:{style:'thin'} };

  ws1.columns = [
    { header:'부서', key:'dept', width:14 },
    { header:'직원명', key:'name', width:12 },
    { header:'정상출근', key:'normal', width:10 },
    { header:'토요근무', key:'satDays', width:10 },
    { header:'오전반차', key:'halfAM', width:10 },
    { header:'오후반차', key:'halfPM', width:10 },
    { header:'연차', key:'annual', width:8 },
    { header:'사용연차', key:'usedLeave', width:10 },
    { header:'지각', key:'late', width:8 },
    { header:'추가근무(h)', key:'overtime', width:12 },
  ];
  ws1.getRow(1).eachCell(c => { c.fill = headerFill; c.font = headerFont; c.alignment = { horizontal:'center', vertical:'middle' }; c.border = thinBorder; });
  ws1.getRow(1).height = 24;

  for (const emp of summary) {
    const row = ws1.addRow({ dept: emp.department||'미배정', name: emp.employeeName, normal: emp.normalDays, satDays: emp.saturdayDays||0, halfAM: emp.halfAM||0, halfPM: emp.halfPM||0, annual: emp.annualDays||0, usedLeave: emp.usedLeave, late: emp.lateDays, overtime: +(emp.totalOvertimeMin/60).toFixed(2) });
    row.eachCell(c => { c.font = bodyFont; c.alignment = { horizontal:'center', vertical:'middle' }; c.border = thinBorder; });
    row.getCell('name').alignment = { horizontal:'left', vertical:'middle' };
    row.getCell('dept').alignment = { horizontal:'left', vertical:'middle' };
    if (emp.lateDays > 0) row.getCell('late').font = { ...bodyFont, color:{ argb:'FFEF4444' }, bold:true };
    if (emp.totalOvertimeMin > 0) row.getCell('overtime').font = { ...bodyFont, color:{ argb:'FF6366F1' }, bold:true };
    if (emp.usedLeave > 0) row.getCell('usedLeave').font = { ...bodyFont, color:{ argb:'FFF59E0B' }, bold:true };
  }

  // 시트2: 일별 상세
  const ws2 = wb.addWorksheet(`${y}년 ${m}월 상세`);
  const leaveLabels = { normal:'정상', noswipe:'미타각', halfAM:'오전반차', halfPM:'오후반차', annual:'연차', absent:'결근', holiday:'공휴일', weekend:'주말' };
  ws2.columns = [
    { header:'부서', key:'dept', width:14 },
    { header:'직원명', key:'name', width:12 },
    { header:'날짜', key:'date', width:12 },
    { header:'요일', key:'day', width:6 },
    { header:'출근시간', key:'inTime', width:10 },
    { header:'퇴근시간', key:'outTime', width:10 },
    { header:'구분', key:'type', width:10 },
    { header:'지각', key:'late', width:6 },
    { header:'비고', key:'note', width:20 },
  ];
  ws2.getRow(1).eachCell(c => { c.fill = headerFill; c.font = headerFont; c.alignment = { horizontal:'center', vertical:'middle' }; c.border = thinBorder; });
  ws2.getRow(1).height = 24;

  const dayNames = ['일','월','화','수','목','금','토'];
  for (const emp of summary) {
    const sorted = [...emp.records].sort((a,b) => a.date.localeCompare(b.date));
    for (const r of sorted) {
      const d = new Date(r.date);
      const dayName = dayNames[d.getDay()];
      const typeLabel = r.leaveLabel || leaveLabels[r.leaveType] || r.leaveType || '';
      const row = ws2.addRow({ dept: emp.department||'미배정', name: emp.employeeName, date: r.date, day: dayName, inTime: r.inTime||'', outTime: r.outTime||'', type: typeLabel, late: r.late?'O':'', note: r.note||'' });
      row.eachCell(c => { c.font = bodyFont; c.alignment = { horizontal:'center', vertical:'middle' }; c.border = thinBorder; });
      row.getCell('name').alignment = { horizontal:'left', vertical:'middle' };
      row.getCell('dept').alignment = { horizontal:'left', vertical:'middle' };
      row.getCell('note').alignment = { horizontal:'left', vertical:'middle' };
      if (r.late) row.getCell('late').font = { ...bodyFont, color:{ argb:'FFEF4444' }, bold:true };
      if (d.getDay() === 0) row.eachCell(c => { c.font = { ...c.font, color:{ argb:'FFEF4444' } }; });
      if (d.getDay() === 6) row.eachCell(c => { c.font = { ...c.font, color:{ argb:'FF2563EB' } }; });
      if (r.leaveType === 'annual' || r.leaveType === 'halfAM' || r.leaveType === 'halfPM') {
        row.getCell('type').font = { ...bodyFont, color:{ argb:'FFF59E0B' }, bold:true };
      }
    }
  }

  // 자동필터
  ws1.autoFilter = { from:'A1', to:`J${ws1.rowCount}` };
  ws2.autoFilter = { from:'A1', to:`I${ws2.rowCount}` };

  const filename = encodeURIComponent(`출퇴근기록부_${y}년${m}월.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  await wb.xlsx.write(res);
  res.end();
});

// ─── 출퇴근 직원 순서/부서 관리 API ───
router.get('/attendance/order', requireAuth, (req, res) => {
  const data = db.출퇴근관리.load();
  // admin 역할 사용자를 employeeOrder에서 자동 제거
  const uData = db.loadUsers();
  const adminNameSet = new Set();
  for (const u of (uData.users || [])) {
    if (u.role === 'admin') {
      adminNameSet.add(u.name);
      if (u.capsName) adminNameSet.add(u.capsName);
    }
  }
  const cleanOrder = {};
  for (const [dept, names] of Object.entries(data.employeeOrder || {})) {
    cleanOrder[dept] = (names || []).filter(n => !adminNameSet.has(n));
  }
  res.json({
    departments: data.departments || [],
    employeeOrder: cleanOrder,
    flexDepts: data.flexDepts || [],
    saturdayWorkDepts: data.saturdayWorkDepts || [],
    exemptDepts: data.exemptDepts || [],
    excludeEmployees: data.excludeEmployees || [],
  });
});

router.post('/attendance/order', requireAdmin, (req, res) => {
  const { departments, employeeOrder, flexDepts, saturdayWorkDepts, exemptDepts, excludeEmployees, skipCheckoutReview } = req.body;
  const data = db.출퇴근관리.load();
  if (departments) data.departments = departments;
  if (employeeOrder) data.employeeOrder = employeeOrder;
  if (flexDepts !== undefined) data.flexDepts = flexDepts;
  if (saturdayWorkDepts !== undefined) data.saturdayWorkDepts = saturdayWorkDepts;
  if (exemptDepts !== undefined) data.exemptDepts = exemptDepts;
  if (excludeEmployees !== undefined) data.excludeEmployees = excludeEmployees;
  if (skipCheckoutReview !== undefined) data.skipCheckoutReview = skipCheckoutReview;
  db.출퇴근관리.save(data);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════
// ★ 연차 관리 API
// ══════════════════════════════════════════════

// 연차관리 전체 데이터 조회
router.get('/leave', requireAuth, (req, res) => {
  try {
    const data = db['연차관리'].load();
    res.json(data);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 입사일 기반 연차 자동 계산 (한국 근로기준법) ──
// 1년 미만: 입사 후 매월 1일씩 발생 (최대 11일, 해당 연도 내 비례)
// 1년 이상: 15일 기본 + 2년마다 1일 추가 (최대 25일)
function calcAnnualLeave(hireDateStr, targetYear) {
  if (!hireDateStr) return 0;
  const hire = new Date(hireDateStr);
  if (isNaN(hire.getTime())) return 0;

  const yearStart = new Date(targetYear, 0, 1);
  const yearEnd = new Date(targetYear, 11, 31);

  // 입사일이 대상 연도 이후면 연차 없음
  if (hire > yearEnd) return 0;

  // 근속 연수 (대상 연도 1월 1일 기준)
  const yearsAtStart = (yearStart - hire) / (365.25 * 24 * 60 * 60 * 1000);

  if (yearsAtStart < 1) {
    // 1년 미만: 대상 연도 내에서 입사 후 경과 개월 수만큼 (매월 1개, 최대 11개)
    // 입사일이 대상 연도 중이면 해당 연도 내 개월수
    const startDate = hire > yearStart ? hire : yearStart;
    const months = (yearEnd.getFullYear() - startDate.getFullYear()) * 12
      + (yearEnd.getMonth() - startDate.getMonth());
    return Math.min(Math.max(months, 0), 11);
  }

  // 1년 이상: 15일 + 매 2년 초과 근속마다 1일 (최대 25일)
  const fullYears = Math.floor(yearsAtStart);
  const bonus = Math.floor((fullYears - 1) / 2);
  return Math.min(15 + bonus, 25);
}

// 연차관리 설정만 조회
router.get('/leave/settings', requireAuth, (req, res) => {
  try {
    const data = db['연차관리'].load();
    res.json(data.settings || {});
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 직원 이름 검색 (승인 시 매칭용)
router.get('/leave/employees/search', requireAuth, (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    if (!q) return res.json([]);
    const data = db['연차관리'].load();
    const emps = data.employees || [];
    // 한글 초성 추출 함수
    const getChosung = (str) => {
      const CHO = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
      return [...str].map(c => {
        const code = c.charCodeAt(0) - 0xAC00;
        if (code < 0 || code > 11171) return c;
        return CHO[Math.floor(code / 588)];
      }).join('');
    };
    const nameMatch = (name, query) => {
      if (!name) return false;
      if (name.includes(query)) return true;
      if (getChosung(name).includes(query)) return true;
      if (Math.abs(name.length - query.length) <= 1) {
        let diff = 0;
        const longer = name.length >= query.length ? name : query;
        const shorter = name.length < query.length ? name : query;
        let j = 0;
        for (let i = 0; i < longer.length && diff <= 1; i++) {
          if (longer[i] !== shorter[j]) { diff++; }
          else { j++; }
        }
        if (diff <= 1) return true;
      }
      return false;
    };
    const results = emps.filter(e => nameMatch(e.name, q)).map(e => ({
      name: e.name,
      department: e.department,
      position: e.position,
      hireDate: e.hireDate,
      resignDate: e.resignDate || ''
    }));
    // 연차관리 데이터에 없으면 사용자 DB에서도 검색 (가입 승인 시 매칭)
    if (results.length === 0) {
      const uData = db.loadUsers();
      const depts = uData.departments || [];
      const deptMap = {};
      depts.forEach(d => { deptMap[d.id] = d.name; });
      const userResults = (uData.users || [])
        .filter(u => u.status === 'approved' && nameMatch(u.name, q))
        .map(u => ({
          name: u.name,
          department: deptMap[u.department] || u.department || '',
          position: u.position || '',
          hireDate: '',
          resignDate: ''
        }));
      return res.json(userResults);
    }
    res.json(results);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 직원 목록 조회 (재직자만 or 전체)
router.get('/leave/employees', requireAuth, (req, res) => {
  try {
    const data = db['연차관리'].load();
    const activeOnly = req.query.active !== 'false';
    let emps = data.employees || [];
    if (activeOnly) emps = emps.filter(e => !e.resignDate);
    res.json(emps);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 직원 추가 (관리자 전용 — 직원 명부 변경)
router.post('/leave/employees', requireAdmin, (req, res) => {
  try {
    const data = db['연차관리'].load();
    const emp = req.body;
    if (!emp.name || !emp.hireDate) return res.status(400).json({ error: '성명과 입사일 필수' });
    data.employees.push(emp);
    db['연차관리'].save(data);
    res.json(emp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 직원 수정 (연도별 필드는 yearlyData에 저장) — 관리자 전용
router.put('/leave/employees/:name', requireAdmin, (req, res) => {
  try {
    // Prototype Pollution 차단 — name은 URL에서만 설정되도록 막음
    req.body = safeBody(req.body, ['name']);
    const data = db['연차관리'].load();
    const idx = data.employees.findIndex(e => e.name === req.params.name);
    if (idx < 0) return res.status(404).json({ error: '직원 없음' });
    const emp = data.employees[idx];

    const yearlyFields = ['additionalDays', 'deductedDays', 'paidDays', 'annualLeaveOverride'];
    const year = req.body._year || String(new Date().getFullYear());
    delete req.body._year; // 메타 필드 제거

    // 연도별 필드는 yearlyData에 저장
    const hasYearlyField = Object.keys(req.body).some(k => yearlyFields.includes(k));
    if (hasYearlyField) {
      if (!emp.yearlyData) emp.yearlyData = {};
      if (!emp.yearlyData[year]) emp.yearlyData[year] = {};
      for (const f of yearlyFields) {
        if (req.body[f] !== undefined) {
          emp.yearlyData[year][f] = req.body[f];
          // 하위호환: 현재 연도면 기존 단일값도 업데이트
          if (year === String(new Date().getFullYear())) {
            emp[f] = req.body[f];
          }
          delete req.body[f];
        }
      }
    }

    // 나머지 필드 (department, position, hireDate 등)는 직접 저장
    Object.assign(emp, req.body);
    db['연차관리'].save(data);
    res.json(emp);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 휴가 사용 기록 조회 (연도별)
router.get('/leave/records', requireAuth, (req, res) => {
  try {
    const data = db['연차관리'].load();
    let records = data.leaveRecords || [];
    const year = parseInt(req.query.year);
    const name = req.query.name;
    if (year) records = records.filter(r => r.date && r.date.startsWith(String(year)));
    if (name) records = records.filter(r => r.employeeName === name);
    res.json(records);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 휴가 사용 등록
router.post('/leave/records', requireAuth, (req, res) => {
  try {
    const data = db['연차관리'].load();
    const rec = req.body;
    if (!rec.employeeName || !rec.date || !rec.leaveType) {
      return res.status(400).json({ error: '직원명, 날짜, 휴가유형 필수' });
    }
    const maxId = (data.leaveRecords || []).reduce((m, r) => Math.max(m, r.id || 0), 0);
    rec.id = maxId + 1;
    // 연차차감 여부 자동 설정
    const lt = (data.settings.leaveTypes || []).find(t => t.name === rec.leaveType);
    if (lt) {
      rec.days = rec.days || lt.days;
      rec.annualDays = lt.deductsAnnual ? (rec.days || lt.days) : 0;
      rec.nonAnnualDays = lt.deductsAnnual ? 0 : (rec.days || lt.days);
    }
    if (!data.leaveRecords) data.leaveRecords = [];
    data.leaveRecords.push(rec);

    // 직원의 사용일수, 잔여일수 갱신
    const yr = rec.date.substring(0, 4);
    const empIdx = data.employees.findIndex(e => e.name === rec.employeeName);
    if (empIdx >= 0 && rec.annualDays > 0) {
      const emp = data.employees[empIdx];
      const yearRecords = data.leaveRecords.filter(r =>
        r.employeeName === rec.employeeName && r.date.startsWith(yr) && r.annualDays > 0
      );
      emp.usedDays = yearRecords.reduce((s, r) => s + (r.annualDays || 0), 0);
      emp.remainingDays = (emp.totalLeave || 0) - emp.usedDays - (emp.paidDays || 0);
    }

    db['연차관리'].save(data);
    res.json(rec);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 휴가 사용 삭제
router.delete('/leave/records/:id', requireAuth, (req, res) => {
  try {
    const data = db['연차관리'].load();
    // 숫자 ID(구형)와 문자열 ID(lr_... 신형) 모두 지원
    const rawId = req.params.id;
    const id = /^\d+$/.test(rawId) ? parseInt(rawId) : rawId;
    const idx = (data.leaveRecords || []).findIndex(r => String(r.id) === String(id));
    if (idx < 0) return res.status(404).json({ error: '기록 없음' });
    const removed = data.leaveRecords.splice(idx, 1)[0];

    // 직원 사용일수 갱신
    if (removed.annualDays > 0) {
      const yr = removed.date.substring(0, 4);
      const empIdx = data.employees.findIndex(e => e.name === removed.employeeName);
      if (empIdx >= 0) {
        const emp = data.employees[empIdx];
        const yearRecords = data.leaveRecords.filter(r =>
          r.employeeName === removed.employeeName && r.date.startsWith(yr) && r.annualDays > 0
        );
        emp.usedDays = yearRecords.reduce((s, r) => s + (r.annualDays || 0), 0);
        emp.remainingDays = (emp.totalLeave || 0) - emp.usedDays - (emp.paidDays || 0);
      }
    }

    db['연차관리'].save(data);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 추가/공제 내역 조회
router.get('/leave/adjustments', requireAuth, (req, res) => {
  try {
    const data = db['연차관리'].load();
    const year = req.query.year ? parseInt(req.query.year) : null;
    let list = data.adjustments || [];
    if (year) list = list.filter(a => a.year === year);
    res.json(list);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 추가/공제 내역 등록
router.post('/leave/adjustments', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 가능' });
    const data = db['연차관리'].load();
    if (!data.adjustments) data.adjustments = [];
    const { employeeName, year, type, days, reason } = req.body;
    if (!employeeName || !year || !type || !days) return res.status(400).json({ error: '필수 항목 누락' });
    const maxId = data.adjustments.reduce((m, a) => Math.max(m, a.id || 0), 0);
    const adj = {
      id: maxId + 1,
      employeeName, year: parseInt(year), type, days: parseFloat(days),
      reason: reason || '',
      createdAt: new Date().toISOString().substring(0, 10)
    };
    data.adjustments.push(adj);
    // yearlyData 동기화
    const emp = (data.employees || []).find(e => e.name === employeeName);
    if (emp) {
      if (!emp.yearlyData) emp.yearlyData = {};
      const y = String(adj.year);
      if (!emp.yearlyData[y]) emp.yearlyData[y] = {};
      // 해당 연도 전체 재집계
      const yearAdjs = data.adjustments.filter(a => a.employeeName === employeeName && a.year === adj.year);
      emp.yearlyData[y].additionalDays = yearAdjs.filter(a => a.type === '추가').reduce((s, a) => s + a.days, 0);
      emp.yearlyData[y].deductedDays = yearAdjs.filter(a => a.type === '공제').reduce((s, a) => s + a.days, 0);
      emp.yearlyData[y].paidDays = yearAdjs.filter(a => a.type === '수당지급').reduce((s, a) => s + a.days, 0);
    }
    db['연차관리'].save(data);
    res.json(adj);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 추가/공제 내역 삭제
router.delete('/leave/adjustments/:id', requireAuth, (req, res) => {
  try {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 가능' });
    const data = db['연차관리'].load();
    const id = parseInt(req.params.id);
    const idx = (data.adjustments || []).findIndex(a => a.id === id);
    if (idx < 0) return res.status(404).json({ error: '내역 없음' });
    const removed = data.adjustments.splice(idx, 1)[0];
    // yearlyData 재집계
    const emp = (data.employees || []).find(e => e.name === removed.employeeName);
    if (emp && emp.yearlyData) {
      const y = String(removed.year);
      if (emp.yearlyData[y]) {
        const yearAdjs = data.adjustments.filter(a => a.employeeName === removed.employeeName && a.year === removed.year);
        emp.yearlyData[y].additionalDays = yearAdjs.filter(a => a.type === '추가').reduce((s, a) => s + a.days, 0);
        emp.yearlyData[y].deductedDays = yearAdjs.filter(a => a.type === '공제').reduce((s, a) => s + a.days, 0);
        emp.yearlyData[y].paidDays = yearAdjs.filter(a => a.type === '수당지급').reduce((s, a) => s + a.days, 0);
      }
    }
    db['연차관리'].save(data);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 연차 현황 요약 (HOME 시트와 동일)
router.get('/leave/summary', requireAuth, (req, res) => {
  try {
    const data = db['연차관리'].load();
    const year = parseInt(req.query.year) || new Date().getFullYear();
    const includeResigned = req.query.includeResigned === 'true';
    let activeEmps = includeResigned
      ? (data.employees || [])
      : (data.employees || []).filter(e => !e.resignDate || e.resignDate === '');

    // 팀장 부서 필터: admin 아닌 attendance_all 권한자 → 같은 부서 팀원만
    const userPerms = req.user.permissions || [];
    if (req.user.role !== 'admin' && userPerms.includes('attendance_all') && req.user.department) {
      const uData = db.loadUsers();
      const myDeptId = req.user.department;
      const teamNames = (uData.users || [])
        .filter(u => u.department === myDeptId && u.status === 'approved')
        .map(u => u.name);
      if (!teamNames.includes(req.user.name)) teamNames.push(req.user.name);
      activeEmps = activeEmps.filter(e => teamNames.includes(e.name));
    }
    // 일반 직원 (attendance_all 권한 없음) → 본인만
    else if (req.user.role !== 'admin' && !userPerms.includes('attendance_all')) {
      activeEmps = activeEmps.filter(e => e.name === req.user.name);
    }

    const summary = activeEmps.map(emp => {
      const yearRecords = (data.leaveRecords || []).filter(r =>
        r.employeeName === emp.name && r.date && r.date.startsWith(String(year))
      );
      const annualUsed = yearRecords.filter(r => r.annualDays > 0).reduce((s, r) => s + (r.annualDays || 0), 0);

      // 연도별 데이터 읽기 (yearlyData 우선, 없으면 기존 단일값 폴백)
      const yd = (emp.yearlyData && emp.yearlyData[String(year)]) || {};
      const additionalDays = yd.additionalDays ?? emp.additionalDays ?? 0;
      const deductedDays = yd.deductedDays ?? emp.deductedDays ?? 0;
      const paidDays = yd.paidDays ?? emp.paidDays ?? 0;
      const annualLeaveOverride = yd.annualLeaveOverride !== undefined ? yd.annualLeaveOverride : (emp.annualLeaveOverride ?? null);

      // 입사일 기반 연차 자동 계산 (수동 오버라이드 우선)
      const autoAnnual = emp.hireDate ? calcAnnualLeave(emp.hireDate, year) : 0;
      const annualLeave = (annualLeaveOverride !== undefined && annualLeaveOverride !== null)
        ? annualLeaveOverride : autoAnnual;
      const total = annualLeave + additionalDays - deductedDays;

      // 월별 집계
      const monthly = {};
      for (let m = 1; m <= 12; m++) monthly[m] = 0;
      yearRecords.forEach(r => {
        if (r.annualDays > 0) {
          const m = parseInt(r.date.substring(5, 7));
          monthly[m] = (monthly[m] || 0) + r.annualDays;
        }
      });

      // 휴가유형별 집계
      const byType = {};
      yearRecords.forEach(r => {
        if (!byType[r.leaveType]) byType[r.leaveType] = 0;
        byType[r.leaveType] += (r.annualDays || 0) + (r.nonAnnualDays || 0);
      });

      return {
        name: emp.name,
        department: emp.department,
        position: emp.position,
        hireDate: emp.hireDate,
        resignDate: emp.resignDate || '',
        annualLeave: annualLeave,
        autoAnnualLeave: autoAnnual,
        annualLeaveOverride: annualLeaveOverride,
        additionalDays: additionalDays,
        deductedDays: deductedDays,
        totalLeave: total,
        usedDays: annualUsed,
        paidDays: paidDays,
        remainingDays: total - annualUsed - paidDays,
        monthly,
        byType,
        records: yearRecords
      };
    });

    // 입사일 기준 정렬 (입사일 없는 직원은 뒤로)
    summary.sort((a, b) => {
      if (!a.hireDate && !b.hireDate) return 0;
      if (!a.hireDate) return 1;
      if (!b.hireDate) return -1;
      return a.hireDate.localeCompare(b.hireDate);
    });

    res.json({ year, employees: summary });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// API: 회계년도 vs 입사일기준 연차 비교
// ─────────────────────────────────────────────────────────
router.get('/leave/compare', requireAuth, (req, res) => {
  try {
    const empName = req.query.name;
    if (!empName) return res.status(400).json({ error: '직원명 필요' });
    const data = db['연차관리'].load();
    const emp = (data.employees || []).find(e => e.name === empName);
    if (!emp) return res.status(404).json({ error: '직원 없음' });
    if (!emp.hireDate) return res.status(400).json({ error: '입사일 없음' });

    const hire = new Date(emp.hireDate);
    const endDate = emp.resignDate ? new Date(emp.resignDate) : new Date();
    const hireYear = hire.getFullYear();
    const endYear = endDate.getFullYear();
    const leaveRecords = data.leaveRecords || [];

    // ── 회계년도 방식 (1월1일~12월31일) ──
    const fiscal = [];
    for (let y = hireYear; y <= endYear; y++) {
      const yearStart = new Date(y, 0, 1);
      const yearEnd   = new Date(y, 11, 31);
      const yearsAtStart = (yearStart - hire) / (365.25 * 24 * 60 * 60 * 1000);
      let annual;
      if (hire > yearEnd) { annual = 0; }
      else if (yearsAtStart < 1) {
        const sd = hire > yearStart ? hire : yearStart;
        const months = (yearEnd.getFullYear() - sd.getFullYear()) * 12 + (yearEnd.getMonth() - sd.getMonth());
        annual = Math.min(Math.max(months, 0), 11);
      } else {
        const fy = Math.floor(yearsAtStart);
        annual = Math.min(15 + Math.floor((fy - 1) / 2), 25);
      }
      // yearlyData 오버라이드 반영
      const yd = emp.yearlyData && emp.yearlyData[String(y)];
      const override = yd && yd.annualLeaveOverride !== undefined ? yd.annualLeaveOverride : (emp.annualLeaveOverride ?? null);
      if (override !== null) annual = override;
      const addDays = (yd && yd.additionalDays) || (emp.additionalDays) || 0;
      const dedDays = (yd && yd.deductedDays) || (emp.deductedDays) || 0;
      const total = annual + addDays - dedDays;

      const yr = leaveRecords.filter(r =>
        r.employeeName === empName && r.date && r.date.startsWith(String(y))
      );
      const used = yr.filter(r => r.annualDays > 0).reduce((s, r) => s + (r.annualDays || 0), 0);
      fiscal.push({ year: y, annual, additionalDays: addDays, deductedDays: dedDays, total, used, remaining: total - used });
    }

    // ── 입사일기준 방식 (입사 N주년 ~ N+1주년) ──
    const anniversary = [];
    for (let yr = 0; yr <= 40; yr++) {
      const pStart = new Date(hire.getFullYear() + yr, hire.getMonth(), hire.getDate());
      const pEndRaw = new Date(hire.getFullYear() + yr + 1, hire.getMonth(), hire.getDate());
      pEndRaw.setDate(pEndRaw.getDate() - 1);
      const pEnd = pEndRaw;
      if (pStart > endDate) break;

      let annual;
      if (yr === 0) {
        const cap = emp.resignDate ? Math.min(endDate, pEnd) : pEnd;
        const ms = Math.max(0,
          (cap.getFullYear() - pStart.getFullYear()) * 12 + (cap.getMonth() - pStart.getMonth())
        );
        annual = Math.min(ms, 11);
      } else {
        annual = Math.min(15 + Math.floor((yr - 1) / 2), 25);
      }

      const pr = leaveRecords.filter(r => {
        if (r.employeeName !== empName || !r.date) return false;
        const d = new Date(r.date);
        return d >= pStart && d <= pEnd;
      });
      const used = pr.filter(r => r.annualDays > 0).reduce((s, r) => s + (r.annualDays || 0), 0);
      anniversary.push({
        workYear: yr + 1,
        startDate: pStart.toISOString().slice(0, 10),
        endDate: pEnd.toISOString().slice(0, 10),
        annual, used, remaining: annual - used
      });
    }

    res.json({
      name: emp.name, hireDate: emp.hireDate, resignDate: emp.resignDate || null,
      fiscal, anniversary
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─────────────────────────────────────────────────────────
// API: 출퇴근 → 연차관리 벌크 동기화
// 출퇴근 summary에서 연차/반차 기록을 연차관리 leaveRecords에 일괄 추가
// ─────────────────────────────────────────────────────────
router.post('/leave/sync-from-attendance', requireAuth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자만 가능' });
  const { year, month } = req.body;
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });

  const y = parseInt(year), m = parseInt(month);
  const from = `${y}-${String(m).padStart(2,'0')}-01`;
  const lastDay = new Date(y, m, 0).getDate();
  const to = `${y}-${String(m).padStart(2,'0')}-${lastDay}`;

  // CAPS 데이터 가져오기 (캐시 or 브릿지)
  let raw;
  try {
    const url = `/api/attendance?from=${from}&to=${to}`;
    const cacheKey = `sum_${from}_${to}_all`;
    raw = getCacheEntry(cacheKey);
    if (!raw) {
      raw = await capsGet(url);
      setCacheEntry(cacheKey, raw);
    }
  } catch (err) {
    return res.status(502).json({ error: 'CAPS 데이터 가져오기 실패: ' + err.message });
  }

  const records = raw.map(analyzeRecord);

  // 수동 노트 병합
  const attData = db.출퇴근관리.load();
  const notes = attData.attendanceNotes || {};
  const existingKeys = new Set(records.map(r => `${r.employeeId}_${r.date}`));
  for (const r of records) {
    const nKey = `${r.employeeId}_${r.date}`;
    if (notes[nKey]) {
      r.leaveType = notes[nKey].leaveType || r.leaveType;
      r.leaveLabel = notes[nKey].leaveLabel || r.leaveLabel;
    }
  }
  // CAPS에 없지만 수동 노트가 있는 날짜
  for (const [nKey, note] of Object.entries(notes)) {
    if (existingKeys.has(nKey)) continue;
    const parts = nKey.match(/^(.+)_(\d{4}-\d{2}-\d{2})$/);
    if (!parts) continue;
    const [, empName, date] = parts;
    if (date < from || date > to) continue;
    records.push({
      employeeId: empName, employeeName: empName, date,
      leaveType: note.leaveType || 'annual', leaveLabel: note.leaveLabel || '연차',
    });
  }

  // 연차/반차 레코드 추출
  const leaveRecords = records.filter(r =>
    r.leaveType === 'annual' || r.leaveType === 'halfAM' || r.leaveType === 'halfPM'
  );

  // 연차관리에 동기화
  const leaveData = db['연차관리'].load();
  if (!leaveData.leaveRecords) leaveData.leaveRecords = [];

  // 해당 월의 출결연동 레코드 제거 (다시 생성)
  const monthPrefix = `${y}-${String(m).padStart(2,'0')}`;
  leaveData.leaveRecords = leaveData.leaveRecords.filter(r =>
    !(r.date && r.date.startsWith(monthPrefix) && r.source === 'attendance')
  );

  let added = 0;
  for (const r of leaveRecords) {
    const annualDays = r.leaveType === 'annual' ? 1 : 0.5;
    const leaveTypeName = r.leaveType === 'annual' ? '연차' :
      (r.leaveType === 'halfAM' ? '오전반차' : '오후반차');

    // 같은 날짜+직원+수동 레코드가 이미 있으면 스킵
    const exists = leaveData.leaveRecords.some(lr =>
      lr.employeeName === r.employeeId && lr.date === r.date && lr.source !== 'attendance'
    );
    if (exists) continue;

    leaveData.leaveRecords.push({
      id: Date.now() + added,
      employeeName: r.employeeId,
      date: r.date,
      leaveType: leaveTypeName,
      annualDays,
      nonAnnualDays: 0,
      note: '출결기록 자동연동',
      source: 'attendance',
      createdAt: new Date().toISOString(),
    });
    added++;
  }

  db['연차관리'].save(leaveData);
  auditLog(req.user.name, '연차 벌크동기화', `${y}년 ${m}월: ${added}건 추가`);
  res.json({ ok: true, added, total: leaveRecords.length });
});

// (ensureAdminAccount, migrateContactsData는 server.js에서 직접 실행)

// 연차관리: 기존 annualLeave → annualLeaveOverride 마이그레이션
// 연차관리: 기존 단일값 → yearlyData 연도별 구조로 마이그레이션
(function migrateToYearlyData() {
  try {
    const data = db['연차관리'].load();
    let migrated = 0;
    const currentYear = new Date().getFullYear();
    for (const emp of data.employees || []) {
      // 이미 yearlyData가 있으면 스킵
      if (emp.yearlyData && Object.keys(emp.yearlyData).length > 0) continue;

      // 기존 단일값이 있으면 현재 연도의 yearlyData로 이동
      const hasOldData = (emp.additionalDays || emp.deductedDays || emp.paidDays ||
                          emp.annualLeaveOverride !== undefined);
      if (!hasOldData && !emp.annualLeave) continue;

      if (!emp.yearlyData) emp.yearlyData = {};
      emp.yearlyData[String(currentYear)] = {
        additionalDays: emp.additionalDays || 0,
        deductedDays: emp.deductedDays || 0,
        paidDays: emp.paidDays || 0,
        annualLeaveOverride: emp.annualLeaveOverride ?? null
      };
      // 기존 필드 정리 (하위호환을 위해 남겨둠, summary에서는 yearlyData 우선 사용)
      migrated++;
    }
    if (migrated > 0) {
      db['연차관리'].save(data);
      console.log(`✅ 연차관리: ${migrated}명 yearlyData 마이그레이션 완료`);
    }
  } catch(e) { console.warn('연차관리 마이그레이션 실패:', e.message); }
})();


// ─────────────────────────────────────────────────────────
// 출퇴근 자동 동기화 스케줄러
// 08:35, 11:35, 14:05, 19:05 — 출근/오후반차퇴근/오전반차출근/퇴근 시간 +5분
// ─────────────────────────────────────────────────────────
const AUTO_SYNC_TIMES = [
  { h: 8,  m: 35, label: '출근 체크' },
  { h: 11, m: 35, label: '오후반차 퇴근 체크' },
  { h: 14, m: 5,  label: '오전반차 출근 체크' },
  { h: 19, m: 5,  label: '퇴근 체크' },
];
let _lastSyncDay = {};  // { 'HH:MM': 'YYYY-MM-DD' } 중복 실행 방지

setInterval(() => {
  const now = new Date();
  const dow = now.getDay();
  if (dow === 0 || dow === 6) return;  // 주말 스킵

  const curH = now.getHours(), curM = now.getMinutes();
  const today = now.toISOString().slice(0, 10);

  for (const t of AUTO_SYNC_TIMES) {
    const key = `${String(t.h).padStart(2,'0')}:${String(t.m).padStart(2,'0')}`;
    if (curH === t.h && curM === t.m && _lastSyncDay[key] !== today) {
      _lastSyncDay[key] = today;
      const y = now.getFullYear(), mon = now.getMonth() + 1;
      const from = `${y}-${String(mon).padStart(2,'0')}-01`;
      const lastDay = new Date(y, mon, 0).getDate();
      const to = `${y}-${String(mon).padStart(2,'0')}-${lastDay}`;
      const url = `/api/attendance?from=${from}&to=${to}`;
      const cacheKey = `sum_${from}_${to}_all`;

      console.log(`[자동동기화] ${key} ${t.label} — CAPS 데이터 가져오는 중...`);
      capsGet(url).then(raw => {
        setCacheEntry(cacheKey, raw);
        console.log(`[자동동기화] ${key} ${t.label} 완료 — ${raw.length}건 캐시 갱신`);
      }).catch(err => {
        console.log(`[자동동기화] ${key} ${t.label} 실패: ${err.message}`);
      });
    }
  }
}, 60 * 1000);  // 1분마다 시간 체크


module.exports = router;

// ─── 외부 모듈(routes/salary.js 등)에서 재사용할 헬퍼 노출 ───────────
// routes/salary.js의 fetchAttendanceData가 같은 캐시(raw CAPS 데이터)를
// 읽어서 leaveType/overtime/late로 분류해야 하므로 공용으로 노출.
module.exports.analyzeRecord = analyzeRecord;
module.exports.isKoreanHoliday = isKoreanHoliday;
module.exports.timeToMin = timeToMin;
module.exports.minToHHMM = minToHHMM;
module.exports.minToDecimalHours = minToDecimalHours;

