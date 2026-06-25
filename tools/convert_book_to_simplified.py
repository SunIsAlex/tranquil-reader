#!/usr/bin/env python3
"""Convert one imported book's manifest titles and chapter text to Simplified Chinese."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from opencc import OpenCC


def main() -> None:
    parser = argparse.ArgumentParser(description="将指定书籍正文和目录标题转换为简体中文")
    parser.add_argument("book_id", help="books/manifest.json 中的书籍 id")
    parser.add_argument("--root", default=".", help="项目根目录（含 books/）")
    args = parser.parse_args()

    root = Path(args.root)
    manifest_path = root / "books" / "manifest.json"
    if not manifest_path.exists():
        sys.exit(f"错误：找不到 {manifest_path}")

    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    books = manifest.get("books", [])
    book = next((item for item in books if item.get("id") == args.book_id), None)
    if not book:
        sys.exit(f"错误：manifest 中找不到书籍 id {args.book_id!r}")

    book_dir = root / "books" / args.book_id
    if not book_dir.is_dir():
        sys.exit(f"错误：找不到 {book_dir}")

    cc = OpenCC("t2s")
    book["title"] = cc.convert(book.get("title", ""))
    book["author"] = cc.convert(book.get("author", ""))

    converted = 0
    for chapter in book.get("chapters", []):
        chapter["title"] = cc.convert(chapter.get("title", ""))
        file_name = chapter.get("file")
        if not file_name:
            continue
        path = book_dir / file_name
        if not path.is_file():
            sys.exit(f"错误：找不到章节文件 {path}")
        text = path.read_text(encoding="utf-8")
        path.write_text(cc.convert(text), encoding="utf-8")
        converted += 1

    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"完成：{args.book_id} 已转换 {converted} 个章节为简体中文")


if __name__ == "__main__":
    main()
