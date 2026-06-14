// 대림에스엠 거래처찾기 PWA 서비스워커
// 캐시 정책:
//  (a) /api/contacts/m/all  -> network-first (성공 응답을 캐시에 보관, 오프라인 시 마지막 목록 반환)
//  (b) 그 외 /api/*          -> 항상 네트워크 (geocode·card-scan·card-register 등 절대 캐시 금지)
//  (c) 앱 셸/정적            -> cache-first
// 토큰/개인정보는 셸 + all목록 외에는 캐시하지 않는다.
const CACHE_VER = 'dcf-v1';
const APP_SHELL = [
  '/contacts-mobile.html',
  '/manifest.webmanifest',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_VER)
      .then((cache) => cache.addAll(APP_SHELL))
      .catch(() => {}) // 아이콘 등 일부 미존재 시에도 설치는 진행
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k !== CACHE_VER).map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  // GET 외 요청(POST 등)은 가로채지 않고 그대로 네트워크로
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // (a) 거래처 목록: network-first
  if (url.pathname.indexOf('/api/contacts/m/all') !== -1) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(CACHE_VER).then((cache) => cache.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => caches.match(req))
    );
    return;
  }

  // (b) 그 외 모든 /api/* 는 항상 네트워크 (캐시 금지)
  if (url.pathname.indexOf('/api/') !== -1) {
    event.respondWith(fetch(req));
    return;
  }

  // (c) 앱 셸/정적: cache-first (없으면 네트워크)
  event.respondWith(
    caches.match(req).then((cached) => cached || fetch(req))
  );
});
