# Security Policy

## 报告问题

请不要在公开 Issue 中粘贴 API Key、Cookie、用户歌单、日志或其他私人信息。安全问题可通过 GitHub Security Advisory 私下报告。

## 本地敏感数据

Claudio 的密钥和个人数据只应保存在 `.env`、被忽略的 `user/` / `cache/`（含 Grok 订阅 token），或 macOS 的 `~/Library/Application Support/com.claudio.fm`。提交前请运行密钥扫描并检查 `git status`。
