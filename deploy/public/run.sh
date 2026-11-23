#!/bin/sh
# 在旧盒子上（重新）起公用版容器 claudio-public。和老板的 claudio 容器完全分开：
#   代码 ~/stacks/claudio-public/app（公用版分支的拷贝，不是老板那份）
#   数据 ~/stacks/claudio-public/data（每人的加密 cookie / 临时记忆）
#   密钥 ~/stacks/claudio-public/secret.env（PUBLIC_HUB_KEY、PUBLIC_VAULT_KEY 等，chmod 600，不进仓库）
# 只听 127.0.0.1:8091，对外由 cloudflared 转发；不挂 ~/stacks/claudio 下的任何东西。
# 127.0.0.1:8092 是好友互荐给老板个人版用的内部口（只认本机，不经 Cloudflare），老板的 claudio 容器设 FRIENDS_URL 来连。
set -eu
BASE="$HOME/stacks/claudio-public"
NODE_DIR="${NODE_DIR:-$HOME/.nvm/versions/node/v22.23.2}"
[ -f "$BASE/secret.env" ] || { echo "缺 $BASE/secret.env" >&2; exit 1; }
mkdir -p "$BASE/data"
docker build -t claudio-public:latest "$BASE/app/deploy/public"
docker rm -f claudio-public 2>/dev/null || true
# Turnstile secret 老板自己填在 ~/.config/claudio-public/turnstile.secret（600），有就只读挂进去
TURNSTILE="$HOME/.config/claudio-public/turnstile.secret"
EXTRA=""
[ -f "$TURNSTILE" ] && EXTRA="-v $TURNSTILE:/run/secrets/turnstile.secret:ro -e PUBLIC_TURNSTILE_SECRET_FILE=/run/secrets/turnstile.secret"
docker run -d --name claudio-public \
  --restart unless-stopped \
  --network host \
  --memory 384m --memory-swap 384m \
  --user 1000:1000 \
  --env-file "$BASE/secret.env" \
  -e CLAUDIO_DATA_DIR=/data \
  -e PORT=8091 -e HOST=127.0.0.1 -e NCM_PORT=3011 \
  -e FRIENDS_INTERNAL=127.0.0.1:8092 \
  -e TZ=Asia/Shanghai \
  -v "$BASE/app:/app:ro" \
  -v "$BASE/data:/data" \
  -v "$NODE_DIR:/opt/node:ro" \
  $EXTRA \
  claudio-public:latest
