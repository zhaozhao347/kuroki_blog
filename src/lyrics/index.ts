/**
 * 歌词数据 —— 一首歌一个 `.lrc`，**文件名 = `src/playlist.ts` 里的 slug**。
 *
 *     src/lyrics/world-goes-round.lrc   ← 对应 { slug: 'world-goes-round' }
 *
 * ── 为什么是本地文件，不是接口 ──
 *   网易云的歌词接口（`/api/song/lyric`）和 playurl 一样**不给 CORS 头**，
 *   浏览器直连会被拦；走自建 Worker 又要多一条路由 + 重新部署。
 *   而站点上只有两首歌、歌词是静态文本 —— 打进仓库最省事，
 *   也顺带让「改一句歌词」不用经过任何接口。将来歌多了再考虑接口，见 §5.16。
 *
 * ── 为什么用 `import.meta.glob` 而不是 `?raw` 静态导入 ──
 *   首屏预算是 88 KB gz（`scripts/budget.mjs`）。歌词只有**点了播放**才需要，
 *   所以这里拿到的是**懒加载函数**：每首一个独立 chunk，没人播就一个字节都不下。
 *   千万别改成 `{ eager: true }` —— 那会把所有歌词塞进入口块。
 *
 * ── LRC 怎么办 ──
 *   没有歌词的歌（例如改编/串烧）**不建文件**即可：`lyricLoader()` 返回 undefined，
 *   歌词层整块不渲染。不要放一个只有时间轴的假文件。
 */

/** 一句歌词 */
export interface LyricLine {
  /** 起始时间（秒，带小数） */
  t: number
  /** 这一行的文字（已去掉时间轴前缀与空行） */
  text: string
}

/**
 * 一首歌一个 loader（懒加载）。
 * ★ key 形如 `./world-goes-round.lrc` —— 与 `lyricLoader()` 的拼接方式必须一致。
 */
const loaders = import.meta.glob('./*.lrc', {
  query: '?raw',
  import: 'default',
}) as Record<string, () => Promise<string>>

/** 按 slug 取 loader；这首歌没有歌词文件时返回 undefined */
export function lyricLoader(slug: string): (() => Promise<string>) | undefined {
  return loaders[`./${slug}.lrc`]
}

/** 时间轴：`[mm:ss]` / `[mm:ss.xx]` / `[mm:ss.xxx]`（分最多三位，容错老式 LRC） */
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

/**
 * 解析 LRC 文本 → 按时间升序的歌词行。
 *
 * 处理到的坑：
 * - **一行多个时间轴**（副歌复用）：每个时间轴各出一行，否则副歌只唱一次
 * - **元数据行**（`[ar:]` / `[by:]` / `[offset:]`）：正则要求冒号前是数字，
 *   它们天然匹配不上，直接跳过
 * - **同一时间戳重复**（有些 LRC 会写两遍）：只留第一条，避免下标抖动
 * - **空文本行**：丢掉（纯时间轴的行没有可显示内容）
 *
 * ★ 不解析 `[offset:]`：需要整体平移就改下面的 `LEAD`，
 *   或者直接在 LRC 里修时间轴 —— 两个偏移量来源迟早打架。
 */
export function parseLrc(raw: string): LyricLine[] {
  const lines: LyricLine[] = []

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue

    const times: number[] = []
    TIME_TAG.lastIndex = 0
    let match: RegExpExecArray | null
    while ((match = TIME_TAG.exec(line)) != null) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      // `.5` / `.45` / `.455` 都按小数处理（不能当整数毫秒，否则 .45 会变成 0.45ms）
      const fraction = match[3] ? Number(`0.${match[3]}`) : 0
      times.push(minutes * 60 + seconds + fraction)
    }
    if (!times.length) continue

    const text = line.replace(TIME_TAG, '').trim()
    if (!text) continue

    for (const t of times) lines.push({ t, text })
  }

  lines.sort((a, b) => a.t - b.t)

  const deduped: LyricLine[] = []
  for (const line of lines) {
    const last = deduped[deduped.length - 1]
    if (last && Math.abs(last.t - line.t) < 0.001) continue
    deduped.push(line)
  }
  return deduped
}
