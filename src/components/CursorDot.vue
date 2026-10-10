<script setup lang="ts">
/**
 * CursorDot —— 跟随光标的半透明白色圆形指示器
 *
 * 一个 fixed 的圆点，平滑地跟着鼠标走（不是硬跟随，带一点阻尼）。
 *
 * ── 为什么不用 `cursor: url(...)` ──
 *   那只能换成一张静态图，做不出「平滑跟随」；
 *   而且图片光标尺寸受限（各浏览器上限 32~128px）、不能半透明混合。
 *
 * ── 为什么用 fixed + transform 而不是 left/top ──
 *   `left/top` 改动会触发**布局**（每帧一次全页重算）；
 *   `transform: translate()` 只走**合成器**，鼠标高频移动下差别明显。
 *   这是本组件性能上的核心决定。
 *
 * ── 为什么用 rAF 循环 + 阻尼，而不是直接在 mousemove 里写位置 ──
 *   直接在事件里写会让圆点"粘"在光标上、显得生硬；
 *   阻尼跟随（`pos += (target − pos) × k`）才有"拖尾"的柔顺感。
 *   ★ 而且 mousemove 的触发频率高于屏幕刷新率，逐事件写是浪费。
 *
 * ★ 尊重 prefers-reduced-motion：那种情况下干脆不渲染 ——
 *   一个追着光标跑的圆点对前庭敏感用户是不适的。
 *
 * ★ 触屏不启用：没有"光标"这个概念，留着只会在点按时闪一下。
 *
 * ── 按下时微微收缩（2026-10-07 用户要求）──
 *   收缩量写在 `paint()` 的 transform 里，**不是** CSS transition：
 *   位置每帧都由 rAF 循环重写 transform，用 CSS 过渡会和它互相打架
 *   （过渡被打断 → 看起来是"抖"，而不是"缩"）。
 *   缩放写在 `translate(-50%,-50%)` **之后**，圆心才不会偏（见 `paint()`）。
 *   pointerdown → 收到 PRESS_SCALE；pointerup / pointercancel / 离开窗口 → 弹回 1。
 *
 * ★ pointer-events: none 是必须的：否则这个浮层会吃掉所有点击，
 *   整个站点的按钮都点不了（这是这类组件最容易犯的错）。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { prefersReducedMotion } from '@/composables/motion'

/** 圆的直径（px）。★ 由 script 写到元素的内联样式上，而不是在 CSS 里
 *  再写一遍 —— 两处各写一份迟早漂移。CSS 只用变量、不写死数值。 */
const SIZE = 28
/** 阻尼系数 0..1：越大越跟手，越小越"飘"。
 *  0.18 在 60Hz 下约 6 帧追上，肉眼是"顺滑地滑过去"而不是瞬移。 */
const EASE = 0.18
/** 按下时的收缩比例。0.82 → 28px 的圆收到 ≈23px：
 *  看得出来"按了一下"，又不至于像被按瘪。 */
const PRESS_SCALE = 0.82
/** 收缩 / 回弹的阻尼系数（比位置的 EASE 大 = 更"跟手"）：
 *  按下要立刻有反馈，松手要干脆地弹回去。 */
const SCALE_EASE = 0.32

const el = ref<HTMLElement | null>(null)
/** 是否启用（触屏 / reduced-motion 下为 false，此时不渲染节点） */
const enabled = ref(false)
/** 尺寸绑定（配合 CSS 的 var(--cursor-size)） */
const sizeStyle = { width: `${SIZE}px`, height: `${SIZE}px` }

/** 光标目标位置（视口坐标） */
let targetX = -999
let targetY = -999
/** 圆点当前位置 */
let posX = -999
let posY = -999
/**
 * 是否**曾经**出场过 —— 只用来决定「要不要瞬间对齐」。
 *
 * ★ 与 `shown` 分开，因为两者语义不同：
 *     everShown：一次性，永久为 true（首帧对齐只需做一次）
 *     shown    ：反复变化（移出窗口 → false，移回 → true）
 *
 *   ★ 之前把两者合成一个变量，结果「恢复可见」被写进了
 *     `if (!active)` 里 —— active 一旦为 true 就再也不会恢复，
 *     于是「移出窗口再回来，圆点永久消失」。
 *     分开之后每个变量只服务一件事，不会互相牵连。
 */
let everShown = false
/** 当前是否可见（尚未首次移入 / 已移出窗口时为 false） */
let shown = false
let rafId = 0
/** 当前缩放（rAF 循环阻尼逼近 scaleTarget） */
let scale = 1
/** 缩放目标：按下 = PRESS_SCALE，松开 = 1 */
let scaleTarget = 1

/** 把圆点变可见（幂等）。首次移入、以及从窗口外移回时都走这里。 */
function show() {
  shown = true
  if (el.value) el.value.style.opacity = '1'
}

function onMove(e: PointerEvent) {
  /* 只在精确指针上报位置。触摸拖动也会触发 pointermove，
     那会让圆点跟着手指跑 —— 触屏下我们整个不启用（见 onMounted）。 */
  if (e.pointerType !== 'mouse') return
  targetX = e.clientX
  targetY = e.clientY

  /* ① 首次出场：把位置直接对齐到光标。
   *   否则圆点会从初始的 (-999,-999)（屏幕左上角之外）一路飘进来。 */
  if (!everShown) {
    everShown = true
    posX = targetX
    posY = targetY
    paint()
  }

  /* ② ★★ 每次移动都恢复可见 —— 这是「移出窗口再移回，圆点消失」的修复点。
   *    不能在 `if (!shown)` 之外的条件里做，否则回归。 */
  if (!shown) show()

  /* ★★ rAF 停滞检测（见下方 lastTickAt 注释）。
   *
   *   正常情况下什么都不做 —— 交给 rAF 循环做阻尼跟随，
   *   这样才有"拖尾"的柔顺感（用户要的观感）。
   *
   *   只有当 rAF 明显停摆（超过 STALL_MS 没跑过）时，才退化成硬跟随：
   *   直接把 pos 对齐到 target 并立刻绘制。代价是那一段失去阻尼，
   *   但换来"圆点至少跟着光标走"而不是彻底卡死。 */
  if (performance.now() - lastTickAt > STALL_MS) {
    posX = targetX
    posY = targetY
    paint()
  }
}

/**
 * rAF 停顿多久算"停摆"（ms）。
 *
 * ★ 依据：正常 60Hz 下 tick 每 ~16.7ms 跑一次；掉帧到 30fps 是 ~33ms。
 *   取 **120ms**（约 8 帧）—— 足够宽松，不会把普通的偶然掉帧误判成停摆；
 *   又足够紧，用户不会看到圆点"卡住"超过 1/8 秒。
 *
 * ★ 判据用「距上次 tick 的真实时间」而不是固定计数：
 *   rAF 的节流是"隔很久才给一帧"，计数法在那种模式下反而会误判。
 */
const STALL_MS = 120
/** 上一次 rAF 循环执行的时间戳（tick 每帧更新） */
let lastTickAt = 0

/**
 * 把当前位置写到 DOM。
 * ★ 抽出来给「rAF 循环」与「pointermove 同步调用」共用 ——
 *   两处各写一份的话，改位移方式（比如去掉 translate3d）必然漏改一处。
 */
function paint() {
  const node = el.value
  if (!node) return
  /* ★ 用 translate3d 而非 translate：显式请求 GPU 图层。
     `-50%` 让圆心（而不是左上角）对准光标。
     ★★ 末尾的 scale 不能挪到 `translate(-50%,-50%)` **前面**：
        变换列表**从右往左**作用，写在末尾 = 最先执行 = 绕圆心缩放，圆心不动；
        写在前面则圆心会偏 `14 × (1 − s)` px（28px 的圆 × 0.82 实测偏 2.5px）。 */
  node.style.transform = `translate3d(${posX}px, ${posY}px, 0) translate(-50%, -50%) scale(${scale})`
}

/**
 * 按下 / 松开：设定缩放目标。
 *
 * ★ 松手的位置可能在窗口外（按住拖出去再松），所以除 `pointerup` 外
 *   还听 `pointercancel`，并在 `onLeave` 里复位 —— 否则圆点会**卡在缩小态**。
 * ★ 与 `onMove` 用同一套 rAF 停摆兜底：停摆时直接落位，不指望下一帧。
 */
function press(down: boolean) {
  scaleTarget = down ? PRESS_SCALE : 1
  if (performance.now() - lastTickAt > STALL_MS) {
    scale = scaleTarget
    paint()
  }
}

function onDown(e: PointerEvent) {
  /* 触屏整个组件都不启用，这里再挡一次（触摸会带 pointerType: 'touch'） */
  if (e.pointerType !== 'mouse') return
  press(true)
}

function onUp() {
  press(false)
}

/**
 * 鼠标离开窗口 → 淡出。
 *
 * ★★ 必须把 `hidden` 置位，否则回不来 —— 见 `hidden` 的注释
 *   （这是「移出再移回，圆点永久消失」那个 bug 的另一半）。
 *
 * ★ 不移除节点、也不改 display：只是透明度变 0。
 *   这样鼠标回来时能立刻（下一帧）复现，不需要重建 DOM。
 *
 * ★ 除 `pointerleave` 外还监听 `window.blur`：
 *   切到别的应用（Alt+Tab）时指针还在窗口内、不会触发 pointerleave，
 *   但此时圆点停在原地不动、看起来像"卡住了"，一并淡出更干净。
 */
function onLeave() {
  shown = false
  /* ★ 顺手复位缩放：在窗口外松手收不到 pointerup，
     不复位的话下次移回来会是个一直缩着的圆点。 */
  scale = 1
  scaleTarget = 1
  if (el.value) el.value.style.opacity = '0'
}

function tick() {
  lastTickAt = performance.now()
  posX += (targetX - posX) * EASE
  posY += (targetY - posY) * EASE
  /* 缩放也在这里推进：与位置同帧、共用同一次 paint（不会各写一次 transform） */
  if (scale !== scaleTarget) {
    scale += (scaleTarget - scale) * SCALE_EASE
    if (Math.abs(scaleTarget - scale) < 0.001) scale = scaleTarget
  }
  paint()
  rafId = requestAnimationFrame(tick)
}

onMounted(() => {
  /* 无障碍：不做跟随（见组件注释） */
  if (prefersReducedMotion()) return
  /* 触屏 / 无精确指针：不启用 */
  if (!window.matchMedia('(hover: hover) and (pointer: fine)').matches) return

  enabled.value = true

  /* ★★ 监听器必须**同步**注册，不能包在 requestAnimationFrame 里。
   *
   *   踩过的坑：原来写成
   *       enabled.value = true
   *       requestAnimationFrame(() => { window.addEventListener('pointermove', ...) })
   *   目的是"等 DOM 渲染出节点再挂监听"。但 rAF 在某些环境（标签页不可见、
   *   集成浏览器、省电模式）会被限流到 ~1fps 甚至完全暂停 ——
   *   于是**监听器永远没挂上**，光标圆点完全不动。
   *   实测症状：节点存在、样式正确，但 opacity 恒为 0、transform 恒为 none。
   *
   *   ✅ 监听器与 rAF 无关（它只依赖 window），直接在 mounted 里挂。
   *      DOM 节点由 Vue 的响应式在 enabled 变化后渲染 —— 而 onMove 只在
   *      用户移动鼠标时才跑，那时节点早就渲染好了。
   *      （onMove 里也做了 `if (el.value)` 判空，双保险。） */
  window.addEventListener('pointermove', onMove, { passive: true })
  window.addEventListener('pointerdown', onDown, { passive: true })
  window.addEventListener('pointerup', onUp, { passive: true })
  window.addEventListener('pointercancel', onUp, { passive: true })
  document.addEventListener('pointerleave', onLeave)
  window.addEventListener('blur', onLeave)
  rafId = requestAnimationFrame(tick)
})

onBeforeUnmount(() => {
  cancelAnimationFrame(rafId)
  window.removeEventListener('pointermove', onMove)
  window.removeEventListener('pointerdown', onDown)
  window.removeEventListener('pointerup', onUp)
  window.removeEventListener('pointercancel', onUp)
  document.removeEventListener('pointerleave', onLeave)
  window.removeEventListener('blur', onLeave)
})
</script>

<template>
  <!-- 只在启用的环境下渲染这个节点（触屏 / reduced-motion 下完全没有它） -->
  <div v-if="enabled" ref="el" class="cursor-dot" :style="sizeStyle" aria-hidden="true"></div>
</template>

<style scoped>
.cursor-dot {
  position: fixed;
  /* ★ 起点在左上角，实际位置全靠 transform 写（见 script） */
  top: 0;
  left: 0;
  /* ★ 尺寸由 script 的 SIZE 以内联样式给出（唯一真相源），
     这里不写 width/height —— 两处各写一份迟早漂移。 */
  border-radius: 50%;

  /* ★★ 半透明白 —— 用户要求的配色。
     纯白 100% 会盖住底下的文字；38% 在深蓝底上是"柔和的雾点"，
     既不挡内容又能看清。 */
  background-color: color-mix(in srgb, #fff 38%, transparent);

  /* ★★ 必须：否则这个浮层会吃掉所有鼠标事件，
     整个站点的按钮、链接全都点不了。 */
  pointer-events: none;

  /* ★ 层级：低于 AppLoader(999)、高于一切内容（最高的是 MusicBar 的 70）。
     放 500 是为了「盖住内容但不盖住首屏遮罩」。 */
  z-index: 500;

  /* ★ 初始透明，等第一次 pointermove 才淡入（避免在 (0,0) 闪一下）。
     用 JS 写 opacity，这里只给过渡曲线。 */
  opacity: 0;
  transition: opacity 0.3s var(--ease);

  /* 不加 mix-blend-mode —— 那会让颜色随背景变化，
     与「半透明白」的确定语义不符（而且实测在深蓝底上会发灰）。 */
  will-change: transform;
}
</style>
