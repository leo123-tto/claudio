# Claudio 🎙️

个人 AI 电台：大模型当 DJ 大脑，读你的听歌口味 → 选歌 → 写一段口播 → TTS 念出来，网页播放器一边放歌一边滚歌词和字幕，自动连播。

> 只有**网页版**：服务跑在一台常开的机器上，电脑和手机浏览器打开同一个地址就能听，多设备之间可以接力。（早期的 macOS 桌面 App 已于 2026-11-23 去掉。）

## 它能做什么

- **DJ 大脑可插拔**：本地 OpenAI 兼容服务（默认）/ Claude Code CLI / DeepSeek 官方 API，在设置页切换；失败明确报错，不自动换。
- **语音可插拔**：自建 Fish S2-Pro 服务 / Fish Audio 云端；语音不在时只放歌，不冷场。
- **音乐源**：本地起一个 [NeteaseCloudMusicApi](https://www.npmjs.com/package/NeteaseCloudMusicApi) 实例，搜索、取直链、取歌词。
- **网页播放器**（`web/`）：两路音乐交叉淡入 + 一路口播、歌词平滑滚动、沉浸歌词、睡眠定时、多设备接力；手机竖屏 / 横屏 / 折叠屏都做了适配。
- **公用版**（`CLAUDIO_MODE=public`，`server/public/`，网页和个人版同一份 `web/`）：多人版，每人绑定自己的网易云账号，放歌 + 文字 DJ。

## 本地跑起来

需要 Node.js 20+。

```bash
npm install

# 1. 配置：复制样例，按注释填（全部留空也能起，只是没有大脑和语音）
cp .env.example .env

# 2. 你的口味档案：从空白模板起一份（user/ 不进仓库）
cp -r packaging/default-user user

# 3. 起网易云 API（默认 :3000），另开一个终端
npm run ncm

# 4. 起 Claudio（默认 :8080），浏览器打开 http://localhost:8080
npm run dev
```

- **最小能出声的配置**：`npm run login:ncm` 登录网易云；在 ⚙ 里把大脑切到 DeepSeek（`.env` 填 `DEEPSEEK_API_KEY`）或 Claude（本机已登录 `claude` CLI）。语音可以先不配，那样只放歌、口播出文字。
- 很多歌要登录网易云才有直链：`npm run login:ncm` 扫码，cookie 写进你本机的 `.env`。
- 大脑和语音在网页右上角 ⚙ 里切；本地模型地址、Fish key 也可以在设置页填，只存在本机 `cache/`。
- 口味档案在 `user/`：`taste.md`（口味描述）、`favorites.md`（收藏曲库，可在设置页粘贴网易云歌单链接导入）、`memory.md`（DJ 自己记的长期记忆）等。
- 跑测试：`npm test`。

## 个人版 / 公用版

| | 个人版（默认） | 公用版（`CLAUDIO_MODE=public`） |
|---|---|---|
| 给谁用 | 你自己，一个人的电台 | 邀请制的几位朋友 |
| 前端 | `web/`（同一份界面，服务端 `/api/mode` 说是哪一版、露哪些按钮） | 同左 |
| 口味 | 本机 `user/*.md` | 每人自己的网易云账号 + 临时记忆（加密存储） |
| 口播 | TTS 念出来 | 文字为主，偶尔一句短口播 |
| 部署 | 本机 / 自己的服务器 | 容器，见 `deploy/public/`；**需要自备 hub** |

想参与开发（包括改播放界面）：照上面「本地跑起来」用个人版模式就行，不需要 hub。

## 部署到自己的机器

两种都是一台常开的 Linux / macOS 机器上跑容器，Node 22 装在宿主机、只读挂进容器，代码和数据都挂载，镜像本身只有 debian + tini。

### 个人版（`deploy/box/`）

```bash
BASE=~/stacks/claudio                      # 可用 CLAUDIO_BASE 改
git clone https://github.com/leo123-tto/claudio.git "$BASE/app"
(cd "$BASE/app" && npm ci --omit=dev)
mkdir -p "$BASE/data/cache/logs"
cp "$BASE/app/.env.example" "$BASE/data/.env"           # 按注释填；另加 HOST=127.0.0.1、PORT=8090、NCM_BASE=http://127.0.0.1:3010
cp -r "$BASE/app/packaging/default-user" "$BASE/data/user"
NODE_DIR=/path/to/node-v22 CLAUDIO_BASE="$BASE" sh "$BASE/app/deploy/box/run.sh"
```

- 容器里同时起网易云 API（只开只读接口，`:3010`）和 Claudio；数据目录 `CLAUDIO_DATA_DIR=/data`，读 `data/.env`、`data/user/`，写 `data/cache/`。
- 只听本机，对外请自己加一层 HTTPS 反向代理（Caddy / nginx / Tailscale serve 都行）。手机上的 PWA、麦克风、锁屏播放都要 HTTPS。
- 用自建 GPU 机做语音时，把 ssh 钥匙放 `$BASE/ssh/`，主机名写 `data/.env`（见 `.env.example` 的 `PC5090_*`）；不用就不管。
- 网易云登录：在本机 `npm run login:ncm` 拿到 cookie，填进 `data/.env` 的 `NCM_COOKIE`。

### 公用版（`deploy/public/`）

邀请制多人版。进门（申请、审批、邀请链接、设备、配对码、每日次数）全交给外部服务 **hub**，本仓库不含 hub：要部署公用版，先自备一个实现了 [`docs/hub-api.md`](./docs/hub-api.md) 接口的服务。

```bash
BASE=~/stacks/claudio-public
git clone https://github.com/leo123-tto/claudio.git "$BASE/app"
(cd "$BASE/app" && npm ci --omit=dev)
cp "$BASE/app/deploy/public/secret.env.example" "$BASE/secret.env" && chmod 600 "$BASE/secret.env"
# 填：PUBLIC_HUB_BASE / PUBLIC_HUB_KEY（hub）、PUBLIC_VAULT_KEY（openssl rand -hex 32，加密每人的网易云 cookie）、
#     PUBLIC_LLM_BASE / PUBLIC_LLM_MODEL / PUBLIC_LLM_KEY（OpenAI 兼容大脑）、PUBLIC_APPLY_ORIGINS（申请页所在站点）
NODE_DIR=/path/to/node-v22 sh "$BASE/app/deploy/public/run.sh"
```

- 公用版只听 `127.0.0.1:8091`，对外经 HTTPS 反向代理；设备凭证是 httpOnly cookie（`PUBLIC_COOKIE_SECURE=0` 只用于本机 http 自测）。
- 启动自检：环境里出现个人版的密钥（`NCM_COOKIE`、`FISH_API_KEY`、`DEEPSEEK_API_KEY` 等）会拒绝启动，两版的配置不要混。
- 和个人版装在同一台机器、同一出口 IP 时，网易云按总数限流：个人版设 `NCM_SHARED_SERVE=127.0.0.1:8099`，公用版设 `NCM_SHARED_URL=http://127.0.0.1:8099`，搜索名额合着算。
- 申请页想加人机校验：配 Cloudflare Turnstile 的 `PUBLIC_TURNSTILE_SITEKEY` 和 secret（可放文件，见 `run.sh`）。

## 隐私

- `.env`、API key、网易云 cookie、`user/`、`cache/`、日志和构建产物都被 Git 忽略。
- 仓库里的 `packaging/default-user/` 只有空白模板，不含任何真实用户数据。
- 自己机器的地址、主机名、作息等个人化配置一律写本机 `.env`（见 `.env.example`），不要写进代码或文档。

## 使用提醒

音乐直链来自第三方网易云 API，仅建议个人学习和自用；请自行遵守所在地法律、平台条款和音乐版权规则。

## 文档

- [`AGENTS.md`](./AGENTS.md) — 项目总文档（架构 / 技术栈 / 规范 / 契约），给人和 AI 协作者看
- [`docs/architecture.md`](./docs/architecture.md) — 四层架构详解
- [`docs/references.md`](./docs/references.md) — 参考资料与依赖
- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — 怎么参与

## License

MIT
