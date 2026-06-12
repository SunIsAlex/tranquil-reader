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
