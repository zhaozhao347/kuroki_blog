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
/* ★★ 线上端点按顺序试：
 *   ① 同源 `/api/views` —— 主站域名走 Cloudflare 代理（橙云）时最理想：复用页面那条
 *      HTTP/2 连接，少一次 DNS + 握手。之前用 `api.kuroki.top` 时，国内实测这条
 *      独立连接经常 3~25s 才建起来，统计卡就一直显示 `—`。
 *   ② `https://api.kuroki.top/views` —— 主站还是**灰云**（DNS-only，直连 GitHub Pages）
 *      时 ① 根本不会命中 Worker（请求压根不经过 Cloudflare），此时必须退回旧端点。
 *   两个都失败才显示 `—`。
 *   ★ 等域名切到橙云后 ① 命中，② 自然不会被用到，不用再改代码。 */
const PROD_ENDPOINTS = ['/api/views', 'https://api.kuroki.top/views']

const ENDPOINTS: string[] = ENV_ENDPOINT
  ? [ENV_ENDPOINT]
  : import.meta.env.PROD
    ? PROD_ENDPOINTS
    : []

/** 端点配了没？没配时组件直接显示 `—`，且一次请求都不发 */
export const hasViewsEndpoint = ENDPOINTS.length > 0

/** 计数端点是外部依赖，12s 拿不到就当没有 —— 不能让卡片一直等。
 *  ★ 4s / 8s 都实测不够：线上这台 Worker 冷启动时单次要 3.4s，偶发到 8s 以上，
 *    手机上再叠加移动网络经常正好卡在超时被 abort，统计卡就一直显示 `—`
 *    （用户 m04376 报的「手机端失效」）。有 localStorage 兜底后，长超时不再影响观感。 */
const TIMEOUT_MS = 12000

/** 上一次成功读到的浏览量（localStorage）。
 *  ★ 目的是**首屏立刻有数**：等 3~4s 才从 `—` 变成数字，看起来就像坏了。
 *    读失败也不会显示错（只是把旧值留在那儿，下一次成功就覆盖）。 */
const CACHE_KEY = 'kuroki:views'

function remember(views: number): void {
  try {
    localStorage.setItem(CACHE_KEY, String(views))
  } catch {
    /* 隐私模式 / 配额满 —— 只是少一层缓存，不影响功能 */
  }
}

/** 上次成功读到的值（没有就 null） */
export function lastKnownViews(): number | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY)
    const n = raw === null ? NaN : Number(raw)
    return Number.isFinite(n) && n >= 0 ? n : null
  } catch {
    return null
  }
}

async function request(method: 'GET' | 'POST'): Promise<number | null> {
  if (!ENDPOINTS.length) return null

  for (const endpoint of ENDPOINTS) {
    const got = await requestOne(endpoint, method)
    if (got !== null) return got
  }
  return null
}

/** 打一个端点；拿不到合法的 `{ views: number }` 就返回 null（交给下一个候选） */
async function requestOne(endpoint: string, method: 'GET' | 'POST'): Promise<number | null> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(endpoint, {
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
    if (typeof views !== 'number' || !Number.isFinite(views)) return null
    remember(views)
    return views
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
