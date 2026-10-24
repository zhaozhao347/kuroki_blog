/**
 * Steam 信息端点（`/steam`）—— 「关于」页那张「最近在玩」卡的数据源。
 *
 * ── 契约（前端 `src/composables/steam.ts` 按这个写死）──
 *   GET /steam        → 规整后的一份 JSON（见下方 buildPayload）
 *   GET /steam/info   → 自检：有没有 key / 有没有 steamID / 缓存多少秒
 *
 * ── 为什么不能前端直连 Steam ──
 *   ① 每个请求都要 `key=<Steam Web API key>`，那个 key 是**账号级凭据**，
 *      打进前端等于公开送人（比网易云那条更严重：它能读你整个库）；
 *   ② Steam Web API **一个 CORS 头都不给** ⇒ 浏览器就算有 key 也读不到响应。
 *   所以 key 只活在 Worker 里：`npx wrangler secret put STEAM_API_KEY`。
 *
 * ── 上游只打两个接口 ──
 *   ISteamUser/GetPlayerSummaries/v2         昵称 / 头像 / 在线状态 / 正在玩
 *   IPlayerService/GetRecentlyPlayedGames/v1 最近两周玩过的（**单位是分钟**）
 *   两个都走 `Promise.all`：一次访问 = 两次上游调用，缓存 5 分钟后基本为零。
 *   想要「总时长 / 游戏数」再加 GetOwnedGames 即可（契约留了扩展位，现在没打）。
 *
 * ── ★★ 隐私是个真坑 ──
 *   Steam 资料或「游戏详情」设成私密时，上游**不报错**：
 *   players 变成 `[]`、recently-played 连 `games` 字段都没有。
 *   不主动判空的话，前端只会看到一张空卡、还不知道为什么 ——
 *   所以这里把两种情况分别标成 `error: 'private'` / `'games-private'`。
 */
import { json, preflight } from './http.js'

const API = 'https://api.steampowered.com'
/** 游戏小图标：上游只给一个哈希，前缀得自己拼 */
const APP_ICON = 'https://media.steampowered.com/steamcommunity/public/images/apps'

/** 上游结果缓存秒数。Steam 官方限 10 万次/天，但「最近在玩」5 分钟刷一次足够新鲜。
 *  ★ 导出给 dev 中间件用：线上那份走 `caches.default`（TTL 由响应头决定），
 *    dev 的 Map 版得自己知道过期时间 —— 一处定义，两边一致。 */
export const CACHE_TTL_S = 300

/**
 * 「上一份成功数据」留多久（秒）。
 * ★ 上游 5xx / 超时不可怕，可怕的是没有兜底 —— 留 7 天，够跨过一次 Steam 抽风。
 */
const STALE_TTL_S = 7 * 24 * 60 * 60
/** 默认取几款最近在玩的 */
const DEFAULT_COUNT = 3
/** 上游 count 上限是 51，这里收窄到 10 —— 卡片最多也就显示三四条 */
const MAX_COUNT = 10
/** 上游超时：Steam 偶尔慢，别让卡片一直等 */
const TIMEOUT_MS = 6000

/** personastate 数字 → 词（前端直接显示，不再翻译一遍） */
const STATE = ['offline', 'online', 'busy', 'away', 'snooze', 'looking-to-trade', 'looking-to-play']

/** 分钟 → 小时（保留 1 位小数）。★ 上游给的是**分钟**，除错 60 倍是经典错法 */
function toHours(minutes) {
  const m = Number(minutes)
  return Number.isFinite(m) && m > 0 ? Math.round((m / 60) * 10) / 10 : 0
}

function clampCount(raw) {
  const n = Number.parseInt(raw ?? '', 10)
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_COUNT
  return Math.min(n, MAX_COUNT)
}

function appIcon(appid, hash) {
  return typeof hash === 'string' && hash ? `${APP_ICON}/${appid}/${hash}.jpg` : ''
}

/** 把错误写成一行可诊断的字符串。
 *  ★★ undici 的 `fetch()` 失败只会给一句光秃秃的 `fetch failed`，
 *  真正的原因（证书、DNS、连接被拒）藏在 `err.cause` 里 ——
 *  不把它带出来的话，线上只会看到 `{"error":"upstream","detail":"fetch failed"}`，
 *  然后开始怀疑 key 写错了。这个坑踩过一次了。 */
function describeError(e) {
  if (!(e instanceof Error)) return String(e)
  const cause = e.cause
  const detail = cause instanceof Error ? cause.message : typeof cause === 'string' ? cause : ''
  return detail && detail !== e.message ? `${e.message} (${detail})` : e.message
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 重试间隔：Steam 偶发的 500/503 与连接抖动，隔几百毫秒再打一次基本就过了 */
const RETRY_DELAYS_MS = [250, 700]

async function fetchOnce(url) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`steam upstream HTTP ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 带重试的取 JSON。
 *
 * ★★ 为什么必须重试：Steam Web API 的 500/503 是**常态级偶发**（尤其
 *    `GetRecentlyPlayedGames`），单次失败就让整张卡变成「加载失败了😫」太脆。
 * ★ 只重试「可能自己好」的错误：网络错误 / 超时 / 429 / 5xx；
 *    4xx（key 错、id 错）重试三次也是三次白跑，直接抛。
 */
async function fetchJson(url) {
  let lastErr = new Error('steam upstream 未执行')
  for (let i = 0; i <= RETRY_DELAYS_MS.length; i++) {
    try {
      return await fetchOnce(url)
    } catch (e) {
      lastErr = e
      const message = describeError(e)
      const status = Number(/HTTP (\d{3})/.exec(message)?.[1] ?? 0)
      const worthRetry = status === 0 || status === 429 || status >= 500
      if (!worthRetry || i === RETRY_DELAYS_MS.length) break
      await sleep(RETRY_DELAYS_MS[i])
    }
  }
  throw lastErr
}

/**
 * 缓存后端。Cloudflare 上用 `caches.default`；dev（Node 里跑）由中间件塞一个 Map 版进来。
 * 接口故意只有 get / put —— 两个实现各几行，不值得抽一层抽象。
 */
function workerCache() {
  if (typeof caches === 'undefined' || !caches.default) return null
  const store = caches.default
  return {
    async get(key) {
      const hit = await store.match(key)
      return hit ? await hit.json() : null
    },
    async put(key, data, maxAge = CACHE_TTL_S) {
      await store.put(
        key,
        new Response(JSON.stringify(data), {
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': `max-age=${maxAge}`,
          },
        }),
      )
    },
  }
}

/** 打上游 + 规整成前端契约 */
async function buildPayload(env) {
  const key = String(env.STEAM_API_KEY ?? '').trim()
  const id = String(env.STEAM_ID ?? '').trim()
  const count = clampCount(env.STEAM_RECENT_COUNT)

  const [summaries, recent] = await Promise.all([
    fetchJson(`${API}/ISteamUser/GetPlayerSummaries/v2/?key=${key}&steamids=${id}`),
    fetchJson(
      `${API}/IPlayerService/GetRecentlyPlayedGames/v1/?key=${key}&steamid=${id}&count=${count}`,
    ),
  ])

  const player = summaries?.response?.players?.[0] ?? null
  const resp = recent?.response ?? {}
  const games = Array.isArray(resp.games) ? resp.games : null
  /* 公开但最近真的没玩：上游给 `total_count: 0` 且没有 games —— 这不是私密 */
  const emptyButPublic = typeof resp.total_count === 'number'

  return {
    profile: player
      ? {
          name: String(player.personaname ?? ''),
          avatar: String(player.avatarfull ?? player.avatarmedium ?? ''),
          url: String(player.profileurl ?? `https://steamcommunity.com/profiles/${id}`),
          state: STATE[Number(player.personastate)] ?? 'offline',
          inGame:
            typeof player.gameextrainfo === 'string' && player.gameextrainfo
              ? player.gameextrainfo
              : null,
        }
      : null,
    recent: (games ?? []).slice(0, count).map((g) => ({
      appid: Number(g.appid) || 0,
      name: String(g.name ?? ''),
      icon: appIcon(g.appid, g.img_icon_url),
      hours2w: toHours(g.playtime_2weeks),
      hoursTotal: toHours(g.playtime_forever),
    })),
    updatedAt: new Date().toISOString(),
    error: player ? (games || emptyButPublic ? null : 'games-private') : 'private',
  }
}

/**
 * @param {Request} request
 * @param {{ STEAM_API_KEY?: string, STEAM_ID?: string, STEAM_RECENT_COUNT?: string }} env
 * @param {{ cache?: { get(key: string): Promise<object | null>, put(key: string, data: object): Promise<void> } | null }} [deps]
 */
export async function handleSteamRequest(request, env = {}, deps = {}) {
  if (request.method === 'OPTIONS') return preflight()

  const segments = new URL(request.url).pathname.split('/').filter(Boolean)
  const sub = (segments[1] ?? '').toLowerCase() // /steam → '' ; /steam/info → 'info'

  const hasKey = String(env.STEAM_API_KEY ?? '').trim().length > 0
  const id = String(env.STEAM_ID ?? '').trim()
  const count = clampCount(env.STEAM_RECENT_COUNT)

  if (sub === 'info') {
    return json({
      ok: true,
      keyConfigured: hasKey,
      steamId: id || null,
      recentCount: count,
      cacheTtlSeconds: CACHE_TTL_S,
    })
  }
  if (sub) return json({ error: 'not-found' }, { status: 404 })

  /* 缺凭据时**明说缺哪个**：这两种是部署期最常见的两个坑 */
  if (!hasKey) {
    return json(
      { error: 'no-key', hint: '执行 npx wrangler secret put STEAM_API_KEY（或 dev 下写进 .env.local）' },
      { status: 503 },
    )
  }
  if (!id) {
    return json(
      { error: 'no-id', hint: 'wrangler.toml 的 [vars] STEAM_ID 填 17 位 steamID64' },
      { status: 503 },
    )
  }

  const store = deps.cache ?? workerCache()
  const cacheKey = `https://blog-api.internal/steam/${id}/${count}`
  /* 上一份「成功」的数据存 7 天：上游抽风时拿它顶上，卡片不至于整块变灰 */
  const staleKey = `https://blog-api.internal/steam-last-good/${id}/${count}`
  const cacheHeaders = { 'cache-control': `public, max-age=${CACHE_TTL_S}` }

  if (store) {
    try {
      const cached = await store.get(cacheKey)
      if (cached) return json({ ...cached, cached: true }, { headers: cacheHeaders })
    } catch (e) {
      /* 缓存坏了不该拖垮端点：说一声，继续打上游 */
      console.warn('[steam] 读缓存失败，改为直连上游：', e)
    }
  }

  try {
    const data = await buildPayload(env)
    if (store) {
      try {
        await store.put(cacheKey, data)
        /* ★ 只把「确实拿到了数据」的版本留成 last-good：
           私密 / 拿不到 games 的结果存进去没有意义，反而会顶掉好数据 */
        if (!data.error) await store.put(staleKey, data, STALE_TTL_S)
      } catch (e) {
        console.warn('[steam] 写缓存失败（不影响本次响应）：', e)
      }
    }
    return json({ ...data, cached: false }, { headers: cacheHeaders })
  } catch (e) {
    /* 重试也没救回来 —— 先拿上一份成功数据顶上，真没有才回 502 */
    if (store) {
      try {
        const stale = await store.get(staleKey)
        if (stale) {
          return json(
            { ...stale, cached: true, stale: true, detail: describeError(e) },
            { headers: cacheHeaders },
          )
        }
      } catch (err) {
        console.warn('[steam] 读 last-good 失败：', err)
      }
    }
    return json({ error: 'upstream', detail: describeError(e) }, { status: 502 })
  }
}
