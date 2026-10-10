<script setup lang="ts">
/**
 * SoundLine —— hero 中央的音频可视化横线
 *
 * ── 位置与规格照搬原站 mbrown.work 的 `curveCanvas` ──
 * 从原站源码脚本读出：
 *   - canvas 在 `.curve_canvas_wrap.u-cover-absolute` 里 → **铺满整个 hero**
 *   - 线在 **hero 垂直正中**：`centerY = containerHeight / 2`
 *   - 静止时是一条**贯穿全宽**的直线
 *   - `ctx.lineWidth = 0.5`，颜色取 `getComputedStyle(document.body).color`
 *
 * ── 分工（避免造轮子，也避免库做不了的事） ──
 *   库 @foobar404/wave 负责：音频图、每帧 getByteFrequencyData、clearRect、
 *                            rAF 循环、以及 `addAnimation({ draw })` 扩展点
 *   本组件负责：① 用官方扩展点提供线条绘制
 *              ② 补上库缺失的 **devicePixelRatio 适配**（库源码里没有 DPR，
 *                 不处理的话线在 2x/3x 屏上会糊）
 *
 * ── 驱动源：本页音乐（src/composables/lofi.ts 实时合成） ──
 *   原站是鼠标驱动（靠近时鼓起一个包）。音频没有"位置"概念，
 *   所以改成「中间振幅最大、两端收到 0」的对称包络 + 正弦波纹。
 *   位置、粗细、颜色、铺满方式都与原站一致。
 */
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { createRenderer, getRenderer, playerState } from '@/composables/lofi'
import { prefersReducedMotion } from '@/composables/motion'

const canvasEl = ref<HTMLCanvasElement | null>(null)

/**
 * 最大振幅（px，半高）。
 *
 * ★★ 这个值**不再写死** —— 它是「随画布宽度缩放」的，由 CSS 的
 *   `--wave-amp` 提供（见 <style> 里的推导），运行时由 refreshCssCache()
 *   从计算样式读出。
 *
 *   为什么必须跟着宽度缩：波形在 t∈[0,1] 上固定铺 8.6 个周期，
 *   窄屏波长按比例变短、振幅却不变 → 斜率暴涨 → 「起伏显得很大」。
 *   实测 1440 斜率 0.63、390 变成 2.35（≈4 倍）。
 *
 * 这里的常量只作为 **CSS 读不到时的兜底**（与桌面基准 40 一致）。
 * 调大调小请改 <style> 里 `--wave-amp` 的比例与上下限。
 */
const BASE_AMPLITUDE = 40
/** 运行时生效的振幅（refreshCssCache 里从 --wave-amp 读出） */
let MAX_AMPLITUDE = BASE_AMPLITUDE
/** 静止时的底线厚度（px）—— 原站 lineWidth 0.5，稍粗一点更可见 */
const BASE_WIDTH = 0.7
/** 波形点数。
 *
 * ★★ 从 180 降到 128（2026-09-20「违和感」复盘）。
 *   180 点是配合**旧的**高空间频率（最高 10.3 个周期）才需要的 ——
 *   而那正是问题的根源：全宽采样下波形有 49 次方向变化（平均每 28px 拐一次），
 *   最短波长只有 140px，看起来像心电图/噪声，不像水。
 *   现在最高周期数压到 8.6，128 点约 15 个采样/周期，已经足够平滑，
 *   而且每帧的计算量少了 29%。 */
const POINTS = 128
/**
 * 取频谱的前 64 个 bin。
 * 频谱长度 = analyser.frequencyBinCount = fftSize / 2 = 512（库会把 fftSize 设为 1024）。
 * 低频能量大、跟"鼓点/响度"相关性最高；拿全频段平均会被高频噪声冲淡。
 */
const BAND_END = 64

/* ==================== 波形形状：多谐波合成 ====================
 *
 * ★★ 为什么不用「单个正弦」（用户反馈「波动太均匀」）：
 *   旧实现是 `sin(2π · 3.2t − phase)` —— **固定 3.2 个周期的一条纯正弦**，
 *   而响度又只被压成一个标量（`readLevel` 把 64 个 bin 求平均）。
 *   于是波形**形状永远不变**，只有整体高低在动：
 *   鼓点、贝斯、镲片画出来长得一模一样 → 看着就是"均匀"。
 *
 *   现在把频谱切成 HARMONICS 段，**每一段驱动一个正弦分量**：
 *   低频段给出宽缓的大起伏，高频段给出细密的涟漪，
 *   各段能量此消彼长，形状才真正跟着音乐变。
 *
 * ★ 这是「用频谱的低频段做逆变换」的思路（相当于只保留前几个谐波的
 *   iFFT），所以看起来很"像波形"，而不是像随机的噪声。
 */
const HARMONICS = 5

/**
 * 各谐波的周期数（相对整幅宽度）。
 *
 * ★ 不要用 1,2,3,4,5 这种整数比 —— 整数比叠加后会**锁成周期图形**，
 *   又变回"均匀"。这里略微错开。
 *
 * ★★ 上限 10.3 → 6.6，这是「违和感」复盘的核心改动。
 *   空间频率越高，画面越像噪声。判据：在整幅宽度上均匀取 116 列，
 *   数波形拐弯（方向变化）的次数 —— 旧参数是 **49 次**（每 28px 拐一次），
 *   新参数是 **10 次**。叠加连续 4 帧看差异最直观：
 *   旧参数四帧互相穿插（"沸腾"），新参数平行有序平移（水在流）。
 *
 * ★ 真实水面的短波也有，但它们应该由**低频骨架调制出来**，
 *   而不是平行叠一层高频正弦 —— 后者是罗纹/布纹的成因。
 *
 * ★ 最宽分量取 1.3 而不是 1.0：整幅宽度上不只有「一个完整的包」，
 *   否则画面左右两侧会落在同一个相位、出现镜像对称感。
 */
const HARMONIC_CYCLES = [1.6, 2.9, 4.5, 6.3, 8.6]

/**
 * ★★ 各谐波的相位速度（弧度/帧，30fps 基准）从「写死的数组」改为
 *   「由周期数推出」。
 *
 *   水的色散关系是长波快、短波慢，且比例基本恒定 ——
 *   `speed_h = SPEED_K · cycles_h^DISP_N`。
 *
 *   旧数组是 [0.008 … 0.04]（比值 5.0），而周期比值是 10.3（7.9 倍）——
 *   对不上，于是各分量在画面里互相乱挤，相邻帧的"最佳位移"不恒定，
 *   这是"沸腾"感的第二个来源（第一个是空间频率太高）。
 *
 *   DISP_N = 0.92 接近线性 → 各分量速度比 ≈ 周期比，
 *   整个波形主要表现为**整体平移**（水在流动），而不是原地起伏。
 */
const DISP_N = 0.92

/** 相位速度系数：cycles=1 的分量每帧走 SPEED_K · 1^DISP_N 弧度 */
const SPEED_K = 0.023

const HARMONIC_SPEEDS = HARMONIC_CYCLES.map((c) => SPEED_K * Math.pow(c, DISP_N))

/**
 * ★★ 海浪质感之一：波峰尖窄、波谷宽平（斯托克斯二阶近似）。
 *
 *   纯 sin(θ) 是对称的，看起来像电子信号而不像水。
 *   真实海浪因开尔文波反折，波峰比波谷窄。
 *   加一个与二次谐波同相的项即可复现：
 *       sharp(θ) = sin(θ) + STOKES · sin(2θ)
 *   验证：θ=π/4 时 sin=0.707、sin(2θ)=1 → 肩部被抬高、峰变窄；
 *        谷底那一侧同样被抬起 → 谷变宽变平。
 *
 *   ★ STOKES_M 是该函数的最大绝对值（加载时数值扫描得出），
 *     用它归一化，保证单层波的峰值仍是 ±1，不会突破 MAX_AMPLITUDE。
 */
const STOKES = 0.32
const STOKES_M = (() => {
  let m = 1
  for (let k = 0; k <= 720; k++) {
    const th = (k * Math.PI) / 360
    m = Math.max(m, Math.abs(Math.sin(th) + STOKES * Math.sin(2 * th)))
  }
  return m
})()
const sharp = (th: number) => (Math.sin(th) + STOKES * Math.sin(2 * th)) / STOKES_M

/**
 * ★★ 海浪质感之二：成组涌动（浪是成群来的）。
 *
 *   真实海面在「大浪组」与「平静段」之间交替，而不是均匀地一直抖。
 *   用一个很慢的行波包络调制整体高度，观感就从「振动」变成「涨落」。
 */
const GROUP_CYCLES = 0.6
const GROUP_DEPTH = 0.42
/** 从 0.004 放慢到 0.0025：涌动周期约 33s，久到"察觉不到它在循环" */
const GROUP_SPEED = 0.005

/**
 * ★★ 海浪质感之三：泛波（细碎浪面）。
 *
 *   不管音乐多安静，海面总有一层细纹 —— 这是「水面」与「纯振动」的
 *   关键区别。
 *
 * ★ 周期数 26 → 7：26 个周期在 1440px 上只有 55px 波长，
 *   那是**罗纹/布纹**的尺度，不是水面。7 个（≈206px）才读得出"涟漪"。
 * ★ 幅度由高频段的活跃度调制（见 drawLine 里 ripple 那一行），
 *   鼓点一响细纹也跟着亮起来，不再是一条恒定的机械纹路。
 */
const RIPPLE_CYCLES = 7
const RIPPLE_AMP = 0.1
const RIPPLE_SPEED = 0.03

/**
 * 包络指数。< 1 = 中间那段更"平"，只在最两端收拢。
 * ★ 旧值是 sin(πt)（指数 1）—— 从头到尾都在收窄，看起来像被掐住的纺锤，
 *   这也是"均匀"观感的一部分。
 * ★ 0.45 → 0.55：空间频率降下来之后，若包络仍收得那么急，
 *   两端会显得"被剪刀剪断"。0.55 收得更缓，整体仍饱满。
 */
const ENVELOPE_POW = 0.55
/**
 * 电平参考值：前 64 个 bin 的平均能量达到它就映射到满幅。
 *
 * ★★ 为什么需要它（用户反馈「放音乐基本没什么波动」）：
 *   旧式是 `avg^0.85`，行程只用了一小半，还被 BODY_GAIN 的归一化再砍一刀。
 *   改成「先除以参考值、再上曲线」，让正常音量正好落在满幅附近。
 *
 * ★★ 0.24 → 0.78（2026-10-09 第三次整定，因为换了音源）：
 *   · 0.24 是给**当年的内置 lo-fi 合成器**定的 —— 那时 avg 稳定在 0.29，
 *     0.29/0.24 = 1.2 正好满幅。
 *   · 现在放的是**网易云真实曲目（320kbps）**：实测两首的 avg 中位数是
 *     **0.58 / 0.65**，除以 0.24 得 2.4 —— 于是 **95%~100% 的帧都贴在
 *     1.2 这个上限上**，画出来的振幅恒等于满幅，只剩相位在动。
 *     这就是用户说的「幅度对了，但跟音乐的律动不明显」。
 *   · 取 0.78 后真实曲目的中位电平落到 0.74 行程，鼓点还能往上顶，
 *     贴顶率从 95% 降到 ~5%（只有最响的那几下被软限幅）。
 *
 *   ★ 换音源（更响 / 更轻）时必须回来复测这两个数。
 */
const LEVEL_REF = 0.78
/**
 * 电平曲线指数（< 1 = 提亮中低电平）。
 * 0.85：只让弱拍稍微显现，整体仍然"跟着鼓点起落"而不是一直大张。
 * （曾试过 0.68 让弱拍也明显张开，用户看后要求调回。）
 */
const LEVEL_CURVE = 0.85

/**
 * ★★ 节拍冲量（2026-10-09 加）：让波浪跟着鼓点「顶」一下。
 *
 *   为什么需要：之前振幅只由**整体电平**驱动。实测网易云 320kbps 的实际曲目
 *   （`1311002329`）时，前 64 个 bin 的平均能量在整首歌里变化很小，
 *   峰谷跨度常年 50±5px —— 高度几乎不起落，看着只是「在慢慢平移」，
 *   这就是用户说的「波动不是很大」。
 *
 *   做法：用**两个时间常数不同**的包络做节拍检测 ——
 *     快包络（攻击 30ms / 释放 90ms）跟着鼓点起落，
 *     慢包络（250ms）当作当前的平均能量，
 *     两者之差除以慢包络 = 这一下的相对冲量 → 经 tanh 软限幅加到振幅上。
 *   两者都作用在**未截断**的比值上（截断后再做，鼓点会被削平）。
 *
 * ★★ 节拍信号 = 全带能量 + 2 × 谱通量（2026-10-09）：
 *   · 只用「能量」时实测每 23s 只抓到 16 次起落 = **0.69 次/s**，
 *     而同一段音频的谱通量自相关给出的真实节拍是 **1.68 拍/s**
 *     —— 漏掉六成鼓点：能量被中高频的持续声（人声 / 弦乐）托着，
 *     底鼓进来时它只涨一点点。
 *   · 谱通量（只累计「比上一帧更亮」的增量）对起音敏感，但单独用偏噪；
 *     两者相加（能量 + 2×通量）实测抓到 **1.69 次/s，与真实节拍 1.68 基本一致**。
 *   · 通量必须与能量用**同一把尺子**（都除以 LEVEL_REF）再相加，
 *     否则 punch 的分母跟着变，冲量强度失去标定（见 readLevel）。
 *
 *   PUNCH_GAIN = 0.9 ⇒ 一下最多把振幅多加 90%，
 *   上限 1.2 倍仍小于波带半高（--band-h 是振幅的 3.6 倍），不会溢出画布。
 */
const PUNCH_GAIN = 0.9
const PUNCH_K = 3
/**
 * 节拍信号里谱通量的权重（倍）。2 是实测选的：
 * 1 → 脉冲率 1.2 次/s（仍漏拍）；4 → 1.95 次/s（开始重报，把一拍算成两拍）。
 */
const FLUX_WEIGHT = 2
/** 上一帧的前 BAND_END 个 bin（谱通量要用）—— 预分配，避免每帧新建数组 */
const prevBins = new Uint8Array(BAND_END)
let hasPrevBins = false
let envFast = 0
let envSlow = 0

/**
 * ★★ 基形：各谐波的**固定**权重。
 *
 *   为什么必须有它（第一次改多谐波时踩的坑）：
 *   一开始用「实时频谱权重之和」做归一化 —— 但真实音乐的能量集中在低频，
 *   高频段常年接近 0，于是归一化分母被低频主导、高阶分量被压到看不见，
 *   形状**又退回单正弦**。实测「方向改变次数」只有 0~2（丰富波形该有 6~10）。
 *
 *   所以改成：**固定基形（保底有层次） + 频谱只调制深浅**。
 *   即使某段频段很安静，它也仍按基形贡献一份，形状不会退化。
 */
const BASE_SHAPE = [1, 0.62, 0.38, 0.22, 0.12]

/** 基形权重之和 —— 用它做归一化（常量，保证振幅稳定、不随音乐忽大忽小） */
const BASE_SHAPE_SUM = BASE_SHAPE.reduce((a, b) => a + b, 0)

/**
 * 频谱对基形的调制深度。
 *   0 = 形状完全固定（只随音乐上下起伏）
 *   1 = 形状完全由频谱决定（会退回上面说的"被低频主导"）
 *   0.72 是折中：安静频段仍保留约 28% 的基形贡献。
 */
const SHAPE_MOD = 0.72

/**
 * ★★ 主体增益 + 软限幅。
 *
 *   为什么需要：`sum / BASE_SHAPE_SUM` 这个归一化太保守 ——
 *   各谐波频率不同，极少同时到达峰值，所以实际包络只有理论最大值的
 *   一半左右（÷2.55 的分母是按"全部同相"算的）。
 *
 *   这里乘一个增益把行程用起来，再过 **tanh 软限幅**：
 *   它平滑趋近 ±1，保证任何时候都不会冲出画布，
 *   而且不像硬 clamp 那样在峰顶压出难看的平顶（会破坏海浪的尖峰感）。
 *
 * ★ 2.2 → 1.4：谐波从 6 个减到 5 个、且高频权重压得更低之后，
 *   分量更容易同相叠加，同样的增益会顶到 tanh 的饱和区。
 *   实测（400 帧扫描）：1.4 → 峰值 29px / 跨度 56px；2.2 → 峰值 36px（贴上限）。
 *   取 1.4，峰值与原版（24px）连续，观感不突变。
 */
const BODY_GAIN = 1.4

/* ---- 非响应式动画状态：每帧都在写，绝不能触发 Vue 响应式更新 ---- */
/** 各谐波的当前相位（初值错开，避免起手时所有分量同相叠加成一个尖峰） */
const hPhase = HARMONIC_CYCLES.map((_, h) => h * 0.7)
/** 各频段的**相对活跃度**（见 readHarmonics） */
const hAmp = new Array(HARMONICS).fill(1)
/** 成组涌动 / 泛波的相位 */
let groupPhase = 0
let ripplePhase = 0
let amp = 0
let smoothLevel = 0
let disposed = false
let dpr = 1
let ro: ResizeObserver | null = null

/* ==================== 归静过渡 ====================
 *
 * 需求：暂停音乐后，波形不应该**瞬间**塌成一条直线，而要有个
 *       「水面慢慢平静下来」的过渡。
 *
 * ★ 做法：暂停时不立刻切到静止态，而是进入 `settling`：
 *      · **冻结形状** —— 相位与各谐波活跃度都停在暂停那一帧，
 *        不再读频谱、不再推进相位。收敛过程中波峰只在原地变矮，
 *        不会左右乱窜（否则看着像"还在振"）。
 *      · **振幅平滑收到 0** —— 用 ease-out 曲线把振幅从暂停瞬间的值
 *        压到 0。收敛到 0 时 waveY(i) 恒等于 centerY，
 *        与 `paintStatic` 画的直线**逐像素一致**，所以最后换成静止态
 *        不会有任何跳变。
 *
 * ★ 时长 900ms：短于它显得还是在"啪"地断掉，长于它用户会以为卡住了。
 *
 * ★ 为什么不用 CSS transition 去缩放 canvas：
 *      那会把整块画布（含填充边界）一起做位图缩放，边缘会发虚，
 *      而且填充的下边界会跟着飘 —— 视觉上很假。
 *      在绘制层面收振幅，填充边界始终是"真实计算出来的水面"。
 */
const SETTLE_MS = 900
/** 归静是否进行中 */
let settling = false
/** 归静起点（performance.now()） */
let settleStartAt = 0
/** 暂停瞬间冻结的振幅（从这里开始收） */
let settleFromAmp = 0
/** 暂停瞬间冻结的相位（形状不再变化） */
const settleHPhase = new Array(HARMONICS).fill(0)
/** 暂停瞬间冻结的各谐波活跃度（不再跟随实时频谱） */
const settleHAmp = new Array(HARMONICS).fill(1)
let settleGroupPhase = 0
let settleRipplePhase = 0
/** 归静完成后的兜底定时器 */
let settleTimer: ReturnType<typeof setTimeout> | null = null

/** ease-out cubic：先快后慢，末段几乎察觉不到在动，像水面自然平息 */
const settleEase = (p: number) => 1 - Math.pow(1 - p, 3)

/** 进入归静状态（由 playerState → idle 触发） */
function beginSettle() {
  if (settling) return
  settling = true
  settleStartAt = performance.now()
  /* 从**当前**振幅接着收，不能从 MAX_AMPLITUDE 开始 ——
     否则暂停那一刻会先"涨一下"再收，像被弹了一下。 */
  settleFromAmp = amp
  for (let h = 0; h < HARMONICS; h++) {
    settleHPhase[h] = hPhase[h]
    settleHAmp[h] = hAmp[h]
  }
  settleGroupPhase = groupPhase
  settleRipplePhase = ripplePhase

  /* ★ 兜底：库的 rAF 在某些情况下会停（标签页隐藏被限流、
     或库内部异常），那样就永远没人来推进归静。
     到点强制切静止态，保证画面最终一定是平的。 */
  if (settleTimer) clearTimeout(settleTimer)
  settleTimer = setTimeout(() => {
    settleTimer = null
    if (!disposed && settling) {
      settling = false
      stopLibraryLoop()
    }
  }, SETTLE_MS + 260)
}

/** 结束归静（点播放、或归静已跑完） */
function endSettle() {
  if (settleTimer) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
  settling = false
}

/* ★★ 缓存抓取：`getComputedStyle` 每帧调用会强制样式重算。
 *   旧代码每帧在 drawLine 里调 `getComputedStyle(document.body).color`
 *   和两处 `getComputedStyle(document.documentElement)`，
 *   在 1440×900 全屏重绘的背景下这是可观测的开销。
 *   现在只在挂载与 resize 时抓一次，值不变就一直复用。 */
let cssCache = { top: '#195bcc', line: '#1049d0', fill: '#0735bd', text: '#fff8e7', amp: 40 }
function refreshCssCache() {
  const root = getComputedStyle(document.documentElement)
  const pick = (name: string, fb: string) => root.getPropertyValue(name).trim() || fb
  /* ★ 振幅从 .sound-line 上读（它是 --wave-amp 的定义处）。
     读不到就退回桌面基准值，保证脚本单独跑也不崩。 */
  const wrap = canvasEl.value?.parentElement
  const wrapAmp = wrap
    ? parseFloat(getComputedStyle(wrap).getPropertyValue('--wave-amp'))
    : NaN
  const amp = Number.isFinite(wrapAmp) && wrapAmp > 0 ? wrapAmp : BASE_AMPLITUDE
  MAX_AMPLITUDE = amp
  cssCache = {
    top: pick('--bg-top', '#195bcc'),
    line: pick('--hero-line', '#1049d0'),
    fill: pick('--hero-fill', '#0735bd'),
    text: getComputedStyle(document.body).color || '#fff8e7',
    amp,
  }
}

/**
 * ★★ 帧率无关的时间步长。
 *
 *   旧代码的相位推进与平滑都是**按帧**写的（`hPhase[h] += 0.008`、
 *   `smoothLevel += (target - smoothLevel) * 0.3`）——
 *   在 120Hz 屏上动画速度会是 60Hz 的两倍，笔记本插电/省电切换时也会变速。
 *   更糟的是掉帧时：帧率越低 → 每秒推进越少 → 动画**同时**变卡又变慢。
 *
 *   现在统一按真实时间推进：
 *     - 相位：`phase += speed · dt / 33.3`（33.3ms 对应原设计基准的低帧率）
 *     - 平滑：用指数衰减 `1 - exp(-dt / tau)`，与帧率无关地收敛到同一曲线
 *
 *   取 dt 上限 100ms：标签页切回来 / 长时间掉帧时不会\"瞬移\"。
 */
let lastTime = 0
let dtScale = 1
/** 指数平滑系数：给定时间常数 tau，算出当前 dt 下应插值的比例 */
const tauK = (dt: number, tau: number) => 1 - Math.exp(-dt / tau)

/**
 * ★★ 背景渐变已改由 CSS 层的 `.sound-line-bg` 提供（见文件末尾的 `<style>`）。
 *
 *   为什么要挪走：库每帧 `clearRect(0,0,canvas.width,canvas.height)` 会清掉
 *   整块画布，而画布原来是**铺满整个 hero**的（1440×900×dpr²）——
 *   我们被迫每帧 `fillRect` 重画一遍全屏渐变，实际却只有中心 ~120px 的波带
 *   在变化。挪到 CSS 后：渐变由合成器一次性栅格化，canvas 只剩中心波带，
 *   每帧重绘面积降到约 **1/7.5**（这是「帧数很低」的主因）。
 *
 *   ★ 停止点必须与原来的 canvas 渐变**完全一致**（顶部 → 50% 处收束到
 *     --hero-line → 以下 --hero-fill），否则会看出色差。
 *     hero 的垂直中心就是波带中心，两者天然对齐。 */

/** 从频谱数据算 0..1 总电平（用于控制整体振幅与线宽） */
function readLevel(data: Uint8Array) {
  const end = Math.min(BAND_END, data.length)
  let sum = 0
  for (let i = 0; i < end; i++) sum += data[i]
  const avg = sum / end / 255

  /* 谱通量：只累计「比上一帧更亮」的那部分增量（鼓点 / 起音处的尖峰）。
     ★ 必须与能量用同一把尺子（除以 LEVEL_REF）再进包络，
       否则慢包络的基准变了，punch 的标定就失效。 */
  let flux = 0
  if (hasPrevBins) {
    let rise = 0
    for (let i = 0; i < end; i++) {
      const d = data[i] - prevBins[i]
      if (d > 0) rise += d
    }
    flux = rise / end / 255
  }
  prevBins.set(data.subarray(0, end))
  hasPrevBins = true

  /* 先除以参考电平再上曲线 —— 理由见 LEVEL_REF 的注释 */
  const norm = avg / LEVEL_REF
  /* 节拍信号 = 能量 + 2×谱通量（理由见 FLUX_WEIGHT 的注释） */
  const beat = norm + (FLUX_WEIGHT * flux) / LEVEL_REF
  /* 节拍冲量：快包络超出慢包络多少（见 PUNCH_GAIN 的注释） */
  envFast += (beat - envFast) * tauK(dtScale * 33.3, beat > envFast ? 30 : 90)
  envSlow += (beat - envSlow) * tauK(dtScale * 33.3, 250)
  const punch = Math.max(0, (envFast - envSlow) / Math.max(0.25, envSlow))
  return Math.min(
    1.2,
    Math.pow(norm, LEVEL_CURVE) * (1 + PUNCH_GAIN * Math.tanh(punch * PUNCH_K)),
  )
}

/** 把频谱均分成 HARMONICS 段，逐段求平均 → 各谐波的**相对活跃度**
 *
 *  ★ 这一步是「让形状跟着音乐变」的关键：
 *    低频段能量强 → 宽缓的大起伏；高频段（镲片 / s 音）亮起来时，
 *    细密涟漪才浮现。各段此消彼长，每帧的波形都不同。
 *
 *  ★★ 用「频段占比」而不是「按各自峰值归一化」（2026-09-20 复盘）。
 *
 *    旧实现是 `raw / hPeak[h]`，而 hPeak 的上升系数是 0.02/帧（≈1.2/s）
 *    —— 几乎瞬间就跟上波峰，于是 `target` 常年在 1 附近**饱和**，
 *    形状被冻结成一条固定的多谐波曲线：SHAPE_MOD 那点调制完全没生效，
 *    波形看起来永远是同一条"噪声"在上下平移。这正是「违和感」的来源之一。
 *
 *    现在改成**无状态**的频段占比：
 *      share_h = 该段平均能量 / 全体平均能量     （1 = 与全频平均持平）
 *  → 不依赖历史，不会饱和；轻段落占比仍然成立。
 *    最后 clamp 到 [0.15, 1.35]，既允许高频段在安静时压到很低（细纹消失），
 *    也允许镲片亮起时短时超过 1（细纹浮现），但不会失控。
 *
 *  ★ 直接写进 hAmp 而不是返回新数组：这个函数每帧都调，
 *    避免每秒 60 次的对象分配（GC 抖动会体现在动画的细微卡顿上）。
 */
function readHarmonics(data: Uint8Array) {
  const end = Math.min(BAND_END, data.length)
  const seg = end / HARMONICS
  let all = 0
  for (let i = 0; i < end; i++) all += data[i]
  const avgAll = Math.max(1, all / end)

  for (let h = 0; h < HARMONICS; h++) {
    const lo = Math.floor(h * seg)
    const hi = Math.min(end, Math.floor((h + 1) * seg))
    let sum = 0
    for (let i = lo; i < hi; i++) sum += data[i]
    const raw = sum / Math.max(1, hi - lo)

    const share = raw / avgAll
    const target = Math.min(1.35, Math.max(0.15, 0.35 + 0.65 * share))

    /* 轻微平滑一下，避免频谱跳变传导成形状抖动（时间常数很小，不影响响应） */
    hAmp[h] += (target - hAmp[h]) * tauK(dtScale * 33.3, 40)
  }
}

/**
 * 自定义动画 —— 交给 wave.js 每帧调用（签名来自库的 `IAnimation` 接口）
 *
 * ★ waveY 定义为 drawLine 内部的闭包，直接捕获 centerY / amp。
 *   之前它是模块级函数 `waveY(i, w, centerY, a)`，改签名时漏改了调用点，
 *   JS 不检查参数个数 → 参数静默错位（centerY 收到 w=1425，amp 被丢弃），
 *   波形被画到 y≈1425（画布外），表现为"线消失、填充不动、画面静止"，
 *   而且没有任何报错。闭包传参从根上避免这类错误。
 */
function drawLine(data: Uint8Array, c: CanvasRenderingContext2D) {
  if (disposed) return

  /* 0) 时间步长 —— 相位推进与平滑都按真实时间走，帧率无关（见 dtScale 注释） */
  const now = performance.now()
  dtScale = lastTime ? Math.min(3, Math.max(0.25, (now - lastTime) / 33.3)) : 1
  lastTime = now

  /* ★★ 归静中：不读频谱、不推进相位 —— 形状冻结，只让振幅收到 0。
   *    这里把 frozen 传下去，paintWaves 会走"固定相位 + 固定活跃度"那一支。 */
  if (settling) {
    const p = Math.min(1, (now - settleStartAt) / SETTLE_MS)
    amp = settleFromAmp * (1 - settleEase(p))
    paintWaves(c, true, amp)
    if (p >= 1) {
      /* 收到 0 后再切静止态：此时 waveY(i) === centerY，
         与 paintStatic 画的直线逐像素一致，切换零跳变。 */
      endSettle()
      amp = 0
      stopLibraryLoop()
    }
    return
  }

  /* 1) 总电平 → 整体振幅（控制"跳得多高"）
   * ★ 时间常数 110/190 → 45/240ms（2026-10-09）：
   *   110ms 的攻击会把鼓点的瞬态抹成一道缓坡 —— 冲量算得再准，
   *   画出来也只是「慢慢涨上去」。攻击收到 45ms 才能跟着鼓点"顿"一下；
   *   释放放宽到 240ms，让它像水面一样慢慢落回去。 */
  const target = readLevel(data) * MAX_AMPLITUDE
  smoothLevel += (target - smoothLevel) * tauK(dtScale * 33.3, target > smoothLevel ? 45 : 240)
  amp = smoothLevel

  /* 2) 频谱分段 → 各频段的相对活跃度（控制"形状长什么样"） */
  readHarmonics(data)

  /* 3) 相位推进 */
  for (let hh = 0; hh < HARMONICS; hh++) hPhase[hh] += HARMONIC_SPEEDS[hh] * dtScale
  groupPhase += GROUP_SPEED * dtScale
  ripplePhase += RIPPLE_SPEED * dtScale

  paintWaves(c, false, amp)
}

/**
 * 波形绘制核心 —— 填充「音频线以下」的区域 + 描出那条线。
 *
 * ★★ 抽成独立函数，让**播放态**与**归静态**共用同一套几何计算。
 *    这一点很重要：归静最后一帧的 `waveY(i)` 必须与 `paintStatic` 的直线
 *    完全重合（振幅收到 0 时两者都等于 centerY）。如果两处各写一份，
 *    迟早会漂移，切换瞬间就会"跳一下"。
 *
 * @param frozen 归静中 —— 用冻结的相位/活跃度，忽略实时 hPhase / hAmp
 * @param amplitude 本帧要用的振幅（归静时是收敛值，播放时是平滑后电平）
 */
function paintWaves(c: CanvasRenderingContext2D, frozen: boolean, amplitude: number) {
  const cv = c.canvas
  /* ★ canvas.width/height 是设备像素（我们乘过 dpr），要换算回 CSS 像素，
     否则在高 DPR 屏上画出来的东西会偏小。库本身不做 DPR，所以这里自己管。 */
  const w = cv.width / dpr
  const h = cv.height / dpr
  const centerY = h / 2

  /** 第 i 个采样点的波形 y（画线与填充共用，保证边缘完全一致）
   *
   *  ★★ 海浪质感的三层叠加（缺一层都不像水）：
   *
   *   ① 主体涌浪 —— 基形权重 × 频谱调制，再经 sharp() 把正弦
   *      变成「波峰窄、波谷宽」的海浪剖面。
   *      归一化用**常量** BASE_SHAPE_SUM（不是实时权重和 ——
   *      用实时和的话，高频安静时高阶项会被压到看不见、形状退回正弦）。
   *      之后乘 BODY_GAIN 把行程用满，再过 tanh 软限幅（理由见常量注释）。
   *
   *   ② 成组涌动 —— 一个很慢的行波包络。真实海面是"一波一波"来的，
   *      不是均匀振动。它让画面有涨落的节奏感。
   *
   *   ③ 泛波 —— 中等频率、低幅度的细纹，由高频段活跃度调制。
   *      保证任何时候水面都不是"干净的正弦"，有海面的琐碎感。
   *
   *  ★ 闭包内不查表、不分配：这是每帧 128 次的热路径。
   */
  /* ★★ 分工（用户 m05994）：「wave 组件不能同时做到监听和承受立方体震荡两件事」
     → 这条音乐波线**只管音乐**，撞击的顶起完全不进来（它由上面那层
     `.sound-line-spray` 画成一帧静止的画面）。这样放歌时线照常律动，
     撞击点的水花是冻住的，两者互不打架。 */
  const waveY = (i: number) => {
    const t = i / POINTS
    /* 包络：两端收到 0，中间保持饱满（指数见 ENVELOPE_POW） */
    const envelope = Math.pow(Math.sin(Math.PI * t), ENVELOPE_POW)

    /* ① 主体 */
    let sum = 0
    for (let hh = 0; hh < HARMONICS; hh++) {
      const live = frozen ? settleHAmp[hh] : hAmp[hh]
      const weight = BASE_SHAPE[hh] * (1 - SHAPE_MOD + SHAPE_MOD * live)
      const th =
        t * Math.PI * 2 * HARMONIC_CYCLES[hh] -
        (frozen ? settleHPhase[hh] : hPhase[hh])
      sum += sharp(th) * weight
    }
    const body = Math.tanh((sum / BASE_SHAPE_SUM) * BODY_GAIN)

    /* ② 成组涌动：沿 x 缓慢推移的行波，把整体高度调制到 GROUP_DEPTH..1 */
    const gp = frozen ? settleGroupPhase : groupPhase
    const group =
      GROUP_DEPTH + (1 - GROUP_DEPTH) * (0.5 + 0.5 * Math.sin(t * Math.PI * 2 * GROUP_CYCLES - gp))

    /* ③ 泛波：细纹，幅度跟随高频段活跃度（hAmp[3]/hAmp[4]） */
    const rippleLive = frozen
      ? (settleHAmp[3] + settleHAmp[4]) * 0.5
      : (hAmp[3] + hAmp[4]) * 0.5
    const rp = frozen ? settleRipplePhase : ripplePhase
    const ripple = RIPPLE_AMP * rippleLive * Math.sin(t * Math.PI * 2 * RIPPLE_CYCLES - rp)

    return centerY + (body * group + ripple) * envelope * amplitude
  }

  /* ★ 背景由 CSS 层负责，canvas 是透明的 → 每帧只需 clearRect
     （库的 clearRect 已经清过全屏，这里清是为了保险 + 尺寸变化后首帧）。
     ★ 不再有每帧全屏 fillRect！这是帧率提升的关键。 */
  c.clearRect(0, 0, w, h)

  /* ★★★ 画「波线**以上**」的天空 = 遮罩（用户 m06218 的架构）。
   *
   *   以前画的是波线**以下**的 --hero-fill「水体」——于是水体必须跟着波形逐帧对齐，
   *   一旦对不齐（或波带外侧的 CSS 直边与波形分家）就露馅：用户报的
   *   「下方水体跟 wave 不同步、无论什么时候都不能有瑕疵」就是这条路走不通。
   *
   *   现在反过来：canvas 只在天上刷一层**与上方 CSS 渐变末端同色**的实色（--hero-line），
   *   波线以下**留透明**。于是：
   *     · 天上 = 这层实色（与 .sound-line-bg 的渐变在波带顶边处同色 → 无缝）；
   *     · 水下 = 透明 → 透出 z-index 更低的 .water-body（一大块 --hero-fill 色块 +
   *       水彩染料）。波线一动，露出的水体高度就跟着变 —— **不需要任何同步**。
   *   路径：沿波形从左到右，再沿右上→左上闭合（只覆盖曲线之上）。
   *   ★ 步长取 2：128 点里 64 段直线在 1440px 下每段 22px，
   *     对平滑曲线而言肉眼无差，但这让填充路径的段数减半。 */
  c.beginPath()
  c.moveTo(0, waveY(0))
  for (let i = 2; i <= POINTS; i += 2) {
    c.lineTo((i / POINTS) * w, waveY(i))
  }
  c.lineTo(w, waveY(POINTS))
  c.lineTo(w, 0)
  c.lineTo(0, 0)
  c.closePath()
  c.fillStyle = cssCache.line
  c.fill()

  /* 再画那条线（叠在填充之上，边缘干净）
   * ★ 描线保持逐点 —— 线是视觉焦点，这里不省。 */
  c.beginPath()
  for (let i = 0; i <= POINTS; i++) {
    const x = (i / POINTS) * w
    const y = waveY(i)
    if (i === 0) c.moveTo(x, y)
    else c.lineTo(x, y)
  }

  /* 线条颜色跟随正文色（挂载时抓取并缓存，不再每帧 getComputedStyle）。 */
  c.strokeStyle = cssCache.text
  c.lineWidth = BASE_WIDTH + amplitude / 26
  c.lineCap = 'round'
  c.stroke()
}

const customAnimation = { draw: drawLine }

/** 设置 canvas 物理像素尺寸（backing store），并把 2D 上下文缩放到 CSS 像素坐标系
 *
 *  ★★ 绝不能把量到的尺寸再写回 `style.width/height`（2026-09-20 踩到）。
 *
 *    canvas 的 CSS 尺寸已经完全由样式表决定（`width: 100%`、
 *    `height: var(--band-h)`），这里**只需要**设置设备像素的 backing store。
 *
 *    旧写法量的是 canvas 自己的框，然后又写回内联 `style.width` ——
 *    这就形成了**自引用**：内联宽 → canvas 框宽 → 下一帧量到的还是它。
 *    一旦某次量到 0（视口是 0×0 时挂载、元素在 display:none 的容器里、
 *    或路由切换时尚未布局），就会把 `width: 0px` **写死**下来，
 *    之后每次测量读到的都是 0 → 命中「尺寸没变就 return」→ 永久不可见。
 *    实测：集成浏览器默认 0×0 视口下加载后，即使把视口调到 1440，
 *    canvas 也永远停在 0px（波形整条消失，且无任何报错）。
 *
 *    现在：宽度取**父级** `.sound-line`（`inset: 0` 铺满 hero，不受 canvas
 *    自身尺寸影响，无自引用）；高度取 canvas 的 CSS 计算高度（由 --band-h
 *    决定，我们不再写内联值）。两者都是外部输入，循环被打断。 */
function resize() {
  const cv = canvasEl.value
  const wrap = cv?.parentElement
  if (!cv || !wrap) return

  const nextDpr = window.devicePixelRatio || 1
  const cssW = wrap.getBoundingClientRect().width
  const cssH = cv.getBoundingClientRect().height
  const nextW = Math.max(1, Math.round(cssW * nextDpr))
  const nextH = Math.max(1, Math.round(cssH * nextDpr))

  /* ★★ 尺寸没变就直接返回。
   *   否则 ResizeObserver 的抖动回调会反复重置 canvas ——
   *   而重置 canvas（= 重设 width/height 属性）会清空内容，
   *   播放中每帧重绘又可能触发下一次回调，
   *   形成"画静止线 → 覆盖动画画面"的死循环
   *   （实测症状：fillRect 每秒调用 57 次，但画面两帧完全相同、白线消失）。 */
  if (cv.width === nextW && cv.height === nextH && dpr === nextDpr) return

  dpr = nextDpr
  cv.width = nextW
  cv.height = nextH
  /* ★ 不写 cv.style.width / height —— CSS 尺寸由样式表负责（见函数注释）。 */

  const c = cv.getContext('2d')
  /* ★ 库每帧调用 clearRect(0,0,canvas.width,canvas.height) 用的也是设备像素，
     配合这个 setTransform，坐标系就是 CSS 像素，线宽才不会被 DPR 放大。 */
  if (c) c.setTransform(dpr, 0, 0, dpr, 0, 0)

  /* 尺寸变了 → 重新抓一次 CSS 变量（顺便拿到主题色更新） */
  refreshCssCache()

  /* ★ 只有在「没有动画在跑」时才重画静止态。
   *   播放中库的 rAF 会自己重绘，这里再画一次只会把动画覆盖掉。
   *   ★ 归静中（playerState 已是 idle，但画面还在收）也**不能**重画 ——
   *     否则 resize 一触发波形就会直接变平线，过渡被吃掉了。 */
  if (playerState.value !== 'playing' && !settling) drawStaticLine()
}

/** 绘制静止态：透明背景 + 线以下实心填充 + 一条水平直线。
 *
 * ★ 与播放态保持同一套视觉：否则暂停时会突然丢掉填充（背景露出 CSS 渐变），观感突兀。
 *
 * ★ 接收 cv / c 而不是自己去取 DOM 节点：它有两条调用路径 ——
 *   ① 直接调用（首屏、prefers-reduced-motion）
 *   ② 作为 wave.js 的动画回调（见下方 staticAnimation）。 */
/** 静止态（没放歌 / reduced-motion / 库不可用时的兜底）：画一条平直的海平面。
 *
 *  ★ 这里**不再**有撞击顶起量（原来有 kickLift）—— 撞击的水花统一由
 *    `.sound-line-spray` 那层「冻结帧」负责，音乐线与静止线都保持纯净。 */
function paintStatic(cv: HTMLCanvasElement, c: CanvasRenderingContext2D) {
  const w = cv.width / dpr
  const h = cv.height / dpr
  const centerY = h / 2

  c.clearRect(0, 0, w, h)

  /* 与库驱动的 paintWaves 同一套遮罩语义：**线以上**刷 --hero-line，线以下透明 */
  c.beginPath()
  c.moveTo(0, centerY)
  c.lineTo(w, centerY)
  c.lineTo(w, 0)
  c.lineTo(0, 0)
  c.closePath()
  c.fillStyle = cssCache.line
  c.fill()

  /* 海平面那条线（颜色跟随正文色，兜底米色 = --text） */
  c.beginPath()
  c.moveTo(0, centerY)
  c.lineTo(w, centerY)
  c.strokeStyle = cssCache.text
  c.lineWidth = BASE_WIDTH
  c.stroke()
}

/** 静止态：直接画一次。用于首屏、reduced-motion、以及库不可用时的兜底 */
function drawStaticLine() {
  const cv = canvasEl.value
  const c = cv?.getContext('2d')
  if (!cv || !c) return
  paintStatic(cv, c)
}

/** 静止态的**动画形态** —— 注册进库的 rAF 循环
 *
 * ★★ 这是「点暂停后整个 wave 组件消失」的修复核心。
 *
 *   根因：wave.js 的 rAF 循环**永不停歇**（它 bundle 里
 *   `cancelAnimationFrame` 出现 0 次），而 `clearAnimations()` 只是
 *   `this._activeAnimations = []` —— 循环依旧每帧执行：
 *       getByteFrequencyData → clearRect(整块画布) → forEach(空数组)
 *   所以暂停时我们手画的静止线，会在**下一帧**被 clearRect 擦掉 →
 *   画布变全透明 → 渐变、波形填充、线全部消失。
 *   （因为 hero 的渐变是画在 canvas 上的，canvas 一透明就“整个没了”。）
 *
 *   正解：暂停时不是「摘掉所有动画」，而是把动画**换成静止态这一支**。
 *   库每帧仍然回调我们，画出来的永远是静止画面，视觉稳定。
 *   代价与播放时相同 —— 反正循环本来就没停过。
 *
 *   ★ 不要试图去 cancelAnimationFrame：库没有暴露 rAF 句柄，取不到。 */
const staticAnimation = {
  draw: (_data: Uint8Array, c: CanvasRenderingContext2D) => {
    if (disposed) return
    paintStatic(c.canvas, c)
  },
}

/** 交给库驱动渲染：库内部 rAF + clearRect + 取频谱，然后调我们的 draw
 *
 * ★ createRenderer 内部会比对 canvas：组件重挂载后 canvas 是新的，
 *   它会重建实例，而不是把动画挂到一个已脱离 DOM 的旧 canvas 上。 */
function startLibraryLoop() {
  const cv = canvasEl.value
  if (!cv) return
  const wave = createRenderer(cv)
  if (!wave) return
  wave.clearAnimations()
  wave.addAnimation(customAnimation)
}

/** 切回静止态。
 *
 *  ★ 不要用 getRenderer()?.clearAnimations() —— 那可能作用在旧实例上；
 *    统一走 createRenderer(cv)，保证操作的是当前 canvas 对应的实例。
 *
 *  ★★ 也不能只是 clearAnimations()：库的 rAF 循环不会停，空数组状态下
 *    它每帧 clearRect 会把画面擦成透明（就是「暂停后组件消失」的根因）。
 *    所以要把动画**换成静止态那一支**，让库继续帮我们每帧重画。 */
function stopLibraryLoop() {
  const cv = canvasEl.value
  const wave = cv ? createRenderer(cv) : null
  if (wave) {
    wave.clearAnimations()
    wave.addAnimation(staticAnimation)
    return
  }
  /* 库不可用（没有 analyser，例如从未点过播放）→ 根本没有 rAF 循环在跑，
     不会有人擦掉画面，画一次就够了。 */
  drawStaticLine()
}

/* ==================== 撞击水花：线条版 ====================
 *
 * 用户 m05402：wave 组件（这条波线）**也要有水溅效果**，但
 * 「只是线条像水花一样飞起来」。所以不去动库的循环（那是给音频波形用的），
 * 而是自己拿一块贴着海平面往上的画布，用一次性 rAF 画几十道
 * 「带速度拖尾的短线」：从线上飞起、受重力落回线里 —— 就是水被砸起来那一瞬。
 *
 * ★ 三条纪律（和 hero 其它部分一致）：
 *   ① 只在有水花时跑 rAF —— 不砸的时候连一帧都不画；
 *   ② 画布只覆盖海平面**以上**一条带（--spray-h），不铺满 hero，重绘面积尽量小；
 *   ③ pointer-events: none，绝不抢水体的鼠标。
 */
/* ★ m06383：撞击水花整层已删除（3D 舞台与碰撞逻辑一起移除）。
   这里原来有 `sprayEl` 画布、`Stroke`/`Drop` 类型、`splashStrokes`/`splashDrops`
   状态、`resizeSpray()` / `spray()` / `calm()` / `paintSplash()` 与 `defineExpose`，
   以及「水体跟着水平面走」的 `--sea-lift` 同步链 —— 现在这条音乐线只管音乐，
   海平面完全由它自己这条波线定义（水体是一块固定色块，见 WaterBody.vue）。 */

/* ★ m06383：`spray()`（撞击时冻结一帧水花）已随碰撞逻辑删除。 */

/* ★ m06383：`calm()` / `paintSplash()` / `defineExpose({ spray, calm })` /
   DEV 钩子 `window.__sl`（都只服务于撞击水花）已一并删除。 */

/* 播放状态变化时挂上 / 摘掉库的动画
 *
 * ★★ 暂停走「归静过渡」而不是立刻切静止态（用户要求）：
 *      立即切会看到波形**瞬间**塌成直线，很生硬。
 *      现在先冻结形状、把振幅用 900ms 收到 0，收完再切静止态
 *      （此时两者几何完全一致，切换无跳变）。
 *      `beginSettle()` 内部的兜底定时器负责在 rAF 没推进时兜住。 */
watch(playerState, (s) => {
  if (prefersReducedMotion()) return
  if (s === 'playing') {
    endSettle()
    startLibraryLoop()
  } else {
    beginSettle()
  }
})

onMounted(() => {
  refreshCssCache()
  resize()

  if (canvasEl.value && typeof ResizeObserver !== 'undefined') {
    /* ★ 观察 canvas 自身（宽度随视口变、高度由 --band-h 决定）。
     *   ★ 不要再在这里额外 drawStaticLine()：
     *   resize() 内部已经按「是否正在播放」决定要不要重画静止态。
     *   旧代码写的是 `if (!getRenderer()) drawStaticLine()`，
     *   而 renderer 在首次播放前恒为 null → 每次回调都覆盖画面，
     *   正是"播放时波形不动、白线消失"的元凶。 */
    ro = new ResizeObserver(() => resize())
    ro.observe(canvasEl.value)
  }
  window.addEventListener('resize', resize)

  /* 无障碍：不跑动画循环，只画一条静止直线（保持这个视觉元素存在） */
  if (prefersReducedMotion()) {
    drawStaticLine()
    return
  }

  /* 未播放时先画静止线；点播放后由 lofi.play() → createRenderer 接管。 */
  drawStaticLine()
  if (playerState.value === 'playing') startLibraryLoop()
})

onBeforeUnmount(() => {
  disposed = true
  /* ★ 清掉归静的兜底定时器，否则组件已销毁它还会去调 stopLibraryLoop */
  if (settleTimer) {
    clearTimeout(settleTimer)
    settleTimer = null
  }
  settling = false
  /* ★ 卸载时务必摘掉动画：库的 rAF 循环是自持的，不清就会一直跑下去
     （画在一个已脱离 DOM 的 canvas 上，属于内存/CPU 泄漏）。 */
  getRenderer()?.clearAnimations()
  ro?.disconnect()
  ro = null
  window.removeEventListener('resize', resize)
})
</script>

<template>
  <!-- 铺满 hero（与原站 .curve_canvas_wrap.u-cover-absolute 一致）。
       pointer-events: none —— 不能挡住水体与 NEXT 的交互。
       ★ 内部两层：背景渐变（静态，由 CSS 画）+ 中心波带 canvas（每帧重绘）。
         m06383 起「撞击水花 canvas」已随 3D/碰撞一起删除。 -->
  <div class="sound-line" aria-hidden="true">
    <div class="sound-line-bg"></div>
    <canvas ref="canvasEl" class="sound-line-canvas"></canvas>
  </div>
</template>

<style scoped>
/* ★★ 把 --wave-amp 注册成真正的 `<length>`。
 *
 *   自定义属性默认是「未类型化」的 —— `getComputedStyle().getPropertyValue()`
 *   返回的是**原始 token 串**（`clamp(7px, 100cqw * 0.0275, 40px)`），
 *   而不是解析后的值。JS 里 `parseFloat(...)` 会得到 NaN，
 *   `max-height: var(--wave-amp)` 这类也拿不到数值。
 *
 *   注册之后它才是一个带类型的长度，计算样式返回 `40px` 这样的实值，
 *   JS 与 CSS 都能正常使用（实测 registerProperty 支持、解析正常）。
 *   ★ `inherits: true`：画布是它的子节点，要能继承到。 */
@property --wave-amp {
  syntax: '<length>';
  inherits: true;
  initial-value: 40px;
}

.sound-line {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  /* ★★★ z-index: 2 —— 这一层是「天空遮罩」，必须盖在水体之上（用户 m06218 的架构）。
     层序（从下到上）：
       .sound-line-bg 天空渐变(z0) → .water-body 色块+水彩(z1)
       → 本层：天空遮罩 + 音乐线 + 撞击水花(z2)
     （原 z3 的立方体层随 3D 舞台在 m06383 删除。）
     · 遮罩（波线以上刷 --hero-line、以下透明）压住水体的直边上沿，
       于是水位由**波线**决定 —— 不需要任何同步；
     · 水花在本层内 → 在水体前面。 */
  z-index: 2;
  pointer-events: none;

  /* ★★ 振幅随画布宽度缩放 —— 修「移动端起伏显得过大」。
   *
   *   波形在 t ∈ [0,1] 上固定铺 HARMONIC_CYCLES(8.6) 个周期，
   *   所以画布越窄，**波长按比例越短**；而振幅原本是写死的（2026-10-09 之前 34px，现在 40px）。
   *   于是斜率（= 振幅 / 波长）随屏幕变窄而暴涨：
   *     1440px：波长 167px、振幅 40px → 斜率 0.48
   *     390px ：波长 45px 、振幅 40px → 斜率 0.89（≈1.9 倍）
   *   这就是「被压缩、起伏很大」的根因 —— 不是振幅变大了，
   *   而是波长缩短而振幅没跟着缩。
   *
   *   现在让振幅与宽度成正比，于是**波形在任何尺寸下都是桌面版的等比缩放**，
   *   斜率恒定：
   *     2.75% = 39.6 / 1440，即桌面基准比例。
   *
   *   ★ 下限只取 6px —— 这一条很关键：
   *     最初设 19px 想「保底可见」，结果它在 768px 以下就开始生效，
   *     把移动端顶在 19px 不动 → 斜率又跑回 0.30~0.41
   *     （桌面 0.156 的 2.6 倍），「起伏过大」其实没修掉。
   *     6px 对应「视口 < 254px」才会触发 —— 任何真实设备都用不到，
   *     所以实际行为就是纯粹的等比缩放，斜率与桌面一致。
   *
   *   ★ 用 cqw（`.hero` 是 container-type: size）而不是由 JS 写内联样式：
   *     布局不依赖脚本，首帧不会闪。JS 只**读**这个值（见 refreshCssCache）。 */
  /* ★★ 波带几何（--wave-amp / --band-h / --band-half / --spray-h）已上移到
     `.hero-contain`（HomeView.vue）—— 因为 `.water-body`（WaterBody.vue）是
     **本组件的兄弟节点**，它也要用 `--band-half` 把自己的色块顶边对齐到波带顶边。
     定义在 `.sound-line` 上时兄弟节点看不见，只能吃 fallback（窄屏上波带会缩到
     10px 量级，色块就会露在遮罩外 → 水面上方出现一条直边色带）。
     cqw 仍然解析到 `.hero`（container-type: size），语义不变。 */
}

/**
 * ★★ hero 的纵向渐变层（原来画在 canvas 里）。
 *
 * 为什么要拆出来：canvas 原来铺满 hero，而库每帧会 `clearRect` 整块画布，
 * 迫使我们每帧 `fillRect` 重画一遍 1440×900 的渐变 —— 但实际只有中心
 * 约 120px 高的波带在变化。挪到 CSS 后由合成器一次性栅格化，每帧重绘面积
 * 降到约 1/7.5。这是「帧数很低」的主因。
 *
 * ★★★ 分层必须按「**在波线的上面 / 下面**」来切，而不是按「hero 的上半 / 下半」！
 *
 *   这是最初版本的致命 bug（用户报「背景色跟 wave 线不重合」）：
 *   那时在 hero 的 50% 处硬切到 --hero-fill。而「波线」位于**波带**的 50%
 *   并且**随波浪上下起伏** —— 两个 50% 是不同的点，于是背景那条直线
 *   与波形边界永远差一截（实测相差 14px 且随时变化），
 *   表现为「线在水面之上/之下各有半截错开的色块」。
 *
 *   正确分工 —— 关键是**波带下边缘以外的区域固定不动**，
 *   波带内部的切换交给 canvas：
 *
 *   ┌ 0% ~ 50%                  CSS 渐变 --bg-top → --hero-line
 *   ├ 50% ~ (50% + band-half)   CSS 恒为 --hero-line   ← 波带
 *   │                            canvas 在「波线以上」是**透明的**，
 *   │                            于是透出这里的 --hero-line ✅
 *   └ (50% + band-half) ~ 100%  CSS 恒为 --hero-fill
 *                                （波浪最大只到 50% + 48px（含节拍冲量），
 *                                  永远够不到下边缘 → 这里必然是水下）
 *
 *   canvas 只负责「波线以下」填 --hero-fill + 描线；波线以上一律透明。
 *   于是：波上 = --hero-line，波下 = --hero-fill。
 *
 *   ★ 渐变的两个停止点与原版**完全一致**：
 *     原版是 canvas 从 0 一路渐变到 450px（中心）到 --hero-line，其下被填充盖住。
 *     这里同样是 0 → **50%** 到 --hero-line，只是把「其下」那一段
 *     从「被填充盖住」换成「CSS 自己保持 --hero-line 直到波带下边缘」。
 *     ★ 若把渐变终点提前到波带顶部，波带上方那段会**比原版偏暗**（提前收敛）。
 *
 * ★ 停止点用 `calc(50% ± var(--band-half))` 而不是写死的百分比 ——
 *   与 --band-h 自动联动。改波带高度时不会又错开。
 *
 * ★★ 渐变在波线处**不能**收敛到 --hero-fill！同色盖同色 → 波形起伏看不见。
 *    所以渐变终点必须停在 --hero-line（与 fill 有 1.28:1 的亮度差）。
 */
.sound-line-bg {
  position: absolute;
  inset: 0;
  /* ★★★ 现架构（用户 m06218）：天空渐变只铺到**波带顶边**，再往下必须**透明** ——
     因为这一层现在 z-index:2（在 .water-body 之上），若不透明就会把整块水体色块
     和水彩一起盖掉（实测：水面变成一条死平色带、水花全消失）。
     波带内部由 canvas 负责（波线以上刷同色 --hero-line、以下透明）；
     波带以下一律透明 → 透出 z1 的水体色块 + 水彩。
     ★ 硬切换（同一个位置写两站）而不是渐变到 transparent：后者会经 rgba(0,0,0,0)
       插值，切口上出现一圈暗色描边。 */
  background-image: linear-gradient(
    180deg,
    var(--bg-top) 0%,
    var(--hero-line) calc(50% - var(--band-half)),
    transparent calc(50% - var(--band-half)),
    transparent 100%
  );
  background-size: 100% 100%;
}

/**
 * ★★ 波带 canvas：只覆盖水平中线上下各 72px（共 144px）。
 *
 *   波形最大振幅来自 CSS 的 --wave-amp（桌面 40px），叠加节拍冲量后最多 1.2×40 = 48px，
 *   加上泛波与线宽，72px 仍有余量；即便 tanh 短暂饱和也不会切到。
 *   ★ 若日后调大 --wave-amp，必须同步加大 --band-h，否则波形会被裁掉。
 *
 *   `top: 50%` + `translateY(-50%)`：与 hero 的垂直中心对齐
 *   （hero 有 padding-top: var(--nav-h)，但 canvas 的绝对定位基准是
 *    内边距盒，所以 50% 正好落在内容区的中心 —— 与 paintStatic 里
 *    centerY = h/2 的语义一致）。 */
.sound-line-canvas {
  display: block;
  position: absolute;
  left: 0;
  top: 50%;
  width: 100%;
  height: var(--band-h, 144px);
  transform: translateY(-50%);
  /* ★ 提示浏览器把它提升为独立合成层：canvas 每帧都在重绘，
     若留在普通层里会把「重绘波带」扩散成整块 hero 的合成。
     它已有 transform（translateY(-50%)），提升是顺理成章的。 */
  will-change: transform;
}

/**
 * ★★ 撞击水花 canvas：海平面**以上**那一条带（下沿正好压在波线上）。
 *
 *   `top: calc(50% - var(--spray-h))` + 高度 --spray-h →
 *   画布下沿 = 50%（= 波线所在的那条中线），水花就是从这条线往上飞的。
 *
 *   opacity 用 CSS transition 淡出：`calm()`（往上滚）时瞬间清空会很生硬。
 *   ★★ 这一层是「一帧静止的画面」：撞击时画一次（`paintSplash()`），之后
 *      **不再有任何 rAF/重绘** —— 音乐波线在它下面照常律动，撞击点则冻住不动。
 */
/* ★ m06383：`.sound-line-spray`（撞击水花那一层的画布样式）已随碰撞逻辑删除。 */
</style>
