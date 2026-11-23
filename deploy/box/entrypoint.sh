#!/bin/sh
# 同一个容器里起两样：网易云 API（只开五个只读接口）和 Claudio。任一样退出，容器就退出，交给 docker 重启。
set -eu
NCM_PORT="${NCM_PORT:-3010}"

PORT="$NCM_PORT" HOST=127.0.0.1 NCM_PACKAGE_ROOT=/app/node_modules/NeteaseCloudMusicApi \
  node /app/packaging/start-ncm.cjs >>/data/cache/logs/ncm.log 2>&1 &
ncm=$!

node /app/server/index.js >>/data/cache/logs/claudio.log 2>&1 &
claudio=$!

trap 'kill "$ncm" "$claudio" 2>/dev/null' TERM INT
while kill -0 "$ncm" 2>/dev/null && kill -0 "$claudio" 2>/dev/null; do sleep 5; done
kill "$ncm" "$claudio" 2>/dev/null || true
exit 1
