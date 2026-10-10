/**
 * 站点浏览量端点（`/views`）—— 三个端点里唯一需要**存储**的那个。
 *
 * ── 契约（前端 `src/composables/siteViews.ts` 按这个写死，改这儿要两边一起改）──
 *   POST /views  → 计一次浏览，回 `{ "views": 123 }`
 *   GET  /views  → 只读总数，  回 `{ "views": 123 }`
 *   口径：一次**整页加载**算一次（`App.vue` 挂载时打一枪），站内路由切换不重复计。
 *
 * ── 存哪 ──
 *   Cloudflare **KV**（`wrangler.toml` 里的 `[[kv_namespaces]]`，绑定名 `VIEWS`），
 *   一个 key 存一个十进制字符串。免费额度 1000 写 / 10 万读每天，个人站绰绰有余。
 *
 * ── 已知取舍（是取舍，不是 bug）──
 *   ① KV 是**最终一致**的：写入后全球可见要几十秒；两个请求几乎同时进来时，
 *      「读-改-写」会丢掉其中一次。浏览量本来就是量级指标，不值得为它上 Durable Object。
 *   ② 不做去重（刷新即 +1）。要防灌水得按 `ip+ua` 哈希存 24h TTL，
 *      代价是每次浏览多一次 KV 写（额度掉一个数量级），默认不划算。
 */
import { json, preflight } from './http.js'

/** KV 里存总数的 key —— 故意是单数，以后要分日统计再加 `day:2026-10-09` 这类 key */
const KEY = 'total'

export async function handleViewsRequest(request, env = {}) {
  if (request.method === 'OPTIONS') return preflight()

  const kv = env.VIEWS
  if (!kv || typeof kv.get !== 'function') {
    /* 忘了建 namespace / 忘了绑：明说缺什么，别回一个 0 把前端骗过去 */
    return json(
      { error: 'kv-missing', hint: 'wrangler.toml 需要绑定名为 VIEWS 的 KV namespace' },
      { status: 503 },
    )
  }

  const method = (request.method || 'GET').toUpperCase()
  if (method !== 'GET' && method !== 'POST') {
    return json({ error: 'method-not-allowed' }, { status: 405 })
  }

  const raw = await kv.get(KEY)
  const parsed = Number.parseInt(raw ?? '', 10)
  const views = Number.isFinite(parsed) && parsed > 0 ? parsed : 0

  /* 计数和读数都要新鲜：CDN、浏览器都别缓存这个响应 */
  const headers = { 'cache-control': 'no-store' }

  if (method === 'GET') return json({ views }, { headers })

  const next = views + 1
  await kv.put(KEY, String(next))
  return json({ views: next }, { headers })
}
