// Service Worker：アプリ本体をキャッシュして、電波がなくても開けるようにする。
// ファイルを追加・変更したら CACHE_VERSION を上げる（tests/sw.test.js が一覧の漏れを確認する）。
const CACHE_VERSION = 'v23';
const CACHE_NAME = `basket-analyst-${CACHE_VERSION}`;

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/style.css',
  './js/ai.js',
  './js/app.js',
  './js/backup.js',
  './js/clock.js',
  './js/court.js',
  './js/lineup.js',
  './js/court-svg.js',
  './js/db.js',
  './js/demo.js',
  './js/input.js',
  './js/insights.js',
  './js/advice.js',
  './js/report.js',
  './js/model.js',
  './js/qa.js',
  './js/qa-print.js',
  './js/qa-data.js',
  './js/review.js',
  './js/stats.js',
  './js/sync-core.js',
  './js/sync.js',
  './js/ui.js',
  './js/update.js',
  './js/views/account.js',
  './js/views/diagram.js',
  './js/views/home.js',
  './js/views/insight-view.js',
  './js/views/qa.js',
  './js/views/qa-print.js',
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

// 設定画面の「アプリの版」：いま動いている版を答える
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'version' && event.ports && event.ports[0]) {
    event.ports[0].postMessage({ version: CACHE_VERSION });
  }
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('basket-analyst-') && k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

/** アプリの画面として開くパス（/ や index.html）。拡張子のあるファイル（.pdf など）は含めない */
function isAppPage(pathname) {
  return !/\.[a-z0-9]+$/i.test(pathname) || /\.html?$/i.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // AI（Worker）などほかのサイトへの通信はそのまま

  // 画面の読み込みは index.html を返す（ハッシュで画面を切り替えるため）。印刷用 PDF などのファイルはそのまま開く
  if (req.mode === 'navigate' && isAppPage(url.pathname)) {
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
