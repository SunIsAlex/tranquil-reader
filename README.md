# 静读 · 静态小说阅读站

一个零外部依赖、可完全自托管的静态小说阅读 Web 项目。界面走 Claude 网页那种克制的简约路线：温暖中性配色、舒适的衬线正文、充足留白。

## 项目结构

```
novel-reader/
├── index.html              书架首页
├── reader.html             阅读页
├── sw.js                   Service Worker（离线缓存）
├── manifest.webmanifest    PWA 清单（可安装）
├── css/
│   └── style.css           全部样式（含深浅色、响应式）
├── js/
│   ├── common.js           主题、localStorage、离线下载封装（两页共用）
│   ├── shelf.js            书架逻辑
│   └── reader.js           阅读器逻辑
├── icons/                  PWA 图标
└── books/
    ├── manifest.json       书目清单（在这里登记每本书）
    └── demo/               示例书（每章一个 .txt）
        ├── ch1.txt
        └── ch2.txt
```

## 特性

- **零外部依赖**：没有引入任何 CDN、字体库或框架，纯 HTML/CSS/原生 JS。
- **阅读进度**：用 `localStorage` 记住每本书读到第几章、读到哪一段、字号、主题。换章节、调字号都会自动定位，进度不漂移。
- **分段进度条（bilibili 式）**：顶部进度条按章内段落分段，每段宽度正比于该段文字数，读到第几段就点亮到第几段。进度以段落为单位、与字号无关，调字号时不会跳动。
- **离线下载**：可把整本书缓存到本地，无网络也能完整阅读（见下文「离线下载」，需安全上下文）。
- **较新的 Web 特性**：`backdrop-filter` 毛玻璃顶栏、`color-mix()`、`100dvh`、`prefers-color-scheme`、`prefers-reduced-motion`、`scroll-behavior`、Service Worker + Cache API。
- **简约交互**：目录抽屉、字号调节、深浅色切换、键盘左右翻章。

## 运行

因为用到了 `fetch()` 读取 json/txt，**不能直接双击打开 HTML**，需要一个本地服务器：

```bash
cd novel-reader
python3 -m http.server 8000
# 浏览器打开 http://localhost:8000
```

部署时把整个文件夹丢到任何静态托管（GitHub Pages / Vercel / Nginx / 自己的服务器）即可。

## 离线下载

站点是一个 PWA：`sw.js` 会预缓存应用外壳，读过的书目/正文也会被运行时缓存。在此基础上，书架每张书卡都有一个**离线按钮**，可把整本书（书目清单 + 全部章节）一次性下载到本地的持久缓存，之后**断网也能完整阅读**，而不必先逐章读过。

- 按钮状态：`⬇ 离线` → `下载中 X%` → `✓ 已离线`（再次点击可移除该书缓存）。
- 下载的内容存在一个独立的持久缓存里，**不随版本升级被清掉**，直到你手动移除。
- 与运行时缓存解耦：移除某本书的下载不会影响其它书，共享的书目清单也会保留。

### 须知：需要「安全上下文」

离线相关能力（Service Worker、Cache API）**只有在安全上下文（secure context）下才可用**。不满足时，离线按钮会**自动隐藏**（`Offline.supported()` 返回 `false`）。安全上下文指：

| 访问方式 | 安全上下文？ | 离线下载 |
|---|---|---|
| `https://你的域名`（线上 / GitHub Pages 等） | ✅ | 可用 |
| `http://localhost` / `127.0.0.1` / `[::1]` | ✅ | 可用 |
| `http://192.168.x.x:8000`（局域网 IP） | ❌ | 不可用 |
| `file:///…/index.html`（直接双击打开） | ❌ | 不可用 |

也就是说：

- **本机调试**请用 `http://localhost:8000`，而不是局域网 IP。
- **手机调试**：手机访问电脑只能走局域网 IP，对手机不是安全上下文。可用 Chrome 的 USB 端口转发（`chrome://inspect` → Port forwarding，让手机用 `http://localhost:8000` 访问），或用 `ngrok` / `cloudflared` 之类隧道拿到 `https://` 地址。
- **正式部署是 HTTPS，功能本就正常**——本地明文 IP 下不可用属预期，并非 bug。

> 改动了应用外壳（HTML/CSS/JS）后，把 `sw.js` 里的 `VERSION` 加一，即可让旧的外壳缓存失效；用户已离线下载的书不受影响。

### Android App（TWA）

仓库内附带一个 TWA 安卓应用安装包 `app/latest.apk`（Digital Asset Links 见 `.well-known/assetlinks.json`）。当访客用**安卓浏览器**打开书架、且不在已安装的 App / 独立窗口内时，页面顶部会出现一张可关闭的推荐卡，点击即可下载该 APK；关闭后记在 `localStorage`，不再打扰。判断逻辑在 `common.js` 的 `AppPromo`。

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

## 无章节标记的大 TXT：按长度自动切分

如果整本书没有"第X章"这类标记，用 `tools/split_by_length.py`，它会按段落边界切成 Part 1、Part 2……并**自动写入 manifest.json**：

```bash
# 在项目根目录运行
python3 tools/split_by_length.py whole.txt --id mybook --title 书名 --author 作者
```

可选参数：

```bash
--chars 8000              # 每部分目标字数，默认 8000
--part-label "第 {n} 部分"  # 分部标题模板，默认 "Part {n}"
--root .                  # 项目根目录（含 books/ 的那层）
```

它处理了几个容易踩的坑：

- **绝不在段落中间切断**；达到目标字数 60% 之后若遇到 `* * *` 这类场景分隔线，会优先在那里断开，断点更自然；末尾的残段太短会并入前一部分。
- **编码自动识别**：UTF-8 / GB18030(GBK) / Big5。
- **格式归一**：无论原文是"空行分段"还是网络 TXT 常见的"一行一段"，输出统一为空行分段——这是阅读器渲染段落的依据。
- **幂等**：同 `--id` 重复运行会清掉旧分卷、替换 manifest 里的旧条目（并保留你手工加过的 `highlights` 等字段），不会越跑越多。

