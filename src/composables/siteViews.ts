/**
 * 站点浏览量（PV）
 *
 * 纯静态站自己算不出「这个站被看了多少次」—— 数据**必须**来自外部计数端点。
 * 方案（用户 2026-10-07 定）：Cloudflare 边缘函数（Worker + KV）。
 *
 * ── 怎么打开 ──
 *   构建期注入 `VITE_VIEWS_ENDPOINT`（见仓库根 `.env.example`），例如
 *   `VITE_VIEWS_ENDPOINT=https://views.xxx.workers.dev/views`。
 *   ★★ **没配就一次请求都不发** —— 本地 dev / 还没接 Worker 时不会在控制台刷 404，
 *      「关于」页那张统计卡里的浏览量显示 `—`。
 *
 * ── 端点契约（Worker 侧要实现）──
 *   POST <endpoint>  → 计一次浏览，返回 `{ "views": 123 }`
 *   GET  <endpoint>  → 只读总数，返回 `{ "views": 123 }`
 *   CORS：放行站点来源（GH Pages 与 workers.dev 不同源），或直接 `Access-Control-Allow-Origin: *`
 *
 * ── 计数口径 ──
 *   一次**整页加载**算一次（`App.vue` 挂载时打一枪），路由切换**不重复计** ——
 *   站内点击导航不会灌水，刷新 +1（这就是"浏览量"的常规口径）。
 *
 * ★ 这里所有失败都吞掉：浏览量的定位是"锦上添花"，
 *   端点挂了 / 超时 / 返回的不是 JSON，卡片一律显示 `—`，绝不报错、绝不吊住页面。
 */

/** 端点地址（末尾斜杠先去掉，免得拼出 `//`） */
const ENV_ENDPOINT = (import.meta.env.VITE_VIEWS_ENDPOINT ?? '').trim().replace(/\/+$/, '')

/* 线上兜底：这份代码就是给 kuroki.top 用的，仓库 Variables 没配时直接走 Worker 的自定义域。
   ★ 之所以不强制依赖构建变量：漏配时整站会「静默不显示浏览量」，比写死一个域名更难排查。
   ★ dev 不受影响 —— 那里走 `plugins/vite-plugin-api-proxy.ts` 的 `/views` 中间件。 */
const PROD_FALLBACK = 'https://api.kuroki.top/views'

const ENDPOINT = ENV_ENDPOINT || (import.meta.env.PROD ? PROD_FALLBACK : '')

/** 端点配了没？没配时组件直接显示 `—`，且一次请求都不发 */
export const hasViewsEndpoint = ENDPOINT.length > 0

/** 计数端点是外部依赖，4s 拿不到就当没有 —— 不能让卡片一直等 */
const TIMEOUT_MS = 4000

async function request(method: 'GET' | 'POST'): Promise<number | null> {
  if (!ENDPOINT) return null

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(ENDPOINT, {
      method,
      signal: ctrl.signal,
      // 计数每次都要真数，别走 HTTP 缓存
      cache: 'no-store',
      // POST 用 keepalive：整页加载的计数不该被导航取消掉
      keepalive: method === 'POST',
      credentials: 'omit',
    })
    if (!res.ok) return null

    const data: unknown = await res.json()
    const views = (data as { views?: unknown } | null)?.views
    return typeof views === 'number' && Number.isFinite(views) ? views : null
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** 计一次浏览（整页加载调一次；返回新总数，失败返回 null） */
export function countPageView(): Promise<number | null> {
  return request('POST')
}

/** 读总数（卡片用，**不**计数；失败返回 null） */
export function readSiteViews(): Promise<number | null> {
  return request('GET')
}
