#!/bin/sh
# 公用版容器里起两样：网易云 API（只读接口 + 扫码登录 / 本人歌单）和公用版服务。任一样退出，容器就退出，交给 docker 重启。
set -eu
NCM_PORT="${NCM_PORT:-3011}"
mkdir -p /data/logs

PORT="$NCM_PORT" HOST=127.0.0.1 NCM_MODULES=public NCM_PACKAGE_ROOT=/app/node_modules/NeteaseCloudMusicApi \
  node /app/packaging/start-ncm.cjs >>/data/logs/ncm.log 2>&1 &
ncm=$!

CLAUDIO_MODE=public NCM_BASE="http://127.0.0.1:$NCM_PORT" \
  node /app/server/public/index.js >>/data/logs/public.log 2>&1 &
app=$!

trap 'kill "$ncm" "$app" 2>/dev/null' TERM INT
while kill -0 "$ncm" 2>/dev/null && kill -0 "$app" 2>/dev/null; do sleep 5; done
kill "$ncm" "$app" 2>/dev/null || true
exit 1
