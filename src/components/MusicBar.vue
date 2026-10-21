<script setup lang="ts">
/**
 * MusicBar —— hero 大字下方的音乐播放器
 *
 * ── 它现在是什么 ──
 *   播放 `src/playlist.ts` 里列出的歌（网易云音乐，音频字节由自建端点
 *   `workers/api/` 转发 —— 仓库里没有任何音频文件），所以界面上显示的是
 *   **每首歌自己的**标题、艺术家、专辑与时长，而不是一段写死的文案。
 *
 * ── 播放器结构（两行）──
 *   行 1  [⏮] [▶/⏸] [⏭]   0:00 / 0:32          [静音] [列表开关]
 *         （曲名/艺术家/专辑已移入下方抽屉；音量只剩静音开关 —— 滑杆已删除）
 *   行 2  ──────●─────────────────────────────  可拖动唱片纹/进度条
 *   （轨道的宽度上限 = 左栏可用宽，见 HomeView 里 .hero-music 的推导）
 *
 * ── 行 2 只有一种形态：细轨 ──
 *   两个 div 自己画的 3px 轨道 + 播放头，透明 range 接全部交互。
 *   ★ 2026-10-07 曾用 wavesurfer.js 画过真实波形（细轨淡出、指针交给它做
 *     dragToSeek），同日用户看过效果后要求撤掉 —— 代码与依赖都已移除。
 *     想加回来的完整配方（动态 import 的理由、与 player.ts 的三条边界、
 *     踩过的坑）留在 `AGENTS.md` §5.7 的「历史：真实波形（已撤）」段。
 *
 * ── 为什么进度条不用 `<input type="range">` 直接表现 ──
 *   range 的原生轨道无法表达「已播放部分」的填充色（那是浏览器的私有绘制），
 *   各家浏览器差异也大。所以视觉层用两个 div 自己画（fill + thumb），
 *   上面盖一个 **透明度为 0 的原生 range** 承接全部交互 ——
 *   拖动、点击跳转、键盘 ←/→、无障碍语义都免费拿到。
 *
 * ── 进度更新为什么是 transform 而不是 width ──
 *   `width` 会触发布局（layout），每帧一次在 hero 这种大页面上有成本；
 *   `transform: scaleX()` 只走合成层。这里用 scaleX 并让它左端固定。
 *   ★ 因此不能给轨道加 `overflow: hidden` 之外的裁剪 —— 圆头靠 fill 自身
 *     的 border-radius 不可能做（缩放会把圆角也拉扁），所以改用
 *     「轨道圆头 + fill 方头」的折中，视觉上被 thumb 与轨道圆头盖住。
 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
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
  volume,
} from '@/composables/player'

/** 拖动进度时用**本地**比例预览，松手才真正 seek（避免每个像素触发一次跳转解码） */
const dragRatio = ref<number | null>(null)
const showList = ref(false)

const shownProgress = computed(() => (dragRatio.value != null ? dragRatio.value : progress.value))
const buffering = computed(() => status.value === 'loading')

/* ── 进度条视觉层：逐帧直接写 DOM，不走 Vue 的 :style 绑定 ──
 * ★ 为什么不用 `:style`：进度比例每帧都在变，一旦进响应式，播放时就是每秒
 *   60 次整块组件重渲染（这正是 player 里 `currentTime` 被压成整秒的原因）。
 *   改成 player 的 rAF 通道把比例推过来，这里只写两个属性：
 *     .mb-track-fill → transform: scaleX()  —— 合成层，不触发布局
 *     .mb-thumb      → left                 —— 9px 的小元素，重排仅限 .mb-track
 * ★ 两者必须**一起**逐帧写：只让填充条丝滑、手柄却按秒跳，看起来就是一个在滑、
 *   一个在蹦。反过来，只要有一个还原成 :style 绑定，台阶感就会回来。
 * ★ 手柄为什么不用 transform 位移：`translateX(%)` 的百分比是相对**自身**宽度
 *   （9px）解析的，没法用它表示「走到轨道的 37%」；而 .mb-track 不设
 *   overflow:hidden（圆头与手柄要探出边缘），也就不能用全宽包裹层 + translate。 */
const fillEl = ref<HTMLElement | null>(null)
const thumbEl = ref<HTMLElement | null>(null)

const metaLine = computed(() => {
  const t = current.value
  if (!t) return ''
  const bits = [t.artist]
  if (t.album) bits.push(t.album)
  if (t.year) bits.push(t.year)
  return bits.join(' · ')
})

/** 音质行（kbps / 采样率 / 声道）**已删除**。
 *  ★ 2026-09-25 用户要求去掉：「hover 展示出来纯多余，而且会造成元素重叠」。
 *    实测那行确实有害：hover 时外壳从 58px 撑到 69px，把进度条 band 挤到
 *    .mb-meta 的底边上；而且码率 / 采样率这类是「文件属性」，
 *    不是听音乐时想看的东西（时长已经在进度条上表达）。
 *  ★ 元数据本身仍然重要 —— 它决定曲名、艺术家、专辑、年份、时长与列表内容，
 *    只是那些技术参数（码率/采样率）不再摆到界面上。
 *    现在这份元数据是**手写**在 `src/playlist.ts` 里的（不再从 ID3 解析）。 */

/* ── 进度条交互 ── */
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
  /* ★ 键盘（←/→）只派发 input、**不派发** pointerdown：不能因为 dragRatio 为 null
     就把事件丢掉 —— 旧写法导致键盘完全改不了进度（只有鼠标拖过才生效）。
     第一个 input 补一次 beginScrub，语义仍是「拖动开始 → 松手才 seek」；
     键盘操作结束后浏览器会补一个 change，走 onScrubEnd。 */
  if (dragRatio.value == null) beginScrub(r)
  dragRatio.value = r
  updateScrub(r)
}
function onScrubEnd() {
  if (dragRatio.value == null) return
  dragRatio.value = null
  endScrub()
}

/* ── 逐帧画进度条 ──
 * ★ 相同比例直接跳过：暂停时 rAF 仍在跑，但 `audio.currentTime` 不变，
 *   没必要每帧重复写一次同样的样式字符串。
 * ★ 拖动中的预览也走这条通道（player 的 visualRatio() 在 scrubbing 非空时
 *   优先返回拖动比例），所以「手指拖到哪、条就画到哪」与「播放时逐帧前进」
 *   是同一段代码，不会出现两套逻辑各画一半。 */
let lastPainted = -1
function paintFrame(ratio: number): void {
  if (ratio === lastPainted) return
  lastPainted = ratio
  if (fillEl.value) fillEl.value.style.transform = `scaleX(${ratio})`
  if (thumbEl.value) thumbEl.value.style.left = `${ratio * 100}%`
}

let stopFrame: (() => void) | null = null
onMounted(() => {
  // 订阅时会立刻回调一次当前值，所以挂载即画出正确位置（不必等第一帧变化）
  stopFrame = onFrameProgress(paintFrame)
})
onUnmounted(() => {
  stopFrame?.()
  stopFrame = null
})

</script>

<template>
  <div class="music-bar" data-no-float :class="{ 'is-playing': isPlaying, 'is-empty': !hasTracks }">
    <!-- 无曲目：只有一种真实原因 —— 生产构建没配 VITE_MUSIC_ENDPOINT。
         ★★ 用户 m00455：这句话也统一成兜底那一句（不再把配置指引摊给访客看）。
         配置方法留在这里备查：把 VITE_MUSIC_ENDPOINT 指向 workers/api/ 的部署地址。 -->
    <p v-if="!hasTracks" class="mb-empty">加载失败了😫</p>

    <div v-else class="mb-shell">
      <!-- 行 1：控件 + 当前曲目 + 时间 + 音量 -->
      <div class="mb-row">
        <div class="mb-controls">
          <button
            class="mb-btn"
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
            class="mb-btn mb-btn-play"
            type="button"
            :aria-label="isPlaying ? '暂停' : '播放'"
            :title="isPlaying ? '暂停' : '播放'"
            @click="toggle()"
          >
            <span v-if="buffering" class="mb-spinner" aria-hidden="true" />
            <svg v-else-if="isPlaying" viewBox="0 0 16 16" aria-hidden="true">
              <rect x="4.2" y="3" width="2.6" height="10" rx="1" fill="currentColor" />
              <rect x="9.2" y="3" width="2.6" height="10" rx="1" fill="currentColor" />
            </svg>
            <svg v-else viewBox="0 0 16 16" aria-hidden="true">
              <path d="M5.4 3.2 12.4 8l-7 4.8z" fill="currentColor" />
            </svg>
          </button>

          <button
            class="mb-btn"
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

        <!-- ★ 时间挪到左侧（紧跟走带键）、列表开关挪到最右 —— 用户要求的互换。
             两者现在同属 .mb-row，右推交给 .mb-aside 的 margin-left: auto；
             不能把 auto margin 挂在开关自己身上，因为音量被容器查询隐藏后
             （display: none 的元素上 auto margin 失效）开关就会掉回时间旁边。 -->
        <span class="mb-time">
          <span class="mb-elapsed">{{ formatTime(currentTime) }}</span>
          <span class="mb-total"> / {{ formatTime(duration) }}</span>
        </span>

        <div class="mb-aside">
          <div class="mb-vol">
            <button
              class="mb-icon-btn"
              type="button"
              :aria-label="muted ? '取消静音' : '静音'"
              :title="muted ? '恢复音量' : '静音'"
              @click="toggleMute()"
            >
              <svg v-if="muted || volume === 0" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 6h2.2L8 3.6v8.8L4.7 10H2.5z" fill="currentColor" />
                <path
                  d="M10.6 6.2 13.8 9.8M13.8 6.2 10.6 9.8"
                  stroke="currentColor"
                  stroke-width="1.2"
                  fill="none"
                />
              </svg>
              <svg v-else viewBox="0 0 16 16" aria-hidden="true">
                <path d="M2.5 6h2.2L8 3.6v8.8L4.7 10H2.5z" fill="currentColor" />
                <path
                  d="M10.3 5.6a3.4 3.4 0 0 1 0 4.8"
                  stroke="currentColor"
                  stroke-width="1.2"
                  fill="none"
                />
                <path
                  d="M12.2 3.9a5.9 5.9 0 0 1 0 8.2"
                  stroke="currentColor"
                  stroke-width="1.2"
                  fill="none"
                />
              </svg>
            </button>
            <!-- ★ 音量滑杆已删除（用户要求）：「web 端很宽的情况下……也没有必要要音量
                 调节，就静音 or 正常音量就好了」。所以这里只剩一个静音切换键
                 （toggleMute 会记住静音前的音量，取消静音即恢复原音量）。
                 本组件内连带删掉：volumePercent 计算属性、onVolume 处理器、
                 以及 setVolume 的 import（player.ts 里那个导出保留，仍是它的公开 API）。 -->
          </div>

          <!-- 抽屉开关：歌名 / 歌手 / 专辑已移入下方抽屉，栏内不再挤这两行信息。
               位置在整行最右（音量之后）—— 用户要求的互换。 -->
          <button
            class="mb-now"
            type="button"
            :title="showList ? '收起曲目信息' : '展开曲目信息'"
            :aria-expanded="showList"
            aria-controls="mb-drawer"
            @click="showList = !showList"
          >
            <svg class="mb-ico" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M2.8 4.4h10.4M2.8 8h10.4M2.8 11.6h6.4"
                fill="none"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
            <span v-if="playlist.length > 1" class="mb-count">{{ playlist.length }}</span>
            <svg class="mb-chev" viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4.4 6.6 8 10.2l3.6-3.6"
                fill="none"
                stroke="currentColor"
                stroke-width="1.6"
                stroke-linecap="round"
                stroke-linejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>

      <!-- 行 2：进度条（细轨）+ 透明原生 range -->
      <div class="mb-scrub">
        <div class="mb-track" aria-hidden="true">
          <div ref="fillEl" class="mb-track-fill" />
        </div>
        <!-- ★★ 手柄是 .mb-scrub 的直接子节点（不是嵌在 .mb-track 里）：
             它的 left 百分比相对整条轨道解析（.mb-scrub 与 .mb-track 同宽）；
             唯一不能做的是放进 .mb-track-fill —— 那里面 9% 会被解析成
             「已播放那一段的 9%」，实测偏到 0.8% 处。 -->
        <div ref="thumbEl" class="mb-thumb" />
        <!-- ★ step="10" 而不是 "1"：这个 range 是 0..1000 的「千分比」，
             step=1 时按一次 ←/→ 只挪 0.1%（32 秒的曲子 = 32ms，等于没动）。
             1% 一步对指针拖动也够细（224px 轨道上 = 2.2px）。 -->
        <input
          class="mb-scrub-input"
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

    </div>

    <!-- ==================== 抽屉：歌名 / 歌手 / 专辑 + 曲目列表 ====================
     * 这些信息原本挤在栏内的曲名位（可用宽度只有 ~95px，「Midnight Study」必被
     * 截断）。挪到栏下方独立面板后曲名有整行宽度，栏里也腾出了空间。
     * ★ 展开动画交给 .mb-drawer 的 grid-template-rows 0fr → 1fr（见样式区）。 -->
    <div
      v-if="hasTracks"
      id="mb-drawer"
      class="mb-drawer"
      :class="{ 'is-open': showList }"
      :inert="showList ? undefined : true"
    >
      <div class="mb-drawer-clip">
        <div class="mb-panel">
          <p class="mb-title">{{ current?.title ?? '——' }}</p>
          <p class="mb-meta">{{ metaLine }}</p>

          <ul class="mb-list">
            <li v-for="(t, i) in playlist" :key="t.slug">
              <button
                class="mb-item"
                type="button"
                :class="{ 'is-current': i === playlist.indexOf(current!) }"
                @click="select(t.slug); showList = false"
              >
                <span class="mb-item-index">{{ String(i + 1).padStart(2, '0') }}</span>
                <span class="mb-item-title">{{ t.title }}</span>
                <span class="mb-item-artist">{{ t.artist }}</span>
                <span class="mb-item-time">{{ formatTime(t.duration) }}</span>
              </button>
            </li>
          </ul>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* ==================== 可过渡的颜色变量（@property 注册）====================
 * ★★ 未注册的自定义属性是**离散**的：交替播放态时它们「啪」一下换值，
 *   于是整块栏看起来是「一半在渐变、一半在跳」——
 *     外壳底色   0.35s 平滑渐变 ✔
 *     轨道底色   var(--mb-track) 瞬间跳 ✘
 *     填充条     var(--mb-fill)  瞬间跳 ✘
 *     外壳描边   var(--mb-edge)  瞬间跳 ✘
 *   注册成 <color> 之后它们才能参与 transition。
 * ★ inherits: true 必须写 —— 这三个值都定义在 .mb-shell 上，
 *   要靠继承流到 .mb-track / .mb-track-fill / 描边上去。
 * ★ initial-value 给的是合法占位色（两个播放态里都会被立刻覆盖），
 *   但**语法不合法会让整条 @property 规则失效**，进而静默退回「跳变」，
 *   所以这里必须给真颜色、不能省。 */
@property --mb-track {
  syntax: '<color>';
  inherits: true;
  initial-value: transparent;
}
@property --mb-fill {
  syntax: '<color>';
  inherits: true;
  initial-value: transparent;
}
@property --mb-edge {
  syntax: '<color>';
  inherits: true;
  initial-value: transparent;
}
/* ★★ 45° 擦除的分界位置（0% = 左上角、100% = 右下角，都在本元素的 135deg 渐变轴上）。
 *   为什么必须注册：渐变里的色标位置**本身不可插值**，只有把这条自定义属性注册成
 *   <percentage> 才有「数值型」中间态，`--mb-wipe 0% → 105%` 才能被 transition
 *   逐帧插值 —— 否则它和别的未注册属性一样是**离散**的，只会「啪」地跳过去。
 *   ★ 两端刻意越过 0 / 100：idle 给 -5%、playing 给 105%，
 *     这样分界线连同它那 4% 的软边都完全落在元素之外 ——
 *     既不会在静止态的四角漏出一道蓝边，也不会在铺满后留下没盖到的角。
 *   ★ inherits: false：外壳与抽屉面板各擦各的（面板自己也要声明一份值）。
 *   ★ 语法写错会让整条规则失效并静默退回跳变（同上面三条颜色属性）。 */
@property --mb-wipe {
  syntax: '<percentage>';
  inherits: false;
  initial-value: -5%;
}

/* ==================== 容器 ====================
 * ★ container-type: inline-size —— 「放不下时降级」必须看**自己的实际宽度**，
 *   不能看视口：栏宽 = --brand-h × 0.734 × 1.05，而 --brand-h 同时取决于
 *   视口的宽与高（见 HomeView 的推导）。同一个 1024px 视口，高屏与矮屏
 *   算出来的栏宽不同，媒体查询判断不了。
 *
 * ★★ container-name: music —— 名字是为了**把意图钉死**，不是修 bug。
 *   本组件的降级规则必须比「这一条栏」的宽度；不写名字时，`@container`
 *   会去比 DOM 里**最近**的容器查询容器 —— 现在恰好就是 .music-bar 自己
 *   （所以不加名字也能工作），但只要将来有任何一个中间层加上
 *   container-type，比较对象就会悄悄换成它，而且不会报错。
 *   注意区分：祖先 <section class="hero"> 有 container-type: size
 *   （为了让 cqh 生效），但 .music-bar 在它里面、离 .mb-vol 更近，
 *   所以自己起的这个名字是有效的。
 *   ★ 曾经把「215px 断点不生效」误判成容器选错，其实是精度问题
 *     （@container 判 222.85px、rect 量 222.72px，差 0.13px），
 *     详见下方降级规则处的注释。 */
.music-bar {
  container-type: inline-size;
  container-name: music;
  width: 100%;
  min-width: 0;
}

.mb-shell {
  /* 行高与控件尺寸 —— 行高、抽屉让位都从它们推出来，改一处即整体联动 */
  --mb-pad: 5px;
  --mb-btn: 28px;
  /* ★ `--mb-h`（= btn + pad*2）已于 2026-10-08 大清洗删除：零读取，
     真正的行高由内容（按钮 + 行间距）自然撑开。 */
  /* ★★ 描边色：淡灰，与底色无关。
     关闭态底色是米色、播放态是半透明蓝，淡灰在两者上都看得见轮廓。 */
  --mb-edge: color-mix(in srgb, var(--text) 42%, transparent);
  /* 轨道色：与外壳底色同族但更暗一点，保证在米色底上可辨 */
  --mb-track: color-mix(in srgb, var(--brand) 18%, transparent);
  --mb-fill: var(--brand);

  display: flex;
  flex-direction: column;
  gap: 4px;
  /* ★★ 与抽屉拼成一体的关键：.mb-drawer 用负上边距咬进本元素底部 14px，
     这里必须把外壳压在上层，否则抽屉的顶边（连同它自己的 2px 描边）
     会盖住外壳的下描边，接缝处就变成「两条线」而不是「一块整体的下沿」。 */
  position: relative;
  z-index: 1;
  padding: calc(var(--mb-pad) - 1px) calc(var(--mb-pad) + 1px); /* 横向 padding 原为 pad+2，描边由 1px 加粗到 2px 后各减 1px 抵掉 */
  border-radius: 14px;
  border: 2px solid var(--mb-edge);
  background-color: color-mix(in srgb, var(--text) 92%, transparent);
  color: var(--brand);
  /* ★★ 45° 擦除层：底色本身不换，播放态的蓝**全靠这一层**从左上角铺过来。
     135deg 的渐变轴：0% = 左上角，100% = 右下角；`--mb-wipe` 就是分界线在轴上的位置。
     软边写在「分界线前 4%」：`ink 0 (wipe-4%)` → `transparent wipe`，
     于是分界线到达前有一小段过渡，不是一条刀切的硬边。
     ★ 两个端点值刻意越界（见 @property --mb-wipe）：-5% 时 ink 段被压到 0 之前，
       整层完全不落笔（静止态四角干净）；105% 时软边跑到 100% 之后，铺满无缺角。
     ★ --mb-wipe-ink 独立成变量是为了窄屏能换一份蓝度（见 @media 窄屏块）。 */
  --mb-wipe: -5%;
  --mb-wipe-ink: color-mix(in srgb, var(--brand) 88%, transparent);
  background-image: linear-gradient(
    135deg,
    var(--mb-wipe-ink) 0 calc(var(--mb-wipe) - 4%),
    transparent var(--mb-wipe)
  );
  background-repeat: no-repeat;
  /* ★ 三条自定义属性必须一起列进来：只写 background-color / color 的话，
     轨道与填充条的颜色会绕开这条过渡、直接跳变（见文件顶部 @property 说明）。
     时间函数刻意与外壳底色一致，整块栏才是「一起」变色而不是接力。
     ★ `--mb-wipe` 给 0.45s：擦除是这一下子的主角。
     ★ 换色 (`color`) 也写 0.45s + 同一条 `var(--ease)`，刻意与擦除同长同曲线：
       分界线是 45° 斜的，扫过左边控件、时间、右边开关的时刻并不相同（实测各点差 300ms 上下），
       而 color 只有一条 transition、不可能逐元素同步 —— 既然同步不了，就让「换色进度」≈「擦除进度」：
       被擦过的地方，文字是「半漂白」的中间色（对蓝底和米底都还看得见），
       而不是纯蓝字死死压在蓝底上；两端又刚好同时到站（wipe 105% ↔ 米色）。
       （曾用「0.26s + 0.1s 延迟」：实测 wipe 36% 时文字还是纯蓝、在蓝区里几乎看不见，故改等长。） */
  transition:
    --mb-wipe 0.45s var(--ease),
    background-color 0.35s var(--ease),
    color 0.45s var(--ease),
    --mb-track 0.35s var(--ease),
    --mb-fill 0.35s var(--ease),
    --mb-edge 0.35s var(--ease);
}

/* ── 行 1 ── */
.mb-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  height: var(--mb-btn);
}

.mb-controls {
  display: flex;
  align-items: center;
  gap: 2px;
  flex: none;
}

.mb-btn {
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
  transition:
    background-color 0.2s var(--ease),
    opacity 0.2s var(--ease);
}

.mb-btn svg {
  width: 13px;
  height: 13px;
}

/* 播放键：唯一的实心圆（视觉重心）
 * ★ 它自己也有一组「播放态换色」（见下方 .is-playing 规则）：底色和图标色都要动。
 *   而 .mb-btn 的过渡列表里**根本没有 color**、时长也是 0.2s ——
 *   结果是图标色瞬间跳、且比外壳早 0.15s 到站，整块栏的变色成了接力。
 *   这里覆盖成与外壳同一条 0.35s，让它跟外壳一起呼吸。 */
.mb-btn-play {
  width: var(--mb-btn);
  height: var(--mb-btn);
  background-color: var(--brand);
  color: var(--text);
  transition:
    background-color 0.35s var(--ease),
    color 0.45s var(--ease),
    opacity 0.2s var(--ease);
}

.mb-btn-play svg {
  width: 15px;
  height: 15px;
}

.mb-btn:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--brand) 14%, transparent);
}

.mb-btn-play:hover:not(:disabled) {
  background-color: color-mix(in srgb, var(--brand) 84%, #000);
}

.mb-btn:disabled {
  opacity: 0.35;
  cursor: default;
}

.mb-btn:focus-visible,
.mb-icon-btn:focus-visible,
.mb-now:focus-visible,
.mb-item:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

/* 缓冲中的转圈（不用 SVG 动画，省一个元素） */
.mb-spinner {
  width: 13px;
  height: 13px;
  border-radius: 50%;
  border: 2px solid color-mix(in srgb, var(--text) 40%, transparent);
  border-top-color: var(--text);
  animation: mb-spin 0.75s linear infinite;
}

@keyframes mb-spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── 抽屉开关：歌名 / 歌手已移入抽屉，这里只留一个紧凑的信息键 ──
 * ★ 它原来是 flex:1 的两行文本块（曲名 + 艺术家·专辑·年份）。曲名可用的横向
 *   空间只有 ~95px（栏宽受 --brand-h 与 --visual-w 双重夹逼，见 HomeView），
 *   12.5px 时「Midnight Study」需要 92px + 计数 16px = 108px → 必被截断。
 *   信息搬进抽屉后这里只承担「开关」，宽度需求从 ~95px 降到 ~46px。 */
.mb-now {
  display: flex;
  align-items: center;
  gap: 4px;
  /* ★ flex: 0 0 auto（不缩不涨）：开关是**图标按钮**，内容一旦被压到
     比内容还窄，图标就会溢出到右侧时间上（实测 224px 栏内被压到 19.5px，
     而内容需要 ~47px）。空间不够时改由容器查询**减内容**（见文件末尾
     「窄栏降级」），而不是让按钮把自己挤变形。
     右对齐交给 .mb-aside 的 margin-left: auto。 */
  flex: 0 0 auto;
  height: 22px;
  padding: 0 5px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
  opacity: 0.72;
  transition:
    opacity 0.2s var(--ease),
    background-color 0.2s var(--ease);
}

.mb-now:hover,
.mb-now[aria-expanded='true'] {
  opacity: 1;
  background-color: color-mix(in srgb, currentColor 12%, transparent);
}

.mb-now svg {
  width: 13px;
  height: 13px;
  flex: none;
}

/* 箭头：展开时翻 180°，与抽屉滑出同拍（0.32s） */
.mb-chev {
  width: 11px;
  height: 11px;
  opacity: 0.7;
  transition: transform 0.32s var(--ease);
}

.mb-now[aria-expanded='true'] .mb-chev {
  transform: rotate(180deg);
}

/* 曲目数：只有 ≥2 首才有意义（1 首时是废话、0 首走空态）
 * ★ 不再从曲名身上割宽度了（曲名已搬走），所以从 8px 放回 9px。 */
.mb-count {
  flex: none;
  font-family: var(--font-mono);
  font-size: 9px;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

/* ── 抽屉里的曲名：终于有整行宽度，不必再为挤空间压字号 ── */
.mb-title {
  margin: 0;
  font-family: var(--font-body);
  font-size: 12.5px;
  font-weight: 600;
  line-height: 1.3;
}

.mb-title,
.mb-meta {
  display: block;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mb-meta {
  display: block;
  width: 100%;
  margin: 2px 0 0;
  font-family: var(--font-mono);
  font-size: 9.5px;
  letter-spacing: 0.02em;
  opacity: 0.62;
  line-height: 1.2;
}

/* ── 右侧：音量 + 曲目开关 ──
 * ★ 开关（.mb-now）**放在这里最右**：它原来是独立一格、夹在时间与音量之间，
 *   现在整行是 [controls] [时间] [音量 开关]，所以「贴右」这条 auto margin
 *   必须挂在本容器上，不能挂开关自己 —— 音量被容器查询隐掉时，
 *   display:none 元素上的 auto margin 会失效，开关就掉回时间旁边了。 */
.mb-aside {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
  /* ★ 时间/音量永远贴右：开关改成不涨的图标按钮后，行内富余空间
     没有人吸了，靠这条把它推到底。 */
  margin-left: auto;
}

/* 时间：**始终**显示「已播 / 总时长」，没有 hover 展开。
 *  ★ 曾经把总时长做成 hover 才露出（想省宽给曲名），已回退 ——
 *    用户要的是「一眼看到还剩多久」，藏起来反而要靠鼠标去问。
 *    腾宽改由别处解决：音量键常驻、音质行整行删除、标题 11.5px。 */
.mb-time {
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.75;
  white-space: nowrap;
}

.mb-total {
  opacity: 0.72;
}

.mb-vol {
  display: flex;
  align-items: center;
}

.mb-icon-btn {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: none;
  color: inherit;
  cursor: pointer;
  opacity: 0.72;
  transition: opacity 0.2s var(--ease);
}

.mb-icon-btn:hover {
  opacity: 1;
}

.mb-icon-btn svg {
  width: 13px;
  height: 13px;
}

/* ★ 音量滑杆的样式（.mb-vol-range 本体、:hover 展开、两个 ::-*-slider-thumb）
   已随滑杆一起删除 —— 见模板里 .mb-vol 处的注释。 */

/* 行 2：进度条（细轨）
 * ★ 高度 8px（原来是 12px）：这个 band 的高度是纯让位空间，
 *   实测 hover 展开音质行时它紧贴 .mb-meta 的底边（视觉上「顶到字上」）。
 *   缩到 8px 再给点 margin-top，bar 整体高度不变（行高由 .mb-row 决定）。 */
.mb-scrub {
  position: relative;
  height: 8px;
  margin-top: 1px;
  display: flex;
  align-items: center;
}

.mb-track {
  position: relative;
  width: 100%;
  height: 3px;
  border-radius: 999px;
  background: var(--mb-track);
}


/* ★ transform: scaleX() 而不是改 width：scale 只走合成层，不触发布局。
   transform-origin 默认 50% 会从中点缩放，必须改成左侧。
   ★ 初值 scaleX(0)：比例现在由 JS 逐帧直接写入（见 script 里 fillEl 的说明），
     不再是 Vue 的 :style 绑定。留一个「空」的初值，避免挂载那一帧
     在 JS 写进来之前闪出满格进度条。 */
.mb-track-fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background: var(--mb-fill);
  transform: scaleX(0);
  transform-origin: left center;
  will-change: transform;
}

.mb-thumb {
  position: absolute;
  top: 50%;
  width: 9px;
  height: 9px;
  margin-left: -4.5px;
  border-radius: 50%;
  /* ★ 用 --mb-fill 而不是写死 --brand：播放态外壳被擦成蓝底，填充色会翻成米色，
     播放头必须跟着翻，否则蓝底上留一个蓝点（看不见）。 */
  background: var(--mb-fill);
  transform: translateY(-50%) scale(0);
  transition: transform 0.2s var(--ease);
  pointer-events: none;
}

.mb-scrub:hover .mb-thumb,
.mb-scrub:focus-within .mb-thumb {
  transform: translateY(-50%) scale(1);
}


/* 透明原生 range 铺满整行承接交互（拖动、点击、键盘、无障碍） */
.mb-scrub-input {
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

.mb-scrub-input::-webkit-slider-thumb {
  appearance: none;
  width: 14px;
  height: 14px;
}

/* ==================== 抽屉：栏下方的信息 / 曲目面板 ====================
 * ★ 展开动画用 `grid-template-rows: 0fr → 1fr`，而不是 max-height：
 *   max-height 要猜一个上界，猜小了内容被裁、猜大了动画前半段在空跑
 *   （视觉上前半程「不动」）。0fr→1fr 是真正的高度自动过渡。
 *   ★ 直接子元素（.mb-drawer-clip）必须 `overflow: hidden` + `min-height: 0`，
 *     否则 0fr 压不到 0（grid 项默认 min-height: auto，内容会把它顶开）。
 * ★ 抽屉是 .mb-shell 的**兄弟**节点，拿不到定义在 .mb-shell 上的自定义属性，
 *   所以 --mb-edge / --mb-track 在这里重新声明一份。@property 已注册（见文件
 *   顶部），这两个变量同样可过渡，所以播放态切换时抽屉内不会「啪」地跳色。
 * ★ 宽度刻意比音乐栏窄 16px 并居中：这样它是「从栏下方抽出来的抽屉」，
 *   而不是「第二块同宽的栏」。 */
.mb-drawer {
  --mb-edge: color-mix(in srgb, var(--text) 42%, transparent);
  --mb-track: color-mix(in srgb, var(--brand) 18%, transparent);

  display: grid;
  grid-template-rows: 0fr;
  width: calc(100% - 16px);
  /* ★★ 往上咬进音乐栏 14px，抽屉就是「从栏底下抽出来」而不是「栏下方的另一块」：
     负上边距把抽屉的盒子提到栏的内部，配合 .mb-shell 的 z-index: 1，
     抽屉的顶边（连同它的 2px 描边与圆角）整段藏在栏后面 —— 两块 div 在视觉上
     拼成一体，接缝处只剩栏自己的下描边，既没有缝也没有双线。
     ★ 14 ≥ 面板圆角 12：圆角必须整段被盖住，露出一点点就会变成小台阶。
     ★ 关闭态 grid-template-rows: 0fr + overflow: hidden，这 14px 不显示也不占位。 */
  margin: -14px auto 0;
  position: relative;
  z-index: 0; /* 必须低于 .mb-shell，否则抽屉会盖住栏的下描边 */
  opacity: 0;
  transform: translateY(-5px);
  pointer-events: none;
  transition:
    grid-template-rows 0.32s var(--ease),
    opacity 0.24s var(--ease),
    transform 0.32s var(--ease),
    --mb-track 0.35s var(--ease),
    --mb-edge 0.35s var(--ease);
}

.music-bar.is-playing .mb-drawer {
  --mb-edge: color-mix(in srgb, var(--text) 40%, transparent);
  --mb-track: color-mix(in srgb, var(--text) 26%, transparent);
}

.mb-drawer.is-open {
  grid-template-rows: 1fr;
  opacity: 1;
  transform: translateY(0);
  pointer-events: auto;
}

.mb-drawer-clip {
  overflow: hidden;
  min-height: 0;
}

/* 面板本体：与 .mb-shell 同一套配色（关闭态米底蓝字、播放态蓝底米字），
 * 同样走 45° 擦除、同样**不换 background-color** —— 两份擦除各自独立
 * （`--mb-wipe` 是 inherits:false，面板这份要自己声明、自己进 transition），
 * 于是外壳与抽屉是**同向、同时**扫过去的，不会一个淡一个扫。 */
.mb-panel {
  margin-top: 0; /* ★ 0：抽屉整体已被负上边距提进栏内，这里再留边距就又拉开缝了 */
  /* ★ padding-top = 23px 里含「重叠补偿」：抽屉被 -14px 提进栏内，面板顶边连同
     2px 描边整段藏在外壳后面，内容盒若只留 7px 就会被外壳下沿切掉字顶
     （实测标题框顶部落在接缝上方 5.54px，肉眼可见被削平）。
     23 = 7（原本的视觉留白）+ 14（被吃掉的重叠）+ 2（藏起来的描边），
     于是标题仍在接缝下方约 11px 处，和改造前观感一致。
     侧、下各 -1px 是为了抵掉描边由 1px 加粗到 2px 多出来的那一圈。 */
  padding: 23px 9px 6px;
  border: 2px solid var(--mb-edge);
  /* ★ 上两角方形、只圆下两角：顶边藏在栏后面（本来就看不见），
     万一对不齐也只露出直角边，不会像「另一张卡片」那样冒出圆角。 */
  border-radius: 0 0 12px 12px;
  background-color: color-mix(in srgb, var(--text) 92%, transparent);
  color: var(--brand);
  --mb-wipe: -5%;
  --mb-wipe-ink: color-mix(in srgb, var(--brand) 88%, transparent);
  background-image: linear-gradient(
    135deg,
    var(--mb-wipe-ink) 0 calc(var(--mb-wipe) - 4%),
    transparent var(--mb-wipe)
  );
  background-repeat: no-repeat;
  transition:
    --mb-wipe 0.45s var(--ease),
    background-color 0.35s var(--ease),
    color 0.45s var(--ease),
    --mb-track 0.35s var(--ease),
    --mb-edge 0.35s var(--ease);
}

.music-bar.is-playing .mb-panel {
  --mb-wipe: 105%;
  color: var(--text);
}

/* ── 曲目列表（在抽屉面板内） ── */
.mb-list {
  list-style: none;
  margin: 7px 0 0;
  padding: 7px 0 0;
  /* ★ 分隔线用 --mb-track 而不是硬编码的 color-mix：播放态它会一起过渡 */
  border-top: 1px solid var(--mb-track);
  max-height: 11rem;
  overflow-y: auto;
}

.mb-item {
  display: grid;
  grid-template-columns: 1.6rem minmax(0, 1fr) auto;
  grid-template-areas:
    'no title time'
    'no artist time';
  align-items: center;
  gap: 0 6px;
  width: 100%;
  padding: 3px 4px;
  border: 0;
  border-radius: 6px;
  background: none;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

/* ★ hover / 当前曲用 currentColor 而不是 var(--brand)：
 *   播放态面板是蓝底米字，固定用品牌蓝做高亮等于「蓝上加蓝」、几乎看不见。
 *   用 currentColor 则自动跟随文字色（关闭态蓝、播放态米）。 */
.mb-item:hover {
  background-color: color-mix(in srgb, currentColor 10%, transparent);
}

.mb-item.is-current {
  background-color: color-mix(in srgb, currentColor 18%, transparent);
}

.mb-item-index {
  grid-area: no;
  font-family: var(--font-mono);
  /* ★ 9px → 10px（2026-10-21）：抽屉是整行宽度，不再受 240px 胶囊的
     行内预算挤压 —— 序号 / 艺术家 / 时长没有理由比胶囊里的时间还小。 */
  font-size: 10px;
  opacity: 0.55;
}

.mb-item-title {
  grid-area: title;
  font-size: 11px;
  font-weight: 600;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mb-item-artist {
  grid-area: artist;
  font-family: var(--font-mono);
  font-size: 10px;
  opacity: 0.6;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.mb-item-time {
  grid-area: time;
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  opacity: 0.6;
}

.mb-empty {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text);
  opacity: 0.75;
}

.mb-empty code {
  font-family: var(--font-mono);
  font-size: 10px;
}

/* ==================== 播放态：蓝色 45° 擦入 ====================
 * ★★ 这里**刻意不再改 background-color** —— 蓝色的来源只有一个，就是上面那层
 *   135deg 渐变的擦除（`--mb-wipe` 从 -5% 走到 105%）。
 *   如果这里再写一条 `background-color: 半透明蓝`，整块壳会在 0.35s 里**淡**成蓝，
 *   擦除就被盖在底下看不出来了 —— 那是「淡入」，不是用户要的「扫过」。
 * ★ 蓝色退回的方向由 `--mb-wipe` 回退自然给出：分界线从右下角往左上角收，
 *   于是米色从**右下角**铺回来 —— 正好是「停止时右下角 45°」。
 * ★ 其余三条（轨道/填充/描边）仍在这里改写，它们靠 @property 注册才可过渡。 */
.music-bar.is-playing .mb-shell {
  --mb-wipe: 105%;
  color: var(--text);
  --mb-track: color-mix(in srgb, var(--text) 26%, transparent);
  --mb-fill: var(--text);
  --mb-edge: color-mix(in srgb, var(--text) 40%, transparent);
}

.music-bar.is-playing .mb-btn-play {
  background-color: var(--text);
  color: var(--brand);
}

/* ==================== 窄栏降级（容器查询）====================
 *   降级顺序：先舍冗余信息，最后才动主信息。
 *   ★★ 必须写 `@container music (…)` —— 名字不能省。
 *      本页 <section class="hero"> 也是容器（container-type: size，为了 cqh），
 *      不带名字的 @container 会去比**hero 的宽度**而不是本栏的宽度，
 *      于是这三条规则永远不会命中（详见上方 .music-bar 的注释）。
 *   ★★ 断点是按**真实量测**定的，不是拍的。实测本栏宽度：
 *        1440×900 → 294.4px、1440×807 → 258.6px、1440×714 → 222.7px
 *      （栏宽 = min(内容高的一半, 宽度公式)，所以纯靠拉高窗口不会让它更宽，
 *        宽度完全由 `--brand-h` 决定）。
 *   ★★ 量测方法上有个坑要记住：`@container` 判据里的宽度比
 *      `getBoundingClientRect().width` **大 0.13px**（二分实测 222.85 vs
 *      222.72）。原因是栏宽 = `calc(--brand-h × 0.734 × 1.05)` 这种
 *      多级 calc 在布局引擎里保留更高精度，而 rect 已经过 rounding。
 *      后果：断点若贴着真实宽度就会「差 0.1px 不命中」——这正是当初
 *      215px 在 222.7px 的栏上不生效的原因（不是 bug、是精度）。
 *      所以断点两侧都要留出 > 1px 的空隙，不要把阈值写成量测值本身。
 *   < 252px  开关只留列表图标（收起曲目数与箭头）
 *   < 232px  隐藏音量（音量还能靠系统音量）
 *   < 205px  时间降到 9px
 *   < 165px  按钮缩到 22px
 *   ★ 曲名与艺术家已搬进抽屉（见 .mb-drawer），不再参与栏内宽度争夺，
 *     所以这两个断点里**没有**针对它们的规则 —— 抽屉保证信息始终可读。
 *   ★ 这四条断点是按量测的行内预算定的（.mb-row 实测含量）：
 *       走带键 ~96px、时间 ~69.5px、音量 ~22px、开关全宽 ~47px、开关仅图标 ~23px。
 *     ⇒ 全宽开关需要行宽 ≥ 236.5px（对应栏宽 ≥ 252px），
 *       仅图标开关需要 ≥ 212.5px（对应栏宽 ≥ 228px），
 *       再隐音量则只要 ≥ 188.5px。
 *     开关本身是 `flex: 0 0 auto`（绝不压缩），所以空间不够时**必须**
 *     在这里减内容 —— 否则它会溢出到右侧时间上（224px 栏内被压到 19.5px 的旧现象）。
 *   ★ 行序改成 [controls] [时间] [音量 开关] 之后，.mb-row 的子节点从 4 个变 3 个，
 *     行内 gap 总数 18px → 12px，**比上面这张预算表松 6px** ——
 *     所以 252 / 232 两个断点照原样保留即可（阈值只会更安全，不必重测重定）。
 */
@container music (max-width: 252px) {
  .mb-count,
  .mb-chev {
    display: none;
  }
}

@container music (max-width: 232px) {
  .mb-vol {
    display: none;
  }
}

@container music (max-width: 205px) {
  .mb-time {
    font-size: 9px;
  }
}

@container music (max-width: 165px) {
  .mb-btn {
    width: 22px;
    height: 22px;
  }
}

/* ==================== 窄屏（≤767px）：侧边固定圆钮 ====================
 * ★★ 与上一版一致：窄屏只保留一个 48px 的播放/暂停圆钮，
 *   浮在右侧垂直居中。理由见 HomeView 的推导 ——
 *   Blog 在窄屏占满整宽，音乐栏没有「在文字下方铺开」的空间。
 * ★ 用 min-height: 0 + padding: 0 覆盖桌面胶囊的尺寸，否则会撑成方块。 */
@media (max-width: 767px) {
  .music-bar {
    position: static;
  }

  .music-bar .mb-shell {
    position: fixed;
    top: 50%;
    right: 1rem;
    z-index: 70;
    width: 48px;
    height: 48px;
    padding: 0;
    gap: 0;
    border-radius: 50%;
    transform: translateY(-50%);
    background-color: color-mix(in srgb, var(--text) 55%, transparent);
    /* ★ 圆钮上的蓝要淡一些（毛玻璃底），所以这里换一份擦除用的蓝，
       而不是去改 background-color —— 改底色会把擦除整个盖掉。 */
    --mb-wipe-ink: color-mix(in srgb, var(--brand) 72%, transparent);
    -webkit-backdrop-filter: blur(14px) saturate(160%);
    backdrop-filter: blur(14px) saturate(160%);
  }

  /* ★ 播放态这里**不再写 background-color**：蓝色完全由 45° 擦除层提供
     （`--mb-wipe: 105%` 那条已在全局播放态规则里给过），
     保留半透明就是为了不把 backdrop-filter 的毛玻璃盖死。 */

  /* 只留播放键，居中铺满 */
  .music-bar .mb-row {
    height: 100%;
    justify-content: center;
    gap: 0;
  }

  .music-bar .mb-controls {
    gap: 0;
  }

  /* ★ 隐藏整个抽屉（列表与信息都搬进去了），不再单独隐藏 .mb-list。
     窄屏只留 48px 圆钮，开关（.mb-now）也一并隐藏，抽屉没有入口。
     ★ .mb-time 现在是 .mb-row 的直接子节点（行序 [controls] [时间] [音量 开关]），
       不再住在 .mb-aside 里 —— 所以必须**单独点名**，否则时间会挤进 48px 圆钮里。 */
  .music-bar .mb-btn:not(.mb-btn-play),
  .music-bar .mb-now,
  .music-bar .mb-time,
  .music-bar .mb-aside,
  .music-bar .mb-scrub,
  .music-bar .mb-drawer {
    display: none;
  }

  .music-bar .mb-btn-play {
    width: 48px;
    height: 48px;
    background-color: transparent;
    color: var(--brand);
  }

  .music-bar.is-playing .mb-btn-play {
    background-color: transparent;
    color: var(--text);
  }

  .music-bar .mb-btn-play svg {
    width: 17px;
    height: 17px;
  }
}

/* ==================== 无障碍：不吃动效 ==================== */
@media (prefers-reduced-motion: reduce) {
  .mb-shell,
  .mb-btn,
  .mb-thumb,
  .mb-spinner,
  .mb-drawer,
  .mb-chev,
  .mb-panel {
    transition-duration: 0.01ms;
    /* ★ 延迟也要清：换色那条带 0.1s delay，只压时长的话「不吃动效」的用户
       仍要多等 100ms 才看到颜色变过去。 */
    transition-delay: 0s;
    animation-duration: 0.01ms;
  }
}
</style>
