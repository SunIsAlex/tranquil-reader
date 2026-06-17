/* ============================================================
   shelf.js · 书架页
   读取 books/manifest.json，渲染书目，显示各书阅读进度
   ============================================================ */

(async function () {
  const listEl = document.getElementById('book-list');

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
    listEl.appendChild(card);
  }
})();

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
        setState('downloading', Math.round((done / total) * 100)));
      setState('downloaded');
    } catch (err) {
      setState('error', String(err && err.message || err));
    }
  });

  // 初始状态异步探测：是否已经缓存过
  setState('checking');
  Offline.isDownloaded(book).then(d => setState(d ? 'downloaded' : 'idle'));
  return btn;
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
