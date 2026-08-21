# Claudio 🎙️

个人 AI 电台 — ChatGPT 当 DJ 大脑，读懂你的听歌习惯 → 挖掘小众音乐 → 像 DJ 那样播报。

> 当前为 **MVP（核心闭环）**，目标是复刻全功能原版。详见 [`AGENTS.md`](./AGENTS.md)。

## 它能做什么

直接打开 `Claudio.app`，点 ▶。ChatGPT 读你的口味，写一段 DJ 口播，优先挑你没听过的同风格小众歌，
TTS 把口播念出来，播放器一边放歌一边滚字幕、压背景音让 DJ 说话 —— 像一个只属于你的电台。
App 会自己启动内置音乐服务和后端，关窗后所有子进程一起退出；顶栏 ▽ 缩成迷你窗。

## 快速开始

```bash
# 从源码构建并安装到 /Applications（开发者）
npm install
npm run test:all
npm run app:install

# 安装后无需终端，直接打开
open /Applications/Claudio.app
```

> 右上角 ⚙ 可切 ChatGPT / Grok / Claude / DeepSeek、Luna / Terra / Sol 和推荐探索度，也可粘贴网易云歌单链接建立自己的口味曲库。Grok 订阅可在设置里弹出浏览器验证；模型和 Fish 密钥只保存在当前电脑。

## 隐私

- `.env`、API Key、网易云 Cookie、`user/`、`cache/`、`runtime/` 和桌面构建产物均被 Git 忽略。
- App 的个人歌单、记忆和设置保存在当前用户的 `~/Library/Application Support/com.claudio.fm`，不进入源码仓库。
- 仓库中的 `packaging/default-user/` 只有空白模板，不包含任何真实用户数据。

## 使用提醒

- 音乐直链来自第三方网易云 API，仅建议个人学习和自用；请自行遵守所在地法律、平台条款和音乐版权规则。
- 首次构建需要 macOS、Node.js 20+、Rust 与 Tauri CLI。ChatGPT/Claude 订阅通道还需要本机已有对应客户端或 CLI 登录；Grok 订阅可在设置里直接弹出浏览器验证。

## 文档

- [`AGENTS.md`](./AGENTS.md) — 项目总文档（架构 / 技术栈 / 规范 / 契约）
- [`docs/architecture.md`](./docs/architecture.md) — 四层架构详解
- [`docs/progress.md`](./docs/progress.md) — 开发进度
- [`docs/references.md`](./docs/references.md) — 参考资料与依赖

## 状态

🚧 开发中（MVP）。不公开部署 / 分发（音乐源版权属灰色地带，仅个人自用）。

## License

[MIT](./LICENSE)
