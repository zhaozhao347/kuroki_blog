<template>
  <div class="water-body" aria-hidden="true">
    <!-- ★ 必须再套一层 host：webgl-fluid-enhanced 会在「它收到的容器」上写
         position/display 内联样式，直接给它 .water-body 会把我们的绝对定位顶掉 -->
    <div ref="hostEl" class="water-body-host" />
  </div>
</template>

<script setup lang="ts">
/**
 * hero 的海平面（SoundLine 那条音乐波线）**以下**那片水：鼠标搅动的水彩流体。
 *
 *   水体是**一大块位置固定的色块**（`.water-body` 的 background: var(--hero-fill)），
 *   顶边贴到波带顶边（inset: calc(50% - var(--band-half))）——
 *   波线以上由 SoundLine 的canvas 刷天空色、以下留透明，于是「水位」完全由波线决定，
 *   这里**不需要**任何同步（用户 m06218 定的架构）。
 *
 *   效果 = PavelDoGreat/WebGL-Fluid-Simulation（MIT）的 npm 封装
 *          `webgl-fluid-enhanced`：鼠标就是一支笔，颜料被水推着走、慢慢晕开。
 *
 *   三条不能动的约定：
 *   ① `transparent: true` —— 水的底色是这块色块，流体只往上叠颜料。
 *      关掉它库会在色块上压出一块黑底。
 *   ② 颜料**只从设计系统令牌推导**（见 palette()），不写死色号。库的 HEXtoHSV
 *      只认 `#rrggbb`，塞 rgb()/color-mix() 会解析成 NaN（整片水会变黑）。
 *   ③ 库没有任何销毁 API，所以路由来回切必须自己 stop() + 还掉 WebGL 上下文 +
 *      移除 canvas，否则上下文会一次次累积到浏览器上限（十几个就崩）。
 *   ④ **鼠标没碰到水体时，这里一点都不能动**（用户要求）：不撒进场颜料、不做环境
 *      自搅，并且一起手就 togglePause(true)，最后一次交互 4 秒后彻底停掉 step。
 *      唤醒挂的是库自己监听的那一套事件（见 WAKE_EVENTS），用 capture 抢在库之前。
 *   ⑤ 性能三件事（见 MAX_DPR / fluidConfig / weakDevice）：绘制缓冲 DPR 压到 1、
 *      速度场 96、压力迭代 12；低端设备再降一档。改这三个值前先读那段注释。
 *   ⑥ ★ m06383：3D 舞台与碰撞逻辑**已全部删除** —— 这里不再有 splash()/freeze()/
 *      release() 这些对外入口，也没有任何「砸水 / 定格」相关状态；只剩鼠标交互。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import type WebGLFluidEnhanced from 'webgl-fluid-enhanced'
import { prefersReducedMotion } from '@/composables/motion'
import { markWaterReady, whenBootGateOpen } from '@/composables/boot'

/** 进场先撒几团颜料（库的 multipleSplats(n) 就是「恰好 n 团」）。
 *  ★ 0 = 一团都不撒。用户要求「鼠标没碰到水体时这里一点都不能动」——
 *    进场自己撒颜料正属于「没人碰它、它自己动」，所以一并关掉。
 *    想要回来说一声，改回 3 即可。 */
const OPEN_SPLATS = 0

/** 没人碰的时候每隔这么久自己搅一下；设 0 = 从不自己动（当前值，原因同上） */
const AMBIENT_SPLAT_MS = 0
const AMBIENT_SPLATS = 2

/** 最后一次交互之后多久**彻底停掉模拟**（毫秒）。
 *  ★ 必须 ≥ 颜料散尽的时间（3~4 秒）：停早了会把还没化开的笔触冻在屏幕上。
 *  ★ 光靠 dissipation 只保证「看不见残留」，停掉 step 才保证「真的一动不动」。 */
const IDLE_PAUSE_MS = 4000

/** ★★ 水层绘制缓冲的 DPR 上限 —— 这一版最大的性能开关（默认 1）。
 *  库用 `scaleByPixelRatio(v) = Math.floor(v * devicePixelRatio)` 同时决定两件事：
 *    ① canvas 绘制缓冲的尺寸（resizeCanvas() 每帧调用）；
 *    ② 鼠标坐标 → 纹理坐标的换算（mousemove 里 offsetX/offsetY 走同一个函数）
 *  所以只要在**实例**上覆盖这一个方法，两者一起降级、笔尖不会偏（见 onMounted）。
 *  本水体 1913×540：DPR 2 时绘制缓冲 3826×1080 = **4.13M 像素/帧**，
 *  压到 1 只剩 **1.03M（−75%）** —— 而且显示那一趟是纯逐像素的后处理，
 *  是整条管线里最大的一笔固定开销。
 *  ★ 为什么肉眼几乎看不出来：染料纹理是**独立分辨率**（dyeResolution，走另一套
 *    getResolution，与画布尺寸无关）；水彩本来就被拉伸得很糊，这一趟降采样
 *    只影响 shading 的精细度（低端档本来就把 shading 关了）。 */
const MAX_DPR = 1

/** 低端设备（核显 / 软件渲染）的 GPU 名字特征，命中就再降一档 */
const WEAK_GPU = /intel|uhd graphics|hd graphics|iris|mali|adreno|powervr|swiftshader|llvmpipe|software/i

/** 用一个 1×1 的临时上下文问 GPU 名字（问完立刻还掉，不会留下上下文） */
function gpuName(): string {
  try {
    const probe = document.createElement('canvas')
    const gl = probe.getContext('webgl2') ?? probe.getContext('webgl')
    if (!gl) return ''
    const ext = gl.getExtension('WEBGL_debug_renderer_info')
    const name = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : ''
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return name
  } catch {
    return ''
  }
}

/** 要不要走低端档。★ 必须在 start() 之前定：库只在「画布尺寸变了」时重建
 *  framebuffer，运行中改 simResolution/dyeResolution 不会重建、也不会有任何效果。 */
function weakDevice(): boolean {
  if (WEAK_GPU.test(gpuName())) return true
  if ((navigator.hardwareConcurrency ?? 8) <= 4) return true
  return typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
}

/** ★ 唤醒用的鼠标事件名，必须**覆盖库自己监听的那一套**：
 *  库在 canvas 上挂的是 `mousemove` / `mousedown`（鼠标）与 `touchstart` / `touchmove`（触摸），
 *  并不监听 pointer 系列。只挂 pointermove 的话，遇到「有鼠标事件、没有 pointer 事件」
 *  的派发路径（如 WebDriver 的 input.performActions）就永远唤不醒 ——
 *  颜料确实被记下了，但 step/render 一直处在暂停态，屏幕上什么都不出现。
 *  pointer 系列一并留着，笔/触控笔也走它。keepAwake 幂等，重复触发无害。 */
const WAKE_EVENTS = ['mousemove', 'mousedown', 'touchstart', 'pointermove', 'pointerdown'] as const

const hostEl = ref<HTMLElement | null>(null)

let fluid: WebGLFluidEnhanced | null = null
let ambientTimer: ReturnType<typeof setInterval> | null = null
let onVisibility: (() => void) | null = null
let idleTimer: number | null = null
let disposed = false
/** 镜像库内部的 paused：官方 API 只有 togglePause() 这个**翻转**开关，没法直接设值，
 *  所以自己记一份，只在真正需要变的时候翻一次。 */
let paused = false

function setPaused(want: boolean): void {
  if (!fluid || paused === want) return
  paused = fluid.togglePause() // 返回翻转后的真实状态
}

/** 有人碰水体：立刻唤醒，并把「多久之后停」的计时器往后推 */
function keepAwake(): void {
  setPaused(false)
  if (idleTimer != null) window.clearTimeout(idleTimer)
  idleTimer = window.setTimeout(() => {
    idleTimer = null
    setPaused(true)
  }, IDLE_PAUSE_MS)
}

/** 把任意 CSS 颜色（含 var() / color-mix()）交给浏览器算成 `#rrggbb` */
function toHex(css: string): string {
  const probe = document.createElement('span')
  probe.style.color = css
  document.body.appendChild(probe)
  const computed = getComputedStyle(probe).color
  probe.remove()
  const m = computed.match(/rgba?\(([^)]+)\)/)
  if (!m) return '#fff8e7'
  const [r, g, b] = m[1].split(',').slice(0, 3).map((v) => Math.round(parseFloat(v)))
  return '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')
}

/**
 * 四档颜料，全部由 --text（米色）/ --brand（深蓝）/ --bg-top（亮蓝）推出来：
 * 米色 → 淡紫蓝 → 亮蓝 → 站点的浅蓝。深色档让晕开的地方有层次，不至于糊成一片白。
 */
function palette(): string[] {
  return [
    toHex('var(--text)'),
    toHex('color-mix(in srgb, var(--text) 58%, var(--brand))'),
    toHex('color-mix(in srgb, var(--bg-top) 55%, var(--text))'),
    toHex('var(--bg-top)'),
  ]
}

function fluidConfig(weak: boolean): Parameters<WebGLFluidEnhanced['setConfig']>[0] {
  return {
    /* ★ 分辨率是按**画布宽高比**放大的（库的 getResolution()，本水体 1913/540 ≈ 3.54），
       所以 128 实际建出 453×128 的速度场、512 建出 1813×512 的染料场。
       速度场每帧要跑 pressureIterations 次压力迭代，外加涡度/散度/梯度若干趟，
       是纯算力的大头：128² 那一档约 1.16M 像素/帧 → 96 档 × 12 次约 0.39M（−66%）。
       观感差别极小（涡旋的细节尺度略微变粗），要贴着屏幕对比才看得出来。 */
    simResolution: weak ? 64 : 96,
    dyeResolution: weak ? 256 : 512, // 水彩本来就是糊的，1024 的染料分辨率只是浪费 GPU
    /* ★★ 颜料消散速度 = 库默认值 1（参考视频用的就是默认值）。
       公式是 `result / (1 + dissipation × dt)`，0.3 时半衰期约 2.3 秒、颜料会积成
       一层迟迟不退的雾 ✗（用户反馈「水彩效果迟迟不消散」）；1.0 的半衰期约 0.7 秒，
       几秒内散尽、只留下一道正在化开的笔触。 */
    densityDissipation: 1.0,
    velocityDissipation: 0.2,
    pressureIterations: weak ? 8 : 12,
    curl: 24, // 涡度：决定颜料卷得漂不漂亮
    /* ★★ 画笔粗细（用户反馈「画笔太粗」）。着色器里强度是 exp(-dot(p,p)/uRadius)，
       而 uRadius = correctRadius(splatRadius / 100)，其中 correctRadius 会乘上
       画布宽高比（本水体 1913×540 ≈ 3.54）—— 所以这个「带宽子」里每一档都被放大三点五倍：
         splatRadius 0.32 → sqrt(0.0032×3.54)×540 ≈ **57px 半径（115px 粗）** ✗
         splatRadius 0.05 → sqrt(0.0005×3.54)×540 ≈ **23px 半径（45px 粗）** ✓
       注意它只在「本体（含 hover 悬停）」上生效；multipleSplats 的进场/环境笔触同参。 */
    splatRadius: 0.05,
    splatForce: 6000,
    shading: !weak, // 参考视频里那种柔和的立体感（低端档省掉这一趟逐像素后处理）
    colorful: false, // ★ 关掉自动换色，否则每 10 秒所有笔触会自己变色
    colorPalette: palette(),
    hover: true, // 不按键也能「晃晃鼠标搅搅水」
    transparent: true, // ★ 让 hero 的深蓝渐变透上来
    brightness: 0.45, // 0.7 时米色会积成刺眼的白斑（火狐截图上很明显），压到 0.45 才是「颜料」
    bloom: false, // 泛光会把米色冲成白，而且在透明底上很怪
    sunrays: false, // 那是「阳光穿过水面」，透明底上没意义
  }
}

onMounted(async () => {
  const host = hostEl.value
  if (prefersReducedMotion() || !host) {
    markWaterReady() // 没有水彩可等，别让 Loader 的预热窗口干耗到超时
    return
  }

  /* 库走动态 import：这段代码只有进首页才会下载（见 vite 的分包）。
     ★ 先启动下载，再等 Loader 的闸门 —— 下载不占主线程，真正贵的是下一句的
       构造 + start()（实测一次阻塞 **633ms**，会正好砸在飞行/淡出上）。 */
  const loading = import('webgl-fluid-enhanced')
  await whenBootGateOpen()
  if (disposed) {
    markWaterReady()
    return
  }
  const { default: Fluid } = await loading
  if (disposed) {
    markWaterReady()
    return
  }

  const inst = new Fluid(host)

  /* ★★ 打绘制缓冲 DPR 的补丁（推导见 MAX_DPR）。
     必须打在**实例的 simulation** 上，而且要在 setConfig/start **之前** ——
     scaleByPixelRatio 是库内部每帧 resizeCanvas() 与鼠标换算共用的那个函数，
     改它一处，缓冲尺寸与笔尖坐标一起降级，笔尖不会偏。 */
  const sim = (inst as unknown as { simulation?: { scaleByPixelRatio(v: number): number } }).simulation
  const bufDpr = Math.min(window.devicePixelRatio || 1, MAX_DPR)
  if (sim) sim.scaleByPixelRatio = (v) => Math.floor(v * bufDpr)

  inst.setConfig(fluidConfig(weakDevice()))
  inst.start()
  fluid = inst

  if (OPEN_SPLATS > 0) inst.multipleSplats(OPEN_SPLATS)
  /* ★ 一起手就暂停：没人碰它的时候一点都不能动（paused 时库连重绘都不做）。
     用 togglePause() 的返回值对齐自己镜像的 paused。 */
  if (!paused) paused = inst.togglePause()

  for (const ev of WAKE_EVENTS) host.addEventListener(ev, keepAwake, { capture: true, passive: true })

  /* 切到后台标签页就停掉，别在看不见的时候烧 GPU */
  onVisibility = () => {
    if (document.hidden) setPaused(true)
  }
  document.addEventListener('visibilitychange', onVisibility)

  if (AMBIENT_SPLAT_MS > 0) {
    ambientTimer = setInterval(() => {
      if (!document.hidden) fluid?.multipleSplats(AMBIENT_SPLATS)
    }, AMBIENT_SPLAT_MS)
  }

  /* 告诉预热窗口「水彩已经能画了」：start() 里的着色器编译是同步完成的，
     再等两帧就一定有东西可显示（第一帧提交、第二帧绘制）。 */
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })
  markWaterReady()
})

onBeforeUnmount(() => {
  disposed = true
  if (ambientTimer) clearInterval(ambientTimer)
  ambientTimer = null
  if (idleTimer != null) window.clearTimeout(idleTimer)
  idleTimer = null
  if (onVisibility) document.removeEventListener('visibilitychange', onVisibility)
  onVisibility = null
  const host = hostEl.value
  for (const ev of WAKE_EVENTS) host?.removeEventListener(ev, keepAwake, { capture: true })

  const canvas = hostEl.value?.querySelector('canvas') ?? null
  try {
    fluid?.stop()
  } catch {
    /* 已经拆过了 */
  }
  /* ★ 库不还上下文：自己 loseContext，否则每个页面来回切都漏一个 WebGL 上下文 */
  try {
    const gl = canvas?.getContext('webgl2') ?? canvas?.getContext('webgl')
    gl?.getExtension('WEBGL_lose_context')?.loseContext()
  } catch {
    /* 拿不到就交给 GC */
  }
  canvas?.remove()
  fluid = null
})
</script>

<style scoped>
/* 海平面以下：顶边贴在音乐波线的垂直中点上（波带顶边），铺满 hero 的下半屏 */
.water-body {
  position: absolute;
  /* ★ 顶边 = 波带顶边（不是 50%）：给水彩留出升到波峰之上的空间，
     同时保证「波线以下」露出来的就是这块色块 */
  inset: calc(50% - var(--band-half, 60px)) 0 0 0;
  z-index: 1;
  overflow: hidden;
  /* ★ 用户 m06218 的架构：水体 = 一大块位置固定的色块，波线一动就露出它。
     同步机制（--sea-lift / publishSeaLift / transform）整体删除。 */
  background: var(--hero-fill);
  pointer-events: auto;
  touch-action: pan-y;
  will-change: transform;
}

/* 库会给它拿到的容器写 position:relative / display:flex ——
   这层只负责「无论库怎么改都还是满尺寸」。 */
.water-body-host {
  position: relative;
  z-index: 1;
  width: 100%;
  height: 100%;
}

.water-body canvas {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
