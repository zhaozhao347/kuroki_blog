<script setup lang="ts">
/**
 * 关于页（/about）—— 「特殊的一篇内容」
 *
 * ── 它为什么长得像文章详情页 ──
 *   用户 m10392：「about 也纳入文章体系，about 相当于是一个特殊的文章详情页，
 *   但是逻辑上照样复用 md 渲染引擎逻辑」。
 *   所以这一页**没有自己的正文**：标题、引言、正文、头像、卡片上的名字与链接
 *   全部来自 `content/pages/about.md`（frontmatter + Markdown 正文），
 *   这里只负责排布：
 *
 *     ┌───────────┐ ┌──────────────────────────────┐
 *     │ 头像卡      │ │ 关于 / 标题 / 引言             │
 *     │ （粘性）    │ ├──────────────────────────────┤
 *     │ 名字        │ │ Markdown 正文（.glass-panel）  │
 *     │ 签名        │ │                              │
 *     │ 三个图标按钮 │ │                              │
 *     └───────────┘ └──────────────────────────────┘
 *
 * ── 为什么用 `findPage` + `getPageBody` 而不是 import 一个 .vue ──
 *   元数据在构建期就写进了 `virtual:pages`（同步、立即有），正文是**懒加载**的
 *   （`virtual:pages-map`，进这一页才拉那一个 md）—— 与文章/项目详情页同一套。
 *
 * ── 卡片上的图标 ──
 *   路径取自 simple-icons v15（CC0），viewBox 都是 0 0 24 24。
 *   名字对不上时退回一个通用的「外链」图形（自己画的）—— 图标是装饰，
 *   不该因为写错一个名字就让构建或页面挂掉。
 */
import { computed, onMounted, ref } from 'vue'

import MarkdownRenderer from '@/components/MarkdownRenderer.vue'
import NextButton from '@/components/NextButton.vue'
import SiteStats from '@/components/SiteStats.vue'
import SteamCard from '@/components/SteamCard.vue'
import { useTypewriter } from '@/composables/typewriter'
import { findPage, getPageBody, pagesErrors } from '@/pages'

/** 这一页对应的 md（文件名即 slug） */
const PAGE_SLUG = 'about'

const page = computed(() => findPage(PAGE_SLUG))
/** 正文（懒加载） */
const body = ref('')
const loading = ref(true)

/** 卡片上的签名逐字打出来（文本在 setup 期就取定；节奏与停顿时机见 typewriter.ts） */
const { shown: taglineShown, done: taglineDone } = useTypewriter(() => page.value?.tagline ?? '')

onMounted(async () => {
  const md = await getPageBody(PAGE_SLUG)
  body.value = md ?? ''
  loading.value = false
})

/**
 * 图标表：名字 → SVG path。
 * ★ github / steam 来自 simple-icons v15（CC0-1.0）；`mail` 取自 Material 信封
 *   （simple-icons 那枚是描边风格，和这几枚实心图标放在一起不搭）；
 *   `link` 是自己画的外链兜底（simple-icons 里没有这么通用的一个）。
 * ★ 不做白名单校验：名字不认识就退回 `link`（写错的代价只是图标不对，不该让构建挂掉）。
 */
const ICONS: Record<string, string> = {
  github:
    'M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12',
  steam:
    'M11.979 0C5.678 0 .511 4.86.022 11.037l6.432 2.658c.545-.371 1.203-.59 1.912-.59.063 0 .125.004.188.006l2.861-4.142V8.91c0-2.495 2.028-4.524 4.524-4.524 2.494 0 4.524 2.031 4.524 4.527s-2.03 4.525-4.524 4.525h-.105l-4.076 2.911c0 .052.004.105.004.159 0 1.875-1.515 3.396-3.39 3.396-1.635 0-3.016-1.173-3.331-2.727L.436 15.27C1.862 20.307 6.486 24 11.979 24c6.627 0 11.999-5.373 11.999-12S18.605 0 11.979 0zM7.54 18.21l-1.473-.61c.262.543.714.999 1.314 1.25 1.297.539 2.793-.076 3.332-1.375.263-.63.264-1.319.005-1.949s-.75-1.121-1.377-1.383c-.624-.26-1.29-.249-1.878-.03l1.523.63c.956.4 1.409 1.5 1.009 2.455-.397.957-1.497 1.41-2.454 1.012H7.54zm11.415-9.303c0-1.662-1.353-3.015-3.015-3.015-1.665 0-3.015 1.353-3.015 3.015 0 1.665 1.35 3.015 3.015 3.015 1.663 0 3.015-1.35 3.015-3.015zm-5.273-.005c0-1.252 1.013-2.266 2.265-2.266 1.249 0 2.266 1.014 2.266 2.266 0 1.251-1.017 2.265-2.266 2.265-1.253 0-2.265-1.014-2.265-2.265z',
  mail: 'M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4-8 5-8-5V6l8 5 8-5v2z',
  link: 'M14 3h7v7h-2V6.414l-8.293 8.293-1.414-1.414L17.586 5H14V3zM5 5h5v2H7v10h10v-3h2v5H5V5z',
}

/** 取图标 path（不认识的名字 → 通用外链图标） */
function iconOf(name: string): string {
  return ICONS[name] ?? ICONS.link
}

/** 邮箱链接（mailto:）不该开新标签页 —— 浏览器会闪一个空白页出来 */
function isMailLink(href: string): boolean {
  return href.startsWith('mailto:')
}
</script>

<template>
  <article class="about u-container">
    <!-- dev 下 md 写错时提示（生产构建里恒为空）——与文章列表页同一套提示 -->
    <aside v-if="pagesErrors.length" class="write-warn" role="alert">
      <span class="u-h4">有 {{ pagesErrors.length }} 个页面文件没被读入</span>
      <pre class="write-warn-body">{{ pagesErrors.join('\n\n') }}</pre>
    </aside>

    <div v-if="page" class="about-grid">
      <!-- ── 左：粘性头像卡（侧栏，不占正文宽度） ───────────── -->
      <aside class="profile">
        <div class="profile-card">
          <div v-if="page.avatar" class="profile-avatar">
            <img v-img-fallback :src="page.avatar" :alt="page.name || page.title" />
          </div>

          <div class="profile-body">
            <p v-if="page.name" class="profile-name">{{ page.name }}</p>

            <!-- 签名：打字机。
                 ★★ 两层叠在同一个格子里：`.tw-ghost` 是不可见的**全文副本**（撑住宽高 +
                    给读屏读），`.tw-live` 是逐字变长的可见副本 ⇒ 打字过程不会让下面那行
                    图标上下跳。`aria-hidden` 只加在可见副本上，免得读屏把同一句话读两遍。 -->
            <p v-if="page.tagline" class="profile-tagline">
              <span class="tw-ghost">{{ page.tagline }}</span>
              <span class="tw-live" aria-hidden="true">{{ taglineShown }}<span
                  class="tw-caret"
                  :class="{ 'is-done': taglineDone }"
                ></span></span>
            </p>

            <ul v-if="page.links.length" class="profile-links">
              <li v-for="link in page.links" :key="link.href">
                <a
                  class="profile-link"
                  :href="link.href"
                  :title="link.label"
                  :aria-label="link.label"
                  :target="isMailLink(link.href) ? undefined : '_blank'"
                  :rel="isMailLink(link.href) ? undefined : 'noopener noreferrer'"
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path :d="iconOf(link.icon)" />
                  </svg>
                </a>
              </li>
            </ul>
          </div>
        </div>

        <!-- 站点统计：和头像卡一起待在同一个粘性侧栏里（见 .profile 的注释） -->
        <SiteStats />

      </aside>

      <!-- ── 右：Steam「最近在玩」（★★ 用户 m00455：从左栏挪来，与左栏对称） ──
           ★ 组件自己判断有没有配端点（没配就整个不渲染），所以这里不用 v-if。 -->
      <aside class="steam-side">
        <SteamCard />
      </aside>

      <!-- ── 中：和文章详情页同一张「纸」（列宽与位置都一致） ── -->
      <main class="about-main">
        <article class="panel glass-panel">
          <header class="about-head">
            <p v-if="page.eyebrow" class="eyebrow u-h4 u-muted">{{ page.eyebrow }}</p>
            <h1 class="title u-h1-cn" v-reveal>{{ page.title }}</h1>
            <p v-if="page.summary" class="lead u-main u-muted" v-reveal="120">
              {{ page.summary }}
            </p>
          </header>

          <hr class="rule" />

          <div class="body">
            <p v-if="loading" class="state u-muted">正在加载正文…</p>
            <MarkdownRenderer v-else :source="body" />
          </div>
        </article>
      </main>
    </div>

    <!-- 兜底：md 文件不在（改名 / 拼错）时不要整页空白 -->
    <div v-else class="missing">
      <p class="u-h4 u-muted">404</p>
      <h1 class="u-h2-cn">加载失败了😫</h1>
      <p class="u-main u-muted">
        `content/pages/{{ PAGE_SLUG }}.md` 没有被读到。跑一下 <code>npm run check:pages</code>。
      </p>
    </div>

    <div class="u-section-space"></div>
    <div class="page-next">
      <NextButton />
    </div>
  </article>
</template>

<style scoped>
/* ★ 与文章/项目详情页一样：面板宽度只在页面级定义（这三个变量不是全局的） */
.about {
  --reading-w: 62ch;
  --panel-pad: clamp(1.25rem, 4vw, 3.25rem);
  --panel-radius: clamp(16px, 1.6vw, 22px);

  padding-top: var(--page-top);
}

/* ── 三栏：正文居中（与文章详情页同一列宽、同一位置）+ 头像卡当左侧栏 ── */
.about-grid {
  display: grid;
  /* ★ 中列宽度 = 面板宽度（--reading-w + 两侧内边距），两侧 1fr 各自算 ——
     正文因此和文章／项目详情页**逐像素同位**（1440 实测面板 x=344）。
     头像卡不占正文的宽度，它待在自己的侧栏里。 */
  grid-template-columns:
    minmax(0, 1fr)
    calc(var(--reading-w) + var(--panel-pad) * 2)
    minmax(0, 1fr);
  gap: var(--space-6);
  align-items: start;
  width: 100%;
}

/* ── 侧栏（头像卡 + 站点统计卡） ────────────────────── */
.profile {
  grid-column: 1;
  /* ★★ `grid-row: 1` 不能省（2026-10-10 实测踩到）：自动放置的**游标**在
     「有确定列、没有确定行」的 item 之间是单调的 —— 先放 col 1、再放 col 3 之后，
     游标列号变成 3，接着那个 col 2 的 `.about-main` 因为「列号比游标小」会被**顶到下一行**
     （实测面板从 y=120 掉到 y=735，正文整块沉下去）。
     三栏显式写 row 1 就与放置顺序无关了；窄屏那档必须各自改回 `grid-row: auto`
     （单列网格里三个 item 都钉在 row 1 会直接叠在一起）。 */
  grid-row: 1;
  /* 贴着中列那一侧（与正文之间留 gap），而不是跟容器左边对齐 */
  justify-self: end;
  width: 15rem;
  /* ★ 侧栏轨道比 15rem 窄时（1280~1345 那一带：两侧各只有 ~208px）让卡片跟着缩，
     否则它会从列里溢出去、左边缘被视口切掉（实测 x = −16）。 */
  max-width: 100%;
  /* ★ 两张卡是**同一个粘性单元**（竖着摞在侧栏里）——
     sticky 挂在这一层，卡片各自只负责自己的样子。
     若给两张卡分别写 sticky，它们会同时黏在同一个 top 上、直接叠在一起。 */
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  /* ★ 粘性：滚正文时整套侧栏跟着停在导航下面。
     它是 grid item，粘性包含块是**整行高度**（= 面板高度），所以有充足的滚程；
     `align-items: start` 又让它保持自身高度、不会拉成一整条米色长条。 */
  position: sticky;
  top: calc(var(--nav-h) + var(--space-4));
}

/* ── 右侧栏（Steam「最近在玩」）★★ 用户 m00455：从左栏挪到右栏，与左栏对称。
   完全镜像 `.profile`：左栏 `justify-self: end` 贴中列，这里 `start` 也贴中列；
   宽度 / 卡间距 / 粘性 top 全部同值 ⇒ 两栏关于中列对称。
   ★ 只有一个 grid item，所以 sticky 直接挂在这一层（同 .profile 的理由）。 */
.steam-side {
  grid-column: 3;
  grid-row: 1; /* ← 见 .profile 的注释（自动放置游标那个坑） */
  justify-self: start;
  width: 15rem;
  max-width: 100%;
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  position: sticky;
  top: calc(var(--nav-h) + var(--space-4));
}

.profile-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding: var(--space-5);
  /* ★ 米色实心卡：和音乐栏外壳同一套配色（--text 底 + --brand 字），
     在蓝底页面上像一张「贴上去的纸」，也是参考图里那张白卡的样子。 */
  background-color: var(--text);
  color: var(--brand);
  border-radius: var(--panel-radius);
  /* ★ 卡片本身**没有** hover 效果（2026-10-07 用户要求）：
     不要抬升、不要投影。整卡不动，只有头像自己略微放大。 */
}

/* hover 只在真有指针的设备上做（触屏上会「粘住」） */
@media (hover: hover) {
  /* ★ 放大的是**头像容器本身**（用户 2026-10-07 澄清：「不是让你把图片放大，
     是让你把头像容器的 div 框放大（不是外面的白底 div）」）：
     指针压到头像上 → `.profile-avatar` 这个框（连里面的图）整体放大；
     **不要**动 `.profile-card`（外面的米色卡一动不动），也不要把缩放写在 img 上。
     ★ transform 不参与布局 ⇒ 卡片不会跟着重排；多出来的那圈落在 `.profile-card` 的
     padding（`--space-5`）里，不会挤出卡外。 */
  .profile-avatar:hover {
    scale: 1.05;
  }
}

.profile-avatar {
  overflow: hidden;
  border-radius: calc(var(--panel-radius) - 6px);
  /* 头像是 420×420 的方图；这里钉死 1:1，换任意比例的图也不会把卡片撑歪 */
  aspect-ratio: 1 / 1;
  /* ★ transition 挂在**容器**上（放大的是它本人；原来错挂在 `.profile-avatar img` 上）。
     ★ 容器带 overflow: hidden + 圆角，所以放大时是「相框变大连图一起」，
       不是「框不动、把图裁得更紧」—— 这两者肉眼差别很明显。
     ★★ 用 `scale` 长写而不是 `transform: scale()`：与列表卡的图片缩放（`ProjectListView.vue`
       的 `.card-media img { transition: scale 0.7s var(--ease) }`）同一套写法，且不会与
       将来加到同一个元素上的 transform 互相覆盖。
     ★★ `will-change: transform` + 时长收到 0.55s（2026-10-07 用户反馈「动画不丝滑」）：
       这个容器带 `overflow: hidden` + 圆角 + 一张 `object-fit: cover` 的位图，
       旁边又紧挨着 `backdrop-filter: blur(20px)` 的 `.panel` —— 不提升成独立图层的话，
       每帧都要重新光栅化「圆角裁剪 + 位图」，还可能把旁边那块玻璃的背景重算一遍（掉帧）。
       提升后由合成器缩放这一层的纹理（动画期间略有软化，结束即回清晰），不再每帧重画。 */
  transition: scale 0.55s var(--ease);
  will-change: transform;
}

.profile-avatar img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.profile-body {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}

.profile-name {
  font-size: var(--fs-h3);
  font-weight: 700;
  line-height: 1.2;
  /* ★ 卡片里的三样（昵称 / 格言 / 链接图标）都居中（用户 m13253） */
  text-align: center;
}

.profile-tagline {
  font-size: var(--fs-small);
  line-height: 1.5;
  opacity: 0.72;
  text-align: center;
  /* ★★ 打字机要「底不动」：两层的容器是一个单格网格，
     不可见的全文副本（.tw-ghost）与逐字变长的可见副本（.tw-live）叠在同一格里
     ⇒ 段落高度恒等于**全文**的高度，光标与图标行都不会跟着跳。
     （居中显示还有个好处：文字从中间往两边长，起点不会左右窜。） */
  display: grid;
}

.profile-tagline > * {
  grid-area: 1 / 1;
  min-width: 0;
}

/* 全文副本：只用来撑排版 + 给读屏读，视觉上透明（不是 display:none / visibility:hidden，
   那样读屏也读不到） */
.tw-ghost {
  color: transparent;
}

.tw-live {
  white-space: pre-wrap;
}

/* 打字机光标：一根 currentColor 的细竖条，紧跟最后一个字，打字期间闪。
   ★ 必须**留在行内流里**（挂在 .tw-live 里面）——挂成网格子项就只能钉在格子起点，
     不会跟着文字走。它始终存在（打完只是透明），所以居中位置不会因为闪烁而抖。 */
.tw-caret {
  display: inline-block;
  width: 1px;
  height: 1em;
  margin-left: 2px;
  vertical-align: -0.15em;
  background: currentColor;
  animation: tw-blink 1s steps(1, end) infinite;
}

/* ★ 打完停一拍就淡出 —— 不一直闪（签名是安静的，常驻光标会抢注意力）。
   想让光标一直闪就删掉这一条。 */
.tw-caret.is-done {
  animation: none;
  opacity: 0;
  transition: opacity 0.4s 0.9s;
}

@keyframes tw-blink {
  0%,
  50% {
    opacity: 1;
  }
  50.01%,
  100% {
    opacity: 0;
  }
}

/* 三个描边方形图标按钮（参考图三底部那排） */
.profile-links {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 0.6rem;
  padding: 0;
  list-style: none;
}

.profile-link {
  display: grid;
  width: 2.4rem;
  height: 2.4rem;
  place-items: center;
  color: var(--brand);
  background-color: transparent;
  border: 1px solid color-mix(in srgb, var(--brand) 42%, transparent);
  border-radius: 9px;
  transition:
    background-color 0.35s var(--ease),
    color 0.35s var(--ease),
    transform 0.35s var(--ease),
    border-color 0.35s var(--ease);
}

.profile-link svg {
  width: 1.1rem;
  height: 1.1rem;
  fill: currentColor;
}

.profile-link:hover,
.profile-link:focus-visible {
  color: var(--text);
  background-color: var(--brand);
  border-color: var(--brand);
  transform: translateY(-3px);
}

/* ── 右：面板（结构与文章详情页一致） ─────────────────── */
.about-main {
  grid-column: 2;
  grid-row: 1; /* ← 见 .profile 的注释（自动放置游标那个坑） */
  min-width: 0;
}

.panel {
  width: 100%;
  max-width: calc(var(--reading-w) + var(--panel-pad) * 2);
  margin-inline: auto;
}

.about-head {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  padding-bottom: var(--space-6);
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
  /* 正文要能选中复制 */
  user-select: text;
}

.state {
  margin: 0;
}

/* ── 兜底 ──────────────────────────────────────────── */
.missing {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 1rem;
}

/* ── 窄屏：侧栏放不下（正文栏本身就有 744，两侧各留不下 15rem + 间距），
      于是收成单栏 —— 卡片从「竖着的一栏」变成「横着的一条」，
      并且和面板同宽同位置（居中），正文仍然居中 ───────────── */
@media (max-width: 1279px) {
  .about-grid {
    grid-template-columns: minmax(0, 1fr);
  }

  /* ★ 必须一起把中列的位置改回第 1 列：单列网格里写 `grid-column: 2`
     会凭空造出一条隐式轨道（宽度 = 面板宽 743），把第 1 列挤成几十像素
     —— 卡片会被压成细长条、两个格子还会重叠。 */
  .about-main {
    grid-column: 1;
    grid-row: auto; /* ← 单列时不能再钉 row 1（会叠在一起） */
  }

  /* ★ 单栏时 sticky 没意义（卡片本来就在最上面），还会在滚动中挡住正文 */
  .profile {
    grid-column: 1;
    grid-row: auto;
    justify-self: stretch;
    position: static;
    width: 100%;
    max-width: calc(var(--reading-w) + var(--panel-pad) * 2);
    margin-inline: auto;
    /* ★★ 用户 m14298：窄屏（单栏）下「头像卡 + 站点统计卡」要**并排一行**，
       不再竖着摞 —— 单栏时侧栏本来就占满整幅宽，摞起来白占一屏。
       两张卡各占一半（下面的 `flex: 1 1 0`），卡**内部**怎么排由
       `@container` 按每张卡自己的宽度决定（见文件末尾那一段）。 */
    flex-direction: row;
    align-items: stretch;
    /* ★ 2026-10-09 曾靠「允许换行 + 第三张卡 flex-basis: 100%」让 Steam 卡独占第二行；
       ★★ 用户 m00455 把 Steam 卡挪到右栏（`.steam-side`）后这里只剩两张卡，
       wrap 仅作保底（窄到两张卡都摆不下时各自掉一行）。 */
    flex-wrap: wrap;
    /* 卡内布局要用容器查询 => 这里建立容器（量的是这一行的宽度） */
    container-type: inline-size;
  }

  .profile > * {
    flex: 1 1 0;
    min-width: 0;
  }

  /* ★★ 窄屏（单栏）下右栏的 Steam 卡回到「一整行」：和面板同宽同位置、居中，
       DOM 顺序让它在「头像卡那一排」下面、正文上面（与挪动前的位置一致）。
       ★ 必须一起把 grid-column 改回第 1 列：单列网格里留着 `grid-column: 3`
       会凭空造出隐式轨道（同上面 .about-main 的坑）。
       ★ container-type 不能省：SteamCard 内部的 @container 规则（38rem / 23rem）
       量的是它自己那一行的宽度。 */
  .steam-side {
    grid-column: 1;
    grid-row: auto;
    justify-self: stretch;
    position: static;
    width: 100%;
    max-width: calc(var(--reading-w) + var(--panel-pad) * 2);
    margin-inline: auto;
    container-type: inline-size;
  }

  .profile-card {
    flex-direction: row;
    align-items: center;
    gap: var(--space-4);
  }

  .profile-avatar {
    flex: 0 0 5.5rem;
    width: 5.5rem;
  }

  .profile-body {
    flex: 1;
    min-width: 0;
  }
}

/* ★★ 并排一行 + 窄视口时，每张卡自己会变得很窄——
   横排（头像在左、文字在右）在卡宽 ~17rem 以下时，三个图标（3 × 2.4rem + 间隙）
   会溢出文字列 ⇒ 换行折成两排。所以卡内转竖排：头像居中在上、昵称 / 格言 / 图标在下面。
   ★ 阈值量的是**整行的宽度**（38rem ⇒ 每张卡约 19rem、文字列约 10rem）；
   ★ 桌面端 `.profile` 没有 container-type，这条规则不会命中（不影响 >1279px）。
   ★ 实测：620px 视口（整行 588px = 36.75rem）以前留在横排 ⇒ 图标折两行；改 38rem 后转竖排。 */
@container (max-width: 38rem) {
  .profile-card {
    flex-direction: column;
    align-items: stretch;
    gap: var(--space-4);
  }

  .profile-avatar {
    flex: 0 0 auto;
    width: 5.5rem;
    margin-inline: auto;
  }

  .profile-body {
    flex: 0 1 auto;
  }
}

@media (max-width: 420px) {
  .profile-card {
    gap: var(--space-4);
    padding: var(--space-4);
  }

  .profile-avatar {
    flex-basis: 4.25rem;
    width: 4.25rem;
  }

  /* ★ 390px 时文字列 129px，三个 2.4rem 按钮按 0.5rem 间隙要 131.2px ⇒ 差 2px 折行；
     0.35rem 间隙 ⇒ 126.4px，一行放得下。 */
  .profile-links {
    gap: 0.35rem;
  }

  .title {
    max-width: none;
  }
}
</style>
