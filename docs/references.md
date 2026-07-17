# 参考资料

> 做 Claudio 的所有外部参考集中在这里。新增参考请追加，不要删历史。

---

## 一、原版项目（我们要复刻的目标）

**Claudio · 个人 AI 电台**（作者 mmguo，**未开源**，仅有架构图与产品截图）

- 定位：读懂听歌习惯 → 规划声音 → 像 DJ 那样播报。
- 截图里的形态：网页播放器，顶部音频波形，中部是聊天式字幕（Claudio 的口播逐句高亮 + 用户语音），底部播放控制。示例节目名 `mmguo's Pilot Episode`，正在放 `If — Bread`。
- 架构图（用户提供）分四层，要点：

  1. **外部上下文**
     - `USER/` 用户品味语料：`taste.md` `routines.md` `playlists.json` `mood-rules.md`
     - `BRAIN` Claude Code：子进程调用，用 Max 订阅免 API key（`claude -p --output json`）
     - `MUSIC` NeteaseCloudMusicApi：`search` `song_url` `lyric` `recommend`
     - `VOICE · I/O`：Fish（TTS）· Feishu/Lark（日程）· Weather（天气）· UPnP/Naim（客厅功放）
  2. **本地大脑**
     - `router.js` 意图分流：简单指令直连 · 音乐走 ncm · 自然语言走 claude
     - `context.js` 提示词组装：taste + routines + 环境 + 历史 → system prompt
     - `claude.js` 大脑适配器：spawn 子进程，`normalizeResult` 解析 `{say, play[], reason, memory}`
     - `scheduler.js` 节律调度：07:00 规划 · 09:00 早间 · 小时情绪检查 · 日历 hook
     - `tts.js` 声音管线：Fish Audio → `cache/tts/*.mp3` → `/tts/<hash>.mp3`
     - `state.db` 状态·记忆：`messages` `plays` `plan` `prefs`，跨重启持久
  3. **运行时聚合（Context Window）** — 每次触发把 6 片粘成 prompt：
     ① 系统提示词 `prompts/dj-persona.md` ② 用户语料 `user/*.md` ③ 环境注入 weather·calendar·now
     ④ 已检索记忆 `state.db·plays` ⑤ 用户输入/工具结果 `/api/chat·ncm search` ⑥ 执行轨迹 `scheduler·webhook`
     → `compute(fragments) → {say, play[], reason, memory}` → ncm 解析 queue · tts 合成 say · WS 推 now-playing
  4. **交互表层**
     - `PWA/` localhost:8080：Player / Profile / Settings 三视图 · 单 `<audio>` · WS 流式聊天 · sw 缓存壳层 · prefetch 10s
     - HTTP 契约 6 条：`POST /api/chat` · `GET /api/now` · `GET /api/next` · `GET /api/taste` · `GET /api/plan/today` · `WS /stream`

> 原图保存：见用户在 issue/对话中提供的两张截图（架构图 + 播放器 UI）。

---

## 二、开源同类 / 可借鉴项目

| 项目 | 链接 | 借鉴点 |
|---|---|---|
| WRIT-FM 方法论 | https://www.roborhythms.com/how-to-build-ai-radio-station-with-claude-2026/ | Claude CLI 写 DJ 稿 → TTS → Icecast 推流，整体思路最接近 |
| claude-music | https://github.com/kennethleungty/claude-music | Claude Code 会话里的 AI DJ，"理解你的 vibe" |
| DJ Claude | https://www.claude.dj/ | AI live coding music 的交互形态 |
| Claude DJ skill | https://claudskills.com/skills/claude-dj/ | 自治电台 DJ 的 skill 封装思路 |
| Andon FM | https://andonlabs.com/blog/andon-fm | 多 AI 跑电台的实验观察 |

---

## 三、关键依赖

### 音乐：NeteaseCloudMusicApi

- 原版（已停更，npm 仍在）：https://github.com/Binaryify/NeteaseCloudMusicApi
- **复兴增强版（推荐）**：https://github.com/NeteaseCloudMusicApiEnhanced/api-enhanced
- 作为**外部服务**起一个本地实例，Claudio 通过 `NCM_BASE`（默认 `http://localhost:3000`）调用。
- 用到的接口：`/search`、`/song/url`（或 `/song/url/v1`）、`/lyric`、`/recommend/songs`。
- ⚠️ `/song/url` 多数歌需登录 cookie 才返回真实直链；VIP/无版权歌可能为 null。登录方式：扫码 `/login/qr/*` 或手机号 `/login/cellphone`，拿到 cookie 注入后续请求。
- 起实例（待 spike 时最终确认）：clone api-enhanced → `npm install` → `node app.js`。

### TTS：Fish Audio

- 文档：https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
- 端点：`POST https://api.fish.audio/v1/tts`，`Authorization: Bearer <key>`，`Content-Type: application/json`
- body 关键字段：`text`、`reference_id`（音色模型 id）、`format`（mp3）、`prosody.speed/volume`、model header（`speech-1.5/1.6`）
- npm SDK：`fish-audio-sdk`（也可直接 fetch）
- 需要：`FISH_API_KEY` + `FISH_REFERENCE_ID`（音色），放 `.env`

### TTS 开发期占位：macOS say（默认）

- 实测 edge-tts（`msedge-tts`）国内连不上微软端点（Connect Error），已降级为可选 provider。
- 改用 macOS 自带 `say`：离线、零依赖、免费、中文嗓音多（Tingting/Meijia/Sinji…），输出 wav。
- 切换由 `.env` 的 `TTS_PROVIDER=say|edge|fish` 控制；接 Fish 时改 `fish` 并填 key。

### 大脑：Claude Code CLI

- 调用：`claude -p "<prompt>" --output-format json`
- 用 Max 订阅，免 API key。返回信封形状以 `scripts/spike-claude.mjs` 实测为准。

---

## 四、待确认 / 风险登记

- [ ] 网易云 `/song/url` 在本机匿名 / 登录态下的可播率（spike-ncm 验证）
- [ ] `claude -p --output-format json` 的确切信封字段与单次延迟（spike-claude 验证）
- [ ] NeteaseCloudMusicApiEnhanced 的确切启动命令 / 端口
- [ ] Fish Audio 计费与音色 reference_id（待用户提供 key）
