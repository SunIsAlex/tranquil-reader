#!/usr/bin/env python3
"""
split_by_length.py · 把无章节标记的大 TXT 按合理长度切成 Part 1, Part 2, ...
并自动登记/更新到 books/manifest.json。

用法（在项目根目录运行）：
    python3 tools/split_by_length.py whole.txt --id mybook --title 书名 --author 作者
可选参数：
    --chars 8000     每部分目标字数（默认 8000，按字符计）
    --part-label     分部标题模板，默认 "Part {n}"，可改成 "第 {n} 部分"
    --root .         项目根目录（含 books/ 的那一层）

行为说明：
- 永远不在段落中间切断；每部分在不低于目标字数 60% 的前提下，
  优先选择"空行/场景分隔线"这类更自然的断点。
- 自动识别 UTF-8 / GB18030(GBK) / Big5 编码。
- 无论原文是"空行分段"还是"一行一段"，输出统一为空行分段
  （阅读器 reader.js 按空行分段渲染，这一步是必须的）。
- 重复运行幂等：同 id 的旧分卷文件会被清掉重写，manifest 中
  同 id 的条目会被替换而不是追加。
"""

import argparse
import json
import re
import sys
from pathlib import Path

# ---------- 读取与编码 ----------

ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "big5")

def read_text(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ENCODINGS:
        try:
            text = raw.decode(enc)
            print(f"  编码识别：{enc}")
            return text
        except UnicodeDecodeError:
            continue
    sys.exit(f"错误：无法识别 {path} 的编码（尝试了 {', '.join(ENCODINGS)}）")

# ---------- 段落化 ----------

SCENE_BREAK = re.compile(r"^\s*([-—*＊·]\s*){3,}\s*$")  # --- *** ＊＊＊ ——— 等

def to_paragraphs(text: str) -> list[str]:
    """
    把原文拆成段落列表。场景分隔线保留为特殊段落 "---"。
    兼容两种常见格式：
      a) 空行分段（标准格式）
      b) 一行一段（网络 TXT 最常见）
    判断方法：看空行数量占比，空行很少则按"一行一段"处理。
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")
    blank = sum(1 for ln in lines if not ln.strip())
    blank_ratio = blank / max(len(lines), 1)

    paras: list[str] = []
    if blank_ratio >= 0.25:
        # 空行分段：按空行切块
        for block in re.split(r"\n\s*\n", text):
            block = block.strip()
            if not block:
                continue
            if SCENE_BREAK.match(block):
                paras.append("---")
            else:
                # 块内残余换行合并为一段
                paras.append(re.sub(r"\s*\n\s*", "", block))
    else:
        # 一行一段
        for ln in lines:
            s = ln.strip()
            if not s:
                continue
            paras.append("---" if SCENE_BREAK.match(s) else s)
    return paras

# ---------- 切分 ----------

def split_parts(paras: list[str], target: int) -> list[list[str]]:
    """
    贪心累积段落到目标字数。规则：
    - 段落是最小单位，绝不切开；
    - 达到目标字数 60% 后，如果遇到场景分隔线，提前在此断开（更自然）；
    - 超过目标字数后，在当前段落结束处断开。
    """
    parts: list[list[str]] = []
    cur: list[str] = []
    count = 0
    soft = int(target * 0.6)

    for p in paras:
        if p == "---" and count >= soft and cur:
            parts.append(cur)          # 场景线作为天然断点，线本身丢弃
            cur, count = [], 0
            continue
        cur.append(p)
        if p != "---":
            count += len(p)
        if count >= target:
            parts.append(cur)
            cur, count = [], 0

    if cur:
        # 末尾残段太短就并入前一部分，避免出现一个迷你 Part
        if parts and sum(len(p) for p in cur if p != "---") < soft // 2:
            parts[-1].extend(cur)
        else:
            parts.append(cur)
    return parts

# ---------- 写出与登记 ----------

def main() -> None:
    ap = argparse.ArgumentParser(description="按长度切分无章节 TXT 并登记到 manifest.json")
    ap.add_argument("source", help="整本小说的 TXT 文件路径")
    ap.add_argument("--id", required=True, help="书籍 id（同时作为 books/ 下的文件夹名）")
    ap.add_argument("--title", required=True, help="书名")
    ap.add_argument("--author", default="佚名", help="作者")
    ap.add_argument("--chars", type=int, default=8000, help="每部分目标字数（默认 8000）")
    ap.add_argument("--part-label", default="Part {n}", help='分部标题模板，默认 "Part {n}"')
    ap.add_argument("--root", default=".", help="项目根目录（含 books/）")
    args = ap.parse_args()

    if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.id):
        sys.exit("错误：--id 只能包含字母、数字、连字符和下划线（要做 URL 和文件夹名）")

    root = Path(args.root)
    manifest_path = root / "books" / "manifest.json"
    if not manifest_path.exists():
        sys.exit(f"错误：找不到 {manifest_path}，请在项目根目录运行，或用 --root 指定")

    src = Path(args.source)
    if not src.exists():
        sys.exit(f"错误：找不到源文件 {src}")

    print(f"读取 {src} ...")
    text = read_text(src)
    paras = to_paragraphs(text)
    total = sum(len(p) for p in paras if p != "---")
    print(f"  共 {len(paras)} 段，约 {total} 字")

    parts = split_parts(paras, args.chars)
    print(f"  切分为 {len(parts)} 个部分（目标每部分约 {args.chars} 字）")

    # 写出分卷文件（先清掉同名书的旧分卷，保证幂等）
    book_dir = root / "books" / args.id
    book_dir.mkdir(parents=True, exist_ok=True)
    for old in book_dir.glob("part*.txt"):
        old.unlink()

    chapters = []
    for i, part in enumerate(parts, 1):
        fname = f"part{i}.txt"
        body = "\n\n".join("---" if p == "---" else p for p in part)
        (book_dir / fname).write_text(body + "\n", encoding="utf-8")
        title = args.part_label.format(n=i)
        chapters.append({"title": title, "file": fname})
        size = sum(len(p) for p in part if p != "---")
        print(f"  {fname}\t{size} 字\t{title}")

    # 更新 manifest：同 id 替换，否则追加
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    books = manifest.setdefault("books", [])
    entry = {"id": args.id, "title": args.title, "author": args.author, "chapters": chapters}

    # 保留旧条目里的 highlights 等额外字段
    for idx, b in enumerate(books):
        if b.get("id") == args.id:
            for key, val in b.items():
                if key not in entry:
                    entry[key] = val
            books[idx] = entry
            print(f"manifest.json：已更新条目「{args.title}」")
            break
    else:
        books.append(entry)
        print(f"manifest.json：已新增条目「{args.title}」")

    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print("完成。刷新书架即可看到。")

if __name__ == "__main__":
    main()
