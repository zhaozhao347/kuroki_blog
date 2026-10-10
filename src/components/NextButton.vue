<script setup lang="ts">
/**
 * NextButton —— 右下角「N ext」下一屏按钮
 *
 * 与首页 hero 右下角那个是**同一套排版**：大写首字母 `N` + 小写后缀 `ext`，
 * 共享基线（Anton 字体 + `line-height: 0.85`，推导见 HomeView 的 `.hero-log`）。
 *
 * ── 为什么抽成组件 ──
 * 之前这套排版只写在 HomeView 里，现在 about / articles / archive 都要用，
 * 复制几份必然会漂移（改了一处忘了另一处）。
 *
 * ── 尺寸：用 --next-cap 控制 ──
 * 组件**不声明** `--next-cap`，而是在用到的地方写 `var(--next-cap, <兜底>)`。
 * 这样父级可以安全地覆盖它：
 *
 *   <NextButton class="hero-next" />   <!-- HomeView 里设 --next-cap -->
 *
 * ★ 如果组件自己也声明 `--next-cap`，就会与父级的声明在**同一个元素**上
 *   撞车，胜负取决于选择器优先级与源码顺序 —— 非常脆。不声明才是对的。
 *
 * ── 行为：翻到「下一页」（不再是「滚动一屏」）──
 * 用户要的是把站点当成一本册子来翻，顺序与导航一致：
 *     Home → Articles → Archive → About →（回到 Home）
 *
 * ★ 必须用 vue-router 的 push，不能改 location：
 *   那会整页刷新（丢掉 Loader 的会话标记、Lenis 状态、路由过渡动画）。
 * ★ 页面切换后回到顶部由 router 的 scrollBehavior 负责，
 *   这里不要自己调 scrollTo（会与 Lenis 打架）。
 * ★ 首页的 NEXT 由「往下滚一屏」改成了「翻到下一章」——
 *   页脚仍然可以用普通滚动到达，不算丢功能。
 */
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'

/** 翻页循环顺序 = 站点的主线阅读顺序，与导航一致。
 *  ★ 数据驱动而不是写死 if-else：加页面只改这一处。 */
const FLOW = ['home', 'article-list', 'archive', 'about'] as const

const route = useRoute()
const router = useRouter()

/** 下一个页面。当前页不在 FLOW 里（如文章详情、404）→ 从第一个开始 */
const nextRoute = computed(() => {
  const i = FLOW.indexOf(route.name as (typeof FLOW)[number])
  return FLOW[(i + 1) % FLOW.length]
})

function go() {
  router.push({ name: nextRoute.value })
}
</script>

<template>
  <!-- ★★ 不加 `v-magnetic`（2026-09-22 用户要求「hover 不要有任何位移」）。
       那个指令会让按钮朝鼠标方向偏移最多 14px —— 在「翻页」这种
       点击型控件上会让人对准位置变得不稳（鼠标一动按钮就跟着跑）。
       hover 反馈只保留文字变灰（见下方 .next:hover）。 -->
  <button
    class="next"
    type="button"
    :aria-label="`下一页`"
    @click="go"
  >
    <span class="next-ch" data-letter="N">N</span><span class="next-ch" data-letter="e">e</span><span class="next-ch" data-letter="x">x</span><span class="next-ch" data-letter="t">t</span>
  </button>
</template>

<style scoped>
/*
 * 排版核心（与 hero 一致）：
 *   大字母 N 的 cap height = --next-cap
 *   Anton 的 cap height ≈ 0.86 × 字号  →  字号 = cap / 0.86
 *   小写 ext = 0.258em
 *     （Blog 组里 log 字号 = 0.30 × B 的 cap；这里父级字号 = cap / 0.86，
 *      故 0.30 × 0.86 = 0.258em，两组比例严格一致）
 *
 * 基线对齐：line-height 取 0.85 时 box 底恰好落在基线上，
 * 再用 align-items: baseline 让 N 与 ext 共用同一条基线。
 */
.next {
  --next-cap-fallback: clamp(2.25rem, min(8vw, 10vh), 4.5rem);

  display: flex;
  align-items: baseline;
  font-family: var(--font-display);
  font-size: calc(var(--next-cap, var(--next-cap-fallback)) / 0.86);
  /* 数值型行高，子元素按各自字号重算，保证两者基线位置一致 */
  line-height: 0.85;
  letter-spacing: 0;
  color: var(--text);
  flex-shrink: 0;
  padding: 0;
  background: none;
  border: 0;
  cursor: pointer;
  /* 颜色过渡 —— 与导航链接同款时长，全站手感一致 */
  transition: color 0.3s var(--ease);
}

/* 每个字母一个 `<span>`。
 *
 * ★★ 它**必须是 `inline-block`**（+ `position: relative`）：逐字母飞入的位移就写在这些
 *    span 上，而 `display: inline` 的元素**不响应 transform** —— 动画会
 *    playState=running、currentTime 正常推进，但盒子一个像素都不动
 *    （实测 Edge 154：inline 的 computed transform 是 matrix(…,-39.99)，
 *     getBoundingClientRect 前后完全一致）。
 *
 * ★ `line-height: 0.85` 与父级一致，四个字盒的尺寸与基线因此与改造前逐项相同。
 *
 * ★ 「N 与 ext 同基线」仍由父级 `display: flex; align-items: baseline` 负责：
 *    flex 项的基线取值规则是「盒子内有行盒则取那行文本的基线，否则取 margin box 底边」，
 *    inline-block 的 span 内部有行盒，所以还是取文本基线 —— 正是我们要的。
 *
 * ❌ 不要给它们**另包一层** `inline-block` 字盒：那才是会让行盒被重算、
 *    基线整体偏移的做法（0.00px → 32px），历史上踩过。 */
.next-ch {
  display: inline-block;
  position: relative;
  line-height: 0.85;
}

/* ext 的三个字母保持原有比例（N 保持父级字号不动） */
.next-ch:not([data-letter='N']) {
  font-size: 0.258em;
}
/* ★★ 上面这个 0.258em 是**设计**，不是冗余：
 *    它 = 0.30 × 0.86，即与 Blog 组「log 字号 = 0.30 × B 高度」严格同比例
 *    （见上方排版核心注释）。一个字都不能删 —— 删了 ext 会从 13px 跳回满字号 64px。 */

/* hover：文字变灰/变暗。
 *
 * ★ 用「往 --muted（米色 50% 透明）退让」而不是降 opacity：
 *   降 opacity 会让米色字透出背后的渐变蓝、显得发浑；
 *   走 --muted 才是真的“变灰”，在蓝底上看着干净。
 *   （这是用户明确喜欢的旧效果 —— 见 §历史：曾写成 opacity 0.65。） */
.next:hover {
  color: var(--muted);
}
</style>
