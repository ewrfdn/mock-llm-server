# 指标语义与调参

所有范围类指标在**每次请求**时重新均匀抽样；不同请求得到不同结果。所有时间单位是毫秒。

## 输出长度（output_tokens_min / max）

- 请求开始时抽样目标 token 数 `target`。
- 再按 `max_tokens` 裁剪；若被裁剪，`finish_reason = "length"`。
- 若 `prompt_tokens + target` 超过 `context_window`，继续裁剪；提示词本身超限则返回 400。
- 文本由 2000 词的内存词表随机抽样组成，每个词的 token 数在启动时预计算，生成时只做整数累加。
- 实际输出 token 可能比 `target` 多 1-3 个（词是完整抽样的），usage 里返回实际值。

超长输出：服务端默认 `MAX_OUTPUT_TOKENS=1000000`。流式按需生成，不会预先分配完整文本；非流式会一次性构建字符串。超大输出会消耗更多内存，压测时注意组合。

## TPS（tps_min / max）

- 流式：所有并发流共用一个 20ms 调度器。每个 tick 按 `elapsed * tps` 计算应发送的 token 数，从词表继续抽样并写入 SSE。
- 非流式：总耗时 = `ttft + completion_tokens / tps`。
- 客户端断开（`res.close`）会立即从调度器移除并记录 499 状态。

## TTFT（ttft_ms_min / max）

- 流式：从收到请求到首个 content 帧的等待；实际值受调度 tick 抖动影响，响应头里是计划值。
- 非流式：包含在总耗时中，响应体 `mock.ttft_ms` 返回计划值。
- 缓存命中：固定 3-12ms（模拟缓存读取），不受模型 TTFT 范围影响。

## 可用性等级（availability_level）

| 等级 | 成功率 |
| --- | --- |
| 1 | 100% |
| 2 | 99.9% |
| 3 | 99% |
| 4 | 95% |
| 5 | 90% |

失败请求返回 HTTP 503，code `model_unavailable`，`retry-after: 2`。QPM 预扣仍会消耗；这符合真实网关里“失败请求也计入请求数”的行为。

## 失败等待（failure_delay_ms）

- 仅作用于**可用性抽样失败**：判定失败后先等待 `failure_delay_ms` 毫秒，再返回 503。
- 不填、`null` 或 `0`：立即失败（默认）。
- 范围：`0` - `600000` ms。等待期间客户端断开会被记录为 499，不再发送响应。
- QPM/TPM 超限的 429、模型停用的 503、参数错误等不受此配置影响。
- 响应头 `x-mock-failure-delay-ms` 会带上本次等待时长，便于客户端断言。

## 缓存命中率（cache_hit_rate_min / max）

- 每次请求抽样一个命中概率；只有抽样命中且缓存存在时才会直接返回。
- 缓存键：模型 ID + messages 文本 + max_tokens + temperature + seed。
- 缓存是进程内 LRU：默认 TTL 10 分钟、每模型 300 条、单条文本上限 200,000 字符；可通过 `CACHE_TTL_MS`、`CACHE_MAX_ENTRIES`、`CACHE_MAX_CHARS` 调整。
- 流式与非流式共享同一份缓存；缓存响应仍会以 SSE 分 4 段快速输出。
- `usage.prompt_tokens_details.cached_tokens` 在命中时等于 prompt tokens；响应头 `x-mock-cache: hit`。

## QPM / TPM

- 作用域：`API Key + 模型`。
- 窗口：自然分钟（按服务器时间取整到分钟），Redis key 带 120s TTL。
- 预扣：请求开始时预扣 `prompt_tokens + target_tokens`。这样并发下不会超卖 TPM。
- 未配置 `REDIS_URL`：完全跳过，服务正常可用，响应头 `x-mock-ratelimit: off`。
- Redis 配置但连接失败：fail-open，请求继续，响应头 `x-mock-ratelimit: degraded`，`/api/v1/system` 显示错误。
- 超限：HTTP 429，code `rate_limit_exceeded`，带 `retry-after` 与 `x-ratelimit-*`。

## 组合建议

| 场景 | 建议 |
| --- | --- |
| 客户端超时 / 重试 | `ttft 3000-8000`，`availability_level 4`，`failure_delay_ms 5000` |
| 超长输出 | `output_tokens 32768-200000`，`tps 200-800`，`max_tokens` 不设或设很大 |
| 限流演练 | Redis + `qpm_limit 10`，`tpm_limit 2000`，并发 20 |
| 缓存演练 | `cache_hit_rate 80-100`，相同 messages 连续请求 |
| 高并发压测 | `ttft 10-50`，`tps 500-2000`，`availability_level 1`，输出 64-256 tokens |
