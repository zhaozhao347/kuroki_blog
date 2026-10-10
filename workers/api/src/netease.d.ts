/**
 * `src/netease.js` 的类型声明。
 *
 * ★ 那份实现是**纯 JS**（要能直接被 wrangler 打包、也要能被 dev 中间件
 *   `plugins/vite-plugin-api-proxy.ts` 导入），而 tsconfig 没开 `allowJs`。
 *   于是把签名单独声明在这里：TS 侧 import `netease.js` 时会取这份 d.ts，
 *   运行期用的仍是同名 .js —— 两边靠文件同名的约定绑定。
 */
export interface MusicEnv {
  /** 逗号分隔的网易云歌曲 id 白名单；留空 = 不限制 */
  ALLOWED_IDS?: string
}

export function handleMusicRequest(request: Request, env?: MusicEnv): Promise<Response>
export function clearUrlCache(): void
