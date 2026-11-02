import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { config } from "../config.js";
import { AVAILABILITY_LEVELS } from "../domain/constants.js";
import { listModels, getModel, createModel, updateModel, deleteModel } from "../domain/models.js";
import { getStats } from "../domain/usage.js";
import { getVocabStats } from "../simulation/vocab.js";
import { rateLimiter } from "../ratelimit/index.js";

const textResult = (data) => ({
  content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
});

const errorResult = (error) => {
  const issues = Array.isArray(error?.issues)
    ? error.issues.map((issue) => ({ path: Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path ?? ""), message: issue.message }))
    : undefined;
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            error: error?.code || (issues ? "validation_error" : "error"),
            message: error?.message || "Unknown error",
            ...(issues ? { issues } : {}),
            ...(error?.details ? { details: error.details } : {}),
          },
          null,
          2,
        ),
      },
    ],
  };
};

function tool(handler) {
  return async (args) => {
    try {
      return textResult(await handler(args || {}));
    } catch (error) {
      return errorResult(error);
    }
  };
}

/** 兼容 SDK 1.x 的 registerTool / 旧版 tool 两种注册方式。 */
function defineTool(server, name, options, handler) {
  if (typeof server.registerTool === "function") {
    return server.registerTool(name, options, handler);
  }
  return server.tool(name, options.description, options.inputSchema, handler);
}

const percentDescription = "0-100。每次请求在 [min, max] 内均匀抽样缓存命中率，命中时直接返回缓存内容（接近 0 的 TTFT）。";

const modelFieldShape = {
  display_name: z.string().min(1).max(120).optional().describe("展示名称，省略时等于模型 ID"),
  description: z.string().max(600).optional().describe("模型描述"),
  qpm_limit: z.number().int().min(0).max(100000000).optional().describe("每分钟请求数上限；0 = 不限制。需要配置 Redis 才生效。"),
  tpm_limit: z.number().int().min(0).max(100000000).optional().describe("每分钟 token 上限（提示词 + 预留输出）；0 = 不限制。需要配置 Redis 才生效。"),
  output_tokens_min: z.number().int().min(1).max(2000000).optional().describe("输出 token 数范围下限，每次请求均匀抽样。"),
  output_tokens_max: z.number().int().min(1).max(2000000).optional().describe("输出 token 数范围上限。"),
  tps_min: z.number().min(0.1).max(100000).optional().describe("输出 tokens/秒范围下限。"),
  tps_max: z.number().min(0.1).max(100000).optional().describe("输出 tokens/秒范围上限。"),
  ttft_ms_min: z.number().int().min(0).max(600000).optional().describe("首 token 延迟 TTFT 范围下限（毫秒）。"),
  ttft_ms_max: z.number().int().min(0).max(600000).optional().describe("首 token 延迟 TTFT 范围上限（毫秒）。"),
  availability_level: z.number().int().min(1).max(5).optional().describe("可用性等级：1=100%，2=99.9%，3=99%，4=95%，5=90%。每次请求按该概率抽样是否成功。"),
  cache_hit_rate_min: z.number().min(0).max(100).optional().describe(`缓存命中率范围下限。${percentDescription}`),
  cache_hit_rate_max: z.number().min(0).max(100).optional().describe("缓存命中率范围上限。"),
  failure_delay_ms: z
    .number()
    .int()
    .min(0)
    .max(600000)
    .optional()
    .describe("可用性抽样失败时，等待多少毫秒再返回 503；0 或省略表示立即失败。"),
  context_window: z.number().int().min(1024).max(10000000).optional().describe("上下文窗口 token 数，必须 >= output_tokens_max。"),
  enabled: z.boolean().optional().describe("是否启用该模型。"),
};

const createModelShape = {
  id: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/, "只能包含字母、数字、点、下划线和连字符")
    .describe("模型 ID（会转为小写），例如 mock-fast"),
  ...modelFieldShape,
};

const updateModelShape = {
  model_id: z.string().min(1).describe("要修改的模型 ID"),
  ...modelFieldShape,
};

export function createMcpServer() {
  const server = new McpServer(
    { name: "mock-llm-server", version: config.version },
    {
      instructions:
        "Mock LLM Server 的管理 MCP。用 list_models 查看 mock 模型，用 create_model / update_model / delete_model 配置模型指标。" +
        "模型本身对外提供 OpenAI 兼容的 /v1/chat/completions 接口。此 MCP 端点当前不鉴权。",
    },
  );

  defineTool(
    server,
    "get_server_info",
    {
      title: "Get server info",
      description: "返回服务地址、鉴权方式、Redis 限流状态、词表信息、可用性等级以及各接口说明。",
      inputSchema: {},
    },
    tool(async () => ({
      name: "mock-llm-server",
      version: config.version,
      base_url: config.publicBaseUrl,
      endpoints: {
        openai_base: `${config.publicBaseUrl}/v1`,
        models: `${config.publicBaseUrl}/v1/models`,
        chat_completions: `${config.publicBaseUrl}/v1/chat/completions`,
        admin_api: `${config.publicBaseUrl}/api/v1`,
        mcp: `${config.publicBaseUrl}/mcp`,
        skill: `${config.publicBaseUrl}/api/v1/skill`,
      },
      auth: {
        type: "bearer",
        header: "Authorization: Bearer <API_KEY>",
        note: "只有 /v1 与 /api/v1 需要 API Key；MCP 端点暂不鉴权。API Key 在管理台创建。",
      },
      redis: rateLimiter.statusInfo(),
      vocabulary: getVocabStats(),
      availability_levels: AVAILABILITY_LEVELS,
      limits: {
        max_output_tokens: config.maxOutputTokens,
        cache_ttl_ms: config.cacheTtlMs,
        cache_max_entries: config.cacheMaxEntries,
      },
      metrics_semantics: {
        qpm_limit: "每 API Key + 模型，每自然分钟请求数；0 表示不限制；仅 Redis 已连接时生效。",
        tpm_limit: "每 API Key + 模型，每自然分钟 token 数（提示词 + 本次预留输出）；0 表示不限制。",
        output_tokens_min_max: "每次请求在范围内均匀抽样目标输出长度。",
        tps_min_max: "每次请求在范围内均匀抽样输出速度，流式响应按该速度产生 token。",
        ttft_ms_min_max: "每次请求在范围内均匀抽样首 token 延迟。",
        availability_level: "1=100%，2=99.9%，3=99%，4=95%，5=90%；按概率返回 503 model_unavailable。",
        cache_hit_rate_min_max: "每次请求抽样命中概率；命中时以 3-12ms 的 TTFT 返回同参数请求的缓存文本。",
        failure_delay_ms: "可用性抽样判定失败时，先等待该毫秒数再返回 503；0 表示立即失败。",
      },
    })),
  );

  defineTool(
    server,
    "list_models",
    {
      title: "List mock models",
      description: "列出所有 mock 模型及其指标配置（QPM、TPM、输出长度、TPS、TTFT、可用性、缓存命中率）。",
      inputSchema: {},
    },
    tool(async () => ({ total: listModels().length, items: listModels() })),
  );

  defineTool(
    server,
    "get_model",
    {
      title: "Get mock model",
      description: "按模型 ID 获取一个 mock 模型的完整配置。",
      inputSchema: { model_id: z.string().min(1).describe("模型 ID") },
    },
    tool(async ({ model_id }) => {
      const model = getModel(model_id);
      if (!model) throw Object.assign(new Error(`模型 ${model_id} 不存在`), { code: "model_not_found" });
      return { model };
    }),
  );

  defineTool(
    server,
    "create_model",
    {
      title: "Create mock model",
      description:
        "创建一个 mock 模型。未提供的指标使用默认值：输出 128-1024 tokens、TPS 20-60、TTFT 200-600ms、可用性 L1、缓存 0-0、失败等待 0ms、QPM/TPM 不限。" +
        "可用性等级 1 表示 100% 可用。",
      inputSchema: createModelShape,
    },
    tool(async (args) => {
      const model = createModel(args);
      return { model, note: "指标范围会在每次推理请求时均匀抽样。" };
    }),
  );

  defineTool(
    server,
    "update_model",
    {
      title: "Update mock model",
      description: "更新 mock 模型的任意指标。只传需要修改的字段，模型 ID 不能修改。",
      inputSchema: updateModelShape,
    },
    tool(async (args) => {
      const { model_id: modelId, ...patch } = args;
      const model = updateModel(modelId, patch);
      return { model };
    }),
  );

  defineTool(
    server,
    "delete_model",
    {
      title: "Delete mock model",
      description: "删除 mock 模型。已产生的请求统计会保留。",
      inputSchema: { model_id: z.string().min(1).describe("模型 ID") },
    },
    tool(async ({ model_id }) => {
      deleteModel(model_id);
      return { ok: true, model_id };
    }),
  );

  defineTool(
    server,
    "get_usage_stats",
    {
      title: "Get usage stats",
      description: "读取请求量、token 用量、缓存命中、错误率，以及按模型的聚合统计。",
      inputSchema: {
        window: z.enum(["1h", "6h", "24h", "7d"]).optional().describe("统计窗口，默认 24h"),
      },
    },
    tool(async ({ window: windowKey }) => {
      const multipliers = {
        "1h": 60 * 60 * 1000,
        "6h": 6 * 60 * 60 * 1000,
        "24h": 24 * 60 * 60 * 1000,
        "7d": 7 * 24 * 60 * 60 * 1000,
      };
      const stats = getStats({ windowMs: multipliers[windowKey || "24h"] });
      return { window: windowKey || "24h", overview: stats.overview, models: stats.models, redis: rateLimiter.statusInfo() };
    }),
  );

  return server;
}
