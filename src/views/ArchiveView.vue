<script setup lang="ts">
import { computed, ref } from 'vue'
import { RouterLink } from 'vue-router'
import NextButton from '@/components/NextButton.vue'
import { useTagFilter } from '@/composables/tagFilter'
import { allPosts, allTags, filterByTags, groupByMonth, postTotal } from '@/posts'

/** 年份筛选。默认 0 = 不限。年份 ≥3 个时才显示筛选条（只有一两年时是纯噪声） */
const activeYear = ref<number | 0>(0)

/** 标签筛选（多选 AND）：与列表页共用同一份「URL ↔ 状态」逻辑 */
const { activeTags, toggleTag, clearTags } = useTagFilter()

const years = computed(() => {
  const set = new Set(allPosts.map((p) => Number(p.date.slice(0, 4))))
  return [...set].sort((a, b) => b - a)
})

/** 两个筛选**叠加**：先按年份，再按标签取交集 */
const filtered = computed(() => {
  const byYear = activeYear.value
    ? allPosts.filter((p) => p.date.startsWith(String(activeYear.value)))
    : allPosts
  return filterByTags(byYear, activeTags.value)
})

/** 按月分组（分组函数只认日期字符串，与两个筛选都正交） */
const groups = computed(() => groupByMonth(filtered.value))

/** 当前筛选下的篇数（页头显示用） */
const shown = computed(() => groups.value.reduce((n, g) => n + g.items.length, 0))
</script>

<template>
  <div class="u-container">
    <header class="page-head">
      <!-- ★ 0 篇时不显示「0 / 0 篇 · 0 个月」（同 ProjectListView 的空计数判断） -->
      <span v-if="postTotal" class="u-h4 u-muted">
        {{ shown }} / {{ postTotal }} 篇 · {{ groups.length }} 个月
      </span>
      <h1 class="u-h1-cn" v-reveal>归档</h1>
      <p class="page-lead u-main u-muted">
        把文章按年月摊开，用来回看。
      </p>
    </header>

    <!-- 年份筛选：只有跨年才出现（单年时是纯噪声） -->
    <div v-if="years.length > 2" class="year-filter">
      <button
        class="filter"
        :class="{ 'is-active': activeYear === 0 }"
        type="button"
        @click="activeYear = 0"
      >
        全部
      </button>
      <button
        v-for="y in years"
        :key="y"
        class="filter"
        :class="{ 'is-active': activeYear === y }"
        type="button"
        @click="activeYear = y"
      >
        {{ y }}
      </button>
    </div>

    <!-- 标签筛选：与年份**叠加**（先按年，再按标签取交集）
         ★ 样式复用列表页那套 pill；状态由 useTagFilter 与 URL 同步 -->
    <div v-if="allTags.length" class="tag-filter">
      <span class="filter-label u-h4 u-muted">标签</span>
      <button
        v-for="t in allTags"
        :key="t.name"
        type="button"
        class="filter filter-tag"
        :class="{ 'is-active': activeTags.includes(t.name) }"
        :aria-pressed="activeTags.includes(t.name)"
        @click="toggleTag(t.name)"
      >
        <span class="tag-hash">#</span>{{ t.name }}
        <span class="filter-count">{{ t.count }}</span>
      </button>
      <button
        v-if="activeTags.length"
        type="button"
        class="filter filter-clear"
        @click="clearTags()"
      >
        清空标签 ×{{ activeTags.length }}
      </button>
    </div>

    <div class="timeline">
      <section v-for="group in groups" :key="group.month" class="group">
        <h2 class="group-month u-h4">{{ group.label }}</h2>

        <ul class="group-list">
          <li v-for="item in group.items" :key="item.slug">
            <RouterLink :to="`/articles/${item.slug}`" class="entry">
              <span class="entry-title">{{ item.title }}</span>
              <span class="entry-meta">
                <span class="u-h4 u-muted">{{ item.category }}</span>
                <time class="u-h4 u-muted">{{ item.date.slice(8) }} 日</time>
              </span>
            </RouterLink>
          </li>
        </ul>
      </section>
    </div>

    <!-- 空态：共用的「取景框」样式在 style.css 的「空态」段
         （角标 = hero .hero-corner 的同一套 L 形语言） -->
    <p v-if="!shown" class="empty">
      <span class="empty-frame">
        <span class="empty-corner empty-corner-tr" aria-hidden="true"></span>
        <span class="empty-corner empty-corner-bl" aria-hidden="true"></span>
        <template v-if="postTotal">没有同时满足这些条件的文章。</template>
        <template v-else>这里还没有文章。</template>
      </span>
    </p>

    <div class="u-section-space"></div>

    <!-- 下一屏：与首页 hero 同款排版（见 components/NextButton.vue） -->
    <div class="page-next">
      <NextButton />
    </div>
  </div>
</template>

<style scoped>
.page-head {
  padding-top: var(--page-top);
  padding-bottom: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

/* 导语收窄：用 em 不用 ch（同 ProjectListView 的 .page-lead）。 */
.page-lead {
  max-width: 24em;
}

.group {
  display: grid;
  grid-template-columns: minmax(0, 6rem) 1fr;
  gap: var(--gutter);
  padding-block: var(--space-5);
  border-top: 1px solid var(--line);
}

.group-month {
  position: sticky;
  /* ★ 原来写死 `4.5rem`（= 桌面导航高 72px）—— 月份标签会**紧贴着导航底边**
     停住，滚动时半截钻到毛玻璃下面。改为「导航高 + 1rem」，留出一段呼吸：
     · 用 --nav-h 而不是硬编码，窄屏导航变矮时自动跟随；
     · +1rem 是标签与导航之间的最小间距（视觉上像贴在导航下方的一行小字）。 */
  top: calc(var(--nav-h) + 1rem);
  align-self: start;
  opacity: 0.8;
}

.entry {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: var(--gutter);
  padding-block: 0.6rem;
  transition: opacity 0.3s var(--ease);
}

.entry:hover {
  opacity: 0.55;
}

.entry-title {
  /* ★ 原为 `var(--fs-h)` —— 那个变量从未定义过，font-size 静默失效。
     改用既有的 --fs-h3。 */
  font-size: var(--fs-h3);
  line-height: 1.25;
}

/* 分类 + 日期：靠右对齐，彼此留一点距离 */
.entry-meta {
  display: flex;
  flex: none;
  gap: 1rem;
  align-items: baseline;
}

/* 年份筛选：与列表页的 .filter 同款外观（全站统一的 pill 按钮） */
.year-filter {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding-bottom: var(--space-5);
}

.filter {
  padding: 0.3rem 0.85rem;
  border: 1px solid var(--line);
  border-radius: 100vw;
  opacity: 0.75;
  transition:
    opacity 0.3s var(--ease),
    background-color 0.3s var(--ease),
    color 0.3s var(--ease);
}

.filter:hover {
  opacity: 1;
}

.filter.is-active {
  opacity: 1;
  background: var(--text);
  color: var(--bg);
  border-color: var(--text);
}

/* --- 标签筛选：与年份同款 pill，但小一号（年份是「粗筛」，标签是「细筛」） --- */
.tag-filter {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  padding-bottom: var(--space-5);
}

.filter-label {
  margin-right: 0.25rem;
  opacity: 0.6;
}

.filter-tag {
  padding: 0.3rem 0.7rem;
  font-size: 0.75rem;
  opacity: 0.6;
}

.tag-hash {
  margin-right: 0.1em;
  opacity: 0.5;
}

.filter-count {
  margin-left: 0.4em;
  font-size: 0.85em;
  opacity: 0.55;
}

.filter-tag.is-active .tag-hash,
.filter-tag.is-active .filter-count {
  opacity: 0.75;
}

/* 清空按钮：虚线描边，与「可切换的标签」区分开 */
.filter-clear {
  padding: 0.3rem 0.7rem;
  font-size: 0.75rem;
  border-style: dashed;
  opacity: 0.7;
}

/* 空态样式已上提到 style.css 的「空态」段（三个列表页共用一份，
   避免像原来那样每个 view 各写一遍、然后各自漂移 ——
   归档页原来还多带了 `u-main`，字号与另外两页就已经不一样了）。 */

@media (max-width: 800px) {
  .group {
    grid-template-columns: 1fr;
    gap: 1rem;
  }

  .group-month {
    position: static;
  }
}
</style>
