#!/usr/bin/env node
/**
 * 从模板生成一篇新文章
 *
 * 用法：
 *   npm run new:post -- <slug> "标题" [分类] [tag1,tag2]
 *
 * 例：
 *   npm run new:post -- css-2026 "2026 年的 CSS" 前端工程 CSS,前端
 *
 * 产出：`content/posts/<今天>-<slug>.md`
 *   · 日期取**今天**（本地时区）—— 文件名里的日期只贡献 slug，
 *     真正的排序依据是 frontmatter 的 date，两者保持一致最不容易混
 *   · 模板里的「字段速查」一节会被删掉，只留干净的正文骨架
 *   · 不覆盖已存在的文件（任何日期前缀下同名都算存在）
 *
 * ★ 模板本身（`_TEMPLATE.md`）也会被 `check-content.mjs` 校验，
 *   所以「模板写坏了」同样会在构建期被拦住。
 */
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const POSTS_DIR = path.join(ROOT, 'content', 'posts')
const TEMPLATE = path.join(POSTS_DIR, '_TEMPLATE.md')

const argv = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const [slug, title, category = '随笔', tagList = ''] = argv

function usage(exitCode) {
  const out = exitCode ? console.error : console.log
  out(
    '\n用法：npm run new:post -- <slug> "标题" [分类] [tag1,tag2]\n' +
      '\n例：  npm run new:post -- css-2026 "2026 年的 CSS" 前端工程 CSS,前端\n' +
      '\n说明：\n' +
      '  slug      英文小写、用 - 连接（进 URL，改起来麻烦，起好一点）\n' +
      '  标题      中文标题，写进 frontmatter 的 title\n' +
      '  分类      可选，默认「随笔」；写个新的就会自动出现在列表页筛选里\n' +
      '  标签      可选，逗号分隔；≤8 个、每个 ≤24 字\n',
  )
  process.exit(exitCode)
}

if (!slug || !title) usage(1)

if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) {
  console.error(
    `\n✗ slug "${slug}" 不合法：只能用英文小写、数字和 -（且不能以 - 开头）。\n` +
      `  例：css-2026 / my-first-post\n`,
  )
  process.exit(1)
}

if (!fs.existsSync(TEMPLATE)) {
  console.error(`\n✗ 找不到模板：${TEMPLATE}\n  模板是新增文章的起点，请先恢复它。\n`)
  process.exit(1)
}

/* ---- 同名文章已存在？（任何日期前缀都算） ---- */
const existing = fs
  .readdirSync(POSTS_DIR)
  .filter((f) => f.endsWith(`-${slug}.md`) || f === `${slug}.md`)
if (existing.length) {
  console.error(`\n✗ 已经有一篇同 slug 的文章：${existing.join('、')}\n  换个 slug，或直接编辑那一篇。\n`)
  process.exit(1)
}

/* ---- 今天（本地时区，补零） ---- */
const now = new Date()
const pad = (n) => String(n).padStart(2, '0')
const today = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`

/* ---- 渲染 ---- */
let text = fs.readFileSync(TEMPLATE, 'utf8')

text = text.replace(/^title:.*$/m, `title: ${title}`)
text = text.replace(/^date:.*$/m, `date: ${today}`)
text = text.replace(/^category:.*$/m, `category: ${category}`)

const tags = tagList
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)
if (tags.length) {
  text = text.replace(/^tags:.*$/m, `tags: [${tags.join(', ')}]`)
} else {
  /* 没给标签就把占位行整行删掉（tags 是可选的，别留「标签一」这种假数据） */
  text = text.replace(/^tags:.*\n/m, '')
}

/* ---- 删掉模板末尾的「字段速查」一节（那是给作者看的，不是正文） ---- */
text = text.replace(/\n#{1,6}\s*字段速查[\s\S]*$/, '\n')

const file = path.join(POSTS_DIR, `${today}-${slug}.md`)
fs.writeFileSync(file, text, 'utf8')

const rel = path.relative(ROOT, file).replace(/\\/g, '/')
console.log(
  `\n✓ 已创建 ${rel}\n` +
    `  分类：${category}${tags.length ? `　标签：${tags.map((t) => '#' + t).join(' ')}` : '　（没写标签，tags 是可选的）'}\n` +
    `\n下一步：写正文，然后跑一次体检\n` +
    `  npm run check:posts\n`,
)
