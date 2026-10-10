/**
 * 路由遮罩（液态玻璃转场）的桥
 *
 * 为什么需要这一层：
 *   router/index.ts 只能拿到「函数」，拿不到组件实例；而遮罩组件也不该知道
 *   router 的存在。两边都只认这两个 Promise：
 *     cover()  —— 把遮罩铺满（铺完才 resolve）
 *     reveal() —— 把遮罩收回去（收完才 resolve）
 *
 * ★ 守卫里 `await cover()` 是**故意**的：导航会因此暂停，旧页面在遮罩
 *   铺满之前一动都不动，切换全部发生在玻璃后面（见 router/index.ts）。
 *
 * ★ 注册可能晚于首次导航（App 挂载顺序），此时 handlers 为 null，
 *   cover/reveal 直接 resolve —— 退化成「无转场」，不会卡住导航。
 */
import { prefersReducedMotion } from '@/composables/motion'

type RouteCoverHandlers = {
  cover: () => Promise<void>
  reveal: () => Promise<void>
}

let handlers: RouteCoverHandlers | null = null

/** 组件挂载时注册、卸载时用 null 注销 */
export function registerRouteTransition(next: RouteCoverHandlers | null) {
  handlers = next
}

/** 关掉「减少动态效果」时不做任何转场：直接切 */
export async function coverRoute() {
  if (prefersReducedMotion()) return
  await handlers?.cover()
}

export async function revealRoute() {
  if (prefersReducedMotion()) return
  await handlers?.reveal()
}
