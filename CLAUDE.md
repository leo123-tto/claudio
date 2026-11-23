# Claudio — 个人 AI 电台

> Claude 当 DJ 大脑：读懂你的听歌习惯 → 规划声音 → 像 DJ 那样播报。

## 先读这段

- **是什么**：个人 AI 电台。Node.js 服务（`server/`）+ 原生 JS 网页（`web/`）：大模型选歌、写口播，TTS 念出来，网页播放器自动连播。
- **两种模式**：个人版（默认，一个人用，口味在 `user/`）；公用版（`CLAUDIO_MODE=public`，邀请制多人，代码在 `server/public/`，进门、设备、额度交给外部 hub，见 `docs/hub-api.md`）。两版共用 `web/`。
- **能力开关**：网页先问 `GET /api/mode` 拿 `{mode, features}`。`web/index.html` 里带 `data-cap="x"` 的控件只在 `features.x` 为真时露出；`web/boot.js` 据此加载 `app.js`（个人版引擎）或 `public.js`（公用版引擎）。个人版开关在 `server/index.js` 和 `boot.js` 的 `PERSONAL`，公用版在 `server/public/app.js`。加按钮的完整步骤见 `docs/上手指南.md`。
- **跑起来 / 测试**：`npm install` → `npm run ncm` → `npm run dev`（:8080）；`npm test`（`node --test`，不联网），提交前必须全过。
- **红线**：不提交密钥、cookie、`.env`、`user/`、日志、内网地址；不写绕过平台限制、伪装客户端的代码；音源只走插件接口（`server/sources.js`），仓库里不放具体音源；前端不写内联脚本、不引外部资源（公用版有 CSP）。
- **改动原则**：最小必要改动、沿用现有风格、新依赖先说明。流程见 `CONTRIBUTING.md`。

本文件是项目**总文档**，给所有在这个仓库里工作的 AI / 人看。它只放**稳定的总览**，不记流水账。

- 📈 开发进度：`docs/progress.md`（**进度只写这里，不要写进本文件**）
- 🏛 架构细节：`docs/architecture.md`
- 🔖 参考资料：`docs/references.md`（原版项目 + 开源复刻 + 依赖）

---

## 当前阶段

**MVP（核心闭环）** → 终极目标是**复刻 mmguo 原版 Claudio 的全功能**。

框架按"全功能复刻"来搭（音乐源、TTS、调度都预留扩展点），实现先打通最小闭环：

> 网页放歌 + Claude 写口播 + TTS 念出来 + 自动连播。

---

## 它是什么

让 Claude 当电台 DJ 的大脑。它读你的口味文件，决定放哪几首歌 + 写一段 DJ 口播稿，
TTS 把稿子合成人声，网页播放器一边放歌一边念词，并能按时间节律自动开节目（早间 / 情绪）。

**一期节目的数据流：**

```
后台预备（episode-buffer，常备两期）
   → context.js  把 Vera 人格 + taste.md + 历史 + 时段语气档 拼成 prompt
   → llm/        按设置调用当前大脑，normalize.js 解析 {say, play[], reason, …}
   → ncm.js  把歌名解析成可播直链   ┐
   → tts/    把 say 合成 mp3        ┘ 并行；口播稿一写完就先合成；语音不在就跳过口播
你点 [开始 / 下一首]，或这期快放完
   → 前端领取一期（没备好先放垫场歌）→ 开声才报 started
   → 口播压在上一首尾奏上 → 交叉淡入放歌 → 领下一期 → ...
```

---

## 四层架构（忠于原版，详见 docs/architecture.md）

1. **外部上下文** — 用户语料 `user/*.md` · 可插拔大脑 · 网易云（音乐）· 声音 I/O（TTS / 天气 / 音响；日历已取消）
2. **本地大脑** — `router` 意图分流 · `context` 提示词组装 · `llm` 大脑适配 · `episode-buffer` 节目预备 · `scheduler` 节律 · `tts` 声音管线 · `state` 记忆
3. **运行时聚合** — 每次触发把 6 片粘成 prompt → 模型前向 → `{say, play[], reason, memory}` → ncm 解析队列 + tts 合成 + WS 推 now-playing
4. **交互表层** — PWA 播放器 + HTTP / WS 契约

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 大脑 | 可插拔三家：本地 OpenAI 兼容服务（默认，DeepSeek V4.1 Flash）/ Claude 订阅（CLI）/ DeepSeek 官方 API | ChatGPT、Grok、Ornith、Agent2API 于 2026-10-31 下线，旧设置读进来自动迁到本地服务。不自动回退 |
| 音乐 | NeteaseCloudMusicApi 4.32.0（本地实例，外部服务；**没有解灰**）；音源可用插件扩展（`server/sources.js`） | search / song_url / lyric / recommend。网易云拿不到（灰、无版权、只有试听、搜索限流）时问插件 |
| TTS | 可插拔，默认 `pc5090`（自建 GPU 机上的 Fish Drama 3，经一层网关保持 Fish 原生 `/v1/tts`，音色 `claudio`），Fish 云端手动备用 | `server/tts/`：pc5090 / fish / say，失败不自动回退；语音服务不在时这期跳过口播只放歌。可经 ssh 隧道连到 WSL 上的服务（本机 `127.0.0.1:18081` → 远端），语音档没起来时经 ssh 叫 gpuctl 拉起（冷启动约 2 分钟）；主机名和地址都在 `.env`。网关支持 `stream_audio`（健康检查带这个字段）时整段一次要、边合成边念；不支持时退回首句先合成（`PC5090_STREAM=0` 也退回）。口播开头带时段语气提示、句内可带 Drama 3 演出标记（`server/tone.js`、`server/tts/tags.js`；只给 pc5090 念，Fish 云端和页面一律去掉），网页 0.9 倍播放。装在 GPU 机的 Windows 本机时不开隧道，直连 WSL，经 `wsl.exe` 调 gpuctl（`PC5090_GPUCTL=wsl`） |
| 后端 | Node.js (ESM) + Express + ws | node ≥ 20 |
| 前端 | PWA（原生 JS；三个 `<audio>`：两路音乐交叉淡入 + 一路口播；WebAudio `GainNode` 控音量/频谱；WS） | 不引重框架。包络按真实时间走，窗口隐藏也不停 |
| 部署 | 只有网页版（2026-11-23 起不再做 Mac App），服务跑在一台常开的机器上 | 个人版：`deploy/box/` 容器（512 MB 上限，只听 127.0.0.1，经 HTTPS 反向代理或 Tailscale serve 对内网开放），电脑和手机浏览器打开同一个地址。公用版：同一台机器上另起容器 `claudio-public`（`CLAUDIO_MODE=public`，`deploy/public/`，需要自备 hub，见 `docs/hub-api.md`）。步骤见 README |

---

## 目录结构

```
claudio/
├─ CLAUDE.md / AGENTS.md     # 本文件 · 项目总文档（两份内容相同，改一份要同步另一份）
├─ README.md                 # 四条入口 + quickstart
├─ CONTRIBUTING.md           # PR 流程、分工、安全红线、用 AI 写码
├─ package.json
├─ .env.example              # 配置样例（真实 .env 不入库）
├─ .gitignore
├─ docs/
│  ├─ references.md          # 参考资料：原版 + 复刻 + 依赖
│  ├─ progress.md            # 开发进度（实时更新）
│  ├─ architecture.md        # 四层架构详解
│  ├─ 上手指南.md            # 本地跑起来、代码地图、加按钮的例子、手机调试、常见坑
│  ├─ 自部署.md              # 自己部署个人版 / 公用版
│  └─ hub-api.md             # 公用版需要的 hub 接口契约（hub 不在本仓库）
├─ server/
│  ├─ index.js               # Express + WS 入口（:8080）· finalizeEpisode 组队列 · /proxy 音频代理
│  ├─ episode-buffer.js      # 后台预备两期节目：领取 → 开声才算数 → 没放就退回；epoch 作废旧节目；没有网页连着或点了停止就不备；备出零首歌的不进缓冲，30 秒起退避重试
│  ├─ episode-audio.js       # 节目里的歌解析成可播地址（点歌总预算 20 秒、后台 90 秒）；开播前刷新过期直链
│  ├─ episode-coherence.js   # 口播提到不会播的歌或顺序不对时才改写
│  ├─ drive.js               # 驾驶模式：口播只说一句（DRIVE_PROMPT + oneSentence）；个人版的开关状态 2 小时自动失效
│  ├─ tone.js                # 口播语气档：清晨 / 上班 / 午休 / 白天 / 傍晚 / 夜晚 / 深夜 / 驾驶，钟点分界 TONE_*；每档的写法、导演提示、放行哪些标记；数据目录 user/tone-extension.md 可按档追加本地要求（设置里有开关）
│  ├─ persona.js             # DJ 人格 Vera：核心 prompts/vera.md 两版共用；个人版可追加数据目录 user/persona.md（不进仓库）；按时段切老友 / 守夜人 / 策展人，睡前最后一段用结束语
│  ├─ chat-mode.js          # 聊天模式（两版共用）：要不要马上换歌、最近几轮对话、聊天规则（放提示词末尾）
│  ├─ talk.js                # 口播频率：话多 / 适中 / 安静 / 几乎不说；听懂「少说点」「今天别打扰我」；按开头 / 道别 / 换主题 / 整点 / 换时段定这一段说不说。当面说话的回复永远开口
│  ├─ audio-quality.js       # 实际音质 {format, bitrate, sampleRate, bits}：网易云 song_url 的 type/br/sr，FLAC 读 64 字节文件头补位深；拿不到的不带
│  ├─ version.js             # /api/mode 的 version：git 短号 → 部署前写的 server/version.json → package 版本 + 构建时间
│  ├─ filler.js              # 大脑或语音没好时的垫场歌（收藏 + 最近放过；点了曲风先挑网易云曲风对得上的）
│  ├─ audio-cache.js         # 本地音频缓存 cache/audio（LRU 400 MB，/media/:id）
│  ├─ style-request.js       # 明确要求的曲风，备选也必须符合
│  ├─ config.js              # 读 .env / 默认值
│  ├─ router.js              # 输入归一化（空=自动开一期 / 非空=交 claude 判断）
│  ├─ context.js             # 多片拼 system prompt：按变化快慢排序、样本按小时固定，好命中模型服务的前缀缓存；点歌不给候选池（大脑会照抄）
│  ├─ claude.js              # spawn claude -p；normalizeResult 解析 {say,play[],reason,memory}
│  ├─ llm/                   # 按设置分发（local / claude / deepseek）；normalize.js 解析模型 JSON
│  ├─ audio-route.js         # 设备菜单。已接上的音箱只送 Claudio；未接上的走控制中心
│  ├─ exclusive-play.js      # 绑定某一路 CoreAudio，不改系统默认输出
│  ├─ rooms.js               # 房间别名，以及「放到客厅」
│  ├─ bans.js                # 可撤销的禁播清单
│  ├─ song-meta.js           # 年份和曲风；接口没有就不编
│  ├─ voice.js               # 短语音转写后走现有暂停 / 换歌 / 点歌
│  ├─ ncm.js                 # 网易云：search → song_url → lyric；拿不到时问音源插件；guest* 给公用版未绑定账号的人取歌（只搜、只取链接）
│  ├─ sources.js             # 音源插件层：按目录加载插件（SOURCE_PLUGIN_DIR，默认数据目录下 plugins/）、每源单独排队、认歌、核对整曲和音质
│  ├─ ncm-shared.js          # 同一台机器上几个实例共用网易云搜索名额：主实例开 127.0.0.1:8099 名额服务，别的实例来要
│  ├─ tts/
│  │  ├─ index.js            # synthesize() 工厂 + 缓存（可插拔）
│  │  ├─ live.js             # 口播边合成边推给前端（/api/tts/stream），念完落盘缓存
│  │  ├─ pc5090.js           # 自建 Drama 3（默认）：隧道 + gpuctl 拉起；网关能流式就整段边合成边念，否则首句先合成
│  │  ├─ tags.js             # Drama 3 演出标记：白名单清洗、成对标记不跨句、去标记（页面 / 记录 / 不认标记的语音）
│  │  ├─ fish.js             # Fish Audio 云端（手动备用）
│  │  ├─ abort.js            # 合成可取消（换歌 / 作废节目时停掉在途请求）
│  │  └─ say.js              # macOS say 手工开发选项（不参与自动兜底）
│  ├─ friends-link.js        # 好友互荐（个人版这头）：经同一台机器上的内部口（FRIENDS_URL）找公用版要朋友推荐的歌、做成单独一期；推荐出去 / 好听 / 已播也走这里。不设 FRIENDS_URL 就关
│  ├─ handoff.js             # 多设备接力：当前歌 / 进度 / 后面几首 / 哪台在响，存 cache/playback.json；一台开始响就推 WS handoff
│  ├─ scene.js               # 此刻场景：工作日 / 周末 + 时段 → 工作模式 / 午休 / 周末…；听众说「我在上班」记进 cache/scene.json，当天或 2 小时内有效（午休 12:00–13:30 自动放开，午休时再说才算）；不用定位
│  ├─ weather.js             # wttr.in 天气（注入选歌 prompt）
│  ├─ memory.js              # 长期记忆 append → user/memory.md（迁移到笔记本后只当回滚备份，不再注入）
│  ├─ notebook.js            # 「Vera 的笔记本」：人 / 习惯 / 歌 / 事 四栏结构化记忆，来源 / 时间 / 敏感级；挑可提往事、校验口播引用、真删除（连备份一起清）
│  ├─ familiarity.js         # 隐性关系进度：第一次听 / 熟客 / 老友 / 只对你，只升不降，界面不出现数字；注入的只是「怎么说话」
│  ├─ scheduler.js           # 节律调度（默认关；.env SCHEDULER_ENABLED=1 才开）
│  ├─ state.js               # messages / plays / favs 持久化（cache/state.json）
│  └─ public/                # 公用版（CLAUDIO_MODE=public，单独容器）：设备核验走 hub（docs/hub-api.md）、每人加密存网易云 cookie 和临时记忆
│                            #   好友互荐：friends.js（好友码、推荐、上限、屏蔽、过期，一份加密文件 friends.enc）、friends-routes.js（/api/friends/* 和个人版用的只听本机的内部口 /owner/*）
├─ user/                     # 让 Claudio 属于你的几个文件
│  ├─ taste.md               # 听歌口味 ✅ 注入 prompt
│  ├─ favorites.md           # 喜欢的歌曲库（gen-favorites 生成）✅ 注入
│  ├─ memory.md              # 旧长期记忆（DJ 自动沉淀、可手改）；迁到 notebook.json 后不再注入，只留作回滚
│  ├─ notebook.json          # Vera 的笔记本（四栏记忆）；存在即接管记忆源，提示词只读它
│  ├─ routines.md            # 作息节律 ✅ 注入（结合此刻在一天中的位置挑歌）
│  ├─ mood-rules.md          # 情绪规则 ✅ 注入（按状态 / 天气 / 时段调整）
│  └─ playlists.json         # 歌单 ✅ 注入（填真实歌单即生效，占位示例自动过滤）
├─ prompts/
│  ├─ vera.md                # DJ 人格 Vera 的核心（两版共用，不含任何听众的个人信息）
│  ├─ public-dj.md           # 公用版的规矩和输出契约
│  └─ dj-persona.md          # 个人版输出契约的说明（实际提示词在 server/context.js）
├─ scripts/
│  ├─ spike-tts.mjs          # TTS 冒烟测试
│  ├─ gen-favorites.mjs      # 歌单 → user/favorites.md 曲库
│  ├─ stamp-version.mjs      # 部署前跑：写 server/version.json（git 短号 + 时间，不进仓库），盒子上没有 .git，页面靠它显示版本
│  └─ ncm-login.mjs          # 网易云扫码登录拿 cookie
├─ bin/
│  └─ claudio-house.mjs      # 无窗口常驻：只起网易云和服务（开机自启自己配）
├─ packaging/                # 容器里起网易云服务的入口（start-ncm.cjs / ncm-modules.cjs）+ 空白用户模板 default-user/（不含私人数据）
├─ cache/                    # 合成的语音 tts/、音频缓存 audio/、日志（不入库）
└─ web/                     # 个人版和公用版同一份网页；差异由服务端 GET /api/mode 下发（模式 + 能力开关）
   ├─ index.html             # 单页播放器（两版共用；带 data-cap 的控件默认藏着，能力开着才露出来）
   ├─ boot.js                # 先问 /api/mode：露出控件、个人版才拉 Google 字体、加载对应播放引擎
   ├─ ui.js                  # 两版共用的界面部件：封面 / 背景、对话条、沉浸歌词
   ├─ app.js                 # 个人版播放引擎：两路音乐 + 口播、领取 / 开声、垫场、暂停闸门、WS
   ├─ public.js              # 公用版播放引擎：单个 <audio> 顺序放、门口 / 绑定 / 配额 / 最近听过（apply.html / apply.js 是申请页）
   ├─ transitions.js         # 音量包络（按绝对时间）、等功率曲线、按曲风定交叉淡入时长、等音频可播
   ├─ lyrics.js              # 歌词解析和平滑滚动（rAF，提前 0.25 秒）
   ├─ subtitle.js            # 口播字幕按语音时长逐字出
   ├─ handoff.js             # 本机设备号（localStorage）和设备名（Mac Chrome / iPhone Safari…）
   ├─ voice-stream.js        # 口播边收边播：/api/tts/stream 用 MediaSource（iPhone 用 ManagedMediaSource）喂块，打不开就直接放
   ├─ drive.js               # 驾驶模式（两版共用，只管界面）：大键转给原按钮、说话（个人版走「说话」，公用版浏览器听写→键盘听写）、Wake Lock、记住开关
   ├─ friends.js / friends.css # 好友互荐（两版共用）：好友面板（好友码、好友、收到的 / 发出的、昵称、接收开关）、推荐给谁、「来自 XX」；引擎换歌时发 claudio:now
   ├─ notebook.html/.js/.css # 「Vera 的笔记本」页面（两版共用，/notebook）：四栏卡片，能看、能改、能删、能标别再提；她引用的那条点开看原话
   ├─ window-mode.js         # 沉浸歌词（顶栏按钮 / F 进，Esc / 轻点空白退）：能网页全屏就全屏，iPhone Safari 等不给就页面内铺满；闲置隐藏控件
   └─ styles.css
```

---

## 模型返回契约（关键约定）

字段顺序和含义以 `prompts/dj-persona.md` 为准，解析在 `server/llm/normalize.js`：

`say`、`intent`（chat / recommend / control）、`action`、`actionValue`、`play`、`reason`、`memoryCandidates`、`memoryRef`。

`memoryRef` 是这一期口播引用了「可提往事」里的哪一条（`n_xxxx`）；必须是当次给过她的候选、没标「别再提」、不是敏感条目，而且那条挂的歌真的在 `play` 里，否则一律丢掉（`notebook.validateMemoryRef`）。

- `say`：40–80 字，要有内容（为什么此刻放、有把握的背景、偶尔聊一句），不引歌词、不编背景。可带 Drama 3 演出标记（白名单见 `server/tts/tags.js`，按语气档放行）；`normalize.js` 出两份：`say` 去标记（页面、记录、校正都用它），`sayTagged` 原样，节目上的 `sayTts` = 时段语气提示 + 清洗后的标记，只给语音。
- `play` 为 `[]` = 不换歌。推荐才给候选：默认 3 个，点了曲风 / 乐器 / 情绪给 5 个，只放前两首；聊天和控制不给歌。
- 点了曲风时，模型选的歌要有网易云曲风证据（钢琴 → 纯音乐 / 轻音乐 / 新世纪 / 古典等）才放；一首都没有时才对「最近听过」放宽一次。
- 暂停、换歌、音量等短句由 `server/intent.js` 直接执行，不打模型。
- 「放到某个房间」由 `server/rooms.js` 在打模型前拦截。
- 已删除的 `segue` 不要加回来。

---

## 开发规范

- **最小必要改动**，保持现有风格；模块单一职责。
- 音乐源、TTS 一律做成**可插拔**（面向全功能：以后加 QQ 音乐 / 本地文件 / 其他 TTS）。
- 不提交 `.env`、`cache/`、`node_modules/`。
- 敏感信息（Fish key、网易云 cookie）**只放 `.env`**，绝不写进代码 / 日志 / 提交记录。
- 进度写 `docs/progress.md`；本文件只放稳定总览。
- 新增第三方依赖要说明理由、作用、影响。
- 走分支 + PR，`npm test` 通过再合并；流程和截图要求见 `CONTRIBUTING.md`。

---

## 已知风险（动手前必读）

1. **网易云 song_url 硬约束**：很多歌要登录 cookie 才返回真实直链；VIP / 无版权歌即便登录也是 null。
   → 音源可用插件扩展（接口见 `server/sources.js` 文件头、`docs/上手指南.md`）：网易云拿不到时问插件。仓库里不放任何具体音源的接入代码。
   → 必须有 fallback（换一首 / 试听片段 / 跳转）。
   → 搜得太密会被限流（405「操作频繁」）：`ncm.js` 按接口冷却，诊断记 `rate-limited`，别当成版权。搜索要带登录 cookie（服务器上匿名搜索一律 405）；后台备节目、发现池、垫场的搜索排队：相隔至少 1.5 秒、任意 60 秒内连点歌一起不超过 6 个（`NCM_SEARCH_GAP_MS` / `NCM_SEARCH_PER_MIN`；实测连着约 10 个就 405），点歌不排队。同一出口的几个实例合用这 6 个（`ncm-shared.js`：主实例 `NCM_SHARED_SERVE=127.0.0.1:8099`，别的实例 `NCM_SHARED_URL`；主实例优先、405 冷却互通）。`claudio.log` 每分钟一行 `[ncm-rate]` 记接口 × 来源 × 结果。测试别反复重装 / 重放，每次启动都是一串请求。
2. **浏览器 autoplay**：首次必须用户手势触发，之后才能自动连播。
3. **大脑延迟**：一期生成几秒到一两分钟（本地模型超时 150 秒，失败退避重试）→ 后台预备两期；都没备好时先放垫场歌（收藏 + 最近放过），不冷场。慢几乎都慢在预填充：命中前缀缓存时首字约 1 秒；没命中的部分有时只有约 40 字/秒。所以提示词里不变的放前、常变的放后，改顺序前先想缓存。
4. **Fish 计费**：按字符，口播稿控制长度。
5. **版权**：网易云抓直链播放属灰色地带。个人版仅供自用。公用版仅邀请制、需运营者审批；绑定了的人用自己的网易云账号放歌；未绑定账号时，使用运营者配置的默认音源（`PUBLIC_BORROW_OWNER=0` 关掉）；都放不了时问音源插件（有的话）。版权与平台协议风险由部署的运营者承担，出问题要能一键停用。
6. **本地推理依赖自己的机器**：大脑选本地服务时，服务或内网不通会明确报错，不会自动切到云端。语音默认走自建 GPU 机：WSL 节点在外只能走中继（几 KB/s、时断），所以经 Windows 节点开隧道、经跳板调 gpuctl（主机名在 `.env`）；GPU 被别的任务登记占用时明确报错，不抢卡。2026-11-01 起语音档开了 `--compile`：合成比实时快（RTF 约 0.64），3 句口播约 3 秒开口；代价是冷启动约 2 分钟、编译缓存被清后约 3 分钟，Claudio 拉起和首包都等到 240 秒。
7. **音箱**：不接 RAAT，也不装 pyatv。已经出现在本机输出列表里的 AirPlay 只送 Claudio（`exclusive-play.js`，不改系统默认输出）。还没接上的音箱走控制中心，会把整台 Mac 的声音一起带过去。禁播可单条撤销；自动推荐只看禁播清单。说话按钮只转写，再走现有播放指令。单独出声时一次只能放一路：没有交叉淡入，口播和歌先后放。单独出声还没在真音箱上试过。这些只在服务跑在 Mac 上时可用；Linux 服务器上设备菜单关着。
8. **语音不在只放歌**：5090 离线、被占或合成失败时这期跳过口播，不自动换 Fish（维护者定）。后台每分钟探测一次并重连隧道，5090 回来后 DJ 自己恢复；探测不调 gpuctl、不 `--force`。gpuctl 拒绝后冷却：被占 10 分钟、连不上 45 秒，期间口播直接跳过（点歌的回复当场带「口播跳过」，网页立刻起歌），不再每段干等约 60 秒；设置页「试听」可绕过一次。

---

## 常用命令

```bash
npm install
npm run ncm          # 起本地网易云 API 实例（外部服务，见 docs/references.md）
npm run dev          # 起 Claudio 服务（默认 :8080）
npm test             # 全部单测（node --test）
```

---

## HTTP / WS 契约

MVP 4 条 → 全功能 6 条：

| 方法 | 路径 | 说明 | 状态 |
|---|---|---|---|
| POST | `/api/chat` | 触发一期生成 / 用户输入（带 nowPlaying）。`chatMode:true` = 聊天模式：多轮对话 + 聊天规则；DJ 自己推的歌插成下一期，回话带 `queued`（公用版回 `when`） | ✅ |
| GET | `/api/now` | 当前在放什么 | ✅ |
| GET | `/api/next?claimId=` | 领取下一期（后台备好的节目）；没备好回 202，备好后 WS 推 `nextReady` | ✅ |
| POST | `/api/episode/started` | `{id, claimId}`：节目真正开声才算数，记播放和推荐 | ✅ |
| POST | `/api/episode/release` | `{claimId}`：领了没放（换心情、停止、过期）就退回 | ✅ |
| POST | `/api/sleep` | 睡眠定时到点：后台不再补备节目、停掉备节目的口播合成；下次领取自动恢复 | ✅ |
| POST | `/api/drive` | `{on}`：网页开 / 关驾驶模式（开着每 20 分钟再报一次，2 小时没报自动失效）。打开时已备好的节目不作废，只把口播改成一句、重新合成（WS `sayRevised`），之后新备的口播只说一句。公用版不走这个，点歌带 `drive:true` | ✅ |
| GET | `/api/episode/:id/voice` | 这期口播的状态：ready / pending / skipped | ✅ |
| GET | `/api/filler?exclude=` | 垫场歌一首（收藏 + 最近放过，优先已缓存的） | ✅ |
| GET | `/api/lyric?id=` | 歌词补取（WS 推丢或点歌后现取时，前端按需来要） | ✅ |
| GET | `/media/:id` | 本地音频缓存里的歌（LRU 400 MB） | ✅ |
| WS | `/stream` | `hello`（epoch / buffered）· `nextReady` · `voiceReady` · `episodesInvalidated`（换口味后旧节目作废）· `sayRevised`（开驾驶模式后备好的下一段口播改短了）· `scheduled`（定时节目，已替前端领取，带 `claimId`）· `sayDraft`（口播稿写完先出文字）· `sayReady` / `sayFailed` · `lyrics` · `ttsLane`（5090 语音档 starting / busy / ready / offline / error）· `handoff`（某台设备开始响，其他设备暂停） | ✅ |
| GET | `/proxy` | 网易云直链同源代理（真频谱 + seek；白名单防 SSRF） | ✅ |
| POST | `/api/fav` | 收藏当前歌（落库进品味）；`remove:true` 取消收藏 | ✅ |
| GET | `/api/favorites` | 当前本机口味曲库数量 | ✅ |
| POST | `/api/favorites/import` | 网易云歌单链接 / ID 合并导入口味曲库 | ✅ |
| GET | `/api/memory` | 读旧长期记忆（迁移后基本只作回滚） | ✅ |
| GET | `/api/notebook` | 笔记本：四栏记忆 + 关系的一个说法（不给数字） | ✅ |
| POST | `/api/notebook` | 记一条（人 / 习惯 / 歌 / 事） | ✅ |
| PATCH | `/api/notebook/:id` | 改一条 / 标「别再提」/ 恢复 | ✅ |
| DELETE | `/api/notebook/:id` | 删一条（真删，备份同步清） | ✅ |
| GET | `/api/weather` | 当前天气 | ✅ |
| GET | `/api/fish-credit` | Fish 余额（key 只在后端） | ✅ |
| POST | `/api/settings/test-pc5090-tts` | 5090 语音试听（设置页「试听」），冷启动要等约 2 分钟 | ✅ |
| GET | `/api/mode` | 网页先问这个：`{mode:'personal', features, chat:{bed, idleMs}, version}`，决定露出哪些控件、加载哪个播放引擎（公用版回 `public`）；`version` 在设置 / 账号面板角落显示 | ✅ |
| GET | `/api/status` | 健康检查 + 节目缓冲（`buffered` / `epoch` / `generating`）。`tts.model` 在 5090 时是音色名，在 Fish 时是模型名 | ✅ |
| GET | `/api/outputs` | 播放设备菜单 | ✅ |
| POST | `/api/outputs` | 切换播放设备 | ✅ |
| POST | `/api/outputs/alias` | 给设备起房间名；空名字表示恢复原名 | ✅ |
| POST | `/api/outputs/bluetooth-settings` | 打开系统蓝牙设置（设备菜单「蓝牙…」） | ✅ |
| GET | `/api/bans` | 禁播清单 | ✅ |
| POST | `/api/bans/remove` | 撤销一条禁播。不要用 DELETE 带 body | ✅ |
| POST | `/api/voice` | 短语音转写，文字再走 `/api/chat`。先走常驻的短句识别（`ASR_FAST_URL`），不通退回转写网关（`ASR_BASE_URL`）。录音不进日志 | ✅ |
| POST | `/api/exclusive/play` | 把一首或一段口播单独送到已接上的输出 | ✅ |
| POST | `/api/remote/play` | 家里语音助手点歌。只收本机和 `REMOTE_ALLOW` 里的地址。`where` 指定房间时送到对应音箱，开发板只返回直链 | ✅ |
| POST | `/api/remote/control` | 同上来源。`pause` / `resume` / `next` / `previous` / `stop` / `volume_set` | ✅ |
| GET | `/api/playback` | 多设备接力：服务端记的当前歌、进度（在响时按时间往前推）、后面几首、哪台在响；直链先刷新 | ✅ |
| POST | `/api/playback` | `{deviceId, deviceName, playing, song, position, queue}`：设备上报；开始响时 WS 推 `handoff`，别的设备自己停 | ✅ |
| GET | `/api/friends` | 好友互荐：自己的好友、收到的、发出的（发出的不给看被跳过）、今天还能推几首。个人版转给公用版内部口（`FRIENDS_URL`），没配回 404 | ✅ |
| POST | `/api/friends/:action` | `code` 生成好友码（15 分钟、用一次）· `add {code}` · `remove / block / unblock {id}` · `profile {nick, accept}` · `recommend {to, song, note}`（附言 ≤30 字，本地规则不过整条不发）· `like {rec}` | ✅ |
| GET | `/api/taste` | 读用户口味档案 | 未实现 |
| GET | `/api/plan/today` | 今日节目编排 | 未实现 |

### 同一台机器上的网易云共享名额（`server/ncm-shared.js`）

同一台机器上的 `claudio`（个人版）和 `claudio-public`（公用版）走同一个出口 IP，网易云按搜索总数限流，所以搜索名额合在一起算。主实例管名额，别的实例来要。只听本机，不经 8090（8090 经反向代理对内网开着）。

| 方 | 环境变量 | 说明 |
|---|---|---|
| 主实例 | `NCM_SHARED_SERVE=127.0.0.1:8099` | 开名额服务；自己的搜索照旧走本进程队列（每分钟 `NCM_SEARCH_PER_MIN`=6，间隔 1.5 秒，点歌直接发） |
| 别的实例 | `NCM_SHARED_URL=http://127.0.0.1:8099` | 每次搜索前来要名额；不要设 `NCM_SHARED_SERVE` |

| 方法 | 路径 | 请求 | 回复 |
|---|---|---|---|
| POST | `/slot` | `{"kind":"chat"\|"background"}` | `{"ok":true}` 放行；`{"ok":false,"retryMs":N}` 过 N 毫秒再要；`{"ok":false,"coolingMs":N}` 网易云冷却中，这段时间别搜 |
| POST | `/cooldown` | `{"ms":N}` | `{"ok":true}`。别的实例碰到 405 报过来，主实例跟着冷却 N 毫秒（最长 30 分钟） |
| POST | `/tts` | `{"text":"纯文字 ≤100 字"}`（可带语气提示和演出标记，整串 ≤400） | 主实例语音是 pc5090、通道 ready、没在合成 / 排队 / 拉起 / 探测、隧道开着时，低优先级念一句（超时 20 秒），回 `audio/mpeg`；否则 409 `{"skip":true}`。不开隧道、不调 gpuctl。主实例要念时直接停掉这一句（主实例优先） |
| POST | `/guest/search` | `{"keywords","limit"}` | 公用版未绑定账号时搜歌：按别的实例算名额（主实例优先，最多 6 − reserve），等不到 503 `{"busy":true}` |
| POST | `/guest/song-url` | `{"id","level","title?","artist?","duration?"}` | 公用版未绑定账号时取播放地址；放不了且给了歌名就问音源插件。每分钟最多 40 次 |
| POST | `/guest/find` | `{"ncmId?","title","artist","duration?","level"}` | 只问音源插件（绑定的人自己放不了时用） |
| POST | `/guest/lyric` | `{"id"}` | 插件歌曲的歌词 |

`/guest/*` 只回歌的信息和播放地址，只搜歌、取地址，不碰播放记录、收藏、记忆、音频缓存。公用版设 `PUBLIC_BORROW_OWNER=0` 关掉。

规则：两边合起来任意 60 秒不超过 6 个、任意两次隔 1.5 秒；主实例有搜索在排队时不给别人；别的实例（点歌也算）最多用到 6 − `NCM_SHARED_RESERVE`（默认 2）= 4 个。非本机来源、非 POST 回 403。名额服务不通（主实例重启）时别的实例按自己的上限搜。
