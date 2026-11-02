import { z } from "zod";

const modelIdSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z
    .string()
    .min(1, "模型 ID 不能为空")
    .max(64, "模型 ID 最多 64 个字符")
    .regex(/^[a-z0-9][a-z0-9._-]*$/, "模型 ID 只能包含小写字母、数字、点、下划线和连字符，且必须以字母或数字开头"),
);

const int = (min, max, message) => z.number().int(message).min(min).max(max);

const baseFields = {
  display_name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(600),
  qpm_limit: int(0, 100_000_000),
  tpm_limit: int(0, 100_000_000),
  output_tokens_min: int(1, 2_000_000),
  output_tokens_max: int(1, 2_000_000),
  tps_min: z.number().min(0.1).max(100_000),
  tps_max: z.number().min(0.1).max(100_000),
  ttft_ms_min: int(0, 600_000),
  ttft_ms_max: int(0, 600_000),
  availability_level: int(1, 5),
  cache_hit_rate_min: z.number().min(0).max(100),
  cache_hit_rate_max: z.number().min(0).max(100),
  failure_delay_ms: int(0, 600_000).nullable(),
  context_window: int(1024, 10_000_000),
  enabled: z.boolean(),
};

export const modelCreateSchema = z
  .object({
    id: modelIdSchema,
    display_name: baseFields.display_name.optional(),
    description: baseFields.description.default(""),
    qpm_limit: baseFields.qpm_limit.default(0),
    tpm_limit: baseFields.tpm_limit.default(0),
    output_tokens_min: baseFields.output_tokens_min.default(128),
    output_tokens_max: baseFields.output_tokens_max.default(1024),
    tps_min: baseFields.tps_min.default(20),
    tps_max: baseFields.tps_max.default(60),
    ttft_ms_min: baseFields.ttft_ms_min.default(200),
    ttft_ms_max: baseFields.ttft_ms_max.default(600),
    availability_level: baseFields.availability_level.default(1),
    cache_hit_rate_min: baseFields.cache_hit_rate_min.default(0),
    cache_hit_rate_max: baseFields.cache_hit_rate_max.default(0),
    failure_delay_ms: baseFields.failure_delay_ms.default(0),
    context_window: baseFields.context_window.default(128000),
    enabled: baseFields.enabled.default(true),
  })
  .strict();

export const modelPatchSchema = z
  .object({
    display_name: baseFields.display_name.optional(),
    description: baseFields.description.optional(),
    qpm_limit: baseFields.qpm_limit.optional(),
    tpm_limit: baseFields.tpm_limit.optional(),
    output_tokens_min: baseFields.output_tokens_min.optional(),
    output_tokens_max: baseFields.output_tokens_max.optional(),
    tps_min: baseFields.tps_min.optional(),
    tps_max: baseFields.tps_max.optional(),
    ttft_ms_min: baseFields.ttft_ms_min.optional(),
    ttft_ms_max: baseFields.ttft_ms_max.optional(),
    availability_level: baseFields.availability_level.optional(),
    cache_hit_rate_min: baseFields.cache_hit_rate_min.optional(),
    cache_hit_rate_max: baseFields.cache_hit_rate_max.optional(),
    failure_delay_ms: baseFields.failure_delay_ms.optional(),
    context_window: baseFields.context_window.optional(),
    enabled: baseFields.enabled.optional(),
  })
  .strict();

export function validateModelRanges(model) {
  const errors = [];
  if (model.output_tokens_min > model.output_tokens_max) {
    errors.push("output_tokens_min 不能大于 output_tokens_max");
  }
  if (model.tps_min > model.tps_max) {
    errors.push("tps_min 不能大于 tps_max");
  }
  if (model.ttft_ms_min > model.ttft_ms_max) {
    errors.push("ttft_ms_min 不能大于 ttft_ms_max");
  }
  if (model.cache_hit_rate_min > model.cache_hit_rate_max) {
    errors.push("cache_hit_rate_min 不能大于 cache_hit_rate_max");
  }
  if (model.context_window < model.output_tokens_max) {
    errors.push("context_window 不能小于 output_tokens_max");
  }
  return errors;
}

export const apiKeyCreateSchema = z
  .object({
    name: z.string().trim().min(1, "名称不能为空").max(80),
    scopes: z.array(z.enum(["admin", "inference"])).min(1).max(2).default(["admin", "inference"]),
    expires_in_days: z.number().int().min(1).max(3650).nullable().optional(),
  })
  .strict();

export const apiKeyPatchSchema = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    enabled: z.boolean().optional(),
  })
  .strict();
