import { config } from "../config.js";
import { prepare } from "../db/index.js";
import { newApiKey, newId } from "../lib/ids.js";
import { sha256 } from "../lib/hash.js";
import { conflict, forbidden, notFound } from "../lib/errors.js";
import { apiKeyCreateSchema, apiKeyPatchSchema } from "./schemas.js";
import { scopesToArray } from "./constants.js";

const AUTH_CACHE_TTL_MS = 5_000;

/** token hash -> { row, cachedAt } */
const authCache = new Map();
/** key id -> 最后一次写 last_used_at 的时间 */
const lastTouched = new Map();

function iso(value) {
  return value ? new Date(Number(value)).toISOString() : null;
}

function toPublicKey(row, usage) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.key_prefix,
    scopes: scopesToArray(row.scopes),
    enabled: Boolean(row.enabled),
    created_at: iso(row.created_at),
    last_used_at: iso(row.last_used_at),
    expires_at: iso(row.expires_at),
    ...(usage ? { requests_24h: Number(usage.requests_24h || 0), tokens_24h: Number(usage.tokens_24h || 0) } : {}),
  };
}

export function listApiKeys() {
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const rows = prepare(`
    SELECT k.*,
      (SELECT COUNT(*) FROM requests r WHERE r.api_key_id = k.id AND r.created_at >= ?) AS requests_24h,
      (SELECT COALESCE(SUM(r.completion_tokens), 0) FROM requests r WHERE r.api_key_id = k.id AND r.created_at >= ?) AS tokens_24h
    FROM api_keys k
    ORDER BY k.created_at ASC, k.id ASC
  `).all(since, since);
  return rows.map((row) => toPublicKey(row, row));
}

export function getApiKey(id) {
  const row = prepare("SELECT * FROM api_keys WHERE id = ?").get(String(id));
  return toPublicKey(row);
}

export function countApiKeys() {
  return Number(prepare("SELECT COUNT(*) AS count FROM api_keys").get().count);
}

export function createApiKey(input) {
  const data = apiKeyCreateSchema.parse(input);
  const token = newApiKey();
  const now = Date.now();
  const scopes = [...new Set(data.scopes)];
  const expiresAt = data.expires_in_days ? now + data.expires_in_days * 24 * 60 * 60 * 1000 : null;
  const id = newId("key");

  prepare(`
    INSERT INTO api_keys (id, name, key_hash, key_prefix, scopes, enabled, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, ?)
  `).run(id, data.name, sha256(token), token.slice(0, 12), scopes.join(","), now, expiresAt);

  authCache.clear();
  return { key: getApiKey(id), token };
}

export function updateApiKey(id, input) {
  const current = prepare("SELECT * FROM api_keys WHERE id = ?").get(String(id));
  if (!current) throw notFound("API Key 不存在", "api_key_not_found");
  const patch = apiKeyPatchSchema.parse(input);

  if (patch.name !== undefined) {
    prepare("UPDATE api_keys SET name = ? WHERE id = ?").run(patch.name, id);
  }
  if (patch.enabled !== undefined) {
    prepare("UPDATE api_keys SET enabled = ? WHERE id = ?").run(patch.enabled ? 1 : 0, id);
  }

  authCache.clear();
  return getApiKey(id);
}

export function rotateApiKey(id) {
  const current = prepare("SELECT * FROM api_keys WHERE id = ?").get(String(id));
  if (!current) throw notFound("API Key 不存在", "api_key_not_found");
  if (!current.enabled) throw conflict("已停用的 Key 不能轮换，请先启用", "api_key_disabled");

  const token = newApiKey();
  prepare("UPDATE api_keys SET key_hash = ?, key_prefix = ?, last_used_at = NULL WHERE id = ?").run(
    sha256(token),
    token.slice(0, 12),
    id,
  );
  authCache.clear();
  return { key: getApiKey(id), token };
}

export function deleteApiKey(id) {
  const current = prepare("SELECT * FROM api_keys WHERE id = ?").get(String(id));
  if (!current) throw notFound("API Key 不存在", "api_key_not_found");
  prepare("DELETE FROM api_keys WHERE id = ?").run(id);
  authCache.clear();
  lastTouched.delete(id);
  return true;
}

/**
 * 校验 Bearer Token。只保存哈希；缓存 5 秒以支撑高频推理请求。
 * 返回 { key, scopes } 或 null。
 */
export function authenticateToken(token) {
  if (!token || typeof token !== "string" || !token.startsWith("mllm_") || token.length > 128) return null;
  const hash = sha256(token);
  const cached = authCache.get(hash);
  const now = Date.now();
  if (cached && now - cached.cachedAt < AUTH_CACHE_TTL_MS) {
    return cached.value;
  }

  const row = prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(hash);
  let value = null;
  if (row && Boolean(row.enabled)) {
    if (!row.expires_at || Number(row.expires_at) > now) {
      value = { key: row, scopes: scopesToArray(row.scopes) };
    }
  }

  if (value) authCache.set(hash, { value, cachedAt: now });
  else authCache.delete(hash);
  return value;
}

/** last_used_at 每个 Key 最多每 30 秒写一次，避免高并发下写放大。 */
export function touchApiKey(id) {
  const now = Date.now();
  const previous = lastTouched.get(id) || 0;
  if (now - previous < 30_000) return;
  lastTouched.set(id, now);
  try {
    prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now, id);
  } catch {
    lastTouched.delete(id);
  }
}

export function requireScope(scopes, scope) {
  if (!Array.isArray(scopes) || !scopes.includes(scope)) {
    throw forbidden(`当前 API Key 缺少 ${scope} 权限`, "insufficient_scope");
  }
}

export function invalidateAuthCache() {
  authCache.clear();
}
