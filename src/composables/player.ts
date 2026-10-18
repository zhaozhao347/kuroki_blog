/**
 * 音乐播放器 —— 单一真相源。
 *
 * ── 数据流 ──
 *   src/playlist.ts（曲目清单：网易云歌曲 id + 手写元数据）
 *     → 拼出稳定的端点地址 `<VITE_MUSIC_ENDPOINT>/stream?id=…`
 *     → 本模块拿它建一个隐藏的 <audio>，并把解码后的音频接进 Web Audio 图
 *     → MusicBar.vue 只读本模块的状态、只调它暴露的动作
 *   ★ 仓库里没有音频文件，字节由自建端点转发（workers/api/）；
 *     dev 下同一份实现挂在 `/music`（见 plugins/vite-plugin-api-proxy.ts）。
 *
 * ── 为什么用 Web Audio 而不是直接 `<audio>` ──
 *   hero 中央的 SoundLine 波形要读**真实频谱**（analyser.getByteFrequencyData）。
 *   `<audio>` 本身没有 analyser，必须 `createMediaElementSource` 把它接进图里。
 *   ★ 一旦接了 MediaElementSource，音频就**只**从图里出（元素自身的音量也在图的前级），
 *     所以音量由图里的 GainNode 负责 —— 更明确，且将来要做切歌淡入不用改架构。
 *   ★★ 音频是**跨源**的（端点在别的域），所以还必须 `crossOrigin = 'anonymous'` +
 *     端点回 CORS 头：否则媒体元素能播、但接进图里的那路会被当成「污染源」而**静音**，
 *     波形全零 —— 表现是「时间在走、没有声音」，很难查。见下面建 audio 处。
 *
 * ── 状态机 ──
 *   status: 'idle' | 'loading' | 'playing' | 'paused'
 *   ★ 用 HTMLMediaElement 的事件（play/playing/pause/ended/waiting）驱动状态，
 *     而不是「点了就设为 playing」—— 浏览器拒绝自动播放、或解码失败时，
 *     乐观状态会和真实状态脱节（界面显示在放、实际没声音）。
 *
 * ★ 文件结构：常量/状态 → 动作 → 启动（建图 + 事件 + rAF）。
 *   建图放在文件末尾执行，是因为它要读 volume / muted 这些 ref。
 */

import { computed, ref, watch } from 'vue'

import { tracks as rawTracks } from '@/playlist'

/* ==================== 类型 ==================== */

/**
 * 曲目。
 * ★ 只留**真的有人读**的字段：`file` / `hasArt` / `trackNo` / `tagVersion`
 *   是「构建期解析 mp3」时代的产物（界面从没用过），随 mp3 一起删了。
 *   加歌要补什么，看 `src/playlist.ts` 的 Song。
 */
export interface Track {
  slug: string
  url: string
  title: string
  artist: string
  album?: string
  year?: string
  duration?: number
}

type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused'

/** 曲目表（同步、第一帧就完整；没有异步加载） */
export const playlist: Track[] = rawTracks

/* ==================== 小工具 ==================== */

/** 秒 → "m:ss"（超过一小时才带小时位） */
export function formatTime(seconds: number | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds < 0) return '0:00'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m)
  return `${h > 0 ? h + ':' : ''}${mm}:${String(s).padStart(2, '0')}`
}

/** 比特率展示已删除（原来的 `formatBitrate`）。
 *  ★ 它只服务于界面上那行「192 kbps · 44.1 kHz · ID3v2.3」音质指纹，
 *    而用户明确要求去掉那行（"hover 展示出来纯多余，而且会造成元素重叠"），
 *    于是这里也不留没有消费方的工具函数。
 *  ★ 现在连那些**字段**也没有了：码率/采样率/声道是「本地 mp3 的文件属性」，
 *    改听在线流之后它们由端点与上游决定（请求的就是 320 kbps），
 *    没有一处会展示，就一并从 Track 里去掉。 */

/**
 * 把清单里的 URL 解析成**绝对 URL**。
 *
 * ★ 端点是绝对地址（`https://…workers.dev`）时它原样返回；而 dev 下清单给的是
 *   `/music`（相对路径，走本地中间件），这时必须让浏览器按**文档**解析 ——
 *   写死 `/music/x` 会解析成站点根；项目页部署在 `https://user.github.io/repo/`
 *   时就会指向 `https://user.github.io/music/x`（404）。
 *   `new URL(url, document.baseURI)` 会尊重文档里的 `<base>`（Vite 构建时按
 *   base 注入）—— 也就是 /repo/ 部署时会正确得到 /repo/music/x。
 *   ★ 用 try/catch 兜底：非浏览器环境（未来若做 SSR/预渲染）没有 document。
 */
function absoluteUrl(url: string): string {
  try {
    return new URL(url, document.baseURI).href
  } catch {
    return url
  }
}

/* ==================== 可持久化的偏好 ==================== */

const KEY = {
  volume: 'blog:music:volume',
  muted: 'blog:music:muted',
  slug: 'blog:music:slug',
  /** 每首单独记位置 —— 切回去能接着听 */
  position: 'blog:music:pos:',
} as const

function readNumber(key: string, fallback: number): number {
  try {
    const v = localStorage.getItem(key)
    if (v == null) return fallback
    const n = Number(v)
    return Number.isFinite(n) ? n : fallback
  } catch {
    return fallback
  }
}

function readString(key: string): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

function write(key: string, value: string | number): void {
  try {
    localStorage.setItem(key, String(value))
  } catch {
    /* 隐私模式 / 配额满：记忆功能失效不该影响播放 */
  }
}

/* ==================== 响应式状态 ==================== */

const savedSlug = readString(KEY.slug)
const startIndex = Math.max(0, playlist.findIndex((t) => t.slug === savedSlug))

export const status = ref<PlayerStatus>('idle')
export const index = ref(startIndex)
/** ★ 当前播放秒数只精确到**整秒**（见文件末尾的 rAF 说明） */
export const currentTime = ref(0)
export const duration = ref(playlist[startIndex]?.duration ?? 0)
export const volume = ref(Math.min(1, Math.max(0, readNumber(KEY.volume, 0.8))))
export const muted = ref(readString(KEY.muted) === '1')
/** 拖动进度条时的预览比例（非 null 表示正在拖） */
export const scrubbing = ref<number | null>(null)

export const current = computed<Track | undefined>(() => playlist[index.value])
export const isPlaying = computed(() => status.value === 'playing')
export const hasTracks = computed(() => playlist.length > 0)

/** 当前进度（0–1），拖动中优先用预览值 */
export const progress = computed(() => {
  if (scrubbing.value != null) return scrubbing.value
  const d = duration.value
  if (!d || !Number.isFinite(d)) return 0
  return Math.min(1, Math.max(0, currentTime.value / d))
})

/* ==================== 音频元素 ==================== */

/**
 * HTMLAudioElement —— 用 `new Audio()` 而不是在模板里放 `<audio>`：
 *   hero 的布局极其敏感（见 HomeView 里那些 --brand-h 的推导），
 *   往 DOM 里插一个媒体元素会带来意外的布局/间距风险。
 *   `new Audio()` 不挂进文档、照样能播。
 */
const audio: HTMLAudioElement | null = typeof Audio !== 'undefined' ? new Audio() : null

if (audio) {
  /* ★★ crossOrigin 必须在**贴 src 之前**设置（这里就是最后的机会）。
     音频是跨源的（站点不打包音频，字节由自建端点转发），而元素要接进 Web Audio 图：
     不设它，元素照样能播，但接进图里的那一路会被当作「污染源」而**静音**、波形全零 ——
     现象是「进度在走、没声音」，很难查。设了它，浏览器会按 CORS 去取，
     端点回 `Access-Control-Allow-Origin`（见 workers/api/src/netease.js）。
     ★ 同源时（dev 的 /music、或端点与站点同域）它也无害：同源请求不走 CORS 检查。 */
  audio.crossOrigin = 'anonymous'
  audio.preload = 'metadata'
  // ★ 不用 loop：播完一曲要跳下一首（见 ended 处理），loop 会把它变成无限单曲循环
  audio.loop = false
}

/* ==================== 音量 ==================== */

function applyVolume(): void {
  /* ★ 走 GainNode 而不是 audio.volume：接了 MediaElementSource 之后，
     元素自身的音量仍然生效（它在图的前级），但用 GainNode 更明确，
     而且将来要做「切歌淡入」时不用改架构。
     ★ setTargetAtTime 而不是直接赋值：拖动音量条时避免台阶噪声（zipper noise）。 */
  if (gain && ctx) {
    const target = muted.value ? 0 : volume.value
    gain.gain.setTargetAtTime(target, ctx.currentTime, 0.02)
  }
}

export function setVolume(v: number): void {
  volume.value = Math.min(1, Math.max(0, v))
  if (volume.value > 0) muted.value = false
  applyVolume()
  write(KEY.volume, volume.value)
  write(KEY.muted, muted.value ? '1' : '0')
}

export function toggleMute(): void {
  muted.value = !muted.value
  applyVolume()
  write(KEY.muted, muted.value ? '1' : '0')
}

/* ==================== 曲目切换与播放 ==================== */

/**
 * 「这个秒数值不值得记住 / 恢复」——存与读**必须共用同一把尺**，
 * 否则会出现「存了读不出」或「读出个末尾」。
 *
 * ★★ 判据：开头 1s 内不值得记（等于从头），末尾 2s 内也不值得记 ——
 *   后者恢复出来就是「一进来直接播完」，听感上是歌刚点就跳到末尾。
 */
function worthRestoring(pos: number, dur: number): boolean {
  if (!(pos > 1)) return false
  if (dur > 0 && pos >= dur - 2) return false
  return true
}

/** 记住当前曲目的播放位置（按 slug 分开存） */
function rememberPosition(): void {
  const t = current.value
  if (!t || !audio) return
  const d = audio.duration || duration.value || 0
  /* ★★ 不满足判据时**也要写**（写 0），不能像以前那样直接 return。
     旧代码只有 `currentTime > 1` 才写，于是两件事同时坏掉：
       ① 拖到末尾（或点到进度条最右端）会把 ~32.03 存进去；
       ② 一旦存进去就**再也覆盖不掉** —— 用户把进度拖回开头（< 1s）时
          写操作被 `> 1` 挡掉，旧值留在 localStorage 里，
          下次载入这首「一进来就跳到末尾」，就是用户报的「不能重置进度」。
     （末尾值还会连锁：跳末尾 → ended → 自动播下一首 → 下一首若也是末尾值
       就继续跳，听感即「频繁跳到播放末尾」。） */
  const ct = audio.currentTime
  write(KEY.position + t.slug, worthRestoring(ct, d) ? ct : 0)
}

/**
 * 载入第 i 首并（可选）开始播放。
 *
 * ★★ 为什么 `audio.src` 只在切歌时改，而 `play()` 可以重复调：
 *   重设 src 会把 currentTime 归零、并触发一次加载；如果每次点播放都重设，
 *   「暂停 → 播放」就会从头开始。
 */
async function load(i: number, autoplay: boolean): Promise<void> {
  if (!audio || playlist.length === 0) return
  const next = (i + playlist.length) % playlist.length
  const changed = next !== index.value || !audio.src
  index.value = next
  const track = playlist[next]
  if (!track) return
  write(KEY.slug, track.slug)

  if (changed) {
    /* ★★ 'loading' 只在**确实要开始播**时才置，否则没人会把它清掉。
       曾经这里无条件写 'loading'，而清掉它的只有 play / playing 两个事件；
       于是「非播放态下切歌」（暂停时点下一首、或从曲目列表里选一首）会把
       状态永久钉在 'loading' —— 播放键上的转圈一直转、歌也不播，
       必须再点一次播放键才恢复（实测转圈 4s 以上不停，用户报的就是这个）。
       非播放态切歌的正确语义是「已载入、未播放」= 'paused'。 */
    status.value = autoplay ? 'loading' : 'paused'
    audio.src = absoluteUrl(track.url)
    duration.value = track.duration ?? 0
    /* 恢复上次听到的位置。
       ★ 有的浏览器在 metadata 之前不接受 currentTime 赋值，所以先记在
         pendingSeek 里，loadedmetadata 时再真正应用。 */
    const saved = readNumber(KEY.position + track.slug, 0)
    pendingSeek = worthRestoring(saved, track.duration ?? 0) ? saved : 0
  }
  if (autoplay) await play()
}

/** 尚未应用的「恢复位置」（metadata 到位前赋 currentTime 会被忽略） */
let pendingSeek = 0

/**
 * 'loading' 的兜底超时（毫秒）。
 *
 * ★★ 为什么需要它：'loading' 是唯一一个「等外部事件来解除」的状态，
 *   而它有两个可能永远等不到的出口 ——
 *     ① 自动播放被拒时，个别浏览器的 play() Promise 既不 resolve 也不 reject；
 *     ② 网络中断触发 waiting 之后，playing 再也没来。
 *   播放键的转圈由 status 驱动，所以这两种情况都会表现为「一直转圈」。
 *   宁可到点退回「已暂停」让人再点一次，也不要骗人地永远转。
 */
const LOADING_TIMEOUT = 8000

/** 看门狗计时器句柄（0 = 未武装） */
let loadingTimer = 0

export async function play(): Promise<void> {
  if (!audio || playlist.length === 0) return
  // ★ AudioContext 必须在用户手势里 resume —— 建图时是 suspended，这里补
  if (ctx && ctx.state === 'suspended') {
    try {
      await ctx.resume()
    } catch {
      /* 忽略：某些浏览器在非手势路径下会拒绝，下一次点击会成功 */
    }
  }
  try {
    await audio.play()
    status.value = 'playing'
  } catch (e) {
    /* 自动播放被拒 / 解码失败：状态回到 paused，UI 显示「已暂停」而不是骗人的播放态 */
    status.value = 'paused'
    console.warn('[player] 播放失败：', e)
  }
}

export function pause(): void {
  if (!audio) return
  audio.pause()
  status.value = 'paused'
  rememberPosition()
}

export function toggle(): void {
  if (status.value === 'playing') pause()
  else void play()
}

export function next(): void {
  const wasPlaying = status.value === 'playing'
  rememberPosition()
  void load(index.value + 1, wasPlaying)
}

export function previous(): void {
  /* 行业惯例：已经播了 3 秒以上时，「上一首」先回到本曲开头，而不是切歌 */
  if (audio && audio.currentTime > 3) {
    seek(0)
    return
  }
  const wasPlaying = status.value === 'playing'
  rememberPosition()
  void load(index.value - 1, wasPlaying)
}

export function select(slug: string): void {
  const i = playlist.findIndex((t) => t.slug === slug)
  if (i < 0 || i === index.value) return
  const wasPlaying = status.value === 'playing'
  rememberPosition()
  void load(i, wasPlaying)
}

/** 跳到某个秒数 */
export function seek(seconds: number): void {
  if (!audio) return
  const d = audio.duration || duration.value
  const clamped =
    Number.isFinite(d) && d > 0 ? Math.min(d, Math.max(0, seconds)) : Math.max(0, seconds)
  audio.currentTime = clamped
  currentTime.value = Math.floor(clamped)
  rememberPosition()
}

/** 按比例跳（进度条用） */
function seekRatio(ratio: number): void {
  const d = audio?.duration || duration.value
  if (!d || !Number.isFinite(d)) return
  seek(d * Math.min(1, Math.max(0, ratio)))
}

/** 拖动开始 / 更新 / 结束 —— 拖动中不改音频，松手才 seek（避免每像素一次解码跳转） */
export function beginScrub(ratio: number): void {
  scrubbing.value = Math.min(1, Math.max(0, ratio))
}
export function updateScrub(ratio: number): void {
  if (scrubbing.value == null) return
  scrubbing.value = Math.min(1, Math.max(0, ratio))
}
export function endScrub(): void {
  const r = scrubbing.value
  scrubbing.value = null
  if (r != null) seekRatio(r)
}

/**
 * 停止并回到开头（离开首页时用）。
 * ★ 不复位 index：下次回来接着听**同一首**，符合「记住上次」的预期。
 */
export function stop(): void {
  if (!audio) return
  rememberPosition()
  audio.pause()
  audio.currentTime = 0
  currentTime.value = 0
  status.value = 'idle'
}

/** 供 SoundLine 取频谱 */
export function getAnalyser(): AnalyserNode | null {
  return analyser
}

/* ==================== 音频图（必须在状态之后建） ==================== */

/**
 * Web Audio 图：audio → analyser → gain → destination
 *
 * ★★ analyser 必须在**模块加载时就建**，不能等首次播放：
 *   SoundLine 在 onMounted 里就要 createRenderer() 挂动画（未播放时画静止线），
 *   那时若还没有 analyser，库不会启动它的 rAF 循环，
 *   之后即使开始播放也没人会去重画 —— 波形永远不动。
 *   AudioContext 在用户手势前是 suspended 状态，建出来是安全且无噪音的。
 */
let ctx: AudioContext | null = null
let analyser: AnalyserNode | null = null
let gain: GainNode | null = null

function initGraph(): void {
  if (ctx || !audio) return
  try {
    ctx = new AudioContext()
    const source = ctx.createMediaElementSource(audio)
    analyser = ctx.createAnalyser()
    analyser.fftSize = 1024
    analyser.smoothingTimeConstant = 0.8
    gain = ctx.createGain()
    gain.gain.value = muted.value ? 0 : volume.value
    source.connect(analyser)
    analyser.connect(gain)
    gain.connect(ctx.destination)
  } catch (e) {
    /* 极少数环境（老旧 Safari / 无音频设备）会在这里失败。
       此时退化成「有声音但没波形」，比整个播放器挂掉好。 */
    console.warn('[player] Web Audio 初始化失败，波形将不可用：', e)
    ctx = null
    analyser = null
    gain = null
  }
}

/* ==================== 逐帧进度通道（进度条视觉层专用） ==================== */

/**
 * 逐帧播放进度（0–1）的订阅者。
 *
 * ★★ 为什么需要单独一条通道：
 *   `currentTime` 这个 ref 刻意只精确到整秒（理由见下方 tick 的说明 ——
 *   它一变就整块重渲染 MusicBar，按帧变就是每秒 60 次重渲染）。
 *   但**进度条**要丝滑，就不能按秒走：一秒动一格的进度条肉眼就是台阶，
 *   而且整秒量化天然带最多 1s 的滞后。
 *   所以把视觉层单独拎出来：进度条按 rAF 逐帧读真实 `audio.currentTime`，
 *   直接写 DOM 的 transform / left。这样
 *     ① 不经过 Vue 响应式 —— 记录仍是每秒 32 次，没有任何额外重渲染；
 *     ② 不受整秒量化影响 —— 无台阶、无滞后，拖到哪画到哪。
 *   ★ 代价是 MusicBar 要放弃 `:style` 绑定、改成直接写 DOM（见那边注释）。
 */
const frameSubs = new Set<(ratio: number) => void>()

/** 上一帧发出的比例（相同就不重复发，暂停时省掉整条链路） */
let lastEmitted = -1

/**
 * 当前**该显示**的进度（0–1）：拖动预览优先，否则取真实播放位置。
 * ★ 与 `progress` 的区别：这里读的是 `audio.currentTime`（连续值，带小数），
 *   而 `progress` 读的是整秒量化的 `currentTime` ref。进度条要前者。
 */
function visualRatio(): number {
  if (scrubbing.value != null) return scrubbing.value
  if (!audio) return 0
  const d = audio.duration || duration.value
  if (!Number.isFinite(d) || d <= 0) return 0
  return Math.min(1, Math.max(0, audio.currentTime / d))
}

/**
 * 订阅逐帧进度，返回取消订阅的函数。
 * ★ 订阅时会**立即回调一次**当前值 —— 否则新挂上来的元素要等到下一次
 *   进度变化才被画出来（暂停状态下可能永远等不到，进度条就停在初始位置）。
 */
export function onFrameProgress(cb: (ratio: number) => void): () => void {
  frameSubs.add(cb)
  cb(visualRatio())
  return () => {
    frameSubs.delete(cb)
  }
}

function emitFrame(): void {
  if (frameSubs.size === 0) return
  const r = visualRatio()
  if (r === lastEmitted) return
  lastEmitted = r
  for (const cb of frameSubs) cb(r)
}

/* ---------------- 逐帧时间（秒，连续值）---------------- */

/**
 * 逐帧播放位置（**秒**，带小数）—— 给歌词这种「按时间点换内容」的消费方。
 *
 * ★ 为什么不直接看 `currentTime` ref：那个 ref 刻意**只精确到整秒**
 *   （见 tick() 的注释，为了少触发重渲染）。挂在它上面，一句歌词最多会
 *   **晚将近 1 秒**才换 —— 歌词对不上拍就是这个原因。
 * ★ 为什么不用 `onFrameProgress`：那里给的是 0–1 比例，乘 `duration` 才能回到秒，
 *   而 `duration` 是清单里手写 / 容器报告的近似值，乘出来会随播放逐渐漂移。
 *   这里直接把 `audio.currentTime` 交出去，一个近似值都不掺。
 * ★ 订阅时**立即回调一次**：挂载瞬间停在半句中间时也能拿到当前句。
 * ★ 暂停时不发（值没变），拖动进度条会发（值变了）—— 与画面一致。
 */
const timeSubs = new Set<(seconds: number) => void>()
let lastEmittedTime = -1

export function onFrameTime(cb: (seconds: number) => void): () => void {
  timeSubs.add(cb)
  cb(audio?.currentTime ?? 0)
  return () => {
    timeSubs.delete(cb)
  }
}

function emitTime(): void {
  if (timeSubs.size === 0) return
  const t = audio?.currentTime ?? 0
  if (t === lastEmittedTime) return
  lastEmittedTime = t
  for (const cb of timeSubs) cb(t)
}

/* ==================== 启动：建图 + 元素事件 + 进度刷新 ==================== */

/**
 * 进度刷新循环（rAF）。
 *
 * ★★ 当前时间 ref 刻意**只精确到整秒**：`currentTime` 一变，整个 MusicBar
 *   就会重渲染 —— 若它每帧都变，播放时每秒重渲染 60 次。
 *   所以这里只在**秒数真的跳了**才写 ref：显示的时间文本仍然准确，
 *   而每首歌只触发 32 次更新。波形也不受影响（SoundLine 直接读 analyser）。
 * ★ 进度条的丝滑由 `emitFrame()` 那条通道负责，两者互不干扰：
 *   ref 管文本（低频、走 Vue），emitFrame 管条形（每帧、直接写 DOM）。
 */
let rafId = 0
let lastWhole = -1

function tick(): void {
  if (audio && scrubbing.value == null) {
    const whole = Math.floor(audio.currentTime)
    if (whole !== lastWhole) {
      lastWhole = whole
      currentTime.value = whole
    }
  }
  emitFrame()
  emitTime()
  rafId = requestAnimationFrame(tick)
}

if (typeof window !== 'undefined') {
  // ★ 先建图再挂事件：事件回调（loadedmetadata 里恢复位置）依赖图已就绪
  initGraph()
  applyVolume()

  if (audio) {
    audio.addEventListener('play', () => {
      status.value = 'playing'
    })
    audio.addEventListener('playing', () => {
      status.value = 'playing'
    })
    audio.addEventListener('pause', () => {
      // ★ 播完时浏览器也会发 pause；那种情况交给 ended 处理，别在这里改状态
      if (!audio.ended && status.value !== 'idle') status.value = 'paused'
    })
    audio.addEventListener('waiting', () => {
      if (status.value === 'playing') status.value = 'loading'
    })
    audio.addEventListener('loadedmetadata', () => {
      /* ★ 时长以**浏览器解出来的为准**：它才是真正在播的那个。
         `src/playlist.ts` 里手写的时长与容器报告的会差几十毫秒 —— 平时看不出来，
         但进度条拖到最右端时「0:32 / 0:31」就会露馅。 */
      if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
        duration.value = audio.duration
      }
      if (pendingSeek > 0) {
        /* ★ 这里用**真实**时长再筛一次：清单里写的 duration 与容器报告的
           可能只差几十毫秒，而这几十毫秒正好决定恢复值算不算「落在末尾」。
           落末尾就按 0 处理（从头播），否则一进来就 ended。 */
        const back = worthRestoring(pendingSeek, audio.duration || 0) ? pendingSeek : 0
        audio.currentTime = Math.min(back, audio.duration || back)
        currentTime.value = Math.floor(audio.currentTime)
        pendingSeek = 0
      }
    })
    audio.addEventListener('ended', () => {
      // 只有一首时回到开头停住，而不是「播完卡在结尾」
      if (playlist.length <= 1) {
        audio.currentTime = 0
        currentTime.value = 0
        status.value = 'paused'
        return
      }
      void load(index.value + 1, true)
    })
    audio.addEventListener('error', () => {
      console.warn('[player] 音频加载失败：', current.value?.url)
      status.value = 'paused'
    })

    /* ★★ 兜底看门狗：任何原因进入 'loading' 后，到点仍未解除就退回 'paused'。
       这是「转圈不会永远转」的最终保证 —— 正常加载几秒内必然被 play/playing
       解除，所以它只在异常路径上生效（见 LOADING_TIMEOUT 的说明）。 */
    watch(status, (s) => {
      window.clearTimeout(loadingTimer)
      loadingTimer = 0
      if (s !== 'loading') return
      loadingTimer = window.setTimeout(() => {
        if (status.value !== 'loading') return
        /* ★ 到点仍没等到 play/playing。此时别猜，看元素的实际状态：
           它若在推进（paused=false）就当它在播；否则退回 'paused'，
           让人再点一次 —— 两种情况都比「永远转圈」诚实。 */
        status.value = audio && !audio.paused ? 'playing' : 'paused'
      }, LOADING_TIMEOUT)
    })

    // 初始化音源（不自动播放）
    const first = playlist[startIndex]
    if (first) {
      audio.src = absoluteUrl(first.url)
      duration.value = first.duration ?? 0
      /* ★★ 首次载入也要恢复上次的位置（用户要求「记住播放位置」）。
         这里曾经漏掉：`load()` 会算 pendingSeek，而**启动路径绕过了 load()**
         （直接贴 src），于是刷新后位置永远是 0:00 —— 存的键有、读的人没有。
         判据与 load() 一致，统一走 worthRestoring()（末尾值不恢复）。 */
      const saved = readNumber(KEY.position + first.slug, 0)
      pendingSeek = worthRestoring(saved, first.duration ?? 0) ? saved : 0
    }
  }

  /* ★★ 离开页面时把位置写回 localStorage。
     `rememberPosition()` 只在 pause/切歌/seek 时被调，用户直接关标签页
     （或按 F5）那一刻没有 pause 事件 → 位置丢失。
     ★ 用 pagehide 而不是 beforeunload：移动端 Safari / bfcache 下
     beforeunload 常常不触发，pagehide 是唯一可靠的。 */
  window.addEventListener('pagehide', rememberPosition)

  // 只在页面可见时跑：切到后台的标签页不需要每帧读 currentTime
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      cancelAnimationFrame(rafId)
      rafId = 0
    } else if (!rafId) {
      rafId = requestAnimationFrame(tick)
    }
  })
  rafId = requestAnimationFrame(tick)
}
