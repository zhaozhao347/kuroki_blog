/**
 * 本站边缘函数的入口 —— **一个 Worker 挂三件事**：`/music`、`/views`、`/steam`。
 *
 * 这里只做路由分发，一行业务逻辑都不写：
 *   /music/*  → `./netease.js`（网易云音频转发，dev 中间件共用同一份实现）
 *   /views    → `./views.js`  （浏览量计数，需要 KV）
 *   /steam    → `./steam.js`  （Steam 资料 / 最近在玩，需要 secret）
 *
 * ★ 为什么合并成一个 Worker 而不是三个：三个都只是「本站自己的小后端」，
 *   合并后一个 URL、一份 CORS、一次 deploy；路径各占一段，互不干扰。
 *   前端那边也不用改代码 —— 只是三个环境变量的地址指向同一个域。
 *
 * 部署见 ../README.md；配置见 ../wrangler.toml。
 */
import { json, preflight, ROUTES } from './http.js'
import { handleMusicRequest } from './netease.js'
import { handleSteamRequest } from './steam.js'
import { handleViewsRequest } from './views.js'

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env wrangler.toml 的 [vars] / KV 绑定 / secret
   */
  fetch(request, env) {
    if (request.method === 'OPTIONS') return preflight()

    const path = (new URL(request.url).pathname.replace(/\/+$/, '') || '/').toLowerCase()
    const head = path.split('/').filter(Boolean)[0] ?? ''

    switch (head) {
      case 'views':
        return handleViewsRequest(request, env)

      case 'steam':
        return handleSteamRequest(request, env)

      case 'music':
      /* ★ 兼容「不带前缀」的老契约：`netease.js` 是按**后缀**匹配的
         （`endsWith('/stream')`），所以 /stream 与 /music/stream 走同一分支。 */
      case 'stream':
      case 'info':
        return handleMusicRequest(request, env)

      case '':
        return json({ ok: true, routes: ROUTES })

      default:
        return json({ error: 'not-found', routes: ROUTES }, { status: 404 })
    }
  },
}
