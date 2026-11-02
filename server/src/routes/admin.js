import express from "express";
import { config } from "../config.js";
import { listModels, getModel, createModel, updateModel, deleteModel } from "../domain/models.js";
import {
  listApiKeys,
  createApiKey,
  updateApiKey,
  rotateApiKey,
  deleteApiKey,
  countApiKeys,
} from "../domain/api-keys.js";
import { getStats, listRequests, countRequestsSince } from "../domain/usage.js";
import { getVocabStats } from "../simulation/vocab.js";
import { clearAllCaches, cacheStats } from "../simulation/cache.js";
import { streamScheduler } from "../simulation/scheduler.js";
import { rateLimiter } from "../ratelimit/index.js";
import { AVAILABILITY_LEVELS, MODEL_DEFAULTS, SCOPES, SCOPE_LABELS } from "../domain/constants.js";
import { AppError, conflict } from "../lib/errors.js";
import { requireApiKey } from "../middleware/auth.js";
import { driver as dbDriver } from "../db/index.js";

export const adminRouter = express.Router();

adminRouter.get("/auth/whoami", requireApiKey(), (req, res) => {
  const key = req.apiKey;
  res.json({
    key: {
      id: key.id,
      name: key.name,
      key_prefix: key.key_prefix,
      scopes: req.apiKeyScopes,
      enabled: Boolean(key.enabled),
      created_at: key.created_at ? new Date(Number(key.created_at)).toISOString() : null,
      last_used_at: key.last_used_at ? new Date(Number(key.last_used_at)).toISOString() : null,
      expires_at: key.expires_at ? new Date(Number(key.expires_at)).toISOString() : null,
    },
    scopes: req.apiKeyScopes,
    can_admin: req.apiKeyScopes.includes("admin"),
    can_inference: req.apiKeyScopes.includes("inference"),
    version: config.version,
  });
});

adminRouter.use(requireApiKey("admin"));

function parseWindow(value) {
  if (!value) return 24 * 60 * 60 * 1000;
  const match = /^(\d+)(m|h|d)$/i.exec(String(value).trim());
  if (!match) return 24 * 60 * 60 * 1000;
  const amount = Number(match[1]);
  const unit = match[2].toLowerCase();
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
  return Math.min(30 * 86_400_000, Math.max(60_000, amount * multiplier));
}

function enabledAdminKeys(excludeId = null) {
  const now = Date.now();
  return listApiKeys().filter(
    (key) =>
      key.enabled &&
      key.scopes.includes("admin") &&
      (!key.expires_at || new Date(key.expires_at).getTime() > now) &&
      (!excludeId || key.id !== excludeId),
  );
}

adminRouter.get("/meta", (req, res) => {
  res.json({
    version: config.version,
    availability_levels: AVAILABILITY_LEVELS,
    scopes: SCOPES,
    scope_labels: SCOPE_LABELS,
    defaults: MODEL_DEFAULTS,
    limits: {
      max_output_tokens: config.maxOutputTokens,
      cache_ttl_ms: config.cacheTtlMs,
      cache_max_entries: config.cacheMaxEntries,
      cache_max_chars: config.cacheMaxChars,
    },
    endpoints: {
      openai_base_url: "/v1",
      mcp_url: "/mcp",
      skill_url: "/api/v1/skill",
      skill_download_url: "/api/v1/skill/download",
    },
  });
});

adminRouter.get("/system", (req, res) => {
  const memory = process.memoryUsage();
  res.json({
    version: config.version,
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    uptime_s: Math.round(process.uptime()),
    memory_mb: Math.round((memory.rss / 1024 / 1024) * 10) / 10,
    db: { driver: dbDriver, path: config.dbPath },
    redis: rateLimiter.statusInfo(),
    counts: {
      models: listModels().length,
      enabled_models: listModels({ includeDisabled: false }).length,
      api_keys: countApiKeys(),
      requests_24h: countRequestsSince(Date.now() - 24 * 60 * 60 * 1000),
    },
    vocab: getVocabStats(),
    cache: cacheStats(),
    active_streams: streamScheduler.size,
    config: {
      max_output_tokens: config.maxOutputTokens,
      cache_ttl_ms: config.cacheTtlMs,
      seed_demo: config.seedDemo,
      cors_origin: config.corsOrigin,
    },
  });
});

adminRouter.get("/models", (req, res) => {
  res.json({ items: listModels() });
});

adminRouter.post("/models", (req, res) => {
  const model = createModel(req.body);
  res.status(201).json({ model });
});

adminRouter.get("/models/:id", (req, res) => {
  const model = getModel(req.params.id);
  if (!model) throw new AppError(404, "model_not_found", `模型 ${req.params.id} 不存在`);
  res.json({ model });
});

adminRouter.patch("/models/:id", (req, res) => {
  const model = updateModel(req.params.id, req.body);
  res.json({ model });
});

adminRouter.delete("/models/:id", (req, res) => {
  deleteModel(req.params.id);
  res.json({ ok: true });
});

adminRouter.get("/api-keys", (req, res) => {
  res.json({ items: listApiKeys() });
});

adminRouter.post("/api-keys", (req, res) => {
  const result = createApiKey(req.body);
  res.status(201).json(result);
});

adminRouter.patch("/api-keys/:id", (req, res) => {
  const current = listApiKeys().find((key) => key.id === req.params.id);
  if (!current) throw new AppError(404, "api_key_not_found", "API Key 不存在");

  if (
    req.body?.enabled === false &&
    current.enabled &&
    current.scopes.includes("admin") &&
    enabledAdminKeys(current.id).length === 0
  ) {
    throw conflict("至少保留一个启用中的管理 Key，避免把自己锁在管理台外", "last_admin_key");
  }

  const key = updateApiKey(req.params.id, req.body);
  res.json({ key });
});

adminRouter.post("/api-keys/:id/rotate", (req, res) => {
  const result = rotateApiKey(req.params.id);
  res.json(result);
});

adminRouter.delete("/api-keys/:id", (req, res) => {
  const current = listApiKeys().find((key) => key.id === req.params.id);
  if (!current) throw new AppError(404, "api_key_not_found", "API Key 不存在");
  if (current.enabled && current.scopes.includes("admin") && enabledAdminKeys(current.id).length === 0) {
    throw conflict("至少保留一个启用中的管理 Key，避免把自己锁在管理台外", "last_admin_key");
  }
  deleteApiKey(req.params.id);
  res.json({ ok: true });
});

adminRouter.get("/requests", (req, res) => {
  const items = listRequests({
    limit: req.query.limit,
    modelId: req.query.model,
    apiKeyId: req.query.key,
    status: req.query.status,
    since: req.query.since,
  });
  res.json({ items });
});

adminRouter.get("/stats", (req, res) => {
  const windowMs = parseWindow(req.query.window);
  const seriesMinutes = Math.min(240, Math.max(10, Number(req.query.series) || 60));
  res.json(getStats({ windowMs, seriesMinutes }));
});

adminRouter.post("/cache/clear", (req, res) => {
  const before = cacheStats();
  clearAllCaches();
  res.json({ ok: true, cleared: before.entries });
});


