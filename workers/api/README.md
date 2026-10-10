# 边缘函数（Cloudflare Worker）—— 一个 Worker，三件事

```
浏览器 ──▶  blog-api.<子域>.workers.dev ──┬─ /views  计数（KV）
                                          ├─ /music  音频转发 ──▶ music.163.com
                                          └─ /steam  Steam 资料 ──▶ api.steampowered.com
```

三条路径合在一个 Worker 里：一次 `deploy`、一份 CORS、一个域名，前端只换三个环境变量。
（早期只有音乐时它在 `workers/music/`，2026-10-09 合并成 `workers/api/`。）

## 路由

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET / POST | `/views` | 浏览量：POST 自增并回总数，GET 只读；KV key `total` |
| GET / HEAD | `/music/stream?id=<网易云歌曲id>` | 音频流；`Range` 原样透传，回 206 |
| GET | `/music/info` | 自检：路由、音质档、白名单状态、缓存条数 |
| GET | `/steam` | Steam 资料 + 最近在玩（JSON，见下） |
| GET | `/steam/info` | 自检：有没有 key、有没有 steamID、缓存秒数 |
| OPTIONS | 任意 | CORS 预检（`Access-Control-Allow-Origin: *`） |

★ 路径前缀是**宽松**的：`/stream`、`/music/stream`、`/steam`、`/views` 都认
（`/info` 按所在前缀分别答音乐或 Steam）。所以 `.env.local` 里带不带 `/music`
都行 —— 但**推荐带上**，三条端点排在一起时更好读。

## 部署

```bash
cd workers/api
npx wrangler login                        # 只需一次
npx wrangler kv namespace create VIEWS    # ← 把打印出的 id 填进 wrangler.toml
npx wrangler secret put STEAM_API_KEY     # ← https://steamcommunity.com/dev/apikey
npx wrangler deploy
```

然后写进项目根 `.env.local`（三个变量指向同一个域，路径不同）：

```
VITE_MUSIC_ENDPOINT=https://blog-api.<你的子域>.workers.dev/music
VITE_VIEWS_ENDPOINT=https://blog-api.<你的子域>.workers.dev/views
VITE_STEAM_ENDPOINT=https://blog-api.<你的子域>.workers.dev/steam
```

★ `STEAM_ID` 也要填（`wrangler.toml` 的 `[vars]`）：vanity 名不行，要 17 位 steamID64。

## 为什么每件事都非得有端点

- **音乐**：网易云 playurl 接口**不给 CORS 头**；直链带 IP 令牌、20 分钟过期；直链还是
  `http://`，https 站点会被混合内容拦掉。三点都只能靠服务端转发解决。
- **浏览量**：纯静态站算不出次数，只能外部计数（KV 一个 key）。
- **Steam**：每个请求都要**账号级 key**，打进前端等于送人（比网易云更严重：能读整个库）；
  而且 Steam Web API **一个 CORS 头都不给**，浏览器有 key 也读不到。

## 响应形状（前端按这个写死）

`GET /views` → `{ "views": 123 }`

`GET /steam` →

```json
{
  "profile": { "name": "…", "avatar": "…", "url": "…", "state": "online", "inGame": null },
  "recent": [{ "appid": 730, "name": "…", "icon": "https://media.steampowered.com/…", "hours2w": 6.5, "hoursTotal": 0 }],
  "updatedAt": "2026-10-09T…",
  "error": null,
  "cached": false
}
```

★ `error` 可能出现在**任何状态码**上：`private`（资料私密）/ `games-private`（游戏详情私密）/
`no-key` / `no-id` / `upstream`。前端**只看 body 里的 `error`**，不看状态码 ——
Steam 把资料设成私密时上游**不报错**，只回空的 `players: []`，不主动判空就会显示一张空卡。
（隐私是个真坑，见 `src/steam.js` 顶部注释。）

## 本地开发不用部署

`npm run dev` 时 Vite 会把**同一份**实现挂成中间件
（`plugins/vite-plugin-api-proxy.ts`）：`/views`、`/music`、`/steam` 直接可用，
KV 和缓存换成进程内存版。两条路径共用一份实现，避免「dev 能放、线上不行」。

Steam 是唯一需要额外东西的：**要真的 key**。

```powershell
$env:STEAM_API_KEY = '你的 key'
$env:STEAM_ID = '7656119…'
npm run dev
```

★★ 本机跑 dev 时如果 `/steam` 回 `{"error":"upstream","detail":"fetch failed (unable to verify
the first certificate…)"}`，那是**本机证书链问题**，不是代码问题 —— 本机 Node 自带的 CA
包里没有 Steam 那条链的中间证书。给 dev server 加一个开关即可：

```powershell
$env:NODE_OPTIONS = '--use-system-ca'   # 用系统证书库（Node 22+）
npm run dev
```

线上（Cloudflare）不存在这个问题。

## 白名单（重要）

`wrangler.toml` 的 `ALLOWED_IDS` 决定哪些歌能用音乐代理：

- **必须**与 `src/playlist.ts` 里 `songs[].id` 保持一致，否则点播放会 403；
- 留空 = 不限制 = 任何人都能拿它当「任意网易云歌曲的免费代理」，流量算在你头上 —— 不建议。

改完 `ALLOWED_IDS` / `STEAM_ID` 要重新 `npx wrangler deploy`。

## 文件

| 文件 | 内容 |
| --- | --- |
| `src/index.js` | 入口：按首段路由分发 + 全局 OPTIONS |
| `src/http.js` | `json()` / `preflight()` / CORS 头 / 路由表 |
| `src/views.js` | 浏览量（KV 读改写自增） |
| `src/netease.js` | 网易云解析 + 音频转发（从 `workers/music/` 原样搬来） |
| `src/steam.js` | Steam 资料 + 最近在玩（含隐私判空、5 分钟缓存） |

★ 这目录**不在任何 tsconfig 的 include 里**：写的是纯 JS（Worker 运行时直接吃），
旁边配同名 `.d.ts` 给 `plugins/vite-plugin-api-proxy.ts`（那个在类型检查范围内）用。
