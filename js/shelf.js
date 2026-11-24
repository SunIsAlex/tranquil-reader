/* ============================================================
   shelf.js · 书架页
   读取 books/manifest.json，渲染书目，显示各书阅读进度
   ============================================================ */

(async function () {
  if (maybeResumeLastReadOnAppLaunch()) return;

  const listEl = document.getElementById('book-list');
  const subEl = document.getElementById('shelf-sub');
  const controlsEl = document.getElementById('shelf-controls');
  const searchEl = document.getElementById('shelf-search');
  const clearEl = document.getElementById('shelf-search-clear');
  const filtersEl = document.getElementById('shelf-filters');
  setupShelfSync();

  // 安卓浏览器访客：在书架顶部推荐下载 App（与书目加载相互独立）
  maybeShowAppBanner();

  let manifest;
  try {
    manifest = await fetchJSON('books/manifest.json');
  } catch (err) {
    listEl.innerHTML = `<li class="empty">书目加载失败：${err.message}<br>
      请确认通过本地服务器访问（不要直接双击打开 HTML）。</li>`;
    return;
  }

  const books = manifest.books || [];
  if (!books.length) {
    listEl.innerHTML = `<li class="empty">书架还是空的。把书登记到 books/manifest.json 吧。</li>`;
    return;
  }

  const offlineSupported = Offline.supported();
  const offlineControllers = new Map();
  const pendingOfflineChecks = [];

  if (offlineSupported && 'serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type !== Offline.MSG_PROGRESS || !msg.bookId) return;
      const ctrl = offlineControllers.get(msg.bookId);
      if (ctrl) ctrl.onProgressMessage(msg);
    });
  }

  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  const cardItems = [];

  for (const book of books) {
    const card = document.createElement('li');
    const hasCover = typeof book.cover === 'string' && book.cover.trim();
    card.className = hasCover ? 'book-card has-cover' : 'book-card';

    const link = document.createElement('a');
    link.className = 'book-link';
    link.href = `reader.html?book=${encodeURIComponent(book.id)}`;

    const progress = Store.getProgress(book.id);
    const hasProgress = Boolean(progress && Number.isInteger(progress.chapter));
    let progressHTML = '';
    if (hasProgress) {
      const total = book.chapters ? book.chapters.length : null;
      const at = progress.chapter + 1;
      if (isPDFBook(book)) {
        const page = Math.max(1, progress.para || 1);
        const partCount = pdfPartCount(book);
        const place = partCount > 1 ? `第 ${at} 卷 · 第 ${page} 页` : `第 ${page} 页`;
        progressHTML = `<div class="book-progress">● 读到${place}</div>`;
      } else {
        progressHTML = `<div class="book-progress">● 读到第 ${at}${total ? ' / ' + total : ''} 章</div>`;
      }
    }

    const meta = isPDFBook(book)
      ? pdfBookMeta(book)
      : book.chapters ? `${book.chapters.length} 章` : '';

    link.innerHTML = `
      <div class="book-main">
        <h2 class="book-name">${escapeHTML(book.title)}</h2>
        <span class="book-author">${escapeHTML(book.author || '佚名')}</span>
        ${progressHTML}
      </div>`;

    const side = document.createElement('div');
    side.className = 'book-side';
    side.innerHTML = `<span class="book-meta">${escapeHTML(meta)}</span>`;

    // 离线下载按钮（浏览器支持时才显示）。按钮与链接分离，避免 <button> 嵌套在 <a> 中。
    if (offlineSupported && Offline.canDownload(book)) {
      side.appendChild(makeOfflineBtn(book, offlineControllers, pendingOfflineChecks));
    }

    // 封面与阅读链接分离：
    // - 点击封面：新标签页打开封面图
    // - 点击标题/书卡文字区域：进入阅读器
    card.appendChild(renderBookCover(book));
    card.appendChild(link);
    card.appendChild(side);
    frag.appendChild(card);

    cardItems.push({
      el: card,
      titleLower: String(book.title || '').toLowerCase(),
      author: String(book.author || '佚名').trim() || '佚名',
      authorLower: String(book.author || '佚名').toLowerCase(),
      hasProgress,
    });
  }

  const emptyFilterEl = document.createElement('li');
  emptyFilterEl.className = 'empty';
  emptyFilterEl.hidden = true;
  emptyFilterEl.textContent = '没有找到匹配的书籍。';
  frag.appendChild(emptyFilterEl);

  listEl.appendChild(frag);

  if (pendingOfflineChecks.length) {
    scheduleShelfIdleTask(() => probeAllOfflineStates(pendingOfflineChecks));
  }

  setupShelfFiltering({
    books,
    cardItems,
    emptyFilterEl,
    subEl,
    controlsEl,
    searchEl,
    clearEl,
    filtersEl,
  });
})();

function setupShelfFiltering({
  books,
  cardItems,
  emptyFilterEl,
  subEl,
  controlsEl,
  searchEl,
  clearEl,
  filtersEl,
}) {
  if (!controlsEl || !searchEl || !clearEl || !filtersEl) {
    if (subEl) subEl.textContent = `静态书库 · 共 ${books.length} 本`;
    return;
  }

  const FILTER_KEY = 'reader.shelfFilter';
  const QUERY_KEY = 'reader.shelfQuery';

  const authorCounts = new Map();
  let readingCount = 0;
  for (const item of cardItems) {
    if (item.hasProgress) readingCount += 1;
    authorCounts.set(item.author, (authorCounts.get(item.author) || 0) + 1);
  }

  const sortedAuthors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1]);

  const filterOptions = [{ id: 'all', label: `全部 (${books.length})` }];
  if (readingCount > 0) {
    filterOptions.push({ id: '__reading__', label: `在读 (${readingCount})` });
  }
  for (const [author, count] of sortedAuthors) {
    filterOptions.push({ id: author, label: `${author} (${count})` });
  }

  let activeFilter = 'all';
  let queryText = '';
  try {
    const savedFilter = sessionStorage.getItem(FILTER_KEY);
    if (savedFilter && filterOptions.some(opt => opt.id === savedFilter)) {
      activeFilter = savedFilter;
    }
    const savedQuery = sessionStorage.getItem(QUERY_KEY);
    if (savedQuery) {
      queryText = savedQuery;
      searchEl.value = savedQuery;
    }
  } catch { /* ignore storage errors */ }

  const pillButtons = [];
  filtersEl.innerHTML = '';
  for (const opt of filterOptions) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'shelf-pill';
    btn.role = 'tab';
    btn.dataset.filter = opt.id;
    btn.textContent = opt.label;
    btn.setAttribute('aria-selected', String(opt.id === activeFilter));
    btn.addEventListener('click', () => {
      activeFilter = opt.id;
      try { sessionStorage.setItem(FILTER_KEY, activeFilter); } catch { /* ignore */ }
      for (const p of pillButtons) {
        p.setAttribute('aria-selected', String(p.dataset.filter === activeFilter));
      }
      applyFilter();
    });
    pillButtons.push(btn);
    filtersEl.appendChild(btn);
  }

  function applyFilter() {
    const q = queryText.trim().toLowerCase();
    clearEl.hidden = !queryText;

    let visible = 0;
    for (const item of cardItems) {
      let ok = true;
      if (activeFilter === '__reading__') {
        ok = item.hasProgress;
      } else if (activeFilter !== 'all') {
        ok = item.author === activeFilter;
      }
      if (ok && q) {
        ok = item.titleLower.includes(q) || item.authorLower.includes(q);
      }
      item.el.hidden = !ok;
      if (ok) visible += 1;
    }

    emptyFilterEl.hidden = visible > 0;
    if (subEl) {
      subEl.textContent = (activeFilter === 'all' && !q)
        ? `静态书库 · 共 ${books.length} 本`
        : `显示 ${visible} / ${books.length} 本`;
    }
  }

  searchEl.addEventListener('input', () => {
    queryText = searchEl.value;
    try { sessionStorage.setItem(QUERY_KEY, queryText); } catch { /* ignore */ }
    applyFilter();
  });

  clearEl.addEventListener('click', () => {
    queryText = '';
    searchEl.value = '';
    try { sessionStorage.removeItem(QUERY_KEY); } catch { /* ignore */ }
    applyFilter();
    searchEl.focus({ preventScroll: true });
  });

  controlsEl.hidden = false;
  applyFilter();
}

async function probeAllOfflineStates(pendingChecks) {
  let cachedSet = null;
  try {
    const cache = await caches.open(Offline.CACHE);
    const keys = await cache.keys();
    cachedSet = new Set(keys.map(req => req.url));
  } catch {
    cachedSet = null;
  }

  for (const { book, setState } of pendingChecks) {
    if (!cachedSet) {
      setState('idle');
      continue;
    }
    const urls = Offline.urls(book);
    const downloaded = urls.length > 0 && urls.every(u => {
      try {
        return cachedSet.has(new URL(u, location.href).href);
      } catch {
        return false;
      }
    });
    setState(downloaded ? 'downloaded' : 'idle');
  }
}


function setupShelfSync() {
  const els = {
    toggle: document.getElementById('sync-toggle'),
    panel: document.getElementById('sync-panel'),
    form: document.getElementById('sync-form'),
    code: document.getElementById('sync-code'),
    save: document.getElementById('sync-save'),
    restore: document.getElementById('sync-restore'),
    status: document.getElementById('sync-status'),
  };

  if (!els.toggle || !els.panel || !els.form || !els.code || !els.save || !els.restore || !els.status) {
    return;
  }

  let lastFocusBeforeSync = null;
  let syncHistoryOpen = false;
  let ignoreNextPopState = false;

  els.toggle.setAttribute('aria-controls', 'sync-panel');
  els.toggle.setAttribute('aria-expanded', String(!els.panel.hidden));
  els.toggle.setAttribute('aria-label', els.panel.hidden ? '打开同步阅读进度' : '关闭同步阅读进度');
  els.panel.setAttribute('role', 'dialog');
  els.panel.setAttribute('aria-label', '同步阅读进度');
  els.panel.setAttribute('aria-hidden', String(els.panel.hidden));
  els.panel.tabIndex = -1;

  function syncCode() {
    return ProgressSync.normalizeCode(els.code.value);
  }

  function setBusy(busy) {
    els.save.disabled = busy;
    els.restore.disabled = busy;
    els.code.disabled = busy;
  }

  function setStatus(message, state = '') {
    els.status.textContent = message;
    els.status.dataset.state = state;
  }

  function pushSyncHistory() {
    if (syncHistoryOpen) return;
    try {
      history.pushState({ ...(history.state || {}), shelfOverlay: 'sync' }, '', location.href);
      syncHistoryOpen = true;
    } catch {
      syncHistoryOpen = false;
    }
  }

  function consumeSyncHistory() {
    if (!syncHistoryOpen) return;
    syncHistoryOpen = false;
    ignoreNextPopState = true;
    try { history.back(); }
    catch { ignoreNextPopState = false; }
  }

  function openSync() {
    if (!els.panel.hidden) {
      requestAnimationFrame(() => els.code.focus({ preventScroll: true }));
      return;
    }

    lastFocusBeforeSync = document.activeElement;
    els.panel.hidden = false;
    els.panel.setAttribute('aria-hidden', 'false');
    els.toggle.setAttribute('aria-expanded', 'true');
    els.toggle.setAttribute('aria-label', '关闭同步阅读进度');
    pushSyncHistory();

    requestAnimationFrame(() => {
      els.code.focus({ preventScroll: true });
      els.code.select();
    });
  }

  function closeSync(restoreFocus = true, options = {}) {
    if (els.panel.hidden) return;
    els.panel.hidden = true;
    els.panel.setAttribute('aria-hidden', 'true');
    els.toggle.setAttribute('aria-expanded', 'false');
    els.toggle.setAttribute('aria-label', '打开同步阅读进度');

    if (restoreFocus) {
      const target = lastFocusBeforeSync && document.contains(lastFocusBeforeSync)
        ? lastFocusBeforeSync
        : els.toggle;
      target.focus({ preventScroll: true });
    }
    lastFocusBeforeSync = null;

    if (!options.fromHistory && !options.keepHistory) {
      consumeSyncHistory();
    }
  }

  async function saveProgress() {
    const code = syncCode();

    if (!ProgressSync.validCode(code)) {
      setStatus('同步码需为 4-32 位字母、数字或下划线。', 'error');
      els.code.focus({ preventScroll: true });
      return;
    }

    setBusy(true);
    setStatus('正在保存阅读进度…');
    try {
      const result = await ProgressSync.save(code);
      const bookmarks = result.bookmarkCount
        ? `及 ${result.bookmarkCount} 个书签`
        : '';
      setStatus(`已保存 ${result.count} 本书的阅读进度${bookmarks}。`, 'ok');
    } catch (err) {
      setStatus(String(err && err.message || err || '保存失败'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function restoreProgress() {
    const code = syncCode();

    if (!ProgressSync.validCode(code)) {
      setStatus('同步码需为 4-32 位字母、数字或下划线。', 'error');
      els.code.focus({ preventScroll: true });
      return;
    }

    setBusy(true);
    setStatus('正在恢复阅读进度…');
    try {
      const result = await ProgressSync.restore(code);
      const bookmarks = result.bookmarkCount
        ? `及 ${result.bookmarkCount} 个书签`
        : '';
      setStatus(`已恢复 ${result.count} 本书的阅读进度${bookmarks}。`, 'ok');
      window.setTimeout(() => location.reload(), 350);
    } catch (err) {
      setStatus(String(err && err.message || err || '恢复失败'), 'error');
    } finally {
      setBusy(false);
    }
  }

  function trapSyncFocus(e) {
    if (els.panel.hidden || e.key !== 'Tab') return;
    const focusables = [...els.panel.querySelectorAll('button:not([disabled]), input, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.hidden && el.offsetParent !== null);
    if (!focusables.length) {
      e.preventDefault();
      els.panel.focus({ preventScroll: true });
      return;
    }

    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus({ preventScroll: true });
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus({ preventScroll: true });
    }
  }

  els.toggle.addEventListener('click', () => els.panel.hidden ? openSync() : closeSync(true));
  els.form.addEventListener('submit', (e) => {
    e.preventDefault();
    saveProgress();
  });
  els.save.addEventListener('click', saveProgress);
  els.restore.addEventListener('click', restoreProgress);

  document.addEventListener('click', (e) => {
    if (!els.panel.hidden && !els.panel.contains(e.target) && !els.toggle.contains(e.target)) {
      closeSync(false);
    }
  });

  document.addEventListener('keydown', (e) => {
    trapSyncFocus(e);
    if (!els.panel.hidden && e.key === 'Escape') {
      e.preventDefault();
      closeSync(true);
    }
  });

  window.addEventListener('popstate', () => {
    if (ignoreNextPopState) {
      ignoreNextPopState = false;
      return;
    }

    if (!els.panel.hidden) {
      syncHistoryOpen = false;
      closeSync(true, { fromHistory: true });
    }
  });
}


// TWA / PWA 从图标冷启动时，start_url 会先打开书架。
// 这里在独立窗口模式下自动跳回上次阅读位置；同一个 app session 只执行一次，
// 因此用户返回书架后不会被立刻再次送回阅读页。
function maybeResumeLastReadOnAppLaunch() {
  try {
    const params = new URLSearchParams(location.search);
    if (params.has('noresume')) return false;
    if (!isStandaloneApp()) return false;
    if (sessionStorage.getItem('reader.resumeChecked') === '1') return false;
    // Let the shelf rebuild interrupted Service Worker jobs before navigating
    // back to the last reading position.
    if (Offline.hasPendingDownloads()) return false;

    sessionStorage.setItem('reader.resumeChecked', '1');

    const last = Store.getLastProgress();
    if (!last || !last.book || !Number.isInteger(last.chapter)) return false;

    location.replace(Store.readerURL(last.book, last));
    return true;
  } catch {
    return false;
  }
}

// 安卓浏览器（非 App 内）访客：在书架顶部插入一张可关闭的下载 App 推荐卡。
function maybeShowAppBanner() {
  if (!AppPromo.shouldSuggest()) return;
  const shelf = document.querySelector('.shelf');
  if (!shelf) return;

  const banner = document.createElement('section');
  banner.className = 'app-banner';
  banner.innerHTML = `
    <button class='app-banner-x' type='button' aria-label='关闭'>✕</button>
    <div class='app-banner-text'>
      <strong>📱 在 Android 上获得更好体验</strong>
      <span>安装「静读」App，全屏阅读、桌面图标</span>
    </div>
    <a class='app-banner-get' href='${AppPromo.APK_URL}' download>下载 App</a>`;

  banner.querySelector('.app-banner-x').addEventListener('click', () => {
    AppPromo.dismiss();
    banner.remove();
  });

  shelf.insertBefore(banner, shelf.querySelector('.shelf-controls') || shelf.querySelector('.book-list'));
}

// 为某本书生成“离线下载/移除”按钮，自带状态机与进度显示。
function makeOfflineBtn(book, offlineControllers, pendingOfflineChecks) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'offline-btn';

  function progressPercent(done, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }

  function displayedDownloadProgress(done, total, details) {
    if (details && details.background) {
      return Number.isFinite(details.percent) ? details.percent : 'background';
    }
    return progressPercent(done, total);
  }

  function setState(state, extra) {
    btn.dataset.state = state;
    btn.disabled = (state === 'checking' || state === 'downloading');
    switch (state) {
      case 'checking':    btn.textContent = '…'; break;
      case 'idle':        btn.textContent = '⬇ 离线'; btn.title = '下载到本地，无网络也能读'; break;
      case 'downloading':
        btn.textContent = extra === 'background' ? '后台下载中' : `下载中 ${extra}%`;
        break;
      case 'downloaded':  btn.textContent = '✓ 已离线'; btn.title = '已缓存，点击移除'; break;
      case 'error':       btn.textContent = '重试'; btn.title = extra || '下载失败'; break;
    }
  }

  function applySavedDownloadState() {
    const saved = Offline.getDownloadState(book.id);
    if (!saved) return false;

    if (saved.status === 'downloading') {
      setState(
        'downloading',
        saved.backgroundFetchId
          ? 'background'
          : progressPercent(saved.done || 0, saved.total || 0)
      );
      resumeDownload();
      return true;
    }

    if (saved.status === 'done') {
      // 版本更新后旧缓存不能继续显示为“已离线”，交给批量缓存检查
      // 使用当前 manifest 中的版本化 URL 重新核验。
      return false;
    }

    if (saved.status === 'error') {
      setState('error', saved.error || '下载失败');
      return true;
    }

    return false;
  }

  async function resumeDownload() {
    try {
      await Offline.download(book, (done, total, details) =>
        setState(
          'downloading',
          displayedDownloadProgress(done, total, details)
        ), {
        showNotification: Offline.notificationPermissionGranted(),
      });
      setState('downloaded');
    } catch (err) {
      setState('error', String(err && err.message || err));
    }
  }

  if (offlineControllers) {
    offlineControllers.set(book.id, {
      onProgressMessage(msg) {
        const current = Offline.getDownloadState(book.id);
        if (
          msg.backgroundFetchId &&
          current &&
          current.backgroundFetchId &&
          msg.backgroundFetchId !== current.backgroundFetchId
        ) return;

        if (msg.status === 'downloading') {
          setState('downloading', progressPercent(msg.done || 0, msg.total || 0));
        } else if (msg.status === 'done') {
          setState('downloaded');
        } else if (msg.status === 'error') {
          setState('error', msg.error || '下载失败');
        }
      },
    });
  }

  btn.addEventListener('click', async (e) => {
    e.preventDefault();
    e.stopPropagation();
    const state = btn.dataset.state;
    if (state === 'checking' || state === 'downloading') return;

    if (state === 'downloaded') {
      await Offline.remove(book);
      setState('idle');
      return;
    }
    try {
      setState('downloading', 0);
      // Native Background Fetch provides its own persistent system UI. Only
      // request notification permission for the legacy Service Worker path.
      const useNativeBackground = Offline.backgroundFetchSupported();
      const permissionRequest = useNativeBackground
        ? Promise.resolve(false)
        : Offline.requestNotificationPermission();
      const showNotification =
        !useNativeBackground && Offline.notificationPermissionGranted();
      if (!showNotification) {
        permissionRequest.then((granted) => {
          if (granted && btn.dataset.state === 'downloading') {
            Offline.enableDownloadNotification(book);
          }
        });
      }
      await Offline.download(book, (done, total, details) =>
        setState(
          'downloading',
          displayedDownloadProgress(done, total, details)
        ), { showNotification });
      setState('downloaded');
    } catch (err) {
      setState('error', String(err && err.message || err));
    }
  });

  // 初始状态异步探测：是否已经缓存过（单次 caches.open().keys() 批量检查）
  setState('checking');
  if (!applySavedDownloadState()) {
    if (pendingOfflineChecks) {
      pendingOfflineChecks.push({ book, setState });
    } else {
      scheduleShelfIdleTask(() => {
        Offline.isDownloaded(book).then(d => setState(d ? 'downloaded' : 'idle'));
      });
    }
  }
  return btn;
}

function scheduleShelfIdleTask(fn) {
  if ('requestIdleCallback' in window) {
    requestIdleCallback(fn, { timeout: 1200 });
  } else {
    setTimeout(fn, 150);
  }
}

function renderBookCover(book) {
  const cover = typeof book.cover === 'string' ? book.cover.trim() : '';

  if (!cover) {
    const el = document.createElement('div');
    el.className = 'book-cover book-cover-placeholder';
    el.setAttribute('aria-hidden', 'true');

    const span = document.createElement('span');
    span.textContent = String(book.title || '书').trim().slice(0, 1) || '书';
    el.appendChild(span);

    return el;
  }

  const fullSrc = resolveBookAsset(book, cover);
  const thumb = typeof book.coverThumb === 'string' ? book.coverThumb.trim() : '';
  const displaySrc = thumb ? resolveBookAsset(book, thumb) : fullSrc;

  const a = document.createElement('a');
  a.className = 'book-cover book-cover-link';
  a.href = fullSrc;
  a.target = '_blank';
  a.rel = 'noopener';
  a.title = `在新标签页打开《${book.title || '书籍'}》封面`;
  a.setAttribute('aria-label', `在新标签页打开《${book.title || '书籍'}》封面`);

  const img = document.createElement('img');
  img.src = displaySrc;
  img.alt = `${book.title || '书籍'}封面`;
  img.loading = 'lazy';
  img.decoding = 'async';

  a.appendChild(img);
  return a;
}

function isPDFBook(book) {
  return book && (
    book.type === 'pdf' ||
    typeof book.pdfUrl === 'string' ||
    Array.isArray(book.parts)
  );
}

function pdfPartCount(book) {
  return Array.isArray(book.parts) ? book.parts.length : 0;
}

function pdfBookMeta(book) {
  const partCount = pdfPartCount(book);
  if (partCount > 1) return `PDF · ${partCount} 卷`;
  if (Number.isInteger(book.pageCount) && book.pageCount > 0) return `PDF · ${book.pageCount} 页`;
  return 'PDF';
}

function resolveBookAsset(book, file) {
  const s = String(file || '').trim();
  if (!s) return '';
  if (/^(?:https?:)?\/\//i.test(s) || s.startsWith('/') || s.startsWith('data:') || s.startsWith('blob:')) {
    return s;
  }

  // Encode each segment so Chinese names/spaces work safely in URLs.
  const encoded = s.split('/').map(part => encodeURIComponent(part)).join('/');
  return withBookVersion(
    `books/${encodeURIComponent(book.id)}/${encoded}`,
    book
  );
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
