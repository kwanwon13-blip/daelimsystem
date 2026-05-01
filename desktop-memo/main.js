/**
 * 대림에스엠 메모 — Electron 데스크탑 메모 앱
 * ERP 워크스페이스의 데스크탑 클라이언트
 *
 * 주요 기능:
 *  - Frameless + Transparent 메모창
 *  - 시스템 트레이 + 우클릭 메뉴
 *  - 멀티 메모창 동시 운영
 *  - Always-on-top 토글
 *  - 자동 시작 (선택)
 *  - ERP 세션 공유 (cookie 영속)
 */

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, session, dialog, clipboard, globalShortcut, desktopCapturer, screen } = require('electron');
const path = require('path');
const fs = require('fs');

let Store;
try { Store = require('electron-store'); } catch (e) { Store = null; }

// ────────────────────────────────────────────────
// 설정 (사용자별 영속)
// ────────────────────────────────────────────────
const store = Store ? new Store({
  name: 'config',
  defaults: {
    serverUrl: 'http://192.168.0.133:3000',
    autoStart: false,
    defaultColor: 'yellow',
    defaultOpacity: '100',
    alwaysOnTopDefault: true,
    pinnedPages: [],   // [{id, title}]
    recentPages: [],   // [{id, title, lastOpened}]
    rememberWindowPos: true,
    windowStates: {},  // { [pageId]: {x, y, width, height, color, opacity, mini, alwaysOnTop} }
  }
}) : null;

const cfg = {
  get: (key, def) => store ? store.get(key, def) : def,
  set: (key, val) => store && store.set(key, val),
};

// ────────────────────────────────────────────────
// 상태
// ────────────────────────────────────────────────
const memoWindows = new Map();   // pageId → BrowserWindow
let trayInstance = null;
let loginWindow = null;
let listWindow = null;
let contactsWidgetWin = null;    // 연락처 위젯 (모드 A — 작은 영구 창)
let contactsSearchWin = null;    // 연락처 검색 팝업 (모드 B)
let contactsFullWin = null;      // 연락처 전체 목록 (모드 C)
let launcherWin = null;          // 런처 (4버튼 박스)
let workspaceSidebarWin = null;  // 워크스페이스 사이드바 패널
let aiWidgetWin = null;          // AI 빠른 질문 위젯
let aiFullWin = null;            // AI 전체 화면 (큰 창)
let ocrWidgetWin = null;         // OCR 위젯
let statementWidgetWin = null;   // 명세서 OCR 빠른 등록 위젯
let captureOverlayWin = null;    // 캡쳐 영역 선택 오버레이
let _lastCaptureImg = null;      // 마지막 전체 화면 캡쳐 (nativeImage) — crop 용
let isQuitting = false;

// 단일 인스턴스 보장 (이미 떠있으면 새로 안 띄움)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // 두 번째 실행 시 트레이에서 메모 목록 표시
    showMemoList();
  });
}

// ────────────────────────────────────────────────
// 세션 (ERP 쿠키 영속)
// ────────────────────────────────────────────────
function getServerUrl() {
  return cfg.get('serverUrl', 'http://192.168.0.133:3000').replace(/\/+$/, '');
}

async function checkLoggedIn() {
  // /api/auth/me 호출해서 로그인 상태 확인
  try {
    const cookies = await session.defaultSession.cookies.get({ url: getServerUrl() });
    if (!cookies.length) return { loggedIn: false };
    const ses = session.defaultSession;
    const url = getServerUrl() + '/api/auth/me';
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const resp = await fetch(url, {
      headers: { Cookie: cookieHeader },
    });
    if (!resp.ok) return { loggedIn: false };
    const data = await resp.json();
    return data;
  } catch (e) {
    return { loggedIn: false, error: e.message };
  }
}

// ────────────────────────────────────────────────
// 로그인 창 (첫 실행 시 또는 세션 만료)
// ── 커스텀 로그인 폼 (메모 전용 앱 — ERP 본체 UI 노출 안 함) ──
// ────────────────────────────────────────────────
function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return loginWindow;
  }
  loginWindow = new BrowserWindow({
    width: 420,
    height: 540,
    title: '대림에스엠 메모 — 로그인',
    resizable: false,
    minimizable: false,
    maximizable: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // 커스텀 로그인 페이지 로드 (ERP 메인 X)
  loginWindow.loadFile(path.join(__dirname, 'renderer', 'login.html'));
  loginWindow.on('closed', () => { loginWindow = null; });
  return loginWindow;
}

// IP 호스트 (192.168.x.x, localhost) 인지 — Electron 쿠키는 IP 에 domain 명시하면 거부
function isIpOrLocalhost(host) {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host === 'localhost' || host === '127.0.0.1';
}

// Set-Cookie 헤더 풀 파싱 (name, value, attributes)
function parseSetCookie(setCookieStr) {
  const parts = setCookieStr.split(';').map(p => p.trim());
  const [nameValue, ...attrs] = parts;
  const eqIdx = nameValue.indexOf('=');
  if (eqIdx < 0) return null;
  const name = nameValue.slice(0, eqIdx).trim();
  const value = nameValue.slice(eqIdx + 1).trim();
  if (!name) return null;
  const result = { name, value, httpOnly: false, secure: false, path: '/', sameSite: null, expirationDate: null };
  for (const a of attrs) {
    const lower = a.toLowerCase();
    if (lower === 'httponly') result.httpOnly = true;
    else if (lower === 'secure') result.secure = true;
    else if (lower.startsWith('max-age=')) {
      const ma = parseInt(a.slice(8), 10);
      if (!isNaN(ma)) result.expirationDate = Date.now() / 1000 + ma;
    }
    else if (lower.startsWith('expires=')) {
      const d = new Date(a.slice(8));
      if (!isNaN(d.getTime())) result.expirationDate = d.getTime() / 1000;
    }
    else if (lower.startsWith('path=')) result.path = a.slice(5) || '/';
    else if (lower.startsWith('samesite=')) {
      const s = lower.slice(9);
      if (s === 'lax' || s === 'strict') result.sameSite = s;
      else if (s === 'none') result.sameSite = 'no_restriction';
    }
  }
  return result;
}

// 로그인 처리 — IPC 로 호출됨, 성공하면 자동으로 로그인 창 닫고 런처 띄움
async function doLogin(userId, password) {
  try {
    const url = getServerUrl() + '/api/auth/login';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password }),
    });

    // Set-Cookie 헤더 → Electron session 으로 저장
    const setCookieHeaders = resp.headers.getSetCookie ? resp.headers.getSetCookie() : (resp.headers.raw ? resp.headers.raw()['set-cookie'] : []);
    if (Array.isArray(setCookieHeaders) && setCookieHeaders.length) {
      const targetUrl = new URL(getServerUrl());
      const isIp = isIpOrLocalhost(targetUrl.hostname);
      for (const ck of setCookieHeaders) {
        const parsed = parseSetCookie(ck);
        if (!parsed) continue;
        const opts = {
          url: getServerUrl(),
          name: parsed.name,
          value: parsed.value,
          path: parsed.path,
          httpOnly: parsed.httpOnly,
          secure: parsed.secure,
        };
        // ⚠ IP/localhost 는 domain 생략 (host-only 쿠키로 저장됨, Electron 권장)
        if (!isIp) opts.domain = targetUrl.hostname;
        if (parsed.expirationDate) opts.expirationDate = parsed.expirationDate;
        if (parsed.sameSite) opts.sameSite = parsed.sameSite;
        try {
          await session.defaultSession.cookies.set(opts);
        } catch (e) {
          console.warn('[doLogin] cookie set failed:', e.message, parsed.name);
        }
      }
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      return { ok: false, error: data.error || ('HTTP ' + resp.status) };
    }

    // 로그인 성공 — 로그인 창 닫고 트레이 + 런처 띄움 (런처가 메인 진입)
    if (loginWindow && !loginWindow.isDestroyed()) {
      try { loginWindow.close(); } catch(_) {}
    }
    buildTrayMenu();
    openLauncher();

    return { ok: true, userId: data.userId, name: data.name };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ────────────────────────────────────────────────
// 메모창 생성 (페이지별)
// ────────────────────────────────────────────────
function openMemoWindow(pageId, options = {}) {
  if (!pageId) return;
  // 이미 열려있으면 포커스
  if (memoWindows.has(pageId)) {
    const existing = memoWindows.get(pageId);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return existing;
    }
    memoWindows.delete(pageId);
  }

  // 저장된 창 상태 복원
  const states = cfg.get('windowStates', {});
  const savedState = states[pageId] || {};

  const win = new BrowserWindow({
    width: Math.max(320, savedState.width || 420),
    height: Math.max(280, savedState.height || 560),
    minWidth: 200,           // 미니 모드 가로 줄일 수 있게
    minHeight: 28,           // 미니 모드 = 헤더만 (28px)
    x: savedState.x,
    y: savedState.y,
    frame: false,             // 프레임 없음 (S메모 스타일)
    transparent: false,       // 투명은 setOpacity 로 대체 (Windows 11 일부 GPU 에서 frameless+transparent 깜박임 회피)
    backgroundColor: '#fffbeb',
    alwaysOnTop: savedState.alwaysOnTop !== undefined ? savedState.alwaysOnTop : cfg.get('alwaysOnTopDefault', true),
    skipTaskbar: false,        // 작업표시줄에 표시 (멀티 메모 식별 위해)
    resizable: true,
    minimizable: true,
    maximizable: false,
    title: '메모',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,               // ready-to-show 후 노출 (깜박임 방지)
  });

  // 메모창 URL — 서버의 workspace-memo.html 그대로 사용 (ERP 와 100% 동기화)
  // 단, 데스크탑 전용 플래그 ?desktop=1 추가 → renderer 가 데스크탑 모드로 동작
  const memoUrl = getServerUrl() + '/workspace/memo/' + encodeURIComponent(pageId) + '?desktop=1';
  win.loadURL(memoUrl);

  win.once('ready-to-show', () => win.show());

  // 창 위치/크기 저장 (사용자가 조정한 값 영속)
  function saveWindowState() {
    if (win.isDestroyed()) return;
    const bounds = win.getBounds();
    const all = cfg.get('windowStates', {});
    all[pageId] = {
      ...all[pageId],
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      alwaysOnTop: win.isAlwaysOnTop(),
    };
    cfg.set('windowStates', all);
  }
  // 자석 스냅 — moved 시 다른 창/화면 가장자리에 가까우면 정렬
  let _snapTimer = null;
  win.on('move', () => {
    if (!cfg.get('snapEnabled', true)) return;
    if (_snapTimer) clearTimeout(_snapTimer);
    _snapTimer = setTimeout(() => snapWindow(win), 50);
  });
  win.on('moved', () => {
    saveWindowState();
    if (cfg.get('snapEnabled', true)) snapWindow(win, true);
  });
  win.on('resized', saveWindowState);

  // 닫힐 때 정리
  win.on('closed', () => {
    memoWindows.delete(pageId);
  });

  // 외부 링크는 시스템 브라우저로
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  memoWindows.set(pageId, win);
  // 최근 사용 페이지에 추가
  addToRecentPages(pageId, options.title);
  return win;
}

// ────────────────────────────────────────────────
// 자석 스냅 — 모든 위젯 창들 + 화면 가장자리 근처에서 정렬
// 메모/연락처/런처/워크스페이스/AI 위젯 — 모두 서로 붙음
// ────────────────────────────────────────────────
const SNAP_THRESHOLD = 16;  // 16px 이내면 스냅

function getAllSnapWindows() {
  const list = [...memoWindows.values()];
  if (launcherWin && !launcherWin.isDestroyed()) list.push(launcherWin);
  if (workspaceSidebarWin && !workspaceSidebarWin.isDestroyed()) list.push(workspaceSidebarWin);
  if (contactsWidgetWin && !contactsWidgetWin.isDestroyed()) list.push(contactsWidgetWin);
  if (aiWidgetWin && !aiWidgetWin.isDestroyed()) list.push(aiWidgetWin);
  if (ocrWidgetWin && !ocrWidgetWin.isDestroyed()) list.push(ocrWidgetWin);
  if (statementWidgetWin && !statementWidgetWin.isDestroyed()) list.push(statementWidgetWin);
  if (listWindow && !listWindow.isDestroyed()) list.push(listWindow);
  return list;
}

function snapWindow(win, finalize = false) {
  if (!win || win.isDestroyed()) return;
  const me = win.getBounds();
  const display = screen.getDisplayNearestPoint({ x: me.x + me.width/2, y: me.y + me.height/2 });
  const work = display.workArea;

  let newX = me.x;
  let newY = me.y;
  let snappedX = false, snappedY = false;

  // 1. 화면 가장자리 스냅
  if (Math.abs(me.x - work.x) < SNAP_THRESHOLD) { newX = work.x; snappedX = true; }
  if (Math.abs((me.x + me.width) - (work.x + work.width)) < SNAP_THRESHOLD) {
    newX = work.x + work.width - me.width; snappedX = true;
  }
  if (Math.abs(me.y - work.y) < SNAP_THRESHOLD) { newY = work.y; snappedY = true; }
  if (Math.abs((me.y + me.height) - (work.y + work.height)) < SNAP_THRESHOLD) {
    newY = work.y + work.height - me.height; snappedY = true;
  }

  // 2. 모든 다른 위젯 창과 스냅 (메모/연락처/런처/워크스페이스/AI)
  for (const other of getAllSnapWindows()) {
    if (other === win || other.isDestroyed()) continue;
    const o = other.getBounds();

    // 좌우 가장자리 정렬
    if (!snappedX) {
      // me.right 와 o.left 가 가까움 (오른쪽에 붙이기)
      if (Math.abs((me.x + me.width) - o.x) < SNAP_THRESHOLD) {
        newX = o.x - me.width; snappedX = true;
      }
      // me.left 와 o.right 가 가까움 (왼쪽에 붙이기)
      else if (Math.abs(me.x - (o.x + o.width)) < SNAP_THRESHOLD) {
        newX = o.x + o.width; snappedX = true;
      }
      // 좌측 또는 우측 정렬
      else if (Math.abs(me.x - o.x) < SNAP_THRESHOLD) {
        newX = o.x; snappedX = true;
      }
      else if (Math.abs((me.x + me.width) - (o.x + o.width)) < SNAP_THRESHOLD) {
        newX = o.x + o.width - me.width; snappedX = true;
      }
    }
    // 상하 가장자리 정렬
    if (!snappedY) {
      if (Math.abs((me.y + me.height) - o.y) < SNAP_THRESHOLD) {
        newY = o.y - me.height; snappedY = true;
      }
      else if (Math.abs(me.y - (o.y + o.height)) < SNAP_THRESHOLD) {
        newY = o.y + o.height; snappedY = true;
      }
      else if (Math.abs(me.y - o.y) < SNAP_THRESHOLD) {
        newY = o.y; snappedY = true;
      }
      else if (Math.abs((me.y + me.height) - (o.y + o.height)) < SNAP_THRESHOLD) {
        newY = o.y + o.height - me.height; snappedY = true;
      }
    }
    if (snappedX && snappedY) break;
  }

  if ((snappedX || snappedY) && (newX !== me.x || newY !== me.y)) {
    // finalize 시에만 실제 setBounds (드래그 중 매번 호출 시 부드럽지 못함)
    if (finalize) {
      win.setBounds({ x: newX, y: newY, width: me.width, height: me.height });
      // ✨ 시각 효과 — 붙은 두 창 모두에 플래시 신호 전송
      try {
        if (!win.isDestroyed() && win.webContents) win.webContents.send('snap:flash');
      } catch (_) {}
      // 어떤 창에 붙었는지 찾아서 같이 플래시
      for (const other of getAllSnapWindows()) {
        if (other === win || other.isDestroyed()) continue;
        const o = other.getBounds();
        // 붙어있는 창 (가장자리 1px 이내 접촉) 찾기
        const touchH = Math.abs((newX + me.width) - o.x) <= 1 || Math.abs(newX - (o.x + o.width)) <= 1;
        const touchV = Math.abs((newY + me.height) - o.y) <= 1 || Math.abs(newY - (o.y + o.height)) <= 1;
        const sameX = newX === o.x || (newX + me.width) === (o.x + o.width);
        const sameY = newY === o.y || (newY + me.height) === (o.y + o.height);
        if (touchH || touchV || sameX || sameY) {
          try { if (other.webContents) other.webContents.send('snap:flash'); } catch (_) {}
        }
      }
    }
  }
}

function addToRecentPages(pageId, title) {
  const recent = cfg.get('recentPages', []);
  const filtered = recent.filter(p => p.id !== pageId);
  filtered.unshift({ id: pageId, title: title || pageId, lastOpened: new Date().toISOString() });
  const trimmed = filtered.slice(0, 10);
  cfg.set('recentPages', trimmed);
}

// ────────────────────────────────────────────────
// 워크스페이스 창 (트레이 → "📋 워크스페이스")
// ────────────────────────────────────────────────
function showMemoList() {
  if (listWindow && !listWindow.isDestroyed()) {
    listWindow.focus();
    return;
  }
  listWindow = new BrowserWindow({
    width: 380,
    height: 540,
    title: '워크스페이스',
    frame: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  listWindow.loadFile(path.join(__dirname, 'renderer', 'list.html'));
  listWindow.on('closed', () => { listWindow = null; });
}

// ────────────────────────────────────────────────
// 연락처 — 3가지 모드 (위젯/검색/전체)
// ────────────────────────────────────────────────

// 서버 API 프록시 (cookie 자동 첨부)
async function fetchWithCookies(pathname, options = {}) {
  const cookies = await session.defaultSession.cookies.get({ url: getServerUrl() });
  const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const headers = Object.assign({}, options.headers || {}, { Cookie: cookieHeader });
  if (options.body && typeof options.body === 'object' && !(options.body instanceof Buffer)) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(options.body);
  }
  return fetch(getServerUrl() + pathname, { ...options, headers });
}

function openContactsWidget() {
  if (contactsWidgetWin && !contactsWidgetWin.isDestroyed()) {
    contactsWidgetWin.focus();
    return;
  }
  // 저장된 위치/크기 복원
  const states = cfg.get('windowStates', {});
  const saved = states['__contacts_widget'] || {};
  contactsWidgetWin = new BrowserWindow({
    width: Math.max(260, saved.width || 290),
    height: Math.max(360, saved.height || 460),
    x: saved.x,
    y: saved.y,
    minWidth: 240,
    minHeight: 280,
    title: '연락처',
    frame: false,
    backgroundColor: '#ffffff',
    alwaysOnTop: saved.alwaysOnTop !== undefined ? saved.alwaysOnTop : cfg.get('alwaysOnTopDefault', true),
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  contactsWidgetWin.loadFile(path.join(__dirname, 'renderer', 'contacts-widget.html'));
  contactsWidgetWin.once('ready-to-show', () => contactsWidgetWin.show());

  // 자석 스냅 + 위치 저장
  const saveWidgetState = () => {
    if (!contactsWidgetWin || contactsWidgetWin.isDestroyed()) return;
    const b = contactsWidgetWin.getBounds();
    const all = cfg.get('windowStates', {});
    all['__contacts_widget'] = {
      ...all['__contacts_widget'],
      x: b.x, y: b.y, width: b.width, height: b.height,
      alwaysOnTop: contactsWidgetWin.isAlwaysOnTop(),
    };
    cfg.set('windowStates', all);
  };
  let _t = null;
  contactsWidgetWin.on('move', () => {
    if (!cfg.get('snapEnabled', true)) return;
    if (_t) clearTimeout(_t);
    _t = setTimeout(() => snapWindow(contactsWidgetWin), 50);
  });
  contactsWidgetWin.on('moved', () => {
    saveWidgetState();
    if (cfg.get('snapEnabled', true)) snapWindow(contactsWidgetWin, true);
  });
  contactsWidgetWin.on('resized', saveWidgetState);
  contactsWidgetWin.on('closed', () => { contactsWidgetWin = null; });
}

function openContactsSearch() {
  if (contactsSearchWin && !contactsSearchWin.isDestroyed()) {
    contactsSearchWin.focus();
    return;
  }
  contactsSearchWin = new BrowserWindow({
    width: 480,
    height: 540,
    title: '연락처 검색',
    frame: false,
    backgroundColor: '#ffffff',
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: true,
    minimizable: false,
    maximizable: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  contactsSearchWin.loadFile(path.join(__dirname, 'renderer', 'contacts-search.html'));
  contactsSearchWin.once('ready-to-show', () => contactsSearchWin.show());
  contactsSearchWin.on('blur', () => {
    // 다른 창 클릭 시 자동 닫힘 (스포트라이트 스타일)
    if (contactsSearchWin && !contactsSearchWin.isDestroyed()) contactsSearchWin.close();
  });
  contactsSearchWin.on('closed', () => { contactsSearchWin = null; });
}

function openContactsFull() {
  if (contactsFullWin && !contactsFullWin.isDestroyed()) {
    contactsFullWin.focus();
    return;
  }
  contactsFullWin = new BrowserWindow({
    width: 720,
    height: 640,
    title: '전체 연락처 — 대림에스엠',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  contactsFullWin.loadFile(path.join(__dirname, 'renderer', 'contacts-full.html'));
  contactsFullWin.on('closed', () => { contactsFullWin = null; });
}

// ────────────────────────────────────────────────
// 영역 캡쳐 (S메모 스타일) — 전체화면 캡쳐 → 오버레이에서 영역 선택 → 클립보드
// ────────────────────────────────────────────────
// Electron accelerator 포맷 → 사용자에게 보여줄 한글/예쁜 형태
function formatShortcutForDisplay(s) {
  if (!s) return '없음';
  return String(s)
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/CmdOrCtrl/g, 'Ctrl')
    .replace(/Command/g, 'Cmd')
    .replace(/\+/g, '+');
}

// 단축키 설정 창 — 사용자가 키 조합 직접 입력
let shortcutSettingsWin = null;
function openShortcutSettings() {
  if (shortcutSettingsWin && !shortcutSettingsWin.isDestroyed()) {
    shortcutSettingsWin.focus();
    return;
  }
  shortcutSettingsWin = new BrowserWindow({
    width: 460,
    height: 320,
    title: '캡쳐 단축키 설정',
    resizable: false,
    minimizable: false,
    maximizable: false,
    alwaysOnTop: true,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  shortcutSettingsWin.setMenu(null);
  shortcutSettingsWin.loadFile(path.join(__dirname, 'renderer', 'shortcut-settings.html'));
  shortcutSettingsWin.on('closed', () => { shortcutSettingsWin = null; });
}

async function startCapture() {
  if (captureOverlayWin && !captureOverlayWin.isDestroyed()) {
    captureOverlayWin.focus();
    return;
  }
  try {
    // 커서가 위치한 디스플레이를 캡쳐 (멀티모니터 지원)
    const cursor = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursor);
    const { width, height } = display.size;

    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width, height },
    });
    if (!sources.length) {
      dialog.showErrorBox('캡쳐 실패', '화면을 가져올 수 없음');
      return;
    }
    // display.id 매칭 (가능하면), 없으면 첫 번째
    let src = sources.find(s => String(s.display_id) === String(display.id)) || sources[0];
    _lastCaptureImg = src.thumbnail;
    const dataUrl = _lastCaptureImg.toDataURL();

    captureOverlayWin = new BrowserWindow({
      x: display.bounds.x,
      y: display.bounds.y,
      width: display.bounds.width,
      height: display.bounds.height,
      frame: false,
      transparent: false,
      backgroundColor: '#000000',
      alwaysOnTop: true,
      skipTaskbar: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      hasShadow: false,
      fullscreen: false,
      kiosk: false,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      show: false,
    });
    captureOverlayWin.setAlwaysOnTop(true, 'screen-saver');
    captureOverlayWin.loadFile(path.join(__dirname, 'renderer', 'capture-overlay.html'));
    captureOverlayWin.webContents.once('did-finish-load', () => {
      captureOverlayWin.webContents.send('capture:image', { dataUrl, width, height });
      captureOverlayWin.show();
      captureOverlayWin.focus();
    });
    captureOverlayWin.on('closed', () => { captureOverlayWin = null; });
  } catch (e) {
    console.error('[capture] 실패:', e);
    dialog.showErrorBox('캡쳐 실패', e.message);
  }
}

function closeCapture() {
  if (captureOverlayWin && !captureOverlayWin.isDestroyed()) {
    try { captureOverlayWin.close(); } catch (_) {}
  }
}

// ────────────────────────────────────────────────
// 통일 위젯 헬퍼 — 자석 스냅 + 위치 저장 (런처/사이드바/AI 위젯 공용)
// ────────────────────────────────────────────────
function attachWidgetBehavior(win, stateKey) {
  const saveState = () => {
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const all = cfg.get('windowStates', {});
    all[stateKey] = {
      ...all[stateKey],
      x: b.x, y: b.y, width: b.width, height: b.height,
      alwaysOnTop: win.isAlwaysOnTop(),
    };
    cfg.set('windowStates', all);
  };
  let _t = null;
  win.on('move', () => {
    if (!cfg.get('snapEnabled', true)) return;
    if (_t) clearTimeout(_t);
    _t = setTimeout(() => snapWindow(win), 50);
  });
  win.on('moved', () => {
    saveState();
    if (cfg.get('snapEnabled', true)) snapWindow(win, true);
  });
  win.on('resized', saveState);
}

function getSavedState(stateKey, defaults) {
  const states = cfg.get('windowStates', {});
  const saved = states[stateKey] || {};
  return {
    x: saved.x,
    y: saved.y,
    width: saved.width || defaults.width,
    height: saved.height || defaults.height,
    alwaysOnTop: saved.alwaysOnTop !== undefined ? saved.alwaysOnTop : cfg.get('alwaysOnTopDefault', true),
  };
}

// ────────────────────────────────────────────────
// 런처 — 데스크탑 4버튼 박스
// ────────────────────────────────────────────────
function openLauncher() {
  if (launcherWin && !launcherWin.isDestroyed()) {
    launcherWin.focus();
    return;
  }
  const s = getSavedState('__launcher', { width: 430, height: 80 });
  launcherWin = new BrowserWindow({
    width: s.width, height: s.height, x: s.x, y: s.y,
    minWidth: 180, minHeight: 24,
    title: '대림에스엠 런처',
    frame: false,
    backgroundColor: '#fef3c7',
    alwaysOnTop: s.alwaysOnTop,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  launcherWin.loadFile(path.join(__dirname, 'renderer', 'launcher.html'));
  launcherWin.once('ready-to-show', () => launcherWin.show());
  attachWidgetBehavior(launcherWin, '__launcher');
  launcherWin.on('closed', () => { launcherWin = null; });
}

// ────────────────────────────────────────────────
// 워크스페이스 사이드바 — 페이지 목록 패널
// ────────────────────────────────────────────────
function openWorkspaceSidebar() {
  if (workspaceSidebarWin && !workspaceSidebarWin.isDestroyed()) {
    workspaceSidebarWin.focus();
    return;
  }
  const s = getSavedState('__workspace_sidebar', { width: 280, height: 480 });
  workspaceSidebarWin = new BrowserWindow({
    width: s.width, height: s.height, x: s.x, y: s.y,
    minWidth: 220, minHeight: 24,
    title: '페이지 목록',
    frame: false,
    backgroundColor: '#ffffff',
    alwaysOnTop: s.alwaysOnTop,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  workspaceSidebarWin.loadFile(path.join(__dirname, 'renderer', 'workspace-sidebar.html'));
  workspaceSidebarWin.once('ready-to-show', () => workspaceSidebarWin.show());
  attachWidgetBehavior(workspaceSidebarWin, '__workspace_sidebar');
  workspaceSidebarWin.on('closed', () => { workspaceSidebarWin = null; });
}

// ────────────────────────────────────────────────
// AI 위젯 (작은 채팅 박스)
// ────────────────────────────────────────────────
function openAIWidget() {
  if (aiWidgetWin && !aiWidgetWin.isDestroyed()) {
    aiWidgetWin.focus();
    return;
  }
  const s = getSavedState('__ai_widget', { width: 360, height: 480 });
  aiWidgetWin = new BrowserWindow({
    width: s.width, height: s.height, x: s.x, y: s.y,
    minWidth: 240, minHeight: 24,
    title: 'AI 빠른 질문',
    frame: false,
    backgroundColor: '#fafafa',
    alwaysOnTop: s.alwaysOnTop,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  aiWidgetWin.loadFile(path.join(__dirname, 'renderer', 'ai-widget.html'));
  aiWidgetWin.once('ready-to-show', () => aiWidgetWin.show());
  attachWidgetBehavior(aiWidgetWin, '__ai_widget');
  aiWidgetWin.on('closed', () => { aiWidgetWin = null; });
}

// ────────────────────────────────────────────────
// OCR 위젯 — Claude Vision 으로 이미지 → 텍스트
// ────────────────────────────────────────────────
function openOcrWidget() {
  if (ocrWidgetWin && !ocrWidgetWin.isDestroyed()) {
    ocrWidgetWin.focus();
    return;
  }
  const s = getSavedState('__ocr_widget', { width: 360, height: 540 });
  ocrWidgetWin = new BrowserWindow({
    width: s.width, height: s.height, x: s.x, y: s.y,
    minWidth: 280, minHeight: 28,
    title: 'OCR — 텍스트 추출',
    frame: false,
    backgroundColor: '#fafafa',
    alwaysOnTop: s.alwaysOnTop,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  ocrWidgetWin.loadFile(path.join(__dirname, 'renderer', 'ocr-widget.html'));
  ocrWidgetWin.once('ready-to-show', () => ocrWidgetWin.show());
  attachWidgetBehavior(ocrWidgetWin, '__ocr_widget');
  ocrWidgetWin.on('closed', () => { ocrWidgetWin = null; });
}

// ────────────────────────────────────────────────
// 명세서 OCR 위젯 — ERP 화면 없이 사진/PDF/PPTX를 빠르게 등록
// ────────────────────────────────────────────────
function openStatementWidget() {
  if (statementWidgetWin && !statementWidgetWin.isDestroyed()) {
    statementWidgetWin.focus();
    return;
  }
  const s = getSavedState('__statement_widget', { width: 420, height: 620 });
  statementWidgetWin = new BrowserWindow({
    width: s.width, height: s.height, x: s.x, y: s.y,
    minWidth: 300, minHeight: 28,
    title: '명세서 OCR 등록',
    frame: false,
    backgroundColor: '#f8fafc',
    alwaysOnTop: s.alwaysOnTop,
    skipTaskbar: false,
    resizable: true,
    minimizable: true,
    maximizable: false,
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    show: false,
  });
  statementWidgetWin.loadFile(path.join(__dirname, 'renderer', 'statement-widget.html'));
  statementWidgetWin.once('ready-to-show', () => statementWidgetWin.show());
  attachWidgetBehavior(statementWidgetWin, '__statement_widget');
  statementWidgetWin.on('closed', () => { statementWidgetWin = null; });
}

// ────────────────────────────────────────────────
// AI 전체 화면 (큰 창) — ERP 의 AI 탭만 띄움
// ────────────────────────────────────────────────
function openAIFull() {
  if (aiFullWin && !aiFullWin.isDestroyed()) {
    aiFullWin.focus();
    return;
  }
  aiFullWin = new BrowserWindow({
    width: 1100,
    height: 760,
    title: 'AI — 대림에스엠',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  // ERP 의 AI 탭으로 직접 진입 (다른 메뉴 안 보이게 desktop=1 플래그 + #ai 해시)
  aiFullWin.loadURL(getServerUrl() + '/?desktop=1#ai');
  aiFullWin.on('closed', () => { aiFullWin = null; });

  // 외부 링크는 시스템 브라우저
  aiFullWin.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

// ────────────────────────────────────────────────
// 시스템 트레이
// ────────────────────────────────────────────────
function buildTrayMenu() {
  if (!trayInstance) return;
  const recent = cfg.get('recentPages', []);
  const pinned = cfg.get('pinnedPages', []);
  const aotDefault = cfg.get('alwaysOnTopDefault', true);

  const recentItems = recent.slice(0, 5).map(p => ({
    label: p.title || p.id,
    click: () => openMemoWindow(p.id, { title: p.title }),
  }));
  const pinnedItems = pinned.map(p => ({
    label: '⭐ ' + (p.title || p.id),
    click: () => openMemoWindow(p.id, { title: p.title }),
  }));

  const menu = Menu.buildFromTemplate([
    {
      label: '+ 새 메모 만들기',
      click: () => createNewMemo(),
    },
    { type: 'separator' },
    ...(pinnedItems.length ? [{ label: '⭐ 즐겨찾기', submenu: pinnedItems }] : []),
    ...(recentItems.length ? [{ label: '🕐 최근 메모', submenu: recentItems }] : []),
    { label: '📋 워크스페이스 (전체 메모 목록)', click: () => showMemoList() },
    { type: 'separator' },
    {
      label: '📞 연락처',
      submenu: [
        { label: '⭐ 위젯 (즐겨찾기 + 검색)', click: () => openContactsWidget() },
        { label: '🔍 빠른 검색 팝업', accelerator: 'Ctrl+Shift+F', click: () => openContactsSearch() },
        { label: '📋 전체 목록 보기', click: () => openContactsFull() },
      ],
    },
    {
      label: '🤖 AI',
      submenu: [
        { label: '💬 빠른 질문 위젯', click: () => openAIWidget() },
        { label: '⛶ 전체 화면 (큰 창)', click: () => openAIFull() },
      ],
    },
    { label: '📝 OCR (이미지 → 텍스트)', click: () => openOcrWidget() },
    { label: '📑 명세서 OCR 빠른 등록', click: () => openStatementWidget() },
    { label: '🚀 런처', click: () => openLauncher() },
    { type: 'separator' },
    // ── 영역 캡쳐 (S메모 스타일) — 기본 OFF, 켜야 단축키 활성 ──
    ...(cfg.get('captureEnabled', false) ? [
      {
        label: `📸 영역 캡쳐 [${formatShortcutForDisplay(cfg.get('captureShortcut', 'CommandOrControl+Shift+S'))}]`,
        accelerator: cfg.get('captureShortcut', 'CommandOrControl+Shift+S'),
        click: () => startCapture(),
      },
    ] : []),
    {
      label: '📸 영역 캡쳐 기능 사용',
      type: 'checkbox',
      checked: cfg.get('captureEnabled', false),
      click: (item) => {
        cfg.set('captureEnabled', item.checked);
        const shortcut = cfg.get('captureShortcut', 'CommandOrControl+Shift+S');
        // 단축키 갱신
        try { globalShortcut.unregister(shortcut); } catch (_) {}
        if (item.checked) {
          try { globalShortcut.register(shortcut, () => startCapture()); } catch (_) {}
        }
        buildTrayMenu();
      },
    },
    ...(cfg.get('captureEnabled', false) ? [
      { label: '🎹 캡쳐 단축키 변경...', click: () => openShortcutSettings() },
      { label: '📁 캡쳐 폴더 열기 (Pictures\\대림에스엠 캡쳐)', click: () => {
        const os = require('os');
        const dir = cfg.get('captureSaveDir') || path.join(os.homedir(), 'Pictures', '대림에스엠 캡쳐');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        shell.openPath(dir);
      } },
    ] : []),
    { type: 'separator' },
    {
      label: '⚙ 설정',
      submenu: [
        {
          label: '항상 위에 표시 (기본값)',
          type: 'checkbox',
          checked: aotDefault,
          click: (item) => {
            cfg.set('alwaysOnTopDefault', item.checked);
            // 열려있는 창에도 적용
            for (const w of memoWindows.values()) {
              if (!w.isDestroyed()) w.setAlwaysOnTop(item.checked);
            }
          },
        },
        {
          label: 'Windows 시작 시 자동 실행',
          type: 'checkbox',
          checked: app.getLoginItemSettings().openAtLogin,
          click: (item) => {
            app.setLoginItemSettings({
              openAtLogin: item.checked,
              path: process.execPath,
            });
            cfg.set('autoStart', item.checked);
          },
        },
        {
          label: '⭐ 즐겨찾기 메모 자동 복원 (PC 간 동기화)',
          type: 'checkbox',
          checked: cfg.get('autoOpenPinned', true),
          click: (item) => cfg.set('autoOpenPinned', item.checked),
        },
        {
          label: '자석 스냅 (다른 메모창에 붙기)',
          type: 'checkbox',
          checked: cfg.get('snapEnabled', true),
          click: (item) => cfg.set('snapEnabled', item.checked),
        },
        { type: 'separator' },
        {
          label: 'ERP 서버 주소 변경...',
          click: () => promptServerUrl(),
        },
        {
          label: '로그아웃 (세션 초기화)',
          click: () => logout(),
        },
      ],
    },
    { type: 'separator' },
    {
      label: '🌐 ERP 웹에서 열기',
      click: () => shell.openExternal(getServerUrl() + '/#workspace'),
    },
    { type: 'separator' },
    {
      label: '종료',
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  trayInstance.setContextMenu(menu);
  trayInstance.setToolTip('대림에스엠 메모');
}

async function createNewMemo() {
  // 로그인 상태 확인
  const status = await checkLoggedIn();
  if (!status.loggedIn) {
    openLoginWindow();
    return;
  }
  // 새 페이지 생성 API 호출
  try {
    const cookies = await session.defaultSession.cookies.get({ url: getServerUrl() });
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const resp = await fetch(getServerUrl() + '/api/workspace/pages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({
        title: '메모 ' + new Date().toLocaleDateString('ko-KR'),
        emoji: '📝',
        content: { blocks: [{ type: 'paragraph', data: { text: '' } }] },
        userId: status.userId,
        userName: status.name,
      }),
    });
    const data = await resp.json();
    if (data.ok && data.id) {
      openMemoWindow(data.id, { title: '새 메모' });
    } else {
      dialog.showErrorBox('새 메모 만들기 실패', data.error || '서버 응답 오류');
    }
  } catch (e) {
    dialog.showErrorBox('새 메모 만들기 실패', e.message);
  }
}

function promptServerUrl() {
  // 간단한 prompt 구현 — BrowserWindow + form
  const promptWin = new BrowserWindow({
    width: 480,
    height: 220,
    title: 'ERP 서버 주소',
    modal: true,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });
  const html = `
    <html><body style="font-family:'Noto Sans KR',sans-serif;padding:20px;">
      <h3 style="margin:0 0 12px;">ERP 서버 주소</h3>
      <p style="font-size:12px;color:#6b7280;margin:0 0 12px;">사내망: http://192.168.0.133:3000<br>외부: 클라우드플레어 터널 URL</p>
      <input id="url" style="width:100%;padding:8px;font-size:13px;border:1px solid #ccc;border-radius:4px;" value="${getServerUrl()}" />
      <div style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px;">
        <button onclick="window.close()" style="padding:6px 14px;">취소</button>
        <button id="ok" style="padding:6px 14px;background:#4f6ef7;color:#fff;border:none;border-radius:4px;font-weight:600;">저장</button>
      </div>
      <script>
        document.getElementById('ok').onclick = () => {
          const url = document.getElementById('url').value.trim();
          if (url) window.electronAPI.setServerUrl(url);
          window.close();
        };
      </script>
    </body></html>
  `;
  promptWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
}

async function logout() {
  await session.defaultSession.clearStorageData({ storages: ['cookies'] });
  // 모든 메모창 닫기
  for (const w of memoWindows.values()) {
    if (!w.isDestroyed()) w.close();
  }
  memoWindows.clear();
  if (listWindow && !listWindow.isDestroyed()) listWindow.close();
  openLoginWindow();
}

function createTray() {
  // 트레이 아이콘 — tray-icon.png (16x16) 우선, 없으면 .ico, 그것도 없으면 빈 이미지
  const candidates = [
    path.join(__dirname, 'assets', 'tray-icon@2x.png'),
    path.join(__dirname, 'assets', 'tray-icon.png'),
    path.join(__dirname, 'build', 'tray-icon@2x.png'),
    path.join(__dirname, 'build', 'tray-icon.png'),
    path.join(__dirname, 'build', 'icon.ico'),
  ];
  let trayIcon = null;
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const img = nativeImage.createFromPath(p);
      if (!img.isEmpty()) {
        // 트레이 표준 크기로 리사이즈 (Windows: 16x16)
        trayIcon = img.resize({ width: 16, height: 16 });
        break;
      }
    }
  }
  if (!trayIcon) trayIcon = nativeImage.createEmpty();
  trayInstance = new Tray(trayIcon);
  buildTrayMenu();
  // 좌클릭으로도 메뉴 열림
  trayInstance.on('click', () => {
    trayInstance.popUpContextMenu();
  });
  trayInstance.on('double-click', () => {
    showMemoList();
  });
}

// ────────────────────────────────────────────────
// IPC 핸들러 (renderer 와 통신)
// ────────────────────────────────────────────────
ipcMain.handle('memo:get-server-url', () => getServerUrl());
ipcMain.handle('memo:set-server-url', (_e, url) => {
  cfg.set('serverUrl', url);
  // 기존 창 모두 닫고 새 URL 로 재시작
  for (const w of memoWindows.values()) {
    if (!w.isDestroyed()) w.close();
  }
  memoWindows.clear();
});
ipcMain.handle('memo:get-config', (_e, key) => cfg.get(key));
ipcMain.handle('memo:set-config', (_e, key, value) => cfg.set(key, value));

ipcMain.handle('memo:open', async (_e, pageId, title) => {
  openMemoWindow(pageId, { title });
});
ipcMain.handle('memo:close', (_e, pageId) => {
  const w = memoWindows.get(pageId);
  if (w && !w.isDestroyed()) w.close();
});
ipcMain.handle('memo:toggle-always-on-top', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return false;
  const next = !w.isAlwaysOnTop();
  w.setAlwaysOnTop(next);
  return next;
});
ipcMain.handle('memo:set-opacity', (e, opacity) => {
  // window opacity (0~1) — 진짜 투명도 (브라우저 popup 과 다름)
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  const v = Math.max(0.2, Math.min(1, parseFloat(opacity) || 1));
  w.setOpacity(v);
});
ipcMain.handle('memo:minimize-to-tray', (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  w.hide();
});
// 미니 모드 — 정확한 윈도우 크기 변경 + 세로 LOCK (드래그로 키워도 본문 안 나옴)
ipcMain.handle('memo:set-mini', (e, on, width, height) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  const W = Math.max(180, parseInt(width, 10) || 280);
  const H = Math.max(28, parseInt(height, 10) || 30);
  if (on) {
    // 미니 모드: 세로 LOCK — 가로만 리사이즈 가능, 세로는 헤더 높이로 고정
    // 순서 중요: 1) max 풀고 → 2) bounds → 3) min/max 잠금
    w.setMaximumSize(0, 0);                    // 일단 풀기 (이전 잠금 해제)
    w.setMinimumSize(180, H);                  // 가로 최소 180, 세로 = 미니 높이
    w.setBounds({ x: w.getBounds().x, y: w.getBounds().y, width: W, height: H });
    w.setMaximumSize(99999, H);                // 세로 LOCK (드래그해도 H 이상 안 늘어남)
  } else {
    // 복원: 세로 잠금 해제 + 원래 크기
    w.setMaximumSize(0, 0);                    // 세로 잠금 해제 (0,0 = unlimited)
    w.setMinimumSize(280, 200);
    w.setBounds({ x: w.getBounds().x, y: w.getBounds().y, width: W, height: H });
  }
});
ipcMain.handle('memo:list-pages', async () => {
  const status = await checkLoggedIn();
  if (!status.loggedIn) return { ok: false, error: 'not_logged_in' };
  try {
    const cookies = await session.defaultSession.cookies.get({ url: getServerUrl() });
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const resp = await fetch(getServerUrl() + '/api/workspace/pages?userId=' + encodeURIComponent(status.userId), {
      headers: { Cookie: cookieHeader },
    });
    const data = await resp.json();
    return data;
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
// 핀 토글 — 서버 우선, 실패 시 로컬 폴백
ipcMain.handle('memo:pin-toggle', async (_e, page) => {
  if (!page || !page.id) return false;
  try {
    const status = await checkLoggedIn();
    if (status.loggedIn) {
      const resp = await fetchWithCookies('/api/workspace/pinned/toggle', {
        method: 'POST',
        body: { memoId: page.id, title: page.title || '' },
      });
      if (resp.ok) {
        const data = await resp.json();
        if (data.ok) {
          cfg.set('pinnedPages', data.pinned || []);
          buildTrayMenu();
          return data.isPinned;
        }
      }
    }
  } catch (e) {
    console.warn('[pin-toggle] 서버 동기화 실패, 로컬만 적용:', e.message);
  }
  // 로컬 폴백
  const pinned = cfg.get('pinnedPages', []);
  const idx = pinned.findIndex(p => p.id === page.id);
  if (idx >= 0) pinned.splice(idx, 1);
  else pinned.push({ id: page.id, title: page.title });
  cfg.set('pinnedPages', pinned);
  buildTrayMenu();
  return pinned.some(p => p.id === page.id);
});
ipcMain.handle('memo:get-pinned', async () => {
  // 서버에서 최신 가져오고, 실패 시 로컬 캐시
  try {
    const status = await checkLoggedIn();
    if (status.loggedIn) {
      const resp = await fetchWithCookies('/api/workspace/pinned');
      if (resp.ok) {
        const data = await resp.json();
        if (data.ok) {
          cfg.set('pinnedPages', data.pinned || []);
          return data.pinned || [];
        }
      }
    }
  } catch (e) {}
  return cfg.get('pinnedPages', []);
});
ipcMain.handle('memo:logout', () => logout());
ipcMain.handle('memo:open-erp', () => shell.openExternal(getServerUrl()));
ipcMain.handle('memo:open-server-prompt', () => promptServerUrl());
ipcMain.handle('memo:create-new', () => createNewMemo());
ipcMain.handle('memo:do-login', (_e, userId, password) => doLogin(userId, password));

// ── 연락처 IPC ─────────────────────────────────
ipcMain.handle('contacts:list', async () => {
  try {
    const status = await checkLoggedIn();
    if (!status.loggedIn) return { ok: false, error: 'not_logged_in' };
    const resp = await fetchWithCookies('/api/contacts/all');
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const contacts = await resp.json();
    return { ok: true, contacts };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('contacts:tree', async () => {
  try {
    const status = await checkLoggedIn();
    if (!status.loggedIn) return { ok: false, error: 'not_logged_in' };
    const resp = await fetchWithCookies('/api/contacts/tree');
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    const tree = await resp.json();
    return { ok: true, tree };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('contacts:favorites', async () => {
  try {
    const status = await checkLoggedIn();
    if (!status.loggedIn) return { ok: false, error: 'not_logged_in' };
    const resp = await fetchWithCookies('/api/contacts/favorites');
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('contacts:toggle-favorite', async (_e, contactId) => {
  try {
    const status = await checkLoggedIn();
    if (!status.loggedIn) return { ok: false, error: 'not_logged_in' };
    const resp = await fetchWithCookies('/api/contacts/favorites/toggle', {
      method: 'POST',
      body: { contactId },
    });
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('contacts:open-widget', () => openContactsWidget());
ipcMain.handle('contacts:open-search', () => openContactsSearch());
ipcMain.handle('contacts:open-full', () => openContactsFull());

ipcMain.handle('memo:copy-text', (_e, text) => {
  try { clipboard.writeText(String(text || '')); return { ok: true }; }
  catch (e) { return { ok: false, error: e.message }; }
});

// ── 런처 / 워크스페이스 사이드바 / AI ──
ipcMain.handle('launcher:open', (_e, kind) => {
  if (kind === 'memo-list') showMemoList();
  else if (kind === 'contacts-widget') openContactsWidget();
  else if (kind === 'workspace-sidebar') openWorkspaceSidebar();
  else if (kind === 'ai-widget') openAIWidget();
  else if (kind === 'ocr-widget') openOcrWidget();
  else if (kind === 'statement-widget') openStatementWidget();
});

// OCR 실행 — multipart upload 를 메인 프로세스가 cookie 와 함께 서버에 프록시
ipcMain.handle('ocr:run', async (_e, payload) => {
  try {
    const status = await checkLoggedIn();
    if (!status.loggedIn) return { ok: false, error: 'not_logged_in' };
    const { imageBase64, mime, mode, filename } = payload || {};
    if (!imageBase64) return { ok: false, error: 'image required' };

    // base64 → Blob → FormData
    const bin = Buffer.from(imageBase64, 'base64');
    const FormData = globalThis.FormData;
    const Blob = globalThis.Blob;
    const form = new FormData();
    form.append('image', new Blob([bin], { type: mime || 'image/png' }), filename || 'ocr.png');
    form.append('mode', mode || 'plain');

    const cookies = await session.defaultSession.cookies.get({ url: getServerUrl() });
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');

    const resp = await fetch(getServerUrl() + '/api/ai/ocr', {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      body: form,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: 'HTTP ' + resp.status + (errText ? ' — ' + errText.slice(0, 200) : '') };
    }
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 명세서 OCR 빠른 등록 — 여러 파일을 기존 /api/statements/upload-batch 큐로 전달
ipcMain.handle('statements:upload', async (_e, payload) => {
  try {
    const status = await checkLoggedIn();
    if (!status.loggedIn) return { ok: false, error: 'not_logged_in' };
    const files = (payload && payload.files) || [];
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'files required' };

    const FormData = globalThis.FormData;
    const Blob = globalThis.Blob;
    const form = new FormData();
    for (const f of files) {
      if (!f || !f.base64) continue;
      const bin = Buffer.from(f.base64, 'base64');
      form.append('files', new Blob([bin], { type: f.mime || 'application/octet-stream' }), f.name || 'statement.bin');
    }

    const cookies = await session.defaultSession.cookies.get({ url: getServerUrl() });
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const resp = await fetch(getServerUrl() + '/api/statements/upload-batch', {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      body: form,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: 'HTTP ' + resp.status + (errText ? ' — ' + errText.slice(0, 200) : '') };
    }
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('statements:queue', async () => {
  try {
    const status = await checkLoggedIn();
    if (!status.loggedIn) return { ok: false, error: 'not_logged_in' };
    const resp = await fetchWithCookies('/api/statements/queue');
    if (!resp.ok) return { ok: false, error: 'HTTP ' + resp.status };
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

ipcMain.handle('statements:spell-check', async (_e, payload) => {
  try {
    const status = await checkLoggedIn();
    if (!status.loggedIn) return { ok: false, error: 'not_logged_in' };
    const files = (payload && payload.files) || [];
    if (!Array.isArray(files) || files.length === 0) return { ok: false, error: 'files required' };

    const FormData = globalThis.FormData;
    const Blob = globalThis.Blob;
    const form = new FormData();
    for (const f of files) {
      if (!f || !f.base64) continue;
      const bin = Buffer.from(f.base64, 'base64');
      form.append('files', new Blob([bin], { type: f.mime || 'application/octet-stream' }), f.name || 'design.png');
    }

    const cookies = await session.defaultSession.cookies.get({ url: getServerUrl() });
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const resp = await fetch(getServerUrl() + '/api/statements/spell-check', {
      method: 'POST',
      headers: { Cookie: cookieHeader },
      body: form,
    });
    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      return { ok: false, error: 'HTTP ' + resp.status + (errText ? ' — ' + errText.slice(0, 200) : '') };
    }
    return await resp.json();
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('statements:open-erp', () => shell.openExternal(getServerUrl() + '/#statements'));
ipcMain.handle('ai:open-full', () => openAIFull());

// ── 영역 캡쳐 IPC ──
ipcMain.handle('capture:start', () => startCapture());
ipcMain.handle('capture:cancel', () => closeCapture());
ipcMain.handle('capture:get-shortcut', () => ({
  shortcut: cfg.get('captureShortcut', 'CommandOrControl+Shift+S'),
  enabled: cfg.get('captureEnabled', false),
}));
ipcMain.handle('capture:set-shortcut', (_e, payload) => {
  try {
    const newShortcut = String((payload && payload.shortcut) || '').trim();
    if (!newShortcut) return { ok: false, error: '단축키 비어있음' };
    const oldShortcut = cfg.get('captureShortcut', 'CommandOrControl+Shift+S');
    // 기존 단축키 해제
    try { globalShortcut.unregister(oldShortcut); } catch (_) {}
    // 새 단축키 검증 + 등록
    let registered = false;
    try {
      registered = globalShortcut.register(newShortcut, () => startCapture());
    } catch (e) {
      // 실패 — 기존 것 복원
      try { globalShortcut.register(oldShortcut, () => startCapture()); } catch (_) {}
      return { ok: false, error: '단축키 등록 실패: ' + e.message };
    }
    if (!registered) {
      try { globalShortcut.register(oldShortcut, () => startCapture()); } catch (_) {}
      return { ok: false, error: '단축키가 이미 다른 곳에서 사용 중' };
    }
    cfg.set('captureShortcut', newShortcut);
    cfg.set('captureEnabled', true);
    buildTrayMenu();
    return { ok: true, shortcut: newShortcut };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});
ipcMain.handle('capture:crop', (_e, rect) => {
  try {
    if (!_lastCaptureImg) return { ok: false, error: '캡쳐 원본 없음' };
    const r = rect || {};
    const x = Math.max(0, Math.round(r.x || 0));
    const y = Math.max(0, Math.round(r.y || 0));
    const w = Math.max(1, Math.round(r.w || 1));
    const h = Math.max(1, Math.round(r.h || 1));
    const cropped = _lastCaptureImg.crop({ x, y, width: w, height: h });

    // 1. 클립보드 (Ctrl+V 로 붙여넣기 가능)
    clipboard.writeImage(cropped);

    // 2. 파일 자동 저장 — Pictures\대림에스엠 캡쳐\YYYY-MM-DD_HHmmss.png
    const os = require('os');
    let savedPath = null;
    try {
      const captureDir = cfg.get('captureSaveDir') || path.join(os.homedir(), 'Pictures', '대림에스엠 캡쳐');
      if (!fs.existsSync(captureDir)) fs.mkdirSync(captureDir, { recursive: true });
      const t = new Date();
      const pad = n => String(n).padStart(2, '0');
      const fname = `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}_${pad(t.getHours())}${pad(t.getMinutes())}${pad(t.getSeconds())}.png`;
      savedPath = path.join(captureDir, fname);
      fs.writeFileSync(savedPath, cropped.toPNG());
      console.log('[capture] 저장:', savedPath);
    } catch (e) {
      console.warn('[capture] 파일 저장 실패:', e.message);
    }

    closeCapture();
    return { ok: true, width: w, height: h, savedPath };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// 캡쳐 폴더 변경 / 열기
ipcMain.handle('capture:open-folder', () => {
  try {
    const os = require('os');
    const dir = cfg.get('captureSaveDir') || path.join(os.homedir(), 'Pictures', '대림에스엠 캡쳐');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
    return { ok: true, dir };
  } catch (e) {
    return { ok: false, error: e.message };
  }
});

// AI Agent SSE — 쿠키 직접 첨부해서 호출, 이벤트는 webContents.send 로 renderer에 전달
ipcMain.handle('ai:run', async (e, payload) => {
  const win = BrowserWindow.fromWebContents(e.sender);
  if (!win) return { ok: false, error: 'no window' };
  const { task, threadId } = payload || {};
  if (!task) return { ok: false, error: 'task 필수' };
  try {
    const status = await checkLoggedIn();
    if (!status.loggedIn) return { ok: false, error: '로그인 필요 — 트레이 → 설정 → 로그아웃 후 재로그인' };

    const cookies = await session.defaultSession.cookies.get({ url: getServerUrl() });
    const cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
    const resp = await fetch(getServerUrl() + '/api/ai/agent/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: cookieHeader },
      body: JSON.stringify({ task, threadId }),
    });
    if (!resp.ok) {
      const txt = await resp.text().catch(() => '');
      return { ok: false, error: 'HTTP ' + resp.status + (txt ? ' — ' + txt.slice(0, 200) : '') };
    }
    if (!resp.body || !resp.body.getReader) {
      // SSE 스트림이 아니면 일반 JSON 으로 처리
      const text = await resp.text().catch(() => '');
      win.webContents.send('ai:event', { event: 'text', data: { text } });
      win.webContents.send('ai:event', { event: 'end', data: {} });
      return { ok: true };
    }

    // SSE 파싱 — 비동기로 진행, 끝나면 'end' 이벤트
    (async () => {
      const reader = resp.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buf = '';
      let currentEvent = '';
      try {
        while (true) {
          if (win.isDestroyed()) return;
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const t = line.trimEnd();
            if (!t || t.startsWith(':')) continue;
            if (t.startsWith('event:')) currentEvent = t.slice(6).trim();
            else if (t.startsWith('data:')) {
              try {
                const data = JSON.parse(t.slice(5).trim());
                if (!win.isDestroyed()) win.webContents.send('ai:event', { event: currentEvent, data });
              } catch (_) {}
            }
          }
        }
      } catch (err) {
        if (!win.isDestroyed()) win.webContents.send('ai:event', { event: 'error', data: { error: err.message } });
      } finally {
        if (!win.isDestroyed()) win.webContents.send('ai:event', { event: 'end', data: {} });
      }
    })();

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ────────────────────────────────────────────────
// 앱 라이프사이클
// ────────────────────────────────────────────────
app.whenReady().then(async () => {
  // 기본 Electron 메뉴(File/Edit/View 등) 제거 — 메모 전용 앱이라 필요 없음
  Menu.setApplicationMenu(null);

  // 자동 시작 기본 ON — 첫 실행 시 자동 등록 (이미 사용자가 끈 적 있으면 그 설정 유지)
  if (!cfg.get('autoStartConfigured', false)) {
    app.setLoginItemSettings({ openAtLogin: true, path: process.execPath });
    cfg.set('autoStart', true);
    cfg.set('autoStartConfigured', true);
  }

  createTray();

  // 전역 단축키: Ctrl+Shift+F → 연락처 빠른 검색 팝업
  try {
    globalShortcut.register('CommandOrControl+Shift+F', async () => {
      const st = await checkLoggedIn();
      if (!st.loggedIn) { openLoginWindow(); return; }
      openContactsSearch();
    });
  } catch (e) {
    console.warn('globalShortcut F 등록 실패:', e.message);
  }
  // 전역 단축키 — 캡쳐 (기본 OFF, 사용자가 켤 때만 활성)
  if (cfg.get('captureEnabled', false)) {
    const shortcut = cfg.get('captureShortcut', 'CommandOrControl+Shift+S');
    try {
      globalShortcut.register(shortcut, () => startCapture());
      console.log('[capture] 단축키 등록:', shortcut);
    } catch (e) {
      console.warn('globalShortcut 캡쳐 등록 실패:', e.message);
    }
  }

  // 로그인 상태 확인
  const status = await checkLoggedIn();
  if (!status.loggedIn) {
    openLoginWindow();
  } else {
    // 시작 시 런처가 메인 화면
    openLauncher();
    // 즐겨찾기 메모 자동 복원 — 기본 ON. 서버에서 최신 핀 목록 가져와서 띄움 (PC 간 동기화)
    if (cfg.get('autoOpenPinned', true)) {
      try {
        const resp = await fetchWithCookies('/api/workspace/pinned');
        if (resp.ok) {
          const data = await resp.json();
          if (data.ok && Array.isArray(data.pinned)) {
            cfg.set('pinnedPages', data.pinned); // 로컬 캐시 갱신
            for (const p of data.pinned) openMemoWindow(p.id, { title: p.title });
          }
        }
      } catch (e) {
        // 서버 다운 등 — 로컬 캐시로 폴백
        console.warn('[autoOpenPinned] 서버 핀 가져오기 실패, 로컬 캐시 사용:', e.message);
        const pinned = cfg.get('pinnedPages', []);
        for (const p of pinned) openMemoWindow(p.id, { title: p.title });
      }
    }
  }
});

// 모든 창 닫혀도 트레이로 살아있음
app.on('window-all-closed', (e) => {
  if (!isQuitting) {
    // 트레이 모드 유지 — 종료 안 함
    return;
  }
  app.quit();
});

app.on('before-quit', () => {
  isQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) {}
});

// 비활성화/활성화 (macOS 호환)
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) showMemoList();
});
