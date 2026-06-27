/* ============================================================
   sw.js · Service Worker
   让「静读」可离线：
   - 预缓存应用外壳
   - books/*.json 使用 network-first，避免书架/高亮长期显示旧数据
   - 章节正文使用 stale-while-revalidate，读过后可离线重读
   - 用户手动离线下载的书保存在 tranquil-books，不随版本升级删除
   ============================================================ */

const VERSION = 'v21';

const SHELL_CACHE = `tranquil-shell-${VERSION}`;
const RUNTIME_CACHE = `tranquil-runtime-${VERSION}`;

// 用户主动“离线下载”的书放这里：不带版本号，跨 shell 升级保留。
const BOOKS_CACHE = 'tranquil-books';
const OFFLINE_DOWNLOAD_START = 'OFFLINE_DOWNLOAD_START';
const OFFLINE_DOWNLOAD_PROGRESS = 'OFFLINE_DOWNLOAD_PROGRESS';
const offlineDownloadJobs = new Map();

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

  // Edge Function API: always pass through, never cache progress sync.
  if (url.pathname.endsWith('/api/progress')) return;

  // Manually downloaded PDFs are served from the persistent book cache.
  // Uncached PDFs keep their normal network/range behavior.
  if (url.pathname.endsWith('/api/pdf') || url.pathname.toLowerCase().endsWith('.pdf')) {
    event.respondWith(handlePDFRequest(req));
    return;
  }

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

  // 运行时代码：优先拿新版，避免修复后仍先执行旧 JS。
  if (/\.(?:js|mjs|css|wasm)$/i.test(url.pathname)) {
    event.respondWith(networkFirst(req, RUNTIME_CACHE));
    return;
  }

  // 其它静态资源：SWR
  event.respondWith(staleWhileRevalidate(req, RUNTIME_CACHE));
});

self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg.type !== OFFLINE_DOWNLOAD_START) return;

  const bookId = String(msg.bookId || '');
  const jobId = String(msg.jobId || '');
  const urls = Array.isArray(msg.urls) ? msg.urls.map(String).filter(Boolean) : [];
  if (!bookId || !jobId || !urls.length) return;

  event.waitUntil(startOfflineBookDownload(bookId, jobId, urls));
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

async function handlePDFRequest(req) {
  const cache = await caches.open(BOOKS_CACHE);
  const cached = await cache.match(req);

  if (!cached) return fetch(req);

  const range = req.headers.get('range');
  if (!range) return cached;

  return createRangeResponse(cached, range);
}

async function createRangeResponse(response, rangeHeader) {
  const buffer = await response.arrayBuffer();
  const size = buffer.byteLength;
  const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim());

  if (!match) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}` },
    });
  }

  let start;
  let end;

  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
  } else {
    const suffixLength = Number(match[2]);
    if (!suffixLength) {
      return new Response(null, {
        status: 416,
        headers: { 'content-range': `bytes */${size}` },
      });
    }
    start = Math.max(0, size - suffixLength);
    end = size - 1;
  }

  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    return new Response(null, {
      status: 416,
      headers: { 'content-range': `bytes */${size}` },
    });
  }

  end = Math.min(end, size - 1);
  const body = buffer.slice(start, end + 1);
  const headers = new Headers(response.headers);
  headers.set('accept-ranges', 'bytes');
  headers.set('content-length', String(body.byteLength));
  headers.set('content-range', `bytes ${start}-${end}/${size}`);

  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers,
  });
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

async function startOfflineBookDownload(bookId, jobId, urls) {
  const existing = offlineDownloadJobs.get(bookId);
  if (existing) {
    await broadcastOfflineDownload({
      jobId,
      bookId,
      status: 'downloading',
      done: existing.done,
      total: existing.total,
    });
    return existing.promise;
  }

  const job = {
    done: 0,
    total: urls.length,
    promise: null,
  };

  job.promise = downloadBookToCache(bookId, jobId, urls, job)
    .finally(() => offlineDownloadJobs.delete(bookId));

  offlineDownloadJobs.set(bookId, job);
  return job.promise;
}

async function downloadBookToCache(bookId, jobId, urls, job) {
  const cache = await caches.open(BOOKS_CACHE);

  await broadcastOfflineDownload({
    jobId,
    bookId,
    status: 'downloading',
    done: 0,
    total: urls.length,
  });

  try {
    for (const url of urls) {
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${url} (${res.status})`);
      await cache.put(url, res.clone());

      job.done += 1;
      await broadcastOfflineDownload({
        jobId,
        bookId,
        status: 'downloading',
        done: job.done,
        total: urls.length,
      });
    }

    await broadcastOfflineDownload({
      jobId,
      bookId,
      status: 'done',
      done: urls.length,
      total: urls.length,
    });
  } catch (err) {
    await broadcastOfflineDownload({
      jobId,
      bookId,
      status: 'error',
      done: job.done,
      total: urls.length,
      error: String(err && err.message || err),
    });
    throw err;
  }
}

async function broadcastOfflineDownload(payload) {
  const clients = await self.clients.matchAll({
    type: 'window',
    includeUncontrolled: true,
  });

  for (const client of clients) {
    client.postMessage({
      type: OFFLINE_DOWNLOAD_PROGRESS,
      ...payload,
    });
  }
}
