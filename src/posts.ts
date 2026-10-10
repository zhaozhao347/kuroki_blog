/**
 * 文章系统的**运行时门面**
 *
 * 视图只 import 这个文件，不直接碰 `virtual:posts`。
 * 这样做的好处：以后要换成「后端接口」或「headless CMS」，
 * 只改这一层，三个视图不用动。
 *
 * ── 数据从哪来 ──
 *
 *   构建期由 `vite-plugin-posts.ts` 扫描 `content/posts/*.md` 生成。
 *   元数据（标题/日期/分类/摘要）走 `virtual:posts`（首屏就要用），
 *   正文走 `virtual:posts-map` 的懒加载（点进某篇才拉）。
 *
 * ── 加一篇文章要做什么 ──
 *
 *   在 `content/posts/` 里新建 `YYYY-MM-DD-slug.md`，
 *   顶部写 frontmatter（title / date / category / summary，可选 tags / cover），下面写正文。
 *   其余全自动 —— 列表、归档、上下篇、分类与标签计数都会跟着变。
 *   ★ 也可以直接 `npm run new:post -- <slug> "标题"`，从模板生成一份。
 *   ★ `_` 开头的文件（如 `_TEMPLATE.md`）不是文章，不会被收录。
 */
import {
  allTags as tagCounts,
  assetUrls,
  buildErrors,
  posts,
  total,
} from 'virtual:posts'
import { loadPost } from 'virtual:posts-map'

export interface PostMeta {
  /** 文件名去掉日期前缀（2026-09-19-hello.md → hello），也是路由参数 */
  slug: string
  title: string
  /** YYYY-MM-DD */
  date: string
  category: string
  /**
   * 多标签（可为空数组）。
   * ★ `category` = 主分类（单值，**只作展示**：卡片与详情页上的一行文字）；
   *   `tags` = 自由多标签，是列表页 / 归档页**唯一**的筛选维度。
   */
  tags: string[]
  summary: string
  /** 封面图（构建期解析出的 glob key，空串表示没写）。取真实 URL 用 coverOf() */
  cover: string
  /**
   * 正文字数（构建期算好：中日韩按字、拉丁按词，已剥掉代码块 / 链接地址等）。
   * 「关于」页的站点统计用它求和 —— 视图里不要自己去数正文（正文是懒加载的）。
   */
  words: number
}

export interface CategoryCount {
  name: string
  count: number
}

/** 全部文章，已按日期倒序（构建期排好序，顺序稳定） */
export const allPosts: PostMeta[] = posts

/**
 * 标签及其数量，按数量降序。
 *
 * ★ 标签是**唯一**的筛选维度。分类筛选那一排已于 2026-10-06 按用户要求删除：
 *   6 篇文章散在 5 个分类里，点任何一个都只剩 1 篇，作筛选器没有意义。
 *   `category` 仍在 frontmatter 里、仍显示在卡片与详情页上，只是不再能点。
 */
export const allTags: CategoryCount[] = tagCounts

/**
 * 按标签筛选（**AND**：选中的标签全部命中才算入选）。
 *
 * ★ 抽到这里是为了让列表页与归档页共用**同一份**语义 ——
 *   两处各写一遍 filter 迟早会出现「列表页是 AND、归档页是 OR」这种不一致。
 */
export function filterByTags(list: PostMeta[], selected: string[]): PostMeta[] {
  if (!selected.length) return list
  return list.filter((p) => selected.every((t) => p.tags.includes(t)))
}

/** 文章总数 */
export const postTotal: number = total

/** 全站正文字数（构建期逐篇算好的 `words` 求和） */
const totalWords: number = allPosts.reduce((sum, p) => sum + (p.words || 0), 0)

/**
 * 「关于」页侧栏那张统计卡的数据源。
 *
 * ★ 这里的每一个数都**能从内容推出来**：不需要后端、不需要外部计数服务。
 *   （浏览量不在这里 —— 那必须来自外部计数端点，见 `src/composables/siteViews.ts`。）
 */
interface SiteStats {
  posts: number
  tags: number
  words: number
}

export const siteStats: SiteStats = {
  posts: postTotal,
  tags: allTags.length,
  words: totalWords,
}

/**
 * 构建期扫到的问题（dev 下非空，页面上会提示）。
 *
 * ★ 为什么要在页面上提示而不是只看终端：
 *   写 md 时人盯着的是浏览器。如果某篇 frontmatter 写错，
 *   dev 下那篇会被**静默跳过**（其他文章照常）——
 *   不提示的话作者会以为「文件没保存」或者「系统坏了」。
 */
export const postsErrors: string[] = buildErrors

/**
 * 取文章封面图的真实 URL。
 *
 * ★★ 必须查 `assetUrls` 表，不能直接把 frontmatter 里的字符串丢给 `img.src`。
 *   `src/assets/` 下的图是**打包器资源** —— 构建后文件名带 hash，
 *   还会自动加上 Pages 的 `base` 前缀（`/<repo>/`）。
 *   当成普通 URL 用 → 开发时 404、线上白屏，而且**一声不响**
 *   （实测 `naturalWidth === 0`，连 error 事件都没有）。
 *
 * ★ 没写 `cover` 时返回空串 → 列表页显示不带图的卡片。
 *   （曾经有一段「按日期哈希从作品图里挑一张」的兜底，已删：
 *     那是隐式行为 —— 没写 cover 却出现一张随机图，想换图得改日期。
 *     现在语义清楚：写了就有图，没写就没图。）
 */
export function coverOf(post: PostMeta): string {
  return post.cover ? (assetUrls[post.cover] ?? '') : ''
}

/** 按 `YYYY-MM` 分组（归档页用），返回已排序的月份数组。
 * ★ 返回类型是内联的（原来是导出的 `MonthGroup` 接口，但除这里之外
 *   零引用 → 已删）。 */
export function groupByMonth(list: PostMeta[] = allPosts) {
  const map = new Map<string, PostMeta[]>()
  for (const p of list) {
    const key = p.date.slice(0, 7)
    const arr = map.get(key)
    if (arr) arr.push(p)
    else map.set(key, [p])
  }
  return [...map.entries()]
    /* 月份倒序：'2026-09' > '2026-08'，字符串比较即可 */
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([month, items]) => ({
      month,
      label: month.replace('-', ' 年 ') + ' 月',
      items,
    }))
}

/** 按 slug 找元数据 */
export function findPost(slug: string): PostMeta | undefined {
  return allPosts.find((p) => p.slug === slug)
}

/**
 * 上一篇 / 下一篇（按列表顺序 = 日期倒序）。
 *
 * ★ 语义按「阅读顺序」理解：
 *   - `prev` = 更**新**的一篇（列表里在它上面）
 *   - `next` = 更**旧**的一篇（列表里在它下面）
 *   这与「首页 → 翻到下一篇」的直觉一致。
 */
export function neighbors(slug: string): { prev?: PostMeta; next?: PostMeta } {
  const i = allPosts.findIndex((p) => p.slug === slug)
  if (i < 0) return {}
  return { prev: allPosts[i - 1], next: allPosts[i + 1] }
}

/** 懒加载某篇的正文（markdown 源码，已去掉 frontmatter） */
export async function getPostBody(slug: string): Promise<string | null> {
  return loadPost(slug)
}
