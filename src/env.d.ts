/// <reference types="vite/client" />

/* ==================== 自定义环境变量 ====================
 *
 * 三个外部端点，全都由**同一个** Worker 提供（`workers/api/`，一个域名三条路径）：
 *
 *   VITE_VIEWS_ENDPOINT：站点浏览量的计数端点（Worker + KV）。
 *   VITE_MUSIC_ENDPOINT：音乐栏的音频转发端点。
 *   VITE_STEAM_ENDPOINT：Steam「最近在玩」的数据端点。
 *
 * ★ 三个都遵循同一个约定：**不配就什么都不发生**（不发请求、界面上是看得见的空）
 *   —— dev 下三个端点都有本地中间件兜底（见 `plugins/vite-plugin-api-proxy.ts`），
 *   所以本地开发不用部署 Cloudflare 也能跑通。配置说明见仓库根 `.env.example`。
 *
 * 曾经声明过 VITE_API_BASE_URL —— 真接后端时按同样写法加回来：
 *
 *   interface ImportMetaEnv {
 *     readonly VITE_API_BASE_URL?: string
 *   }
 */
interface ImportMetaEnv {
  /** 浏览量计数端点，例如 https://blog-api.xxx.workers.dev/views */
  readonly VITE_VIEWS_ENDPOINT?: string
  /**
   * 音乐端点（`workers/api/` 部署后的地址，Cloudflare Worker）。
   * ★ 不带 `/stream`：前端会拼 `<endpoint>/stream?id=<网易云歌曲id>`。
   * ★ 生产环境不配 ⇒ 曲目表为空、音乐栏显示一句配置提示；
   *   dev 下不配 ⇒ 默认走本地中间件 `/music`（见 plugins/vite-plugin-api-proxy.ts）。
   */
  readonly VITE_MUSIC_ENDPOINT?: string
  /**
   * Steam 端点（`workers/api/`，路径 `/steam`）。
   * ★ 生产不配 ⇒ 「关于」页不渲染「最近在玩」卡（不是空卡）；
   *   dev 下不配 ⇒ 默认走本地中间件 `/steam`，但**还要有 Steam Web API key**
   *   才能拿到数据（key 只活在 Worker / dev 环境变量里，永远不进前端）。
   */
  readonly VITE_STEAM_ENDPOINT?: string
  /**
   * 纯内网模式。`'1'` = 全站零外网请求：浏览量、Steam、网易云镜像全部停用，
   * 音乐只在配了 `VITE_MUSIC_BASE` 时才有（见下）。用于 `deploy/local/` 那套
   * 「内网 nginx 直接托管」的构建。
   */
  readonly VITE_OFFLINE?: string
  /**
   * 静态音频目录（可选）。配了就走 `<目录><slug>.mp3`，音频文件自己丢进 nginx
   * 的那个目录即可，不需要任何接口。例：`/music/`
   */
  readonly VITE_MUSIC_BASE?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

/* ==================== 文章系统的虚拟模块 ====================
 *
 * 这两个模块由 `vite-plugin-posts.ts` 在**构建期**生成（不是真实文件），
 * 所以必须手写类型声明，否则 TS 不认识它们。
 *
 * ★ 数据结构（PostMeta / CategoryCount）只在 `src/posts.ts` 里定义一次，
 *   这里引用它 —— 改字段时类型检查会同时指出两边，不会漏。
 */
declare module 'virtual:posts' {
  import type { PostMeta, CategoryCount } from '@/posts'
  export const posts: PostMeta[]
  /** 多标签及其数量（按数量降序） */
  export const allTags: CategoryCount[]
  export const total: number
  /**
   * 图片 URL 表：构建期解析出的 glob key → 打包后的真实 URL。
   * ★ 所有 `img.src` 都必须过这张表 —— 直接写字符串会在构建后 404。
   */
  export const assetUrls: Record<string, string>
  /** 构建期扫描出的问题（dev 下供页面提示；生产构建恒为空） */
  export const buildErrors: string[]
  export default posts
}

declare module 'virtual:posts-map' {
  /** 所有文章的 slug（构建期生成，顺序与索引一致） */
  export const slugs: string[]
  /**
   * 按 slug 懒加载正文（已剥掉 frontmatter）。
   * ★ 找不到时返回 null（而不是抛错）—— 路由可能收到任意 URL。
   */
  export function loadPost(slug: string): Promise<string | null>
}

/* ==================== 项目板块的虚拟模块 ====================
 *
 * 与文章**同一套引擎**（`content-kit.ts`）生成，只是换了一份 spec
 * （`vite-plugin-projects.ts`）：目录 `content/projects/`、必填字段
 * title / date / summary、可选 cover（**没有** category / tags / role / link）。
 *
 * ★ 类型同样只在 `src/projects.ts` 里定义一次，这里引用它。
 */
declare module 'virtual:projects' {
  import type { ProjectMeta } from '@/projects'
  export const projects: ProjectMeta[]
  export const total: number
  /** 图片 URL 表（同 virtual:posts 的 assetUrls） */
  export const assetUrls: Record<string, string>
  /** 构建期扫描出的问题（dev 下供页面提示；生产构建恒为空） */
  export const buildErrors: string[]
  export default projects
}

declare module 'virtual:projects-map' {
  /** 所有项目的 slug（构建期生成，顺序与索引一致） */
  export const slugs: string[]
  /**
   * 按 slug 懒加载正文（已剥掉 frontmatter）。
   * ★ 找不到时返回 null（而不是抛错）—— 路由可能收到任意 URL。
   */
  export function loadProject(slug: string): Promise<string | null>
}

/* ==================== 页面的虚拟模块 ====================
 *
 * 同样由 `content-kit.ts` 生成，spec 是 `vite-plugin-pages.ts`：
 * 把 `content/pages/*.md` 变成「像文章详情页一样的单页」（关于、将来的友链…）。
 * 与文章/项目的区别：文件名不带日期前缀、没有分类、摘要可省。
 *
 * ★ 类型同样只在 `src/pages.ts` 里定义一次，这里引用它。
 */
declare module 'virtual:pages' {
  import type { PageMeta } from '@/pages'
  export const pages: PageMeta[]
  export const total: number
  /** 图片 URL 表（同 virtual:posts 的 assetUrls） */
  export const assetUrls: Record<string, string>
  /** 构建期扫描出的问题（dev 下供页面提示；生产构建恒为空） */
  export const buildErrors: string[]
  export default pages
}

declare module 'virtual:pages-map' {
  /** 所有页面的 slug（构建期生成，顺序与索引一致） */
  export const slugs: string[]
  /**
   * 按 slug 懒加载正文（已剥掉 frontmatter）。
   * ★ 找不到时返回 null（而不是抛错）—— 路由可能收到任意 URL。
   */
  export function loadPage(slug: string): Promise<string | null>
}

/* ==================== 音乐：没有虚拟模块了 ====================
 *
 * 曾经有 `virtual:music`：构建期扫描 `public/music/*.mp3`、解析 ID3 标签后
 * 把曲目表交给播放器。2026-10-08 用户要求「音乐删掉，接网易云」之后，
 * 音频文件、ID3 解析器（`plugins/mp3.ts`）与那个插件一起删了 ——
 * 曲目表现在是手写清单 `src/playlist.ts`（歌曲 id + 显示用元数据），
 * 音频字节由 `workers/api/` 转发。
 */
