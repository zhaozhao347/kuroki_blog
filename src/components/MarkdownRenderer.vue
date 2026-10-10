<script setup lang="ts">
/**
 * MarkdownRenderer —— 把 markdown 源码渲染成主题化 HTML
 *
 * 依赖三件套（都是各自领域最主流的库，MIT / BSD / Apache 许可）：
 *   markdown-it   —— 解析。CommonMark 兼容、插件生态大、默认关闭原始 HTML（更安全）
 *   highlight.js  —— 代码块语法高亮
 *   dompurify     —— 清洗产出的 HTML，挡住 XSS
 *
 * ★ 安全：**必须** 经过 DOMPurify 再 v-html。
 *   markdown-it 默认 `html: false` 已经不解析原始 HTML，但链接的
 *   `javascript:` 协议、以及我们开启 highlight 后注入的 HTML 仍要洗一遍。
 *   → 双保险：解析器关 HTML + 输出再清洗。
 *
 * ★ 代码高亮：用 highlight.js 的**核心包 + 按需注册语言**，
 *   而不是 `highlight.js` 全量包（5MB+，会把包体积撑爆）。
 *   这里只注册最常用的十几种语言。
 */
import { computed, nextTick, ref, watch } from 'vue'
import MarkdownIt from 'markdown-it'
import hljs from 'highlight.js/lib/core'
import DOMPurify from 'dompurify'

/* ---- 按需注册语言（避免把 5MB 的全量包打进来） ---- */
import javascript from 'highlight.js/lib/languages/javascript'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml' /* html/vue 都归它 */
import css from 'highlight.js/lib/languages/css'
import json from 'highlight.js/lib/languages/json'
import bash from 'highlight.js/lib/languages/bash'
import python from 'highlight.js/lib/languages/python'
import sql from 'highlight.js/lib/languages/sql'
import yaml from 'highlight.js/lib/languages/yaml'
import markdown from 'highlight.js/lib/languages/markdown'
import diff from 'highlight.js/lib/languages/diff'
import rust from 'highlight.js/lib/languages/rust'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'

const LANGS: Record<string, Parameters<typeof hljs.registerLanguage>[1]> = {
  javascript,
  typescript,
  xml,
  css,
  json,
  bash,
  python,
  sql,
  yaml,
  markdown,
  diff,
  rust,
  go,
  java,
}
Object.entries(LANGS).forEach(([name, def]) => hljs.registerLanguage(name, def))

/** 别名：让 ```js / ```ts / ```vue 等写法也能命中 */
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['ts', 'tsx'], { languageName: 'typescript' })
hljs.registerAliases(['html', 'vue', 'svg'], { languageName: 'xml' })
hljs.registerAliases(['sh', 'shell', 'zsh'], { languageName: 'bash' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['md'], { languageName: 'markdown' })
hljs.registerAliases(['py'], { languageName: 'python' })

const props = withDefaults(
  defineProps<{
    /** markdown 源码 */
    source?: string
    /** 段落间距（跟随设计系统的两档） */
    gap?: 'main' | 'small'
  }>(),
  { source: '', gap: 'main' },
)

/* ---- 解析器实例（模块级只建一次，避免每次渲染都重建） ---- */
const md = new MarkdownIt({
  /* ★ 关掉原始 HTML：文章内容若来自接口/用户，这是第一道防线 */
  html: false,
  linkify: true,
  typographer: true,
  /* 中文排版：允许软换行，更贴近写作直觉 */
  breaks: true,
  highlight(code, lang) {
    if (lang && hljs.getLanguage(lang)) {
      try {
        return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value
      } catch {
        /* 高亮失败就退回纯文本 */
      }
    }
    /* 无语言标记时不做自动识别：自动识别在混合代码上容易猜错，
       反而让配色显得杂乱 */
    return ''
  },
})

/* 覆盖 fence（代码块）渲染：
   默认实现只输出 <pre><code>，我们要额外加一层容器与右上角语言标签，
   并把 highlight.js 的结果塞进去。 */
md.renderer.rules.fence = (tokens, idx) => {
  const token = tokens[idx]
  const info = token.info ? token.info.trim() : ''
  const lang = info.split(/\s+/)[0] || ''
  const highlighted =
    lang && hljs.getLanguage(lang)
      ? hljs.highlight(token.content, { language: lang, ignoreIllegals: true }).value
      : md.utils.escapeHtml(token.content)

  /* 语言标签用于右上角显示；无语言时不显示 */
  const label = lang
    ? `<span class="md-code-lang">${md.utils.escapeHtml(lang)}</span>`
    : ''
  return `<div class="md-code">${label}<pre><code class="hljs${
    lang ? ` language-${md.utils.escapeHtml(lang)}` : ''
  }">${highlighted}</code></pre></div>`
}

/* 表格包一层容器，窄屏可横向滚动而不撑破布局 */
md.renderer.rules.table_open = () => '<div class="md-table-wrap"><table>'
md.renderer.rules.table_close = () => '</table></div>'

/* 外链在新标签打开，并加 rel 防 tabnabbing */
const defaultLinkOpen =
  md.renderer.rules.link_open ??
  ((tokens, idx, options, _env, self) => self.renderToken(tokens, idx, options))

md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
  /* attrGet 的签名是 string | number | null，先转成字符串再判断 */
  const href = String(tokens[idx].attrGet('href') ?? '')
  if (/^https?:\/\//.test(href)) {
    tokens[idx].attrSet('target', '_blank')
    tokens[idx].attrSet('rel', 'noopener noreferrer')
  }
  return defaultLinkOpen(tokens, idx, options, env, self)
}

/* ---- 渲染 + 清洗 ---- */
const rendered = computed(() => {
  const raw = md.render(props.source ?? '')
  // ★ DOMPurify 只保留安全标签/属性；它默认就允许 class（高亮要用）
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['target', 'rel'],
    /* 允许 hljs 的类名与语言标签 */
    ADD_TAGS: ['span'],
  })
})

/* 空内容时不渲染容器（避免出现空白块） */
const isEmpty = computed(() => !(props.source ?? '').trim())

/* ---- 截图/测试用：暴露原始 HTML 便于断言 ---- */
const rootEl = ref<HTMLElement | null>(null)

/* ★ 正文图兜底：图片被删 / 路径写错 / 图床挂了时，浏览器会画出「破图图标 + alt」，
   在正文里非常刺眼。这里给 img 加 `.is-broken`（CSS 在 style.css，和 `v-img-fallback`
   指令共用同一套类名），父级加 `.has-broken-img` 顶上一块占位。
   两条路都要走：① 监听 capture 期的 error（error 不冒泡，只能捕获）；
   ② 渲染完成后补一次检查 —— 命中 HTTP 缓存里的失败态时 error 不会再触发一次。 */
function markBroken(el: HTMLImageElement) {
  el.classList.add('is-broken')
  el.parentElement?.classList.add('has-broken-img')
}

function onImgError(event: Event) {
  if (event.target instanceof HTMLImageElement) markBroken(event.target)
}

function scanBrokenImages(root: HTMLElement | null) {
  root?.querySelectorAll('img').forEach((img) => {
    if (img.complete && img.naturalWidth === 0) markBroken(img)
  })
}

watch(rendered, () => {
  void nextTick(() => scanBrokenImages(rootEl.value))
})
defineExpose({ rootEl })
</script>

<template>
  <div
    v-if="!isEmpty"
    ref="rootEl"
    class="markdown-body"
    :class="`gap-${gap}`"
    @error.capture="onImgError"
    v-html="rendered"
  />
</template>

<style scoped>
/* ==========================================================================
   Markdown 排版 —— 蓝白配色（全部由既有令牌派生，不引入新颜色）
   ========================================================================== */

.markdown-body {
  /* 正文色：纯白略降一点，长文阅读更柔和 */
  color: color-mix(in srgb, var(--text) 92%, transparent);
}

/* ---- 段落 ---- */
.markdown-body :deep(p) {
  margin: 0;
  line-height: var(--lh-main-cn);
  letter-spacing: 0.02em;
  text-wrap: pretty;
}

.markdown-body.gap-main :deep(p + p) {
  margin-top: var(--space-5);
}
.markdown-body.gap-small :deep(p + p) {
  margin-top: var(--space-4);
}

/* ---- 标题 ---- */
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  font-family: var(--font-mono);
  font-weight: 500;
  line-height: var(--lh-h2-cn);
  letter-spacing: 0.02em;
  color: var(--text);
  text-wrap: balance;
}

.markdown-body :deep(h1) {
  font-size: 1.75rem;
  margin-top: var(--space-7);
}
.markdown-body :deep(h2) {
  font-size: var(--fs-h2);
  margin-top: var(--space-7);
  /* 二级标题下方加一条细线，呼应站点的「线」语言 */
  padding-bottom: 0.4rem;
  border-bottom: 1px solid var(--line);
}
.markdown-body :deep(h3) {
  font-size: 1.125rem;
  margin-top: var(--space-6);
}
.markdown-body :deep(h4) {
  font-size: var(--fs-h4);
  text-transform: uppercase;
  color: color-mix(in srgb, var(--text) 70%, transparent);
  margin-top: var(--space-5);
}

/* ★ 小标题带锚点 id（文章详情页右侧目录用，见 ArticleDetailView.vue），
   所以必须给**浏览器原生定位**留出顶部固定导航的高度：
   粘贴带 # 的链接、或中键在新标签打开时浏览器会自己滚过去，
   没有这一条标题就被压在导航底下。
   （点目录那条路不靠它 —— 它走 Lenis，偏移量在 ArticleDetailView 里算。） */
.markdown-body :deep(h2),
.markdown-body :deep(h3),
.markdown-body :deep(h4) {
  scroll-margin-top: calc(var(--nav-h) + 24px);
}

/* 第一个元素不要上边距（避免顶部多出空隙） */
.markdown-body :deep(> :first-child) {
  margin-top: 0;
}

/* ---- 链接：下划线用「线」的语言，hover 时右移一点 ---- */
.markdown-body :deep(a) {
  color: var(--text);
  text-decoration: none;
  border-bottom: 1px solid var(--line);
  transition:
    border-color 0.3s var(--ease),
    opacity 0.3s var(--ease);
}
.markdown-body :deep(a:hover) {
  border-bottom-color: var(--text);
}

/* ---- 强调 ---- */
.markdown-body :deep(strong) {
  font-weight: 600;
  color: var(--text);
}
.markdown-body :deep(em) {
  font-style: italic;
}
.markdown-body :deep(del) {
  opacity: 0.55;
}

/* ---- 列表：用短横线代替默认圆点，更贴合极简调性 ---- */
.markdown-body :deep(ul),
.markdown-body :deep(ol) {
  margin: var(--space-5) 0 0;
  padding-left: 1.4em;
}
.markdown-body :deep(ul) {
  list-style: none;
}
.markdown-body :deep(ul > li) {
  position: relative;
}
.markdown-body :deep(ul > li)::before {
  content: '';
  position: absolute;
  left: -1.1em;
  top: 0.72em;
  width: 0.5em;
  height: 1px;
  background-color: var(--line);
}
.markdown-body :deep(ol) {
  list-style: decimal;
}
.markdown-body :deep(ol > li)::marker {
  color: color-mix(in srgb, var(--text) 55%, transparent);
  font-family: var(--font-mono);
  font-size: 0.85em;
}
.markdown-body :deep(li) {
  line-height: var(--lh-main-cn);
}
.markdown-body :deep(li + li) {
  margin-top: 0.4em;
}
.markdown-body :deep(li > ul),
.markdown-body :deep(li > ol) {
  margin-top: 0.4em;
}

/* ---- 引用：左侧竖线 + 降透明度 ---- */
.markdown-body :deep(blockquote) {
  margin: var(--space-5) 0 0;
  padding: 0.25rem 0 0.25rem 1.25rem;
  border-left: 1px solid var(--text);
  color: color-mix(in srgb, var(--text) 72%, transparent);
}
.markdown-body :deep(blockquote > :first-child) {
  margin-top: 0;
}

/* ---- 行内代码 ---- */
.markdown-body :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.875em;
  padding: 0.15em 0.4em;
  /* 底色用白色低透明度，在蓝底上呈现"磨砂玻璃"感，不引入新色 */
  background-color: color-mix(in srgb, var(--text) 12%, transparent);
  border-radius: 2px;
}

/* ---- 代码块 ---- */
.markdown-body :deep(.md-code) {
  position: relative;
  margin-top: var(--space-5);
  /* 比正文底色**更深**一点：用 --bg 叠加黑色低透明度，
     在渐变背景上形成沉稳的"代码区" */
  background-color: color-mix(in srgb, #000 28%, transparent);
  border: 1px solid color-mix(in srgb, var(--text) 14%, transparent);
  border-radius: 4px;
  overflow: hidden;
}

.markdown-body :deep(.md-code pre) {
  margin: 0;
  /* ★ 内边距（= 代码文字到框的距离）。
     水平略大于垂直：等宽字体的行首/行尾贴边会更明显，
     横向多留一点，视觉上才与上下对称。 */
  padding: 1.35rem 1.5rem;
  overflow-x: auto;
  /* 细滚动条，不抢视觉 */
  scrollbar-width: thin;
  /* ★ 关键：给滚动容器一个独立的 BFC + 最大宽度约束。
     只写 overflow-x: auto 不够 —— 下面的 code 是 block，
     但 highlight.js 产出的 token 是**内联 span**，单个超长 token
     （如一条很长的注释）在内联格式化里无法折行，
     会把 pre 撑宽 → 溢出父容器（实测 360/320px 下 hljs-comment /
     hljs-built_in 越界）。加 min-width: 0 + max-width: 100%
     让 pre 真正受父级约束，滚动条才会生效。 */
  min-width: 0;
  max-width: 100%;
}

.markdown-body :deep(.md-code code) {
  display: block;
  padding: 0;
  background: none;
  /* ★★ 必须显式清掉 border！
     全局有一条给**行内代码**用的 `code { border: 1px solid var(--line) }`
     （见 style.css），而块级代码块里的 <code> 也会命中它 ——
     于是代码区里出现"第二层框"，且它的不透明度（.5）比外层
     wrapper 的边框（.14）深得多，看起来比第一层还抢眼。
     这里不写 border 就会被继承/命中，形成双层边框。 */
  border: 0;
  font-size: 0.8125rem;
  line-height: 1.7;
  /* ★ pre-wrap 而不是 pre：允许在必要处折行（配合上面的 max-width），
     超长 token 不会再把容器顶宽。缩进仍由 pre-wrap 保留。 */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  width: max-content;
  min-width: 100%;
}

/* 右上角语言标签
   ★ 位置跟着 pre 的内边距走：内边距变大后标签也要相应内移，
     否则会贴到框线上、或与首行代码挤在一起。 */
.markdown-body :deep(.md-code-lang) {
  position: absolute;
  top: 0.6rem;
  right: 0.85rem;
  font-family: var(--font-mono);
  font-size: 0.625rem;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: color-mix(in srgb, var(--text) 40%, transparent);
  pointer-events: none;
  user-select: none;
}

/* ---- 语法高亮配色（全部白/蓝系，不引入暖色） ----
   思路：用「白色的不同透明度」区分层级，而不是彩虹色 ——
   这样在深蓝底上既清晰又统一。
   ★ 这些覆盖要放在全局或 ::v-deep 里才作用于 v-html 的内容。 */
.markdown-body :deep(.hljs-comment),
.markdown-body :deep(.hljs-quote) {
  color: color-mix(in srgb, var(--text) 42%, transparent);
  font-style: italic;
}
.markdown-body :deep(.hljs-keyword),
.markdown-body :deep(.hljs-selector-tag),
.markdown-body :deep(.hljs-literal),
.markdown-body :deep(.hljs-section),
.markdown-body :deep(.hljs-doctag),
.markdown-body :deep(.hljs-type),
.markdown-body :deep(.hljs-name),
.markdown-body :deep(.hljs-strong) {
  color: var(--text);
  font-weight: 600;
}
.markdown-body :deep(.hljs-string),
.markdown-body :deep(.hljs-regexp),
.markdown-body :deep(.hljs-addition),
.markdown-body :deep(.hljs-attribute),
.markdown-body :deep(.hljs-meta .hljs-string) {
  color: #a8e5ff; /* 代码里唯一允许的"提亮青"，与渐变顶部同源 */
}
.markdown-body :deep(.hljs-number),
.markdown-body :deep(.hljs-symbol),
.markdown-body :deep(.hljs-bullet),
.markdown-body :deep(.hljs-variable),
.markdown-body :deep(.hljs-template-variable),
.markdown-body :deep(.hljs-link),
.markdown-body :deep(.hljs-selector-attr),
.markdown-body :deep(.hljs-selector-pseudo) {
  color: #7fc4ff;
}
.markdown-body :deep(.hljs-title),
.markdown-body :deep(.hljs-title.function_),
.markdown-body :deep(.hljs-title.class_),
.markdown-body :deep(.hljs-built_in),
.markdown-body :deep(.hljs-selector-id),
.markdown-body :deep(.hljs-selector-class) {
  color: var(--text);
  text-decoration: underline;
  text-decoration-color: color-mix(in srgb, var(--text) 35%, transparent);
  text-underline-offset: 3px;
}
.markdown-body :deep(.hljs-attr),
.markdown-body :deep(.hljs-property),
.markdown-body :deep(.hljs-params),
.markdown-body :deep(.hljs-meta),
.markdown-body :deep(.hljs-punctuation) {
  color: color-mix(in srgb, var(--text) 78%, transparent);
}
.markdown-body :deep(.hljs-deletion) {
  color: #ffb4c4;
}

/* ---- 表格 ---- */
.markdown-body :deep(.md-table-wrap) {
  margin-top: var(--space-5);
  overflow-x: auto;
  scrollbar-width: thin;
}
.markdown-body :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--fs-small);
}
.markdown-body :deep(th),
.markdown-body :deep(td) {
  padding: 0.6rem 0.85rem;
  text-align: left;
  border-bottom: 1px solid var(--line);
}
.markdown-body :deep(th) {
  font-family: var(--font-mono);
  font-size: var(--fs-h4);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text);
  border-bottom-color: var(--text);
  white-space: nowrap;
}
.markdown-body :deep(tbody tr:hover) {
  background-color: color-mix(in srgb, var(--text) 6%, transparent);
}

/* ---- 分隔线 ---- */
.markdown-body :deep(hr) {
  margin: var(--space-6) 0;
  border: 0;
  height: 1px;
  background-color: var(--line);
}

/* ---- 图片 ---- */
.markdown-body :deep(img) {
  display: block;
  max-width: 100%;
  height: auto;
  margin-top: var(--space-5);
  border-radius: 4px;
}

/* ---- 键盘按键 ---- */
.markdown-body :deep(kbd) {
  font-family: var(--font-mono);
  font-size: 0.8em;
  padding: 0.15em 0.45em;
  border: 1px solid var(--line);
  border-radius: 3px;
  background-color: color-mix(in srgb, var(--text) 8%, transparent);
}

/* ---- 任务列表 ---- */
.markdown-body :deep(li.task-list-item) {
  list-style: none;
}
.markdown-body :deep(li.task-list-item)::before {
  display: none;
}
.markdown-body :deep(input[type='checkbox']) {
  margin-right: 0.5em;
  accent-color: var(--text);
}
</style>
