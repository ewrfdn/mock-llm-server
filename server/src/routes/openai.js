import express from "express";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { delay } from "../lib/async.js";
import { newCompletionId } from "../lib/ids.js";
import { AppError, openAiErrorBody } from "../lib/errors.js";
import { mulberry32, uniform, uniformInt } from "../lib/random.js";
import { getModel, listModels } from "../domain/models.js";
import { recordRequest } from "../domain/usage.js";
import { availabilityPercent } from "../domain/constants.js";
import { rateLimiter, rateLimitHeaders } from "../ratelimit/index.js";
import { getCached, putCached } from "../simulation/cache.js";
import { buildText, countMessageTokens, extractMessageText, WordStream } from "../simulation/generator.js";
import { streamScheduler } from "../simulation/scheduler.js";
import { requireApiKey } from "../middleware/auth.js";

export const openaiRouter = express.Router();

function invalid(message, code = "invalid_request", param = null) {
  return new AppError(400, code, message, param ? { param } : undefined);
}

function parseChatRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw invalid("请求体必须是 JSON 对象");
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) throw invalid("缺少 model 字段", "model_required", "model");

  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    throw invalid("messages 必须是非空数组", "messages_required", "messages");
  }
  body.messages.forEach((message, index) => {
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      throw invalid(`messages[${index}] 必须是对象`, "invalid_messages", "messages");
    }
    if (typeof message.role !== "string" || !message.role) {
      throw invalid(`messages[${index}].role 不能为空`, "invalid_messages", "messages");
    }
  });

  const stream = body.stream === true;
  const includeUsage = body.stream_options?.include_usage === true;

  let maxTokens = null;
  const rawMax = body.max_completion_tokens ?? body.max_tokens;
  if (rawMax !== undefined && rawMax !== null) {
    const parsed = Number(rawMax);
    if (!Number.isFinite(parsed) || parsed < 1) {
      throw invalid("max_tokens 必须是大于 0 的整数", "invalid_max_tokens", "max_tokens");
    }
    maxTokens = Math.floor(parsed);
  }

  let seed = null;
  if (body.seed !== undefined && body.seed !== null) {
    const parsed = Number(body.seed);
    if (!Number.isFinite(parsed)) throw invalid("seed 必须是数字", "invalid_seed", "seed");
    seed = Math.floor(parsed);
  }

  const temperature = Number.isFinite(Number(body.temperature)) ? Number(body.temperature) : 1;

  return { model, messages: body.messages, stream, includeUsage, maxTokens, seed, temperature };
}

function samplePlan(model, rng) {
  const capacityPercent = availabilityPercent(model.availability_level);
  const availabilityRoll = rng() * 100;
  const available = availabilityRoll < capacityPercent;

  const cacheHitRate = uniform(model.cache_hit_rate_min, model.cache_hit_rate_max, rng);
  const cacheRoll = rng() * 100;
  const wantsCache = cacheHitRate > 0 && cacheRoll < cacheHitRate;

  const plannedTokens = uniformInt(model.output_tokens_min, model.output_tokens_max, rng);
  const tps = Math.max(0.1, uniform(model.tps_min, model.tps_max, rng));
  const ttftMs = uniformInt(model.ttft_ms_min, model.ttft_ms_max, rng);

  return { capacityPercent, availabilityRoll, available, cacheHitRate, cacheRoll, wantsCache, plannedTokens, tps, ttftMs };
}

function buildCacheKey(modelId, parsed) {
  const material = JSON.stringify({
    model: modelId,
    messages: parsed.messages.map((message) => ({
      role: message.role,
      content: extractMessageText(message.content),
    })),
    max_tokens: parsed.maxTokens,
    temperature: parsed.temperature,
    seed: parsed.seed,
  });
  return createHash("sha256").update(material).digest("hex");
}

function usagePayload(promptTokens, completionTokens, cachedPromptTokens = false) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: cachedPromptTokens ? promptTokens : 0 },
    completion_tokens_details: { reasoning_tokens: 0 },
  };
}

function applyMockHeaders(res, { model, plan, targetTokens, cached, cacheAttempted }) {
  res.setHeader("x-mock-model", model.id);
  res.setHeader("x-mock-availability-level", String(model.availability_level));
  res.setHeader("x-mock-availability-percent", String(plan.capacityPercent));
  res.setHeader("x-mock-plan-ttft-ms", String(plan.ttftMs));
  res.setHeader("x-mock-plan-tps", String(Math.round(plan.tps * 10) / 10));
  res.setHeader("x-mock-output-tokens", String(targetTokens));
  res.setHeader("x-mock-cache", cached ? "hit" : cacheAttempted ? "miss" : "off");
}

function recordSuccess({ req, model, requestId, promptTokens, completionTokens, cached, ttftMs, durationMs, finishReason, stream }) {
  const outputMs = Math.max(1, durationMs - ttftMs);
  recordRequest({
    request_id: requestId,
    api_key_id: req.apiKey?.id,
    api_key_name: req.apiKey?.name,
    model_id: model.id,
    endpoint: "/v1/chat/completions",
    stream,
    status: 200,
    finish_reason: finishReason,
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    cached,
    ttft_ms: Math.round(ttftMs),
    duration_ms: Math.round(durationMs),
    // 缓存命中时几乎是瞬时返回，TPS 没有统计意义，避免把全局均值拉爆。
    tps: cached ? null : Math.round((completionTokens / (outputMs / 1000)) * 10) / 10,
  });
}

function recordFailure({ req, model, requestId, promptTokens, status, error, cached = false, stream = false, durationMs = null }) {
  recordRequest({
    request_id: requestId,
    api_key_id: req.apiKey?.id,
    api_key_name: req.apiKey?.name,
    model_id: model.id,
    endpoint: "/v1/chat/completions",
    stream,
    status,
    finish_reason: null,
    prompt_tokens: promptTokens,
    completion_tokens: 0,
    cached,
    ttft_ms: null,
    duration_ms: durationMs == null ? null : Math.round(durationMs),
    tps: null,
    error,
  });
}

function writeSse(res, payload) {
  if (res.writableEnded) return true;
  const ok = res.write(`data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`);
  return ok;
}

function chunkPayload(id, created, model, delta, finishReason = null) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    system_fingerprint: "fp_mock_llm",
    choices: [{ index: 0, delta, finish_reason: finishReason, logprobs: null }],
  };
}

function startSse(res) {
  res.status(200);
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders?.();
}

function sendSseError(res, message, code = "server_error") {
  if (res.writableEnded) return;
  writeSse(res, { error: { message, type: "server_error", code } });
  writeSse(res, "[DONE]");
  res.end();
}

function streamGenerated(req, res, ctx) {
  const {
    model,
    requestId,
    promptTokens,
    targetTokens,
    plannedTokens,
    finishReason,
    includeUsage,
    cacheKey,
    canCache,
    rng,
    plan,
    cacheAttempted,
  } = ctx;

  const completionId = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const startedAt = performance.now();
  const words = new WordStream({ targetTokens, rng });

  let roleSent = false;
  let produced = 0;
  let firstTokenAt = null;
  let paused = false;
  let done = false;
  let cacheChunks = canCache ? [] : null;
  let cacheChars = 0;
  let cacheOverflow = false;

  applyMockHeaders(res, { model, plan, targetTokens, cached: false, cacheAttempted });
  startSse(res);
  req.socket?.setNoDelay?.(true);

  const finish = () => {
    if (done) return;
    done = true;
    streamScheduler.remove(stream);
    const finishedAt = performance.now();
    const ttft = firstTokenAt ? firstTokenAt - startedAt : plan.ttftMs;
    const completionTokens = produced;

    if (cacheChunks && !cacheOverflow) {
      putCached(model.id, cacheKey, {
        text: cacheChunks.join(""),
        tokens: completionTokens,
        finish_reason: finishReason,
      });
    }

    writeSse(res, chunkPayload(completionId, created, model.id, {}, finishReason));
    if (includeUsage) {
      writeSse(res, {
        id: completionId,
        object: "chat.completion.chunk",
        created,
        model: model.id,
        system_fingerprint: "fp_mock_llm",
        choices: [],
        usage: usagePayload(promptTokens, completionTokens, false),
      });
    }
    writeSse(res, "[DONE]");
    res.end();

    recordSuccess({
      req,
      model,
      requestId,
      promptTokens,
      completionTokens,
      cached: false,
      ttftMs: ttft,
      durationMs: finishedAt - startedAt,
      finishReason,
      stream: true,
    });
  };

  const stream = {
    tick(now) {
      if (done || paused) return;
      const elapsed = now - startedAt;
      if (elapsed < plan.ttftMs) return;

      let due = Math.floor(((elapsed - plan.ttftMs) / 1000) * plan.tps);
      if (!roleSent) due = Math.max(1, due);
      if (due <= produced) return;

      const chunk = words.produce(due - produced);
      if (!chunk.text) {
        finish();
        return;
      }

      if (!roleSent) {
        roleSent = true;
        firstTokenAt = performance.now();
        writeSse(res, chunkPayload(completionId, created, model.id, { role: "assistant", content: "" }, null));
      }

      const delta = produced > 0 ? ` ${chunk.text}` : chunk.text;
      const ok = writeSse(res, chunkPayload(completionId, created, model.id, { content: delta }, null));
      if (!ok) {
        paused = true;
        res.once("drain", () => {
          paused = false;
        });
      }

      produced = chunk.produced;

      if (cacheChunks) {
        cacheChars += delta.length;
        if (cacheChars <= config.cacheMaxChars) cacheChunks.push(delta);
        else {
          cacheOverflow = true;
          cacheChunks = null;
        }
      }

      if (produced >= targetTokens) finish();
    },

    fail(error) {
      if (done) return;
      done = true;
      streamScheduler.remove(stream);
      logger.error("流式生成失败", error?.message || error);
      sendSseError(res, "流式生成失败", "stream_error");
      recordFailure({ req, model, requestId, promptTokens, status: 500, error: "stream_error" });
    },
  };

  res.on("close", () => {
    if (done) return;
    done = true;
    streamScheduler.remove(stream);
    const ttft = firstTokenAt ? firstTokenAt - startedAt : null;
    const durationMs = performance.now() - startedAt;
    recordRequest({
      request_id: requestId,
      api_key_id: req.apiKey?.id,
      api_key_name: req.apiKey?.name,
      model_id: model.id,
      endpoint: "/v1/chat/completions",
      stream: true,
      status: 499,
      finish_reason: "cancelled",
      prompt_tokens: promptTokens,
      completion_tokens: produced,
      cached: false,
      ttft_ms: ttft,
      duration_ms: Math.round(durationMs),
      tps: ttft && produced ? Math.round((produced / ((durationMs - ttft) / 1000)) * 10) / 10 : null,
      error: "client_closed",
    });
  });

  streamScheduler.add(stream);
}

function streamCached(req, res, { model, requestId, promptTokens, entry, plan, cacheAttempted, targetTokens, includeUsage }) {
  const completionId = newCompletionId();
  const created = Math.floor(Date.now() / 1000);
  const startedAt = performance.now();
  const ttftMs = uniformInt(3, 12, Math.random);
  const text = entry.text;
  const completionTokens = entry.tokens;
  const finishReason = entry.finish_reason || "stop";

  applyMockHeaders(res, { model, plan, targetTokens, cached: true, cacheAttempted });
  startSse(res);

  let closed = false;
  res.on("close", () => {
    closed = true;
    if (!res.writableEnded) {
      recordFailure({ req, model, requestId, promptTokens, status: 499, error: "client_closed", cached: true, stream: true });
    }
  });

  (async () => {
    try {
      await delay(ttftMs);
      if (closed || res.writableEnded) return;
      writeSse(res, chunkPayload(completionId, created, model.id, { role: "assistant", content: "" }, null));

      const parts = 4;
      const size = Math.max(1, Math.ceil(text.length / parts));
      for (let offset = 0; offset < text.length; offset += size) {
        const piece = text.slice(offset, offset + size);
        if (closed || res.writableEnded) return;
        writeSse(res, chunkPayload(completionId, created, model.id, { content: piece }, null));
        await delay(2);
      }

      writeSse(res, chunkPayload(completionId, created, model.id, {}, finishReason));
      if (includeUsage) {
        writeSse(res, {
          id: completionId,
          object: "chat.completion.chunk",
          created,
          model: model.id,
          system_fingerprint: "fp_mock_llm",
          choices: [],
          usage: usagePayload(promptTokens, completionTokens, true),
        });
      }
      writeSse(res, "[DONE]");
      res.end();

      recordSuccess({
        req,
        model,
        requestId,
        promptTokens,
        completionTokens,
        cached: true,
        ttftMs,
        durationMs: performance.now() - startedAt,
        finishReason,
        stream: true,
      });
    } catch (error) {
      logger.error("缓存流式响应失败", error?.message || error);
      if (!res.writableEnded) sendSseError(res, "缓存响应失败", "cache_stream_failed");
      recordFailure({ req, model, requestId, promptTokens, status: 500, error: "cache_stream_failed", cached: true, stream: true });
    }
  })();
}

function respondJson(req, res, { model, requestId, promptTokens, targetTokens, plannedTokens, finishReason, cacheKey, canCache, rng, plan, cacheAttempted }) {
  const startedAt = performance.now();
  applyMockHeaders(res, { model, plan, targetTokens, cached: false, cacheAttempted });

  const built = buildText(targetTokens, rng);
  const completionTokens = built.tokens;
  const totalDelay = plan.ttftMs + (completionTokens / plan.tps) * 1000;

  if (canCache) {
    putCached(model.id, cacheKey, { text: built.text, tokens: completionTokens, finish_reason: finishReason });
  }

  let aborted = false;
  const onClose = () => {
    aborted = true;
  };
  res.once("close", onClose);

  delay(totalDelay)
    .then(() => {
      res.removeListener("close", onClose);
      if (aborted || res.writableEnded) {
        recordFailure({ req, model, requestId, promptTokens, status: 499, error: "client_closed" });
        return;
      }

      const durationMs = performance.now() - startedAt;
      const created = Math.floor(Date.now() / 1000);
      res.status(200).json({
        id: newCompletionId(),
        object: "chat.completion",
        created,
        model: model.id,
        system_fingerprint: "fp_mock_llm",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: built.text },
            finish_reason: finishReason,
            logprobs: null,
          },
        ],
        usage: usagePayload(promptTokens, completionTokens, false),
        mock: {
          cache_hit: false,
          ttft_ms: plan.ttftMs,
          tps: Math.round(plan.tps * 10) / 10,
          availability_level: model.availability_level,
          failure_delay_ms: model.failure_delay_ms,
          output_tokens_planned: plannedTokens,
          output_tokens_actual: completionTokens,
        },
      });

      recordSuccess({
        req,
        model,
        requestId,
        promptTokens,
        completionTokens,
        cached: false,
        ttftMs: plan.ttftMs,
        durationMs,
        finishReason,
        stream: false,
      });
    })
    .catch((error) => {
      res.removeListener("close", onClose);
      logger.error("非流式生成失败", error?.message || error);
      if (!res.headersSent) res.status(500).json(openAiErrorBody({ message: "生成失败", type: "server_error", code: "generation_failed" }));
      recordFailure({ req, model, requestId, promptTokens, status: 500, error: "generation_failed" });
    });
}

function respondCachedJson(req, res, { model, requestId, promptTokens, entry, plan, cacheAttempted, targetTokens }) {
  const startedAt = performance.now();
  const ttftMs = uniformInt(3, 12, Math.random);

  applyMockHeaders(res, { model, plan, targetTokens, cached: true, cacheAttempted });

  let aborted = false;
  const onClose = () => {
    aborted = true;
  };
  res.once("close", onClose);

  delay(ttftMs)
    .then(() => {
      res.removeListener("close", onClose);
      if (aborted || res.writableEnded) {
        recordFailure({ req, model, requestId, promptTokens, status: 499, error: "client_closed", cached: true });
        return;
      }

      const completionTokens = entry.tokens;
      res.status(200).json({
        id: newCompletionId(),
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model: model.id,
        system_fingerprint: "fp_mock_llm",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: entry.text },
            finish_reason: entry.finish_reason || "stop",
            logprobs: null,
          },
        ],
        usage: usagePayload(promptTokens, completionTokens, true),
        mock: {
          cache_hit: true,
          ttft_ms: ttftMs,
          tps: Math.round(plan.tps * 10) / 10,
          availability_level: model.availability_level,
          failure_delay_ms: model.failure_delay_ms,
          output_tokens_actual: completionTokens,
        },
      });

      recordSuccess({
        req,
        model,
        requestId,
        promptTokens,
        completionTokens,
        cached: true,
        ttftMs,
        durationMs: performance.now() - startedAt,
        finishReason: entry.finish_reason || "stop",
        stream: false,
      });
    })
    .catch((error) => {
      res.removeListener("close", onClose);
      logger.error("缓存响应失败", error?.message || error);
      recordFailure({ req, model, requestId, promptTokens, status: 500, error: "cache_response_failed", cached: true });
    });
}

async function handleChat(req, res) {
  const requestId = req.requestId;
  const startedAt = performance.now();
  res.setHeader("x-request-id", requestId);

  const parsed = parseChatRequest(req.body);
  const model = getModel(parsed.model);
  if (!model) throw new AppError(404, "model_not_found", `模型 '${parsed.model}' 不存在`);
  if (!model.enabled) throw new AppError(503, "model_disabled", `模型 '${parsed.model}' 已停用`);

  const promptTokens = countMessageTokens(parsed.messages);
  if (promptTokens >= model.context_window) {
    throw new AppError(
      400,
      "context_length_exceeded",
      `提示词约 ${promptTokens} tokens，超过模型上下文 ${model.context_window} tokens`,
    );
  }

  // seed 只决定生成文本；TTFT / TPS / 可用性 / 缓存命中属于服务端模拟，始终每请求重新抽样。
  const rng = parsed.seed === null ? Math.random : mulberry32(parsed.seed);
  const plan = samplePlan(model, Math.random);

  let targetTokens = Math.min(plan.plannedTokens, config.maxOutputTokens);
  let finishReason = "stop";
  if (parsed.maxTokens && targetTokens > parsed.maxTokens) {
    targetTokens = parsed.maxTokens;
    finishReason = "length";
  }
  const contextLeft = model.context_window - promptTokens;
  if (targetTokens > contextLeft) {
    targetTokens = contextLeft;
    finishReason = "length";
  }
  targetTokens = Math.max(1, Math.floor(targetTokens));

  const cacheAttempted = model.cache_hit_rate_max > 0;
  const cacheKey = buildCacheKey(model.id, parsed);
  const cacheEnabled = model.cache_hit_rate_max > 0 && config.cacheMaxChars > 0;
  const cachedEntry = plan.wantsCache && cacheEnabled ? getCached(model.id, cacheKey) : null;

  const limit = await rateLimiter.consume({
    apiKeyId: req.apiKey.id,
    model,
    tokens: promptTokens + targetTokens,
  });
  for (const [name, value] of Object.entries(rateLimitHeaders(limit))) res.setHeader(name, value);

  if (!limit.allowed) {
    const retryAfter = Math.max(1, Math.ceil(((limit.reset_at || Date.now() + 60_000) - Date.now()) / 1000));
    res.setHeader("retry-after", String(retryAfter));
    recordFailure({ req, model, requestId, promptTokens, status: 429, error: `rate_limit_${limit.reason}` });
    res.status(429).json(
      openAiErrorBody({
        message:
          limit.reason === "qpm"
            ? `QPM 限流：每个 Key 每分钟最多 ${limit.limit} 次请求，请 ${retryAfter}s 后重试`
            : `TPM 限流：该模型每分钟 token 上限 ${limit.token_limit ?? limit.limit}，本次预留 ${promptTokens + targetTokens} tokens`,
        type: "rate_limit_error",
        code: "rate_limit_exceeded",
      }),
    );
    return;
  }

  if (!plan.available) {
    const failureDelayMs = Math.min(600_000, Math.max(0, Number(model.failure_delay_ms) || 0));
    res.setHeader("x-mock-failure-delay-ms", String(failureDelayMs));
    res.setHeader("retry-after", "2");
    if (failureDelayMs > 0) await delay(failureDelayMs);
    if (res.writableEnded || res.destroyed) {
      recordFailure({ req, model, requestId, promptTokens, status: 499, error: "client_closed" });
      return;
    }
    recordFailure({
      req,
      model,
      requestId,
      promptTokens,
      status: 503,
      error: "model_unavailable",
      durationMs: performance.now() - startedAt,
    });
    res.status(503).json(
      openAiErrorBody({
        message: `模拟故障：模型 ${model.id} 当前不可用（可用性等级 L${model.availability_level}，本次抽样 ${plan.availabilityRoll.toFixed(2)}），请稍后重试`,
        type: "server_error",
        code: "model_unavailable",
      }),
    );
    return;
  }

  const common = {
    model,
    requestId,
    promptTokens,
    targetTokens,
    plannedTokens: plan.plannedTokens,
    finishReason,
    cacheKey,
    canCache: cacheEnabled,
    rng,
    plan,
    cacheAttempted,
  };

  if (cachedEntry) {
    if (parsed.stream) {
      streamCached(req, res, { ...common, entry: cachedEntry, includeUsage: parsed.includeUsage });
    } else {
      respondCachedJson(req, res, { ...common, entry: cachedEntry });
    }
    return;
  }

  if (parsed.stream) {
    streamGenerated(req, res, { ...common, includeUsage: parsed.includeUsage });
  } else {
    respondJson(req, res, common);
  }
}

openaiRouter.use(requireApiKey("inference"));

openaiRouter.get("/models", (req, res) => {
  const data = listModels({ includeDisabled: false }).map((model) => ({
    id: model.id,
    object: "model",
    created: Math.floor(new Date(model.created_at).getTime() / 1000),
    owned_by: "mock-llm-server",
    mock: {
      qpm_limit: model.qpm_limit,
      tpm_limit: model.tpm_limit,
      output_tokens_min: model.output_tokens_min,
      output_tokens_max: model.output_tokens_max,
      tps_min: model.tps_min,
      tps_max: model.tps_max,
      ttft_ms_min: model.ttft_ms_min,
      ttft_ms_max: model.ttft_ms_max,
      availability_level: model.availability_level,
      cache_hit_rate_min: model.cache_hit_rate_min,
      cache_hit_rate_max: model.cache_hit_rate_max,
      failure_delay_ms: model.failure_delay_ms,
    },
  }));
  res.json({ object: "list", data });
});

openaiRouter.post("/chat/completions", (req, res) => {
  Promise.resolve(handleChat(req, res)).catch((error) => {
    if (res.headersSent) {
      try {
        res.end();
      } catch {
        /* ignore */
      }
      return;
    }
    const status = error instanceof AppError ? error.status : 500;
    const code = typeof error?.code === "string" ? error.code : null;
    const param = error?.details?.param ?? null;
    if (status >= 500) logger.error("chat/completions 失败", error?.message || error);
    res.status(status).json(
      openAiErrorBody({
        message: error?.message || "内部错误",
        type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error",
        code,
        param,
      }),
    );
  });
});
