/**
 * vMagnetic —— 鼠标跟随（磁性）微动效
 *
 * 用法：
 *   <div v-magnetic>...</div>
 *   <div v-magnetic="0.3">...</div>   // 强度 0..1，默认 0.25
 *
 * 效果：鼠标在元素附近时，元素朝鼠标方向轻微偏移，离开时弹回。
 *
 * ★ 只在「有精确指针」的设备上启用：触屏没有 hover 概念，
 *   强行启用会让点击时元素跳一下，很怪。用 (hover: hover) 判定。
 *
 * ★ 偏移作用在**子元素**上，不是指令所在元素本身：
 *   很多用法里指令元素是 flex/item 容器，直接位移会影响布局
 *   （尤其是 .client-item 这类靠 overflow: hidden 裁背景的元素）。
 *   这里统一拿第一个元素子节点做位移目标；没有子元素时才动自己。
 *
 * ★ 用 motion 的 spring 而不是 CSS transition：
 *   鼠标移动是高频事件，spring 天然带阻尼、不会累积误差，
 *   且能中途改变目标值仍然平滑（CSS transition 会「重启」）。
 */
import type { Directive, DirectiveBinding } from 'vue'
import { animate, prefersReducedMotion } from '@/composables/motion'

const cleanups = new WeakMap<HTMLElement, () => void>()

const MAX_OFFSET = 14 // px，元素最多偏移多少

export const vMagnetic: Directive<HTMLElement, number | undefined> = {
  mounted(el: HTMLElement, binding: DirectiveBinding<number | undefined>) {
    if (prefersReducedMotion()) return
    // 触屏 / 无精确指针：不启用
    if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return

    const strength = Math.max(0, Math.min(1, binding.value ?? 0.25))

    /* 位移目标：优先第一个元素子节点，否则元素自身。
     *
     * ★ 但只在这个子节点**不是**布局关键元素时才用它。
     *   例：`.hero-next` 的两个 span 靠 `align-items: baseline` 对齐，
     *   单独位移其中一个会破坏基线；这种情况应该整体位移按钮本身。
     *   判据：元素自身是 flex/grid 容器且子节点参与对齐时，动自己更安全。
     *   这里用简单可靠的规则 —— 只有「子节点就是唯一可见内容」时才用子节点。 */
    const childEls = Array.from(el.children).filter((c) => c instanceof HTMLElement)
    const useSelf = el.classList.contains('hero-next') || childEls.length > 1
    const target = useSelf ? el : ((childEls[0] as HTMLElement) ?? el)

    let controls: { stop: () => void } | null = null

    const onMove = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      // 鼠标相对元素中心的偏移，归一到 -1..1
      const dx = (e.clientX - (r.left + r.width / 2)) / (r.width / 2)
      const dy = (e.clientY - (r.top + r.height / 2)) / (r.height / 2)
      const x = dx * MAX_OFFSET * strength
      const y = dy * MAX_OFFSET * strength

      controls?.stop()
      controls = animate(
        target,
        { transform: `translate(${x}px, ${y}px)` },
        { type: 'spring', stiffness: 260, damping: 22, mass: 0.6 },
      )
    }

    const onLeave = () => {
      controls?.stop()
      controls = animate(
        target,
        { transform: 'translate(0px, 0px)' },
        { type: 'spring', stiffness: 220, damping: 20, mass: 0.6 },
      )
    }

    el.addEventListener('mousemove', onMove)
    el.addEventListener('mouseleave', onLeave)

    cleanups.set(el, () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mouseleave', onLeave)
      controls?.stop()
    })
  },

  unmounted(el: HTMLElement) {
    cleanups.get(el)?.()
    cleanups.delete(el)
  },
}
