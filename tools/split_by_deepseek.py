#!/usr/bin/env python3
# tools/split_book_deepseek.py
#
# Termux-friendly, no third-party dependencies.
#
# What it does:
#   1. Read a large Chinese novel TXT.
#   2. Locally find possible headings.
#   3. Ask DeepSeek to classify headings as:
#      - part
#      - chapter
#      - preface
#      - ignore
#   4. Split the ORIGINAL text by line numbers.
#   5. Write chapter TXT files + index.txt + manifest snippet.
#
# Usage:
#   export DEEPSEEK_API_KEY="sk-..."
#   python tools/split_book_deepseek.py \
#     --input "[1991-1]《超新星纪元》(新创世纪-完整版).txt" \
#     --id chaoxinxingjiyuan \
#     --title "超新星纪元" \
#     --author "刘慈欣" \
#     --out-dir books/chaoxinxingjiyuan \
#     --manifest-snippet books/chaoxinxingjiyuan/manifest.snippet.json
#
# Optional:
#   export DEEPSEEK_MODEL="deepseek-v4-flash"
#   export DEEPSEEK_BASE_URL="https://api.deepseek.com"

import argparse
import json
import os
import re
import shutil
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEFAULT_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")

CN_NUMS = "零〇一二三四五六七八九十百千万两壹贰叁肆伍陆柒捌玖拾"


SYSTEM_PROMPT = """
你是中文小说目录结构识别助手。

你会收到一组“候选标题行”，每个候选都有 line、text、prev、next。

任务：
判断哪些候选是真正的小说结构标题，并输出 json。

只输出 json，不要解释，不要 markdown。

json 格式必须是：
{
  "items": [
    {
      "line": 123,
      "type": "preface | part | chapter | ignore",
      "title": "清理后的标题",
      "reason": "very short reason"
    }
  ]
}

规则：
1. line 必须来自输入候选，不要编造新 line。
2. “引子”“序章”“楔子”“序”通常是 preface。
3. “死星”“接过世界”“糖城时代”“超新星战争”“创世纪”这种短独立标题通常是 part。
4. “一、超新星”“二、午夜骄阳”“第十二章 xxx”通常是 chapter。
5. 括号说明、通讯说明、引文来源、普通短句、人物对白都应为 ignore。
6. 不要把正文中的短句误判为章节标题。
7. title 要去掉多余空白，但不要改写原意。
8. 输出中必须包含每一个输入候选，type 可为 ignore。
""".strip()


def read_text(path: Path) -> str:
    for enc in ("utf-8-sig", "utf-8", "gb18030", "big5"):
        try:
            return path.read_text(encoding=enc)
        except UnicodeDecodeError:
            continue
    return path.read_text(encoding="utf-8", errors="replace")


def normalize_newlines(text: str) -> str:
    return text.replace("\r\n", "\n").replace("\r", "\n")


def is_blank(s: str) -> bool:
    return s.strip() == ""


def looks_numbered_heading(s: str) -> bool:
    s = s.strip()
    if len(s) > 60:
        return False

    patterns = [
        rf"^[{CN_NUMS}]+[、.．]\s*\S+",
        rf"^第[{CN_NUMS}\d]+[章节回部卷篇]\s*\S*",
        r"^\d+[、.．]\s*\S+",
    ]
    return any(re.match(p, s) for p in patterns)


def looks_short_part_heading(s: str) -> bool:
    s = s.strip()
    if not s or len(s) > 14:
        return False
    if looks_numbered_heading(s):
        return False
    if any(ch in s for ch in "，。；：,.!?！？、（）()《》“”\"'"):
        return False
    return True


def find_candidates(lines: list[str]) -> list[dict[str, Any]]:
    candidates = []

    for i, line in enumerate(lines):
        s = line.strip()
        if not s:
            continue

        prev_blank = i == 0 or is_blank(lines[i - 1])
        next_blank = i + 1 >= len(lines) or is_blank(lines[i + 1])

        # Strong structural hint: standalone short line surrounded by blank lines.
        surrounded = prev_blank and next_blank

        is_candidate = False

        if s in {"引子", "序", "序章", "楔子", "前言"} and surrounded:
            is_candidate = True
        elif looks_numbered_heading(s) and surrounded:
            is_candidate = True
        elif looks_short_part_heading(s) and surrounded:
            is_candidate = True

        if not is_candidate:
            continue

        prev_text = ""
        next_text = ""

        # nearest non-empty previous line
        for j in range(i - 1, max(-1, i - 6), -1):
            if lines[j].strip():
                prev_text = lines[j].strip()
                break

        # nearest non-empty next line
        for j in range(i + 1, min(len(lines), i + 7)):
            if lines[j].strip():
                next_text = lines[j].strip()
                break

        candidates.append({
            "line": i,
            "text": s,
            "prev": prev_text[:80],
            "next": next_text[:80],
        })

    return candidates


def api_chat_json(
    api_key: str,
    base_url: str,
    model: str,
    payload_obj: dict[str, Any],
    timeout: int = 120,
) -> dict[str, Any]:
    url = base_url.rstrip("/") + "/chat/completions"

    payload = {
        "model": model,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": "请识别下面候选标题行，并输出 json：\n\n" +
                           json.dumps(payload_obj, ensure_ascii=False)
            },
        ],
        "stream": False,
        "response_format": {"type": "json_object"},

        # DeepSeek V4 thinking mode: explicitly disabled.
        "thinking": {"type": "disabled"},

        "max_tokens": 6000,
    }

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=body,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            raw = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        err = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {err}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e}") from e

    data = json.loads(raw)
    content = data["choices"][0]["message"]["content"]
    return json.loads(content)


def classify_candidates_with_deepseek(
    candidates: list[dict[str, Any]],
    api_key: str,
    base_url: str,
    model: str,
    chunk_size: int = 80,
    sleep: float = 0.4,
) -> list[dict[str, Any]]:
    all_items = []

    for start in range(0, len(candidates), chunk_size):
        chunk = candidates[start:start + chunk_size]
        print(f"Classifying candidates {start + 1}-{start + len(chunk)} / {len(candidates)}")

        result = api_chat_json(
            api_key=api_key,
            base_url=base_url,
            model=model,
            payload_obj={"candidates": chunk},
        )

        items = result.get("items", [])
        if not isinstance(items, list):
            raise RuntimeError("DeepSeek returned invalid JSON: missing items[]")

        all_items.extend(items)

        if sleep > 0:
            time.sleep(sleep)

    return all_items


def fallback_classify(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    items = []

    for c in candidates:
        s = c["text"]
        typ = "ignore"

        if s in {"引子", "序", "序章", "楔子", "前言"}:
            typ = "preface"
        elif looks_numbered_heading(s):
            typ = "chapter"
        elif looks_short_part_heading(s):
            typ = "part"

        items.append({
            "line": c["line"],
            "type": typ,
            "title": s,
            "reason": "fallback rule",
        })

    return items


def clean_title(s: str) -> str:
    s = str(s or "").strip()
    s = re.sub(r"\s+", " ", s)
    return s


def build_chapter_plan(items: list[dict[str, Any]], lines: list[str]) -> list[dict[str, Any]]:
    valid = []
    seen_lines = set()

    for item in items:
        try:
            line = int(item.get("line"))
        except Exception:
            continue

        if line < 0 or line >= len(lines):
            continue
        if line in seen_lines:
            continue

        typ = str(item.get("type", "")).strip().lower()
        if typ not in {"preface", "part", "chapter", "ignore"}:
            typ = "ignore"

        title = clean_title(item.get("title") or lines[line].strip())
        valid.append({
            "line": line,
            "type": typ,
            "title": title,
        })
        seen_lines.add(line)

    valid.sort(key=lambda x: x["line"])

    plan = []
    current_part = ""
    pending_part_line = None

    for item in valid:
        typ = item["type"]

        if typ == "ignore":
            continue

        if typ == "part":
            current_part = item["title"]
            pending_part_line = item["line"]
            continue

        if typ in {"preface", "chapter"}:
            raw_title = item["title"]

            if typ == "preface":
                full_title = raw_title
                start_line = item["line"]
                current_part = ""
                pending_part_line = None
            else:
                full_title = f"{current_part} - {raw_title}" if current_part else raw_title

                # Include the part heading line in the first chapter of that part.
                # Example:
                #   死星
                #
                #   一、超新星
                start_line = pending_part_line if pending_part_line is not None else item["line"]
                pending_part_line = None

            plan.append({
                "start_line": start_line,
                "heading_line": item["line"],
                "title": full_title,
                "raw_title": raw_title,
                "part": current_part,
            })

    # Remove accidental duplicate starts.
    cleaned = []
    seen_starts = set()
    for ch in plan:
        if ch["start_line"] in seen_starts:
            continue
        seen_starts.add(ch["start_line"])
        cleaned.append(ch)

    return cleaned


def safe_filename(s: str) -> str:
    s = re.sub(r'[\\/:*?"<>|]', "_", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s[:90] or "untitled"


def write_split_files(
    lines: list[str],
    plan: list[dict[str, Any]],
    out_dir: Path,
    book_id: str,
    book_title: str,
    author: str,
    manifest_snippet_path: Path | None,
    clean_out_dir: bool,
) -> None:
    if clean_out_dir and out_dir.exists():
        shutil.rmtree(out_dir)

    out_dir.mkdir(parents=True, exist_ok=True)

    chapters = []

    for idx, ch in enumerate(plan):
        start = ch["start_line"]
        end = plan[idx + 1]["start_line"] if idx + 1 < len(plan) else len(lines)

        content = "\n".join(lines[start:end]).strip() + "\n"

        filename = f"{idx + 1:03d}_{safe_filename(ch['title'])}.txt"
        path = out_dir / filename
        path.write_text(content, encoding="utf-8")

        chapters.append({
            "title": ch["title"],
            "file": filename,
        })

    index_lines = [book_title, ""]
    for i, ch in enumerate(chapters, start=1):
        index_lines.append(f"{i:03d}. {ch['title']}  ->  {ch['file']}")

    (out_dir / "index.txt").write_text("\n".join(index_lines) + "\n", encoding="utf-8")

    manifest_book = {
        "id": book_id,
        "title": book_title,
        "author": author,
        "chapters": chapters,
    }

    if manifest_snippet_path:
        manifest_snippet_path.parent.mkdir(parents=True, exist_ok=True)
        manifest_snippet_path.write_text(
            json.dumps(manifest_book, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )

    print()
    print(f"Wrote {len(chapters)} chapter files to: {out_dir}")
    print(f"Wrote index: {out_dir / 'index.txt'}")
    if manifest_snippet_path:
        print(f"Wrote manifest snippet: {manifest_snippet_path}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True, help="Input large TXT file")
    parser.add_argument("--id", required=True, help="Book id, e.g. chaoxinxingjiyuan")
    parser.add_argument("--title", required=True, help="Book title")
    parser.add_argument("--author", default="佚名")
    parser.add_argument("--out-dir", required=True, help="Output folder for chapter TXT files")
    parser.add_argument("--manifest-snippet", default="", help="Write a book-object JSON snippet here")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--no-ai", action="store_true", help="Use deterministic fallback only")
    parser.add_argument("--keep-out-dir", action="store_true", help="Do not delete existing output folder first")
    parser.add_argument("--sleep", type=float, default=0.4)
    args = parser.parse_args()

    input_path = Path(args.input)
    out_dir = Path(args.out_dir)
    manifest_path = Path(args.manifest_snippet) if args.manifest_snippet else None

    raw = normalize_newlines(read_text(input_path))
    lines = raw.split("\n")

    candidates = find_candidates(lines)
    print(f"Input lines: {len(lines)}")
    print(f"Heading candidates: {len(candidates)}")

    if not candidates:
        raise SystemExit("No heading candidates found.")

    if args.no_ai:
        print("AI disabled. Using fallback rules.")
        items = fallback_classify(candidates)
    else:
        api_key = os.environ.get("DEEPSEEK_API_KEY")
        if not api_key:
            raise SystemExit("Missing DEEPSEEK_API_KEY. Or run with --no-ai.")

        print(f"Model: {args.model}")
        print(f"Base URL: {args.base_url}")
        print("Thinking: disabled")

        try:
            items = classify_candidates_with_deepseek(
                candidates=candidates,
                api_key=api_key,
                base_url=args.base_url,
                model=args.model,
                sleep=args.sleep,
            )
        except Exception as e:
            print()
            print(f"DeepSeek classification failed: {e}")
            print("Falling back to deterministic rules.")
            items = fallback_classify(candidates)

    plan = build_chapter_plan(items, lines)

    print()
    print(f"Detected chapters: {len(plan)}")
    for i, ch in enumerate(plan[:12], start=1):
        print(f"{i:03d}. line {ch['start_line']}: {ch['title']}")
    if len(plan) > 12:
        print("...")
        last = plan[-1]
        print(f"{len(plan):03d}. line {last['start_line']}: {last['title']}")

    if len(plan) < 2:
        raise SystemExit("Too few chapters detected. Not writing output.")

    write_split_files(
        lines=lines,
        plan=plan,
        out_dir=out_dir,
        book_id=args.id,
        book_title=args.title,
        author=args.author,
        manifest_snippet_path=manifest_path,
        clean_out_dir=not args.keep_out_dir,
    )


if __name__ == "__main__":
    main()