#!/usr/bin/env bash
#
# 内容 & 构建体检 —— 把错误拦在构建期
#
#   ./scripts/check-content.sh                内容校验 → 类型检查 → 构建 → 体积预算
#   ./scripts/check-content.sh --only=posts   只校验文章
#   ./scripts/check-content.sh --only=projects 只校验项目
#   ./scripts/check-content.sh --content-only 只做内容校验（跳过类型检查与构建）
#   ./scripts/check-content.sh --no-build     校验 + 类型检查（跳过打包与体积预算）
#   ./scripts/check-content.sh --json         内容校验输出 JSON（给编辑器/CI 用）
#
# ── 为什么是 bash 包一层 Node ──
#   校验规则只有一份，写在 `content-kit.ts` 里（两个集合各一份 spec）；
#   `scripts/check-content.mjs` 直接 import 两个插件调用它们的
#   `checkPosts()` / `checkProjects()`。这个脚本只负责
#   「环境检查 + 按顺序跑几步 + 汇总退出码」——
#   千万别在这里重写一套校验（两份规则迟早会走样）。
#
# ── 为什么需要 Node ≥ 22.18 ──
#   全靠原生的 TypeScript 类型擦除直接 import 那些 .ts。
#   低版本会报 `Unknown file extension ".ts"`。
#
# ★ Windows 上：本机（未装 WSL 发行版）跑不了 bash —— 用
#   `npm run check` / `npm run check:posts` / `npm run check:projects` 等价替代；
#   或者用 Git Bash / MSYS2 执行本脚本。
# ★ 本脚本依赖 LF 换行；用 Windows 编辑器改完记得别存成 CRLF
#   （CRLF 会让 bash 报 `\r: command not found`）。
#
set -euo pipefail

# 切到仓库根（脚本在 scripts/ 下，所以在哪调用都能正常工作）
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ONLY=""
CONTENT_ONLY=0
SKIP_BUILD=0
JSON_OUT=0

for arg in "$@"; do
  case "$arg" in
    --only=posts|--only=projects) ONLY="${arg#--only=}" ;;
    --posts-only)                 CONTENT_ONLY=1 ;;   # 旧名字，保留兼容
    --content-only)               CONTENT_ONLY=1 ;;
    --no-build)                   SKIP_BUILD=1 ;;
    --json)                       JSON_OUT=1 ;;
    -h|--help)
      sed -n '2,23p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "✗ 不认识的参数：$arg（-h 看用法）" >&2
      exit 2
      ;;
  esac
done

say() { printf '\n\033[1m%s\033[0m\n' "$1"; }
ok()  { printf '  \033[32m✓\033[0m %s\n' "$1"; }
die() { printf '\n  \033[31m✗\033[0m %s\n\n' "$1" >&2; exit 1; }

# ---------------------------------------------------------------- 环境
if ! command -v node >/dev/null 2>&1; then
  die "没找到 node。本项目需要 Node ≥ 22.18。"
fi

NODE_MAJOR=$(node -p "process.versions.node.split('.')[0]")
NODE_MINOR=$(node -p "process.versions.node.split('.')[1]")
if [ "$NODE_MAJOR" -lt 22 ] || { [ "$NODE_MAJOR" -eq 22 ] && [ "$NODE_MINOR" -lt 18 ]; }; then
  die "需要 Node ≥ 22.18（直接 import .ts 依赖原生类型擦除），当前是 $(node -v)"
fi

if [ ! -d node_modules ]; then
  die "没装依赖。先跑一次 npm ci（或 npm install）。"
fi

# ---------------------------------------------------------------- 1/4 内容
if [ -n "$ONLY" ]; then
  say "[1/4] 内容校验（$ONLY：frontmatter / 图片 / slug / 模板）"
else
  say "[1/4] 内容校验（文章 + 项目：frontmatter / 图片 / slug / 模板）"
fi
CHECK_ARGS=()
[ -n "$ONLY" ] && CHECK_ARGS+=("--only=$ONLY")
[ "$JSON_OUT" -eq 1 ] && CHECK_ARGS+=("--json")
if [ "$JSON_OUT" -eq 1 ]; then
  node scripts/check-content.mjs "${CHECK_ARGS[@]}" || die "内容校验没通过（见上面的 JSON）"
else
  node scripts/check-content.mjs "${CHECK_ARGS[@]}" || die "内容校验没通过 —— 上面的每一条都指出了文件和原因"
fi
ok "内容与模板都合法"

if [ "$CONTENT_ONLY" -eq 1 ]; then
  printf '\n  （--content-only：跳过类型检查与构建）\n\n'
  exit 0
fi

# ---------------------------------------------------------------- 2/4 类型
say "[2/4] 类型检查（vue-tsc -b）"
npm run typecheck || die "类型检查没通过"
ok "类型检查通过"

if [ "$SKIP_BUILD" -eq 1 ]; then
  printf '\n  （--no-build：跳过打包）\n\n'
  exit 0
fi

# ---------------------------------------------------------------- 3/4 构建
say "[3/4] 生产构建（vite build）"
npm run build || die "构建失败"
ok "构建通过"

# ---------------------------------------------------------------- 4/4 体积
say "[4/4] 体积预算（首屏 / 单块 / 大二进制）"
npm run budget:check || die "体积超预算 —— 门槛与实测值见上面的输出"
ok "预算通过"

printf '\n  全部通过 ✓\n\n'
