/**
 * 内容集合引擎（content kit）—— 构建期解析 / 校验 / 生成虚拟模块的**唯一实现**
 *
 * ── 它解决什么 ──
 *   站点有两类「一个 md 甩进去就完事」的内容：
 *     · 文章 `content/posts/*.md`     → 列表 / 归档 / 详情（virtual:posts）
 *     · 项目 `content/projects/*.md`  → 列表 / 详情（virtual:projects）
 *   两者的**机制完全相同**：构建期扫描 + 校验（有问题让 build 失败）、
 *   生成一份不含正文的索引、正文按需懒加载。
 *   所以引擎只有这一份，每个集合只写「自己的字段 + 自己的虚拟模块名」
 *   （见 `vite-plugin-posts.ts` / `vite-plugin-projects.ts` 的 spec）。
 *
 *   ★★ 为什么不能让两个插件各写一套解析：
 *      校验规则一旦有两份，迟早就走样（今天文章拒绝 `tags: CSS`、
 *      明天项目接受了），而「构建期拦住写错的内容」正是这套东西存在的理由。
 *
 * ── 产出的虚拟模块（每个集合两个）──
 *   virtual:<name>      索引：元数据数组（已排序）+ 图片 URL 表 + 错误清单
 *   virtual:<name>-map  懒加载：slug → 那一篇的正文（去掉 frontmatter、图片换成真实 URL）
 *
 * ── frontmatter 约定（所有集合共有）──
 *   title / date(YYYY-MM-DD) / summary 必填；tags / cover 可选。
 *   各集合额外的字段由自己的 `buildMeta()` 校验。
 *
 *   ★ `_` / `.` 开头的文件不是内容（模板 `_TEMPLATE.md`、编辑器临时文件）：
 *     不进索引、也不报错；但 `npm run check:content` 会把它们当**模板**校验，
 *     模板自己写坏了同样要在构建期拦住。
 *
 * ── 图片写在哪儿 ──
 *   各集合自己的 `assets/`（如 content/projects/assets/）+ 通用 `src/assets/works/`。
 *   引用写法：`pic.png` / `assets/pic.png` / `works/你的封面.avif` / `/works/…`；
 *   `https://…` 与 `data:` 原样透传。
 *   ★★ 必须走这条路，不能直接写 `src="works/x.avif"`：
 *     `src/assets/` 下的图是**打包器资源**（构建后带 hash + base 前缀），
 *     当普通字符串用会静默裂图（实测 naturalWidth === 0，连 error 事件都没有）。
 *   ★ 只把**真正被引用过**的图打进产物（见 usedAssetKeys）：整目录 eager glob
 *     会把没人引用的图也塞进 dist（2026-10-06 清掉过 6 张 avif / 516 KB）。
 */
import fs from 'node:fs'
import path from 'node:path'
/* ★ js-yaml v4 的 ESM 构建**没有 default 导出**（只有命名导出）。
   写成 `import yaml from 'js-yaml'` 会在 Vite 加载 config 时报：
     SyntaxError: The requested module 'js-yaml.mjs' does not provide
                  an export named 'default'
   必须用命名导入。 */
import { load as loadYaml } from 'js-yaml'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'

/* ==========================================================================
   类型
   ========================================================================== */

/** 所有集合共有的元数据字段 */
export interface BaseMeta {
  /** 文件名去掉 `YYYY-MM-DD-` 前缀，也是路由参数 */
  slug: string
  title: string
  /** YYYY-MM-DD */
  date: string
  /**
   * 自由多标签（可为空数组）。
   * ★ **可选**：集合在 spec 里写 `tags: false` 表示不要标签（项目就是，
   *   见 `vite-plugin-projects.ts`）—— 这时 meta 上根本没有这个字段。
   */
  tags?: string[]
  summary: string
  /** 封面对应的 glob key（形如 `/src/assets/works/你的封面.avif`）；空串 = 没写 */
  cover: string
}

/** 资源索引：glob key（以 `/` 开头、相对项目根）→ 原始绝对路径 */
type AssetIndex = Map<string, string>

/** 一条解析好的内容 */
interface Parsed<M> {
  meta: M
  file: string
  /**
   * 封面对应的 glob key（空串 = 没写 cover → 列表页显示不带图的卡片）。
   * ★ 不在构建期把 URL 定死：Vite 的 hash 只有打包完才知道，
   *   所以只存 key，真正的 URL 由生成的索引模块查表得到。
   */
  coverKey: string
  /** 正文里出现的图片引用 → glob key（运行时替换成真实 URL） */
  assetRefs: Record<string, string>
}

/** `buildMeta()` 拿到的公共字段 */
interface MetaContext {
  /** 文件名（报错信息里用它，作者一眼知道是哪一篇） */
  name: string
  slug: string
  date: string
  tags: string[]
  coverKey: string
  /**
   * 正文字数（构建期算好的，见 `countWords`）。
   * ★ 只有真的用它（目前是文章）的集合才写进 meta；别的集合忽略即可。
   */
  words: number
}

/**
 * 一个集合的全部差异都写在这里。
 *
 * ★ 解析、校验、图片、懒加载、HMR 全在引擎里；spec 只声明：
 *   目录在哪、虚拟模块叫什么、有哪些必填字段、frontmatter 怎么变成 meta。
 */
export interface CollectionSpec<M extends BaseMeta> {
  /** 集合名：错误前缀 `[posts]`、统计、虚拟模块注释都用它 */
  name: string
  /** 报告里的中文名，如「文章」「项目」 */
  label: string
  /** md 目录（相对 root），如 `content/posts` */
  dir: string
  /** 本集合自有图片目录（相对 root）—— 推荐把图放这儿 */
  assetDir: string
  /** 索引虚拟模块名，如 `virtual:posts` */
  indexModule: string
  /** 懒加载虚拟模块名，如 `virtual:posts-map` */
  mapModule: string
  /** 索引模块里那个数组的变量名，如 `posts` / `projects` */
  listName: string
  /** 懒加载函数名，如 `loadPost` / `loadProject` */
  loaderName: string
  /** frontmatter 必填字段（缺一个就报错） */
  required: string[]
  /**
   * 这个集合要不要 `tags`（默认 true）。
   *
   * ★ 写 `false`：frontmatter 里出现 tags 会被**明确拒绝**，而不是静默忽略 ——
   *   静默吞掉的话，作者写了标签、页面上不显示、也没有报错，只能靠猜。
   *   此时 `ctx.tags` 恒为 `[]`，`BaseMeta.tags` 也不会产出。
   *   项目就是这一档（用户 m13371：项目不需要标签和分类）。
   */
  tags?: boolean
  /** 由 frontmatter 产出 meta；校验不通过**直接抛异常** */
  buildMeta(data: Record<string, unknown>, ctx: MetaContext): M
  /** 索引模块额外导出的源码行（如分类 / 标签统计） */
  indexExtras?(metas: M[]): string[]
}

/**
 * 校验助手里真正用得上的字段。
 * ★ 单独抽出来是为了躲开泛型的 variance 纠缠：`CollectionSpec<PostMeta>`
 *   不能赋给 `CollectionSpec<BaseMeta>`（`buildMeta` 的返回类型是逆变的），
 *   但它**可以**赋给这个只读的结构类型。
 */
interface SpecInfo {
  name: string
  label: string
  assetDir: string
  /** 集合是否支持 `tags`（默认 true；false = 写了就报错，见 `CollectionSpec.tags`） */
  tags?: boolean
}

/** `checkCollection()` 的返回结构（给 `scripts/check-content.mjs` 用） */
export interface CollectionReport<M> {
  root: string
  /** 校验通过的元数据（已排序） */
  items: M[]
  /** 被当作模板校验的 `_` / `.` 开头文件 */
  templates: { file: string; ok: boolean }[]
  /** **全部**问题（不抛异常，一次性报完） */
  errors: string[]
}

/* ==========================================================================
   常量与文件级助手
   ========================================================================== */

/** 通用作品图目录（历史约定，所有集合都可用） */
export const WORKS_DIR = 'src/assets/works'

/**
 * 本进程已知的**所有**图片目录（集合在 import spec 时用 registerAssetDirs 注册）。
 *
 * ★ 为什么要一份全局的：`resolveAsset()` 要在所有目录里查表，
 *   而且 dev 下要监听它们 —— 新加一张图后 assetRefs 必须重算，
 *   否则封面还是查不到 key（表现为「图放进去了但页面还是裂的」）。
 */
const ASSET_DIRS = new Set<string>()
export function registerAssetDirs(dirs: string[]): void {
  for (const d of dirs) ASSET_DIRS.add(d)
}

/** 参与解析的图片扩展名 */
const IMAGE_EXT = ['.avif', '.webp', '.png', '.jpg', '.jpeg', '.svg', '.gif']

/**
 * `_` / `.` 开头的文件不参与收录（模板 `_TEMPLATE.md`、编辑器临时文件 `.x.md.swp`…）。
 * ★ 以前这种文件会被当成内容去解析：模板里 `date: YYYY-MM-DD` 这种占位符
 *   当场让 `npm run build` 抛异常，等于「放个模板就没法构建」。
 */
const isHidden = (f: string) => f.startsWith('_') || f.startsWith('.')

/**
 * 判断是不是 markdown 文件。
 *
 * ★★ 大小写**不敏感**（2026-09-21 修正）：旧代码写的是 `f.endsWith('.md')`，
 *   于是 `hello.MD` 会被**完全忽略** —— 构建照样成功，内容却根本不存在，
 *   作者只会疑惑「我文件明明放进去了」。
 * ★ 比对时不转小写、只做判断 —— 保留真实文件名，它们要用于 path.join 与 slug 推导。
 */
const isMarkdown = (f: string) => f.toLowerCase().endsWith('.md')

/**
 * 看起来像 markdown 但扩展名不对（`.markdown` / `.mdx` / `.txt`…）。
 * 用于在构建期给出提示，而不是静默忽略。
 */
const looksLikeMarkdown = (f: string) => /\.(markdown|mdx|mdown|mkd|text|txt)$/i.test(f)

/** 匹配 markdown 图片：`![alt](ref)` 或 `![alt](ref "title")` */
const IMG_RE = /(!\[[^\]]*\]\(\s*)([^)\s]+)(\s*(?:"[^"]*")?\s*\))/g

/**
 * slug：文件名去掉 `YYYY-MM-DD-` 前缀（`2026-09-19-hello.md` → `hello`）。
 * ★ 没有日期前缀也认（项目文件名常常直接叫 `atlas.md`）。
 * ★★ 这段规则同时被**生成到运行时**（map 模块里也要按同样办法从 glob 路径推 slug），
 *   所以用常量保存源码字符串，别写两遍。
 */
const SLUG_RE = /\.md$/
const DATE_PREFIX_RE = /^\d{4}-\d{2}-\d{2}-/
const slugOf = (fileOrPath: string): string =>
  fileOrPath
    .slice(fileOrPath.lastIndexOf('/') + 1)
    .slice(fileOrPath.lastIndexOf('\\') + 1)
    .replace(SLUG_RE, '')
    .replace(DATE_PREFIX_RE, '')

/** 生成到运行时的 slug 推导源码（与上面的 slugOf 同一套规则） */
const SLUG_OF_SRC =
  `p.slice(p.lastIndexOf('/') + 1).replace(/\\.md$/, '').replace(/^\\d{4}-\\d{2}-\\d{2}-/, '')`

/**
 * 扫描所有图片目录，建立「glob key → 原始路径」索引。
 *
 * ★ glob key 必须与生成的 `import.meta.glob([...])` 的键**逐字节一致**
 *   （都以 `/` 开头、相对项目根），否则运行时的 URL 查表会全部落空。
 */
function buildAssetIndex(root: string): AssetIndex {
  const idx: AssetIndex = new Map()
  for (const dir of ASSET_DIRS) {
    const abs = path.resolve(root, dir)
    if (!fs.existsSync(abs)) continue
    /* 递归：允许作者在 assets/ 下建子目录分类（assets/2026/pic.png） */
    const walk = (d: string) => {
      for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, entry.name)
        if (entry.isDirectory()) {
          walk(full)
          continue
        }
        if (!IMAGE_EXT.includes(path.extname(entry.name).toLowerCase())) continue
        /* 转成 POSIX 风格的 glob key（Windows 下 path.relative 会给反斜杠） */
        const rel = path.relative(root, full).split(path.sep).join('/')
        idx.set('/' + rel, full)
      }
    }
    walk(abs)
  }
  return idx
}

/**
 * 把 md 里写的图片引用解析成 glob key。
 *
 * 解析不到返回 `null` —— 调用方负责报错，**绝不静默放行**。
 */
function resolveAsset(ref: string, assets: AssetIndex, assetDir: string): string | null {
  let s = ref.trim()
  /* 外链 / data URI 原样透传，不参与解析 */
  if (/^(https?:)?\/\//i.test(s) || s.startsWith('data:')) return null
  s = s.replace(/^\.\//, '')

  const tryKey = (k: string) => (assets.has(k) ? k : null)

  /* ① 已经是完整 key（作者写了 /content/posts/assets/x.png） */
  if (s.startsWith('/')) {
    if (assets.has(s)) return s
    s = s.slice(1)
  }

  /* ② works/x.avif → src/assets/works/x.avif（通用作品图，所有集合可用） */
  if (s.startsWith('works/')) {
    const hit = tryKey('/' + WORKS_DIR + '/' + s.slice('works/'.length))
    if (hit) return hit
  }

  /* ③ assets/x.png → <本集合>/assets/x.png */
  if (s.startsWith('assets/')) {
    const hit = tryKey('/' + assetDir + '/' + s.slice('assets/'.length))
    if (hit) return hit
  }

  /* ④ 直接当本集合 assets 下的相对路径 */
  const direct = tryKey('/' + assetDir + '/' + s)
  if (direct) return direct

  /* ⑤ 兜底：按**文件名**在全部资源里找，但只在唯一命中时才认。
        多个同名文件时报错比瞎猜好 —— 作者应该写清楚目录。 */
  const base = s.slice(s.lastIndexOf('/') + 1)
  const hits = [...assets.keys()].filter((k) => k.slice(k.lastIndexOf('/') + 1) === base)
  if (hits.length === 1) return hits[0]
  return null
}

/**
 * 收集**真正被引用过**的图片 glob key（封面 + 正文里的图）。
 * ★ key 必须与 `buildAssetIndex` / `resolveAsset` 产出的 key 逐字节一致，
 *   否则运行时查表落空（表现为裂图）。
 *   sorted 只是让生成代码稳定、便于 diff（对象键顺序不影响查表）。
 */
function usedAssetKeys(list: Parsed<BaseMeta>[]): string[] {
  const keys = new Set<string>()
  for (const p of list) {
    if (p.coverKey) keys.add(p.coverKey)
    for (const k of Object.values(p.assetRefs)) keys.add(k)
  }
  return [...keys].sort()
}

/* ==========================================================================
   解析与校验
   ========================================================================== */

/**
 * 解析 `tags`（可选）。
 *
 * ★ 必须是 YAML 数组：`tags: [CSS, 设计系统]`。
 *   写成标量（`tags: CSS`）会被**明确拒绝**，而不是当成「只有一个标签」——
 *   否则「忘了写方括号」会静默变成单标签，作者永远发现不了。
 * ★ 上限（≤8 个、每个 ≤24 字）是刻意加的：标签是给人**扫**的短词，
 *   一旦能写长句，筛选器就会变成一堆每人一个的私有分类。
 * ★ `spec.tags === false` 的集合（项目）**没有标签**：写了就报错，返回恒 `[]`。
 */
function parseTags(data: Record<string, unknown>, name: string, spec: SpecInfo): string[] {
  const tag = `[${spec.name}]`

  /* ★ 这个集合声明不要标签：出现 tags 就直接拒绝。
     与「写成标量也拒绝」同一个标准 —— 不猜作者意图，也不静默丢。 */
  if (spec.tags === false) {
    if (data.tags !== undefined && data.tags !== null) {
      throw new Error(
        `${tag} ${name} 不支持 tags —— ${spec.label}没有标签。\n` +
          `        请把 frontmatter 里的 tags 那一行删掉（写在这里也不会显示）。`,
      )
    }
    return []
  }

  const raw = data.tags
  if (raw === undefined || raw === null) return []

  if (!Array.isArray(raw)) {
    throw new Error(
      `${tag} ${name} 的 tags 必须是数组，当前是 ${typeof raw}。\n` +
        `        正确写法：tags: [CSS, 设计系统]\n` +
        `        只有一个标签也要写方括号：tags: [CSS]`,
    )
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (typeof item !== 'string' && typeof item !== 'number') {
      throw new Error(
        `${tag} ${name} 的 tags 里有非文本项：${JSON.stringify(item)}\n` +
          `        标签只能是短文本，例如 tags: [CSS, 设计系统]`,
      )
    }
    const t = String(item).trim()
    if (!t) {
      throw new Error(
        `${tag} ${name} 的 tags 里有空标签 —— 大概率是多写了一个逗号（tags: [a, , b]）`,
      )
    }
    if (t.length > 24) {
      throw new Error(
        `${tag} ${name} 的标签 "${t}" 太长（${t.length} 字，上限 24）。\n` +
          `        标签要短；这句话请写进 summary。`,
      )
    }
    /* ★ 去重忽略大小写（CSS / css 视为同一个），但保留第一次的拼写 */
    const key = t.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(t)
  }

  if (out.length > 8) {
    throw new Error(
      `${tag} ${name} 有 ${out.length} 个标签（上限 8）。\n` +
        `        标签太多就失去意义了，请合并同类项。`,
    )
  }
  return out
}

/** 校验 `date`：必须 `YYYY-MM-DD`（补零），且是真实日期 */
function parseDate(data: Record<string, unknown>, name: string, spec: SpecInfo): string {
  const tag = `[${spec.name}]`
  const dateStr = String(data.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(
      `${tag} ${name} 的 date 必须是 YYYY-MM-DD 格式，当前是 "${dateStr}"。\n` +
        `        ★ 不要写成 YYYY-M-D 或带引号的形式 —— YAML 会把 2026-09-01\n` +
        `          解析成字符串，但 2026-9-1 可能被当成别的类型。`,
    )
  }
  const d = new Date(dateStr + 'T00:00:00Z')
  if (Number.isNaN(d.getTime())) {
    throw new Error(`${tag} ${name} 的 date "${dateStr}" 不是有效日期`)
  }
  return dateStr
}

/**
 * 正文「字数」：中日韩字符按**字**算，拉丁文按**词**算。
 *
 * ★ 构建期算一次、写进 meta（`words`），页面直接读 —— 正文是**懒加载**的，
 *   在视图里数一遍等于把全站 md 都拉下来（首屏白白多几百 KB）。
 * ★ 计数前先剥掉**不该算字数**的东西：代码块、行内代码、图片、链接地址、HTML 标签。
 *   否则一篇满是代码的文章会虚高，「站点统计」也跟着虚高。
 */
function countWords(md: string): number {
  const text = md
    .replace(/```[\s\S]*?```/g, ' ') /* 围栏代码块 */
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ') /* 行内代码 */
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') /* 图片 */
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') /* 链接只留文字 */
    .replace(/<[^>]+>/g, ' ') /* HTML 标签 */
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, ' ') /* 标题 / 引用 / 列表标记 */
    .replace(/https?:\/\/\S+/g, ' ') /* 裸链接 */
  const cjk =
    text.match(/[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]/g)?.length ?? 0
  const latin = text.match(/[A-Za-z0-9][A-Za-z0-9'’_-]*/g)?.length ?? 0
  return cjk + latin
}

/** 解析一篇内容；任何校验失败都抛异常（build 路径靠它拦住错误内容） */
function parseContent<M extends BaseMeta>(
  file: string,
  assets: AssetIndex,
  spec: CollectionSpec<M>,
): Parsed<M> {
  const tag = `[${spec.name}]`
  /* ★ 去掉 BOM：Windows 编辑器（记事本 / VS Code 选 UTF-8 with BOM）
     会把 \uFEFF 写在文件最前面，那样 `/^---/` 就匹配不上，
     报出来却是含糊的「缺少 frontmatter」。这里统一剥掉。 */
  const raw = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
  const name = path.basename(file)

  /* ---- frontmatter ---- */
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(raw)
  if (!m) {
    throw new Error(
      `${tag} ${name} 缺少 frontmatter。\n` +
        `        文件必须以 --- 开头、以 --- 结束，中间写元数据。\n` +
        `        参考同目录下已有的文件或 _TEMPLATE.md。`,
    )
  }

  let data: Record<string, unknown>
  try {
    data = (loadYaml(m[1]) ?? {}) as Record<string, unknown>
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    throw new Error(`${tag} ${name} 的 frontmatter 不是合法 YAML：\n        ${msg}`)
  }

  const body = raw.slice(m[0].length)

  /* ---- 必填字段 ---- */
  const missing = spec.required.filter((k) => !data[k])
  if (missing.length) {
    throw new Error(`${tag} ${name} 缺少必填字段：${missing.join(', ')}`)
  }

  const date = parseDate(data, name, spec)
  const tags = parseTags(data, name, spec)

  const slug = slugOf(name)

  /* ---- 封面图：解析成 glob key，解析不到直接报错 ----
     ★ 报错而不是静默留空：列表页某张卡片突然变白图，
       作者根本不知道是自己写错了名字还是系统坏了。 */
  let coverKey = ''
  if (data.cover) {
    const ref = String(data.cover)
    const key = resolveAsset(ref, assets, spec.assetDir)
    if (!key) {
      throw new Error(
        `${tag} ${name} 的 cover 找不到对应图片："${ref}"。\n` +
          `        图片请放在这两个目录之一：\n` +
          `          ${spec.assetDir}/   （推荐，${spec.label}自己的图）\n` +
          `          ${WORKS_DIR}/       （通用作品图）\n` +
          `        然后写相对路径，例如 cover: pic.png 或 cover: works/你的封面.avif`,
      )
    }
    coverKey = key
  }

  /* ---- 正文插图：解析每个相对路径 ----
     ★ 只**校验 + 记录**，不改正文本身。正文在运行时是通过
       `import.meta.glob(?raw)` 拿的原始 md，构建期改内存里的副本到不了页面。
       所以这里产出 `assetRefs: { 原始引用 → glob key }`，
       运行时拿真实的打包 URL 替换（见 map 模块里的 localizeImages）。 */
  const assetRefs: Record<string, string> = {}
  const scan = (whole: string, ref: string) => {
    if (/^(https?:)?\/\//i.test(ref.trim()) || ref.trim().startsWith('data:')) return whole
    const key = resolveAsset(ref, assets, spec.assetDir)
    if (!key) {
      throw new Error(
        `${tag} ${name} 正文里的图片找不到：${ref}\n` +
          `        图片请放在这两个目录之一：\n` +
          `          ${spec.assetDir}/   （推荐）\n` +
          `          ${WORKS_DIR}/\n` +
          `        然后写相对路径，例如 ![图](pic.png)`,
      )
    }
    assetRefs[ref] = key
    return whole
  }
  body.replace(IMG_RE, (whole: string, _head: string, ref: string) => scan(whole, ref))

  /* ---- ★★ 拒绝引用式图片语法 ----
   *   `![alt][id]` + `[id]: path` 这种写法，引擎**解析不到**（IMG_RE 只认
   *   行内 `![alt](ref)`），于是图片既不校验、也不会被 localizeImages
   *   替换成真实 URL —— 结果上线后就是一张**静默裂图**。
   *
   *   实测（2026-09-21）：构建通过、正文 chunk 里原样保留 `missing-ref.png`，
   *   浏览器里渲染成 `<img src="missing-ref.png">` 指向一个不存在的路径。
   *
   *   与其猜作者意图，不如**明确报错** —— 与 frontmatter / 行内图片同一套标准。 */
  const refStyle = body.match(/!\[[^\]]*\]\[[^\]]*\]/)
  if (refStyle) {
    throw new Error(
      `${tag} ${name} 用了「引用式图片」语法：${refStyle[0]}\n` +
        `        这种写法引擎解析不到图片路径，会变成裂图。\n` +
        `        请改成行内写法：![说明](图片名.png)\n` +
        `        （图片放在 ${spec.assetDir}/ 或 ${WORKS_DIR}/ 下）`,
    )
  }

  const meta = spec.buildMeta(data, { name, slug, date, tags, coverKey, words: countWords(body) })

  return { meta, file, coverKey, assetRefs }
}

/**
 * 排序比较器：日期倒序，同日期按 slug。
 * ★ 排序放在构建期：列表页、归档页、上下篇导航共用同一份顺序，
 *   不会出现「列表里顺序和上一篇下一篇对不上」这种不一致。
 *   同日期的按 slug 兜底，保证顺序**稳定**（否则每次构建可能不同）。
 */
function compareItems<M extends BaseMeta>(a: Parsed<M>, b: Parsed<M>): number {
  const c = b.meta.date.localeCompare(a.meta.date)
  return c !== 0 ? c : a.meta.slug.localeCompare(b.meta.slug)
}

/**
 * 扫描一个集合。
 *
 * ★ `tolerant = true`（dev）：坏文件**跳过**并把错误收进清单 ——
 *   dev server 绝不能因为一个写错的 frontmatter 就崩掉（异常发生在 watcher
 *   回调里，没有人 catch，作者得重启服务器才能继续）。
 * ★ `tolerant = false`（build）：**遇错即抛** —— 否则 CI 会放行一篇格式错误的内容。
 */
function scanCollection<M extends BaseMeta>(
  root: string,
  spec: CollectionSpec<M>,
  tolerant: boolean,
): { list: Parsed<M>[]; errors: string[] } {
  const tag = `[${spec.name}]`
  const dir = path.resolve(root, spec.dir)
  const errors: string[] = []
  const list: Parsed<M>[] = []
  if (!fs.existsSync(dir)) return { list, errors }

  const assets = buildAssetIndex(root)
  /* 排序：让「一次报完」的错误顺序稳定（readdirSync 的顺序依文件系统而定） */
  const files = fs.readdirSync(dir).sort()

  for (const f of files) {
    /* ★ 模板 / 草稿 / 编辑器临时文件：不进索引，也不报错 */
    if (isHidden(f)) continue
    if (!isMarkdown(f)) {
      if (looksLikeMarkdown(f)) {
        const msg =
          `${tag} ${f} 的扩展名不是 .md，${spec.label}系统不会收录它。\n` +
          `        请改名为 ${f.replace(/\.[^.]+$/, '')}.md`
        if (tolerant) errors.push(msg)
        else throw new Error(msg)
      }
      continue
    }
    try {
      list.push(parseContent(path.join(dir, f), assets, spec))
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!tolerant) throw e
      errors.push(msg)
      console.error('\n' + msg + '\n')
    }
  }

  /* ---- 排序 + slug 唯一性 ----
     ★ slug 重复会让路由撞车（两个 md 抢一个 URL）。dev 下**不抛异常**：
       保住「写错不崩服务」，保留先出现的那个、把冲突记进错误清单。 */
  list.sort(compareItems)
  const seen = new Map<string, Parsed<M>>()
  const unique: Parsed<M>[] = []
  for (const p of list) {
    const prev = seen.get(p.meta.slug)
    if (prev) {
      const msg =
        `${tag} slug 重复："${p.meta.slug}"（来自 ${path.basename(prev.file)} 与 ${path.basename(p.file)}）。\n` +
        `        slug 来自文件名去掉 YYYY-MM-DD- 前缀，必须唯一。`
      if (!tolerant) throw new Error(msg)
      errors.push(msg)
      continue
    }
    seen.set(p.meta.slug, p)
    unique.push(p)
  }

  return { list: unique, errors }
}

/**
 * 体检一个集合，**收集全部问题**而不是遇到第一个就停。
 *
 * ★ 为什么要有它：`scanCollection(…, false)` 是构建路径（遇错即抛，一次只报一条），
 *   而「写完一篇内容想知道还有没有别的问题」需要一次看全部。
 *   `scripts/check-content.mjs` 直接 import 它调用 —— **校验规则只有这一份**，
 *   不在 JS / bash 里重写第二套（两套规则迟早就走样）。
 *
 * ★ 模板也要合法：`_TEMPLATE.md` 不进索引，但仍会被解析一遍 ——
 *   模板自己写坏了（比如 date 写成占位符）同样应该在构建期被拦住。
 */
export function checkCollection<M extends BaseMeta>(
  root: string,
  spec: CollectionSpec<M>,
): CollectionReport<M> {
  const dir = path.resolve(root, spec.dir)
  const errors: string[] = []
  const items: Parsed<M>[] = []
  const templates: { file: string; ok: boolean }[] = []

  if (!fs.existsSync(dir)) {
    return { root, items: [], templates: [], errors: [`[${spec.name}] 目录不存在：${dir}`] }
  }

  const assets = buildAssetIndex(root)
  const files = fs.readdirSync(dir).sort()

  for (const f of files) {
    /* ---- 模板 / 草稿：不进索引，但要校验 ---- */
    if (isHidden(f)) {
      if (!isMarkdown(f)) continue
      try {
        parseContent(path.join(dir, f), assets, spec)
        templates.push({ file: f, ok: true })
      } catch (e) {
        templates.push({ file: f, ok: false })
        errors.push(`（模板 ${f}）${e instanceof Error ? e.message : String(e)}`)
      }
      continue
    }

    if (!isMarkdown(f)) {
      if (looksLikeMarkdown(f)) {
        errors.push(
          `[${spec.name}] ${f} 的扩展名不是 .md，${spec.label}系统不会收录它。\n` +
            `        请改名为 ${f.replace(/\.[^.]+$/, '')}.md`,
        )
      }
      continue
    }

    try {
      items.push(parseContent(path.join(dir, f), assets, spec))
    } catch (e) {
      errors.push(e instanceof Error ? e.message : String(e))
    }
  }

  /* ---- slug 唯一性：这里自己查一遍，好把**所有**冲突一次报出来 ---- */
  const bySlug = new Map<string, string[]>()
  for (const p of items) {
    const arr = bySlug.get(p.meta.slug) ?? []
    arr.push(path.basename(p.file))
    bySlug.set(p.meta.slug, arr)
  }
  for (const [slug, list] of bySlug) {
    if (list.length > 1) {
      errors.push(
        `[${spec.name}] slug 重复："${slug}"（来自 ${list.join(' 与 ')}）。\n` +
          `        slug 来自文件名去掉 YYYY-MM-DD- 前缀，必须唯一。`,
      )
    }
  }

  items.sort(compareItems)
  return { root, items: items.map((p) => p.meta), templates, errors }
}

/* ==========================================================================
   虚拟模块生成
   ========================================================================== */

/** 只把被引用过的图片写进 glob；一张都没有时给空对象最稳 */
function assetGlobExpr(usedKeys: string[]): string {
  return usedKeys.length > 0
    ? `import.meta.glob(${JSON.stringify(usedKeys)}, ` +
        `{ eager: true, query: '?url', import: 'default' })`
    : `({})`
}

/** 索引模块源码：**只含元数据，不含正文**（首屏只需要它） */
function indexSource<M extends BaseMeta>(
  spec: CollectionSpec<M>,
  parsed: Parsed<M>[],
  errors: string[],
): string {
  const metas = parsed.map((p) => p.meta)
  return [
    `/* 由 content-kit 生成（${spec.name}）—— 不要手改 */`,
    /* ★ 图片 URL 表：构建期解析出的 glob key → 打包后的真实 URL。
     *   eager:true 是**有意为之** —— 封面在列表页首屏就要用，
     *   而 eager 只是把 URL 字符串打进 JS，图片字节仍要等 <img> 用到才下载。
     *   ★ key 必须与引擎的 buildAssetIndex / resolveAsset 一致，否则查表落空。 */
    `export const assetUrls = ${assetGlobExpr(usedAssetKeys(parsed))}`,
    `export const ${spec.listName} = ${JSON.stringify(metas, null, 2)}`,
    ...(spec.indexExtras?.(metas) ?? []),
    `export const total = ${metas.length}`,
    /* ★ 构建期的问题清单。dev 下前端可以据此在页面上给出提示 ——
       作者不必盯着终端才知道某篇 md 写错了。生产构建时这个数组恒为空
       （因为 build 路径遇错直接抛，根本走不到这里）。 */
    `export const buildErrors = ${JSON.stringify(errors, null, 2)}`,
    `export default ${spec.listName}`,
  ].join('\n')
}

/** 懒加载模块源码：slug → 那一篇的正文 */
function mapSource<M extends BaseMeta>(spec: CollectionSpec<M>, parsed: Parsed<M>[]): string {
  const dir = spec.dir
  /* ★ 用 import.meta.glob 的 eager:false：每个 md 会成为一个独立 chunk，
   *   点进某一篇才下载它自己的正文。首屏不会带上全部内容。
   *   ★ `?raw` 拿原始文本（含 frontmatter），运行时再去掉头部。
   *   ★ 两条否定模式排除 `_`/`.` 开头的文件（`_TEMPLATE.md` 是模板）——
   *     否则 glob 会给模板也打一个 chunk 进产物。 */
  const glob =
    `['/${dir}/*.md', '!/${dir}/_*', '!/${dir}/.*']`
  return [
    `/* 由 content-kit 生成（${spec.name}）—— 不要手改 */`,
    `const loaders = import.meta.glob(` +
      `${glob}, { query: '?raw', import: 'default' })`,
    /* ★ 图片 URL 表与索引模块**同源同 key**：两边都用同一份 key 列表。 */
    `const assetUrls = ${assetGlobExpr(usedAssetKeys(parsed))}`,
    `const stripFrontmatter = (raw) =>`,
    `  String(raw).replace(/^---\\r?\\n[\\s\\S]*?\\r?\\n---\\r?\\n?/, '')`,
    `const slugOf = (p) => ${SLUG_OF_SRC}`,
    /* 每篇正文里出现过的图片引用 → glob key（构建期算好，直接内联） */
    `const refsBySlug = ${JSON.stringify(
      Object.fromEntries(parsed.map((p) => [p.meta.slug, p.assetRefs])),
    )}`,
    `export const slugs = Object.keys(loaders).map(slugOf)`,
    /**
     * 把正文里的图片相对路径换成打包后的真实 URL。
     * ★ 为什么在运行时做：正文是 `?raw` 原始文本，构建期改内存副本到不了页面；
     *   而 URL 只有打包完才知道（带 hash + base 前缀）。
     * ★ 替换按**长度倒序**，避免 `a.png` 抢先命中 `aa.png` 里的片段。
     */
    `function localizeImages(body, slug) {`,
    `  const refs = refsBySlug[slug]`,
    `  if (!refs) return body`,
    `  const keys = Object.keys(refs).sort((a, b) => b.length - a.length)`,
    `  let out = body`,
    `  for (const ref of keys) {`,
    `    const url = assetUrls[refs[ref]]`,
    `    if (!url) continue`,
    `    out = out.split('](' + ref).join('](' + url)`,
    `  }`,
    `  return out`,
    `}`,
    `export async function ${spec.loaderName}(slug) {`,
    `  for (const [p, fn] of Object.entries(loaders)) {`,
    `    if (slugOf(p) === slug) return localizeImages(stripFrontmatter(await fn()), slug)`,
    `  }`,
    `  return null`,
    `}`,
  ].join('\n')
}

/* ==========================================================================
   插件
   ========================================================================== */

/**
 * 给一个集合造 Vite 插件（每个集合一个，四个虚拟模块互不干扰）。
 *
 * ★★ dev / build 的差异只有一条：写错时 build **抛**、dev **容错跳过并提示**。
 *   见 `scanCollection()` 的注释。
 */
export function createCollectionPlugin<M extends BaseMeta>(spec: CollectionSpec<M>): Plugin {
  let root = process.cwd()
  let isBuild = false
  let parsed: Parsed<M>[] = []
  let errors: string[] = []

  const RESOLVED_INDEX = '\0' + spec.indexModule
  const RESOLVED_MAP = '\0' + spec.mapModule

  const refresh = () => {
    const out = scanCollection(root, spec, !isBuild)
    parsed = out.list
    errors = out.errors
  }

  return {
    name: `blog-${spec.name}`,

    configResolved(config: ResolvedConfig) {
      root = config.root
      /* ★ 用 command 而不是 mode 判断「是不是生产构建」：
       *   `vite build --mode development` 也是构建，行为应当一致。 */
      isBuild = config.command === 'build'
      refresh()
    },

    /* dev 下热更新：改任意 md / 换任意图片都重扫一遍，并让两个虚拟模块失效 */
    configureServer(server: ViteDevServer) {
      server.watcher.add(path.resolve(root, spec.dir))
      /* ★ 所有图片目录也要看：新加/换掉一张图后，assetRefs 必须重算，
         否则封面还是查不到 key（表现为「图放进去了但页面还是裂的」）。 */
      for (const d of ASSET_DIRS) server.watcher.add(path.resolve(root, d))
      const onChange = (file: string) => {
        if (!file.endsWith('.md') && !IMAGE_EXT.includes(path.extname(file).toLowerCase())) return
        refresh()
        const indexMod = server.moduleGraph.getModuleById(RESOLVED_INDEX)
        const mapMod = server.moduleGraph.getModuleById(RESOLVED_MAP)
        if (indexMod) server.moduleGraph.invalidateModule(indexMod)
        if (mapMod) server.moduleGraph.invalidateModule(mapMod)
        server.ws.send({ type: 'full-reload' })
      }
      server.watcher.on('add', onChange)
      server.watcher.on('change', onChange)
      server.watcher.on('unlink', onChange)
    },

    resolveId(id: string) {
      if (id === spec.indexModule) return RESOLVED_INDEX
      if (id === spec.mapModule) return RESOLVED_MAP
      return null
    },

    load(id: string) {
      if (id === RESOLVED_INDEX) return indexSource(spec, parsed, errors)
      if (id === RESOLVED_MAP) return mapSource(spec, parsed)
      return null
    },
  }
}
