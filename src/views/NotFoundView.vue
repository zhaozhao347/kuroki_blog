<script setup lang="ts">
import { RouterLink } from 'vue-router'
</script>

<template>
  <div class="wrap u-container">
    <span class="u-h4 u-muted">错误 404</span>

    <div class="middle">
      <div class="code">404</div>
      <div class="copy">
        <h1 class="u-h1-cn">页面走丢</h1>
        <p class="u-main">你访问的地址不存在，或者已经被移走了。</p>
      </div>
    </div>

    <div class="foot">
      <RouterLink to="/" class="btn">回到首页</RouterLink>
      <span class="u-h4 u-muted">我的博客</span>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  /* ★ 用「1fr / auto / 1fr」三行网格，中段天然落在视口正中。
     不要用 flex + flex:1：那样中段只在「顶部标签与底部页脚之间」居中，
     而页脚（约 100px）比标签（约 18px）高很多，
     结果中段被往上挤（实测偏离视口中心 -23px）。
     网格的两侧行等高（都是 1fr），上下留白才真正对称。
     （数学：middle 中心 = padding + 内容高/2 = 视口中心，与行内容高度无关。） */
  display: grid;
  grid-template-rows: 1fr auto 1fr;
  min-height: 100svh;

  /* ★ 不要用 --page-top(桌面 15rem / 移动 7.5rem)。
     那个值是给其他视图「给导航让位」用的，而 404 路由挂在 DefaultLayout
     之外，**这一页根本没有导航**。套上去等于凭空往下推 240px，
     实测中段偏离视口中心 98px —— 这就是「整体过靠下」的原因。 */
  padding-block: 3rem;
  gap: var(--space-5);
}

.wrap > .u-h4 {
  align-self: start;
}

/* 中段：占据中间一行（两侧 1fr 把它顶到正中） */
.middle {
  /* 404 的字号：桌面端要够大才撑得住宽屏。
     原来 clamp(4rem, 13vw, 10rem) 的上限锁死在 160px，
     1920 宽下仅占屏宽 12%（比移动端的 32% 还小，明显是反的）。
     现在按 vw/vh **双轴取小**：宽屏能长到 ~430px（约屏宽 33%、屏高 32%），
     矮屏（如 1440×600）又会自动收到 ~240px，不会顶破一屏。
     ★ 变量定义在 .middle 上，是为了让 .copy 的标题按同一基准缩放，比例不脱节。 */
  --code-fs: clamp(5rem, min(30vw, 40vh), 28rem);

  display: flex;
  align-items: center;
  gap: var(--space-6);
  min-height: 0;
}

/* 大号 404：与 hero 的巨型字母同一字体，但只用文字。
   line-height 取 0.8（--lh-h1）时，Anton 的字形墨迹（cap height 0.86em）
   在行盒里上下恰好均分（推导见 style.css 的 --lh-h1），
   所以视觉上就是居中的，不需要额外位移校正。 */
.code {
  font-family: var(--font-display);
  font-size: var(--code-fs);
  line-height: var(--lh-h1);
  letter-spacing: 0;
  color: var(--text);
  flex-shrink: 0;
}

.copy {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  /* 允许收缩，避免 404 放大后把这段文字挤出容器 */
  min-width: 0;
}

/* 标题跟着 404 一起放大，否则会出现「大字旁边配小字」的比例失衡。
   0.22 是实测协调的比值：1920 下 404=432px → 标题约 95px；
   1024 下 404=307px → 标题约 68px（原来固定 56px，偏小）。 */
.copy h1 {
  font-size: calc(var(--code-fs) * 0.22);
}

.foot {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  gap: var(--gutter);
}

@media (max-width: 800px) {
  .wrap {
    /* 窄屏顶部标签与页脚都更矮，压缩留白 */
    padding-block: 2.5rem;
  }

  /* 窄屏改成上下堆叠，404 独占一行 → 可以用更大的宽度占比，更醒目。
     下限与断点外一致（5rem），避免刚跨过 800px 时字号「往回缩」；
     上限放宽到 16rem，因为堆叠后不再受旁边文字块的宽度挤压。 */
  .middle {
    --code-fs: clamp(5rem, min(38vw, 32vh), 16rem);
    flex-direction: column;
    align-items: flex-start;
    justify-content: center;
    gap: var(--space-4);
  }

  .foot {
    flex-direction: column;
    align-items: flex-start;
    gap: 1.5rem;
  }
}
</style>
