import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'
import { nextTick } from 'vue'
import { getLenis } from '@/composables/motion'
import { coverRoute, revealRoute } from '@/composables/routeTransition'

const routes: RouteRecordRaw[] = [
  {
    path: '/',
    component: () => import('@/layouts/DefaultLayout.vue'),
    children: [
      {
        path: '',
        name: 'home',
        component: () => import('@/views/HomeView.vue'),
        meta: { title: '首页' },
      },
      {
        path: 'articles',
        name: 'article-list',
        component: () => import('@/views/ArticleListView.vue'),
        meta: { title: '文章' },
      },
      {
        path: 'articles/:id',
        name: 'article-detail',
        component: () => import('@/views/ArticleDetailView.vue'),
        props: true,
        meta: { title: '文章详情' },
      },
      {
        path: 'archive',
        name: 'archive',
        component: () => import('@/views/ArchiveView.vue'),
        meta: { title: '归档' },
      },
      {
        path: 'about',
        name: 'about',
        component: () => import('@/views/AboutView.vue'),
        meta: { title: '关于' },
      },
      /* 项目（Projects）：作品/项目清单。
       * ★ 数据在 `content/projects/*.md`（构建期扫描 → `virtual:projects`，
       *   门面层 `src/projects.ts`），页面只负责排版。见 AGENTS.md §5.12。
       * ★ 路由级懒加载：这个页面的 JS 只在进页面时才下，首屏预算一动不动。 */
      {
        path: 'projects',
        name: 'projects',
        component: () => import('@/views/ProjectListView.vue'),
        meta: { title: '项目' },
      },
      /* 项目详情：和文章详情同一套（懒加载正文 + 上下篇）。
       * ★ props: true 把 slug 作为 prop 传进去（与 articles/:id 一致）。 */
      {
        path: 'projects/:id',
        name: 'project-detail',
        component: () => import('@/views/ProjectDetailView.vue'),
        props: true,
        meta: { title: '项目详情' },
      },
    ],
  },
  {
    path: '/:pathMatch(.*)*',
    name: 'not-found',
    component: () => import('@/views/NotFoundView.vue'),
    meta: { title: '页面不存在' },
  },
]

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior(to, from, savedPosition) {
    /* ★ 有 Lenis 时必须走它的 scrollTo（immediate 模式）。
     *   否则 Lenis 内部的滚动状态还停在旧位置，下一帧会把页面又拽回去。
     *   Lenis 是通过 initSmoothScroll() 懒加载的，这里动态取，
     *   避免无谓地把 lenis 打进首屏包。
     *
     * ★★ 也要等「下一帧」再滚，不能在 scrollBehavior 里同步滚：
     *   scrollBehavior 的调用时机是**路由刚解析完、DOM 还没更新**，
     *   此时旧页面仍在屏幕上。同步复位会让用户看到
     *   「内容还在、视口却突然回顶」的抽走感（实测报过）。
     *
     *   推到 rAF 后：新视图已经挂上（高度也变了），
     *   复位发生在「新内容出现」的同一帧，观感是翻页而不是抽走。
     */
    const top = savedPosition?.top ?? 0
    const lenis = getLenis()

    const apply = () => {
      if (lenis) lenis.scrollTo(top, { immediate: true })
      else window.scrollTo({ top, behavior: 'auto' })
    }

    // 同页内（例如只换 query）不需要复位，避免无谓跳动
    if (to.path === from.path && !savedPosition) return false

    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        apply()
        resolve()
      })
    })
  },
})

/* ==================== 液态玻璃转场（用户 m06921） ====================
 *
 * 编舞（时间轴）：
 *   beforeEach 里 `await cover()`  →  玻璃从导航下沿长到视口底部（~0.6s）
 *   守卫放行，路由在新旧页面之间切换（此时整块内容区被玻璃盖着）
 *   afterEach 里 `await nextTick()` 再 `await reveal()`  →  玻璃缩回 bar（~0.72s）
 *
 * ★★ 为什么 beforeEach 要**故意 await**：
 *   不 await 的话，导航会立刻完成、新页面在玻璃还没铺满时就换掉了 ——
 *   用户会看到"半遮半掩"的一瞬。await 期间旧页面一动不动，
 *   等玻璃落到底，切换才发生，全程看不见接缝。
 *
 * ★ afterEach 里为什么要 nextTick：
 *   afterEach 触发时路由状态已更新，但 Vue 的 DOM 还没重渲染（微任务里刷）。
 *   立刻 reveal 会把**旧内容**先亮出来一帧，然后再跳成新内容。
 *   等一个 nextTick，DOM 已经是新页面了，缩回去露出的就是新内容。
 *
 * ★ 首屏不走遮罩：
 *   首次导航由 AppLoader 负责（它自己会淡出交接），再叠一层玻璃就重复了。
 *   用模块级 flag 判断，比用 `from === START_LOCATION` 更直白、也不怕 base 名。
 */
let firstNavigation = true

router.beforeEach(async (to, from) => {
  if (firstNavigation) {
    firstNavigation = false
    return true
  }
  // 同 path（只换 query / hash）：不值得铺一次玻璃，直接切
  if (to.path === from.path) return true

  /* ★ 遮罩自己出错绝不能拦住导航 —— 所以这里吞掉异常。
     真的失败时 cover 会立刻 resolve，退化成"没有转场"。 */
  try {
    await coverRoute()
  } catch {
    /* ignore */
  }
  return true
})

router.afterEach(async (to, from) => {
  if (to.path === from.path) return
  try {
    await nextTick()
    await revealRoute()
  } catch {
    /* ignore */
  }
})

/* 懒加载 chunk 拉取失败 / 守卫抛错时，导航会中断 ——
   此时玻璃可能已经铺满，必须把它收回去，否则页面被永久盖住。 */
router.onError(() => {
  void revealRoute()
})

router.afterEach((to) => {
  const title = to.meta.title as string | undefined
  document.title = title ? `${title} · 我的博客` : '我的博客'
})

export default router
