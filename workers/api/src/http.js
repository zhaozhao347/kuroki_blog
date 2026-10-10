/**
 * 三个端点共用的一点点 HTTP 糖：路由清单、CORS、JSON 响应、预检。
 *
 * ★ 为什么要有这个文件 —— 一个 Worker 挂三个路由时，最大的风险是
 *   「规则抄三遍、其中一遍抄漏了」：表现就是音乐能播、浏览量却跨域被拦。
 *   所以 CORS 只在这里定义一次。
 *
 * ★ 用 `Access-Control-Allow-Origin: *` 而不是白名单：
 *   三个端点都是**读公开数据**、不带 cookie、不带凭据（前端 `credentials: 'omit'`），
 *   放 `*` 不会泄露任何东西，却省掉了「换域名后忘了加进来」这类事故。
 *   要是以后加了写操作或鉴权，这里必须改成按 Origin 回显白名单。
 */

/** 路由清单：`GET /` 与 404 都回它，部署完一眼就知道端点活着、有哪些路 */
export const ROUTES = [
  'GET  /music/stream?id=<网易云歌曲id>',
  'GET  /music/info',
  'POST /views',
  'GET  /views',
  'GET  /steam',
  'GET  /steam/info',
]

export const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,HEAD,POST,OPTIONS',
  /* Range 规范上算 CORS 安全头，但预检顺手答了成本为零，且能省掉一类玄学问题 */
  'Access-Control-Allow-Headers': 'Range,If-Range,Content-Type',
  /* ★ Content-Range 必须 expose：音频拖进度条要读它（见 netease.js 的注释） */
  'Access-Control-Expose-Headers': 'Content-Length,Content-Range,Accept-Ranges',
}

/** 预检：三个路由共用同一份答案 */
export function preflight() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}

/**
 * JSON 响应（自动带上 CORS）。
 *
 * @param {unknown} data 会被 JSON.stringify 的内容
 * @param {{ status?: number, headers?: HeadersInit }} [init] status 默认 200
 */
export function json(data, init = {}) {
  const headers = new Headers(init.headers)
  headers.set('content-type', 'application/json; charset=utf-8')
  for (const [name, value] of Object.entries(CORS_HEADERS)) {
    if (!headers.has(name)) headers.set(name, value)
  }
  return new Response(JSON.stringify(data), { status: init.status ?? 200, headers })
}
