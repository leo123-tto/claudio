#!/bin/sh
# 起个人版容器 claudio。目录：$CLAUDIO_BASE（默认 ~/stacks/claudio）下 app/ 放代码、data/ 放 .env、user/、cache/，ssh/ 放拉起语音档用的钥匙（可选）。
set -eu
BASE="${CLAUDIO_BASE:-$HOME/stacks/claudio}"
NODE_DIR="${NODE_DIR:-$HOME/.nvm/versions/node/v22.23.2}"
docker build -t claudio-box:latest "$BASE/app/deploy/box"
docker rm -f claudio 2>/dev/null || true
docker run -d --name claudio \
  --restart unless-stopped \
  --network host \
  --memory 512m --memory-swap 512m \
  --user 1000:1000 \
  -e CLAUDIO_DATA_DIR=/data \
  -e TZ=Asia/Shanghai \
  -v "$BASE/app:/app:ro" \
  -v "$BASE/data:/data" \
  -v "$NODE_DIR:/opt/node:ro" \
  -v "$BASE/ssh:/home/claudio/.ssh:ro" \
  claudio-box:latest
