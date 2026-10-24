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
 * ★★ 边缘缓存（2026-10-25 加）：`/views` 与 `/steam` 是**读多写少的展示型**数据，
 *   但每次请求都要跨一次「边缘 → Worker 所在机房 → KV / Steam API」。
 *   从国内点开「关于」页时实测要几秒（Worker 冷启动 + 跨洋回源），
 *   而这个页面上的数字晚 60 秒根本没人看得出来。
 *   所以这里用 `caches.default` 把它们的 **GET 响应在边缘存 60 秒**：
 *   命中时直接由最近的 PoP 返回（几十毫秒），不再落到 Worker。
 *
 *   ⚠️ 只在 Worker 内部缓存，**不要**再在 Cloudflare 面板给 api.* 加 Cache Rule ——
 *      两层缓存叠起来，「发了新浏览量 60 秒内还在看旧值」会变成两倍时间，
 *      且排查时很难分清是哪一层在给旧数据。
 *   ⚠️ `POST /views` 永远不进缓存，并且会把 GET 的缓存**删掉**（否则刚计完数还读到旧值）。
 *   ⚠️ 音乐端点（`/music/*`）**不缓存**：音频是靠 Range 分段拉的，套一层缓存会把
 *      分段语义搅乱（见 §5.7 第 4 条）。
 *
 * 部署见 ../README.md；配置见 ../wrangler.toml。
 */
import { json, preflight, ROUTES } from './http.js'
import { handleMusicRequest } from './netease.js'
import { handleSteamRequest } from './steam.js'
import { handleViewsRequest } from './views.js'

/** 边缘缓存时长（秒）。改大 = 更省回源、更新更慢；60 是「肉眼看不出延迟」的安全值 */
const EDGE_TTL = 60

/** 把请求归一成缓存 key：同域同名、丢掉查询串与方法（这些端点不吃参数） */
function cacheKeyOf(request) {
  const url = new URL(request.url)
  return new Request(`${url.origin}${url.pathname}`)
}

/**
 * 给「只读展示型」响应套一层边缘缓存。
 *
 * @param {Request} request
 * @param {{ waitUntil?: (p: Promise<unknown>) => void } | undefined} ctx
 * @param {() => Promise<Response>} produce 真正干活的那一步
 */
async function edgeCached(request, ctx, produce) {
  if ((request.method || 'GET').toUpperCase() !== 'GET') return produce()

  const cache = caches.default
  const key = cacheKeyOf(request)
  const hit = await cache.match(key)
  if (hit) {
    /* 复制一份再加标记：直接改缓存里那份的 header 会污染后续命中 */
    const fresh = new Response(hit.body, hit)
    fresh.headers.set('x-edge-cache', 'hit')
    return fresh
  }

  const res = await produce()
  if (res.status !== 200) return res

  const out = new Response(res.body, res)
  out.headers.set('cache-control', `public, max-age=${EDGE_TTL}, stale-while-revalidate=300`)
  out.headers.set('x-edge-cache', 'miss')
  /* clone 一份塞进缓存，原件直接回给这次请求 */
  ctx?.waitUntil?.(cache.put(key, out.clone()))
  return out
}

export default {
  /**
   * @param {Request} request
   * @param {Record<string, unknown>} env wrangler.toml 的 [vars] / KV 绑定 / secret
   * @param {{ waitUntil?: (p: Promise<unknown>) => void }} ctx 第三个参数才有 waitUntil
   */
  fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return preflight()

    /* ★★ 同源挂载（2026-10-25）：`https://kuroki.top/api/*` 与 `https://api.kuroki.top/*` 等价。
       为什么要多这一条：api.kuroki.top 是**另一个 origin**，浏览器要另开一条 TLS 连接，
       而从国内实测这条连接经常 3~25s 才建起来（甚至超时）—— 页面本身却很快，
       因为主站连接早就建好了。改成同源之后，请求复用页面那条 HTTP/2 连接，
       少一次 DNS + 握手，统计卡与 Steam 卡才稳定拿到数据。
       前缀只在这里剥一层，下面的路由逻辑一行没动。 */
    const segments = new URL(request.url).pathname.split('/').filter(Boolean)
    const prefixed = (segments[0] ?? '').toLowerCase() === 'api'
    const head = (prefixed ? segments[1] : segments[0] ?? '').toLowerCase()

    switch (head) {
      case 'views': {
        /* 计数必须穿透缓存；顺便把读的缓存作废，免得刚计完又读到旧值 */
        if ((request.method || 'GET').toUpperCase() === 'POST') {
          ctx?.waitUntil?.(caches.default.delete(cacheKeyOf(request)))
          return handleViewsRequest(request, env)
        }
        return edgeCached(request, ctx, () => handleViewsRequest(request, env))
      }

      case 'steam':
        return edgeCached(request, ctx, () => handleSteamRequest(request, env))

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
