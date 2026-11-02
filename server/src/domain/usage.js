import { config } from "../config.js";
import { prepare, transaction } from "../db/index.js";
import { newId } from "../lib/ids.js";

const pending = [];
const INSERT_SQL = `
  INSERT INTO requests (
    id, request_id, api_key_id, api_key_name, model_id, endpoint, stream,
    status, finish_reason, prompt_tokens, completion_tokens, cached,
    ttft_ms, duration_ms, tps, error, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`;

function flush() {
  if (!pending.length) return;
  const rows = pending.splice(0, pending.length);
  try {
    transaction(() => {
      const insert = prepare(INSERT_SQL);
      for (const row of rows) {
        insert.run(
          row.id,
          row.request_id,
          row.api_key_id ?? null,
          row.api_key_name ?? null,
          row.model_id,
          row.endpoint,
          row.stream ? 1 : 0,
          row.status,
          row.finish_reason ?? null,
          Math.max(0, Math.round(row.prompt_tokens || 0)),
          Math.max(0, Math.round(row.completion_tokens || 0)),
          row.cached ? 1 : 0,
          row.ttft_ms == null ? null : Math.max(0, Math.round(row.ttft_ms)),
          row.duration_ms == null ? null : Math.max(0, Math.round(row.duration_ms)),
          row.tps == null ? null : Number(row.tps),
          row.error ?? null,
          row.created_at || Date.now(),
        );
      }
    });
  } catch {
    // 写入失败时放回队列，下一轮再试，避免统计丢数据。
    pending.unshift(...rows);
  }
}

export function recordRequest(entry) {
  pending.push({
    id: newId("req"),
    created_at: Date.now(),
    ...entry,
  });
  if (pending.length >= 500) flush();
}

export function flushRequests() {
  flush();
}

function iso(value) {
  return value ? new Date(Number(value)).toISOString() : null;
}

function toRequest(row) {
  return {
    id: row.id,
    request_id: row.request_id,
    api_key_id: row.api_key_id,
    api_key_name: row.api_key_name,
    model_id: row.model_id,
    endpoint: row.endpoint,
    stream: Boolean(row.stream),
    status: Number(row.status),
    finish_reason: row.finish_reason,
    prompt_tokens: Number(row.prompt_tokens),
    completion_tokens: Number(row.completion_tokens),
    total_tokens: Number(row.prompt_tokens) + Number(row.completion_tokens),
    cached: Boolean(row.cached),
    ttft_ms: row.ttft_ms == null ? null : Number(row.ttft_ms),
    duration_ms: row.duration_ms == null ? null : Number(row.duration_ms),
    tps: row.tps == null ? null : Number(row.tps),
    error: row.error,
    created_at: iso(row.created_at),
  };
}

export function listRequests({ limit = 50, modelId, apiKeyId, status, since } = {}) {
  const clauses = [];
  const params = [];
  if (modelId) {
    clauses.push("model_id = ?");
    params.push(String(modelId));
  }
  if (apiKeyId) {
    clauses.push("api_key_id = ?");
    params.push(String(apiKeyId));
  }
  if (status === "error") clauses.push("status >= 400");
  if (status === "success") clauses.push("status < 400");
  if (since) {
    clauses.push("created_at >= ?");
    params.push(Number(since));
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const cappedLimit = Math.min(500, Math.max(1, Number(limit) || 50));
  const rows = prepare(`SELECT * FROM requests ${where} ORDER BY created_at DESC LIMIT ?`).all(...params, cappedLimit);
  return rows.map(toRequest);
}

function average(value) {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 10) / 10;
}

export function getStats({ windowMs = 24 * 60 * 60 * 1000, seriesMinutes = 60 } = {}) {
  const since = Date.now() - windowMs;
  const overviewRow = prepare(`
    SELECT
      COUNT(*) AS requests,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(cached), 0) AS cache_hits,
      AVG(CASE WHEN status < 400 AND cached = 0 THEN ttft_ms END) AS avg_ttft_ms,
      AVG(CASE WHEN status < 400 AND cached = 0 THEN tps END) AS avg_tps,
      AVG(CASE WHEN status < 400 THEN duration_ms END) AS avg_duration_ms
    FROM requests WHERE created_at >= ?
  `).get(since);

  const overview = {
    requests: Number(overviewRow.requests || 0),
    prompt_tokens: Number(overviewRow.prompt_tokens || 0),
    completion_tokens: Number(overviewRow.completion_tokens || 0),
    tokens: Number(overviewRow.prompt_tokens || 0) + Number(overviewRow.completion_tokens || 0),
    errors: Number(overviewRow.errors || 0),
    cache_hits: Number(overviewRow.cache_hits || 0),
    avg_ttft_ms: average(overviewRow.avg_ttft_ms),
    avg_tps: average(overviewRow.avg_tps),
    avg_duration_ms: average(overviewRow.avg_duration_ms),
    error_rate: 0,
    cache_hit_rate: 0,
  };
  if (overview.requests > 0) {
    overview.error_rate = Math.round((overview.errors / overview.requests) * 1000) / 10;
    overview.cache_hit_rate = Math.round((overview.cache_hits / overview.requests) * 1000) / 10;
  }

  const bucketMs = 60 * 1000;
  const seriesSince = Date.now() - seriesMinutes * bucketMs;
  const seriesRows = prepare(`
    SELECT
      CAST(created_at / ? AS INTEGER) * ? AS bucket,
      COUNT(*) AS requests,
      COALESCE(SUM(completion_tokens), 0) AS tokens,
      COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(cached), 0) AS cache_hits
    FROM requests
    WHERE created_at >= ?
    GROUP BY bucket
    ORDER BY bucket ASC
  `).all(bucketMs, bucketMs, seriesSince);

  const seriesIndex = new Map(seriesRows.map((row) => [Number(row.bucket), row]));
  const currentBucket = Math.floor(Date.now() / bucketMs) * bucketMs;
  const series = [];
  for (let i = seriesMinutes - 1; i >= 0; i -= 1) {
    const bucket = currentBucket - i * bucketMs;
    const row = seriesIndex.get(bucket);
    series.push({
      t: new Date(bucket).toISOString(),
      requests: row ? Number(row.requests) : 0,
      tokens: row ? Number(row.tokens) : 0,
      errors: row ? Number(row.errors) : 0,
      cache_hits: row ? Number(row.cache_hits) : 0,
    });
  }

  const models = prepare(`
    SELECT
      model_id,
      COUNT(*) AS requests,
      COALESCE(SUM(prompt_tokens), 0) AS prompt_tokens,
      COALESCE(SUM(completion_tokens), 0) AS completion_tokens,
      COALESCE(SUM(CASE WHEN status >= 400 THEN 1 ELSE 0 END), 0) AS errors,
      COALESCE(SUM(cached), 0) AS cache_hits,
      AVG(CASE WHEN status < 400 AND cached = 0 THEN ttft_ms END) AS avg_ttft_ms,
      AVG(CASE WHEN status < 400 AND cached = 0 THEN tps END) AS avg_tps
    FROM requests
    WHERE created_at >= ?
    GROUP BY model_id
    ORDER BY requests DESC
    LIMIT 20
  `).all(since).map((row) => ({
    model_id: row.model_id,
    requests: Number(row.requests),
    prompt_tokens: Number(row.prompt_tokens),
    completion_tokens: Number(row.completion_tokens),
    tokens: Number(row.prompt_tokens) + Number(row.completion_tokens),
    errors: Number(row.errors),
    cache_hits: Number(row.cache_hits),
    avg_ttft_ms: average(row.avg_ttft_ms),
    avg_tps: average(row.avg_tps),
  }));

  const keys = prepare(`
    SELECT
      api_key_id,
      COALESCE(api_key_name, 'unknown') AS name,
      COUNT(*) AS requests,
      COALESCE(SUM(completion_tokens), 0) AS tokens
    FROM requests
    WHERE created_at >= ? AND api_key_id IS NOT NULL
    GROUP BY api_key_id
    ORDER BY requests DESC
    LIMIT 10
  `).all(since).map((row) => ({
    api_key_id: row.api_key_id,
    name: row.name,
    requests: Number(row.requests),
    tokens: Number(row.tokens),
  }));

  return {
    window_ms: windowMs,
    overview,
    series,
    models,
    keys,
    recent: listRequests({ limit: 12 }),
  };
}

export function countRequestsSince(since) {
  const row = prepare("SELECT COUNT(*) AS count FROM requests WHERE created_at >= ?").get(Number(since) || 0);
  return Number(row.count || 0);
}

export function pruneRequests() {
  const total = Number(prepare("SELECT COUNT(*) AS count FROM requests").get().count);
  if (total <= config.requestsRetention) return 0;
  const removed = prepare(`
    DELETE FROM requests
    WHERE rowid NOT IN (
      SELECT rowid FROM requests ORDER BY created_at DESC LIMIT ?
    )
  `).run(config.requestsRetention);
  return Number(removed.changes || 0);
}

const flushTimer = setInterval(flush, 1000);
flushTimer.unref?.();
