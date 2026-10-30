/**
 * 曲目表 —— 站点上能播的歌，只有这一处清单。
 *
 * ── 音频从哪来 ──
 *   仓库里**没有任何 mp3**（2026-10-08 起改为接网易云）。
 *
 *   · 本地 dev：`/music/stream?id=<id>`，由 `plugins/vite-plugin-api-proxy.ts`
 *     用 `workers/api/src/netease.js` 的**同一份实现**顶替，所以 `npm run dev`
 *     不需要先部署。
 *   · 线上：默认走**公共镜像** `https://api.injahow.cn/meting/?type=url&id=<id>`
 *     （302 到网易云 CDN，见下方 `MIRROR`）；配了 `VITE_MUSIC_ENDPOINT` 就用自建端点。
 *
 *   ★ 为什么线上不用自建 Worker：它跑在 Cloudflare 境外机房，网易云对境外 IP 的
 *     playurl 直接回 `404`（开 Smart Placement 后是 `-462` 风控码）—— 这是地域限制，
 *     不是代码问题；同一接口从大陆 IP 请求是 `code=200` + 320 kbps 直链。
 *   ★ 网易云 playurl 不给 CORS 头（浏览器自己解析不了），返回的直链带 IP 令牌、
 *     20 分钟过期，而且可能是 http —— 所以只能「让服务端换一个 https 直链再 302」。
 *
 * ── 加 / 换一首歌 ──
 *   ① 往下面 `songs` 里加一项（`id` 必填，其余是**手写**的显示用元数据）
 *   ② 把同一个 id 加进 `workers/api/wrangler.toml` 的 `ALLOWED_IDS` 并重新部署
 *   ★ 元数据手写而不是运行时拉取：曲名/艺术家/专辑/时长只有 playurl 之外的接口
 *     才有（song/detail），为了列表里显示几行字多发一轮请求不值得。
 *     真值（`br`、真实时长）以浏览器解出来的为准，见 `composables/player.ts`。
 *
 * ── 没配端点会怎样 ──
 *   生产环境若没给 `VITE_MUSIC_ENDPOINT`，曲目表就是**空的**，
 *   音乐栏显示一句「端点未配置」，而不是给一排点了没反应的按钮。
 */
import type { Track } from '@/composables/player'

/** 一首歌的清单项（`url` 是拼出来的，不在这里写） */
interface Song {
  /** 网易云歌曲 id —— music.163.com/song?id=<这串数字> */
  id: string
  /** 稳定标识：记住播放位置、列表 key 都用它，改歌名不该丢进度 */
  slug: string
  title: string
  artist: string
  /** 专辑；与曲名重复时省略（否则抽屉里同一行字出现两遍） */
  album?: string
  year?: string
  /** 秒。列表里显示用；播放时以浏览器解出的真实时长为准 */
  duration?: number
}

const songs: Song[] = [
  {
    id: '1311002329',
    slug: 'world-goes-round',
    title: 'World Goes Round',
    artist: '岩崎太整 / 二宮愛',
    /* ★ 网易云曲库里这张专辑名把 Soundtrack 拼成了 "Sountrack"，
       这里按正确拼写显示（清单是手写元数据，不跟上游逐字对齐）。 */
    album: 'Blood Blockade Battlefront (Original Series Soundtrack)',
    duration: 198.813,
  },
  {
    id: '3371533046',
    slug: 'anime-openings-be-like',
    title: 'anime openings be like',
    artist: 'ALN',
    /* 专辑名与曲名相同，省掉（见 Song.album 的说明） */
    duration: 216.75,
  },
]

/**
 * 端点地址。尾部斜杠先剥掉，拼 `url` 时才不会出现 `//stream`。
 * ★ dev 下没配就默认 `/music`（走本地中间件）。
 */
const endpoint = (import.meta.env.VITE_MUSIC_ENDPOINT ?? '').trim().replace(/\/+$/, '')
const base = endpoint || (import.meta.env.DEV ? '/music' : '')

/**
 * 纯内网模式（`VITE_OFFLINE=1`，见 `deploy/local/`）：整个站不许有任何外网请求。
 * 此时**默认没有歌**——镜子在公网，内网机器多半连不上，给一排点了没反应的按钮更糟。
 */
const OFFLINE = import.meta.env.VITE_OFFLINE === '1'

/**
 * 静态音频目录（可选）。配了就用 `${目录}${slug}.mp3`，音频文件自己丢进 nginx 的
 * 那个目录即可（内网最省事的放歌方式，不需要任何接口）。
 * 例：`VITE_MUSIC_BASE=/music/`
 */
const rawStaticBase = (import.meta.env.VITE_MUSIC_BASE ?? '').trim()
/* ★ 空串必须留空：`''.replace(/\/?$/, '/')` 会得到 `'/'`，于是每首歌都被拼成
   `/xxx.mp3` —— 内网版就莫名其妙地"有歌"了（点了当然 404）。 */
const staticBase = rawStaticBase ? `${rawStaticBase.replace(/\/+$/, '')}/` : ''

/**
 * 线上兜底：**公共网易云镜像**（Meting 风格：`?type=url&id=` 直接 302 到 mp3）。
 *
 * ★ 为什么不用自家 Worker：Worker 跑在 Cloudflare 境外机房，网易云对境外 IP 的
 *   playurl 直接回 `404`（开 Smart Placement 后变成 `-462` 风控码），救不回来。
 *   公共镜像的出口在国内，能正常换到直链。
 * ★ 为什么是 302 而不是 Worker 转发字节：音频不经 Cloudflare，浏览器直接从
 *   网易云 CDN 下载 —— 实测 CDN 带 `Access-Control-Allow-Origin: *`（Web Audio
 *   能取到数据、波形可用），也支持 `Range`（拖进度条正常）。
 * ★ 风险：公益镜像可能哪天挂。挂了就换一个域名，或改回自建端点。
 */
const MIRROR = 'https://api.injahow.cn/meting/?type=url&id='

/** 是否纯内网构建（`VITE_OFFLINE=1`）。视图层据此决定要不要摆音乐栏 */
export const offline = OFFLINE

/** 一首歌最终用哪个 URL；纯内网且没配静态目录时返回 null（这首直接不进列表） */
function trackUrl(song: Song): string | null {
  if (staticBase) return `${staticBase}${song.slug}.mp3`
  /* ★ OFFLINE 必须排在 `base` 前面：`.env.local` 里写着 `VITE_MUSIC_ENDPOINT=/music`
     （dev 用），而 Vite 在所有模式都会加载 `.env.local` —— 不先拦，内网版就会去请求
     一个根本不存在的 `/music/stream`。 */
  if (OFFLINE) return null
  if (base) return `${base}/stream?id=${encodeURIComponent(song.id)}`
  return `${MIRROR}${encodeURIComponent(song.id)}`
}

/** 组装一首 Track（可选字段只在有值时才挂上去，兼容 `exactOptionalPropertyTypes`） */
function toTrack(song: Song, url: string): Track {
  const track: Track = {
    slug: song.slug,
    url,
    title: song.title,
    artist: song.artist,
  }
  if (song.album) track.album = song.album
  if (song.year) track.year = song.year
  if (song.duration) track.duration = song.duration
  return track
}

/** 拼好的曲目表（player.ts 直接用它建播放列表） */
export const tracks: Track[] = songs.flatMap((song) => {
  const url = trackUrl(song)
  return url ? [toTrack(song, url)] : []
})

export const total = tracks.length
