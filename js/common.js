/* ============================================================
   common.js · 通用工具
   主题切换、localStorage 进度存取，被两个页面共用
   ============================================================ */

const Store = {
  THEME_KEY: 'reader.theme',
  LAST_KEY: 'reader.lastProgress',
  BOOKMARK_PREFIX: 'reader.bookmarks.',
  fontKey: 'reader.fontSize',

  // 进度键：每本书一份。结构 { chapter: number, para: number, scroll: number, time: number }
  progressKey(bookId) { return `reader.progress.${bookId}`; },

  getProgress(bookId) {
    try { return JSON.parse(localStorage.getItem(this.progressKey(bookId))) || null; }
    catch { return null; }
  },
  getLastProgress() {
    try { return JSON.parse(localStorage.getItem(this.LAST_KEY)) || null; }
    catch { return null; }
  },
  bookmarkKey(bookId) { return `${this.BOOKMARK_PREFIX}${bookId}`; },
  normalizeBookmark(item) {
    if (!item || typeof item !== 'object') return null;
    if (!Number.isInteger(item.chapter) || item.chapter < 0) return null;
    if (!Number.isInteger(item.para) || item.para < 0) return null;

    return {
      id: String(item.id || `${item.chapter}:${item.para}`),
      chapter: item.chapter,
      para: item.para,
      note: String(item.note || ''),
      excerpt: String(item.excerpt || ''),
      createdAt: Number.isFinite(item.createdAt) ? item.createdAt : Date.now(),
      updatedAt: Number.isFinite(item.updatedAt) ? item.updatedAt : null,
    };
  },
  getBookmarks(bookId) {
    try {
      const data = JSON.parse(localStorage.getItem(this.bookmarkKey(bookId)));
      if (!Array.isArray(data)) return [];
      return data.map(item => this.normalizeBookmark(item)).filter(Boolean);
    } catch {
      return [];
    }
  },
  setBookmarks(bookId, items) {
    try {
      const normalized = Array.isArray(items)
        ? items.map(item => this.normalizeBookmark(item)).filter(Boolean)
        : [];
      localStorage.setItem(this.bookmarkKey(bookId), JSON.stringify(normalized));
    } catch { /* 隐私模式或配额满，静默失败 */ }
  },
  setProgress(bookId, data) {
    try {
      const normalized = {
        chapter: Number.isInteger(data.chapter) ? data.chapter : 0,
        para: Number.isInteger(data.para) ? data.para : 0,
        scroll: Number.isFinite(data.scroll) ? data.scroll : 0,
        time: Number.isFinite(data.time) ? data.time : Date.now(),
      };

      localStorage.setItem(this.progressKey(bookId), JSON.stringify(normalized));
      localStorage.setItem(this.LAST_KEY, JSON.stringify({
        book: bookId,
        ...normalized,
      }));
    } catch { /* 隐私模式或配额满，静默失败 */ }
  },
  getAllProgress() {
    const progress = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('reader.progress.')) continue;
        const bookId = key.slice('reader.progress.'.length);
        if (!bookId) continue;

        const item = JSON.parse(localStorage.getItem(key));
        if (!item || typeof item !== 'object') continue;
        if (!Number.isInteger(item.chapter)) continue;

        progress[bookId] = {
          chapter: item.chapter,
          para: Number.isInteger(item.para) ? item.para : 0,
          scroll: Number.isFinite(item.scroll) ? item.scroll : 0,
          time: Number.isFinite(item.time) ? item.time : Date.now(),
        };
      }
    } catch { /* ignore partial localStorage failures */ }

    return progress;
  },
  getAllBookmarks() {
    const bookmarks = {};
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(this.BOOKMARK_PREFIX)) continue;
        const bookId = key.slice(this.BOOKMARK_PREFIX.length);
        if (!bookId) continue;
        bookmarks[bookId] = this.getBookmarks(bookId);
      }
    } catch { /* ignore partial localStorage failures */ }

    return bookmarks;
  },
  applyProgressSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return 0;

    const progress = snapshot.progress || {};
    let count = 0;

    try {
      for (const [bookId, item] of Object.entries(progress)) {
        if (!item || typeof item !== 'object') continue;
        if (!Number.isInteger(item.chapter)) continue;
        localStorage.setItem(this.progressKey(bookId), JSON.stringify({
          chapter: item.chapter,
          para: Number.isInteger(item.para) ? item.para : 0,
          scroll: Number.isFinite(item.scroll) ? item.scroll : 0,
          time: Number.isFinite(item.time) ? item.time : Date.now(),
        }));
        count += 1;
      }

      const last = snapshot.lastProgress;
      if (last && last.book && progress[last.book]) {
        localStorage.setItem(this.LAST_KEY, JSON.stringify({
          book: String(last.book),
          ...progress[last.book],
        }));
      }
    } catch { /* ignore storage failures */ }

    return count;
  },
  applyBookmarkSnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return 0;
    const bookmarkMap = snapshot.bookmarks;
    // Old sync records do not contain this field. Leave local bookmarks untouched.
    if (!bookmarkMap || typeof bookmarkMap !== 'object' || Array.isArray(bookmarkMap)) return 0;

    let count = 0;
    try {
      for (const [bookId, items] of Object.entries(bookmarkMap)) {
        if (!Array.isArray(items)) continue;
        const normalized = items.map(item => this.normalizeBookmark(item)).filter(Boolean);
        this.setBookmarks(bookId, normalized);
        count += normalized.length;
      }
    } catch { /* ignore storage failures */ }

    return count;
  },
  progressSnapshot() {
    return {
      progress: this.getAllProgress(),
      lastProgress: this.getLastProgress(),
      bookmarks: this.getAllBookmarks(),
    };
  },
  readerURL(bookId, progress = null) {
    const p = progress || this.getProgress(bookId) || {};
    const chapter = Number.isInteger(p.chapter) ? p.chapter : 0;
    const para = Number.isInteger(p.para) && p.para > 0 ? `#p${p.para}` : '';
    return `reader.html?book=${encodeURIComponent(bookId)}&chapter=${chapter}${para}`;
  },

  getFontSize() {
    const v = parseFloat(localStorage.getItem(this.fontKey));
    return Number.isFinite(v) ? v : 1.12;
  },
  setFontSize(rem) { localStorage.setItem(this.fontKey, String(rem)); },
};

/* ---------- 阅读进度同步 ---------- */
const ProgressSync = {
  API: 'api/progress',

  normalizeCode(code) {
    return String(code || '').trim().toLowerCase();
  },

  validCode(code) {
    return /^[a-z0-9][a-z0-9_]{3,31}$/.test(this.normalizeCode(code));
  },

  async save(code) {
    code = this.normalizeCode(code);
    if (!this.validCode(code)) throw new Error('同步码需为 4-32 位字母、数字或下划线');

    const snapshot = Store.progressSnapshot();
    const count = Object.keys(snapshot.progress).length;
    const bookmarkCount = Object.values(snapshot.bookmarks)
      .reduce((total, items) => total + items.length, 0);
    if (!count) throw new Error('没有可保存的阅读进度');

    const res = await fetch(this.API, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({ code, ...snapshot }),
    });

    const data = await readSyncResponse(res);
    return {
      code,
      count: data.count || count,
      bookmarkCount: Number.isInteger(data.bookmarkCount) ? data.bookmarkCount : bookmarkCount,
      updatedAt: data.updatedAt || Date.now(),
    };
  },

  async restore(code) {
    code = this.normalizeCode(code);
    if (!this.validCode(code)) throw new Error('同步码需为 4-32 位字母、数字或下划线');

    const res = await fetch(`${this.API}?code=${encodeURIComponent(code)}`, {
      cache: 'no-store',
    });

    const data = await readSyncResponse(res);
    const count = Store.applyProgressSnapshot(data);
    const bookmarkCount = Store.applyBookmarkSnapshot(data);
    if (!count) throw new Error('没有可恢复的阅读进度');

    return {
      code,
      count,
      bookmarkCount,
      updatedAt: data.updatedAt || null,
      lastProgress: data.lastProgress || null,
    };
  },
};

async function readSyncResponse(res) {
  let data = null;
  try { data = await res.json(); }
  catch { /* ignore invalid response body */ }

  if (!res.ok || !data || data.ok === false) {
    throw new Error((data && data.error) || `同步请求失败（${res.status}）`);
  }

  return data;
}

/* ---------- 离线下载 ---------- */
// 把整本书（清单 + 各章正文）写入持久缓存 tranquil-books，
// sw.js 经 caches.match 读取，无网络时也能完整阅读。
const Offline = {
  CACHE: 'tranquil-books',
  STATE_PREFIX: 'reader.offlineDownload.',
  MSG_START: 'OFFLINE_DOWNLOAD_START',
  MSG_PROGRESS: 'OFFLINE_DOWNLOAD_PROGRESS',
  MSG_ENABLE_NOTIFICATION: 'OFFLINE_DOWNLOAD_ENABLE_NOTIFICATION',

  // 浏览器是否支持（需 Cache API；非安全上下文下 caches 不可用）
  supported() { return typeof caches !== 'undefined'; },

  notificationSupported() {
    return (
      isStandaloneApp() &&
      'Notification' in window &&
      'serviceWorker' in navigator
    );
  },

  // 通知权限必须由用户手势触发。仅在已安装的 PWA/TWA 中请求，
  // 普通浏览器仍使用书架按钮本身显示进度。
  async requestNotificationPermission() {
    if (!this.notificationSupported()) return false;
    if (Notification.permission === 'granted') return true;
    if (Notification.permission === 'denied') return false;

    try {
      return await Notification.requestPermission() === 'granted';
    } catch {
      return false;
    }
  },

  notificationPermissionGranted() {
    return this.notificationSupported() && Notification.permission === 'granted';
  },

  backgroundFetchSupported() {
    return (
      'serviceWorker' in navigator &&
      'BackgroundFetchManager' in window
    );
  },

  async enableDownloadNotification(book) {
    if (!this.notificationPermissionGranted()) return;

    try {
      const registration = await navigator.serviceWorker.ready;
      const worker =
        navigator.serviceWorker.controller ||
        registration.active ||
        registration.waiting ||
        registration.installing;
      if (!worker) return;

      worker.postMessage({
        type: this.MSG_ENABLE_NOTIFICATION,
        bookId: String(book.id || ''),
        bookTitle: String(book.title || book.name || book.id || ''),
      });
    } catch { /* notification is best-effort */ }
  },

  canDownload(book) {
    const isPDF = book && (
      book.type === 'pdf' ||
      typeof book.pdfUrl === 'string' ||
      Array.isArray(book.parts)
    );
    if (!isPDF) return true;

    const sources = Array.isArray(book.parts) && book.parts.length
      ? book.parts
      : [book];

    return sources.length > 0 && sources.every(source => {
      if (!source || typeof source !== 'object') return false;
      const pdfUrl = typeof source.pdfUrl === 'string' ? source.pdfUrl.trim() : '';
      return Boolean(pdfUrl && !isExternalURL(pdfUrl));
    });
  },

  // 该书需要离线的全部 URL。manifest 由运行时缓存单独维护，
  // 其它资源使用书籍版本号生成精确、可失效的缓存键。
  urls(book) {
    const list = [];

    const coverFile = typeof book.cover === 'string' ? book.cover : '';
    const coverThumbFile = typeof book.coverThumb === 'string' ? book.coverThumb : '';
    const shelfCoverFile = coverThumbFile || coverFile;

    // Cache the small shelf thumbnail. The full cover still opens on demand,
    // but is not downloaded automatically when a thumbnail exists.
    if (shelfCoverFile && !isExternalURL(shelfCoverFile)) {
      list.push(withBookVersion(`books/${book.id}/${shelfCoverFile}`, book));
    }

    const highlightsFile =
      typeof book.highlightsFile === 'string' ? book.highlightsFile :
      typeof book.highlights === 'string' ? book.highlights :
      '';

    if (highlightsFile) {
      list.push(withBookVersion(`books/${book.id}/${highlightsFile}`, book));
    }

    for (const ch of (book.chapters || [])) {
      list.push(withBookVersion(`books/${book.id}/${ch.file}`, book, ch));
    }

    list.push(...this.pdfUrls(book));

    return [...new Set(list)];
  },

  pdfUrls(book) {
    const sources = Array.isArray(book.parts) && book.parts.length
      ? book.parts
      : [book];
    const urls = [];

    for (const source of sources) {
      if (!source || typeof source !== 'object') continue;

      const pdfUrl = typeof source.pdfUrl === 'string' ? source.pdfUrl.trim() : '';
      if (pdfUrl && !isExternalURL(pdfUrl)) {
        urls.push(withBookVersion(pdfUrl, book, source));
      }
    }

    return urls;
  },

  // 是否已完整缓存当前版本的正文/PDF 等书籍资源。
  async isDownloaded(book) {
    if (!this.supported()) return false;
    try {
      const cache = await caches.open(this.CACHE);
      for (const u of this.urls(book)) {
        if (!(await cache.match(u))) return false;
      }
      return true;
    } catch { return false; }
  },

  // 逐个抓取并写入缓存；onProgress(done, total) 用于显示进度
  async download(book, onProgress, options = {}) {
    const urls = this.urls(book);
    const nativeBackground = await this.downloadInBackgroundFetch(book, urls, onProgress);
    if (nativeBackground !== null) return;

    const serviceWorkerDownload =
      await this.downloadInServiceWorker(book, urls, onProgress, options);
    if (serviceWorkerDownload) return;

    return this.downloadInPage(book, urls, onProgress);
  },

  // Background Fetch 由浏览器/系统接管传输，即使页面关闭或 Service Worker
  // 被回收也能继续下载。Chrome/Android 支持时优先使用；其它浏览器仍走
  // 下方可断点续传的 Service Worker / 页面兼容路径。
  async downloadInBackgroundFetch(book, urls, onProgress) {
    if (!this.backgroundFetchSupported()) return null;

    let registration;
    try {
      registration = await navigator.serviceWorker.ready;
    } catch {
      return null;
    }
    const manager = registration.backgroundFetch;
    if (!manager || typeof manager.fetch !== 'function') return null;

    const cache = await caches.open(this.CACHE);
    const missingUrls = [];
    for (const url of urls) {
      if (!(await cache.match(url))) missingUrls.push(url);
    }

    if (!missingUrls.length) {
      this.setDownloadState(book.id, {
        status: 'done',
        done: urls.length,
        total: urls.length,
      });
      if (onProgress) onProgress(urls.length, urls.length);
      return true;
    }

    const bookId = String(book.id || '');
    const cachedDone = urls.length - missingUrls.length;
    const scope = this.backgroundFetchScope(bookId, urls);
    let background = null;
    let backgroundFetchId = '';

    try {
      const saved = this.getDownloadState(bookId);
      if (
        saved &&
        saved.status === 'downloading' &&
        typeof saved.backgroundFetchId === 'string' &&
        saved.backgroundFetchId.startsWith(scope)
      ) {
        backgroundFetchId = saved.backgroundFetchId;
        background = await manager.get(backgroundFetchId);
      }

      // localStorage may have been cleared while the browser-owned download
      // is still active. Recover it from the registration instead of starting
      // a duplicate transfer.
      if (!background && typeof manager.getIds === 'function') {
        const existingId = (await manager.getIds()).find(id => id.startsWith(scope));
        if (existingId) {
          backgroundFetchId = existingId;
          background = await manager.get(existingId);
        }
      }

      // Jobs created by the previous release omitted downloadTotal, which
      // makes Chrome's system UI stay at 0‰. Restart those jobs once with a
      // measured total; already cached files are excluded from the new job.
      if (background && !(Number(background.downloadTotal) > 0)) {
        await background.abort();
        background = null;
        backgroundFetchId = '';
      }

      if (!background) {
        const jobId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        backgroundFetchId =
          `${scope}${cachedDone}:${urls.length}:${jobId}`;
        const requests = missingUrls.map(url => new URL(url, location.href).href);
        const downloadTotal = await this.measureDownloadTotal(missingUrls);
        const fetchOptions = {
          title: `离线下载《${book.title || book.name || bookId}》`,
          icons: [{
            src: new URL('icons/icon-192.png', location.href).href,
            sizes: '192x192',
            type: 'image/png',
          }],
        };
        if (downloadTotal > 0) fetchOptions.downloadTotal = downloadTotal;
        background = await manager.fetch(backgroundFetchId, requests, fetchOptions);
      }
    } catch (err) {
      // Permission denial or an incomplete implementation should not make
      // offline download unavailable; transparently use the existing path.
      console.warn('Background Fetch unavailable, using fallback:', err);
      return null;
    }

    this.setDownloadState(bookId, {
      backgroundFetchId,
      status: 'downloading',
      done: cachedDone,
      total: urls.length,
    });
    if (onProgress) {
      onProgress(cachedDone, urls.length, {
        background: true,
        percent: this.backgroundFetchPercent(background),
      });
    }

    await this.waitForBackgroundFetch(
      book,
      background,
      backgroundFetchId,
      cachedDone,
      urls.length,
      onProgress
    );
    return true;
  },

  async measureDownloadTotal(urls) {
    let nextIndex = 0;
    let total = 0;
    let complete = true;

    const measureNext = async () => {
      while (complete && nextIndex < urls.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          const response = await fetch(urls[index], {
            method: 'HEAD',
            cache: 'no-cache',
          });
          const length = Number(response.headers.get('content-length'));
          const encoding = response.headers.get('content-encoding');
          if (
            !response.ok ||
            !Number.isSafeInteger(length) ||
            length <= 0 ||
            (encoding && encoding !== 'identity')
          ) {
            complete = false;
            return;
          }
          total += length;
        } catch {
          complete = false;
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(6, urls.length) },
        () => measureNext()
      )
    );
    return complete && Number.isSafeInteger(total) ? total : 0;
  },

  backgroundFetchPercent(background) {
    const total = Number(background && background.downloadTotal) || 0;
    const downloaded = Number(background && background.downloaded) || 0;
    if (total <= 0) return null;
    return Math.max(0, Math.min(100, Math.round((downloaded / total) * 100)));
  },

  backgroundFetchScope(bookId, urls) {
    // Stable, non-cryptographic fingerprint: only used to associate an active
    // browser download with the current versioned URL list.
    let hash = 2166136261;
    for (const char of urls.join('\n')) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 16777619);
    }
    return `offline-book:${encodeURIComponent(bookId)}:${(hash >>> 0).toString(36)}:`;
  },

  waitForBackgroundFetch(book, background, backgroundFetchId, done, total, onProgress) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let checkingCache = false;

      const cleanup = () => {
        navigator.serviceWorker.removeEventListener('message', onMessage);
        background.removeEventListener('progress', onNativeProgress);
        clearInterval(cacheTimer);
      };
      const finish = (err) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (err) reject(err);
        else resolve();
      };
      const checkCache = async () => {
        if (checkingCache || settled) return;
        checkingCache = true;
        try {
          if (await this.isDownloaded(book)) {
            this.setDownloadState(book.id, {
              backgroundFetchId,
              status: 'done',
              done: total,
              total,
            });
            if (onProgress) onProgress(total, total);
            finish();
          } else if (background.result === 'failure') {
            finish(new Error(background.failureReason || '后台下载失败'));
          }
        } finally {
          checkingCache = false;
        }
      };
      const onNativeProgress = () => {
        if (background.result === 'failure') {
          finish(new Error(background.failureReason || '后台下载失败'));
          return;
        }
        if (onProgress) {
          onProgress(done, total, {
            background: true,
            downloaded: background.downloaded || 0,
            percent: this.backgroundFetchPercent(background),
          });
        }
        if (background.result === 'success') checkCache();
      };
      const onMessage = (event) => {
        const msg = event.data || {};
        if (
          msg.type !== this.MSG_PROGRESS ||
          msg.backgroundFetchId !== backgroundFetchId
        ) return;

        this.rememberDownloadMessage(msg);
        if (msg.status === 'done') {
          if (onProgress) onProgress(total, total);
          finish();
        } else if (msg.status === 'error') {
          finish(new Error(msg.error || '后台下载失败'));
        }
      };

      navigator.serviceWorker.addEventListener('message', onMessage);
      background.addEventListener('progress', onNativeProgress);
      const cacheTimer = window.setInterval(checkCache, 1500);
      checkCache();
    });
  },

  async downloadInPage(book, urls, onProgress) {
    const cache = await caches.open(this.CACHE);
    let done = 0;
    this.setDownloadState(book.id, {
      status: 'downloading',
      done,
      total: urls.length,
    });

    for (const u of urls) {
      if (!(await cache.match(u))) {
        const res = await fetch(u, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`${u}（${res.status}）`);
        await cache.put(u, res);
      }
      done += 1;
      this.setDownloadState(book.id, {
        status: 'downloading',
        done,
        total: urls.length,
      });
      if (onProgress) onProgress(done, urls.length);
    }
    this.setDownloadState(book.id, {
      status: 'done',
      done: urls.length,
      total: urls.length,
    });
  },

  async downloadInServiceWorker(book, urls, onProgress, options = {}) {
    if (!('serviceWorker' in navigator)) return null;

    let registration;
    try {
      registration = await navigator.serviceWorker.ready;
    } catch {
      return null;
    }

    const worker =
      navigator.serviceWorker.controller ||
      registration.active ||
      registration.waiting ||
      registration.installing;

    if (!worker) return null;

    const bookId = String(book.id || '');
    const jobId = `${bookId}-${Date.now()}-${Math.random().toString(36).slice(2)}`;

    this.setDownloadState(bookId, {
      jobId,
      status: 'downloading',
      done: 0,
      total: urls.length,
    });

    await new Promise((resolve, reject) => {
      let lastMessageAt = Date.now();
      const payload = {
        type: this.MSG_START,
        jobId,
        bookId,
        bookTitle: String(book.title || book.name || bookId),
        showNotification: options.showNotification === true,
        urls,
      };
      const postStart = () => {
        const currentWorker =
          navigator.serviceWorker.controller ||
          registration.active ||
          worker;
        currentWorker.postMessage(payload);
      };
      const retryIfStalled = () => {
        if (!document.hidden && Date.now() - lastMessageAt >= 15000) {
          lastMessageAt = Date.now();
          try { postStart(); }
          catch { /* the next visibility/interval tick retries */ }
        }
      };
      const cleanup = () => {
        navigator.serviceWorker.removeEventListener('message', onMessage);
        document.removeEventListener('visibilitychange', retryIfStalled);
        clearInterval(retryTimer);
      };

      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.type !== this.MSG_PROGRESS || msg.bookId !== bookId) return;

        lastMessageAt = Date.now();
        this.rememberDownloadMessage(msg);

        if (msg.status === 'downloading') {
          if (onProgress) onProgress(msg.done || 0, msg.total || urls.length);
          return;
        }

        cleanup();
        if (msg.status === 'done') {
          if (onProgress) onProgress(urls.length, urls.length);
          resolve();
        } else {
          reject(new Error(msg.error || '下载失败'));
        }
      };

      navigator.serviceWorker.addEventListener('message', onMessage);
      document.addEventListener('visibilitychange', retryIfStalled);
      const retryTimer = window.setInterval(retryIfStalled, 15000);

      try {
        postStart();
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
    return true;
  },

  // 移除本书当前版本的章节、PDF、封面和高亮缓存。
  async remove(book) {
    if (!this.supported()) return;
    const cache = await caches.open(this.CACHE);

    const coverFile = typeof book.cover === 'string' ? book.cover : '';
    const coverThumbFile = typeof book.coverThumb === 'string' ? book.coverThumb : '';

    if (coverFile && !isExternalURL(coverFile)) {
      await cache.delete(withBookVersion(`books/${book.id}/${coverFile}`, book));
    }
    if (coverThumbFile && !isExternalURL(coverThumbFile)) {
      await cache.delete(withBookVersion(`books/${book.id}/${coverThumbFile}`, book));
    }

    const highlightsFile =
      typeof book.highlightsFile === 'string' ? book.highlightsFile :
      typeof book.highlights === 'string' ? book.highlights :
      '';

    if (highlightsFile) {
      await cache.delete(withBookVersion(`books/${book.id}/${highlightsFile}`, book));
    }

    for (const ch of (book.chapters || [])) {
      await cache.delete(withBookVersion(`books/${book.id}/${ch.file}`, book, ch));
    }
    for (const url of this.pdfUrls(book)) {
      await cache.delete(url);
    }

    this.clearDownloadState(book.id);
  },

  downloadStateKey(bookId) {
    return `${this.STATE_PREFIX}${bookId}`;
  },

  getDownloadState(bookId) {
    try {
      const data = JSON.parse(localStorage.getItem(this.downloadStateKey(bookId)));
      if (!data || typeof data !== 'object') return null;

      return data;
    } catch {
      return null;
    }
  },

  setDownloadState(bookId, data) {
    try {
      localStorage.setItem(this.downloadStateKey(bookId), JSON.stringify({
        ...data,
        time: Date.now(),
      }));
    } catch { /* ignore storage failures */ }
  },

  clearDownloadState(bookId) {
    try { localStorage.removeItem(this.downloadStateKey(bookId)); }
    catch { /* ignore storage failures */ }
  },

  hasPendingDownloads() {
    try {
      for (let i = 0; i < localStorage.length; i += 1) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith(this.STATE_PREFIX)) continue;
        try {
          const data = JSON.parse(localStorage.getItem(key));
          if (data && data.status === 'downloading') return true;
        } catch { /* ignore this malformed entry */ }
      }
    } catch { /* ignore inaccessible storage */ }
    return false;
  },

  rememberDownloadMessage(msg) {
    if (!msg || !msg.bookId) return;

    const current = this.getDownloadState(msg.bookId);
    if (
      msg.backgroundFetchId &&
      current &&
      current.backgroundFetchId &&
      msg.backgroundFetchId !== current.backgroundFetchId
    ) {
      return;
    }

    if (msg.status === 'done') {
      this.setDownloadState(msg.bookId, {
        backgroundFetchId: msg.backgroundFetchId || '',
        jobId: msg.jobId || '',
        status: 'done',
        done: msg.total || 0,
        total: msg.total || 0,
      });
      return;
    }

    if (msg.status === 'error') {
      this.setDownloadState(msg.bookId, {
        backgroundFetchId: msg.backgroundFetchId || '',
        jobId: msg.jobId || '',
        status: 'error',
        done: msg.done || 0,
        total: msg.total || 0,
        error: msg.error || '下载失败',
      });
      return;
    }

    if (msg.status === 'downloading') {
      this.setDownloadState(msg.bookId, {
        backgroundFetchId: msg.backgroundFetchId || '',
        jobId: msg.jobId || '',
        status: 'downloading',
        done: msg.done || 0,
        total: msg.total || 0,
      });
    }
  },
};

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data || {};
    if (msg.type === Offline.MSG_PROGRESS) {
      Offline.rememberDownloadMessage(msg);
    }
  });
}


function isStandaloneApp() {
  try {
    return (
      (matchMedia && matchMedia('(display-mode: standalone)').matches) ||
      navigator.standalone === true ||
      (document.referrer || '').startsWith('android-app://')
    );
  } catch {
    return false;
  }
}

/* ---------- Android App 推荐 ---------- */
// 安卓浏览器访客（且不在已安装的 App / 独立窗口里）推荐下载 TWA 安装包。
const AppPromo = {
  DISMISS_KEY: 'reader.apkBannerDismissed',
  APK_URL: 'app/latest.apk',

  // 是否应推荐：安卓浏览器 + 不在 standalone/TWA 中 + 未被关闭过
  shouldSuggest() {
    try {
      if (!/Android/i.test(navigator.userAgent)) return false;
      // 已安装的 PWA / TWA 都跑在 standalone 显示模式，App 内不再推荐
      if (isStandaloneApp()) return false;
      return localStorage.getItem(this.DISMISS_KEY) !== '1';
    } catch { return false; }
  },

  // 记住"不再提示"
  dismiss() {
    try { localStorage.setItem(this.DISMISS_KEY, '1'); }
    catch { /* 隐私模式或配额满，静默失败 */ }
  },
};


function isExternalURL(url) {
  return /^(?:https?:)?\/\//i.test(String(url || '')) ||
    String(url || '').startsWith('data:') ||
    String(url || '').startsWith('blob:');
}

// 书籍资源以版本化 URL 作为缓存键。章节或 PDF 分卷可单独声明
// version；未声明时继承书籍 version。
function withBookVersion(url, book, resource = null) {
  const source = resource && resource.version != null ? resource : book;
  const version = source && source.version;
  if (version == null || String(version).trim() === '' || isExternalURL(url)) {
    return url;
  }

  const value = encodeURIComponent(String(version).trim());
  const hashAt = url.indexOf('#');
  const base = hashAt >= 0 ? url.slice(0, hashAt) : url;
  const hash = hashAt >= 0 ? url.slice(hashAt) : '';
  const separator = base.includes('?') ? '&' : '?';
  return `${base}${separator}v=${value}${hash}`;
}

/* ---------- 主题 ---------- */
const Theme = {
  init() {
    const saved = localStorage.getItem(Store.THEME_KEY);
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', () => this.toggle());
    this.syncButton();
  },
  current() {
    const attr = document.documentElement.getAttribute('data-theme');
    if (attr) return attr;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  },
  toggle() {
    const next = this.current() === 'dark' ? 'light' : 'dark';
    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem(Store.THEME_KEY, next);
    this.syncButton();
  },
  // 按钮文案跟随当前主题：提示点击后会切到哪一边
  syncButton() {
    const btn = document.getElementById('theme-toggle');
    if (!btn) return;
    const label = this.current() === 'dark' ? '切换到浅色模式' : '切换到深色模式';
    btn.setAttribute('aria-label', label);
    btn.title = label;
  },
};

Theme.init();

/* ---------- 小工具 ---------- */
// 读取 URL 查询参数
function getParam(name) {
  return new URLSearchParams(location.search).get(name);
}

// 节流：避免滚动时频繁写 localStorage
function throttle(fn, wait) {
  let last = 0, timer = null;
  return function (...args) {
    const now = Date.now();
    const remaining = wait - (now - last);
    if (remaining <= 0) {
      clearTimeout(timer); timer = null; last = now; fn.apply(this, args);
    } else if (!timer) {
      timer = setTimeout(() => { last = Date.now(); timer = null; fn.apply(this, args); }, remaining);
    }
  };
}

// 拉取 JSON，统一错误处理
async function fetchJSON(url) {
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) throw new Error(`无法加载 ${url}（${res.status}）`);
  return res.json();
}

/* ---------- Service Worker（离线/可安装） ---------- */
// 注册路径相对页面解析 = 站点根，作用域即整个阅读站
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => { /* 不支持或非 HTTPS，忽略 */ });
  });
}
