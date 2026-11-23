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
│  user/*.md · 家里盒子 / 云端模型 · 网易云 · 语音                  │
└────────────────────────────────────────────────────────────┘
```

---

## 第一层 · 外部上下文

| 块 | MVP | 全功能 |
|---|---|---|
| 用户语料 `user/*.md` | taste.md（核心） | + routines / mood-rules / playlists |
| 大脑 | ✅ 可插拔。默认家里盒子（DeepSeek V4.1 Flash） | 可切 Claude / DeepSeek 官方 API |
| 音乐 网易云 | ✅ search/song_url | + lyric/recommend/登录态 |
| 声音 I/O | ✅ TTS | + 天气 ✅ / ~~日历(Lark)~~（已取消） / UPnP(Naim) |

## 第二层 · 本地大脑（server/）

- **llm/** — 按 `settings.llm.provider` 分发：`local`（默认，家里盒子）/ `claude` / `deepseek`；`normalize.js` 解析 `{say,intent,action,actionValue,play,reason,memoryCandidates}`。`codex` / `grok` / `ornith` / `agent2api` 已于 2026-10-31 下线，旧设置读进来自动迁到 `local`。
- **settings.js** — `cache/settings.json` 运行时设置；下一次请求即生效，密钥不返回前端。
- **context.js / recommendation.js / discovery.js / bans.js** — 场景提示、探索编排、收藏和近期过滤。自动推荐只躲开 `cache/bans.json`；历史不喜欢只在清单尚未播种时写入一次。点名要听时可以放过被禁的那首。撤销走 `POST /api/bans/remove`。发现池 = 收藏的网易云相似歌 + 热歌 / 新风格 / 老歌三条榜单，过期（24 小时，或一首榜单歌都没有）才刷新，每小时查一次；网易云一个都连不上时不算刷新，30 秒起退避重试（App 启动时自带的网易云服务常常还没起来）。
- **rooms.js / audio-route.js / exclusive-play.js** — 房间别名在 `cache/rooms.json`。「放到客厅」这类短句在打模型前切换设备。已出现在 CoreAudio 输出里的 AirPlay 只送 Claudio，不改系统默认输出；还没出现的走控制中心，整台 Mac 的声音会一起过去。不接 RAAT，不装 pyatv。
- **voice.js** — 输入栏「说」把短录音交给家里盒子转写，文字再进现有的暂停、换歌、点歌。不新做一套播放命令。
- **ncm.js** — 网易云 search → song_url → lyric。网易云嫌太频繁会回 405「操作频繁」：按接口冷却 1 分钟起（翻倍，最长 10 分钟，成功即复位），冷却期间直接报忙、不再请求；诊断里记 `rate-limited`，不和「放不了」混在一起。垫场歌一批被限流就停这一轮；有接口在冷却（`coolingDown()`）时，垫场歌不为曲风多找。搜索带登录 cookie；后台备节目 / 发现池 / 垫场 / 开播前刷新的搜索排队：间隔 `NCM_SEARCH_GAP_MS`（默认 1.5 秒），任意 60 秒内连点歌一起不超过 `NCM_SEARCH_PER_MIN`（默认 6）个；点歌不排队、不受上限挡。来源用 `withNcmSource()` 标记，每分钟汇总一行 `[ncm-rate]`。盒子上几个实例合用名额（`ncm-shared.js`）：老板实例开只听本机的名额服务（`NCM_SHARED_SERVE`，127.0.0.1:8099），它自己的搜索照旧走本进程队列；别的实例（`NCM_SHARED_URL`）每次搜索前来要，合起来仍守每分钟上限，老板实例排队时不给、别的实例（点歌也算）最多用到上限减 `NCM_SHARED_RESERVE`，405 冷却互相通报；服务不通就按本实例上限照搜。
- **song-meta.js** — 从网易云详情取年份和曲风。没有就不编，也不为了补一句口播再打一轮模型。
- **events.js / profile.js** — 只追加真实听歌事件，按显式反馈、收藏、完整听完、秒切等权重生成画像。
- **tts/** — `pc5090`（默认，5090 上的 Fish S2-Pro）/ `fish`（云端，手动备用）；`say.js` 只是手工开发选项。聊天边合成边念（`live.js`）；点开始和预生成走 `synthesize()`，要等整段口播合成完再交给播放器。失败不自动切换。
- **scheduler.js** — cron 式节律（07:00 规划 / 09:00 早间 / 整点情绪检查）。当前**默认关闭**（`SCHEDULER_ENABLED=1` 才开）；日历 hook 已取消。
- **state.js** — 记忆：messages / plays / plan / prefs。MVP：内存 + JSON 落盘；全功能可换 sqlite。

### 大脑与语音供应商（可插拔，设置页切换）

| 层 | provider | 说明 |
|---|---|---|
| 大脑 | `local` / `claude` / `deepseek` | `server/llm/index.js` 按 `settings.llm.provider` 分发；`local` = 家里盒子 OpenAI 兼容接口（地址在 `.env` 的 `LOCAL_LLM_BASE_URL` 或设置页填，默认 `http://127.0.0.1:8001/v1`；模型 `DeepSeek-V4.1-Flash-1017`） |
| 语音 | `pc5090` / `fish` | `server/tts/index.js` 与 `live.js` 按 `settings.tts.provider` 选；`pc5090` = 5090 台式机上的 Fish S2-Pro（Mac 上经本机隧道 `http://127.0.0.1:18081`；装在 5090 的 Windows 本机时直连 WSL 上的服务、经 `wsl.exe` 调 gpuctl；主机名和地址都在 `.env` 里配；音色 `claudio`）；`fish` = 云端，手动备用 |

- 失败一律明确报错，**不自动回退**到别的供应商或 macOS `say`。
- 设置存 `<数据目录>/cache/settings.json`，密钥存 `cache/secrets.json`（`localLlmApiKey` / `localTtsApiKey`，界面不回显）。数据目录：容器里是 `CLAUDIO_DATA_DIR`（盒子上 `/data`），开发态是项目根。
- TTS 缓存键含 provider、音色、模型、服务地址，切换后不会命中旧音色缓存。
- 本地模型 / 语音服务的地址、主机名一律放 `.env`（见 `.env.example`），代码和文档里不写真实值。

## 第三层 · 运行时聚合（每次触发）

把这 6 片拼成 prompt：

1. **系统提示词** `prompts/dj-persona.md`
2. **用户语料** `user/*.md`
3. **环境注入** weather · now · nowPlaying（日历已取消）
4. **已检索记忆** state · plays（最近放过什么，避免重复）
5. **用户输入 / 工具结果** `/api/chat` · ncm search
6. **执行轨迹** scheduler · webhook（全功能）

拼接顺序按变化快慢：不变的（人设、契约、口味档案）在前，常变的（最近口播、本次任务、环境、听众原话）在后，好命中盒子的前缀缓存；收藏样本和候选池按小时固定抽样（`context.js`）。候选池只给自动节目；点歌提示词不给（实测大脑会照抄池里的歌），池子仍留给程序兜底。环境前面有一段「此刻场景」（`scene.js`）：工作日 / 周末 + 时段定默认场景，听众说「我在上班」等会覆盖；工作、深夜、睡前时自动节目的桥接和发现位也服从场景。同场景以前的喜欢 / 跳过（行为记录带 `scene`）也放在这里。

→ 模型前向 `compute(fragments) → {say, intent, action, play[], reason, memoryCandidates}`
→ 本地过滤/降权候选（点了曲风时按网易云曲风核对，一首都没有才对「最近听过」放宽一次）→ ncm 解析可播队列。聊天和控制的 `say` 一闭合就交给语音供应商；推荐要等可播歌定下、口播校正后再合成。

## 第四层 · 交互表层

- **前端**：单页，**三个 `<audio>`：两路音乐 `musicA`/`musicB`（交叉淡入）+ 一路口播 `voice`；WebAudio（`GainNode` 控音量、`AnalyserNode` 出频谱）**，一个**播放队列**（项类型 `tts` 念词 / `song` 放歌）。音量包络按 `performance.now()` 的真实时间求值（30 ms 定时器），不靠窗口绘制，窗口隐藏也照常淡入淡出。WS 推字幕与状态。
  > ⚠️ Safari（WebKit）下音频接入 WebAudio 后 `element.volume` 对输出失效，**音量必须走 `GainNode.gain`**（`setTrackVol`/`trackVol`）；这是 ducking / 音量条 / 口播提响（gain 可 >1）的唯一可靠途径。
- **HTTP/WS 契约**：见 `AGENTS.md` 与 `CLAUDE.md` 的契约表。两份都要改，避免只更新其中一份。
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

两路音乐顺序消费队列：主轨放当前项、空闲轨预载下一项做交叉淡入；`ended`/进度推进；口播走单独的 `voice`，字幕按语音时长逐字出；边合成边推的口播（`/api/tts/stream/`）由 `voice-stream.js` 用 MediaSource 收一块喂一块，首块到就能开口，打不开就直接设 src。点歌时口播一出声新歌就压低音量垫在下面；自动节目在口播剩 6 秒、或上一首已放完时垫进来。多设备接力：服务端 `handoff.js` 记当前歌和进度（`cache/playback.json`），设备每 5 秒和开播 / 暂停 / 拖动时上报；一台开始响就经 WS `handoff` 叫其他设备暂停；点播放先取服务端进度，只接歌不重念口播。节目由后端预备，前端快放完时领取（`/api/next?claimId=`），真正开声才报 `started`；没备好先放垫场歌（点了曲风时先挑网易云曲风对得上的，没有就照旧放别的）。

**歌与歌**：等功率交叉淡入 3 秒；钢琴、古典、爵士、氛围、原声等 1.2 秒（`transitions.js` 的 `crossfadeDuration`）。

**ducking / 交叠（电台范儿，音量全走 GainNode）**：
- 歌→口播（自动）：上一首还剩约 8 秒时开口，口播压在尾奏上（尾奏降到背景音）；语音跳过的节目在交叉淡入窗口内直接接歌。
- 口播→歌（自动）：口播念到最后 ~6s（`MUSIC_LEAD`），下一首歌以背景音垫进来 → 口播完停 ~1s → ~2s 涨回原音量。
- 聊天插口播：不在发话瞬间压，等口播快出来时把当前歌 ~1.2s 压到背景音（`BG_VOL≈0.13`）→ 口播叠上去念（口播增益 `SAY_GAIN≈1.25` 提响）→ 念完没切歌就慢慢回升、要切歌就换新歌。
- 看门狗：duck 后必须有界时间内接管或强制恢复；口播开播后按「口播真实时长+余量」重设，避免长思考误砍正在念的口播。

**只送一只音箱时不能交叉淡入**：`AVAudioPlayerNode` 一次只播一路，所以口播和歌改成先念完再放。切到这只音箱时，当前这首从头再送。网页进度条不能跳转这一路。本机扬声器仍走两路音乐 + 口播。
