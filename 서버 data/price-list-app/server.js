const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const https = require('https');
const net = require('net');
const tls = require('tls');
const crypto = require('crypto');
const db = require('./db');
const PDFDocument = require('pdfkit');
let sharp;
try { sharp = require('sharp'); } catch(e) { console.log('[썸네일] sharp 미설치 — npm install sharp 권장'); }

// 썸네일 캐시 폴더
const THUMB_DIR = path.join(__dirname, 'data', 'thumbs');
if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

// HTML 이스케이프 유틸
function escHtml(str) {
  if (!str) return '';
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── 견적서 PDF 생성 함수 ──
// Windows 시스템 폰트 (맑은 고딕) 사용, 없으면 data 폴더 폰트 사용
const WIN_FONT = 'C:\\Windows\\Fonts\\malgun.ttf';
const WIN_FONT_BOLD = 'C:\\Windows\\Fonts\\malgunbd.ttf';
const FONT_PATH = fs.existsSync(WIN_FONT) ? WIN_FONT : path.join(__dirname, 'data', 'NotoSansKR-Regular.ttf');
const FONT_BOLD_PATH = fs.existsSync(WIN_FONT_BOLD) ? WIN_FONT_BOLD : path.join(__dirname, 'data', 'NotoSansKR-Bold.ttf');
const LOGO_PATH = path.join(__dirname, 'data', 'logo.png');
const STAMP_PATH = path.join(__dirname, 'data', 'stamp.png');

function generateQuotePdf(quoteData, namecardImgPath) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 50, autoFirstPage: true });
      const chunks = [];
      doc.on('data', c => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const hasFont = fs.existsSync(FONT_PATH);
      const hasBold = fs.existsSync(FONT_BOLD_PATH);
      if (hasFont) doc.registerFont('Korean', FONT_PATH);
      if (hasBold) doc.registerFont('KoreanBold', FONT_BOLD_PATH);
      const f = hasFont ? 'Korean' : 'Helvetica';
      const fb = hasBold ? 'KoreanBold' : (hasFont ? 'Korean' : 'Helvetica-Bold');

      const pw = 595.28; // A4 width
      const ml = 50, mr = 50;
      const cw = pw - ml - mr; // content width
      let y = 50;

      // ── 헤더: 로고 + 회사정보 ──
      if (fs.existsSync(LOGO_PATH)) {
        try { doc.image(LOGO_PATH, ml, y, { height: 36 }); } catch(e) {}
      }
      doc.font(fb).fontSize(22).fillColor('#1a1a1a').text('견적내역서', ml, y + 42, { width: cw * 0.55 });
      doc.font(f).fontSize(8).fillColor('#9ca3af').text('OFFICIAL BUSINESS QUOTATION', ml, y + 66, { width: cw * 0.55 });

      // 오른쪽 회사 정보
      const rx = ml + cw * 0.55;
      const rw = cw * 0.45;
      doc.font(fb).fontSize(14).fillColor('#1a1a1a').text('DAELIM SM', rx, y, { width: rw, align: 'right' });
      doc.font(f).fontSize(8).fillColor('#4b5563').text('서울 구로구 경인로 393-7(고척동 73-3)', rx, y + 20, { width: rw, align: 'right' });
      doc.text('일이삼전자타운 2동 4층 4101호', rx, y + 31, { width: rw, align: 'right' });
      doc.text('TEL: 02.2682.8940 | FAX: 02.2672.3620', rx, y + 42, { width: rw, align: 'right' });
      doc.font(fb).fontSize(9).fillColor('#1a1a1a').text('대표이사 이 정 호', rx, y + 58, { width: rw, align: 'right' });

      // 직인
      if (fs.existsSync(STAMP_PATH)) {
        try { doc.image(STAMP_PATH, pw - mr - 48, y + 2, { width: 44, height: 44 }); } catch(e) {}
      }

      y += 90;
      doc.moveTo(ml, y).lineTo(pw - mr, y).strokeColor('#e5e7eb').lineWidth(1).stroke();
      y += 16;

      // ── 현장명 / 견적명 ──
      doc.font(f).fontSize(8).fillColor('#9ca3af').text('현장명', ml, y);
      y += 12;
      doc.font(fb).fontSize(13).fillColor('#1a1a1a').text(quoteData.siteName || '-', ml, y, { width: cw * 0.55 });
      y += 20;
      doc.moveTo(ml, y).lineTo(ml + cw * 0.55, y).strokeColor('#1a1a1a').lineWidth(1.5).stroke();
      y += 10;
      doc.font(f).fontSize(8).fillColor('#9ca3af').text('견적명', ml, y);
      y += 12;
      doc.font(fb).fontSize(13).fillColor('#1a1a1a').text(quoteData.quoteName || '-', ml, y, { width: cw * 0.55 });
      y += 20;
      doc.moveTo(ml, y).lineTo(ml + cw * 0.55, y).strokeColor('#1a1a1a').lineWidth(1.5).stroke();
      y += 14;

      // 담당자 / 우리측 담당 / 견적일
      const colW = cw * 0.55 / 3;
      const labels = ['담당자', '우리측 담당', '견적일'];
      const values = [quoteData.manager || '-', quoteData.vendorManager || '-', quoteData.quoteDate || new Date().toISOString().slice(0,10)];
      for (let i = 0; i < 3; i++) {
        const cx = ml + colW * i;
        doc.font(f).fontSize(7).fillColor('#9ca3af').text(labels[i], cx, y);
        doc.font(f).fontSize(10).fillColor('#1a1a1a').text(values[i], cx, y + 11, { width: colW - 8 });
      }
      y += 28;
      doc.moveTo(ml, y).lineTo(ml + cw * 0.55, y).strokeColor('#d1d5db').lineWidth(0.5).stroke();

      // ── 총 견적금액 박스 (오른쪽) ──
      const supplyTotal = quoteData.items.reduce((s, it) => s + ((it.qty || 0) * (it.unitPrice || 0)), 0);
      const vatAmount = Math.round(supplyTotal * 0.1);
      const grandTotal = supplyTotal + vatAmount;
      const boxX = ml + cw * 0.58, boxY = y - 90, boxW = cw * 0.42, boxH = 80;
      doc.roundedRect(boxX, boxY, boxW, boxH, 6).fillColor('#fdf6ed').fill();
      doc.font(f).fontSize(8).fillColor('#8b5e3c').text('총 견적금액 (VAT 포함)', boxX + 12, boxY + 12, { width: boxW - 24 });
      doc.font(fb).fontSize(22).fillColor('#1a1a1a').text('₩ ' + grandTotal.toLocaleString(), boxX + 12, boxY + 26, { width: boxW - 24 });
      doc.font(f).fontSize(8).fillColor('#8b5e3c').text(`공급가액 ₩${supplyTotal.toLocaleString()} + VAT ₩${vatAmount.toLocaleString()}`, boxX + 12, boxY + 54, { width: boxW - 24 });

      y += 20;

      // ── 품목 테이블 ──
      const cols = [
        { label: 'No', w: 28, align: 'center' },
        { label: '품명', w: cw * 0.28, align: 'left' },
        { label: '단위', w: 40, align: 'center' },
        { label: '수량', w: 45, align: 'right' },
        { label: '단가', w: 65, align: 'right' },
        { label: '금액', w: 70, align: 'right' },
        { label: '비고', w: 0, align: 'left' } // 나머지
      ];
      // 비고 폭 계산
      const usedW = cols.slice(0, 6).reduce((s, c) => s + c.w, 0);
      cols[6].w = cw - usedW;

      const rh = 26; // row height (글씨 잘림 방지)
      // 헤더
      doc.rect(ml, y, cw, rh).fillColor('#f9fafb').fill();
      let cx = ml;
      for (const col of cols) {
        doc.font(fb).fontSize(8).fillColor('#6b7280');
        const tx = col.align === 'right' ? cx + col.w - 6 : (col.align === 'center' ? cx + col.w / 2 : cx + 6);
        doc.text(col.label, tx - (col.align === 'center' ? 20 : 0), y + 7, { width: col.align === 'center' ? 40 : col.w - 6, align: col.align });
        cx += col.w;
      }
      doc.moveTo(ml, y + rh).lineTo(pw - mr, y + rh).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      y += rh;

      // 데이터 행
      quoteData.items.forEach((item, idx) => {
        const amt = (item.qty || 0) * (item.unitPrice || 0);
        if (y > 720) { doc.addPage(); y = 50; }
        cx = ml;
        const vals = [
          String(idx + 1).padStart(2, '0'),
          item.name || '',
          item.unit || '',
          String(item.qty || 0),
          (item.unitPrice || 0).toLocaleString(),
          amt.toLocaleString(),
          item.remark || ''
        ];
        for (let i = 0; i < cols.length; i++) {
          const col = cols[i];
          const isName = i === 1;
          doc.font(isName ? fb : f).fontSize(9).fillColor(i === 0 ? '#9ca3af' : '#1a1a1a');
          const tx = col.align === 'right' ? cx + col.w - 6 : (col.align === 'center' ? cx + col.w / 2 : cx + 6);
          doc.text(vals[i], tx - (col.align === 'center' ? 20 : 0), y + 7, { width: col.align === 'center' ? 40 : col.w - 12, align: col.align, lineBreak: false });
          cx += col.w;
        }
        doc.moveTo(ml, y + rh).lineTo(pw - mr, y + rh).strokeColor('#e5e7eb').lineWidth(0.3).stroke();
        y += rh;
      });

      // 합계 영역
      const sumLabelW = cw - cols[5].w - cols[6].w;
      // 공급가액
      doc.font(f).fontSize(8).fillColor('#6b7280').text('공급가액', ml, y + 5, { width: sumLabelW - 6, align: 'right' });
      doc.font(fb).fontSize(10).fillColor('#1a1a1a').text('₩ ' + supplyTotal.toLocaleString(), ml + sumLabelW, y + 4, { width: cols[5].w + cols[6].w, align: 'right' });
      doc.moveTo(ml, y + rh).lineTo(pw - mr, y + rh).strokeColor('#e5e7eb').lineWidth(0.3).stroke();
      y += rh;
      // 부가세
      doc.font(f).fontSize(8).fillColor('#6b7280').text('부가세 (10%)', ml, y + 5, { width: sumLabelW - 6, align: 'right' });
      doc.font(fb).fontSize(10).fillColor('#1a1a1a').text('₩ ' + vatAmount.toLocaleString(), ml + sumLabelW, y + 4, { width: cols[5].w + cols[6].w, align: 'right' });
      doc.moveTo(ml, y + rh).lineTo(pw - mr, y + rh).strokeColor('#e5e7eb').lineWidth(0.3).stroke();
      y += rh;
      // 합계
      doc.rect(ml, y, cw, rh + 4).fillColor('#f9fafb').fill();
      doc.font(fb).fontSize(10).fillColor('#4b5563').text('합 계', ml, y + 7, { width: sumLabelW - 6, align: 'right' });
      doc.font(fb).fontSize(16).fillColor('#1a1a1a').text('₩ ' + grandTotal.toLocaleString(), ml + sumLabelW, y + 3, { width: cols[5].w + cols[6].w, align: 'right' });
      y += rh + 8;

      // 유효기간
      doc.font(f).fontSize(7).fillColor('#94a3b8').text('※ 견적 유효기간: 견적일로부터 30일', ml, y, { width: cw, align: 'right' });
      y += 16;

      // ── 하단 ──
      y = Math.max(y, 700);
      doc.moveTo(ml, y).lineTo(pw - mr, y).strokeColor('#e5e7eb').lineWidth(0.5).stroke();
      doc.font(f).fontSize(7).fillColor('#9ca3af').text('품질과 안전을 최우선으로 고객을 위해 항상 최선을 다하겠습니다', ml, y + 6, { width: cw, align: 'center' });
      doc.text('DAELIM SM - Total Safety Group Co., Ltd.', ml, y + 16, { width: cw, align: 'center' });

      doc.end();
    } catch(e) { reject(e); }
  });
}

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));

// ── index.html 서버사이드 인클루드 ─────────────────────────
// <!--INCLUDE:파일명.html--> 태그를 실제 파일 내용으로 치환하여 서빙
// 분리된 탭 HTML (tab-pricing.html, tab-options.html 등)을 index.html에 합쳐서 전송
const PUBLIC_DIR = path.join(__dirname, 'public');
let _indexCache = null;
let _indexMtime = 0;

function buildIndexHtml() {
  const indexPath = path.join(PUBLIC_DIR, 'index.html');
  const stat = fs.statSync(indexPath);
  // 인클루드 파일들의 최신 mtime도 확인
  const includeFiles = (fs.readdirSync(PUBLIC_DIR)).filter(f => f.startsWith('tab-') && f.endsWith('.html'));
  const latestMtime = Math.max(stat.mtimeMs, ...includeFiles.map(f => {
    try { return fs.statSync(path.join(PUBLIC_DIR, f)).mtimeMs; } catch(e) { return 0; }
  }));
  // 파일이 변경되지 않았으면 캐시 사용
  if (_indexCache && latestMtime === _indexMtime) return _indexCache;
  let html = fs.readFileSync(indexPath, 'utf-8');
  // <!--INCLUDE:filename.html--> 패턴 치환
  html = html.replace(/<!--INCLUDE:([a-zA-Z0-9_\-]+\.html)-->/g, (match, filename) => {
    const filePath = path.join(PUBLIC_DIR, filename);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    console.warn('[SSI] 파일 없음:', filename);
    return match; // 파일이 없으면 원본 유지
  });
  _indexCache = html;
  _indexMtime = latestMtime;
  return html;
}

app.get(['/', '/index.html'], (req, res) => {
  try {
    const html = buildIndexHtml();
    res.type('html').send(html);
  } catch (e) {
    console.error('[SSI] 오류:', e.message);
    // 실패 시 원본 index.html 직접 전송
    res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));
// data 폴더에서 로고/직인 이미지 제공
app.use('/data', express.static(path.join(__dirname, 'data')));

// ── 쿠키 파서 (수동) ─────────────────────────────────────
function parseCookies(req) {
  const obj = {};
  const str = req.headers.cookie || '';
  str.split(';').forEach(pair => {
    try {
      const [k, ...v] = pair.trim().split('=');
      if (k) obj[k.trim()] = decodeURIComponent(v.join('='));
    } catch(e) {}
  });
  return obj;
}

// ── 세션 관리 ─────────────────────────────────────────────
const sessions = {}; // { token: { userId, name, role, loginAt } }

function hashPassword(pw) {
  return crypto.createHash('sha256').update(pw + '_단가표_salt').digest('hex');
}

function requireAuth(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  if (!token || !sessions[token]) {
    return res.status(401).json({ error: '로그인이 필요합니다' });
  }
  req.user = sessions[token];
  req.sessionToken = token;
  next();
}

function requireAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (req.user.role !== 'admin') return res.status(403).json({ error: '관리자 권한이 필요합니다' });
    next();
  });
}

// 초기 관리자 계정 확인 (없으면 admin/admin 생성)
function ensureAdminAccount() {
  const data = db.load();
  if (!data.users) data.users = [];
  const hasAdmin = data.users.some(u => u.role === 'admin');
  if (!hasAdmin) {
    data.users.push({
      id: db.generateId('u'),
      userId: 'admin',
      name: '관리자',
      password: hashPassword('admin'),
      role: 'admin',        // admin 또는 user
      status: 'approved',   // approved, pending, rejected
      createdAt: new Date().toISOString(),
      lastLogin: null
    });
    db.save(data);
    console.log('[초기설정] 관리자 계정 생성됨 (admin / admin)');
  }
}

// ── 로그인 ────────────────────────────────────────────────
app.post('/api/auth/login', (req, res) => {
  const { userId, password } = req.body;
  if (!userId || !password) return res.status(400).json({ error: '아이디와 비밀번호를 입력해주세요' });

  const data = db.load();
  if (!data.users) data.users = [];
  const user = data.users.find(u => u.userId === userId);
  if (!user) return res.status(401).json({ error: '존재하지 않는 아이디입니다' });
  if (user.password !== hashPassword(password)) return res.status(401).json({ error: '비밀번호가 틀렸습니다' });
  if (user.status === 'pending') return res.status(403).json({ error: '관리자 승인 대기 중입니다. 관리자에게 문의하세요.' });
  if (user.status === 'rejected') return res.status(403).json({ error: '가입이 거절되었습니다. 관리자에게 문의하세요.' });

  // 로그인 성공
  user.lastLogin = new Date().toISOString();
  db.save(data);

  const token = crypto.randomBytes(32).toString('hex');
  const perms = user.permissions || [];
  sessions[token] = { userId: user.userId, name: user.name, role: user.role, position: user.position || '', phone: user.phone || '', permissions: perms, loginAt: Date.now() };
  res.setHeader('Set-Cookie', `session_token=${token}; Path=/; HttpOnly; Max-Age=86400`);
  res.json({ ok: true, userId: user.userId, name: user.name, role: user.role, position: user.position || '', phone: user.phone || '', permissions: perms });
});

// 회원가입 (관리자 승인 필요)
app.post('/api/auth/register', (req, res) => {
  const { userId, password, name, position, phone } = req.body;
  if (!userId || !password || !name) return res.status(400).json({ error: '아이디, 비밀번호, 이름을 모두 입력해주세요' });
  if (userId.length < 3) return res.status(400).json({ error: '아이디는 3자 이상이어야 합니다' });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다' });

  const data = db.load();
  if (!data.users) data.users = [];
  if (data.users.find(u => u.userId === userId)) return res.status(400).json({ error: '이미 사용 중인 아이디입니다' });

  data.users.push({
    id: db.generateId('u'),
    userId,
    name,
    position: position || '',
    phone: phone || '',
    password: hashPassword(password),
    role: 'user',
    status: 'pending',  // 관리자 승인 대기
    createdAt: new Date().toISOString(),
    lastLogin: null
  });
  db.save(data);
  res.json({ ok: true, message: '가입 신청이 완료되었습니다. 관리자 승인 후 로그인할 수 있습니다.' });
});

// 로그아웃
app.post('/api/auth/logout', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token;
  if (token) delete sessions[token];
  res.setHeader('Set-Cookie', 'session_token=; Path=/; HttpOnly; Max-Age=0');
  res.json({ ok: true });
});

// 현재 로그인 상태
app.get('/api/auth/me', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  if (!token || !sessions[token]) return res.json({ loggedIn: false });
  const s = sessions[token];
  res.json({ loggedIn: true, userId: s.userId, name: s.name, role: s.role, position: s.position || '', phone: s.phone || '', permissions: s.permissions || [] });
});

// ── 관리자: 사용자 관리 ──────────────────────────────────
app.get('/api/admin/users', requireAdmin, (req, res) => {
  const data = db.load();
  // 비밀번호 제외하고 반환
  const users = (data.users || []).map(u => ({
    id: u.id, userId: u.userId, name: u.name, role: u.role, status: u.status,
    position: u.position || '', phone: u.phone || '',
    permissions: u.permissions || [],
    createdAt: u.createdAt, lastLogin: u.lastLogin
  }));
  res.json(users);
});

// 관리자 직접 계정 생성
app.post('/api/admin/users/create', requireAdmin, (req, res) => {
  const { userId, password, name, role, position, phone } = req.body;
  if (!userId || !password || !name) return res.status(400).json({ error: '아이디, 비밀번호, 이름을 모두 입력해주세요' });
  if (userId.length < 3) return res.status(400).json({ error: '아이디는 3자 이상이어야 합니다' });
  if (password.length < 4) return res.status(400).json({ error: '비밀번호는 4자 이상이어야 합니다' });

  const data = db.load();
  if (!data.users) data.users = [];
  if (data.users.some(u => u.userId === userId)) {
    return res.status(400).json({ error: '이미 존재하는 아이디입니다' });
  }

  data.users.push({
    id: db.generateId('u'), userId, name,
    position: position || '', phone: phone || '',
    password: hashPassword(password),
    role: role === 'admin' ? 'admin' : 'user',
    status: 'approved', // 관리자가 만든 계정은 바로 승인
    createdAt: new Date().toISOString(), lastLogin: null
  });
  db.save(data);
  res.json({ ok: true, message: `${name} (${userId}) 계정 생성 완료` });
});

// 사용자 승인
app.post('/api/admin/users/:id/approve', requireAdmin, (req, res) => {
  const data = db.load();
  const user = (data.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.status = 'approved';
  db.save(data);
  res.json({ ok: true, message: user.name + ' 승인 완료' });
});

// 사용자 거절
app.post('/api/admin/users/:id/reject', requireAdmin, (req, res) => {
  const data = db.load();
  const user = (data.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.status = 'rejected';
  db.save(data);
  res.json({ ok: true, message: user.name + ' 거절' });
});

// 사용자 삭제
app.delete('/api/admin/users/:id', requireAdmin, (req, res) => {
  const data = db.load();
  if (!data.users) data.users = [];
  const target = data.users.find(u => u.id === req.params.id);
  if (target && target.role === 'admin' && data.users.filter(u => u.role === 'admin').length <= 1) {
    return res.status(400).json({ error: '마지막 관리자는 삭제할 수 없습니다' });
  }
  data.users = data.users.filter(u => u.id !== req.params.id);
  db.save(data);
  res.json({ ok: true });
});

// 사용자 역할 변경
app.post('/api/admin/users/:id/role', requireAdmin, (req, res) => {
  const data = db.load();
  const user = (data.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  const newRole = req.body.role;
  if (newRole !== 'admin' && newRole !== 'user') return res.status(400).json({ error: '유효하지 않은 역할' });
  // 마지막 관리자 체크
  if (user.role === 'admin' && newRole === 'user') {
    const adminCount = data.users.filter(u => u.role === 'admin').length;
    if (adminCount <= 1) return res.status(400).json({ error: '마지막 관리자의 역할을 변경할 수 없습니다' });
  }
  user.role = newRole;
  db.save(data);
  res.json({ ok: true });
});

// 비밀번호 초기화 (관리자)
app.post('/api/admin/users/:id/reset-password', requireAdmin, (req, res) => {
  const data = db.load();
  const user = (data.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  const newPw = req.body.password || '1234';
  user.password = hashPassword(newPw);
  db.save(data);
  res.json({ ok: true, message: `${user.name} 비밀번호를 "${newPw}"로 초기화했습니다` });
});

// 사용자별 메뉴 권한 설정 (관리자)
app.post('/api/admin/users/:id/permissions', requireAdmin, (req, res) => {
  const data = db.load();
  const user = (data.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  user.permissions = req.body.permissions || [];
  db.save(data);
  res.json({ ok: true, permissions: user.permissions });
});

// 사용자 프로필 수정 (관리자)
app.post('/api/admin/users/:id/profile', requireAdmin, (req, res) => {
  const data = db.load();
  const user = (data.users || []).find(u => u.id === req.params.id);
  if (!user) return res.status(404).json({ error: '사용자 없음' });
  if (req.body.name !== undefined) user.name = req.body.name;
  if (req.body.position !== undefined) user.position = req.body.position;
  if (req.body.phone !== undefined) user.phone = req.body.phone;
  db.save(data);
  res.json({ ok: true });
});

// ── CSV 품목 캐시 (메모리) ──────────────────────────────
let csvCache = { list: [], loadedAt: 0 };

function parseEcountCsv(csvText) {
  const lines = csvText.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines.length < 3) return [];
  const items = [];
  for (let i = 2; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line || line.startsWith('"20')) continue;
    const cols = line.split('","').map(c => c.replace(/^"|"$/g, '').replace(/\t/g, '').trim());
    const code = cols[0];
    if (!code || code === 'A0000000000') continue;
    items.push({ PROD_CD: code, PROD_DES: cols[1] || code, SIZE_DES: cols[3] || '', GROUP_NM: cols[4] || '', USE_FLAG: (cols[6] || '').toUpperCase() === 'YES' });
  }
  return items;
}

const CSV_PATH = path.join(__dirname, 'data', 'ESA009M.csv');
if (fs.existsSync(CSV_PATH)) {
  csvCache.list = parseEcountCsv(fs.readFileSync(CSV_PATH, 'utf8'));
  csvCache.loadedAt = Date.now();
  console.log(`[시작] ✅ CSV에서 ${csvCache.list.length}개 품목 로드`);
}

app.post('/api/csv/upload', express.raw({ type: '*/*', limit: '50mb' }), (req, res) => {
  if (!req.body || req.body.length === 0) return res.status(400).json({ error: '파일 없음' });
  try {
    fs.writeFileSync(CSV_PATH, req.body);
    csvCache.list = parseEcountCsv(fs.readFileSync(CSV_PATH, 'utf8'));
    csvCache.loadedAt = Date.now();
    res.json({ ok: true, count: csvCache.list.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/csv/status', (req, res) => {
  res.json({ loaded: csvCache.list.length > 0, count: csvCache.list.length });
});

app.post('/api/csv/search', (req, res) => {
  const kw = (req.body.keyword || '').trim().toLowerCase();
  if (!kw) return res.json({ items: [], total: 0 });
  if (csvCache.list.length === 0) return res.status(400).json({ error: 'CSV 미로드' });
  const items = csvCache.list.filter(item =>
    (item.PROD_DES || '').toLowerCase().includes(kw) ||
    (item.PROD_CD || '').toLowerCase().includes(kw) ||
    (item.SIZE_DES || '').toLowerCase().includes(kw)
  ).slice(0, 200);
  res.json({ items, total: items.length, cacheTotal: csvCache.list.length });
});

// ── 이미지 업로드 (base64) ────────────────────────────────
app.post('/api/upload-image', (req, res) => {
  try {
    const { imageData, fileName } = req.body;
    if (!imageData) return res.status(400).json({ error: 'imageData required' });
    const imgDir = path.join(__dirname, 'data', 'images');
    if (!fs.existsSync(imgDir)) fs.mkdirSync(imgDir, { recursive: true });
    // base64에서 데이터 추출
    const matches = imageData.match(/^data:([^;]+);base64,(.+)$/);
    if (!matches) return res.status(400).json({ error: 'invalid base64 format' });
    const ext = matches[1].split('/')[1] || 'png';
    const buffer = Buffer.from(matches[2], 'base64');
    const safeName = (fileName || 'img').replace(/[^a-zA-Z0-9가-힣_-]/g, '_');
    const finalName = `${safeName}_${Date.now()}.${ext}`;
    fs.writeFileSync(path.join(imgDir, finalName), buffer);
    res.json({ url: `/data/images/${finalName}` });
  } catch(e) {
    console.error('이미지 업로드 실패:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── 카테고리 ────────────────────────────────────────────
app.get('/api/categories', (req, res) => res.json(db.load().categories));

app.post('/api/categories', (req, res) => {
  const data = db.load();
  const cat = {
    id: db.generateId('cat'), name: req.body.name || '', code: req.body.code || '',
    pricingType: req.body.pricingType || 'QTY', unit: req.body.unit || '개',
    tiers: req.body.tiers || [], qtyPrice: req.body.qtyPrice || 0, fixedPrice: req.body.fixedPrice || 0
  };
  data.categories.push(cat); db.save(data); res.json(cat);
});

app.put('/api/categories/:id', (req, res) => {
  const data = db.load();
  const idx = data.categories.findIndex(c => c.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.categories[idx] = { ...data.categories[idx], ...req.body, id: req.params.id };
  db.save(data); res.json(data.categories[idx]);
});

app.delete('/api/categories/:id', (req, res) => {
  const data = db.load();
  data.categories = data.categories.filter(c => c.id !== req.params.id);
  db.save(data); res.json({ ok: true });
});

// ── 옵션 관리 ────────────────────────────────────────────
app.get('/api/options', (req, res) => res.json(db.load().options || []));

app.post('/api/options', (req, res) => {
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

// 옵션 업체별 견적 추가
app.post('/api/options/:id/quotes', (req, res) => {
  const data = db.load();
  const opt = (data.options || []).find(o => o.id === req.params.id);
  if (!opt) return res.status(404).json({ error: 'not found' });
  if (!opt.quotes) opt.quotes = [];
  const q = { id: db.generateId('oq'), vendor: req.body.vendor || '', price: Number(req.body.price) || 0, quoteDate: req.body.quoteDate || new Date().toISOString().slice(0,10), note: req.body.note || '' };
  opt.quotes.push(q); db.save(data); res.json(opt);
});

// 옵션 업체별 견적 삭제
app.delete('/api/options/:id/quotes/:qid', (req, res) => {
  const data = db.load();
  const opt = (data.options || []).find(o => o.id === req.params.id);
  if (!opt) return res.status(404).json({ error: 'not found' });
  opt.quotes = (opt.quotes || []).filter(q => q.id !== req.params.qid);
  db.save(data); res.json(opt);
});

app.put('/api/options/:id', (req, res) => {
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

app.delete('/api/options/:id', (req, res) => {
  const data = db.load();
  if (!data.options) data.options = [];
  data.options = data.options.filter(o => o.id !== req.params.id);
  db.save(data); res.json({ ok: true });
});

// ── 업체 ─────────────────────────────────────────────────
app.get('/api/vendors', (req, res) => res.json(db.load().vendors));

app.post('/api/vendors', (req, res) => {
  const data = db.load();
  const v = { id: db.generateId('v'), name: req.body.name || '', bizNo: req.body.bizNo || '',
    ceo: req.body.ceo || '', phone: req.body.phone || '', email: req.body.email || '',
    address: req.body.address || '', note: req.body.note || '' };
  data.vendors.push(v); db.save(data); res.json(v);
});

app.put('/api/vendors/:id', (req, res) => {
  const data = db.load();
  const idx = data.vendors.findIndex(v => v.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.vendors[idx] = { ...data.vendors[idx], ...req.body, id: req.params.id };
  db.save(data); res.json(data.vendors[idx]);
});

app.delete('/api/vendors/:id', (req, res) => {
  const data = db.load();
  data.vendors = data.vendors.filter(v => v.id !== req.params.id);
  db.save(data); res.json({ ok: true });
});

// ── 업체별 단가 (vendorPrices) ───────────────────────────
// vendorPrices: [ { id, vendorId, categoryId, pricingType, tiers, qtyPrice, fixedPrice } ]

// 특정 업체의 모든 카테고리 단가 조회
app.get('/api/vendor-prices/:vendorId', (req, res) => {
  const data = db.load();
  if (!data.vendorPrices) data.vendorPrices = [];
  const vp = data.vendorPrices.filter(p => p.vendorId === req.params.vendorId);
  res.json(vp);
});

// 특정 업체 + 카테고리 단가 저장/수정 (upsert)
app.post('/api/vendor-prices', (req, res) => {
  const data = db.load();
  if (!data.vendorPrices) data.vendorPrices = [];
  const { vendorId, categoryId, tiers, widthTiers, qtyPrice, fixedPrice } = req.body;
  if (!vendorId || !categoryId) return res.status(400).json({ error: 'vendorId, categoryId 필요' });

  const existing = data.vendorPrices.findIndex(p => p.vendorId === vendorId && p.categoryId === categoryId);
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
  res.json(entry);
});

// 기본 단가를 업체 단가로 복사
app.post('/api/vendor-prices/:vendorId/copy-defaults', (req, res) => {
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
app.delete('/api/vendor-prices/:vendorId/:categoryId', (req, res) => {
  const data = db.load();
  if (!data.vendorPrices) data.vendorPrices = [];
  data.vendorPrices = data.vendorPrices.filter(p => !(p.vendorId === req.params.vendorId && p.categoryId === req.params.categoryId));
  db.save(data);
  res.json({ ok: true });
});

// ── 견적 계산 ────────────────────────────────────────────
// vendorId가 있으면 업체별 단가 우선, 없으면 기본 단가
app.post('/api/quote/calculate', (req, res) => {
  const data = db.load();
  const { categoryId, widthMm, heightMm, qty, optionSelections, vendorId } = req.body;
  const cat = data.categories.find(c => c.id === categoryId);
  if (!cat) return res.status(404).json({ error: '카테고리 없음' });

  // 업체별 단가 확인
  let pricing = cat; // 기본값은 카테고리 기본 단가
  if (vendorId && data.vendorPrices) {
    const vp = data.vendorPrices.find(p => p.vendorId === vendorId && p.categoryId === categoryId);
    if (vp) {
      pricing = { ...cat, tiers: vp.tiers, widthTiers: vp.widthTiers, qtyPrice: vp.qtyPrice, fixedPrice: vp.fixedPrice };
    }
  }

  const q = Math.max(1, Number(qty) || 1);
  let basePrice = 0, sqm = 0, matchedTier = null;
  let lengthM = 0, matchedWidthTier = null;

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
    // 폭별 m당 단가: widthTiers = [{ widthMm: 300, pricePerM: 5000 }, ...]
    const w = Number(widthMm) || 0, h = Number(heightMm) || 0;
    lengthM = h / 1000; // heightMm = 길이(가로)
    sqm = (w / 1000) * lengthM; // 참고용 면적
    const wTiers = (pricing.widthTiers || []).sort((a, b) => (Number(a.widthMm) || 0) - (Number(b.widthMm) || 0));
    // 비표준 폭: 올림 처리 (입력 폭 이상인 가장 가까운 티어)
    for (const t of wTiers) {
      if (w <= Number(t.widthMm)) { matchedWidthTier = t; break; }
    }
    // 최대 폭보다 크면 마지막 티어 적용
    if (!matchedWidthTier && wTiers.length > 0) matchedWidthTier = wTiers[wTiers.length - 1];
    const pricePerM = matchedWidthTier ? Number(matchedWidthTier.pricePerM) || 0 : 0;
    basePrice = lengthM * pricePerM * q;
  } else if (cat.pricingType === 'QTY') {
    basePrice = (Number(pricing.qtyPrice) || 0) * q;
  } else {
    basePrice = Number(pricing.fixedPrice) || 0;
  }

  let optionTotal = 0;
  const optionDetails = [];
  if (Array.isArray(optionSelections)) {
    for (const sel of optionSelections) {
      const opt = (data.options || []).find(o => o.id === sel.optionId);
      if (!opt) continue;
      const oQty = Math.max(1, Number(sel.qty) || 1);
      const optType = opt.pricingType || 'fixed';
      let oPrice = 0;
      let optLabel = opt.name;

      if (optType === 'perSqm') {
        // 면적(㎡) 기준 단가 — sqm은 위에서 이미 계산됨
        oPrice = Math.round(Number(opt.price) * sqm) * oQty;
        optLabel = `${opt.name}(${sqm.toFixed(2)}㎡)`;
      } else if (optType === 'variants' && Array.isArray(opt.variants) && sel.variantIdx !== undefined) {
        // 규격별 단가 — variantIdx로 선택된 규격의 단가 사용
        const variant = opt.variants[Number(sel.variantIdx)];
        if (variant) {
          oPrice = Number(variant.price) * oQty;
          optLabel = `${opt.name}(${variant.label})`;
        }
      } else {
        // fixed: 고정 단가
        oPrice = Number(opt.price) * oQty;
      }

      optionTotal += oPrice;
      optionDetails.push({ id: opt.id, name: optLabel, code: opt.code, unitPrice: Math.round(oPrice / oQty), qty: oQty, total: oPrice, unit: opt.unit });
    }
  }

  const totalExVat = Math.round(basePrice + optionTotal);
  const vat = Math.round(totalExVat * 0.1);

  const usingVendorPrice = !!(vendorId && data.vendorPrices && data.vendorPrices.find(p => p.vendorId === vendorId && p.categoryId === categoryId));

  res.json({
    sqm: Math.round(sqm * 10000) / 10000,
    pricePerSqm: matchedTier ? Number(matchedTier.pricePerSqm) : null,
    tierLabel: matchedTier ? `${matchedTier.areaMin || 0}~${matchedTier.areaMax || '∞'}㎡` : null,
    // LENGTH 타입 전용 정보
    lengthM: Math.round(lengthM * 1000) / 1000,
    pricePerM: matchedWidthTier ? Number(matchedWidthTier.pricePerM) : null,
    widthTierLabel: matchedWidthTier ? `${matchedWidthTier.widthMm}mm폭` : null,
    basePrice: Math.round(basePrice), optionTotal, optionDetails,
    totalExVat, vat, totalIncVat: totalExVat + vat,
    optionRemark: optionDetails.map(o => o.qty > 1 ? `${o.name} ${o.qty}${o.unit||'개'}` : o.name).join(', '),
    usingVendorPrice
  });
});

// ── 견적서 저장/목록/조회 ────────────────────────────────
app.get('/api/quotes', (req, res) => {
  const data = db.load();
  const quotes = (data.quotes || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  // 목록은 가볍게 (items 제외)
  res.json(quotes.map(q => ({
    id: q.id, siteName: q.siteName, quoteName: q.quoteName, vendorName: q.vendorName,
    manager: q.manager, createdBy: q.createdBy, createdAt: q.createdAt,
    totalAmount: q.totalAmount, itemCount: (q.items || []).length, status: q.status || 'draft'
  })));
});

app.get('/api/quotes/:id', (req, res) => {
  const data = db.load();
  const quote = (data.quotes || []).find(q => q.id === req.params.id);
  if (!quote) return res.status(404).json({ error: '견적서 없음' });
  res.json(quote);
});

app.post('/api/quotes', (req, res) => {
  const data = db.load();
  if (!data.quotes) data.quotes = [];

  // 로그인 사용자 정보
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const user = token ? sessions[token] : null;

  const quote = {
    id: db.generateId('q'),
    siteName: req.body.siteName || '',
    quoteName: req.body.quoteName || '',
    manager: req.body.manager || '',
    vendorManager: req.body.vendorManager || '',
    vendorId: req.body.vendorId || '',
    vendorName: req.body.vendorName || '',
    vendorBizNo: req.body.vendorBizNo || '',
    items: req.body.items || [],
    totalAmount: (req.body.items || []).reduce((sum, it) => sum + (it.amount || 0), 0),
    createdBy: user ? user.userId : (req.body.createdBy || ''),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    status: 'draft'
  };

  data.quotes.push(quote);
  db.save(data);
  res.json(quote);
});

app.put('/api/quotes/:id', (req, res) => {
  const data = db.load();
  if (!data.quotes) data.quotes = [];
  const idx = data.quotes.findIndex(q => q.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  data.quotes[idx] = { ...data.quotes[idx], ...req.body, id: req.params.id, updatedAt: new Date().toISOString() };
  if (req.body.items) {
    data.quotes[idx].totalAmount = req.body.items.reduce((sum, it) => sum + (it.amount || 0), 0);
  }
  db.save(data); res.json(data.quotes[idx]);
});

app.delete('/api/quotes/:id', (req, res) => {
  const data = db.load();
  if (!data.quotes) data.quotes = [];
  data.quotes = data.quotes.filter(q => q.id !== req.params.id);
  db.save(data); res.json({ ok: true });
});

// 견적 복사
app.post('/api/quotes/:id/copy', (req, res) => {
  const data = db.load();
  const src = (data.quotes || []).find(q => q.id === req.params.id);
  if (!src) return res.status(404).json({ error: 'not found' });
  const copied = { ...JSON.parse(JSON.stringify(src)), id: db.generateId('q'), siteName: '[복사] ' + src.siteName, status: 'draft', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), mailHistory: [] };
  data.quotes.push(copied); db.save(data); res.json(copied);
});

// 견적 상태 변경
app.post('/api/quotes/:id/status', (req, res) => {
  const data = db.load();
  const q = (data.quotes || []).find(q => q.id === req.params.id);
  if (!q) return res.status(404).json({ error: 'not found' });
  q.status = req.body.status; q.updatedAt = new Date().toISOString();
  if (req.body.status === 'won' && !q.wonAt) q.wonAt = new Date().toISOString();
  if (req.body.status === 'lost' && !q.lostAt) q.lostAt = new Date().toISOString();
  db.save(data); res.json(q);
});

// 통계
app.get('/api/stats', (req, res) => {
  const data = db.load();
  const quotes = data.quotes || [];
  // 월별 통계
  const byMonth = {};
  quotes.forEach(q => {
    const m = (q.createdAt || '').slice(0, 7);
    if (!byMonth[m]) byMonth[m] = { count: 0, amount: 0, won: 0, lost: 0 };
    byMonth[m].count++;
    byMonth[m].amount += q.totalAmount || 0;
    if (q.status === 'won') byMonth[m].won++;
    if (q.status === 'lost') byMonth[m].lost++;
  });
  // 거래처별 통계
  const byVendor = {};
  quotes.forEach(q => {
    const v = q.vendorName || '미지정';
    if (!byVendor[v]) byVendor[v] = { count: 0, amount: 0 };
    byVendor[v].count++; byVendor[v].amount += q.totalAmount || 0;
  });
  // 품목별 빈도
  const byCategory = {};
  quotes.forEach(q => (q.items || []).forEach(it => {
    const c = it.category || it.name || '기타';
    if (!byCategory[c]) byCategory[c] = 0;
    byCategory[c]++;
  }));
  // 상태 요약
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

// 명함 저장 (본인)
app.post('/api/me/namecard', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const data = db.load();
  const user = (data.users || []).find(u => u.userId === session.userId);
  if (!user) return res.status(404).json({ error: 'not found' });
  user.namecard = { mobile: req.body.mobile || '', tel: req.body.tel || '', fax: req.body.fax || '', email: req.body.email || '', dept: req.body.dept || '', tagline: req.body.tagline || '' };
  db.save(data); res.json({ ok: true });
});

// 내 명함 조회
app.get('/api/me/namecard', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const data = db.load();
  const user = (data.users || []).find(u => u.userId === session.userId);
  res.json(user ? (user.namecard || {}) : {});
});

// 명함 이미지 업로드 (base64)
app.post('/api/me/namecard-image', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const { image, mimeType } = req.body;
  if (!image) return res.status(400).json({ error: '이미지 없음' });
  // 사용자별 파일로 저장
  const ext = (mimeType || 'image/jpeg').includes('png') ? 'png' : 'jpg';
  const filename = `namecard_${session.userId}.${ext}`;
  const filepath = path.join(__dirname, 'data', filename);
  const base64Data = image.replace(/^data:image\/\w+;base64,/, '');
  fs.writeFileSync(filepath, Buffer.from(base64Data, 'base64'));
  // DB에 파일명 저장
  const data = db.load();
  const user = (data.users || []).find(u => u.userId === session.userId);
  if (user) { user.namecardImage = filename; db.save(data); }
  res.json({ ok: true, url: `/data/${filename}` });
});

// 명함 이미지 조회 URL
app.get('/api/me/namecard-image', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const data = db.load();
  const user = (data.users || []).find(u => u.userId === session.userId);
  if (user && user.namecardImage) {
    res.json({ url: `/data/${user.namecardImage}` });
  } else {
    res.json({ url: null });
  }
});

// 명함 이미지 삭제
app.delete('/api/me/namecard-image', (req, res) => {
  const cookies = parseCookies(req);
  const token = cookies.session_token || req.headers['x-session-token'];
  const session = token ? sessions[token] : null;
  if (!session) return res.status(401).json({ error: '로그인 필요' });
  const data = db.load();
  const user = (data.users || []).find(u => u.userId === session.userId);
  if (user && user.namecardImage) {
    const filepath = path.join(__dirname, 'data', user.namecardImage);
    if (fs.existsSync(filepath)) fs.unlinkSync(filepath);
    user.namecardImage = null;
    db.save(data);
  }
  res.json({ ok: true });
});

// ── 견적서 Excel 내보내기 (ZIP 직접 조작 — 도형/이미지 보존) ──
const JSZip = require('jszip');
const TEMPLATE_PATH = path.join(__dirname, 'data', 'template.xlsx');

async function generateQuoteExcel(quoteData) {
  const { siteName, quoteName, manager, vendorManager, quoteDate, items } = quoteData;
  const templateBuf = fs.readFileSync(TEMPLATE_PATH);
  const zip = await JSZip.loadAsync(templateBuf);

  // drawing1.xml — 남중석 제거 (대표이사 이정호만 표시)
  const drawFile = zip.file('xl/drawings/drawing1.xml');
  if (drawFile) {
    let drawXml = await drawFile.async('string');
    drawXml = drawXml.replace(/<a:r><a:rPr[^>]*>(?:<[^>]*>)*<\/a:rPr><a:t>,<\/a:t><\/a:r>/g, '');
    drawXml = drawXml.replace(/<a:r><a:rPr[^>]*>(?:<[^>]*>)*<\/a:rPr><a:t> 남 중 석<\/a:t><\/a:r>/g, '');
    zip.file('xl/drawings/drawing1.xml', drawXml);
  }

  // sharedStrings.xml 읽기 — 기존 문자열 목록
  let ssXml = await zip.file('xl/sharedStrings.xml').async('string');

  // 기존 shared strings 파싱
  const ssMatches = [...ssXml.matchAll(/<si>([\s\S]*?)<\/si>/g)];
  const sharedStrings = ssMatches.map(m => {
    const tMatch = m[1].match(/<t[^>]*>([^<]*)<\/t>/);
    return tMatch ? tMatch[1] : '';
  });

  // 새 shared string 추가 헬퍼
  function addSharedString(text) {
    const escaped = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    const idx = sharedStrings.length;
    sharedStrings.push(text);
    return idx;
  }

  // B4 현장명 (인덱스 41), B5 견적명 (인덱스 39), B6 담당자 (인덱스 40)
  const idxSiteName = addSharedString('현 장 명: ' + (siteName || ''));
  const idxQuoteName = addSharedString('견 적 명: ' + (quoteName || ''));
  const idxManager = addSharedString('담 당 자: ' + (manager || ''));
  const idxVendorMgr = addSharedString('담당자 : ' + (vendorManager || ''));

  // 품목 데이터용 shared strings
  const itemStrIndices = items.map(item => ({
    name: addSharedString(item.name || ''),
    spec: addSharedString(item.spec || ''),
    unit: addSharedString(item.unit || ''),
    remark: addSharedString(item.remark || '')
  }));

  // sheet1.xml 수정 (sharedStrings는 모든 인덱스 추가 후 아래에서 재생성)
  let sheetXml = await zip.file('xl/worksheets/sheet1.xml').async('string');

  // B4 현장명 교체 (원래 인덱스 41)
  sheetXml = sheetXml.replace(
    /(<c r="B4"[^>]*t="s"[^>]*><v>)\d+(<\/v><\/c>)/,
    `$1${idxSiteName}$2`
  );
  // B5 견적명 (원래 인덱스 39)
  sheetXml = sheetXml.replace(
    /(<c r="B5"[^>]*t="s"[^>]*><v>)\d+(<\/v><\/c>)/,
    `$1${idxQuoteName}$2`
  );
  // B6 담당자 (원래 인덱스 40)
  sheetXml = sheetXml.replace(
    /(<c r="B6"[^>]*t="s"[^>]*><v>)\d+(<\/v><\/c>)/,
    `$1${idxManager}$2`
  );
  // G8 담당자 (원래 인덱스 21)
  sheetXml = sheetXml.replace(
    /(<c r="G8"[^>]*t="s"[^>]*><v>)\d+(<\/v><\/c>)/,
    `$1${idxVendorMgr}$2`
  );

  // B8 견적일 — 수식 제거하고 직접 텍스트로
  const dateStr = quoteDate || new Date().toISOString().slice(0, 10);
  const formattedDate = '견적일:' + dateStr.replace(/-/g, '.');
  const idxDate = addSharedString(formattedDate);
  // sharedStrings 재생성은 아래에서 하므로 여기서는 인덱스만 확보
  sheetXml = sheetXml.replace(
    /<c r="B8"[^>]*>[\s\S]*?<\/c>/,
    `<c r="B8" s="42" t="s"><v>${idxDate}</v></c>`
  );

  // sharedStrings.xml 재생성 (날짜 포함)
  const newSiEntries2 = sharedStrings.map(s => {
    const escaped = s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
    return `<si><t>${escaped}</t></si>`;
  });
  ssXml = ssXml.replace(
    /<sst[^>]*>[\s\S]*<\/sst>/,
    `<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">${newSiEntries2.join('')}</sst>`
  );
  zip.file('xl/sharedStrings.xml', ssXml);

  // 데이터 행 11~34 채우기
  const DATA_START = 11;
  const DATA_END = 34;
  const itemCount = Math.min(items.length, DATA_END - DATA_START + 1); // 최대 24개

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
      // 빈 행
      const emptyRow = `<row r="${rowNum}" spans="2:9" ht="19.5" customHeight="1" x14ac:dyDescent="0.15">` +
        `<c r="B${rowNum}" s="21"/><c r="C${rowNum}" s="21"/><c r="D${rowNum}" s="21"/>` +
        `<c r="E${rowNum}" s="21"/><c r="F${rowNum}" s="23"/><c r="G${rowNum}" s="22"/>` +
        `<c r="H${rowNum}" s="22"/><c r="I${rowNum}" s="21"/>` +
        `</row>`;
      sheetXml = sheetXml.replace(rowRegex, emptyRow);
    }
  }

  // H35 합계 수식 업데이트
  const lastDataRow = DATA_START + itemCount - 1;
  sheetXml = sheetXml.replace(
    /(<c r="H35"[^>]*>)<f>[^<]*<\/f><v>[^<]*<\/v>/,
    `$1<f>SUM(H${DATA_START}:H${lastDataRow})</f><v>${items.slice(0, itemCount).reduce((s, it) => s + (it.qty || 0) * (it.unitPrice || 0), 0)}</v>`
  );

  // B7 합계 참조도 업데이트 (=H35 이미 수식이라 값만 갱신)
  const total = items.slice(0, itemCount).reduce((s, it) => s + (it.qty || 0) * (it.unitPrice || 0), 0);
  sheetXml = sheetXml.replace(
    /(<c r="B7"[^>]*>)<f>[^<]*<\/f><v>[^<]*<\/v>/,
    `$1<f>H35</f><v>${total}</v>`
  );

  zip.file('xl/worksheets/sheet1.xml', sheetXml);

  // Buffer로 반환
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

app.post('/api/quote/export', async (req, res) => {
  try {
    const { items } = req.body;
    if (!items || !items.length) return res.status(400).json({ error: '품목이 없습니다' });

    const buffer = await generateQuoteExcel(req.body);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    const filename = (req.body.siteName || 'quote') + '_' + new Date().toISOString().slice(0,10) + '.xlsx';
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
    res.send(buffer);
  } catch (e) {
    console.error('견적서 오류:', e);
    res.status(500).json({ error: e.message });
  }
});

// ── 네이버 SMTP 메일 발송 ────────────────────────────────
// nodemailer 없이 직접 SMTP 구현
function sendSmtpMail({ smtpHost, smtpPort, smtpUser, smtpPass, from, to, subject, html, attachments }) {
  return new Promise((resolve, reject) => {
    const useSSL = (smtpPort === 465);

    function handleSmtp(socket) {
      let step = useSSL ? 'connect' : 'greeting';
      let buffer = '';

      socket.on('data', (data) => {
        buffer += data.toString();
        if (!buffer.includes('\r\n')) return;
        const lines = buffer.split('\r\n');
        buffer = lines.pop();

        for (const line of lines) {
          const code = parseInt(line.substring(0, 3));

          if (step === 'greeting' && code === 220) {
            // 587: 평문 접속 후 EHLO
            socket.write('EHLO localhost\r\n'); step = 'ehlo_starttls';
          } else if (step === 'ehlo_starttls' && code === 250) {
            if (line.startsWith('250 ')) {
              // STARTTLS 요청
              socket.write('STARTTLS\r\n'); step = 'starttls';
            }
          } else if (step === 'starttls' && code === 220) {
            // TLS 업그레이드
            const tlsSocket = tls.connect({ socket, host: smtpHost, rejectUnauthorized: false }, () => {
              tlsSocket.write('EHLO localhost\r\n');
            });
            // 새 TLS 소켓으로 교체하여 이벤트 재등록
            step = 'ehlo';
            let tlsBuf = '';
            tlsSocket.on('data', (d) => {
              tlsBuf += d.toString();
              if (!tlsBuf.includes('\r\n')) return;
              const tlines = tlsBuf.split('\r\n');
              tlsBuf = tlines.pop();
              for (const tl of tlines) processLine(tl, tlsSocket);
            });
            tlsSocket.on('error', reject);
            tlsSocket.on('timeout', () => reject(new Error('SMTP 타임아웃')));
            tlsSocket.setTimeout(30000);
            return; // 기존 소켓 이벤트 종료
          } else {
            processLine(line, socket);
            continue;
          }

          // 공통 처리가 아닌 경우 skip
          continue;
        }
      });

      function processLine(line, sock) {
        const code = parseInt(line.substring(0, 3));
        if (step === 'connect' && code === 220) {
          sock.write('EHLO localhost\r\n'); step = 'ehlo';
        } else if (step === 'ehlo' && code === 250) {
          if (line.startsWith('250 ')) {
            const auth = Buffer.from(`\0${smtpUser}\0${smtpPass}`).toString('base64');
            sock.write(`AUTH PLAIN ${auth}\r\n`); step = 'auth';
          }
        } else if (step === 'auth' && code === 235) {
          sock.write(`MAIL FROM:<${from}>\r\n`); step = 'from';
        } else if (step === 'from' && code === 250) {
          sock.write(`RCPT TO:<${to}>\r\n`); step = 'rcpt';
        } else if (step === 'rcpt' && code === 250) {
          sock.write('DATA\r\n'); step = 'data';
        } else if (step === 'data' && code === 354) {
          const boundary = 'BOUNDARY_' + crypto.randomBytes(16).toString('hex');
          let msg = '';
          msg += `From: ${from}\r\n`;
          msg += `To: ${to}\r\n`;
          msg += `Subject: =?UTF-8?B?${Buffer.from(subject).toString('base64')}?=\r\n`;
          msg += `MIME-Version: 1.0\r\n`;
          msg += `Content-Type: multipart/mixed; boundary="${boundary}"\r\n\r\n`;
          msg += `--${boundary}\r\n`;
          msg += `Content-Type: text/html; charset=UTF-8\r\n\r\n`;
          msg += html + '\r\n';

          if (attachments && attachments.length > 0) {
            for (const att of attachments) {
              msg += `--${boundary}\r\n`;
              msg += `Content-Type: ${att.contentType || 'application/octet-stream'}; name="${att.filename}"\r\n`;
              msg += `Content-Disposition: attachment; filename="=?UTF-8?B?${Buffer.from(att.filename).toString('base64')}?="\r\n`;
              msg += `Content-Transfer-Encoding: base64\r\n\r\n`;
              msg += att.content.toString('base64').replace(/(.{76})/g, '$1\r\n') + '\r\n';
            }
          }
          msg += `--${boundary}--\r\n`;
          msg += '\r\n.\r\n';
          sock.write(msg); step = 'sent';
        } else if (step === 'sent' && code === 250) {
          sock.write('QUIT\r\n'); step = 'quit';
          resolve({ ok: true, message: '메일 발송 완료' });
        } else if (code >= 400) {
          sock.write('QUIT\r\n');
          reject(new Error(`SMTP 오류 (${code}): ${line}`));
        }
      }

      socket.on('error', reject);
      socket.on('timeout', () => reject(new Error('SMTP 타임아웃')));
      socket.setTimeout(30000);
    }

    if (useSSL) {
      // 465: 직접 SSL 접속
      const socket = tls.connect(smtpPort, smtpHost, { rejectUnauthorized: false }, () => {
        handleSmtp(socket);
      });
    } else {
      // 587: 평문 접속 후 STARTTLS
      const net = require('net');
      const socket = net.connect(smtpPort, smtpHost, () => {
        handleSmtp(socket);
      });
    }
  });
}

// SMTP 설정 저장
app.get('/api/mail/settings', (req, res) => {
  try {
    const settingsPath = path.join(__dirname, 'data', 'settings.json');
    if (!fs.existsSync(settingsPath)) return res.json({});
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // 비밀번호는 마스킹
    if (settings.smtp && settings.smtp.pass) {
      settings.smtp.pass = '****';
    }
    res.json(settings);
  } catch (e) { res.json({}); }
});

app.post('/api/mail/settings', (req, res) => {
  try {
    const settingsPath = path.join(__dirname, 'data', 'settings.json');
    let settings = {};
    if (fs.existsSync(settingsPath)) settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    settings.smtp = {
      host: req.body.host || 'smtp.naver.com',
      port: Number(req.body.port) || 465,
      user: req.body.user || '',
      pass: req.body.pass === '****' ? (settings.smtp?.pass || '') : (req.body.pass || ''),
      from: req.body.from || req.body.user || ''
    };
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 견적서 메일 발송
app.post('/api/mail/send', async (req, res) => {
  try {
    const { quoteId, toEmail, subject, message } = req.body;
    if (!toEmail) return res.status(400).json({ error: '수신 이메일을 입력해주세요' });

    // SMTP 설정 로드
    const settingsPath = path.join(__dirname, 'data', 'settings.json');
    if (!fs.existsSync(settingsPath)) return res.status(400).json({ error: 'SMTP 설정을 먼저 해주세요' });
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    if (!settings.smtp || !settings.smtp.user || !settings.smtp.pass) {
      return res.status(400).json({ error: 'SMTP 설정이 완료되지 않았습니다 (설정 탭에서 메일 설정)' });
    }

    // 견적서 데이터 (quoteId가 있으면 DB에서, 없으면 body에서)
    let quoteData = req.body.quoteData;
    const cookies2 = parseCookies(req);
    const token2 = cookies2.session_token || req.headers['x-session-token'];
    const senderSession = token2 ? sessions[token2] : null;
    let senderInfo = null;
    if (senderSession) {
      const dbData = db.load();
      const senderUser = (dbData.users || []).find(u => u.userId === senderSession.userId);
      if (senderUser) senderInfo = { name: senderUser.name, position: senderUser.position || '', phone: senderUser.phone || '', namecard: senderUser.namecard || {}, namecardImage: senderUser.namecardImage || null };
    }
    if (quoteId) {
      const data = db.load();
      const quote = (data.quotes || []).find(q => q.id === quoteId);
      if (!quote) return res.status(404).json({ error: '견적서를 찾을 수 없습니다' });
      quoteData = quote;
    }
    if (!quoteData || !quoteData.items || !quoteData.items.length) {
      return res.status(400).json({ error: '견적서 데이터가 없습니다' });
    }

    const supplyTotal = quoteData.items.reduce((s, it) => s + ((it.qty || 0) * (it.unitPrice || 0)), 0);
    const vatAmount = Math.round(supplyTotal * 0.1);
    const grandTotal = supplyTotal + vatAmount;

    // 명함 이미지 경로
    let namecardImgPath = null;
    if (senderInfo && senderInfo.namecardImage) {
      const imgPath = path.join(__dirname, 'data', senderInfo.namecardImage);
      if (fs.existsSync(imgPath)) namecardImgPath = imgPath;
    }

    // PDF 견적서 생성
    const pdfBuffer = await generateQuotePdf(quoteData, namecardImgPath);
    const pdfFilename = `견적서_${(quoteData.siteName || '').replace(/[^가-힣a-zA-Z0-9]/g,'_')}_${quoteData.quoteDate || new Date().toISOString().slice(0,10)}.pdf`;

    // 명함 HTML (이메일 서명용)
    const nc = senderInfo ? senderInfo.namecard : {};
    let namecardHtml = '';
    if (senderInfo && senderInfo.namecardImage && namecardImgPath) {
      const imgExt = senderInfo.namecardImage.endsWith('.png') ? 'png' : 'jpeg';
      const imgBase64 = fs.readFileSync(namecardImgPath).toString('base64');
      namecardHtml = `<div style="margin-top:20px;"><img src="data:image/${imgExt};base64,${imgBase64}" style="max-width:280px;border-radius:4px;border:1px solid #e2e8f0;" alt="명함"></div>`;
    } else if (senderInfo) {
      namecardHtml = `<div style="margin-top:20px;padding-top:16px;border-top:1px solid #e5e7eb;">
        <table style="border-collapse:collapse;font-size:11px;color:#4b5563;line-height:1.7;">
          <tr><td style="font-weight:700;color:#1a1a1a;font-size:12px;padding-bottom:2px;">${escHtml(senderInfo.name)}${senderInfo.position ? ' | ' + escHtml(senderInfo.position) : ''}</td></tr>
          ${senderInfo.phone ? `<tr><td>T. ${escHtml(senderInfo.phone)}${nc.mobile ? ' | M. ' + escHtml(nc.mobile) : ''}</td></tr>` : ''}
          ${nc.email ? `<tr><td style="color:#0284c7;">${escHtml(nc.email)}</td></tr>` : ''}
          <tr><td style="font-size:10px;color:#9ca3af;">(주)대림에스엠 | 서울 구로구 경인로 393-7</td></tr>
        </table>
      </div>`;
    }

    // 이메일 HTML — 심플 텍스트 + 명함 서명
    const defaultMsg = '안녕하세요.\n\n견적서를 보내드립니다.\n첨부파일 확인 부탁드립니다.\n\n감사합니다.';
    const html = `<!DOCTYPE html><html><body style="margin:0;padding:0;font-family:'Malgun Gothic','맑은 고딕',Arial,sans-serif;">
      <div style="max-width:600px;padding:10px 0;">
        <div style="font-size:14px;color:#222;line-height:2.0;">
          ${(message || defaultMsg).replace(/\n/g, '<br>')}
        </div>
        ${namecardHtml}
      </div>
    </body></html>`;

    await sendSmtpMail({
      smtpHost: settings.smtp.host,
      smtpPort: settings.smtp.port,
      smtpUser: settings.smtp.user,
      smtpPass: settings.smtp.pass,
      from: settings.smtp.from || settings.smtp.user,
      to: toEmail,
      subject: subject || `[견적서] ${quoteData.siteName || ''} - ${quoteData.quoteName || ''}`,
      html,
      attachments: [{
        filename: pdfFilename,
        contentType: 'application/pdf',
        content: pdfBuffer
      }]
    });

    // 발송 기록 저장
    if (quoteId) {
      const data = db.load();
      const quote = (data.quotes || []).find(q => q.id === quoteId);
      if (quote) {
        if (!quote.mailHistory) quote.mailHistory = [];
        const cookies = parseCookies(req);
        const token = cookies.session_token;
        const user = token ? sessions[token] : null;
        quote.mailHistory.push({ to: toEmail, sentAt: new Date().toISOString(), sentBy: user ? user.userId : '' });
        quote.status = 'sent';
        db.save(data);
      }
    }

    res.json({ ok: true, message: `${toEmail}로 발송 완료` });
  } catch (e) {
    console.error('메일 발송 오류:', e);
    res.status(500).json({ error: '메일 발송 실패: ' + e.message });
  }
});

// ── 백업 ─────────────────────────────────────────────────
app.get('/api/export', (req, res) => {
  res.setHeader('Content-Disposition', 'attachment; filename="price-backup.json"');
  res.json(db.load());
});

app.post('/api/import', (req, res) => {
  try {
    if (!req.body.categories) throw new Error('형식 오류');
    db.save(req.body); res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: e.message }); }
});

// ══════════════════════════════════════════════════════════
// ── 전화번호부 (3단계: 업체 → 프로젝트 → 연락처) ──────
// ══════════════════════════════════════════════════════════

// 마이그레이션: 서버 시작 시 한 번 실행
// flat contact 데이터(company, note 문자열)를 3단 구조(contactCompanies, contactProjects)로 변환
function migrateContactsData() {
  const data = db.load();
  const contacts = data.contacts || [];

  // contactCompanies가 이미 있고 내용이 있으면 skip
  if (data.contactCompanies && data.contactCompanies.length > 0) {
    return;
  }

  // 1) 기존 contactSites -> contactProjects 변환 (레거시)
  if (data.contactSites && Array.isArray(data.contactSites)) {
    const defaultCompany = {
      id: 'comp_' + Date.now(),
      name: '기본 업체',
      note: '',
      createdAt: new Date().toISOString()
    };
    data.contactCompanies = [defaultCompany];
    data.contactProjects = data.contactSites.map(site => ({
      id: site.id,
      companyId: defaultCompany.id,
      name: site.name,
      address: site.address || '',
      note: site.note || '',
      createdAt: site.createdAt || new Date().toISOString(),
      customFields: site.customFields || []
    }));
    contacts.forEach(c => {
      if (c.siteId && !c.projectId) c.projectId = c.siteId;
    });
    db.save(data);
    return;
  }

  // 2) flat contact 데이터에서 company/note 기반 자동 마이그레이션
  console.log('[migrate] flat contacts → 3단 구조 시작');
  const companyMap = {}; // companyName → company obj
  const projectMap = {}; // companyId + projectName → project obj

  if (!data.contactCompanies) data.contactCompanies = [];
  if (!data.contactProjects) data.contactProjects = [];

  contacts.forEach(c => {
    const compName = (c.company || '').trim();
    if (!compName) return;

    // 업체 생성
    if (!companyMap[compName]) {
      const comp = {
        id: 'comp_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        name: compName,
        note: '',
        createdAt: new Date().toISOString()
      };
      companyMap[compName] = comp;
      data.contactCompanies.push(comp);
    }
    const comp = companyMap[compName];
    c.companyId = comp.id;

    // 현장(note) 생성
    const siteName = (c.note || '').trim();
    if (siteName) {
      const pKey = comp.id + '::' + siteName;
      if (!projectMap[pKey]) {
        const proj = {
          id: 'proj_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          companyId: comp.id,
          name: siteName,
          address: '',
          note: '',
          createdAt: new Date().toISOString(),
          customFields: []
        };
        projectMap[pKey] = proj;
        data.contactProjects.push(proj);
      }
      c.projectId = projectMap[comp.id + '::' + siteName].id;
    }
  });

  db.save(data);
  console.log('[migrate] 완료: 업체 ' + data.contactCompanies.length + '개, 현장 ' + data.contactProjects.length + '개');
}

// 업체 API
app.get('/api/contacts/companies', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const companies = data.contactCompanies || [];
  const projects = data.contactProjects || [];

  // 각 업체의 프로젝트 수 포함
  const result = companies.map(comp => ({
    ...comp,
    projectCount: projects.filter(p => p.companyId === comp.id).length
  }));

  res.json(result);
});

app.post('/api/contacts/companies', requireAuth, (req, res) => {
  const data = db.loadContacts();
  if (!data.contactCompanies) data.contactCompanies = [];

  const company = {
    id: 'comp_' + Date.now(),
    name: req.body.name || '',
    note: req.body.note || '',
    createdAt: new Date().toISOString()
  };

  data.contactCompanies.push(company);
  db.saveContacts(data);
  res.json(company);
});

app.put('/api/contacts/companies/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const company = (data.contactCompanies || []).find(c => c.id === req.params.id);
  if (!company) return res.status(404).json({ error: '업체 없음' });

  if (req.body.name !== undefined) company.name = req.body.name;
  if (req.body.note !== undefined) company.note = req.body.note;
  if (req.body.order !== undefined) company.order = req.body.order;

  db.saveContacts(data);
  res.json(company);
});

app.delete('/api/contacts/companies/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();

  // 해당 업체의 모든 프로젝트 삭제
  const projectIds = (data.contactProjects || [])
    .filter(p => p.companyId === req.params.id)
    .map(p => p.id);

  data.contactProjects = (data.contactProjects || []).filter(p => p.companyId !== req.params.id);

  // 해당 프로젝트의 모든 연락처 삭제
  data.contacts = (data.contacts || []).filter(c => !projectIds.includes(c.projectId));

  // 업체 삭제
  data.contactCompanies = (data.contactCompanies || []).filter(c => c.id !== req.params.id);

  db.saveContacts(data);
  res.json({ ok: true });
});

// 프로젝트 API
app.get('/api/contacts/projects', requireAuth, (req, res) => {
  const data = db.loadContacts();
  let projects = data.contactProjects || [];

  if (req.query.companyId) {
    projects = projects.filter(p => p.companyId === req.query.companyId);
  }

  // 각 프로젝트의 연락처 수 포함
  const contacts = data.contacts || [];
  const result = projects.map(proj => ({
    ...proj,
    contactCount: contacts.filter(c => c.projectId === proj.id).length
  }));

  res.json(result);
});

app.post('/api/contacts/projects', requireAuth, (req, res) => {
  const data = db.loadContacts();
  if (!data.contactProjects) data.contactProjects = [];

  const project = {
    id: 'proj_' + Date.now(),
    companyId: req.body.companyId || '',
    name: req.body.name || '',
    address: req.body.address || '',
    note: req.body.note || '',
    createdAt: new Date().toISOString(),
    customFields: []
  };

  data.contactProjects.push(project);
  db.saveContacts(data);
  res.json(project);
});

app.put('/api/contacts/projects/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const project = (data.contactProjects || []).find(p => p.id === req.params.id);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  if (req.body.name !== undefined) project.name = req.body.name;
  if (req.body.address !== undefined) project.address = req.body.address;
  if (req.body.note !== undefined) project.note = req.body.note;
  if (req.body.order !== undefined) project.order = req.body.order;

  db.saveContacts(data);
  res.json(project);
});

app.delete('/api/contacts/projects/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();

  // 해당 프로젝트의 모든 연락처 삭제
  data.contacts = (data.contacts || []).filter(c => c.projectId !== req.params.id);

  // 프로젝트 삭제
  data.contactProjects = (data.contactProjects || []).filter(p => p.id !== req.params.id);

  db.saveContacts(data);
  res.json({ ok: true });
});

// 전체 연락처 조회 (플랫 구조, 검색+업체필터)
app.get('/api/contacts/all', requireAuth, (req, res) => {
  const data = db.loadContacts();
  let contacts = data.contacts || [];

  // 업체 필터
  if (req.query.company) {
    const comp = req.query.company;
    contacts = contacts.filter(c => (c.company || '') === comp);
  }

  // 검색 (현장명 note 포함)
  if (req.query.q) {
    const kw = req.query.q.toLowerCase();
    contacts = contacts.filter(c =>
      (c.name || '').toLowerCase().includes(kw) ||
      (c.company || '').toLowerCase().includes(kw) ||
      (c.position || '').toLowerCase().includes(kw) ||
      (c.phone || '').includes(kw) ||
      (c.mobile || '').includes(kw) ||
      (c.email || '').toLowerCase().includes(kw) ||
      (c.note || '').toLowerCase().includes(kw)
    );
  }

  // 최신순 정렬
  contacts.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  res.json(contacts);
});

// 3단 구조 전체 조회 (업체 > 현장 > 연락처) - 트리형태
app.get('/api/contacts/tree', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const companies = data.contactCompanies || [];
  const projects = data.contactProjects || [];
  let contacts = data.contacts || [];

  // 검색 필터
  const q = (req.query.q || '').trim().toLowerCase();

  // 업체별 프로젝트 맵
  const projByCompany = {};
  projects.forEach(p => {
    if (!projByCompany[p.companyId]) projByCompany[p.companyId] = [];
    projByCompany[p.companyId].push(p);
  });

  // 프로젝트별 연락처 맵
  const contactByProject = {};
  const contactNoProject = {}; // companyId 있지만 projectId 없는 연락처
  const contactOrphan = []; // companyId도 없는 연락처

  contacts.forEach(c => {
    if (q) {
      const match =
        (c.name || '').toLowerCase().includes(q) ||
        (c.company || '').toLowerCase().includes(q) ||
        (c.position || '').toLowerCase().includes(q) ||
        (c.phone || '').includes(q) ||
        (c.mobile || '').includes(q) ||
        (c.email || '').toLowerCase().includes(q) ||
        (c.note || '').toLowerCase().includes(q);
      if (!match) return;
    }

    if (c.projectId) {
      if (!contactByProject[c.projectId]) contactByProject[c.projectId] = [];
      contactByProject[c.projectId].push(c);
    } else if (c.companyId) {
      if (!contactNoProject[c.companyId]) contactNoProject[c.companyId] = [];
      contactNoProject[c.companyId].push(c);
    } else if (c.company) {
      // companyId 없지만 company 문자열 있는 경우 — 매칭 시도
      const matched = companies.find(comp => comp.name === c.company);
      if (matched) {
        if (!contactNoProject[matched.id]) contactNoProject[matched.id] = [];
        contactNoProject[matched.id].push(c);
      } else {
        contactOrphan.push(c);
      }
    } else {
      contactOrphan.push(c);
    }
  });

  // 검색 시 현장명도 매치
  if (q) {
    projects.forEach(p => {
      if ((p.name || '').toLowerCase().includes(q) || (p.address || '').toLowerCase().includes(q)) {
        // 이 현장에 속한 모든 연락처 포함
        const allInProj = contacts.filter(c => c.projectId === p.id);
        allInProj.forEach(c => {
          if (!contactByProject[p.id]) contactByProject[p.id] = [];
          if (!contactByProject[p.id].find(x => x.id === c.id)) {
            contactByProject[p.id].push(c);
          }
        });
      }
    });
  }

  // 트리 구성
  const tree = companies.map(comp => {
    const compProjects = (projByCompany[comp.id] || []).map(proj => ({
      ...proj,
      contacts: contactByProject[proj.id] || []
    }));
    // 검색 시 연락처/현장 없는 업체 제외
    const noProjectContacts = contactNoProject[comp.id] || [];
    const hasContent = compProjects.some(p => p.contacts.length > 0) || noProjectContacts.length > 0;
    if (q && !hasContent && !(comp.name || '').toLowerCase().includes(q)) return null;

    return {
      ...comp,
      projects: compProjects,
      directContacts: noProjectContacts // 현장 미배정 연락처
    };
  }).filter(Boolean);

  // 미분류 연락처
  if (contactOrphan.length > 0) {
    tree.push({
      id: '_orphan',
      name: '미분류',
      note: '',
      projects: [],
      directContacts: contactOrphan
    });
  }

  res.json(tree);
});

// 연락처 CRUD (projectId 기반, 하위 호환성: siteId도 지원)
app.get('/api/contacts', requireAuth, (req, res) => {
  const data = db.loadContacts();
  let contacts = data.contacts || [];

  // projectId 또는 siteId로 필터링 (하위 호환성)
  if (req.query.projectId) {
    contacts = contacts.filter(c => c.projectId === req.query.projectId);
  } else if (req.query.siteId) {
    contacts = contacts.filter(c => c.projectId === req.query.siteId);
  }

  // 검색
  if (req.query.q) {
    const kw = req.query.q.toLowerCase();
    contacts = contacts.filter(c =>
      (c.name || '').toLowerCase().includes(kw) ||
      (c.company || '').toLowerCase().includes(kw) ||
      (c.position || '').toLowerCase().includes(kw) ||
      (c.phone || '').includes(kw) ||
      (c.mobile || '').includes(kw)
    );
  }

  res.json(contacts);
});

app.post('/api/contacts', requireAuth, (req, res) => {
  const data = db.loadContacts();
  if (!data.contacts) data.contacts = [];

  // projectId 또는 siteId 받음 (하위 호환성)
  const projectId = req.body.projectId || req.body.siteId || '';

  const contact = {
    id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    projectId: projectId,
    siteId: projectId,  // 하위 호환성
    name: req.body.name || '',
    company: req.body.company || '',
    position: req.body.position || '',
    dept: req.body.dept || '',
    phone: req.body.phone || '',
    mobile: req.body.mobile || '',
    email: req.body.email || '',
    note: req.body.note || '',
    customFields: req.body.customFields || {},
    createdAt: new Date().toISOString(),
    createdBy: req.authUser?.userId || ''
  };

  data.contacts.push(contact);
  db.saveContacts(data);
  res.json(contact);
});

app.put('/api/contacts/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const c = (data.contacts || []).find(x => x.id === req.params.id);
  if (!c) return res.status(404).json({ error: '연락처 없음' });

  const updateFields = ['name','company','position','dept','phone','mobile','email','note','projectId','siteId'];
  for (const key of updateFields) {
    if (req.body[key] !== undefined) {
      c[key] = req.body[key];
      // projectId 변경 시 siteId도 동기화
      if (key === 'projectId') c.siteId = req.body[key];
      if (key === 'siteId') c.projectId = req.body[key];
    }
  }

  // 커스텀 필드
  if (req.body.customFields !== undefined) {
    c.customFields = req.body.customFields;
  }

  db.saveContacts(data);
  res.json(c);
});

app.delete('/api/contacts/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  data.contacts = (data.contacts || []).filter(c => c.id !== req.params.id);
  db.saveContacts(data);
  res.json({ ok: true });
});

// 연락처 복사 (다른 프로젝트로)
app.post('/api/contacts/copy', requireAuth, (req, res) => {
  const { contactIds, targetProjectId, targetSiteId } = req.body;
  const projId = targetProjectId || targetSiteId;

  if (!contactIds || !projId) return res.status(400).json({ error: '필수 값 누락' });

  const data = db.loadContacts();
  if (!data.contacts) data.contacts = [];

  const copied = [];
  for (const cid of contactIds) {
    const orig = data.contacts.find(c => c.id === cid);
    if (!orig) continue;

    const newC = {
      ...orig,
      id: 'c_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
      projectId: projId,
      siteId: projId,
      createdAt: new Date().toISOString(),
      createdBy: req.authUser?.userId || ''
    };

    data.contacts.push(newC);
    copied.push(newC);
  }

  db.saveContacts(data);
  res.json({ ok: true, copied: copied.length });
});

// 통합 검색 API (전체 연락처 검색 + 업체/프로젝트 정보 포함)
app.get('/api/contacts/search', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const q = (req.query.q || '').toLowerCase();

  if (!q) return res.json([]);

  const contacts = data.contacts || [];
  const projects = data.contactProjects || [];
  const companies = data.contactCompanies || [];

  // 프로젝트/회사 맵 만들기
  const projectMap = {};
  projects.forEach(p => { projectMap[p.id] = p; });

  const companyMap = {};
  companies.forEach(c => { companyMap[c.id] = c; });

  // 검색
  const results = contacts.filter(c =>
    (c.name || '').toLowerCase().includes(q) ||
    (c.company || '').toLowerCase().includes(q) ||
    (c.position || '').toLowerCase().includes(q) ||
    (c.phone || '').includes(q) ||
    (c.mobile || '').includes(q) ||
    (c.email || '').toLowerCase().includes(q)
  ).map(c => {
    const proj = projectMap[c.projectId];
    const comp = proj ? companyMap[proj.companyId] : null;

    return {
      ...c,
      projectName: proj ? proj.name : '',
      companyName: comp ? comp.name : ''
    };
  });

  res.json(results);
});

// 커스텀 필드 관리 (프로젝트별)
app.get('/api/contacts/projects/:projectId/fields', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const project = (data.contactProjects || []).find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  const fields = project.customFields || [];
  res.json(fields);
});

app.post('/api/contacts/projects/:projectId/fields', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const project = (data.contactProjects || []).find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  if (!project.customFields) project.customFields = [];

  const field = {
    id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    name: req.body.name || '',
    type: req.body.type || 'text',
    options: req.body.options || []
  };

  project.customFields.push(field);
  db.saveContacts(data);
  res.json(field);
});

app.delete('/api/contacts/projects/:projectId/fields/:fieldId', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const project = (data.contactProjects || []).find(p => p.id === req.params.projectId);
  if (!project) return res.status(404).json({ error: '프로젝트 없음' });

  project.customFields = (project.customFields || []).filter(f => f.id !== req.params.fieldId);

  // 연락처에서 해당 필드 데이터 제거
  (data.contacts || []).forEach(c => {
    if (c.projectId === req.params.projectId && c.customFields) {
      delete c.customFields[req.params.fieldId];
    }
  });

  db.saveContacts(data);
  res.json({ ok: true });
});

// 하위 호환성: 이전 sites API도 유지 (실제로는 projects 사용)
app.get('/api/contacts/sites', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const sites = data.contactProjects || [];
  res.json(sites);
});

app.post('/api/contacts/sites', requireAuth, (req, res) => {
  const data = db.loadContacts();
  if (!data.contactProjects) data.contactProjects = [];
  if (!data.contactCompanies || data.contactCompanies.length === 0) {
    data.contactCompanies = [{
      id: 'comp_default',
      name: '기본 업체',
      note: '',
      createdAt: new Date().toISOString()
    }];
  }

  const site = {
    id: 'proj_' + Date.now(),
    companyId: data.contactCompanies[0].id,
    name: req.body.name || '',
    address: req.body.address || '',
    note: req.body.note || '',
    createdAt: new Date().toISOString(),
    customFields: []
  };

  data.contactProjects.push(site);
  db.saveContacts(data);
  res.json(site);
});

app.put('/api/contacts/sites/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const site = (data.contactProjects || []).find(s => s.id === req.params.id);
  if (!site) return res.status(404).json({ error: '현장 없음' });

  if (req.body.name !== undefined) site.name = req.body.name;
  if (req.body.address !== undefined) site.address = req.body.address;
  if (req.body.note !== undefined) site.note = req.body.note;

  db.saveContacts(data);
  res.json(site);
});

app.delete('/api/contacts/sites/:id', requireAuth, (req, res) => {
  const data = db.loadContacts();

  data.contactProjects = (data.contactProjects || []).filter(s => s.id !== req.params.id);
  data.contacts = (data.contacts || []).filter(c => c.projectId !== req.params.id);

  db.saveContacts(data);
  res.json({ ok: true });
});

app.get('/api/contacts/sites/:siteId/fields', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const site = (data.contactProjects || []).find(s => s.id === req.params.siteId);
  if (!site) return res.status(404).json({ error: '현장 없음' });

  const fields = site.customFields || [];
  res.json(fields);
});

app.post('/api/contacts/sites/:siteId/fields', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const site = (data.contactProjects || []).find(s => s.id === req.params.siteId);
  if (!site) return res.status(404).json({ error: '현장 없음' });

  if (!site.customFields) site.customFields = [];

  const field = {
    id: 'f_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    name: req.body.name || '',
    type: req.body.type || 'text',
    options: req.body.options || []
  };

  site.customFields.push(field);
  db.saveContacts(data);
  res.json(field);
});

app.delete('/api/contacts/sites/:siteId/fields/:fieldId', requireAuth, (req, res) => {
  const data = db.loadContacts();
  const site = (data.contactProjects || []).find(s => s.id === req.params.siteId);
  if (!site) return res.status(404).json({ error: '현장 없음' });

  site.customFields = (site.customFields || []).filter(f => f.id !== req.params.fieldId);

  (data.contacts || []).forEach(c => {
    if (c.projectId === req.params.siteId && c.customFields) {
      delete c.customFields[req.params.fieldId];
    }
  });

  db.saveContacts(data);
  res.json({ ok: true });
});

// ── 시안 검색 ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════

const DESIGN_ROOT = process.env.DESIGN_ROOT || 'D:\\';
const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.bmp', '.gif', '.webp']);
// 네트워크 공유 경로 (클라이언트에서 폴더 열기용)
const NETWORK_SHARE = '\\\\192.168.0.133\\dd';
function toNetworkPath(localPath) {
  return localPath.replace(/^D:\\/i, NETWORK_SHARE + '\\');
}

let designIndex = [];
let designIndexStatus = { built: false, building: false, count: 0, lastBuilt: null, error: null };

// 건너뛸 시스템 폴더
const SKIP_DIRS = new Set([
  'system volume information', 'recycler', '$recycle.bin', 'recovery',
  'windows', 'program files', 'program files (x86)', 'programdata',
  'node_modules', '.git', '__pycache__', 'appdata',
  '송지현 대리'
]);

async function buildDesignIndexAsync(rootPath) {
  const items = [];
  const queue = [{ dir: rootPath, depth: 0 }];
  // .ai 파일 존재 여부를 폴더별로 배치 체크 (디스크 I/O 대폭 감소)
  const aiFileCache = new Map(); // dir -> Set of basenames with .ai

  while (queue.length > 0) {
    const { dir, depth } = queue.shift();
    if (depth > 8) continue;

    // 10개 폴더마다 이벤트 루프 양보 (너무 자주 양보하면 오히려 느림)
    if (items.length % 10 === 0) await new Promise(r => setImmediate(r));

    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
    catch (e) { continue; }

    // 해당 폴더의 .ai 파일 목록을 한 번에 수집
    const aiSet = new Set();
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase().endsWith('.ai')) {
        aiSet.add(path.basename(e.name, '.ai').toLowerCase());
      }
    }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || entry.name.startsWith('$')) continue;
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        queue.push({ dir: fullPath, depth: depth + 1 });
      } else if (IMAGE_EXTS.has(path.extname(entry.name).toLowerCase())) {
        const rel = path.relative(rootPath, fullPath);
        const parts = rel.split(path.sep);
        const baseName = path.basename(entry.name, path.extname(entry.name));
        // .ai 파일 존재 여부를 이미 수집한 Set에서 O(1) 조회
        const hasAi = aiSet.has(baseName.toLowerCase());
        // 수정시간 저장 (최신순 정렬용)
        let mtime = 0;
        try { mtime = fs.statSync(fullPath).mtimeMs; } catch(e) {}
        items.push({
          path: fullPath, rel, parts, name: entry.name,
          aiPath: hasAi ? path.join(dir, baseName + '.ai') : null,
          mtime,
          searchText: rel.toLowerCase().replace(/\\/g, ' ').replace(/_/g, ' ')
        });
        if (items.length % 500 === 0) {
          designIndexStatus.count = items.length;
        }
      }
    }
  }
  return items;
}

let designIndexTimer = null;

function runDesignIndex() {
  if (designIndexStatus.building) return;
  if (!fs.existsSync(DESIGN_ROOT)) {
    designIndexStatus.error = `경로 없음: ${DESIGN_ROOT}`;
    console.log(`[시안검색] 경로 없음: ${DESIGN_ROOT}`);
    return;
  }
  designIndexStatus.building = true;
  designIndexStatus.error = null;
  console.log(`[시안검색] 인덱싱 시작... (${DESIGN_ROOT})`);
  buildDesignIndexAsync(DESIGN_ROOT).then(idx => {
    designIndex = idx;
    designIndexStatus = { built: true, building: false, count: idx.length, lastBuilt: new Date().toISOString(), error: null };
    console.log(`[시안검색] 완료: ${idx.length}개 파일`);
  }).catch(e => {
    designIndexStatus = { ...designIndexStatus, building: false, error: e.message };
    console.log(`[시안검색] 오류: ${e.message}`);
  });
}

function startDesignIndexer() {
  // 서버 시작 5초 후 첫 인덱싱
  setTimeout(() => {
    runDesignIndex();
    // 이후 30분마다 자동 재인덱싱 (5분은 너무 빈번 → 서버 부담)
    designIndexTimer = setInterval(runDesignIndex, 30 * 60 * 1000);
  }, 5000);
  // fs.watch 제거 — D드라이브 전체 감시는 서버 성능 심각하게 저하
  // 대신 수동 재인덱싱 버튼 또는 30분 자동 주기 사용
  console.log(`[시안검색] 30분 주기 자동 인덱싱 설정 완료 (수동: 재인덱싱 버튼 사용)`);
}
startDesignIndexer();

app.get('/api/design/search', requireAuth, (req, res) => {
  const q = (req.query.q || '').toLowerCase().trim();
  if (!q) return res.json({ items: [], total: 0, status: designIndexStatus });
  const keywords = q.split(/\s+/).filter(Boolean);
  // 빠른 검색: 첫 키워드로 1차 필터링 후 나머지 키워드 매칭
  const first = keywords[0];
  const rest = keywords.slice(1);
  let matches = designIndex.filter(item => item.searchText.includes(first));
  if (rest.length > 0) matches = matches.filter(item => rest.every(kw => item.searchText.includes(kw)));
  // 년도 필터
  const yearFilter = parseInt(req.query.year);
  if (yearFilter && yearFilter >= 2000 && yearFilter <= 2100) {
    const yearStart = new Date(yearFilter, 0, 1).getTime();
    const yearEnd = new Date(yearFilter + 1, 0, 1).getTime();
    matches = matches.filter(item => item.mtime >= yearStart && item.mtime < yearEnd);
  }
  // 최신 수정일 순으로 정렬
  matches.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
  const total = matches.length;
  const pageSize = Math.min(200, parseInt(req.query.pageSize) || 100);
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const start = (page - 1) * pageSize;
  // searchText 제외하고 응답 (트래픽 절감) + 네트워크 경로 추가
  const results = matches.slice(start, start + pageSize).map(item => ({
    path: item.path, rel: item.rel, parts: item.parts, name: item.name, aiPath: item.aiPath,
    netPath: toNetworkPath(item.aiPath || item.path),
    netFolder: toNetworkPath(path.dirname(item.aiPath || item.path))
  }));
  res.json({ items: results, total, page, pageSize, status: designIndexStatus });
});

app.get('/api/design/thumb', requireAuth, async (req, res) => {
  const filePath = req.query.path;
  if (!filePath) return res.status(400).send('path required');
  const resolved = path.resolve(filePath);
  if (!resolved.toLowerCase().startsWith(path.resolve(DESIGN_ROOT).toLowerCase())) return res.status(403).send('forbidden');
  if (!fs.existsSync(resolved)) return res.status(404).send('not found');

  res.set('Cache-Control', 'public, max-age=86400'); // 24시간 캐시

  // sharp 있으면 축소된 썸네일 생성/캐시
  if (sharp) {
    const hash = crypto.createHash('md5').update(resolved).digest('hex');
    const thumbPath = path.join(THUMB_DIR, hash + '.jpg');
    // 캐시된 썸네일 있으면 바로 전송
    if (fs.existsSync(thumbPath)) {
      return res.type('image/jpeg').sendFile(thumbPath);
    }
    // 없으면 생성
    try {
      await sharp(resolved).resize(240, 180, { fit: 'cover', withoutEnlargement: true }).jpeg({ quality: 60 }).toFile(thumbPath);
      return res.type('image/jpeg').sendFile(thumbPath);
    } catch(e) {
      // sharp 실패 시 원본 전송 (단 5MB 이하만)
    }
  }

  // sharp 없으면 원본 전송 (5MB 제한)
  try {
    const stat = fs.statSync(resolved);
    if (stat.size > 5 * 1024 * 1024) return res.status(204).end();
  } catch(e) {}
  res.sendFile(resolved);
});

app.get('/api/design/status', (req, res) => res.json(designIndexStatus));

app.post('/api/design/open-folder', requireAuth, (req, res) => {
  const { path: filePath } = req.body;
  if (!filePath) return res.status(400).json({ error: 'path 필요' });
  const absPath = path.resolve(DESIGN_ROOT, filePath);
  const folderPath = path.dirname(absPath);
  const { execFile } = require('child_process');
  const platform = process.platform;
  if (platform === 'win32') {
    // execFile은 쉘을 거치지 않아서 특수문자(#, ●, 한글 등) 안전
    execFile('explorer', [folderPath], (err) => {
      // explorer는 성공해도 exit code 1 반환하는 경우가 있음
      res.json({ ok: true });
    });
  } else if (platform === 'darwin') {
    execFile('open', [folderPath], (err) => {
      if (err) res.status(500).json({ error: err.message });
      else res.json({ ok: true });
    });
  } else {
    execFile('xdg-open', [folderPath], (err) => {
      if (err) res.status(500).json({ error: err.message });
      else res.json({ ok: true });
    });
  }
});

// ── 폴더/파일 열기 토큰 (URL 인코딩 문제 우회) ──
const openFolderTokens = new Map(); // token -> { path, type, created }
app.post('/api/design/openfolder', requireAuth, (req, res) => {
  const { folderPath, openType } = req.body;
  if (!folderPath) return res.status(400).json({ error: 'folderPath required' });
  const token = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const type = openType === 'file' ? 'file' : openType === 'select' ? 'select' : 'folder';
  openFolderTokens.set(token, { path: folderPath, type, created: Date.now() });
  // 5분 후 자동 삭제
  setTimeout(() => openFolderTokens.delete(token), 5 * 60 * 1000);
  res.json({ token });
});
app.get('/api/design/openfolder/:token', (req, res) => {
  const data = openFolderTokens.get(req.params.token);
  if (!data) return res.status(404).send('not found');
  openFolderTokens.delete(req.params.token);
  res.send(data.type + '|' + data.path);
});

app.post('/api/design/reindex', requireAuth, (req, res) => {
  if (designIndexStatus.building) return res.json({ building: true, message: '인덱싱 중...', count: designIndex.length });
  runDesignIndex(); // 비동기 시작
  res.json({ building: true, message: '인덱싱 시작됨 — 파일 수에 따라 수 분 소요될 수 있습니다', count: 0 });
});

// 진단용 (관리자) — 브라우저에서 /api/design/debug 로 확인
app.get('/api/design/debug', requireAdmin, (req, res) => {
  const rootExists = fs.existsSync(DESIGN_ROOT);
  let entries = [];
  if (rootExists) {
    try { entries = fs.readdirSync(DESIGN_ROOT).slice(0, 20); } catch(e) { entries = ['읽기 오류: '+e.message]; }
  }
  res.json({
    DESIGN_ROOT,
    rootExists,
    entries,
    status: designIndexStatus,
    indexedCount: designIndex.length,
    platform: process.platform,
  });
});

// ══════════════════════════════════════════════════════════
// ── 공지사항 ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════

app.get('/api/notices', requireAuth, (req, res) => {
  const data = db.load();
  res.json((data.notices || []).sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)));
});

app.post('/api/notices', requireAdmin, (req, res) => {
  const { title, content, type } = req.body;
  if (!title || !content) return res.status(400).json({ error: '제목과 내용을 입력하세요' });
  const data = db.load();
  if (!data.notices) data.notices = [];
  const notice = { id: db.generateId('ntc'), title: title.trim(), content: content.trim(), type: type || 'update', createdAt: new Date().toISOString(), createdBy: req.user.name };
  data.notices.unshift(notice);
  db.save(data);
  res.json(notice);
});

app.delete('/api/notices/:id', requireAdmin, (req, res) => {
  const data = db.load();
  data.notices = (data.notices || []).filter(n => n.id !== req.params.id);
  db.save(data);
  res.json({ success: true });
});

// 서버 시작 시 관리자 계정 확인
ensureAdminAccount();

// 서버 시작 시 데이터 마이그레이션
migrateContactsData();

app.listen(PORT, '0.0.0.0', () => {
  const nets = require('os').networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(nets)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) { localIP = cfg.address; break; }
    }
  }
  console.log(`\n✅ 단가표 서버 실행 중`);
  console.log(`   로컬: http://localhost:${PORT}`);
  console.log(`   네트워크: http://${localIP}:${PORT}  ← 직원들은 이 주소로 접속\n`);
});
