/**
 * 本地 dev 的边缘函数端点 —— 把 Worker 那份实现挂成 Vite 中间件。
 *
 * ── 它解决什么 ──
 *   生产环境三个端点都来自同一个 Worker（`workers/api/`），地址写在前端的
 *   `VITE_*_ENDPOINT` 里。本地开发不该被迫先部署一遍才能看效果，所以 dev 下由
 *   这里顶上：
 *
 *     GET  /music/stream?id=<网易云歌曲id>   音频（支持 Range/206）
 *     GET  /music/info
 *     POST /views                            计一次浏览
 *     GET  /views                            读总数
 *     GET  /steam                            Steam 资料 + 最近在玩
 *     GET  /steam/info
 *
 *   ★★ 关键点是**共用同一份实现**（`workers/api/src/*.js`）——
 *     如果 dev 自己再写一遍，就会出现「本地好好的、线上 403 / 没有 CORS」
 *     这类只有部署后才发现的问题。这里只做
 *     「Node req/res ↔ fetch Request/Response」的翻译，不含任何业务逻辑。
 *
 * ── dev 与线上的两处差异（都是故意的）──
 *   ① 浏览量存储：线上是 KV；dev 用进程内存（重启归零），免得本地开发还得先建
 *      namespace、还得登录 wrangler。
 *   ② 音乐白名单默认关掉：线上靠 `ALLOWED_IDS` 防止被当成任意歌曲的免费代理，
 *      本地只有自己能访问。要模拟线上行为：`MUSIC_ALLOWED_IDS=1311002329 npm run dev`。
 *
 * ── Steam key 从哪来 ──
 *   `.env.local` 里写 `STEAM_API_KEY=...`（**不带** VITE_ 前缀，别打进前端）与
 *   `STEAM_ID=<17 位 steamID64>`。没配时 `/steam` 会回 503 并说明缺哪个 ——
 *   卡片因此保持隐藏，不会显示空白卡。
 *
 * ★ 改 `workers/api/src/*.js` 之后如果没生效：重启 dev（那些文件是 vite.config.ts
 *   的依赖，多数情况下 Vite 会自己重启，但不保证）。
 */
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { ServerResponse } from 'node:http'
import type { Connect, Plugin } from 'vite'
import { loadEnv } from 'vite'

import { handleMusicRequest } from '../workers/api/src/netease.js'
import { CACHE_TTL_S as STEAM_CACHE_TTL_S, handleSteamRequest } from '../workers/api/src/steam.js'
import type { SteamCache } from '../workers/api/src/steam.js'
import { handleViewsRequest } from '../workers/api/src/views.js'
import type { ViewsKV } from '../workers/api/src/views.js'

/**
 * 是不是「客户端主动断了」这一类的收尾 —— 音频流里这是**常态**，不该报成错误。
 *
 * `<audio>` 缓冲够了、拖进度条跳到别的字节区间、切歌、关页面……浏览器都会直接
 * 掐掉上一个请求（实测 dev 日志里一堆 `net::ERR_ABORTED`）。这些收尾会以
 * `ERR_STREAM_PREMATURE_CLOSE` / `ECONNRESET` / `TypeError: terminated` 等形态冒出来。
 */
function isClientGone(e: unknown): boolean {
  const code = (e as { code?: string } | null)?.code
  if (
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ECONNRESET' ||
    code === 'EPIPE'
  ) {
    return true
  }
  if ((e as Error | null)?.name === 'AbortError') return true
  /* fetch 的 body 被打断时 Node 给的是 `TypeError: terminated` */
  return e instanceof TypeError && /terminated/i.test(e.message)
}

/** dev 版 KV：进程内存。接口与 `views.d.ts` 的 `ViewsKV` 一致 */
function memoryKV(): ViewsKV {
  const map = new Map<string, string>()
  return {
    async get(key: string) {
      return map.get(key) ?? null
    },
    async put(key: string, value: string) {
      map.set(key, value)
    },
  }
}

/** dev 版 Steam 缓存：带 TTL 的 Map（线上那份是 `caches.default`，TTL 由响应头决定） */
function memoryCache(ttlSeconds: number): SteamCache {
  const map = new Map<string, { at: number; data: object }>()
  return {
    async get(key: string) {
      const hit = map.get(key)
      if (!hit) return null
      if (Date.now() - hit.at > ttlSeconds * 1000) {
        map.delete(key)
        return null
      }
      return hit.data
    },
    async put(key: string, data: object) {
      map.set(key, { at: Date.now(), data })
    },
  }
}

/** Node 的 req/res 与 fetch 的 Request/Response 之间只做这些翻译 */
async function serve(
  mount: string,
  handler: (request: Request) => Promise<Response>,
  req: Connect.IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  try {
    /* Node 的 headers 可能是 string[]（同名头多次出现）—— Headers 只吃字符串 */
    const headers = new Headers()
    for (const [name, value] of Object.entries(req.headers)) {
      if (typeof value === 'string') headers.set(name, value)
      else if (Array.isArray(value)) headers.set(name, value.join(', '))
    }

    /* ★ 中间件挂在 '/music' 上，connect 会把挂载前缀从 req.url 里剥掉
       （这里收到的是 '/stream?id=…'），所以要把它拼回来 —— 端点路由
       是按完整路径匹配的，拼错了会变成 404。 */
    const url = new URL(`${mount}${req.url ?? ''}`, 'http://localhost')
    const request = new Request(url, { method: req.method ?? 'GET', headers })

    const response = await handler(request)

    res.statusCode = response.status
    res.statusMessage = response.statusText
    for (const [name, value] of response.headers) res.setHeader(name, value)

    if (!response.body) {
      res.end()
      return
    }
    /* ★ web ReadableStream → Node Readable：直接 pipe 才能边下边发。
       若改成 await response.arrayBuffer() 再 end()，一首 8 MB 的歌会先整个读进
       内存、且 `Range` 的分段语义也白做了（拖动进度条会变卡）。 */
    const source = Readable.fromWeb(
      response.body as unknown as import('node:stream/web').ReadableStream,
    )

    /* ★★ 必须用 pipeline，**不能**用裸 `source.pipe(res)`。
       2026-10-09 实测：dev server 被这条路径**整个进程打死**
       （`TypeError: terminated` + `read ECONNRESET`，`exit code 1`）——
       裸 pipe 不会替 Readable 挂 error 监听，上游体被浏览器 abort 打断后
       Node 抛出**无人接管**的 'error' 事件 ⇒ 进程退出。
       （Worker 那边不受影响：Cloudflare 运行时不需要我们管进程存活，
         而 dev 中间件跑在**你自己那个 vite 进程**里。）
       pipeline 会把这条错误收进下面的 catch，并顺手销毁两端。 */
    try {
      await pipeline(source, res)
    } catch (e) {
      if (isClientGone(e)) {
        /* 提醒一次就够，别刷屏 —— 拖一下进度条能触发好几次 */
        console.warn('[api-dev-proxy] 客户端提前断开，已丢弃剩余音频流（正常现象）')
      } else {
        console.error('[api-dev-proxy] 响应流中断：', e)
      }
      /* 别让上游继续下载：取消 fetch body（Node 那侧 pipeline 已销毁） */
      void response.body.cancel().catch(() => {})
      if (!res.writableEnded) res.destroy()
    }
  } catch (e) {
    /* 翻译层自己的异常（不该发生）：给出带原因的 502，别让请求悬着。
       ★ 走到这里说明响应还没开始流（流那段的异常在上面被吃掉了）——
         万一真已发出头，补 JSON 只会污染音频流，直接断开了事。 */
    const message = e instanceof Error ? e.message : String(e)
    console.error('[api-dev-proxy] 转发失败：', e)
    if (res.headersSent) {
      res.destroy()
      return
    }
    res.statusCode = 502
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ error: `dev 中间件转发失败：${message}` }))
  }
}

export default function apiDevProxy(): Plugin {
  return {
    name: 'api-dev-proxy',
    /* 只在 dev server 里挂；build 时三个端点都走 VITE_*_ENDPOINT */
    apply: 'serve',
    configureServer(server) {
      /* ★ prefixes 传 '' ⇒ 把 `.env.local` 里**没有** VITE_ 前缀的也算进来
         （STEAM_API_KEY 就该是这种：它只能待在服务端，绝不能进前端包）。 */
      const env = loadEnv(server.config.mode, server.config.root, '')
      const musicEnv = {
        ALLOWED_IDS: env.MUSIC_ALLOWED_IDS ?? process.env.MUSIC_ALLOWED_IDS,
      }
      const viewsKV = memoryKV()
      const steamEnv = {
        STEAM_API_KEY: env.STEAM_API_KEY ?? process.env.STEAM_API_KEY,
        STEAM_ID: (env.STEAM_ID ?? process.env.STEAM_ID ?? '').trim(),
        STEAM_RECENT_COUNT: env.STEAM_RECENT_COUNT ?? process.env.STEAM_RECENT_COUNT,
      }
      const steamCache = memoryCache(STEAM_CACHE_TTL_S)

      /* ★ 在 configureServer 里直接 use = 装在内置中间件**之前**：
         这几个前缀与 Vite 自己的路由不冲突，早装早答，少一层判断。 */
      server.middlewares.use('/music', (req, res) => {
        void serve('/music', (request) => handleMusicRequest(request, musicEnv), req, res)
      })
      server.middlewares.use('/views', (req, res) => {
        void serve('/views', (request) => handleViewsRequest(request, { VIEWS: viewsKV }), req, res)
      })
      server.middlewares.use('/steam', (req, res) => {
        void serve(
          '/steam',
          (request) => handleSteamRequest(request, steamEnv, { cache: steamCache }),
          req,
          res,
        )
      })
    },
  }
}
