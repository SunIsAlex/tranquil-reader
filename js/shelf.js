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
      <span class="book-meta">${meta}</span>`;
    listEl.appendChild(card);
  }
})();

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
