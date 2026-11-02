/** 可用性等级：1 = 100%，等级越高模拟的故障概率越大。 */
export const AVAILABILITY_LEVELS = Object.freeze([
  { level: 1, percent: 100, label: "L1 · 100% 可用" },
  { level: 2, percent: 99.9, label: "L2 · 99.9% 可用" },
  { level: 3, percent: 99, label: "L3 · 99% 可用" },
  { level: 4, percent: 95, label: "L4 · 95% 可用" },
  { level: 5, percent: 90, label: "L5 · 90% 可用" },
]);

export function availabilityPercent(level) {
  const item = AVAILABILITY_LEVELS.find((entry) => entry.level === Number(level));
  return item ? item.percent : 100;
}

export const SCOPES = Object.freeze(["admin", "inference"]);

export const SCOPE_LABELS = Object.freeze({
  admin: "管理",
  inference: "推理",
});

export const MODEL_DEFAULTS = Object.freeze({
  qpm_limit: 0,
  tpm_limit: 0,
  output_tokens_min: 128,
  output_tokens_max: 1024,
  tps_min: 20,
  tps_max: 60,
  ttft_ms_min: 200,
  ttft_ms_max: 600,
  availability_level: 1,
  cache_hit_rate_min: 0,
  cache_hit_rate_max: 0,
  failure_delay_ms: 0,
  context_window: 128000,
  enabled: true,
});

export const FINISH_REASONS = Object.freeze({
  stop: "stop",
  length: "length",
});

export function scopesToArray(value) {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    return value
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
  }
  return [];
}
