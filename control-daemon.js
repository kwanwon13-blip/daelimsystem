/**
 * control-daemon.js — 서버 원격 제어 데몬 (서버 PC에서 항상 실행)
 *
 * 서버 PC(192.168.0.133)에서 포트 3002로 돌아감.
 * 로컬 PC 등 다른 PC가 이걸 호출해서 메인 서버(3000)를 Start/Stop/Restart 한다.
 *
 * 환경변수:
 *   CONTROL_DAEMON_PORT     데몬 포트 (기본 3002)
 *   CONTROL_DAEMON_BIND     바인딩 IP (기본 0.0.0.0 — 사내망 전용)
 *   CONTROL_DAEMON_SECRET   공유 비밀 (필수)
 *   CONTROL_APP_DIR         메인 앱 디렉토리 (기본: 이 파일의 경로)
 *
 * 자동시작: control-daemon-watchdog.bat → Windows 작업 스케줄러
 */

// ── .env 로드 (없거나 dotenv 미설치여도 안전하게 무시) ──
try { require('dotenv').config(); } catch (e) { /* dotenv 미설치 — 기본값 사용 */ }

const express = require('express');
const path = require('path');
const fs = require('fs');
const { spawn, exec } = require('child_process');
const net = require('net');

// ── 설정 ─────────────────────────────────────────────────
const PORT = parseInt(process.env.CONTROL_DAEMON_PORT || '3002', 10);
const BIND = process.env.CONTROL_DAEMON_BIND || '0.0.0.0';
const SECRET = process.env.CONTROL_DAEMON_SECRET || '';
const APP_DIR = process.env.CONTROL_APP_DIR || __dirname;
const MAIN_PORT = 3000;
const STOP_FLAG = path.join(APP_DIR, 'server-stop.flag');
const VBS_PATH = path.join(APP_DIR, 'proxy-hidden-start.vbs');
const LOG_FILE = path.join(APP_DIR, 'control-daemon.log');

if (!SECRET) {
  console.error('❌ CONTROL_DAEMON_SECRET 환경변수가 없습니다.');
  console.error('   control-daemon-watchdog.bat에서 세팅하세요.');
  process.exit(1);
}

// ── 로깅 ─────────────────────────────────────────────────
function log(...args) {
  const line = '[' + new Date().toISOString() + '] ' + args.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

// ── 크래시 방지 ──────────────────────────────────────────
process.on('uncaughtException', (err) => {
  log('[uncaughtException]', err.message, err.stack);
});
process.on('unhandledRejection', (reason) => {
  log('[unhandledRejection]', String(reason));
});

// ── 메인 서버(3000) TCP 핑 ───────────────────────────────
function pingMainServer() {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    let done = false;
    const finish = (alive) => { if (done) return; done = true; try { sock.destroy(); } catch(e) {} resolve(alive); };
    sock.setTimeout(600);
    sock.once('connect', () => finish(true));
    sock.once('timeout', () => finish(false));
    sock.once('error', () => finish(false));
    sock.connect(MAIN_PORT, '127.0.0.1');
  });
}

// ── 메인 서버 시작 (VBS로 히든 실행) ─────────────────────
function startMain() {
  if (!fs.existsSync(VBS_PATH)) {
    throw new Error('VBS 파일 없음: ' + VBS_PATH);
  }
  // stop.flag 제거 (남아있으면 와치독이 바로 죽음)
  try { if (fs.existsSync(STOP_FLAG)) fs.unlinkSync(STOP_FLAG); } catch(e) { log('stop.flag 제거 실패:', e.message); }

  const proc = spawn('wscript.exe', [VBS_PATH], {
    cwd: APP_DIR,
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  proc.unref();
  log('메인 서버 시작 요청 (VBS 실행):', VBS_PATH);
}

// ── 메인 서버 정지 (stop.flag + taskkill node) ───────────
function stopMain() {
  try {
    fs.writeFileSync(STOP_FLAG, new Date().toISOString(), 'utf8');
    log('stop.flag 생성:', STOP_FLAG);
  } catch (e) {
    throw new Error('stop.flag 생성 실패: ' + e.message);
  }
  // node.exe 중 server.js를 돌리는 놈만 죽이고 싶지만, 단순히 전체 node를 잡는다.
  // (control-daemon.js도 node인데 얘가 죽으면 문제니까 — 대신 pid 필터)
  // 현재 프로세스(control-daemon)의 pid는 살리고 나머지 node만 kill
  exec('tasklist /FI "IMAGENAME eq node.exe" /FO CSV /NH', (err, stdout) => {
    if (err) { log('tasklist 실패:', err.message); return; }
    const myPid = String(process.pid);
    const lines = stdout.split(/\r?\n/).filter(Boolean);
    const pids = [];
    for (const line of lines) {
      // "node.exe","1234","Services","0","12,345 K"
      const m = line.match(/^"[^"]+","(\d+)"/);
      if (m && m[1] !== myPid) pids.push(m[1]);
    }
    if (pids.length === 0) { log('죽일 node 프로세스 없음'); return; }
    log('taskkill 대상 PID:', pids.join(','));
    for (const pid of pids) {
      exec(`taskkill /f /pid ${pid}`, (e, so, se) => {
        if (e) log(`taskkill /pid ${pid} 실패:`, e.message);
        else log(`taskkill /pid ${pid} 성공`);
      });
    }
  });
}

// ── CORS ────────────────────────────────────────────────
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,X-Control-Secret');
}

// ── Express 앱 ──────────────────────────────────────────
const app = express();
app.use(express.json({ limit: '1mb' }));

app.use((req, res, next) => {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
});

// 공유 비밀 인증 (OPTIONS 제외, /ping 제외)
app.use((req, res, next) => {
  if (req.path === '/ping') return next();
  const secret = req.headers['x-control-secret'] || req.query.secret || '';
  if (secret !== SECRET) {
    log('인증 실패:', req.ip, req.path);
    return res.status(401).json({ error: 'Invalid secret' });
  }
  next();
});

// GET /ping — 인증 없이 살아있는지만 확인
app.get('/ping', (req, res) => {
  res.json({ ok: true, service: 'control-daemon', version: '1.0' });
});

// GET /status — 메인 서버 상태
app.get('/status', async (req, res) => {
  const alive = await pingMainServer();
  const stopFlagExists = fs.existsSync(STOP_FLAG);
  res.json({
    ok: true,
    mainServer: {
      running: alive,
      port: MAIN_PORT,
      stopFlagPresent: stopFlagExists,
    },
    daemon: {
      pid: process.pid,
      uptimeSec: Math.floor(process.uptime()),
      port: PORT,
      appDir: APP_DIR,
    },
    timestamp: new Date().toISOString(),
  });
});

// POST /start — 메인 서버 시작
app.post('/start', async (req, res) => {
  const alive = await pingMainServer();
  if (alive) {
    return res.json({ ok: true, msg: '이미 실행 중입니다.', alreadyRunning: true });
  }
  try {
    startMain();
    res.json({ ok: true, msg: '시작 요청됨. 몇 초 뒤 /status로 확인하세요.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /stop — 메인 서버 정지
app.post('/stop', async (req, res) => {
  try {
    stopMain();
    res.json({ ok: true, msg: '정지 요청됨. stop.flag 생성됨 + node 프로세스 종료 예약됨.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /restart — 정지 후 시작
app.post('/restart', async (req, res) => {
  try {
    stopMain();
    res.json({ ok: true, msg: '재시작 진행 중... 5초 뒤 /status 확인하세요.' });
    // 5초 기다린 뒤 다시 시작
    setTimeout(() => {
      try { startMain(); log('restart: startMain 호출 완료'); }
      catch (e) { log('restart: startMain 실패 -', e.message); }
    }, 5000);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── 서버 기동 ───────────────────────────────────────────
app.listen(PORT, BIND, () => {
  log('============================================');
  log(' control-daemon 기동');
  log(`   포트: ${PORT} / 바인드: ${BIND}`);
  log(`   앱 경로: ${APP_DIR}`);
  log(`   VBS: ${VBS_PATH}`);
  log(`   STOP_FLAG: ${STOP_FLAG}`);
  log('============================================');
});
