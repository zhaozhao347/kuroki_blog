# new_blog

个人博客前端。**Vue 3 + TypeScript + Vite**，纯静态站（无后端）。
视觉方向：深蓝 `#0631BB` + 米色，Persona 3 的气质 —— 单色、锐利、克制。

## 快速开始

```bash
npm install
npm run dev      # 开发，http://localhost:5173
npm run build    # 类型检查 + 生产构建（输出 dist/）
npm run preview  # 预览构建产物

npm run typecheck            # 只做类型检查
```

## 写文章 —— 全流程

文章就是 `content/posts/` 下的 **Markdown 文件**。没有后台、没有数据库。

### 1. 新建

在 `content/posts/` 里建一个文件，文件名格式 `YYYY-MM-DD-slug.md`：

```
content/posts/2026-09-22-understanding-css-cascade.md
```

- 日期前缀用于排序（插件会去掉它得到 slug）
- `slug` 就是 URL 最后一段：`/articles/understanding-css-cascade`
- ★ **用英文写 slug**（中文会变成一串 `%E7%90%86` 的转义，难读也难分享）

然后按下面的约定写 frontmatter 即可。

### 2. 写 frontmatter

```markdown
---
title: 理解 CSS 层叠上下文 # 必填
date: 2026-09-20 #       必填，必须 YYYY-MM-DD
category: 前端工程 #      必填，用于列表页筛选
summary: 一句话摘要。 #     必填，列表页卡片 + 详情页开头
cover: pic.png #         可选，省略时按日期自动挑一张
                              （不写路径就用 content/posts/assets/pic.png）
---

正文从这里开始，支持完整 Markdown。

![插图](pic.png)
```

★ **没有「草稿」概念**：md 一旦放进 `content/posts/`，下一次构建就会发布它。
不想发就先别放进去（或先放在仓库目录外面）。

⚠️ **必填字段缺一个、或日期格式不对，`npm run build` 就会失败。**
这是有意的：CI 会因此红掉，坏数据不会上线。
开发时不会崩服务 —— 那篇会被跳过，并在 `/articles` 页面顶部提示。

### 3. 插图放哪儿

文章图片统一放在 **`content/posts/assets/`**：

```
content/posts/
├─ 2026-09-20-hello.md
└─ assets/
   ├─ pic.png
   └─ cover.avif
```

md 里就写文件名（相对 `assets/`）：

```markdown
cover: pic.png          # frontmatter 里的封面

![插图](pic.png)         # 正文里的图
```

这几种写法都认：`pic.png`、`assets/pic.png`、`works/你的封面.avif`
（后者指向 `src/assets/works/` 里的通用作品图）。

★★ **不要把图片放进 `public/`，也不要写 `src="/works/…"` 这类绝对路径。**
`src/assets/` 下的图是打包器资源 —— 构建后文件名带 hash，
还会自动加 GitHub Pages 的仓库前缀。当成普通 URL 字符串用会在线上白板，
而且**一声不响**（连 error 事件都没有）。走上面这套写法，插件会帮你解析。

图片名字写错时：开发环境那篇会被跳过并在页面顶部提示，
`npm run build` 直接报错（和 frontmatter 同一套标准）。

### 4. 本地预览

```bash
npm run dev
```

打开 `http://localhost:5173/articles`。改 md 保存后页面自动刷新。

### 5. 发布

```bash
git add content/posts/
git commit -m "post: 理解 CSS 层叠上下文"
git push
```

推送后 GitHub Actions 会自动 **类型检查 → 构建 → 部署到 Pages**。
构建通过即上线（约 1 分钟）。

> 首次部署前需要在仓库 **Settings → Pages → Source** 选 **GitHub Actions**。

### 文章是怎么变成页面的

```
content/posts/*.md
content/projects/*.md
content/pages/*.md
      │
      │  content-kit.ts（构建期；文章、项目、页面共用这一份实现）
      │  · 解析 frontmatter + 校验
      │  · 解析图片引用（cover / 正文插图）→ 生成 URL 表
      │  · 生成索引（标题/日期/标签/摘要，不含正文）
      ▼
  virtual:posts         →  src/posts.ts    →  ArticleListView / ArchiveView
  virtual:posts-map     →  正文按需懒加载  →  ArticleDetailView
  virtual:projects      →  src/projects.ts →  ProjectListView
  virtual:projects-map  →  正文按需懒加载  →  ProjectDetailView
  virtual:pages         →  src/pages.ts    →  AboutView
  virtual:pages-map     →  正文按需懒加载  →  AboutView 的正文
```

- **索引**很小（gzip 约 1.5KB），首屏只加载它
- **正文**每篇一个独立 chunk，点进某篇才下载
- 排序、分类统计、上下篇、相关阅读都在构建期算好，运行时零计算
- **图片**走 `import.meta.glob(..., { query: '?url' })` 拿打包后的真实 URL

加文章**不需要改任何 `.vue`** —— 列表、归档、上下篇、标签计数全自动跟随。

**项目**同理：`content/projects/` 里丢一个 md，列表多一张卡、`/projects/<slug>` 详情页
自动生成。字段：`title` / `date` / `summary` 必填，`tags` / `role` / `link` / `cover` 可选；
加完跑 `npm run check:projects` 体检。

**「关于」页**也是同一套：整个页面由 `content/pages/about.md` 一篇 md 驱动 ——
正文是 Markdown，头像用 `cover`（这里复用为头像），卡片上的名字/签名是 `name` / `tagline`，
社交按钮是 `links`（`label` / `href` / `icon`，href 只接受 `http(s)://`）。
改文案只碰这个文件，跑 `npm run check:pages` 体检。

## 目录结构

```
content/posts/             # 文章（Markdown + frontmatter）★ 写作只碰这里
content/projects/          # 项目（同一套引擎）★ 加项目只碰这里
content/pages/             # 独立页面（目前只有 about）★ 改「关于」只碰这里
content-kit.ts             # ★ 内容引擎：扫描 / 校验 / 图片解析 / 虚拟模块（三个集合共用）
vite-plugin-posts.ts       # 文章集合的 spec（规则全在 content-kit.ts）
vite-plugin-projects.ts    # 项目集合的 spec
vite-plugin-pages.ts       # 页面集合的 spec（同上）
.github/workflows/         # CI/CD（构建 + 部署 Pages）
.env.example               # 环境变量样板（三个端点：VITE_VIEWS_ENDPOINT / VITE_MUSIC_ENDPOINT / VITE_STEAM_ENDPOINT；不配就不发请求）
docs/reports/              # 每轮改动的对照图（与构建无关，不进 dist）；2026-10-08 历史图已清空

src/
├─ posts.ts                # 文章门面层：视图只 import 它
├─ projects.ts             # 项目门面层：视图只 import 它
├─ pages.ts                # 页面门面层：视图只 import 它（「关于」的数据源）
├─ playlist.ts             # 曲目清单（唯一真相源：网易云 id + 手写元数据 + 端点拼 URL）
├─ lyrics/                 # 歌词 `*.lrc`（文件名 = playlist.ts 的 slug；懒加载，每首一个独立 chunk）
├─ assets/works/           # 通用作品图池（avif；项目 md 的 cover 可引用，只有被引用的才进 dist）
├─ components/
│  ├─ AppLoader.vue        # 首屏载入动画（同一会话只播一次）
│  ├─ InitialLetter.vue    # 巨型字母 SVG（Blog 的 B）
│  ├─ LiquidTransition.vue # 液态玻璃转场遮罩（App.vue 里独立的一层 fixed）
│  ├─ MarkdownRenderer.vue # markdown → 主题化 HTML（已做 XSS 加固）
│  ├─ MusicBar.vue         # 音乐栏（走带键 + 细轨进度 + 曲目抽屉 + 断点续播；曲目来自网易云，见 DEVELOPMENT.md §5.6）
│  ├─ MusicBall.vue        # 音乐球（非首页的右下浮动球 + 面板：环状进度 + 走带键 + 曲目列表；见 DEVELOPMENT.md §5.6）
│  ├─ LyricStage.vue       # 歌词层（hero 上三句：上一句右上 / 当前句正中 / 下一句左下）
│  ├─ SteamCard.vue        # 「关于」页右栏的 Steam「最近在玩」卡（没配端点就不渲染）
│  ├─ SiteStats.vue        # 「关于」页侧栏的站点统计卡（文章 / 标签 / 总字数 / 浏览量）
│  ├─ NextButton.vue       # 「N ext」翻页按钮（各页共用）
│  ├─ SoundLine.vue        # 音频可视化横线（兼画 hero 渐变与线下填充）
│  └─ WaterBody.vue        # hero 线以下的水体（鼠标交互；原 HeroStage 3D 舞台已删）
├─ composables/
│  ├─ lofi.ts              # 音频可视化状态（波形来自 player 的 analyser）+ 渲染器工厂
│  ├─ siteViews.ts         # 站点浏览量（PV）：POST 计一次 / GET 读总数（端点由 VITE_VIEWS_ENDPOINT 注入）
│  ├─ steam.ts             # Steam「最近在玩」（workers/api/ 的 /steam；没配端点就不渲染那张卡）
│  ├─ lyrics.ts            # 歌词同步：当前播放位置 → 上一句 / 当前句 / 下一句
│  ├─ beat.ts              # 节拍包络（频谱能量 + 谱通量 → 0~1，供 hero 逐字律动用）
│  ├─ floatText.ts         # hero 逐字「浮水」：拆字 / 还原 / 每帧只写 3 个 CSS 变量
│  ├─ boot.ts              # 启动闸门：LoadApp 预热与水体初始化互相让步（都带超时兜底）
│  ├─ tagFilter.ts         # 标签筛选（列表页 / 归档页共用）
│  ├─ typewriter.ts        # 格言打字机（逐字出现 + 光标淡出；reduced-motion 直接给全文）
│  └─ motion.ts            # 动效基础设施（Lenis 单例、reduced-motion、启动信号）
├─ directives/
│  ├─ magnetic.ts          # v-magnetic 鼠标磁性偏移
│  ├─ reveal.ts            # v-reveal 滚动进场（motion 驱动）
│  └─ imgFallback.ts       # v-img-fallback 坏图兜底（.is-broken / .has-broken-img）
├─ layouts/DefaultLayout.vue  # 顶栏 + main + 页脚（含毛玻璃重叠检测、视图过渡）
├─ router/index.ts
├─ views/                  # Home / ArticleList / ArticleDetail / Archive / About / ProjectList / ProjectDetail / NotFound
├─ App.vue
├─ style.css               # 设计系统（令牌 / 基础 / 工具类 / 布局 / 组件）
├─ main.ts
└─ env.d.ts                # 含 virtual:posts / virtual:projects / virtual:pages 的类型声明
```

## 路由

| 路径 | name | 标题 |
| --- | --- | --- |
| `/` | home | 首页 |
| `/articles` | article-list | 文章 |
| `/articles/:id` | article-detail | 文章详情（`:id` 是 md 文件名去掉日期前缀） |
| `/archive` | archive | 归档 |
| `/about` | about | 关于 |
| `/:pathMatch(.*)*` | not-found | 页面不存在 |

★ 404 是**顶层路由**，不在 `DefaultLayout` 内 —— 所以它没有导航栏，
也不能套「给导航让位」的顶部内边距。

★ 部署到 Pages 后深链接（直接访问 `/articles/hello`）由
`public/404.html` + `src/main.ts` 的 `?redirect=` 处理。

## 换主题

所有颜色集中在 `src/style.css` 的 `:root` 里，改一个值就全局生效：

```css
--brand:  #0631bb;   /* 唯一被显式指定的色，也是最深锚点 */
--bg-top: …;         /* 顶部浅蓝（由 --brand 派生） */
--text:   #fff8e7;   /* 米色（暖白），全站文字色 */
```

★ **不要再新增硬编码的 `#fff`**：全站文字都从 `var(--text)` 派生，
canvas 里的线条色也取自 `getComputedStyle(document.body).color`。
保持单一来源，换色才不会漏。

## 说明

- **没有传统后端**：没有 Node 服务、没有数据库。（曾经有 `src/api`、`src/stores`、
  `src/types` 与 Pinia、axios，收尾时一并删掉了。）只有三件「必须有个进程才能做」的事
  走 Cloudflare 边缘函数，都在 `workers/api/` 一个 Worker 里：浏览量计数、网易云音频转发、
  Steam 资料 —— 见 `workers/api/README.md`（端点契约）。
- **不要用 VS Code 内置浏览器验证动画**：它把 `requestAnimationFrame`
  限流到 ~1fps，且截图管线不稳定。详见 `DEVELOPMENT.md` §6.2。
- 开发者请先读 **`AGENTS.md`**（改代码前必看的约束清单）
  与 **`DEVELOPMENT.md`**（架构意图、踩坑记录、灵感池）；
  **要部署 / 绑域名 / 接边缘函数** → **`docs/static-site-deploy.md`**（静态站全链路）。
