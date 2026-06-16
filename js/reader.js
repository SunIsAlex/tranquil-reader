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
    bookmarkToggle: document.getElementById('bookmark-toggle'),
    bookmarks:  document.getElementById('bookmarks'),
    bookmarkAdd: document.getElementById('bookmark-add'),
    bookmarkList: document.getElementById('bookmark-list'),
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
  // 推荐新结构：
  // books/<book.id>/highlights.json
  // {
  //   "highlights": { "人名": ["..."] },
  //   "perChapter": { "001_xxx.txt": { "专有名词": ["..."] } }
  // }
  // 仍兼容旧结构：manifest 内联 highlights。
  const highlightData = await loadBookHighlights(book);
  let activeHighlighter = null;

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

  async function loadBookHighlights(book) {
    // Backward compatibility: old manifest style:
    // "highlights": { "人名": ["..."] }
    if (book.highlights && typeof book.highlights === 'object' && !Array.isArray(book.highlights)) {
      return {
        highlights: book.highlights,
        perChapter: book.perChapter || book.perChapterHighlights || {}
      };
    }

    // New style:
    // "highlightsFile": "highlights.json"
    // Also support "highlights": "highlights.json" for convenience.
    const file =
      typeof book.highlightsFile === 'string' ? book.highlightsFile :
      typeof book.highlights === 'string' ? book.highlights :
      '';

    if (!file) {
      return { highlights: null, perChapter: {} };
    }

    try {
      const res = await fetch(`books/${book.id}/${file}`, { cache: 'no-cache' });
      if (!res.ok) throw new Error(res.status);

      const data = await res.json();

      // Preferred format:
      // { "highlights": {...}, "perChapter": {...} }
      if (data && (data.highlights || data.perChapter || data.perChapterHighlights)) {
        return {
          highlights: data.highlights || null,
          perChapter: data.perChapter || data.perChapterHighlights || {}
        };
      }

      // Fallback: if the JSON itself is a category map, treat it as global highlights.
      return { highlights: data, perChapter: {} };
    } catch (err) {
      console.warn(`Failed to load highlights for ${book.id}:`, err);
      return { highlights: null, perChapter: {} };
    }
  }

  function hasHighlights(data) {
    if (!data) return false;

    if (data.highlights && Object.values(data.highlights).some(v => Array.isArray(v) && v.length)) {
      return true;
    }

    const perChapter = data.perChapter || {};
    return Object.values(perChapter).some(group =>
      group && typeof group === 'object' &&
      Object.values(group).some(v => Array.isArray(v) && v.length)
    );
  }

  function getChapterHighlights(ch) {
    const perChapter = highlightData.perChapter || {};

    // Filename is preferred because it is stable even if the chapter title changes.
    return perChapter[ch.file] || perChapter[ch.title] || null;
  }

  function mergeHighlights(...sources) {
    const out = {};

    for (const src of sources) {
      if (!src || typeof src !== 'object') continue;

      for (const [cat, terms] of Object.entries(src)) {
        if (!Array.isArray(terms)) continue;
        if (!out[cat]) out[cat] = [];

        const seen = new Set(out[cat]);

        for (const raw of terms) {
          const term = String(raw || '').trim();
          if (!term || seen.has(term)) continue;

          out[cat].push(term);
          seen.add(term);
        }
      }
    }

    return out;
  }

  function refreshChapterHighlighter(ch) {
    activeHighlighter = buildHighlighter(
      mergeHighlights(
        highlightData.highlights,
        getChapterHighlights(ch)
      )
    );
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
  if (!hasHighlights(highlightData)) hlBtn.hidden = true; // 这本书没配词表就不显示开关

  // ---- 状态 ----
  let current = 0;
  let currentPara = 0;       // 当前阅读到的段落序号（章内，从 0 起）
  let paraChars = [];        // 各段落的文字数（章内），用于分段进度条的段宽
  let paraSegs = [];         // 分段进度条里各段对应的 DOM 节点
  let paraTops = [];         // 各段落相对文档顶部的位置，用于二分查找当前段落
  let lastProgressPara = -1; // 上次已渲染到进度条的段落，避免重复更新 DOM
  let progressRaf = 0;
  let lastFocusBeforeTOC = null;
  let lastFocusBeforeBookmarks = null;
  let bookmarks = loadBookmarks();
  const prefetchedChapters = new Set();

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
  // 改字号会让正文重新排版、高度变化，若只改 CSS 不动滚动位置，原来的像素位置
  // 会对应到别的段落。这里记下阅读线落在“哪一段、段内高度的百分之几”，重排后
  // 按新高度把同一点还原到阅读线——段内位置也一并保留，进度不会偏移。
  function changeFont(delta) {
    const ps = els.body.querySelectorAll('p[id]');
    const line = topbarOffset();
    let anchor = null;
    if (ps.length) {
      const el = ps[Math.min(computeCurrentPara(), ps.length - 1)];
      const r = el.getBoundingClientRect();
      const frac = r.height > 0 ? (line - r.top) / r.height : 0;
      anchor = { el, frac: Math.max(0, Math.min(1, frac)) };
    }
    applyFont(Store.getFontSize() + delta);
    if (anchor) {
      const r = anchor.el.getBoundingClientRect();           // 重排后的新位置/高度
      const top = r.top + window.scrollY - line + anchor.frac * r.height;
      // 'instant' 才真正瞬时；'auto' 会沿用 html 的 scroll-behavior: smooth，
      // 导致重排后再平滑滑到锚点，视觉上就是“跳动一下”。
      window.scrollTo({ top: Math.max(0, top), behavior: 'instant' });
    }
    refreshParaTops();
    saveProgress();
    syncURL();
    updateProgressBar(currentPara);
  }
  els.fontInc.addEventListener('click', () => changeFont(+0.06));
  els.fontDec.addEventListener('click', () => changeFont(-0.06));

  // ---- 目录 ----
  function buildTOC() {
    els.tocList.innerHTML = '';
    book.chapters.forEach((ch, i) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = ch.title;
      if (i === current) a.classList.add('current');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        loadChapter(i);
        closeTOC(true);
      });
      li.appendChild(a);
      els.tocList.appendChild(li);
    });
  }

  function setupTOCAccessibility() {
    els.tocToggle.setAttribute('aria-controls', 'toc');
    els.tocToggle.setAttribute('aria-expanded', String(!els.toc.hidden));
    els.tocToggle.setAttribute('aria-label', els.toc.hidden ? '打开目录' : '关闭目录');
    els.toc.setAttribute('role', 'dialog');
    els.toc.setAttribute('aria-label', '目录');
    els.toc.setAttribute('aria-hidden', String(els.toc.hidden));
    els.toc.tabIndex = -1;
  }

  function openTOC() {
    if (!els.toc.hidden) return;
    lastFocusBeforeTOC = document.activeElement;
    els.toc.hidden = false;
    els.toc.setAttribute('aria-hidden', 'false');
    els.tocToggle.setAttribute('aria-expanded', 'true');
    els.tocToggle.setAttribute('aria-label', '关闭目录');

    requestAnimationFrame(() => {
      const target = els.tocList.querySelector('a.current') ||
        els.tocList.querySelector('a') || els.toc;
      target.focus({ preventScroll: true });
    });
  }

  function closeTOC(restoreFocus = true) {
    if (els.toc.hidden) return;
    els.toc.hidden = true;
    els.toc.setAttribute('aria-hidden', 'true');
    els.tocToggle.setAttribute('aria-expanded', 'false');
    els.tocToggle.setAttribute('aria-label', '打开目录');

    if (restoreFocus) {
      const target = lastFocusBeforeTOC && document.contains(lastFocusBeforeTOC)
        ? lastFocusBeforeTOC
        : els.tocToggle;
      target.focus({ preventScroll: true });
    }
    lastFocusBeforeTOC = null;
  }

  function trapTOCFocus(e) {
    if (els.toc.hidden || e.key !== 'Tab') return;
    const focusables = [...els.toc.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.hidden && el.offsetParent !== null);
    if (!focusables.length) {
      e.preventDefault();
      els.toc.focus({ preventScroll: true });
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

  setupTOCAccessibility();
  setupBookmarkPanelAccessibility();
  els.tocToggle.addEventListener('click', () => els.toc.hidden ? openTOC() : closeTOC(true));
  document.addEventListener('keydown', (e) => {
    trapTOCFocus(e);
    trapPanelFocus(els.bookmarks, e);
  });
  els.bookmarkToggle.addEventListener('click', () => els.bookmarks.hidden ? openBookmarks() : closeBookmarks(true));
  els.bookmarkAdd.addEventListener('click', addBookmarkAtCurrentPara);
  // 点击目录外部关闭。这里不强行归还焦点，避免打断用户点击页面其他控件。
  document.addEventListener('click', (e) => {
    if (!els.toc.hidden && !els.toc.contains(e.target) && e.target !== els.tocToggle) closeTOC(false);
    if (!els.bookmarks.hidden && !els.bookmarks.contains(e.target) && e.target !== els.bookmarkToggle) closeBookmarks(false);
  });

  // ---- 书签 / 笔记 ----
  function bookmarkKey() {
    return `reader.bookmarks.${bookId}`;
  }

  function loadBookmarks() {
    try {
      const data = JSON.parse(localStorage.getItem(`reader.bookmarks.${bookId}`));
      if (!Array.isArray(data)) return [];
      return data
        .filter(b => b && Number.isInteger(b.chapter) && Number.isInteger(b.para))
        .map(b => ({
          id: String(b.id || makeBookmarkId(b.chapter, b.para)),
          chapter: b.chapter,
          para: b.para,
          note: String(b.note || ''),
          excerpt: String(b.excerpt || ''),
          createdAt: Number.isFinite(b.createdAt) ? b.createdAt : Date.now(),
          updatedAt: Number.isFinite(b.updatedAt) ? b.updatedAt : null,
        }))
        .filter(b => b.chapter >= 0 && b.chapter < book.chapters.length && b.para >= 0);
    } catch {
      return [];
    }
  }

  function saveBookmarks() {
    try { localStorage.setItem(bookmarkKey(), JSON.stringify(bookmarks)); }
    catch { /* 隐私模式或配额满，静默失败 */ }
  }

  function makeBookmarkId(chapter, para) {
    return `${chapter}:${para}`;
  }

  function sortedBookmarks() {
    return [...bookmarks].sort((a, b) =>
      a.chapter - b.chapter || a.para - b.para || a.createdAt - b.createdAt);
  }

  function getBookmark(chapter, para) {
    return bookmarks.find(b => b.chapter === chapter && b.para === para) || null;
  }

  function currentParaElement() {
    const ps = els.body.querySelectorAll('p[id]');
    if (!ps.length) return null;
    return ps[Math.min(computeCurrentPara(), ps.length - 1)] || null;
  }

  function applyBookmarkMarks() {
    const marked = new Set(bookmarks
      .filter(b => b.chapter === current)
      .map(b => b.para));

    els.body.querySelectorAll('p[id]').forEach((p, i) => {
      p.classList.toggle('bookmarked', marked.has(i));
    });
    updateBookmarkButtonState(currentPara);
  }

  function updateBookmarkButtonState(cur = currentPara) {
    if (!els.bookmarkToggle) return;
    const marked = Boolean(getBookmark(current, cur));
    els.bookmarkToggle.classList.toggle('active', marked);
    els.bookmarkToggle.setAttribute('aria-pressed', String(marked));
    els.bookmarkToggle.title = marked ? '当前段落已加书签' : '书签和笔记';
  }

  function setupBookmarkPanelAccessibility() {
    els.bookmarkToggle.setAttribute('aria-controls', 'bookmarks');
    els.bookmarkToggle.setAttribute('aria-expanded', String(!els.bookmarks.hidden));
    els.bookmarkToggle.setAttribute('aria-label', els.bookmarks.hidden ? '打开书签和笔记' : '关闭书签和笔记');
    els.bookmarkToggle.setAttribute('aria-pressed', 'false');
    els.bookmarks.setAttribute('role', 'dialog');
    els.bookmarks.setAttribute('aria-label', '书签和笔记');
    els.bookmarks.setAttribute('aria-hidden', String(els.bookmarks.hidden));
    els.bookmarks.tabIndex = -1;
  }

  function openBookmarks() {
    if (!els.bookmarks.hidden) return;
    closeTOC(false);
    lastFocusBeforeBookmarks = document.activeElement;
    renderBookmarks();
    els.bookmarks.hidden = false;
    els.bookmarks.setAttribute('aria-hidden', 'false');
    els.bookmarkToggle.setAttribute('aria-expanded', 'true');
    els.bookmarkToggle.setAttribute('aria-label', '关闭书签和笔记');

    requestAnimationFrame(() => {
      const target = els.bookmarkAdd || els.bookmarkList.querySelector('button') || els.bookmarks;
      target.focus({ preventScroll: true });
    });
  }

  function closeBookmarks(restoreFocus = true) {
    if (els.bookmarks.hidden) return;
    els.bookmarks.hidden = true;
    els.bookmarks.setAttribute('aria-hidden', 'true');
    els.bookmarkToggle.setAttribute('aria-expanded', 'false');
    els.bookmarkToggle.setAttribute('aria-label', '打开书签和笔记');

    if (restoreFocus) {
      const target = lastFocusBeforeBookmarks && document.contains(lastFocusBeforeBookmarks)
        ? lastFocusBeforeBookmarks
        : els.bookmarkToggle;
      target.focus({ preventScroll: true });
    }
    lastFocusBeforeBookmarks = null;
  }

  function trapPanelFocus(panel, e) {
    if (panel.hidden || e.key !== 'Tab') return;
    const focusables = [...panel.querySelectorAll('a[href], button:not([disabled]), textarea, input, [tabindex]:not([tabindex="-1"])')]
      .filter(el => !el.hidden && el.offsetParent !== null);
    if (!focusables.length) {
      e.preventDefault();
      panel.focus({ preventScroll: true });
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

  function addBookmarkAtCurrentPara() {
    const para = computeCurrentPara();
    const p = currentParaElement();
    if (!p) return;

    const existing = getBookmark(current, para);
    const oldNote = existing ? existing.note : '';
    const note = prompt(
      existing ? '编辑这个书签的备注（可留空）：' : '为当前段落添加书签备注（可留空）：',
      oldNote
    );
    if (note === null) return;

    const excerpt = shortenText(p.textContent || '', 80);
    const now = Date.now();
    if (existing) {
      existing.note = note.trim();
      existing.excerpt = excerpt;
      existing.updatedAt = now;
    } else {
      bookmarks.push({
        id: makeBookmarkId(current, para),
        chapter: current,
        para,
        note: note.trim(),
        excerpt,
        createdAt: now,
        updatedAt: null,
      });
    }

    saveBookmarks();
    applyBookmarkMarks();
    renderBookmarks();
  }

  function deleteBookmark(id) {
    bookmarks = bookmarks.filter(b => b.id !== id);
    saveBookmarks();
    applyBookmarkMarks();
    renderBookmarks();
  }

  async function jumpToBookmark(id) {
    const bm = bookmarks.find(b => b.id === id);
    if (!bm) return;
    closeBookmarks(false);
    if (bm.chapter === current) {
      scrollToPara(bm.para);
      saveProgress();
      syncURL();
      updateProgressBar(bm.para);
      return;
    }
    await loadChapter(bm.chapter, { para: bm.para });
  }

  function renderBookmarks() {
    const list = sortedBookmarks();
    els.bookmarkList.innerHTML = '';

    if (!list.length) {
      const li = document.createElement('li');
      li.className = 'bookmark-empty';
      li.textContent = '还没有书签。滚到想保存的段落后，点“＋ 当前段落”。';
      els.bookmarkList.appendChild(li);
      return;
    }

    for (const bm of list) {
      const li = document.createElement('li');
      li.className = 'bookmark-item';
      li.dataset.id = bm.id;

      const jump = document.createElement('button');
      jump.type = 'button';
      jump.className = 'bookmark-jump';
      jump.innerHTML = `
        <span class="bookmark-title">${escapeHTML(book.chapters[bm.chapter]?.title || '未知章节')}</span>
        <span class="bookmark-meta">第 ${bm.chapter + 1} 章 · 段落 ${bm.para + 1}</span>
        <span class="bookmark-excerpt">${escapeHTML(bm.excerpt || '（无摘录）')}</span>
        ${bm.note ? `<span class="bookmark-note">${escapeHTML(bm.note)}</span>` : ''}
      `;
      jump.addEventListener('click', () => jumpToBookmark(bm.id));

      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'bookmark-delete';
      del.textContent = '删除';
      del.addEventListener('click', () => deleteBookmark(bm.id));

      li.appendChild(jump);
      li.appendChild(del);
      els.bookmarkList.appendChild(li);
    }
  }

  function shortenText(text, max) {
    const s = String(text || '').replace(/\s+/g, ' ').trim();
    return s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  // ---- 章节预取 ----
  // 当前章渲染完成后，浏览器空闲时静默请求下一章。
  // 在 Service Worker 存在时，这会让下一章进入 runtime cache；
  // 没有 Service Worker 时，也能利用浏览器 HTTP cache。
  function chapterURL(index) {
    const ch = book.chapters[index];
    return `books/${book.id}/${ch.file}`;
  }

  function shouldPrefetch() {
    const conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    return !(conn && conn.saveData);
  }

  function scheduleIdleTask(fn) {
    if ('requestIdleCallback' in window) {
      requestIdleCallback(fn, { timeout: 1600 });
    } else {
      setTimeout(fn, 300);
    }
  }

  function prefetchChapter(index) {
    if (!shouldPrefetch()) return;
    if (index < 0 || index >= book.chapters.length) return;
    if (prefetchedChapters.has(index)) return;

    prefetchedChapters.add(index);
    const url = chapterURL(index);

    scheduleIdleTask(async () => {
      try {
        const res = await fetch(url, { cache: 'force-cache' });
        if (!res.ok) throw new Error(String(res.status));
      } catch {
        // 预取失败不影响阅读；移出集合，之后进入前一章时可以再试。
        prefetchedChapters.delete(index);
      }
    });
  }

  function prefetchNextChapter() {
    prefetchChapter(current + 1);
  }

  // ---- 加载章节 ----
  // 章节正文以纯文本存放（.txt），空行分段，---- 作为场景分隔
  async function loadChapter(index, restore = null) {
    index = Math.min(book.chapters.length - 1, Math.max(0, index));
    current = index;
    currentPara = 0;
    lastProgressPara = -1;
    const ch = book.chapters[index];
    refreshChapterHighlighter(ch);

    els.body.innerHTML = `<p class="empty">正在加载……</p>`;
    els.chapTitle.textContent = ch.title;

    let text;
    try {
      const res = await fetch(chapterURL(index));
      if (!res.ok) throw new Error(res.status);
      text = await res.text();
    } catch {
      els.body.innerHTML = `<p class="empty">这一章读取失败（${chapterURL(index)}）。</p>`;
      return;
    }

    els.body.innerHTML = renderText(text);
    refreshParaTops();
    buildProgressSegments();   // 按本章段落字数重建分段进度条
    els.chapTitle.textContent = ch.title;
    document.title = `${ch.title} · ${book.title}`;

    // 导航按钮状态
    els.prev.disabled = index === 0;
    els.next.disabled = index === book.chapters.length - 1;

    // 高亮当前目录项
    [...els.tocList.querySelectorAll('a')].forEach((a, i) =>
      a.classList.toggle('current', i === index));

    // 滚动定位：优先段落锚点，其次旧的像素位置，否则回到顶部
    if (restore && Number.isInteger(restore.para) && restore.para > 0) {
      scrollToPara(restore.para);
    } else if (restore && restore.scroll) {
      window.scrollTo({ top: restore.scroll, behavior: 'auto' });
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    refreshParaTops();
    saveProgress();   // 同时刷新 currentPara
    syncURL();
    updateProgressBar(currentPara);
    applyBookmarkMarks();
    prefetchNextChapter();
  }

  function refreshParaTops() {
    paraTops = [...els.body.querySelectorAll('p[id]')]
      .map(el => el.getBoundingClientRect().top + window.scrollY);
  }

  // 找出“正在读”的段落：阅读线（顶栏下沿）之上、最靠下的那个 <p>
  // 用段落 top 坐标二分，避免滚动时反复遍历所有段落。
  function computeCurrentPara() {
    if (!paraTops.length) refreshParaTops();
    if (!paraTops.length) return 0;

    const lineY = window.scrollY + topbarOffset();
    let lo = 0;
    let hi = paraTops.length - 1;
    let idx = 0;

    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (paraTops[mid] <= lineY) {
        idx = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return idx;
  }

  // 把某段滚到阅读线位置（瞬时，绕过 scroll-behavior: smooth）
  function scrollToPara(i) {
    const ps = els.body.querySelectorAll('p[id]');
    if (!ps.length) return;
    const el = ps[Math.min(i, ps.length - 1)];
    const top = el.getBoundingClientRect().top + window.scrollY - topbarOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }

  // 阅读线 = 粘性顶栏下沿，留一点余量
  function topbarOffset() {
    const bar = document.querySelector('.topbar');
    return (bar ? bar.offsetHeight : 56) + 8;
  }

  // 把章节 + 段落同步进地址栏：?book=…&chapter=N#pM
  // 用 replaceState，既不污染前进/后退历史，也不会触发滚动跳转
  function syncURL() {
    const base = `?book=${encodeURIComponent(bookId)}&chapter=${current}`;
    const hash = currentPara > 0 ? `#p${currentPara}` : '';
    history.replaceState(null, '', base + hash);
  }

  function parseParaFromHash(h) {
    const m = /^#p(\d+)$/.exec(h || '');
    return m ? parseInt(m[1], 10) : null;
  }

  // 纯文本 -> 段落 HTML。空行分段，单独一行的 --- / *** 视作场景分隔
  // 每个段落带上 id="pN"（章内序号），供段落级进度定位与 URL 锚点使用
  function renderText(raw) {
    const blocks = raw.replace(/\r\n/g, '\n').split(/\n\s*\n/);
    let pi = 0;
    paraChars = [];
    return blocks.map(b => {
      const t = b.trim();
      if (!t) return '';
      if (/^([-*]\s*){3,}$/.test(t) || t === '---' || t === '***') return '<hr>';
      let html = escapeHTML(t);
      if (activeHighlighter) html = activeHighlighter(html); // 在转义后、<br> 插入前标注
      paraChars[pi] = t.length;                  // 原始文字数（与字号无关）
      return `<p id="p${pi++}">${html.replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }

  // ---- 进度保存 ----
  function saveProgress() {
    currentPara = computeCurrentPara();
    updateProgressBar(currentPara);
    Store.setProgress(bookId, {
      chapter: current,
      para: currentPara,
      scroll: window.scrollY || 0,   // 旧字段保留，作为无段落数据时的兜底
      time: Date.now(),
    });
  }
  const saveScroll = throttle(() => { saveProgress(); syncURL(); }, 800);

  function requestProgressUpdate() {
    if (progressRaf) return;
    progressRaf = requestAnimationFrame(() => {
      progressRaf = 0;
      updateProgressBar();
    });
  }

  window.addEventListener('scroll', () => {
    saveScroll();
    requestProgressUpdate();
  }, { passive: true });
  // 离开页面时再保存一次，确保滚动位置最新
  window.addEventListener('beforeunload', saveProgress);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });

  // ---- 顶部进度条（bilibili 式分段）----
  // 每个段落一段，段宽（flex-grow）正比于段落字数。进度以“当前所在段落序号”
  // 离散推进：读到第 N 段就点亮前 N 段。字数与字号无关，所以调字号时不漂移。
  function buildProgressSegments() {
    els.progress.innerHTML = '';
    paraSegs = paraChars.map(n => {
      const seg = document.createElement('span');
      seg.className = 'progress-seg';
      seg.style.flex = `${Math.max(1, n)} 0 0`;   // 段宽正比于字数
      els.progress.appendChild(seg);
      return seg;
    });
    lastProgressPara = -1;
    updateProgressBar();
  }

  function updateProgressBar(cur = computeCurrentPara()) {
    currentPara = cur;
    if (cur === lastProgressPara) return;

    for (let i = 0; i < paraSegs.length; i++) {
      paraSegs[i].classList.toggle('read', i <= cur);
    }
    updateBookmarkButtonState(cur);
    lastProgressPara = cur;
  }

  // ---- 翻章 ----
  els.prev.addEventListener('click', () => loadChapter(current - 1));
  els.next.addEventListener('click', () => loadChapter(current + 1));

  // 键盘左右翻章；抽屉打开时只处理 Esc，避免焦点在抽屉中误触翻章。
  document.addEventListener('keydown', (e) => {
    if (!els.toc.hidden || !els.bookmarks.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeTOC(true);
        closeBookmarks(true);
      }
      return;
    }
    if (e.target.matches('input, textarea')) return;
    if (e.key === 'ArrowLeft' && current > 0) loadChapter(current - 1);
    if (e.key === 'ArrowRight' && current < book.chapters.length - 1) loadChapter(current + 1);
  });

  // ---- 启动 ----
  buildTOC();
  renderBookmarks();

  // 让浏览器原生的锚点跳转（#pN 分享链接 / 刷新恢复）也停在顶栏下方，
  // 否则 #pN 会被滚到视口最顶端、被 sticky 顶栏遮住。取值与阅读线一致。
  function refreshLayoutState() {
    document.documentElement.style.scrollPaddingTop = topbarOffset() + 'px';
    refreshParaTops();
    updateProgressBar();
  }
  refreshLayoutState();
  window.addEventListener('resize', () => {
    requestAnimationFrame(refreshLayoutState);
  });

  // 恢复位置：URL 锚点（#pN，分享链接用）> 本地保存的段落 > 旧的像素进度 > 顶部
  let restore = null;
  const hashPara = parseParaFromHash(location.hash);
  if (hashPara != null) {
    restore = { para: hashPara };
  } else if (saved && saved.chapter === current) {
    if (Number.isInteger(saved.para)) restore = { para: saved.para };
    else if (saved.scroll) restore = { scroll: saved.scroll };
  }
  loadChapter(current, restore);
})();

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}