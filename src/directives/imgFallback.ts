/**
 * v-img-fallback 指令：图片请求不到时给一个像样的占位，而不是破图图标
 *
 * 用法：
 *   <img v-img-fallback :src="p.image" :alt="p.title" />
 *
 * ★ 为什么需要：md 里写了 cover、但图片被删 / 路径写错 / 图床挂了，
 *   浏览器会画出「破图图标 + alt 文字」，看着像整页坏了。
 *   静态站没有后端可以兜，只能在前端收场。
 *
 * ★ 兜底形态：给 img 加 `.is-broken`（CSS 用 visibility: hidden ——
 *   **不能**用 display: none，带 `aspect-ratio` 的媒体框会塌成 0 高），
 *   同时给父级加 `.has-broken-img`，由它顶上占位底 + 一行说明。
 *
 * ★ 必须补一次「挂载时就已经是坏图」的检查：图片命中 HTTP 缓存里的失败态时
 *   error 事件不会再来一遍（`complete && naturalWidth === 0` 就是这种状态）。
 */
import type { Directive } from 'vue'

/** el → 已挂上的 error 处理函数（卸载时摘掉） */
const handlers = new WeakMap<HTMLImageElement, () => void>()

function markBroken(el: HTMLImageElement) {
  el.classList.add('is-broken')
  el.parentElement?.classList.add('has-broken-img')
}

export const vImgFallback: Directive<HTMLImageElement> = {
  mounted(el: HTMLImageElement) {
    const onError = () => markBroken(el)
    handlers.set(el, onError)
    el.addEventListener('error', onError)
    if (el.complete && el.naturalWidth === 0) markBroken(el)
  },

  unmounted(el: HTMLImageElement) {
    const onError = handlers.get(el)
    if (onError) el.removeEventListener('error', onError)
    handlers.delete(el)
  },
}
