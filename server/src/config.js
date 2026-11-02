import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(here, "..");
export const PROJECT_ROOT = path.resolve(SERVER_ROOT, "..");

// 支持仓库根目录 .env 与 server/.env 两层配置，后者不覆盖前者。
dotenv.config({ path: path.join(PROJECT_ROOT, ".env") });
dotenv.config({ path: path.join(SERVER_ROOT, ".env"), override: false });

const number = (value, fallback) => {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const boolean = (value, fallback = false) => {
  if (value === undefined || value === null || value === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
};

const resolveFromRoot = (value) =>
  path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);

const dataDir = resolveFromRoot(process.env.DATA_DIR?.trim() || "data");
const dbPath = process.env.DB_PATH?.trim()
  ? resolveFromRoot(process.env.DB_PATH.trim())
  : path.join(dataDir, "mock-llm.db");
const host = process.env.HOST?.trim() || "127.0.0.1";
const port = number(process.env.PORT, 8787);
const publicBaseUrl = (process.env.PUBLIC_BASE_URL?.trim() || `http://${host === "0.0.0.0" ? "localhost" : host}:${port}`).replace(/\/+$/, "");

export const config = Object.freeze({
  version: "1.0.0",

  host,
  port,
  publicBaseUrl,
  dataDir,
  dbPath,
  webDist: path.join(PROJECT_ROOT, "web", "dist"),
  skillsDir: path.join(SERVER_ROOT, "skills"),

  redisUrl: process.env.REDIS_URL?.trim() || "",
  redisPrefix: process.env.REDIS_PREFIX?.trim() || "mockllm",

  bootstrapApiKey: process.env.BOOTSTRAP_API_KEY?.trim() || "",
  seedDemo: boolean(process.env.SEED_DEMO, true),

  maxOutputTokens: Math.max(1, Math.floor(number(process.env.MAX_OUTPUT_TOKENS, 1_000_000))),
  cacheTtlMs: Math.max(0, number(process.env.CACHE_TTL_MS, 10 * 60 * 1000)),
  cacheMaxEntries: Math.max(1, Math.floor(number(process.env.CACHE_MAX_ENTRIES, 300))),
  cacheMaxChars: Math.max(0, Math.floor(number(process.env.CACHE_MAX_CHARS, 200_000))),

  requestsRetention: Math.max(100, Math.floor(number(process.env.REQUESTS_RETENTION, 20_000))),
  logRequests: boolean(process.env.LOG_REQUESTS, false),
  logLevel: process.env.LOG_LEVEL?.trim() || "info",
  corsOrigin: process.env.CORS_ORIGIN?.trim() || "*",

  // 流式生成调度的 tick 间隔（毫秒）。所有并发流共用一个定时器。
  tickMs: 20,
});
