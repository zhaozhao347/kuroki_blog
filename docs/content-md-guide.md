# 内容 md 放哪儿 —— 文章 / 项目 / 「关于」

> 一页说清：**写内容时文件该丢进哪个目录、文件名怎么起、frontmatter 怎么写、图片放哪**。
> 只讲「怎么放」，不讲引擎原理（那在 `AGENTS.md` §5.12/§5.13/§8 与 `content-kit.ts`）。
>
> 基线：2026-10-10。若与代码冲突，**以代码为准**（三个 spec：`vite-plugin-posts.ts` /
> `vite-plugin-projects.ts` / `vite-plugin-pages.ts`）。

---

## 0. 三十秒速查

| 你说的 | 放哪儿（目录） | 文件名 | 页面 URL | 显示在 |
| --- | --- | --- | --- | --- |
| **文章页**（articles） | `content/posts/` | `YYYY-MM-DD-英文slug.md` | `/articles/<slug>` | 文章列表、归档、站点统计 |
| **项目页**（projects） | `content/projects/` | `YYYY-MM-DD-英文slug.md` | `/projects/<slug>` | 项目列表 |
| **「关于」介绍页** | `content/pages/` | `about.md`（**不带日期**） | `/about` | 关于页正文 |

**slug = 文件名去掉 `YYYY-MM-DD-` 前缀**（`.md` 也要去掉）：

```
content/posts/2026-10-10-my-first-post.md   → slug = my-first-post   → /articles/my-first-post
content/projects/2026-09-28-blog.md         → slug = blog            → /projects/blog
content/pages/about.md                      → slug = about           → /about
```

★ 日期前缀是**约定**（`npm run new:post` 生成的就是这种）：引擎其实也接受不带前缀的
文件名（`content/posts/hello.md` → slug `hello`），只是带上日期更整齐、也一眼看得出排期。
**页面集合（「关于」）历来不带**。
★ **slug 必须唯一**：两个 md 撞同一个 slug 会让构建直接失败（它们会抢同一个 URL）。
★ slug 也是正文图片、上下篇导航、归档链接的锚点 —— **起好之后别改**。

图片都放各目录下的 `assets/`（不存在就自己建一个）：

| 集合 | 图片目录 | 目前状态 |
| --- | --- | --- |
| 文章 | `content/posts/assets/` | 空目录，还没建 |
| 项目 | `content/projects/assets/` | 空目录，还没建 |
| 关于 | `content/pages/assets/` | 已有 `avatar.jpg`（头像） |
| 共用 | `src/assets/works/` | 通用图池，三个集合都能引用 |

---

## 1. 文章 —— `content/posts/`

写一篇新文章只碰这一个目录，**列表 / 归档 / 详情页 / 站点统计全自动跟上**。

### 1.1 最快的方式

```bash
npm run new:post -- my-first-post "我的第一篇文章" 随笔 CSS,设计
#                  └─ slug ──┘ └── 标题 ──┘   └分类┘ └─标签（可省）─┘
```

它从 `content/posts/_TEMPLATE.md` 生成 `content/posts/<今天>-my-first-post.md`，
日期取今天、顺手删掉模板末尾的「字段速查」一节，**不覆盖**任何已存在的同 slug 文件。
不想用脚本就手动复制 `_TEMPLATE.md` 改名。

### 1.2 frontmatter

```markdown
---
title: 我的第一篇文章        # 必填
date: 2026-10-10            # 必填，YYYY-MM-DD（必须补零；2026-9-1 会被拒绝）
category: 随笔               # 必填，单值 —— 只作展示，不能点
tags: [CSS, 设计系统]        # 可选，YAML 数组；≤8 个、每个 ≤24 字
summary: 一句话摘要。         # 必填 —— 列表页卡片上那句
cover: 封面.png              # 可选 —— 图片放 content/posts/assets/
---

正文从这里开始，用 Markdown 写。h2 / h3、列表、代码块、引用都支持。
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 标题（卡片与详情页大标题） |
| `date` | ✅ | `YYYY-MM-DD`，**必须补零**；决定排序（日期倒序，同日期按 slug） |
| `category` | ✅ | 主分类，单值，**只显示、不可筛选**（分类筛选那一排早已撤掉） |
| `summary` | ✅ | 摘要，列表页卡片用 |
| `tags` | ⬜ | 自由多标签，**列表页 / 归档页唯一的筛选维度**；只能写成方括号数组 |
| `cover` | ⬜ | 封面图文件名 |

★ `tags` 写成标量（`tags: CSS`）会被**明确拒绝**（怕「忘了方括号」变成静默单标签）。
★ 只有一个标签也要写方括号：`tags: [CSS]`。
★ 正文字数（`words`）不是 frontmatter 字段，是构建期算好喂给「站点统计」的。

### 1.3 正文配图

把图丢进 `content/posts/assets/`，然后**行内**引用（相对 `assets/`）：

```markdown
![示意图](pic.png)          ← content/posts/assets/pic.png
![通用图](works/xx.avif)    ← src/assets/works/xx.avif（通用图池）
```

★ **不支持引用式图片语法**（`![alt][id]` + `[id]: path`）—— 引擎解析不到会变**裂图**，
所以构建期直接报错，请改成行内写法。
★ 只有**真正被引用过**的图才会被打进产物；`assets/` 里放着没引用的不会进 dist。

---

## 2. 项目 —— `content/projects/`

机制与文章**完全一样**（同一套引擎），只是字段更少。

### 2.1 frontmatter

```markdown
---
title: 这个博客              # 必填 —— 卡片与详情页的「大标题」
date: 2026-09-28            # 必填，YYYY-MM-DD；页面上只显示派生出的「年份」
summary: 一句话摘要。        # 必填 —— 卡片上的「小标题」
cover: 封面.avif            # 可选 —— content/projects/assets/ 或 src/assets/works/
---

正文从这里开始，和文章一样用 Markdown 写。
```

★ 项目卡片上**只有四样**：图片 / 年份 / 大标题 / 小标题。
★ 项目**没有** `category` / `tags` / `role` / `link` —— 写了 `tags:` 会在构建期
**明确报错**（`[projects] xxx.md 不支持 tags —— 项目没有标签。`），不显示也不静默忽略。
★ 详情页没有目录（TOC），文章详情页才有。

### 2.2 正文配图

同文章，放 `content/projects/assets/`，行内引用；通用图写 `works/xx.avif`。

---

## 3. 「关于」介绍页 —— `content/pages/about.md`

「关于」**不是写死的 Vue 模板**，它就是一个特殊的详情页：内容全在
`content/pages/about.md`，路由 `/about` 由 `src/views/AboutView.vue` 取它
（`AboutView.vue:39` 的 `const PAGE_SLUG = 'about'`）。

这个集合的 frontmatter 是**最多**的一个 —— 正文 + 左侧那张粘性卡片（头像 / 名字 /
签名 / 三个图标按钮）都在 md 里：

```markdown
---
title: 设计是怎么工作，而不只是看上去如何   # 必填 —— 面板里的大标题
date: 2026-10-07                        # 必填，YYYY-MM-DD（页面不显示，仅排序/记录）
eyebrow: 关于                            # 可选 —— 大标题上方的小字
summary: 这个站是什么、用什么写的…          # 可选 —— 大标题下方的引言
cover: assets/avatar.jpg                # 可选 —— ★ 在页面里它是**头像**
name: 小火兰                              # 可选 —— 卡片上的名字
tagline: popipa~                         # 可选 —— 卡片上的签名（会逐字打出来）
links:                                  # 可选 —— 卡片底部那排图标按钮
  - { label: GitHub, href: https://github.com/zhaozhao347, icon: github }
  - { label: Steam,  href: https://steamcommunity.com/id/1938526060zsx/, icon: steam }
  - { label: 邮箱,   href: mailto:huolandeshuyin@qq.com, icon: mail }
---

## 这个站点

正文从这里开始。h2 / 列表 / 代码块 / 引用都支持。
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `title` | ✅ | 面板里的大标题 |
| `date` | ✅ | `YYYY-MM-DD`，须补零；页面不显示它 |
| `eyebrow` | ⬜ | 标题上方的小字（现在写的是「关于」） |
| `summary` | ⬜ | 标题下方的引言（**页面集合里它可以省**） |
| `cover` | ⬜ | **头像 / 主图**；写 `assets/avatar.jpg` 就是本目录那张 |
| `name` | ⬜ | 卡片上的名字 |
| `tagline` | ⬜ | 卡片上的签名（`useTypewriter` 逐字出现） |
| `links` | ⬜ | 卡片底部按钮数组，每项 `{ label, href, icon }` |

★ `links[].href` **必须是 `http(s)://` 或 `mailto:`** —— 构建期直接拦掉
`javascript:` 之类（这个值最终会进 `<a href>`）。
★ `links[].icon` 可选，认得的只有四个：`github` / `steam` / `mail` / `link`；
写不认识的名字**不会报错**，只是退回通用的外链图标。
★ 头像放 `content/pages/assets/`。

### 3.1 ⚠️ 想再加一页（友链 / 说明…）

`content/pages/` 里**丢一个新 md 不会自动有路由** —— 现在只有 `/about` 一条路由，
且 `AboutView.vue` 里把 slug 写死成 `'about'`。要加固定页得两步：

1. `src/router/index.ts` 加一条路由（参考现有的 `path: 'about'`）；
2. 视图里把 `PAGE_SLUG` 换成新 slug（或抽成一个通用的 `PageView.vue` 复用同一套版面）。

引擎本身是通用的（`findPage(slug)` / `getPageBody(slug)` 任意 slug 都能取），
缺的只是路由与视图这一层。

---

## 4. 三个集合共有的规矩

| 规矩 | 说明 |
| --- | --- |
| `_` / `.` 开头 | **不是内容**，不进索引、也不报错（`_TEMPLATE.md`、编辑器临时文件）；但体检会把它们当**模板**校验 |
| 扩展名 | 必须 `.md`（大小写不敏感，`X.MD` 也认）。`.markdown` / `.mdx` / `.txt` 会被**明确提示不收录** |
| frontmatter | 文件必须以 `---` 开头、`---` 结束；BOM 会被自动剥掉 |
| `date` | 三个集合**都必填**，一律 `YYYY-MM-DD` 且补零 |
| 图片引用 | 一律**行内** `![alt](文件名)`；`assets/x` / `works/x` / 裸文件名都行，外链与 `data:` 原样透传 |
| 图片格式 | `.avif .webp .png .jpg .jpeg .svg .gif` |
| 图片查找顺序 | ① 以 `/` 开头的完整 key → ② `works/x` → ③ `assets/x`（本集合） → ④ 本集合 `assets/` 下的相对路径 → ⑤ 全库**唯一同名**兜底 |
| 找不到图 | 构建期**报错**（dev 下把该文件跳过 + 页面顶部提示），绝不静默裂图 |
| 文件名 | 文章 / 项目惯例带 `YYYY-MM-DD-` 前缀（`new:post` 生成的就是这种），不带也能跑（slug 就是整个文件名）；页面集合历来不带 |
| 排序 | 日期倒序，同日期按 slug（构建期排好，列表 / 归档 / 上下篇共用同一份顺序） |

### 4.1 写错时会发生什么

| 场景 | dev（`npm run dev`） | build（`npm run build` / CI） |
| --- | --- | --- |
| frontmatter 写错 | **跳过那个文件**、其余照常，错误收进清单并在页面顶部提示 | **直接抛错**，构建失败 |
| slug 重复 | 保留先出现的那个并提示冲突 | 直接抛错 |
| 图片找不到 | 跳过该文件并提示 | 直接抛错 |

★ 两者的差别是刻意的：dev 不能因为写错一个字段就崩（还要继续写别的），
而 CI 必须拦住 —— 否则线上会出现「少了半篇文章」。

### 4.2 自检命令

```bash
npm run check:content     # 文章 + 项目 + 页面 一起体检（快，不构建）
npm run check:posts       # 只查文章
npm run check:projects    # 只查项目
npm run check:pages       # 只查「关于」这类页面
npm run check:json        # 体检结果输出 JSON（给脚本用）
npm run check             # 体检 + 类型 + 构建 + 体积预算（最全，推之前跑一次）
```

dev 下改 md / 加图片会**热重扫**（整页 reload，不是局部刷新）：丢进去存盘就能看到效果，
不用重启服务器。

---

## 5. 复制这三段就够了

**新文章** → `content/posts/2026-10-10-hello.md`

```markdown
---
title: 标题
date: 2026-10-10
category: 随笔
tags: [标签一, 标签二]
summary: 一句话摘要。
---

正文。
```

**新项目** → `content/projects/2026-10-10-my-thing.md`

```markdown
---
title: 项目名
date: 2026-10-10
summary: 一句话摘要。
---

正文。
```

**改「关于」** → 直接编辑 `content/pages/about.md`（结构见 §3）。

> 仓库里三个目录各有一份 `_TEMPLATE.md`，内容比这里更细 —— 复制它改名即可；
> 模板自己也会被体检校验，别把它写坏。
