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
  let currentPara = 0;   // 当前阅读到的段落序号（章内，从 0 起）
  let paraChars = [];    // 各段落的文字数（章内），用于分段进度条的段宽
  let paraSegs = [];     // 分段进度条里各段对应的 DOM 节点
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
  async function loadChapter(index, restore = null) {
    index = Math.min(book.chapters.length - 1, Math.max(0, index));
    current = index;
    currentPara = 0;
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

    saveProgress();   // 同时刷新 currentPara
    syncURL();
    updateProgressBar();
  }

  // 找出"正在读"的段落：阅读线（顶栏下沿）之上、最靠下的那个 <p>
  function computeCurrentPara() {
    const ps = els.body.querySelectorAll('p[id]');
    if (!ps.length) return 0;
    const line = topbarOffset();
    let idx = 0;
    for (let i = 0; i < ps.length; i++) {
      if (ps[i].getBoundingClientRect().top <= line) idx = i;
      else break;
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
      if (highlighter) html = highlighter(html); // 在转义后、<br> 插入前标注
      paraChars[pi] = t.length;                  // 原始文字数（与字号无关）
      return `<p id="p${pi++}">${html.replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }

  // ---- 进度保存 ----
  function saveProgress() {
    currentPara = computeCurrentPara();
    Store.setProgress(bookId, {
      chapter: current,
      para: currentPara,
      scroll: window.scrollY || 0,   // 旧字段保留，作为无段落数据时的兜底
      time: Date.now(),
    });
  }
  const saveScroll = throttle(() => { saveProgress(); syncURL(); }, 800);
  window.addEventListener('scroll', () => { saveScroll(); updateProgressBar(); }, { passive: true });
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
    updateProgressBar();
  }
  function updateProgressBar() {
    const cur = computeCurrentPara();
    for (let i = 0; i < paraSegs.length; i++) {
      paraSegs[i].classList.toggle('read', i <= cur);
    }
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

  // 让浏览器原生的锚点跳转（#pN 分享链接 / 刷新恢复）也停在顶栏下方，
  // 否则 #pN 会被滚到视口最顶端、被 sticky 顶栏遮住。取值与阅读线一致。
  document.documentElement.style.scrollPaddingTop = topbarOffset() + 'px';
  window.addEventListener('resize', () => {
    document.documentElement.style.scrollPaddingTop = topbarOffset() + 'px';
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
