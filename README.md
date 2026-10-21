# new_blog

我的个人博客。Vue 3 + TypeScript + Vite 写的纯静态站，没有后端也没有数据库，内容就是仓库里的 Markdown 文件。

配色只有两个：深蓝 `#0631BB` 和米色 `#fff8e7`，其余颜色都由它们混出来。

## 本地跑

```bash
npm install
npm run dev       # http://localhost:5173
npm run build     # 类型检查 + 构建，产物在 dist/
npm run preview   # 预览 dist/
```

检查用的命令：

```bash
npm run check:content   # 只查内容，很快
npm run check           # 内容 + 类型 + 构建 + 体积预算
npm run budget          # 只看首屏体积
```

## 写东西

- 文章：`content/posts/YYYY-MM-DD-slug.md`，图片放 `content/posts/assets/`，正文里写文件名就行
- 项目：`content/projects/*.md`，字段少一些，`title` / `date` / `summary` 必填
- 关于页：`content/pages/about.md`

文章的 frontmatter 里 `title` / `date` / `category` / `summary` 必填，`cover` 可选。没有草稿这个概念，文件放进去下次构建就会发出去。写错了 `npm run build` 会直接失败；开发时那一篇会被跳过，并在页面顶部提示。

字段、图片路径规则、校验行为都在 [docs/content-md-guide.md](docs/content-md-guide.md)。

## 结构

三个内容集合（文章 / 项目 / 页面）共用一套引擎。`content-kit.ts` 在构建期扫描 md、校验 frontmatter、解析图片，生成虚拟模块交给 `src/posts.ts`、`src/projects.ts`、`src/pages.ts`。列表页只加载索引，正文按需懒加载。

```
content/        Markdown 内容
content-kit.ts  内容引擎，三个集合共用
src/            Vue 应用（views / components / composables）
workers/api/    Cloudflare Worker：浏览量、网易云音频转发、Steam 资料
```

完整目录树和技术栈在 [AGENTS.md](AGENTS.md)。

## 部署

推送到 `main`，GitHub Actions 会类型检查、构建、发布到 GitHub Pages，配置在 `.github/workflows/deploy.yml`。第一次用要去仓库 Settings → Pages，把 Source 选成 GitHub Actions。

音乐栏、浏览量、Steam 卡片要靠 `workers/api/` 里那个 Worker。不配环境变量（`VITE_MUSIC_ENDPOINT` 等）时这几块显示空态，站点本身照常能用，部署步骤见 [workers/api/README.md](workers/api/README.md)。

## 再往下

- [AGENTS.md](AGENTS.md)：改代码前该知道的约束（样式体系、hero 尺寸、内容引擎规则）
- [DEVELOPMENT.md](DEVELOPMENT.md)：为什么这么写，以及踩过的坑
