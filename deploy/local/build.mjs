#!/usr/bin/env node
/**
 * 内网版构建。
 *
 * 和线上是**同一份源码**，只把「外网依赖」全关掉：
 *   BASE_PATH=/          根路径（nginx 直接挂在站点根上）
 *   VITE_OFFLINE=1       浏览量 / Steam / 网易云镜像 一律不发请求
 *   VITE_MUSIC_BASE=?    可选。配了就走静态音频目录（如 /music/），不配就没有歌
 *
 * 用法：
 *   node deploy/local/build.mjs
 *   VITE_MUSIC_BASE=/music/ node deploy/local/build.mjs      # 想放本地 mp3 时
 *
 * 产物和 `npm run build` 一样在 dist/，直接拷到 nginx 的 root 即可。
 */
import { spawnSync } from 'node:child_process'

const env = {
  ...process.env,
  BASE_PATH: '/',
  VITE_OFFLINE: '1',
}

/* 直接用 node 跑本地的 bin，而不是 `npm run build`：
   Windows 上 spawn 一个 .cmd 必须开 shell，Node 会警告 DEP0190（参数不转义）。
   等价于 `npm run build` = `vue-tsc -b && vite build`。 */
const run = (args) => {
  const res = spawnSync(process.execPath, args, { stdio: 'inherit', env })
  if (res.error) {
    console.error('构建失败：', res.error.message)
    process.exit(1)
  }
  if (res.status !== 0) process.exit(res.status ?? 1)
}

run(['node_modules/vue-tsc/bin/vue-tsc.js', '-b'])
run(['node_modules/vite/bin/vite.js', 'build'])

console.log('\n内网版已构建 → dist/')
console.log('  · 浏览量 / Steam / 网易云 全部不发请求（VITE_OFFLINE=1）')
console.log('  · 下次发布：bash deploy/local/install.sh')
