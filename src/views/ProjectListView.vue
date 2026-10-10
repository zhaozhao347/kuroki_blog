<script setup lang="ts">
/**
 * 项目 —— 列表页
 *
 * ── 数据来源 ──
 *   `@/projects`（门面层）→ 构建期扫描 `content/projects/*.md` 生成的
 *   `virtual:projects`。丢一个 md 进目录，这里就多一张卡（见 AGENTS.md §5.12）。
 *
 * ── 整张卡是一个 RouterLink ──
 *   「点进去跟文章一样」：卡片是入口，详情页才是内容。
 *   ★ 所以卡片上**不能**再嵌外链按钮（`<a>` 套 `<a>` 是无效 HTML，
 *     而且点击会被内层吞掉）—— `link` 渲染在**详情页**上。
 *
 * ── 为什么没有毛玻璃面板 ──
 *   面板是「单篇内容」的纸（文章详情页）：给一段长文一个边界。
 *   采集页（文章列表 / 归档 / 项目）一律**直接在页面上排卡片** ——
 *   一行能放三个项目，不用把卡片的宽度让给面板左右的内边距。
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { projects, projectsErrors } from '@/projects'

const count = computed(() => projects.length)
</script>

<template>
  <div class="u-container">
    <header class="page-head">
      <!-- 0 个项目时不显示「共 0 个」（空态已经说明了情况） -->
      <span v-if="count" class="u-h4 u-muted">共 {{ count }} 个项目</span>
      <h1 class="u-h1-cn" v-reveal>项目</h1>
      <p class="page-lead u-main u-muted">
        做过的一些东西：项目、作品、实验。
      </p>
    </header>

    <!-- 构建期扫到的问题：只在 dev 出现（写错一个 frontmatter 时，
         那个 md 会被静默跳过 —— 不提示的话会以为「系统坏了」）。
         与文章列表页同一套提示，样式见本文件末尾的 .write-warn。 -->
    <aside v-if="projectsErrors.length" class="write-warn" role="alert">
      <span class="u-h4">有 {{ projectsErrors.length }} 个文件没被读入</span>
      <pre class="write-warn-body">{{ projectsErrors.join('\n\n') }}</pre>
    </aside>

    <ul v-if="count" class="grid">
      <li v-for="(p, i) in projects" :key="p.slug" v-reveal="i * 60" class="card">
        <RouterLink :to="`/projects/${p.slug}`" class="card-link">
          <!-- ★ 没写 cover 就不渲染媒体框（见 @/projects 的 Project.image）。
               不写 v-if 会生成 `<img src="">`，浏览器会对当前页再发一次请求。 -->
          <span v-if="p.image" class="card-media">
            <img v-img-fallback :src="p.image" :alt="p.title" loading="lazy" />
          </span>

          <span class="card-body">
            <span class="card-title">{{ p.title }}</span>
            <span v-if="p.summary" class="card-summary u-small u-muted">{{ p.summary }}</span>

            <!-- 卡片上只有「图片 / 大标题 / 小标题 / 年份」四样（用户 m13371：
                 项目不要标签和分类）—— 别再加标签排、角色行、分类徽标。 -->
            <span class="card-year u-h4 u-muted">{{ p.year }}</span>
          </span>
        </RouterLink>
      </li>
    </ul>

    <p v-else class="empty u-muted">这里还没有项目。</p>

    <div class="u-section-space"></div>
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

/* ★ 用 em 而不是 ch 收窄导语：ch = 一个 "0" 的宽度（≈0.55 个汉字宽），
   34ch 只放得下约 19 个汉字 —— 中文句子的换行位置全靠猜。
   em 与字号同宽，24em ≈ 24 个汉字，换行点可预期。 */
.page-lead {
  max-width: 24em;
}

/* --- 卡片网格：24 列，每项跨 8 列（一行 3 个）---
   项目卡片是横图，比文章卡（3/4 竖图）宽，所以一行放 3 个而不是 4 个。 */
.grid {
  display: grid;
  grid-template-columns: repeat(var(--cols), minmax(0, 1fr));
  column-gap: var(--gutter);
  row-gap: 3rem;
}

.card {
  grid-column: span 8;
}

.card-link {
  display: block;
}

.card-media {
  display: block;
  aspect-ratio: 16 / 10;
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
  scale: 1.04;
}

.card-body {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding-top: 0.75rem;
}

.card-title {
  font-family: var(--font-mono);
  font-size: var(--fs-h3);
  line-height: 1.2;
}

.card-summary {
  max-width: 40ch;
}

/* 年份：卡片上唯一的元信息（角色 / 标签都去掉了，见模板里的注释） */
.card-year {
  padding-top: 0.25rem;
  opacity: 0.72;
}

.empty {
  padding-block: var(--section-small);
  text-align: center;
}

/* 写作错误提示框：只在 dev 出现，用站点既有的两色（不引入红色）。
   靠描边 + 半透明底与内容区分，而不是靠色相 —— 守住单色约束。
   （与 ArticleListView.vue 的同名规则保持一致。） */
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
    grid-column: span 12;
  }
}

@media (max-width: 800px) {
  .grid {
    grid-template-columns: repeat(6, minmax(0, 1fr));
    row-gap: 2.5rem;
  }

  .card {
    grid-column: span 6;
  }

  .card-title {
    font-size: var(--fs-main);
  }
}
</style>
