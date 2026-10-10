/**
 * Vite 插件：页面（pages）—— 把 `content/pages/*.md` 变成「像文章详情页一样的单页」
 *
 * ── 这个文件只写「页面和别的集合**不一样**的地方** ──
 *   扫描 / frontmatter 解析 / 图片解析 / 校验 / 虚拟模块 / HMR 全在
 *   `content-kit.ts`（唯一实现）。这里声明：
 *     · 目录：`content/pages/`
 *     · 虚拟模块：`virtual:pages`（索引）+ `virtual:pages-map`（正文懒加载）
 *     · 必填字段：title / date（比文章/项目少 —— 页面没有分类，摘要也可省）
 *     · 额外字段：eyebrow（页眉小字）、name / tagline / links（左侧粘性卡片）
 *
 * ── 为什么要这个集合（用户 m10392）──
 *   「about 页重构……about 相当于是一个特殊的文章详情页，逻辑上照样复用 md
 *     渲染引擎」。于是 About 不再是写死的 .vue 模板，而是 `content/pages/about.md`：
 *   标题、引言、正文、头像、卡片上的名字与链接全在 md 里，页面只负责排布。
 *
 * ── frontmatter 约定 ──
 *   ---
 *   title: 设计是怎么工作，而不只是看上去如何   # 必填，面板里的大标题
 *   date: 2026-10-07                        # 必填，YYYY-MM-DD（页面不显示，排序用）
 *   eyebrow: 关于                            # 可选，标题上方的小字
 *   summary: 这个站是什么、用什么写的…          # 可选，标题下方的引言
 *   cover: assets/avatar.jpg                # 可选 —— ★ 在页面里它是**头像/主图**
 *   name: 小火兰                              # 可选，粘性卡片上的名字
 *   tagline: 爱你所爱                          # 可选，卡片上的签名
 *   links:                                  # 可选，卡片底部那排图标按钮
 *     - { label: 邮箱, href: mailto:you@example.com, icon: mail }
 *   ---
 *
 *   slug = 文件名去掉 `.md`（`about.md` → `about`）。
 *   ★ 页面**不带日期前缀**：它不是「某天发生的事」，路由靠 slug 取。
 *   ★ `_` / `.` 开头的文件（`_TEMPLATE.md`）不是页面：不进索引、也不报错；
 *     但 `npm run check:content` 会把它们当**模板**校验。
 *
 * ── 图片写在哪儿 ──
 *   content/pages/assets/  ← ★ 页面自己的图（头像是这里的 avatar.jpg）
 *   src/assets/works/      ← 通用作品图池（所有集合共用）
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

/** 卡片上的一个图标按钮 */
export interface PageLink {
  /** 无障碍用的文字（也当 title 提示） */
  label: string
  /** 必须是 http(s) 或 mailto:（见 parseHref） */
  href: string
  /**
   * 图标名。**刻意不做白名单校验** —— 图标是表现层的事（组件里有一张表），
   * 引擎只保证它是字符串；写了不认识的名字时组件退回一个通用图标，
   * 而不是让 `npm run build` 因为一个装饰性字段挂掉。
   */
  icon: string
}

/** 页面元数据（与 `src/pages.ts` 的 Page 对应） */
export interface PageMeta extends BaseMeta {
  /** 标题上方的小字（如「关于」） */
  eyebrow: string
  /** 粘性卡片上的名字 */
  name: string
  /** 粘性卡片上的签名 */
  tagline: string
  /** 卡片底部的图标按钮（可为空数组） */
  links: PageLink[]
}

const MD_DIR = 'content/pages'
/** 页面自有图片目录（头像是这里的 avatar.jpg） */
const ASSET_DIR = 'content/pages/assets'

/* ★ 把本集合的图片目录登记给引擎（通用作品图目录由引擎提供）。 */
registerAssetDirs([ASSET_DIR, WORKS_DIR])

/** 可选字符串字段：没写给空串（模板里 `v-if` 判断方便，不用区分 null / undefined） */
function optionalStr(value: unknown): string {
  return value === undefined || value === null ? '' : String(value).trim()
}

/**
 * 解析外链。
 *
 * ★★ 只放行 `http(s)://` 与 `mailto:`（本仓库里只有「关于」的邮箱那条用后者）——
 *   这个值最终会进 `<a href>`。
 *   Vue 会转义属性值里的引号，但**不会拦 `javascript:` 协议**：
 *   写进 md 就是一个可点的 XSS。构建期直接拒掉，比运行时过滤可靠得多。
 *   `mailto:` 本身不能执行脚本，但仍然要求写出 `名字@域名`，免得收下
 *   `mailto:javascript:...` 这种一眼看不懂的怪东西。
 *   （项目那边本来也有一份同规则的 `parseLink`，2026-10-08 随项目 `link`
 *   字段一起删了 —— 现在**全站只有这一处**外链白名单，别照抄第二份。）
 */
const HREF_PATTERN = /^(?:https?:\/\/[^\s]+|mailto:[^\s@]+@[^\s@]+)$/i

function parseHref(value: unknown, slug: string, label: string): string {
  const s = String(value).trim()
  if (!HREF_PATTERN.test(s)) {
    throw new Error(
      `[pages] ${slug} 的 links 里「${label}」的 href 必须是 http(s) 或 mailto: 地址："${s}"。\n` +
        `        （只放行 http/https/mailto：这个值会进 <a href>，javascript: 之类等于自己开个 XSS。）`,
    )
  }
  return s
}

/** 解析 links：必须是数组，每一项要有 label + href（icon 可省，默认 link） */
function parseLinks(value: unknown, slug: string): PageLink[] {
  if (value === undefined || value === null || value === '') return []
  if (!Array.isArray(value)) {
    throw new Error(
      `[pages] ${slug} 的 links 必须是数组，当前是 ${typeof value}。\n` +
        `        写法：\n` +
        `          links:\n` +
        `            - { label: GitHub, href: https://github.com/you, icon: github }`,
    )
  }
  return value.map((raw, i) => {
    const at = `links[${i}]`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`[pages] ${slug} 的 ${at} 必须是 { label, href, icon } 形式`)
    }
    const item = raw as Record<string, unknown>
    const label = optionalStr(item.label)
    if (!label) throw new Error(`[pages] ${slug} 的 ${at} 缺 label（会被读屏软件念出来）`)
    if (item.href === undefined || item.href === null || String(item.href).trim() === '') {
      throw new Error(`[pages] ${slug} 的 ${at}（${label}）缺 href`)
    }
    return {
      label,
      href: parseHref(item.href, slug, label),
      icon: optionalStr(item.icon) || 'link',
    }
  })
}

const PAGES: CollectionSpec<PageMeta> = {
  name: 'pages',
  label: '页面',
  dir: MD_DIR,
  assetDir: ASSET_DIR,
  indexModule: 'virtual:pages',
  mapModule: 'virtual:pages-map',
  listName: 'pages',
  loaderName: 'loadPage',
  /* ★ 页面没有分类、摘要也可以省；date 仍然必填 —— 引擎的 parseDate 对每个集合
     都跑（缺了就报「date 必须是 YYYY-MM-DD」），写进 required 是为了先报更好懂的
     「缺字段」。 */
  required: ['title', 'date'],

  buildMeta(data, ctx) {
    return {
      slug: ctx.slug,
      title: String(data.title),
      date: ctx.date,
      tags: ctx.tags,
      summary: optionalStr(data.summary),
      /* ★ frontmatter 的 cover 在页面里当**头像/主图**用：
         引擎已经把它解析成 assetUrls 里的 key，门面查表拿 URL。 */
      cover: ctx.coverKey,
      eyebrow: optionalStr(data.eyebrow),
      name: optionalStr(data.name),
      tagline: optionalStr(data.tagline),
      links: parseLinks(data.links, ctx.slug),
    }
  },
}

/**
 * 体检 `content/pages/`（收集全部问题，不抛异常）。
 * ★ 规则同样只有一份：`scripts/check-content.mjs` 直接 import 本函数。
 */
export function checkPages(root: string): CollectionReport<PageMeta> {
  return checkCollection(root, PAGES)
}

export default function pagesPlugin() {
  return createCollectionPlugin(PAGES)
}
