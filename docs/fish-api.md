# Fish Audio API 参考

> 项目 TTS 用 Fish Audio。本文件记录用到的关键端点，便于查阅。
> 密钥放 `.env` 的 `FISH_API_KEY`，**绝不写进代码 / 日志 / 提交**。

## TTS 合成
`POST https://api.fish.audio/v1/tts`
- Header：`Authorization: Bearer <FISH_API_KEY>`、`Content-Type: application/json`、`model: s1 | s2-pro`
- Body：`{ "text": "...", "reference_id": "<音色 id>", "format": "mp3" }`
- 实现：`server/tts/fish.js`

### 模型（`model` header 仅接受两个值）
| model | 说明 |
|---|---|
| `s1` | 上一代 |
| `s2-pro` | **当前在用**（官方文档推荐，价格与 s1 相同） |

## 钱包 / 余额
`GET https://api.fish.audio/wallet/{user_id}/api-credit`（`user_id` 用 `self`）
- Header：`Authorization: Bearer <FISH_API_KEY>`
- 可选 query：`check_free_credit`(bool)、`team_id`
- 返回：`{ _id, user_id, credit: "字符串余额", created_at, updated_at, has_phone_sha256, has_free_credit }`
- 项目封装：后端 `GET /api/fish-credit` → `{ ok, credit }`；`claudio` 启动时显示。

`GET https://api.fish.audio/wallet/{user_id}/package`（套餐余额，暂未用）
- 返回：`{ user_id, type, total, balance, ... }`（`total`/`balance` 为整数）

## 文档入口
- 索引：https://docs.fish.audio/llms.txt
- TTS：https://docs.fish.audio/api-reference/endpoint/openapi-v1/text-to-speech
- 模型与定价：https://docs.fish.audio/developer-guide/models-pricing/
