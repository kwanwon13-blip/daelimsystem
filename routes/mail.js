/**
 * routes/mail.js — SMTP 메일 발송 + 설정
 * Mounted at: app.use('/api', require('./routes/mail'))
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
const { escHtml, generateQuotePdf } = require('../utils/pdf');

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
router.get('/mail/settings', (req, res) => {
  try {
    const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
    if (!fs.existsSync(settingsPath)) return res.json({});
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
    // 비밀번호는 마스킹
    if (settings.smtp && settings.smtp.pass) {
      settings.smtp.pass = '****';
    }
    res.json(settings);
  } catch (e) { res.json({}); }
});

router.post('/mail/settings', (req, res) => {
  try {
    const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
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
router.post('/mail/send', async (req, res) => {
  try {
    const { quoteId, toEmail, subject, message } = req.body;
    if (!toEmail) return res.status(400).json({ error: '수신 이메일을 입력해주세요' });

    // SMTP 설정 로드
    const settingsPath = path.join(__dirname, '..', 'data', 'settings.json');
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
      const uData = db.loadUsers();
      const senderUser = (uData.users || []).find(u => u.userId === senderSession.userId);
      if (senderUser) senderInfo = { name: senderUser.name, position: senderUser.position || '', phone: senderUser.phone || '', namecard: senderUser.namecard || {}, namecardImage: senderUser.namecardImage || null };
    }
    if (quoteId) {
      if (db.sql) {
        const quote = db.sql.quotes.getById(quoteId);
        if (!quote) return res.status(404).json({ error: '견적서를 찾을 수 없습니다' });
        quoteData = quote;
      } else {
        const data = db.load();
        const quote = (data.quotes || []).find(q => q.id === quoteId);
        if (!quote) return res.status(404).json({ error: '견적서를 찾을 수 없습니다' });
        quoteData = quote;
      }
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
      const imgPath = path.join(__dirname, '..', 'data', senderInfo.namecardImage);
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
      if (db.sql) {
        const quote = db.sql.quotes.getById(quoteId);
        if (quote) {
          if (!quote.mailHistory) quote.mailHistory = [];
          const cookies = parseCookies(req);
          const token = cookies.session_token;
          const user = token ? sessions[token] : null;
          quote.mailHistory.push({ to: toEmail, sentAt: new Date().toISOString(), sentBy: user ? user.userId : '' });
          db.sql.quotes.update(quoteId, { mailHistory: quote.mailHistory, status: 'sent' });
        }
      } else {
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
    }

    res.json({ ok: true, message: `${toEmail}로 발송 완료` });
  } catch (e) {
    console.error('메일 발송 오류:', e);
    res.status(500).json({ error: '메일 발송 실패: ' + e.message });
  }
});


module.exports = router;
