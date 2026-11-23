# 公用版的 hub 接口契约

公用版（`CLAUDIO_MODE=public`）自己不管「谁能进」：申请、审批、邀请链接、设备、配对码、每日次数都交给一个外部服务 **hub**。这个仓库**不含 hub**，要部署公用版需要自备一个实现了下面接口的服务。只是想参与开发、在本机跑播放界面的话，用个人版模式就行，不需要 hub。

调用方代码在 `server/public/hub-client.js`，接口有出入时以它为准。

## 约定

- 基址：`PUBLIC_HUB_BASE`（如 `http://127.0.0.1:9000`），路径都在 `/claudio/v1/` 下。
- 鉴权：每个请求带 `Authorization: Bearer <PUBLIC_HUB_KEY>`。这把服务 key 只该有调这组接口的权限。
- 请求和返回都是 JSON；超时 8 秒。
- 出错：返回非 2xx，body 为 `{"error": {"type": "<原因>", "message": "<说明>"}}`。公用版把 `type` 映射成给用户看的话（`server/public/app.js` 的 `REASONS`）：

| type | 含义 |
|---|---|
| `invalid` | 链接或配对码不对 |
| `link_used` / `link_expired` | 邀请链接已用过 / 过期 |
| `device_limit` | 设备数已满 |
| `disabled` / `expired` | 账号停用 / 到期 |
| `quota` | 今天的次数用完 |
| `rate_limit` | 申请太频繁 |

- 设备核验返回 403 时，公用版会清掉这台设备的 cookie，让用户重新加入；hub 连不上一律按「不让进」处理。

## 成员对象

`verify`、`link/redeem`、`pair/redeem` 返回里的 `member`：

```json
{
  "id": "mem_00000001",
  "name": "显示名",
  "remaining": 37,
  "daily_total": 50,
  "devices": 2,
  "max_devices": 3,
  "expires": "2026-12-31T23:59:59Z"
}
```

## 接口

| 方法 | 路径 | 请求 | 成功返回 | 用途 |
|---|---|---|---|---|
| POST | `/claudio/v1/apply` | `{name, note, wechat, ip}` | `{id}` | 申请页提交，等管理员审批 |
| POST | `/claudio/v1/link/redeem` | `{token, label}` | `{device_token, member}` | 用一次性邀请链接加入；`label` 是设备名（如 iPhone Safari） |
| POST | `/claudio/v1/pair/create` | `{device_token}` | `{code, expires}` | 已登录设备生成 6 位配对码，给新设备用 |
| POST | `/claudio/v1/pair/redeem` | `{code, label}` | `{device_token, member}` | 新设备用配对码加入 |
| POST | `/claudio/v1/device/verify` | `{device_token}` | `{device_id, member}` | 每个需要登录的请求都核一次（公用版只缓存 5 秒） |
| POST | `/claudio/v1/device/logout` | `{device_token}` | 任意 2xx | 设备退出 |
| POST | `/claudio/v1/consume` | `{member_id, kind}` | `{remaining}` | 扣一次额度；`kind` 为 `chat`（点歌 / 聊天）或 `song`（自动续播） |
| GET | `/claudio/v1/states` | — | `{members: [{id, status}, …]}` | 定时对账：不是 `active` 的成员，公用版删掉其本地数据 |
| POST | `/claudio/v1/report` | `{items: {<member_id>: {bound: true\|false}}}` | 任意 2xx | 公用版报告谁绑定了网易云，供管理后台展示 |

`device_token` 由 hub 生成，公用版只存进浏览器的 httpOnly cookie，自己不保存。
