Tranquil Reader / 静读

A lightweight, offline-first novel reader built with plain HTML, CSS and JavaScript.

It is designed for long-form Chinese novel reading, with a mobile-first interface, PWA/TWA support, offline reading, book covers, reading progress restoration, bookmarks, notes, and AI-assisted highlight generation tools.

No build system is required.

---

Features

Bookshelf

- Dynamic bookshelf powered by "books/manifest.json"
- Per-book metadata:
  - title
  - author
  - chapter list
  - cover image
  - lightweight cover thumbnail
  - external highlight file path
- Book cover support:
  - shelf displays lightweight thumbnail
  - tapping the cover opens the full cover image in a new tab
  - tapping the book title/text area opens the reader
- Reading progress shown on the bookshelf
- Android App / TWA recommendation banner for browser users

---

Reader

- Chapter-based reading
- Per-book reading progress persistence
- Paragraph-aware reading progress
- Resume reading position after reload
- Resume last reading session on TWA/PWA cold start
- Previous / next chapter navigation
- Top progress indicator
- Paragraph-based progress tracking
- Supports TXT files with:
  - blank-line separated paragraphs
  - indented paragraphs without blank lines
- Fixed top toolbar attached to the browser/TWA viewport
- Auto-hide top toolbar while reading:
  - scroll down / swipe up: hide toolbar
  - scroll up / swipe down: show toolbar
- Mobile-friendly layout

---

Table of Contents

- Slide-in TOC drawer
- Current chapter highlighting
- Keyboard and accessibility support
- Focus management
- "Escape" closes TOC
- Android/browser back button closes TOC before leaving reader
- Swipe right to close TOC on mobile
- Long chapter titles wrap safely
- Drawer width is constrained to the viewport to avoid horizontal overflow

---

Bookmarks and Notes

- Add bookmarks while reading
- Store bookmarks locally per book
- Bookmark drawer
- Quick jump to bookmarked paragraph
- Notes-ready bookmark structure
- Back button closes bookmark drawer before leaving reader

---

Highlight System

Highlights are no longer stored directly inside "books/manifest.json".

Each book can define an external highlight file inside its own folder:

books/
  <book-id>/
    highlights.json

Recommended manifest entry:

{
  "id": "chaoxinxingjiyuan",
  "title": "超新星纪元",
  "author": "刘慈欣",
  "cover": "cover.png",
  "coverThumb": "cover-thumb.webp",
  "highlightsFile": "highlights.json",
  "chapters": [
    {
      "title": "引子",
      "file": "001_引子.txt"
    }
  ]
}

Recommended "highlights.json" format:

{
  "highlights": {
    "人名": [],
    "地名": [],
    "组织/机构": [],
    "专有名词": [],
    "科技/设定": [],
    "重要概念": []
  },
  "perChapter": {
    "001_引子.txt": {
      "人名": [],
      "地名": [],
      "组织/机构": [],
      "专有名词": [],
      "科技/设定": [],
      "重要概念": []
    }
  }
}

Meaning:

- "highlights": global terms used across the whole book
- "perChapter": chapter-specific terms
- keys inside "perChapter" should preferably use chapter filenames
- the reader merges global and per-chapter highlights while rendering

The old inline manifest style is still backward-compatible, but new books should use external "highlights.json".

---

Project Structure

novel-reader/
├── index.html
├── reader.html
├── manifest.webmanifest
├── sw.js
├── favicon.png
│
├── css/
│   └── style.css
│
├── js/
│   ├── common.js
│   ├── shelf.js
│   └── reader.js
│
├── books/
│   ├── manifest.json
│   │
│   ├── demo/
│   │   ├── ch1.txt
│   │   └── ch2.txt
│   │
│   ├── shanyangrenlei/
│   │   ├── part1.txt
│   │   ├── part2.txt
│   │   ├── part3.txt
│   │   ├── part4.txt
│   │   ├── cover.png
│   │   ├── cover-thumb.webp
│   │   └── highlights.json
│   │
│   ├── zhongguo2185/
│   │   ├── ch1.txt
│   │   ├── ch2.txt
│   │   ├── ...
│   │   ├── cover.png
│   │   ├── cover-thumb.webp
│   │   └── highlights.json
│   │
│   └── chaoxinxingjiyuan/
│       ├── 001_引子.txt
│       ├── 002_死星 - 一、超新星.txt
│       ├── ...
│       ├── cover.png
│       ├── cover-thumb.webp
│       └── highlights.json
│
├── tools/
│   ├── split_by_length.py
│   ├── split_by_index.py
│   ├── split_book_deepseek.py
│   ├── generate_highlights_deepseek.py
│   └── make_cover_thumb.py
│
└── app/
    └── latest.apk

---

Book Manifest

"books/manifest.json" is the bookshelf index.

It should contain book metadata and chapter lists only. Large or book-specific auxiliary data should stay inside each book folder.

Example:

{
  "books": [
    {
      "id": "chaoxinxingjiyuan",
      "title": "超新星纪元",
      "author": "刘慈欣",
      "cover": "cover.png",
      "coverThumb": "cover-thumb.webp",
      "highlightsFile": "highlights.json",
      "chapters": [
        {
          "title": "引子",
          "file": "001_引子.txt"
        },
        {
          "title": "死星 - 一、超新星",
          "file": "002_死星 - 一、超新星.txt"
        }
      ]
    }
  ]
}

Field meanings:

Field| Meaning
"id"| Book folder name under "books/"
"title"| Display title
"author"| Display author
"cover"| Full-resolution cover image
"coverThumb"| Lightweight shelf thumbnail
"highlightsFile"| External highlight JSON file
"chapters"| Ordered chapter list

---

Cover Images

Recommended layout:

books/<book-id>/
  cover.png
  cover-thumb.webp

Recommended manifest fields:

{
  "cover": "cover.png",
  "coverThumb": "cover-thumb.webp"
}

The shelf uses "coverThumb" for performance.

The full "cover" image is opened only when the user taps the cover.

Generate a thumbnail:

python tools/make_cover_thumb.py books/<book-id>/cover.png

Default output:

books/<book-id>/cover-thumb.webp

---

Adding a New Book

1. Create a folder:

books/<book-id>/

2. Put chapter files inside it:

books/<book-id>/001_第一章.txt
books/<book-id>/002_第二章.txt

3. Add cover files:

books/<book-id>/cover.png
books/<book-id>/cover-thumb.webp

4. Add optional highlights:

books/<book-id>/highlights.json

5. Register the book in "books/manifest.json":

{
  "id": "book-id",
  "title": "书名",
  "author": "作者",
  "cover": "cover.png",
  "coverThumb": "cover-thumb.webp",
  "highlightsFile": "highlights.json",
  "chapters": [
    {
      "title": "第一章",
      "file": "001_第一章.txt"
    }
  ]
}

---

Offline Support

The Service Worker handles offline reading.

Caching strategy:

Resource| Strategy
App shell| precache
"books/*.json"| network-first
chapter ".txt" files| stale-while-revalidate
cover thumbnails| cached for offline reading
manually downloaded books| stored in persistent book cache

Book JSON files use network-first so bookshelf metadata and highlights update reliably.

Chapter text uses stale-while-revalidate so previously read chapters remain available offline.

---

TWA / PWA Behavior

The project supports installation as a PWA and packaging as a TWA.

Current behavior:

- standalone/TWA detection
- app banner hidden inside installed app
- cold start auto-resumes the last reading session
- Android back button closes TOC/bookmark panels first
- Service Worker keeps reading assets available offline

---

Local Development

Start a local static server:

python -m http.server 8000

Then open:

http://localhost:8000/

Avoid opening "index.html" directly from the file system, because fetch and Service Worker behavior require HTTP/HTTPS.

---

Tools

Split TXT by simple length

python tools/split_by_length.py

Split TXT by detected index

python tools/split_by_index.py

Split a book with DeepSeek assistance

export DEEPSEEK_API_KEY="sk-..."

python tools/split_book_deepseek.py \
  --input raw_books/example.txt \
  --id example-book \
  --title "示例书" \
  --author "作者" \
  --out-dir books/example-book \
  --manifest-snippet books/example-book/manifest.snippet.json

Generate highlights with DeepSeek

export DEEPSEEK_API_KEY="sk-..."

python tools/generate_highlights_deepseek.py \
  --book-dir books/chaoxinxingjiyuan

Default output:

books/chaoxinxingjiyuan/highlights.json

The DeepSeek script uses OpenAI-compatible API format, but directly calls the REST endpoint without requiring the OpenAI Python SDK.

Thinking mode is explicitly disabled in the request.

Generate cover thumbnail

python tools/make_cover_thumb.py books/<book-id>/cover.png

---

Storage

The app uses "localStorage" for lightweight state:

Data| Purpose
"reader.progress.<bookId>"| per-book reading progress
"reader.lastProgress"| last active reading session
"reader.fontSize"| font size preference
"reader.theme"| theme preference
bookmark keys| per-book bookmarks and notes

Book content and offline assets are handled through the Cache API.

---

Browser Support

Recommended:

- Android Chrome
- Chromium-based browsers
- TWA shell
- modern desktop browsers

The reader relies on:

- Fetch API
- Cache API
- Service Worker
- LocalStorage
- History API
- modern CSS features

---

Design Philosophy

This reader is designed around one principle:

«The interface should disappear while reading, but instantly return when needed.»

That leads to the current design:

- lightweight static architecture
- no build step
- local-first data
- offline reading
- mobile-first gestures
- fast resume
- external book assets
- per-book extensibility

---

Roadmap Ideas

Potential future improvements:

- full-book search
- search result highlighting and jump
- AI chapter summary
- character / concept cards
- timeline view
- reading statistics
- multi-device sync
- EPUB import
- TTS / read-aloud mode
- user-created highlights
- cloud backup for bookmarks and notes