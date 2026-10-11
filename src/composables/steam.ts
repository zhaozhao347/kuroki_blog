/**
 * Steam「最近在玩」（关于页侧栏那张卡的数据源）
 *
 * ── 为什么要有端点 ──
 *   ① Steam Web API 每个请求都要 `key=<账号级凭据>` —— 打进前端等于公开送人；
 *   ② Steam Web API **一个 CORS 头都不给** ⇒ 浏览器就算有 key 也读不到响应。
 *   所以数据只能由 `workers/api/` 那个 Worker 拿（它自己存 key），前端只读结果。
 *
 * ── 怎么打开 ──
 *   构建期注入 `VITE_STEAM_ENDPOINT`（见仓库根 `.env.example`），例如
 *   `VITE_STEAM_ENDPOINT=https://blog-api.xxx.workers.dev/steam`。
 *   ★★ **不配就一次请求都不发**，卡片整个不渲染（不是空卡）——见 `SteamCard.vue`。
 *      dev 下不配则默认走本地中间件 `/steam`（见 plugins/vite-plugin-api-proxy.ts）。
 *
 * ── 端点契约（Worker 侧 `workers/api/src/steam.js`）──
 *   GET <endpoint>  → `{ profile, recent[], updatedAt, error, cached }`
 *   失败也可能是 200/503/502 + `{ error: 'private' | 'games-private' | 'no-key' | 'no-id' | 'upstream' }`
 *   ⇒ **不看 HTTP 状态码，只看 body 里的 `error` 字段**（状态码只用来给人看）。
 *
 * ── 缓存 ──
 *   Worker 自己缓存 5 分钟（`CACHE_TTL_S`）。前端再留一层同样 5 分钟的模块级缓存，
 *   只是为了「关于页来回切几次」不重复打端点 —— 不配也行，配上更省。
 *   `upstream` / 网络失败**不进缓存**（那是瞬时状态，刷新一下就该重试）。
 *
 * ★ 这里所有失败都吞成一句可显示的状态，绝不抛异常：卡片是"锦上添花"，
 *   端点挂了不该让「关于」页跟着白屏。
 */

/** 端点地址（末尾斜杠先去掉，免得拼出 `//`） */
const ENDPOINT = (import.meta.env.VITE_STEAM_ENDPOINT ?? '').trim().replace(/\/+$/, '')

/** 端点配了没？没配时卡片整个不渲染，且一次请求都不发 */
export const hasSteamEndpoint = ENDPOINT.length > 0

/** 外部依赖，6s 拿不到就当没有（Steam 偶尔很慢，别让卡片一直等） */
const TIMEOUT_MS = 6000

/** 与 Worker 的 `CACHE_TTL_S` 对齐（5 分钟） */
const CACHE_TTL_MS = 300_000

/** 一款「最近在玩」的游戏 */
export interface SteamGame {
  appid: number
  name: string
  /** 小图标 URL（Worker 拼好了 `media.steampowered.com` 前缀） */
  icon: string
  /** 近两周时长（小时，1 位小数） */
  hours2w: number
  /** 总时长（小时）—— 当前 Worker 没打 GetOwnedGames，恒为 0 */
  hoursTotal: number
}

/** Steam 个人资料（可能为 null：资料私密或上游没给） */
export interface SteamProfile {
  name: string
  avatar: string
  url: string
  /** `offline` / `online` / `busy` / `away` / `snooze` / `looking-to-trade` / `looking-to-play` */
  state: string
  /** 正在玩的游戏名，没在玩是 null */
  inGame: string | null
}

/** 端点自报的状态。`null` = 一切正常 */
export type SteamError =
  | 'private'
  | 'games-private'
  | 'no-key'
  | 'no-id'
  | 'upstream'
  | 'network'
  | 'bad-response'
  | null

export interface SteamSnapshot {
  profile: SteamProfile | null
  recent: SteamGame[]
  /** 上游数据的抓取时间（ISO 字符串，可能为空） */
  updatedAt: string
  error: SteamError
  /** 这一份是不是端点缓存里拿的（仅用于自检，界面不用） */
  cached: boolean
}

const KNOWN_ERRORS: ReadonlySet<string> = new Set([
  'private',
  'games-private',
  'no-key',
  'no-id',
  'upstream',
])

/** 瞬时失败：别缓存（刷新一下就该重试） */
const TRANSIENT: ReadonlySet<SteamError> = new Set<SteamError>(['upstream', 'network', 'bad-response'])

function asGame(raw: unknown): SteamGame | null {
  const g = raw as Partial<SteamGame> | null | undefined
  if (!g || typeof g.name !== 'string' || !g.name) return null
  return {
    appid: typeof g.appid === 'number' ? g.appid : 0,
    name: g.name,
    icon: typeof g.icon === 'string' ? g.icon : '',
    hours2w: typeof g.hours2w === 'number' && Number.isFinite(g.hours2w) ? g.hours2w : 0,
    hoursTotal: typeof g.hoursTotal === 'number' && Number.isFinite(g.hoursTotal) ? g.hoursTotal : 0,
  }
}

function asProfile(raw: unknown): SteamProfile | null {
  const p = raw as Partial<SteamProfile> | null | undefined
  if (!p || typeof p.name !== 'string' || !p.name) return null
  return {
    name: p.name,
    avatar: typeof p.avatar === 'string' ? p.avatar : '',
    url: typeof p.url === 'string' ? p.url : '',
    state: typeof p.state === 'string' ? p.state : 'offline',
    inGame: typeof p.inGame === 'string' && p.inGame ? p.inGame : null,
  }
}

/** 端点回的任何东西 → 快照。连 body 都不是对象才算 `bad-response` */
function parse(data: unknown): SteamSnapshot {
  const obj = data as { error?: unknown; profile?: unknown; recent?: unknown; updatedAt?: unknown; cached?: unknown } | null

  if (!obj || typeof obj !== 'object') {
    return { profile: null, recent: [], updatedAt: '', error: 'bad-response', cached: false }
  }

  const rawError = typeof obj.error === 'string' ? obj.error : null
  const error: SteamError = rawError
    ? KNOWN_ERRORS.has(rawError)
      ? (rawError as SteamError)
      : 'upstream'
    : null

  const recent = Array.isArray(obj.recent)
    ? obj.recent.map(asGame).filter((g): g is SteamGame => g !== null)
    : []

  return {
    profile: asProfile(obj.profile),
    recent,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : '',
    error,
    cached: obj.cached === true,
  }
}

/** 模块级缓存 + 并发去重（同一时刻多张卡/多次挂载只打一次端点） */
let cache: { at: number; data: SteamSnapshot } | null = null
let inflight: Promise<SteamSnapshot> | null = null

/**
 * 读一份 Steam 快照。
 * ★ 返回 `null` 只有一种情况：**没配端点**。端点配了但失败会返回带 `error` 的快照
 *   （卡片据此显示「私密」「取不到」等状态，而不是静默消失）。
 */
export async function readSteam(force = false): Promise<SteamSnapshot | null> {
  if (!ENDPOINT) return null

  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data
  if (!force && inflight) return inflight

  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)

  const run = (async (): Promise<SteamSnapshot> => {
    try {
      const res = await fetch(ENDPOINT, {
        signal: ctrl.signal,
        // 缓存由 Worker 负责，这里别叠 HTTP 缓存（否则 dev 下改了假数据刷不出来）
        cache: 'no-store',
        credentials: 'omit',
      })
      const data: unknown = await res.json().catch(() => null)
      const snap = parse(data)
      if (!TRANSIENT.has(snap.error)) cache = { at: Date.now(), data: snap }
      return snap
    } catch {
      /* 超时 / 跨域失败 / 端点没起 —— 都是「暂时取不到」，不进缓存 */
      return { profile: null, recent: [], updatedAt: '', error: 'network', cached: false }
    } finally {
      clearTimeout(timer)
    }
  })()

  inflight = run
  try {
    return await run
  } finally {
    inflight = null
  }
}

/** 状态词 → 中文（卡片直接用，不在模板里堆 map） */
export const STEAM_STATE_TEXT: Readonly<Record<string, string>> = {
  offline: '离线',
  online: '在线',
  busy: '忙碌',
  away: '离开',
  snooze: '打盹',
  'looking-to-trade': '想交易',
  'looking-to-play': '想联机',
}

/**
 * 前端所有可见兜底的统一文案。
 *
 * ★★ 用户 m00455：「把前端的所有能显示出来的错误兜底，全部统一改为：加载失败了😫」
 *    —— 所以端点没配 key、资料设了私密、超时、返回看不懂…… 对访客都是同一句。
 */
export const FALLBACK_TEXT = '加载失败了😫'

/**
 * 错误码 → 卡片上那句话（`null` 不进这里）。
 *
 * ★ 七个码现在长得一模一样（用户 m00455 要求统一文案）。键**故意保留**：
 *   它们是端点 body 里真实存在的 `error` 取值（private / games-private / no-key /
 *   no-id / upstream / network / bad-response），排障时对着 Network 面板能立刻对上号。
 *   想恢复「一种原因一句话」，把下面七个值各自换回原句即可 —— 调用方一行都不用动
 *   （原句见本仓库 2026-10-10 之前的版本：私密 / 游戏详情私密 / 没配 key / 没配 ID /
 *   暂时取不到 / 暂时取不到 / 数据看不懂）。
 */
export const STEAM_ERROR_TEXT: Readonly<Record<string, string>> = {
  private: FALLBACK_TEXT,
  'games-private': FALLBACK_TEXT,
  'no-key': FALLBACK_TEXT,
  'no-id': FALLBACK_TEXT,
  upstream: FALLBACK_TEXT,
  network: FALLBACK_TEXT,
  'bad-response': FALLBACK_TEXT,
}
