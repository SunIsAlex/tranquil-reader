# Tranquil Reader / 静读

一个轻量、离线优先、移动端友好的静态小说阅读器。

项目使用原生 HTML / CSS / JavaScript 实现，不需要构建工具，适合部署到 GitHub Pages、Cloudflare Pages、静态服务器，或打包成 Android TWA。

## 主要特性

### 书架

- 通过 `books/manifest.json` 动态加载书籍
- 支持书名、作者、章节列表、封面、缩略封面、高亮文件
- 书架显示阅读进度
- 支持书籍封面：
  - 书架使用轻量 `coverThumb`
  - 点击封面会在新标签页打开完整 `cover`
  - 点击书名 / 文本区域进入阅读器
- Android 浏览器内可显示 App 下载提示
- TWA / PWA 内自动隐藏 App 下载提示

### 阅读器

- 按章节阅读
- 自动保存阅读进度
- 支持章节、段落、滚动位置恢复
- TWA / PWA 冷启动时自动回到上次阅读位置
- 支持上一章 / 下一章
- 顶部进度条
- 段落级阅读进度
- 支持两类 TXT 段落格式：
  - 空行分段
  - 中文缩进分段但无空行
- 顶部菜单固定在浏览器 / TWA 视口顶部
- 顶部菜单自动隐藏：
  - 上划 / 向下滚动时隐藏
  - 下划 / 向上滚动时显示
- 移动端布局针对 Android Chrome / WebView 优化

### 目录

- 右侧滑出式目录
- 当前章节高亮
- 支持键盘和无障碍焦点管理
- `Escape` 关闭目录
- Android / 浏览器返回键优先关闭目录，而不是直接退出阅读页
- 移动端右滑关闭目录
- 长章节标题自动换行
- 抽屉宽度限制在视口内，避免撑宽页面

### 书签和笔记

- 支持添加书签
- 每本书独立保存书签
- 书签抽屉
- 点击书签快速跳转到对应段落
- 返回键优先关闭书签抽屉
- 数据存储在本地浏览器中

### 高亮系统

高亮数据不再直接写进 `books/manifest.json`。

每本书可以在自己的目录下放置独立的 `highlights.json`：

```text
books/
  <book-id>/
    highlights.json
```

推荐在 `manifest.json` 中这样引用：

```json
{
  "id": "chaoxinxingjiyuan",
  "title": "超新星纪元",
  "author": "刘慈欣",
  "cover": "cover.png",
  "coverThumb": "cover-thumb.webp",
  "highlightsFile": "highlights.json",
  "chapters": [
    {
      "title": "引子",
      "file": "001_引子.txt"
    }
  ]
}
```

推荐的 `highlights.json` 格式：

```json
{
  "highlights": {
    "人名": [],
    "地名": [],
    "组织/机构": [],
    "专有名词": [],
    "科技/设定": [],
    "重要概念": []
  },
  "perChapter": {
    "001_引子.txt": {
      "人名": [],
      "地名": [],
      "组织/机构": [],
      "专有名词": [],
      "科技/设定": [],
      "重要概念": []
    }
  }
}
```

说明：

- `highlights`：全书通用高亮词
- `perChapter`：章节专属高亮词
- `perChapter` 的 key 推荐使用章节文件名
- 阅读器渲染时会自动合并全书高亮和当前章节高亮
- 旧版 manifest 内联高亮仍可兼容，但新书建议统一使用外部 `highlights.json`

## 项目结构

```text
novel-reader/
├── index.html
├── reader.html
├── manifest.webmanifest
├── sw.js
├── favicon.png
│
├── css/
│   └── style.css
│
├── js/
│   ├── common.js
│   ├── shelf.js
│   └── reader.js
│
├── books/
│   ├── manifest.json
│   │
│   ├── demo/
│   │   ├── ch1.txt
│   │   └── ch2.txt
│   │
│   ├── shanyangrenlei/
│   │   ├── part1.txt
│   │   ├── part2.txt
│   │   ├── part3.txt
│   │   ├── part4.txt
│   │   ├── cover.png
│   │   ├── cover-thumb.webp
│   │   └── highlights.json
│   │
│   ├── zhongguo2185/
│   │   ├── ch1.txt
│   │   ├── ch2.txt
│   │   ├── ...
│   │   ├── cover.png
│   │   ├── cover-thumb.webp
│   │   └── highlights.json
│   │
│   └── chaoxinxingjiyuan/
│       ├── 001_引子.txt
│       ├── 002_死星 - 一、超新星.txt
│       ├── ...
│       ├── cover.png
│       ├── cover-thumb.webp
│       └── highlights.json
│
├── tools/
│   ├── split_by_length.py
│   ├── split_by_index.py
│   ├── split_by_deepseek.py
│   ├── generate_highlights_deepseek.py
│   ├── make_cover_thumb.py
│   ├── import_hongloumeng_wikisource.py
│   ├── convert_book_to_simplified.py
│   └── build_release.py
│
└── app/
    └── latest.apk
```

## 书籍清单格式

`books/manifest.json` 是书架索引文件。

它只应该保存书籍基本信息和章节列表。封面、高亮、正文等资源应放在对应书籍目录中。

示例：

```json
{
  "books": [
    {
      "id": "chaoxinxingjiyuan",
      "title": "超新星纪元",
      "author": "刘慈欣",
      "cover": "cover.png",
      "coverThumb": "cover-thumb.webp",
      "highlightsFile": "highlights.json",
      "chapters": [
        {
          "title": "引子",
          "file": "001_引子.txt"
        },
        {
          "title": "死星 - 一、超新星",
          "file": "002_死星 - 一、超新星.txt"
        }
      ]
    }
  ]
}
```

字段说明：

| 字段 | 说明 |
| --- | --- |
| `id` | 书籍目录名，对应 `books/<id>/` |
| `title` | 书名 |
| `author` | 作者 |
| `cover` | 完整封面图 |
| `coverThumb` | 书架缩略封面 |
| `highlightsFile` | 外部高亮 JSON 文件 |
| `chapters` | 章节列表 |

## 添加一本新书

1. 创建书籍目录：

```text
books/<book-id>/
```

2. 放入章节文件：

```text
books/<book-id>/001_第一章.txt
books/<book-id>/002_第二章.txt
```

3. 可选：放入封面：

```text
books/<book-id>/cover.png
books/<book-id>/cover-thumb.webp
```

4. 可选：放入高亮文件：

```text
books/<book-id>/highlights.json
```

5. 在 `books/manifest.json` 中注册：

```json
{
  "id": "book-id",
  "title": "书名",
  "author": "作者",
  "cover": "cover.png",
  "coverThumb": "cover-thumb.webp",
  "highlightsFile": "highlights.json",
  "chapters": [
    {
      "title": "第一章",
      "file": "001_第一章.txt"
    }
  ]
}
```

如果没有封面或高亮，可以省略对应字段。

## 封面和缩略图

推荐每本书使用：

```text
books/<book-id>/
  cover.png
  cover-thumb.webp
```

对应 manifest 字段：

```json
{
  "cover": "cover.png",
  "coverThumb": "cover-thumb.webp"
}
```

书架只加载 `coverThumb`，减少流量和首屏压力。

完整封面只会在用户点击封面时打开。

生成缩略图：

```bash
python3 tools/make_cover_thumb.py books/<book-id>/cover.png
```

默认输出：

```text
books/<book-id>/cover-thumb.webp
```

## 离线支持

Service Worker 提供离线阅读能力。

缓存策略：

| 资源 | 策略 |
| --- | --- |
| App shell | 预缓存 |
| `books/*.json` | network-first |
| 章节 `.txt` | stale-while-revalidate |
| 封面缩略图 | 离线下载时缓存 |
| 手动离线下载的书 | 独立书籍缓存 |

说明：

- 书籍 JSON 使用 network-first，避免书架和高亮长期显示旧数据
- 章节正文使用 stale-while-revalidate，读过的章节可以离线重读
- 手动离线下载的书保存在独立缓存中，版本升级时不会被清除

## PWA / TWA 行为

项目支持作为 PWA 安装，也支持作为 Android TWA 打包。

当前行为：

- 检测 standalone / TWA 运行环境
- App 内隐藏下载 App 横幅
- 冷启动时自动恢复上次阅读位置
- Android 返回键优先关闭目录 / 书签面板
- Service Worker 提供离线缓存
- 顶部菜单固定在 TWA 视口顶部

## 本地开发

启动本地静态服务器：

```bash
python -m http.server 8000
```

然后打开：

```text
http://localhost:8000/
```

不要直接双击打开 `index.html`，因为 `fetch`、Service Worker 和部分浏览器 API 需要 HTTP / HTTPS 环境。

## 发布构建

源码保持无构建步骤，方便直接调试。发布时可以生成压缩后的静态目录：

```bash
npm install
python3 tools/build_release.py
```

也可以使用 npm 脚本：

```bash
npm run build
```

默认输出：

```text
dist/
```

构建脚本会：

- 校验 `books/manifest.json` 中引用的书籍目录、章节、封面和高亮文件
- 校验 `manifest.webmanifest` 图标和 `sw.js` 预缓存资源是否存在
- 复制可部署资源到 `dist/`
- 使用 `html-minifier-terser` 压缩 HTML 并删除注释
- 使用 `clean-css` 压缩 CSS 并删除注释
- 使用 `terser` 压缩 JavaScript、删除注释、压缩表达式并缩短局部变量名
- 使用 Node.js 检查生成后的 JavaScript 语法
- 根据发布目录中的应用外壳文件内容，为 `dist/sw.js` 自动生成缓存版本号

说明：页面脚本分多个 `<script>` 加载，共享 `Store`、`Offline`、`Theme` 等全局对象。构建脚本会保留这些跨文件全局名称，只压缩局部变量；独立运行的 `sw.js` 会使用更激进的顶层变量压缩。

只做校验、不生成 `dist/`：

```bash
python3 tools/build_release.py --validate-only
```

### Service Worker 缓存版本

开发版 `sw.js` 里有手动版本号：

```js
const VERSION = 'v18';
```

发布构建不会修改源码里的这个值，而是只改写 `dist/sw.js`。脚本会读取 `sw.js` 里的 `SHELL` 列表，把发布目录中这些文件的内容一起计算成短哈希，例如：

```js
const VERSION = 'v3722a203d648';
```

构建后该常量可能会被 Terser 进一步压缩成短变量名，但版本字符串仍会进入 `tranquil-shell-<version>` 和 `tranquil-runtime-<version>` 缓存名。浏览器安装新 Service Worker 后，会打开新的 shell/runtime 缓存；`activate` 阶段会删除旧版本 shell/runtime 缓存，但保留不带版本号的 `tranquil-books`，因此用户手动离线下载的书不会因为应用升级被清掉。

## 工具脚本

### 按长度拆分 TXT

```bash
python3 tools/split_by_length.py
```

### 按目录索引拆分 TXT

```bash
python3 tools/split_by_index.py
```

### 使用 DeepSeek 辅助拆分章节

```bash
export DEEPSEEK_API_KEY="sk-..."

python3 tools/split_by_deepseek.py \
  --input raw_books/example.txt \
  --id example-book \
  --title "示例书" \
  --author "作者" \
  --out-dir books/example-book \
  --manifest-snippet books/example-book/manifest.snippet.json
```

### 使用 DeepSeek 生成高亮

```bash
export DEEPSEEK_API_KEY="sk-..."

python3 tools/generate_highlights_deepseek.py \
  --book-dir books/chaoxinxingjiyuan
```

默认输出：

```text
books/chaoxinxingjiyuan/highlights.json
```

该脚本直接调用 OpenAI-compatible REST API，不依赖 OpenAI Python SDK。

DeepSeek thinking mode 会在请求中显式关闭。

### 生成封面缩略图

```bash
python3 tools/make_cover_thumb.py books/<book-id>/cover.png
```

### 从维基文库导入《红楼梦》

该工具会从维基文库抓取《红楼梦》120 回，写入 `books/<id>/`，并更新 `books/manifest.json`。

```bash
python3 tools/import_hongloumeng_wikisource.py \
  --id hongloumeng \
  --delay 0.5
```

可选：将指定书籍正文和目录标题转换为简体中文：

```bash
python3 tools/convert_book_to_simplified.py hongloumeng
```

导入或转换书籍前，请确认文本来源和使用方式符合对应来源的授权条款。

## 许可和内容来源

项目代码、构建脚本、样式和页面结构按 `LICENSE` 中的 MIT License 授权。

书籍正文、封面图片、生成的高亮数据、`app/latest.apk` 以及从第三方来源导入的内容不自动包含在代码许可中。添加或发布书籍资源时，应在对应书籍目录或提交说明中保留来源、作者、授权方式和必要的署名信息。

建议每本书至少记录：

- 正文来源 URL 或本地来源说明
- 作者、译者、整理者等署名信息
- 授权许可或公有领域状态
- 封面图片来源和授权
- 导入或转换脚本及处理日期

## 本地存储

浏览器本地使用 `localStorage` 保存轻量状态：

| 数据 | 用途 |
| --- | --- |
| `reader.progress.<bookId>` | 每本书的阅读进度 |
| `reader.lastProgress` | 最近一次阅读位置 |
| `reader.fontSize` | 字号偏好 |
| `reader.theme` | 主题偏好 |
| 书签数据 | 每本书的书签和笔记 |

正文、封面缩略图、离线书籍等资源使用 Cache API 保存。

## 浏览器支持

推荐环境：

- Android Chrome
- Chromium-based browsers
- Android TWA
- 现代桌面浏览器

项目依赖：

- Fetch API
- Cache API
- Service Worker
- LocalStorage
- History API
- modern CSS

## 设计原则

> 阅读时界面应该消失，需要时又能立即回来。

因此项目倾向于：

- 静态架构
- 无构建步骤
- 本地优先
- 离线可用
- 移动端手势优先
- 快速恢复阅读
- 书籍资源外置
- 每本书独立扩展

## 未来计划

可能的后续方向：

- 预生成搜索索引
- AI 章节总结
- 人物 / 概念卡片
- 时间线视图
- 阅读统计
- 多设备同步
- EPUB 导入
- TTS 听书模式
- 用户自定义高亮
- 书签和笔记备份
