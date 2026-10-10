/**
 * 标签筛选的「URL ↔ 状态」同步
 *
 * 列表页（`/articles`）与归档页（`/archive`）共用 —— 两处筛选语义必须完全一样，
 * 各写一遍迟早会出现「列表页是 AND、归档页是 OR」这种不一致。
 *
 * ── 为什么把筛选状态放进 URL ──
 *   ① 详情页点一个标签 → 跳过来能直接还原筛选（`?tags=CSS,设计`）
 *   ② 刷新、分享链接、浏览器前进后退都不丢
 *
 * ── 为什么用 replace 而不是 push ──
 *   筛选是「同一屏的视图状态」，不该把历史记录塞满
 *   （否则返回键要按十几次才回得去上一页）。
 *
 * ★ 只改**当前路由**的 query，所以列表页与归档页都能直接用同一个组合式函数。
 * ★ 纯 query 变化不触发路由转场（`router/index.ts` 里按 to.path === from.path 短路），
 *   所以切标签不会闪一下液态玻璃遮罩。
 */
import { ref, watch, type Ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'

interface TagFilter {
  /** 选中的标签（多选） */
  activeTags: Ref<string[]>
  /** 点一下：有就去掉，没有就加上 */
  toggleTag: (tag: string) => void
  /** 清空所有标签筛选 */
  clearTags: () => void
}

/** 读 URL 里的 tags（逗号分隔，容错空值 / 数组形式） */
function readTags(raw: unknown): string[] {
  const s = Array.isArray(raw) ? raw.join(',') : (raw ?? '')
  return String(s)
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
}

export function useTagFilter(): TagFilter {
  const route = useRoute()
  const router = useRouter()
  const activeTags = ref<string[]>(readTags(route.query.tags))

  /* ★ 必须 watch：列表页/归档页的组件实例会被复用。
   *   从详情页点标签跳回 `/articles` 时**只有 query 变了**、组件不重建，
   *   不监听就会出现「点了标签但页面没反应」。 */
  watch(
    () => route.query.tags,
    () => {
      activeTags.value = readTags(route.query.tags)
    },
  )

  function sync(tags: string[]) {
    const q = { ...route.query }
    if (tags.length) q.tags = tags.join(',')
    else delete q.tags
    void router.replace({ query: q })
  }

  function toggleTag(tag: string) {
    const next = activeTags.value.includes(tag)
      ? activeTags.value.filter((t) => t !== tag)
      : [...activeTags.value, tag]
    activeTags.value = next
    sync(next)
  }

  function clearTags() {
    activeTags.value = []
    sync([])
  }

  return { activeTags, toggleTag, clearTags }
}
