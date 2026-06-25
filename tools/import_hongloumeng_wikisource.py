#!/usr/bin/env python3
"""Import the public-domain Wikisource text of 紅樓夢 into books/.

The importer fetches the 120 chapter pages listed at:
https://zh.wikisource.org/wiki/紅樓夢

It writes normalized UTF-8 chapter files and updates books/manifest.json in
the same shape used by the other split/import tools in this project.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from typing import Any


API_URL = "https://zh.wikisource.org/w/api.php"
INDEX_PAGE = "紅樓夢"
USER_AGENT = "tranquil-reader-import/1.0"


class MainTextParser(HTMLParser):
    """Extract readable text from MediaWiki parser HTML."""

    SKIP_CLASSES = (
        "mw-editsection",
        "reference",
        "references",
        "noprint",
        "printfooter",
        "mw-cite-backlink",
    )

    BLOCK_TAGS = {
        "address",
        "blockquote",
        "br",
        "center",
        "dd",
        "div",
        "dl",
        "dt",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "li",
        "p",
        "table",
        "td",
        "th",
        "tr",
        "ul",
        "ol",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in {"script", "style"}:
            self.skip_depth += 1
            return
        attrs_dict = {name: value or "" for name, value in attrs}
        classes = attrs_dict.get("class", "")
        if self.skip_depth or any(cls in classes for cls in self.SKIP_CLASSES):
            self.skip_depth += 1
            return
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_endtag(self, tag: str) -> None:
        if self.skip_depth:
            self.skip_depth -= 1
            return
        if tag in self.BLOCK_TAGS:
            self.parts.append("\n")

    def handle_data(self, data: str) -> None:
        if not self.skip_depth:
            self.parts.append(data)

    def text(self) -> str:
        return "".join(self.parts)


class ChapterLinkParser(HTMLParser):
    """Extract chapter target pages and their displayed titles from the index."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.in_chapter_link = False
        self.current_page = ""
        self.current_text: list[str] = []
        self.links: list[tuple[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag != "a":
            return
        attrs_dict = {name: value or "" for name, value in attrs}
        href = attrs_dict.get("href", "")
        prefix = f"/wiki/{urllib.parse.quote(INDEX_PAGE)}/"
        if href.startswith(prefix):
            page = urllib.parse.unquote(href.removeprefix("/wiki/"))
            chapter = page.split("/", 1)[1]
            if re.match(r"^第.+回", chapter):
                self.in_chapter_link = True
                self.current_page = page
                self.current_text = []

    def handle_endtag(self, tag: str) -> None:
        if tag == "a" and self.in_chapter_link:
            title = "".join(self.current_text).strip()
            fallback = self.current_page.split("/", 1)[1]
            self.links.append((title or fallback, self.current_page))
            self.in_chapter_link = False
            self.current_page = ""
            self.current_text = []

    def handle_data(self, data: str) -> None:
        if self.in_chapter_link:
            self.current_text.append(data)


def api_get(params: dict[str, str]) -> dict[str, Any]:
    query = urllib.parse.urlencode(params)
    request = urllib.request.Request(
        f"{API_URL}?{query}",
        headers={"User-Agent": USER_AGENT},
    )
    for attempt in range(6):
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            if exc.code not in {429, 500, 502, 503, 504} or attempt == 5:
                raise
            wait = 2 ** attempt
            print(f"  接口返回 {exc.code}，{wait}s 后重试 ...")
            time.sleep(wait)
        except urllib.error.URLError as exc:
            if attempt == 5:
                raise
            wait = 2 ** attempt
            print(f"  网络错误 {exc.reason}，{wait}s 后重试 ...")
            time.sleep(wait)
    raise RuntimeError("unreachable")


def fetch_chapter_links() -> list[tuple[str, str]]:
    data = api_get(
        {
            "action": "parse",
            "page": INDEX_PAGE,
            "prop": "text",
            "format": "json",
        }
    )
    parser = ChapterLinkParser()
    parser.feed(data["parse"]["text"]["*"])
    chapters = parser.links
    if len(chapters) != 120:
        raise RuntimeError(f"expected 120 chapters, got {len(chapters)}")
    return chapters


def fetch_page_text(page: str) -> str:
    data = api_get(
        {
            "action": "parse",
            "page": page,
            "prop": "text",
            "format": "json",
            "disablelimitreport": "1",
            "disableeditsection": "1",
        }
    )
    parser = MainTextParser()
    parser.feed(data["parse"]["text"]["*"])
    return normalize_text(parser.text())


def normalize_text(text: str) -> str:
    text = html.unescape(text).replace("\r\n", "\n").replace("\r", "\n")
    lines: list[str] = []
    for line in text.split("\n"):
        line = re.sub(r"\[[^\]]*\]", "", line)
        line = re.sub(r"\s+", " ", line).strip()
        if not line:
            continue
        if line.startswith(".mw-parser-output"):
            continue
        if "回目录" in line:
            continue
        if line in {"姊妹计划: 百科·大典·吴典·粤典·图册分类·数据项", "校閱參考"}:
            continue
        lines.append(line)
    return "\n\n".join(lines)


def split_title_and_body(text: str, fallback_title: str) -> tuple[str, str]:
    lines = [line.strip() for line in normalize_text(text).split("\n") if line.strip()]
    if lines and re.match(r"^第.+回\s+\S+", lines[0]):
        return lines[0], "\n\n".join(lines[1:])
    return fallback_title, "\n\n".join(lines)


def safe_file_name(index: int, title: str) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|]', "", title)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return f"{index:03d}_{cleaned}.txt"


def update_manifest(root: Path, chapters: list[dict[str, str]], book_id: str) -> None:
    manifest_path = root / "books" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    books = manifest.setdefault("books", [])
    entry = {
        "id": book_id,
        "title": "红楼梦",
        "author": "曹雪芹、高鹗",
        "chapters": chapters,
    }
    for index, book in enumerate(books):
        if book.get("id") == book_id:
            for key, value in book.items():
                if key not in entry:
                    entry[key] = value
            books[index] = entry
            break
    else:
        books.append(entry)
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="导入维基文库《红楼梦》120 回")
    parser.add_argument("--root", default=".", help="项目根目录（含 books/）")
    parser.add_argument("--id", default="hongloumeng", help="书籍 id / 目录名")
    parser.add_argument("--delay", type=float, default=1.0, help="请求间隔秒数")
    args = parser.parse_args()

    if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.id):
        sys.exit("错误：--id 只能含字母、数字、连字符、下划线")

    root = Path(args.root)
    manifest_path = root / "books" / "manifest.json"
    if not manifest_path.exists():
        sys.exit(f"错误：找不到 {manifest_path}")

    book_dir = root / "books" / args.id
    book_dir.mkdir(parents=True, exist_ok=True)

    print("读取维基文库目录 ...")
    links = fetch_chapter_links()
    expected_files = {
        safe_file_name(index, page.split("/", 1)[1])
        for index, (_title, page) in enumerate(links, 1)
    }
    for old in book_dir.glob("*.txt"):
        if old.name not in expected_files:
            old.unlink()

    chapters: list[dict[str, str]] = []
    for index, (title, page) in enumerate(links, 1):
        file_name = safe_file_name(index, page.split("/", 1)[1])
        path = book_dir / file_name
        if path.exists() and path.stat().st_size > 1000:
            title, body = split_title_and_body(path.read_text(encoding="utf-8"), title)
            path.write_text(body.rstrip() + "\n", encoding="utf-8")
            print(f"  {file_name}\t已存在，已清理")
            chapters.append({"title": title, "file": file_name})
            continue
        else:
            title, body = split_title_and_body(fetch_page_text(page), title)
            if len(body) < 1000:
                raise RuntimeError(f"{title} body looks too short: {len(body)} chars")
            path.write_text(body + "\n", encoding="utf-8")
            print(f"  {file_name}\t{len(body)} 字")
        chapters.append({"title": title, "file": file_name})
        time.sleep(args.delay)

    update_manifest(root, chapters, args.id)
    print(f"完成：{len(chapters)} 回，已更新 books/manifest.json")


if __name__ == "__main__":
    main()
