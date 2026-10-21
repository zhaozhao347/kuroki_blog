<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import MusicBall from '@/components/MusicBall.vue'

const year = new Date().getFullYear()

/* ==================== 导航毛玻璃 ====================
 * 桌面端导航是透明的（叠在 hero 上）。页面滚动后内容会从导航下面经过，
 * 两者文字互相干扰 —— 这时给导航加一层毛玻璃（背景模糊 + 半透明底色）。
 *
 * 判定方式：取「main 里最靠上的那个有视觉内容元素」的**文档坐标**减去 scrollY，
 * 即它当前相对视口的位置；若已进入导航高度范围，就是重叠。
 *
 * ★ 不要用 scrollY > 0 判断：各页面顶部有 --page-top 的大留白
 *   （桌面 240px），刚滚动很长一段内容都还没到导航位置，会误加模糊。
 *   实测：归档页要滚过 168px 才真正与导航重叠。
 */
const route = useRoute()

/* ★★ 首页不显示页脚（用户要求「hero 里把页脚移除」）。
 *
 *   首页 hero 是 100svh，**页脚是它唯一的额外高度** —— 留着它，页面就能往下
 *   滚 186px（实测 1920×1080）。而首页的滚轮已经被 hero 拿去驱动视差动画了
 *   （见 HomeView 的 onWheel）：滚轮只用来「放动画」，页面本身一步都不能走。
 *   把页脚拿掉 → 页面总高正好一屏 → 没有可滚动量，视差才真的发生在 hero 里。
 *
 *   ★ 其它页面照旧带页脚。判据用路由名（router 里首页的 name 就是 'home'），
 *     不要用 path 字符串比较 —— 带 base / 尾斜杠时容易漏。 */
const isHome = computed(() => route.name === 'home')

/* ★★ 导航当前页状态（用户 m11336 要求：「在 bar 的逻辑里维护一个状态，当前切换到
 *   什么页面了就在 bar 的对应 title 上加一个类似日语引号的「」」）。
 *
 *   角标取 .nav-mark 的方框两条边，**两条边等长**，与 hero 的 .hero-corner
 *   （HomeView.vue:833-862，`--corner-w: clamp(5px, calc(var(--brand-h)*0.03), 14px)`
 *   + `width/height: calc(var(--brand-h)*0.3)`）是同一套「方角标」语言。
 *
 *   ★ 与 AGENTS.md §6.8 不冲突：那里禁的是「当前页**常驻的色块/颜色**」（Home 指向 /，
 *     永久生效会看起来像 hover 卡住）。角标只在当前项上淡入一对线，不动底色与字色；
 *     它用 currentColor ⇒ hover 反色（--text 底 + --bg 字）时跟着一起反色。
 *
 *   ★ 前缀匹配：`/articles/hello`（文章详情）要点亮 Articles，`/projects/blog` 同理；
 *     只有 `/` 精确匹配 home；匹配不到（404 之类）返回空串 ⇒ 一个角标都不显示。
 *     不要用 router-link-exact-active：详情页不是 exact，且它无法表达上面的前缀语义。 */
const NAV_ITEMS = [
  { key: 'home', label: 'Home', to: '/' },
  { key: 'articles', label: 'Articles', to: '/articles' },
  { key: 'archive', label: 'Archive', to: '/archive' },
  { key: 'about', label: 'About', to: '/about' },
  { key: 'projects', label: 'Projects', to: '/projects' },
] as const

const activeNav = computed(() => {
  const p = route.path
  if (p === '/') return 'home'
  const hit = NAV_ITEMS.find(
    (n) => n.key !== 'home' && (p === `/${n.key}` || p.startsWith(`/${n.key}/`)),
  )
  return hit ? hit.key : ''
})

const navEl = ref<HTMLElement | null>(null)
const isOverlapping = ref(false)

/** main 里所有内容元素的**文档纵向区间**（用于与导航条带求相交） */
type Span = { top: number; bottom: number }
let spans: Span[] = []

/** 元素的文档纵向位置（基于布局，**不受 transform 影响**）
 *
 * ★ 不能用 getBoundingClientRect().top + scrollY：
 *   各页面用了 v-reveal 入场动画，元素初始带 translateY(1.5rem)，
 *   实测会让测出的位置偏下 24px → 毛玻璃触发偏晚。
 *   offsetTop 是布局值，忽略 transform，正好绕开这个问题。
 *
 * ★ SVG 元素必须单独走 rect：offsetTop / offsetParent 只定义在 HTMLElement 上，
 *   SVGElement 上没有 → 累加会得到 NaN，导致判定**恒为 false**。
 *   （首页最靠上的内容正是那个巨型 B（SVG），实测因此完全不触发毛玻璃。）
 */
function docTop(el: HTMLElement | SVGElement) {
  if (el instanceof SVGElement) {
    return el.getBoundingClientRect().top + window.scrollY
  }
  let y = 0
  let node: HTMLElement | null = el
  while (node) {
    y += node.offsetTop
    node = node.offsetParent as HTMLElement | null
  }
  return y
}

function measureContentTop() {
  const main = document.querySelector('main')
  if (!main) {
    spans = []
    return
  }
  const next: Span[] = []
  for (const el of main.querySelectorAll<HTMLElement | SVGElement>('*')) {
    const isSvg = el instanceof SVGElement
    const isMedia =
      isSvg || el.tagName === 'IMG' || el.tagName === 'VIDEO' || el.tagName === 'CANVAS'
    // 只统计根 <svg>，跳过内部的 <path> 等：它们不算独立内容，也拿不到布局坐标
    if (isSvg && el.tagName !== 'svg') continue
    // 只统计「叶子」元素：容器自身的顶边带着内边距，不是内容的真实位置。
    // （例：.hero 从 y=0 开始，但它 padding-top: --nav-h，内容其实在 72px 以下）
    if (!isMedia && el.children.length > 0) continue
    // 无文本也非媒体 → 空占位元素（如 .hero-title-wrap），跳过
    if (!isMedia && !(el.textContent || '').trim()) continue
    // 尺寸过滤走 rect：offsetWidth/Height 只定义在 HTMLElement 上，
    // SVGElement 上读不到（会得到 undefined，过滤失效）。
    const r = el.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) continue
    const top = docTop(el)
    if (!Number.isFinite(top)) continue
    const bottom = top + (r.height || parseFloat(getComputedStyle(el).lineHeight) || 0)
    next.push({ top, bottom })
  }
  spans = next
}

/** 毛玻璃在**所有断点**生效，不再做尺寸门控。
 *
 * ★ 旧实现用 `matchMedia('(min-width: 901px)')` 做门控，理由是
 *   「≤900px 时导航是两行、本身就需要实心底」。但那个实心底后来因为
 *   会在浅色渐变上压出一条深色横带（破坏背景无缝）而被删除，
 *   可读性全部交给毛玻璃 —— CSS 里的 `.nav.is-overlapping` 也同步改成了
 *   全断点生效（见下方样式注释）。
 *
 *   唯独这个 JS 门控漏改，于是 ≤900px 时 `detect()` 开头就短路返回，
 *   `is-overlapping` 永远不加 → **导航在窄屏完全没有毛玻璃**（用户报的 bug）。
 *   现已移除门控，与 CSS 对齐。
 *
 * ⚠️ 教训：CSS 里加了断点条件时，记得全局搜一下 JS 里有没有对应的
 *   镜像判断（matchMedia / innerWidth），两处必须同步改。 */

function detect() {
  const nav = navEl.value
  if (!nav || !spans.length) {
    isOverlapping.value = false
    return
  }
  const navH = nav.getBoundingClientRect().height
  if (navH === 0) {
    isOverlapping.value = false
    return
  }
  /* 导航条带在**文档**坐标下是 [scrollY, scrollY + navH]。
   * 只要有任一内容区间与它相交 → 重叠。
   *
   * ★ 不能只缓存「最靠上内容的顶边」再判断 scrollY 是否追过它：
   *   那样当内容**已经滚过导航（在视口上方）**时依然会判定为重叠 ——
   *   实测 320×700 的 /about 滚到底就是这种误报。
   *   用区间相交才对：滚过去之后，区间落在条带上方，自然不相交。 */
  const bandTop = window.scrollY
  const bandBottom = bandTop + navH
  isOverlapping.value = spans.some((s) => s.bottom > bandTop && s.top < bandBottom)
}

/* 滚动用 rAF 节流，避免每帧重复计算 */
let ticking = false
function onScroll() {
  if (ticking) return
  ticking = true
  requestAnimationFrame(() => {
    detect()
    ticking = false
  })
}

/** 布局可能变了 → 重新测量内容位置 */
function remeasure() {
  measureContentTop()
  detect()
}

/* ★ 内容变化时重测。
 * 页面组件是**懒加载**的：DefaultLayout 的 onMounted 会先于内层页面执行，
 * 那时 <main> 里还没有任何内容 → 测到 Infinity。
 * 旧实现只在 mount / resize / load / 字体就绪时重测，
 * 一旦首测得 Infinity 就**永久失效**（实测 320×700 的 /about 完全不触发毛玻璃）。
 * 用 MutationObserver 监听 <main> 的子树变化，内容一挂载就补测。 */
let contentObserver: MutationObserver | null = null
let observerTimer: ReturnType<typeof setTimeout> | undefined

function onContentMutated() {
  // 动画帧前先立即测一次，其余合并到下一帧，避免频繁重排
  remeasure()
  clearTimeout(observerTimer)
  observerTimer = setTimeout(remeasure, 120)
}

onMounted(async () => {
  remeasure()
  window.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', remeasure)
  // 字体 / 图片加载完会改变布局，各补测一次
  window.addEventListener('load', remeasure)
  document.fonts?.ready.then(remeasure).catch(() => {})

  // 等 DOM 稳定后再挂观察器，避免把首次渲染当成「变化」
  await nextTick()
  const main = document.querySelector('main')
  if (main) {
    contentObserver = new MutationObserver(onContentMutated)
    contentObserver.observe(main, { childList: true, subtree: true })
    // 观察器挂上后补测一次，兼顾「首次渲染早于 nextTick」的情况
    remeasure()
  }
})

onBeforeUnmount(() => {
  contentObserver?.disconnect()
  contentObserver = null
  clearTimeout(observerTimer)
  window.removeEventListener('scroll', onScroll)
  window.removeEventListener('resize', remeasure)
  window.removeEventListener('load', remeasure)
})

// 路由切换后内容变了，等 DOM 更新完重新测量
watch(
  () => route.fullPath,
  () => nextTick(remeasure),
)
</script>

<template>
  <div class="page">
    <!-- ==================== 导航 ==================== -->
    <!-- 原站：fixed 顶部，网格布局，logo 占 6 列，链接 7→-1 -->
    <nav ref="navEl" class="nav" :class="{ 'is-overlapping': isOverlapping }">
      <div class="nav-contain u-container">
        <div class="nav-logo">
          <RouterLink v-magnetic="0.18" to="/" class="nav-logo-link" aria-label="回到首页">
            <span class="u-h3">Blog</span>
            <svg class="nav-logo-icon" viewBox="0 0 13 13" aria-hidden="true">
              <rect width="13" height="13" fill="currentColor" />
            </svg>
          </RouterLink>
        </div>

        <div class="nav-links-wrap">
          <ul class="nav-list">
            <!-- 导航项由脚本里的 NAV_ITEMS 驱动；当前页那一项（activeNav）会淡入一对
                 「」角标。★ Projects 是导航里最长的标签（8 字母），窄屏靠 ≤520px 那档的
                 3px 内边距 + 10px 字号下限才放得下；标签再改长就必须同步调那两处。 -->
            <li v-for="item in NAV_ITEMS" :key="item.key" class="nav-item">
              <RouterLink
                v-magnetic="0.22"
                :to="item.to"
                class="nav-link"
                :class="{ 'is-current': activeNav === item.key }"
              >
                <span class="nav-block u-h3"
                  ><span class="nav-mark nav-mark-open" aria-hidden="true"></span
                  >{{ item.label
                  }}<span class="nav-mark nav-mark-close" aria-hidden="true"></span
                ></span>
              </RouterLink>
            </li>
          </ul>
        </div>
      </div>
    </nav>

    <main class="main">
      <!-- ★★ 页面过渡放在 <main> **内部**，不能包整个布局。

           原因（用户报「切页时导航乱跳 + 白屏」，实测确认）：
           过渡会给元素加 transform，而 **.nav 是 position: fixed**。
           CSS 规范：只要祖先链上有 transform/filter/perspective，
           fixed 元素的包含块就从「视口」变成「那个祖先」—— fixed 直接失效。
           实测 navTop 跟着过渡从 0 → -10.9 → +16 来回跑，
           看起来就是「导航自己在乱跳」。

           而且 `mode="out-in"` 包整个布局时，退场阶段连导航和页脚
           一起淡出，中间那一瞬就是**整屏白**。

           现在：导航/页脚常驻不动，只有这里的视图做淡入淡出。 -->
      <RouterView v-slot="{ Component, route: r }">
        <Transition name="view">
          <component :is="Component" :key="r.path" />
        </Transition>
      </RouterView>
    </main>

    <!-- ==================== 页脚 ==================== -->
    <!-- 矮版页脚：只有一行链接 + 版权 + 一句说明。
         ★ 首页不渲染（见 isHome）：页面不能有可滚动量。 -->
    <footer v-if="!isHome" class="footer">
      <div class="footer-contain u-container">
        <div class="footer-layout u-grid">
          <div class="footer-legal">
            <ul class="footer-link-list">
              <li>
                <RouterLink to="/about" class="footer-link u-h4">关于</RouterLink>
              </li>
              <li>
                <RouterLink to="/archive" class="footer-link u-h4">归档</RouterLink>
              </li>
              <li>
                <RouterLink to="/articles" class="footer-link u-h4">文章</RouterLink>
              </li>
              <li>
                <RouterLink to="/projects" class="footer-link u-h4">项目</RouterLink>
              </li>
            </ul>
            <div class="footer-meta u-small u-muted">
              <span>© {{ year }} 我的博客</span>
              <span>Vue + Vite 构建</span>
              <!-- 备案号：工信部要求站底可见、可点（跳到 beian.miit.gov.cn 的查询页）。
                   ★ 只有这个 <a> 是外链，所以就地写死 target/rel，不走 parseHref 那套校验。 -->
              <a
                class="footer-icp"
                href="https://beian.miit.gov.cn/"
                target="_blank"
                rel="noopener noreferrer"
              >豫ICP备2026008086号</a>
            </div>
          </div>

          <div class="footer-contact">
            <p class="u-main footer-contact-text">
              这个博客会一直写下去。如果你也在做类似的事，欢迎交流。
            </p>
          </div>
        </div>
      </div>
    </footer>

    <!-- ==================== 音乐球（仅非首页）====================
         播放器是模块级单例，切页不会停 —— 但唯一的控制器（hero 里的胶囊）
         只挂在首页。球把「离开首页后还能控制音乐」这件事补上：
         它自己按路由名判断，首页不渲染（判据与页脚一致）。
         ★ 放在布局层（不是某个页面里）：它必须跨路由常驻，且不能进 <main>
           的视图过渡 —— 那里会给元素加 transform，fixed 的球会跟着飘。 -->
    <MusicBall />
  </div>
</template>

<style scoped>
.page {
  display: flex;
  flex-flow: column;
  min-height: 100svh;
}

/* ==================== 导航 ==================== */
/* 原站：z-index 60，fixed 顶部，透明背景 */
.nav {
  z-index: 60;
  position: fixed;
  inset: 0 0 auto;

  /* ★★ 高度**由 --nav-h 直接决定**，不由子元素的内边距撑出来。
   *
   *   为什么这么改（踩了很多次）：
   *   旧写法是「高度 = .nav-logo-link 的内边距 + 字号行高」自然撑开，
   *   而 --nav-h 在 style.css 里是独立写死的值 —— 两者必须**手工同步**。
   *   于是每当断点里改字号或内边距，就忘一次 --nav-h，
   *   结果 hero 顶部凭空多出几十像素空隙（实测漂过 65vs63、54vs63）。
   *
   *   现在 --nav-h 是唯一真相：导航就这个高，里面的内容居中摆放。
   *   改字号/内边距只会影响**内容**，不再能意外改变导航高度。
   *
   *   ⚠️ 代价：子元素必须能装进这个高度。若某断点下内容比 --nav-h 高，
   *      会溢出（而不是把导航撑高）。改字号后跑一次容器自检即可发现。 */
  height: var(--nav-h);
}

/* 与页面内容重叠时的毛玻璃：背景模糊 + 半透明底色，
   后面的内容虚化但仍可感知 —— 比纯透明易读，比实心轻。

/* 与页面内容重叠时的毛玻璃：背景模糊 + 半透明底色，
   后面的内容虚化但仍可感知 —— 比纯透明易读，比实心轻。

   ★ 底色基准必须是 --bg-top，不是 --bg：
     渐变层是 position: fixed，所以**无论滚到哪里，视口顶部的颜色永远是 --bg-top**
     （最浅的那个蓝）。若用最深的 --bg，导航就会在浅色渐变上压出一条深色横带，
     正好破坏"无缝"。用 --bg-top 才能与背后的渐变连成一体。
     （实测：改前移动端实心导航是 rgb(6,49,187)，而渐变顶部是 rgb(3,80,218)，明显分层。）

   ★ 所有尺寸都启用（原先只给 >900px）：窄屏也靠毛玻璃保证可读性，
     不再需要那块"实心底" —— 那个实心底正是色差的来源。

   ⚠️ 改这里的断点条件时，务必同步检查 JS 侧的 `detect()`：
     它早先也有一个 `matchMedia('(min-width: 901px)')` 门控，
     两边不同步就会导致「类名不加 → 毛玻璃静默失效」。 */
.nav {
  transition:
    background-color 0.35s var(--ease),
    backdrop-filter 0.35s var(--ease),
    -webkit-backdrop-filter 0.35s var(--ease);
}

.nav.is-overlapping {
  background-color: color-mix(in srgb, var(--bg-top) 62%, transparent);
  backdrop-filter: blur(14px) saturate(160%);
  -webkit-backdrop-filter: blur(14px) saturate(160%);
}

/* 不支持 backdrop-filter 时退化为实心底，保证文字可读性。
   ★ 用 --bg-top 而不是 --bg：理由同上（要贴合渐变顶部，避免色差） */
@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .nav.is-overlapping {
    background-color: var(--bg-top);
  }
}

/* 原站 24 列网格，logo 跨 6 列 */
.nav-contain {
  position: relative;
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  gap: var(--gutter);
  /* 铺满 .nav 的固定高度，并让内容垂直居中（高度不再靠内边距撑） */
  height: 100%;
  align-items: center;
}

.nav-logo {
  grid-column: span 6;
  display: inline-flex;
  gap: 0.125rem;
}

.nav-logo-link {
  display: inline-flex;
  gap: 0.125rem;
  /* 横向内边距 = 鼠标靶区与左右留白（与导航高度无关） */
  padding-inline: 1.5rem;
  /* ★★ 纵向内边距**必须自适应**，不能写死 1.5rem。
   *
   *   导航高度由 --nav-h 固定，而字号在窄屏会缩小（clamp）；
   *   若内边距不变，内容就会顶出导航 —— 实测 700px 视口下
   *   link 高 71.1px > nav 69px，溢出 2.1px（logo 上下不居中）。
   *
   *   这里取「1.5rem」与「(导航高 − 内容高) / 2」的较小值：
   *     桌面  (72 − 25.6)/2 = 23.2 → 内容 24   + 46.4 = 70.4 < 72 ✓
   *     700px (69 − 25.6)/2 = 21.7 → 内容 23.1 + 43.4 = 66.5 < 69 ✓
   *     320px (56 − 25.6)/2 = 15.2 → 内容 15   + 30.4 = 45.4 < 56 ✓
   *   任何断点都装得进去，不会再随字号变化而溢出。
   *
   *   ★ 用 1.6em 而非 1.5em 估内容高：留一点余量，
   *     避免四舍五入后刚好卡在边界上。 */
  padding-block: min(1.5rem, calc((var(--nav-h) - 1.6em) / 2));
}

/* 方块图标：.72em（原站 .nav_logo_icon） */
.nav-logo-icon {
  width: 0.72em;
  height: 0.72em;
  aspect-ratio: 1;
  align-self: center;
}

/* 导航链接：相对**视口**水平居中（绝对定位，不影响左侧 logo） */
.nav-links-wrap {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  height: 100%;
  display: flex;
  align-items: center;
}

.nav-list {
  display: flex;
  gap: var(--gutter);
}

/* .nav-link / .nav-item 只做 flex 容器，
   不给 padding——否则鼠标离色块还有距离就会触发反色 */
.nav-item,
.nav-link {
  display: flex;
}

/* 反色块：hover 区域恰好等于色块本身，宽度贴合文字。
   纵向内边距让色块随导航栏一起变高（hover 靶区也更大），
   但不要超出导航栏高度，否则会溢出。 */
.nav-block {
  position: relative; /* 角标 .nav-mark 的定位基准 */
  display: flex;
  align-items: center;
  padding-block: 0.375rem;
  padding-inline: 0.75rem;
  background-color: transparent;
  color: var(--text);
  transition:
    background-color 0.3s var(--ease),
    color 0.3s var(--ease);

  /* 「」角标的尺寸参数（可以用变量覆盖，见窄屏档）：
     --nav-mark-size  方框边长（两条边等长，与 hero 的 .hero-corner 同一套语言）
     --nav-mark-w     线宽 ≈ 边长 × 0.085
     --nav-mark-inset 角标离色块边缘的距离 —— 放在 padding-inline 内，
                      横线正好指向文字、尖端离字 ~2px（12px 内边距 - 10px 角标）
     --nav-mark-shift 竖直错位：左角标**整体抬高**、右角标**整体压低**
                      （用户 2026-10-07 画的草图就是这个形态：左边高点、右边低点，
                       不是上下居中对称的方框） */
  --nav-mark-size: 0.62em;
  --nav-mark-w: max(1px, 0.085em);
  --nav-mark-inset: 1px;
  --nav-mark-shift: 0.5em;
}

/* ★★ 当前页的「」角标。
 *
 *   取方框的两条边（开口角标），**两条边等长** —— 和 hero 里的 .hero-corner
 *   （HomeView.vue:833-862）同一套语言，只是这里用的是「日语引号」的开口方向：
 *     「 = 上边 + 左边（┌）      」 = 下边 + 右边（┘）
 *
 *   ★ 绝对定位 + 落在色块的内边距里 ⇒ **完全不占布局**：导航条总宽不变，
 *     切页时其余项一个像素都不动。这一点是硬要求：≤520px 档链接条与 logo
 *     只剩 7.3px 余量（见下方注释），任何加宽都会撞上去。
 *   ★ pointer-events: none ⇒ 不扩大 hover 靶区。
 *   ★ currentColor ⇒ hover 反色（--text 底 + --bg 字）时角标跟着变蓝，仍看得见。
 *   ★ 只有当前页那一项会渲染出可见角标 ⇒ 全站同时最多一对。 */
.nav-mark {
  position: absolute;
  top: calc(50% - var(--nav-mark-size) / 2);
  width: var(--nav-mark-size);
  height: var(--nav-mark-size);
  opacity: 0;
  pointer-events: none;
  transition:
    opacity 0.3s var(--ease),
    transform 0.3s var(--ease);
}

/* 未显示时向里收 3px，出现时推出去 ⇒ 像「把标题括起来」而不是凭空闪出来。
   ★ 竖直方向不是对称的：左角标整体**抬高**、右角标整体**压低**（`--nav-mark-shift`），
   所以是「左边高点、右边低点」的斜错开，而不是两个方框上下居中。 */
.nav-mark-open {
  left: var(--nav-mark-inset);
  top: calc(50% - var(--nav-mark-size) / 2 - var(--nav-mark-shift));
  border-top: var(--nav-mark-w) solid currentColor;
  border-left: var(--nav-mark-w) solid currentColor;
  transform: translateX(3px);
}

.nav-mark-close {
  right: var(--nav-mark-inset);
  top: calc(50% - var(--nav-mark-size) / 2 + var(--nav-mark-shift));
  border-bottom: var(--nav-mark-w) solid currentColor;
  border-right: var(--nav-mark-w) solid currentColor;
  transform: translateX(-3px);
}

.nav-link.is-current .nav-mark {
  opacity: 1;
  transform: translateX(0);
}

.nav-link:hover .nav-block {
  background-color: var(--text);
  color: var(--bg);
}

/* hover 时其余项变淡（原站 :has 逻辑） */
.nav-list:hover .nav-item:not(:hover) {
  opacity: 0.4;
}

/* 窄屏紧凑化：**只缩字号与间距，不换行**。

   ★★★ 字号必须跨整个窄屏区间**持续**变小，不能早早碰到下限。

   踩过两次坑：
     ① 「≤767px 用 14px、≤345px 用 12px」——中间 420px 是死区，字号不变；
     ② `clamp(12px, 1.6vw, 16px)` —— 1.6vw 在 767px 处已是 12.3px，
        于是**一进窄屏就触底**，从其下到 320px 全部是 12px，同样看着「不会缩小」。

   现用 `clamp(10px, 2.2vw, 16px)`：
     767px → 16.9 → 封顶 16px
     700px → 15.4px
     600px → 13.2px
     500px → 11.0px
     455px → 10px（下限）
   即从 767 到 455 持续从 16 缩到 10，**全程都在变**。

   ★ 下限 10px：再小就真的看不清了。实测 320 视口下 10px 时，
     链接条左边缘 62.6px、logo 右边缘 55.3px —— **只剩 7.3px**（第五项是
     `Projects`，全站最长的导航标签；Talk 时代还有 ~33px）。再加一项或换更长的
     词就会撞上 logo（390px 下余量 77.3px、360px 下 47.3px）。 */
@media (max-width: 767px) {
  .nav-list {
    gap: 0.25rem;
  }

  /* 链接项与 logo 用**同一个** clamp 表达式，两者始终同比缩放 */
  .nav-block,
  .nav-logo-link .u-h3 {
    font-size: clamp(10px, 2.2vw, 16px);
  }

  .nav-block {
    padding-inline: 0.5rem;
    /* 窄屏字号掉到 10–13px，角标跟着缩一号（0.5em = 5–6.6px，仍在内边距里） */
    --nav-mark-size: 0.5em;
  }
}

/* 极窄屏的 ≤520px 档（padding-inline 只剩 3px）里角标放不下：
   0.5em 在 10px 字号下是 5px，会比内边距宽出 2px，正好压在首字母上。
   这一档就**不显示角标**（宁可没有，也不要糊在字上）。 */
@media (max-width: 520px) {
  .nav-mark {
    display: none;
  }
}

/* 极窄屏（≤520px）：**仍然并排**，只把横向内边距压到 3px。

   ★★ 这里曾经是「改成两行」（链接条在上、logo 在下）。
      那个行为抄自参考站的小屏形态，但用户明确要求「一直并排」。

   ★ 并排靠 flex 的 space-between（logo 贴左、链接条贴右），
     **不能**再用「链接条绝对定位居中」——它是相对视口居中的，
     窄屏必然与 logo 相撞（这正是最初的 bug 来源）。 */
@media (max-width: 520px) {
  .nav-contain {
    display: flex;
    flex-flow: row;
    align-items: center;
    justify-content: space-between;
    gap: 0.25rem;
  }

  /* 退出绝对定位、回到常规流（此时它是 flex 的第二项） */
  .nav-links-wrap {
    order: 0;
    position: static;
    transform: none;
    height: auto;
    width: auto;
    /* ★ 不加 min-width: 0 的话，flex 项的自动最小尺寸 = 内容宽度，
       窄到极限时会顶破容器、把 logo 挤出去（或触发溢出）。 */
    min-width: 0;
  }

  .nav-list {
    width: auto;
    gap: 0.125rem;
  }

  .nav-logo,
  .nav-item {
    width: auto;
  }

  /* logo 是品牌标识，不许收缩 —— 被压变形比换行更糟 */
  .nav-logo {
    flex-shrink: 0;
  }

  /* 横向内边距 3px：这是「省下来的」主要空间来源（原 8px，4 项省 40px） */
  .nav-block {
    padding-inline: 3px;
  }

  /* logo 两侧对齐同一档（纵向交给上面的自适应 padding-block；
     这里只把横向收成 3px，给窄屏腾出空间） */
  .nav-logo-link {
    padding-inline: 3px;
  }
}

/* 超窄屏（≤345px）：clamp 已把字号压到下限，
   这里不再改内边距 —— 纵向由自适应公式跟着 --nav-h 自动算。 */

/* ==================== 主体 ==================== */
.main {
  flex: 1;
  /* ★ 为下面「退场视图绝对定位」提供包含块（见 .view-leave-active） */
  position: relative;
}

/* 视图切换：交错淡入淡出（不是 out-in 的「先空再填」）。
 *
 * ★★ 为什么不用 `mode="out-in"`：
 *   那个模式是「旧内容完全消失 → 新内容才出现」。
 *   而 <main> 是 flex: 1 的伸缩项，旧内容一消失、新内容还没挂上时，
 *   main 高度归零 → **页脚会往上跳一大截**（即便导航还在，观感也是"塌了一下"）。
 *
 *   实测用户报的「先全部消失再出现」就是这个：早期过渡还包了整个布局，
 *   连导航和页脚都一起消失，那就是真正的整屏白。
 *
 * ★ 现在：
 *   - 新视图**立即**进 DOM（main 高度当场按新内容算，页脚不跳）
 *   - 旧视图脱离文档流、叠在上面淡出（不占位，所以不会把新内容顶下去）
 *     → 必须在 .main 上给 position: relative 作包含块
 *   - 两边同时淡，总时长 0.3s（比 out-in 的「0.28 + 0.28」快一倍）
 *
 * ★ 只动 opacity，不碰 transform：
 *   祖先上的 transform 会让 .nav（position: fixed）失效、导航跟着乱跳
 *   —— 这正是早期「切页时导航乱跳」的根因。opacity 不影响包含块，安全。 */
.view-enter-active,
.view-leave-active {
  transition: opacity 0.3s var(--ease);
}

.view-enter-from,
.view-leave-to {
  opacity: 0;
}

/* 退场的那个脱离文档流：不占位 → 新内容立即接上，页脚不跳 */
.view-leave-active {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
}

/* ★ 液态玻璃转场进行中（`html.liq-active` 由 components/LiquidTransition.vue 打上）：
 *   遮罩已经把内容区整个盖住，路由切换全程躲在玻璃后面发生。
 *   此时再叠这层 0.3s 淡入淡出，只会在玻璃往回缩的头 0.3s 里露出
 *   「新旧两张半透明页面互相穿透」的鬼影 —— 所以这期间把视图过渡压成瞬时，
 *   让内容干净地换掉。玻璃收完（reveal 结束）就摘掉类，之后普通跳转照旧淡入淡出。 */
:global(html.liq-active) .view-enter-active,
:global(html.liq-active) .view-leave-active {
  transition-duration: 0.01ms;
}

/* 无障碍：几乎瞬时 */
@media (prefers-reduced-motion: reduce) {
  .view-enter-active,
  .view-leave-active {
    transition-duration: 0.01ms;
  }
}

/* ==================== 页脚 ==================== */
/* 矮版：去掉了原站的巨型标题与 100svh 高度，只留一行信息 */
.footer {
  border-top: 1px solid var(--line);
  padding-block: var(--section-small);
}

.footer-contain {
  display: flex;
  flex-flow: column;
}

.footer-layout {
  z-index: 3;
  position: relative;
}

/* 法定信息：1→14 列 */
.footer-legal {
  grid-column: 1 / span 14;
  display: flex;
  flex-flow: column;
  align-items: flex-start;
}

.footer-link-list {
  display: flex;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}

/* 链接默认 40% 透明，hover 变全（原站精确值） */
.footer-link {
  color: color-mix(in srgb, var(--text) 40%, transparent);
  transition: color 0.3s ease;
}

.footer-link:hover {
  color: var(--text);
}

/* 版权行：© / 构建方式 / 备案号 挤在一行，窄屏整项折行（不要 nowrap）。
   ★ 不用 `·` 分隔符：与上面那排链接（本来就只靠间距）统一，也免得窄屏折行时
   分隔点被孤零零留在行尾。 */
.footer-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem 0.9rem;
}

/* 备案号是这一行里唯一的外链：默认跟随 --muted，hover 才提到 --text */
.footer-icp {
  color: inherit;
  transition: color 0.3s ease;
}

.footer-icp:hover {
  color: var(--text);
}

/* 联系方式：15→-1 列 */
.footer-contact {
  grid-column: 15 / -1;
}

.footer-contact-text {
  /* ★ 33ch → 20em（2026-10-21）：ch = 数字 "0" 的宽度，中文字符约两倍宽，
     用它量中文段落的换行点完全不可预期（ProjectListView 的 .page-lead
     已经踩过一次，注释里写着「中文句子用 em」）。
     20em ≈ 20 个汉字一行，两行把这句话排完，行尾也稳定。 */
  max-width: 20em;
}

@media (max-width: 991px) {
  .footer {
    min-height: auto;
  }

  .footer-legal {
    grid-column: 1 / span 12;
  }

  .footer-contact {
    grid-column: 13 / -1;
  }
}

@media (max-width: 767px) {
  .footer-contain {
    gap: var(--section-large);
  }

  .footer-layout {
    display: flex;
    flex-flow: column;
    gap: 1.5rem;
  }

  .footer-contact {
    order: -1;
  }
}
</style>
