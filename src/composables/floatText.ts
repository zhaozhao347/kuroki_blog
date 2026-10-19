/**
 * 文字「浮水」模式 —— 播放时让**首屏 hero** 里的字形轻轻浮动。
 *
 * ── 需求与两次收窄（用户 m00528 / m00787）──
 *   m00528：正常状态文字不动；按下播放后每个字浮起来，各自有轻微角度和大小差异，
 *           大小跟着**真实音乐节奏**律动（不是随机脉动）。
 *   m00787：**只做 hero**，文章正文不要加（原话「文章部分不要加呀，只 hero 加就可以了，
 *           文章部分加了就是降低可读性呀」）。
 *   所以这里的作用域是 `section.hero` 一棵子树，正文/导航/页脚一律不碰。
 *
 * ── 为什么作用域收窄同时也是性能修复 ──
 *   全页测试（/about，420 个字，Edge headful + GTX 1660 Ti，真实 GPU）：
 *     不浮动 200fps → 浮动 17~24fps。headless 更差（7fps）。
 *   逐字 `rotate` / `scale` 的文本**每帧都要重新栅格化**，420 个字就是 420 次，
 *   这不是调参数能解决的。hero 只有 8 个字形（B + log 三个字母 + NEXT 四个字母），
 *   量级差 50 倍，稳在 60fps 以上。
 *   ★ 另一个隐藏成本：把 `--float-t` / `--float-beat` 写在 `<html>` 上会让**全文档**
 *     重算样式（实测 200fps → 85fps，即使一个 transform 都没有）。所以这三个变量
 *     现在写在 hero 元素自己身上，失效范围只有 hero 子树。
 *
 * ── 怎么做到「跟着节奏」──
 *   节拍信号来自 `composables/beat.ts`（频谱能量 + 谱通量双包络，与 SoundLine 同源）。
 *   每帧只写三个变量：
 *     `--float-t`    连续时间（秒）→ 波浪相位
 *     `--float-beat` 0..1 的鼓点包络 → 决定这一下「涨多大」
 *     `--float-k`    0..1 的强度开关 → 播放淡入、暂停淡出
 *   每个字自己的 `--float-i`（序号）/`--float-r`（基础角）/`--float-s`（基础缩放）/
 *   `--float-a`（律动幅度）/`--float-j`（相位抖动）在拆分时一次性写死。
 *   ★ 于是每帧只有 3 次样式写入，逐字的三角函数交给 CSS 自己算（`sin()` / `calc()`，
 *     Chromium 111+ / Safari 15.4+）；逐字逐帧写内联样式做不到 60fps。
 *
 * ── 为什么必须保留「原始文本节点」而不是用完重建 ──
 *   拆分时把原 Text 节点**摘下来留在内存里**（不销毁），恢复时原样插回去。
 *   这样 Vue 的 vnode 仍指向那个节点 —— 它更新文本时写的是我们手里这个
 *   已脱离文档的节点，`nodeValue` 会被正常更新，插回来就是**最新的文字**。
 *   若改用「记住字符串、恢复时新建 Text」，动态文字会退回旧值。
 *
 * ── 谁不参与 ──
 *   `.music-bar`（用户明确「除了 bar」）与歌词层（它自己在做换句淡入）——
 *   它们都在 hero 里面，靠 `data-no-float` 豁免。
 *   天然跳过的还有：`pre/code/textarea/input/svg` 等（见 SKIP_TAGS），
 *   以及 `[data-letter]` 元素**内部的**文本：那些元素本身就是逐字元素
 *   （`.hero-log` 的 `<i>`、NEXT 的 `<span>`、巨型 B 的 `<svg>`），直接**领养**它们当字，
 *   不再向下拆（否则会和 HomeView 的入场拆分打架）。
 *   ★ 就现在的 hero 结构而言，里面**没有任何需要拆分的普通文本节点**，
 *     8 个字全是领养来的；拆分器留着是为了将来 hero 里出现标题/副标题时也能逐字浮。
 */
import { nextTick, watch } from 'vue'
import type { Router } from 'vue-router'
import { readBeat, resetBeat } from '@/composables/beat'
import { prefersReducedMotion } from '@/composables/motion'
import { status } from '@/composables/player'

/** 作用域：首页首屏（HomeView 的 `section.hero`） */
const HERO = 'section.hero'

/** 拆分后每个字用的类名 */
const GLYPH = 'fchar'
/** 英文单词外壳（`white-space: nowrap`，防止一个词在词中间断行） */
const WORD = 'fword'
/** 「领养」的逐字元素（`.hero-log` 的 `<i>`、NEXT 的 `<span>`、B 的 `<svg>`）用的类名 */
const ADOPTED = 'fchar-el'
/** 不参与浮动的容器标记（由各组件自己挂） */
const OPT_OUT = 'data-no-float'

/**
 * 拆分预算（字数上限）。
 *
 * ★ 现在只拆 hero，正常情况下是 8 个字。留 240 是给「hero 里将来加了副标题/标签」
 *   这种情况兜底 —— 超了就不拆了，绝不让成本回到"整页逐字"那个量级。
 */
const BUDGET = 240

/**
 * 多长的「词」就不再包 `nowrap` 外壳。
 *
 * ★★ 给 **长 URL / 长标识符** 留的活口：`nowrap` 的内联块不能断行，
 *   超过这个长度就按**单字**拆，于是又能随时断行。
 */
export const LONG_ATOM = 24

/** 天然不拆的标签（代码块、表单、图形） */
const SKIP_TAGS = new Set([
  'SCRIPT',
  'STYLE',
  'NOSCRIPT',
  'TEMPLATE',
  'TEXTAREA',
  'INPUT',
  'SELECT',
  'OPTION',
  'PRE',
  'CODE',
  'KBD',
  'SAMP',
  'SVG',
  'CANVAS',
  'IFRAME',
])

/** 一个原始文本节点被拆开后的记录 */
interface SplitRecord {
  /** 原始 Text 节点（已被替换下来，但**不销毁**） */
  text: Text
  /** 插进 DOM 的替换节点（恢复时按这个列表删） */
  nodes: Node[]
}

/** 被领养的逐字元素（恢复时去掉类与自定义属性） */
interface AdoptedRecord {
  el: HTMLElement
}

/** 当前作用域元素（hero）；不在首页时为 null */
let host: HTMLElement | null = null
let records: SplitRecord[] = []
let adopted: AdoptedRecord[] = []
let raf = 0
let lastNow = 0
let clock = 0
let intensity = 0
/** 目标状态：播放中 = 想浮 */
let enabled = false

/* ==================== 拆分 ==================== */

/** 确定性伪随机（同一个序号永远得到同一个值 —— 每次播放的角度/大小都是同一套，不会跳） */
function rnd(seed: number): number {
  const v = Math.sin(seed * 12.9898 + 78.233) * 43758.5453
  return v - Math.floor(v)
}

/** 一个字的「身份」数值（确定性：同一个序号永远同一套） */
interface GlyphIdentity {
  rot: number
  scale: number
  pulse: number
  jitter: number
}

/**
 * 算出一个字的身份。
 *
 * ★ 幅度是克制的：角度 ±1.7°、基础缩放 ±3.5%、律动最多 +6.2%。
 *   用户明确「角度和大小不能太夸张」—— 目标读感是「每个字不一样、在呼吸」，
 *   而不是让排版散架。大字形（B / log / NEXT，字号 200~417px）反而要更小：
 *   417px 高的 B 涨 6% 会晃得头晕。
 */
function glyphIdentity(i: number, big: boolean): GlyphIdentity {
  const r1 = rnd(i * 3.17)
  const r2 = rnd(i * 5.71 + 1.31)
  const r3 = rnd(i * 7.93 + 2.67)
  const r4 = rnd(i * 11.37 + 4.19)

  return {
    rot: (r1 * 2 - 1) * (big ? 0.9 : 1.7),
    scale: 1 + (r2 * 2 - 1) * (big ? 0.016 : 0.035),
    pulse: (0.35 + 0.65 * r3) * (big ? 0.022 : 0.062),
    jitter: r4 * 0.9,
  }
}

/**
 * 给一个字写「身份」：序号 + 基础角 + 基础缩放 + 律动幅度 + 相位抖动。
 *
 * ★ 这几个值只写一次（拆分时），之后每帧变的是**共享的** `--float-t` / `--float-beat`。
 */
function tagGlyph(el: HTMLElement, i: number, big: boolean): void {
  const g = glyphIdentity(i, big)
  el.style.setProperty('--float-i', String(i))
  el.style.setProperty('--float-r', `${g.rot.toFixed(2)}deg`)
  el.style.setProperty('--float-s', g.scale.toFixed(4))
  el.style.setProperty('--float-a', g.pulse.toFixed(4))
  el.style.setProperty('--float-j', g.jitter.toFixed(3))
}

/**
 * 同一套身份变量，但是**给 Vue 自己渲染的逐字元素**用（歌词层，见 §5.17/§5.18）。
 *
 * 歌词是 Vue 每句重渲染的文本：如果交给 `splitText()` 去拆，Vue 之后写的是那个
 * 已经脱离文档的旧 Text 节点 ⇒ 屏上永远是上一句。所以歌词层**声明式**地渲染
 * `<span class="fchar">`，身份变量在这里算好、`v-bind:style` 一次写死；
 * 每帧变的仍然只有 hero 上那三个共享变量。
 */
export function glyphVars(i: number, big = false): Record<string, string> {
  const g = glyphIdentity(i, big)
  return {
    '--float-i': String(i),
    '--float-r': `${g.rot.toFixed(2)}deg`,
    '--float-s': g.scale.toFixed(4),
    '--float-a': g.pulse.toFixed(4),
    '--float-j': g.jitter.toFixed(3),
  }
}

function untagGlyph(el: HTMLElement): void {
  el.classList.remove(GLYPH, ADOPTED)
  for (const name of ['--float-i', '--float-r', '--float-s', '--float-a', '--float-j']) {
    el.style.removeProperty(name)
  }
}

/** 新建一个字元素 */
function makeGlyph(ch: string, index: number): HTMLSpanElement {
  const s = document.createElement('span')
  s.className = GLYPH
  s.textContent = ch
  tagGlyph(s, index, false)
  return s
}

const WORD_CHAR = /^[A-Za-z0-9'’\-_.@:/?#%&=+~]$/
const SPACE_CHAR = /^\s$/u
const MARK_CHAR = /^\p{M}$/u

/** 原子：连续空白 / 一个「词」 / 一个独立字（含 CJK、标点、emoji） */
export type Atom = 'space' | 'word' | 'char'

export interface TextAtom {
  kind: Atom
  text: string
}

/**
 * 把一段文本切成原子。
 *
 * ★ 为什么要分「词」：CSS 的断行机会存在于**内联块之间**，
 *   所以逐字拆开之后，英文会**在词中间**被拆行。把英文词包进
 *   `white-space: nowrap` 的外壳，断行就只发生在词与词之间。
 * ★ 中文/标点/emoji 本来就是「每个字都能断行」，所以逐字拆即可。
 * ★ 导出给歌词层用（它自己渲染逐字 span，理由见 glyphVars 的注释）——
 *   两处共用这一份切法，否则歌词的断行规则会和 hero 漂移。
 */
export function atomizeText(raw: string): TextAtom[] {
  const chars = Array.from(raw)
  const out: TextAtom[] = []
  let i = 0
  while (i < chars.length) {
    const ch = chars[i]
    if (SPACE_CHAR.test(ch) || ch === '\u00a0') {
      let j = i + 1
      while (j < chars.length && (SPACE_CHAR.test(chars[j]) || chars[j] === '\u00a0')) j++
      out.push({ kind: 'space', text: chars.slice(i, j).join('') })
      i = j
      continue
    }
    if (WORD_CHAR.test(ch)) {
      let j = i + 1
      while (j < chars.length && WORD_CHAR.test(chars[j])) j++
      out.push({ kind: 'word', text: chars.slice(i, j).join('') })
      i = j
      continue
    }
    /* 组合附加符（é 的声调、天城文的元音符号…）必须并回前一个字，
       否则会被拆成两个内联块，字形散开。 */
    if (MARK_CHAR.test(ch) && out.length > 0) {
      out[out.length - 1].text += ch
      i += 1
      continue
    }
    out.push({ kind: 'char', text: ch })
    i += 1
  }
  return out
}

/** 拆分状态（一次 splitAll 内累计） */
interface SplitState {
  glyphs: number
}

/** 试拆一个文本节点；超出预算或不该拆就原样留着 */
function splitText(text: Text, state: SplitState): void {
  const raw = text.nodeValue ?? ''
  if (!raw.trim()) return

  const parent = text.parentElement
  if (!parent) return
  /* ★ 逐字元素（data-letter）自己的文字不再拆 —— 它本身就是一个字 */
  if (parent.hasAttribute('data-letter')) return

  const atoms = atomizeText(raw)
  let need = 0
  for (const a of atoms) need += a.kind === 'space' ? 0 : Array.from(a.text).length
  if (state.glyphs + need > BUDGET) return

  const frag = document.createDocumentFragment()
  for (const atom of atoms) {
    if (atom.kind === 'space') {
      frag.appendChild(document.createTextNode(atom.text))
      continue
    }
    const longWord = atom.kind === 'word' && atom.text.length > LONG_ATOM
    if (atom.kind === 'word' && !longWord) {
      const word = document.createElement('span')
      word.className = WORD
      for (const ch of Array.from(atom.text)) {
        word.appendChild(makeGlyph(ch, state.glyphs++))
      }
      frag.appendChild(word)
    } else {
      for (const ch of Array.from(atom.text)) {
        frag.appendChild(makeGlyph(ch, state.glyphs++))
      }
    }
  }

  const nodes = Array.from(frag.childNodes)
  parent.replaceChild(frag, text)
  records.push({ text, nodes })
}

/**
 * ★★ 领养前必须清掉**无效果的内联 filter**。
 *
 * 实测（3x 放大截图对比，`docs/reports/` 里的 seam 对比图）：入场动画给
 * `.hero-log <i>` 和 NEXT 的 `<span>` 留下了内联 `filter: blur(0px)`。
 * 这种「看起来等于没写」的滤镜会让元素被单独栅格化；之后再对它做
 * translate / rotate / scale，字的右边缘会拖出**一条 1~2px 的竖直白缝**
 * （用户 m00846 报的「字体后面会有白缝」）。把 filter 清掉，缝立刻消失。
 *
 * 只清 `none` / `blur(0px)` 这类无效果的，正在做入场模糊的元素不动它。
 */
function clearNoopFilter(el: HTMLElement): void {
  const f = getComputedStyle(el).filter
  if (f === 'none' || /^blur\(\s*0(px)?\s*\)$/.test(f)) el.style.removeProperty('filter')
}

/** 领养已经是「逐字元素」的节点（不拆、只加类与变量） */
function adoptLetters(scope: HTMLElement, state: SplitState): void {
  const list = scope.querySelectorAll<HTMLElement>('[data-letter]')
  for (const el of list) {
    if (el.closest(`[${OPT_OUT}]`)) continue
    clearNoopFilter(el)
    el.classList.add(ADOPTED)
    const big = el.tagName.toLowerCase() === 'svg'
    tagGlyph(el, state.glyphs++, big)
    adopted.push({ el })
  }
}

/** 该不该跳过这个元素（连同整棵子树） */
function skipElement(el: Element): boolean {
  if (el.hasAttribute(OPT_OUT)) return true
  if (SKIP_TAGS.has(el.tagName.toUpperCase())) return true
  if (el.namespaceURI === 'http://www.w3.org/2000/svg') return true
  if (el.getAttribute('contenteditable') === 'true') return true
  return false
}

function walk(el: Element, state: SplitState): void {
  if (skipElement(el)) return
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) splitText(child as Text, state)
    else if (child.nodeType === Node.ELEMENT_NODE) walk(child as Element, state)
  }
}

/**
 * 全量拆分（幂等：先恢复再拆）。
 *
 * @returns 找到 hero 并完成拆分时 true；不在首页（没有 hero）时 false
 */
function splitAll(): boolean {
  restore()
  host = document.querySelector<HTMLElement>(HERO)
  if (!host) return false
  const state: SplitState = { glyphs: 0 }
  adoptLetters(host, state)
  walk(host, state)
  return true
}

/** 恢复到原始文本（幂等） */
function restore(): void {
  for (const rec of records) {
    const first = rec.nodes[0]
    const parent = first?.parentNode
    if (!parent) continue
    /* ★ 插回的是**原来那个 Text 节点**（见文件头注释：Vue 可能已经更新过它的值） */
    parent.insertBefore(rec.text, first)
    for (const n of rec.nodes) n.parentNode?.removeChild(n)
  }
  records = []
  for (const a of adopted) untagGlyph(a.el)
  adopted = []
}

/* ==================== 每帧驱动 ==================== */

function writeVar(name: string, value: string): void {
  host?.style.setProperty(name, value)
}

function ensureLoop(): void {
  if (raf || !host) return
  lastNow = 0
  raf = requestAnimationFrame(frame)
}

function frame(now: number): void {
  raf = 0
  if (!host) return
  const dt = lastNow ? Math.min(64, Math.max(1, now - lastNow)) : 16
  lastNow = now
  clock += dt / 1000

  const target = enabled ? 1 : 0
  /* 淡入快（90ms，点播放立刻"活过来"）、淡出慢（380ms，像水面慢慢平静） */
  intensity += (target - intensity) * (1 - Math.exp(-dt / (enabled ? 90 : 380)))
  if (!enabled && intensity < 0.004) intensity = 0

  const beat = enabled ? readBeat(dt) : 0

  writeVar('--float-t', clock.toFixed(3))
  writeVar('--float-beat', beat.toFixed(4))
  writeVar('--float-k', intensity.toFixed(4))

  if (!enabled && intensity === 0) {
    teardown()
    return
  }
  raf = requestAnimationFrame(frame)
}

/** 淡出结束：把 DOM 还原成普通文本，收工 */
function teardown(): void {
  restore()
  host?.removeAttribute('data-float')
  writeVar('--float-t', '0')
  writeVar('--float-beat', '0')
  writeVar('--float-k', '0')
  lastNow = 0
}

/**
 * 确保 hero 已拆分并处于浮动状态（幂等：内部先 restore 再 split）。
 *
 * @returns 找到 hero 时 true
 */
function apply(): boolean {
  const hero = document.querySelector<HTMLElement>(HERO)
  if (!hero) return false
  host = hero
  if (!enabled) {
    enabled = true
    resetBeat()
  }
  splitAll()
  host.setAttribute('data-float', 'on')
  ensureLoop()
  return true
}

function enable(): void {
  if (!apply()) {
    /* 不在首页：没有任何字形要浮，直接收摊（切回首页时 rebuild() 会再试一次） */
    enabled = false
    teardown()
  }
}

function disable(): void {
  enabled = false
  /* 没有字形就不用等淡出，直接还原 */
  if (!records.length && !adopted.length) {
    teardown()
    return
  }
  /* 不在这里 restore：先让 `--float-k` 淡到 0，字形平滑落回，再由 frame() 收尾 */
  ensureLoop()
}

/**
 * 路由切换后重建。
 *
 * ★ 用路由钩子而不是 MutationObserver：本项目的整块 DOM 更替只发生在路由切换，
 *   而观察器会在我们**自己插入**节点时疯狂回调（自触发循环）。
 * ★ 首屏视图是路由级懒加载：`afterEach` 触发时 hero 可能还没挂上，
 *   所以没找到时补一次（实测首次进 / 时 chunk 到位约 100~300ms）。
 */
async function rebuild(): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  if (status.value !== 'playing') {
    disable()
    return
  }
  if (apply()) return
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  if (status.value === 'playing') apply()
}

/**
 * 挂上浮水模式。
 *
 * @param router 路由实例（切页后要重新找 hero）
 * @returns 卸载函数
 */
export function startFloatText(router: Router): () => void {
  if (typeof document === 'undefined') return () => {}
  /* ★ reduced-motion 用户：整块能力直接不装 —— 这是无障碍红线，
     不是「动画慢一点」的问题。 */
  if (prefersReducedMotion()) return () => {}

  const stopStatus = watch(status, (s) => {
    if (s === 'playing') enable()
    else if (s !== 'loading') disable()
  })
  const stopRouter = router.afterEach(() => {
    void rebuild()
  })

  return () => {
    stopStatus()
    stopRouter()
    if (raf) cancelAnimationFrame(raf)
    raf = 0
    enabled = false
    intensity = 0
    teardown()
    host = null
  }
}
