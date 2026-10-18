/**
 * 歌词同步 —— 把「当前播到第几秒」翻译成「上一句 / 当前句 / 下一句」。
 *
 * 数据：`src/lyrics/<slug>.lrc`（懒加载，见 `src/lyrics/index.ts`）
 * 时钟：`onFrameTime()`（逐帧的 `audio.currentTime`，不是整秒的 `currentTime` ref）
 *
 * ★ 这个 composable **不碰 DOM**：只给出三个 `computed`，怎么摆位是组件的事。
 *   （所以以后要在音乐球面板里也显示歌词，直接复用这一份即可。）
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

import { current, onFrameTime } from '@/composables/player'
import { lyricLoader, parseLrc, type LyricLine } from '@/lyrics'

/**
 * 提前量（秒）：句子在**人声落下前**一点点就换上来。
 * 0 = 严格按时间轴；调大 = 提前，调小/负值 = 延后。
 * ★ 只放一个偏移量来源（不要在 LRC 里再写 `[offset:]`），否则两处相加会翻倍。
 */
const LEAD = 0.18

export function useLyrics() {
  /** 当前这首歌的全部歌词行（空数组 = 这首歌没有歌词） */
  const lines = ref<LyricLine[]>([])
  /** 当前句在 `lines` 里的下标；-1 = 还没到第一句 */
  const index = ref(-1)

  const prev = computed(() => (index.value > 0 ? lines.value[index.value - 1] : undefined))
  const now = computed(() => (index.value >= 0 ? lines.value[index.value] : undefined))
  const next = computed(() => lines.value[index.value + 1])

  /** 最近一次拿到的播放位置：歌词**载入完成时**要用它补算一次下标 */
  let lastSeconds = 0

  /** 异步竞态的令牌：切歌太快时，旧请求的结果必须丢掉 */
  let token = 0

  async function load(slug: string | undefined): Promise<void> {
    const mine = ++token
    index.value = -1
    lines.value = []
    if (!slug) return

    const loader = lyricLoader(slug)
    if (!loader) return

    try {
      const raw = await loader()
      if (mine !== token) return
      lines.value = parseLrc(raw)
      // ★ 载入前就已经在播了（刷新后恢复位置、或中途切回这首歌）：
      //   不补算就会从第一句开始显示，直到下一句才「跳」到位。
      sync(lastSeconds)
    } catch (err) {
      if (mine !== token) return
      console.warn('[lyrics] 歌词加载失败：', slug, err)
      lines.value = []
    }
  }

  watch(() => current.value?.slug, (slug) => void load(slug), { immediate: true })

  /**
   * 二分找「最后一个起始时间 ≤ 当前时间」的行。
   * ★ 只在**下标真的变了**时写 ref：这里每帧都会被调用，
   *   每帧写 ref 等于每秒让组件重渲染 60 次。
   */
  function sync(seconds: number): void {
    lastSeconds = seconds
    const list = lines.value
    if (!list.length) return

    const t = seconds + LEAD
    let lo = 0
    let hi = list.length - 1
    let found = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].t <= t) {
        found = mid
        lo = mid + 1
      } else {
        hi = mid - 1
      }
    }
    if (found !== index.value) index.value = found
  }

  let off: (() => void) | null = null
  onMounted(() => {
    off = onFrameTime(sync)
  })
  onBeforeUnmount(() => {
    off?.()
    off = null
  })

  return { lines, index, prev, now, next }
}
