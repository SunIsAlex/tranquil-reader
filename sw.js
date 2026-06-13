/* ============================================================
   sw.js · Service Worker
   让"静读"可离线：预缓存应用外壳，按需缓存读过的书目与正文。
   改动了 shell 文件后，把 VERSION 加一即可让旧缓存失效。
   ============================================================ */

const VERSION = 'v1';
const SHELL_CACHE = `tranquil-shell-${VERSION}`;
const RUNTIME_CACHE = `tranquil-runtime-${VERSION}`;

// 应用外壳：装好就能离线打开页面（书目/正文按读到的再运行时缓存）
const SHELL = [
  './',
  'index.html',
  'reader.html',
  'css/style.css',
  'js/common.js',
  'js/shelf.js',
  'js/reader.js',
  'manifest.webmanifest',
  'favicon.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then((c) => c.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // 跨域请求不拦截

  // 1) 页面导航：联网优先，离线时回退到缓存的外壳（忽略 ?book= 等查询串）
  if (req.mode === 'navigate') {
    e.respondWith((async () => {
      try {
        return await fetch(req);
      } catch {
        return (await caches.match(req, { ignoreSearch: true }))
            || (await caches.match('index.html'))
            || Response.error();
      }
    })());
    return;
  }

  // 2) 书目与章节正文：stale-while-revalidate
  //    （先给缓存、后台更新；读过一次后即可离线重读）
  if (url.pathname.endsWith('books/manifest.json') || url.pathname.endsWith('.txt')) {
    e.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // 3) 其它同源静态资源（CSS/JS/图标）：同样 SWR，离线可用又能后台更新
  e.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await caches.match(req);   // 命中任意缓存（含预缓存的外壳）
  const network = fetch(req).then((res) => {
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  }).catch(() => null);
  return cached || (await network) || Response.error();
}
