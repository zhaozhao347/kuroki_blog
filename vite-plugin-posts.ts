/**
 * Vite 插件：文章（posts）—— 把 `content/posts/*.md` 变成文章系统
 *
 * ── 这个文件只写「文章和别的集合**不一样**的地方** ──
 *   扫描 / frontmatter 解析 / 图片解析 / 校验 / 虚拟模块 / HMR 全在
 *   `content-kit.ts`（唯一实现）。这里声明：
 *     · 目录：`content/posts/`
 *     · 虚拟模块：`virtual:posts`（索引）+ `virtual:posts-map`（正文懒加载）
 *     · 必填字段：title / date / category / summary
 *     · 额外字段：category（主分类，**只作展示**）
 *
 * ── 为什么用 Vite 插件而不是 import.meta.glob ──
 *     · 构建期解析 + **校验**，写错直接让 `npm run build` 失败 → CI 拦住
 *     · 生成一份**索引**（不含正文），首屏只需要它
 *     · 正文按需懒加载（eager:false），点进某篇才拉那一个 md
 *
 * ── frontmatter 约定 ──
 *   ---
 *   title: 标题            # 必填
 *   date: 2026-09-19       # 必填，YYYY-MM-DD
 *   category: 随笔          # 必填（主分类，单值）
 *   tags: [CSS, 设计系统]    # 可选，多标签（YAML 数组：≤8 个、每个 ≤24 字）
 *   summary: 摘要           # 必填（列表页卡片的摘要）
 *   cover: pic.png         # 可选，封面图
 *   ---
 *
 *   slug = 文件名去掉 `YYYY-MM-DD-` 前缀（`2026-09-19-hello.md` → `hello`）。
 *   ★ `words`（正文字数）**不是 frontmatter 字段** —— 引擎在构建期算好写进 meta，
 *     给「关于」页的站点统计用（见 content-kit.ts 的 countWords）。
 *   ★ `_` / `.` 开头的文件（`_TEMPLATE.md`、编辑器临时文件）不是文章：
 *     不进索引、也不报错；但 `npm run check:content` 会把它们当**模板**校验。
 *
 * ── 图片写在哪儿 ──
 *   content/posts/assets/  ← ★ 推荐。文章自己的图，挨着文章放
 *   src/assets/works/      ← 通用作品图（历史约定，仍然可用）
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

/** 文章元数据（与 `src/posts.ts` 的 PostMeta 对应） */
export interface PostMeta extends BaseMeta {
  /** 主分类（单值）。★ 与 tags 的分工：category **只作展示**，
   *  真正能筛的是 tags（见 src/posts.ts 的注释）。 */
  category: string
  /** 正文字数（构建期由 `content-kit.ts` 的 countWords 算好）——「站点统计」用 */
  words: number
}

const MD_DIR = 'content/posts'
/** 文章自有图片目录（推荐） */
const ASSET_DIR = 'content/posts/assets'

/* ★ 把本集合的图片目录登记给引擎：解析图片、dev 监听都靠这份清单。
   （通用作品图目录由引擎提供，所有集合共用。） */
registerAssetDirs([ASSET_DIR, WORKS_DIR])

/** 统计（分类 / 标签）：按出现次数降序，次数相同按名称 —— 保证输出稳定 */
function tally(values: string[]): { name: string; count: number }[] {
  return [...values.reduce((m, v) => m.set(v, (m.get(v) ?? 0) + 1), new Map<string, number>())]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([name, count]) => ({ name, count }))
}

const POSTS: CollectionSpec<PostMeta> = {
  name: 'posts',
  label: '文章',
  dir: MD_DIR,
  assetDir: ASSET_DIR,
  indexModule: 'virtual:posts',
  mapModule: 'virtual:posts-map',
  listName: 'posts',
  loaderName: 'loadPost',
  required: ['title', 'date', 'category', 'summary'],

  buildMeta(data, ctx) {
    return {
      slug: ctx.slug,
      title: String(data.title),
      date: ctx.date,
      category: String(data.category),
      tags: ctx.tags,
      summary: String(data.summary),
      cover: ctx.coverKey,
      words: ctx.words,
    }
  },

  /* ★ 多标签总表：列表页与归档页的筛选排用它（与分类同款排序规则）。
     空数组的 tags 不产生条目。
     ★ `categories`（分类计数）已于 2026-10-07 删除：分类筛选那一排早就撤了，
       而 `src/env.d.ts` 里声明的那个导出零引用 —— 属于死代码。 */
  indexExtras(metas) {
    /* ★ `m.tags ?? []`：`BaseMeta.tags` 现在**可选**（项目那种集合干脆没有标签，
       见 content-kit.ts 的 `CollectionSpec.tags`）——文章这边写不写都有值，
       但类型上必须挡一下 undefined。 */
    return [
      `export const allTags = ${JSON.stringify(tally(metas.flatMap((m) => m.tags ?? [])), null, 2)}`,
    ]
  },
}

/**
 * 体检 `content/posts/`，**收集全部问题**而不是遇到第一个就停。
 * ★ 规则只有一份（`content-kit.ts`）：`scripts/check-content.mjs` 直接 import 本函数。
 */
export function checkPosts(root: string): CollectionReport<PostMeta> {
  return checkCollection(root, POSTS)
}

export default function postsPlugin() {
  return createCollectionPlugin(POSTS)
}
