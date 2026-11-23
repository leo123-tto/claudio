# Security Policy

## 报告问题

请不要在公开 Issue 中粘贴 API Key、Cookie、用户歌单、日志或其他私人信息。安全问题可通过 GitHub Security Advisory 私下报告。

## 本地敏感数据

Claudio 的密钥和个人数据只应保存在本机：`.env`、被 Git 忽略的 `user/` / `cache/`（设置、`secrets.json`、日志）；容器部署时在 `CLAUDIO_DATA_DIR` 指的数据目录里。自己机器的地址、主机名也写 `.env`，不写进代码。

提交前检查 `git status` 和 `git diff --cached`。密钥一旦推上公开仓库，先到对应平台吊销重发，再处理提交记录。
