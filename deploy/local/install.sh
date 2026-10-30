#!/usr/bin/env bash
#
# 把 dist/ 发布到 nginx 的站点根目录，然后 reload。
#
#   node deploy/local/build.mjs     # 先构建
#   bash deploy/local/install.sh    # 再发布
#
# 可用环境变量：
#   ROOT=/var/www/kuroki           站点根目录
#   OWNER=www-data                 属主（Debian/Ubuntu 的 nginx 用户）
#   NO_RELOAD=1                    只拷文件，不动 nginx
#
set -euo pipefail

ROOT="${ROOT:-/var/www/kuroki}"
OWNER="${OWNER:-www-data}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC="$(cd "$HERE/../.." && pwd)/dist"

if [ ! -f "$SRC/index.html" ]; then
  echo "找不到 $SRC/index.html —— 先跑：node deploy/local/build.mjs" >&2
  exit 1
fi

echo "→ 发布 $SRC → $ROOT"
sudo mkdir -p "$ROOT"
# --delete 让旧哈希文件不堆积；音频目录在 /music 里，不在 dist 里，不受影响
sudo rsync -a --delete "$SRC/" "$ROOT/"
sudo chown -R "$OWNER:$OWNER" "$ROOT"

if [ "${NO_RELOAD:-0}" = "1" ]; then
  echo "已拷贝（NO_RELOAD=1，跳过 nginx 检查）"
  exit 0
fi

sudo nginx -t
sudo systemctl reload nginx
echo "✓ 已发布到 $ROOT，nginx 已 reload"
echo "  内网访问：http://$(hostname -I | awk '{print $1}')/"
