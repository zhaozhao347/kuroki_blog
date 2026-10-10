/**
 * 页面（Pages）—— 运行时门面
 *
 * 视图只 import 这个文件，不直接碰 `virtual:pages`。
 *
 * ── 数据从哪来 ──
 *   构建期由 `vite-plugin-pages.ts` 扫描 `content/pages/*.md` 生成。
 *   元数据（标题/页眉小字/引言/卡片上的名字与链接）走 `virtual:pages`，
 *   正文走 `virtual:pages-map` 的懒加载（进入某一页才拉那一个 md）。
 *
 * ── 「页面」和「文章」的区别 ──
 *   文章是一篇篇按时间排的内容；页面是**站点的固定几页**（关于、将来可能的
 *   友链 / 说明）。所以：文件名不带日期前缀、没有分类、索引页也不存在 ——
 *   路由自己按 slug 取（`/about` 用 `findPage('about')`）。
 *
 * ── 历史 ──
 *   2026-10-07 之前 `/about` 是写死在 `src/views/AboutView.vue` 里的模板
 *   （两段正文 + 一个 dl 表 + 一个 ul）。用户 m10392 要求「about 也纳入文章
 *   体系，相当于一个特殊的文章详情页」，于是内容搬到 `content/pages/about.md`，
 *   页面只负责排布（左侧粘性头像卡 + 右侧毛玻璃面板 + Markdown 正文）。
 */
import { assetUrls, buildErrors, pages as raw } from 'virtual:pages'
import { loadPage } from 'virtual:pages-map'

/** 卡片上的一个图标按钮（与 `vite-plugin-pages.ts` 的 PageLink 一一对应） */
export interface PageLink {
  label: string
  href: string
  /** 图标名；组件里没有对应的图形时退回通用图标 */
  icon: string
}

/**
 * 构建期写进索引的原始字段（与 `vite-plugin-pages.ts` 的 `PageMeta` 一一对应）。
 * ★ 这里不重复校验规则 —— 规则只有 `content-kit.ts` 一份。
 */
export interface PageMeta {
  /** 文件名去掉 `.md`（`about.md` → `about`） */
  slug: string
  title: string
  /** YYYY-MM-DD（页面不显示，只用于排序/记录） */
  date: string
  tags: string[]
  summary: string
  /** 主图 —— 首页面里它是**头像**（构建期解析出的 glob key，空串表示没写） */
  cover: string
  /** 标题上方的小字（如「关于」） */
  eyebrow: string
  /** 粘性卡片上的名字 */
  name: string
  /** 粘性卡片上的签名 */
  tagline: string
  links: PageLink[]
}

/** 门面补上派生字段后给视图用的类型 */
export interface Page extends PageMeta {
  /** 头像/主图的真实 URL（空串 = 没写 cover，卡片就不渲染图） */
  avatar: string
}

/**
 * 全部页面，已按日期倒序（构建期排好序，顺序稳定）。
 *
 * ★ 头像走 `assetUrls` 查表：`content/pages/assets/` 与 `src/assets/` 里的图是
 *   **打包器资源** —— 构建后文件名带 hash，还会加上 Pages 的 `base` 前缀。
 *   直接把 frontmatter 里的字符串丢给 `img.src` → 开发时 404、线上白屏，
 *   而且一声不响（实测 `naturalWidth === 0`，连 error 事件都没有）。
 */
export const pages: Page[] = (raw as PageMeta[]).map((p) => ({
  ...p,
  avatar: p.cover ? (assetUrls[p.cover] ?? '') : '',
}))

/**
 * 构建期扫到的问题（dev 下非空，页面上会提示）。
 * ★ 为什么要在页面上提示而不是只看终端：写 md 时人盯着的是浏览器。
 *   某个 frontmatter 写错时，dev 下那个文件会被**静默跳过**（其余照常）——
 *   不提示的话作者会以为「文件没保存」或者「系统坏了」。
 */
export const pagesErrors: string[] = buildErrors

/** 按 slug 找页面（`/about` → `findPage('about')`） */
export function findPage(slug: string): Page | undefined {
  return pages.find((p) => p.slug === slug)
}

/** 懒加载某一页的正文（markdown 源码，已去掉 frontmatter） */
export async function getPageBody(slug: string): Promise<string | null> {
  return loadPage(slug)
}
