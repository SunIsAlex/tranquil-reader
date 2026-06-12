/* ============================================================
   reader.js · 阅读页
   加载某本书的某一章，处理目录、翻章、字号、进度保存与恢复
   ============================================================ */

(async function () {
  const bookId = getParam('book');
  if (!bookId) { location.replace('index.html'); return; }

  const els = {
    title:      document.getElementById('book-title'),
    chapTitle:  document.getElementById('chapter-title'),
    body:       document.getElementById('chapter-body'),
    tocList:    document.getElementById('toc-list'),
    toc:        document.getElementById('toc'),
    tocToggle:  document.getElementById('toc-toggle'),
    prev:       document.getElementById('prev-btn'),
    next:       document.getElementById('next-btn'),
    fontInc:    document.getElementById('font-inc'),
    fontDec:    document.getElementById('font-dec'),
    progress:   document.getElementById('progress-bar'),
  };

  // ---- 找到这本书 ----
  let book;
  try {
    const manifest = await fetchJSON('books/manifest.json');
    book = (manifest.books || []).find(b => b.id === bookId);
  } catch (err) {
    els.body.innerHTML = `<p class="empty">加载失败：${err.message}</p>`;
    return;
  }
  if (!book || !book.chapters || !book.chapters.length) {
    els.body.innerHTML = `<p class="empty">找不到这本书或它没有章节。</p>`;
    return;
  }

  els.title.textContent = book.title;
  document.title = `${book.title} · 静读`;

  // ---- 词语标注（高亮） ----
  // manifest 中的 highlights 形如 { "人名": ["滑膛"], "专有名词": ["第一地球"] }
  // 类别按声明顺序循环使用 5 种标注样式（hl-0 ~ hl-4）
  const highlighter = buildHighlighter(book.highlights);

  function buildHighlighter(highlights) {
    if (!highlights || typeof highlights !== 'object') return null;
    const entries = [];
    Object.keys(highlights).forEach((cat, ci) => {
      const terms = highlights[cat];
      if (!Array.isArray(terms)) return;
      for (const term of terms) {
        if (typeof term === 'string' && term.trim()) {
          entries.push({ term: term.trim(), cat, ci });
        }
      }
    });
    if (!entries.length) return null;

    // 长词优先，防止“哥哥星球”被先匹配成“哥哥”
    entries.sort((a, b) => b.term.length - a.term.length);

    // 正文是转义后的 HTML，所以词条也要先转义再参与匹配
    const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const byEscaped = new Map(entries.map(e => [escapeHTML(e.term), e]));
    const pattern = new RegExp(
      entries.map(e => escRe(escapeHTML(e.term))).join('|'), 'g');

    // 单遍替换：不会重扫已生成的 <mark> 标签内部
    return escapedText => escapedText.replace(pattern, m => {
      const e = byEscaped.get(m);
      return `<mark class="hl hl-${e.ci % 5}" title="${escapeHTML(e.cat)}">${m}</mark>`;
    });
  }

  // 开关（默认开启，状态持久化）
  const HL_KEY = 'reader.highlight';
  const hlBtn = document.getElementById('hl-toggle');
  function applyHL(on) {
    document.body.classList.toggle('no-hl', !on);
    hlBtn.setAttribute('aria-pressed', String(on));
    localStorage.setItem(HL_KEY, on ? '1' : '0');
  }
  applyHL(localStorage.getItem(HL_KEY) !== '0');
  hlBtn.addEventListener('click', () =>
    applyHL(document.body.classList.contains('no-hl')));
  if (!highlighter) hlBtn.hidden = true; // 这本书没配词表就不显示开关

  // ---- 状态 ----
  let current = 0;
  const saved = Store.getProgress(bookId);
  if (saved && Number.isInteger(saved.chapter) &&
      saved.chapter >= 0 && saved.chapter < book.chapters.length) {
    current = saved.chapter;
  }
  // URL 中的 ?chapter= 优先（便于直接链接到某章）
  const urlChapter = parseInt(getParam('chapter'), 10);
  if (Number.isInteger(urlChapter) && urlChapter >= 0 && urlChapter < book.chapters.length) {
    current = urlChapter;
  }

  // ---- 字号 ----
  function applyFont(rem) {
    rem = Math.min(1.6, Math.max(0.9, rem));
    document.documentElement.style.setProperty('--reader-font', rem + 'rem');
    Store.setFontSize(rem);
  }
  applyFont(Store.getFontSize());
  els.fontInc.addEventListener('click', () => applyFont(Store.getFontSize() + 0.06));
  els.fontDec.addEventListener('click', () => applyFont(Store.getFontSize() - 0.06));

  // ---- 目录 ----
  function buildTOC() {
    els.tocList.innerHTML = '';
    book.chapters.forEach((ch, i) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = ch.title;
      if (i === current) a.classList.add('current');
      a.addEventListener('click', (e) => { e.preventDefault(); loadChapter(i); closeTOC(); });
      li.appendChild(a);
      els.tocList.appendChild(li);
    });
  }
  function openTOC()  { els.toc.hidden = false; }
  function closeTOC() { els.toc.hidden = true; }
  els.tocToggle.addEventListener('click', () => els.toc.hidden ? openTOC() : closeTOC());
  // 点击目录外部关闭
  document.addEventListener('click', (e) => {
    if (!els.toc.hidden && !els.toc.contains(e.target) && e.target !== els.tocToggle) closeTOC();
  });

  // ---- 加载章节 ----
  // 章节正文以纯文本存放（.txt），空行分段，---- 作为场景分隔
  async function loadChapter(index, restoreScroll = false) {
    index = Math.min(book.chapters.length - 1, Math.max(0, index));
    current = index;
    const ch = book.chapters[index];

    els.body.innerHTML = `<p class="empty">正在加载……</p>`;
    els.chapTitle.textContent = ch.title;

    let text;
    try {
      const res = await fetch(`books/${book.id}/${ch.file}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);
      text = await res.text();
    } catch {
      els.body.innerHTML = `<p class="empty">这一章读取失败（books/${book.id}/${ch.file}）。</p>`;
      return;
    }

    els.body.innerHTML = renderText(text);
    els.chapTitle.textContent = ch.title;
    document.title = `${ch.title} · ${book.title}`;

    // 导航按钮状态
    els.prev.disabled = index === 0;
    els.next.disabled = index === book.chapters.length - 1;

    // 高亮当前目录项
    [...els.tocList.querySelectorAll('a')].forEach((a, i) =>
      a.classList.toggle('current', i === index));

    // 滚动定位
    if (restoreScroll && saved && saved.chapter === index && saved.scroll) {
      window.scrollTo(0, saved.scroll);
    } else {
      window.scrollTo(0, 0);
    }

    saveProgress();
    updateProgressBar();
  }

  // 纯文本 -> 段落 HTML。空行分段，单独一行的 --- / *** 视作场景分隔
  function renderText(raw) {
    const blocks = raw.replace(/\r\n/g, '\n').split(/\n\s*\n/);
    return blocks.map(b => {
      const t = b.trim();
      if (!t) return '';
      if (/^([-*]\s*){3,}$/.test(t) || t === '---' || t === '***') return '<hr>';
      let html = escapeHTML(t);
      if (highlighter) html = highlighter(html); // 在转义后、<br> 插入前标注
      return `<p>${html.replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }

  // ---- 进度保存 ----
  function saveProgress() {
    Store.setProgress(bookId, {
      chapter: current,
      scroll: window.scrollY || 0,
      time: Date.now(),
    });
  }
  const saveScroll = throttle(saveProgress, 800);
  window.addEventListener('scroll', () => { saveScroll(); updateProgressBar(); }, { passive: true });
  // 离开页面时再保存一次，确保滚动位置最新
  window.addEventListener('beforeunload', saveProgress);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });

  // ---- 顶部进度条 ----
  function updateProgressBar() {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    const pct = max > 0 ? (window.scrollY / max) * 100 : 0;
    els.progress.style.width = pct + '%';
  }

  // ---- 翻章 ----
  els.prev.addEventListener('click', () => loadChapter(current - 1));
  els.next.addEventListener('click', () => loadChapter(current + 1));

  // 键盘左右翻章
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowLeft' && current > 0) loadChapter(current - 1);
    if (e.key === 'ArrowRight' && current < book.chapters.length - 1) loadChapter(current + 1);
  });

  // ---- 启动 ----
  buildTOC();
  loadChapter(current, true);
})();

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
