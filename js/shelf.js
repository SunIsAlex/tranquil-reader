/* ============================================================
   shelf.js · 书架页
   读取 books/manifest.json，渲染书目，显示各书阅读进度
   ============================================================ */

(async function () {
  const listEl = document.getElementById('book-list');

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
    const card = document.createElement('a');
    card.className = 'book-card';
    card.href = `reader.html?book=${encodeURIComponent(book.id)}`;

    const progress = Store.getProgress(book.id);
    let progressHTML = '';
    if (progress && Number.isInteger(progress.chapter)) {
      const total = book.chapters ? book.chapters.length : null;
      const at = progress.chapter + 1;
      progressHTML = `<div class="book-progress">● 读到第 ${at}${total ? ' / ' + total : ''} 章</div>`;
    }

    const meta = book.chapters ? `${book.chapters.length} 章` : '';

    card.innerHTML = `
      <div class="book-main">
        <h2 class="book-name">${escapeHTML(book.title)}</h2>
        <span class="book-author">${escapeHTML(book.author || '佚名')}</span>
        ${progressHTML}
      </div>
      <div class="book-side">
        <span class="book-meta">${meta}</span>
      </div>`;

    // 离线下载按钮（浏览器支持时才显示）
    if (Offline.supported()) {
      card.querySelector('.book-side').appendChild(makeOfflineBtn(book));
    }

    listEl.appendChild(card);
  }
})();

// 为某本书生成“离线下载/移除”按钮，自带状态机与进度显示。
// 卡片本身是 <a>，按钮内要拦掉点击，避免触发跳转。
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

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
