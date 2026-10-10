/**
 * v-reveal 指令：元素进入视口时淡入上浮
 *
 * 用法：
 *   <div v-reveal>...</div>
 *   <div v-reveal="150">...</div>   // 延迟 150ms
 *
 * ── 2026-09-19 改为 motion 驱动 ──
 * 原来是纯 CSS（[data-reveal] + .is-visible 类切换）。换 motion 的好处：
 *   - 不用再往元素上挂 data-* / 类名，状态不落地到 DOM
 *   - 能拿到返回的 controls，卸载时可 stop()，避免组件已销毁还在写样式
 *   - 缓动/时长统一走 motion 的 ease 定义，与其它动效一致
 *
 * ★ 保留「只播一次」语义（motion 的 inView 默认每次进出都触发）：
 *   进入即取消订阅，与旧实现一致。
 *
 * ★ 位移量保持 1.5rem 不变：DefaultLayout 里测量「内容是否与导航重叠」
 *   时会用 offsetTop 绕开 transform 干扰（见那段注释）。
 *   这里若改成更大位移，那个判定仍然安全 —— 但别再引入 scale 之类的
 *   会影响布局测量的属性。
 */
import type { Directive, DirectiveBinding } from 'vue'
import { animate, inView, prefersReducedMotion } from '@/composables/motion'

/** 已挂载动画的元素 → 其清理函数（卸载时用） */
const cleanups = new WeakMap<HTMLElement, () => void>()

export const vReveal: Directive<HTMLElement, number | undefined> = {
  mounted(el: HTMLElement, binding: DirectiveBinding<number | undefined>) {
    // 无障碍：直接显示，不做动画
    if (prefersReducedMotion()) return

    const delay = (typeof binding.value === 'number' ? binding.value : 0) / 1000

    /* 先置为不可见，避免「原样闪现一帧再开始动画」 */
    el.style.opacity = '0'

    const cancel = inView(
      el,
      () => {
        /* 进入视口即取消订阅 —— 只播一次，与旧实现一致 */
        cancel()
        const controls = animate(
          el,
          {
            opacity: [0, 1],
            transform: ['translateY(1.5rem)', 'translateY(0rem)'],
          },
          { duration: 0.8, delay, ease: [0.22, 1, 0.36, 1] },
        )
        cleanups.set(el, () => controls.stop())
      },
      /* margin 用负值把触发线往上收，元素进入屏幕约 88% 处才开始
         （对应旧的 rootMargin: '0px 0px -12% 0px'） */
      { margin: '0px 0px -12% 0px', amount: 0.08 },
    )

    cleanups.set(el, cancel)
  },

  unmounted(el: HTMLElement) {
    cleanups.get(el)?.()
    cleanups.delete(el)
  },
}
