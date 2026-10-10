/**
 * 网易云音乐 —— 解析 + 代理（Cloudflare Worker 与本地 dev 中间件**共用这一份**）。
 *
 * ── 为什么需要它 ──
 *   浏览器不能直接播网易云：playurl 接口**不给 CORS 头**，而且返回的直链带
 *   IP 令牌、`expi=1200`（20 分钟）就过期。所以音频必须由自建端点转发：
 *     浏览器 → 本端点 → 网易云 → 本端点 → 浏览器
 *   ★ 顺带解决了「直链会过期」：前端只认 `<endpoint>/stream?id=<歌曲id>`，
 *     稳定不变；真正会过期的上游直链只活在这个进程里。
 *
 * ── 用的是公开接口，不是官方 openapi ──
 *   官方 `openapi/music/basic/batch/song/playurl/get` 要 appId + RSA 私钥签名 +
 *   accessToken（实测不带这些直接返回 `{"msg":"非法sign参数","code":1402}`）。
 *   私钥只能放服务端，为一次「播两首歌」去申请开发者凭据并不划算 ——
 *   这里用网页版同一套公开接口：
 *     GET music.163.com/api/song/enhance/player/url/v1?ids=[id]&level=exhigh&encodeType=mp3
 *   实测无需登录即返回 `code=200 / br=320000 / level=exhigh`（320 kbps）。
 *   ★ 它属于「非公开契约」，哪天变了要改这里 —— 前端完全不受影响。
 *
 * ── 端点路由 ──
 *   GET  <endpoint>/stream?id=<网易云歌曲 id>[Range: …]  → 音频字节流（支持 206）
 *   GET  <endpoint>/info                                → 自检：路由 + 白名单状态
 *   OPTIONS *                                           → CORS 预检
 *   ★ 挂在哪一级都行（`/stream`、`/music/stream` 都认），所以端点可以带路径前缀。
 */

/** playurl（v1）：`level=exhigh` 就是 320 kbps */
const PLAYURL_API = 'https://music.163.com/api/song/enhance/player/url/v1'

/**
 * 音质档位。exhigh = 320 kbps（用户要求 320）。
 * ★ 上游若给不了这一档会**自动降级**返回较低码率，不会报错 ——
 *   真机上要看 `br` 字段确认（本文件把它记进日志了）。
 */
const LEVEL = 'exhigh'
const ENCODE_TYPE = 'mp3'

/**
 * 上游直链的有效期 `expi=1200`（20 分钟），这里缓存 15 分钟留余量。
 * ★ 缓存的是「解析结果」而不是音频字节：一首歌 ~8 MB，缓存字节既吃内存
 *   又要处理 Range 的分段合并，不划算 —— 浏览器那边有它自己的媒体缓存。
 */
const URL_TTL_MS = 15 * 60 * 1000

/**
 * 请求上游要带的头。实测不带 UA/Referer 会被风控挡掉
 * （网易云对「裸 requests」有反爬）。
 */
const UPSTREAM_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Referer: 'https://music.163.com/',
  Origin: 'https://music.163.com',
}

/**
 * CORS：站点（GitHub Pages / Pages 预览域）与 Worker 不同源，必须放行。
 * ★ `Access-Control-Expose-Headers` 里的 `Content-Range` 是关键 ——
 *   不带它，`Range` 请求虽然会成功，但浏览器读不到分段信息，**拖进度条会失灵**。
 * ★ `Allow-Headers: Range` 是给「万一浏览器对 Range 发预检」兜底的：
 *   规范里 Range 已是 CORS 安全头，但预检路由此处顺手答了，成本为零。
 */
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
  'Access-Control-Allow-Headers': 'Range,If-Range',
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges',
}

/** 带 HTTP 状态码的错误（好让 handler 原样回给前端，而不是一律 500） */
class HttpError extends Error {
  constructor(status, message) {
    super(message)
    this.name = 'HttpError'
    this.status = status
  }
}

/** 网易云歌曲 id 就是个纯数字串（实测 10 位；放宽到 4–20 位防脏参数） */
const ID_PATTERN = /^\d{4,20}$/

/** id → { url, exp }；模块级缓存（一个 isolate 一份，热起来就命中） */
const urlCache = new Map()

/** 测试用：清掉解析缓存 */
export function clearUrlCache() {
  urlCache.clear()
}

/**
 * `ALLOWED_IDS` 白名单（逗号分隔）。
 *
 * ★★ 为什么要有：这个端点是**公开**的，没有白名单的话任何人都能拿它当
 *   「任意网易云歌曲的免费代理」—— 流量走的是部署者的 Cloudflare 额度。
 *   留空 = 不限制（只在本地 dev 里方便，生产别这么配）。
 */
function allowedIds(env) {
  return new Set(
    String(env?.ALLOWED_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

/** 解析一首歌的播放直链（带缓存） */
async function resolvePlayUrl(id) {
  const cached = urlCache.get(id)
  if (cached && cached.exp > Date.now()) return cached.url

  const api = `${PLAYURL_API}?ids=%5B${id}%5D&level=${LEVEL}&encodeType=${ENCODE_TYPE}`
  let res
  try {
    res = await fetch(api, { headers: UPSTREAM_HEADERS })
  } catch (e) {
    throw new HttpError(502, `连不上网易云接口：${e?.message ?? e}`)
  }
  if (!res.ok) throw new HttpError(502, `网易云接口返回 HTTP ${res.status}`)

  let data
  try {
    data = await res.json()
  } catch {
    /* 风控页面是 HTML，不是 JSON —— 说清这一点省得以后误判成「歌下架了」 */
    throw new HttpError(502, '网易云接口返回的不是 JSON（多半被风控了）')
  }

  const item = Array.isArray(data?.data) ? data.data[0] : null
  if (!item?.url) {
    const why = item?.code ? `code=${item.code}` : `code=${data?.code ?? '?'}`
    throw new HttpError(404, `歌曲 ${id} 拿不到播放地址（${why}；可能下架 / VIP / 版权受限）`)
  }

  /* ★ 上游给的是 http 直链，而本站是 https —— 混合内容会被浏览器直接拦掉。
     实测同一台 CDN 换 https 一样可用（返回同样的 206）。 */
  const url = String(item.url).replace(/^http:\/\//i, 'https://')
  urlCache.set(id, { url, exp: Date.now() + URL_TTL_MS })
  console.log(`[music] 解析 ${id}: br=${item.br} level=${item.level} type=${item.type} size=${item.size}`)
  return url
}

/**
 * 把音频字节流转发给浏览器。
 *
 * ★★ `Range` 必须**原样透传**并由上游回答 206：`<audio>` 是边下边播的，
 *   而「拖进度条」本质就是「跳到某个字节区间」。若这里无视 Range、回一个
 *   200 全量流，浏览器就只能顺序下载，seek 要等到整首下完 —— 表现是
 *   「进度条拖了没反应」。
 */
async function streamAudio(id, request) {
  const target = await resolvePlayUrl(id)
  const range = request.headers.get('range')

  let upstream
  try {
    upstream = await fetch(target, {
      headers: range ? { ...UPSTREAM_HEADERS, Range: range } : UPSTREAM_HEADERS,
    })
  } catch (e) {
    throw new HttpError(502, `连不上音频 CDN：${e?.message ?? e}`)
  }
  // 206 = 上游按 Range 回了分段；200 = 没有 Range 或上游不支持分段
  if (upstream.status !== 200 && upstream.status !== 206) {
    throw new HttpError(502, `音频 CDN 返回 HTTP ${upstream.status}`)
  }

  const headers = new Headers(CORS_HEADERS)
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag']) {
    const value = upstream.headers.get(name)
    if (value) headers.set(name, value)
  }
  if (!headers.has('content-type')) headers.set('content-type', 'audio/mpeg')
  if (!headers.has('accept-ranges')) headers.set('accept-ranges', 'bytes')
  /* ★ 让浏览器自己缓存一小段时间（同一首歌重复播不再走 Worker）。
     不能给太长：上游内容是「网易云此刻给的这一版」，没必要替它长期背书。 */
  headers.set('cache-control', 'public, max-age=1800')

  /* HEAD 只关心头：把上游 body 丢掉，别让它挂着占用配额 */
  if (request.method === 'HEAD') {
    try {
      await upstream.body?.cancel()
    } catch {
      /* 取消失败无所谓 */
    }
    return new Response(null, { status: upstream.status, headers })
  }
  return new Response(upstream.body, { status: upstream.status, headers })
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

/**
 * 端点入口 —— Worker 的 `fetch` 直接调它，本地 dev 中间件把 Node 的
 * `req`/`res` 包装成 `Request`/`Response` 后也调它（同一份逻辑，两条运行路径）。
 *
 * @param {Request} request
 * @param {{ ALLOWED_IDS?: string }} [env]
 * @returns {Promise<Response>}
 */
export async function handleMusicRequest(request, env = {}) {
  const url = new URL(request.url)
  const path = (url.pathname.replace(/\/+$/, '') || '/').toLowerCase()

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    return json({ error: `只支持 GET / HEAD，收到 ${request.method}` }, 405)
  }

  try {
    if (path.endsWith('/stream')) {
      const id = url.searchParams.get('id') ?? ''
      if (!ID_PATTERN.test(id)) {
        throw new HttpError(400, `id 必须是纯数字的网易云歌曲 id（收到 ${JSON.stringify(id)}）`)
      }
      const allow = allowedIds(env)
      if (allow.size > 0 && !allow.has(id)) {
        throw new HttpError(403, `歌曲 ${id} 不在白名单里 —— 要加它就改 workers/api/wrangler.toml 的 ALLOWED_IDS`)
      }
      return await streamAudio(id, request)
    }

    if (path === '/' || path.endsWith('/info')) {
      const allow = allowedIds(env)
      return json({
        ok: true,
        routes: ['GET /stream?id=<歌曲id>', 'GET /info'],
        quality: `level=${LEVEL} encodeType=${ENCODE_TYPE}（320 kbps）`,
        allowedIds: allow.size > 0 ? [...allow] : null,
        restricted: allow.size > 0,
        cached: urlCache.size,
      })
    }

    throw new HttpError(404, `没有这个路由：${path}（只有 /stream 与 /info）`)
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500
    const message = e instanceof Error ? e.message : String(e)
    console.warn(`[music] ${status} ${message}`)
    return json({ error: message }, status)
  }
}
