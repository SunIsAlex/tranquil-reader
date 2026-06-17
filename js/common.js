/* ============================================================
   common.js · 通用工具
   主题切换、localStorage 进度存取，被两个页面共用
   ============================================================ */

const Store = {
  THEME_KEY: 'reader.theme',
  fontKey: 'reader.fontSize',

  // 进度键：每本书一份。结构 { chapter: number, scroll: number, time: number }
  progressKey(bookId) { return `reader.progress.${bookId}`; },

  getProgress(bookId) {
    try { return JSON.parse(localStorage.getItem(this.progressKey(bookId))) || null; }
    catch { return null; }
  },
  setProgress(bookId, data) {
    try { localStorage.setItem(this.progressKey(bookId), JSON.stringify(data)); }
    catch { /* 隐私模式或配额满，静默失败 */ }
  },

  getFontSize() {
    const v = parseFloat(localStorage.getItem(this.fontKey));
    return Number.isFinite(v) ? v : 1.12;
  },
  setFontSize(rem) { localStorage.setItem(this.fontKey, String(rem)); },
};

/* ---------- 离线下载 ---------- */
// 把整本书（清单 + 各章正文）写入持久缓存 tranquil-books，
// sw.js 经 caches.match 读取，无网络时也能完整阅读。
const Offline = {
  CACHE: 'tranquil-books',

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
    const cache = await caches.open(this.CACHE);
    const urls = this.urls(book);
    let done = 0;
    for (const u of urls) {
      const res = await fetch(u, { cache: 'no-cache' });
      if (!res.ok) throw new Error(`${u}（${res.status}）`);
      await cache.put(u, res);
      if (onProgress) onProgress(++done, urls.length);
    }
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
  },
};

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
      const standalone =
        (matchMedia && matchMedia('(display-mode: standalone)').matches) ||
        navigator.standalone === true ||
        (document.referrer || '').startsWith('android-app://');
      if (standalone) return false;
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
