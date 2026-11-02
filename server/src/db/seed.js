import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { newApiKey, newId } from "../lib/ids.js";
import { sha256 } from "../lib/hash.js";
import { prepare } from "./index.js";

const DEMO_MODELS = [
  {
    id: "mock-fast",
    display_name: "Mock Fast",
    description: "低延迟、高吞吐的通用演示模型，100% 可用。",
    qpm_limit: 0,
    tpm_limit: 0,
    output_tokens_min: 128,
    output_tokens_max: 1024,
    tps_min: 80,
    tps_max: 140,
    ttft_ms_min: 120,
    ttft_ms_max: 350,
    availability_level: 1,
    cache_hit_rate_min: 10,
    cache_hit_rate_max: 35,
    context_window: 128000,
  },
  {
    id: "mock-long",
    display_name: "Mock Long",
    description: "面向超长输出与限流演示：默认 4k-32k 输出、QPM/TPM 生效后需要 Redis。",
    qpm_limit: 120,
    tpm_limit: 4_000_000,
    output_tokens_min: 4096,
    output_tokens_max: 32768,
    tps_min: 20,
    tps_max: 45,
    ttft_ms_min: 350,
    ttft_ms_max: 900,
    availability_level: 2,
    cache_hit_rate_min: 0,
    cache_hit_rate_max: 10,
    failure_delay_ms: 1500,
    context_window: 256000,
  },
  {
    id: "mock-cached",
    display_name: "Mock Cached",
    description: "高缓存命中率演示模型，重复请求会以接近 0 的 TTFT 返回。",
    qpm_limit: 600,
    tpm_limit: 1_000_000,
    output_tokens_min: 256,
    output_tokens_max: 2048,
    tps_min: 60,
    tps_max: 110,
    ttft_ms_min: 80,
    ttft_ms_max: 220,
    availability_level: 1,
    cache_hit_rate_min: 65,
    cache_hit_rate_max: 92,
    context_window: 128000,
  },
];

export function seedDemoModels() {
  if (!config.seedDemo) return 0;
  const count = Number(prepare("SELECT COUNT(*) AS count FROM models").get().count);
  if (count > 0) return 0;

  const now = Date.now();
  const insert = prepare(`
    INSERT INTO models (
      id, display_name, description, qpm_limit, tpm_limit,
      output_tokens_min, output_tokens_max, tps_min, tps_max,
      ttft_ms_min, ttft_ms_max, availability_level,
      cache_hit_rate_min, cache_hit_rate_max, failure_delay_ms, context_window,
      enabled, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `);

  for (const model of DEMO_MODELS) {
    insert.run(
      model.id,
      model.display_name,
      model.description,
      model.qpm_limit,
      model.tpm_limit,
      model.output_tokens_min,
      model.output_tokens_max,
      model.tps_min,
      model.tps_max,
      model.ttft_ms_min,
      model.ttft_ms_max,
      model.availability_level,
      model.cache_hit_rate_min,
      model.cache_hit_rate_max,
      model.failure_delay_ms || 0,
      model.context_window,
      now,
      now,
    );
  }

  logger.info(`已创建 ${DEMO_MODELS.length} 个演示模型`);
  return DEMO_MODELS.length;
}

export function ensureBootstrapKey() {
  const count = Number(prepare("SELECT COUNT(*) AS count FROM api_keys").get().count);
  if (count > 0) return null;

  const raw = config.bootstrapApiKey || newApiKey();
  const token = raw.startsWith("mllm_") ? raw : `mllm_${raw}`;
  const now = Date.now();
  prepare(`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, enabled, created_at)
    VALUES (?, ?, ?, ?, ?, 1, ?)
  `).run(newId("key"), "bootstrap-admin", sha256(token), token.slice(0, 12), "admin,inference", now);

  const file = path.join(config.dataDir, "bootstrap-key.txt");
  try {
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(
      file,
      [
        "Mock LLM Server 管理台 API Key",
        "================================",
        "",
        token,
        "",
        "用途：登录管理台（http://localhost:8787）以及在 /api/v1、/v1 请求中作为 Bearer Token。",
        "数据库只保存该 Key 的哈希；此文件是唯一明文副本，请勿提交到 Git。",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  } catch (error) {
    logger.warn("无法写入 bootstrap-key.txt，请从下方日志复制 Key", error?.message);
  }

  return { token, file };
}
