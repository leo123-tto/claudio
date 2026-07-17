# Claudio — 个人 AI 电台

> Codex 当 DJ 大脑：读懂你的听歌习惯 → 规划声音 → 像 DJ 那样播报。

本文件是项目**总文档**，给所有在这个仓库里工作的 AI / 人看。它只放**稳定的总览**，不记流水账。

- 📈 开发进度：`docs/progress.md`（**进度只写这里，不要写进本文件**）
- 🏛 架构细节：`docs/architecture.md`
- 🔖 参考资料：`docs/references.md`（原版项目 + 开源复刻 + 依赖）

---

## 当前阶段

**MVP（核心闭环）** → 终极目标是**复刻 mmguo 原版 Claudio 的全功能**。

框架按"全功能复刻"来搭（音乐源、TTS、调度都预留扩展点），实现先打通最小闭环：

> 网页放歌 + Codex 写口播 + TTS 念出来 + 自动连播。

---

## 它是什么

让 Codex 当电台 DJ 的大脑。它读你的口味文件，决定放哪几首歌 + 写一段 DJ 口播稿，
TTS 把稿子合成人声，网页播放器一边放歌一边念词，并能按时间节律自动开节目（早间 / 情绪）。

**一期节目的数据流：**

```
你在网页点 [开始 / 换一首 / 换心情]
   → context.js  把 dj-persona + taste.md + 历史 拼成 prompt
   → Codex.js   spawn `Codex -p --output-format json`
   → Codex 返回 {say, play[], reason, memory}
   → ncm.js  把歌名解析成可播直链   ┐
   → tts.js  把 say 合成 mp3        ┘ 并行
   → 前端队列：念口播 → 放歌 → 念下一段 → ...
```

---

## 四层架构（忠于原版，详见 docs/architecture.md）

1. **外部上下文** — 用户语料 `user/*.md` · Codex（大脑）· 网易云（音乐）· 声音 I/O（TTS / 天气 / 音响；日历已取消）
2. **本地大脑** — `router` 意图分流 · `context` 提示词组装 · `Codex` 适配器 · `scheduler` 节律 · `tts` 声音管线 · `state` 记忆
3. **运行时聚合** — 每次触发把 6 片粘成 prompt → 模型前向 → `{say, play[], reason, memory}` → ncm 解析队列 + tts 合成 + WS 推 now-playing
4. **交互表层** — PWA 播放器 + HTTP / WS 契约

---

## 技术栈

| 层 | 选型 | 说明 |
|---|---|---|
| 大脑 | Codex app-server（默认 `gpt-5.6-luna`） | ChatGPT 订阅免 API key；常驻连接、low + priority；设置页可切 Terra/Sol、Claude、DeepSeek |
| 音乐 | NeteaseCloudMusicApiEnhanced（本地实例，外部服务） | search / song_url / lyric / recommend |
| TTS | Fish Audio 流式（默认 fish · s1） | 边生成边播放并缓存；失败明确提示，**不自动回退 macOS `say`**；say 仅保留手工开发选项 |
| 后端 | Node.js (ESM) + Express + ws | node ≥ 20 |
| 前端 | PWA（原生 JS，双音轨 `<audio>` 交叉淡入 + WebAudio `GainNode` 控音量/频谱 + WS） | 不引重框架 |

---

## 目录结构

```
claudio/
├─ AGENTS.md                 # 本文件 · 项目总文档
├─ README.md                 # quickstart
├─ package.json
├─ .env.example              # 配置样例（真实 .env 不入库）
├─ .gitignore
├─ docs/
│  ├─ references.md          # 参考资料：原版 + 复刻 + 依赖
│  ├─ progress.md            # 开发进度（实时更新）
│  └─ architecture.md        # 四层架构详解
├─ server/
│  ├─ index.js               # Express + WS 入口（:8080）· finalizeEpisode 组队列 · /proxy 音频代理
│  ├─ config.js              # 读 .env / 默认值
│  ├─ router.js              # 输入归一化（空=自动开一期 / 非空=交 Codex 判断）
│  ├─ context.js             # 多片拼 system prompt（含选歌多样性「起手种子」）
│  ├─ Codex.js              # spawn Codex -p；normalizeResult 解析 {say,play[],reason,memory}
│  ├─ ncm.js                 # 网易云：search → song_url → lyric
│  ├─ tts/
│  │  ├─ index.js            # synthesize() 工厂 + 缓存（可插拔）
│  │  ├─ say.js              # macOS say 手工开发选项（不参与自动兜底）
│  │  └─ fish.js             # Fish Audio 实现（当前默认 TTS_PROVIDER=fish · FISH_MODEL=s1 求低延迟）
│  ├─ weather.js             # wttr.in 天气（注入选歌 prompt）
│  ├─ memory.js              # 长期记忆 append → user/memory.md
│  ├─ scheduler.js           # 节律调度（默认关；.env SCHEDULER_ENABLED=1 才开）
│  └─ state.js               # messages / plays / favs 持久化（cache/state.json）
├─ user/                     # 让 Claudio 属于你的几个文件
│  ├─ taste.md               # 听歌口味 ✅ 注入 prompt
│  ├─ favorites.md           # 喜欢的歌曲库（gen-favorites 生成）✅ 注入
│  ├─ memory.md              # 长期记忆（DJ 自动沉淀、可手改）✅ 注入
│  ├─ routines.md            # 作息节律 ✅ 注入（结合此刻在一天中的位置挑歌）
│  ├─ mood-rules.md          # 情绪规则 ✅ 注入（按状态 / 天气 / 时段调整）
│  └─ playlists.json         # 歌单 ✅ 注入（填真实歌单即生效，占位示例自动过滤）
├─ prompts/
│  └─ dj-persona.md          # DJ 人设系统提示词
├─ scripts/
│  ├─ spike-Codex.mjs       # 验证 Codex -p 信封 + 延迟
│  ├─ spike-ncm.mjs          # 验证 search→song_url 能否拿到可播 URL
│  ├─ spike-tts.mjs          # TTS 冒烟测试
│  ├─ gen-favorites.mjs      # 歌单 → user/favorites.md 曲库
│  └─ ncm-login.mjs          # 网易云扫码登录拿 cookie
├─ bin/
│  └─ claudio.mjs            # CLI 启动器（起服务 + 开前端窗口）/ `claudio stop` 总开关
├─ src-tauri/                # Tauri 主 App（自启动/关闭内置 Node + 网易云服务；target/gen 不入库）
├─ packaging/                # 可分享 App 的空白用户模板与网易云启动入口（不含私人数据）
├─ cache/tts/                # 合成的语音（不入库）
└─ web/
   ├─ index.html             # 单页播放器
   ├─ app.js                 # 双音轨 <audio> 交叉淡入 + WebAudio(GainNode 控音量/频谱) + 播放队列 + ducking + WS + 字幕 + mini（唯一播放层）
   └─ styles.css
```

---

## Codex 返回契约（关键约定）

每次生成一期节目，Codex 必须返回**严格 JSON**：

```json
{
  "say":    "DJ 口播稿（要念出来的话）",
  "play":   [{ "title": "歌名", "artist": "歌手" }],
  "reason": "为什么这样安排（调试用，不念出来）",
  "memory": "值得长期记住的一句第三人称事实（可选，没有就 null / 省略）"
}
```

- `play` 为空数组 `[]` = 只聊天、保持当前歌不换（前端据此判断「聊天 vs 换歌」）。
- 已砍 `action`（自然语言播放控制随后端播放引擎一并废弃；暂停/停止/换歌走界面按钮）；已删废弃的 `segue`（过渡口播，省 Fish 额度）。

解析在 `server/Codex.js`，必须**容错**（模型偶尔会包裹解释文字 → 提取第一个完整 JSON 对象）。
约束输出靠 `prompts/dj-persona.md` 里的强指令。

---

## 开发规范

- **最小必要改动**，保持现有风格；模块单一职责。
- 音乐源、TTS 一律做成**可插拔**（面向全功能：以后加 QQ 音乐 / 本地文件 / 其他 TTS）。
- 不提交 `.env`、`cache/`、`node_modules/`。
- 敏感信息（Fish key、网易云 cookie）**只放 `.env`**，绝不写进代码 / 日志 / 提交记录。
- 进度写 `docs/progress.md`；本文件只放稳定总览。
- 新增第三方依赖要说明理由、作用、影响。
- 未经用户明确确认，不执行 `git commit` / `git push` / 部署。

---

## 已知风险（动手前必读）

1. **网易云 song_url 硬约束**：很多歌要登录 cookie 才返回真实直链；VIP / 无版权歌即便登录也是 null。
   → 必须有 fallback（换一首 / 试听片段 / 跳转），`scripts/spike-ncm.mjs` 先证伪。
2. **浏览器 autoplay**：首次必须用户手势触发，之后才能自动连播。
3. **Codex -p 延迟**：一期生成几秒~十几秒 → 前端要 loading + 预合成下一段。
4. **Fish 计费**：按字符，口播稿控制长度。
5. **版权**：网易云抓直链播放属灰色地带，个人自用风险低，**不公开部署 / 分发**。

---

## 常用命令

```bash
npm install
npm run ncm          # 起本地网易云 API 实例（外部服务，见 docs/references.md）
npm run dev          # 起 Claudio 服务（默认 :8080）
npm run app:install  # 构建并安装 /Applications/Claudio.app；之后无需终端
npm run spike:Codex # 验证 Codex -p 信封与延迟
npm run spike:ncm    # 验证网易云能否拿到可播 URL
```

---

## HTTP / WS 契约

MVP 4 条 → 全功能 6 条：

| 方法 | 路径 | 说明 | 状态 |
|---|---|---|---|
| POST | `/api/chat` | 触发一期生成 / 用户输入（带 nowPlaying） | ✅ |
| GET | `/api/now` | 当前在放什么 | ✅ |
| GET | `/api/next` | 换一首 / 下一期 | ✅ |
| WS | `/stream` | now-playing / 字幕 / sayReady / 状态 | ✅ |
| GET | `/proxy` | 网易云直链同源代理（真频谱 + seek；白名单防 SSRF） | ✅ |
| POST | `/api/fav` | 收藏当前歌（落库进品味） | ✅ |
| GET | `/api/favorites` | 当前本机口味曲库数量 | ✅ |
| POST | `/api/favorites/import` | 网易云歌单链接/ID 合并导入口味曲库 | ✅ |
| GET | `/api/memory` | 读长期记忆 | ✅ |
| GET | `/api/weather` | 当前天气 | ✅ |
| GET | `/api/fish-credit` | Fish 余额（key 只在后端） | ✅ |
| GET | `/api/open` | 系统浏览器打开外链（Tauri 里 `window.open` 失效；白名单 `https://fish.audio/`） | ✅ |
| GET | `/api/status` | 健康检查 + 首期预热状态 | ✅ |
| GET | `/api/taste` | 读用户口味档案 | 未实现 |
| GET | `/api/plan/today` | 今日节目编排 | 未实现 |
