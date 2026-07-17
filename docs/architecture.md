# 架构详解

> 从原版四层架构整理而来，作为实现蓝图。MVP 只实现高亮部分，其余为全功能阶段。

---

## 总览

```
┌─ 第四层 · 交互表层 ────────────────────────────────────────┐
│  PWA 播放器（:8080）  ←HTTP/WS→  Claudio server               │
└───────────────────────────────▲───────────────────────────┘
                                 │
┌─ 第三层 · 运行时聚合 ───────────┴───────────────────────────┐
│  每次触发：6 片 → system prompt → 模型 → {say,play[],...}     │
└───────────────────────────────▲───────────────────────────┘
                                 │
┌─ 第二层 · 本地大脑 ─────────────┴───────────────────────────┐
│  router · context · llm · recommendation · events · tts       │
└───────────────────────────────▲───────────────────────────┘
                                 │
┌─ 第一层 · 外部上下文 ───────────┴───────────────────────────┐
│  user/*.md · ChatGPT/Claude/DeepSeek · 网易云 · Fish TTS      │
└────────────────────────────────────────────────────────────┘
```

---

## 第一层 · 外部上下文

| 块 | MVP | 全功能 |
|---|---|---|
| 用户语料 `user/*.md` | taste.md（核心） | + routines / mood-rules / playlists |
| 大脑 | ✅ Codex app-server（默认 GPT-5.6 Luna） | 可切 Claude / DeepSeek |
| 音乐 网易云 | ✅ search/song_url | + lyric/recommend/登录态 |
| 声音 I/O | ✅ TTS | + 天气 ✅ / ~~日历(Lark)~~（已取消） / UPnP(Naim) |

## 第二层 · 本地大脑（server/）

- **llm/** — 常驻 Codex app-server（默认 GPT-5.6 Luna + low + priority）与统一输出规整；`claude.js` 保留 Claude CLI / DeepSeek provider。
- **settings.js** — `cache/settings.json` 运行时设置；下一次请求即生效，密钥不返回前端。
- **context.js / recommendation.js / discovery.js** — 场景提示、10/65/25 探索编排、收藏/近期/反感过滤、网易云相似歌曲候选池。
- **events.js / profile.js** — 只追加真实听歌事件，按显式反馈、收藏、完整听完、秒切等权重生成画像。
- **tts/** — Fish HTTP 流边生成边播放并写缓存；首段超时明确失败，绝不自动切换 macOS `say`。
- **scheduler.js** — cron 式节律（07:00 规划 / 09:00 早间 / 整点情绪检查）。当前**默认关闭**（`SCHEDULER_ENABLED=1` 才开）；日历 hook 已取消。
- **state.js** — 记忆：messages / plays / plan / prefs。MVP：内存 + JSON 落盘；全功能可换 sqlite。

## 第三层 · 运行时聚合（每次触发）

把这 6 片拼成 prompt：

1. **系统提示词** `prompts/dj-persona.md`
2. **用户语料** `user/*.md`
3. **环境注入** weather · now · nowPlaying（日历已取消）
4. **已检索记忆** state · plays（最近放过什么，避免重复）
5. **用户输入 / 工具结果** `/api/chat` · ncm search
6. **执行轨迹** scheduler · webhook（全功能）

→ 模型前向 `compute(fragments) → {say, play[], reason, memoryCandidates}`
→ 本地过滤/降权候选 → ncm 解析可播队列；`say` 一闭合即启动 Fish 音频流，WS 先推口播。

## 第四层 · 交互表层

- **前端**：单页，**双音轨 `<audio>`（trackA/trackB 交叉淡入）+ WebAudio（`GainNode` 控音量、`AnalyserNode` 出频谱）**，一个**播放队列**（项类型 `tts` 念词 / `song` 放歌）。WS 推字幕与状态。
  > ⚠️ WKWebView 下音频接入 WebAudio 后 `element.volume` 对输出失效，**音量必须走 `GainNode.gain`**（`setTrackVol`/`trackVol`）；这是 ducking / 音量条 / 口播提响（gain 可 >1）的唯一可靠途径。
- **HTTP/WS 契约**：见 CLAUDE.md 表格。
- **autoplay**：首屏一个"开始收听"按钮拿用户手势，之后队列自动连播。
- 全功能：Player / Profile / Settings 三视图 + service worker 缓存壳层 + prefetch 下一段 10s。

---

## 播放队列模型（前端核心）

```
queue = [
  { type: 'tts',  url: '/tts/<hash>.mp3', text: 'DJ 口播稿…' },  // 念词，带字幕
  { type: 'song', url: '<网易云直链>',     meta: {title, artist} }, // 放歌
  { type: 'song', ... },                                          // 下一首（已不做过渡口播 segue，省 Fish 额度）
  ...
]
```

双音轨顺序消费队列：主轨放当前项、idle 轨预载下一项做交叉淡入；`ended`/进度推进；`tts` 项同步高亮字幕；接近队尾时请求下一期（prefetch）。

**ducking / 交叠（电台范儿，音量全走 GainNode）**：
- 口播→歌（自动）：口播念到最后 ~6s（`MUSIC_LEAD`），下一首歌以 ~20% 背景音垫进来 → 口播完停 ~1s → ~2s 涨回原音量。
- 聊天插口播：不在发话瞬间压，等口播快出来时把当前歌 ~1.2s 压到背景音（`BG_VOL≈0.13`）→ 口播叠上去念（口播增益 `SAY_GAIN≈1.25` 提响）→ 念完没切歌就慢慢回升、要切歌就换新歌。
- 看门狗：duck 后必须有界时间内接管或强制恢复；口播开播后按「口播真实时长+余量」重设，避免长思考误砍正在念的口播。
