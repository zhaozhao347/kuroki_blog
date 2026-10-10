/**
 * 动效基础设施 —— 统一入口
 *
 * 这里集中管理两件事，避免各组件各自初始化导致冲突：
 *   1) Lenis 平滑滚动（整页滚动接管）
 *   2) motion 的 prefers-reduced-motion 判定（所有动效都要尊重它）
 *
 * ★ 为什么用 `motion` 而不是 GSAP/其他：
 *   它是 v13，只提供通用核心 API（animate / scroll / inView / stagger），
 *   没有 Vue 绑定（只出 React 版）。所以下面全部是原生 DOM 用法。
 *
 * ★ Lenis 的坑（都踩过）：
 *   - 必须把 scrollTo 桥接到 router 的 scrollBehavior，否则路由切换后
 *     位置会漂移（Lenis 持有自己的滚动状态，不认 window.scrollTo）
 *   - `autoRaf: false` + 手动 raf：这样能精确控制启停，也方便在
 *     prefers-reduced-motion 下彻底不启动
 */
import Lenis from 'lenis'
import { animate, inView, scroll } from 'motion'
import type { AnimationPlaybackControls } from 'motion'

/** 用户是否要求减少动态效果（无障碍） */
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/* ==================== Lenis 平滑滚动 ==================== */

let lenis: Lenis | null = null
let rafId = 0

export function getLenis() {
  return lenis
}

export function initSmoothScroll() {
  if (lenis || prefersReducedMotion()) return lenis

  lenis = new Lenis({
    /* 滚动阻尼：越大越"粘"，越小越跟手。
       1.1 接近原站 Lenis 的默认手感。 */
    lerp: 0.1,
    /* 触屏不接管：移动端原生滚动已经足够顺，接管反而会打架
       （尤其是 iOS 的橡皮筋与地址栏收起行为）。 */
    smoothWheel: true,
    syncTouch: false,
  })

  const raf = (time: number) => {
    lenis?.raf(time)
    rafId = requestAnimationFrame(raf)
  }
  rafId = requestAnimationFrame(raf)

  return lenis
}

export function destroySmoothScroll() {
  cancelAnimationFrame(rafId)
  rafId = 0
  lenis?.destroy()
  lenis = null
}

/* ★ 曾经有一个 `smoothScrollTo(top)` 工具函数（2026-09-22 删除）。
   它没有任何调用点 —— 全站的滚动复位都由 `router/index.ts` 的
   `scrollBehavior` 负责（那里直接操作 lenis 实例，因为它们必须
   同步在同一个 Promise 里 resolve）。留着只会误导人以为
   「想滚动应该调它」。 */

/* ==================== 载入完成信号 ==================== */
/* Loader 播完后放行，让 hero 入场动画能接着它演，而不是被遮罩盖住白播。
 *
 * 用模块级 Promise（而不是 provide/inject）：
 *   Loader 在 App 的根层，hero 在页面组件里，层级隔了几层；
 *   而这个信号本质是「全局一次性的启动事件」，单例最直接。
 *
 * ★ 必须带超时兜底：万一 Loader 因异常没播（或没调 markBooted），
 *   hero 动画不能永远等下去。 */
let bootResolve: (() => void) | null = null
const bootPromise = new Promise<void>((resolve) => {
  bootResolve = resolve
})

export function markBooted() {
  bootResolve?.()
  bootResolve = null
}

export function whenBooted(timeoutMs = 2600): Promise<void> {
  return Promise.race([bootPromise, new Promise<void>((r) => setTimeout(r, timeoutMs))])
}

/* ==================== motion 便捷封装 ==================== */

export { animate, inView, scroll }
export type { AnimationPlaybackControls }
