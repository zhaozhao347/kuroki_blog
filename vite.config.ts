import { fileURLToPath, URL } from 'node:url'

import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vite'

/* ★ 必须带 `.js` 后缀：tsconfig.node.json 用的是 node16 模块解析，
   相对导入要求显式扩展名（TS2835）。这里写 .js 但实际解析到 .ts —— 
   这是 Node 的 ESM 约定，Vite 自己也是这么加载 config 的。 */
import postsPlugin from './vite-plugin-posts.js'
/* 项目插件：和文章共用 `content-kit.ts` 引擎，只是换了一份 spec
   （目录 content/projects/、必填字段 title/date/summary、多 role/link）。
   两边各生成一对虚拟模块：virtual:posts{,-map} / virtual:projects{,-map}。 */
import projectsPlugin from './vite-plugin-projects.js'
/* 页面插件：同一套 content-kit 引擎，扫的是 content/pages/。
   页面（关于、将来的友链…）没有分类、摘要可省，文件名也不带日期前缀。 */
import pagesPlugin from './vite-plugin-pages.js'
/* 边缘函数：站点不打包音频、浏览量要外部计数、Steam 要 key，三件事都由
   `workers/api/` 那个 Worker 提供（/music、/views、/steam）。
   这个插件只在 **dev** 下把**同一份**实现挂成中间件，
   于是本地不部署 Cloudflare 也能听歌、也能看到计数器在涨。理由见文件头注释。 */
import apiDevProxy from './plugins/vite-plugin-api-proxy.js'

// https://vite.dev/config/
export default defineConfig({
  plugins: [vue(), postsPlugin(), projectsPlugin(), pagesPlugin(), apiDevProxy()],

  /* ★ `base` 决定资源路径前缀。
   *
   *   本地开发要 '/'；部署到 GitHub Pages 的**项目页**
   *   （https://<user>.github.io/<repo>/）需要 '/<repo>/'，
   *   否则 css/js 会 404、页面白屏。
   *
   *   由 CI 通过环境变量 BASE_PATH 传入 —— 本地不设时走默认 '/'，
   *   所以开发体验完全不受影响。
   *   ★ 注意 Vite 要求 base 以 '/' 开头和结尾（'./' 是另一种相对写法）。 */
  base: process.env.BASE_PATH || '/',
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    /* ★ 曾经有一条 `/api` → http://127.0.0.1:8000 的代理，用于联调 FastAPI。
       目前是纯静态站、没有后端，所以已移除。
       接后端时加回来即可：
         proxy: { '/api': { target: 'http://127.0.0.1:8000', changeOrigin: true } } */
  },
})
