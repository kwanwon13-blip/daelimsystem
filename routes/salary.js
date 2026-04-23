/**
 * routes/salary.js — 급여 모듈 API
 * Mounted at: app.use('/api/salary', require('./routes/salary'))
 *
 * 모든 엔드포인트: requireSalaryAccess (로그인 + salary_view 권한 + PIN 재인증)
 */
const express = require('express');
const router = express.Router();
const path = require('path');
const fs = require('fs');
const net = require('net');
const tls = require('tls');
let multer;
try { multer = require('multer'); } catch(e) { multer = null; }

const salaryDb = require('../db-salary');
const db = require('../db');
const { requireSalaryAccess, requireAuth, requireAdmin, logSalaryAccess } = require('../middleware/auth');
const { safeBody } = require('../middleware/sanitize');

// ── 이메일 발송 헬퍼 (기존 SMTP 설정 재활용) ────────────────────────────────
async function sendMail({ to, subject, html }) {
  // 설정 읽기
  const settings = db.설정.load ? db.설정.load() : {};
  const smtp = settings.smtp;
  if (!smtp || !smtp.user || !smtp.pass) throw new Error('SMTP 설정이 없습니다 (설정 탭에서 SMTP를 먼저 설정하세요)');

  return new Promise((resolve, reject) => {
    const boundary = 'boundary_' + Date.now();
    const body = [
      `From: ${smtp.user}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=`,
      'MIME-Version: 1.0',
      `Content-Type: multipart/alternative; boundary="${boundary}"`,
      '',
      `--${boundary}`,
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
      '',
      Buffer.from(html).toString('base64'),
      `--${boundary}--`,
    ].join('\r\n');

    const useSSL = (smtp.port === 465);
    let socket;
    const cmds = [];
    let step = 0;
    const next = () => { if (cmds[step]) { socket.write(cmds[step++] + '\r\n'); } };

    const init = (sock) => {
      socket = sock;
      socket.on('data', d => {
        const line = d.toString();
        if (line.startsWith('220') && step === 0) { cmds.push(`EHLO localhost`); next(); }
        else if (line.includes('235') || (line.includes('250') && step >= 2)) { next(); }
        else if (line.startsWith('334')) {
          if (step === 3) { socket.write(Buffer.from(`\0${smtp.user}\0${smtp.pass}`).toString('base64') + '\r\n'); step++; }
        }
        else if (line.startsWith('250') && step === 1) { cmds.push(`AUTH PLAIN`); next(); }
        else if (line.startsWith('221')) { resolve(); }
        else if (line.match(/^[45]/)) { reject(new Error(line.trim())); socket.destroy(); }
      });
      socket.on('error', reject);
    };

    cmds.push(null); // placeholder for EHLO
    // 실제로는 단순화된 SMTP: mail.js의 sendSmtpMail 함수를 직접 require로 재사용
    // 복잡한 구현 대신 mail.js의 내부 함수를 동적으로 가져옴
    try {
      const mailModule = require('fs').readFileSync(path.join(__dirname, 'mail.js'), 'utf-8');
      // mail.js에서 sendSmtpMail 함수 추출
      const fn = new Function('net','tls','require', mailModule.match(/function sendSmtpMail[\s\S]+?^}/m)?.[0] + '\nreturn sendSmtpMail;')(net, tls, require);
      fn({ smtpHost: smtp.host, smtpPort: smtp.port, smtpUser: smtp.user, smtpPass: smtp.pass,
        from: smtp.user, to, subject, html }).then(resolve).catch(reject);
    } catch(e) {
      reject(new Error('메일 발송 실패: ' + e.message));
    }
  });
}

// multer — EDI 파일 업로드
const uploadDir = path.join(__dirname, '..', 'data', 'edi-uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer ? multer({ dest: uploadDir, limits: { fileSize: 10 * 1024 * 1024 } }) : null;

// 직원 이름 조회 (ERP 조직관리 우선, 없으면 salary_configs.name 사용)
function getNameMap(companyId) {
  const map = {};
  try {
    const org = db.조직관리.load();
    (org.users || []).forEach(u => { if (u.name) map[u.id] = u.name; });
  } catch(e) {}
  // salary_configs.name으로 보완 (대림컴퍼니 등 ERP 미등록 직원)
  try {
    const cfgs = salaryDb.configs.getAll(companyId);
    cfgs.forEach(c => { if (c.name && !map[c.userId]) map[c.userId] = c.name; });
  } catch(e) {}
  return map;
}

// 직원명 → userId 매핑 (ERP + salary_configs 통합)
function getNameToUserIdMap(companyId) {
  const map = {};
  try {
    const org = db.조직관리.load();
    (org.users || []).forEach(u => { if (u.name) map[u.name] = u.id; });
  } catch(e) {}
  try {
    const cfgs = salaryDb.configs.getAll(companyId);
    cfgs.forEach(c => { if (c.name) map[c.name] = c.userId; });
  } catch(e) {}
  return map;
}

// ── 근무일수 자동계산 (평일 기준) ──────────────────────────────────────────────
// 해당 월의 월~금 일수를 반환 (공휴일 제외 없음 — 추후 공휴일 테이블 추가 가능)
// 대림컴퍼니처럼 CAPS 미연동 회사의 기본값으로 사용
function calcWeekdaysInMonth(yearMonth) {
  const [y, m] = yearMonth.split('-').map(Number);
  const lastDay = new Date(y, m, 0).getDate();
  let count = 0;
  for (let d = 1; d <= lastDay; d++) {
    const dow = new Date(y, m - 1, d).getDay(); // 0=일, 6=토
    if (dow !== 0 && dow !== 6) count++;
  }
  return count;
}

// ── 회사별 출퇴근 연동 모드 ───────────────────────────────────────────────────
// 추후 대림컴퍼니 자체 ERP 출퇴근 시스템 연동 시 이 함수만 수정
async function getAttendanceWorkDays(userId, companyId, yearMonth) {
  if (companyId === 'dalim-sm') {
    // 대림에스엠: CAPS 연동 (캐시에 데이터 있으면 사용, 없으면 평일 기준)
    // → attendance-import 엔드포인트에서 처리, 여기서는 fallback만
    return null; // null = 수동/CAPS에서 가져와야 함
  }
  if (companyId === 'dalim-company') {
    // 대림컴퍼니: 지금은 월별 평일 수 자동반환
    // TODO: 자체 ERP 출퇴근 시스템 연동 시 아래를 실제 데이터로 교체
    return calcWeekdaysInMonth(yearMonth);
  }
  return null;
}

// ── CAPS 출퇴근 데이터 집계 (공용 헬퍼) ────────────────────────────────────────
// /attendance-import 라우트와 /calculate 라우트에서 공통으로 사용.
// 반환: { employees: [{userId, name, workDays, totalOvertimeH, ...}], note?, warn? }
//
// 대림에스엠: CAPS 지문인식 데이터 (attendance-store 캐시) → 실측 workDays + 연장시간
// 대림컴퍼니: CAPS 미연동 → 월 평일 수 자동, 연장시간 0
//
// ★ 중요: attendance-store 캐시는 CAPS 브릿지 원본(raw) 데이터
//   ({name, date, inTime, outTime, swipeCount}) 이므로 여기서 analyzeRecord로
//   분류(leaveType/overtime/late)한 뒤 attendanceNotes / 연차관리 leaveRecords를
//   병합해야 한다. routes/attendance.js /summary 와 같은 파이프라인이어야
//   급여탭과 출퇴근탭 수치가 일치한다.
async function fetchAttendanceData(companyId, yearMonth) {
  const [year, mon] = yearMonth.split('-');
  const from = `${year}-${String(mon).padStart(2,'0')}-01`;
  const lastDay = new Date(+year, +mon, 0).getDate();
  const to = `${year}-${String(mon).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

  // 이름 → userId 매핑 구축 + CAPS이름 → 앱이름 매핑
  const nameToId = {};
  const capsNameMap = {}; // CAPS 이름 → 앱 이름
  const adminNames = new Set();
  const excludeNames = new Set();
  try {
    const uData = db.loadUsers();
    (uData.users || []).forEach(u => {
      if (u.name) nameToId[u.name] = u.id;
      if (u.capsName && u.capsName !== u.name) {
        nameToId[u.capsName] = u.id;
        capsNameMap[u.capsName] = u.name;
      }
      if (u.role === 'admin') {
        adminNames.add(u.name);
        if (u.capsName) adminNames.add(u.capsName);
      }
    });
  } catch(e) {}
  try {
    const workData = db.출퇴근관리.load();
    (workData.excludeEmployees || []).forEach(n => excludeNames.add(n));
  } catch(e) {}
  const cfgs = salaryDb.configs.getAll(companyId);
  cfgs.forEach(c => {
    if (c.name && !nameToId[c.name]) nameToId[c.name] = c.userId;
  });

  // 대림컴퍼니: CAPS 없음 → 평일 수 자동 적용
  const attendanceStoreDir = path.join(__dirname, '..', 'data', 'attendance-store');
  const cacheKeyRaw = `sum_${from}_${to}_all`;
  const cacheFile = path.join(attendanceStoreDir,
    Buffer.from(cacheKeyRaw, 'utf8').toString('hex') + '.json');

  if (companyId === 'dalim-company' || !fs.existsSync(cacheFile)) {
    const weekdays = calcWeekdaysInMonth(yearMonth);
    if (companyId === 'dalim-company') {
      const nameMapLocal = getNameMap(companyId);
      const empList = cfgs.map(c => ({
        userId: c.userId,
        name: c.name || nameMapLocal[c.userId] || c.userId,
        workDays: weekdays,
        annualDays: 0, absentDays: 0, lateCount: 0, totalOvertimeH: 0,
        _autoCalc: true,
      }));
      return {
        employees: empList,
        note: `대림컴퍼니: CAPS 미연동 — ${yearMonth.slice(5)}월 평일 수(${weekdays}일) 자동 적용`,
      };
    }
    return { employees: [], warn: 'CAPS 출퇴근 데이터 없음 — 출퇴근 탭에서 해당 월 먼저 조회/동기화 필요' };
  }

  // 대림에스엠: CAPS 캐시 읽기
  const rawFile = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
  const payload = (rawFile && typeof rawFile === 'object' && 'data' in rawFile) ? rawFile.data : rawFile;
  let rawRecords = [];
  if (Array.isArray(payload)) rawRecords = payload;
  else if (payload && Array.isArray(payload.records)) rawRecords = payload.records;
  else if (payload && typeof payload === 'object') {
    for (const v of Object.values(payload)) {
      if (Array.isArray(v)) rawRecords.push(...v);
    }
  }

  // ── 캐시 포맷 판별 ──────────────────────────────────────────────
  // 신버전 캐시: {name, date, inTime, outTime, swipeCount} (raw tenter)
  // 구버전 캐시: {employeeName, leaveType, overtime, late, ...} (이미 분류됨)
  const looksRaw = rawRecords.length > 0 &&
    rawRecords[0].name !== undefined &&
    rawRecords[0].leaveType === undefined;

  // attendance.js에서 분류/변환 헬퍼 불러오기 (circular 방지 위해 지연 require)
  let analyzeRecord;
  try {
    analyzeRecord = require('./attendance').analyzeRecord;
  } catch(e) {}

  let records = [];
  if (looksRaw && analyzeRecord) {
    // 원본 → 분류 변환
    records = rawRecords.map(analyzeRecord);
  } else {
    // 이미 분류된 데이터 (구버전) — 그대로 사용
    records = rawRecords.map(r => ({ ...r }));
  }

  // CAPS 이름 → 앱 이름 치환
  for (const r of records) {
    if (r.employeeName && capsNameMap[r.employeeName]) {
      r.employeeName = capsNameMap[r.employeeName];
      r.employeeId = capsNameMap[r.employeeId] || r.employeeName;
    }
  }

  // admin / 기록제외 직원 필터
  records = records.filter(r => {
    const nm = r.employeeName || r.employeeId;
    if (!nm) return false;
    if (adminNames.has(nm)) return false;
    if (excludeNames.has(nm)) return false;
    return true;
  });

  // 퇴근 미기록 체크 제외 (skipCheckoutReview)
  try {
    const workData = db.출퇴근관리.load();
    const skipCheckoutNames = new Set(workData.skipCheckoutReview || []);
    if (skipCheckoutNames.size > 0) {
      for (const r of records) {
        if (r.leaveType === 'noSwipeOut' && skipCheckoutNames.has(r.employeeName)) {
          r.leaveType = 'normal';
          r.leaveLabel = '정상';
          r.reviewStatus = 'normal';
        }
      }
    }
  } catch(e) {}

  // attendanceNotes 병합 (관리자 수동 수정)
  try {
    const workData = db.출퇴근관리.load();
    const notes = workData.attendanceNotes || {};
    for (const r of records) {
      const nKey = `${r.employeeId || r.employeeName}_${r.date}`;
      if (notes[nKey]) {
        r.leaveType = notes[nKey].leaveType || r.leaveType;
        r.leaveLabel = notes[nKey].leaveLabel || r.leaveLabel;
        if (notes[nKey].modifiedInTime !== undefined) r.inTime = notes[nKey].modifiedInTime;
        if (notes[nKey].modifiedOutTime !== undefined) r.outTime = notes[nKey].modifiedOutTime;
        // 지각/연장 재계산은 analyzeRecord에 맡기지 않고 단순화
        // (summary 라우트와 살짝 다를 수 있음 — 하지만 workDays/연장 집계에 크게 영향 없음)
      }
    }
  } catch(e) {}

  // 연차관리 leaveRecords 병합 (결재 승인된 연차 → 출퇴근에 반영)
  try {
    const leaveData = db['연차관리'].load();
    const ltCode = { '연차':'annual','반차':'halfAM','오전반차':'halfAM','오후반차':'halfPM','병가':'sick','특별휴가':'special' };
    const monthLeaves = (leaveData.leaveRecords || []).filter(r => r.date >= from && r.date <= to);
    const recByKey = {};
    for (const r of records) {
      recByKey[`${r.employeeName}_${r.date}`] = r;
    }
    for (const lr of monthLeaves) {
      if (adminNames.has(lr.employeeName)) continue;
      const key = `${lr.employeeName}_${lr.date}`;
      const attLeaveType = ltCode[lr.leaveType] || 'annual';
      if (recByKey[key]) {
        const rec = recByKey[key];
        // 이미 연차/반차인 기록은 건드리지 않음
        if (rec.leaveType === 'annual' || rec.leaveType === 'halfAM' || rec.leaveType === 'halfPM') continue;
        rec.leaveType = attLeaveType;
      } else {
        // CAPS 기록 없는 날짜 → 가상 레코드
        const dow = new Date(lr.date).getDay();
        if (dow === 0 || dow === 6) continue;
        records.push({
          employeeId: lr.employeeName,
          employeeName: lr.employeeName,
          date: lr.date,
          leaveType: attLeaveType,
          late: false,
          overtime: 0,
        });
      }
    }
  } catch(e) {}

  // 직원별 집계
  const byName = {};
  for (const r of records) {
    const name = r.employeeName || r.employeeId;
    if (!name) continue;
    if (!byName[name]) byName[name] = { normalDays:0, halfAM:0, halfPM:0, annualDays:0, absentDays:0, lateCount:0, totalOvertimeMin:0 };
    const e = byName[name];
    if (r.leaveType === 'normal')   e.normalDays++;
    else if (r.leaveType === 'halfAM') e.halfAM++;
    else if (r.leaveType === 'halfPM') e.halfPM++;
    else if (r.leaveType === 'annual') e.annualDays++;
    else if (r.leaveType === 'absent') e.absentDays++;
    if (r.late) e.lateCount++;
    e.totalOvertimeMin += (r.overtime || 0);
  }

  const result = [];
  for (const [empName, stats] of Object.entries(byName)) {
    const userId = nameToId[empName];
    if (!userId) continue;
    const cfg = cfgs.find(c => c.userId === userId);
    if (!cfg) continue;

    const workDays = stats.normalDays + stats.halfAM * 0.5 + stats.halfPM * 0.5;
    result.push({
      userId,
      name: capsNameMap[empName] || empName,
      workDays: Math.round(workDays * 2) / 2,
      annualDays: stats.annualDays + stats.halfAM * 0.5 + stats.halfPM * 0.5,
      absentDays: stats.absentDays,
      lateCount: stats.lateCount,
      totalOvertimeH: Math.round((stats.totalOvertimeMin / 60) * 10) / 10,
    });
  }
  return { employees: result };
}

// ── 퇴사 경과 월수 계산 ─────────────────────────────────────────────
// null: 재직 중 or 데이터 없음
// 0: 퇴사한 달
// 1: 퇴사 다음달 (1개월 경과)
// 2: 2개월 경과 등...
function calcMonthsSinceResign(user, yearMonth) {
  if (!user || user.status !== 'resigned' || !user.resignDate) return null;
  const [ry, rm] = user.resignDate.slice(0, 7).split('-').map(Number);
  const [py, pm] = yearMonth.split('-').map(Number);
  if (!ry || !rm || !py || !pm) return null;
  return (py - ry) * 12 + (pm - rm);
}

// ── 중도 입/퇴사자 일할계산용 ratio 산출 ────────────────────────────
// 엑셀 급여계산설정 F11 정산기간(monthly / prev20_curr19) 대응.
// 반환:
//   { ratio: 0~1, activeDays: number, totalDays: number, periodStart/End }
//   일할계산 필요 없으면 { ratio: 1, ... } 반환.
function calcProrateRatio(user, yearMonth, periodType) {
  const [y, m] = yearMonth.split('-').map(Number);
  if (!y || !m) return { ratio: 1, activeDays: 0, totalDays: 0 };
  let periodStart, periodEnd;
  if (periodType === 'prev20_curr19') {
    // 전월 20일 ~ 당월 19일
    periodStart = new Date(y, m - 2, 20);
    periodEnd   = new Date(y, m - 1, 19);
  } else {
    // 당월 1일 ~ 말일
    periodStart = new Date(y, m - 1, 1);
    periodEnd   = new Date(y, m, 0);
  }
  const dayMs = 24 * 3600 * 1000;
  const totalDays = Math.round((periodEnd - periodStart) / dayMs) + 1;

  const hireDate = user?.hireDate ? new Date(user.hireDate) : null;
  const resignDate = user?.resignDate ? new Date(user.resignDate) : null;

  // 재직 구간: max(periodStart, hireDate) ~ min(periodEnd, resignDate)
  const effStart = hireDate && hireDate > periodStart ? hireDate : periodStart;
  const effEnd   = resignDate && resignDate < periodEnd ? resignDate : periodEnd;

  if (effEnd < effStart) {
    // 해당 월에 아예 재직 없음
    return { ratio: 0, activeDays: 0, totalDays, periodStart, periodEnd };
  }
  const activeDays = Math.round((effEnd - effStart) / dayMs) + 1;
  const ratio = Math.min(1, activeDays / totalDays);
  return { ratio, activeDays, totalDays, periodStart, periodEnd };
}

// ── 자동 드래프트 대상 포함 여부 (관대하게) ────────────────────────────────
// 급여 작성 시 자동으로 후보에 넣을지 판정.
// 과거 규칙: 퇴사월 + 1개월까지만 자동 포함 → 2개월차 정산 누락 위험.
// 새 규칙 (2026-04-17): 재직자 + 퇴사 3개월 이내까지 자동 포함.
// 그 이후는 관리자가 [+ 사람 추가] 모달에서 수동 추가.
// 퇴사자는 노출되더라도 프론트에서 [퇴사 N개월] 배지로 표시 → 관리자가 판단해서 뺌.
function isActiveForMonth(user, yearMonth) {
  if (!user) return true; // ERP 미등록 (대림컴퍼니 등) → 일단 포함
  if (user.status !== 'resigned') return true;
  const months = calcMonthsSinceResign(user, yearMonth);
  if (months === null) return false;
  return months >= 0 && months <= 3; // 퇴사월~3개월까지
}

// 조직관리 users를 userId → user 객체로 매핑
// 조회 키는 3가지:
//   - u.id              (UUID 기반 기존 계정 — 남관원/한윤호/장은지 등)
//   - "companyId:sabun" (엑셀 사번 기반 신규 계정 — ws-001 등)
//   - sabun (lowercase) (fallback, 회사 중복 시 마지막에 저장)
function getOrgUserMap() {
  try {
    const org = db.조직관리.load();
    const map = {};
    (org.users || []).forEach(u => {
      if (u.id) map[u.id] = u;
      if (u.sabun && u.companyId) {
        map[`${u.companyId}:${String(u.sabun).toLowerCase()}`] = u;
      }
      if (u.sabun) map[String(u.sabun).toLowerCase()] = u;
    });
    return map;
  } catch (e) {
    return {};
  }
}

// 급여 config/record → 조직관리 user 조회 헬퍼
function findOrgUser(orgUserMap, companyId, userId) {
  if (!userId) return null;
  const key1 = `${companyId}:${String(userId).toLowerCase()}`;
  return orgUserMap[key1] || orgUserMap[userId] || orgUserMap[String(userId).toLowerCase()] || null;
}

// 전월 YYYY-MM 계산 (엑셀 "지난달 시트 복제" 방식 지원용)
function prevYearMonth(ym) {
  const [Y, M] = String(ym || '').split('-').map(Number);
  if (!Y || !M) return null;
  const d = new Date(Y, M - 2, 1); // 전월 1일
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// 전월 record 에서 이번달로 "수동 입력 성격" 필드만 복사해오는 시드
// 기본급/수당/4대보험/세금은 calcSalary 가 config·settingsRow 로 재계산해야 하므로 시드에서 제외.
// 복사 대상: 상여/소급/연차수당/extraPay1..8/extraDeduction1..8/기타 공제 (misc 등 관리자 직접 입력 값)
function buildSeedFromPrev(prevRec) {
  if (!prevRec) return null;
  const seed = {};
  const fields = [
    'bonusPay', 'retroPay', 'leavePay', 'teamLeaderAllowance',
    'miscDeduction1', 'miscDeduction2',
    'healthAnnual', 'ltcAnnual',
    'healthInstallment', 'ltcInstallment',
    'healthAprExtra', 'ltcAprExtra',
    'healthRefundInterest', 'ltcRefundInterest',
    'incomeTaxAdj', 'localTaxAdj',
  ];
  for (const k of fields) {
    if (prevRec[k] != null) seed[k] = prevRec[k];
  }
  for (let i = 1; i <= 8; i++) {
    if (prevRec[`extraPay${i}`] != null) seed[`extraPay${i}`] = prevRec[`extraPay${i}`];
    if (prevRec[`extraDeduction${i}`] != null) seed[`extraDeduction${i}`] = prevRec[`extraDeduction${i}`];
  }
  return seed;
}

// ── 모든 라우트에 requireSalaryAccess 적용 ──────────────────────────────────────
router.use(requireSalaryAccess);

// ══════════════════════════════════════════════════════════════════════════════
// 4대보험 요율 설정
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/settings/:companyId
router.get('/settings/:companyId', (req, res) => {
  const { companyId } = req.params;
  const all = salaryDb.settings.getAll(companyId);
  res.json({ settings: all, current: all[0] || null });
});

// PUT /api/salary/settings/:companyId
router.put('/settings/:companyId', requireAdmin, (req, res) => {
  try {
    const { companyId } = req.params;
    const { effectiveFrom, ...data } = req.body;
    if (!effectiveFrom) return res.status(400).json({ error: '적용 시작일 필수' });
    const result = salaryDb.settings.upsert(companyId, effectiveFrom, data);
    logSalaryAccess(req.user.userId, 'SETTINGS_UPDATE', `${companyId} 요율 설정 변경`);
    res.json({ ok: true, settings: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 직원별 급여 기초 설정
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/config?company=dalim-sm&userId=ws-016
router.get('/config', (req, res) => {
  const { company, userId } = req.query;
  if (userId) {
    const config = salaryDb.configs.get(userId, company);
    res.json({ config });
  } else {
    const configs = salaryDb.configs.getAll(company);
    res.json({ configs });
  }
});

// POST /api/salary/config
router.post('/config', (req, res) => {
  try {
    const result = salaryDb.configs.upsert(req.body);
    logSalaryAccess(req.user.userId, 'CONFIG_UPDATE', `${req.body.userId} 급여설정 변경`);
    res.json({ ok: true, config: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/salary/config/:userId/:companyId
router.delete('/config/:userId/:companyId', requireAdmin, (req, res) => {
  salaryDb.configs.delete(req.params.userId, req.params.companyId);
  res.json({ ok: true });
});

// ──────────────────────────────────────────────────────────────────────────────
// 입사일/퇴사일 저장 — 조직관리.json 에 쓰기
// 직원 설정 테이블에서 입사일/퇴사일 인라인 편집 시 호출됨.
// ERP 미가입자도 처리 가능: 조직관리.json에 없으면 최소 항목으로 신규 생성.
// ERP 가입자가 퇴사일 들어가면 status='resigned' 로 변경 (로그인 차단).
// ──────────────────────────────────────────────────────────────────────────────
router.post('/config/:userId/employment', requireAdmin, (req, res) => {
  try {
    const rawId = String(req.params.userId || '').trim();
    if (!rawId) return res.status(400).json({ error: 'userId 필요' });
    const { companyId, hireDate, resignDate, name, department, position, birthDate } = req.body || {};
    if (!companyId) return res.status(400).json({ error: 'companyId 필요' });

    // 날짜 형식 검증 (빈값 허용)
    const dateOk = v => !v || /^\d{4}-\d{2}-\d{2}$/.test(v);
    if (!dateOk(hireDate)) return res.status(400).json({ error: '입사일 형식 오류 (YYYY-MM-DD)' });
    if (!dateOk(resignDate)) return res.status(400).json({ error: '퇴사일 형식 오류 (YYYY-MM-DD)' });

    const org = db.조직관리.load() || {};
    org.users = org.users || [];

    // 찾기: (1) id == rawId, (2) companyId+sabun 일치
    const lowered = rawId.toLowerCase();
    let user = org.users.find(u =>
      u.id === rawId ||
      (u.sabun && String(u.sabun).toLowerCase() === lowered && u.companyId === companyId)
    );
    const isNew = !user;

    if (!user) {
      // ERP 미가입자 최소 항목 신규 생성
      user = {
        id: 'u_unreg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
        sabun: rawId,
        companyId: companyId,
        name: name || '',
        department: department || '',
        position: position || '',
        role: 'none',
        status: 'unregistered',
        createdAt: new Date().toISOString(),
      };
      org.users.push(user);
    }

    // 필드 업데이트 (undefined는 건드리지 않음)
    if (hireDate !== undefined) user.hireDate = hireDate || '';
    if (resignDate !== undefined) {
      user.resignDate = resignDate || '';
      // ERP 가입자 퇴사 처리 / 복귀 처리
      if (resignDate && user.status === 'approved') user.status = 'resigned';
      if (!resignDate && user.status === 'resigned') user.status = 'approved';
    }
    if (name && !user.name) user.name = name;
    if (department && !user.department) user.department = department;
    if (position && !user.position) user.position = position;
    if (birthDate && !user.birthDate) user.birthDate = birthDate;

    db.조직관리.save(org);

    // 연차관리 동기화 (이름 기준)
    try {
      if (db.연차관리 && user.name) {
        const leaveData = db.연차관리.load() || {};
        const emp = (leaveData.employees || []).find(e => e.name === user.name);
        if (emp) {
          if (hireDate !== undefined) emp.hireDate = hireDate || '';
          if (resignDate !== undefined) emp.resignDate = resignDate || '';
          db.연차관리.save(leaveData);
        }
      }
    } catch(e) {}

    logSalaryAccess(req.user.userId, 'EMPLOYMENT_UPDATE',
      `${user.name || rawId} 입사=${user.hireDate || '-'} 퇴사=${user.resignDate || '-'} (${isNew ? '신규' : '수정'})`);

    res.json({ ok: true, user, isNew });
  } catch (e) {
    console.error('employment update error:', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 자유 항목명
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/labels?company=dalim-sm&month=2026-03
router.get('/labels', (req, res) => {
  const { company, month } = req.query;
  res.json({ labels: salaryDb.itemLabels.get(company, month) });
});

// PUT /api/salary/labels
router.put('/labels', (req, res) => {
  const { companyId, yearMonth, ...data } = req.body;
  const result = salaryDb.itemLabels.upsert(companyId, yearMonth, data);
  res.json({ ok: true, labels: result });
});

// ══════════════════════════════════════════════════════════════════════════════
// 월별 급여 (급여대장)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/records?company=dalim-sm&month=2026-03
// 퇴사 여부는 자동 제외하지 않고 monthsSinceResign 필드로 프론트가 배지 표시.
// 관리자가 [− 선택 빼기]로 수동 제거하는 방식.
router.get('/records', (req, res) => {
  const { company, month } = req.query;
  const recs = salaryDb.records.getByMonth(company, month);
  const labels = salaryDb.itemLabels.get(company, month);
  const orgUserMap = getOrgUserMap();
  // 저장된 레코드에 재직상태 + 퇴사 경과월 부착 (프론트 배지용)
  const enriched = recs.map(r => {
    const u = findOrgUser(orgUserMap, r.companyId || company, r.userId);
    return {
      ...r,
      resigned: u?.status === 'resigned',
      resignDate: u?.resignDate || null,
      monthsSinceResign: calcMonthsSinceResign(u, month),
    };
  });
  logSalaryAccess(req.user.userId, 'VIEW', `급여대장 조회 ${company} ${month}`);
  res.json({ records: enriched, labels });
});

// GET /api/salary/resigned-users?company=dalim-sm&month=2026-04
// 해당 월 기준 퇴사자 목록. [+ 사람 추가] 모달의 "퇴사자" 탭에서 사용.
// 모든 퇴사자를 노출하되, 경과 개월수로 정렬/분류 (3개월 이내 추천, 그 이상은 과거)
router.get('/resigned-users', (req, res) => {
  try {
    const { company, month } = req.query;
    const yearMonth = month || new Date().toISOString().slice(0, 7);
    const org = db.조직관리.load();
    const users = (org.users || []).filter(u =>
      u.status === 'resigned' &&
      (!company || u.companyId === company || (company === 'dalim-sm' && !u.companyId))
    );
    const enriched = users.map(u => {
      const monthsSinceResign = calcMonthsSinceResign(u, yearMonth);
      // userId는 salary_configs.userId와 매칭되도록 사번(소문자) 우선, 없으면 legacy id
      // 이게 맞아야 [+ 사람 추가] 모달의 "재직자" 탭에서 퇴사자가 걸러진다.
      const resolvedId = u.sabun ? String(u.sabun).toLowerCase() : u.id;
      return {
        userId: resolvedId,
        orgId: u.id, // 디버깅/향후 참조용
        name: u.name,
        department: u.department || '',
        resignDate: u.resignDate || '',
        monthsSinceResign,
        // 추천 범위: 퇴사월~3개월 이내 (자동 드래프트 포함 범위와 동일)
        recommendedForMonth: monthsSinceResign !== null && monthsSinceResign >= 0 && monthsSinceResign <= 3,
      };
    }).sort((a, b) => (b.resignDate || '').localeCompare(a.resignDate || ''));
    res.json({ resignedUsers: enriched });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/salary/records/:userId/:month
router.get('/records/:userId/:month', (req, res) => {
  const { userId, month } = req.params;
  const { company } = req.query;
  const rec = salaryDb.records.getOne(userId, company, month);
  const config = salaryDb.configs.get(userId, company);
  logSalaryAccess(req.user.userId, 'VIEW', `개인급여 조회 ${userId} ${month}`);
  res.json({ record: rec, config });
});

// POST /api/salary/calculate — 자동계산 (draft 생성/갱신)
// 2026-04-17: CAPS 출퇴근 데이터 자동 병합 — 관리자가 연장근무 수동 입력 없이도
// 급여 작성 시 CAPS 실제 집계(근무일수+연장시간)가 자동 반영됨.
// 우선순위: 수동입력(salary_overtime) > CAPS 자동 > 0
router.post('/calculate', async (req, res) => {
  try {
    const { companyId, yearMonth, userIds, overwrite = false, purgeStale = false } = req.body;
    const settingsRow = salaryDb.settings.get(companyId);
    if (!settingsRow) return res.status(400).json({ error: '요율 설정이 없습니다.' });

    // 조직관리 users 매핑 (퇴사자 필터링용)
    const orgUserMap = getOrgUserMap();

    // ─ 전월/이번달 records 맵 (엑셀 "지난달 시트 복제" 방식) ─
    // 자동 모드에서는 "전월에 급여받은 사람 + 이번달 이미 작성된 사람" 만 대상에 포함.
    // → 퇴사자(전월에 안 받았으면 자동 제외), 아직 입사 전 사람 자동 제외.
    // → 신규 입사자는 [+ 사람 추가] 모달로 userIds 명시 경로를 타서 포함.
    const prevYm = prevYearMonth(yearMonth);
    const prevRecMap = {};
    if (prevYm) {
      (salaryDb.records.getByMonth(companyId, prevYm) || []).forEach(r => { prevRecMap[r.userId] = r; });
    }
    const thisRecMap = {};
    (salaryDb.records.getByMonth(companyId, yearMonth) || []).forEach(r => { thisRecMap[r.userId] = r; });

    // ※ userIds가 명시적으로 들어오면 (+ 사람 추가 모달 등) 필터 무시 — 관리자가 직접 고른 것
    const autoMode = !userIds?.length;
    const targets = autoMode
      ? salaryDb.configs.getAll(companyId)
          .filter(c => isActiveForMonth(findOrgUser(orgUserMap, c.companyId, c.userId), yearMonth))
          // ★ 자동 모드의 "대상자" 는 엄격하게 "전월에 급여받은 사람" 뿐.
          //   이번달에만 draft 가 있는 사람은 별도로 userIds 로 들어와야 포함 (+ 사람 추가 경로).
          //   이렇게 해야 과거 잘못된 로직으로 생성된 잡음이 계속 살아남지 않음.
          .filter(c => prevRecMap[c.userId])
      : userIds.map(id => salaryDb.configs.get(id, companyId)).filter(Boolean);

    // ─ 잔여 draft 정리 (purgeStale) ─
    // 이번달 thisRecMap 에 있지만 "전월에도 없고 이번 targets 에도 없는" draft 레코드는
    // 과거 잘못된 로직으로 생성된 잡음. 자동 모드에서만 적용.
    // confirmed/paid 는 절대 건들지 않음.
    const targetUserIdSet = new Set(targets.map(c => c.userId));
    const staleDrafts = autoMode
      ? Object.values(thisRecMap).filter(r =>
          r.status === 'draft'
          && !targetUserIdSet.has(r.userId)
          && !prevRecMap[r.userId]
        )
      : [];
    const staleCount = staleDrafts.length;
    let staleDeleted = 0;
    if (purgeStale && autoMode && staleCount > 0) {
      for (const r of staleDrafts) {
        try {
          salaryDb.records.delete(r.id);
          // thisRecMap 에서도 제거 (아래 계산 루프에 영향 없도록)
          delete thisRecMap[r.userId];
          staleDeleted++;
        } catch (e) {
          // draft 가 아닌 것은 delete() 가 거부 — 안전장치
          console.warn('[salary/calculate] stale purge skip:', r.id, e.message);
        }
      }
    }

    // ── 회사별 근무일수 자동계산 (fallback) ─────────────────────────────────
    const autoWorkDays = await getAttendanceWorkDays(null, companyId, yearMonth);

    // ── CAPS 출퇴근 자동 병합 ──────────────────────────────────────────────
    // 대림에스엠: CAPS 실측 workDays + 연장시간 집계
    // 대림컴퍼니: 평일 수 자동, 연장시간 0
    let attendanceMap = {};
    let attendanceNote = null;
    try {
      const att = await fetchAttendanceData(companyId, yearMonth);
      (att.employees || []).forEach(e => { attendanceMap[e.userId] = e; });
      attendanceNote = att.note || att.warn || null;
    } catch(e) {
      console.warn('[salary/calculate] CAPS fetch 실패:', e.message);
    }

    // 수동 입력 연장근무 (관리자가 명시적으로 넣은 값) — CAPS보다 우선
    const overtimeRows = salaryDb.overtime.getByMonth(companyId, yearMonth);
    const overtimeMap = {};
    overtimeRows.forEach(r => { overtimeMap[r.userId] = r; });

    // 라벨 (비과세 플래그 지원)
    const labels = salaryDb.itemLabels.get(companyId, yearMonth);
    // 정산기간 타입 (회사 설정)
    const periodType = settingsRow.periodType || 'monthly';

    let capsAutoCount = 0;
    let prorateCount = 0;
    let prevSeedCount = 0;  // 전월 값 시드된 건수 (신규 draft 생성 시)
    const results = [];
    for (const config of targets) {
      const existing = thisRecMap[config.userId] || salaryDb.records.getOne(config.userId, companyId, yearMonth);
      if (existing && existing.status !== 'draft' && !overwrite) {
        results.push({ userId: config.userId, skipped: true, reason: '이미 확정/지급됨' });
        continue;
      }

      const caps = attendanceMap[config.userId];

      // 근무일수 우선순위: 수동 입력 > CAPS > 회사별 자동(평일) > 기존값
      const workDays = (existing?.workDays && existing.workDays > 0 && existing._workDaysManual)
        ? existing.workDays
        : (caps?.workDays ?? autoWorkDays ?? existing?.workDays ?? 0);

      // 연장근무 우선순위: 수동 입력값(overtime 탭) > CAPS 자동집계 > 0
      // ※ calcSalary는 overtimeHours/nightHours/... (plural) 키를 읽음
      let overtimeData = overtimeMap[config.userId] || null;
      if (!overtimeData && caps && caps.totalOvertimeH > 0) {
        overtimeData = {
          userId: config.userId, companyId, yearMonth,
          overtimeHours: caps.totalOvertimeH,
          nightHours: 0, holidayHours: 0, holidayOtHours: 0,
          _source: 'caps',
        };
        capsAutoCount++;
      }

      // 중도 입/퇴사자 일할계산 준비
      const orgUser = findOrgUser(orgUserMap, companyId, config.userId);
      let prorate = null;
      if (orgUser && (orgUser.hireDate || orgUser.resignDate)) {
        const pr = calcProrateRatio(orgUser, yearMonth, periodType);
        if (pr.ratio < 1 && pr.ratio >= 0) {
          prorate = {
            ratio: pr.ratio,
            activeDays: pr.activeDays,
            denom: settingsRow.prorateDenom || 'period_ratio',
            mode:  settingsRow.prorateMode  || 'base_plus_allow',
          };
          if (pr.ratio < 1) prorateCount++;
        }
      }

      // extraItems 시드 우선순위:
      //   1) 이번달에 이미 저장된 레코드 (draft 포함) → 그대로 유지 (관리자가 수정한 값 보존)
      //   2) 전월 레코드 값 (상여·연차수당·기타 공제 등 수동 입력 성격 필드만) → "지난달 시트 복제" 효과
      //   3) 빈 객체 (최초 도입 회사)
      let extraSeed;
      if (existing) {
        extraSeed = existing;
      } else {
        const prevSeed = buildSeedFromPrev(prevRecMap[config.userId]);
        if (prevSeed && Object.keys(prevSeed).length) {
          extraSeed = prevSeed;
          prevSeedCount++;
        } else {
          extraSeed = {};
        }
      }
      const calc = salaryDb.calcSalary({
        config, settingsRow, overtimeData, yearMonth,
        extraItems: extraSeed, labels, prorate,
      });
      const saved = salaryDb.records.upsert({
        ...existing,
        ...calc,
        userId: config.userId,
        companyId,
        yearMonth,
        workDays,
        // CAPS 연동 메타 (프론트에서 "CAPS 자동" 배지 표시용)
        annualDays: caps?.annualDays ?? existing?.annualDays ?? 0,
        absentDays: caps?.absentDays ?? existing?.absentDays ?? 0,
        lateCount: caps?.lateCount ?? existing?.lateCount ?? 0,
      });
      results.push({
        userId: config.userId,
        record: saved,
        capsAuto: !!(caps && overtimeData?._source === 'caps'),
        prorate: prorate ? { ratio: prorate.ratio, activeDays: prorate.activeDays } : null,
      });
    }
    logSalaryAccess(req.user.userId, 'CALCULATE',
      `급여계산 ${companyId} ${yearMonth} (CAPS자동 ${capsAutoCount}건 · 전월시드 ${prevSeedCount}건 · 잔여정리 ${staleDeleted}/${staleCount}건)`);
    res.json({
      ok: true,
      results,
      autoWorkDays,
      capsAutoCount,
      prevSeedCount,    // 전월 값에서 복제된 건수 (UI 에 안내)
      prevMonth: prevYm,
      staleCount,       // 자동 대상도 아니고 전월에도 없는 draft 개수 (정리 후보)
      staleDeleted,     // 실제 삭제된 건수 (purgeStale 이 true 였을 때)
      attendanceNote,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/salary/records/:id — 수동 수정
// 값이 바뀔 때 지급합계/공제합계/실지급액을 다시 맞춰주는 헬퍼
// (엑셀 B~AS 47열 급여대장의 공식과 동일)
const PAY_SUM_FIELDS = [
  'baseSalary', 'fixedOvertimePay', 'fixedHolidayPay',
  'mealAllowance', 'transportAllowance', 'teamLeaderAllowance',
  'overtimePay', 'nightPay', 'holidayPay', 'holidayOtPay',
  'bonusPay', 'retroPay', 'leavePay',
  'extraPay1', 'extraPay2', 'extraPay3', 'extraPay4', 'extraPay5',
];
const DEDUCT_SUM_FIELDS = [
  'nationalPension', 'healthInsurance', 'longTermCare', 'employmentInsurance',
  'incomeTax', 'localTax',
  'incomeTaxAdj', 'localTaxAdj',
  'healthAnnual', 'ltcAnnual',
  'healthInstallment', 'ltcInstallment',
  'healthAprExtra', 'ltcAprExtra',
  'healthRefundInterest', 'ltcRefundInterest',
  'miscDeduction1', 'miscDeduction2',
  'extraDed1', 'extraDed2', 'extraDed3',
];
function recomputeTotals(rec) {
  let gross = 0;
  for (const k of PAY_SUM_FIELDS) gross += +(rec[k] || 0);
  let totalDed = 0;
  for (const k of DEDUCT_SUM_FIELDS) totalDed += +(rec[k] || 0);
  rec.grossPay = gross;
  rec.totalDeductions = totalDed;
  rec.netPay = gross - totalDed;
  return rec;
}

router.put('/records/:id', (req, res) => {
  try {
    // Prototype Pollution 차단 + 위조 필드 제거 (status/id는 서버가 관리)
    req.body = safeBody(req.body, ['id', 'status']);
    const existing = salaryDb.records.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: '없음' });
    if (existing.status !== 'draft') return res.status(400).json({ error: '확정된 급여는 수정 불가' });
    // patch 병합 → 합계 재계산
    const merged = recomputeTotals({ ...existing, ...req.body });
    const updated = salaryDb.records.upsert({ ...merged, id: undefined });
    logSalaryAccess(req.user.userId, 'EDIT', `급여수정 ${existing.userId} ${existing.yearMonth}`);
    res.json({ ok: true, record: updated });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/salary/records/bulk-update — 엑셀 붙여넣기 (여러 행 · 여러 열 일괄 수정)
// body: { patches: [ { id, patches: {field: val, ...} }, ... ] }
router.put('/records/bulk-update', (req, res) => {
  try {
    // Prototype Pollution 차단 — patches 배열 각 원소 내부까지 정화
    const sanitizedBody = safeBody(req.body);
    const patches = Array.isArray(sanitizedBody.patches) ? sanitizedBody.patches : [];
    if (patches.length === 0) return res.json({ ok: true, updated: 0, skipped: 0 });
    let updated = 0;
    let skipped = 0;
    const errors = [];
    for (const item of patches) {
      try {
        const existing = salaryDb.records.getById(item.id);
        if (!existing) { skipped++; continue; }
        if (existing.status !== 'draft') { skipped++; continue; }
        // 추가로 각 patch 내부의 id/status도 차단
        const cleanPatch = safeBody(item.patches || {}, ['id', 'status']);
        const merged = recomputeTotals({ ...existing, ...cleanPatch });
        salaryDb.records.upsert({ ...merged, id: undefined });
        updated++;
      } catch (e) {
        errors.push({ id: item.id, error: e.message });
      }
    }
    logSalaryAccess(req.user.userId, 'BULK_EDIT', `급여일괄수정 ${updated}건 · 스킵 ${skipped}건`);
    res.json({ ok: true, updated, skipped, errors });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/salary/records/:id/confirm — 확정
router.put('/records/:id/confirm', requireAdmin, (req, res) => {
  try {
    const result = salaryDb.records.confirm(req.params.id, req.user.userId);
    logSalaryAccess(req.user.userId, 'CONFIRM', `급여확정 ${result.userId} ${result.yearMonth}`);
    res.json({ ok: true, record: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/salary/records/:id/unconfirm — 확정 취소
router.put('/records/:id/unconfirm', requireAdmin, (req, res) => {
  try {
    const result = salaryDb.records.unconfirm(req.params.id);
    res.json({ ok: true, record: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/salary/records/:id/paid — 지급 처리
router.put('/records/:id/paid', requireAdmin, (req, res) => {
  try {
    const result = salaryDb.records.markPaid(req.params.id, req.body.payDate);
    logSalaryAccess(req.user.userId, 'PAID', `지급처리 ${result.userId} ${result.yearMonth}`);
    res.json({ ok: true, record: result });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/salary/records/:id
router.delete('/records/:id', requireAdmin, (req, res) => {
  try {
    salaryDb.records.delete(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/salary/records/bulk — draft 전체 삭제
router.delete('/records/bulk', requireAdmin, (req, res) => {
  const { companyId, yearMonth } = req.body;
  salaryDb.records.deleteByMonth(companyId, yearMonth);
  res.json({ ok: true });
});

// ══════════════════════════════════════════════════════════════════════════════
// 인건비 추이 (홈 대시보드용)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/cost-trend?months=12&company=all
// 최근 N개월 월별 인건비 (grossPay, netPay, headcount) — 회사별/전체
// 관리자만 접근
router.get('/cost-trend', requireAdmin, (req, res) => {
  try {
    const months = Math.max(1, Math.min(36, Number(req.query.months) || 12));
    const companyFilter = (req.query.company || 'all').toString();

    // 회사 목록
    let companies = [];
    try {
      const org = db.조직관리.load();
      companies = (org.companies || []).map(c => ({ id: c.id, name: c.name }));
    } catch (e) {}
    if (companies.length === 0) {
      companies = [
        { id: 'dalim-sm', name: '대림에스엠' },
        { id: 'dalim-company', name: '대림컴퍼니' }
      ];
    }

    // 최근 N개월 yearMonth 배열 (YYYY-MM, 과거→현재)
    const now = new Date();
    const monthList = [];
    for (let i = months - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      monthList.push(d.toISOString().slice(0, 7));
    }

    // 각 회사 × 각 월 집계
    const series = {};
    const activeCompanies = companyFilter === 'all'
      ? companies
      : companies.filter(c => c.id === companyFilter);

    for (const co of activeCompanies) {
      series[co.id] = {
        companyId: co.id,
        companyName: co.name,
        monthly: monthList.map(ym => {
          const recs = salaryDb.records.getByMonth(co.id, ym) || [];
          const grossPay = recs.reduce((s, r) => s + (r.grossPay || 0), 0);
          const netPay = recs.reduce((s, r) => s + (r.netPay || 0), 0);
          const totalDeductions = recs.reduce((s, r) => s + (r.totalDeductions || 0), 0);
          return {
            yearMonth: ym,
            grossPay,
            netPay,
            totalDeductions,
            headcount: recs.length
          };
        })
      };
    }

    // 전체 합계 (회사 간 합산)
    const totalMonthly = monthList.map((ym, idx) => {
      let gp = 0, np = 0, td = 0, hc = 0;
      Object.values(series).forEach(s => {
        const m = s.monthly[idx];
        gp += m.grossPay; np += m.netPay; td += m.totalDeductions; hc += m.headcount;
      });
      return { yearMonth: ym, grossPay: gp, netPay: np, totalDeductions: td, headcount: hc };
    });

    logSalaryAccess(req.user.userId, 'VIEW', `인건비추이 ${months}개월 company=${companyFilter}`);
    res.json({
      months: monthList,
      companies: Object.values(series),
      total: totalMonthly
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 연간 급여현황
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/annual/:userId/:year
router.get('/annual/:userId/:year', (req, res) => {
  const { userId, year } = req.params;
  const rows = salaryDb.records.getAnnual(userId, year);
  // 월별로 정리
  const monthly = {};
  rows.forEach(r => { monthly[r.yearMonth] = r; });
  // 연간 합계
  const totals = rows.reduce((acc, r) => {
    ['grossPay','totalDeductions','netPay','nationalPension','healthInsurance',
     'longTermCare','employmentInsurance','incomeTax','localTax'].forEach(k => {
      acc[k] = (acc[k] || 0) + (r[k] || 0);
    });
    return acc;
  }, {});
  logSalaryAccess(req.user.userId, 'VIEW', `연간현황 조회 ${userId} ${year}`);
  res.json({ userId, year, monthly, totals, rows });
});

// ══════════════════════════════════════════════════════════════════════════════
// 급여명세서 (HTML — 브라우저 인쇄/PDF)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/slip/:userId/:month?company=
router.get('/slip/:userId/:month', (req, res) => {
  try {
    const { userId, month } = req.params;
    const company = req.query.company || 'dalim-sm';
    const rec = salaryDb.records.getOne(userId, company, month);
    if (!rec) return res.status(404).json({ error: '급여 데이터 없음' });
    const config = salaryDb.configs.get(userId, company);
    const labels = salaryDb.itemLabels.get(company, month);
    const settingsRow = salaryDb.settings.get(company);
    let companyName = company === 'dalim-sm' ? '대림에스엠' : company === 'dalim-company' ? '대림컴퍼니' : company;
    try { const org = db.조직관리.load(); const co = (org.companies||[]).find(c=>c.id===company); if(co) companyName=co.name; } catch(e) {}

    // 조직에서 직원 정보 (ERP 미등록 시 salary_configs.name 사용)
    let empInfo = {};
    try {
      const org = db.조직관리.load();
      empInfo = (org.users || []).find(u => u.id === userId) || {};
    } catch (e) {}
    // ERP에 없으면 config.name 사용
    if (!empInfo.name && config?.name) empInfo = { name: config.name, ...empInfo };

    const fmt = n => (n || 0).toLocaleString('ko-KR');
    const html = generateSlipHtml({ rec, config, labels, settingsRow, companyName, empInfo, fmt, month });

    logSalaryAccess(req.user.userId, 'SLIP_VIEW', `명세서 조회 ${userId} ${month}`);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.send(html);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/salary/slip/email/:userId/:month — 이메일 발송
router.post('/slip/email/:userId/:month', requireAdmin, async (req, res) => {
  try {
    const { userId, month } = req.params;
    const company = req.body.company || 'dalim-sm';
    const config = salaryDb.configs.get(userId, company);
    const recipient = req.body.email || config?.email;
    if (!recipient) return res.status(400).json({ error: '이메일 없음' });

    // 메일 발송 (기존 mail 라우터의 SMTP 설정 활용)
    
    const rec = salaryDb.records.getOne(userId, company, month);
    const labels = salaryDb.itemLabels.get(company, month);
    const settingsRow = salaryDb.settings.get(company);
    let companyName = company === 'dalim-sm' ? '대림에스엠' : company === 'dalim-company' ? '대림컴퍼니' : company;
    try { const org = db.조직관리.load(); const co = (org.companies||[]).find(c=>c.id===company); if(co) companyName=co.name; } catch(e) {}
    let empInfo = {};
    try { const org = db.조직관리.load(); empInfo = (org.users||[]).find(u=>u.id===userId)||{}; } catch(e){}
    if (!empInfo.name && config?.name) empInfo = { name: config.name, ...empInfo };
    const fmt = n => (n||0).toLocaleString('ko-KR');
    const html = generateSlipHtml({ rec, config, labels, settingsRow, companyName, empInfo, fmt, month });

    await sendMail({
      to: recipient,
      subject: `[${companyName}] ${month} 급여명세서`,
      html
    });

    salaryDb.issuances.create({ yearMonth: month, userId, companyId: company, issuedType: 'email', recipient, issuedBy: req.user.userId });
    logSalaryAccess(req.user.userId, 'SLIP_EMAIL', `이메일 발송 ${userId} ${month} → ${recipient}`);
    res.json({ ok: true, recipient });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/salary/slip/email/bulk — 일괄 이메일 발송
router.post('/slip/email/bulk', requireAdmin, async (req, res) => {
  const { companyId, yearMonth, userIds } = req.body;
  const results = [];
  const targets = userIds?.length ? userIds : salaryDb.configs.getAll(companyId).map(c => c.userId);
  for (const userId of targets) {
    try {
      const config = salaryDb.configs.get(userId, companyId);
      if (!config?.email) { results.push({ userId, ok: false, reason: '이메일 없음' }); continue; }
      const rec = salaryDb.records.getOne(userId, companyId, yearMonth);
      if (!rec) { results.push({ userId, ok: false, reason: '급여 데이터 없음' }); continue; }
      // 재귀 호출 대신 직접 처리
      
      const labels = salaryDb.itemLabels.get(companyId, yearMonth);
      const settingsRow = salaryDb.settings.get(companyId);
      const companyName = companyId === 'dalim-sm' ? '대림에스엠' : '대림컴퍼니';
      let empInfo = {};
      try { const org = db.조직관리.load(); empInfo = (org.users||[]).find(u=>u.id===userId)||{}; } catch(e){}
      const fmt = n => (n||0).toLocaleString('ko-KR');
      const html = generateSlipHtml({ rec, config, labels, settingsRow, companyName, empInfo, fmt, month: yearMonth });
      await sendMail({ to: config.email, subject: `[${companyName}] ${yearMonth} 급여명세서`, html });
      salaryDb.issuances.create({ yearMonth, userId, companyId, issuedType: 'email', recipient: config.email, issuedBy: req.user.userId });
      results.push({ userId, ok: true, recipient: config.email });
    } catch (e) {
      results.push({ userId, ok: false, reason: e.message });
    }
  }
  logSalaryAccess(req.user.userId, 'SLIP_EMAIL_BULK', `일괄 이메일 ${companyId} ${yearMonth}`);
  res.json({ ok: true, results });
});

// ══════════════════════════════════════════════════════════════════════════════
// 급여명세서 PDF 일괄 생성 (선택 직원 → PDF/ZIP 다운로드, 생년월일 비번 옵션)
// ══════════════════════════════════════════════════════════════════════════════

// POST /api/salary/slip/pdf/bulk
// Body: { companyId, yearMonth, userIds: [], withPassword: bool }
router.post('/slip/pdf/bulk', requireAdmin, async (req, res) => {
  try {
    const { companyId, yearMonth, userIds, withPassword } = req.body || {};
    if (!companyId || !yearMonth || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ error: 'companyId, yearMonth, userIds 필요' });
    }

    // 의존성 로드
    let puppeteer, JSZip;
    try { puppeteer = require('puppeteer'); }
    catch(e) { return res.status(500).json({ error: 'puppeteer 미설치 — 서버에서 npm install 실행 필요' }); }
    try { JSZip = require('jszip'); }
    catch(e) { return res.status(500).json({ error: 'jszip 미설치 — 서버에서 npm install 실행 필요' }); }
    if (withPassword) {
      // qpdf.exe 바이너리 존재 여부 체크
      if (!fs.existsSync(QPDF_BIN)) {
        return res.status(500).json({
          error: 'qpdf 미설치 — tools/qpdf/bin/qpdf.exe 를 배치해주세요. 또는 비번 체크박스를 해제하고 다시 시도'
        });
      }
    }

    // 공통 설정 로드
    const labels = salaryDb.itemLabels.get(companyId, yearMonth);
    const settingsRow = salaryDb.settings.get(companyId);
    let companyName = companyId === 'dalim-sm' ? '대림에스엠' : companyId === 'dalim-company' ? '대림컴퍼니' : companyId;
    try { const org = db.조직관리.load(); const co = (org.companies||[]).find(c=>c.id===companyId); if(co) companyName=co.name; } catch(e) {}

    const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    const results = [];
    const pdfs = []; // { userId, name, buffer, protected }

    try {
      for (const userId of userIds) {
        try {
          const rec = salaryDb.records.getOne(userId, companyId, yearMonth);
          if (!rec) { results.push({ userId, ok: false, reason: '급여 데이터 없음' }); continue; }
          const config = salaryDb.configs.get(userId, companyId);
          let empInfo = {};
          try { const org = db.조직관리.load(); empInfo = (org.users||[]).find(u=>u.id===userId)||{}; } catch(e){}
          if (!empInfo.name && config?.name) empInfo = { name: config.name, ...empInfo };
          const fmt = n => (n||0).toLocaleString('ko-KR');
          const html = generateSlipHtml({ rec, config, labels, settingsRow, companyName, empInfo, fmt, month: yearMonth });

          const page = await browser.newPage();
          await page.setContent(html, { waitUntil: 'networkidle0' });
          const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '10mm', bottom: '10mm', left: '10mm', right: '10mm' }
          });
          await page.close();

          const name = empInfo.name || config?.name || userId;
          const birth = (empInfo.birthDate || '').replace(/-/g, '');
          let finalBuffer = pdfBuffer;
          let isProtected = false;

          if (withPassword) {
            if (!birth || !/^\d{8}$/.test(birth)) {
              results.push({ userId, ok: false, reason: '생년월일 없음 (사원정보 등록 필요)' });
              continue;
            }
            try {
              finalBuffer = await encryptPdfWithPassword(pdfBuffer, birth);
              isProtected = true;
            } catch (enc) {
              console.error('[slip/pdf/bulk] 암호화 실패', userId, enc);
              results.push({ userId, ok: false, reason: `암호화 실패: ${enc.message}` });
              continue;
            }
          }

          pdfs.push({ userId, name, buffer: finalBuffer, protected: isProtected });
          results.push({ userId, ok: true, protected: isProtected, name });
          try {
            salaryDb.issuances.create({ yearMonth, userId, companyId, issuedType: 'pdf', issuedBy: req.user.userId });
          } catch(e) {}
        } catch (e) {
          results.push({ userId, ok: false, reason: e.message });
        }
      }
    } finally {
      try { await browser.close(); } catch(e) {}
    }

    logSalaryAccess(req.user.userId, 'SLIP_PDF_BULK',
      `PDF일괄 ${companyId} ${yearMonth} 요청${userIds.length} 성공${pdfs.length}${withPassword?' (비번O)':''}`);

    if (pdfs.length === 0) {
      return res.status(400).json({ error: '생성된 PDF 없음', results });
    }

    const sanitize = (s) => String(s || '').replace(/[\/\\?%*:|"<>]/g, '_').trim() || 'unknown';

    // 실패가 있으면 응답 헤더에 표시
    const failedCount = results.filter(r => !r.ok).length;
    if (failedCount > 0) res.setHeader('X-Slip-Failed', String(failedCount));

    if (pdfs.length === 1 && failedCount === 0) {
      // 단일 PDF
      const filename = `급여명세서_${yearMonth}_${sanitize(pdfs[0].name)}.pdf`;
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
      return res.send(pdfs[0].buffer);
    }

    // 여러 명 → ZIP
    const zip = new JSZip();
    const nameCount = {};
    for (const p of pdfs) {
      const safeName = sanitize(p.name);
      nameCount[safeName] = (nameCount[safeName] || 0) + 1;
      const suffix = nameCount[safeName] > 1 ? `_${nameCount[safeName]}` : '';
      zip.file(`급여명세서_${yearMonth}_${safeName}${suffix}.pdf`, p.buffer);
    }
    // 실패 목록이 있으면 결과 요약 텍스트도 포함
    if (failedCount > 0) {
      const failLines = results.filter(r => !r.ok).map(r => `${r.userId}\t${r.reason}`);
      zip.file('실패목록.txt', '급여명세서 생성 실패 목록\n\n' + failLines.join('\n'));
    }
    const zipBuf = await zip.generateAsync({ type: 'nodebuffer' });
    const tag = withPassword ? '비번' : '';
    const zipName = `급여명세서_${yearMonth}_${pdfs.length}명${tag ? '_' + tag : ''}.zip`;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(zipName)}`);
    return res.send(zipBuf);
  } catch (e) {
    console.error('[slip/pdf/bulk] error:', e);
    res.status(500).json({ error: e.message });
  }
});

// qpdf.exe 바이너리 경로 (프로젝트 내 tools/qpdf/bin/qpdf.exe)
const QPDF_BIN = path.join(__dirname, '..', 'tools', 'qpdf', 'bin', 'qpdf.exe');

// qpdf 로 PDF 사용자비번 암호화 (tmp 파일 경유, async)
async function encryptPdfWithPassword(pdfBuffer, password) {
  const os = require('os');
  const crypto = require('crypto');
  const { spawn } = require('child_process');
  if (!fs.existsSync(QPDF_BIN)) {
    throw new Error(`qpdf.exe 없음 (${QPDF_BIN}). tools/qpdf/bin/ 에 바이너리 배치 필요`);
  }
  const tmpDir = os.tmpdir();
  const id = Date.now() + '_' + crypto.randomBytes(4).toString('hex');
  const inPath = path.join(tmpDir, `slip_in_${id}.pdf`);
  const outPath = path.join(tmpDir, `slip_out_${id}.pdf`);
  fs.writeFileSync(inPath, pdfBuffer);
  try {
    await new Promise((resolve, reject) => {
      const args = [
        '--encrypt', password, password + '_owner', '256',
        '--print=full',       // 인쇄는 허용
        '--modify=none',      // 수정은 금지
        '--',
        inPath, outPath
      ];
      const child = spawn(QPDF_BIN, args, { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', d => stderr += d.toString('utf8'));
      child.on('error', reject);
      child.on('close', code => {
        // qpdf: 0=성공, 3=경고(성공), 2=에러
        if (code === 0 || code === 3) return resolve();
        reject(new Error(stderr.trim() || `qpdf exit ${code}`));
      });
    });
    return fs.readFileSync(outPath);
  } finally {
    try { fs.unlinkSync(inPath); } catch(e) {}
    try { fs.unlinkSync(outPath); } catch(e) {}
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// 발급대장
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/issuances?company=dalim-sm&month=2026-03
router.get('/issuances', (req, res) => {
  const { company, month } = req.query;
  res.json({ issuances: salaryDb.issuances.getByMonth(company, month) });
});

// ══════════════════════════════════════════════════════════════════════════════
// 급여대장 엑셀 다운로드
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/export?company=dalim-sm&month=2026-03
router.get('/export', (req, res) => {
  try {
    const { company, month } = req.query;
    const recs = salaryDb.records.getByMonth(company, month);
    const labels = salaryDb.itemLabels.get(company, month);
    let companyName = company === 'dalim-sm' ? '대림에스엠' : company === 'dalim-company' ? '대림컴퍼니' : company;
    try { const org = db.조직관리.load(); const co = (org.companies||[]).find(c=>c.id===company); if(co) companyName=co.name; } catch(e) {}

    // 직원 이름 매핑
    let userMap = {};
    try {
      const org = db.조직관리.load();
      (org.users||[]).forEach(u => { userMap[u.id] = u.name || u.id; });
    } catch(e) {}

    // 간단한 CSV 내보내기
    const headers = ['이름','귀속월','기본급','고정연장','고정휴일','식대','차량유지비','팀장수당',
      '연장수당','야간수당','휴일수당','상여','소급','연차수당',
      labels.extraPay1Name||'추가1', labels.extraPay2Name||'추가2', labels.extraPay3Name||'추가3',
      '과세합계','비과세합계','지급합계',
      '국민연금','건강보험','장기요양','고용보험','소득세','지방소득세',
      '정산소득세','정산지방소득세','건강연말정산','요양연말정산','건강분할납부','요양분할납부',
      '건강정산분','요양정산분','건강환급이자','요양환급이자','잡공제1','잡공제2',
      labels.extraDeduction1Name||'공제1', labels.extraDeduction2Name||'공제2', labels.extraDeduction3Name||'공제3',
      '공제합계','실지급액','상태'];

    const rows = recs.map(r => [
      userMap[r.userId]||r.userId, r.yearMonth, r.baseSalary, r.fixedOvertimePay, r.fixedHolidayPay,
      r.mealAllowance, r.transportAllowance, r.teamLeaderAllowance,
      r.overtimePay, r.nightPay, r.holidayPay, r.bonusPay, r.retroPay, r.leavePay,
      r.extraPay1, r.extraPay2, r.extraPay3,
      r.taxableTotal, r.nonTaxableTotal, r.grossPay,
      r.nationalPension, r.healthInsurance, r.longTermCare, r.employmentInsurance,
      r.incomeTax, r.localTax, r.incomeTaxAdj, r.localTaxAdj,
      r.healthAnnual, r.ltcAnnual, r.healthInstallment, r.ltcInstallment,
      r.healthAprExtra, r.ltcAprExtra, r.healthRefundInterest, r.ltcRefundInterest,
      r.miscDeduction1, r.miscDeduction2, r.extraDeduction1, r.extraDeduction2, r.extraDeduction3,
      r.totalDeductions, r.netPay, r.status
    ]);

    const csv = [headers, ...rows].map(r => r.map(v => `"${String(v||0).replace(/"/g,'""')}"`).join(',')).join('\n');
    const bom = '\uFEFF';
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(companyName+'_급여대장_'+month+'.csv')}`);
    logSalaryAccess(req.user.userId, 'EXPORT', `급여대장 다운로드 ${company} ${month}`);
    res.send(bom + csv);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 간이세액표
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/tax-table/:year
router.get('/tax-table/:year', (req, res) => {
  const rows = salaryDb.incomeTax.getAll(parseInt(req.params.year));
  const years = salaryDb.incomeTax.getYears();
  res.json({ rows, years });
});

// POST /api/salary/tax-table — 간이세액표 등록 (JSON 배열)
router.post('/tax-table', requireAdmin, (req, res) => {
  try {
    const { year, rows } = req.body;
    if (!year || !Array.isArray(rows)) return res.status(400).json({ error: 'year, rows 필수' });
    salaryDb.incomeTax.bulkInsert(year, rows);
    logSalaryAccess(req.user.userId, 'TAX_TABLE_UPDATE', `간이세액표 ${year}년 ${rows.length}행 등록`);
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/salary/tax-table/upload — CSV 업로드
const taxTableUploadMw = upload ? upload.single('file') : (req, res, next) => res.status(503).json({ error: 'multer 미설치 — npm install multer' });
router.post('/tax-table/upload', requireAdmin, taxTableUploadMw, (req, res) => {
  try {
    const { year } = req.body;
    if (!req.file) return res.status(400).json({ error: '파일 없음' });
    const content = fs.readFileSync(req.file.path, 'utf-8').replace(/^\uFEFF/, '');
    const lines = content.split('\n').filter(l => l.trim());
    const headers = lines[0].split(',').map(h => h.trim().replace(/"/g,''));
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(',').map(v => v.trim().replace(/"/g,''));
      const obj = {};
      headers.forEach((h, idx) => { obj[h] = vals[idx]; });
      rows.push({
        salaryFrom: parseInt(obj.salaryFrom || obj['시작']),
        salaryTo:   parseInt(obj.salaryTo   || obj['끝']),
        dep1:  parseInt(obj.dep1 ||obj['1인']),  dep2:  parseInt(obj.dep2 ||obj['2인']),
        dep3:  parseInt(obj.dep3 ||obj['3인']),  dep4:  parseInt(obj.dep4 ||obj['4인']),
        dep5:  parseInt(obj.dep5 ||obj['5인']),  dep6:  parseInt(obj.dep6 ||obj['6인']),
        dep7:  parseInt(obj.dep7 ||obj['7인']),  dep8:  parseInt(obj.dep8 ||obj['8인']),
        dep9:  parseInt(obj.dep9 ||obj['9인']),  dep10: parseInt(obj.dep10||obj['10인']),
        dep11: parseInt(obj.dep11||obj['11인']),
      });
    }
    salaryDb.incomeTax.bulkInsert(parseInt(year), rows.filter(r => !isNaN(r.salaryFrom)));
    fs.unlinkSync(req.file.path);
    res.json({ ok: true, count: rows.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// EDI 보험료 비교
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/edi?company=dalim-sm&month=2026-03
router.get('/edi', (req, res) => {
  const { company, month } = req.query;
  res.json({ edi: salaryDb.ediRecords.getByMonth(company, month) });
});

// POST /api/salary/edi — 수동 입력
router.post('/edi', (req, res) => {
  try {
    // Prototype Pollution 차단 (uploadedBy/source는 서버가 주입)
    const clean = safeBody(req.body, ['uploadedBy', 'source']);
    const data = { ...clean, uploadedBy: req.user.userId, source: 'manual' };
    salaryDb.ediRecords.upsert(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/salary/edi/upload — EDI 파일 업로드 (건강보험공단 xls)
const ediUploadMw = upload ? upload.single('file') : (req, res, next) => res.status(503).json({ error: 'multer 미설치 — npm install multer' });
router.post('/edi/upload', ediUploadMw, (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: '파일 없음' });
    const { companyId, yearMonth } = req.body;

    let rows = [];
    const ext = path.extname(req.file.originalname).toLowerCase();
    const nameMap = getNameToUserIdMap();

    if (ext === '.xls') {
      // xlrd로 파싱
      try {
        const xlrd = require('xlrd');
        const book = xlrd.open_workbook ? xlrd.open_workbook(req.file.path) : null;
        // Node.js xlrd 없으면 에러
        if (!book) throw new Error('xlrd 파싱 불가');
      } catch (xlrdErr) {
        // xlrd가 Python 모듈이므로 Node.js에서는 직접 사용 불가
        // → 간단한 바이너리 파싱 대신 python3 스크립트 실행
        const { execSync } = require('child_process');
        const tmpOut = req.file.path + '_parsed.json';
        const pyScript = `
import xlrd, json, sys
book = xlrd.open_workbook(sys.argv[1])
sh = book.sheet_by_index(0)
data = []
for r in range(1, sh.nrows):
    row = sh.row_values(r)
    try:
        data.append({
            'name': str(row[6]).strip(),
            'healthBasis': int(float(row[11])) if row[11] else 0,
            'healthCalc': int(float(row[12])) if row[12] else 0,
            'healthBilled': int(float(row[17])) if row[17] else 0,
            'healthAnnual': int(float(row[18])) if row[18] else 0,
            'ltcCalc': int(float(row[21])) if row[21] else 0,
            'ltcBilled': int(float(row[26])) if row[26] else 0,
            'healthRefundInterest': int(float(row[32])) if row[32] else 0,
            'ltcRefundInterest': int(float(row[33])) if row[33] else 0,
            'totalBilled': int(float(row[34])) if row[34] else 0,
        })
    except:
        pass
print(json.dumps(data, ensure_ascii=False))
`;
        const pyFile = req.file.path + '_parser.py';
        fs.writeFileSync(pyFile, pyScript);
        const out = execSync(`python3 ${pyFile} ${req.file.path}`, { encoding: 'utf-8' });
        fs.unlinkSync(pyFile);
        const parsed = JSON.parse(out.trim());
        rows = parsed.filter(p => p.name && p.healthBasis > 0).map(p => ({
          userId: nameMap[p.name] || p.name,
          companyId,
          yearMonth,
          healthBasis: p.healthBasis,
          healthCalc: p.healthCalc,
          healthBilled: p.healthBilled,
          healthAnnual: p.healthAnnual,
          ltcCalc: p.ltcCalc,
          ltcBilled: p.ltcBilled,
          healthRefundInterest: p.healthRefundInterest,
          ltcRefundInterest: p.ltcRefundInterest,
          totalBilled: p.totalBilled,
          source: 'health-edi',
          uploadedBy: req.user.userId,
        }));
      }
    } else if (ext === '.csv') {
      // CSV 파싱
      const content = fs.readFileSync(req.file.path, 'utf-8').replace(/^\uFEFF/, '');
      const lines = content.split('\n').filter(l => l.trim());
      const headers = lines[0].split(',').map(h => h.trim().replace(/"/g,''));
      for (let i = 1; i < lines.length; i++) {
        const vals = lines[i].split(',').map(v => v.trim().replace(/"/g,''));
        const obj = {};
        headers.forEach((h, idx) => { obj[h] = vals[idx]; });
        const name = obj['성명'] || obj['name'];
        if (!name) continue;
        rows.push({
          userId: nameMap[name] || name,
          companyId, yearMonth,
          healthBasis: parseInt(obj['보수월액']||0),
          healthCalc: parseInt(obj['산출보험료']||0),
          healthBilled: parseInt(obj['고지금액']||0),
          healthAnnual: parseInt(obj['연말정산']||0),
          ltcCalc: parseInt(obj['요양산출보험료']||0),
          ltcBilled: parseInt(obj['요양고지보험료']||0),
          healthRefundInterest: parseInt(obj['건강환급금이자']||0),
          ltcRefundInterest: parseInt(obj['요양환급금이자']||0),
          totalBilled: parseInt(obj['가입자총납부할보험료']||0),
          source: 'health-edi',
          uploadedBy: req.user.userId,
        });
      }
    }

    salaryDb.ediRecords.bulkUpsert(rows);
    try { fs.unlinkSync(req.file.path); } catch(e) {}

    logSalaryAccess(req.user.userId, 'EDI_UPLOAD', `EDI 업로드 ${companyId} ${yearMonth} ${rows.length}명`);
    res.json({ ok: true, count: rows.length, rows });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /api/salary/edi/:id
router.delete('/edi/:id', requireAdmin, (req, res) => {
  salaryDb.ediRecords.delete(req.params.id);
  res.json({ ok: true });
});

// GET /api/salary/edi/compare?company=dalim-sm&month=2026-03 — 계산값 vs EDI 비교
router.get('/edi/compare', (req, res) => {
  try {
    const { company, month } = req.query;
    const recs = salaryDb.records.getByMonth(company, month);
    const ediRows = salaryDb.ediRecords.getByMonth(company, month);
    const ediMap = {};
    ediRows.forEach(e => { ediMap[e.userId] = e; });

    let userMap = {};
    try { const org = db.조직관리.load(); (org.users||[]).forEach(u => { userMap[u.id] = u.name||u.id; }); } catch(e){}

    const comparison = recs.map(r => {
      const edi = ediMap[r.userId] || null;
      const diff = edi ? {
        healthBasis: (edi.healthBasis || 0) - 0,
        health: (edi.healthBilled || 0) - (r.healthInsurance || 0),
        ltc: (edi.ltcBilled || 0) - (r.longTermCare || 0),
        pension: (edi.pensionBilled || 0) - (r.nationalPension || 0),
        employment: (edi.employmentBilled || 0) - (r.employmentInsurance || 0),
      } : null;
      const hasDiscrepancy = diff && (Math.abs(diff.health) > 10 || Math.abs(diff.ltc) > 10 ||
        Math.abs(diff.pension) > 10 || Math.abs(diff.employment) > 10);
      return { userId: r.userId, name: userMap[r.userId]||r.userId, calc: r, edi, diff, hasDiscrepancy };
    });

    res.json({ comparison, month });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 급여명세서 HTML 생성 함수
// ══════════════════════════════════════════════════════════════════════════════

function generateSlipHtml({ rec, config, labels, settingsRow, companyName, empInfo, fmt, month }) {
  const s = settingsRow || {};
  const l = labels || {};
  const name = empInfo.name || rec.userId;
  const dept = empInfo.department || '';
  const position = empInfo.position || '';
  const hireDate = empInfo.hireDate || '';

  const taxPct = (v, d=3) => v ? `(${v}%)` : '';

  const rows_pay = [
    ['기본급', '', fmt(rec.baseSalary)],
    rec.overtimeHours > 0 ? ['연장수당', `${rec.overtimeHours}h`, fmt(rec.overtimePay)] : null,
    rec.nightHours > 0 ? ['야간수당', `${rec.nightHours}h`, fmt(rec.nightPay)] : null,
    rec.holidayHours > 0 ? ['휴일기본수당', `${rec.holidayHours}h`, fmt(rec.holidayPay)] : null,
    rec.holidayOtHours > 0 ? ['휴일연장수당', `${rec.holidayOtHours}h`, fmt(rec.holidayOtPay)] : null,
    rec.fixedOvertimePay > 0 ? ['고정연장수당', '', fmt(rec.fixedOvertimePay)] : null,
    rec.fixedHolidayPay > 0 ? ['고정휴일수당', '', fmt(rec.fixedHolidayPay)] : null,
    rec.mealAllowance > 0 ? ['식대', '', fmt(rec.mealAllowance)] : null,
    rec.transportAllowance > 0 ? ['차량유지비', '', fmt(rec.transportAllowance)] : null,
    rec.teamLeaderAllowance > 0 ? ['팀장수당', '', fmt(rec.teamLeaderAllowance)] : null,
    rec.bonusPay > 0 ? ['상여', '', fmt(rec.bonusPay)] : null,
    rec.retroPay > 0 ? ['소급', '', fmt(rec.retroPay)] : null,
    rec.leavePay > 0 ? ['연차수당', '', fmt(rec.leavePay)] : null,
    (rec.extraPay1 > 0 && (l.extraPay1Name||'')) ? [l.extraPay1Name, '', fmt(rec.extraPay1)] : null,
    (rec.extraPay2 > 0 && (l.extraPay2Name||'')) ? [l.extraPay2Name, '', fmt(rec.extraPay2)] : null,
    (rec.extraPay3 > 0 && (l.extraPay3Name||'')) ? [l.extraPay3Name, '', fmt(rec.extraPay3)] : null,
  ].filter(Boolean);

  const rows_ded = [
    rec.nationalPension ? ['국민연금', `(${s.pensionRate||4.5}%)`, fmt(rec.nationalPension)] : null,
    rec.healthInsurance ? ['건강보험', `(${s.healthRate||3.595}%)`, fmt(rec.healthInsurance)] : null,
    rec.longTermCare ? ['장기요양보험', `(${s.ltcRate||13.14}%)`, fmt(rec.longTermCare)] : null,
    rec.employmentInsurance ? ['고용보험', `(${s.employmentRate||0.9}%)`, fmt(rec.employmentInsurance)] : null,
    rec.incomeTax ? ['소득세', '', fmt(rec.incomeTax)] : null,
    rec.localTax ? ['지방소득세', '', fmt(rec.localTax)] : null,
    rec.incomeTaxAdj ? ['정산소득세', '', fmt(rec.incomeTaxAdj)] : null,
    rec.localTaxAdj ? ['정산지방소득세', '', fmt(rec.localTaxAdj)] : null,
    rec.healthAnnual ? ['건강보험 연말정산', '', fmt(rec.healthAnnual)] : null,
    rec.ltcAnnual ? ['장기요양 연말정산', '', fmt(rec.ltcAnnual)] : null,
    rec.healthInstallment ? ['건강보험 분할납부', '', fmt(rec.healthInstallment)] : null,
    rec.ltcInstallment ? ['장기요양 분할납부', '', fmt(rec.ltcInstallment)] : null,
    rec.healthAprExtra ? ['건강보험 정산분', '', fmt(rec.healthAprExtra)] : null,
    rec.ltcAprExtra ? ['장기요양 정산분', '', fmt(rec.ltcAprExtra)] : null,
    rec.healthRefundInterest ? ['건강보험 환급금이자', '', fmt(rec.healthRefundInterest)] : null,
    rec.ltcRefundInterest ? ['요양보험 환급금이자', '', fmt(rec.ltcRefundInterest)] : null,
    rec.miscDeduction1 ? ['과태료 및 주차비', '', fmt(rec.miscDeduction1)] : null,
    rec.miscDeduction2 ? ['기타 공제', '', fmt(rec.miscDeduction2)] : null,
    (rec.extraDeduction1 && l.extraDeduction1Name) ? [l.extraDeduction1Name, '', fmt(rec.extraDeduction1)] : null,
    (rec.extraDeduction2 && l.extraDeduction2Name) ? [l.extraDeduction2Name, '', fmt(rec.extraDeduction2)] : null,
    (rec.extraDeduction3 && l.extraDeduction3Name) ? [l.extraDeduction3Name, '', fmt(rec.extraDeduction3)] : null,
  ].filter(Boolean);

  const payRowsHtml = rows_pay.map(([label, hours, amt]) => `
    <tr><td>${label}</td><td style="color:#6b7280;font-size:11px;">${hours}</td><td class="num">${amt}</td></tr>`).join('');
  const dedRowsHtml = rows_ded.map(([label, pct, amt]) => `
    <tr><td>${label}<span style="color:#9ca3af;font-size:10px;margin-left:4px;">${pct}</span></td><td></td><td class="num">${amt}</td></tr>`).join('');

  // ── 엑셀식 2단 레이아웃 (지급 ← | → 공제) ──────────────────────────────
  // 좌우 행수를 맞춰 빈 행으로 패딩
  const maxRows = Math.max(rows_pay.length, rows_ded.length);
  function pad(arr) {
    const out = arr.slice();
    while (out.length < maxRows) out.push(['', '', '']);
    return out;
  }
  const padPay = pad(rows_pay);
  const padDed = pad(rows_ded);
  const bodyRowsHtml = padPay.map((p, i) => {
    const d = padDed[i];
    const pLabel = p[0] || '';
    const pHours = p[1] || '';
    const pAmt = p[2] || '';
    const dLabel = d[0] || '';
    const dPct = d[1] || '';
    const dAmt = d[2] || '';
    return `<tr>
      <td class="lbl">${pLabel}${pHours ? `<span class="sub">${pHours}</span>` : ''}</td>
      <td class="num">${pAmt}</td>
      <td class="lbl">${dLabel}${dPct ? `<span class="sub">${dPct}</span>` : ''}</td>
      <td class="num">${dAmt}</td>
    </tr>`;
  }).join('');

  // ── 산출근거 테이블 (엑셀 명세서 양식 복제) ─────────────────────
  // [구분, 산출근거, 비고] — 해당 항목이 실제 있을 때만 행을 그림
  const basisRows = [
    ['4대보험 / 소득세', '관련 법률·규정에 근거함', '공통 적용'],
  ];
  // ─ 지급 항목
  if (rec.overtimePay > 0)       basisRows.push(['연장수당',      '연장근무시간 × 통상시급 × 1.5배',                     '야간근무 시 +0.5배 가산']);
  if (rec.nightPay > 0)          basisRows.push(['야간수당',      '야간근무시간 × 통상시급 × 0.5배',                     '22시~06시 근무분']);
  if (rec.holidayPay > 0)        basisRows.push(['휴일수당',      '휴일기본근무시간 × 통상시급 × 1.5배',                  '연장근무 시 +0.5배 가산']);
  if (rec.holidayOtPay > 0)      basisRows.push(['휴일연장수당',  '휴일연장근무시간 × 통상시급 × 2.0배',                  '']);
  if (rec.fixedOvertimePay > 0)  basisRows.push(['고정연장수당',  '월 고정연장근무 약정분',                              '근로계약서 기준']);
  if (rec.fixedHolidayPay > 0)   basisRows.push(['고정휴일수당',  '월 고정휴일근무 약정분',                              '근로계약서 기준']);
  if (rec.mealAllowance > 0)     basisRows.push(['식대',          '월 20만원 한도 비과세',                               '소득세법 제12조']);
  if (rec.transportAllowance>0)  basisRows.push(['차량유지비',    '본인 차량 업무 사용분 월 20만원 한도 비과세',          '소득세법 제12조']);
  if (rec.teamLeaderAllowance>0) basisRows.push(['팀장수당',      '팀장 직책 추가수당',                                  '']);
  if (rec.bonusPay > 0)          basisRows.push(['상여',          '설·추석 명절 상여',                                   '']);
  if (rec.retroPay > 0)          basisRows.push(['소급',          '호봉·직급 인상분 소급 지급',                          '']);
  if (rec.leavePay > 0)          basisRows.push(['연차수당',      '미사용 연차일수 × 일급',                              '근로기준법 제60조']);
  // ─ 공제 정산 항목
  if (rec.incomeTaxAdj)          basisRows.push(['정산소득세',         '전년도 연말정산 결과 정산분 소득세',                    '']);
  if (rec.localTaxAdj)           basisRows.push(['정산지방소득세',     '전년도 연말정산 결과 정산분 지방소득세',                '']);
  if (rec.healthAnnual)          basisRows.push(['건강보험 연말정산', '전년도 보수총액 기준 건강보험료 정산분',                '']);
  if (rec.ltcAnnual)             basisRows.push(['장기요양 연말정산', '전년도 보수총액 기준 장기요양료 정산분',                '']);
  if (rec.healthAprExtra)        basisRows.push(['건강보험 정산분',   '2026년 건강보험 요율 변경(3.545% → 3.595%) 1~3월 소급 정산', '공단 신요율 납부 / 직원 공제 구요율 적용 차액']);
  if (rec.ltcAprExtra)           basisRows.push(['장기요양 정산분',   '2026년 장기요양 요율 변경(12.95% → 13.14%) 1~3월 소급 정산', '공단 신요율 납부 / 직원 공제 구요율 적용 차액']);
  if (rec.healthInstallment)     basisRows.push(['건강보험 분할납부', '연말정산 건강보험료 분할납부 해당월분',                 '']);
  if (rec.ltcInstallment)        basisRows.push(['장기요양 분할납부', '연말정산 장기요양료 분할납부 해당월분',                 '']);
  if (rec.healthRefundInterest)  basisRows.push(['건강보험 환급금이자','건강보험 과오납 환급금에 대한 이자(과세소득)',          '']);
  if (rec.ltcRefundInterest)     basisRows.push(['요양보험 환급금이자','장기요양 과오납 환급금에 대한 이자(과세소득)',          '']);
  if (rec.miscDeduction1)        basisRows.push(['과태료 및 주차비', '차량 운행 중 발생한 과태료 및 개인차량 주차비',          '']);
  if (rec.miscDeduction2)        basisRows.push(['기타 공제',       '기타 개별 공제 항목',                                    '']);
  if (rec.extraDeduction1 && l.extraDeduction1Name) basisRows.push([l.extraDeduction1Name, '회사 내부 규정에 따른 공제', '']);
  if (rec.extraDeduction2 && l.extraDeduction2Name) basisRows.push([l.extraDeduction2Name, '회사 내부 규정에 따른 공제', '']);
  if (rec.extraDeduction3 && l.extraDeduction3Name) basisRows.push([l.extraDeduction3Name, '회사 내부 규정에 따른 공제', '']);

  const basisRowsHtml = basisRows.map(([a, b, c]) => `
    <tr><td class="b-lbl">${a}</td><td class="b-src">${b}</td><td class="b-note">${c || ''}</td></tr>`).join('');

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${companyName} ${month} 급여명세서 — ${name}</title>
<style>
  @page { margin: 15mm 12mm; size: A4; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Malgun Gothic','맑은 고딕',sans-serif; font-size: 12px; color: #111; background: #fff; }
  .slip { max-width: 760px; margin: 0 auto; padding: 18px; }
  .title { text-align:center; font-size:22px; font-weight:800; letter-spacing:8px; padding:8px 0 14px; }
  .company { text-align:center; font-size:14px; font-weight:700; color:#333; margin-bottom:6px; }
  .period  { text-align:right; font-size:12px; color:#333; margin-bottom:4px; }
  table.info, table.body { width:100%; border-collapse:collapse; }
  table.info td { border:1px solid #555; padding:5px 8px; font-size:12px; }
  table.info td.th { background:#f0f0f0; font-weight:700; width:90px; text-align:center; }
  table.body { margin-top:0; }
  table.body th, table.body td { border:1px solid #555; padding:4px 8px; font-size:12px; }
  table.body thead th { background:#e8eaf0; font-weight:700; text-align:center; height:26px; }
  table.body td.lbl { background:#fafafa; }
  table.body td.lbl .sub { color:#888; font-size:10px; margin-left:4px; }
  table.body td.num { text-align:right; font-variant-numeric:tabular-nums; width:110px; }
  table.body tr.sub td { background:#f5f5f5; font-weight:600; }
  table.body tr.sum td { background:#fff3cd; font-weight:700; }
  table.body tr.net td { background:#1e3a5f; color:#fff; font-size:15px; font-weight:800; height:34px; }
  table.body tr.net td.num { font-size:16px; }
  .sign { display:grid; grid-template-columns: 1fr 1fr 1fr; gap:10px; margin-top:18px; font-size:12px; }
  .sign .box { border:1px solid #555; height:70px; position:relative; padding:6px 8px; }
  .sign .box .role { font-weight:700; }
  .sign .box .seal { position:absolute; right:8px; bottom:6px; color:#888; font-size:11px; }
  table.basis { width:100%; border-collapse:collapse; font-size:11px; margin-top:4px; }
  table.basis th, table.basis td { border:1px solid #555; padding:4px 8px; vertical-align:middle; }
  table.basis thead th { background:#e8eaf0; font-weight:700; text-align:center; height:22px; }
  table.basis td.b-lbl { background:#fafafa; font-weight:600; text-align:center; }
  table.basis td.b-src { font-size:11px; color:#222; }
  table.basis td.b-note { font-size:10px; color:#666; }
  .basis-title { margin-top:14px; font-size:12px; font-weight:700; color:#333; margin-bottom:4px; }
  .ref-note { margin-top:8px; font-size:10px; color:#555; line-height:1.6; }
  @media print { .no-print { display: none !important; } body { font-size:11px; } }
  .print-btn { text-align: center; margin-top: 18px; }
  .print-btn button { background: #4f6ef7; color: #fff; border: none; padding: 9px 24px; border-radius: 6px; font-size: 13px; cursor: pointer; }
</style>
</head>
<body>
<div class="slip">
  <div class="company">${companyName}</div>
  <div class="title">급 여 명 세 서</div>
  <div class="period">귀속월: <b>${month}</b> &nbsp;&nbsp; 지급일: <b>${rec.payDate || '—'}</b></div>

  <table class="info">
    <tr>
      <td class="th">성명</td><td>${name}</td>
      <td class="th">부서</td><td>${dept || '—'}</td>
      <td class="th">직위</td><td>${position || '—'}</td>
    </tr>
    <tr>
      <td class="th">입사일</td><td>${hireDate || '—'}</td>
      <td class="th">통상시급</td><td>${fmt(Math.round(config?.hourlyRate || 0))} 원</td>
      <td class="th">근무일/시간</td><td>${rec.workDays || 0}일 / ${rec.workHours || 0}h</td>
    </tr>
  </table>

  <table class="body">
    <thead>
      <tr>
        <th style="width:38%">지급 내역</th>
        <th style="width:12%">금액(원)</th>
        <th style="width:38%">공제 내역</th>
        <th style="width:12%">금액(원)</th>
      </tr>
    </thead>
    <tbody>
      ${bodyRowsHtml}
      <tr class="sub">
        <td class="lbl">과세합계</td>
        <td class="num">${fmt(rec.taxableTotal)}</td>
        <td class="lbl">&nbsp;</td>
        <td class="num">&nbsp;</td>
      </tr>
      <tr class="sub">
        <td class="lbl">비과세합계</td>
        <td class="num">${fmt(rec.nonTaxableTotal)}</td>
        <td class="lbl">&nbsp;</td>
        <td class="num">&nbsp;</td>
      </tr>
      <tr class="sum">
        <td class="lbl">지급 합계 (A)</td>
        <td class="num">${fmt(rec.grossPay)}</td>
        <td class="lbl">공제 합계 (B)</td>
        <td class="num">${fmt(rec.totalDeductions)}</td>
      </tr>
      <tr class="net">
        <td class="lbl" colspan="3">실 지 급 액 (A − B)</td>
        <td class="num">${fmt(rec.netPay)} 원</td>
      </tr>
    </tbody>
  </table>

  <div class="sign">
    <div class="box"><div class="role">작성자</div><div class="seal">(인)</div></div>
    <div class="box"><div class="role">확인자</div><div class="seal">(인)</div></div>
    <div class="box"><div class="role">수령자 / ${name}</div><div class="seal">(인)</div></div>
  </div>

  <div class="basis-title">◎ 산 출 근 거</div>
  <table class="basis">
    <thead>
      <tr>
        <th style="width:22%">구 분</th>
        <th style="width:53%">산 출 근 거</th>
        <th style="width:25%">비 고</th>
      </tr>
    </thead>
    <tbody>
      ${basisRowsHtml}
    </tbody>
  </table>

  <div class="ref-note">
    ※ 4대보험 요율: 국민연금 ${s.pensionRate||4.5}% / 건강보험 ${s.healthRate||3.595}% / 장기요양 ${s.ltcRate||13.14}%(건보료 대비) / 고용보험 ${s.employmentRate||0.9}% &nbsp;|&nbsp;
    소득세: 근로소득 간이세액표 기준 (부양가족 ${config?.dependents||1}명)
  </div>

  <div class="print-btn no-print">
    <button onclick="window.print()">🖨️ 인쇄 / PDF 저장</button>
  </div>
</div>
</body>
</html>`;
}

// ══════════════════════════════════════════════════════════════════════════════
// 출퇴근 연동 — 근무일수/연장시간 자동 가져오기
// ══════════════════════════════════════════════════════════════════════════════

/**
 * GET /api/salary/attendance-import?company=dalim-sm&month=2026-04
 *
 * 출퇴근 모듈의 summary 데이터를 급여 모듈용으로 변환해서 반환
 * 매핑: attendance employeeName → 조직관리.json user.name → user.id
 *
 * 반환값 per userId:
 *   workDays       : 정상 출근일수 (normalDays + halfAM*0.5 + halfPM*0.5)
 *   annualDays     : 연차 사용일수
 *   absentDays     : 결근일수
 *   totalOvertimeH : CAPS 집계 연장시간(분→시간)
 *   lateCount      : 지각 횟수
 */
router.get('/attendance-import', async (req, res) => {
  const { company, month } = req.query;
  if (!company || !month) return res.status(400).json({ error: 'company, month 필요' });

  try {
    const data = await fetchAttendanceData(company, month);
    logSalaryAccess(req.user.userId, 'ATTENDANCE_IMPORT', `출퇴근 연동 조회 ${company} ${month}`);
    res.json({ ok: true, month, company, ...data });
  } catch (e) {
    console.error('[salary/attendance-import]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/salary/attendance-apply — 출퇴근 데이터를 급여 레코드에 일괄 반영
// 2026-04-17: 연장시간도 함께 반영하도록 확장. CAPS 집계를 급여 레코드에 밀어넣어
// /calculate를 다시 돌리지 않아도 수동 연장근무 입력값처럼 동작하게 함.
router.post('/attendance-apply', async (req, res) => {
  const { companyId, yearMonth, employees } = req.body;
  if (!companyId || !yearMonth || !employees?.length) {
    return res.status(400).json({ error: '파라미터 누락' });
  }
  const results = [];
  for (const emp of employees) {
    try {
      const existing = salaryDb.records.getOne(emp.userId, companyId, yearMonth);
      if (!existing || existing.status !== 'draft') {
        results.push({ userId: emp.userId, skipped: true, reason: existing ? '이미 확정/지급됨' : '급여 레코드 없음' });
        continue;
      }

      // 1. 출퇴근 연동 레코드 업데이트 (workDays + 연차/결근/지각 메타)
      const updated = salaryDb.records.upsert({
        ...existing,
        workDays: emp.workDays,
        annualDays: emp.annualDays ?? existing.annualDays ?? 0,
        absentDays: emp.absentDays ?? existing.absentDays ?? 0,
        lateCount: emp.lateCount ?? existing.lateCount ?? 0,
        note: [existing.note, `출퇴근연동: 연차${emp.annualDays}일 지각${emp.lateCount}회`].filter(Boolean).join(' | '),
      });

      // 2. 연장시간 동기화 (salary_overtime 테이블) — 수동 입력이 없는 경우만
      let overtimeApplied = false;
      if (emp.totalOvertimeH != null && emp.totalOvertimeH > 0) {
        const existingOt = salaryDb.overtime.getByMonth(companyId, yearMonth)
          .find(r => r.userId === emp.userId);
        // 수동 입력값이 있으면 덮어쓰지 않음 (관리자 의도 존중)
        if (!existingOt || (existingOt.overtimeH === 0 && !existingOt.memo)) {
          salaryDb.overtime.upsertSummary({
            userId: emp.userId,
            companyId,
            yearMonth,
            overtimeH: emp.totalOvertimeH,
            nightH: existingOt?.nightH || 0,
            holidayH: existingOt?.holidayH || 0,
            holidayOtH: existingOt?.holidayOtH || 0,
            memo: `CAPS 자동: ${emp.totalOvertimeH}h`,
          });
          overtimeApplied = true;
        }
      }

      results.push({
        userId: emp.userId,
        ok: true,
        workDays: emp.workDays,
        overtimeH: overtimeApplied ? emp.totalOvertimeH : null,
        overtimeApplied,
      });
    } catch (e) {
      results.push({ userId: emp.userId, error: e.message });
    }
  }
  logSalaryAccess(req.user.userId, 'ATTENDANCE_APPLY',
    `출퇴근 데이터 반영 ${companyId} ${yearMonth} (${employees.length}명)`);
  res.json({ ok: true, results });
});

// ══════════════════════════════════════════════════════════════════════════════
// 연장근무 입력 (전용 탭)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/overtime?company=&month=
router.get('/overtime', (req, res) => {
  const { company, month } = req.query;
  if (!company || !month) return res.status(400).json({ error: '파라미터 누락' });
  const rows = salaryDb.overtime.getByMonth(company, month);
  const nameMap = getNameMap(company);
  const result = rows.map(r => ({ ...r, name: nameMap[r.userId] || r.userId }));

  // 설정된 직원 중 연장근무 미입력자도 포함
  const cfgs = salaryDb.configs.getAll(company);
  const withOt = new Set(rows.map(r => r.userId));
  cfgs.forEach(c => {
    if (!withOt.has(c.userId)) {
      result.push({ userId: c.userId, companyId: company, yearMonth: month,
        overtimeH: 0, nightH: 0, holidayH: 0, holidayOtH: 0, name: nameMap[c.userId] || c.userId });
    }
  });
  result.sort((a,b) => (a.name||'').localeCompare(b.name||'', 'ko'));
  res.json({ overtime: result });
});

// POST /api/salary/overtime — 월 합계 저장
router.post('/overtime', (req, res) => {
  try {
    const { userId, companyId, yearMonth, overtimeH=0, nightH=0, holidayH=0, holidayOtH=0, memo='' } = req.body;
    if (!userId || !companyId || !yearMonth) return res.status(400).json({ error: '파라미터 누락' });
    const result = salaryDb.overtime.upsertSummary({ userId, companyId, yearMonth,
      overtimeH: +overtimeH, nightH: +nightH, holidayH: +holidayH, holidayOtH: +holidayOtH, memo });
    logSalaryAccess(req.user.userId, 'OVERTIME_EDIT', `연장근무 수정 ${userId} ${yearMonth}`);
    res.json({ ok: true, overtime: result });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/salary/overtime/:userId/:month
router.delete('/overtime/:userId/:month', requireAdmin, (req, res) => {
  const { company } = req.query;
  salaryDb.overtime.delete(req.params.userId, company, req.params.month);
  res.json({ ok: true });
});

// ── 일자별 연장근무 API (엑셀 연장근무 시트 대응) ────────────────────────────
// GET /api/salary/overtime/daily?company=&month=&userId=
router.get('/overtime/daily', (req, res) => {
  const { company, month, userId } = req.query;
  if (!company || !month || !userId) return res.status(400).json({ error: '파라미터 누락(company,month,userId)' });
  const rows = salaryDb.overtime.getDetail(userId, company, month).filter(r => r.workDate !== 'TOTAL');
  res.json({ daily: rows });
});

// POST /api/salary/overtime/daily — 단건 upsert
// body: { userId, companyId, yearMonth, workDate(YYYY-MM-DD), overtimeH, nightH, holidayH, holidayOtH, memo }
router.post('/overtime/daily', (req, res) => {
  try {
    const { userId, companyId, yearMonth, workDate, overtimeH=0, nightH=0, holidayH=0, holidayOtH=0, memo='' } = req.body;
    if (!userId || !companyId || !yearMonth || !workDate) return res.status(400).json({ error: '파라미터 누락' });
    const row = salaryDb.overtime.upsertDaily({ userId, companyId, yearMonth, workDate,
      overtimeH: +overtimeH, nightH: +nightH, holidayH: +holidayH, holidayOtH: +holidayOtH, memo });
    logSalaryAccess(req.user.userId, 'OVERTIME_DAILY_EDIT', `일자별 연장 ${userId} ${workDate}`);
    res.json({ ok: true, row });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// POST /api/salary/overtime/daily/bulk — 여러 일자 한번에 upsert
// body: { rows: [{ userId, companyId, yearMonth, workDate, overtimeH, ... }, ...] }
router.post('/overtime/daily/bulk', (req, res) => {
  try {
    const { rows } = req.body;
    if (!Array.isArray(rows) || rows.length === 0) return res.status(400).json({ error: 'rows 필요' });
    salaryDb.overtime.bulkUpsertDaily(rows.map(r => ({
      ...r,
      overtimeH: +(r.overtimeH || 0), nightH: +(r.nightH || 0),
      holidayH: +(r.holidayH || 0), holidayOtH: +(r.holidayOtH || 0),
    })));
    logSalaryAccess(req.user.userId, 'OVERTIME_DAILY_BULK', `일자별 연장 일괄 ${rows.length}건`);
    res.json({ ok: true, count: rows.length });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/salary/overtime/daily/:userId/:month/:workDate?company=
router.delete('/overtime/daily/:userId/:month/:workDate', (req, res) => {
  try {
    const { company } = req.query;
    const { userId, month, workDate } = req.params;
    if (!company) return res.status(400).json({ error: 'company 필요' });
    salaryDb.overtime.deleteDaily(userId, company, month, workDate);
    logSalaryAccess(req.user.userId, 'OVERTIME_DAILY_DELETE', `일자별 연장 삭제 ${userId} ${workDate}`);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════════════════════════
// 출퇴근 → 연장근무 자동 가져오기 (CAPS 오탐 필터링 포함)
// ══════════════════════════════════════════════════════════════════════════════
const SUSPICIOUS_OUT_MIN = 23 * 60 + 30; // 23:30 이후 퇴근 → 오탐 의심

/**
 * GET /api/salary/overtime-import?company=&month=
 * CAPS 캐시를 읽어 평일 연장시간을 집계하되,
 * outTime이 23:30 이후인 레코드는 "오탐 의심"으로 분리해서 반환한다.
 *
 * 반환 per employee:
 *   userId, name
 *   confirmedH : 확정 연장시간 (자동 반영 대상)
 *   suspicious : [{ date, outTime, hours }]  ← 사용자 체크 시에만 합산
 */
router.get('/overtime-import', async (req, res) => {
  const { company, month } = req.query;
  if (!company || !month) return res.status(400).json({ error: 'company, month 필요' });
  if (company !== 'dalim-sm') {
    return res.json({ ok: true, employees: [], warn: '대림컴퍼니는 CAPS 미연동 — 연장근무는 수동 입력' });
  }

  try {
    // 이름 매핑 빌드 (attendance-import와 동일)
    const nameToId = {};
    const uData = db.loadUsers();
    (uData.users || []).forEach(u => {
      if (u.name) nameToId[u.name] = u.id;
      if (u.capsName && u.capsName !== u.name) nameToId[u.capsName] = u.id;
    });
    const cfgs = salaryDb.configs.getAll(company);
    cfgs.forEach(c => { if (c.name && !nameToId[c.name]) nameToId[c.name] = c.userId; });
    const cfgIds = new Set(cfgs.map(c => c.userId));
    const nameMap = getNameMap(company);

    // CAPS 캐시 로드
    const [year, mon] = month.split('-');
    const from = `${year}-${String(mon).padStart(2,'0')}-01`;
    const lastDay = new Date(+year, +mon, 0).getDate();
    const to = `${year}-${String(mon).padStart(2,'0')}-${lastDay}`;
    const cacheKeyRaw = `sum_${from}_${to}_all`;
    const attendanceStoreDir = path.join(__dirname, '..', 'data', 'attendance-store');
    const cacheFile = path.join(attendanceStoreDir,
      Buffer.from(cacheKeyRaw, 'utf8').toString('hex') + '.json');
    if (!fs.existsSync(cacheFile)) {
      return res.json({ ok: true, warn: '출퇴근 캐시 없음 — 출퇴근 탭에서 해당 월을 먼저 조회하세요', employees: [] });
    }
    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    const payload = (raw && typeof raw === 'object' && 'data' in raw) ? raw.data : raw;
    let records = [];
    if (Array.isArray(payload)) records = payload;
    else if (payload && Array.isArray(payload.records)) records = payload.records;
    else if (payload && typeof payload === 'object') {
      for (const v of Object.values(payload)) if (Array.isArray(v)) records.push(...v);
    }

    // ── 직원별 집계 ─────────────────────────────────────────────────────────
    const byEmp = {}; // userId → { confirmedMin, suspicious:[] }
    for (const r of records) {
      if (!r.overtime || r.overtime <= 0) continue;       // 연장 0이면 스킵
      if (r.leaveType === 'weekend' || r.leaveType === 'holiday') continue; // 주말/공휴일 제외
      const empName = r.employeeName || r.employeeId;
      const uid = nameToId[empName];
      if (!uid || !cfgIds.has(uid)) continue;              // 급여 미설정 제외

      // outTime 파싱 ("HH:MM")
      let outMin = 0;
      if (typeof r.outTime === 'string' && /^\d{1,2}:\d{2}$/.test(r.outTime)) {
        const [hh, mm] = r.outTime.split(':').map(Number);
        outMin = hh * 60 + mm;
      }

      if (!byEmp[uid]) byEmp[uid] = { confirmedMin: 0, suspicious: [] };
      const hrs = Math.round((r.overtime / 60) * 100) / 100;

      if (outMin >= SUSPICIOUS_OUT_MIN) {
        // 오탐 의심 → 분리
        byEmp[uid].suspicious.push({
          date: r.date,
          outTime: r.outTime,
          hours: hrs,
          reason: '퇴근 타각이 23:30 이후 — 다음날 새벽 출근이 전날로 잘못 찍혔을 가능성',
        });
      } else {
        byEmp[uid].confirmedMin += r.overtime;
      }
    }

    // 전 직원 포함 (연장 없는 사람도 0으로)
    const employees = cfgs.map(c => {
      const e = byEmp[c.userId] || { confirmedMin: 0, suspicious: [] };
      return {
        userId: c.userId,
        name: c.name || nameMap[c.userId] || c.userId,
        confirmedH: Math.round((e.confirmedMin / 60) * 100) / 100,
        suspicious: e.suspicious.sort((a,b) => a.date.localeCompare(b.date)),
      };
    }).sort((a,b) => (a.name||'').localeCompare(b.name||'', 'ko'));

    logSalaryAccess(req.user.userId, 'OVERTIME_IMPORT_VIEW', `연장근무 자동가져오기 조회 ${company} ${month}`);
    res.json({ ok: true, month, company, employees });
  } catch (e) {
    console.error('[salary/overtime-import]', e);
    res.status(500).json({ error: e.message });
  }
});

/**
 * POST /api/salary/overtime-apply
 * body: { companyId, yearMonth, rows: [{ userId, overtimeH }] }
 * salary_overtime 테이블에 upsert (nightH/holidayH/holidayOtH는 0이 아닌 경우 기존값 유지)
 */
router.post('/overtime-apply', (req, res) => {
  try {
    const { companyId, yearMonth, rows } = req.body;
    if (!companyId || !yearMonth || !Array.isArray(rows)) {
      return res.status(400).json({ error: '파라미터 누락' });
    }
    const applied = [];
    for (const row of rows) {
      if (!row.userId) continue;
      // 기존 야간/휴일 값은 유지 (사용자가 수동 입력한 경우)
      const existing = salaryDb.overtime.getByMonth(companyId, yearMonth).find(r => r.userId === row.userId);
      salaryDb.overtime.upsertSummary({
        userId: row.userId, companyId, yearMonth,
        overtimeH: +(row.overtimeH || 0),
        nightH: existing?.nightHours || 0,
        holidayH: existing?.holidayHours || 0,
        holidayOtH: existing?.holidayOtHours || 0,
        memo: existing?.memo || '',
      });
      applied.push({ userId: row.userId, overtimeH: +(row.overtimeH || 0) });
    }
    logSalaryAccess(req.user.userId, 'OVERTIME_IMPORT_APPLY', `연장근무 자동반영 ${companyId} ${yearMonth} ${applied.length}명`);
    res.json({ ok: true, applied });
  } catch (e) {
    console.error('[salary/overtime-apply]', e);
    res.status(500).json({ error: e.message });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 지급현황 (연도별 전직원 × 12개월 그리드)
// ══════════════════════════════════════════════════════════════════════════════

// GET /api/salary/paystatus?company=&year=
router.get('/paystatus', (req, res) => {
  const { company, year } = req.query;
  if (!company || !year) return res.status(400).json({ error: '파라미터 누락' });
  const data = salaryDb.getPayStatus(company, year);
  // ERP / configs에서 이름 보완
  const nameMap = getNameMap(company);
  data.employees.forEach(e => { if (!e.name) e.name = nameMap[e.userId] || e.userId; });
  data.employees.sort((a,b) => (a.name||'').localeCompare(b.name||'', 'ko'));
  logSalaryAccess(req.user.userId, 'VIEW', `지급현황 조회 ${company} ${year}`);
  res.json(data);
});

module.exports = router;
