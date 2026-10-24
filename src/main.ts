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

/* ★★ 处理 GitHub Pages 的深链接回跳（兜底，规则与 index.html 里那段完全一致）。
 *
 *   Pages 没有服务端路由：直接访问 /articles/hello 会命中 404.html，
 *   而 404.html 会把路径塞进 `?redirect=<原路径>` 回到 index.html
 *   （见 public/404.html）。
 *
 *   ★★ 真正起作用的是 `index.html` <head> 里那段**内联脚本** —— 这段代码其实
 *      跑得太晚了：`import router from './router'` 是 ES 模块，会在本文件函数体
 *      之前求值，`createWebHistory()` 一被调用就把 location 记成 `/`；随后 router
 *      初始化会 replaceState 回 `?redirect=…`，把这里刚改好的地址又写回去
 *      （实测：`location.href` 从 /about 被改回 `?redirect=%2Fabout`，页面留在首页）。
 *      保留这段只为兜底（例如内联脚本被 CSP 拦掉、或页面被别的容器注入）。
 *
 *   ★★ 校验必须严格（`//host`、`/\host` 都能跳出站）：微信把这个站判成
 *      「存在 XSS/开放重定向」，唯一可注入的点就是 `?redirect=`。 */
function safeRedirectPath(raw: string | null): string | null {
  if (!raw || raw.length > 300) return null
  if (raw.charAt(0) !== '/' || raw.charAt(1) === '/') return null
  if (/[\\\u0000-\u001f\u007f]/.test(raw)) return null
  try {
    const u = new URL(raw, window.location.origin)
    return u.origin === window.location.origin ? u.pathname + u.search + u.hash : null
  } catch {
    return null
  }
}

const redirect = safeRedirectPath(new URLSearchParams(window.location.search).get('redirect'))
if (redirect) {
  /* 用 replace 而不是 push：不要在历史里留一条 `/?redirect=...` */
  try {
    window.history.replaceState(null, '', redirect)
  } catch {
    /* 改不动就留着原地址，别让整个应用挂掉 */
  }
}

const app = createApp(App)

app.use(router)
app.directive('reveal', vReveal)
app.directive('magnetic', vMagnetic)
app.directive('img-fallback', vImgFallback)
app.mount('#app')
