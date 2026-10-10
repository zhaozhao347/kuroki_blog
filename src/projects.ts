/**
 * 项目（Projects）—— 运行时门面
 *
 * 视图只 import 这个文件，不直接碰 `virtual:projects`。
 *
 * ── 数据从哪来 ──
 *   构建期由 `vite-plugin-projects.ts` 扫描 `content/projects/*.md` 生成。
 *   元数据（标题/日期/摘要/封面）走 `virtual:projects`（列表页首屏就要用），
 *   正文走 `virtual:projects-map` 的懒加载（点进某个项目才拉那一个 md）。
 *
 * ── 加一个项目要做什么 ──
 *   在 `content/projects/` 里新建 `YYYY-MM-DD-slug.md`，顶部写 frontmatter
 *   （title / date / summary，可选 cover），下面写正文。
 *   列表、详情、上下篇都会自动跟着变。
 *   ★ `_` 开头的文件（如 `_TEMPLATE.md`）不是项目，不会被收录。
 *
 * ── 项目只有四样东西（用户 m13371）──
 *   年份（由 date 派生）/ 大标题 / 小标题 / 图片 —— **没有** category、tags、
 *   role、link。卡片与详情页都只渲染这四样，别的地方也别再引入。
 *
 * ── 历史 ──
 *   2026-10-07 之前这里是一份手写的 TS 数组（`src/projects.ts` 里直接列对象、
 *   配图靠显式 import）。用户 m09288 要求「像 md 文章系统一样的机制」，
 *   于是改成 `content/projects/*.md` + 构建期扫描 —— 和文章共用
 *   `content-kit.ts` 这一份引擎，字段规则不会两边走样。
 */
import { assetUrls, buildErrors, projects as raw } from 'virtual:projects'
import { loadProject } from 'virtual:projects-map'

/**
 * 构建期写进索引的原始字段（与 `vite-plugin-projects.ts` 的 `ProjectMeta` 一一对应）。
 * ★ 这里不重复校验规则 —— 规则只有 `content-kit.ts` 一份。
 */
export interface ProjectMeta {
  /** 文件名去掉日期前缀（2026-09-28-blog.md → blog），也是路由参数 */
  slug: string
  title: string
  /** YYYY-MM-DD（记录/完成日期，列表按它倒序；**页面上只显示派生出的年份**） */
  date: string
  summary: string
  /** 封面图（构建期解析出的 glob key，空串表示没写） */
  cover: string
}

/** 门面补上派生字段后给视图用的类型 */
export interface Project extends ProjectMeta {
  /** 由 date 派生的年份（卡片与详情页只显示年份，不假装精确到日） */
  year: string
  /** 封面图的真实 URL（空串 = 没写 cover，卡片就不渲染媒体框） */
  image: string
}

/**
 * 全部项目，已按日期倒序（构建期排好序，顺序稳定）。
 *
 * ★ 封面走 `assetUrls` 查表：`src/assets/` 与各集合目录下的 `assets/` 里的图是
 *   **打包器资源** —— 构建后文件名带 hash，还会加上 Pages 的 `base` 前缀。
 *   直接把 frontmatter 里的字符串丢给 `img.src` → 开发时 404、线上白屏，
 *   而且一声不响（实测 `naturalWidth === 0`，连 error 事件都没有）。
 */
export const projects: Project[] = (raw as ProjectMeta[]).map((p) => ({
  ...p,
  year: p.date.slice(0, 4),
  image: p.cover ? (assetUrls[p.cover] ?? '') : '',
}))

/**
 * 构建期扫到的问题（dev 下非空，页面上会提示）。
 *
 * ★ 为什么要在页面上提示而不是只看终端：写 md 时人盯着的是浏览器。
 *   某个 frontmatter 写错时，dev 下那个文件会被**静默跳过**（其余照常）——
 *   不提示的话作者会以为「文件没保存」或者「系统坏了」。
 */
export const projectsErrors: string[] = buildErrors

/** 按 slug 找项目 */
export function findProject(slug: string): Project | undefined {
  return projects.find((p) => p.slug === slug)
}

/**
 * 上一个 / 下一个项目（按列表顺序 = 日期倒序）。
 *
 * ★ 与文章同一套语义：`prev` = 更新（列表里在上面），`next` = 更旧。
 */
export function projectNeighbors(slug: string): { prev?: Project; next?: Project } {
  const i = projects.findIndex((p) => p.slug === slug)
  if (i < 0) return {}
  return { prev: projects[i - 1], next: projects[i + 1] }
}

/** 懒加载某个项目的正文（markdown 源码，已去掉 frontmatter） */
export async function getProjectBody(slug: string): Promise<string | null> {
  return loadProject(slug)
}
