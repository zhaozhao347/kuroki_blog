/**
 * `src/steam.js` 的类型声明（纯 JS + 同名 d.ts，理由见 netease.d.ts）。
 */
export interface SteamEnv {
  /** Steam Web API key：**只**来自 `wrangler secret put STEAM_API_KEY`（或 dev 的 .env.local） */
  STEAM_API_KEY?: string
  /** 17 位 steamID64；用 ResolveVanityURL 换一次后写死在 [vars] 里 */
  STEAM_ID?: string
  /** 「最近在玩」取几款，默认 3、上限 10 */
  STEAM_RECENT_COUNT?: string
}

/** dev 中间件塞进来的内存缓存版本也满足这个形状 */
export interface SteamCache {
  get(key: string): Promise<object | null>
  put(key: string, data: object): Promise<void>
}

/** 上游结果缓存秒数（线上 `caches.default` 与 dev 的 Map 版共用这一个值） */
export declare const CACHE_TTL_S: number

export function handleSteamRequest(
  request: Request,
  env?: SteamEnv,
  deps?: { cache?: SteamCache | null },
): Promise<Response>
