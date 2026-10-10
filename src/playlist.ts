/**
 * 曲目表 —— 站点上能播的歌，只有这一处清单。
 *
 * ── 音频从哪来 ──
 *   仓库里**没有任何 mp3**（2026-10-08 起改为接网易云）。播放时音频来自自建端点：
 *
 *     <VITE_MUSIC_ENDPOINT>/stream?id=<网易云歌曲id>
 *
 *   端点在 `workers/api/`（Cloudflare Worker）；本地 dev 由
 *   `plugins/vite-plugin-api-proxy.ts` 用**同一份实现**顶替，所以
 *   `npm run dev` 不需要先部署。
 *
 *   ★ 为什么必须自建端点：网易云 playurl 接口不给 CORS 头（浏览器自己解析不了），
 *     返回的直链带 IP 令牌、20 分钟就过期，而且是 http（https 站点会拦混合内容）。
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
 * ★ dev 下没配就默认 `/music`（走本地中间件）；生产没配就是空 —— 曲目表为空，
 *   MusicBar 给出配置提示。这样「忘了配」是**看得见**的，不是静默的静音。
 */
const endpoint = (import.meta.env.VITE_MUSIC_ENDPOINT ?? '').trim().replace(/\/+$/, '')
const base = endpoint || (import.meta.env.DEV ? '/music' : '')

/** 拼好的曲目表（player.ts 直接用它建播放列表） */
export const tracks: Track[] = base
  ? songs.map((song) => ({
      slug: song.slug,
      url: `${base}/stream?id=${encodeURIComponent(song.id)}`,
      title: song.title,
      artist: song.artist,
      album: song.album,
      year: song.year,
      duration: song.duration,
    }))
  : []

export const total = tracks.length
