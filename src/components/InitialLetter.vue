<script setup lang="ts">
/**
 * 巨型字母（SVG 路径）
 *
 * 原站的 hero 视觉冲击来自这个，不是靠放大字号：
 * 首屏左右各一个超大字母，撑满整行高度。
 * 路径直接取自原站 SVG，viewBox 高 417 是原始坐标系。
 */
const GLYPHS: Record<string, { w: number; d: string }> = {
  M: {
    w: 194,
    d: 'M0.458984 417V0.383789H75.7056L95.4614 226.995L115.217 0.383789H193.079V417H138.75V115.723L110.569 417H78.3203L49.8486 112.818L50.1392 417H0.458984Z',
  },
  B: {
    w: 150,
    d: 'M0.953125 417V0.383789H85.4966C126.17 0.383789 147.669 21.8828 147.669 61.104V155.525C147.669 181.382 137.501 197.652 119.198 203.753C138.373 209.273 149.413 225.833 149.413 252.562V356.28C149.413 395.21 127.623 417 85.4966 417H0.953125ZM72.7134 371.097C84.0439 371.097 91.0166 364.415 91.0166 351.631V243.555C91.0166 231.062 84.3345 224.671 72.7134 224.671H59.6396V371.097H72.7134ZM72.4229 182.835C83.4629 182.835 90.145 176.734 90.145 164.822V65.4619C90.145 52.9692 83.4629 46.2871 72.7134 46.2871H59.6396V182.835H72.4229Z',
  },
}

const props = withDefaults(defineProps<{ letter?: string; label?: string }>(), { letter: 'M' })

const glyph = GLYPHS[props.letter] ?? GLYPHS.M
</script>

<template>
  <svg
    class="initial"
    :viewBox="`0 0 ${glyph.w} 417`"
    fill="none"
    preserveAspectRatio="xMidYMid meet"
    role="img"
    :aria-label="label ?? letter"
    :data-letter="letter"
  >
    <path :d="glyph.d" fill="currentColor" />
  </svg>
</template>

<style scoped>
.initial {
  display: block;
  height: 100%;
  width: auto;
  color: var(--text);
}
</style>
