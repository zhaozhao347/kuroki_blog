import { createApp } from 'vue'

// 字体：本地打包，不依赖外网 CDN
import '@fontsource-variable/inter'
import '@fontsource-variable/jetbrains-mono'
import '@fontsource/anton'
/* 歌词层专用衬线（hero 的三句歌词，见 components/LyricStage.vue）。
 * ★ 只引 **latin / 500 / italic** 这一子集：完整 Cormorant Garamond 有 9 个字重 ×
 *   3 种字形 × 6 个子集，全引会是几 MB。中文交给 `--font-lyric` 的兜底字体。
 * ★ 这个文件只在页面里真有元素用到该字族时才会下载 —— 歌词层是播放后才出现的，
 *   所以它**不进首屏关键路径**（`npm run budget` 的首屏 88 KB 门槛不受影响）。 */
import '@fontsource/cormorant-garamond/latin-500-italic.css'

import './style.css'
import App from './App.vue'
import router from './router'
import { vReveal } from './directives/reveal'
import { vMagnetic } from './directives/magnetic'
import { vImgFallback } from './directives/imgFallback'

/** 应用入口
 *
 * ★ 目前是**纯静态站**：没有后端、没有全局状态。
 *   所以这里不装 Pinia，也不注册 axios 相关的东西。
 *   （曾经有 src/api、src/stores、src/types，已在收尾时删除。）
 *   以后真接后端时再加 createPinia() 与 api 层即可。 */

/* ★★ 处理 GitHub Pages 的深链接回跳。
 *
 *   Pages 没有服务端路由：直接访问 /articles/hello 会命中 404.html，
 *   而 404.html 会把路径塞进 `?redirect=<原路径>` 回到 index.html
 *   （见 public/404.html）。
 *   这里把它读出来、`replaceState` 成正常 URL，**必须在 mount 之前**
 *   —— 否则 router 已经按 `/?redirect=...` 匹配过了，会先闪一下 404 页。
 *
 *   本地开发（vite dev/preview）本来就是 SPA 回退，这段代码不会触发。 */
const params = new URLSearchParams(window.location.search)
const redirect = params.get('redirect')
if (redirect && redirect.startsWith('/')) {
  /* 用 replace 而不是 push：不要在历史里留一条 `/?redirect=...` */
  window.history.replaceState(null, '', redirect)
}

const app = createApp(App)

app.use(router)
app.directive('reveal', vReveal)
app.directive('magnetic', vMagnetic)
app.directive('img-fallback', vImgFallback)
app.mount('#app')
