/**
 * 节拍包络（beat envelope）—— 全站唯一的「这一下有多重」信号。
 *
 * ── 它输出什么 ──
 *   `readBeat(dt)` 返回 0..1：**这一次鼓点有多强**（不是响度，是「突然起来」的量）。
 *   调用方自己按帧调它（不需要订阅、不持有 rAF），所以谁都可以读，互不干扰。
 *
 * ── 为什么不是「随机脉动」──
 *   用户明确要求「大小跟着节奏律动，不是随机律动，而是真正跟着音乐节奏走」。
 *   所以这个信号完全由**真实频谱**推出来，和 SoundLine 的波形同源：
 *
 *     节拍信号 raw = (能量 + 2 × 谱通量) / LEVEL_REF
 *     快包络（攻击 26ms / 释放 130ms）跟着鼓点起
 *     慢包络（260ms）≈ 当前平均能量
 *     punch = (fast − slow) / slow      ← 这一拍比"周围"高出多少
 *     beat  = tanh(punch × 2.2)         ← 软限幅到 0..1
 *
 *   ★ 这个配比不是随手写的，是 SoundLine 在真实曲目（网易云 320 kbps）上量出来的：
 *     · 只用「能量」：实测每 23s 只抓到 16 次起落 = 0.69 次/s，而同一段音频的
 *       谱通量自相关给出真实节拍 1.68 拍/s —— 漏掉六成鼓点（能量被持续的人声/弦乐托着）。
 *     · 能量 + 2×通量：实测 1.69 次/s，与真实节拍一致。
 *     详见 `components/SoundLine.vue` 里 FLUX_WEIGHT / PUNCH_GAIN 的注释。
 *
 * ── 为什么还要除以 LEVEL_REF ──
 *   同一个「能量」在不同音源下尺度不同（内置合成器时代 avg≈0.29，真实曲目 0.58~0.65）。
 *   0.78 是给真实曲目定的参考电平，除完再进包络，punch 才有统一的标定。
 *
 * ★ 这里**不建** rAF、不订阅播放器：它只是一段「给我 dt，我给你 beat」的纯计算。
 *   生命周期由调用方（`composables/floatText.ts`）掌握 —— 暂停时没人调它，
 *   它连一帧都不会算。
 */
import { getAnalyser } from '@/composables/player'

/** 只看频谱前 64 个 bin：低频能量与「鼓点 / 响度」相关性最高，全频段平均会被高频冲淡 */
const BAND = 64
/** 满幅参考电平（真实曲目实测中位 0.58~0.65，取 0.78 留出行程） */
const LEVEL_REF = 0.78
/** 谱通量权重：1 漏拍、4 重复计数，2 实测与真实拍速对齐 */
const FLUX_WEIGHT = 2
/** 快包络：攻击要快（鼓点当场起），释放稍慢（余音慢慢落） */
const ATTACK_MS = 26
const RELEASE_MS = 130
/** 慢包络 ≈ 当前平均能量（punch 的分母） */
const SLOW_MS = 260
/** 输出平滑：避免频谱抖动直接传导成字形抖动 */
const SMOOTH_MS = 40
/** punch → beat 的软限幅系数 */
const PUNCH_GAIN = 2.2

let bins: Uint8Array<ArrayBuffer> | null = null
let prev: Uint8Array<ArrayBuffer> | null = null
let seeded = false
let fast = 0
let slow = 0
let beat = 0

/** 与帧率无关的指数平滑系数：给定时间常数，算出这一帧该插值多少 */
const tauK = (dt: number, ms: number) => 1 - Math.exp(-dt / ms)

/**
 * 清空包络状态。
 *
 * ★ 每次「开始浮动」前要调一次：否则上一轮留下的 fast/slow 会让第一拍
 *   变成负数或虚高（punch 是两者之差，历史值不清零，起手就不准）。
 */
export function resetBeat(): void {
  seeded = false
  fast = 0
  slow = 0
  beat = 0
  prev?.fill(0)
}

/**
 * 读一次节拍（必须按帧调）。
 *
 * @param dtMs 距上一次调用的毫秒数（rAF 的真实间隔）
 * @returns 0..1 的节拍包络；没有 analyser（还没建音频图）时平滑回落到 0
 */
export function readBeat(dtMs: number): number {
  const dt = Math.max(1, Math.min(80, dtMs))
  const analyser = getAnalyser()
  if (!analyser) {
    beat += (0 - beat) * tauK(dt, SMOOTH_MS)
    return beat
  }

  const n = analyser.frequencyBinCount
  if (!bins || bins.length !== n) {
    bins = new Uint8Array(n)
    prev = new Uint8Array(n)
    seeded = false
  }
  analyser.getByteFrequencyData(bins)

  const end = Math.min(BAND, n)
  let sum = 0
  let rise = 0
  for (let i = 0; i < end; i++) {
    const v = bins[i]
    sum += v
    /* ★ 第一帧 prev 全是 0，若照算会得到一个「巨大起音」的假鼓点 →
       用 seeded 跳过头一帧的谱通量。 */
    if (seeded && prev) {
      const d = v - prev[i]
      if (d > 0) rise += d
    }
  }
  prev?.set(bins.subarray(0, end))
  seeded = true

  const avg = sum / end / 255
  const flux = rise / end / 255
  const raw = (avg + FLUX_WEIGHT * flux) / LEVEL_REF

  fast += (raw - fast) * tauK(dt, raw > fast ? ATTACK_MS : RELEASE_MS)
  slow += (raw - slow) * tauK(dt, SLOW_MS)

  const punch = Math.max(0, (fast - slow) / Math.max(0.25, slow))
  const target = Math.min(1, Math.tanh(punch * PUNCH_GAIN))
  beat += (target - beat) * tauK(dt, SMOOTH_MS)
  return beat
}
