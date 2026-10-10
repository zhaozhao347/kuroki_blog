<script setup lang="ts">
/**
 * App 根组件
 *
 * 职责：
 *   1) 初始化 / 销毁 Lenis 平滑滚动
 *   2) 渲染首屏 Loader（自己用 v-if 控制显隐）
 *   3) 直接渲染 RouterView —— **不做页面过渡**
 *   4) 渲染液态玻璃转场遮罩（LiquidTransition）
 *
 * ★★ 为什么过渡不在这里（重要）：
 *   这里渲染的是顶层路由组件 = DefaultLayout（含 fixed 导航 + 页脚）。
 *   若在此加 `<Transition>`，过渡的 transform 会加在 DefaultLayout 上，
 *   而 **.nav 是 position: fixed** —— 祖先一旦有 transform，
 *   fixed 的包含块就从视口变成那个祖先，fixed 直接失效：
 *   导航会跟着过渡位移（实测 0 → -10.9 → +16 来回跑，看着像"乱跳"），
 *   而且 mode="out-in" 会让导航和页脚一起淡出 → **整屏白**。
 *
 *   所以过渡下沉到了 DefaultLayout 的 <main> 内部（只动内容区），
 *   导航与页脚常驻。见 layouts/DefaultLayout.vue。
 *
 * ★ 转场遮罩（LiquidTransition）是**独立的一层 fixed 元素**，不是 Transition：
 *   它不包裹任何东西，所以不存在上面那个"祖先 transform"的坑；
 *   放在这里（App 根层级）而不是 DefaultLayout 里，是为了 404 页也有转场
 *   （404 是顶层路由，不套 DefaultLayout）。
 *
 * ★ 滚动位置复位交给 router 的 scrollBehavior（见 router/index.ts）。
 */
import { onBeforeUnmount, onMounted } from 'vue'
import { RouterView } from 'vue-router'
import AppLoader from '@/components/AppLoader.vue'
import CursorDot from '@/components/CursorDot.vue'
import LiquidTransition from '@/components/LiquidTransition.vue'
import { destroySmoothScroll, initSmoothScroll } from '@/composables/motion'
import { countPageView, hasViewsEndpoint } from '@/composables/siteViews'

onMounted(() => {
  initSmoothScroll()

  // 站点浏览量：一次**整页加载**算一次（路由切换不重复计，见 siteViews.ts）。
  // ★ 没配 VITE_VIEWS_ENDPOINT 时一次请求都不发；失败也静默 —— 计数不该影响任何事。
  if (hasViewsEndpoint) void countPageView()
})

onBeforeUnmount(() => {
  destroySmoothScroll()
})
</script>

<template>
  <!-- 首屏载入动画：播完自己隐藏（内部用 v-if 控制遮罩） -->
  <AppLoader />

  <!-- 跟随光标的半透明白色圆点。
       ★ 放这里（而不是 DefaultLayout）是为了在 404 页也生效 ——
         404 是顶层路由，不套 DefaultLayout。 -->
  <CursorDot />

  <!-- 液态玻璃路由转场遮罩（z 55，在 .nav 的 60 之下：玻璃从 bar 下沿长出来）。
       ★ 自己注册到 composables/routeTransition.ts，由 router 守卫驱动 ——
         这里只负责把它挂上，不传任何 props。 -->
  <LiquidTransition />

  <RouterView />
</template>
