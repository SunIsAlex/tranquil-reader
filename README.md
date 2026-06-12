# 静读 · 静态小说阅读站

一个零外部依赖、可完全自托管的静态小说阅读 Web 项目。界面走 Claude 网页那种克制的简约路线：温暖中性配色、舒适的衬线正文、充足留白。

## 项目结构

```
novel-reader/
├── index.html          书架首页
├── reader.html         阅读页
├── css/
│   └── style.css       全部样式（含深浅色、响应式）
├── js/
│   ├── common.js       主题切换 + localStorage 封装（两页共用）
│   ├── shelf.js        书架逻辑
│   └── reader.js       阅读器逻辑
└── books/
    ├── manifest.json   书目清单（在这里登记每本书）
    └── demo/           示例书（每章一个 .txt）
        ├── ch1.txt
        └── ch2.txt
```

## 特性

- **零外部依赖**：没有引入任何 CDN、字体库或框架，纯 HTML/CSS/原生 JS，可离线运行。
- **阅读进度**：用 `localStorage` 记住每本书读到第几章、滚动到哪、字号、主题。换章节自动定位。
- **较新的 Web 特性**：`backdrop-filter` 毛玻璃顶栏、`color-mix()`、`100dvh`、`prefers-color-scheme`、`prefers-reduced-motion`、`scroll-behavior`。
- **简约交互**：目录抽屉、字号调节、深浅色切换、键盘左右翻章、顶部阅读进度条。

## 运行

因为用到了 `fetch()` 读取 json/txt，**不能直接双击打开 HTML**，需要一个本地服务器：

```bash
cd novel-reader
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

部署时把整个文件夹丢到任何静态托管（GitHub Pages / Vercel / Nginx / 自己的服务器）即可。

## 如何添加一本书

两步：

**1. 放正文。** 在 `books/` 下新建一个以书 id 命名的文件夹，每章存成一个 `.txt`：

```
books/santi/
├── ch1.txt
├── ch2.txt
└── ...
```

`.txt` 就是纯文本。空一行分段，开头自动缩进两格。单独一行写 `* * *` 或 `---` 会渲染成场景分隔线。

**2. 登记。** 在 `books/manifest.json` 的 `books` 数组里加一项：

```json
{
  "id": "santi",
  "title": "三体",
  "author": "刘慈欣",
  "chapters": [
    { "title": "第一章 · 科学边界", "file": "ch1.txt" },
    { "title": "第二章 · 台球",     "file": "ch2.txt" }
  ]
}
```

`id` 要和文件夹名一致；`file` 要和 txt 文件名一致。刷新书架就能看到。

## 词语标注（自动高亮）

每本书可以在 manifest 里加一个可选的 `highlights` 字段，按类别声明词表，阅读器会在正文中自动标注这些词：

```json
{
  "id": "santi",
  "title": "三体",
  "author": "刘慈欣",
  "highlights": {
    "人名":     ["叶文洁", "汪淼", "史强"],
    "专有名词": ["三体", "智子", "红岸基地"],
    "组织":     ["地球三体组织"]
  },
  "chapters": [ ... ]
}
```

规则与行为：

- **类别任意命名**，按声明顺序循环使用 5 种标注配色（浅底色 + 同色细下划线），深浅色模式各有一套。
- **悬停显示类别名**（`<mark title="人名">`）。
- **长词优先匹配**：词表里同时有「哥哥」和「哥哥星球」时，「哥哥星球」不会被截断成「哥哥」+「星球」。
- 匹配在 HTML 转义之后进行，词条含 `&`、`+` 等字符也安全。
- 顶栏「标注」按钮可随时开关，状态记在 localStorage；没配词表的书不显示该按钮。


## 一段小脚本：把一整个 txt 切成章节

如果你手上是一整本未分章的 `whole.txt`，可以用这个脚本按"第X章"自动切分并生成 manifest 片段：

```python
# split_book.py
import re, os, json, sys

book_id = "santi"
title   = "三体"
author  = "刘慈欣"
src     = "whole.txt"

os.makedirs(f"books/{book_id}", exist_ok=True)
text = open(src, encoding="utf-8").read()

# 按“第N章”切分（按需改正则）
parts = re.split(r'\n(?=第[零一二三四五六七八九十百千\d]+章)', text)
chapters = []
for i, part in enumerate(parts, 1):
    part = part.strip()
    if not part:
        continue
    head = part.splitlines()[0][:30]
    fname = f"ch{i}.txt"
    with open(f"books/{book_id}/{fname}", "w", encoding="utf-8") as f:
        f.write(part)
    chapters.append({"title": head, "file": fname})

print(json.dumps(
    {"id": book_id, "title": title, "author": author, "chapters": chapters},
    ensure_ascii=False, indent=2))
```

运行 `python3 split_book.py`，把打印出的 JSON 粘进 `manifest.json` 即可。
