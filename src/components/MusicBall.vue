<script setup lang="ts">
/**
 * MusicBall —— 非首页右下角的「音乐球」
 *
 * ── 它解决什么 ──
 *   播放器（`src/composables/player.ts`）本来就是**模块级单例**，`<audio>` 也是
 *   `new Audio()` 建的一直挂着 —— 所以切页时音乐从没停过。问题是：
 *   **唯一的控制器 MusicBar 只挂在首页 hero 里**（`HomeView.vue` 的 `.hero-music`），
 *   一旦离开首页，正在放的歌就再也没有任何入口（用户原话：「我希望音乐栏在
 *   其他页面也可以播放，变成一个音乐球」）。
 *
 * ── 形态（用户 m16393 的两次选择）──
 *   ① 首页照旧是 hero 里那颗胶囊（本组件在首页**完全不渲染**，判据与页脚一致
 *      用路由名 `home`）；
 *   ② 其它页面右下角一颗 52px 的球：球上只有「进度环 + 均衡器图标」——
 *      球本身**不是播放键**，点它只负责展开/收起面板（用户选的是
 *      「点球展开面板，播放键在面板里」）；
 *   ③ 面板从球的正上方展开，上/下一首、播放、静音、进度、曲目列表都在里面，
 *      反复点球（或按 Esc、点面板外）收起。
 *
 * ── 与 MusicBar 的关系：同一个播放器，两套衣服 ──
 *   ★ 数据全部来自 `@/composables/player` 的同一批导出，两处永远同步：
 *     在任何一处暂停/切歌，另一处（首页胶囊）下一帧就是同一个状态。
 *   ★ 但**不复用同一个组件**：胶囊的排版是「一行控件 + 细轨」的横向胶囊，
 *     球的面板是竖向卡片，两者的容器查询降级、抽屉动画、45° 擦除都不通用；
 *     硬塞进去只会把首页那套已经调稳的版式拖下水。
 *   ★ 因此这里刻意重复了三段小逻辑（拖动预览、逐帧画进度、细轨+透明 range），
 *     它们的注释在 MusicBar.vue 里写得更详细，改的时候**两边都要看一眼**。
 *
 * ── 层级 ──
 *   z-index 54：在页面内容之上、液态玻璃转场（LiquidTransition 的 55）之下 ——
 *   转场时球会被玻璃一起扫掉，不会「浮在玻璃上」很突兀。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRoute } from 'vue-router'
import {
  beginScrub,
  current,
  currentTime,
  duration,
  endScrub,
  formatTime,
  hasTracks,
  isPlaying,
  muted,
  next,
  onFrameProgress,
  playlist,
  previous,
  progress,
  select,
  status,
  toggle,
  toggleMute,
  updateScrub,
} from '@/composables/player'

const route = useRoute()

/** 首页 hero 里已经有胶囊 ⇒ 球在首页不渲染。
 *  ★ 判据用路由**名**（与 DefaultLayout 的页脚、isHome 完全一致），
 *    不要比 path 字符串：带 base / 尾斜杠时容易漏。 */
const onHome = computed(() => route.name === 'home')
/** 没有曲目就没有球：真实原因只有一个 —— 生产没配 VITE_MUSIC_ENDPOINT。
 *  那种情况下首页胶囊会如实说明怎么配（.mb-empty），球在这儿沉默是金。 */
const visible = computed(() => !onHome.value && hasTracks.value)

const open = ref(false)

/** 拖动中用**本地**比例预览，松手才真正 seek（与 MusicBar 同一套） */
const dragRatio = ref<number | null>(null)
const shownProgress = computed(() => (dragRatio.value != null ? dragRatio.value : progress.value))
const buffering = computed(() => status.value === 'loading')
const metaLine = computed(() => {
  const t = current.value
  if (!t) return ''
  const bits = [t.artist]
  if (t.album) bits.push(t.album)
  if (t.year) bits.push(t.year)
  return bits.join(' · ')
})

/* ── 逐帧直接写 DOM，不走 Vue 的 :style 绑定 ──
 * 进度比例每帧都在变，一旦进响应式就是每秒 60 次组件重渲染。
 * ★ 环按 **1% 粒度**更新：描边/圆锥渐变的重画成本远高于 scaleX 与 left，
 *   而 1% 在 3 分钟的曲子上是 2 秒 —— 完全没有每帧重画的必要。 */
const RING_R = 22
const RING_LEN = 2 * Math.PI * RING_R

const ringEl = ref<SVGCircleElement | null>(null)
const fillEl = ref<HTMLElement | null>(null)
const thumbEl = ref<HTMLElement | null>(null)

let lastRing = -1
function paintFrame(ratio: number): void {
  if (fillEl.value) fillEl.value.style.transform = `scaleX(${ratio})`
  if (thumbEl.value) thumbEl.value.style.left = `${ratio * 100}%`
  const pct = Math.round(ratio * 100)
  if (ringEl.value && pct !== lastRing) {
    lastRing = pct
    ringEl.value.style.strokeDashoffset = String(RING_LEN * (1 - pct / 100))
  }
}

let stopFrame: (() => void) | null = null
onMounted(() => {
  // 订阅时会立刻回调一次当前值 ⇒ 挂载即画出正确的环与进度，不必等第一帧变化
  stopFrame = onFrameProgress(paintFrame)
})

/* ── 进度条交互（同 MusicBar：键盘只派发 input，不能因 dragRatio 为 null 丢掉） ── */
function ratioFrom(e: Event): number {
  const el = e.target as HTMLInputElement
  const v = Number(el.value)
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v / 1000)) : 0
}
function onScrubStart(e: Event) {
  const r = ratioFrom(e)
  dragRatio.value = r
  beginScrub(r)
}
function onScrubMove(e: Event) {
  const r = ratioFrom(e)
  if (dragRatio.value == null) beginScrub(r)
  dragRatio.value = r
  updateScrub(r)
}
function onScrubEnd() {
  if (dragRatio.value == null) return
  dragRatio.value = null
  endScrub()
}

/* ── 收起面板的三种方式：再点球 / 点面板外 / Esc ──
 * ★ 监听器只在展开期间挂着，收起就摘 —— 常驻的话每次点击全站都要过一遍判断。
 * ★ 用**捕获阶段**的 pointerdown：面板里没有 stopPropagation 的地方，
 *   但捕获能保证在页面里任何处理逻辑之前就决定收不收。
 * ★ 展开那一下本身不会立刻收起：pointerdown 早已发生，监听器是这之后
 *   （watch 的微任务里）才挂上的。 */
const rootEl = ref<HTMLElement | null>(null)
const ballEl = ref<HTMLButtonElement | null>(null)

function onDocPointerDown(e: PointerEvent) {
  if (!open.value) return
  const root = rootEl.value
  if (root && e.target instanceof Node && !root.contains(e.target)) open.value = false
}
function onDocKeydown(e: KeyboardEvent) {
  if (e.key !== 'Escape' || !open.value) return
  open.value = false
  ballEl.value?.focus()
}
function bindDismiss(on: boolean) {
  if (on) {
    document.addEventListener('pointerdown', onDocPointerDown, true)
    document.addEventListener('keydown', onDocKeydown)
  } else {
    document.removeEventListener('pointerdown', onDocPointerDown, true)
    document.removeEventListener('keydown', onDocKeydown)
  }
}
watch(open, (v) => bindDismiss(v))

onBeforeUnmount(() => {
  stopFrame?.()
  stopFrame = null
  bindDismiss(false)
})
</script>

<template>
  <div
    v-if="visible"
    ref="rootEl"
    class="music-ball"
    :class="{ 'is-open': open, 'is-playing': isPlaying }"
  >
    <!-- ==================== 面板（在球的正上方展开）====================
         ★ inert：收起时整块不可聚焦、不会被 Tab 走进来。
         ★ 不用 aria-modal / role=dialog：它不是模态，也不锁焦点与滚动，
           用一个普通 region 更诚实。 -->
    <div
      id="music-ball-panel"
      class="mc-panel"
      role="region"
      aria-label="音乐播放器"
      :inert="open ? undefined : true"
    >
      <div class="mc-head">
        <div class="mc-info">
          <p class="mc-title">{{ current?.title ?? '——' }}</p>
          <p class="mc-meta">{{ metaLine }}</p>
        </div>
        <button
          class="mc-close"
          type="button"
          aria-label="收起音乐面板"
          title="收起"
          @click="open = false"
        >
          <svg viewBox="0 0 16 16" aria-hidden="true">
            <path
              d="M4.6 4.6 11.4 11.4M11.4 4.6 4.6 11.4"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              stroke-linecap="round"
            />
          </svg>
        </button>
      </div>

      <!-- 进度：细轨 + 透明原生 range（画法与 hero 胶囊完全一致，见 MusicBar 注释） -->
      <div class="mc-scrub">
        <div class="mc-track" aria-hidden="true">
          <div ref="fillEl" class="mc-track-fill" />
        </div>
        <div ref="thumbEl" class="mc-thumb" />
        <input
          class="mc-scrub-input"
          type="range"
          min="0"
          max="1000"
          step="10"
          :value="Math.round(shownProgress * 1000)"
          aria-label="播放进度"
          :aria-valuetext="`${formatTime(currentTime)} / ${formatTime(duration)}`"
          @pointerdown="onScrubStart"
          @input="onScrubMove"
          @change="onScrubEnd"
          @pointerup="onScrubEnd"
          @pointercancel="onScrubEnd"
        />
      </div>

      <div class="mc-row">
        <span class="mc-time">
          <span class="mc-elapsed">{{ formatTime(currentTime) }}</span>
          <span class="mc-total"> / {{ formatTime(duration) }}</span>
        </span>

        <div class="mc-controls">
          <button
            class="mc-btn"
            type="button"
            :disabled="playlist.length < 2"
            aria-label="上一首"
            title="上一首（播放满 3 秒后先回到开头）"
            @click="previous()"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M4 3h1.7v10H4z" fill="currentColor" />
              <path d="M12.6 3.4v9.2L6.4 8z" fill="currentColor" />
            </svg>
          </button>

          <button
            class="mc-btn mc-btn-play"
            type="button"
            :aria-label="isPlaying ? '暂停' : '播放'"
            :title="isPlaying ? '暂停' : '播放'"
            @click="toggle()"
          >
            <span v-if="buffering" class="mc-spinner" aria-hidden="true" />
            <svg v-else-if="isPlaying" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4.2" y="3" width="2.6" height="10" rx="1" fill="currentColor" />
              <rect x="9.2" y="3" width="2.6" height="10" rx="1" fill="currentColor" />
            </svg>
            <svg v-else viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.4 3.2 12.4 8l-7 4.8z" fill="currentColor" />
            </svg>
          </button>

          <button
            class="mc-btn"
            type="button"
            :disabled="playlist.length < 2"
            aria-label="下一首"
            title="下一首"
            @click="next()"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M10.3 3H12v10h-1.7z" fill="currentColor" />
              <path d="M3.4 3.4v9.2L9.6 8z" fill="currentColor" />
            </svg>
          </button>
        </div>

        <button
          class="mc-icon"
          type="button"
          :aria-label="muted ? '取消静音' : '静音'"
          :title="muted ? '恢复音量' : '静音'"
          @click="toggleMute()"
        >
          <svg v-if="muted" viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 6h2.2L8 3.6v8.8L4.7 10H2.5z" fill="currentColor" />
            <path
              d="M10.6 6.2 13.8 9.8M13.8 6.2 10.6 9.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
          </svg>
          <svg v-else viewBox="0 0 16 16" aria-hidden="true">
            <path d="M2.5 6h2.2L8 3.6v8.8L4.7 10H2.5z" fill="currentColor" />
            <path
              d="M10.3 5.6a3.4 3.4 0 0 1 0 4.8"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path
              d="M12.2 3.9a5.9 5.9 0 0 1 0 8.2"
              fill="none"
              stroke="currentColor"
              stroke-width="1.2"
            />
          </svg>
        </button>
      </div>

      <!-- 曲目列表：两行式（标题 / 艺术家 · 时长），21rem 宽也放得下 -->
      <ul class="mc-list">
        <li v-for="(t, i) in playlist" :key="t.slug">
          <button
            class="mc-item"
            type="button"
            :class="{ 'is-current': t.slug === current?.slug }"
            :aria-current="t.slug === current?.slug ? 'true' : undefined"
            @click="select(t.slug)"
          >
            <span class="mc-item-index">{{ String(i + 1).padStart(2, '0') }}</span>
            <span class="mc-item-body">
              <span class="mc-item-title">{{ t.title }}</span>
              <span class="mc-item-sub">{{ t.artist }} · {{ formatTime(t.duration) }}</span>
            </span>
            <!-- 正在放的那一首给一个会跳的小动画（与球上的图标同一套语言） -->
            <span v-if="t.slug === current?.slug && isPlaying" class="mc-item-live" aria-hidden="true">
              <i /><i /><i />
            </span>
          </button>
        </li>
      </ul>
    </div>

    <!-- ==================== 球 ====================
         ★ 球上**没有播放键**：点它只展开/收起面板（用户 m16393 的选择）。
           所以图标是均衡器而不是 ▶ —— 一个「点开才有播放键」的球上画 ▶
           会让人以为点下去是播放。 -->
    <button
      ref="ballEl"
      class="mc-ball"
      type="button"
      :aria-expanded="open"
      aria-controls="music-ball-panel"
      :aria-label="open ? '收起音乐面板' : '展开音乐面板'"
      :title="open ? '收起音乐面板' : '展开音乐面板'"
      @click="open = !open"
    >
      <!-- 进度环：r=22 ⇒ 周长 138.23，JS 只改 stroke-dashoffset（1% 粒度） -->
      <svg class="mc-ring" viewBox="0 0 48 48" aria-hidden="true">
        <circle class="mc-ring-track" cx="24" cy="24" r="22" />
        <circle
          ref="ringEl"
          class="mc-ring-fill"
          cx="24"
          cy="24"
          r="22"
          transform="rotate(-90 24 24)"
        />
      </svg>

      <span v-if="buffering" class="mc-spinner" aria-hidden="true" />
      <svg v-else class="mc-eq" viewBox="0 0 16 16" aria-hidden="true">
        <rect class="mc-eq-bar" x="3.1" y="6" width="2" height="4" rx="1" />
        <rect class="mc-eq-bar" x="7" y="3.6" width="2" height="8.8" rx="1" />
        <rect class="mc-eq-bar" x="10.9" y="7" width="2" height="2.6" rx="1" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* ==================== 调色板 ====================
 * 直接沿用 hero 胶囊（.mb-shell）那套：米底蓝字、淡灰描边、蓝轨道。
 * 播放态再整体翻成蓝底米字 —— 与胶囊的 45° 擦除是同一个「换色」结果，
 * 只是球太小，用直接换底色 + 0.35s 过渡就够，不必再铺一层渐变。 */
.music-ball {
  --mc-edge: color-mix(in srgb, var(--text) 42%, transparent);
  --mc-track: color-mix(in srgb, var(--brand) 18%, transparent);
  --mc-bg: color-mix(in srgb, var(--text) 92%, transparent);
  --mc-muted: color-mix(in srgb, var(--brand) 62%, transparent);

  /* ★ 定在右下角。z-index 54：内容之上、液态玻璃转场（55）之下。
     ★ 本元素**不加 transform**（里面的面板用绝对定位贴着它）——
     祖先/自身带 transform 会让后代里的 fixed 元素换包含块，这里虽没有
     fixed 后代，但留个规矩，免得以后往里塞东西踩坑。 */
  position: fixed;
  right: 1.25rem;
  bottom: 1.25rem;
  z-index: 54;
  display: flex;
  flex-flow: column;
  align-items: flex-end;
}

/* ==================== 球 ==================== */
.mc-ball {
  position: relative;
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  padding: 0;
  border: 2px solid var(--mc-edge);
  border-radius: 50%;
  background-color: var(--mc-bg);
  color: var(--brand);
  cursor: pointer;
  transition:
    background-color 0.35s var(--ease),
    border-color 0.35s var(--ease),
    color 0.35s var(--ease),
    transform 0.25s var(--ease);
}

.mc-ball:hover {
  transform: scale(1.06);
}

.mc-ball:active {
  transform: scale(0.97);
}

.mc-ball:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 3px;
}

/* 播放态：蓝底米字（与胶囊播放态同一个配色关系） */
.music-ball.is-playing .mc-ball {
  background-color: var(--brand);
  border-color: var(--brand);
  color: var(--text);
}

/* ── 进度环 ──
 * ★ stroke-dasharray 用周长的十进制近似值（138.23）写死在 CSS，JS 里用
 *   `2πr` 算出同一个数写 offset，两边必须一致（改 r 就要改这两处）。
 * ★ 描边色用 currentColor ⇒ 播放态翻底色时环自己跟着翻，不必写两份规则。 */
.mc-ring {
  position: absolute;
  inset: -2px; /* 盖住球的描边，环就贴在轮廓上 */
  width: calc(100% + 4px);
  height: calc(100% + 4px);
  pointer-events: none;
}

.mc-ring-track,
.mc-ring-fill {
  fill: none;
  stroke-width: 2.2;
}

.mc-ring-track {
  stroke: color-mix(in srgb, currentColor 18%, transparent);
}

.mc-ring-fill {
  stroke: currentColor;
  stroke-linecap: round;
  stroke-dasharray: 138.23;
  /* 初值 = 整圈不画（offset = 周长）；挂载时 onFrameProgress 会立刻写真实值 */
  stroke-dashoffset: 138.23;
}

/* ── 均衡器图标：播放时才跳 ──
 * ★ 用 animation-play-state 而不是 v-if 换两个图标：
 *   暂停瞬间动画停在当前位置，再播放时接着跳 —— 不会「清零重来」那一下抖动。
 * ★ transform-box: fill-box 是 SVG 小矩形能绕**自己**中心缩放的关键，
 *   否则 transform-origin 会按整个 viewBox 解析，柱子会横着飞出去。 */
.mc-eq {
  width: 18px;
  height: 18px;
}

.mc-eq-bar {
  fill: currentColor;
  transform-box: fill-box;
  transform-origin: center;
  animation: mc-eq 0.9s var(--ease) infinite alternate;
  animation-play-state: paused;
  transform: scaleY(0.55);
}

.music-ball.is-playing .mc-eq-bar {
  animation-play-state: running;
}

.mc-eq-bar:nth-child(2) {
  animation-delay: 0.15s;
}

.mc-eq-bar:nth-child(3) {
  animation-delay: 0.3s;
}

@keyframes mc-eq {
  from {
    transform: scaleY(0.42);
  }
  to {
    transform: scaleY(1);
  }
}

/* 缓冲转圈（与胶囊里的 .mb-spinner 同一做法，不用额外元素/图标） */
.mc-spinner {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, currentColor 28%, transparent);
  border-top-color: currentColor;
  animation: mc-spin 0.8s linear infinite;
}

@keyframes mc-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ==================== 面板 ====================
 * ★ 绝对定位贴着球的上沿（bottom: 100%），从右下角放大展开。
 * ★ 收起态用 visibility: hidden + pointer-events: none，再配 inert
 *   （模板里那行）—— 三重保证「收起的面板不进 Tab、不可点、不可读屏」。
 * ★ 投影用中性黑：蓝底页面上深蓝投影会糊成一团。 */
.mc-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 0.7rem);
  width: min(21rem, calc(100vw - 2.5rem));
  padding: 0.75rem 0.8rem 0.6rem;
  border: 2px solid var(--mc-edge);
  border-radius: 16px;
  background-color: var(--mc-bg);
  color: var(--brand);
  box-shadow: 0 14px 34px rgb(0 0 0 / 22%);
  transform-origin: 100% 100%;
  opacity: 0;
  visibility: hidden;
  pointer-events: none;
  transform: translateY(0.4rem) scale(0.96);
  transition:
    opacity 0.28s var(--ease),
    transform 0.28s var(--ease),
    visibility 0.28s var(--ease);
}

.music-ball.is-open .mc-panel {
  opacity: 1;
  visibility: visible;
  pointer-events: auto;
  transform: none;
}

.mc-head {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
}

.mc-info {
  min-width: 0;
  flex: 1;
}

.mc-title {
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.35;
  /* 长曲名最多两行，超出打点 —— 面板宽度固定，不能让它把面板撑高多少 */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.mc-meta {
  margin-top: 0.15rem;
  font-size: 0.6875rem;
  line-height: 1.4;
  color: var(--mc-muted);
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
}

.mc-close {
  display: grid;
  place-items: center;
  flex: none;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  color: inherit;
  cursor: pointer;
  transition: background-color 0.2s var(--ease);
}

.mc-close:hover {
  background-color: color-mix(in srgb, currentColor 12%, transparent);
}

.mc-close svg {
  width: 13px;
  height: 13px;
}

/* ── 进度条（细轨，画法与 .mb-* 一致）── */
.mc-scrub {
  position: relative;
  height: 12px;
  margin-top: 0.5rem;
  display: flex;
  align-items: center;
}

.mc-track {
  position: relative;
  width: 100%;
  height: 3px;
  border-radius: 999px;
  background: var(--mc-track);
}

.mc-track-fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--brand);
  transform: scaleX(0);
  transform-origin: left center;
  will-change: transform;
}

.mc-thumb {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  margin-left: -4.5px;
  border-radius: 50%;
  background: var(--brand);
  transform: translateY(-50%) scale(0);
  transition: transform 0.2s var(--ease);
  pointer-events: none;
}

.mc-scrub:hover .mc-thumb,
.mc-scrub:focus-within .mc-thumb {
  transform: translateY(-50%) scale(1);
}

.mc-scrub-input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
  appearance: none;
  background: none;
}

.mc-scrub-input::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
}

/* ── 第三行：时间 / 走带键 / 静音 ── */
.mc-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-top: 0.35rem;
}

.mc-time {
  flex: 1;
  font-size: 0.6875rem;
  font-variant-numeric: tabular-nums;
  color: var(--mc-muted);
  white-space: nowrap;
}

.mc-controls {
  display: flex;
  align-items: center;
  gap: 0.15rem;
}

.mc-btn {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  color: inherit;
  cursor: pointer;
  transition: background-color 0.2s var(--ease);
}

.mc-btn svg {
  width: 13px;
  height: 13px;
}

.mc-btn:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--brand) 14%, transparent);
}

.mc-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

/* 播放键：整块面板唯一的实心圆（与胶囊里的重心一致） */
.mc-btn-play {
  width: 30px;
  height: 30px;
  background-color: var(--brand);
  color: var(--text);
}

.mc-btn-play svg {
  width: 15px;
  height: 15px;
}

.mc-btn-play:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--brand) 84%, #000);
}

.mc-icon {
  display: grid;
  place-items: center;
  flex: none;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  color: inherit;
  cursor: pointer;
  transition: background-color 0.2s var(--ease);
}

.mc-icon svg {
  width: 14px;
  height: 14px;
}

.mc-icon:hover {
  background-color: color-mix(in srgb, var(--brand) 14%, transparent);
}

.mc-btn:focus-visible,
.mc-icon:focus-visible,
.mc-close:focus-visible,
.mc-item:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 1px;
}

/* ── 曲目列表 ── */
.mc-list {
  display: flex;
  flex-flow: column;
  gap: 1px;
  margin-top: 0.4rem;
  border-top: 1px solid color-mix(in srgb, var(--brand) 16%, transparent);
  padding-top: 0.35rem;
}

.mc-item {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  width: 100%;
  padding: 0.3rem 0.35rem;
  border: 0;
  border-radius: 8px;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.2s var(--ease);
}

.mc-item:hover {
  background-color: color-mix(in srgb, var(--brand) 10%, transparent);
}

/* ★ 当前曲用**字重 + 颜色**而不是换底色：hover 也会换底色，
   两者叠在一起就分不清「鼠标在这」还是「正在放这首」。 */
.mc-item.is-current {
  color: var(--brand);
}

.mc-item-index {
  flex: none;
  font-size: 0.625rem;
  font-variant-numeric: tabular-nums;
  color: var(--mc-muted);
}

.mc-item.is-current .mc-item-index {
  color: inherit;
}

.mc-item-body {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-flow: column;
}

.mc-item-title {
  font-size: 0.75rem;
  line-height: 1.3;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mc-item.is-current .mc-item-title {
  font-weight: 600;
}

.mc-item-sub {
  font-size: 0.625rem;
  line-height: 1.3;
  color: var(--mc-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 正在播放的那一首右侧的三根小柱（纯装饰） */
.mc-item-live {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 11px;
}

.mc-item-live i {
  width: 2px;
  height: 100%;
  border-radius: 1px;
  background: currentColor;
  transform-origin: bottom center;
  animation: mc-live 0.8s var(--ease) infinite alternate;
}

.mc-item-live i:nth-child(2) {
  animation-delay: 0.2s;
}

.mc-item-live i:nth-child(3) {
  animation-delay: 0.4s;
}

@keyframes mc-live {
  from {
    transform: scaleY(0.35);
  }
  to {
    transform: scaleY(1);
  }
}

/* ==================== 窄屏 ====================
 * ★ 球缩到 48px、贴角 1rem —— 与首页窄屏那颗固定圆钮（.mb-shell 的
 *   ≤767px 形态）**同一尺寸与边距**，这样「首页右下角」与「其他页右下角」
 *   是同一个东西的手感。 */
@media (max-width: 767px) {
  .music-ball {
    right: 1rem;
    bottom: 1rem;
  }

  .mc-ball {
    width: 48px;
    height: 48px;
  }

  .mc-eq {
    width: 16px;
    height: 16px;
  }
}

/* ==================== 无障碍：不吃动效 ==================== */
@media (prefers-reduced-motion: reduce) {
  .mc-ball,
  .mc-panel,
  .mc-item,
  .mc-btn,
  .mc-icon,
  .mc-close {
    transition-duration: 0.01ms;
  }

  .mc-eq-bar,
  .mc-item-live i,
  .mc-spinner {
    animation: none;
  }
}
</style>
