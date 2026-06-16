#!/usr/bin/env python3
# tools/generate_highlights_deepseek.py
#
# Termux-friendly, no third-party dependencies.
#
# Usage:
#   export DEEPSEEK_API_KEY="sk-..."
#   python tools/generate_highlights_deepseek.py \
#     --book-dir books/chaoxinxingjiyuan
#
# Output:
#   books/chaoxinxingjiyuan/highlights.json
#
# The output format is:
# {
#   "highlights": { ... global highlights ... },
#   "perChapter": {
#     "001_引子.txt": { ... chapter highlights ... }
#   }
# }

import argparse
import json
import os
import re
import time
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


DEFAULT_BASE_URL = os.environ.get("DEEPSEEK_BASE_URL", "https://api.deepseek.com")
DEFAULT_MODEL = os.environ.get("DEEPSEEK_MODEL", "deepseek-v4-flash")

CATEGORIES = [
    "人名",
    "地名",
    "组织/机构",
    "专有名词",
    "科技/设定",
    "重要概念",
]

SYSTEM_PROMPT = """
你是中文小说实体与关键词标注助手。

你的任务：从小说章节中提取适合网页阅读器高亮的词条。

只输出 json，不要解释，不要 markdown。

json 格式必须是：
{
  "人名": [],
  "地名": [],
  "组织/机构": [],
  "专有名词": [],
  "科技/设定": [],
  "重要概念": []
}

规则：
1. 只提取原文中明确出现过的词。
2. 不要编造。
3. 不要输出普通高频词，例如“孩子”“人类”“国家”“世界”，除非它在文中是特定设定名。
4. 优先提取重复出现、对理解剧情有帮助的词。
5. 每类最多 20 个。
6. 词条尽量短，但必须完整，例如“超级表决器”比“表决器”更好。
7. 不要加入标点。
8. 不要重复。
""".strip()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8", errors="replace")


def clean_text_for_model(text: str, max_chars: int) -> str:
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    text = text.strip()

    if len(text) <= max_chars:
        return text

    head = max_chars // 2
    tail = max_chars - head
    return text[:head] + "\n\n……【中间省略】……\n\n" + text[-tail:]


def chat_completion(
    api_key: str,
    base_url: str,
    model: str,
    messages: list[dict[str, str]],
    timeout: int = 120,
) -> str:
    url = base_url.rstrip("/") + "/chat/completions"

    payload = {
        "model": model,
        "messages": messages,
        "stream": False,
        "response_format": {"type": "json_object"},
        "thinking": {"type": "disabled"},
        "max_tokens": 1800
    }

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")

    req = urllib.request.Request(
        url,
        data=data,
        method="POST",
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            body = resp.read().decode("utf-8", errors="replace")
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"HTTP {e.code}: {body}") from e
    except urllib.error.URLError as e:
        raise RuntimeError(f"Network error: {e}") from e

    obj = json.loads(body)
    return obj["choices"][0]["message"]["content"] or ""


def extract_json_object(s: str) -> dict[str, Any]:
    s = s.strip()
    s = re.sub(r"^```(?:json)?\s*", "", s)
    s = re.sub(r"\s*```$", "", s)

    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass

    start = s.find("{")
    end = s.rfind("}")
    if start >= 0 and end > start:
        return json.loads(s[start:end + 1])

    raise ValueError("Model did not return a JSON object")


def normalize_item(item: Any) -> str:
    item = str(item).strip()
    item = re.sub(r"\s+", "", item)
    item = item.strip("，。；：、,.!?！？“”‘’\"'（）()[]【】《》<>")
    return item


def normalize_highlights(data: dict[str, Any]) -> dict[str, list[str]]:
    out = {k: [] for k in CATEGORIES}

    for category in CATEGORIES:
        values = data.get(category, [])
        if not isinstance(values, list):
            continue

        seen = set()
        for raw in values:
            item = normalize_item(raw)

            if not item:
                continue

            # Single-character highlights are usually too noisy in a reader.
            if len(item) == 1:
                continue

            # Avoid marking whole clauses.
            if len(item) > 18:
                continue

            if item not in seen:
                seen.add(item)
                out[category].append(item)

    return out


def call_deepseek(
    api_key: str,
    base_url: str,
    model: str,
    chapter_title: str,
    text: str,
) -> dict[str, list[str]]:
    user_prompt = f"""
章节标题：{chapter_title}

请从下面章节中提取阅读器高亮词条，并输出 json：

{text}
""".strip()

    content = chat_completion(
        api_key=api_key,
        base_url=base_url,
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user_prompt},
        ],
    )

    parsed = extract_json_object(content)
    return normalize_highlights(parsed)


def merge_highlights(
    merged: dict[str, list[str]],
    new_data: dict[str, list[str]],
    max_per_category: int,
) -> None:
    for category in CATEGORIES:
        seen = set(merged[category])

        for item in new_data.get(category, []):
            if item not in seen:
                merged[category].append(item)
                seen.add(item)

        merged[category] = merged[category][:max_per_category]


def discover_chapters(book_dir: Path) -> list[Path]:
    files = sorted(book_dir.glob("*.txt"))
    return [p for p in files if p.name.lower() != "index.txt"]


def title_from_filename(path: Path) -> str:
    stem = path.stem
    stem = re.sub(r"^\d+[-_ ]*", "", stem)
    return stem.strip() or path.stem


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--book-dir", required=True, help="Book folder, e.g. books/chaoxinxingjiyuan")
    parser.add_argument("--out", default="", help="Output file. Default: <book-dir>/highlights.json")
    parser.add_argument("--model", default=DEFAULT_MODEL)
    parser.add_argument("--base-url", default=DEFAULT_BASE_URL)
    parser.add_argument("--max-chars", type=int, default=12000)
    parser.add_argument("--max-per-category", type=int, default=80)
    parser.add_argument("--sleep", type=float, default=0.5)
    args = parser.parse_args()

    api_key = os.environ.get("DEEPSEEK_API_KEY")
    if not api_key:
      raise SystemExit("Missing DEEPSEEK_API_KEY environment variable")

    book_dir = Path(args.book_dir)
    if not book_dir.exists():
        raise SystemExit(f"Book dir not found: {book_dir}")

    chapters = discover_chapters(book_dir)
    if not chapters:
        raise SystemExit(f"No .txt chapters found in {book_dir}")

    out_path = Path(args.out) if args.out else book_dir / "highlights.json"

    merged = {k: [] for k in CATEGORIES}
    per_chapter = {}

    print(f"Model: {args.model}")
    print(f"Base URL: {args.base_url}")
    print("Thinking: disabled")
    print(f"Chapters: {len(chapters)}")
    print()

    for i, path in enumerate(chapters, start=1):
        title = title_from_filename(path)
        text = clean_text_for_model(read_text(path), args.max_chars)

        print(f"[{i}/{len(chapters)}] {path.name}")

        try:
            highlights = call_deepseek(
                api_key=api_key,
                base_url=args.base_url,
                model=args.model,
                chapter_title=title,
                text=text,
            )
        except Exception as e:
            print(f"  ERROR: {e}")
            continue

        per_chapter[path.name] = highlights
        merge_highlights(merged, highlights, args.max_per_category)

        count = sum(len(v) for v in highlights.values())
        print(f"  extracted: {count}")

        if args.sleep > 0:
            time.sleep(args.sleep)

    output = {
        "highlights": merged,
        "perChapter": per_chapter,
    }

    out_path.write_text(
        json.dumps(output, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print()
    print(f"DONE: {out_path}")
    print()
    print("In books/manifest.json, this book should use:")
    print(json.dumps({"highlightsFile": out_path.name}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
