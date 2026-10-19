<script setup lang="ts">
/**
 * 歌词层 —— 盖在 hero 上的一层纯文字（`pointer-events: none`，不吃任何鼠标事件）。
 *
 * 布局（用户 m00111 指定的三句结构）：
 *
 *     上一句 ────────────────────────→ 右上
 *                   当前句（正中）
 *     下一句 ←──────────────────────── 左下
 *
 * ★★ 所有句子一次性挂在 DOM 里、按「离当前句的距离」给每句一个槽位（`data-slot`），
 *   槽位只决定 **`translate` / `scale` / `opacity` / `color`**（全部是合成器属性），
 *   换句时：
 *
 *     下下一句 ──→ 下一句 ──→ 当前句（从下游缓入到正中）
 *     当前句 ──→ 上一句 ──→ 上上一句（继续往右上浮走、淡出）
 *
 *   —— 也就是用户 m01134 要的「下一句缓入到现在的位置，现在的歌词缓入到上一句的位置，
 *   上上一句和下下一句的退出也按类似方向缓入缓出」。因为节点**不增不减**，浏览器会把
 *   位移/缩放/透明度直接插值成一条连续的运动，不会出现「先出后进」的两段式闪断。
 *
 * ★★ 为什么位移/大小走 `translate` + `scale`，而不是 `left/top` + `font-size`
 *   （2026-10-19 改，用户 m02813「歌词切换动画卡」）：那三个都是**布局属性** ——
 *   每帧都要重新排版整行（含 `max-content` 宽度测量）再重新栅格化文字。
 *   Chromium 在 200Hz 屏上勉强扛住，Firefox 上直接卡。现在整段过渡只剩合成器工作。
 *   ⇒ 配套约定：**所有句子统一按当前句的字号排版**（`font-size` 固定在 `.lyric-line`），
 *     上下两句用 `scale: var(--lyric-side)` 缩到 0.59×，永远不会放大 ⇒ 文字始终清晰
 *     （Firefox 放大 transform 位图会发虚，见文件末尾的说明与现代代码同源的
 *     `style.css`「文字浮水」段注释）。
 *
 * ★ 定位全靠 `translate`：`.lyric-line` 统一 `left/top: 0` + `transform-origin: 0 0`，
 *   于是「缩放后的盒子左上角」就等于 translate 的坐标 —— 右对齐/居中的算式不必
 *   跟着 scale 变，换槽位时也不会因为 transform-origin 变化而跳一下。
 *   容器尺寸用 `cqw` / `cqh`（`.lyric-stage` 自己是尺寸容器）。
 *
 * ★ 与 `.hero-contain` / `<SoundLine />` / `<WaterBody />` 是**兄弟节点**
 *   （都挂在 `.hero` 下）。理由同 §4.2：变量定义在 `.hero-contain` 上的话，
 *   兄弟元素读不到 —— 所以这里只用 `.hero` 上的变量
 *   （`--nav-h` / `--site-margin` / `--band-half`）。
 * ★ z-index 3 与 `.hero-contain` 同层，但 DOM 顺序在后面 ⇒ 画在文字之上。
 *   不要为了「压在 B 上面」去调成 4+：那会盖住液态玻璃转场（55）。
 */
import { computed, nextTick, ref, watch } from 'vue'

import { useLyrics } from '@/composables/lyrics'
import { lyricLoader } from '@/lyrics'
import { current, status } from '@/composables/player'
import { atomizeText, glyphVars, LONG_ATOM } from '@/composables/floatText'

const { lines, index } = useLyrics()

/* ==================== 逐字渲染（浮水，用户 m01390） ==================== */

interface GlyphSpan {
  text: string
  key: string
  style: Record<string, string>
}

type Piece =
  | { kind: 'space'; text: string; key: string }
  | { kind: 'char'; text: string; key: string; style: Record<string, string> }
  | { kind: 'word'; key: string; chars: GlyphSpan[] }

/**
 * 把每句歌词切成「空白 / 词 / 字」三种片段，逐字给一套浮水身份变量。
 *
 * ★★ 为什么歌词要**自己**渲染逐字 span，而不是交给 `composables/floatText.ts`
 *   去拆：歌词是 Vue 每句重渲染的文本。`splitText()` 的做法是把原 Text 节点摘下来
 *   换成 span，并**留着那个已脱离文档的 Text 节点**给 Vue 之后写 —— 在 hero 的静态
 *   标题上没问题，但歌词每几秒就换一句，Vue 写进旧节点的字永远上不了屏。
 *   所以这里声明式地渲染 `<span class="fchar">`，身份变量在渲染时算好；
 *   每帧变化的仍然只有 hero 上那三个共享变量（`--float-t/-beat/-k`），性能不变。
 *
 * ★ 用 floatText 的 `atomizeText()` 而不是自己 split：英文词必须包进 `.fword`
 *   （`white-space: nowrap`），否则逐字内联块会让英文在词中间断行。
 * ★ `n` 从 `lineIndex * 7` 起：每句错开相位，换句时不会整句同时呼吸。
 */
const rendered = computed(() =>
  lines.value.map((line, li) => {
    let n = li * 7
    /** 取一个字的「身份」：序号只在这里前进，key 与变量同源 */
    const take = (): { key: string; style: Record<string, string> } => {
      const key = `g${n}`
      const style = glyphVars(n)
      n += 1
      return { key, style }
    }
    const pieces: Piece[] = []
    for (const atom of atomizeText(line.text)) {
      if (atom.kind === 'space') {
        pieces.push({ kind: 'space', text: atom.text, key: `s${pieces.length}` })
        continue
      }
      const chars = Array.from(atom.text)
      if (atom.kind === 'word' && chars.length <= LONG_ATOM) {
        pieces.push({
          kind: 'word',
          key: `w${pieces.length}`,
          chars: chars.map((ch) => ({ text: ch, ...take() })),
        })
      } else {
        /* 超长 token（裸链接之类）逐字拆，保证还有断行机会 */
        for (const ch of chars) pieces.push({ kind: 'char', text: ch, ...take() })
      }
    }
    return { t: line.t, text: line.text, pieces }
  }),
)

/** 这首歌到底有没有词（有 lrc 文件才算） */
const hasLines = computed(() => lines.value.length > 0)

/** 这首歌**根本没有** lrc 文件（不是「还没加载完」） */
const noLyricFile = computed(() => !lyricLoader(current.value?.slug ?? ''))

/** 没有歌词时用来占位的曲名 */
const title = computed(() => current.value?.title ?? '')

/**
 * 什么时候显示：播放器已经离开「待机」，且**要么有歌词、要么确认这首歌没有词**。
 * ★ 暂停时**不隐藏** —— 一句歌词停在半空比整块消失更自然（也正好是「暂停」的语义）。
 *
 * ★★ 判据里必须有「无词的歌」（用户 m01277 报的「重新播放歌曲歌词会消失」）：
 *   曾经的判据只有 `lines.length > 0`，于是**任何一首没有 lrc 的歌**（比如
 *   `anime-openings-be-like` —— 网易云对这首只给了一行「作曲 : Allan Miguel Recto」）
 *   一开播，整个歌词层就 `v-if` 掉，画面上看着就是「歌词没了」。而它出现得又很
 *   隐蔽：上一首播完 `ended` → 自动 `load(index + 1)` → 落到没有词的那首。
 *   现在没有词时改为在正中显示曲名 + 一行「暂无歌词」，层不消失，用户知道是
 *   「这首歌没有词」而不是「功能坏了」。
 *
 * ★ 为什么要区分 `noLyricFile`（没有文件）与「有文件但还没读完」：
 *   后者只是几十毫秒的加载窗口，这时跳个「暂无歌词」等于说假话；
 *   真的读失败时也宁可安静，而不是断言「这首歌没词」。
 */
const visible = computed(() => {
  if (status.value === 'idle') return false
  return hasLines.value || (noLyricFile.value && title.value !== '')
})

/**
 * 拖动进度条 / 连点下一首会**跨过好几句**。那种跳跃不该让整屏歌词横穿画面 —— 所以
 * 一次跨超过一句时，这一帧关掉过渡（瞬间归位），下一句边界再恢复动画。
 * 判据挂在 `index` 上：它只在「当前句真的换了」时变。
 */
const instant = ref(false)
watch(index, (to, from) => {
  if (Math.abs(to - from) <= 1) return
  instant.value = true
  void nextTick(() => {
    requestAnimationFrame(() => {
      instant.value = false
    })
  })
})

type Slot = 'now' | 'prev' | 'next' | 'above' | 'below'

/** 离当前句的距离 → 槽位。±2 及更远的句子只保留「进出场方向」，不参与版面。 */
function slotOf(i: number): Slot {
  const d = i - index.value
  if (d === 0) return 'now'
  if (d === -1) return 'prev'
  if (d === 1) return 'next'
  return d < 0 ? 'above' : 'below'
}
</script>

<template>
  <!-- 纯装饰层：逐句更新对读屏是噪音，整块 aria-hidden -->
  <!-- data-no-float：这一层**自己**在渲染逐字 span（见 script 的 `rendered`）。
       如果放任 floatText 的 walker 再进来，它会把每个 `.fchar` 里的那个字**再拆一层**
       （父子两层变换叠加）。所以整块对 walker 豁免；浮水效果靠 `.fchar` 类 + 继承下来的
       `--float-*` 变量在这里照常生效。 -->
  <div
    v-if="visible"
    class="lyric-stage"
    :class="{ 'is-instant': instant }"
    data-no-float
    aria-hidden="true"
  >
    <!-- 逐字渲染：每个 `span.fchar` 都带一套浮水身份变量（见 script 里 `rendered` 的注释），
         播放中由 `.hero[data-float='on']` 那段 CSS 驱动（§5.18）。 -->
    <!-- ★★ 只有「当前句」逐字浮动，上一句 / 下一句是**纯文本、完全静止**（用户 m02634
         「上一句下一句不要用浮动，固定住」）。
         · 静止的句子不进 `.fchar` ⇒ 保留 kerning / 连字，排版是字体原本的样子；
         · 槽位切到 `now` 的那一帧才换成逐字 span —— 过渡挂在 `<p>` 上，
           内部结构变化不会重启动画；
         · 每帧变化的仍然只有 hero 上那三个共享变量，所以「只有一句在动」也更省。 -->
    <p v-for="(line, i) in rendered" :key="line.t" class="lyric-line" :data-slot="slotOf(i)">
      <template v-if="slotOf(i) === 'now'">
        <template v-for="piece in line.pieces" :key="piece.key">
          <span v-if="piece.kind === 'word'" class="fword">
            <span v-for="glyph in piece.chars" :key="glyph.key" class="fchar" :style="glyph.style">{{
              glyph.text
            }}</span>
          </span>
          <span v-else-if="piece.kind === 'char'" class="fchar" :style="piece.style">{{
            piece.text
          }}</span>
          <template v-else>{{ piece.text }}</template>
        </template>
      </template>
      <template v-else>{{ line.text }}</template>
    </p>

    <!-- 没有歌词的曲目（网易云只给了作曲人行的那首）：层不消失，改为报「这里没有词」。
         用同一套排版语言（衬线斜体 + 弱化色），读起来是「这张唱片没有词」，
         而不是「UI 少了一块」。 -->
    <div v-if="noLyricFile && !hasLines" class="lyric-none">
      <p class="lyric-none-title">{{ title }}</p>
      <p class="lyric-none-hint">暂无歌词</p>
    </div>
  </div>
</template>

<style scoped>
/* ==================== 层 ==================== */
/* 铺满 hero、不吃事件、只负责定位。 */
.lyric-stage {
  position: absolute;
  inset: 0;
  z-index: 3;
  pointer-events: none;

  /* ★★ 自己是尺寸容器：下面所有槽位都用 `cqw` / `cqh` 换算锚点
     （`translate` 的百分比是**相对自身**的，取不到容器宽高，只有 cq 单位能同时表达
     「容器的一半」和「自己的一半」）。inert 的内联尺寸已由 `inset: 0` 定死，所以安全。 */
  container-type: size;

  /* ★ 当前句用衬线斜体（Cormorant Garamond italic）—— 用户 m01134 要的「优雅、特别」。
     整层共用同一个族：换句时字号会变、字族不会，否则斜体/无衬线在动画中途会「啪」地换形。 */
  font-family: var(--font-lyric);
  color: var(--text);

  /* 海平面正好在正中 —— 文字会压着波峰。这层软阴影负责把字从水色里托起来，
     不用加加半透明底板（底板会在波线两侧切出一条硬边）。 */
  text-shadow: 0 2px 26px color-mix(in srgb, var(--bg) 55%, transparent);
}

/* ==================== 一句 ==================== */
/* ★★ 所有句子**统一按当前句的字号排版**，上下两句靠 `scale` 缩到 0.59×（≈18.4px）。
 *
 *   为什么不像以前那样逐槽改 `font-size`：`font-size` / `left` / `top` 都是**布局属性**，
 *   每一帧都要重新排版这一行（还要重算 `max-content` 宽度）再重新栅格化文字。
 *   Chromium 在 200Hz 上勉强扛住，Firefox 直接卡 —— 用户 m02813「歌词切换动画卡」。
 *   现在整段过渡只有 `translate` + `scale` + `opacity`，全部走合成器，两个浏览器都顺。
 *
 * ★★ 为什么 `scale` 恒 ≤ 1（不放大）：Firefox 对带 transform 的元素先按 1× 栅格化、
 *   再按 transform 缩放位图 —— 放大就是「位图被拉大」（和 hero 大字模糊同源，
 *   见 style.css「文字浮水」段的注释）。这里排版尺寸永远是最大的那份，
 *   缩小只是重采样，永远清晰。
 *
 * ★ `width: max-content` + `max-width`：短句不撑满、长句才折行。
 * ★ `transform-origin: 0 0`：缩放绕左上角 ⇒ **缩放不移动盒子的左上角**，
 *   于是每个槽位都能用「缩放后的左上角该在哪」直接写 `translate`，不用去解
 *   「绕中心缩 + 右对齐」的联立方程，换 `scale` 也不用同步改对齐公式。
 */
.lyric-line {
  position: absolute;
  left: 0;
  top: 0;
  margin: 0;
  width: max-content;
  max-width: min(46ch, 76vw);
  font-size: clamp(1.3rem, 2.15vw, 2rem);
  font-weight: 500;
  font-style: italic;
  /* 中文没有衬线斜体字形，浏览器会「合成倾斜」（把字整体斜切）—— 中文看起来是歪的，
     而不是斜体。关掉合成：拉丁文用 Cormorant 自己的真斜体，中文保持正体。 */
  font-synthesis: none;
  line-height: 1.45;
  letter-spacing: 0.005em;
  color: var(--text);
  overflow-wrap: break-word;
  transform-origin: 0 0;
  scale: var(--lyric-s, 1);

  /* ★ 只过渡合成器属性 = 一条连续的运动，且不触发布局。
     缓动曲线 `cubic-bezier(.4,.02,.18,1)`：起步慢、中段走得匀、末尾收住 ——
     像水面把字轻轻托上去。★ 别用 `(.22,.72,.18,1)` 那种「前段极快」的 ease-out：
     实测跨句后 150ms 就走完 55%，观感是「跳」过去而不是「滑」过去。 */
  transition:
    translate 0.9s cubic-bezier(0.4, 0.02, 0.18, 1),
    scale 0.9s cubic-bezier(0.4, 0.02, 0.18, 1),
    opacity 0.62s ease,
    color 0.9s ease;
}

/* 上下两句的缩放比。0.594 = 18.4px / 31px（1440 视口实测：`now` 30.96、两侧 18.43）。
   ★ 窄屏另有一档（见末尾媒体查询）：19.5px 的正中对应 0.74 的两侧。 */
.lyric-stage {
  --lyric-side: 0.594;
}

/* ==================== 逐字（只有当前句） ==================== */
/* 只有 `[data-slot='now']` 里才有 `.fchar`（见 template）；上下两句是纯文本。
   ★ 但 `.fchar` 仍然**常驻**内联块：切开之后每个字各自成盒，才能各自绕自己的
     `transform-origin` 转/缩；而且它只在「当前句」存在，所以句子一离开 now 就
     自动回到纯文本排版（kerning/连字恢复），不需要额外开关。
   ★ 变换（translate/rotate/scale）本身只挂在 `.hero[data-float='on'] .fchar` 上
     （见 style.css 的「文字浮水」段），所以暂停时这些 span 是**静止**的纯排版。 */
.lyric-line .fchar {
  display: inline-block;
}

/* 英文词外壳：断行只发生在词与词之间（逐字内联块会让英文在词中间断行） */
.lyric-line .fword {
  display: inline-block;
  white-space: nowrap;
}

/* 跨多句的跳跃（拖进度条 / 切歌）：这一帧不许有过渡，否则整屏歌词横穿画面。 */
.lyric-stage.is-instant .lyric-line {
  transition: none;
}

/* ==================== 当前句：正中 ==================== */
/* ★★ 用户 m01390「中间歌词也改成浮动的，然后放在正中间」⇒ 这里就是**视口正中**。
 *
 *   历史：之前怕「波峰穿字」，把当前句压到波带下沿外面
 *   （`50% + --band-half + 1.25rem`）。现在整句逐字浮起来了，那层顾虑反转了 ——
 *   海平面从句子附近穿过正好读成「字浮在水面上」，和 hero 的浮水是同一件事。
 *   ⇒ 锚点 `top: 50%`，`.lyric-stage` 是 `.hero` 的 `inset: 0` 一层，
 *   hero 铺满 `100svh`，所以 50% 就是视口正中（不是「hero 内容区」的中线）。
 *   ★ 别改成 `calc(50% + var(--nav-h) / 2)`：hero 顶部那段内边距只是避开导航，
 *   元素盒仍从 y=0 开始，加了就偏低 36px。
 *
 * ★★ `--lyric-lift`：为什么锚在正中却还要抬 0.32em
 *   把文字盒中心**严格**放在 50%（1440×900 实测 y=450）时，海平面正压在 x-height
 *   中间 —— 静止时那条 1px 亮线横穿字心，读起来就是**删除线**（三种遮罩都试过：
 *   2px 暗色 text-shadow 无效、径向「干斑」会在水面上留一块方形面板、背景色块更糟）。
 *   实测文字盒 45px 高时基线在盒顶 +32px，所以把句子上抬 0.32em（31px 字号 ≈ 10px）
 *   正好让**基线落在海平面上**：字是「站在水面上」而不是「被水线划过」。
 *   用 em 而不是 px，字号随断点变也保持同一光学关系；block 视觉中心只比几何中心高
 *   10px（900 屏的 1.1%），肉眼看仍是正中。
 *   ★ 播放时波峰仍会漫过字脚（±40px 振幅），那正是「水在动」；不想让水碰字就
 *   回到 `50% + var(--band-half) + 1.25rem`，但那就不是正中了。 */
.lyric-line[data-slot='now'] {
  --lyric-s: 1;
  --lyric-lift: 0.32em;
  /* 盒中心落在 (50cqw, 50cqh - lift)。`origin: 0 0` + `scale: 1` ⇒ 百分比就是盒的一半。 */
  translate: calc(50cqw - 50%) calc(50cqh - 50% - var(--lyric-lift));
  text-align: center;
  opacity: 1;
  /* ★ 给逐字的一层紧凑暗光：播放时海平面会漫过字脚，这层“湿边”让水线在笔画
     背后断开，读成「字在水前面」。只用 `color-mix(--bg)` 的暖蓝，不加描边色。
     实测 720px 宽里能看出水线在 g / , 的降部后面断了；再收紧就几乎看不出，
     放大到 20px 以上反而像给字描了一圈脏边。 */
  text-shadow:
    0 0 5px color-mix(in srgb, var(--bg) 78%, transparent),
    0 0 14px color-mix(in srgb, var(--bg) 62%, transparent);
}

/* ==================== 上一句：右上 ==================== */
/* 落进右上角标（⌐）的内侧。竖臂 `--corner-w` 实测 11~14px 宽，
   这里按实测定 `--site-margin + 2rem`：1440 视口下文字右边缘 1382、竖臂内沿 1402。
   ★ 缩放后的右边缘要贴在这条线上，所以 x = 容器宽 − 边距 − **缩放后的自身宽**；
     `origin: 0 0` 保证缩放不动左上角，写的坐标就是屏幕上看到的位置。 */
.lyric-line[data-slot='prev'] {
  --lyric-s: var(--lyric-side);
  translate:
    calc(100cqw - var(--site-margin) - 2rem - var(--lyric-side) * 100%)
    calc(var(--nav-h) + 1.75rem);
  text-align: right;
  color: color-mix(in srgb, var(--text) 88%, transparent);
  opacity: 1;
}

/* ==================== 下一句：左下 ==================== */
/* 落进左下角标（L）的内侧。角标的竖臂 + 横臂都在左下角，
   所以左边缘让到 `--site-margin + 2.25rem`（1440 实测文字左边缘 52、竖臂右沿 27.5），
   下边缘让到 `--site-margin + 2.5rem`（文字下边缘 844、横臂上沿 888）。
   ★ 锚底边：y = 容器高 − 边距 − **缩放后的自身高**（同样靠 `origin: 0 0`）。 */
.lyric-line[data-slot='next'] {
  --lyric-s: var(--lyric-side);
  translate:
    calc(var(--site-margin) + 2.25rem)
    calc(100cqh - var(--site-margin) - 2.5rem - var(--lyric-side) * 100%);
  text-align: left;
  color: color-mix(in srgb, var(--text) 88%, transparent);
  opacity: 1;
}

/* ==================== 已退场 / 待进场 ==================== */
/* 上上一句：继续往右上浮、淡出（与「上一句」同一方向，只再远一点、再小一点）。
   下下一句：停在更下方的水外，等着被「下一句」那一步拉上来。 */
.lyric-line[data-slot='above'] {
  --lyric-s: 0.5;
  translate:
    calc(100cqw - var(--site-margin) - 1.5rem - 50%)
    calc(var(--nav-h) + 0.65rem);
  text-align: right;
  opacity: 0;
}

.lyric-line[data-slot='below'] {
  --lyric-s: 0.5;
  translate:
    calc(var(--site-margin) + 1.75rem)
    calc(100cqh - var(--site-margin) - 2.5rem + 1.1rem - 50%);
  text-align: left;
  opacity: 0;
}

/* ==================== 没有歌词的曲目 ==================== */
/* 位置与「当前句」完全一致（同 `top: 50%` + 同一份 0.32em 抬升），只是字号小一档、
   颜色弱一档 —— 一眼能看出「这里没有词」，而不是「图层没渲染」。
   ★ 抬升必须跟着当前句一起抬：这两块占同一个位置，换歌时会直接互换，
     一边抬一边不抬就会在这两种状态之间跳 10px。 */
.lyric-none {
  position: absolute;
  left: 50%;
  top: 50%;
  translate: -50% calc(-50% - 0.32em);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
  width: max-content;
  max-width: min(46ch, 76vw);
  text-align: center;
}

.lyric-none-title {
  margin: 0;
  font-size: clamp(1.15rem, 1.9vw, 1.6rem);
  font-style: italic;
  font-weight: 500;
  font-synthesis: none;
  line-height: 1.4;
  letter-spacing: 0.005em;
  color: color-mix(in srgb, var(--text) 82%, transparent);
  overflow-wrap: break-word;
}

.lyric-none-hint {
  margin: 0;
  font-size: clamp(0.72rem, 0.85vw, 0.8rem);
  font-style: normal;
  font-synthesis: none;
  letter-spacing: 0.18em;
  color: color-mix(in srgb, var(--text) 45%, transparent);
}

/* ==================== 窄屏 ==================== */
@media (max-width: 767px) {
  /* ★ 窄屏上 B 与 NEXT 把两角挤得很满，三句只能往内收：当前句收 **60vw** ——
     767px 以下音乐栏会变成一颗 48px 的固定圆钮（`right: --site-margin`、
     垂直中心 ±24px）；当前句正中就在这条横线上，70vw 时右端（390 屏实测 305）
     离圆钮左沿只剩 12px，换一句更长的就贴上了。
     60vw 在 390 屏是 234px（文字盒 78~312），圆钮左沿 317 ⇒ 留 5px 余量。
     ★ 上下两句不再单独收窄：它们只是当前句的 0.74 倍，视觉宽度大约是 44vw。 */
  .lyric-stage {
    --lyric-side: 0.74;
  }

  .lyric-line {
    max-width: min(46ch, 60vw);
    font-size: clamp(1.05rem, 5vw, 1.45rem);
  }

  .lyric-none {
    max-width: 60vw;
  }

  .lyric-none-title {
    font-size: clamp(1rem, 4.4vw, 1.25rem);
  }

  .lyric-none-hint {
    font-size: 0.7rem;
  }
}

/* 系统要求「减少动态效果」时不做位移动画，只留一句一换的淡入淡出。 */
@media (prefers-reduced-motion: reduce) {
  .lyric-line {
    transition: opacity 0.2s linear;
  }
}
</style>
