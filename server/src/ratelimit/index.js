import Redis from "ioredis";
import { config } from "../config.js";
import { logger } from "../logger.js";

/**
 * QPM / TPM 限流器。
 *
 * - 未配置 REDIS_URL：不做任何限流，正常服务（enforced = false）。
 * - Redis 配置但不可用：fail-open，正常服务，并通过状态接口提示降级。
 * - 已连接：按「API Key + 模型 + 分钟桶」原子检查并预扣 token。
 */
const CONSUME_SCRIPT = `
local q = tonumber(redis.call('GET', KEYS[1]) or '0')
local t = tonumber(redis.call('GET', KEYS[2]) or '0')
local ql = tonumber(ARGV[1])
local tl = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
if ql > 0 and q + 1 > ql then
  return {-1, q, t}
end
if tl > 0 and t + cost > tl then
  return {-2, q, t}
end
q = redis.call('INCR', KEYS[1])
redis.call('EXPIRE', KEYS[1], ttl)
t = redis.call('INCRBY', KEYS[2], cost)
redis.call('EXPIRE', KEYS[2], ttl)
return {1, q, t}
`;

const WINDOW_MS = 60_000;
const TTL_SECONDS = 120;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis 连接超时（${ms}ms）`)), ms);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class RateLimiter {
  constructor() {
    this.client = null;
    this.status = config.redisUrl ? "connecting" : "disabled";
    this.lastError = null;
    this.lastErrorAt = 0;
    this.configured = Boolean(config.redisUrl);
    this.enforced = false;
  }

  async init() {
    if (!this.configured) {
      logger.info("未配置 REDIS_URL：QPM / TPM 限流关闭，服务正常可用");
      return;
    }

    const client = new Redis(config.redisUrl, {
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 1,
      connectTimeout: 2000,
      retryStrategy: (times) => Math.min(500 * times, 5000),
    });

    client.on("ready", () => {
      this.status = "connected";
      this.enforced = true;
      this.lastError = null;
      logger.info("Redis 已连接，QPM / TPM 限流生效");
    });
    client.on("error", (error) => {
      this.lastError = error?.message || String(error);
      this.lastErrorAt = Date.now();
      this.status = "error";
      this.enforced = false;
      if (config.logLevel === "debug") logger.warn("Redis 错误", this.lastError);
    });
    client.on("close", () => {
      if (this.configured) {
        this.enforced = false;
        if (this.status === "connected") this.status = "disconnected";
      }
    });

    this.client = client;
    try {
      await withTimeout(client.connect(), 2500);
      await withTimeout(client.ping(), 1500);
      this.status = "connected";
      this.enforced = true;
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.lastErrorAt = Date.now();
      this.status = "error";
      this.enforced = false;
      logger.warn("Redis 连接失败，QPM / TPM 限流降级为不生效（fail-open）", this.lastError);
      // 保留 client，让 ioredis 在后台按 retryStrategy 继续尝试重连。
    }
  }

  statusInfo() {
    return {
      configured: this.configured,
      connected: this.status === "connected",
      status: this.status,
      enforced: this.enforced,
      last_error: this.lastError && Date.now() - this.lastErrorAt < 60_000 ? this.lastError : null,
    };
  }

  /**
   * @returns {Promise<{allowed:boolean, enforced:boolean, degraded?:boolean, reason?:string, limit?:number, remaining?:number, reset_at?:number}>}
   */
  async consume({ apiKeyId, model, tokens }) {
    const qpmLimit = Number(model.qpm_limit) || 0;
    const tpmLimit = Number(model.tpm_limit) || 0;

    if (qpmLimit === 0 && tpmLimit === 0) {
      return { allowed: true, enforced: false, reason: "unlimited", reset_at: Date.now() + WINDOW_MS };
    }
    if (!this.client || this.status !== "connected") {
      return {
        allowed: true,
        enforced: false,
        degraded: this.configured,
        reason: "redis_unavailable",
        reset_at: Date.now() + WINDOW_MS,
      };
    }

    const bucket = Math.floor(Date.now() / WINDOW_MS);
    const resetAt = (bucket + 1) * WINDOW_MS;
    const qpmKey = `${config.redisPrefix}:qpm:${apiKeyId}:${model.id}:${bucket}`;
    const tpmKey = `${config.redisPrefix}:tpm:${apiKeyId}:${model.id}:${bucket}`;
    const cost = Math.max(1, Math.round(tokens));

    try {
      const result = await this.client.eval(
        CONSUME_SCRIPT,
        2,
        qpmKey,
        tpmKey,
        String(qpmLimit),
        String(tpmLimit),
        String(cost),
        String(TTL_SECONDS),
      );
      const code = Number(result[0]);
      const usedQpm = Number(result[1]);
      const usedTpm = Number(result[2]);

      if (code === 1) {
        return {
          allowed: true,
          enforced: true,
          limit: qpmLimit || null,
          remaining: qpmLimit ? Math.max(0, qpmLimit - usedQpm) : null,
          token_limit: tpmLimit || null,
          token_remaining: tpmLimit ? Math.max(0, tpmLimit - usedTpm) : null,
          reset_at: resetAt,
        };
      }

      const reason = code === -1 ? "qpm" : "tpm";
      return {
        allowed: false,
        enforced: true,
        reason,
        limit: qpmLimit || null,
        remaining: qpmLimit ? Math.max(0, qpmLimit - usedQpm) : null,
        token_limit: tpmLimit || null,
        token_remaining: tpmLimit ? Math.max(0, tpmLimit - usedTpm) : null,
        used: reason === "qpm" ? usedQpm : usedTpm,
        reset_at: resetAt,
      };
    } catch (error) {
      this.lastError = error?.message || String(error);
      this.lastErrorAt = Date.now();
      logger.warn("Redis 限流检查失败，本次请求 fail-open", this.lastError);
      return {
        allowed: true,
        enforced: false,
        degraded: true,
        reason: "redis_error",
        reset_at: resetAt,
      };
    }
  }

  async close() {
    if (!this.client) return;
    try {
      await this.client.quit();
    } catch {
      try {
        this.client.disconnect();
      } catch {
        /* ignore */
      }
    }
  }
}

export const rateLimiter = new RateLimiter();

export function rateLimitHeaders(result) {
  const headers = {};
  if (!result) return headers;
  headers["x-mock-ratelimit"] = result.enforced ? "enforced" : result.degraded ? "degraded" : "off";
  if (result.reset_at) headers["x-ratelimit-reset"] = String(Math.max(0, Math.ceil((result.reset_at - Date.now()) / 1000)));
  if (result.enforced) {
    if (result.limit != null) {
      headers["x-ratelimit-limit-requests"] = String(result.limit);
      headers["x-ratelimit-remaining-requests"] = String(result.remaining);
    }
    if (result.token_limit != null) {
      headers["x-ratelimit-limit-tokens"] = String(result.token_limit);
      headers["x-ratelimit-remaining-tokens"] = String(result.token_remaining);
    }
  }
  return headers;
}
