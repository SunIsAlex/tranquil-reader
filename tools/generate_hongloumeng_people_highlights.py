#!/usr/bin/env python3
"""Generate people-name highlights for the imported Simplified Chinese 红楼梦.

The base list comes from the zh.wikipedia.org "红楼梦角色列表" page, then is
filtered to terms that actually occur in books/hongloumeng/*.txt. A small alias
list covers common in-text names such as 宝玉, 黛玉, 凤姐, 贾母.
"""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

from opencc import OpenCC


SOURCE_PAGE = "红楼梦角色列表"
API_URL = "https://zh.wikipedia.org/w/api.php"
USER_AGENT = "tranquil-reader-import/1.0"

COMMON_ALIASES = {
    "宝玉",
    "黛玉",
    "宝钗",
    "熙凤",
    "凤姐",
    "凤姐儿",
    "琏二奶奶",
    "平儿",
    "湘云",
    "妙玉",
    "迎春",
    "探春",
    "惜春",
    "元春",
    "巧姐",
    "可卿",
    "英莲",
    "香菱",
    "秋菱",
    "袭人",
    "晴雯",
    "麝月",
    "秋纹",
    "碧痕",
    "紫鹃",
    "雪雁",
    "莺儿",
    "莺哥",
    "鸳鸯",
    "司棋",
    "入画",
    "侍书",
    "翠墨",
    "小红",
    "红玉",
    "芳官",
    "龄官",
    "藕官",
    "蕊官",
    "文官",
    "宝官",
    "茄官",
    "葵官",
    "豆官",
    "艾官",
    "菂官",
    "玉官",
    "贾母",
    "史太君",
    "林如海",
    "贾敏",
    "贾雨村",
    "雨村",
    "甄士隐",
    "士隐",
    "甄英莲",
    "甄宝玉",
    "冷子兴",
    "子兴",
    "薛蟠",
    "薛蝌",
    "薛宝琴",
    "宝琴",
    "薛姨妈",
    "王夫人",
    "邢夫人",
    "赵姨娘",
    "周姨娘",
    "刘姥姥",
    "王熙凤",
    "贾琏",
    "贾珍",
    "贾蓉",
    "贾政",
    "贾赦",
    "贾环",
    "贾兰",
    "贾芸",
    "贾蔷",
    "秦钟",
    "秦业",
    "秦可卿",
    "尤氏",
    "尤二姐",
    "尤三姐",
    "尤老娘",
    "柳湘莲",
    "蒋玉菡",
    "北静王",
    "忠顺王",
    "水溶",
    "茗烟",
    "焙茗",
    "李贵",
    "赖大",
    "赖二",
    "赖嬷嬷",
    "林之孝",
    "周瑞",
    "周瑞家的",
    "吴新登",
    "吴新登家的",
    "王善保家的",
    "来旺",
    "来旺家的",
    "兴儿",
    "旺儿",
    "焦大",
    "宝蟾",
    "夏金桂",
    "孙绍祖",
}


def fetch_character_page_html() -> str:
    query = urllib.parse.urlencode(
        {
            "action": "parse",
            "page": SOURCE_PAGE,
            "prop": "text",
            "format": "json",
            "variant": "zh-hans",
        }
    )
    request = urllib.request.Request(
        f"{API_URL}?{query}",
        headers={"User-Agent": USER_AGENT},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        data = json.loads(response.read().decode("utf-8"))
    return data["parse"]["text"]["*"]


def strip_tags(fragment: str) -> str:
    fragment = re.sub(r"<style.*?</style>|<script.*?</script>", "", fragment, flags=re.S)
    fragment = re.sub(r"<sup.*?</sup>", "", fragment, flags=re.S)
    fragment = re.sub(r"<[^>]+>", "", fragment)
    return html.unescape(fragment).strip()


def extract_first_column_names(page_html: str) -> set[str]:
    names: set[str] = set()
    for row in re.findall(r"<tr[^>]*>(.*?)</tr>", page_html, flags=re.S):
        cells = re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", row, flags=re.S)
        if not cells:
            continue
        text = clean_name(strip_tags(cells[0]))
        if is_name_like(text):
            names.add(text)
    return names


def clean_name(text: str) -> str:
    text = re.sub(r"\[.*?\]", "", text)
    text = re.sub(r"\s+", "", text)
    text = re.sub(r"（.*?）|\\(.*?\\)", "", text)
    text = text.strip("，。；：、,.!?！？“”‘’\"'（）()[]【】《》<>")
    return text


def is_name_like(text: str) -> bool:
    if not text or text in {"姓名", "人物", "称谓", "家庭成员"}:
        return False
    if len(text) < 2 or len(text) > 8:
        return False
    if any(bad in text for bad in ("查论编", "作品", "地点", "红学", "派", "专题", "续书")):
        return False
    if text in {"金陵十二钗"}:
        return False
    if re.search(r"[|/：:]", text):
        return False
    if text.endswith(("之妻", "之母", "之父", "之子", "之女")):
        return False
    return True


def add_short_aliases(names: set[str]) -> set[str]:
    out = set(names)
    surnames = "贾林薛史王甄秦尤邢李赵周张孙夏傅赖吴马卜柳蒋冷金"
    for name in names:
        if len(name) == 3 and name[0] in surnames:
            alias = name[1:]
            if alias not in {"夫人", "姨妈", "姨娘", "奶娘", "家的"}:
                out.add(alias)
    return out


def read_book_text(book_dir: Path) -> str:
    chunks = []
    for path in sorted(book_dir.glob("*.txt")):
        chunks.append(path.read_text(encoding="utf-8", errors="replace"))
    return "\n".join(chunks)


def update_manifest(root: Path, book_id: str) -> None:
    manifest_path = root / "books" / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    for book in manifest.get("books", []):
        if book.get("id") == book_id:
            book["highlightsFile"] = "highlights.json"
            break
    else:
        sys.exit(f"错误：manifest 中找不到 {book_id}")
    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="生成《红楼梦》人名高亮")
    parser.add_argument("--root", default=".", help="项目根目录（含 books/）")
    parser.add_argument("--id", default="hongloumeng", help="书籍 id")
    args = parser.parse_args()

    root = Path(args.root)
    book_dir = root / "books" / args.id
    if not book_dir.is_dir():
        sys.exit(f"错误：找不到 {book_dir}")

    cc = OpenCC("t2s")
    names = extract_first_column_names(fetch_character_page_html())
    names = {cc.convert(name) for name in names}
    names.update(COMMON_ALIASES)
    names = add_short_aliases(names)

    book_text = read_book_text(book_dir)
    names = {name for name in names if name in book_text}
    names = sorted(names, key=lambda value: (-len(value), value))

    output = {
        "highlights": {
            "人名": names,
        },
        "perChapter": {},
    }
    (book_dir / "highlights.json").write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    update_manifest(root, args.id)
    print(f"完成：写入 {len(names)} 个人名到 {book_dir / 'highlights.json'}")


if __name__ == "__main__":
    main()
