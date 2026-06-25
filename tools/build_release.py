#!/usr/bin/env python3
"""Build a compact static release into dist/.

The source app intentionally stays build-free. This script is for deployment:
it validates book assets, copies only deployable files, compacts text assets,
and gives the generated service worker a content-derived cache version.
"""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import re
import shutil
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_DIST = ROOT / "dist"

DEPLOY_PATHS = [
    ".well-known",
    "app",
    "books",
    "css",
    "edge-functions",
    "icons",
    "js",
    "favicon.ico",
    "favicon.png",
    "index.html",
    "manifest.webmanifest",
    "reader.html",
    "sw.js",
]


class BuildError(Exception):
    pass


def main() -> None:
    parser = argparse.ArgumentParser(description="Validate and build a compact release.")
    parser.add_argument("--dist", default=str(DEFAULT_DIST), help="Release output directory.")
    parser.add_argument("--validate-only", action="store_true", help="Only validate assets.")
    args = parser.parse_args()

    dist = Path(args.dist).resolve()
    if not dist.is_relative_to(ROOT):
      raise BuildError(f"dist must be inside the project: {dist}")

    validate_project(ROOT)

    if args.validate_only:
        print("Validation passed.")
        return

    build_dist(ROOT, dist)
    print(f"Release built: {dist.relative_to(ROOT)}")


def validate_project(root: Path) -> None:
    errors: list[str] = []

    manifest_path = root / "books" / "manifest.json"
    manifest = read_json(manifest_path, errors)
    if not isinstance(manifest, dict):
        raise_errors(errors or ["books/manifest.json must be a JSON object."])

    books = manifest.get("books")
    if not isinstance(books, list):
        errors.append("books/manifest.json: books must be an array.")
        books = []

    seen_ids: set[str] = set()
    for index, book in enumerate(books):
        label = f"books[{index}]"
        if not isinstance(book, dict):
            errors.append(f"{label}: must be an object.")
            continue

        book_id = book.get("id")
        if not isinstance(book_id, str) or not book_id.strip():
            errors.append(f"{label}: id is required.")
            continue
        if book_id in seen_ids:
            errors.append(f"{label}: duplicate id {book_id!r}.")
        seen_ids.add(book_id)

        book_dir = root / "books" / book_id
        if not book_dir.is_dir():
            errors.append(f"{label}: missing directory books/{book_id}/.")

        for key in ("cover", "coverThumb", "highlightsFile"):
            value = book.get(key)
            if isinstance(value, str) and value and not is_external_or_absolute(value):
                path = book_dir / value
                if not path.is_file():
                    errors.append(f"{label}: missing {key} file books/{book_id}/{value}.")
                elif key == "highlightsFile":
                    read_json(path, errors)

        chapters = book.get("chapters")
        if not isinstance(chapters, list) or not chapters:
            errors.append(f"{label}: chapters must be a non-empty array.")
            continue

        chapter_files: set[str] = set()
        for chapter_index, chapter in enumerate(chapters):
            chapter_label = f"{label}.chapters[{chapter_index}]"
            if not isinstance(chapter, dict):
                errors.append(f"{chapter_label}: must be an object.")
                continue

            file_name = chapter.get("file")
            if not isinstance(file_name, str) or not file_name.strip():
                errors.append(f"{chapter_label}: file is required.")
                continue
            if file_name in chapter_files:
                errors.append(f"{chapter_label}: duplicate chapter file {file_name!r}.")
            chapter_files.add(file_name)

            path = book_dir / file_name
            if not path.is_file():
                errors.append(f"{chapter_label}: missing books/{book_id}/{file_name}.")

    validate_webmanifest(root, errors)
    validate_service_worker_shell(root, errors)

    raise_errors(errors)


def validate_webmanifest(root: Path, errors: list[str]) -> None:
    data = read_json(root / "manifest.webmanifest", errors)
    if not isinstance(data, dict):
        return
    for index, icon in enumerate(data.get("icons", [])):
        if not isinstance(icon, dict):
            errors.append(f"manifest.webmanifest icons[{index}]: must be an object.")
            continue
        src = icon.get("src")
        if isinstance(src, str) and src and not is_external_or_absolute(src):
            if not (root / src).is_file():
                errors.append(f"manifest.webmanifest icons[{index}]: missing {src}.")


def validate_service_worker_shell(root: Path, errors: list[str]) -> None:
    for asset in parse_sw_shell(root / "sw.js", errors):
        if asset == "./":
            continue
        if not (root / asset).is_file():
            errors.append(f"sw.js SHELL: missing {asset}.")


def build_dist(root: Path, dist: Path) -> None:
    if dist.exists():
        shutil.rmtree(dist)
    dist.mkdir(parents=True)

    for rel in DEPLOY_PATHS:
        src = root / rel
        dst = dist / rel
        if not src.exists():
            continue
        if src.is_dir():
            shutil.copytree(src, dst, ignore=ignore_release_noise)
        else:
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(src, dst)

    write_versioned_service_worker(root, dist)
    compact_files(root, dist)
    validate_generated_js(dist)


def ignore_release_noise(_dir: str, names: list[str]) -> set[str]:
    ignored = {"__pycache__", ".DS_Store"}
    return {name for name in names if name in ignored or name.endswith(".pyc")}


def compact_files(root: Path, dist: Path) -> None:
    helper = root / "tools" / "minify_release.mjs"
    if not helper.is_file():
        raise BuildError("Missing tools/minify_release.mjs.")

    result = subprocess.run(
        ["node", str(helper), str(dist)],
        cwd=root,
        text=True,
        capture_output=True,
        check=False,
    )
    if result.returncode != 0:
        details = result.stderr.strip() or result.stdout.strip()
        raise BuildError(
            "Release minification failed. Run `npm install` and retry."
            + (f"\n{details}" if details else "")
        )


def write_versioned_service_worker(root: Path, dist: Path) -> None:
    source_sw = root / "sw.js"
    dist_sw = dist / "sw.js"
    sw_text = source_sw.read_text(encoding="utf-8")
    version = compute_shell_version(dist, sw_text)
    sw_text = re.sub(
        r"const\s+VERSION\s*=\s*['\"][^'\"]+['\"]\s*;",
        f"const VERSION = '{version}';",
        sw_text,
        count=1,
    )
    dist_sw.write_text(sw_text, encoding="utf-8")


def compute_shell_version(dist: Path, sw_text: str) -> str:
    digest = hashlib.sha256()
    digest.update(re.sub(r"const\s+VERSION\s*=\s*['\"][^'\"]+['\"]\s*;", "", sw_text).encode("utf-8"))
    for rel in parse_sw_shell(dist / "sw.js", []):
        if rel == "./":
            continue
        path = dist / rel
        if path.is_file():
            digest.update(rel.encode("utf-8"))
            digest.update(path.read_bytes())
    return "v" + digest.hexdigest()[:12]


def parse_sw_shell(path: Path, errors: list[str]) -> list[str]:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        errors.append(f"{path.relative_to(ROOT)}: {exc}")
        return []

    match = re.search(r"const\s+SHELL\s*=\s*(\[[\s\S]*?\])\s*;", text)
    if not match:
        errors.append("sw.js: could not find const SHELL = [...].")
        return []

    try:
        shell = ast.literal_eval(match.group(1))
    except (SyntaxError, ValueError) as exc:
        errors.append(f"sw.js: SHELL must contain only string literals ({exc}).")
        return []

    if not isinstance(shell, list) or not all(isinstance(item, str) for item in shell):
        errors.append("sw.js: SHELL must be an array of strings.")
        return []
    return shell


def read_json(path: Path, errors: list[str]):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except OSError as exc:
        errors.append(f"{path.relative_to(ROOT)}: {exc}")
    except json.JSONDecodeError as exc:
        errors.append(f"{path.relative_to(ROOT)}: invalid JSON at line {exc.lineno}, column {exc.colno}.")
    return None


def is_external_or_absolute(value: str) -> bool:
    return bool(re.match(r"^(?:https?:)?//", value)) or value.startswith(("/", "data:", "blob:"))


def validate_generated_js(dist: Path) -> None:
    node = shutil.which("node")
    if not node:
        return

    errors: list[str] = []
    for path in [dist / "sw.js", *(dist / "js").glob("*.js")]:
        result = subprocess.run(
            [node, "--check", str(path)],
            cwd=dist,
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode != 0:
            errors.append(result.stderr.strip() or result.stdout.strip())

    if errors:
        raise BuildError("Generated JavaScript failed syntax checks:\n- " + "\n- ".join(errors))


def raise_errors(errors: list[str]) -> None:
    if errors:
        raise BuildError("Validation failed:\n- " + "\n- ".join(errors))


if __name__ == "__main__":
    try:
        main()
    except BuildError as exc:
        raise SystemExit(str(exc))
