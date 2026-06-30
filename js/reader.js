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
    searchToggle: document.getElementById('search-toggle'),
    searchPanel:  document.getElementById('search-panel'),
    searchForm:   document.getElementById('search-form'),
    searchInput:  document.getElementById('search-input'),
    searchStatus: document.getElementById('search-status'),
    searchResults: document.getElementById('search-results'),
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
  if (!book) {
    els.body.innerHTML = `<p class="empty">找不到这本书。</p>`;
    return;
  }

  els.title.textContent = book.title;
  document.title = `${book.title} · 静读`;

  const pdfjsLoadPromises = {
    modern: null,
    legacy: null,
  };
  let pdfjsBuild = 'modern';
  const pdfDocumentCache = new Map();

  if (isPDFBook(book)) {
    initPDFReader(book);
    return;
  }

  if (!book.chapters || !book.chapters.length) {
    els.body.innerHTML = `<p class="empty">找不到这本书或它没有章节。</p>`;
    return;
  }

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

  function isPDFBook(book) {
    return book && (
      book.type === 'pdf' ||
      typeof book.pdfUrl === 'string' ||
      typeof book.pdfKey === 'string' ||
      Array.isArray(book.parts)
    );
  }

  function initPDFReader(book) {
    const parts = getPDFParts(book);
    document.body.classList.add('pdf-reading');
    els.progress.hidden = true;

    [
      els.fontInc,
      els.fontDec,
      document.getElementById('hl-toggle'),
      els.searchToggle,
      els.tocToggle,
    ].forEach(el => { if (el) el.hidden = true; });

    if (!parts.length) {
      els.chapTitle.textContent = book.title;
      els.body.innerHTML = `<p class="empty">这本 PDF 没有配置 pdfUrl、pdfKey 或 parts。</p>`;
      document.querySelector('.chapter-nav')?.remove();
      return;
    }

    const savedPDF = Store.getProgress(bookId);
    const savedPart = savedPDF && Number.isInteger(savedPDF.chapter)
      ? Math.max(0, Math.min(savedPDF.chapter, parts.length - 1))
      : 0;
    const initialPage = savedPDF && Number.isInteger(savedPDF.para) && savedPDF.para > 0
      ? savedPDF.para
      : 1;

    els.body.innerHTML = renderPDFReader(parts, savedPart, initialPage, book.title);
    document.querySelector('.chapter-nav')?.remove();

    const viewer = els.body.querySelector('.pdf-canvas-wrap');
    const canvas = els.body.querySelector('.pdf-canvas');
    const status = els.body.querySelector('.pdf-status');
    const toolbar = els.body.querySelector('.pdf-toolbar');
    const partSelect = els.body.querySelector('.pdf-part-select');
    const pageInput = els.body.querySelector('.pdf-page-input');
    const openLink = els.body.querySelector('.pdf-open-link');
    const pageTotal = els.body.querySelector('.pdf-page-total');
    const zoomValue = els.body.querySelector('.pdf-zoom-value');
    let currentPart = savedPart;
    let currentPage = initialPage;
    let zoom = 1;
    let renderTicket = 0;
    let activeRenderTask = null;
    let resizeTimer = 0;
    let wheelZoomTimer = 0;
    let pinch = null;
    let zoomFocus = null;
    let edgeSwipe = null;
    let ignoreClickUntil = 0;
    let bookmarks = loadPDFBookmarks();
    const isMobilePDF = window.matchMedia('(pointer: coarse)').matches;
    const pdfHistoryGuard = 'pdf-reader-guard';

    setupPDFBookmarks();

    if (isMobilePDF) {
      history.replaceState({ ...(history.state || {}), pdfReader: true }, '', location.href);
      history.pushState({ pdfReader: true, guard: pdfHistoryGuard }, '', location.href);
      window.addEventListener('popstate', handlePDFHistoryBack);
    }

    function setPDFLocation(partIndex, page) {
      currentPart = Math.max(0, Math.min(partIndex, parts.length - 1));
      const part = parts[currentPart];
      const pageCount = Number.isInteger(part.pageCount) && part.pageCount > 0
        ? part.pageCount
        : null;
      const nextPage = Math.max(1, pageCount ? Math.min(page, pageCount) : page);
      const src = pdfURLWithPage(part.src, nextPage);
      currentPage = nextPage;

      els.chapTitle.textContent = parts.length > 1 ? part.title : book.title;
      partSelect.value = String(currentPart);
      pageInput.value = String(nextPage);
      if (pageCount) {
        pageInput.max = String(pageCount);
        pageTotal.textContent = `/ ${pageCount}`;
      } else {
        pageInput.removeAttribute('max');
        pageTotal.textContent = '';
      }
      openLink.href = src;
      Store.setProgress(bookId, {
        chapter: currentPart,
        para: nextPage,
        scroll: 0,
        time: Date.now(),
      });
      updatePDFBookmarkButton();
      renderPDFPage(part, nextPage, ++renderTicket);
    }

    partSelect.addEventListener('change', () => {
      setPDFLocation(parseInt(partSelect.value, 10) || 0, 1);
    });
    pageInput.addEventListener('change', () => {
      setPDFLocation(currentPart, parseInt(pageInput.value, 10) || 1);
    });
    pageInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        setPDFLocation(currentPart, parseInt(pageInput.value, 10) || 1);
      }
    });

    toolbar.addEventListener('pointerdown', (e) => e.stopPropagation());
    toolbar.addEventListener('click', (e) => e.stopPropagation());
    toolbar.addEventListener('focusin', showPDFControls);
    toolbar.addEventListener('pointermove', showPDFControls);

    viewer.addEventListener('click', (e) => {
      if (Date.now() < ignoreClickUntil || e.target.closest('.pdf-toolbar')) return;
      const rect = viewer.getBoundingClientRect();
      const position = (e.clientX - rect.left) / rect.width;
      const controlsWereVisible = !document.body.classList.contains('pdf-controls-hidden');
      if (controlsWereVisible) hidePDFControls();
      if (position < 0.3) {
        changePDFPage(-1);
      } else if (position > 0.7) {
        changePDFPage(1);
      } else if (!isMobilePDF && !controlsWereVisible) {
        togglePDFControls();
      }
    });

    viewer.addEventListener('touchstart', handlePDFTouchStart, { passive: false });
    viewer.addEventListener('touchmove', handlePDFTouchMove, { passive: false });
    viewer.addEventListener('touchend', handlePDFTouchEnd, { passive: true });
    viewer.addEventListener('touchcancel', handlePDFTouchEnd, { passive: true });
    viewer.addEventListener('wheel', handlePDFWheel, { passive: false });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !els.bookmarks.hidden) {
        e.preventDefault();
        closePDFBookmarks();
        return;
      }
      if (e.target.matches('input, select')) return;
      if (e.key === 'ArrowLeft' || e.key === 'PageUp') {
        e.preventDefault();
        changePDFPage(-1);
      } else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') {
        e.preventDefault();
        changePDFPage(1);
      }
    });

    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = window.setTimeout(renderCurrentPDFPage, 180);
    });

    showPDFControls();
    setPDFLocation(savedPart, initialPage);

    function changePDFPage(delta) {
      const part = parts[currentPart];
      const pageCount = Number.isInteger(part.pageCount) ? part.pageCount : null;
      if (delta < 0 && currentPage <= 1) {
        if (currentPart > 0) {
          const previous = parts[currentPart - 1];
          setPDFLocation(currentPart - 1, previous.pageCount || 1);
        }
        return;
      }
      if (delta > 0 && pageCount && currentPage >= pageCount) {
        if (currentPart < parts.length - 1) setPDFLocation(currentPart + 1, 1);
        return;
      }
      setPDFLocation(currentPart, currentPage + delta);
    }

    function showPDFControls() {
      document.body.classList.remove('pdf-controls-hidden', 'reader-topbar-hidden');
    }

    function handlePDFBackGesture(menuWasVisible) {
      if (!els.bookmarks.hidden) {
        closePDFBookmarks(false);
        return true;
      }
      if (menuWasVisible) {
        history.back();
        return true;
      }
      showPDFControls();
      return false;
    }

    function handlePDFHistoryBack() {
      if (!els.bookmarks.hidden) {
        closePDFBookmarks(false);
        history.pushState({ pdfReader: true, guard: pdfHistoryGuard }, '', location.href);
        return;
      }
      if (document.body.classList.contains('pdf-controls-hidden')) {
        showPDFControls();
        history.pushState({ pdfReader: true, guard: pdfHistoryGuard }, '', location.href);
        return;
      }
      location.replace('index.html');
    }

    function hidePDFControls(rerender = true) {
      const wasVisible = !document.body.classList.contains('pdf-controls-hidden');
      document.body.classList.add('pdf-controls-hidden', 'reader-topbar-hidden');
      if (rerender && wasVisible && canvas.width) {
        requestAnimationFrame(renderCurrentPDFPage);
      }
    }

    function togglePDFControls() {
      if (document.body.classList.contains('pdf-controls-hidden')) {
        showPDFControls();
      } else {
        hidePDFControls();
      }
    }

    function touchDistance(touches) {
      return Math.hypot(
        touches[0].clientX - touches[1].clientX,
        touches[0].clientY - touches[1].clientY
      );
    }

    function handlePDFWheel(e) {
      if (!e.ctrlKey || !canvas.width) return;
      e.preventDefault();

      const canvasRect = canvas.getBoundingClientRect();
      const viewerRect = viewer.getBoundingClientRect();
      const delta = e.deltaMode === 1
        ? e.deltaY * 16
        : e.deltaMode === 2
          ? e.deltaY * viewer.clientHeight
          : e.deltaY;
      const nextZoom = Math.round(
        Math.min(4, Math.max(1, zoom * Math.exp(-delta * 0.002))) * 100
      ) / 100;

      if (nextZoom === zoom) return;

      zoomFocus = {
        x: Math.min(1, Math.max(0, (e.clientX - canvasRect.left) / Math.max(1, canvasRect.width))),
        y: Math.min(1, Math.max(0, (e.clientY - canvasRect.top) / Math.max(1, canvasRect.height))),
        viewerX: e.clientX - viewerRect.left,
        viewerY: e.clientY - viewerRect.top,
      };
      zoom = nextZoom;
      zoomValue.textContent = `${Math.round(zoom * 100)}%`;
      ignoreClickUntil = Date.now() + 300;

      clearTimeout(wheelZoomTimer);
      wheelZoomTimer = window.setTimeout(() => {
        wheelZoomTimer = 0;
        renderCurrentPDFPage();
      }, 100);
    }

    function handlePDFTouchStart(e) {
      if (e.touches.length === 1 && isMobilePDF) {
        const touch = e.touches[0];
        const edgeSize = 28;
        if (touch.clientX <= edgeSize || touch.clientX >= window.innerWidth - edgeSize) {
          e.preventDefault();
          edgeSwipe = {
            side: touch.clientX <= edgeSize ? 'left' : 'right',
            menuWasVisible: !document.body.classList.contains('pdf-controls-hidden'),
            x: touch.clientX,
            y: touch.clientY,
            lastX: touch.clientX,
            lastY: touch.clientY,
          };
        } else {
          hidePDFControls();
        }
        return;
      }
      if (e.touches.length !== 2) return;
      edgeSwipe = null;
      const canvasRect = canvas.getBoundingClientRect();
      const viewerRect = viewer.getBoundingClientRect();
      const centerX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      const centerY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
      pinch = {
        distance: Math.max(1, touchDistance(e.touches)),
        zoom,
        nextZoom: zoom,
        focusX: Math.min(1, Math.max(0, (centerX - canvasRect.left) / Math.max(1, canvasRect.width))),
        focusY: Math.min(1, Math.max(0, (centerY - canvasRect.top) / Math.max(1, canvasRect.height))),
        viewerX: centerX - viewerRect.left,
        viewerY: centerY - viewerRect.top,
      };
      canvas.style.transformOrigin = `${pinch.focusX * 100}% ${pinch.focusY * 100}%`;
      canvas.classList.add('is-pinching');
      hidePDFControls(false);
      ignoreClickUntil = Date.now() + 500;
    }

    function handlePDFTouchMove(e) {
      if (edgeSwipe && e.touches.length === 1) {
        e.preventDefault();
        edgeSwipe.lastX = e.touches[0].clientX;
        edgeSwipe.lastY = e.touches[0].clientY;
        return;
      }
      if (!pinch || e.touches.length !== 2) return;
      e.preventDefault();
      const ratio = touchDistance(e.touches) / pinch.distance;
      pinch.nextZoom = Math.min(4, Math.max(1, pinch.zoom * ratio));
      canvas.style.transform = `scale(${pinch.nextZoom / zoom})`;
      zoomValue.textContent = `${Math.round(pinch.nextZoom * 100)}%`;
      ignoreClickUntil = Date.now() + 500;
    }

    function handlePDFTouchEnd(e) {
      if (edgeSwipe && e.touches.length === 0) {
        const menuWasVisible = edgeSwipe.menuWasVisible;
        const dx = edgeSwipe.lastX - edgeSwipe.x;
        const dy = edgeSwipe.lastY - edgeSwipe.y;
        const inward = edgeSwipe.side === 'left' ? dx : -dx;
        edgeSwipe = null;
        if (inward >= 56 && Math.abs(dx) > Math.abs(dy) * 1.25) {
          ignoreClickUntil = Date.now() + 500;
          handlePDFBackGesture(menuWasVisible);
        }
        return;
      }
      if (!pinch || e.touches.length > 1) return;
      zoom = pinch.nextZoom;
      zoomFocus = {
        x: pinch.focusX,
        y: pinch.focusY,
        viewerX: pinch.viewerX,
        viewerY: pinch.viewerY,
      };
      pinch = null;
      canvas.classList.remove('is-pinching');
      canvas.style.transform = '';
      canvas.style.transformOrigin = '';
      ignoreClickUntil = Date.now() + 500;
      renderCurrentPDFPage();
    }

    function renderCurrentPDFPage() {
      renderPDFPage(parts[currentPart], currentPage, ++renderTicket);
    }

    async function renderPDFPage(part, page, ticket) {
      if (activeRenderTask) {
        activeRenderTask.cancel();
        activeRenderTask = null;
      }
      status.textContent = pdfjsBuild === 'legacy'
        ? '正在使用兼容模式加载 PDF...'
        : '正在加载 PDF...';
      viewer.classList.add('is-loading');

      try {
        const pdf = await loadPDFDocument(part.src);
        if (ticket !== renderTicket) return;

        const pageCount = pdf.numPages;
        part.pageCount = pageCount;
        const nextPage = Math.max(1, Math.min(page, pageCount));
        pageInput.max = String(pageCount);
        pageInput.value = String(nextPage);
        pageTotal.textContent = `/ ${pageCount}`;

        const pdfPage = await pdf.getPage(nextPage);
        if (ticket !== renderTicket) return;

        const baseViewport = pdfPage.getViewport({ scale: 1 });
        const availableWidth = Math.max(280, viewer.clientWidth || window.innerWidth || 360);
        const availableHeight = Math.max(320, viewer.clientHeight || window.innerHeight || 640);
        const fitScale = Math.min(
          availableWidth / baseViewport.width,
          availableHeight / baseViewport.height
        );
        const cssScale = Math.max(0.25, fitScale * zoom);
        const viewport = pdfPage.getViewport({ scale: cssScale });
        const deviceScale = Math.min(window.devicePixelRatio || 1, 3);
        const maxPixels = 24 * 1024 * 1024;
        const pixelScale = Math.min(
          deviceScale,
          Math.sqrt(maxPixels / Math.max(1, viewport.width * viewport.height))
        );

        canvas.width = Math.floor(viewport.width * pixelScale);
        canvas.height = Math.floor(viewport.height * pixelScale);
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;

        if (zoomFocus) {
          const focus = zoomFocus;
          zoomFocus = null;
          requestAnimationFrame(() => {
            viewer.scrollLeft = canvas.offsetLeft + viewport.width * focus.x - focus.viewerX;
            viewer.scrollTop = canvas.offsetTop + viewport.height * focus.y - focus.viewerY;
          });
        }

        const context = canvas.getContext('2d', { alpha: false });
        context.setTransform(pixelScale, 0, 0, pixelScale, 0, 0);
        context.fillStyle = '#fff';
        context.fillRect(0, 0, viewport.width, viewport.height);

        const renderTask = pdfPage.render({ canvasContext: context, viewport });
        activeRenderTask = renderTask;
        try {
          await renderTask.promise;
        } finally {
          if (activeRenderTask === renderTask) activeRenderTask = null;
        }
        if (ticket !== renderTicket) return;

        status.textContent = '';
        viewer.classList.remove('is-loading');
        currentPage = nextPage;
        pageInput.value = String(nextPage);
        openLink.href = pdfURLWithPage(part.src, nextPage);
        zoomValue.textContent = `${Math.round(zoom * 100)}%`;
        updatePDFBookmarkButton();

        if (nextPage !== page) {
          Store.setProgress(bookId, {
            chapter: currentPart,
            para: nextPage,
            scroll: 0,
            time: Date.now(),
          });
        }
      } catch (err) {
        if (ticket !== renderTicket) return;
        if (isPDFRenderCancellation(err)) {
          viewer.classList.remove('is-loading');
          return;
        }
        if (pdfjsBuild !== 'legacy') {
          console.warn('Modern PDF.js failed; retrying with the legacy build:', err);
          pdfjsBuild = 'legacy';
          await renderPDFPage(part, page, ticket);
          return;
        }
        console.warn('Failed to render PDF:', err);
        viewer.classList.remove('is-loading');
        status.textContent = `PDF 加载失败：${pdfErrorMessage(err)}。请用“新窗口打开”。`;
      }
    }

    function loadPDFBookmarks() {
      return Store.getBookmarks(bookId)
        .filter(bookmark => {
          if (bookmark.chapter < 0 || bookmark.chapter >= parts.length || bookmark.para < 1) {
            return false;
          }
          const pageCount = parts[bookmark.chapter].pageCount;
          return !Number.isInteger(pageCount) || bookmark.para <= pageCount;
        });
    }

    function savePDFBookmarks() {
      Store.setBookmarks(bookId, bookmarks);
    }

    function getPDFBookmark(partIndex = currentPart, page = currentPage) {
      return bookmarks.find(
        bookmark => bookmark.chapter === partIndex && bookmark.para === page
      ) || null;
    }

    function updatePDFBookmarkButton() {
      const marked = Boolean(getPDFBookmark());
      els.bookmarkToggle.classList.toggle('active', marked);
      els.bookmarkToggle.setAttribute('aria-pressed', String(marked));
      els.bookmarkToggle.title = marked ? '当前页已加书签' : '书签和笔记';
    }

    function setupPDFBookmarks() {
      els.bookmarkAdd.textContent = '＋ 当前页';
      els.bookmarkToggle.hidden = false;
      els.bookmarkToggle.setAttribute('aria-controls', 'bookmarks');
      els.bookmarkToggle.setAttribute('aria-expanded', 'false');
      els.bookmarkToggle.setAttribute('aria-label', '打开书签和笔记');
      els.bookmarkToggle.setAttribute('aria-pressed', 'false');
      els.bookmarks.setAttribute('role', 'dialog');
      els.bookmarks.setAttribute('aria-label', '书签和笔记');
      els.bookmarks.setAttribute('aria-hidden', 'true');
      els.bookmarks.tabIndex = -1;

      els.bookmarkToggle.addEventListener('click', () => {
        if (els.bookmarks.hidden) openPDFBookmarks();
        else closePDFBookmarks();
      });
      els.bookmarkAdd.addEventListener('click', addPDFBookmark);
      document.addEventListener('click', (event) => {
        if (
          !els.bookmarks.hidden &&
          !els.bookmarks.contains(event.target) &&
          event.target !== els.bookmarkToggle
        ) {
          closePDFBookmarks(false);
        }
      });
    }

    function openPDFBookmarks() {
      showPDFControls();
      renderPDFBookmarks();
      els.bookmarks.hidden = false;
      els.bookmarks.setAttribute('aria-hidden', 'false');
      els.bookmarkToggle.setAttribute('aria-expanded', 'true');
      els.bookmarkToggle.setAttribute('aria-label', '关闭书签和笔记');
      requestAnimationFrame(() => {
        const target = els.bookmarkAdd || els.bookmarkList.querySelector('button') || els.bookmarks;
        target.focus({ preventScroll: true });
      });
    }

    function closePDFBookmarks(restoreFocus = true) {
      if (els.bookmarks.hidden) return;
      els.bookmarks.hidden = true;
      els.bookmarks.setAttribute('aria-hidden', 'true');
      els.bookmarkToggle.setAttribute('aria-expanded', 'false');
      els.bookmarkToggle.setAttribute('aria-label', '打开书签和笔记');
      if (restoreFocus) els.bookmarkToggle.focus({ preventScroll: true });
    }

    function addPDFBookmark() {
      const existing = getPDFBookmark();
      const note = prompt(
        existing ? '编辑这个页面书签的备注（可留空）：' : '为当前页面添加书签备注（可留空）：',
        existing ? existing.note : ''
      );
      if (note === null) return;

      const now = Date.now();
      if (existing) {
        existing.note = note.trim();
        existing.updatedAt = now;
      } else {
        bookmarks.push({
          id: `${currentPart}:${currentPage}`,
          chapter: currentPart,
          para: currentPage,
          note: note.trim(),
          excerpt: `${parts[currentPart].title} · 第 ${currentPage} 页`,
          createdAt: now,
          updatedAt: null,
        });
      }
      savePDFBookmarks();
      updatePDFBookmarkButton();
      renderPDFBookmarks();
    }

    function deletePDFBookmark(id) {
      bookmarks = bookmarks.filter(bookmark => bookmark.id !== id);
      savePDFBookmarks();
      updatePDFBookmarkButton();
      renderPDFBookmarks();
    }

    function jumpToPDFBookmark(id) {
      const bookmark = bookmarks.find(item => item.id === id);
      if (!bookmark) return;
      closePDFBookmarks(false);
      setPDFLocation(bookmark.chapter, bookmark.para);
    }

    function renderPDFBookmarks() {
      const list = [...bookmarks].sort((a, b) =>
        a.chapter - b.chapter || a.para - b.para || a.createdAt - b.createdAt
      );
      els.bookmarkList.innerHTML = '';

      if (!list.length) {
        const li = document.createElement('li');
        li.className = 'bookmark-empty';
        li.textContent = '还没有书签。翻到想保存的页面后，点“＋ 当前页”。';
        els.bookmarkList.appendChild(li);
        return;
      }

      for (const bookmark of list) {
        const li = document.createElement('li');
        li.className = 'bookmark-item';
        li.dataset.id = bookmark.id;

        const jump = document.createElement('button');
        jump.type = 'button';
        jump.className = 'bookmark-jump';
        jump.innerHTML = `
          <span class="bookmark-title">${escapeHTML(parts[bookmark.chapter]?.title || '未知章节')}</span>
          <span class="bookmark-meta">第 ${bookmark.chapter + 1} 章 · 第 ${bookmark.para} 页</span>
          ${bookmark.note ? `<span class="bookmark-note">${escapeHTML(bookmark.note)}</span>` : ''}
        `;
        jump.addEventListener('click', () => jumpToPDFBookmark(bookmark.id));

        const del = document.createElement('button');
        del.type = 'button';
        del.className = 'bookmark-delete';
        del.textContent = '删除';
        del.addEventListener('click', () => deletePDFBookmark(bookmark.id));

        li.appendChild(jump);
        li.appendChild(del);
        els.bookmarkList.appendChild(li);
      }
    }
  }

  async function loadPDFJS(build = pdfjsBuild) {
    if (!pdfjsLoadPromises[build]) {
      const legacy = build === 'legacy';
      // Use .js extensions so static hosts return a JavaScript MIME type.
      const pdfjsURL = new URL(
        legacy ? 'vendor/pdfjs/pdf.legacy.min.js' : 'vendor/pdfjs/pdf.min.js',
        location.href
      ).href;
      const workerURL = new URL(
        legacy ? 'vendor/pdfjs/pdf.worker.legacy.min.js' : 'vendor/pdfjs/pdf.worker.min.js',
        location.href
      ).href;
      pdfjsLoadPromises[build] = import(pdfjsURL).then(pdfjs => {
        pdfjs.GlobalWorkerOptions.workerSrc = workerURL;
        return pdfjs;
      });
    }
    return pdfjsLoadPromises[build];
  }

  async function loadPDFDocument(src) {
    const build = pdfjsBuild;
    const cacheKey = `${build}:${src}`;
    if (!pdfDocumentCache.has(cacheKey)) {
      pdfDocumentCache.set(cacheKey, loadPDFJS(build).then(pdfjs => pdfjs.getDocument({
        url: src,
        disableRange: false,
        disableStream: true,
        disableAutoFetch: true,
        rangeChunkSize: 256 * 1024,
        cMapUrl: new URL('vendor/pdfjs/cmaps/', location.href).href,
        cMapPacked: true,
        standardFontDataUrl: new URL('vendor/pdfjs/standard_fonts/', location.href).href,
        wasmUrl: new URL('vendor/pdfjs/wasm/', location.href).href,
        useWorkerFetch: false,
        isOffscreenCanvasSupported: false,
        isImageDecoderSupported: false,
      }).promise));
    }
    return pdfDocumentCache.get(cacheKey);
  }

  function isPDFRenderCancellation(err) {
    return Boolean(err && (
      err.name === 'RenderingCancelledException' ||
      /rendering cancelled/i.test(String(err.message || ''))
    ));
  }

  function pdfErrorMessage(err) {
    const raw = err && (err.message || err.name || String(err));
    return String(raw || '未知错误').replace(/\s+/g, ' ').slice(0, 180);
  }

  function getPDFParts(book) {
    const rawParts = Array.isArray(book.parts) && book.parts.length
      ? book.parts
      : [book];

    return rawParts
      .map((part, index) => {
        const src = resolvePDFSource(part);
        if (!src) return null;
        const title = typeof part.title === 'string' && part.title.trim()
          ? part.title.trim()
          : `第 ${index + 1} 卷`;
        const pageCount = Number.isInteger(part.pageCount) && part.pageCount > 0
          ? part.pageCount
          : null;
        return { title, src, pageCount };
      })
      .filter(Boolean);
  }

  function resolvePDFSource(source) {
    const pdfUrl = typeof source.pdfUrl === 'string' ? source.pdfUrl.trim() : '';
    if (pdfUrl) return pdfUrl;

    const pdfKey = typeof source.pdfKey === 'string' ? source.pdfKey.trim() : '';
    if (pdfKey) return `api/pdf?key=${encodeURIComponent(pdfKey)}`;

    return '';
  }

  function renderPDFReader(parts, partIndex, page, title) {
    const options = parts.map((part, index) => (
      `<option value="${index}" ${index === partIndex ? 'selected' : ''}>${escapeHTML(part.title)}</option>`
    )).join('');
    const part = parts[partIndex];
    const pageCount = Number.isInteger(part.pageCount) && part.pageCount > 0 ? part.pageCount : null;
    const total = pageCount ? `/ ${pageCount}` : '';
    return `
      <section class="pdf-reader-shell">
        <div class="pdf-toolbar">
          <select class="pdf-part-select"${parts.length > 1 ? '' : ' hidden'} aria-label="选择 PDF 分卷">
            ${options}
          </select>
          <label class="pdf-page-label">
            <span class="sr-only">页码</span>
            <input class="pdf-page-input" type="number" inputmode="numeric" min="1" ${pageCount ? `max="${pageCount}"` : ''} value="${page}">
            <span class="pdf-page-total">${total}</span>
          </label>
          <span class="pdf-zoom-value">100%</span>
          <a class="pdf-open-link" href="${escapeHTML(pdfURLWithPage(part.src, page))}" target="_blank" rel="noopener" title="新窗口打开" aria-label="新窗口打开">↗</a>
        </div>
        <div class="pdf-canvas-wrap" role="region" aria-label="${escapeHTML(title || 'PDF')}">
          <span class="pdf-edge-gesture pdf-edge-gesture-left" aria-hidden="true"></span>
          <span class="pdf-edge-gesture pdf-edge-gesture-right" aria-hidden="true"></span>
          <canvas class="pdf-canvas"></canvas>
          <p class="pdf-status" aria-live="polite"></p>
        </div>
      </section>`;
  }

  function pdfURLWithPage(src, page) {
    const clean = String(src || '').split('#')[0];
    return `${clean}#page=${Math.max(1, page || 1)}&toolbar=1&navpanes=0`;
  }

  // ---- 状态 ----
  let current = 0;
  let currentPara = 0;       // 当前阅读到的段落序号（章内，从 0 起）
  let paraChars = [];        // 各段落的文字数（章内），用于分段进度条的段宽
  let paraSegs = [];         // 分段进度条里各段对应的 DOM 节点
  let paraEls = [];          // Cache rendered paragraph nodes for scroll/progress work.
  let paraTops = [];         // 各段落相对文档顶部的位置，用于二分查找当前段落
  let lastProgressPara = -1; // 上次已渲染到进度条的段落，避免重复更新 DOM
  let progressRaf = 0;
  let lastFocusBeforeTOC = null;
  let lastFocusBeforeSearch = null;
  let lastFocusBeforeBookmarks = null;
  let bookmarks = loadBookmarks();
  const prefetchedChapters = new Set();

  const searchCache = new Map();
  let searchRunId = 0;
  let pendingSearchTarget = null;

  let activeOverlayHistory = null;
  let ignoreNextPopState = false;
  let tocSwipeStart = null;

  let topbarHidden = false;
  let topbarAutoHideReady = false;
  let lastTopbarScrollY = getScrollY();
  let topbarDownDistance = 0;
  let topbarUpDistance = 0;
  let topbarTouchStartY = 0;
  let topbarTouchLastY = 0;
  let topbarTouchDistance = 0;
  let textEdgeSwipe = null;
  const isMobileTextReader = window.matchMedia('(pointer: coarse)').matches;
  const textHistoryGuard = 'text-reader-guard';
  const originalScrollRestoration = history.scrollRestoration;
  const topbar = document.querySelector('.topbar');
  let topbarOffsetValue = 64;
  let tocLinks = [];

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
    const line = topbarOffset();
    let anchor = null;
    if (paraEls.length) {
      const el = paraEls[Math.min(computeCurrentPara(), paraEls.length - 1)];
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
    const frag = document.createDocumentFragment();
    tocLinks = [];
    book.chapters.forEach((ch, i) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = '#';
      a.textContent = ch.title;
      if (i === current) a.classList.add('current');
      a.addEventListener('click', (e) => {
        e.preventDefault();
        closeTOC(true, { keepHistory: true });
        loadChapter(i);
      });
      li.appendChild(a);
      frag.appendChild(li);
      tocLinks.push(a);
    });
    els.tocList.appendChild(frag);
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

  function setupSearchAccessibility() {
    els.searchToggle.setAttribute('aria-controls', 'search-panel');
    els.searchToggle.setAttribute('aria-expanded', String(!els.searchPanel.hidden));
    els.searchToggle.setAttribute('aria-label', els.searchPanel.hidden ? '打开全书搜索' : '关闭全书搜索');
    els.searchPanel.setAttribute('role', 'dialog');
    els.searchPanel.setAttribute('aria-label', '全书搜索');
    els.searchPanel.setAttribute('aria-hidden', String(els.searchPanel.hidden));
    els.searchPanel.tabIndex = -1;
  }

  function pushOverlayHistory(type) {
    if (activeOverlayHistory === type) return;

    try {
      history.pushState({ ...(history.state || {}), readerOverlay: type }, '', location.href);
      activeOverlayHistory = type;
    } catch {
      activeOverlayHistory = null;
    }
  }

  function consumeOverlayHistory(type) {
    if (activeOverlayHistory !== type) return;

    activeOverlayHistory = null;
    ignoreNextPopState = true;
    try { history.back(); }
    catch { ignoreNextPopState = false; }
  }

  function openTOC() {
    if (!els.toc.hidden) return;
    setTopbarHidden(false);
    closeSearch(false, { keepHistory: true });
    closeBookmarks(false, { keepHistory: true });
    lastFocusBeforeTOC = document.activeElement;
    els.toc.hidden = false;
    els.toc.setAttribute('aria-hidden', 'false');
    els.tocToggle.setAttribute('aria-expanded', 'true');
    els.tocToggle.setAttribute('aria-label', '关闭目录');
    pushOverlayHistory('toc');

    requestAnimationFrame(() => {
      const target = els.tocList.querySelector('a.current') ||
        els.tocList.querySelector('a') || els.toc;
      target.focus({ preventScroll: true });
    });
  }

  function closeTOC(restoreFocus = true, options = {}) {
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

    if (!options.fromHistory && !options.keepHistory) {
      consumeOverlayHistory('toc');
    }
  }

  function openSearch() {
    if (!els.searchPanel.hidden) {
      requestAnimationFrame(() => els.searchInput.focus({ preventScroll: true }));
      return;
    }
    setTopbarHidden(false);
    closeTOC(false, { keepHistory: true });
    closeBookmarks(false, { keepHistory: true });
    lastFocusBeforeSearch = document.activeElement;
    els.searchPanel.hidden = false;
    els.searchPanel.setAttribute('aria-hidden', 'false');
    els.searchToggle.setAttribute('aria-expanded', 'true');
    els.searchToggle.setAttribute('aria-label', '关闭全书搜索');
    pushOverlayHistory('search');

    requestAnimationFrame(() => {
      els.searchInput.focus({ preventScroll: true });
      els.searchInput.select();
    });
  }

  function closeSearch(restoreFocus = true, options = {}) {
    if (els.searchPanel.hidden) return;
    els.searchPanel.hidden = true;
    els.searchPanel.setAttribute('aria-hidden', 'true');
    els.searchToggle.setAttribute('aria-expanded', 'false');
    els.searchToggle.setAttribute('aria-label', '打开全书搜索');

    if (restoreFocus) {
      const target = lastFocusBeforeSearch && document.contains(lastFocusBeforeSearch)
        ? lastFocusBeforeSearch
        : els.searchToggle;
      target.focus({ preventScroll: true });
    }
    lastFocusBeforeSearch = null;

    if (!options.fromHistory && !options.keepHistory) {
      consumeOverlayHistory('search');
    }
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
  setupSearchAccessibility();
  setupBookmarkPanelAccessibility();
  els.tocToggle.addEventListener('click', () => els.toc.hidden ? openTOC() : closeTOC(true));
  els.searchToggle.addEventListener('click', () => els.searchPanel.hidden ? openSearch() : closeSearch(true));
  els.searchForm.addEventListener('submit', (e) => {
    e.preventDefault();
    runBookSearch(els.searchInput.value);
  });
  els.searchInput.addEventListener('input', () => {
    if (!els.searchInput.value.trim()) resetSearchPanel();
  });
  document.addEventListener('keydown', (e) => {
    trapTOCFocus(e);
    trapPanelFocus(els.searchPanel, e);
    trapPanelFocus(els.bookmarks, e);
  });
  els.bookmarkToggle.addEventListener('click', () => els.bookmarks.hidden ? openBookmarks() : closeBookmarks(true));
  els.bookmarkAdd.addEventListener('click', addBookmarkAtCurrentPara);
  // 点击目录外部关闭。这里不强行归还焦点，避免打断用户点击页面其他控件。
  document.addEventListener('click', (e) => {
    if (!els.toc.hidden && !els.toc.contains(e.target) && e.target !== els.tocToggle) closeTOC(false);
    if (!els.searchPanel.hidden && !els.searchPanel.contains(e.target) && e.target !== els.searchToggle) closeSearch(false);
    if (!els.bookmarks.hidden && !els.bookmarks.contains(e.target) && e.target !== els.bookmarkToggle) closeBookmarks(false);
  });
  document.querySelector('.topbar')?.addEventListener('focusin', () => {
    setTopbarHidden(false);
  });

  function setupTopbarSwipeAutoHide() {
    document.addEventListener('touchstart', (e) => {
      if (!topbarAutoHideReady || e.touches.length !== 1) return;
      if (!els.toc.hidden || !els.searchPanel.hidden || !els.bookmarks.hidden) return;

      const t = e.touches[0];
      topbarTouchStartY = t.clientY;
      topbarTouchLastY = t.clientY;
      topbarTouchDistance = 0;
    }, { passive: true });

    document.addEventListener('touchmove', (e) => {
      if (!topbarAutoHideReady || e.touches.length !== 1) return;
      if (!els.toc.hidden || !els.searchPanel.hidden || !els.bookmarks.hidden) {
        setTopbarHidden(false);
        return;
      }

      const t = e.touches[0];
      const dy = t.clientY - topbarTouchLastY;
      topbarTouchLastY = t.clientY;

      // 手指上划：dy < 0，页面通常向下滚动，收起顶栏。
      // 手指下划：dy > 0，页面通常向上滚动，显示顶栏。
      if (Math.abs(dy) < 1.5) return;

      topbarTouchDistance += dy;

      if (topbarTouchDistance < -22) {
        setTopbarHidden(true);
        topbarTouchDistance = 0;
      } else if (topbarTouchDistance > 12) {
        setTopbarHidden(false);
        topbarTouchDistance = 0;
      }
    }, { passive: true });

    document.addEventListener('touchend', () => {
      topbarTouchStartY = 0;
      topbarTouchLastY = 0;
      topbarTouchDistance = 0;
    }, { passive: true });

    document.addEventListener('touchcancel', () => {
      topbarTouchStartY = 0;
      topbarTouchLastY = 0;
      topbarTouchDistance = 0;
    }, { passive: true });
  }

  setupTopbarSwipeAutoHide();

  function handleTextBackGesture(menuWasVisible) {
    if (menuWasVisible) {
      history.scrollRestoration = originalScrollRestoration;
      history.back();
      return true;
    }
    const readingScrollY = getScrollY();
    setTopbarHidden(false);
    requestAnimationFrame(() => {
      window.scrollTo({ top: readingScrollY, behavior: 'instant' });
    });
    return false;
  }

  function setupTextEdgeNavigation() {
    if (!isMobileTextReader) return;

    history.scrollRestoration = 'manual';
    history.replaceState({ ...(history.state || {}), textReader: true }, '', location.href);
    history.pushState({ textReader: true, guard: textHistoryGuard }, '', location.href);
    window.addEventListener('pagehide', () => {
      history.scrollRestoration = originalScrollRestoration;
    }, { once: true });

    for (const side of ['left', 'right']) {
      const edge = document.createElement('span');
      edge.className = `reader-edge-gesture reader-edge-gesture-${side}`;
      edge.setAttribute('aria-hidden', 'true');
      document.body.appendChild(edge);

      edge.addEventListener('touchstart', (e) => {
        if (e.touches.length !== 1) return;
        e.preventDefault();
        const touch = e.touches[0];
        textEdgeSwipe = {
          side,
          menuWasVisible: !topbarHidden,
          x: touch.clientX,
          y: touch.clientY,
          lastX: touch.clientX,
          lastY: touch.clientY,
        };
      }, { passive: false });

      edge.addEventListener('touchmove', (e) => {
        if (!textEdgeSwipe || e.touches.length !== 1) return;
        e.preventDefault();
        textEdgeSwipe.lastX = e.touches[0].clientX;
        textEdgeSwipe.lastY = e.touches[0].clientY;
      }, { passive: false });

      edge.addEventListener('touchend', () => {
        if (!textEdgeSwipe) return;
        const menuWasVisible = textEdgeSwipe.menuWasVisible;
        const dx = textEdgeSwipe.lastX - textEdgeSwipe.x;
        const dy = textEdgeSwipe.lastY - textEdgeSwipe.y;
        const inward = textEdgeSwipe.side === 'left' ? dx : -dx;
        textEdgeSwipe = null;
        if (inward >= 56 && Math.abs(dx) > Math.abs(dy) * 1.25) {
          handleTextBackGesture(menuWasVisible);
        }
      }, { passive: true });

      edge.addEventListener('touchcancel', () => {
        textEdgeSwipe = null;
      }, { passive: true });
    }
  }

  setupTextEdgeNavigation();

  function setupTOCSwipeClose() {
    els.toc.addEventListener('touchstart', (e) => {
      if (els.toc.hidden || e.touches.length !== 1) return;
      const t = e.touches[0];
      tocSwipeStart = {
        x: t.clientX,
        y: t.clientY,
        time: Date.now(),
      };
    }, { passive: true });

    els.toc.addEventListener('touchmove', (e) => {
      if (!tocSwipeStart || els.toc.hidden || e.touches.length !== 1) return;
      const t = e.touches[0];
      const dx = t.clientX - tocSwipeStart.x;
      const dy = t.clientY - tocSwipeStart.y;

      // 只在明确横向右滑时阻止页面/抽屉滚动；纵向滑动仍用于滚目录。
      if (dx > 24 && Math.abs(dx) > Math.abs(dy) * 1.25) {
        e.preventDefault();
      }
    }, { passive: false });

    els.toc.addEventListener('touchend', (e) => {
      if (!tocSwipeStart || els.toc.hidden) return;
      const t = e.changedTouches && e.changedTouches[0];
      if (!t) {
        tocSwipeStart = null;
        return;
      }

      const dx = t.clientX - tocSwipeStart.x;
      const dy = t.clientY - tocSwipeStart.y;
      const dt = Date.now() - tocSwipeStart.time;
      tocSwipeStart = null;

      if (dx > 72 && Math.abs(dx) > Math.abs(dy) * 1.35 && dt < 700) {
        closeTOC(false);
      }
    }, { passive: true });

    els.toc.addEventListener('touchcancel', () => {
      tocSwipeStart = null;
    }, { passive: true });
  }

  setupTOCSwipeClose();

  window.addEventListener('popstate', () => {
    if (ignoreNextPopState) {
      ignoreNextPopState = false;
      return;
    }

    if (!els.toc.hidden) {
      activeOverlayHistory = null;
      closeTOC(true, { fromHistory: true });
      return;
    }

    if (!els.searchPanel.hidden) {
      activeOverlayHistory = null;
      closeSearch(true, { fromHistory: true });
      return;
    }

    if (!els.bookmarks.hidden) {
      activeOverlayHistory = null;
      closeBookmarks(true, { fromHistory: true });
      return;
    }

    if (isMobileTextReader) {
      if (topbarHidden) {
        handleTextBackGesture(false);
        history.pushState({ textReader: true, guard: textHistoryGuard }, '', location.href);
        return;
      }
      history.scrollRestoration = originalScrollRestoration;
      location.replace('index.html');
    }
  });


  // ---- 全书搜索 ----
  function resetSearchPanel() {
    searchRunId++;
    els.searchStatus.textContent = '输入关键词后，将搜索当前书籍的全部章节。';
    els.searchResults.innerHTML = '';
  }

  function normalizeSearchText(text) {
    return String(text || '').replace(/\s+/g, ' ').trim();
  }

  function searchHaystack(text) {
    return normalizeSearchText(text).toLocaleLowerCase();
  }

  function searchNeedle(query) {
    return normalizeSearchText(query).toLocaleLowerCase();
  }

  function highlightSnippet(snippet, query) {
    const safe = escapeHTML(snippet);
    const q = escapeHTML(normalizeSearchText(query));
    if (!q) return safe;
    const pattern = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return safe.replace(new RegExp(pattern, 'gi'), m => `<mark class="search-mark">${m}</mark>`);
  }

  function makeSearchSnippet(text, query, radius = 48) {
    const clean = normalizeSearchText(text);
    const hay = clean.toLocaleLowerCase();
    const needle = searchNeedle(query);
    const idx = hay.indexOf(needle);
    if (idx < 0) return shortenText(clean, radius * 2);

    const start = Math.max(0, idx - radius);
    const end = Math.min(clean.length, idx + needle.length + radius);
    return `${start > 0 ? '…' : ''}${clean.slice(start, end)}${end < clean.length ? '…' : ''}`;
  }

  async function getSearchChapter(index) {
    if (searchCache.has(index)) return searchCache.get(index);

    const ch = book.chapters[index];
    const res = await fetch(chapterURL(index));
    if (!res.ok) throw new Error(`${ch.title}（${res.status}）`);

    const raw = await res.text();
    const blocks = splitTextBlocks(raw);
    const paragraphs = [];

    for (const block of blocks) {
      const t = block.trim();
      if (!t || isDividerBlock(t)) continue;
      paragraphs.push(normalizeSearchText(t));
    }

    const data = { chapter: index, title: ch.title, paragraphs };
    searchCache.set(index, data);
    return data;
  }

  function yieldToBrowser() {
    return new Promise(resolve => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
      } else {
        setTimeout(resolve, 0);
      }
    });
  }

  async function runBookSearch(rawQuery) {
    const query = normalizeSearchText(rawQuery);
    const needle = searchNeedle(query);
    const runId = ++searchRunId;

    els.searchResults.innerHTML = '';

    if (!needle) {
      resetSearchPanel();
      return;
    }

    els.searchStatus.textContent = `正在搜索《${book.title}》… 结果会边搜边显示。`;

    const maxVisible = 200;
    const total = book.chapters.length;
    let matchCount = 0;
    let renderedCount = 0;
    let errorCount = 0;

    for (let i = 0; i < total; i++) {
      if (runId !== searchRunId) return;

      const visibleBatch = [];

      try {
        const chapter = await getSearchChapter(i);
        chapter.paragraphs.forEach((text, para) => {
          if (!searchHaystack(text).includes(needle)) return;

          matchCount++;

          if (renderedCount + visibleBatch.length >= maxVisible) return;

          visibleBatch.push({
            chapter: i,
            para,
            title: chapter.title,
            excerpt: makeSearchSnippet(text, query),
          });
        });
      } catch (err) {
        errorCount++;
      }

      if (runId !== searchRunId) return;

      if (visibleBatch.length) {
        appendSearchResults(visibleBatch, query, renderedCount);
        renderedCount += visibleBatch.length;
        await yieldToBrowser();
      } else if (i % 3 === 0) {
        await yieldToBrowser();
      }

      updateStreamingSearchStatus({
        scanned: i + 1,
        total,
        matchCount,
        renderedCount,
        maxVisible,
        errorCount,
        done: false,
        query,
      });
    }

    if (runId !== searchRunId) return;

    if (!matchCount && !errorCount) {
      const li = document.createElement('li');
      li.className = 'search-empty';
      li.textContent = '没有找到匹配内容。';
      els.searchResults.appendChild(li);
    }

    if (errorCount) {
      const li = document.createElement('li');
      li.className = 'search-empty';
      li.textContent = `${errorCount} 个章节搜索失败，可稍后重试。`;
      els.searchResults.appendChild(li);
    }

    updateStreamingSearchStatus({
      scanned: total,
      total,
      matchCount,
      renderedCount,
      maxVisible,
      errorCount,
      done: true,
      query,
    });
  }

  function updateStreamingSearchStatus({
    scanned,
    total,
    matchCount,
    renderedCount,
    maxVisible,
    errorCount,
    done,
    query,
  }) {
    if (done) {
      if (!matchCount) {
        els.searchStatus.textContent = errorCount
          ? `未找到“${query}”。${errorCount} 个章节搜索失败。`
          : `未找到“${query}”。`;
        return;
      }

      const limitText = matchCount > maxVisible
        ? `，显示前 ${maxVisible} 条`
        : '';

      els.searchStatus.textContent = errorCount
        ? `搜索完成，找到 ${matchCount} 条${limitText}；${errorCount} 个章节失败。`
        : `搜索完成，找到 ${matchCount} 条${limitText}。`;
      return;
    }

    const limitText = matchCount > maxVisible
      ? `，已显示前 ${maxVisible} 条`
      : renderedCount < matchCount
        ? `，已显示 ${renderedCount} 条`
        : '';

    els.searchStatus.textContent = `正在搜索 ${scanned} / ${total} 章… 已找到 ${matchCount} 条${limitText}`;
  }

  function appendSearchResults(items, query, offset = 0) {
    const frag = document.createDocumentFragment();

    items.forEach((item, index) => {
      const li = document.createElement('li');
      li.className = 'search-item search-item-streaming';
      li.style.animationDelay = `${Math.min((offset + index) % 8, 7) * 35}ms`;

      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'search-result';
      btn.innerHTML = `
        <span class="search-result-title">${escapeHTML(item.title)}</span>
        <span class="search-result-meta">第 ${item.chapter + 1} 章 · 段落 ${item.para + 1}</span>
        <span class="search-result-excerpt">${highlightSnippet(item.excerpt, query)}</span>
      `;
      btn.addEventListener('click', () => jumpToSearchResult(item.chapter, item.para));

      li.appendChild(btn);
      frag.appendChild(li);
    });

    els.searchResults.appendChild(frag);
  }

  async function jumpToSearchResult(chapter, para) {
    closeSearch(false);
    pendingSearchTarget = { chapter, para };

    if (chapter === current) {
      scrollToPara(para);
      flashSearchTarget(para);
      saveProgress();
      syncURL();
      updateProgressBar(para);
      pendingSearchTarget = null;
      return;
    }

    await loadChapter(chapter, { para });
  }

  function flashSearchTarget(para) {
    paraEls.forEach(el => el.classList.remove('search-target'));
    const el = paraEls[Math.min(para, paraEls.length - 1)];
    if (!el) return;

    el.classList.add('search-target');
    window.setTimeout(() => {
      el.classList.remove('search-target');
    }, 2400);
  }

  // ---- 书签 / 笔记 ----
  function loadBookmarks() {
    return Store.getBookmarks(bookId)
      .filter(b => b.chapter >= 0 && b.chapter < book.chapters.length && b.para >= 0);
  }

  function saveBookmarks() {
    Store.setBookmarks(bookId, bookmarks);
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
    if (!paraEls.length) return null;
    return paraEls[Math.min(computeCurrentPara(), paraEls.length - 1)] || null;
  }

  function applyBookmarkMarks() {
    const marked = new Set(bookmarks
      .filter(b => b.chapter === current)
      .map(b => b.para));

    paraEls.forEach((p, i) => {
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
    setTopbarHidden(false);
    closeTOC(false, { keepHistory: true });
    closeSearch(false, { keepHistory: true });
    lastFocusBeforeBookmarks = document.activeElement;
    renderBookmarks();
    els.bookmarks.hidden = false;
    els.bookmarks.setAttribute('aria-hidden', 'false');
    els.bookmarkToggle.setAttribute('aria-expanded', 'true');
    els.bookmarkToggle.setAttribute('aria-label', '关闭书签和笔记');
    pushOverlayHistory('bookmarks');

    requestAnimationFrame(() => {
      const target = els.bookmarkAdd || els.bookmarkList.querySelector('button') || els.bookmarks;
      target.focus({ preventScroll: true });
    });
  }

  function closeBookmarks(restoreFocus = true, options = {}) {
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

    if (!options.fromHistory && !options.keepHistory) {
      consumeOverlayHistory('bookmarks');
    }
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
    paraEls = [];
    paraChars = [];
    paraSegs = [];
    paraTops = [];
    els.progress.innerHTML = '';
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
    paraEls = Array.from(els.body.querySelectorAll('p[id]'));
    refreshParaTops();
    buildProgressSegments();   // 按本章段落字数重建分段进度条
    els.chapTitle.textContent = ch.title;
    document.title = `${ch.title} · ${book.title}`;

    // 导航按钮状态
    els.prev.disabled = index === 0;
    els.next.disabled = index === book.chapters.length - 1;

    // 高亮当前目录项
    tocLinks.forEach((a, i) =>
      a.classList.toggle('current', i === index));

    // 滚动定位：优先段落锚点，其次旧的像素位置，否则回到顶部
    if (restore && Number.isInteger(restore.para) && restore.para > 0) {
      scrollToPara(restore.para);
    } else if (restore && Number.isFinite(restore.scroll) && restore.scroll > 0) {
      window.scrollTo({ top: restore.scroll, behavior: 'auto' });
    } else {
      window.scrollTo({ top: 0, behavior: 'auto' });
    }

    refreshParaTops();
    saveProgress();   // 同时刷新 currentPara
    syncURL();
    updateProgressBar(currentPara);
    applyBookmarkMarks();
    if (pendingSearchTarget && pendingSearchTarget.chapter === current) {
      flashSearchTarget(pendingSearchTarget.para);
      pendingSearchTarget = null;
    }
    prefetchNextChapter();
  }

  function refreshParaTops() {
    if (!paraEls.length) {
      paraEls = Array.from(els.body.querySelectorAll('p[id]'));
    }
    const scrollY = window.scrollY;
    paraTops = paraEls.map(el => el.getBoundingClientRect().top + scrollY);
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
    if (!paraEls.length) return;
    const el = paraEls[Math.min(i, paraEls.length - 1)];
    const top = el.getBoundingClientRect().top + window.scrollY - topbarOffset();
    window.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }

  // 阅读线 = 粘性顶栏下沿，留一点余量
  function topbarOffset() {
    return topbarOffsetValue;
  }

  function refreshTopbarOffset() {
    topbarOffsetValue = (topbar ? topbar.offsetHeight : 56) + 8;
  }

  function getScrollY() {
    const el = document.scrollingElement || document.documentElement;
    return Math.max(0, window.scrollY || el.scrollTop || 0);
  }

  function setTopbarHidden(hidden) {
    // 顶部、目录/搜索/书签打开时强制显示。
    if (
      hidden &&
      (getScrollY() < 80 ||
        !els.toc.hidden ||
        !els.searchPanel.hidden ||
        !els.bookmarks.hidden)
    ) {
      hidden = false;
    }

    // 移动端点击过顶部按钮后，按钮可能长期保持 focus；
    // 如果不 blur，:focus-within / activeElement 会让顶栏看起来“永远隐藏不了”。
    if (hidden) {
      if (topbar && topbar.contains(document.activeElement) && document.activeElement.blur) {
        document.activeElement.blur();
      }
    }

    if (topbarHidden === hidden) return;
    topbarHidden = hidden;
    document.body.classList.toggle('reader-topbar-hidden', hidden);
  }

  function handleTopbarAutoHide() {
    if (!topbarAutoHideReady) return;

    const y = getScrollY();
    const dy = y - lastTopbarScrollY;

    if (Math.abs(dy) < 2) return;

    // 回到页面顶部时总是显示。
    if (y < 80) {
      topbarDownDistance = 0;
      topbarUpDistance = 0;
      setTopbarHidden(false);
      lastTopbarScrollY = y;
      return;
    }

    // 页面向下滚动 = 手指上划：收起顶部菜单。
    if (dy > 0) {
      topbarDownDistance += dy;
      topbarUpDistance = 0;

      if (topbarDownDistance > 44) {
        setTopbarHidden(true);
        topbarDownDistance = 0;
      }
    }

    // 页面向上滚动 = 手指下划：弹出顶部菜单。
    if (dy < 0) {
      topbarUpDistance += -dy;
      topbarDownDistance = 0;

      if (topbarUpDistance > 18) {
        setTopbarHidden(false);
        topbarUpDistance = 0;
      }
    }

    lastTopbarScrollY = y;
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

  function isDividerBlock(t) {
    return /^([-*]\s*){3,}$/.test(t) || t === '---' || t === '***';
  }

  function looksLikeIndentedParagraph(line) {
    // 有些 TXT（如《超新星纪元》）用“每段一行、行首两个全角空格”，
    // 但段落之间没有空行。原来的空行分段会把整章合成一个 <p>，
    // 导致顶部进度条只剩一个长段，进度恢复也只能回到第 0 段。
    return /^[\u3000]{2,}\S/.test(line) || /^[ \t]{2,}\S/.test(line);
  }

  function splitTextBlocks(raw) {
    const coarseBlocks = raw
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split(/\n\s*\n/);

    const blocks = [];

    for (const block of coarseBlocks) {
      const t = block.trim();
      if (!t) continue;

      if (isDividerBlock(t)) {
        blocks.push(t);
        continue;
      }

      const lines = block
        .split('\n')
        .map(line => line.replace(/[ \t\u3000]+$/g, ''))
        .filter(line => line.trim());

      // 如果一个空行块里出现多条缩进正文行，就按缩进行拆成多个段落。
      // 若不是这种格式，则保持原来的换行，用 <br> 展示。
      if (lines.length > 1 && lines.slice(1).some(looksLikeIndentedParagraph)) {
        let currentLines = [];

        for (const line of lines) {
          if (looksLikeIndentedParagraph(line) && currentLines.length) {
            blocks.push(currentLines.join('\n').trim());
            currentLines = [];
          }
          currentLines.push(line.trim());
        }

        if (currentLines.length) {
          blocks.push(currentLines.join('\n').trim());
        }
      } else {
        blocks.push(t);
      }
    }

    return blocks;
  }

  // 纯文本 -> 段落 HTML。空行分段；兼容“每段一行但段间无空行”的 TXT。
  // 每个段落带上 id="pN"（章内序号），供段落级进度定位与 URL 锚点使用。
  function renderText(raw) {
    const blocks = splitTextBlocks(raw);
    let pi = 0;
    paraChars = [];
    const htmlParts = [];

    for (const b of blocks) {
      const t = b.trim();
      if (!t) continue;
      if (isDividerBlock(t)) {
        htmlParts.push('<hr>');
        continue;
      }
      let html = escapeHTML(t);
      if (activeHighlighter) html = activeHighlighter(html); // 在转义后、<br> 插入前标注
      paraChars[pi] = t.replace(/\s+/g, '').length;       // 原始文字数（与字号无关）
      htmlParts.push(`<p id="p${pi++}">${html.replace(/\n/g, '<br>')}</p>`);
    }

    return htmlParts.join('');
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
    handleTopbarAutoHide();
  }, { passive: true });
  // 离开页面时再保存一次，确保滚动位置最新
  window.addEventListener('beforeunload', saveProgress);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveProgress(); });

  // ---- 顶部进度条（bilibili 式分段）----
  // 每个段落一段，段宽（flex-grow）正比于段落字数。进度以“当前所在段落序号”
  // 离散推进：读到第 N 段就点亮前 N 段。字数与字号无关，所以调字号时不漂移。
  function buildProgressSegments() {
    els.progress.innerHTML = '';
    const frag = document.createDocumentFragment();
    paraSegs = paraChars.map(n => {
      const seg = document.createElement('span');
      seg.className = 'progress-seg';
      seg.style.flex = `${Math.max(1, n)} 0 0`;   // 段宽正比于字数
      frag.appendChild(seg);
      return seg;
    });
    els.progress.appendChild(frag);
    lastProgressPara = -1;
    updateProgressBar();
  }

  function updateProgressBar(cur = computeCurrentPara()) {
    if (paraSegs.length) {
      cur = Math.max(0, Math.min(cur, paraSegs.length - 1));
    } else {
      cur = 0;
    }

    currentPara = cur;
    if (cur === lastProgressPara) return;

    const prev = Math.max(-1, Math.min(lastProgressPara, paraSegs.length - 1));

    if (prev < 0) {
      for (let i = 0; i < paraSegs.length; i++) {
        paraSegs[i].classList.toggle('read', i <= cur);
      }
    } else if (cur > prev) {
      for (let i = prev + 1; i <= cur; i++) {
        paraSegs[i].classList.add('read');
      }
    } else {
      for (let i = cur + 1; i <= prev; i++) {
        paraSegs[i].classList.remove('read');
      }
    }

    updateBookmarkButtonState(cur);
    lastProgressPara = cur;
  }

  // ---- 翻章 ----
  els.prev.addEventListener('click', () => loadChapter(current - 1));
  els.next.addEventListener('click', () => loadChapter(current + 1));

  // 键盘左右翻章；抽屉打开时只处理 Esc，避免焦点在抽屉中误触翻章。
  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      openSearch();
      return;
    }

    if (!els.toc.hidden || !els.searchPanel.hidden || !els.bookmarks.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeTOC(true);
        closeSearch(true);
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
    refreshTopbarOffset();
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
    if (Number.isInteger(saved.para) && saved.para > 0) {
      restore = { para: saved.para, scroll: saved.scroll };
    } else if (Number.isFinite(saved.scroll) && saved.scroll > 0) {
      restore = { scroll: saved.scroll };
    }
  }
  loadChapter(current, restore);

  // 避免启动恢复阅读位置时的程序化滚动立刻触发“收起顶部栏”。
  window.setTimeout(() => {
    lastTopbarScrollY = getScrollY();
    topbarAutoHideReady = true;
  }, 600);
})();

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}
