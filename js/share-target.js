/* ============================================================
   share-target.js · 系统分享入口
   接收 Android / PWA Share Target 传来的 title/text/url/file。
   优先级：
   1. 如果收到真实文件内容，直接作为临时书打开
   2. 如果收到较长纯文本，直接作为临时书打开
   3. 如果收到站内 reader.html 链接，打开对应阅读页
   4. 如果只收到文件名，提示无法读取本地文件内容
   5. 最后才匹配书架已有书籍
   ============================================================ */

(async function () {
  let shared;
  try {
    shared = await readSharedPayload();
  } catch (err) {
    showError(`分享内容读取失败：${err.message}`);
    return;
  }

  // 1. 收到 POST multipart 文件内容：直接打开分享来的 TXT
  const openedFiles = await tryOpenSharedFiles(shared);
  if (openedFiles) return;

  // 2. 收到真正的长文本内容：直接作为临时书打开
  const openedText = await tryOpenSharedText(shared);
  if (openedText) return;

  // 3. 如果只是文件名，例如 xxx.txt，网页无法凭文件名读取 Android 本地文件
  if (looksLikeOnlyFileName(shared)) {
    showOnlyFileName(shared);
    return;
  }

  // 4. 站内阅读链接仍然允许直接跳转
  let manifest;
  try {
    manifest = await fetchJSON('books/manifest.json');
  } catch (err) {
    showError(`书目加载失败：${err.message}`);
    return;
  }

  const books = Array.isArray(manifest.books) ? manifest.books : [];

  const directReaderURL = findInternalReaderURL(shared, books);
  if (directReaderURL) {
    openDirect(directReaderURL);
    return;
  }

  // 5. 最后才尝试按书名 / id 匹配书架
  const matched = matchBook(shared, books);
  if (matched) {
    openDirect(`reader.html?book=${encodeURIComponent(matched.id)}`);
    return;
  }

  showNoMatch(shared, books);
})();

async function readSharedPayload() {
  const params = new URLSearchParams(location.search);
  const shareId = params.get('shareId');

  // POST + files 的正常路径：
  // sw.js 拦截 POST，把内容写进 Cache API，
  // 然后重定向到 share-target.html?shareId=...
  if (shareId) {
    const res = await fetch(`share-data/${encodeURIComponent(shareId)}.json`, {
      cache: 'force-cache'
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    return normalizeSharedPayload(data);
  }

  // GET 分享路径：通常只能拿到 title/text/url，拿不到文件内容
  return normalizeSharedPayload({
    title: params.get('title') || '',
    text: params.get('text') || '',
    url: params.get('url') || '',
    files: []
  });
}

function normalizeSharedPayload(data) {
  const title = String(data.title || '').trim();
  const text = String(data.text || '').trim();
  const url = String(data.url || '').trim();
  const files = Array.isArray(data.files) ? data.files : [];

  const fileNames = files
    .map(f => f && f.name ? String(f.name) : '')
    .filter(Boolean)
    .join('\n');

  return {
    id: String(data.id || ''),
    title,
    text,
    url,
    files,
    combined: [title, text, url, fileNames].filter(Boolean).join('\n').trim()
  };
}

/* ---------- 直接打开分享来的文件 ---------- */

async function tryOpenSharedFiles(shared) {
  const files = (shared.files || [])
    .filter(file => file && typeof file.text === 'string' && file.text.length > 0);

  if (!files.length) return false;

  const title = deriveSharedBookTitle(shared, files);

  await openTemporaryBook({
    title,
    author: '本地分享',
    chapters: files.map((file, index) => ({
      title: deriveChapterTitle(file, index, files.length),
      text: String(file.text || '')
    }))
  });

  return true;
}

/* ---------- 直接打开分享来的纯文本 ---------- */

async function tryOpenSharedText(shared) {
  const text = pickSharedReadableText(shared);
  if (!text) return false;

  await openTemporaryBook({
    title: deriveTextShareTitle(shared),
    author: '本地分享',
    chapters: [
      {
        title: deriveTextShareTitle(shared),
        text
      }
    ]
  });

  return true;
}

function pickSharedReadableText(shared) {
  const candidates = [
    shared.text,
    shared.url,
    shared.title
  ].map(s => String(s || '').trim()).filter(Boolean);

  for (const value of candidates) {
    if (looksLikeOnlyFileName({ combined: value })) continue;
    if (looksLikeURL(value)) continue;

    // 防止把一个普通书名、文件名、短标题误当正文打开。
    // 真正分享的 TXT 正文一般会更长，或者至少包含换行。
    if (value.length >= 80 || value.includes('\n')) {
      return value;
    }
  }

  return '';
}

function deriveTextShareTitle(shared) {
  if (shared.title && !looksLikeGenericShareTitle(shared.title) && !isProbablyFileName(shared.title)) {
    return shorten(shared.title, 40);
  }

  const firstLine = String(shared.text || '')
    .split(/\r?\n/)
    .map(s => s.trim())
    .find(Boolean);

  if (firstLine) return shorten(firstLine, 32);
  return '分享文本';
}

/* ---------- 临时书存储并跳转 reader ---------- */

async function openTemporaryBook(bookData) {
  const id = `share-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const book = {
    id,
    source: 'share-target',
    title: bookData.title || '分享文本',
    author: bookData.author || '本地分享',
    chapters: bookData.chapters || []
  };

  const cache = await caches.open('tranquil-shares');
  await cache.put(
    `shared-books/${encodeURIComponent(id)}.json`,
    new Response(JSON.stringify(book), {
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
      }
    })
  );

  location.replace(`reader.html?shared=${encodeURIComponent(id)}`);
}

/* ---------- 文件名-only 情况 ---------- */

function looksLikeOnlyFileName(shared) {
  const s = String(shared.combined || '').trim();

  if (!s) return false;
  if (s.includes('\n')) return false;
  if (looksLikeURL(s)) return false;

  return isProbablyFileName(s);
}

function isProbablyFileName(s) {
  s = String(s || '').trim();

  return /^[^<>:"/\\|?*\n\r]{1,160}\.(txt|md|markdown|json|xml|yml|yaml|csv)$/i.test(s);
}

function showOnlyFileName(shared) {
  const name = escapeHTML(shorten(shared.combined, 120));

  document.title = '无法读取文件内容 · 静读';

  const statusEl = document.getElementById('share-status');
  const resultEl = document.getElementById('share-result');

  statusEl.textContent = '只收到了文件名，没有收到 TXT 文件内容。';

  resultEl.innerHTML = `
    <li class="book-card">
      <a class="book-link" href="index.html">
        <div class="book-main">
          <h2 class="book-name">返回书架</h2>
          <p class="book-progress">收到的内容：${name}</p>
          <p class="book-progress">这通常说明分享来源只把文件名作为文本发给了 PWA，而没有把文件本体发过来。</p>
          <p class="book-progress">请尝试在文件管理器中使用“分享文件”而不是“分享文件名/路径”，或换一个文件管理器测试。</p>
        </div>
      </a>
      <div class="book-side">
        <span class="book-meta">未收到文件</span>
      </div>
    </li>
  `;
}

/* ---------- 标题辅助 ---------- */

function deriveSharedBookTitle(shared, files) {
  if (shared.title && !looksLikeGenericShareTitle(shared.title)) {
    return shorten(cleanFileTitle(shared.title), 40);
  }

  const firstName = files[0] && files[0].name ? cleanFileTitle(files[0].name) : '';
  if (files.length === 1) return firstName || '分享文本';

  return firstName
    ? `${shorten(firstName, 32)} 等 ${files.length} 个文件`
    : `分享文本 · ${files.length} 个文件`;
}

function deriveChapterTitle(file, index, total) {
  const name = file && file.name ? cleanFileTitle(file.name) : '';
  if (total === 1) return name || '分享文本';
  return name || `分享文本 ${index + 1}`;
}

function cleanFileTitle(name) {
  return String(name || '')
    .replace(/\.[^.]+$/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function looksLikeGenericShareTitle(title) {
  return /^(share|shared|text|file|document|untitled|分享|文件|文本)$/i.test(String(title || '').trim());
}

/* ---------- 站内链接 / 书架匹配 ---------- */

function findInternalReaderURL(shared, books) {
  const candidates = collectURLCandidates(shared);
  const knownBookIds = new Set(books.map(b => b.id));

  for (const raw of candidates) {
    const url = parseMaybeURL(raw);
    if (!url) continue;

    if (url.origin !== location.origin) continue;
    if (!url.pathname.endsWith('/reader.html') && !url.pathname.endsWith('reader.html')) continue;

    const bookId = url.searchParams.get('book');
    if (!bookId || !knownBookIds.has(bookId)) continue;

    const book = books.find(b => b.id === bookId);
    const chapter = parseInt(url.searchParams.get('chapter'), 10);
    const hasChapter =
      Number.isInteger(chapter) &&
      chapter >= 0 &&
      chapter < ((book && book.chapters) ? book.chapters.length : 0);

    let target = `reader.html?book=${encodeURIComponent(bookId)}`;
    if (hasChapter) target += `&chapter=${chapter}`;
    if (/^#p\d+$/.test(url.hash)) target += url.hash;

    return target;
  }

  return null;
}

function collectURLCandidates(shared) {
  const values = [shared.url, shared.text, shared.title, shared.combined].filter(Boolean);
  const urls = [];

  for (const value of values) {
    urls.push(value);

    const matches = value.match(/https?:\/\/[^\s<>"']+|(?:^|\s)(?:\.\/)?reader\.html\?[^\s<>"']+/g);
    if (!matches) continue;

    for (let match of matches) {
      match = match.trim();
      match = match.replace(/^[\s(（「『《]+/, '');
      match = match.replace(/[)\]）」，。、《》]+$/, '');
      urls.push(match);
    }
  }

  return [...new Set(urls)];
}

function parseMaybeURL(raw) {
  if (!raw) return null;

  try {
    return new URL(raw, location.href);
  } catch {
    return null;
  }
}

function matchBook(shared, books) {
  const haystack = normalizeText(shared.combined);
  if (!haystack) return null;

  const exactId = books.find(book => normalizeText(book.id) && haystack.includes(normalizeText(book.id)));
  if (exactId) return exactId;

  const exactTitle = books.find(book => normalizeText(book.title) && haystack.includes(normalizeText(book.title)));
  if (exactTitle) return exactTitle;

  return null;
}

function normalizeText(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000"'“”‘’`~!！?？.,，。:：;；()[\]{}<>《》「」『』、\\/|_-]+/g, '');
}

/* ---------- UI ---------- */

function openDirect(target) {
  document.title = '正在打开 · 静读';
  const statusEl = document.getElementById('share-status');
  if (statusEl) statusEl.textContent = '已识别分享内容，正在打开阅读页……';
  location.replace(target);
}

function showNoMatch(shared, books) {
  const statusEl = document.getElementById('share-status');
  const resultEl = document.getElementById('share-result');

  document.title = '未识别分享内容 · 静读';
  statusEl.textContent = '没有识别出可直接打开的书籍。你可以返回书架，或从下面选择一本书。';

  const sharedHTML = shared.combined
    ? `<p class="book-progress">分享内容：${escapeHTML(shorten(shared.combined, 120))}</p>`
    : `<p class="book-progress">没有收到有效的 title / text / url / file 参数。</p>`;

  resultEl.innerHTML = `
    <li class="book-card">
      <a class="book-link" href="index.html">
        <div class="book-main">
          <h2 class="book-name">返回书架</h2>
          ${sharedHTML}
        </div>
      </a>
      <div class="book-side">
        <span class="book-meta">书架</span>
      </div>
    </li>
  `;

  for (const book of books) {
    const li = document.createElement('li');
    li.className = 'book-card';

    const link = document.createElement('a');
    link.className = 'book-link';
    link.href = `reader.html?book=${encodeURIComponent(book.id)}`;
    link.innerHTML = `
      <div class="book-main">
        <h2 class="book-name">${escapeHTML(book.title)}</h2>
        <span class="book-author">${escapeHTML(book.author || '佚名')}</span>
      </div>
    `;

    const side = document.createElement('div');
    side.className = 'book-side';
    side.innerHTML = `<span class="book-meta">${escapeHTML((book.chapters || []).length + ' 章')}</span>`;

    li.appendChild(link);
    li.appendChild(side);
    resultEl.appendChild(li);
  }
}

function showError(message) {
  const statusEl = document.getElementById('share-status');
  const resultEl = document.getElementById('share-result');

  document.title = '打开失败 · 静读';
  statusEl.textContent = message;
  resultEl.innerHTML = `
    <li class="book-card">
      <a class="book-link" href="index.html">
        <div class="book-main">
          <h2 class="book-name">返回书架</h2>
          <span class="book-author">无法处理这次分享。</span>
        </div>
      </a>
      <div class="book-side">
        <span class="book-meta">错误</span>
      </div>
    </li>
  `;
}

/* ---------- 小工具 ---------- */

function looksLikeURL(s) {
  return /^https?:\/\//i.test(String(s || '').trim());
}

function shorten(s, max) {
  s = String(s || '').replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}