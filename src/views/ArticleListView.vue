<script setup lang="ts">
/**
 * 全部文章 —— 列表页
 *
 * ── 数据来源 ──
 *   `@/posts`（门面层）→ 构建期扫描 `content/posts/*.md` 生成。
 *   加文章只需往那个目录丢 md，这里**不用改**。
 *
 * ── 筛选维度只有一个：标签 ──
 *   分类（`category`）仍写在 frontmatter 里、仍显示在卡片上，
 *   但**不再有筛选入口**（2026-10-06 用户要求）。理由很实在：
 *   6 篇文章散在 5 个分类里，点任何一个都只剩 1 篇，作筛选器没意义；
 *   标签可多选（AND）才是有区分度的那个维度。
 *
 *   曾经有过一排分类筛选（'全部' + `allCategories`），已随之删除；
 *   `allCategories` 这个导出也一并删了（留着会让人以为还能按分类筛）。
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import NextButton from '@/components/NextButton.vue'
import { useTagFilter } from '@/composables/tagFilter'
import { allPosts, allTags, coverOf, filterByTags, postsErrors } from '@/posts'

/* 标签筛选（多选 AND）+ URL 同步，逻辑与归档页共用一份 */
const { activeTags, toggleTag, clearTags } = useTagFilter()

/** 只按标签筛（AND） */
const filtered = computed(() => filterByTags(allPosts, activeTags.value))
</script>

<template>
  <div class="u-container">
    <header class="page-head">
      <span class="u-h4 u-muted">共 {{ filtered.length }} 篇</span>
      <h1 class="u-h1-cn" v-reveal>全部文章</h1>
    </header>

    <!-- ★ 写作错误提示：只在 dev 下会出现（生产构建遇错直接失败，走不到这） -->
    <aside v-if="postsErrors.length" class="write-warn" role="alert">
      <span class="u-h4">有 {{ postsErrors.length }} 个文件没被读入</span>
      <pre class="write-warn-body">{{ postsErrors.join('\n\n') }}</pre>
      <span class="u-h4 u-muted">修好后保存，页面会自动刷新。</span>
    </aside>

    <!-- 标签筛选（**多选**，AND 语义）—— 列表页唯一的筛选排
         ★ 按钮里不能嵌套按钮，所以卡片上的标签只是装饰，只有这里能点 -->
    <nav v-if="allTags.length" class="filters filters-tags" aria-label="按标签筛选">
      <span class="filters-label u-h4 u-muted">标签</span>
      <button
        v-for="t in allTags"
        :key="t.name"
        type="button"
        class="filter filter-tag u-h4"
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
        class="filter filter-clear u-h4"
        @click="clearTags()"
      >
        清空标签 ×{{ activeTags.length }}
      </button>
    </nav>
    <ul class="grid">
      <li v-for="(item, i) in filtered" :key="item.slug" v-reveal="i * 60" class="card">
        <RouterLink :to="`/articles/${item.slug}`" class="card-link">
          <!-- ★ 没写 cover 的 md 就不渲染图（v-if）。
               不写 v-if 会生成 `<img src="">` —— 浏览器会对当前页面
               再发一次请求（实测 6 个空 img），纯浪费。
               （曾经有「按日期哈希挑一张兜底图」的逻辑，已删：
                 没写 cover 却出现随机图是隐式行为，想换图还得改日期。） -->
          <span v-if="coverOf(item)" class="card-media">
            <img v-img-fallback :src="coverOf(item)" :alt="item.title" loading="lazy" />
          </span>

          <span class="card-body">
            <span class="card-title">{{ item.title }}</span>
            <span class="card-summary u-small u-muted">{{ item.summary }}</span>
            <span v-if="item.tags.length" class="card-tags">
              <span v-for="t in item.tags" :key="t" class="card-tag u-h4">#{{ t }}</span>
            </span>
            <span class="card-meta">
              <span class="u-h4">{{ item.category }}</span>
              <time class="u-h4 u-muted" :datetime="item.date">{{ item.date }}</time>
            </span>
          </span>
        </RouterLink>
      </li>
    </ul>

    <p v-if="!filtered.length" class="empty u-muted">
      <template v-if="activeTags.length">没有同时带这些标签的文章（多个标签取交集）。</template>
      <template v-else>这里还没有文章。</template>
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

/* --- 筛选 --- */
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--line);
}

.filter {
  padding: 0.45rem 1rem;
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

/* --- 标签筛选（列表页唯一的筛选排） ---
   ★ 底边线来自基类 `.filters`，正好当筛选器与卡片网格之间的分隔。 */
.filters-tags {
  align-items: center;
}

.filters-label {
  margin-right: 0.25rem;
  opacity: 0.6;
}

/* 筛选 pill 比正文小一号：它是辅助控件，不该跟标题抢注意力 */
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

/* --- 卡片网格：24 列，每项跨 6 列（一行 4 个）--- */
.grid {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  column-gap: var(--gutter);
  row-gap: 2.5rem;
  padding-top: var(--space-6);
}

.card {
  grid-column: span 6;
}

.card-media {
  display: block;
  aspect-ratio: 3 / 4;
  overflow: hidden;
  background: color-mix(in srgb, var(--text) 8%, transparent);
}

.card-media img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: scale 0.7s var(--ease);
}

.card-link:hover .card-media img {
  scale: 1.05;
}

/* ★ 整卡 hover 反馈（用户 m11155：「选中文章没有hover，给选中文章做个hover」）：
   上面那条只对**有封面**的卡生效 —— 没写 `cover` 的 md 卡片（模板里 `v-if="coverOf(item)"`）
   连 `.card-media` 都不渲染，hover 时原本**零反馈**
   （仓库里 6 篇 post 全都没写 cover ⇒ 图片放大在实际站点上从未触发过）。
   所以补两条**不依赖封面、也不依赖 transform** 的整卡反馈：
     ① 卡片顶上那条 1px 细线（全局 `.card { border-top: 1px solid var(--line) }`，
        见 src/style.css:713）从 50% 亮到 100% —— 「这张卡被拿起来了」；
     ② 标题的下划线淡入（颜色不变，保住标题层级）。
   ★ 刻意**不把标题变灰**：第一版写成 `color: var(--muted)`，实测六张卡里被 hover 的
     那一张反而像「不可用」（标题掉到跟摘要一样亮）。`.entry:hover` / `.next:hover`
     那套「hover = 退一步变灰」的语言适合整行与按钮，不适合列表里的标题。
   ★ 刻意不用 transform 抬卡：`.card` 上挂着 `v-reveal`（指令写内联 transform），
     内联样式会盖掉 CSS hover 的 transform。
   ★ 用 `:has()` 是因为细线长在 `.card`（li）上、而 hover 发生在它内部的 `.card-link`。 */
@media (hover: hover) {
  .card {
    transition: border-top-color 0.35s var(--ease);
  }

  .card:has(.card-link:hover) {
    border-top-color: var(--text);
  }

  .card-link:hover .card-title {
    text-decoration-color: currentColor;
  }

  /* ③ 摘要从 --muted 亮成正文色（`u-muted` 只有 0,1,0，这里 0,2,0 能盖过它）：
     hover 是「唤醒」——标题不给动，靠摘要亮起来把整张卡拉进视线。 */
  .card-link:hover .card-summary {
    color: var(--text);
  }
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 0.75rem;
}

.card-title {
  font-family: var(--font-mono);
  /* ★ 原来写的是 `var(--fs-h)` —— 这个变量**从未定义过**，
     于是 font-size 静默失效、退回继承值（16px），标题看起来跟正文一样大。
     改用既有的 --fs-h3（1rem）。 */
  font-size: var(--fs-h3);
  line-height: 1.2;
  /* ★ 整卡 hover 的可见反馈靠标题（见下方 .card-link:hover 的注释）：
     默认是一条透明下划线，hover 时连同颜色一起过渡出来。
     用 text-decoration 而不是 `::after` 画线：标题**换行时每行都会画**，
     `::after` 只会落在整块盒子的底部。 */
  text-decoration: underline;
  text-decoration-color: transparent;
  text-decoration-thickness: 1px;
  text-underline-offset: 0.22em;
  transition:
    color 0.35s var(--ease),
    text-decoration-color 0.35s var(--ease);
}

.card-summary {
  max-width: 34ch;
  transition: color 0.35s var(--ease);
}

.card-meta {
  display: flex;
  gap: 0.75rem;
  padding-top: 0.25rem;
}

/* 卡片上的标签：**只是装饰，不可点**
   —— 整张卡已经是一个 RouterLink，里面不能再嵌按钮/链接（无效 HTML）。 */
.card-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.card-tag {
  font-size: 0.75rem;
  opacity: 0.55;
}

.empty {
  padding-block: var(--section-small);
  text-align: center;
}

/* 写作错误提示框：只在 dev 出现，用站点既有的两色（不引入红色）。
   靠描边 + 半透明底与内容区分，而不是靠色相 —— 守住单色约束。 */
.write-warn {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  margin-bottom: var(--space-5);
  padding: 1rem 1.25rem;
  border: 1px solid var(--text);
  border-radius: 3px;
  background: color-mix(in srgb, var(--text) 12%, transparent);
}

.write-warn-body {
  margin: 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.75rem;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

@media (max-width: 1000px) {
  .card {
    grid-column: span 8;
  }
}

@media (max-width: 800px) {
  .grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
  }

  .card {
    grid-column: span 3;
  }

  .card-title {
    font-size: var(--fs-main);
  }
}
</style>
