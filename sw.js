// Service Worker：アプリ本体をキャッシュして、電波がなくても開けるようにする。
// ファイルを追加・変更したら CACHE_VERSION を上げる（tests/sw.test.js が一覧の漏れを確認する）。
const CACHE_VERSION = 'v13';
const CACHE_NAME = `basket-analyst-${CACHE_VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/ai.js',
  './js/app.js',
  './js/backup.js',
  './js/court.js',
  './js/court-svg.js',
  './js/db.js',
  './js/demo.js',
  './js/input.js',
  './js/insights.js',
  './js/model.js',
  './js/qa.js',
  './js/qa-data.js',
  './js/review.js',
  './js/stats.js',
  './js/ui.js',
  './js/views/diagram.js',
  './js/views/home.js',
  './js/views/insight-view.js',
  './js/views/qa.js',
  './js/views/quarter.js',
  './js/views/record.js',
  './js/views/review.js',
  './js/views/settings.js',
  './js/views/setup.js',
  './js/views/shared.js',
  './js/views/summary.js',
  './js/views/video-editor.js',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('basket-analyst-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // AI（Worker）などほかのサイトへの通信はそのまま

  // 画面の読み込みは index.html を返す（ハッシュで画面を切り替えるため）
  if (req.mode === 'navigate') {
    event.respondWith(
      caches.match('./index.html').then((cached) => cached || fetch(req)),
    );
    return;
  }

  // それ以外はキャッシュ優先、なければ通信してキャッシュに足す
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((cached) => {
      if (cached) return cached;
      return fetch(req).then((res) => {
        if (res && res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        }
        return res;
      });
    }),
  );
});
