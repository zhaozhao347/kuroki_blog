<script lang="ts">
/** 模块级标记：生命周期 = 整页加载。刷新（含 Ctrl+F5）时模块重新求值 → 归 false → 重播；
 *  SPA 内部路由切换时模块不重新求值 → 保持 true → 不重播。 */
let playedThisPageLoad = false
</script>

<script setup lang="ts">
/**
 * Loader —— 首屏载入动画（2026-10 重构版）
 *
 * ★★ 用户 m06789 指定的编舞（这段就是规格，别随手改顺序）：
 *   ① 加载时播放 **Blog 打字机效果**（B 出来 → l → o → g 逐字打出，带光标）
 *   ② 加载完成后，把 **B 移动到 hero 页 Blog 大字的 B 上**（FLIP：位移 + 缩放对齐）
 *   ③ 然后把遮罩**透明度缓降**
 *   ④ 最后暴露出整个 hero
 *   ⑤ 最后展示 hero 入场动画（在 HomeView，且**Blog 里的 B 不再动**）
 *
 * ★ 为什么 ②→③ 能无缝（这是整个设计的关键）：
 *   飞行的终点是**量出来的** `.hero-initial`（hero 里那个 B）的 rect，
 *   飞行结束后遮罩里的 B 与 hero 的 B **像素级重合**；
 *   而遮罩是连同里面的 B 一起淡出的，hero 的 B 一直在原地不动，
 *   所以交叉淡入淡出看不出接缝 —— 看起来就是「B 就位 → 幕布拉开」。
 *   为此 HomeView 那边必须保证：**hero 的 B 全程不参与入场动画**
 *   （既不位移、也不淡入，否则幕布拉开时 B 会闪一下）。
 *
 * ★ 遮罩用与站点一致的 --bg / --bg-grad 品牌蓝，不是黑色：
 *   淡出时不产生色彩跳变。
 *
 * ★ 只播一次 —— 但这里的"一次"指的是**每次整页加载一次**，不是每个标签页一次。
 *   ★★ 教训（m07097）：这里原来用 sessionStorage 记忆，结果 **Ctrl+F5 也看不到动画** ——
 *      sessionStorage 是跨刷新存活的（关标签页才清），所以同一个标签页里刷新永远被跳过。
 *      改成模块级内存标记后：整页加载必播（含 F5 / Ctrl+F5），
 *      而 AppLoader 挂在 App 根上、SPA 内部路由切换不会重挂，所以切栏目时天然不重播。
 * ★ 尊重 prefers-reduced-motion（直接跳过）与后台标签页（rAF 被限流，跳过）。
 *
 * ★★ 三条兜底（2026-10-07，用户 m10960 报「loading 动画有时卡死、有时没位移就直接进页面」）：
 *   ① **看门狗**：整段编舞的硬上限，到点无条件收幕（`finish()`）。
 *      遮罩是 `z-index: 999` 的 fixed，卡住 = 整站不可点 —— 宁可少一段动画，
 *      也绝不能把页面盖死。★ 它必须是 `setTimeout`（rAF 在后台完全停摆）。
 *   ② **原地收尾**：没有 hero 的 B 可飞时（刷新在非首页 / hero 迟到 / 目标折叠）
 *      给 B + log 一段**本地**的上浮淡出，任何页面都不会「什么都不动就进页面」。
 *   ③ **标签页隐藏即收幕**：用户看不见，不必让遮罩在后台卡着。
 */
import { nextTick, onMounted, onBeforeUnmount, ref } from 'vue'
import { useRoute } from 'vue-router'
import { animate, markBooted, prefersReducedMotion } from '@/composables/motion'
import { openBootGate, whenWaterReady } from '@/composables/boot'

const props = withDefaults(
  defineProps<{ durationMs?: number }>(),
  {
    /* 「加载中」至少停留多久（打字机打完之后的保持段）。
       450ms 足够盖住懒加载 chunk 与字体切换，之后才起飞。 */
    durationMs: 450,
  },
)

/** 动画结束（供父级 / hero 衔接后续动效） */
const emit = defineEmits<{ (e: 'done'): void }>()

const show = ref(false)
const rootEl = ref<HTMLElement | null>(null)
const markEl = ref<SVGSVGElement | null>(null)
const wordEl = ref<HTMLElement | null>(null)
const caretEl = ref<HTMLElement | null>(null)
/** 「Blog」整组（原地收尾要动它，见 localOutro） */
const innerEl = ref<HTMLElement | null>(null)
/** 预热窗口里那条「还在加载」的细线（纯 CSS 动画，见 warmup 的注释） */
const warmupOn = ref(false)

/** ★ 用来判断「有没有 hero 的 B 可飞」：`.hero-initial` 只存在于首页（`name: 'home'`）。 */
const route = useRoute()

/* ── 时间线参数（要一起看，别只改一个） ── */
const TYPE_STEP = 0.13 // 每字间隔（秒）
const TYPE_DUR = 0.16 // 单字展开时长
const ENTER_DUR = 0.4 // B 自己先淡入
const FLIGHT_DUR = 0.72 // 飞到 hero 的 B 上
/* ★ m07239：飞行不再用 WAAPI 的关键帧插值（它的终点是「开飞那一刻」算的，
   会过期），改成 rAF 每帧重解落点；缓动曲线见下面的 `FLIGHT_EASE_FN`
   （与原来的 `cubic-bezier(0.66, 0, 0.34, 1)` 同一条）。 */
const FADE_DUR = 0.78 // 遮罩透明度缓降
/* 等 hero 里的 B 出现的上限。
 * ★ m07137：原来是 1600ms —— dev 下 hero 是懒加载 chunk，冷启动常常超时，
 *   一旦超时 `flyToHeroB()` 会静默 return，B 就留在屏幕正中不动了，
 *   用户看到的就是「loader 的 B 和 hero 的 B 没对齐」。宁可多等一会儿，
 *   这本来就是「加载中」的画面，等 hero 到位再落地才是对的。 */
const TARGET_WAIT_MS = 3200

/* ── 预热窗口（用户 m00846）──
 * 原话：「loading 动画也太卡了……你可以用一些延迟的手段，加入一小段时间的
 * loading 动画，在这个简单动画期间进行其他动画的加载，观感会好很多」。
 * 实测（dev 1440×900，longtask 追踪）：水彩初始化一次阻塞主线程 **633ms**，
 * 正好压在飞行 / 淡出上。所以打字机打完之后先插一段**纯 CSS 动**的等待节拍
 * （合成器驱动，主线程卡住也照样顺），并在这一刻打开闸门（`openBootGate()`），
 * 让水彩在这个窗口里初始化；它就绪就提前收。
 *   WARMUP_MIN_MS 下限 —— 太短会像"闪了一下"，必须是一拍；
 *   WARMUP_MAX_MS 上限 —— 水彩再慢也不干等（whenWaterReady 自己也有超时）。 */
const WARMUP_MIN_MS = 420
const WARMUP_MAX_MS = 1600

/* ── 兜底参数 ── */
/* 整段编舞的硬上限。正常路径（首页、hero 到位）全程 ~2.2s；
   最坏（首页冷启动，hero 迟到）≈ 字体 0.8 + 打字 0.45 + 等 3.2 + 飞 0.72 + 淡 0.78 ≈ 6s，
   所以给 7s —— 超过它一定是「本不该发生的停滞」。 */
const WATCHDOG_MS = 7000
/* ★ 已知**没有** hero 的 B 时（非首页）不再干等 TARGET_WAIT_MS：
   刷新在 /about、/articles/… 时那个元素根本不会出现，干等就是"没位移"。
   留 220ms 只为盖住"首页 hero 恰好在打字机打完前后挂载"的抖动。 */
const NO_TARGET_WAIT_MS = 220
/* 原地收尾的时长 */
const OUTRO_DUR = 0.5

let controls: { stop: () => void }[] = []
let timers: number[] = []
let cancelled = false
/** 编舞是否已经结束。★★ 幂等锁：收尾有三条路（正常 / 看门狗 / 标签页隐藏），
 *  没有它就会出现「遮罩已收、动画还在往下写」的鬼影。 */
let finished = false
/** 看门狗定时器（setTimeout，故意不进 `timers` —— 收幕时要单独清掉） */
let watchdog = 0
/** 贴合循环的停止函数（收幕时也要停掉） */
let stopGlue: (() => void) | null = null
/** visibilitychange 监听器（收幕时摘掉） */
let onVisibility: (() => void) | null = null

/** ★★ 收幕（三处调用：正常收尾 / 看门狗 / 标签页隐藏）。
 *  **幂等** —— 第一条到达的路径赢，后面的静默返回。
 *  只负责"把遮罩收掉并放行 hero"，不负责动画好不好看：
 *  看门狗那条路是**直接消失**（没有淡出），这是故意的 ——
 *  它触发时说明主线程/rAF 已经不可信，任何"补一段淡出"都可能再卡一次。 */
function finish() {
  if (finished) return
  finished = true
  /* ★ 收幕时一定有闸门已开的保证：水彩要能初始化（正常路径 warmup 早开了，
     这是看门狗 / 标签页隐藏这些旁路的兜底）。 */
  openBootGate()
  if (watchdog) {
    clearTimeout(watchdog)
    watchdog = 0
  }
  if (onVisibility) {
    document.removeEventListener('visibilitychange', onVisibility)
    onVisibility = null
  }
  stopGlue?.()
  stopGlue = null
  controls.forEach((c) => c.stop())
  controls = []
  show.value = false
  markBooted()
  emit('done')
}

/** 挂看门狗。★ 必须在第一个 rAF **之前**调用（见 onMounted 注释）。 */
function armWatchdog() {
  if (watchdog || finished) return
  watchdog = window.setTimeout(() => {
    watchdog = 0
    /* 走到这里说明编舞停滞了：rAF 停摆（后台标签页 / 系统休眠）、
       hero 永远不到位、或某个动画的 promise 不结算。 */
    finish()
  }, WATCHDOG_MS)
}

function push(c: { stop: () => void } | null | undefined) {
  if (c) controls.push(c)
}

/** 轮询等待元素出现（hero 由路由懒加载，AppLoader 挂载时它可能还没渲染） */
function waitForEl(selector: string, timeoutMs: number): Promise<Element | null> {
  return new Promise((resolve) => {
    const started = performance.now()
    const tick = () => {
      if (cancelled || finished) return resolve(null)
      const el = document.querySelector(selector)
      if (el) return resolve(el)
      if (performance.now() - started > timeoutMs) return resolve(null)
      timers.push(window.setTimeout(tick, 50))
    }
    tick()
  })
}

/** 字体就绪（打字机的字宽要量，字体没到位量出来是错的） */
function fontsReady(timeoutMs = 800): Promise<void> {
  const fonts = (document as Document & { fonts?: FontFaceSet }).fonts
  if (!fonts) return Promise.resolve()
  return Promise.race([
    fonts.ready.then(() => undefined),
    new Promise<void>((r) => {
      timers.push(window.setTimeout(r, timeoutMs))
    }),
  ])
}

/** 打字机：l → o → g 依次出现，光标一路跟在后面
 *  ★ m06789 修复：改用 CSS transition 而不是 animate(...width) 关键帧 ——
 *    关键帧动画结束后 width 会不会保留取决于 fill，实测出现过「打完又缩回 0」
 *    的抖动；transition 的终点就是内联样式本身，稳定且不可能被回收。
 *  ★★ 2026（用户 m00846「loading 动画也太卡了」）：把 width 过渡换成 **clip-path**。
 *    旧写法每帧都在改三个字的 width ⇒ **每帧触发布局**，而 `.loader` 是一整屏
 *    固定遮罩 ⇒ 整屏重绘；再加上外层 `justify-content: center`，"log" 变宽时
 *    连 B 都在往左滑。现在布局从第一帧起就是最终形态，只做绘制裁剪；
 *    光标改用 `translate`（合成器属性）跳格。实测主线程 600ms 级阻塞期间
 *    打字机本身不再拖影。
 *  ★ typedOnce 幂等锁：这段只允许跑一次。 */
let typedOnce = false
async function typeWord() {
  const word = wordEl.value
  const caret = caretEl.value
  if (!word || typedOnce) return
  typedOnce = true

  await fontsReady()

  const chars = Array.from(word.querySelectorAll<HTMLElement>('.loader-char'))
  /* ★ 先一次性量完所有字宽（一次布局读），再改样式 —— 避免「量一个、改一个」的抖动 */
  const widths = chars.map((el) => el.getBoundingClientRect().width)
  const total = widths.reduce((a, b) => a + b, 0)

  chars.forEach((el) => {
    el.style.clipPath = 'inset(0 100% 0 0)'
    el.style.opacity = '1'
  })
  if (caret) {
    caret.style.opacity = '1'
    caret.style.translate = `${-total}px 0`
  }

  /* 强制一次回流，让上面的起点成为 transition 的真正起点（否则同帧写入会被合并） */
  void word.offsetWidth

  chars.forEach((el, i) => {
    /* steps(1, end)：整字一次性显出来（真打字机的观感），不是从左往右擦 */
    el.style.transition = `clip-path ${TYPE_DUR}s steps(1, end) ${i * TYPE_STEP}s`
    el.style.clipPath = 'inset(0 0 0 0)'
    if (caret) {
      /* 光标跳到这个字的右边缘（负位移 = 从词尾往回退，见上面的 -total） */
      const typed = widths.slice(0, i + 1).reduce((a, b) => a + b, 0)
      caret.style.transition = `translate ${TYPE_DUR}s steps(1, end) ${i * TYPE_STEP}s`
      caret.style.translate = `${typed - total}px 0`
    }
  })

  /* ★★ 必须等最后一个字真的打出来再返回：上面只是「发射 CSS transition」，
     `await typing` 立刻 resolve 的话，后面的预热节拍/飞行会在打字还没打完时就开始
     （实测 warm 阶段在 t=67ms 就来了，而打字机要到 420ms 才结束）。 */
  await new Promise<void>((r) => {
    timers.push(window.setTimeout(r, (TYPE_DUR + 2 * TYPE_STEP) * 1000))
  })
}

function nextFrame() {
  return new Promise<void>((r) => {
    timers.push(window.setTimeout(() => requestAnimationFrame(() => r()), 0))
  })
}

/** 解出「把 mark 摆到 target 上」所需的变换。
 *
 *  ★★★ 完全无状态：布局基准由「实测 rect + **实测 computed transform**」当场反推。
 *    既不缓存 rect，也不依赖「上一帧我写了什么」。
 *
 *  为什么必须这样：先前的写法把基准存在变量里（`orig`，或后来的 `st`），
 *  一旦实测值和账本对不上 —— 动画正在跑、样式还没提交、布局重排 ——
 *  就会解出一个荒谬的落点（实测到过 `dx=144`：B 突然往回跳再飘回来）。
 *  `getComputedStyle(mark).transform` 拿到的是**当前真正生效**的变换，
 *  与同一帧的 `getBoundingClientRect()` 天然一致，所以不可能对不上。
 *
 *  基准取法（CSS 是 `transform-origin: 0 0`）：
 *    · scale 以左上角为原点 → 不移动左上角，所以
 *        layoutLeft = 实测 left − 实测 translate
 *    · 实测 width ÷ 实测 scale = **布局宽度** */
function solveAlign(mark: Element, target: Element) {
  const live = target.getBoundingClientRect()
  if (live.width <= 1 || live.height <= 1) return null // 目标还没布局好 / 被折叠
  const cur = mark.getBoundingClientRect()
  if (!cur.width || !cur.height) return null

  let s = 1
  let tx = 0
  let ty = 0
  const cs = getComputedStyle(mark).transform
  if (cs && cs !== 'none') {
    try {
      const m = new DOMMatrixReadOnly(cs)
      s = m.a || 1
      tx = m.e
      ty = m.f
    } catch {
      return null
    }
  }
  if (!s) return null

  const layoutW = cur.width / s
  const layoutLeft = cur.left - tx
  const layoutTop = cur.top - ty
  const ns = live.width / layoutW
  const ntx = live.left - layoutLeft
  const nty = live.top - layoutTop
  if (!Number.isFinite(ns) || !Number.isFinite(ntx) || !Number.isFinite(nty)) return null
  return { s: ns, tx: ntx, ty: nty, str: `translate(${ntx}px, ${nty}px) scale(${ns})` }
}

/** 三次贝塞尔求值（与 CSS `cubic-bezier()` 同语义：牛顿迭代把 x 解成 t） */
function cubicBezier(x1: number, y1: number, x2: number, y2: number) {
  const cx = 3 * x1
  const bx = 3 * (x2 - x1) - cx
  const ax = 1 - cx - bx
  const cy = 3 * y1
  const by = 3 * (y2 - y1) - cy
  const ay = 1 - cy - by
  const fx = (t: number) => ((ax * t + bx) * t + cx) * t
  const dfx = (t: number) => (3 * ax * t + 2 * bx) * t + cx
  const fy = (t: number) => ((ay * t + by) * t + cy) * t
  return (x: number) => {
    if (x <= 0) return 0
    if (x >= 1) return 1
    let t = x
    for (let i = 0; i < 6; i++) {
      const e = fx(t) - x
      if (Math.abs(e) < 1e-5) break
      const d = dfx(t)
      if (Math.abs(d) < 1e-6) break
      t -= e / d
    }
    return fy(Math.min(1, Math.max(0, t)))
  }
}
const FLIGHT_EASE_FN = cubicBezier(0.66, 0, 0.34, 1)

/** ★ 原地收尾（兜底，2026-10-07）：没有 hero 的 B 可飞时，别让遮罩**静止着**淡掉 ——
 *  给 B + log 一段本地位移（上浮 + 微缩 + 淡出），观感上仍然是"收起来"，
 *  而不是用户 m10960 报的「没位移就直接进入了某个页面」。
 *  ★ 返回 noop（没有需要后续停止的东西），与 flyToHeroB 的返回类型一致。 */
function localOutro(): () => void {
  const inner = innerEl.value
  if (inner && !prefersReducedMotion()) {
    push(
      animate(
        inner,
        {
          opacity: [1, 0],
          transform: ['translateY(0px) scale(1)', 'translateY(-16px) scale(0.94)'],
        },
        { duration: OUTRO_DUR, ease: [0.22, 1, 0.36, 1] },
      ),
    )
  }
  return () => undefined
}

/** B 从遮罩中央飞到 hero 的 B 上（FLIP：translate + scale，矢量不糊）。
 *  ★ m07137「我要的是重合，不是差不多」：落点**不缓存、不一次定死**。
 *  ★ m07239「改宽度后差距更大」：连飞行的插值也不能提前定死 ——
 *    每帧重新解一次当时的落点，飞行途中布局怎么动都不会偏。 */
async function flyToHeroB(): Promise<() => void> {
  const noop = () => undefined
  const mark = markEl.value
  /* ★★ 只等该等的时间：`.hero-initial` 是**首页专属**元素（hero 里的巨型 B）。
     刷新在 /about、/articles/… 时它永远不会出现 —— 老代码在这里干等满 3.2s，
     然后 `return noop` ⇒ 遮罩"静止着"淡掉，正是「没位移就进页面」的成因。 */
  const waitMs = route.name === 'home' ? TARGET_WAIT_MS : NO_TARGET_WAIT_MS
  const target = await waitForEl('.hero-initial', waitMs)
  if (!mark || !target || cancelled || finished) return localOutro()

  /* ★ 量之前先清掉入场动画可能留下的内联 transform，
     否则 getBoundingClientRect 会把那笔变换算进去，落点会偏。 */
  mark.style.transform = ''
  /* 等目标量得出尺寸（`.hero-initial` 可能已挂载但那一帧还没布局完） */
  let dest = solveAlign(mark, target)
  for (let i = 0; !dest && i < 20; i++) {
    await nextFrame()
    if (cancelled || finished) return noop
    dest = solveAlign(mark, target)
  }
  /* ★ 目标在 DOM 里但量不出尺寸（被折叠 / 隐藏）→ 走原地收尾，别静止淡出 */
  if (!dest) return localOutro()
  /* ★★★ m07239：不用 WAAPI 的关键帧插值 —— 关键帧终点是「开飞那一刻」算的，
     途中布局再动（打字机撑宽整行、字体后到、改窗口宽度重排）落点就失真，
     实测偏过 92px 且偏差随宽度变化。改成 rAF 每帧重解：B 永远朝**当时**的
     目标飞，收尾天然重合，事后不需要校正。 */
  mark.style.willChange = 'transform'
  const t0 = performance.now()
  await new Promise<void>((resolve) => {
    const step = () => {
      if (cancelled || finished || !mark.isConnected || !target.isConnected) return resolve()
      const p = Math.min(1, (performance.now() - t0) / (FLIGHT_DUR * 1000))
      const k = FLIGHT_EASE_FN(p)
      /* 起点恒为 identity(0,0,1)，终点取「此刻」解出来的变换 */
      const want = solveAlign(mark, target)
      if (want) {
        const s = 1 + (want.s - 1) * k
        mark.style.transform = `translate(${want.tx * k}px, ${want.ty * k}px) scale(${s})`
      }
      if (p >= 1) return resolve()
      requestAnimationFrame(step)
    }
    requestAnimationFrame(step)
  })
  if (cancelled || finished) return noop

  /* 飞行终点写回内联样式（不依赖动画的 fill） */
  mark.style.transform = dest.str

  /* ★★ 硬校正：等布局稳一帧，用**最新实测值**重解一次落点。
     凡是「量完之后 hero 又动了」的情形（改窗口宽度触发重排、字体后到、
     懒加载晚一拍、容器查询/断点重算）都会在这里被吃掉。 */
  await nextFrame()
  if (cancelled || finished) return noop
  const landed = solveAlign(mark, target)
  if (landed) mark.style.transform = landed.str

  /* ★★★ 贴合循环：遮罩缓降的这 0.78s 里，只要 hero 的 B 还在动
     （字体二次交换、resize、滚动条…），就随时把它拽回重合位置。
     只在启动动画期间活着，且只在**真的差**的时候才写样式。 */
  let glue = requestAnimationFrame(function tick() {
    if (cancelled || finished || !mark.isConnected || !target.isConnected) return
    const want = solveAlign(mark, target)
    if (want && want.str !== mark.style.transform) mark.style.transform = want.str
    glue = requestAnimationFrame(tick)
  })
  return () => cancelAnimationFrame(glue)
}

/**
 * 预热窗口：打字打完之后的一段「还在加载」的节拍。
 *
 * ★ 这一段存在的意义不是好看，而是**给重活腾一个不刺眼的窗口**：
 *   打开闸门 → 水彩开始编译着色器（实测 633ms 主线程阻塞）；
 *   与此同时屏幕上那条细线是 `@keyframes` 驱动的（走合成器），
 *   主线程被占住也不会卡 —— 这正是用户要的「丝滑」。
 * ★ 下限 420ms：太短会像"闪了一下"；上限 1600ms：水彩再慢也不干等。
 */
async function warmup(): Promise<void> {
  warmupOn.value = true
  /* ★★ 先让细线**真的画出来**，再放重活进来：水彩初始化会一口吃掉 400~600ms
     主线程，如果这两步挨着做，细线要等那口气松了才有机会上屏（实测第一帧
     被推迟 210ms，屏幕上就是"卡住"而不是"在转"）。等两帧 = 已经合成过一帧。 */
  await nextTick()
  await new Promise<void>((r) => {
    requestAnimationFrame(() => requestAnimationFrame(() => r()))
  })

  const t0 = performance.now()
  openBootGate()

  const work = (async () => {
    await fontsReady(600)
    const waits: Array<Promise<unknown>> = []
    if (route.name === 'home') {
      /* hero 的 B 到位（飞行的落点）+ 水彩第一帧（后者是那 633ms 的来源） */
      waits.push(waitForEl('.hero-initial', TARGET_WAIT_MS))
      waits.push(whenWaterReady())
    }
    await Promise.all(waits)
  })()

  await Promise.race([work.catch(() => undefined), sleep(WARMUP_MAX_MS)])
  const left = WARMUP_MIN_MS - (performance.now() - t0)
  if (left > 0) await sleep(left)
  warmupOn.value = false
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((r) => {
    timers.push(window.setTimeout(r, ms))
  })
}

async function play() {
  const root = rootEl.value
  if (!root || finished) return

  /* ① 打字机（B 先自己淡入，再打出 log —— 合起来就是 "Blog"） */
  if (markEl.value) {
    push(
      animate(markEl.value, { opacity: [0, 1] }, { duration: ENTER_DUR, ease: 'easeOut' }),
    )
  }
  const typing = typeWord()

  /* ② 等「打字机打完 + 至少停留 durationMs」 */
  const done = (async () => {
    await typing
    const typed =
      TYPE_DUR + Math.max(0, 2) * TYPE_STEP /* l,o,g → 最后一字的 delay 是 2×step */
    await new Promise<void>((r) => {
      timers.push(window.setTimeout(r, Math.max(0, props.durationMs - typed * 1000)))
    })
  })()

  await done
  if (cancelled || finished) return

  /* ①½ 预热窗口：打开闸门让水彩初始化，同时屏幕上一直是顺的（见 warmup 注释） */
  await warmup()
  if (cancelled || finished) return

  /* 收掉打字机（只降透明度，保留占位：B 的布局位置不能被挪动） */
  if (caretEl.value) caretEl.value.style.opacity = '0'
  if (wordEl.value) {
    push(animate(wordEl.value, { opacity: [1, 0] }, { duration: 0.22, ease: 'easeOut' }))
  }

  /* ② 飞过去（返回值是「停止贴合」的函数：遮罩缓降期间 B 要一直咬着 hero 的 B）
     ★ 没有可飞的目标时它内部改走 `localOutro()`（原地收尾），
       所以这里要么拿到"停贴合"、要么拿到 noop，都不影响下面的收幕。 */
  stopGlue = await flyToHeroB()
  if (cancelled || finished) return

  /* ③ 遮罩透明度缓降（里面的 B 与 hero 的 B 重合，一起淡出 → 无缝） */
  const fade = animate(root, { opacity: [1, 0] }, { duration: FADE_DUR, ease: 'easeInOut' })
  push(fade)
  /* ★ 兜底：`finished` 在极端情况（动画被冻住 / 时间轴被挂起）下可能不结算，
     这里再加一道上限，到点无论如何都往下走。 */
  await Promise.race([
    fade.finished.catch(() => undefined),
    new Promise<void>((r) => {
      timers.push(window.setTimeout(r, FADE_DUR * 1000 + 400))
    }),
  ])
  if (cancelled) return

  /* ④⑤ 幕布收掉 → 放行 hero 入场动画（B 不参与，见 HomeView） */
  finish()
}

function skip() {
  finished = true
  openBootGate()
  show.value = false
  markBooted()
}

onMounted(() => {
  if (prefersReducedMotion() || document.hidden) return skip()
  /* 整页加载已经播过就不再播（正常情况下 AppLoader 只挂一次，这行是防御）。 */
  if (playedThisPageLoad) return skip()
  playedThisPageLoad = true

  show.value = true
  /* ★★ 看门狗与可见性兜底**必须挂在第一个 rAF 之前**：
     若标签页在下面这两帧之间被隐藏 / 冻结，rAF 永远不会触发、`play()` 根本不会开始 ——
     那时只有这两条兜底能把遮罩收掉（老代码在这种情况下会留下一个盖死的遮罩）。 */
  armWatchdog()
  onVisibility = () => {
    if (document.hidden) finish()
  }
  document.addEventListener('visibilitychange', onVisibility)
  // 等 DOM 渲染出遮罩再开始动画
  requestAnimationFrame(() => requestAnimationFrame(() => void play()))
})

onBeforeUnmount(() => {
  cancelled = true
  /* 组件都没了就别再让水彩等闸门 */
  openBootGate()
  if (watchdog) clearTimeout(watchdog)
  watchdog = 0
  if (onVisibility) document.removeEventListener('visibilitychange', onVisibility)
  onVisibility = null
  controls.forEach((c) => c.stop())
  controls = []
  timers.forEach((t) => clearTimeout(t))
  timers = []
})
</script>

<template>
  <Teleport to="body">
    <div
      v-if="show"
      ref="rootEl"
      class="loader"
      role="status"
      aria-live="polite"
      aria-label="页面载入中"
    >
      <div ref="innerEl" class="loader-inner">
        <!-- 与 hero 同款的巨型 B：它就是这个动画的主角，最后要飞到 hero 上 -->
        <svg
          ref="markEl"
          class="loader-mark"
          viewBox="0 0 150 417"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M0.953125 417V0.383789H85.4966C126.17 0.383789 147.669 21.8828 147.669 61.104V155.525C147.669 181.382 137.501 197.652 119.198 203.753C138.373 209.273 149.413 225.833 149.413 252.562V356.28C149.413 395.21 127.623 417 85.4966 417H0.953125ZM72.7134 371.097C84.0439 371.097 91.0166 364.415 91.0166 351.631V243.555C91.0166 231.062 84.3345 224.671 72.7134 224.671H59.6396V371.097H72.7134ZM72.4229 182.835C83.4629 182.835 90.145 176.734 90.145 164.822V65.4619C90.145 52.9692 83.4629 46.2871 72.7134 46.2871H59.6396V182.835H72.4229Z"
            fill="currentColor"
          />
        </svg>

        <!-- "log"：打字机一个字一个字打出来（B 已经是上面的 SVG 了） -->
        <span ref="wordEl" class="loader-word" aria-hidden="true">
          <span class="loader-char">l</span><span class="loader-char">o</span><span
            class="loader-char"
            >g</span
          ><span ref="caretEl" class="loader-caret"></span>
        </span>

        <!-- 预热窗口的「还在加载」细线：纯 CSS 动画（合成器驱动），主线程卡住也不会抖 -->
        <span v-if="warmupOn" class="loader-track" aria-hidden="true">
          <span class="loader-track-head"></span>
        </span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.loader {
  position: fixed;
  inset: 0;
  z-index: 999;
  /* ★ 用与页面同一套渐变（--bg-grad），不要写实心 --bg。
     否则遮罩是最深的蓝、而页面顶部是浅蓝，揭开的一瞬间会"跳色"。 */
  background-color: var(--bg);
  background-image: var(--bg-grad);
  display: flex;
  align-items: center;
  justify-content: center;
  /* 遮罩期间禁掉指针，避免用户点到下面的内容 */
  cursor: wait;
}

/* 与 hero 的 `.hero-brand-row` 同一套排版：底对齐 → log 的基线贴 B 的底边 */
.loader-inner {
  position: relative;
  display: flex;
  align-items: flex-end;
  gap: 0;
}

.loader-mark {
  height: clamp(3rem, 9vh, 5.5rem);
  width: auto;
  color: var(--text);
  /* ★ 飞行用：以左上角为原点做 scale，落点才好算（见 flyToHeroB） */
  transform-origin: 0 0;
}

/* ★ 与 hero 的 .hero-log 同源：同一字体、同一比例（0.3 × B 高）、同一行高 0.85。
   这样遮罩里的 "Blog" 与 hero 的 "Blog" 是同一套排版语言。 */
.loader-word {
  font-family: var(--font-display);
  font-size: calc(clamp(3rem, 9vh, 5.5rem) * 0.3);
  line-height: 0.85;
  color: var(--text);
  text-transform: lowercase;
  white-space: nowrap;
}

.loader-char {
  display: inline-block;
  opacity: 0;
  vertical-align: bottom;
}

/* ── 预热窗口的细线 ──
 * 1px 的水平线 + 一小段亮头从左往右扫。**只用 transform / opacity**，
 * 所以它跑在合成器上：主线程被水彩初始化占住 600ms，这条线照样是顺的。
 * ★ 宽度取 `max(10rem, 100%)` 并居中：`.loader-inner` 只有约 64px 宽
 *   （B 31 + log 27），照它铺一条线在 1440 屏上几乎看不见（实测 1px × 64px）。
 *   10rem 的横线像是 "Blog" 底下的一道水线/进度轨，比例才对。 */
.loader-track {
  position: absolute;
  left: 50%;
  bottom: -0.72em;
  width: max(10rem, 100%);
  height: 1px;
  translate: -50% 0;
  overflow: hidden;
  background-color: color-mix(in srgb, var(--text) 22%, transparent);
}

.loader-track-head {
  position: absolute;
  top: 0;
  bottom: 0;
  left: 0;
  width: 34%;
  background-image: linear-gradient(
    90deg,
    transparent,
    color-mix(in srgb, var(--text) 85%, transparent),
    transparent
  );
  animation: loader-track-sweep 1.15s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}

@keyframes loader-track-sweep {
  from {
    transform: translateX(-100%);
  }
  to {
    transform: translateX(300%);
  }
}

.loader-caret {
  display: inline-block;
  width: 2px;
  height: 0.9em;
  margin-left: 0.06em;
  background-color: currentColor;
  vertical-align: baseline;
  opacity: 0;
  animation: loader-caret-blink 0.9s steps(1, end) infinite;
}

@keyframes loader-caret-blink {
  0%,
  50% {
    visibility: visible;
  }
  50.01%,
  100% {
    visibility: hidden;
  }
}

@media (prefers-reduced-motion: reduce) {
  .loader-caret {
    animation: none;
  }
}
</style>
