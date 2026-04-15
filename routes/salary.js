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
router.get('/records', (req, res) => {
  const { company, month } = req.query;
  const recs = salaryDb.records.getByMonth(company, month);
  const labels = salaryDb.itemLabels.get(company, month);
  logSalaryAccess(req.user.userId, 'VIEW', `급여대장 조회 ${company} ${month}`);
  res.json({ records: recs, labels });
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
router.post('/calculate', async (req, res) => {
  try {
    const { companyId, yearMonth, userIds, overwrite = false } = req.body;
    const settingsRow = salaryDb.settings.get(companyId);
    if (!settingsRow) return res.status(400).json({ error: '요율 설정이 없습니다.' });

    const targets = userIds?.length
      ? userIds.map(id => salaryDb.configs.get(id, companyId)).filter(Boolean)
      : salaryDb.configs.getAll(companyId);

    // ── 회사별 근무일수 자동계산 ────────────────────────────────────────────
    // 대림컴퍼니: 이 월의 평일 수를 기본값으로 사용
    // 대림에스엠: CAPS 데이터 없으면 null (기존 레코드 값 유지)
    const autoWorkDays = await getAttendanceWorkDays(null, companyId, yearMonth);

    // 월별 연장/야간/휴일 근무 데이터 일괄 로드 (userId별 맵)
    const overtimeRows = salaryDb.overtime.getByMonth(companyId, yearMonth);
    const overtimeMap = {};
    overtimeRows.forEach(r => { overtimeMap[r.userId] = r; });

    const results = [];
    for (const config of targets) {
      const existing = salaryDb.records.getOne(config.userId, companyId, yearMonth);
      if (existing && existing.status !== 'draft' && !overwrite) {
        results.push({ userId: config.userId, skipped: true, reason: '이미 확정/지급됨' });
        continue;
      }
      // 근무일수: 기존 수동 입력값 있으면 유지, 없으면 회사별 자동값 적용
      const workDays = (existing?.workDays && existing.workDays > 0)
        ? existing.workDays
        : (autoWorkDays ?? existing?.workDays ?? 0);

      const overtimeData = overtimeMap[config.userId] || null;
      const calc = salaryDb.calcSalary({ config, settingsRow, overtimeData, yearMonth, extraItems: existing || {} });
      const saved = salaryDb.records.upsert({
        ...existing,
        ...calc,
        userId: config.userId,
        companyId,
        yearMonth,
        workDays, // 근무일수 자동/수동 적용
      });
      results.push({ userId: config.userId, record: saved });
    }
    logSalaryAccess(req.user.userId, 'CALCULATE', `급여계산 ${companyId} ${yearMonth}`);
    res.json({ ok: true, results, autoWorkDays });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /api/salary/records/:id — 수동 수정
router.put('/records/:id', (req, res) => {
  try {
    const existing = salaryDb.records.getById(req.params.id);
    if (!existing) return res.status(404).json({ error: '없음' });
    if (existing.status !== 'draft') return res.status(400).json({ error: '확정된 급여는 수정 불가' });
    const updated = salaryDb.records.upsert({ ...existing, ...req.body, id: undefined });
    logSalaryAccess(req.user.userId, 'EDIT', `급여수정 ${existing.userId} ${existing.yearMonth}`);
    res.json({ ok: true, record: updated });
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
    const companyName = company === 'dalim-sm' ? '대림에스엠' : '대림컴퍼니';

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
    const companyName = company === 'dalim-sm' ? '대림에스엠' : '대림컴퍼니';
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
    const companyName = company === 'dalim-sm' ? '대림에스엠' : '대림컴퍼니';

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
      '건강4월추가','요양4월추가','건강환급이자','요양환급이자','잡공제1','잡공제2',
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
router.post('/tax-table/upload', requireAdmin, upload.single('file'), (req, res) => {
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
    const data = { ...req.body, uploadedBy: req.user.userId, source: 'manual' };
    salaryDb.ediRecords.upsert(data);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /api/salary/edi/upload — EDI 파일 업로드 (건강보험공단 xls)
router.post('/edi/upload', upload.single('file'), (req, res) => {
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
    rec.healthAprExtra ? ['건강보험 4월추가분', '', fmt(rec.healthAprExtra)] : null,
    rec.ltcAprExtra ? ['장기요양 4월추가분', '', fmt(rec.ltcAprExtra)] : null,
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

  return `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="UTF-8">
<title>${companyName} ${month} 급여명세서 — ${name}</title>
<style>
  @page { margin: 20mm 15mm; size: A4; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Malgun Gothic', sans-serif; font-size: 13px; color: #1f2937; background: #fff; }
  .slip { max-width: 680px; margin: 0 auto; padding: 24px; }
  .header { text-align: center; margin-bottom: 20px; }
  .header h1 { font-size: 22px; font-weight: 700; letter-spacing: 2px; }
  .header .company { font-size: 15px; color: #4b5563; margin-bottom: 6px; }
  .info-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 20px; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px; padding: 12px 16px; margin-bottom: 16px; font-size: 12px; }
  .info-grid dt { color: #6b7280; }
  .info-grid dd { font-weight: 600; }
  .section { margin-bottom: 14px; }
  .section-title { font-size: 12px; font-weight: 700; color: #374151; background: #f3f4f6; padding: 6px 10px; border-left: 3px solid #4f6ef7; margin-bottom: 0; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  td { padding: 5px 10px; border-bottom: 1px solid #f3f4f6; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .subtotal td { background: #f9fafb; font-weight: 600; border-top: 1px solid #d1d5db; }
  .nettotal { background: #1e3a5f; color: #fff; border-radius: 8px; padding: 14px 20px; display: flex; justify-content: space-between; align-items: center; margin-top: 14px; }
  .nettotal .label { font-size: 15px; font-weight: 700; }
  .nettotal .amount { font-size: 22px; font-weight: 800; letter-spacing: -0.5px; }
  .basis { margin-top: 16px; font-size: 11px; color: #6b7280; border-top: 1px solid #e5e7eb; padding-top: 10px; line-height: 1.8; }
  @media print { .no-print { display: none !important; } }
  .print-btn { text-align: center; margin-top: 20px; }
  .print-btn button { background: #4f6ef7; color: #fff; border: none; padding: 10px 28px; border-radius: 6px; font-size: 14px; cursor: pointer; }
</style>
</head>
<body>
<div class="slip">
  <div class="header">
    <div class="company">${companyName}</div>
    <h1>급 여 명 세 서</h1>
  </div>
  <dl class="info-grid">
    <dt>귀속연월</dt><dd>${month}</dd>
    <dt>급여지급일</dt><dd>${rec.payDate || '—'}</dd>
    <dt>성명</dt><dd>${name}</dd>
    <dt>부서/직위</dt><dd>${dept}${position ? ' / ' + position : ''}</dd>
    <dt>입사일</dt><dd>${hireDate || '—'}</dd>
    <dt>통상시급</dt><dd>${fmt(Math.round(config?.hourlyRate || 0))}원</dd>
    <dt>근무일수</dt><dd>${rec.workDays || 0}일</dd>
    <dt>근무시간</dt><dd>${rec.workHours || 0}시간</dd>
  </dl>

  <div class="section">
    <div class="section-title">지급 내역</div>
    <table>
      ${payRowsHtml}
      <tr class="subtotal">
        <td>과세합계</td><td></td><td class="num">${fmt(rec.taxableTotal)}</td>
      </tr>
      <tr class="subtotal" style="color:#6b7280;">
        <td>비과세합계</td><td></td><td class="num">${fmt(rec.nonTaxableTotal)}</td>
      </tr>
      <tr class="subtotal">
        <td>지급합계</td><td></td><td class="num">${fmt(rec.grossPay)}</td>
      </tr>
    </table>
  </div>

  <div class="section">
    <div class="section-title">공제 내역</div>
    <table>
      ${dedRowsHtml}
      <tr class="subtotal">
        <td>공제합계</td><td></td><td class="num">${fmt(rec.totalDeductions)}</td>
      </tr>
    </table>
  </div>

  <div class="nettotal">
    <span class="label">실 지 급 액</span>
    <span class="amount">${fmt(rec.netPay)} 원</span>
  </div>

  <div class="basis">
    ※ 4대보험: 국민연금 ${s.pensionRate||4.5}% / 건강보험 ${s.healthRate||3.595}% / 장기요양 ${s.ltcRate||13.14}% (건보료 대비) / 고용보험 ${s.employmentRate||0.9}%<br>
    ※ 비과세: 식대(월 20만원 한도), 차량유지비<br>
    ※ 소득세: 근로소득 간이세액표 기준 (부양가족 ${config?.dependents||1}명)
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

  const [year, mon] = month.split('-');

  try {
    // ── 1. 이름 → userId 매핑 빌드 ──────────────────────────────────────────
    const nameToId = {};   // employeeName → userId
    const nameMap = {};    // employeeName → displayName (after capsName mapping)
    const uData = db.loadUsers();
    (uData.users || []).forEach(u => {
      if (u.name) nameToId[u.name] = u.id;
      // capsName 처리 (CAPS에 다른 이름으로 등록된 경우)
      if (u.capsName && u.capsName !== u.name) {
        nameToId[u.capsName] = u.id;
        nameMap[u.capsName] = u.name;
      }
    });
    // salary_configs.name으로도 보완 (대림컴퍼니 ERP 미등록 직원)
    const cfgs = salaryDb.configs.getAll(company);
    cfgs.forEach(c => {
      if (c.name && !nameToId[c.name]) nameToId[c.name] = c.userId;
    });

    // ── 2. 출퇴근 summary API 내부 호출 ────────────────────────────────────
    // attendance.js의 /api/attendance/summary를 직접 require하는 대신
    // 같은 로직의 핵심인 attendance-store 캐시 파일을 읽음
    const attendanceStoreDir = path.join(__dirname, '..', 'data', 'attendance-store');

    const from = `${year}-${String(mon).padStart(2,'0')}-01`;
    const lastDay = new Date(+year, +mon, 0).getDate();
    const to = `${year}-${String(mon).padStart(2,'0')}-${lastDay}`;
    const cacheKeyRaw = `sum_${from}_${to}_all`;
    const cacheFile = path.join(attendanceStoreDir,
      Buffer.from(cacheKeyRaw, 'utf8').toString('hex') + '.json');

    // ── 대림컴퍼니: CAPS 없음 → 평일 수 자동계산으로 전 직원 반환 ────────────────
    if (company === 'dalim-company' || !fs.existsSync(cacheFile)) {
      const weekdays = calcWeekdaysInMonth(month);
      const cfgsAll = salaryDb.configs.getAll(company);
      if (company === 'dalim-company') {
        const nameMapLocal = getNameMap(company);
        const empList = cfgsAll.map(c => ({
          userId: c.userId,
          name: c.name || nameMapLocal[c.userId] || c.userId,
          workDays: weekdays,
          annualDays: 0, absentDays: 0, lateCount: 0, totalOvertimeH: 0,
          _autoCalc: true,
        }));
        return res.json({
          ok: true,
          month, company,
          employees: empList,
          note: `대림컴퍼니: CAPS 미연동 — ${month.slice(5)}월 평일 수(${weekdays}일) 자동 적용. 추후 자체 ERP 연동 시 실제 데이터로 교체됩니다.`,
        });
      }
      // 대림에스엠인데 CAPS 캐시 없는 경우
      return res.json({
        ok: true,
        warn: '출퇴근 데이터 없음 — 출퇴근 탭에서 해당 월을 먼저 조회/동기화하세요',
        employees: []
      });
    }

    const raw = JSON.parse(fs.readFileSync(cacheFile, 'utf8'));
    // 캐시 파일 포맷: {_key, data, savedAt} 또는 과거 평문 배열
    const payload = (raw && typeof raw === 'object' && 'data' in raw) ? raw.data : raw;
    let records = [];
    if (Array.isArray(payload)) records = payload;
    else if (payload && Array.isArray(payload.records)) records = payload.records;
    else if (payload && typeof payload === 'object') {
      // 날짜별 맵 형태면 flatten
      for (const v of Object.values(payload)) {
        if (Array.isArray(v)) records.push(...v);
      }
    }

    // ── 3. 직원별 집계 ────────────────────────────────────────────────────
    // attendance.js의 analyzeRecord 함수와 동일한 로직 (핵심만 추출)
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

    // 수동 노트 추가 적용 (attendanceNotes)
    try {
      const workData = db.출퇴근관리.load();
      const notes = workData.attendanceNotes || {};
      for (const [key, note] of Object.entries(notes)) {
        const m = key.match(/^(.+)_(\d{4}-\d{2}-\d{2})$/);
        if (!m) continue;
        const [, empName, date] = m;
        if (date < from || date > to) continue;
        if (!byName[empName]) byName[empName] = { normalDays:0, halfAM:0, halfPM:0, annualDays:0, absentDays:0, lateCount:0, totalOvertimeMin:0 };
        // 수동 레코드는 이미 위 records에 포함될 수도 있으므로 중복 방지 불필요 — 여기서는 건너뜀
        // (attendance.js에서 이미 수동+CAPS를 병합한 캐시를 사용하므로 자동 반영됨)
      }
    } catch(e) {}

    // ── 4. 이름 → userId 변환 후 결과 빌드 ──────────────────────────────
    const result = [];
    for (const [empName, stats] of Object.entries(byName)) {
      const userId = nameToId[empName];
      if (!userId) continue; // 급여 미설정 직원 제외

      // salary_configs에 없는 직원도 제외 (해당 회사 소속인지 확인)
      const cfg = cfgs.find(c => c.userId === userId);
      if (!cfg) continue;

      const workDays = stats.normalDays + stats.halfAM * 0.5 + stats.halfPM * 0.5;
      result.push({
        userId,
        name: nameMap[empName] || empName,
        workDays: Math.round(workDays * 2) / 2, // 0.5 단위 반올림
        annualDays: stats.annualDays + stats.halfAM * 0.5 + stats.halfPM * 0.5,
        absentDays: stats.absentDays,
        lateCount: stats.lateCount,
        totalOvertimeH: Math.round((stats.totalOvertimeMin / 60) * 10) / 10,
      });
    }

    logSalaryAccess(req.user.userId, 'ATTENDANCE_IMPORT', `출퇴근 연동 조회 ${company} ${month}`);
    res.json({ ok: true, month, company, employees: result });

  } catch (e) {
    console.error('[salary/attendance-import]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// POST /api/salary/attendance-apply — 출퇴근 데이터를 급여 레코드에 일괄 반영
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
      const updated = salaryDb.records.upsert({
        ...existing,
        workDays: emp.workDays,
        // annualDays, lateCount는 메모로 저장 (별도 필드 없음)
        note: [existing.note, `출퇴근연동: 연차${emp.annualDays}일 지각${emp.lateCount}회`].filter(Boolean).join(' | '),
      });
      results.push({ userId: emp.userId, ok: true, workDays: emp.workDays });
    } catch (e) {
      results.push({ userId: emp.userId, error: e.message });
    }
  }
  logSalaryAccess(req.user.userId, 'ATTENDANCE_APPLY', `출퇴근 데이터 반영 ${companyId} ${yearMonth}`);
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
