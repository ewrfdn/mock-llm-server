import { prepare, transaction } from "../db/index.js";
import { AppError, conflict, notFound } from "../lib/errors.js";
import { validateModelRanges, modelCreateSchema, modelPatchSchema } from "./schemas.js";
import { clearModelCache } from "../simulation/cache.js";

function iso(value) {
  return value ? new Date(Number(value)).toISOString() : null;
}

export function toModel(row) {
  if (!row) return null;
  return {
    id: row.id,
    display_name: row.display_name,
    description: row.description || "",
    qpm_limit: Number(row.qpm_limit),
    tpm_limit: Number(row.tpm_limit),
    output_tokens_min: Number(row.output_tokens_min),
    output_tokens_max: Number(row.output_tokens_max),
    tps_min: Number(row.tps_min),
    tps_max: Number(row.tps_max),
    ttft_ms_min: Number(row.ttft_ms_min),
    ttft_ms_max: Number(row.ttft_ms_max),
    availability_level: Number(row.availability_level),
    cache_hit_rate_min: Number(row.cache_hit_rate_min),
    cache_hit_rate_max: Number(row.cache_hit_rate_max),
    failure_delay_ms: Number(row.failure_delay_ms) || 0,
    context_window: Number(row.context_window),
    enabled: Boolean(row.enabled),
    created_at: iso(row.created_at),
    updated_at: iso(row.updated_at),
  };
}

export function listModels({ includeDisabled = true } = {}) {
  const sql = includeDisabled
    ? "SELECT * FROM models ORDER BY created_at ASC, id ASC"
    : "SELECT * FROM models WHERE enabled = 1 ORDER BY created_at ASC, id ASC";
  return prepare(sql).all().map(toModel);
}

export function getModel(id) {
  const row = prepare("SELECT * FROM models WHERE id = ?").get(String(id));
  return toModel(row);
}

export function requireModel(id) {
  const model = getModel(id);
  if (!model) throw notFound(`模型 ${id} 不存在`, "model_not_found");
  return model;
}

export function createModel(input) {
  const data = modelCreateSchema.parse(input);
  const errors = validateModelRanges(data);
  if (errors.length) throw new AppError(422, "invalid_model_config", errors[0], { issues: errors });

  const existing = prepare("SELECT id FROM models WHERE id = ?").get(data.id);
  if (existing) throw conflict(`模型 ${data.id} 已存在`, "model_exists");

  const now = Date.now();
  const displayName = data.display_name || data.id;

  transaction(() => {
    prepare(`
      INSERT INTO models (
        id, display_name, description, qpm_limit, tpm_limit,
        output_tokens_min, output_tokens_max, tps_min, tps_max,
        ttft_ms_min, ttft_ms_max, availability_level,
        cache_hit_rate_min, cache_hit_rate_max, failure_delay_ms, context_window,
        enabled, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      data.id,
      displayName,
      data.description,
      data.qpm_limit,
      data.tpm_limit,
      data.output_tokens_min,
      data.output_tokens_max,
      data.tps_min,
      data.tps_max,
      data.ttft_ms_min,
      data.ttft_ms_max,
      data.availability_level,
      data.cache_hit_rate_min,
      data.cache_hit_rate_max,
      data.failure_delay_ms ?? 0,
      data.context_window,
      data.enabled ? 1 : 0,
      now,
      now,
    );
  });

  return getModel(data.id);
}

export function updateModel(id, input) {
  const current = requireModel(id);
  const patch = modelPatchSchema.parse(input);

  const merged = { ...current, ...patch };
  if (patch.display_name === undefined) merged.display_name = current.display_name;
  const errors = validateModelRanges(merged);
  if (errors.length) throw new AppError(422, "invalid_model_config", errors[0], { issues: errors });

  const now = Date.now();
  transaction(() => {
    prepare(`
      UPDATE models SET
        display_name = ?, description = ?, qpm_limit = ?, tpm_limit = ?,
        output_tokens_min = ?, output_tokens_max = ?, tps_min = ?, tps_max = ?,
        ttft_ms_min = ?, ttft_ms_max = ?, availability_level = ?,
        cache_hit_rate_min = ?, cache_hit_rate_max = ?, failure_delay_ms = ?, context_window = ?,
        enabled = ?, updated_at = ?
      WHERE id = ?
    `).run(
      merged.display_name,
      merged.description,
      merged.qpm_limit,
      merged.tpm_limit,
      merged.output_tokens_min,
      merged.output_tokens_max,
      merged.tps_min,
      merged.tps_max,
      merged.ttft_ms_min,
      merged.ttft_ms_max,
      merged.availability_level,
      merged.cache_hit_rate_min,
      merged.cache_hit_rate_max,
      merged.failure_delay_ms ?? 0,
      merged.context_window,
      merged.enabled ? 1 : 0,
      now,
      id,
    );
  });

  clearModelCache(id);
  return getModel(id);
}

export function deleteModel(id) {
  requireModel(id);
  prepare("DELETE FROM models WHERE id = ?").run(id);
  clearModelCache(id);
  return true;
}
