/* ============================================================
   common.js · 通用工具
   主题切换、localStorage 进度存取，被两个页面共用
   ============================================================ */

const Store = {
  THEME_KEY: 'reader.theme',
  LAST_KEY: 'reader.lastProgress',
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
  progressSnapshot() {
    return {
      progress: this.getAllProgress(),
      lastProgress: this.getLastProgress(),
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
    if (!count) throw new Error('没有可恢复的阅读进度');

    return {
      code,
      count,
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

  // 浏览器是否支持（需 Cache API；非安全上下文下 caches 不可用）
  supported() { return typeof caches !== 'undefined'; },

  // 该书需要离线的全部 URL：共享的书目清单 + 封面 + 高亮文件 + 每一章正文
  urls(book) {
    const list = ['books/manifest.json'];

    const coverFile = typeof book.cover === 'string' ? book.cover : '';
    const coverThumbFile = typeof book.coverThumb === 'string' ? book.coverThumb : '';
    const shelfCoverFile = coverThumbFile || coverFile;

    // Cache the small shelf thumbnail. The full cover still opens on demand,
    // but is not downloaded automatically when a thumbnail exists.
    if (shelfCoverFile && !isExternalURL(shelfCoverFile)) {
      list.push(`books/${book.id}/${shelfCoverFile}`);
    }

    const highlightsFile =
      typeof book.highlightsFile === 'string' ? book.highlightsFile :
      typeof book.highlights === 'string' ? book.highlights :
      '';

    if (highlightsFile) {
      list.push(`books/${book.id}/${highlightsFile}`);
    }

    for (const ch of (book.chapters || [])) {
      list.push(`books/${book.id}/${ch.file}`);
    }

    return list;
  },

  // 是否已完整缓存（清单与每一章都在）
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
  async download(book, onProgress) {
    const urls = this.urls(book);
    const background = await this.downloadInServiceWorker(book, urls, onProgress);
    if (background) return background;

    return this.downloadInPage(book, urls, onProgress);
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
      const res = await fetch(u, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${u}（${res.status}）`);
      await cache.put(u, res);
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

  async downloadInServiceWorker(book, urls, onProgress) {
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

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        navigator.serviceWorker.removeEventListener('message', onMessage);
      };

      const onMessage = (event) => {
        const msg = event.data || {};
        if (msg.type !== this.MSG_PROGRESS || msg.bookId !== bookId) return;

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

      try {
        worker.postMessage({
          type: this.MSG_START,
          jobId,
          bookId,
          urls,
        });
      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  },

  // 移除本书章节缓存、封面缓存和该书高亮缓存。清单是多本书共享的，留着不删。
  async remove(book) {
    if (!this.supported()) return;
    const cache = await caches.open(this.CACHE);

    const coverFile = typeof book.cover === 'string' ? book.cover : '';
    const coverThumbFile = typeof book.coverThumb === 'string' ? book.coverThumb : '';

    if (coverFile && !isExternalURL(coverFile)) {
      await cache.delete(`books/${book.id}/${coverFile}`);
    }
    if (coverThumbFile && !isExternalURL(coverThumbFile)) {
      await cache.delete(`books/${book.id}/${coverThumbFile}`);
    }

    const highlightsFile =
      typeof book.highlightsFile === 'string' ? book.highlightsFile :
      typeof book.highlights === 'string' ? book.highlights :
      '';

    if (highlightsFile) {
      await cache.delete(`books/${book.id}/${highlightsFile}`);
    }

    for (const ch of (book.chapters || [])) {
      await cache.delete(`books/${book.id}/${ch.file}`);
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

      // Avoid leaving a dead "downloading" state forever if the browser killed
      // the service worker or the app was closed mid-download.
      if (data.status === 'downloading' && Date.now() - Number(data.time || 0) > 30 * 60 * 1000) {
        this.clearDownloadState(bookId);
        return null;
      }

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

  rememberDownloadMessage(msg) {
    if (!msg || !msg.bookId) return;

    if (msg.status === 'done') {
      this.setDownloadState(msg.bookId, {
        jobId: msg.jobId || '',
        status: 'done',
        done: msg.total || 0,
        total: msg.total || 0,
      });
      return;
    }

    if (msg.status === 'error') {
      this.setDownloadState(msg.bookId, {
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

/* ---------- 主题 ---------- */
const Theme = {
  init() {
    const saved = localStorage.getItem(Store.THEME_KEY);
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
    const btn = document.getElementById('theme-toggle');
    if (btn) btn.addEventListener('click', () => this.toggle());
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
