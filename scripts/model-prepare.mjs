/**
 * 3D 模型预处理（`npm run model:prepare -- <源文件.glb>`）。
 *
 * ★ 这个脚本的存在意义：**模型是唯一能一口吃掉首屏预算的东西**。
 *   一个没压过的 Sketchfab 下载动辄 20–60 MB，压完通常 0.3–1.5 MB ——
 *   差别不是「优化一下」，是「能不能上线」。所以流程写成一条命令，
 *   并且**压完立刻按 scripts/budget.mjs 里那条硬门槛（1.5 MB raw）判定**，
 *   超了直接退出码 1，不给「先提交上去回头再说」的机会。
 *
 * 用法：
 *   npm run model:prepare -- ~/Downloads/scene.glb            # 压到 public/models/scene.glb
 *   npm run model:prepare -- scene.glb --name hero            # 自己定输出名
 *   npm run model:prepare -- scene.glb --inspect              # 只看报告，不压
 *   npm run model:prepare -- scene.glb --compress draco       # 换压缩器
 *   npm run model:prepare -- scene.glb --flags "--simplify false"
 *
 * ★ 为什么默认用 **meshopt** 而不是 draco：
 *   draco 压得更狠（同模型通常再小 10–20%），但运行时要下载 ~300 KB 的
 *   wasm 解码器（还得自托管或吃 CDN），meshopt 的解码器约 25 KB。
 *   对一个「首屏 70 KB gz」的站，解码器多出来的 275 KB 比模型本身还贵。
 *   ★ 注意（2026-10-08）：本仓库现在**没有装 three**（2026-10-06 随 3D 删除），
 *   所以「three 自带解码器」这条便利暂时不存在 —— 真要上模型时再装回来，
 *   解码器路径在 `node_modules/three/examples/jsm/libs/`。
 *   真要极限压缩：`--compress draco` + 自托管 draco 解码器目录。
 *
 * ★ 依赖不进 package.json：CLI 装在全局或按需 npx 拉起，只有真正要压模型时才需要。
 *   本机装不上（多数是 sharp 的二进制拉不下来）时脚本会给出国内镜像的解法。
 */
import { existsSync, statSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, extname, join, resolve } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name, def = null) => {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : def
}
const has = (name) => argv.includes('--' + name)

/** 与 scripts/budget.mjs 的 CAP.binaryRaw 保持一致（那里是闸门，这里是操作时的即时反馈） */
const BINARY_RAW_MAX = 1.5 * 1024 * 1024
/** 真正推荐的目标值：超过它就该考虑减面/减材质，而不是继续调压缩参数 */
const BINARY_RAW_TARGET = 1.0 * 1024 * 1024

const kb = (n) => (n / 1024).toFixed(n < 1024 * 1024 ? 0 : 2)
const src = argv.find((a) => !a.startsWith('--') && !a.endsWith('.mjs'))
if (!src) {
  console.error('用法：npm run model:prepare -- <源文件.glb> [--name hero] [--inspect] [--compress meshopt]')
  process.exit(2)
}
if (!existsSync(src)) {
  console.error(`✗ 找不到输入文件：${src}`)
  process.exit(2)
}
const ext = extname(src).toLowerCase()
if (ext !== '.glb' && ext !== '.gltf') {
  console.error(`✗ 只认 .glb / .gltf（给的是 ${ext || '无扩展名'}）。其它格式先用 Blender 导出 glTF。`)
  process.exit(2)
}

const srcBytes = statSync(src).size
console.log(`源文件  ${basename(src)}  ${kb(srcBytes)} KB`)
if (srcBytes > BINARY_RAW_MAX && !has('inspect')) {
  console.log('  ⚠ 已经超过 1.5 MB 硬门槛 —— 压完还是这么大就得回去减面/减材质/换 1K 贴图。')
}

/* 找 CLI：先 PATH，再退回 npx（npx 会现下，网络差时很慢，所以先提示） */
function findCli() {
  const probe = spawnSync('npx', ['--no-install', 'gltf-transform', '--version'], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  })
  return probe.status === 0
}
const standalone = spawnSync('gltf-transform', ['--version'], {
  encoding: 'utf8',
  shell: process.platform === 'win32',
})
const cliPrefix = standalone.status === 0 ? ['gltf-transform'] : findCli() ? ['npx', '--no-install', 'gltf-transform'] : null

if (!cliPrefix) {
  console.error(
    [
      '',
      '✗ 没找到 gltf-transform CLI。装一个（全局），再重跑本脚本：',
      '',
      '    npm install --global @gltf-transform/cli',
      '',
      '  国内装不上多半是 sharp 的二进制拉不下来，加两行镜像再装：',
      '',
      '    npm config set sharp_binary_host "https://npmmirror.com/mirrors/sharp"',
      '    npm config set sharp_libvips_binary_host "https://npmmirror.com/mirrors/sharp-libvips"',
      '    npm install --global @gltf-transform/cli',
      '',
      '  文档：https://gltf-transform.dev/cli',
    ].join('\n'),
  )
  process.exit(2)
}

const run = (args) => {
  console.log('\n$ ' + [...cliPrefix, ...args].join(' '))
  const r = spawnSync(cliPrefix[0], [...cliPrefix.slice(1), ...args], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })
  return r.status ?? 1
}

if (has('inspect')) {
  process.exit(run(['inspect', src]))
}

const name = flag('name', basename(src, ext))
const outDir = flag('out', join('public', 'models'))
const out = join(outDir, `${name}.glb`)
mkdirSync(resolve(outDir), { recursive: true })

/* ★ 参数就是官方文档里那条示例，只把压缩器换成默认的 meshopt。
   想细调先看 `gltf-transform optimize -h`，再走 --flags 追加。 */
const compress = flag('compress', 'meshopt')
const extra = flag('flags', '')
const args = [
  'optimize',
  src,
  out,
  '--compress',
  compress,
  '--texture-compress',
  'webp',
  ...(extra ? extra.split(' ').filter(Boolean) : []),
]
const status = run(args)
if (status !== 0) {
  console.error('\n✗ 压缩失败（退出码 ' + status + '）。把上面 CLI 的报错读完再重试。')
  process.exit(status)
}
if (!existsSync(out)) {
  console.error('✗ CLI 报成功但没生成 ' + out)
  process.exit(1)
}

const outBytes = statSync(out).size
const ratio = ((1 - outBytes / srcBytes) * 100).toFixed(0)
console.log(
  `\n结果  ${out}  ${kb(outBytes)} KB  （从 ${kb(srcBytes)} KB 压掉 ${ratio}%）`,
)
console.log(`      线上 URL：/${out.split('\\').join('/').replace(/^public\//, '')}`)

/* 闸门：与 npm run budget:check 同一条线 */
if (outBytes > BINARY_RAW_MAX) {
  console.error(
    `\n✗ ${kb(outBytes)} KB 超过 1.5 MB 硬门槛 —— npm run budget:check 会红。` +
      `\n  下一步：减面（--flags "--simplify true"）、贴图降到 1K、或删掉用不到的部件。`,
  )
  process.exit(1)
}
if (outBytes > BINARY_RAW_TARGET) {
  console.log(`  ⚠ 超过 1 MB 的目标值（门槛仍是 1.5 MB）—— 还能再瘦一点。`)
}

console.log(
  [
    '',
    '接下来（见 AGENTS.md 的「3D 资产」一节）：',
    '  ① 拍一张 poster（首屏占位图），放 public/models/ 旁边，比如 ' + name + '-poster.webp',
    '  ② 在需要的组件里动态 import three 并挂载（url 指向上面的 URL）—— 旧的 DeferredStage 管线已在 2026-10-08 大清洗里删掉，',
    '     真要延迟加载大资产，先写一个会 warm 的包装组件，别把 three 拉进首屏',
    '  ③ 跑 npm run budget:check 确认首屏没有变胖（首屏 ≤ 88 KB gz）',
  ].join('\n'),
)
