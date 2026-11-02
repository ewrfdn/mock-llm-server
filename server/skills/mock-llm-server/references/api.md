# Mock LLM Server API 参考

Base URL：`http://localhost:8787`（可用 `HOST` / `PORT` 修改）。

## 鉴权

```http
Authorization: Bearer mllm_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

也接受 `x-api-key: mllm_...`。`admin` scope 用于管理接口，`inference` scope 用于 `/v1`。

## 管理 API（`/api/v1`，需要 admin）

| Method | Path | 说明 |
| --- | --- | --- |
| GET | `/health` | 公开健康检查 |
| GET | `/auth/whoami` | 任意有效 Key，返回当前 Key 与 scope |
| GET | `/meta` | 可用性等级、默认值、限制、接口地址 |
| GET | `/system` | 版本、Redis、词表、缓存、数据库、活跃流 |
| GET | `/models` | 模型列表 |
| POST | `/models` | 创建模型 |
| GET | `/models/:id` | 模型详情 |
| PATCH | `/models/:id` | 局部更新模型 |
| DELETE | `/models/:id` | 删除模型 |
| GET | `/api-keys` | Key 列表（含 24h 用量） |
| POST | `/api-keys` | 创建 Key，明文 token 只返回一次 |
| PATCH | `/api-keys/:id` | 改名 / 启用停用 |
| POST | `/api-keys/:id/rotate` | 轮换 Key |
| DELETE | `/api-keys/:id` | 删除 Key |
| GET | `/requests?limit=&model=&key=&status=` | 请求历史 |
| GET | `/stats?window=24h&series=60` | 概览、分钟序列、按模型聚合、最近请求 |
| POST | `/cache/clear` | 清空模拟缓存 |
| GET | `/skill` | Skill 文本（公开） |
| GET | `/skill/download` | Skill ZIP（公开） |

创建模型请求体：

```json
{
  "id": "mock-fast",
  "display_name": "Mock Fast",
  "description": "demo",
  "qpm_limit": 0,
  "tpm_limit": 0,
  "output_tokens_min": 128,
  "output_tokens_max": 1024,
  "tps_min": 80,
  "tps_max": 140,
  "ttft_ms_min": 120,
  "ttft_ms_max": 350,
  "availability_level": 1,
  "failure_delay_ms": 0,
  "cache_hit_rate_min": 10,
  "cache_hit_rate_max": 35,
  "context_window": 128000,
  "enabled": true
}
```

## OpenAI 兼容 API（`/v1`，需要 inference）

### GET /v1/models

返回启用中的模型，额外带 `mock` 指标字段。

### POST /v1/chat/completions

请求字段：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `model` | string | 必填 |
| `messages` | array | 必填，支持 content 为字符串或 text part 数组 |
| `stream` | boolean | 默认 false |
| `max_tokens` / `max_completion_tokens` | number | 可选，裁剪本次输出 |
| `temperature` | number | 可选，进入缓存键 |
| `seed` | number | 可选，仅生成文本可复现；TTFT/TPS/可用性/缓存仍每请求随机 |
| `stream_options.include_usage` | boolean | 流式最后追加 usage 帧 |

非流式响应示例：

```json
{
  "id": "chatcmpl-...",
  "object": "chat.completion",
  "created": 1760000000,
  "model": "mock-fast",
  "choices": [
    {
      "index": 0,
      "message": {"role": "assistant", "content": "..."},
      "finish_reason": "stop",
      "logprobs": null
    }
  ],
  "usage": {
    "prompt_tokens": 12,
    "completion_tokens": 356,
    "total_tokens": 368,
    "prompt_tokens_details": {"cached_tokens": 0},
    "completion_tokens_details": {"reasoning_tokens": 0}
  },
  "mock": {
    "cache_hit": false,
    "ttft_ms": 241,
    "tps": 112.4,
    "availability_level": 1,
    "failure_delay_ms": 0,
    "output_tokens_planned": 356,
    "output_tokens_actual": 357
  }
}
```

流式响应为标准 SSE：

```
data: {"choices":[{"delta":{"role":"assistant","content":""},"finish_reason":null,...}]}

data: {"choices":[{"delta":{"content":"..."},"finish_reason":null,...}]}

data: {"choices":[{"delta":{},"finish_reason":"stop",...}]}

data: [DONE]
```

## 响应头

| Header | 说明 |
| --- | --- |
| `x-request-id` | 请求 ID |
| `x-mock-cache` | `hit` / `miss` / `off` |
| `x-mock-plan-ttft-ms` | 本次抽样的 TTFT |
| `x-mock-plan-tps` | 本次抽样的 TPS |
| `x-mock-output-tokens` | 本次计划输出 token |
| `x-mock-availability-level` | 可用性等级 |
| `x-mock-failure-delay-ms` | 可用性失败时的等待毫秒数（仅 503 模拟失败响应携带） |
| `x-ratelimit-limit-requests` / `remaining` | QPM 限流（Redis 已连接时） |
| `x-ratelimit-limit-tokens` / `remaining` | TPM 限流 |
| `x-ratelimit-reset` | 当前分钟窗口剩余秒数 |
| `retry-after` | 429 / 503 建议重试秒数 |

## 错误格式

```json
{
  "error": {
    "message": "QPM 限流：每个 Key 每分钟最多 60 次请求，请 12s 后重试",
    "type": "rate_limit_error",
    "param": null,
    "code": "rate_limit_exceeded"
  }
}
```

可用性失败时返回 `503 model_unavailable`；如果模型配置了 `failure_delay_ms`，服务会先等待该毫秒数再返回，响应头带 `x-mock-failure-delay-ms`。QPM/TPM 的 429 和模型停用的 503 不等待。

管理接口错误：

```json
{
  "error": {
    "code": "validation_error",
    "message": "参数校验失败",
    "details": [{"path": "tps_min", "message": "..."}]
  }
}
```
