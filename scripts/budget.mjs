/**
 * 体积预算体检（`npm run budget` / `npm run budget:check`）。
 *
 * ★ 为什么要单独一个脚本：这个站最容易被无声拖垮的是**首屏字节数**。
 *   加一个 3D 模型、换一张大图、多引一个库，构建照样成功、页面照样能开，
 *   只是首屏悄悄多几百 KB —— 只有把数字量出来并且**设成硬门槛**，
 *   这种退化才会在 `npm run check` 里当场红掉。
 *
 * 数据来源全部是 `dist/`（必须先 `npm run build`）：
 *   ① 首屏成本 = index.html 里直接引用的 js/css（浏览器冷启动的阻塞字节）
 *   ② 全产物排行 + 按类型合计
 *   ③ `--check`：三条硬门槛，超了退出码 1
 *
 * 用法：
 *   npm run build && node scripts/budget.mjs          # 只看数字
 *   node scripts/budget.mjs --check                   # 当门槛用（CI）
 *   node scripts/budget.mjs --json                    # 给别的工具吃
 */
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'

const dist = 'dist'
const args = process.argv.slice(2)
const check = args.includes('--check')
const json = args.includes('--json')

/**
 * 三条硬门槛。定在「今天实测值 + 余量」，不是拍脑袋的理想值：
 * 首屏 70 KB gz → 门槛 88 KB（+25%），单个 chunk 最大 74 KB gz → 150 KB，
 * 模型 1.5 MB raw。改门槛要连着这里的注释一起改，说明为什么。
 */
const CAP = {
  /** 首屏 js+css 的 gzip 合计 */
  firstLoadGz: 88 * 1024,
  /** 单个 js/css chunk 的 gzip 上限（今天最大是 ArticleDetailView 74 KB） */
  chunkGz: 150 * 1024,
  /** 单个 3D/大二进制资产的 raw 上限（目标 1 MB，硬顶 1.5 MB） */
  binaryRaw: 1.5 * 1024 * 1024,
}

/** 大二进制资产（模型、纹理、环境贴图）—— 单独一条门槛，gzip 对它们没意义 */
const BINARY_EXT = ['.glb', '.gltf', '.bin', '.ktx2', '.basis', '.hdr', '.exr', '.drc']
/** 首屏/单块门槛只管代码，图片字体不在此列（图片有 lazy 与 unicode-range 兜着） */
const CODE_EXT = ['.js', '.css']

const kb = (n) => Math.round(n / 1024)

function walk(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
  )
}

if (!existsSync(dist)) {
  console.error('✗ 没有 dist/ —— 先跑 `npm run build`（或直接用 `npm run check`）')
  process.exit(2)
}

/* ---------- ① 首屏成本 ---------- */
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
  .map((m) => m[1])
  .filter((u) => u.startsWith('/') && /\.(js|css)$/.test(u))

const firstLoad = []
let firstRaw = 0
let firstGz = 0
for (const r of new Set(refs)) {
  const f = join(dist, r.replace(/^\//, ''))
  if (!existsSync(f)) {
    console.error('✗ index.html 引用了不存在的文件：' + r)
    process.exit(2)
  }
  const b = readFileSync(f)
  const g = gzipSync(b, { level: 9 })
  firstRaw += b.length
  firstGz += g.length
  firstLoad.push({ file: r, raw: b.length, gz: g.length })
}

/* ---------- ② 全产物 ---------- */
const all = walk(dist).map((f) => {
  const b = readFileSync(f)
  return {
    file: f.slice(dist.length + 1).split('\\').join('/'),
    ext: f.slice(f.lastIndexOf('.')).toLowerCase(),
    raw: b.length,
    gz: gzipSync(b, { level: 9 }).length,
  }
})

const bucket = {}
for (const x of all) {
  const kind =
    x.ext === '.js' ? 'js'
    : x.ext === '.css' ? 'css'
    : /^\.(woff2?|ttf|otf)$/.test(x.ext) ? 'font'
    : /^\.(avif|webp|png|jpe?g|gif|svg)$/.test(x.ext) ? 'image'
    : /^\.(mp3|m4a|ogg|wav)$/.test(x.ext) ? 'audio'
    : BINARY_EXT.includes(x.ext) ? 'model'
    : 'other'
  const b = (bucket[kind] ??= { n: 0, raw: 0, gz: 0 })
  b.n += 1
  b.raw += x.raw
  b.gz += x.gz
}

/* ---------- ③ 门槛 ---------- */
const problems = []
if (firstGz > CAP.firstLoadGz) {
  problems.push(
    `首屏 js+css 合计 ${kb(firstGz)} KB gz，超过门槛 ${kb(CAP.firstLoadGz)} KB`,
  )
}
for (const x of all) {
  if (CODE_EXT.includes(x.ext) && x.gz > CAP.chunkGz) {
    problems.push(`单个 chunk ${x.file} 达 ${kb(x.gz)} KB gz，超过门槛 ${kb(CAP.chunkGz)} KB`)
  }
  if (BINARY_EXT.includes(x.ext) && x.raw > CAP.binaryRaw) {
    problems.push(
      `大二进制资产 ${x.file} 达 ${kb(x.raw)} KB raw，超过门槛 ${kb(CAP.binaryRaw)} KB` +
        `（先压：npm run model:prepare -- <源文件>）`,
    )
  }
}

if (json) {
  console.log(
    JSON.stringify(
      {
        firstLoad: { raw: firstRaw, gz: firstGz, files: firstLoad },
        byKind: bucket,
        largest: all.slice().sort((a, b) => b.gz - a.gz).slice(0, 14),
        caps: CAP,
        problems,
      },
      null,
      2,
    ),
  )
} else {
  console.log('===== ① 首屏成本（index.html 直接引用的 js/css）=====')
  for (const x of firstLoad) {
    console.log(`  ${String(kb(x.raw)).padStart(5)} KB raw | gz ${String(kb(x.gz)).padStart(4)} KB  ${x.file}`)
  }
  console.log(`  ---- 合计 ${kb(firstRaw)} KB raw / gzip ${kb(firstGz)} KB`)

  console.log('\n===== ② 单块最大（gzip 排行，前 14）=====')
  for (const x of all.slice().sort((a, b) => b.gz - a.gz).slice(0, 14)) {
    console.log(`  ${String(kb(x.raw)).padStart(6)} KB raw | gz ${String(kb(x.gz)).padStart(4)} KB  ${x.file}`)
  }

  console.log('\n===== ③ 按类型合计 =====')
  for (const [k, v] of Object.entries(bucket).sort((a, b) => b[1].gz - a[1].gz)) {
    console.log(`  ${k.padEnd(6)} ${String(v.n).padStart(3)} 个  gz ${String(kb(v.gz)).padStart(5)} KB`)
  }

  console.log('\n===== 门槛 =====')
  console.log(
    `  首屏 js+css ≤ ${kb(CAP.firstLoadGz)} KB gz（现在 ${kb(firstGz)}）· ` +
      `单块 ≤ ${kb(CAP.chunkGz)} KB gz · 大二进制 ≤ ${kb(CAP.binaryRaw)} KB raw`,
  )
}

if (problems.length > 0) {
  if (!json) {
    console.log('\n✗ 预算超了：')
    for (const p of problems) console.log('  · ' + p)
  }
  process.exit(1)
}
if (!json) console.log('\n✓ 预算通过')
