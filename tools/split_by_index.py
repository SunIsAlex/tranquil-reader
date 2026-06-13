#!/usr/bin/env python3
"""
split_by_index.py · 切分"中文数字索引体"小说
适用章节标题形如：
    零  引子
    一  最高执政官
    十一  全国断电
即：行首一个中文数字（零/一/二…十一…），空格，章节名，各占一行。

用法（项目根目录运行）：
    python3 tools/split_by_index.py whole.txt --id mybook --title 书名 --author 作者
可选：
    --root .                  项目根目录（含 books/）
    --min-chars 120           判定"真章节"的正文字数下限（默认 120），
                              用来过滤目录里的同名条目

为什么需要特殊处理：
- 章节标记是裸中文数字，不是"第X章"，普通正则匹配不到；
- 正文开头通常有一份"目录"，每行也长成 "一  最高执政官" 的样子。
  本脚本通过"同名标题只保留最后一次出现"来剔除目录条目
  （目录在前、正文在后，正文那次才是真章节），
  再用 --min-chars 作为二次保险，过滤正文极短的误判行。

其余行为（编码识别、段落归一、manifest 幂等更新、保留 highlights）
与 split_by_length.py 一致。
"""

import argparse
import json
import re
import sys
from pathlib import Path

ENCODINGS = ("utf-8-sig", "utf-8", "gb18030", "big5")

# 行首中文数字 + 间隔空白（半角或全角）+ 标题
HEADING = re.compile(
    r"^[\s\u3000]*([〇零一二三四五六七八九十百千两]+)[\s\u3000]+(\S[^\n]*?)[\s\u3000]*$"
)
SCENE_BREAK = re.compile(r"^\s*([-—*＊·]\s*){3,}\s*$")


def read_text(path: Path) -> str:
    raw = path.read_bytes()
    for enc in ENCODINGS:
        try:
            text = raw.decode(enc)
            print(f"  编码识别：{enc}")
            return text
        except UnicodeDecodeError:
            continue
    sys.exit(f"错误：无法识别 {path} 的编码")


def normalize_paragraphs(lines: list[str], one_line_mode: bool) -> str:
    """把一章的行列表归一为空行分段的文本（阅读器按空行分段渲染）。"""
    if one_line_mode:
        out = []
        for ln in lines:
            s = ln.strip()
            if not s:
                continue
            out.append("---" if SCENE_BREAK.match(s) else s)
        return "\n\n".join(out)
    # 空行分段模式
    text = "\n".join(lines)
    blocks = []
    for block in re.split(r"\n\s*\n", text):
        b = block.strip()
        if not b:
            continue
        if SCENE_BREAK.match(b):
            blocks.append("---")
        else:
            blocks.append(re.sub(r"\s*\n\s*", "", b))
    return "\n\n".join(blocks)


def main() -> None:
    ap = argparse.ArgumentParser(description="切分中文数字索引体小说并登记 manifest.json")
    ap.add_argument("source", help="整本 TXT 路径")
    ap.add_argument("--id", required=True, help="书籍 id（同时作文件夹名）")
    ap.add_argument("--title", required=True, help="书名")
    ap.add_argument("--author", default="佚名", help="作者")
    ap.add_argument("--min-chars", type=int, default=120, help="真章节正文字数下限")
    ap.add_argument("--root", default=".", help="项目根目录（含 books/）")
    args = ap.parse_args()

    if not re.fullmatch(r"[a-zA-Z0-9_-]+", args.id):
        sys.exit("错误：--id 只能含字母、数字、连字符、下划线")

    root = Path(args.root)
    manifest_path = root / "books" / "manifest.json"
    if not manifest_path.exists():
        sys.exit(f"错误：找不到 {manifest_path}，请在项目根目录运行或用 --root 指定")
    src = Path(args.source)
    if not src.exists():
        sys.exit(f"错误：找不到源文件 {src}")

    print(f"读取 {src} ...")
    text = read_text(src).replace("\r\n", "\n").replace("\r", "\n")
    lines = text.split("\n")

    # 一行一段 vs 空行分段：看空行占比
    blank = sum(1 for ln in lines if not ln.strip())
    one_line_mode = (blank / max(len(lines), 1)) < 0.25

    # 1) 找出所有候选标题行
    cands = []  # (line_idx, title_text)
    for i, ln in enumerate(lines):
        m = HEADING.match(ln)
        if m:
            num, name = m.group(1), m.group(2).strip()
            # 标题别太长，避免把正文里"十 年来他..."这类误判（一般标题 < 20 字）
            if len(name) <= 20:
                cands.append((i, f"{num} {name}"))
    if not cands:
        sys.exit("没找到任何 '数字 标题' 形式的章节行，确认格式或换用 split_by_length.py")

    # 2) 同名标题只保留最后一次出现 —— 目录在前、正文在后，去掉目录那一份
    last_idx_of = {}
    for idx, title in cands:
        last_idx_of[title] = idx
    kept = sorted((idx, title) for title, idx in last_idx_of.items())

    # 3) 二次保险：正文太短的候选丢弃（过滤残留误判）
    real = []
    for k, (idx, title) in enumerate(kept):
        end = kept[k + 1][0] if k + 1 < len(kept) else len(lines)
        body_chars = sum(len(lines[j].strip()) for j in range(idx + 1, end))
        if body_chars >= args.min_chars:
            real.append((idx, title))
        else:
            print(f"  跳过疑似目录/空章：{title}（正文仅 {body_chars} 字）")
    if not real:
        sys.exit("过滤后无有效章节，可调小 --min-chars 重试")

    skipped_head = real[0][0]
    if skipped_head > 0:
        head_chars = sum(len(lines[j].strip()) for j in range(skipped_head))
        print(f"  首章之前的 {head_chars} 字（书名/目录等）已忽略")

    # 4) 写出各章
    book_dir = root / "books" / args.id
    book_dir.mkdir(parents=True, exist_ok=True)
    for old in book_dir.glob("ch*.txt"):
        old.unlink()

    chapters = []
    for k, (idx, title) in enumerate(real):
        end = real[k + 1][0] if k + 1 < len(real) else len(lines)
        body = normalize_paragraphs(lines[idx + 1:end], one_line_mode)
        fname = f"ch{k + 1}.txt"
        (book_dir / fname).write_text(body + "\n", encoding="utf-8")
        chapters.append({"title": title, "file": fname})
        print(f"  {fname}\t{len(body)} 字\t{title}")

    print(f"共 {len(chapters)} 章")

    # 5) 更新 manifest（同 id 替换，保留 highlights 等字段）
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    books = manifest.setdefault("books", [])
    entry = {"id": args.id, "title": args.title, "author": args.author, "chapters": chapters}
    for i, b in enumerate(books):
        if b.get("id") == args.id:
            for key, val in b.items():
                if key not in entry:
                    entry[key] = val
            books[i] = entry
            print(f"manifest.json：已更新「{args.title}」")
            break
    else:
        books.append(entry)
        print(f"manifest.json：已新增「{args.title}」")

    manifest_path.write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print("完成。刷新书架即可看到。")


if __name__ == "__main__":
    main()
