/**
 * 打字机（逐字显示）—— 目前只给「关于」页那张头像卡上的签名用。
 *
 * ── 为什么要等 `whenBooted()` ──
 *   首屏 Loader 会盖住整页（见 `AppLoader.vue`），`/about` 实测约 1.3 秒才掀幕。
 *   立刻开打等于演给幕布看，所以默认**等掀幕之后**再开，
 *   另加一小段 `startDelay`（让视线从面板挪到侧栏）。
 *
 * ── 为什么自带「停顿表」──
 *   匀速吐字不像打字机：标点处多停一拍才有手感
 *   （`，、；：` 停 3 倍，`。！？` 停 5 倍）。用固定倍率而不是随机数，
 *   同样文本每次的节奏一致，探针也好断言。
 *
 * ── reduced-motion ──
 *   `prefersReducedMotion()` 为真时**直接给全文**、连光标都不上（不做无意义的动效）。
 *
 * ★★ 用它的组件**必须**留一个「不可见的全文副本」把宽高撑住（见 AboutView 的
 *   `.profile-tagline > .tw-ghost`）：否则逐字变长时，下面那行图标会一路往下跳。
 */
import { onBeforeUnmount, ref } from 'vue'

import { prefersReducedMotion, whenBooted } from '@/composables/motion'

interface TypewriterOptions {
  /** 每个字的间隔 ms */
  speed?: number
  /** 掀幕之后再等多久开打 ms */
  startDelay?: number
}

/**
 * @param text 取文本的函数（只在 setup 期调用一次 —— frontmatter 是构建期注入的，不会变）
 */
export function useTypewriter(text: () => string, options: TypewriterOptions = {}) {
  const { speed = 78, startDelay = 260 } = options
  const full = text() ?? ''

  const reduced = prefersReducedMotion()
  const shown = ref(reduced ? full : '')
  /** 打完了（template 用它把光标淡出） */
  const done = ref(reduced)

  let timer: number | undefined
  let cancelled = false

  /** 标点后的额外停顿 */
  function pauseAfter(ch: string): number {
    if ('。！？!?…'.includes(ch)) return speed * 5
    if ('，、；：,;:'.includes(ch)) return speed * 3
    return 0
  }

  function step() {
    if (cancelled) return
    const n = shown.value.length
    if (n >= full.length) {
      done.value = true
      return
    }
    shown.value = full.slice(0, n + 1)
    timer = window.setTimeout(step, speed + pauseAfter(full.charAt(n)))
  }

  void (async () => {
    if (reduced || !full) {
      if (!full) done.value = true
      return
    }
    await whenBooted()
    if (cancelled) return
    timer = window.setTimeout(step, startDelay)
  })()

  onBeforeUnmount(() => {
    cancelled = true
    if (timer !== undefined) window.clearTimeout(timer)
  })

  return { shown, done }
}
