/**
 * 首屏启动期的两个「闸门 / 信号」。
 *
 * 背景（实测，dev 1440×900，`PerformanceObserver('longtask')`）：
 * 首屏加载期间有两次 600ms 级的主线程阻塞 —— 一次是入口模块求值，
 * 一次是 **水彩初始化**（`new Fluid(host)` + `start()` 要编译十几个着色器，实测 633ms）。
 * 后者正好压在 Loader 的动画上，看起来就是「loading 动画卡住了」。
 *
 * 解法（用户 m00846 的要求「加一小段 loading，在这期间把别的动画加载好」）：
 *   1. Loader 在打完字之后插入一段**纯 CSS 驱动**的等待节拍（合成器负责，
 *      主线程再忙也照样顺），并在这一刻调用 `openBootGate()`；
 *   2. 重活（水彩）只在闸门打开后才开始，于是那 600ms 一定落在「等待」里，
 *      而不是砸在打字机/飞行/淡出上；
 *   3. 水彩初始化完成后 `markWaterReady()`，Loader 据此提前结束等待。
 *
 * ★ 两条兜底，缺一不可：
 *   - `whenBootGateOpen(timeoutMs)` 自带超时：Loader 可能整段被跳过
 *     （reduced-motion / 后台标签页 / 本次加载已播过），闸门不打开就等于水彩永远不出现；
 *   - `whenWaterReady(timeoutMs)` 自带超时：水彩可能因为 WebGL 不可用而永远不就绪。
 */

let gateOpen = false
let gateWaiters: Array<() => void> = []

/** 打开预热窗口（幂等；Loader 的 warmup 阶段与所有收尾路径都会调） */
export function openBootGate(): void {
  if (gateOpen) return
  gateOpen = true
  const waiters = gateWaiters
  gateWaiters = []
  for (const fn of waiters) fn()
}

/**
 * 等到预热窗口打开。
 *
 * @param timeoutMs 兜底超时 —— 到点无条件放行，绝不让水彩缺席
 */
export function whenBootGateOpen(timeoutMs = 2600): Promise<void> {
  if (gateOpen) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const fire = () => {
      if (done) return
      done = true
      resolve()
    }
    gateWaiters.push(fire)
    setTimeout(fire, timeoutMs)
  })
}

let waterReady = false
let waterWaiters: Array<() => void> = []

/** 水彩画完第一帧（由 WaterBody 在 `start()` 之后调用） */
export function markWaterReady(): void {
  if (waterReady) return
  waterReady = true
  const waiters = waterWaiters
  waterWaiters = []
  for (const fn of waiters) fn()
}

/** 等水彩就绪（带超时；没有水彩的页面不必等） */
export function whenWaterReady(timeoutMs = 1300): Promise<void> {
  if (waterReady) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const fire = () => {
      if (done) return
      done = true
      resolve()
    }
    waterWaiters.push(fire)
    setTimeout(fire, timeoutMs)
  })
}
