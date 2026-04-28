/**
 * preload.js — Renderer ↔ Main process 안전한 브리지
 * contextIsolation 활성화 상태에서 IPC 노출
 */
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // 서버 URL
  getServerUrl: () => ipcRenderer.invoke('memo:get-server-url'),
  setServerUrl: (url) => ipcRenderer.invoke('memo:set-server-url', url),

  // 설정 (key/value)
  getConfig: (key) => ipcRenderer.invoke('memo:get-config', key),
  setConfig: (key, val) => ipcRenderer.invoke('memo:set-config', key, val),

  // 메모창 제어
  openMemo: (pageId, title) => ipcRenderer.invoke('memo:open', pageId, title),
  closeMemo: (pageId) => ipcRenderer.invoke('memo:close', pageId),
  toggleAlwaysOnTop: () => ipcRenderer.invoke('memo:toggle-always-on-top'),
  setOpacity: (opacity) => ipcRenderer.invoke('memo:set-opacity', opacity),
  minimizeToTray: () => ipcRenderer.invoke('memo:minimize-to-tray'),
  setMini: (on, w, h) => ipcRenderer.invoke('memo:set-mini', on, w, h),

  // 페이지 목록
  listPages: () => ipcRenderer.invoke('memo:list-pages'),

  // 즐겨찾기
  togglePin: (page) => ipcRenderer.invoke('memo:pin-toggle', page),
  getPinned: () => ipcRenderer.invoke('memo:get-pinned'),

  // 기타
  logout: () => ipcRenderer.invoke('memo:logout'),
  openErp: () => ipcRenderer.invoke('memo:open-erp'),
  openServerPrompt: () => ipcRenderer.invoke('memo:open-server-prompt'),
  createNewMemo: () => ipcRenderer.invoke('memo:create-new'),
  doLogin: (userId, password) => ipcRenderer.invoke('memo:do-login', userId, password),

  // 연락처 (3모드)
  contactsList: () => ipcRenderer.invoke('contacts:list'),
  contactsFavorites: () => ipcRenderer.invoke('contacts:favorites'),
  contactsToggleFavorite: (contactId) => ipcRenderer.invoke('contacts:toggle-favorite', contactId),
  contactsOpenWidget: () => ipcRenderer.invoke('contacts:open-widget'),
  contactsOpenSearch: () => ipcRenderer.invoke('contacts:open-search'),
  contactsOpenFull: () => ipcRenderer.invoke('contacts:open-full'),
  copyText: (text) => ipcRenderer.invoke('memo:copy-text', text),

  // 환경 정보
  isDesktopApp: true,
  platform: process.platform,
});
