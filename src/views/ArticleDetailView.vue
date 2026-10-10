<script setup lang="ts">
/**
 * 文章详情页
 *
 * ── 数据来源 ──
 *   元数据来自 `@/posts`（构建期索引），**正文按需懒加载**：
 *   只有真的点进某篇时，才下载那一个 md 的 chunk。
 *   （构建产物里每篇 md 是一个独立 js，首屏不承担全部文章的体积。）
 *
 * ── 排版要点（用户要求「整篇居中」）──
 *   - 标题、meta、正文**共用一个居中栏宽**（--reading-w），内容在栏内左对齐
 *   - 整篇外面包一层毛玻璃面板（.panel），把文章从背景上「抬」起来（见样式区注释）
 *   - ≥1280px 时面板**右侧**再多一列小标题栏（.toc / .toc-col，sticky 在导航下沿）；
 *     窄屏没地方放这一列（见样式区 .toc-col 注释）
 *   - 正文末尾「继续阅读」右侧并排一个「返回顶部」
 *   - 原来正文 `max-width: 62ch` 却贴容器左边缘，宽屏上左侧留白巨大、
 *     右侧大片空白，整体视觉是"偏的" —— 现在整块居中
 *   - 栏宽按 ch 定（跟随字号），窄屏退化为 100%
 *
 * ── 三种状态都要处理 ──
 *   loading  正文在加载（懒加载的 chunk 要等网络）
 *   ready    正常渲染
 *   missing  该 slug 不存在 —— 显示「文章不存在」而不是永远转圈
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import { getLenis, prefersReducedMotion } from '@/composables/motion'
import { findPost, getPostBody, neighbors } from '@/posts'

const props = defineProps<{ id: string }>()

/** 当前文章的元数据（构建期索引里有，立刻可用） */
const meta = computed(() => findPost(props.id))

/** 正文源码；null = 还没加载完 */
const body = ref<string | null>(null)
/** 是否加载失败（slug 不存在） */
const missing = ref(false)
/** 正在加载 */
const loading = ref(false)

/** 上一篇（更新）/ 下一篇（更旧） */
const near = computed(() => neighbors(props.id))

/**
 * 加载正文。
 *
 * ★ 必须 `watch(..., { immediate: true })` 而不是只 `onMounted`：
 *   从「下一篇」跳到另一篇时，**路由参数变了但组件被复用**（同一路由记录），
 *   onMounted 不会再跑，正文就会停在上篇。这是这类页面最经典的一个坑。
 *
 * ★ 用 `watch` 的取消语义防竞态：快速连点两篇时，
 *   先返回的旧请求不能覆盖新文章的内容。
 */
watch(
  () => props.id,
  async (slug) => {
    body.value = null
    missing.value = false
    loading.value = true
    try {
      const text = await getPostBody(slug)
      /* ★ 竞态保护：请求期间 slug 又变了，就丢弃这次结果 */
      if (slug !== props.id) return
      if (text === null) missing.value = true
      else body.value = text
    } finally {
      if (slug === props.id) loading.value = false
    }
  },
  { immediate: true },
)

/* ==================== 小标题栏（目录） ==================== */

/**
 * 目录项。
 * ★ 目录是**从渲染后的 DOM 反查**的，不是再解析一遍 markdown：
 *   - id 和列表同源，永远不会错位；
 *   - 渲染器以后换实现（只要还产出 h2/h3/h4）这里不用跟着改。
 *   反面做法：两处各自解析 + 各自拼 slug —— 两份逻辑迟早会漂移。
 */
interface TocItem {
  id: string
  text: string
  level: number
}

/** 正文容器：目录从它里面查标题 */
const bodyEl = ref<HTMLElement | null>(null)
const toc = ref<TocItem[]>([])
/** 当前读到的小节，只用于给目录加一点亮度（.toc-link.is-active） */
const activeId = ref('')

/** 目录顶部与导航下沿的间距。
 *  ★ 样式区 `.toc` 的 top 用的是同一个 24px，两处必须一致 ——
 *    否则点完标题会停在偏高/偏低的位置。 */
const TOC_GAP = 24

/** 顶部固定导航的高度（px）。--nav-h 是 rem / px 令牌，这里换算成像素 */
function navHeight(): number {
  const cs = getComputedStyle(document.documentElement)
  const raw = cs.getPropertyValue('--nav-h').trim()
  const n = Number.parseFloat(raw)
  if (!Number.isFinite(n)) return 72
  return raw.endsWith('rem') ? n * Number.parseFloat(cs.fontSize || '16') : n
}

/** 标题 → 锚点 id：保留字母数字（含中文），丢掉空白与标点，
 *  所以 id 里不会出现需要转义的字符（`#` 之类的也不会）。 */
function headingId(text: string, index: number): string {
  const slug = text
    .toLowerCase()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
  return `h-${slug || index + 1}`
}

/**
 * 全站唯一的滚动入口（目录跳转 / 返回顶部都走它）。
 * ★ 有 Lenis 就必须走它的 scrollTo —— 用 window.scrollTo / scrollIntoView
 *   会和 Lenis 内部状态打架（定位漂移），这是 AGENTS §5.1 记过的坑。
 *   没有 Lenis（用户开了「减弱动态效果」）时才退回原生滚动。
 */
function scrollToY(top: number, smooth: boolean) {
  const animate = smooth && !prefersReducedMotion()
  const lenis = getLenis()
  if (lenis) {
    if (animate) lenis.scrollTo(top, { duration: 0.9 })
    else lenis.scrollTo(top, { immediate: true })
    return
  }
  window.scrollTo({ top, behavior: animate ? 'smooth' : 'auto' })
}

/** 正文进 DOM 之后收集小标题：给每一条补上 id，并生成目录 */
async function collectHeadings() {
  await nextTick()
  const root = bodyEl.value
  const items: TocItem[] = []
  if (root) {
    const used = new Set<string>()
    root.querySelectorAll<HTMLElement>('h2, h3, h4').forEach((el, i) => {
      const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim()
      if (!text) return
      if (!el.id) {
        /* 同名标题（比如两处「小结」）加序号后缀 —— id 必须唯一 */
        const base = headingId(text, i)
        let id = base
        let n = 2
        while (used.has(id)) id = `${base}-${n++}`
        el.id = id
      }
      used.add(el.id)
      items.push({ id: el.id, text, level: Number(el.tagName.slice(1)) })
    })
  }
  toc.value = items
  syncActive()
}

/* 正文是**懒加载**的（先 null 再赋值），所以挂 body 而不是只跑一次 onMounted */
watch(body, () => void collectHeadings())

/** 点了哪一条就滚到哪一条，停在「导航下沿 + TOC_GAP」处 */
function jumpTo(id: string) {
  const el = document.getElementById(id)
  if (!el) return
  scrollToY(window.scrollY + el.getBoundingClientRect().top - (navHeight() + TOC_GAP), true)
}

/** 文末「返回顶部」 */
function toTop() {
  scrollToY(0, true)
}

/** 当前小节 = 已经越过判定线的最后一个标题 */
function syncActive() {
  if (!toc.value.length) {
    activeId.value = ''
    return
  }
  const line = navHeight() + TOC_GAP + 8
  let current = ''
  for (const item of toc.value) {
    const el = document.getElementById(item.id)
    if (!el) continue
    if (el.getBoundingClientRect().top <= line) current = item.id
    else break
  }
  activeId.value = current
}

/* 滚动监听用 rAF 节流：Lenis 一帧可能发好几次 scroll */
let scrollRaf = 0
function onScroll() {
  if (scrollRaf) return
  scrollRaf = requestAnimationFrame(() => {
    scrollRaf = 0
    syncActive()
  })
}

onMounted(() => {
  window.addEventListener('scroll', onScroll, { passive: true })
  /* 兜底：万一挂载时正文已经在了（watch 不会再触发）也得建目录 */
  if (body.value) void collectHeadings()
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', onScroll)
  if (scrollRaf) cancelAnimationFrame(scrollRaf)
})
</script>

<template>
  <article v-if="meta" class="article u-container">
    <!-- 毛玻璃面板：包住「头部 + 正文 + 翻页」。
         ★ 面板宽度 = 阅读栏宽 + 两侧内边距，且 box-sizing: border-box，
           所以面板的 content box 恰好等于 --reading-w —— 里面那些
           max-width: var(--reading-w) 的块宽度**逐像素不变**。 -->
    <div class="panel glass-panel">
      <!-- 头部与正文共用同一居中栏宽 -->
      <header class="article-head">
        <RouterLink to="/articles" class="back u-h4">← 返回列表</RouterLink>

        <div class="meta">
          <span class="u-h4">{{ meta.category }}</span>
          <time class="u-h4 u-muted" :datetime="meta.date">{{ meta.date }}</time>
        </div>

        <!-- 标签：点一个回到列表页并**预选**它（/articles?tags=xxx）
             ★ query 而不是 path：列表页读的就是 ?tags=，这样「点标签 → 看到同一批文章」
               只需要一次导航，不用在两边各存一份筛选状态。 -->
        <div v-if="meta.tags.length" class="tags">
          <RouterLink
            v-for="t in meta.tags"
            :key="t"
            :to="{ path: '/articles', query: { tags: t } }"
            class="tag u-h4"
          >
            <span class="tag-hash">#</span>{{ t }}
          </RouterLink>
        </div>

        <h1 class="title u-h1-cn" v-reveal>{{ meta.title }}</h1>
        <p class="lead u-main u-muted" v-reveal="120">{{ meta.summary }}</p>
      </header>

      <hr class="rule" />

      <!-- 正文：加载中 / 已就绪 -->
      <div ref="bodyEl" class="body">
        <p v-if="loading" class="state u-muted">正在加载正文…</p>
        <MarkdownRenderer v-else-if="body" :source="body" />
      </div>

      <div class="spacer"></div>

      <!-- 上一篇 / 下一篇 -->
      <nav v-if="near.prev || near.next" class="pager" aria-label="文章导航">
        <RouterLink v-if="near.prev" :to="`/articles/${near.prev.slug}`" class="pager-item">
          <span class="u-h4 u-muted">上一篇</span>
          <span class="pager-title">{{ near.prev.title }}</span>
        </RouterLink>
        <span v-else class="pager-item is-empty"></span>

        <RouterLink
          v-if="near.next"
          :to="`/articles/${near.next.slug}`"
          class="pager-item pager-item--next"
        >
          <span class="u-h4 u-muted">下一篇</span>
          <span class="pager-title">{{ near.next.title }}</span>
        </RouterLink>
      </nav>

      <div class="spacer"></div>

      <div class="foot">
        <RouterLink to="/articles" class="btn">继续阅读</RouterLink>
        <!-- 右侧动作（.foot 是 space-between，所以它贴右边缘）。
             这里曾经有一条「说点什么 →」去总评论区（2026-10-07 用户 m09009
               把那个板块整个换成了项目页，故删）。 -->
        <div class="foot-actions">
          <button type="button" class="btn u-h4 to-top" @click="toTop">返回顶部 ↑</button>
        </div>
      </div>
    </div>

    <!-- 小标题栏（目录）：
         ★ 放在面板**外面** —— 用户要的位置就是「毛玻璃右侧」。
           放进面板里会挤窄正文栏，而且是另一回事。
         ★ 内容由正文 DOM 反查（见 script 里的 collectHeadings）：
           markdown 里写几个 h2/h3 就显示几条，不用维护第二份列表。
         ★ v-if：没有小标题的文章（如 hello）整块不存在，不影响版面。 -->
    <aside v-if="toc.length" class="toc-col">
      <nav class="toc" aria-label="文章小标题">
        <p class="toc-title u-h4 u-muted">小标题</p>
        <ol class="toc-list">
          <li v-for="h in toc" :key="h.id" class="toc-item" :class="`lvl-${h.level}`">
            <a
              class="toc-link"
              :class="{ 'is-active': h.id === activeId }"
              :href="`#${h.id}`"
              @click.prevent="jumpTo(h.id)"
            >{{ h.text }}</a>
          </li>
        </ol>
      </nav>
    </aside>

    <!-- ★ 这个 spacer 必须留在面板**外面**：它是「卡片底边 → 页脚」的间距。
         放进面板里，卡片就会一直贴到页脚（实测只剩 ~5px）。 -->
    <div class="spacer"></div>
  </article>

  <!-- slug 不存在：明确告知，不要留白屏 -->
  <div v-else class="article u-container missing">
    <p class="u-h4 u-muted">404</p>
    <h1 class="u-h2-cn">找不到这篇文章</h1>
    <p class="u-main u-muted">它可能被改名或删掉了。链接里的标识是「{{ props.id }}」。</p>
    <RouterLink to="/articles" class="btn">回到文章列表</RouterLink>
  </div>
</template>


<style scoped>
/*
 * 居中栏宽 --reading-w
 *   用 ch（跟随字号）。62ch 约等于舒服的中文行长。
 *   头部 / 分隔线 / 正文 / 页脚都限制在同一宽度并 margin-inline: auto。
 */
.article {
  --reading-w: 62ch;
  /* ★ 面板的两条尺寸令牌放在这里（而不是 .panel 上）：
     ≥1280px 的网格要用 --panel-pad 算中间那一列的宽度，
     而自定义属性只**向下**继承 —— 写在 .panel 上父级读不到。 */
  --panel-pad: clamp(1.25rem, 4vw, 3.25rem);
  --panel-radius: clamp(16px, 1.6vw, 22px);
  padding-top: var(--page-top);
}

/*
 * ★★ ≥1280px：面板居中 + 右侧多一列小标题栏。
 *
 * 为什么用 3 列网格，而不是给目录做绝对定位：
 *   只有常规流里的元素才能 position: sticky，而「滑到导航下沿就黏住、
 *   上滑恢复」正好就是 sticky 的语义。fixed 做不到「上滑恢复」
 *   （它会从进正文的第一眼就贴在顶上）。
 *
 * 中间列 = 面板宽（读宽 + 两侧内边距），左右两个 1fr 等宽
 *   → 面板仍在整页居中，与原来的 margin-inline: auto 完全等价。
 *
 * ⚠️ :not(.missing) —— .article 被 404 分支复用（v-else），
 *    那边一串散块要是进了网格会散成三列。
 * ⚠️ 绝不要给这个网格加 align-items: start：
 *    那样 .toc-col 只有自身高度，sticky 就无处可黏（sticky 最经典的坑）。
 */
@media (min-width: 1280px) {
  .article:not(.missing) {
    display: grid;
    grid-template-columns:
      minmax(0, 1fr)
      minmax(0, calc(var(--reading-w) + var(--panel-pad) * 2))
      minmax(0, 1fr);
  }

  .article:not(.missing) > .panel {
    grid-column: 2;
  }

  .article:not(.missing) > .toc-col {
    grid-column: 3;
  }

  /* 面板外面那个收尾间距横跨整行 */
  .article:not(.missing) > .spacer {
    grid-column: 1 / -1;
  }
}

.article-head,
.rule,
.body,
.foot {
  width: 100%;
  max-width: var(--reading-w);
  margin-inline: auto;
}

/*
 * 毛玻璃面板（2026-10-06 用户要求「文章详情页文章背景加个毛玻璃效果，凸显文章」）
 *
 * ★ 为什么是「包一层 div」而不是给 .article 本身加背景：
 *   .article 是 .u-container（宽 = 100vw − 2rem），而正文栏只有 62ch。
 *   直接给容器上色 → 宽屏上玻璃比文字宽出一大截，看着像"页面被分成两块"。
 *   面板宽度 = 阅读栏宽 + 两侧内边距，所以玻璃**贴着文字**。
 *
 * ★ 面板的 content box 恰好等于 --reading-w（border-box + 两侧等宽内边距），
 *   所以上面那组 max-width: var(--reading-w) 一条都不用改，文字栏宽逐像素不变。
 *
 * ★★ 背景是 html::before 的**固定平滑渐变**（没有细节可模糊），所以
 *   backdrop-filter 本身几乎看不出变化 —— 真正让它读成"玻璃"的是三件套：
 *     ① 淡白纱（linear-gradient 的 3 个白色停止点）
 *     ② 1px 亮边 + 顶部内高光（inset 0 1px 0）
 *     ③ 大而软的投影 ← **最关键**：平滑渐变上只有投影能把"纸"抬起来
 *   去掉投影后它立刻退化成一块"颜色略有不同的矩形"。
 *
 * ★★ 2026-10-07：这三件套的**配方**上提到了 style.css 的 `.glass-panel`
 *   （当时是为了让留言板复用同一种"纸"；留言板已在 m09009 换成项目页，
 *   `.glass-panel` 保留 —— 它仍是"单篇内容的纸"这个语义，以后加详情页直接用）。
 *   这里只留**版面**：多宽、怎么居中。改观感 = 改 .glass-panel；改宽度 = 改这里。
 */
.panel {
  width: 100%;
  max-width: calc(var(--reading-w) + var(--panel-pad) * 2);
  margin-inline: auto;
}

.article-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-6);
}

.back {
  opacity: 0.8;
  transition: opacity 0.3s var(--ease);
  /* 返链不跟随整栏的文本流，单独贴左 */
  align-self: flex-start;
}

.back:hover {
  opacity: 1;
}

.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
}

/* 标签行：与分类/日期同属「头部元信息」，所以放在 .meta 下面而不是正文里 */
.tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
}

.tag {
  padding: 0.3rem 0.7rem;
  font-size: 0.75rem;
  border: 1px solid var(--line);
  border-radius: 100vw;
  opacity: 0.7;
  transition:
    opacity 0.3s var(--ease),
    background-color 0.3s var(--ease),
    color 0.3s var(--ease);
}

/* hover = 反色填充，与列表页「已选中的标签」同款，暗示「点了会被筛出来」 */
.tag:hover {
  opacity: 1;
  background: var(--text);
  color: var(--bg);
  border-color: var(--text);
}

.tag-hash {
  margin-right: 0.1em;
  opacity: 0.55;
}

.title {
  max-width: 20ch;
  text-wrap: balance;
}

.lead {
  max-width: 52ch;
  text-wrap: pretty;
}

/* 分隔线跟着文字栏宽，而不是通栏铺满 */
.rule {
  height: 1px;
  border: 0;
  background-color: var(--line);
}

/* 正文区 —— 全站唯一允许选中文本的地方
 *   ★ style.css 的基础层有一条 `* { user-select: none }`（站点级策略：
 *     导航、hero 巨型字形、按钮、标签一律不可选）。这里把它重新打开。
 *   ★ 放行的边界**恰好**是 MarkdownRenderer 渲染出来的正文（含代码块）：
 *     上面的 .article-head（分类 / 日期 / 标题 / 摘要）与下面的 .pager
 *     （上一篇 / 下一篇）仍然是版式，依旧不可选。
 *   ★ 为什么写在 .body 而不是 MarkdownRenderer 组件内部：
 *     以后换渲染器（或加一个「引用块」组件）时，这条策略不该跟着换 ——
 *     它属于**版面**的职责，不属于渲染器的职责。
 *   ★ 副作用：文章标题与摘要无法复制。要用那种能力就把放行点上提到
 *     .article，代价是页码与翻页链接也一起可选了。 */
.body {
  padding-top: var(--space-6);
  user-select: text;
  -webkit-user-select: text;
}

/*
 * 上一篇 / 下一篇
 *   ★ 必须进「居中栏宽组」——否则会撑满整宽，而正文是 62ch 居中，
 *     两者左边对齐、右边空一大片（曾经就是这个症状）。
 *   ★ 两列等宽：「上一篇」贴左、「下一篇」贴右，
 *     缺一篇时用占位 span 占住格子，剩下的那个才不会滑到左边。
 */
.pager {
  width: 100%;
  max-width: var(--reading-w);
  margin-inline: auto;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--gutter);
  border-top: 1px solid var(--line);
  padding-top: var(--space-5);
}

.pager-item {
  /* ★ RouterLink 默认是 inline，flex 才能让标签与标题分成两行 */
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
  transition: opacity 0.3s var(--ease);
}

.pager-item:not(.is-empty):hover {
  opacity: 0.55;
}

.pager-item--next {
  align-items: flex-end;
  text-align: right;
}

.pager-title {
  font-size: var(--fs-h3);
  /* 中文行高必须分档，1.1 会上下叠 */
  line-height: var(--lh-h3-cn);
  text-wrap: pretty;
}

.spacer {
  height: var(--section-small);
}

.foot {
  display: flex;
  align-items: center;
  /* 「继续阅读」贴左、右侧动作贴右 —— 用户要的「末尾并排右下方」 */
  justify-content: space-between;
  /* 窄屏放不下就换行（动作多了以后会用到） */
  flex-wrap: wrap;
  gap: 1rem;
}

/* 页脚右侧的动作组：现在只有「返回顶部」，保留这层是为了以后再加动作时
   不影响「继续阅读」与它们的对齐关系。 */
.foot-actions {
  display: flex;
  align-items: center;
  gap: 1.25rem;
}

/* 「返回顶部 ↑」：与「继续阅读」同一套文字样式，只是压暗一点 */
.to-top {
  opacity: 0.72;
  transition: opacity 0.3s var(--ease);
}

.to-top:hover {
  opacity: 1;
}

/* ==================== 小标题栏（目录） ====================
 * ★ 只在 ≥1280px 出现。1280 时中间列 ≈ 743px、两侧各 ≈ 236px，
 *   目录 15rem + 2rem 间距刚好放得下；再窄就得盖住正文了。
 */
.toc-col {
  display: none;
}

@media (min-width: 1280px) {
  .toc-col {
    display: block;
  }
}

/*
 * ★ sticky 的 top 必须与 JS 里 navHeight() + TOC_GAP 一致 ——
 *   跳转落点用的是同一个值，两处不一致就会停在偏高/偏低的位置。
 */
.toc {
  position: sticky;
  top: calc(var(--nav-h) + 24px);
  /* 贴着面板往右留 2rem；max-width 兜住 1280~1400 这段较窄的列不出界 */
  margin-left: 2rem;
  max-width: min(15rem, calc(100% - 2rem));
  /* 小标题特别多时目录自己滚，不把页面撑高（sticky 元素自身可以滚） */
  max-height: calc(100svh - var(--nav-h) - 3rem);
  overflow-y: auto;
  scrollbar-width: thin;
  padding-right: 0.25rem;
}

.toc-title {
  margin-bottom: 0.85rem;
}

.toc-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}

/* 悬挂缩进 + 左侧短横线：与正文列表用的是同一种「线」语言 */
.toc-link {
  position: relative;
  display: block;
  padding-left: 0.9rem;
  font-size: 0.8125rem;
  line-height: 1.5;
  text-wrap: pretty;
  color: color-mix(in srgb, var(--text) 60%, transparent);
  transition:
    color 0.25s var(--ease),
    opacity 0.25s var(--ease);
}

.toc-link::before {
  content: '';
  position: absolute;
  left: 0;
  top: 0.7em;
  width: 0.5em;
  height: 1px;
  background-color: var(--line);
  transition:
    background-color 0.25s var(--ease),
    width 0.25s var(--ease);
}

.toc-link:hover {
  color: var(--text);
}

/* 当前读到的小节：只提亮 + 短线变长，不加粗 ——
   目录是导航，不该跟正文抢注意力 */
.toc-link.is-active {
  color: var(--text);
}

.toc-link.is-active::before {
  width: 0.7em;
  background-color: var(--text);
}

/* h3 / h4 再缩进一档，层级一眼看得出来 */
.toc-item.lvl-3 .toc-link {
  padding-left: 1.75rem;
}

.toc-item.lvl-4 .toc-link {
  padding-left: 2.6rem;
}

/* 窄屏：栏宽退化为整宽（容器的 site-margin 已经给了左右留白） */
@media (max-width: 767px) {
  .article {
    --reading-w: 100%;
  }
}

/*
 * 更窄的屏：上一篇/下一篇的两列会挤到每列 ~140px，
 * 中文标题基本放不下 → 改成上下堆叠，各自贴左。
 */
@media (max-width: 520px) {
  .pager {
    grid-template-columns: 1fr;
    gap: var(--space-4);
  }

  .pager-item--next {
    align-items: flex-start;
    text-align: left;
  }

  /* 堆叠时用不上占位格，避免多出一条空行 */
  .pager-item.is-empty {
    display: none;
  }
}
</style>
