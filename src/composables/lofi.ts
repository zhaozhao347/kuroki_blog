/**
 * 波形画布与音频源之间的**唯一适配层**。
 *
 * ── 这里曾经是什么 ──
 *   原来是 488 行的 Web Audio 实时合成器（自己算和弦、贝斯、鼓点，
 *   零音频文件）。2026-09-25 起播放器改成播放真实音频文件（当时是本地 mp3，
 *   2026-10-08 起换成网易云端点，见 `src/playlist.ts`），
 *   音频源变成 `<audio>` 元素，原先那套合成器就成了**第二套互不相关的
 *   播放状态**（它一暂停、波形也跟着停，但音乐还在响）——于是整个删掉。
 *
 * ── 现在它是做什么的 ──
 *   只做三件事，都不持有音频状态：
 *     1. 从 `@/composables/player` 取 analyser（`<audio> → analyser → 扬声器`，
 *        见 player.ts 的 initGraph）；
 *     2. 把 wave.js 的渲染循环挂到 canvas 上，并在 canvas 换代时重建实例；
 *     3. 用 `playerState` 给波形层提供一个「在放 / 不在放」的开关信号。
 *
 * ★ 唯一的真相源是 `player.ts`：这里的 `playerState` 是**从它派生的视图**，
 *   不存自己的状态。同时刻只可能有一个地方在响。
 *
 * ★ analyser 是「边分析边透传」的，所以它既能被 wave.js 读取、又能出声；
 *   反过来，**没有这个节点就没有波形** —— 播放器不走这里，波形就是一条直线。
 */
import { computed } from 'vue'
import { Wave } from '@foobar404/wave'
import { getAnalyser, status } from '@/composables/player'

/**
 * 波形层看到的播放状态。
 *
 * ★ 单向映射：player 的 'loading'（缓冲中）**也算 playing** ——
 *   此时音频还没出声，但波形应该立刻从「归静」切到「待机在放」，
 *   否则缓冲那一下会先收成直线、再猛地打开，看着像卡了一帧。
 *
 * ★ 类型保持 `'idle' | 'playing'`（而不是直接透出 player 的四态）：
 *   SoundLine 只关心「在放 / 不在放」这一个比特，多透状态出去
 *   会让它的 watch 多跑几次无意义的 settle。
 */
export const playerState = computed<'idle' | 'playing'>(() =>
  status.value === 'playing' || status.value === 'loading' ? 'playing' : 'idle',
)

/* ==================== 渲染循环 ==================== */

let renderer: Wave | null = null

/**
 * 读取库实例内部持有的 canvas。
 *
 * ★ `_canvasElement` 在 TS 声明里是 private，但运行时确实存在
 *   （见 bundle 的 constructor：`this._canvasElement = i`）。
 *   这里用类型断言取出来 —— 我们需要它来判断实例是否已失效。
 */
function boundCanvasOf(w: Wave): HTMLCanvasElement | undefined {
  return (w as unknown as { _canvasElement?: HTMLCanvasElement })._canvasElement
}

/**
 * 把 wave.js 的渲染循环挂到 canvas 上（库自己 rAF + 取频谱 + 清屏）。
 *
 * ★★ 必须检查「已绑定的 canvas 是否还是当前这个」！
 *   库把 canvas 与 context 存在自己的实例里（`_canvasElement` /
 *   `_canvasContext`），而 renderer 是**模块级单例**。
 *   组件卸载再挂载（路由切换回来、HMR、v-if 切换）会创建**新的 canvas 元素**，
 *   旧实例却仍指向那个已脱离 DOM 的旧 canvas →
 *   库每帧画在一个看不见的元素上，屏幕上的波形永远不动。
 *
 *   实测症状：`draw()` 每秒被调 ~200 次、音频数据正常流动、
 *   手动调 draw 能画出来，但画布 hash 12 次采样完全相同。
 *   排查时确认 `document.contains(renderer._canvasElement) === false`。
 *
 * ★★ 返回 `null` 的含义变了（2026-09-25）：从「合成器还没建」变成
 *   「播放器还没建出 analyser」。所以调用方**不能**把 null 当成
 *   「永远没有波形」—— 点播放之后要再调一次（SoundLine 就是这么做的：
 *   它的 watch(playerState) 会重新走 startLibraryLoop）。
 */
export function createRenderer(canvas: HTMLCanvasElement) {
  const node = getAnalyser()
  if (!node) return null

  /* 已绑定且绑的正是这个 canvas → 直接复用 */
  if (renderer && boundCanvasOf(renderer) === canvas) return renderer

  renderer = new Wave(node, canvas)
  return renderer
}

export function getRenderer() {
  return renderer
}
