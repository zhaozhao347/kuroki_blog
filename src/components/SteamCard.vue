<script setup lang="ts">
/**
 * Steam「最近在玩」卡（「关于」页侧栏，粘在统计卡下面）
 *
 * ── 数据从哪来 ──
 *   外部端点（`workers/api/` 的 `/steam`）—— 见 `src/composables/steam.ts`。
 *   ★★ **没配 `VITE_STEAM_ENDPOINT` 时整个组件不渲染**（`v-if`）。
 *      这里和「站点统计」卡的「浏览量显示 `—`」不一样：那一行是那张卡里的一个格子，
 *      留个 `—` 是诚实的；而这张卡整体就是一个可选功能，没开就**不该占位置**。
 *      端点配了但失败（私密 / 上游挂了）反而要显示 —— 那时用户需要知道为什么。
 *
 * ── 形状 ──
 *   和上面两张卡同一套语言：米色实底 + 品牌蓝字 + 同一档圆角（`--panel-radius`）。
 *   一行 = 图标 + 两行文字（游戏名 / 近两周时长），与音乐面板的曲目行同构。
 */
import { computed, onMounted, ref } from 'vue'

import {
  hasSteamEndpoint,
  readSteam,
  STEAM_ERROR_TEXT,
  FALLBACK_TEXT,
  STEAM_STATE_TEXT,
  type SteamSnapshot,
} from '@/composables/steam'

const snap = ref<SteamSnapshot | null>(null)
const loading = ref(true)

onMounted(async () => {
  if (!hasSteamEndpoint) {
    loading.value = false
    return
  }
  snap.value = await readSteam()
  loading.value = false
})

const error = computed(() => snap.value?.error ?? null)
const recent = computed(() => snap.value?.recent ?? [])

/** 「谁 · 在干什么」；正在玩游戏就显示游戏名，比「在线」有用 */
const profileLine = computed(() => {
  const p = snap.value?.profile
  if (!p) return ''
  const state = p.inGame ? `正在玩 ${p.inGame}` : (STEAM_STATE_TEXT[p.state] ?? p.state)
  return state ? `${p.name} · ${state}` : p.name
})

const errorText = computed(() => (error.value ? (STEAM_ERROR_TEXT[error.value] ?? FALLBACK_TEXT) : ''))

/** 时长文案：上游给的是小时（1 位小数），0 和极小值都要说人话 */
function hoursText(hours: number): string {
  if (hours <= 0) return '近两周玩过'
  if (hours < 0.1) return '近两周不到 0.1 小时'
  return `近两周 ${hours} 小时`
}
</script>

<template>
  <section v-if="hasSteamEndpoint" class="steam-card" aria-label="最近在玩">
    <p class="steam-title">
      <span class="steam-bar" aria-hidden="true"></span>最近在玩
    </p>

    <p v-if="profileLine" class="steam-who">{{ profileLine }}</p>

    <p v-if="loading" class="steam-note">读取中…</p>
    <p v-else-if="errorText" class="steam-note">{{ errorText }}</p>
    <p v-else-if="!recent.length" class="steam-note">最近两周没有玩过游戏</p>

    <ul v-else class="steam-list">
      <li v-for="game in recent" :key="game.appid" class="steam-row">
        <img
          v-if="game.icon"
          class="steam-icon"
          :src="game.icon"
          alt=""
          width="32"
          height="32"
          loading="lazy"
          decoding="async"
        />
        <span v-else class="steam-icon steam-icon-empty" aria-hidden="true"></span>
        <span class="steam-text">
          <span class="steam-name" :title="game.name">{{ game.name }}</span>
          <span class="steam-hours">{{ hoursText(game.hours2w) }}</span>
        </span>
      </li>
    </ul>
  </section>
</template>

<style scoped>
/* ★ 与 .stats-card / .profile-card 同一套反色关系（米底蓝字），圆角共用 --panel-radius */
.steam-card {
  background: var(--text);
  color: var(--brand);
  border-radius: var(--panel-radius, 18px);
  padding: var(--space-5);
}

.steam-title {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.95rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

/* 标题前那根竖条：与「站点统计」卡完全同款（currentColor ⇒ 跟着卡片字色） */
.steam-bar {
  width: 4px;
  height: 1.15em;
  border-radius: 2px;
  background: currentColor;
}

/* 「谁 · 在干什么」：比正文淡一档，用「品牌蓝 + 透明」混出来，不引新色 */
.steam-who {
  margin-top: 0.45rem;
  font-size: 0.78rem;
  color: color-mix(in srgb, var(--brand) 62%, transparent);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.steam-note {
  margin-top: 0.7rem;
  font-size: 0.8rem;
  color: color-mix(in srgb, var(--brand) 62%, transparent);
}

.steam-list {
  display: flex;
  flex-direction: column;
  gap: 0.8rem;
  /* 标题下面留一口气（没有 profileLine 时也别贴着） */
  margin-top: 0.85rem;
}

.steam-row {
  display: grid;
  grid-template-columns: 2rem minmax(0, 1fr);
  align-items: center;
  gap: 0.6rem;
}

.steam-icon {
  width: 2rem;
  height: 2rem;
  border-radius: 5px;
  /* 兜底：图标没回来时别出现破图框 */
  background: color-mix(in srgb, var(--brand) 12%, transparent);
  object-fit: cover;
}

.steam-text {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
}

.steam-name {
  font-size: 0.85rem;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.steam-hours {
  font-size: 0.75rem;
  color: color-mix(in srgb, var(--brand) 70%, transparent);
  font-variant-numeric: tabular-nums;
}

/* ★ 窄屏（≤1279px）侧栏摊成整幅宽：单列列表会被拉成一条细线（图标在最左、时长在最右），
   改成多列 —— 与「站点统计」卡同一招、同一阈值（那边是行变格子，这边是列表变格子）。
   ★ 用 auto-fit 而不是写死 3 列：宽卡一行 3 格、窄卡自动降 2 格，不用补断点。 */
@media (max-width: 1279px) {
  .steam-list {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
    gap: 0.8rem 1.25rem;
  }
}

/* ★ 卡很窄时（整行 < 38rem ⇒ 每张卡约 < 19rem，也就是 ≤1279px 的窄档）内边距收一收，
   否则 170px 宽的卡里文字只剩 ~120px。容器是 AboutView 的 `.profile`。 */
@container (max-width: 38rem) {
  .steam-card {
    padding: var(--space-4);
  }

  .steam-title {
    font-size: 0.9rem;
  }

  .steam-list {
    gap: 0.6rem;
  }

  .steam-row {
    grid-template-columns: 1.75rem minmax(0, 1fr);
    gap: 0.5rem;
  }

  .steam-icon {
    width: 1.75rem;
    height: 1.75rem;
  }

  .steam-name {
    font-size: 0.8rem;
  }
}

/* ★★ 极窄（整行 < 23rem ⇒ 每张卡 < 11.5rem，320 / 390px 视口都落这一档）：
   图标再收一号、字号降一档；游戏名照旧省略号（它是 `minmax(0,1fr)` 里的 flex 子项）。
   —— 阈值与「站点统计」卡保持一致，两张卡在同一行时才不会一宽一窄。 */
@container (max-width: 23rem) {
  .steam-row {
    grid-template-columns: 1.5rem minmax(0, 1fr);
    gap: 0.4rem;
  }

  .steam-icon {
    width: 1.5rem;
    height: 1.5rem;
  }

  .steam-name {
    font-size: 0.75rem;
  }

  .steam-hours,
  .steam-who,
  .steam-note {
    font-size: 0.7rem;
  }
}
</style>
