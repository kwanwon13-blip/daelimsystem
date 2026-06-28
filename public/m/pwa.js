// public/m/pwa.js — 모바일 PWA 공통: 서비스워커 등록 + 웹푸시 켜기/상태
// 기존 인프라 재사용: /sw.js(푸시 수신·notificationclick), /api/push/* (구독), utils/notify(발송)
(function () {
  function supported() {
    try {
      return ('serviceWorker' in navigator) && ('PushManager' in window)
        && (typeof Notification !== 'undefined') && window.isSecureContext;
    } catch (_) { return false; }
  }

  function registerSW() {
    try { if ('serviceWorker' in navigator) return navigator.serviceWorker.register('/sw.js'); }
    catch (_) {}
    return Promise.resolve(null);
  }

  function b64ToU8(b64) {
    var pad = '='.repeat((4 - b64.length % 4) % 4);
    var s = (b64 + pad).replace(/-/g, '+').replace(/_/g, '/');
    var raw = atob(s), arr = new Uint8Array(raw.length);
    for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  }

  // 'unsupported' | 'denied' | 'on' | 'off'
  async function state() {
    if (!supported()) return 'unsupported';
    if (Notification.permission === 'denied') return 'denied';
    try {
      var reg = await navigator.serviceWorker.getRegistration();
      var sub = reg ? await reg.pushManager.getSubscription() : null;
      return sub ? 'on' : 'off';
    } catch (_) { return 'off'; }
  }

  async function enable() {
    if (!supported()) {
      alert('지금 접속(사내 와이파이 http)에선 알림을 켤 수 없어요.\n\n폰에서 erp.daelimsm.com (https)로 접속하면 켜집니다.\n· 안드로이드: 홈 화면 추가 없이 크롬에서 바로 켜짐\n· 아이폰: 홈 화면에 추가한 뒤 켜기');
      return 'unsupported';
    }
    try {
      var perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        alert(perm === 'denied'
          ? '알림이 차단돼 있습니다. 브라우저/설정에서 이 사이트 알림을 허용으로 바꿔주세요.'
          : '알림 권한이 허용되지 않았습니다.');
        return perm === 'denied' ? 'denied' : 'off';
      }
      var reg = await navigator.serviceWorker.register('/sw.js');
      await navigator.serviceWorker.ready;
      var r = await fetch('/api/push/vapid-public-key', { credentials: 'same-origin' });
      var j = await r.json();
      if (!j || !j.key) { alert('서버 푸시가 아직 준비되지 않았습니다.\n(관리자: web-push 설치 + 재시작 필요)'); return 'off'; }
      var sub = await reg.pushManager.getSubscription();
      if (!sub) {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: b64ToU8(j.key),
        });
      }
      var sr = await fetch('/api/push/subscribe', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin', body: JSON.stringify({ subscription: sub }),
      });
      if (sr.ok) { alert('알림을 켰습니다 ✅\n앱을 꺼둬도 새 픽업·작업이 오면 이 폰으로 알려드립니다.'); return 'on'; }
      alert('구독 저장에 실패했습니다. 잠시 후 다시 시도해주세요.'); return 'off';
    } catch (e) {
      alert('알림 켜기 실패: ' + ((e && e.message) || e)); return 'off';
    }
  }

  // ── 앱 설치(홈 화면 추가) — 안드로이드 크롬은 한 번 탭으로 설치 ──
  var deferredInstall = null;
  function isStandalone() {
    try { return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true; }
    catch (_) { return false; }
  }
  function isIOS() {
    try { return /iphone|ipad|ipod/i.test(navigator.userAgent) && !window.MSStream; } catch (_) { return false; }
  }
  // 크롬이 설치 가능해지면 이 이벤트가 옴 → 가로채서 우리 버튼으로 띄움
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    deferredInstall = e;
    try { window.dispatchEvent(new Event('erp-installable')); } catch (_) {}
  });
  window.addEventListener('appinstalled', function () {
    deferredInstall = null;
    try { window.dispatchEvent(new Event('erp-installed')); } catch (_) {}
  });
  function canInstall() { return !!deferredInstall && !isStandalone(); }
  async function install() {
    if (!deferredInstall) return 'unavailable';
    try {
      deferredInstall.prompt();
      var res = await deferredInstall.userChoice;
      deferredInstall = null;
      return (res && res.outcome) || 'dismissed';   // 'accepted' | 'dismissed'
    } catch (_) { return 'error'; }
  }

  // 페이지 로드 시 서비스워커 자동 등록(홈화면 설치 + 푸시 수신 기반)
  registerSW();
  window.erpPwa = {
    supported: supported, state: state, enable: enable, registerSW: registerSW,
    canInstall: canInstall, install: install, isStandalone: isStandalone, isIOS: isIOS,
  };
})();
