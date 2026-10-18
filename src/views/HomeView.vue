<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import InitialLetter from '@/components/InitialLetter.vue'
import MusicBar from '@/components/MusicBar.vue'
import NextButton from '@/components/NextButton.vue'
import LyricStage from '@/components/LyricStage.vue'
import SoundLine from '@/components/SoundLine.vue'
import WaterBody from '@/components/WaterBody.vue'
import { animate, prefersReducedMotion, scroll, whenBooted } from '@/composables/motion'

/* ★★★ 2026-09 用户 m06383 定案：**3D 舞台与碰撞逻辑全部删除**。
 *   原来的中心舞台（HeroStage + PlcStage 的 S7-1200、滚轮驱动的下落/砸水/定格）
 *   连同它的滚轮累积（heroDrive）一并移除 —— 首页现在只有：
 *     天空渐变 + 音乐波线（遮罩）+ 水体色块/水彩 + Blog/Next 排版。
 *   ★ 用户 m06569：hero 里那行轮播小字（caption）也已删除 —— `captions` 数组、
 *     `activeCaption` 定时器、入场淡入与相关 CSS 全部一并移除。 */

/* 右下角 NEXT 已抽成公共组件（`components/NextButton.vue`），
 * 排版与其它页面共用。这里的 `.hero-next` 只负责两件事：
 *   1) 按 hero 的比例给出 `--next-cap`（其它页面走组件内兜底值）
 *   2) 布局：贴右下角 + 收回鼠标事件
 *
 * 滚动行为由组件内部处理（滚一屏，夹在可达范围内）。
 * 首页会自动退化成「滚到页面底部」—— 因为 hero 占满一屏、`maxTop`
 * 只有 186~270px，远小于一屏。观感与改动前一致。 */

/* ==================== 动效 ==================== */
/* hero 入场：Blog 巨型字缩放淡入 + 元素逐个上浮
 *
 * ★ 关键约束：不能改元素的 transform，因为布局依赖它！
 *   `.hero-brand-row` 的 align-items: flex-end 负责「log 底 = B 底」的基线对齐，
 *   `.hero-next` 靠 baseline 对齐。
 *   所以这里**只用 opacity 和 filter**，不动任何几何属性 —— 否则会把已经
 *   调好的基线对齐全部破坏掉。 */
const heroEl = ref<HTMLElement | null>(null)
let cleanupEffects: Array<() => void> = []
let safetyTimer: ReturnType<typeof setTimeout> | undefined

/** 入场动画异常时的兜底：强制恢复可见
 *
 * ★ 为什么需要它：入场是先把元素内联设为 opacity: 0，再靠 JS 动画恢复到 1。
 *   如果动画没跑起来（rAF 被浏览器挂起 / JS 报错 / 以后重构出错），
 *   这些元素会**永久不可见** —— NEXT 按钮点不到，页面看上去是坏的。
 *   宁可不做动画，也绝不能把内容留在不可见状态。
 *
 *   实测就撞到过：集成浏览器的标签页被标为 hidden，rAF 被限流到 ~1fps，
 *   回归检查里 .hero-caption / .hero-next 长时间停在 opacity 0。
 *   真实用户虽不至于卡死，但标签页在后台加载完再切回来时也会很难看。 */
function armRevealSafety(targets: Element[]) {
  clearTimeout(safetyTimer)
  safetyTimer = setTimeout(() => {
    targets.forEach((el) => {
      if (+getComputedStyle(el).opacity < 0.05) {
        ;(el as HTMLElement).style.opacity = '1'
      }
    })
  }, 3500)
}

/* ==================== 逐字母「对焦 + 下落」入场 ====================
 *
 * 用户要的效果：Blog 的 B 与 Next 的 N 先从上方缓入，然后 l/x、o/e、g/t
 * **依次**跟进 —— 从外往内飞入，且**保留**原有的「模糊 → 清晰」。
 *
 * ── 为什么位移必须加在「本来就参与排版的那个元素」上 ──
 * ★★ Blog 的「log 底 = B 底」靠 `.hero-brand-row { align-items: flex-end }`，
 *    Next 的「N 与 ext 同基线」靠 `.next { align-items: baseline }`。
 *    基线对齐算的是元素的**静态盒子**，而对元素写 `transform` **不改静态盒子** ——
 *    所以位移加在任何既有元素上都安全：字形在飞，排版基准完全静止。
 *
 *    实测（同一 fixed probe 内逐项比对，视口 1440×900）：
 *      · 把整词拆成 3 个 `<i>` 后，log 与 B 的墨迹矩形与**拆之前 0.00px 相同**；
 *      · 给其中一个 `<i>` 写 `translateY(-40px)`，它自己精确移动 40px，
 *        而 B 的盒子、兄弟字母的盒子、父级的基线**全部 0.00px 不变**。
 *    （对照：若改用 inline-block 字盒，行盒被重算，实测字盒高从 84.5px 变 168px，
 *      基线随之上移 32px —— 所以**不要**包字盒，见 splitLetters 的注释。）
 *
 * ── 位移量为什么用「百分比」──
 *    百分比的基准是**元素自身尺寸**（大小写字母差异很大便自动差异化），
 *    而且不依赖 `--brand-h` 之类的上下文变量 —— 组件在不同页面复用也不会失配。
 *
 * ── 为什么不担心「位移动画与入场/滚动动画打架」──
 *    · 父级 `.hero-brand-row` / `.next` 动画的是 `opacity` / `filter`，在**另一个元素**上；
 *    · 字母元素只被写 transform，从不与父级的 filter 争同一个属性；
 *    · 唯一需要留意的是：**不要**在字母自身上再加 transform 类的动画。
 */
/* 每个字母的下落距离，单位是**它自己墨迹高度的比例**。
 *
 * ★★ 这几个数字是按「落到眼里的行程」调的，不是按几何等比 ——
 *    第一版取了 0.3（B 走 100px、log 只走 30px），实测**大字母把小字母的位移吞掉了**。
 *    现在的配比是「大字母绝对行程大、小字母小，但都明显可见」，
 *    以及一条更重要的约束：**B 与 N 的绝对行程要拉开**，否则两个最大最抢眼的字母
 *    即使起跑时间不同，看上去仍像「一起下来」。
 *    （第二版 B/N 取 0.36/0.47 时实测 121px/78px，比值 1.55，观感上仍嫌接近。）
 *    实测行程（1440×807，--brand-h=335.5px）：B 120.8px、N 77.9px、
 *    l/o/g 34.3px、e/x/t 17.1px。 */
const FLY_UNIT: Record<string, number> = { B: 0.36, N: 0.30 }
/** 相邻字母的起跑间隔（秒）。
 *  ★★ 必须**明显大于**下落时长的一小部分，否则相邻字母的位移在时间上重叠，
 *     观感就是「一起下来的」（第一版 75ms 就是这个毛病）。
 *  ★★ 也要**明显小于**下落时长，否则最后一个字母（g / t）要等太久才开始，
 *     整段入场拖成两秒以上，显得拖沓。
 *  ★ 0.16s / 时长 0.50s 的配比 ≈ 0.32：g 起跑时 l 已落定、o 走到六成，
 *    逐个落下看得清楚，而组内跨时只有 0.48s —— 密集的敲击感，不是排队的拖沓感。
 *    （0.19s / 0.8s 那版比值 0.24 位移重叠太多，是「生硬」的一个成因；
 *      0.20s / 0.62s 那版比值 0.32、比例对但是**绝对时长偏慢**，
 *      用户反馈「速度可以快一些」，于是整体等比压到 0.16 / 0.50。） */
const FLY_STEP = 0.16
/** 下落时长（秒）。
 *  ★★ 0.8 → 0.62 → 0.50 的两次收缩：单个字母 0.8s 太长，字母落完之后
 *     还有半秒在微调，观感是「飘着停不下来的滞重」；0.5s 配 ease-in，
 *     加速段利落、落地即走完，不拖尾。
 *  ★ 整段入场收在 0.72 + 0.48 + 0.5 ≈ 1.7s（0.62/0.9 那版是 2.1s）。 */
const FLY_DURATION = 0.5
/** 两组之间的**组间起跑间隔**（秒）：让「Blog 落完」与「Next 开始落」明显错开。
 *  ★ 第一版只有 0.45s 且与 NEXT 的 opacity delay 共用，实测 B（121px 行程）
 *    与 N（78px 行程）在时间上仍有重叠，用户反馈「体感上 n 和 b 是一起下来的」。
 *  ★ 0.9s 那版：Blog 的 g 在 0.6+0.62=1.22s 落定，NEXT 的 N 在 0.9s 才开始动。
 *  ★ 现在 0.72s：随上两个时长等比缩短，保持「log 的 g 快落定、N 就起跑」
 *    的同一节奏（0.9/1.22 ≈ 0.74），否则整体提速后 NEXT 会显得在干等。
 *  ★ NEXT 的 opacity delay 共用这个常量（见 runHeroIntro 里 `.next` 的动画），
 *    否则 NEXT 会先整块淡入、再逐字下落，露出「先出现后下落」的破绽。 */
const FLY_GROUP_DELAY = 0.72

/** 把一个元素里的文本逐字拆成 `<i>`（每个都是 `display: inline-block`），返回这些 `<i>`。
 *
 *  ★★ 为什么是 `<i>`（而不是直接给整词做 transform）：
 *    位移要落在**每个字母**身上才能做出逐级感，所以必须先把词拆成元素。
 *
 *  ★★ 为什么这些 `<i>` 必须是 `display: inline-block`：
 *    `display: inline` 的元素**不响应 transform** —— 动画会在跑、
 *    `playState=running`、`currentTime` 正常推进，但盒子一个像素都不动。
 *    详见下方 splitLetters 里那段实测记录。
 *    （旧版注释曾写「保持 inline 才不会新起行盒」，方向反了：inline-block 在
 *      **不显式写 line-height** 时同样不改布局，实测容器尺寸逐项 0.00px 相同。） */
function splitLetters(el: HTMLElement | null): Element[] {
  if (!el) return []
  const node = el.firstChild
  if (!node || node.nodeType !== Node.TEXT_NODE) return []
  const out: Element[] = []
  const chars = (node.textContent ?? '').split('')
  chars.forEach((ch, i) => {
    const glyph = document.createElement('i')
    glyph.textContent = ch
    glyph.dataset.letter = ch
    /* ★★ 必须能让 transform 生效 —— 而 `display: inline` 的元素**不响应 transform**。
     *   实测（Edge 154，用真 WAAPI 动画而不是静态改 style）：
     *     display:inline        → computed transform 是 matrix(…,-39.99)（看着像生效），
     *                             getBoundingClientRect().top 前后**一模一样，位移 0px**
     *     display:inline-block  → 位移 40px ✓
     *     display:block         → 位移 40px ✓
     *   （旧版注释说「不给它任何样式、保持 inline」是错的：那样动画看起来「在跑」
     *     —— getAnimations() 里 playState=running、currentTime 正常推进 ——
     *     但字母**一个像素都没动**，只有 B（SVG，display:block）在动，
     *     所以用户看到的是「只有 B 在落、log 不动」。）
     *
     *   ★ 用 inline-block 会不会把基线顶偏？不会，前提是**别写 line-height**：
     *     实测 inline-block + 继承 .hero-log 的 line-height: 0.85，
     *     容器 h=94.73 w=140.13 与原始单文本节点**逐项 0.00px 相同**，
     *     行盒高度也仍由父级 strut 决定（子盒溢出但不撑高行盒）。
     *     ❌ 一旦显式写 line-height（如 normal/1），容器高就变成 168px、基线整体偏移 —— 别写。 */
    glyph.style.display = 'inline-block'
    glyph.style.position = 'relative'
    if (i === 0) el.replaceChild(glyph, node)
    else el.appendChild(glyph)
    out.push(glyph)
  })
  return out
}

function flyLetters(
  letters: Element[],
  offsetFor: (el: Element, i: number) => { y: string; delay: number },
) {
  letters.forEach((el, i) => {
    const { y, delay } = offsetFor(el, i)
    if (y === '0px') return
    /* 过冲关键帧：落定前多走 7% 的**反方向**（y 是负值，所以这里取 y 的 −7% = 向下多走）。
     * 例：y = '40%' → 过冲帧 'translateY(-2.8%)' → 终态 'translateY(0px)'。 */
    const overshoot = 'translateY(' + Math.round(parseFloat(y) * -0.07 * 10) / 10 + '%)'
    /* ── 关键帧：过冲 + 运动模糊 + 拉伸 ──
     *
     * ★★ 为什么不能只用 `['translateY(-y)', 'translateY(0px)']` 两帧 + ease-out：
     *    那是「直线下落 + 到位即停」，看起来**生硬** —— 字母像是被瞬移过去钉在基线上。
     *    真实下落有三个痕迹：起步快、末段减速、以及**运动方向的拖影**。三者都要给。
     *
     * ★★ 缓动曲线 `[0.42, 0, 0.9, 0.42]` —— 这是一条 **ease-in（缓入）**：
     *    控制点 2 的 y 只有 0.42（< x 的 0.9），曲线整体压在匀角线**下方**，
     *    所以初段慢、末段快。这正是「重力下落」的形状：从静止松手，越落越快。
     *    纯数值模拟（反解 cubic-bezier 的 x→t，取 10% 一档的行程比例；原探针
     *    `.tmp-ease.mjs` 已随大清洗删除）：
     *      时间 0  10  20  30  40  50  60  70  80  90 100 %
     *      行程 0   2   6  14  27  43  59  75  88  97 100 %
     *    中段匀速增长、没有平肩（`[0.5,0,0.4,1]` 那种「开头 20% 几乎不动」的曲线是 **ease-out 感**，
     *    方向搞反了 —— 用户要的是缓入），末段迅速收口。
     *
     * ★ 那「落定」怎么办？物理上落到底该急停，但屏幕上一刀切会像瞬移。
     *   所以只在 86%~100% 这一段（≈87ms）用关键帧做「接触-回弹」，
     *   而不是靠把整条曲线拉成 ease-out。曲线管加速，尾段关键帧管落地。
     *
     * ★ 过冲（86% 处向下多走 7%，再回弹）：
     *    给落定一个「刹住」的过程，而不是硬停 —— 这是「灵动」里手感的部分。
     *    7% 是刻意的克制值：再大（如 15%）在 Blog 这种静态排版里会显得弹跳做作。
     *
     * ★ 运动模糊（filter: blur）：
     *    前两帧最糊（3.5px）—— 那是行程走得最快的一段（ease-in 的加速段），
     *    与「快速运动的物体在视觉上被拉长」一致；末段随速度收口，到基线时完全锐利。
     *    ★ 与缓动方向的关系：由于现在是 ease-in，**起手是慢的**，
     *      所以模糊也刻意不在第一帧就铺满 —— 关键帧把最糊的时刻放在加速段。
     *    ★★ 3.5px 而不是更大：字母自身的模糊会与父级 `.hero-brand-row` 的
     *       `blur(14px→0)` **叠加**（两者同时发生），起点再放大就会糊成一团光。
     *       实测（ct=240ms）父级 blur(4.3px) + 字母 4.3px，单帧偏软 —— 降到 3.5px 后
     *       单帧锐度回来了，而连续运动下「拖影」的观感不受影响。
     *    ★★ 垂直方向位移 + **各向同性**的 blur 只是近似（真运动模糊只在 Y 方向拉长），
     *       但字号这么大、行程又短，实拍观感足够像。
     *    ★ 只在下落期间存在，落定后 filter 回到 none → 不残留合成层、不成为包含块
     *      （包含块会让层内 fixed 子元素失效 —— 这一带将来挂东西时要记得）。
     *    ★ 用 `blur(0px)` 而不是 `blur()` / `none`：关键帧里 filter 的函数列表必须同构，
     *      否则浏览器无法在两端之间插值，会退化成硬切。
     *
     * ★ 拉伸（scaleY 1.02）：极轻微，只为让落定那一下不是纯粹的位置到达。
     *    ★★ 注意 transform 必须**保持同一个函数序列**（translateY → scaleY），
     *       否则关键帧之间无法插值。scaleY 的基准是元素中心（transform-origin 默认 50% 50%），
     *       1.02 的拉伸约 ±1% 高度，肉眼只当作「落下时轻轻压了一下」。 */
    cleanupEffects.push(
      animate(
        el,
        {
          transform: [
            'translateY(-' + y + ') scaleY(1)',
            overshoot + ' scaleY(1.02)',
            'translateY(0px) scaleY(1)',
          ],
          filter: ['blur(3.5px)', 'blur(0.6px)', 'blur(0px)'],
          offset: [0, 0.86, 1],
        },
        {
          duration: FLY_DURATION,
          delay,
          ease: [0.42, 0, 0.9, 0.42],
        },
      ).stop,
    )
  })
}

function setupHeroMotion() {
  const hero = heroEl.value
  if (!hero || prefersReducedMotion()) return

  const brand = hero.querySelector('.hero-brand-row')
  const logEl = hero.querySelector<HTMLElement>('.hero-log')
  const next = hero.querySelector('.hero-next')

  /* 先把要动画的元素置为不可见，避免「先按原样闪现一帧、再开始动画」。
     ★ 一定要在 whenBooted 之前同步执行，否则会漏掉首帧。
     ★ 同时挂上兜底定时器：万一动画没跑起来，也会被恢复可见（见函数注释）。 */
  /* ★★ m06789：这里**只隐藏 log 与 NEXT**，**不要**隐藏 `.hero-brand-row`。
     原因：Blog 里的 B 要和 Loader 飞过来的 B 做无缝交接 ——
     B 全程必须不透明、不位移，否则幕布淡出时它会闪一下。
     于是「整词对焦」的 opacity/blur 从 .hero-brand-row 下沉到 .hero-log。 */
  const targets = [logEl, next].filter(Boolean) as Element[]
  targets.forEach((el) => {
    ;(el as HTMLElement).style.opacity = '0'
  })

  /* 字母级「从上往下、由外向内」飞入的落点。
     ★ m06789 起 B 不参与：Loader 里的 B 会飞到 hero 的 B 上完成交接，
       hero 自己的 B 必须一动不动（见 setupHeroMotion 的说明）。
       所以这里只有 log 的逐字（`<i>`，display: inline-block 才能 transform）
       与 NEXT 的字母盒（NextButton 里的 `.next-ch`）。
     ★ 顺序即「由外向内」：l→o→g、N→e→x→t。 */
  /* ★★ 为什么字母要等到 whenBooted 之后才查：Vue 的 onMounted 是**子组件先、父组件后**，
     所以在这个同步块里 NextButton 的 onMounted 还没跑 —— 它的 `.next-ch` 是那时候才插进
     DOM 的，此刻 querySelectorAll 返回空数组，**NEXT 整组的下落动画会被静默跳过**
     （实测：animate 调用记录里只有 4 个字母，N 与 e/x/t 一个都没有）。
     挪到 whenBooted（载入遮罩揭开）之后就正常了 —— 那时子组件早已挂载完。
     ★ 不会因此看到「未切分的整词闪烁」：log / next 的 opacity 在上面已置 0。 */
  let brandLetters: Element[] = []
  let nextLetters: Element[] = []

  armRevealSafety(targets)

  /* 等载入动画揭开后再开始，否则整段入场都被遮罩盖住（白播） */
  whenBooted().then(() => {
    if (!hero.isConnected) return
    /* ★★ m06789：B（`.hero-initial`）**不再进这个数组** —— 它不参与入场动画，
       它的位置由 Loader 里那个 B 飞过来对齐（hero 的 B 自始至终原地不动）。
       所以逐字母下落的只有 log：l → o → g。 */
    brandLetters = [...splitLetters(logEl)]
    nextLetters = next ? Array.from(next.querySelectorAll<HTMLElement>('.next-ch')) : []
    // 兜底定时器要在字母元素存在之后再挂，否则复原不到它们
    armRevealSafety([...brandLetters, ...nextLetters])
    runHeroIntro(logEl, next, brandLetters, nextLetters)
  })

  /* 滚动联动：Blog 随滚动逐渐淡出、轻微模糊，制造纵深
     ★ 用 motion 的 scroll() 而不是监听 scroll 事件：内部已做 rAF 节流
       与进度归一化，且返回 cancel 函数方便清理。
     ★ 同样只动 opacity / filter，不碰 transform（理由见上）。
     ★ 必须等入场动画播完再挂，否则两条动画会同时写 opacity 互相覆盖。 */
  whenBooted().then(() => {
    if (!hero.isConnected || !brand) return
    setTimeout(() => {
      if (!hero.isConnected) return
      cleanupEffects.push(
        scroll(
          animate(brand, { opacity: [1, 0.12] }, { ease: 'linear' }),
          { target: hero, offset: ['start start', 'end start'] },
        ),
      )
    }, 1600)
  })
}

function runHeroIntro(
  /* ★ m06789：这里收的是 `.hero-log`（不再是 .hero-brand-row）——
     B 不参与入场动画，见 setupHeroMotion 里的说明。 */
  brandFocus: Element | null,
  next: Element | null,
  brandLetters: Element[],
  nextLetters: Element[],
) {
  /** ★★ 入场结束后必须清掉内联 `filter`。
   *
   *   motion 会把最终关键帧（`blur(0px)`）以**内联样式**留在元素上，
   *   而 `filter` 即使值是 0 也仍然有效 —— 它会在元素上：
   *    1) 建一个**合成层**（持续占用显存/合成开销）
   *    2) 成为**包含块**（与 transform 同理）—— 层里挂 3D 渲染器或 fixed 元素会失效
   *   hero 是首屏最显眼的区域，这里每帧多一层合成不值得。
   *
   *   ★★★ 这里**不能**挂在动画的生命周期回调上，无论 `onComplete` 还是
   *        `finished.then()` 都试过，**都不可靠**：
   *        motion v13 用 Web Animations API 驱动，最终值的内联提交发生在
   *        动画结束**之后**，实测在 `finished` resolve 之后还要再等
   *        **>900ms** 才落盘（0.2 / 0.6 / 1.1s 三种时长都是如此）。
   *        所以在回调里清掉，稍后都会被那笔提交覆盖回来。
   *
   *   ✅ 改用朴素的定时器：等入场动画的铁定结束时间（最长 1.35s）再清，
   *      对 motion 的提交时机完全免疫。
   *      ★ 清**两次**（2.0s / 3.6s）：motion 的提交时机不稳定，
   *        实测可晚至 `finished` 之后 1s 以上，单次清可能踩空。
   *        清除是幂等的、几乎零成本，多补一次当保险。
   *      （若将来 motion 不再留残渣，这里也只是个无害的 no-op。） */
  const clearIntroFilters = () => {
    ;[brandFocus].forEach((el) => {
      if (el) (el as HTMLElement).style.removeProperty('filter')
    })
  }
  const filterTimers = [2000, 3600].map((ms) => setTimeout(clearIntroFilters, ms))
  cleanupEffects.push(() => filterTimers.forEach(clearTimeout))

  /* ── 逐字母「下落 + 由外向内」──
     与上面那层「模糊 → 清晰」**同时**发生，两层叠加：
       父级：整词 opacity 0→1 + blur(14px)→blur(0)
       子级：每个字母各自从上方（自身墨迹高度的 30%~36%）落下，FLY_DURATION 秒 ease-in
     时间线（延迟 = 组内序号 × FLY_STEP；实测 animate 调用确认）：
       Blog：l 0ms ｜ o 160 ｜ g 320   ← m06789 起 B 不再入场，所以从 l 起算
       Next：N 720 ｜ e 880 ｜ x 1040 ｜ t 1200
     ★ 两组之间的 FLY_GROUP_DELAY 让「Blog 快落完、Next 再落」，
       所以视觉上是 l/o/g 依次落 → N 落 → e/x/t 依次落。
     ★ 实测每个动画的 currentTime 是同一根时间轴（8 个动画同时创建），
       所以「错落」完全由 delay 决定 —— 改 delay 就等于改观感。
     ★ 三个常量（FLY_STEP / FLY_DURATION / FLY_GROUP_DELAY）**要一起改**：
       只动其中一个会破坏「上一个字母快落定、下一个才起跑」的配比。 */
  flyLetters(brandLetters, (el, i) => ({
    y: (FLY_UNIT[el.getAttribute('data-letter') ?? ''] ?? 0.4) * 100 + '%',
    delay: i * FLY_STEP,
  }))
  flyLetters(nextLetters, (el, i) => ({
    y: (FLY_UNIT[el.getAttribute('data-letter') ?? ''] ?? 0.4) * 100 + '%',
    delay:
      FLY_GROUP_DELAY + // 与下面 NEXT 的 opacity 动画对齐（那段 delay 用同一个常量）
      i * FLY_STEP,
  }))

  /* 开幕：log 从 0 淡入 + 轻微模糊 → 清晰，营造「对焦」感
     ★★ m06789：目标从 `.hero-brand-row` 换成 `.hero-log` ——
       B 交给 Loader 交接，绝不能参与淡入（否则幕布拉开时 B 会闪）。
     ★ 不能用 transform 做缩放/位移：布局依赖它！
       `.hero-brand-row` 的 align-items: flex-end 负责「log 底 = B 底」的基线对齐，
       `.hero-next` 靠 baseline 对齐。
       一旦改了 transform，这些已经调好的对齐全部会被破坏。
     ★ 时长与逐字母下落同步压缩（1.1 → 0.88）：文字已经 1.7s 落完，
       对焦若还拖到 1.1s 之后就成了尾巴。 */
  if (brandFocus) {
    cleanupEffects.push(
      animate(
        brandFocus,
        { opacity: [0, 1], filter: ['blur(14px)', 'blur(0px)'] },
        { duration: 0.88, ease: [0.22, 1, 0.36, 1] },
      ).stop,
    )
  }
  if (next) {
    cleanupEffects.push(
      animate(next, { opacity: [0, 1] }, { duration: 0.6, delay: FLY_GROUP_DELAY, ease: 'easeOut' }).stop,
    )
  }
}

onMounted(() => {
  setupHeroMotion()
})
onBeforeUnmount(() => {
  clearTimeout(safetyTimer)
  /* ★★ 这里曾经是 `pauseMusic()` —— 理由是「别让用户切到别的页面还在后台放」。
   *
   *   2026-10-09 用户要求「我希望音乐栏在其他页面也可以播放，变成一个音乐球」，
   *   而「离开首页就暂停」与这条需求**直接冲突**：只要有这一行，切页续播
   *   在任何实现下都不可能发生（实测确认：切到 /about 时 status 被改成 paused）。
   *   现在离开首页后由右下角的 MusicBall 接管（同一个模块级播放器单例，
   *   可以继续放、也能随时暂停/切歌），所以这一行已删除。
   *
   *   ★ 不要再加回来。若日后确实想「只在没人管的时候停」，要停的条件也应该是
   *     「没有任何页面在展示控制入口」，而不是「离开了首页」。 */
  cleanupEffects.forEach((fn) => fn())
  cleanupEffects = []
})
</script>

<template>
  <!-- ==================== HERO ==================== -->
  <!-- 原站结构：100svh 纵向 flex，上下各 50%，中央绝对定位浮动图 -->
  <section ref="heroEl" class="hero">
    <div class="hero-contain u-container">
      <!-- 上半：左侧巨型字母 B 拼出 Blog（大 B + 小 log） -->
      <div class="hero-top">
        <div class="hero-brand-row">
          <InitialLetter letter="B" label="Blog" class="hero-initial" />

          <!-- 小写的 log：与 B 组成 Blog 一词 -->
          <span class="hero-log" aria-hidden="true">log</span>
        </div>

        <!-- 音乐栏：位于 Blog 大字下方（与 caption 之间）。
             ★ 它是占位行而非单行 —— 见 .hero-music-row 的注释。 -->
        <div class="hero-music-row">
          <MusicBar class="hero-music" />
        </div>

        <!-- ★ m06569：这里原来是一行轮播小字（.hero-caption，3.5s 换一条），已删除 -->

        <!-- 右上角标：L 形（取 top+right 两条边 → ⌐ 形）
             放在 hero-top 内，因为它是 position: relative 的定位基准。 -->
        <span class="hero-corner hero-corner-tr" aria-hidden="true"></span>
      </div>

      <!-- 下半：左侧留空（原站曾是标题位），右下 NEXT
           注意 .hero-title-wrap 必须保留：它是 flex: 1 的占位元素，
           一旦删掉，NEXT 的 align-self: flex-end 就失去配重，会被推到左侧。 -->
      <div class="hero-bottom">
        <!-- 左侧空容器：原本是 hero 标题位（现已删）。
             ★ 必须保留：它是 flex: 1 的配重，一旦删掉，
               NEXT 的 align-self: flex-end 就失去配重，会被推到左侧。 -->
        <div class="hero-title-wrap" aria-hidden="true"></div>

        <NextButton class="hero-next" />

        <!-- 左下角标：L 形（取 bottom+left 两条边 → L 形），与右上对角呼应 -->
        <span class="hero-corner hero-corner-bl" aria-hidden="true"></span>
      </div>
    </div>

    <!-- 音频可视化横线：铺满 hero、垂直居中，位置与原站 curveCanvas 一致。
         这条线就是「海平面」；线**以下**的水体归 WaterBody（鼠标交互）。
         ★ m06383：这一层同时是「天空遮罩」——波线以上刷天空色、以下透明。 -->
    <SoundLine />
    <WaterBody />

    <!-- 歌词层：上一句右上 / 当前句正中 / 下一句左下（音乐栏同页，共用 player 的时钟）。
         ★ 必须是 .hero-contain 的**兄弟**、且排在 WaterBody 之后：z-index 同层，
           靠 DOM 顺序压在文字与水面之上（见组件注释）。 -->
    <LyricStage />
  </section>
</template>

<style scoped>
/* ==================== HERO ==================== */
/* 原站：100svh，纵向 flex */
.hero {
  position: relative;
  display: flex;
  flex-flow: column;
  height: 100svh;
  overflow: hidden;

  /* 给导航让位，避免内容压住巨型字母。
     --nav-h 由 style.css 按断点给出，**导航始终单行**：
       >767px 72px / 521~767px 69px / ≤520px 64px / ≤345px 56px。
     ★ 早期这里写的是「≤520px 106px（两行）」—— 那版导航真的会换行，
       后来改成「永远并排」，高度随之回落（见 style.css 的同名注释）。 */
  padding-top: var(--nav-h);

  /* 把 hero 变成尺寸查询容器，供内部用 cqh 算「半屏高度」 */
  container-type: size;

  /* 兜底值：不支持 cqh 的浏览器生效。
     hero 内容盒 = 100svh - nav-h，半屏再减去上下 padding（site-margin × 2）。 */
  --hero-half: calc(50svh - var(--nav-h) / 2 - var(--site-margin) * 2);

  /* 内容区总高（= hero 内容盒高度，已扣除给导航让位的 padding-top）。
     移动端的垂直分配全部以它为基准（见 ≤767px 断点）。
     ★ 数值上等于 100svh − nav-h；用 cqh 的版本在下方被子元素覆盖，
       目的是摆脱 svh 在移动端滚动时的重算/抖动。 */
  --hero-content-h: calc(100svh - var(--nav-h));

  /* ★★★ 波带几何（用户 m06218 的遮罩架构，SoundLine 与 WaterBody 共用）。
     必须定义在**共同父级 .hero** 上：SoundLine 与 WaterBody 是**兄弟节点**，
     定义在其中任何一个里，另一个都收不到（只能吃 fallback）——
     而 WaterBody 的色块顶边必须与 SoundLine 波带 canvas 的上边缘严丝合缝：
       色块高一点 → 遮罩刷不到它 → 水面上方露出一条直边色带；
       色块低一点 → 波峰处露出天空色。
     ★ 自定义属性是**惰性替换**的：这里的 cqw 会在「使用它的元素」的上下文里解析，
       即解析到 .hero（container-type: size）→ 语义与振幅随宽度等比缩放的设计一致。 */
  --wave-amp: clamp(7px, 100cqw * 0.0275, 40px);
  /* 波带高度 = 振幅 × 3.6（40 → 144；2026-10-09 振幅由 34 提到 40） */
  --band-h: calc(var(--wave-amp) * 3.6);
  /* 半高 —— 渐变停止点、canvas 定位、水面色块顶边都从它派生 */
  --band-half: calc(var(--band-h) / 2);
  /* 撞击水花那条带的高度：只覆盖海平面**以上**（画布下沿正好落在线上） */
  /* ★ m06383：--spray-h（撞击水花层的高度）已随 3D/碰撞一起删除 */

  /* ★ 中间舞台的宽度定义在**共同父级 .hero** 上。
     ★ 历史理由（已消失）：当年 `<HeroStage class="hero-visual">` 是 .hero-contain 的
       **兄弟节点**，读不到它身上定义的属性 —— 实测宽度退回 auto、舞台被撑到 712px 并溢出。
       3D 舞台已删（m06383），现在留在 .hero 只是因为它是公共祖先：
       `.hero-contain` 的 `--brand-max-h` 与 `.hero-music` 的 max-width 都靠继承拿到它。 */
  --visual-w: 14rem;
}

/* 支持容器查询时改用 cqh —— 它是基于「容器实际高度」的定值，
 * 与视口单位无关，滚动时不会重算。
 *
 * ★ 必须声明在 .hero 的**子元素**上：
 *   自定义属性里的 cqh 若写在容器元素自身上，会退回参考「祖先容器」，
 *   没有祖先容器时就退化成视口单位，又会随滚动抖动。 */
@supports (height: 1cqh) {
  /* ★ 必须给 .hero-contain 一份准确的 100cqh（理由见下方移动端那段注释）。
     （原来还要给兄弟节点 .hero-visual —— 它已随 3D 删除，m06383。） */
  .hero-contain {
    --hero-content-h: 100cqh;
  }

  .hero-contain {
    /* 容器（.hero 的内容盒）高度已排除 padding-top，故直接取一半 */
    --hero-half: calc(50cqh - var(--site-margin) * 2);
  }
}

/* 容器：100% 高，纵向 flex */
.hero-contain {
  /* ★★★ z-index: 3 —— 文字必须**盖在天空遮罩之上**（用户 m06383 报「字体全盖住了」）。
     遮罩层 .sound-line 现在 z-index:2（要盖住 z1 的水体色块），而 .hero-contain
     在 DOM 里排在它**前面**，同级 z 序时会被遮罩刷掉 → 巨型 Blog/Next 全被天空色糊住。
     层序（从下到上）：天空渐变(0) < 水体色块+水彩(1) < 遮罩+音乐线(2) < 文字/内容(3)。 */
  z-index: 3;
  display: flex;
  flex-flow: column;
  height: 100%;

  /* ★ 关键：这一层铺满整个 hero 且 z-index 最高，会吃掉下面的鼠标事件。
     放开后事件穿透到下方的水体 / 音乐线层（将来若在中央挂 3D，也是它受益）；
     内部真正需要交互的元素（NEXT 按钮、音乐栏）各自设回 auto。 */
  pointer-events: none;

  /* ---- Blog 自适应尺寸（定义在共同祖先，供 .hero-brand-row / .hero-next 共用）----
     （--visual-w 在 .hero 上定义，理由见上方注释） */

  /* Blog 组的「等效宽度系数」：
       B 宽   = 0.3597 × h（SVG viewBox 150 / 417）
       log 宽 ≈ 0.3746 × h（字号 0.30h，字宽比 1.2485）
       合计 ≈ 0.734 × h
     左侧可用宽度 = (容器宽 − 图宽) / 2 − 间距，
     故 Blog 的最大高度 = 可用宽度 / 0.734。
     ★ 必须用 vw 而非 %：自定义属性以 token 代入后，
       % 会在「使用它的元素」上解析（如 max-height 里会按高度算），结果错误。 */
  --brand-max-h: min(
    /* ① 原「左右分栏」上限：左侧可用宽 / 0.734。中央舞台已删，这一项现在极宽松，
          实际上永不生效，仅作为历史约束保留。 */
    calc((100vw - var(--site-margin) * 2 - var(--visual-w)) / 2 / 0.734 - var(--gutter)),
    /* ② ★★ 2026-10-06 用户 m06705「760-770 这个区间似乎有一个 blog 大字整体缩小的逻辑，
          但问题是在 760 宽度前 blog 就很大，抢占了中间的位置」：
          桌面分支原来**只受半屏高限制** → 768 / 1024 / 1440 三档算出几乎同一个值
          （实测 333 / 339 / 339），小窗口里 Blog 和宽窗口一样大，相对就显得巨硕。
          这里按视口宽度 29% 收口：768 → 213px（-38%）、1024 → 292px，
          ≥ ~1200 时不生效（1440 / 1920 的现有比例完全不变）。
          ★ 0.29 的来处：让它恰好在 1200 附近与半屏高相等，再窄才明显收，
            这样宽屏观感不变、只修「小窗口里过大」这一档。 */
    calc((100vw - var(--site-margin) * 2) * 0.29)
  );

  /* 实际高度取「半屏高」与「宽度上限」的较小值 —— 窄屏自动缩小，不会挡住中间的图 */
  --brand-h: min(var(--hero-half), var(--brand-max-h));
}

/* 上下各 50% */
.hero-top,
.hero-bottom {
  display: flex;
  justify-content: space-between;
  width: 100%;
  height: 50%;
  padding-block: var(--site-margin);
  position: relative;
  /* ★ 音乐栏与 Blog / caption 的间距（用户指定 20px，后续微调）。
     做成变量而不是散落的字面值：桌面与窄屏两套 margin 都从它反推，
     改一处即整体联动。
      ★ 窄屏必须再减去父级 gap —— 见 @media 里 .hero-music-row 的说明。
      ★ 2026-09-20：20px → **30px**（用户要求「音乐栏下移 10px」）。 */
  --hero-music-gap: 30px;
}

/* 上半：内容**贴顶**。
 *
 * ★ 原站是 align-items: flex-end（贴底），但那依赖「Blog 恰好填满上半屏」。
 *   一旦 Blog 被**宽度**公式卡住（窄屏：中间舞台占宽 + 两侧 site-margin），
 *   Blog 就比上半屏矮，贴底会让它与 bar 之间裂开一个大空隙：
 *   实测 800×1000 空 87px、768×1025 空 121px、768×1200 空 **209px**
 *   —— 看起来就像 Blog 被挤到了 bar 下方。
 *   改成贴顶后，Blog 始终紧跟在 bar 下面（间距恒为 site-margin）。
 *
 *   ★ 桌面端不会因此改变：正常宽高比下 Blog 恰好等于上半屏高，
 *     贴顶与贴底是同一个位置（1440×900 两者都是 gap 16px）。
 *   caption 有自己的 align-self: flex-end，仍然待在上半屏右下角。 */
.hero-top {
  /* ★★ m06745：桌面改成**纵向**堆叠（窄屏本来就是纵向，见 @media 里那段）。
     这样 DOM 顺序 Blog → 音乐栏 就是视觉顺序，音乐栏永远紧跟大字下方，
     不再取决于「上半屏有多高」。
     ★ justify-content 必须显式覆盖基类的 space-between：
       纵向时它会把音乐栏推到上半屏底边（正是要修掉的行为）。
     ★ align-items: flex-start —— 纵向布局下它是**水平**对齐（左对齐）。 */
  flex-direction: column;
  align-items: flex-start;
  justify-content: flex-start;
}

/* 下半：内容贴顶 */
.hero-bottom {
  align-items: flex-start;
}

/* 巨型字母 + 小写 log 同行，拼成 Blog。
   尺寸变量：--brand-h 定义在父级 .hero-contain 上，--visual-w 在 .hero 上（见上）。 */
.hero-brand-row {
  /* ★ m06745：父级改成纵向 flex 后，flex: 1 会作用在**高度**上（把行拉满上半屏），
     必须换成 flex: none，高度由下面的 --brand-h 直接给出。 */
  flex: none;
  display: flex;
  align-items: flex-end;
  gap: 0;
  /* ★ 高度必须夹到 --brand-h，不能写 100%。
   *
   * 上半屏高度（= --hero-half）在窄屏上会大于 Blog 的可用高度，
   * 若写 100%：
   *   1) row 比 Blog 高 → 配合父级贴顶，B 内部仍会靠底（见 align-items 说明）
   *   2) SVG 的 height: 100% 会跟着 row 一起变高，Blog 被拉得过大
   *
   * min(100%, var(--brand-h)) 两个好处：
   *   • row 高度恰好等于 Blog 高度 → B ↕ row 同高，log 的 align-items: flex-end
   *     才能真正让「log 底 = B 底」（这是 Blog 一词的基线对齐关键）
   *   • 给 SVG 的 height: 100% 提供了**确定**的百分比基准，
   *     不依赖替换元素的固有尺寸回退，任何视口下尺寸都精确等于 --brand-h
   *     （实测 1920×1600 这种极端高屏也不会被固有高度 417 卡住） */
  height: var(--brand-h); /* m06745：原来是 min(100%, var(--brand-h))，纵向 flex 下要确定值 */
  min-width: 0;
}

/* SVG：撑满高度，但受 --brand-h 限制。
   SVG 是有固有比例的替换元素，max-height 生效时 width:auto 会按比例重算，
   所以会**等比缩小**而不是被压扁。 */
.hero-initial {
  height: 100%;
  max-height: var(--brand-h);
  width: auto;
}

/* 小写的 log：跟在 B 后面拼成 Blog，尺寸明显小于 B。
 *
 * 排版本质：让 log 与 SVG 的 B **共享同一条基线**，B 的底边就是基线。
 * 实测 Anton 的字体度量（font-size = 1）：
 *   fontBoundingBoxAscent = 1.18, Descent = 0.33 → normal 行高 1.51
 *   小写 l 的上伸 = 0.86，g 的下伸 = 0.12 → 墨迹总高 0.98
 * 取字号 = 0.30 × B 高度时，墨迹高 = 0.98 × 0.30 ≈ 0.29 × B 高度。
 *
 * 基线定位：设 line-height 为 L，则「box 底 − 基线」= 0.5L − 0.425（推导自上面度量）。
 * 取 L = 0.85 时该值为 0，即 box 底恰好落在基线上，
 * 于是配合 align-items: flex-end 就能让 log 的基线对齐 B 的底边。
 */
.hero-log {
  font-family: var(--font-display);
  /* 跟随「实际生效的 B 高度」而非半屏高，窄屏缩小后比例才不会脱节 */
  font-size: calc(var(--brand-h) * 0.3);
  line-height: 0.85;
  text-transform: lowercase;
  flex-shrink: 0;
}

/* 逐字母飞入用的 `<i>`（由 script 里的 splitLetters 生成，display/position 也由 JS 内联）。
 *
 * ★★ 它**必须**是 `display: inline-block` —— `display: inline` 的元素不响应 transform，
 *    动画会「在跑但纹丝不动」（实测见 splitLetters 的注释）。
 *
 * ★ 这里**故意不写任何类选择器样式**：`display` / `position` 由 JS 内联设置，
 *   而 `line-height` **必须保持继承**（.hero-log 的 0.85）——
 *    实测：不写 line-height 时容器 h=94.73 w=140.13，与原始单文本节点逐项 0.00px 相同；
 *    一旦显式写 line-height（normal / 1），容器高会涨到 168px、基线整体偏移几十像素。
 *
 * ❌ 历史上这里写过 `letter-box` 包裹层 + 显式 line-height，正是踩了上面这条，
 *    表现为「log 比 B 高半个字」，所以那条路已经放弃、包裹层也已删除。 */

/* 移动端同样用公式（不要再写固定 clamp，
   否则比例会和 B 脱节——曾出现 log 只有 B 的 5% 的情况） */

/* ★ m06569：`.hero-caption`（轮播小字：右对齐 / align-self: flex-end）已删除 */

/* 标题容器：flex 1，最大 40ch（原站 .hero_home_title_wrap.u-pointer-off） */
.hero-title-wrap {
  flex: 1;
  max-width: 40ch;
  position: relative;
}

/* ==================== 音乐栏的落位 ====================
 *
 * ★★ m06745（用户）：「无论宽度高度怎么改，音乐播放栏都放在 blog 大字的下方」
 *   → 音乐栏改成**普通文档流**，紧跟 `.hero-brand-row` 之后。
 *
 *   历史：桌面端曾把它绝对定位到上半屏的正下方（`top: 100%`），
 *   当时的前提是「Blog 恰好填满上半屏」，所以「上半屏底边」＝「Blog 底边」。
 *   但 Blog 的高度现在受**宽度**公式约束（`.hero-brand-row` 见上），
 *   上半屏经常空出一大截 —— 绝对定位就让音乐栏飘在离大字很远的地方。
 *   改成流内后，间距完全由 margin 决定，与视口宽/高、断点都无关。
 *
 *   ★ .hero-top 必须同时是纵向 flex（见上面 .hero-top 的规则），
 *     否则流内的音乐栏会和 Blog 并排而不是排在下面。
 *
 * ★★ 窄屏（≤767px）不用这条：那时音乐栏已经换成 fixed 圆形播放键
 *   （见 MusicBar.vue），这里只是一个高度 0 的占位行 —— 见 @media 里那段。
 *   所以本规则里给的 margin-top 在窄屏会被 margin-block: 0 覆盖掉。
 *
 * ★ 宽度上限用「跟随 Blog 的比例式」而不是写死的数值：
 *   栏比 Blog 字样略短一点，窄屏也成立（公式与 Blog 的宽度公式同一套思路）。
 */
.hero-music-row {
  /* ★★ m06745：普通文档流（原来 absolute + top: 100% 贴在上半屏底边）。
     margin-top 直接给 --hero-music-gap(30px) —— 与旧版观感一致：
     旧版是「上半屏底边 +14px」，而大字底边距那条线本来还有 16px padding。 */
  position: static;
  width: 100%;
  margin-top: var(--hero-music-gap);
  display: flex;
  justify-content: flex-start;
  /* ★ 父级 .hero-contain 是 pointer-events: none（为放行 3D 舞台），
     音乐栏要单独收回事件，否则整个栏都点不了。 */
  pointer-events: auto;
  min-width: 0;
}

.hero-music {
  width: 100%;
  /* ★★ 宽度跟随 Blog 字样，比它**略短一点**（用户要求）。
   *
   *   字样的排版宽 = --brand-h × 0.734
   *   （B 宽 0.3597 + log 框宽 0.3768，即项目里一直在用的 0.734 系数）。
   *   实测对照：1920→347.5px、1440→281.4、390→172.8、320→140.1，
   *   与公式吻合。
   *
   *   × 0.93 即「稍微短一点点」（短约 7%）。
   *   ★ 用比例而不是写死的 px：Blog 会随视口缩放，写死的话
   *     宽屏下短得离谱、窄屏下又比字还长。
   *   ★ 这条规则在**两个断点都成立**（窄屏 Blog 也占满整宽）。
   *
   *   ★★ 2026-09-25 播放器改版后放宽到 1.05：原来 0.93 是按「一行滑杆开关」
   *     的旧控件定的，新播放器一行里有 3 个走带键 + 曲名 + 时间 + 音量，
   *     实测 1440×900（--brand-h ≈ 335.5 → 旧上限 229px）只够曲名显示 2 个字
   *     （元素量测：.mb-now 只剩 51.5px 宽，而曲名完整需要 92px）。
   *     上限同时受下面那条「别压到舞台」约束，所以这里放宽不会撞舞台。
   *
   *   ★★ 「别压到中间 3D 舞台」的上限**不能写在这里** ——
   *     它是按左右分栏推导的（50% − 舞台半宽 − gutter），
   *     在窄屏上 50% 只有两百来像素、再减舞台就只剩几十像素，
   *     会把整个栏压成细条（实测 390 下只剩 38px）。
   *     所以那条上限放进下面的 @media (min-width: 768px)。
   *
   *   ★★ 2026-09-26 加了绝对值上限 --music-max-w：栏里的内容（3 个走带键 + 时间 +
   *     静音 + 列表开关）实测只要 ~250px，而宽度公式是跟着 --brand-h 一路长的
   *     （1920×1080 下算出来 360px+），宽屏上就是「一条空荡荡的长条」。
   *     ★ 上限只在**大屏**生效：1440×900 时公式给 258.6px < 300，不动；
   *       再大的窗口才被它按住。这也顺手恢复了「栏比 Blog 字样略短一点」的关系
   *       （1.05 系数原本会让栏比字样还长 5%）。
   *
   *   ★★ 2026-10-06 用户 m06655「宽距离状态下，音乐播放栏的宽度太宽了，可以适当收窄」：
   *     上限 300 → 260px。只影响公式超过 260 的**宽视口**
   *     （--brand-h × 0.734 × 1.05 > 260 ⇔ --brand-h > 337 ⇒ 视口宽 ≳ 1750px）；
   *     1440×900 时公式给 258.6px，仍然不受影响。
   *     ★ 为什么是 260 而不是更小：`.hero-music` 的容器查询断点是 252px
   *       （`@container music (max-width: 252px)` 会切到紧凑布局），
   *       260 能收窄又不跨过断点。 */
  --music-max-w: 240px;
  max-width: min(calc(var(--brand-h) * 0.734 * 0.95), var(--music-max-w));
  min-width: 0;
}

/* 桌面 / 平板：左右分栏，栏还要避开中间的 3D 舞台。
 *
 * ★★ 这条上限**比 Blog 的宽度公式更紧**（2026-09-25 实测）：
 *   1440×900 下 --brand-h ≈ 335.5 → Blog 公式给 258.6px，
 *   这条给 50% − 112 − 16 = 592px —— 实际生效的是**上一条**（258.6px）。
 *   想让播放器更宽就必须动 --visual-w（舞台尺寸），那是设计决策，
 *   不在播放器改造范围内，所以这里不动。
 *
 * ★ 另外这条在窄屏上会算出几十像素（390 下 38px），
 *   所以它只放在 min-width: 768px 里，不能上移到基础规则。 */
@media (min-width: 768px) {
  .hero-music {
    max-width: min(
      calc(var(--brand-h) * 0.734 * 0.95),
      var(--music-max-w),
      calc(50% - var(--visual-w) / 2 - var(--gutter))
    );
  }
}

/* ==================== hero 对角 L 形角标 ====================
 *
 * 右上（⌐ 形）与左下（L 形）各一个，用两条 border 拼出 90° 直角，
 * 呼应站点的「线」语言（与 --text 同色）。
 *
 * ★ 尺寸基准 --brand-h × 0.3 = 与 .hero-log 的字号完全相同。
 *   两处都用同一算式（而不是写死 px），这样窄屏 Blog 缩小时角标同步缩小，
 *   不会出现"字小了角标还很大"的比例脱节。
 *   （--brand-h 定义在父级 .hero-contain 上，两处都能读到。）
 *
 * ★ 线宽用局部变量 --corner-w，一处调全球生效。
 *   不能写死 px：角标尺寸本身跟着 --brand-h 走，桌面 115px、手机 57px，
 *   固定线宽在窄屏会显得笨重、宽屏又偏细。这里用比例 + clamp 兜底：
 *   桌面 ≈5.7px、手机下限 3px。
 * ★ 用 border 而不是 SVG/文字：边线在任意 DPR 下都锐利，且不需要额外资源。
 * ★ 位置绝对定位到 hero-top / hero-bottom 的角上（两者都是 position: relative），
 *   避开 caption（上半屏右下）与播放按钮（下半屏左上）。 */
.hero-corner {
  position: absolute;
  /* 线宽：取角标边长的 10%。
     角标边长 = --brand-h × 0.3，所以线宽 = --brand-h × 0.3 × 0.1 = --brand-h × 0.03。
     用「边长的百分比」而不是固定 px，是因为角标本身随 --brand-h 缩放
     （桌面 115px、手机 57px），固定线宽会让两端比例失衡。
     clamp 的上下限放宽（5~14px），保证 190~470 的 --brand-h 区间内
     基本不会被夹住，比例恒定 ≈10%。 */
  --corner-w: clamp(5px, calc(var(--brand-h) * 0.03), 14px);
  /* 与 log 字号同基准 */
  width: calc(var(--brand-h) * 0.3);
  height: calc(var(--brand-h) * 0.3);
  color: var(--text);
}

/* 右上：取 top + right 两条边 → ⌐ */
.hero-corner-tr {
  top: 0;
  right: 0;
  border-top: var(--corner-w) solid currentColor;
  border-right: var(--corner-w) solid currentColor;
}

/* 左下：取 bottom + left 两条边 → L，与右上对角呼应 */
.hero-corner-bl {
  bottom: 0;
  left: 0;
  border-bottom: var(--corner-w) solid currentColor;
  border-left: var(--corner-w) solid currentColor;
}

/* 右下角 NEXT：排版本体在 components/NextButton.vue，
 * 这里只声明 hero 专属的两件事 ——
 *   ① `--next-cap`：大字母 N 的高度 = B 的一半（跟随实际 B 高度，窄屏同步缩小）；
 *      组件不自己声明该变量，所以父级覆盖是安全的（见组件注释）。
 *   ② 布局：贴下半屏右下角 + 收回鼠标事件。
 *
 * ★ `pointer-events: auto` 必须留着：父级 .hero-contain 为放行 3D 舞台
 *   设了 pointer-events: none，不在这里收回来按钮就点不了。 */
.hero-next {
  --next-cap: calc(var(--brand-h) * 0.5);
  align-self: flex-end;
  pointer-events: auto;
}

@media (max-width: 991px) {
  .hero-next {
    --next-cap: calc(var(--brand-h) * 0.38);
  }
}

/* ★ m06383：中央舞台（`<HeroStage class="hero-visual">` 的定位与尺寸规则）
   已随 3D 一起删除 —— 这里原本写着「宽度 14rem、比例 4:5、绝对居中」。
   注意 `.hero` 有 padding-top（给导航让位），绝对定位的百分比以内边距盒为基准 —— 
   将来若真在中央挂东西，这条要重新算。 */

@media (max-width: 767px) {
  /* ★ 矮屏保底高度：避免 Blog 被压成一条细缝。
   *
   * 移动端 --brand-h 的垂直上限随屏幕高度缩小（公式见 .hero-contain 处）。
   * 极矮屏上 Blog 会小到看不清：实测 320×480 只有 71px、640×480 71px、
   * 360×568 122px（旧公式更差：430×420 会算出负值 → max-height 0 → Blog 完全消失）。
   * 而移动端导航虽然单行（--nav-h 69px / ≤520px 64px），在 480 高的矮屏上
   * 仍占了约 1/7 屏，加剧了这个问题。
   *
   * 保底 43rem(688px)：保证 Blog 至少 191px。
   * 视口更高时 100svh 更大，min-height 不生效，**正常手机竖屏不受影响**
   * （390×844 = 282px、430×932 = 333px）。
   * 代价：比 688px 矮的屏幕会多出一段滚动（375×667 仅多 21px，可忽略；
   * 320×480 这种极矮屏多 208px，但那时 Blog 本来就没法既大又不出滚动，
   * 两害相权取其大 —— 用户报的就是「被挤压」）。 */
  .hero {
    min-height: 43rem;
  }

  /* 移动端改为纵向堆叠。
     注意：父级 .hero-top/.hero-bottom 的 align-items 在纵向布局下会变成**水平**对齐，
     必须一并重置，否则内容会被推到右侧。 */
  .hero-top,
  .hero-bottom {
    flex-flow: column;
    align-items: flex-start;
    /* 不要用 center —— Blog 缩小后会被垂直居中、离顶部很远（实测 390px 下有 176px 空隙），
       那样就不像"左上角"了。改为贴顶排列。 */
    justify-content: flex-start;
    gap: var(--site-margin);
  }

  /* Blog 保持在左上角，同时 log 与 B 的**底部**对齐。
   *
   * 桌面端是横向 flex：row 用 height: 100% 撑满上半屏，再靠
   * align-items: flex-end 把 B 和 log 一起压到「上半屏底部」（原站设计）。
   * 但移动端切成纵向 flex 后，flex: 1 变成沿**垂直**方向伸张，
   * row 被撑到 312px 而 B 只有 130px → flex-end 会把 B 推到 row 底部
   * （离 hero 顶部 199px，就不是"左上角"了）。
   *
   * 所以移动端要让 row 的高度收缩到等于内容高度（B 的高度），两个都要写：
   *   flex: none   —— 取消纵向伸张，否则 height: auto 不生效
   *   height: auto —— 高度由内容决定，而不是撑满上半屏
   * 收缩后：B 在 row 顶部（左上角 ✓），log 被 flex-end 压到 B 的底部基线 ✓ */
  .hero-brand-row {
    flex: none;
    height: auto;
    align-items: flex-end;
    width: 100%;
  }

  /* ★★ 窄屏这行**不再承载音乐栏**（2026-09-22 改成固定圆形播放键）。
   *
   *   音乐栏在 ≤767px 是一个 `position: fixed` 的 48px 圆钮（见 MusicBar.vue），
   *   已经脱离 hero 的布局 —— 这里留一个高度为 0 的占位行即可，
   *   只是为了让 `.hero-top` 的 flex 顺序（Blog → 音乐栏 → caption）
   *   在 DOM 上保持一致。
   *
   *   ★ 关键：`margin-block` 与 `width` 都要归零，否则会白占一段垂直空间。
   *     归零后 caption 会直接跟在 Blog 后面 —— 这是对的，
   *     圆形播放键是浮层，不该挤占内容。 */
  .hero-music-row {
    position: static;
    margin-block: 0;
    width: 0;
    height: 0;
    overflow: visible;
  }

  /* 移动端舞台大小与位置改为**按内容高度**算。
     ★ 不再沿用桌面的 --brand-max-h：桌面是左右分栏（Blog 在左、图居中，
       要把图宽减掉再 ÷2）；移动端是纵向堆叠（Blog 在顶、舞台在中），
       两者不在同一水平线上、不争宽度，套桌面公式会把 Blog 压得极小。 */

  /* ★ 移动端**不再覆盖 `--visual-w`**：那一档没有任何消费者
     （`.hero-music` 的 `50% − visual-w/2` 上限只在 min-width: 768px 里生效，
     `--brand-max-h` 在移动端改用下面的 `--hero-content-h` 公式）。
     原来的 `.hero-contain, .hero-visual { --visual-w: clamp(...) }` 随 3D 舞台
     一起删掉（2026-10-08 大清洗）—— 留着只会让人以为移动端还有舞台。

     ★ 仍然成立的历史结论（将来若恢复中央舞台要照抄）：`--hero-content-h` 这类
     尺寸必须声明在 `.hero-contain` 上、**不能写在 `.hero` 上** ——
     `.hero` 上的值是 svh 兜底（100svh − nav-h），**不知道 `min-height: 43rem` 的存在**；
     矮屏上两者实测差 208px（411 vs 619），会把舞台算小到 132px（应为 198px）。
     `.hero-contain` 在 `@supports` 里拿到了准确的 `100cqh`，才是正确基准。

     ★ 移动端 `--brand-max-h` 的三条上限（见下）与桌面公式无关：
     桌面是左右分栏（要把舞台宽减掉再 ÷2），移动端是纵向堆叠、两者不争宽度。 */

  .hero-contain {
    /* ★ 移动端必须单独给尺寸，不能沿用桌面的 --brand-max-h。
     *
     * 三条上限取小：
     *   1) 整宽上限 —— Blog 独占一行，可用整个容器宽度
     *   2) 垂直预算 —— B 最多占内容高的 24%（2026-09-22 从 30% 下调）
     *   3) 宽度比例 —— B 组总宽不超过容器宽的 55%
     *
     * ★★ 为什么 30% → 24%（用户报「窄屏 Blog 略大，主要是高度」）：
     *   音乐栏插进 Blog 下方后，上半屏的顺序是 B → 音乐栏 → caption。
     *   30% 时实测 390×844 下 B 高 268px，加上音乐栏 58 与两段间距，
     *   上半屏被填得很满，视觉上 B 显得压抑（尤其纵向）。
     *   24% 后：390×844 的 B 高 268 → **214px**，比例回到舒展。
     *
     * ★ 为什么必须加上第 3 条（用户报「窄屏下 B 不缩小」）：
     *   前两条都**与视口宽度无关**（内容高只看高度），于是横向把窗口
     *   从 700 拉到 320，B 一直是 251px 不动，而它占容器宽的比例
     *   从 28% 一路涨到 65% —— 看起来就是「越窄越不缩、反而越显大」。
     *
     *   换算：B 组总宽 = 0.734 × h（B 宽 0.3597 + log 宽 0.3746），
     *   要它 ≤ 0.55 × 容器宽  →  h ≤ 0.55 / 0.734 = 0.75 × 容器宽。
     *
     * ★ 必须用 vw 而非 %：% 会在「使用它的元素」上解析（如 max-height 按高度算），结果错误。
     * ★ max() 兜底：内容高极小（极端矮屏）时防止算出 0 → Blog 直接消失。 */
    --brand-max-h: min(
      calc((100vw - var(--site-margin) * 2) / 0.734 - var(--gutter) * 2),
      max(2.5rem, calc(var(--hero-content-h) * 0.24)),
      max(2.5rem, calc((100vw - var(--site-margin) * 2) * 0.75))
    );
  }

  /* 舞台垂直位置。
   *
   * ★★ 音乐栏于 2026-09-22 改成侧边固定圆钮（fixed）后，**上半屏不再有它** ——
   *   流内顺序只剩 Blog → caption（`.hero-music-row` 高 0）。
   *   所以舞台要重新上移：原来那套「避开音乐栏」的推导已作废。
   *
   * 推导（相对 .hero-contain 顶边，contentH = --hero-content-h）：
   *   caption 底 = 16 + B + 16 + 18 = B + 50
   *   NEXT 顶    = contentH − 16 − nextH
   *   中心       = (B + 50 + contentH − 16 − nextH) / 2
   * 代入 B = 0.24·contentH、nextH = 0.38·B = 0.0912·contentH：
   *   中心 ≈ (0.24 + 1 − 0.0912)/2 · contentH + 17 = 0.574·contentH + 17
   *   → 约内容区的 **59%**（内容高越大，17px 的偏移越可忽略）。
   *   取 60% 作为实现值（略微下移一点，视觉上更稳）。
   *
   * ★★ 为什么 NEXT 从「贴底居中」改成「右下角」后不会撞上舞台：
   *   NEXT 在**右下**、舞台**水平居中**，两者横向错开
   *   （舞台宽 32% 内容高，390 下约 198px，居中后左右各余 ~96px；
   *    NEXT 贴右缘、舞台中线在 50% → 只在极窄屏才可能擦边）。
   *   实测见回归结果。
   *
   * inset 的百分比是相对 .hero 的整个盒子（含 padding-top: nav-h），
   * 而我们要的是「内容区的 p」，换算成 p + nav-h × (1 − p)
   * （推导：目标 = nav-h + 内容高 × p；而 nav-h + 内容高 = 100%
   *         → 目标 = 100% × p + nav-h × (1 − p)） */
  /* NEXT 贴右下角（与桌面端一致）。
   *
   * ★★ 为什么不是「正下方居中」（用户 2026-09-22 要求）：
   *   移动端不必跟桌面分叉 —— 右下角是本站 NEXT 的固定语言，
   *   居中反而像另一套设计。
   *
   * ★ 用 `align-self: flex-end` 推到行尾，再用 `margin-top: auto` 压到底。
   *   `.hero-bottom` 在移动端是 `flex-flow: column`，所以
   *   `align-self` 控制的是**水平**位置（flex-end = 靠右），
   *   `margin-top: auto` 负责垂直贴底。
   *
   * ★ 舞台的垂直位置（60%，见上一条规则的 `inset`）也是按「NEXT 在右下」算的，
   *   两者不冲突：NEXT 在右、舞台水平居中，横向错开。
   *
   * ★ 不再覆盖 --next-cap —— 沿用 ≤991px 的 0.38×B。 */
  .hero-next {
    align-self: flex-end;
    margin-top: auto;
    margin-bottom: 0;
  }
}
</style>

