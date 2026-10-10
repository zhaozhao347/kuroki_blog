/**
 * Vite 插件：项目（projects）—— 把 `content/projects/*.md` 变成项目板块
 *
 * ── 这个文件只写「项目和文章**不一样**的地方** ──
 *   扫描 / frontmatter 解析 / 图片解析 / 校验 / 虚拟模块 / HMR 全在
 *   `content-kit.ts`（唯一实现）。这里声明：
 *     · 目录：`content/projects/`
 *     · 虚拟模块：`virtual:projects`（索引）+ `virtual:projects-map`（正文懒加载）
 *     · 必填字段：title / date / summary
 *     · 可选字段：cover
 *     · **没有** category / tags / role / link —— 项目只有
 *       「年份（由 date 派生）/ 大标题 / 小标题 / 图片」四样
 *
 * ── 和文章的关系 ──
 *   2026-10-07 之前，项目是一份手写的 `src/projects.ts` 数组；
 *   用户 m09288 要求「像 md 文章系统一样的机制：一个 md 甩进去，点进去跟文章一样」。
 *   于是把文章那套引擎抽成 `content-kit.ts`，两边各写一份 spec ——
 *   **校验规则只有一份**，不会出现「文章拒 `tags: CSS`、项目却接受」这种走样。
 *
 * ── frontmatter 约定 ──
 *   ---
 *   title: 项目名           # 必填
 *   date: 2026-09-28       # 必填，YYYY-MM-DD（记录/完成日期，列表按它倒序）
 *   summary: 摘要           # 必填（卡片上的一段话）
 *   cover: 封面.avif       # 可选，封面图（放 content/projects/assets/，或写 src/assets/works/ 里的文件名）
 *   ---
 *
 *   slug = 文件名去掉 `YYYY-MM-DD-` 前缀（`2026-09-28-blog.md` → `blog`）。
 *   ★ `_` / `.` 开头的文件（`_TEMPLATE.md`）不是项目：不进索引、也不报错；
 *     但 `npm run check:content` 会把它们当**模板**校验。
 *
 * ── 历史：tags / role / link 是**曾经有过**的字段（2026-10-08 全去掉）──
 *   用户 m13371：「项目不需要标签和分类，全部去掉，只需要解析时间（年份）、
 *   大标题、小标题、图片」，问到 role / link 时选择了「都去掉」。
 *   ★ 顺带没了 `link` 的 `http(s)` 白名单。那条校验存在的理由是
 *     「这个值最终会进 `<a href>`，`javascript:` 之类等于自己开个 XSS」——
 *     现在项目页没有任何来自 md 的 href，这条坑不再是活的风险；
 *     **真要加回外链，先把白名单一起加回来**（别只加字段）。
 */
import {
  checkCollection,
  createCollectionPlugin,
  registerAssetDirs,
  WORKS_DIR,
  type BaseMeta,
  type CollectionReport,
  type CollectionSpec,
} from './content-kit.ts'

/**
 * 项目元数据（与 `src/projects.ts` 的 Project 对应）。
 * ★ 就是引擎的公共字段，一个都不多 —— 项目没有 category / tags / role / link。
 */
export type ProjectMeta = BaseMeta

const MD_DIR = 'content/projects'
/** 项目自有图片目录（可选；不放图也能跑） */
const ASSET_DIR = 'content/projects/assets'

/* ★ 把本集合的图片目录登记给引擎（通用作品图目录由引擎提供）。 */
registerAssetDirs([ASSET_DIR, WORKS_DIR])

const PROJECTS: CollectionSpec<ProjectMeta> = {
  name: 'projects',
  label: '项目',
  dir: MD_DIR,
  assetDir: ASSET_DIR,
  indexModule: 'virtual:projects',
  mapModule: 'virtual:projects-map',
  listName: 'projects',
  loaderName: 'loadProject',
  required: ['title', 'date', 'summary'],
  /* ★★ 项目没有标签：frontmatter 里写 `tags:` 会被构建期**明确拒绝**
     （见 content-kit.ts 的 parseTags）—— 静默忽略的话，作者写了标签、
     页面上不显示、也没有报错，只能靠猜。 */
  tags: false,

  buildMeta(data, ctx) {
    return {
      slug: ctx.slug,
      title: String(data.title),
      date: ctx.date,
      summary: String(data.summary),
      cover: ctx.coverKey,
    }
  },
}

/**
 * 体检 `content/projects/`（收集全部问题，不抛异常）。
 * ★ 规则同样只有一份：`scripts/check-content.mjs` 直接 import 本函数。
 */
export function checkProjects(root: string): CollectionReport<ProjectMeta> {
  return checkCollection(root, PROJECTS)
}

export default function projectsPlugin() {
  return createCollectionPlugin(PROJECTS)
}
