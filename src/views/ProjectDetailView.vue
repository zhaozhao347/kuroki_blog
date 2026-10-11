<script setup lang="ts">
/**
 * 项目详情页
 *
 * ── 与文章详情页的关系 ──
 *   版面是照 `ArticleDetailView.vue` 抄的（毛玻璃面板 / 同一条阅读栏宽 / 上下篇 /
 *   返回顶部），差别只有三处：
 *     1. 没有小标题栏（目录）—— 项目页通常只有两三个小节，一列目录是负担；
 *        真要加，把 ArticleDetailView 的 .toc 那套搬过来即可。
 *     2. 头部只有「年份 + 大标题 + 小标题」：项目没有分类 / 标签 / 角色 / 外链
 *        （用户 m13371：项目只需要 年份 / 大标题 / 小标题 / 图片）。
 *     3. 页脚是「所有项目 + 返回顶部」，没有「访问 ↗」——项目不再有 link 字段。
 *
 * ── 数据来源 ──
 *   元数据来自 `@/projects`（构建期索引），**正文按需懒加载**：
 *   点进某个项目才下载那一个 md 的 chunk。
 *
 * ── 三种状态 ──
 *   loading  正文在加载（懒加载 chunk 要等网络）
 *   ready    正常渲染
 *   missing  该 slug 不存在 —— 显示「找不到这个项目」而不是永远转圈
 */
import { computed, ref, watch } from 'vue'
import { RouterLink } from 'vue-router'
import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import { getLenis, prefersReducedMotion } from '@/composables/motion'
import { findProject, getProjectBody, projectNeighbors } from '@/projects'

const props = defineProps<{ id: string }>()

/** 当前项目的元数据（构建期索引里有，立刻可用） */
const meta = computed(() => findProject(props.id))

/** 正文源码；null = 还没加载完 */
const body = ref<string | null>(null)
/** 该 slug 不存在 */
const missing = ref(false)
/** 正在加载 */
const loading = ref(false)

/** 上一个（更新）/ 下一个（更旧）项目 */
const near = computed(() => projectNeighbors(props.id))

/**
 * 加载正文。
 *
 * ★ 必须 `watch(..., { immediate: true })` 而不是只 `onMounted`：
 *   从「下一个项目」跳到另一个时**路由参数变了但组件被复用**（同一路由记录），
 *   onMounted 不会再跑，正文会停在上一份。
 * ★ `slug !== props.id` 是竞态保护：快速连点两个项目时，
 *   先返回的旧请求不能覆盖新内容。
 */
watch(
  () => props.id,
  async (slug) => {
    body.value = null
    missing.value = false
    loading.value = true
    try {
      const text = await getProjectBody(slug)
      if (slug !== props.id) return
      if (text === null) missing.value = true
      else body.value = text
    } finally {
      if (slug === props.id) loading.value = false
    }
  },
  { immediate: true },
)

/**
 * 页脚「返回顶部」。
 * ★ 滚动一律走 Lenis（AGENTS §5.1）：直接用 window.scrollTo / scrollIntoView
 *   会和 Lenis 的内部位置打架，落点会漂。
 *   用户开了「减弱动态效果」时才退回原生滚动。
 */
function toTop() {
  const animate = !prefersReducedMotion()
  const lenis = getLenis()
  if (lenis) {
    if (animate) lenis.scrollTo(0, { duration: 0.9 })
    else lenis.scrollTo(0, { immediate: true })
    return
  }
  window.scrollTo({ top: 0, behavior: animate ? 'smooth' : 'auto' })
}
</script>

<template>
  <article v-if="meta" class="project u-container">
    <!-- 毛玻璃面板：与文章详情页同一张「纸」（.glass-panel 见 src/style.css）。
         面板宽度 = 阅读栏宽 + 两侧内边距（border-box），所以里面的
         max-width: var(--reading-w) 块宽度逐像素不变。 -->
    <div class="panel glass-panel">
      <header class="project-head">
        <RouterLink to="/projects" class="back u-h4">← 返回项目</RouterLink>

        <!-- 头部只有年份 + 标题 + 摘要（年份从 date 派生，不假装精确到日）。
             ★ 项目没有分类 / 标签 / 角色行 —— 用户 m13371 定：项目只需要
               年份 / 大标题 / 小标题 / 图片。 -->
        <p class="u-h4 u-muted">{{ meta.year }}</p>

        <h1 class="title u-h1-cn" v-reveal>{{ meta.title }}</h1>
        <p class="lead u-main u-muted" v-reveal="120">{{ meta.summary }}</p>
      </header>

      <hr class="rule" />

      <!-- 正文：加载中 / 已就绪 -->
      <div class="body">
        <p v-if="loading" class="state u-muted">正在加载正文…</p>
        <MarkdownRenderer v-else-if="body" :source="body" />
      </div>

      <div class="spacer"></div>

      <!-- 上一个 / 下一个项目 -->
      <nav v-if="near.prev || near.next" class="pager" aria-label="项目导航">
        <RouterLink v-if="near.prev" :to="`/projects/${near.prev.slug}`" class="pager-item">
          <span class="u-h4 u-muted">上一个</span>
          <span class="pager-title">{{ near.prev.title }}</span>
        </RouterLink>
        <span v-else class="pager-item is-empty"></span>

        <RouterLink
          v-if="near.next"
          :to="`/projects/${near.next.slug}`"
          class="pager-item pager-item--next"
        >
          <span class="u-h4 u-muted">下一个</span>
          <span class="pager-title">{{ near.next.title }}</span>
        </RouterLink>
      </nav>

      <div class="spacer"></div>

      <div class="foot">
        <RouterLink to="/projects" class="btn">所有项目</RouterLink>
        <div class="foot-actions">
          <button type="button" class="btn u-h4 to-top" @click="toTop">返回顶部 ↑</button>
        </div>
      </div>
    </div>

    <!-- ★ 这个 spacer 必须留在面板**外面**：它是「卡片底边 → 页脚」的间距。
         放进面板里，卡片就会一直贴到页脚（实测只剩 ~5px）。 -->
    <div class="spacer"></div>
  </article>

  <!-- slug 不存在：明确告知，不要留白屏 -->
  <div v-else class="project u-container missing">
    <p class="u-h4 u-muted">404</p>
    <h1 class="u-h2-cn">加载失败了😫</h1>
    <p class="u-main u-muted">它可能被改名或删掉了。链接里的标识是「{{ props.id }}」。</p>
    <RouterLink to="/projects" class="btn">回到项目列表</RouterLink>
  </div>
</template>

<style scoped>
/* 居中栏宽：与文章详情页同一个值（62ch ≈ 舒服的中文行长）。 */
.project {
  --reading-w: 62ch;
  --panel-pad: clamp(1.25rem, 4vw, 3.25rem);
  --panel-radius: clamp(16px, 1.6vw, 22px);
  padding-top: var(--page-top);
}

.panel {
  width: 100%;
  max-width: calc(var(--reading-w) + var(--panel-pad) * 2);
  margin-inline: auto;
}

.project-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-6);
}

.back {
  align-self: flex-start;
  opacity: 0.8;
  transition: opacity 0.3s var(--ease);
}

.back:hover {
  opacity: 1;
}

.title {
  max-width: 20ch;
  text-wrap: balance;
}

.lead {
  max-width: 52ch;
  text-wrap: pretty;
}

.rule {
  height: 1px;
  border: 0;
  background-color: var(--line);
}

.body {
  padding-top: var(--space-6);
  /* ★ 正文必须能选中复制（全局 `* { user-select: none }` 会拦住它） */
  user-select: text;
  -webkit-user-select: text;
}

/* 上一个 / 下一个：两列，右侧那条贴右边缘 */
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
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  min-width: 0;
  transition: opacity 0.3s var(--ease);
}

.pager-item:hover {
  opacity: 0.72;
}

.pager-item--next {
  align-items: flex-end;
  text-align: right;
}

.pager-title {
  font-size: var(--fs-h3);
  line-height: var(--lh-h3-cn);
  text-wrap: pretty;
}

.spacer {
  height: var(--section-small);
}

.foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
}

.foot-actions {
  display: flex;
  align-items: center;
  gap: 1.25rem;
}

.to-top {
  opacity: 0.72;
  transition: opacity 0.3s var(--ease);
}

.to-top:hover {
  opacity: 1;
}

/* slug 不存在 */
.missing {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1rem;
}
</style>
