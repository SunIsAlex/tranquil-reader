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
#   5. Remove structural headings from chapter body.
#   6. Write chapter TXT files + index.txt + manifest snippet.
#
# Usage:
#   export DEEPSEEK_API_KEY="sk-..."
#   python tools/split_book_deepseek.py \
#     --input "[2006]《三体》.txt" \
#     --id santi \
#     --title "三体" \
#     --author "刘慈欣" \
#     --out-dir books/santi \
#     --manifest-snippet books/santi/manifest.snippet.json
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
5. “1. 疯狂年代”“2．寂静的春天”“27 伊文斯”“35.尾声 遗址”这种通常是 chapter。
6. 如果候选 text 只有编号，例如“4．”，而 next 是短标题，例如“三十八年后。”，则它通常是 chapter，title 应补全为“4．三十八年后”。
7. 括号说明、通讯说明、引文来源、普通短句、人物对白都应为 ignore。
8. 不要把正文中的短句误判为章节标题。
9. title 要去掉多余空白，但不要改写原意。
10. 输出中必须包含每一个输入候选，type 可为 ignore。
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


def strip_title_end_punctuation(s: str) -> str:
    """
    Used for broken headings like:

      4．
      　三十八年后。

    We want title: 4．三十八年后
    """
    return re.sub(r"[。．.]+$", "", s.strip()).strip()


def is_number_only_heading(s: str) -> bool:
    """
    Match:
      4．
      4.
      4 ．
    """
    s = s.strip()
    return re.match(r"^\d{1,3}\s*[\.．]\s*$", s) is not None


def looks_arabic_chapter_heading(s: str) -> bool:
    """
    Match chapter headings like those in 三体:

      1. 疯狂年代
      1.疯狂年代
      2．寂静的春天
      4．
      27 伊文斯
      35.尾声 遗址

    Important:
    三体-style headings often are NOT surrounded by blank lines.
    So find_candidates() should not require next_blank for this pattern.
    """
    s = s.strip()
    if not s or len(s) > 60:
        return False

    return re.match(
        r"^\d{1,3}(?:\s*[\.．]\s*|\s+)(?:\S.*)?$",
        s,
    ) is not None


def looks_numbered_heading(s: str) -> bool:
    """
    Match more traditional Chinese numbered headings.

    Examples:
      一、超新星
      二．午夜骄阳
      第十二章 红岸之一
      1、疯狂年代

    三体-style "1. 疯狂年代" is handled by looks_arabic_chapter_heading().
    """
    s = s.strip()
    if not s or len(s) > 60:
        return False

    patterns = [
        rf"^[{CN_NUMS}]+[、\.．]\s*\S+",
        rf"^第[{CN_NUMS}\d]+[章节回部卷篇]\s*\S*",
        r"^\d{1,3}\s*、\s*\S+",
    ]

    return any(re.match(p, s) for p in patterns)


def looks_short_part_heading(s: str) -> bool:
    s = s.strip()
    if not s or len(s) > 14:
        return False
    if looks_arabic_chapter_heading(s):
        return False
    if looks_numbered_heading(s):
        return False

    # Punctuation usually means this is not a clean part title.
    if any(ch in s for ch in "，。；：,.!?！？、（）()《》“”\"'"):
        return False

    # Avoid obvious metadata lines like "刘慈欣  三体".
    if re.search(r"\s{2,}", s):
        return False

    return True


def find_nearest_non_empty_before(
    lines: list[str],
    i: int,
    window: int = 6,
) -> tuple[int, str]:
    for j in range(i - 1, max(-1, i - window), -1):
        if lines[j].strip():
            return j, lines[j].strip()
    return -1, ""


def find_nearest_non_empty_after(
    lines: list[str],
    i: int,
    window: int = 7,
) -> tuple[int, str]:
    for j in range(i + 1, min(len(lines), i + window)):
        if lines[j].strip():
            return j, lines[j].strip()
    return -1, ""


def infer_heading_title_and_end_line(
    line: int,
    lines: list[str],
    next_line: int | None = None,
) -> tuple[str, int]:
    """
    Return:
      (clean heading title, last title line index)

    Normal:
      line: "1. 疯狂年代"
      -> ("1. 疯狂年代", line)

    Broken heading:
      line: "4．"
      next non-empty line: "三十八年后。"
      -> ("4．三十八年后", next_line)

    The second return value is important because chapter body should start
    AFTER the last title line, so headings do not appear in TXT body.
    """
    raw = lines[line].strip()

    if not is_number_only_heading(raw):
        return raw, line

    if next_line is None or next_line < 0 or next_line >= len(lines):
        next_line, next_text = find_nearest_non_empty_after(lines, line, window=4)
    else:
        next_text = lines[next_line].strip()

    # Conservative enough for cases like "三十八年后。"
    # A real title continuation is usually short.
    if next_line != -1 and next_text and len(next_text) <= 30:
        cleaned_next = strip_title_end_punctuation(next_text)
        if cleaned_next:
            return f"{raw}{cleaned_next}", next_line

    return raw, line


def find_candidates(lines: list[str]) -> list[dict[str, Any]]:
    candidates = []

    for i, line in enumerate(lines):
        s = line.strip()
        if not s:
            continue

        prev_blank = i == 0 or is_blank(lines[i - 1])
        next_blank = i + 1 >= len(lines) or is_blank(lines[i + 1])
        surrounded = prev_blank and next_blank

        is_candidate = False

        # Preface-like titles are often standalone, but may not always have both blank lines.
        if s in {"引子", "序", "序章", "楔子", "前言"} and (surrounded or prev_blank or next_blank):
            is_candidate = True

        # 三体-style chapter titles:
        # Do NOT require surrounded blank lines.
        elif looks_arabic_chapter_heading(s):
            is_candidate = True

        # Traditional numbered headings still require stronger structural hint,
        # because body text may contain numbered lists like "一、..." or "1、...".
        elif looks_numbered_heading(s) and surrounded:
            is_candidate = True

        # Short part headings need blank lines to avoid many false positives.
        # Also skip i == 0 to avoid treating book metadata/title line as part.
        elif i > 0 and looks_short_part_heading(s) and surrounded:
            is_candidate = True

        if not is_candidate:
            continue

        prev_line, prev_text = find_nearest_non_empty_before(lines, i)
        next_line, next_text = find_nearest_non_empty_after(lines, i)

        candidates.append({
            "line": i,
            "text": s,
            "prev_line": prev_line,
            "next_line": next_line,
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
                "content": (
                    "请识别下面候选标题行，并输出 json：\n\n"
                    + json.dumps(payload_obj, ensure_ascii=False)
                ),
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


def fallback_classify(candidates: list[dict[str, Any]], lines: list[str]) -> list[dict[str, Any]]:
    items = []

    for c in candidates:
        line = int(c["line"])
        raw = lines[line].strip()

        inferred_title, _title_end_line = infer_heading_title_and_end_line(
            line=line,
            lines=lines,
            next_line=c.get("next_line", -1),
        )

        typ = "ignore"

        if raw in {"引子", "序", "序章", "楔子", "前言"}:
            typ = "preface"
        elif looks_arabic_chapter_heading(raw):
            typ = "chapter"
        elif looks_numbered_heading(raw):
            typ = "chapter"
        elif looks_short_part_heading(raw):
            typ = "part"

        items.append({
            "line": line,
            "type": typ,
            "title": inferred_title,
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

        source_title, title_end_line = infer_heading_title_and_end_line(
            line=line,
            lines=lines,
        )

        ai_title = clean_title(item.get("title") or "")

        # For broken headings like "4．", trust local reconstruction,
        # because the true title line needs to be removed from body too.
        raw_source = lines[line].strip()
        if is_number_only_heading(raw_source):
            title = source_title
        elif not ai_title or is_number_only_heading(ai_title):
            title = source_title
        else:
            title = ai_title

        valid.append({
            "line": line,
            "type": typ,
            "title": clean_title(title),
            "title_end_line": title_end_line,
        })

        seen_lines.add(line)

    valid.sort(key=lambda x: x["line"])

    plan = []
    current_part = ""

    pending_part_title = ""
    pending_part_start_line = None
    pending_part_title_end_line = None

    for item in valid:
        typ = item["type"]

        if typ == "ignore":
            continue

        if typ == "part":
            current_part = item["title"]
            pending_part_title = item["title"]
            pending_part_start_line = item["line"]
            pending_part_title_end_line = item["title_end_line"]
            continue

        if typ in {"preface", "chapter"}:
            raw_title = item["title"]

            if typ == "preface":
                full_title = raw_title
                section_start_line = item["line"]

                # Remove preface heading itself from body.
                content_start_line = item["title_end_line"] + 1

                current_part = ""
                pending_part_title = ""
                pending_part_start_line = None
                pending_part_title_end_line = None

            else:
                full_title = f"{current_part} - {raw_title}" if current_part else raw_title

                # If a part heading immediately precedes the first chapter of the part,
                # use the part line as the section boundary so previous chapter stops before it.
                section_start_line = (
                    pending_part_start_line
                    if pending_part_start_line is not None
                    else item["line"]
                )

                # But body should start after the chapter title, not after the part title.
                # This removes both:
                #   part heading line
                #   chapter heading line
                # from the chapter TXT body.
                content_start_line = item["title_end_line"] + 1

                pending_part_title = ""
                pending_part_start_line = None
                pending_part_title_end_line = None

            plan.append({
                "start_line": section_start_line,
                "content_start_line": content_start_line,
                "heading_line": item["line"],
                "title_end_line": item["title_end_line"],
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
        section_start = ch["start_line"]
        content_start = ch["content_start_line"]
        end = plan[idx + 1]["start_line"] if idx + 1 < len(plan) else len(lines)

        if content_start < section_start:
            content_start = section_start
        if content_start > end:
            content_start = end

        # Important:
        # Use content_start, not section_start.
        # This removes chapter/part/preface headings from TXT body.
        content = "\n".join(lines[content_start:end]).strip() + "\n"

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

    (out_dir / "index.txt").write_text(
        "\n".join(index_lines) + "\n",
        encoding="utf-8",
    )

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
    parser.add_argument("--id", required=True, help="Book id, e.g. santi")
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
        items = fallback_classify(candidates, lines)
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
            items = fallback_classify(candidates, lines)

    plan = build_chapter_plan(items, lines)

    print()
    print(f"Detected chapters: {len(plan)}")

    for i, ch in enumerate(plan[:12], start=1):
        print(
            f"{i:03d}. "
            f"section line {ch['start_line']}, "
            f"content line {ch['content_start_line']}: "
            f"{ch['title']}"
        )

    if len(plan) > 12:
        print("...")
        last = plan[-1]
        print(
            f"{len(plan):03d}. "
            f"section line {last['start_line']}, "
            f"content line {last['content_start_line']}: "
            f"{last['title']}"
        )

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