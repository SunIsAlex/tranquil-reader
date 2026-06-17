/* ============================================================
   sw.js · Service Worker
   让「静读」可离线：
   - 预缓存应用外壳
   - books/*.json 使用 network-first，避免书架/高亮长期显示旧数据
   - 章节正文使用 stale-while-revalidate，读过后可离线重读
   - 用户手动离线下载的书保存在 tranquil-books，不随版本升级删除
   ============================================================ */

const VERSION = 'v10';

const SHELL_CACHE = `tranquil-shell-${VERSION}`;
const RUNTIME_CACHE = `tranquil-runtime-${VERSION}`;

// 用户主动“离线下载”的书放这里：不带版本号，跨 shell 升级保留。
const BOOKS_CACHE = 'tranquil-books';

// 应用外壳。改了这里面的文件后，记得 bump VERSION。
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
  'icons/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();

    await Promise.all(
      keys
        .filter((key) =>
          key !== SHELL_CACHE &&
          key !== RUNTIME_CACHE &&
          key !== BOOKS_CACHE
        )
        .map((key) => caches.delete(key))
    );

    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;

  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // 只处理同源资源
  if (url.origin !== self.location.origin) return;

  // APK 安装包直连下载，不放进运行时缓存
  if (url.pathname.endsWith('.apk')) return;

  // 页面导航：联网优先，离线时回退到缓存页面
  if (req.mode === 'navigate') {
    event.respondWith(handleNavigation(req));
    return;
  }

  // 书籍 JSON：network-first
  // 包括 books/manifest.json 和 books/<id>/highlights.json。
  if (url.pathname.includes('/books/') && url.pathname.endsWith('.json')) {
    event.respondWith(networkFirst(req, RUNTIME_CACHE));
    return;
  }

  // 章节正文：SWR
  // 读过一次后可离线，联网时后台更新。
  if (url.pathname.endsWith('.txt')) {
    event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
    return;
  }

  // 其它静态资源：SWR
  event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

async function handleNavigation(req) {
  try {
    return await fetch(req);
  } catch {
    return (
      await caches.match(req, { ignoreSearch: true }) ||
      await caches.match('index.html') ||
      Response.error()
    );
  }
}

async function networkFirst(req, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const res = await fetch(req, { cache: 'no-store' });

    if (res && res.ok) {
      await cache.put(req, res.clone());
    }

    return res;
  } catch {
    return (
      await caches.match(req) ||
      Response.error()
    );
  }
}

async function staleWhileRevalidate(req, cacheName) {
  const cache = await caches.open(cacheName);

  // 跨缓存查找：
  // - shell cache
  // - runtime cache
  // - tranquil-books 手动离线缓存
  const cached = await caches.match(req);

  const network = fetch(req)
    .then((res) => {
      if (res && res.ok) {
        cache.put(req, res.clone());
      }
      return res;
    })
    .catch(() => null);

  return cached || await network || Response.error();
}
