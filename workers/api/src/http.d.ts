/**
 * `src/http.js` 的类型声明（纯 JS + 同名 d.ts，理由见 netease.d.ts）。
 */
export declare const ROUTES: string[]
export declare const CORS_HEADERS: Record<string, string>
export declare function preflight(): Response
export declare function json(
  data: unknown,
  init?: { status?: number; headers?: HeadersInit },
): Response
