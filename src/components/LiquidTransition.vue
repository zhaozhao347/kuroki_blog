<script setup lang="ts">
/**
 * 液體遮罩路由转场（液态玻璃 → 纯色遮罩）
 *
 * 用户的 prompt（m06921）：
 *   「从 bar 伸出一个液态玻璃遮罩一直延伸（缓动，非线性移动）到视口最底部，
 *     切换完成同上方法缩回去」
 * 用户后来的修正（m07065）：
 *   「毛玻璃有点没必要了…我想让这个玻璃变成一个纯粹的遮罩，就是纯色蓝色」
 *   → 去掉 `backdrop-filter`，主体改成不透明纯色（`var(--bg)`）。
 *     "液态"的质感不再靠玻璃透光，而是靠**弯月面圆角 + 下沿高光 + 外投影**。
 *
 * 实现要点 / 为什么这么做：
 *
 * 1) **位置**：fixed，top 顶在导航下沿（`--nav-h`），z-index 55 —— 比 `.nav`(60) 低，
 *    所以遮罩是从 bar 底下"渗"出来的，导航自己始终可见、不被盖。
 *
 * 2) **动 height，不动 scaleY**（关键）。
 *    scaleY 会把圆角波线一起纵向压扁 —— 弯月面越薄越像细椭圆；
 *    而且 scaleY 是纯视觉压缩，height 才是真的几何变化。
 *    height 只重排这一个 fixed 元素（内部全是 absolute），代价可控。
 *
 * 3) **圆角 = 液体的弯月面**：`border-bottom-*-radius: 50% Npx` 让下沿鼓成一个
 *    向下的穹面。N 由 CSS keyframes 驱动（起手小 → 中途鼓到 ~190px → 收尾摊平到 0），
 *    所以"落地那一下"是自然摊平，不是硬切。
 *
 * 4) **两层**：`.liq-slab`（主体遮罩）+ `.liq-echo`（更软更亮的湿边）。
 *    下落时 echo 用更短的 duration → 领先于主体，像液体前沿先挂下来；
 *    回收时 echo 用更长的 duration → 滞后，像液滴最后才被吸回去。
 *
 * 5) **缓动必须非线性**：`cubic-bezier` 给的是"黏滞"感 —— 先挂住、再加速、
 *    最后缓缓落定。线性或 ease 会像一块板子平移。
 *
 * 6) **终值显式写回**：每段动画结束后主动写 `height`，不依赖动画的 fill，
 *    避免下一段从错误的高度起飞（生成号 gen 保证被打断的那一段不会写脏）。
 *
 * 7) **材质是纯色，不是玻璃**（m07065）。副作用是好的：全屏 `backdrop-filter`
 *    每帧都要重新采样 + 模糊背后那一层，这是本组件唯一可能持续吃 CPU 的地方；
 *    换成不透明底之后，遮罩只是盖住 —— 切换全程本来就该一个字都看不见。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { animate, type AnimationPlaybackControls } from '@/composables/motion'
import { registerRouteTransition } from '@/composables/routeTransition'

/* ── 时间线 ─────────────────────────────────────────────────────────── */
const COVER_DUR = 0.6
const REVEAL_DUR = 0.72

/* 强非线性：0.83/0.17 是「quint 级」的进慢-中快-尾慢，最像黏滞液体 */
const COVER_EASE: [number, number, number, number] = [0.83, 0.02, 0.17, 1]
const REVEAL_EASE: [number, number, number, number] = [0.71, 0, 0.2, 1]

/* echo 的相对节奏：<1 领先（下落时），>1 滞后（回收时）。
 * ★ 别贪心：0.86 时湿边能超前主体 240px，看起来像「两块分开的玻璃」。
 *   0.95 / 1.12 只差几十像素 —— 才读得出是同一种液体的前后沿。 */
const ECHO_COVER_RATE = 0.95
const ECHO_REVEAL_RATE = 1.12

const rootEl = ref<HTMLElement | null>(null)
const slabEl = ref<HTMLElement | null>(null)
const echoEl = ref<HTMLElement | null>(null)

/* 生成号：任何一次 stopAll 都会 +1，被打断的那一段 await 之后不得写终值 */
let gen = 0
let slabCtl: AnimationPlaybackControls | null = null
let echoCtl: AnimationPlaybackControls | null = null
let locked = false

function frameHeight() {
  return rootEl.value?.clientHeight || window.innerHeight
}

function release() {
  gen += 1
  slabCtl?.stop()
  echoCtl?.stop()
  slabCtl = null
  echoCtl = null
}

function setPhase(root: HTMLElement, phase: 'covering' | 'revealing') {
  root.classList.remove('is-covering', 'is-revealing')
  // 强制重排：否则同名/相邻 keyframes 不会重新开始，圆角动画会"续上一次的"
  void root.offsetHeight
  root.classList.add(phase === 'covering' ? 'is-covering' : 'is-revealing')
  const dur = phase === 'covering' ? COVER_DUR : REVEAL_DUR
  const ease = phase === 'covering' ? COVER_EASE : REVEAL_EASE
  root.style.setProperty('--liq-dur', `${dur}s`)
  root.style.setProperty('--liq-ease', `cubic-bezier(${ease.join(', ')})`)
}

/** 拨动一个元素的高度；返回这趟飞行的完成 Promise（被打断时也 resolve） */
function fly(
  el: HTMLElement,
  from: number,
  to: number,
  duration: number,
  ease: [number, number, number, number],
  delay = 0,
) {
  const ctl = animate(el, { height: [`${from}px`, `${to}px`] }, { duration, ease, delay })
  return ctl
}

async function cover() {
  const root = rootEl.value
  const slab = slabEl.value
  const echo = echoEl.value
  if (!root || !slab || !echo) return

  release()
  const my = gen
  locked = true

  const target = frameHeight()
  // 起始高度：正常情况是 0；若上一段 reveal 被中途打断，就从当前高度接着往下长
  const start = Math.min(slab.getBoundingClientRect().height || 0, target)

  root.style.visibility = 'visible'
  document.documentElement.classList.add('liq-active')
  setPhase(root, 'covering')

  slab.style.height = `${start}px`
  echo.style.height = `${start}px`

  slabCtl = fly(slab, start, target, COVER_DUR, COVER_EASE)
  echoCtl = fly(echo, start, target, COVER_DUR * ECHO_COVER_RATE, COVER_EASE)

  await Promise.all([slabCtl.finished, echoCtl.finished]).catch(() => undefined)
  if (my !== gen) return

  // 显式写回终值
  slab.style.height = `${target}px`
  echo.style.height = `${target}px`
  locked = false
}

async function reveal() {
  const root = rootEl.value
  const slab = slabEl.value
  const echo = echoEl.value
  if (!root || !slab || !echo) return

  release()
  const my = gen
  locked = true

  const full = frameHeight()
  const start = Math.min(slab.getBoundingClientRect().height || full, full)

  setPhase(root, 'revealing')

  slabCtl = fly(slab, start, 0, REVEAL_DUR, REVEAL_EASE)
  echoCtl = fly(echo, start, 0, REVEAL_DUR * ECHO_REVEAL_RATE, REVEAL_EASE)

  await Promise.all([slabCtl.finished, echoCtl.finished]).catch(() => undefined)
  if (my !== gen) return

  slab.style.height = '0px'
  echo.style.height = '0px'
  root.classList.remove('is-covering', 'is-revealing')
  root.style.visibility = 'hidden'
  document.documentElement.classList.remove('liq-active')
  locked = false
}

onMounted(() => {
  registerRouteTransition({ cover, reveal })
})

onBeforeUnmount(() => {
  registerRouteTransition(null)
  release()
  document.documentElement.classList.remove('liq-active')
})

/* 调试出口：探针可以直接手动驱动，不用真的点导航 */
if (import.meta.env.DEV) {
  ;(window as unknown as Record<string, unknown>).__liq = {
    cover,
    reveal,
    get locked() {
      return locked
    },
  }
}
</script>

<template>
  <!-- aria-hidden：纯装饰，读屏跳过 -->
  <div ref="rootEl" class="liq" aria-hidden="true">
    <!-- 湿边：在主体后面，下落时领先、回收时滞后 -->
    <div ref="echoEl" class="liq-echo"></div>
    <!-- 主体玻璃 -->
    <div ref="slabEl" class="liq-slab">
      <!-- 贴在"移动中的下沿"上的高光带：高度变化时它一直住在底边 -->
      <span class="liq-sheen"></span>
    </div>
  </div>
</template>

<style scoped>
/* ★ z-index 55 < .nav 的 60：玻璃从 bar 下面长出来，导航永远清晰可见 */
.liq {
  position: fixed;
  left: 0;
  right: 0;
  top: var(--nav-h);
  bottom: 0;
  z-index: 55;
  overflow: hidden;
  visibility: hidden;
  pointer-events: none;
}

.liq.is-covering,
.liq.is-revealing {
  pointer-events: auto; /* 转场期间吃掉点击：防止连点导致动画互相打架 */
}

.liq-slab,
.liq-echo {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 0;
  /* ★ 故意不写 will-change：height 不是可合成属性，这个提示买不到任何东西，
     却可能让浏览器为这一整条满宽元素长期留一张图层/光栅位图。
     本组件平时 visibility: hidden，就该彻底不占资源。 */
}

/* ── 湿边（后层） ──
 * 主体变成纯色之后，它只负责"水膜"：在主体下沿外面透出极淡的一线，
 * 一亮就变成第二块板子了，所以峰值压在 0.14。 */
.liq-echo {
  z-index: 0;
  background: linear-gradient(
    180deg,
    rgba(255, 248, 231, 0) 0%,
    rgba(255, 248, 231, 0.05) 58%,
    rgba(255, 248, 231, 0.14) 88%,
    rgba(255, 248, 231, 0.03) 100%
  );
  border-bottom-left-radius: 50% 150px;
  border-bottom-right-radius: 50% 150px;
}

/* ── 主体：纯色蓝遮罩 ──
   ★ m07065：按用户要求去掉 backdrop-filter，改成**不透明纯色** ——
     它现在是"遮罩"而不是"玻璃窗"：切换全程躲在后面，一个字都别想看见。
   ★ 质感全靠三样东西留着，一个都不能省：
     ① 弯月面圆角（下沿那条弧 = "液态"）；
     ② 下沿高光带 `.liq-sheen`（骑着前进/后退的边缘走）；
     ③ 外投影（让遮罩"浮"在页面上，否则纯色块会和同样是蓝色的页面糊成一片）。 */
.liq-slab {
  z-index: 1;
  background: var(--bg);
  box-shadow:
    inset 0 1px 0 rgba(255, 248, 231, 0.3),
    inset 0 -1px 0 rgba(255, 248, 231, 0.14),
    0 18px 60px rgba(2, 18, 62, 0.45);
}

/* 下沿高光带：bottom: 0 让它始终骑在前进/后退的边缘上。
   ★ 纯色遮罩上这条高光就是"液面"本身 —— 去掉它，整块蓝就变成一块呆板子。
   用米白（--text 的色相）而不是纯白，跟整站的用色是一套。 */
.liq-sheen {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 84px;
  background: linear-gradient(
    180deg,
    rgba(255, 248, 231, 0) 0%,
    rgba(255, 248, 231, 0.2) 76%,
    rgba(255, 248, 231, 0.04) 100%
  );
  pointer-events: none;
}

/* ── 弯月面：圆角随行程呼吸 ──
   duration / ease 由 JS 写进 --liq-dur / --liq-ease，与高度动画严格同拍。
   ★ slab 与 echo 用各自一套 keyframes：湿边的穹面刻意再鼓一点，
     这样它从主体下沿透出来的那一线才是"弧"而不是"平行的直线"。 */
.liq.is-covering .liq-slab {
  animation: liq-dome-cover var(--liq-dur, 0.6s) var(--liq-ease, ease) both;
}
.liq.is-covering .liq-echo {
  animation: liq-echo-cover var(--liq-dur, 0.6s) var(--liq-ease, ease) both;
}
.liq.is-revealing .liq-slab {
  animation: liq-dome-reveal var(--liq-dur, 0.72s) var(--liq-ease, ease) both;
}
.liq.is-revealing .liq-echo {
  animation: liq-echo-reveal var(--liq-dur, 0.72s) var(--liq-ease, ease) both;
}

@keyframes liq-dome-cover {
  0% {
    border-bottom-left-radius: 50% 0px;
    border-bottom-right-radius: 50% 0px;
  }
  15% {
    border-bottom-left-radius: 50% 96px;
    border-bottom-right-radius: 50% 96px;
  }
  54% {
    border-bottom-left-radius: 50% 190px;
    border-bottom-right-radius: 50% 190px;
  }
  82% {
    border-bottom-left-radius: 50% 64px;
    border-bottom-right-radius: 50% 64px;
  }
  100% {
    border-bottom-left-radius: 50% 0px;
    border-bottom-right-radius: 50% 0px;
  }
}

@keyframes liq-echo-cover {
  0% {
    border-bottom-left-radius: 50% 0px;
    border-bottom-right-radius: 50% 0px;
  }
  30% {
    border-bottom-left-radius: 50% 150px;
    border-bottom-right-radius: 50% 150px;
  }
  70% {
    border-bottom-left-radius: 50% 240px;
    border-bottom-right-radius: 50% 240px;
  }
  100% {
    border-bottom-left-radius: 50% 150px;
    border-bottom-right-radius: 50% 150px;
  }
}

@keyframes liq-dome-reveal {
  0% {
    border-bottom-left-radius: 50% 0px;
    border-bottom-right-radius: 50% 0px;
  }
  24% {
    border-bottom-left-radius: 50% 128px;
    border-bottom-right-radius: 50% 128px;
  }
  100% {
    border-bottom-left-radius: 50% 44px;
    border-bottom-right-radius: 50% 44px;
  }
}

@keyframes liq-echo-reveal {
  0% {
    border-bottom-left-radius: 50% 0px;
    border-bottom-right-radius: 50% 0px;
  }
  30% {
    border-bottom-left-radius: 50% 170px;
    border-bottom-right-radius: 50% 170px;
  }
  100% {
    border-bottom-left-radius: 50% 80px;
    border-bottom-right-radius: 50% 80px;
  }
}

/* 减少动态效果：不做任何转场（routeTransition.ts 里也会提前 return，双保险） */
@media (prefers-reduced-motion: reduce) {
  .liq {
    display: none;
  }
}
</style>
