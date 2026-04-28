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

const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage, session, dialog, clipboard, globalShortcut } = require('electron');
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

// 로그인 처리 — IPC 로 호출됨, 성공하면 자동으로 로그인 창 닫고 메모 목록 띄움
async function doLogin(userId, password) {
  try {
    const url = getServerUrl() + '/api/auth/login';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, password }),
    });

    // Set-Cookie 헤더 → Electron session 으로 저장
    // (Node.js fetch 에선 자동 안 됨. 헤더 파싱해서 직접 저장)
    const setCookieHeaders = resp.headers.getSetCookie ? resp.headers.getSetCookie() : (resp.headers.raw ? resp.headers.raw()['set-cookie'] : []);
    if (Array.isArray(setCookieHeaders) && setCookieHeaders.length) {
      const targetUrl = new URL(getServerUrl());
      for (const ck of setCookieHeaders) {
        const m = ck.match(/^([^=]+)=([^;]+)/);
        if (!m) continue;
        const name = m[1].trim();
        const value = m[2].trim();
        try {
          await session.defaultSession.cookies.set({
            url: getServerUrl(),
            name, value,
            domain: targetUrl.hostname,
            path: '/',
            httpOnly: ck.toLowerCase().includes('httponly'),
            secure: ck.toLowerCase().includes('secure'),
          });
        } catch (e) {
          console.warn('cookie set failed:', e.message);
        }
      }
    }

    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.error) {
      return { ok: false, error: data.error || ('HTTP ' + resp.status) };
    }

    // 로그인 성공 — 로그인 창 닫고 트레이 + 메모 목록 띄움
    if (loginWindow && !loginWindow.isDestroyed()) {
      try { loginWindow.close(); } catch(_) {}
    }
    buildTrayMenu();
    showMemoList();

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
    minWidth: 300,           // 헤더 버튼들이 다 보이는 최소 크기
    minHeight: 50,           // 미니 모드 최소
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
// 자석 스냅 — 다른 메모창 / 화면 가장자리 근처에서 정렬
// ────────────────────────────────────────────────
const SNAP_THRESHOLD = 16;  // 16px 이내면 스냅
function snapWindow(win, finalize = false) {
  if (!win || win.isDestroyed()) return;
  const me = win.getBounds();
  const { screen } = require('electron');
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

  // 2. 다른 메모창과 스냅
  for (const other of memoWindows.values()) {
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
// 메모 목록 창 (트레이 → "📋 내 메모")
// ────────────────────────────────────────────────
function showMemoList() {
  if (listWindow && !listWindow.isDestroyed()) {
    listWindow.focus();
    return;
  }
  listWindow = new BrowserWindow({
    width: 380,
    height: 540,
    title: '내 메모',
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
  const s = getSavedState('__launcher', { width: 360, height: 80 });
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
    { label: '📋 전체 메모 목록...', click: () => showMemoList() },
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
    { label: '🚀 런처 (4버튼 박스)', click: () => openLauncher() },
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
// 미니 모드 — 정확한 윈도우 크기 변경 (minHeight 제약 임시 해제)
ipcMain.handle('memo:set-mini', (e, on, width, height) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w) return;
  const W = Math.max(180, parseInt(width, 10) || 280);
  const H = Math.max(28, parseInt(height, 10) || 30);
  if (on) {
    // 미니: minHeight 를 충분히 작게 (28px = 헤더만)
    w.setMinimumSize(180, 28);
    const b = w.getBounds();
    w.setBounds({ x: b.x, y: b.y, width: W, height: H });
    w.setResizable(true); // 가로 드래그 리사이즈 가능
  } else {
    // 복원: 원래 minHeight
    w.setMinimumSize(280, 200);
    const b = w.getBounds();
    w.setBounds({ x: b.x, y: b.y, width: W, height: H });
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
ipcMain.handle('memo:pin-toggle', (_e, page) => {
  const pinned = cfg.get('pinnedPages', []);
  const idx = pinned.findIndex(p => p.id === page.id);
  if (idx >= 0) {
    pinned.splice(idx, 1);
  } else {
    pinned.push({ id: page.id, title: page.title });
  }
  cfg.set('pinnedPages', pinned);
  buildTrayMenu();
  return pinned.some(p => p.id === page.id);
});
ipcMain.handle('memo:get-pinned', () => cfg.get('pinnedPages', []));
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
});
ipcMain.handle('ai:open-full', () => openAIFull());

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
  // (다른 앱에서도 동작 — 시스템 어디서든 호출 가능)
  try {
    globalShortcut.register('CommandOrControl+Shift+F', async () => {
      const st = await checkLoggedIn();
      if (!st.loggedIn) {
        openLoginWindow();
        return;
      }
      openContactsSearch();
    });
  } catch (e) {
    console.warn('globalShortcut 등록 실패:', e.message);
  }

  // 로그인 상태 확인
  const status = await checkLoggedIn();
  if (!status.loggedIn) {
    openLoginWindow();
  } else {
    // 로그인된 상태 — 즐겨찾기 메모 자동 띄우기
    const pinned = cfg.get('pinnedPages', []);
    for (const p of pinned) openMemoWindow(p.id, { title: p.title });
    // 런처 자동 띄우기 (사용자가 끈 적 없으면)
    if (cfg.get('autoOpenLauncher', true)) {
      openLauncher();
    } else if (pinned.length === 0) {
      // 런처도 안 띄우는데 즐겨찾기도 없으면 메모 목록 보여주기
      showMemoList();
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
