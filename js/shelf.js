/* ============================================================
   shelf.js · 书架页
   读取 books/manifest.json，渲染书目，显示各书阅读进度
   ============================================================ */

(async function () {
  if (maybeResumeLastReadOnAppLaunch()) return;

  const listEl = document.getElementById('book-list');
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

  listEl.innerHTML = '';
  const frag = document.createDocumentFragment();
  for (const book of books) {
    const card = document.createElement('li');
    const hasCover = typeof book.cover === 'string' && book.cover.trim();
    card.className = hasCover ? 'book-card has-cover' : 'book-card';

    const link = document.createElement('a');
    link.className = 'book-link';
    link.href = `reader.html?book=${encodeURIComponent(book.id)}`;

    const progress = Store.getProgress(book.id);
    let progressHTML = '';
    if (progress && Number.isInteger(progress.chapter)) {
      const total = book.chapters ? book.chapters.length : null;
      const at = progress.chapter + 1;
      progressHTML = `<div class="book-progress">● 读到第 ${at}${total ? ' / ' + total : ''} 章</div>`;
    }

    const meta = book.chapters ? `${book.chapters.length} 章` : '';

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
    if (Offline.supported()) {
      side.appendChild(makeOfflineBtn(book));
    }

    // 封面与阅读链接分离：
    // - 点击封面：新标签页打开封面图
    // - 点击标题/书卡文字区域：进入阅读器
    card.appendChild(renderBookCover(book));
    card.appendChild(link);
    card.appendChild(side);
    frag.appendChild(card);
  }
  listEl.appendChild(frag);
})();


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
      setStatus(`已保存 ${result.count} 本书的阅读进度。`, 'ok');
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
      setStatus(`已恢复 ${result.count} 本书的阅读进度。`, 'ok');
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
    if (!els.panel.hidden && !els.panel.contains(e.target) && e.target !== els.toggle) {
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

  shelf.insertBefore(banner, shelf.querySelector('.book-list'));
}

// 为某本书生成“离线下载/移除”按钮，自带状态机与进度显示。
function makeOfflineBtn(book) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'offline-btn';

  function progressPercent(done, total) {
    if (!total) return 0;
    return Math.max(0, Math.min(100, Math.round((done / total) * 100)));
  }

  function setState(state, extra) {
    btn.dataset.state = state;
    btn.disabled = (state === 'checking' || state === 'downloading');
    switch (state) {
      case 'checking':    btn.textContent = '…'; break;
      case 'idle':        btn.textContent = '⬇ 离线'; btn.title = '下载到本地，无网络也能读'; break;
      case 'downloading': btn.textContent = `下载中 ${extra}%`; break;
      case 'downloaded':  btn.textContent = '✓ 已离线'; btn.title = '已缓存，点击移除'; break;
      case 'error':       btn.textContent = '重试'; btn.title = extra || '下载失败'; break;
    }
  }

  function applySavedDownloadState() {
    const saved = Offline.getDownloadState(book.id);
    if (!saved) return false;

    if (saved.status === 'downloading') {
      setState('downloading', progressPercent(saved.done || 0, saved.total || 0));
      return true;
    }

    if (saved.status === 'done') {
      setState('downloaded');
      return true;
    }

    if (saved.status === 'error') {
      setState('error', saved.error || '下载失败');
      return true;
    }

    return false;
  }

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.addEventListener('message', (event) => {
      const msg = event.data || {};
      if (msg.type !== Offline.MSG_PROGRESS || msg.bookId !== book.id) return;

      if (msg.status === 'downloading') {
        setState('downloading', progressPercent(msg.done || 0, msg.total || 0));
      } else if (msg.status === 'done') {
        setState('downloaded');
      } else if (msg.status === 'error') {
        setState('error', msg.error || '下载失败');
      }
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
      await Offline.download(book, (done, total) =>
        setState('downloading', progressPercent(done, total)));
      setState('downloaded');
    } catch (err) {
      setState('error', String(err && err.message || err));
    }
  });

  // 初始状态异步探测：是否已经缓存过
  setState('checking');
  scheduleShelfIdleTask(() => {
    if (applySavedDownloadState()) return;
    Offline.isDownloaded(book).then(d => setState(d ? 'downloaded' : 'idle'));
  });
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

function resolveBookAsset(book, file) {
  const s = String(file || '').trim();
  if (!s) return '';
  if (/^(?:https?:)?\/\//i.test(s) || s.startsWith('/') || s.startsWith('data:') || s.startsWith('blob:')) {
    return s;
  }

  // Encode each segment so Chinese names/spaces work safely in URLs.
  const encoded = s.split('/').map(part => encodeURIComponent(part)).join('/');
  return `books/${encodeURIComponent(book.id)}/${encoded}`;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
