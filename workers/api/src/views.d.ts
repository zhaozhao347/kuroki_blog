/**
 * `src/views.js` 的类型声明（纯 JS + 同名 d.ts，理由见 netease.d.ts）。
 *
 * ★ KV 这里只声明用到的两个方法（`get` / `put`）：dev 中间件塞进来的内存版
 *   只要满足这两条就能跑，不必假装自己是完整的 KVNamespace。
 */
export interface ViewsKV {
  get(key: string): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

export interface ViewsEnv {
  VIEWS?: ViewsKV
}

export function handleViewsRequest(request: Request, env?: ViewsEnv): Promise<Response>
