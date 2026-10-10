#!/usr/bin/env node
/**
 * 内容体检 —— 构建期校验的命令行入口（文章 + 项目共用）
 *
 * ── 为什么要有它（构建期已经会拦了）──
 *   `vite-plugin-posts.ts` / `vite-plugin-projects.ts` 在 `npm run build` 时会直接抛异常，
 *   但它是**遇到第一个错误就停**，而且要在 vue-tsc + vite 之后才跑到。
 *   写内容时想要的是：一次性看到**所有**问题、而且别等整个构建。
 *   所以这里直接调用插件导出的 `checkPosts()` / `checkProjects()` ——
 *   **校验规则只有 `content-kit.ts` 那一份**，不在 JS / bash 里重写第二套
 *   （两套规则迟早会走样）。
 *
 * ── 怎么做到「直接 import .ts」──
 *   Node ≥ 22.18 原生支持类型擦除（type stripping），可以直接 import
 *   `../vite-plugin-posts.ts`。两个插件只依赖 node:fs / node:path / js-yaml，
 *   类型导入（`import type … from 'vite'`）会被擦掉，所以不需要打包。
 *
 * ── 2026-10-07 改名 ──
 *   原来是 `scripts/check-posts.mjs`（只查文章）。项目板块改成 md 驱动之后
 *   两边的检查合成一个入口，免得「文章一份脚本、项目再抄一份」。
 *
 * 用法：
 *   node scripts/check-content.mjs                  # 文章 + 项目
 *   node scripts/check-content.mjs --only=posts     # 只查文章
 *   node scripts/check-content.mjs --only=projects  # 只查项目
 *   node scripts/check-content.mjs --json           # 机器可读（CI / 编辑器）
 *
 * 退出码：0 = 全部通过，1 = 有问题，2 = 环境/参数不对
 */
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const JSON_OUT = process.argv.includes('--json')
const onlyArg = process.argv.find((a) => a.startsWith('--only='))
const ONLY = onlyArg ? onlyArg.slice('--only='.length) : ''

/* ---- 引入校验器：Node < 22.18 会以「不认识的扩展名」失败，给一句人话 ---- */
let checkPosts
let checkProjects
let checkPages
try {
  ;({ checkPosts } = await import('../vite-plugin-posts.ts'))
  ;({ checkProjects } = await import('../vite-plugin-projects.ts'))
  ;({ checkPages } = await import('../vite-plugin-pages.ts'))
} catch (err) {
  const msg = String(err?.message ?? err)
  if (/Unknown file extension|ERR_UNKNOWN_FILE_EXTENSION|Unknown module/.test(msg)) {
    console.error(
      `\n✗ 当前 Node（${process.version}）不能直接 import .ts 文件。\n` +
        `  本项目要求 Node ≥ 22.18（依赖原生类型擦除跑构建期校验）。\n` +
        `  升级后重试，或改用 \`npm run build\`（插件本身也会校验，只是错误会一次报一条）。\n`,
    )
    process.exit(2)
  }
  throw err
}

/**
 * 三个集合的体检配置。
 * ★ 「额外一列」和「跨度」的差别就在这里，其余全部共用。
 */
const ALL = [
  {
    name: 'posts',
    label: '文章',
    dir: 'content/posts',
    unit: '篇',
    check: checkPosts,
    /** 表格里的额外一列 */
    column: { head: '分类', of: (m) => m.category ?? '—' },
    /** 没有标签时提醒一句（项目根本没有标签，不提醒） */
    warnUntagged: true,
    /** 日期跨度按 `YYYY-MM` 收 */
    span: { label: '月份', len: 7, unit: '个月' },
  },
  {
    name: 'projects',
    label: '项目',
    dir: 'content/projects',
    unit: '个',
    check: checkProjects,
    /* ★ 项目没有标签、也没有额外列（用户 m13371：项目只需要
       年份 / 大标题 / 小标题 / 图片）—— 这张表就剩 slug + 日期。 */
    column: null,
    warnUntagged: false,
    span: { label: '年份', len: 4, unit: '年' },
  },
  {
    /* 页面（关于…）：文件名不带日期前缀，也不按时间读；
       额外一列显示页眉小字（eyebrow），日期跨度只是顺带统计。 */
    name: 'pages',
    label: '页面',
    dir: 'content/pages',
    unit: '个',
    check: checkPages,
    column: { head: '页眉', of: (m) => m.eyebrow || '—' },
    warnUntagged: false,
    span: { label: '月份', len: 7, unit: '个月' },
  },
]

const selected = ONLY ? ALL.filter((c) => c.name === ONLY) : ALL
if (!selected.length) {
  console.error(
    `\n✗ 不认识的 --only=${ONLY}（可选：${ALL.map((c) => c.name).join(' / ')}）\n`,
  )
  process.exit(2)
}

/* ---- 跑校验 ---- */
const results = selected.map((col) => ({ col, report: col.check(ROOT) }))
const allErrors = results.flatMap((r) => r.report.errors)

/* ---- 小工具：中文是双宽字符，padEnd 会错位 → 按显示宽度补空格 ---- */
const WIDE =
  /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/
const visWidth = (s) => [...s].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0)
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - visWidth(s)))
const tally = (values) => {
  const m = new Map()
  for (const v of values) m.set(v, (m.get(v) ?? 0) + 1)
  return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/** 每个集合的汇总数据（人类可读与 --json 共用一份，避免两处算得不一样） */
const summaries = results.map(({ col, report }) => {
  const items = report.items ?? []
  const spans = [...new Set(items.map((m) => m.date.slice(0, col.span.len)))].sort()
  return {
    name: col.name,
    label: col.label,
    dir: col.dir,
    unit: col.unit,
    column: col.column ? col.column.of : null,
    columnHead: col.column ? col.column.head : null,
    spanLabel: col.span.label,
    spanUnit: col.span.unit,
    total: items.length,
    items,
    tags: tally(items.flatMap((m) => m.tags ?? [])),
    span: spans.length ? { from: spans[0], to: spans[spans.length - 1], count: spans.length } : null,
    untagged: col.warnUntagged ? items.filter((m) => !(m.tags ?? []).length).map((m) => m.slug) : [],
    templates: report.templates,
    errors: report.errors,
  }
})

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        ok: allErrors.length === 0,
        root: ROOT,
        collections: Object.fromEntries(summaries.map((s) => [s.name, s])),
        errors: allErrors,
      },
      null,
      2,
    ),
  )
  process.exit(allErrors.length ? 1 : 0)
}

/* ---- 人类可读报告 ---- */
const W = 30
const line = (s = '') => process.stdout.write(s + '\n')

for (const s of summaries) {
  line('')
  line(`${s.label}体检 · ${s.dir}`)
  line('')

  /* ★ 列是**按集合**拼的：项目没有额外列、也没有标签（那张表就剩 slug + 日期）。
     写死列宽的话，项目表会多出一列空的「标签」。 */
  const hasCol = Boolean(s.columnHead)
  const hasTags = s.tags.length > 0

  if (s.items.length) {
    line(
      `  ${pad('slug', W)}${pad('日期', 12)}${hasCol ? pad(s.columnHead, 14) : ''}${hasTags ? '标签' : ''}`,
    )
    line('  ' + '─'.repeat(W + 12 + (hasCol ? 14 : 0) + (hasTags ? 20 : 0)))
    for (const m of s.items) {
      const tags = (m.tags ?? []).map((t) => `#${t}`).join(' ') || '—'
      line(
        `  ${pad(m.slug, W)}${pad(m.date, 12)}${hasCol ? pad(s.column(m), 14) : ''}${hasTags ? tags : ''}`,
      )
    }
    line('')
  }

  line(`  ${s.label} ${s.total} ${s.unit}`)
  if (s.span) line(`  ${s.spanLabel} ${s.span.from} → ${s.span.to}（${s.span.count} ${s.spanUnit}）`)
  if (hasTags) line(`  标签 ${s.tags.map(([n, c]) => `#${n} ${c}`).join(' · ')}`)

  for (const t of s.templates) line(`  模板 ${t.file} ${t.ok ? '✓' : '✗'}`)

  if (s.untagged.length) {
    line('')
    line(`  ⚠ ${s.untagged.length} ${s.unit}没有标签：${s.untagged.join('、')}`)
    line('    标签是给人筛的短词，建议每条补 2–4 个（tags: [前端, CSS]）。')
  }
}

if (allErrors.length) {
  line('')
  line(`✗ 发现 ${allErrors.length} 个问题：`)
  allErrors.forEach((e, i) => {
    line('')
    line(`  ${i + 1}) ${e}`)
  })
  line('')
  process.exit(1)
}

line('')
line('✓ 全部通过')
line('')
