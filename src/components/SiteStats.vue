<script setup lang="ts">
/**
 * 站点统计卡（「关于」页侧栏，粘在头像卡下面）
 *
 * ── 数据从哪来 ──
 *   前几行由 `src/posts.ts` 的 `siteStats` 推导（文章数 / 标签数 / 总字数），
 *   所以**不需要后端**；`words` 是构建期逐篇算好写进 meta 的
 *   （见 `content-kit.ts` 的 `countWords`）—— 视图里不要自己去数正文，正文是懒加载的。
 *   最后一行「浏览量」**例外**：那是外部计数端点给的（见 `siteViews.ts`），
 *   没配端点时显示 `—`，且不会发任何请求。
 *
 * ── 形状 ──
 *   和上面的头像卡同一套语言：米色实底 + 品牌蓝字 + 同一档圆角。
 *   标题前那根竖条用 `currentColor`（= 卡片字色），所以日后换反色关系也跟着走。
 */
import { computed, onMounted, ref } from 'vue'

import { siteStats } from '@/posts'
import { lastKnownViews, readSiteViews } from '@/composables/siteViews'

/** 24×24 描边图标（stroke 走 currentColor，纯几何形状，不引依赖） */
const ICONS: Record<string, string> = {
  posts: 'M7 3.5h6.5L18.5 8.5V20.5H7z M13.5 3.5v5h5 M10 13h5 M10 16.5h5',
  tags: 'M4 4h7.3l8.7 8.7-7.3 7.3L4 11.3z M8.3 8.3h.01',
  words: 'M4 6.5h16 M4 10.5h16 M4 14.5h10 M4 18.5h6',
  views: 'M2.6 12c2.6-3.8 5.7-5.7 9.4-5.7S18.8 8.2 21.4 12c-2.6 3.8-5.7 5.7-9.4 5.7S5.2 15.8 2.6 12z M12 9.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5z',
}

/** 千分位（22,546） */
const num = (n: number): string => n.toLocaleString('en-US')

/** 浏览量：`null` = 还没有数（端点没配 / 没回来 / 出错）⇒ 显示 —，绝不显示 0 或 NaN
 *  ★ 初值先用上次成功读到的旧值，避免「先显示 — 、3 秒后才变数字」看起来像坏了。 */
const views = ref<number | null>(lastKnownViews())

onMounted(async () => {
  views.value = await readSiteViews()
})

const viewsText = computed(() => (views.value === null ? '—' : num(views.value)))

const rows = computed(() => [
  { key: 'posts', label: '文章', value: num(siteStats.posts) },
  { key: 'tags', label: '标签', value: num(siteStats.tags) },
  { key: 'words', label: '总字数', value: num(siteStats.words) },
  { key: 'views', label: '浏览量', value: viewsText.value },
])
</script>

<template>
  <section class="stats-card" aria-label="站点统计">
    <p class="stats-title">
      <span class="stats-bar" aria-hidden="true"></span>站点统计
    </p>

    <ul class="stats-list">
      <li v-for="row in rows" :key="row.key" class="stats-row">
        <svg class="stats-icon" viewBox="0 0 24 24" aria-hidden="true">
          <path :d="ICONS[row.key]" />
        </svg>
        <span class="stats-label">{{ row.label }}</span>
        <span class="stats-value">{{ row.value }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* ★ 米色实底 + 品牌蓝字：与上面的头像卡（.profile-card）**同一套反色关系**，
   圆角也共用 --panel-radius（在 .about 上定义；组件外用兜底值）。 */
.stats-card {
  background: var(--text);
  color: var(--brand);
  border-radius: var(--panel-radius, 18px);
  padding: var(--space-5);
}

.stats-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: var(--space-4);
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* 标题前那根竖条（参考图里就是这一根）：用 currentColor ⇒ 跟着卡片字色 */
.stats-bar {
  width: 4px;
  height: 1.15em;
  border-radius: 2px;
  background: currentColor;
}

.stats-list {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
}

.stats-row {
  display: grid;
  grid-template-columns: 1.05rem minmax(0, 1fr) auto;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.85rem;
}

.stats-icon {
  width: 1.05rem;
  height: 1.05rem;
  fill: none;
  stroke: currentColor;
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  opacity: 0.8;
}

.stats-label {
  /* 标签比数值淡一档：在米色底上用「品牌蓝 + 透明」混出来，不引新色 */
  color: color-mix(in srgb, var(--brand) 78%, transparent);
}

.stats-value {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-variant-numeric: tabular-nums;
  font-weight: 600;
  font-size: 0.82rem;
  white-space: nowrap;
}

/* ★ 窄屏（≤1279px，「关于」页侧栏摊成整幅宽）时四行竖排会被拉开到 700px 宽 ——
   标签和数值中间空一大片。改多列：卡片还是那张卡，只是行变格子。
   ★ 用 auto-fit 而不是写死列数：宽卡一行 4 格、窄卡自动降成 2 格，
     两边都不用再补一个断点（下面两档只负责"别挤成一团"）。 */
@media (max-width: 1279px) {
  .stats-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(7.5rem, 1fr));
    gap: 0.75rem 1.25rem;
  }
}

/* ★ 卡很窄时（整行 < 38rem ⇒ 每张卡约 < 19rem）内边距也收一收，
   否则 170px 宽的卡里文字只剩 ~130px 可放；容器是 AboutView 的 `.profile`。 */
@container (max-width: 38rem) {
  .stats-card {
    padding: var(--space-4);
  }

  .stats-title {
    font-size: 0.9rem;
    margin-bottom: var(--space-3);
  }

  .stats-list {
    gap: 0.6rem;
  }

  .stats-row {
    font-size: 0.8rem;
    gap: 0.4rem;
  }
}

/* ★★ 极窄（整行 < 23rem ⇒ 每张卡 < 11.5rem）：`auto-fit` 的 7.5rem 最小轨道
   （120px）会硬撑出容器 —— 320px 视口实测 `stats:140>134`、`statsList:120>94`。
   改成单列 `minmax(0, 1fr)` 让轨道跟着卡片走，行也整体缩一号：
   图标 0.95rem + 标签 0.75rem + 数值，320px 卡内可用 102px、内容约 91px ⇒ 放得下。
   （390px 整行 358px = 22.4rem 也落进这一档，跟着更宽松，无副作用。） */
@container (max-width: 23rem) {
  .stats-list {
    grid-template-columns: minmax(0, 1fr);
    gap: 0.55rem;
  }

  .stats-row {
    font-size: 0.75rem;
    gap: 0.3rem;
    grid-template-columns: 0.95rem minmax(0, 1fr) auto;
  }

  .stats-icon {
    width: 0.95rem;
    height: 0.95rem;
  }
}
</style>
