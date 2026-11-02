import http from "node:http";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { createApp } from "./app.js";
import { seedDemoModels, ensureBootstrapKey } from "./db/seed.js";
import { rateLimiter } from "./ratelimit/index.js";
import { flushRequests, pruneRequests } from "./domain/usage.js";
import { streamScheduler } from "./simulation/scheduler.js";
import { closeDatabase } from "./db/index.js";
import { getVocabStats } from "./simulation/vocab.js";

async function main() {
  seedDemoModels();
  const bootstrap = ensureBootstrapKey();

  await rateLimiter.init();

  const app = createApp();
  const server = http.createServer(app);
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.timeout = 0;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, config.host, resolve);
  });

  const address = server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  const baseUrl = config.publicBaseUrl.includes(`:${config.port}`)
    ? config.publicBaseUrl.replace(`:${config.port}`, `:${port}`)
    : config.publicBaseUrl;

  logger.info(`Mock LLM Server v${config.version} 已启动`);
  logger.info(`  API     ${baseUrl}/v1`);
  logger.info(`  管理台  ${baseUrl}`);
  logger.info(`  MCP     ${baseUrl}/mcp`);
  logger.info(`  Skill   ${baseUrl}/api/v1/skill`);
  logger.info(`  Redis   ${rateLimiter.statusInfo().enforced ? "已连接（QPM/TPM 生效）" : "未生效（未配置或连接失败）"}`);
  logger.info(`  词表    ${getVocabStats().words} 词 / ${config.dbPath}`);

  if (bootstrap) {
    logger.info("────────────────────────────────────────────────────────────");
    logger.info(`首次启动，已生成管理 Key（同时写入 ${bootstrap.file}）：`);
    logger.info(bootstrap.token);
    logger.info("请用该 Key 登录管理台；数据库只保存哈希，登录后可再创建更多 Key。");
    logger.info("────────────────────────────────────────────────────────────");
  }

  const pruneTimer = setInterval(() => {
    try {
      const removed = pruneRequests();
      if (removed > 0) logger.info(`已清理 ${removed} 条过期请求记录`);
    } catch (error) {
      logger.warn("清理请求记录失败", error?.message);
    }
  }, 5 * 60 * 1000);
  pruneTimer.unref?.();

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info(`收到 ${signal}，正在关闭...`);
    clearInterval(pruneTimer);
    streamScheduler.stop();
    server.close();
    flushRequests();
    await rateLimiter.close();
    closeDatabase();
    setTimeout(() => process.exit(0), 100).unref?.();
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => logger.error("未处理的 Promise 拒绝", reason));
  process.on("uncaughtException", (error) => logger.error("未捕获异常", error));
}

main().catch((error) => {
  logger.error("服务启动失败", error);
  process.exit(1);
});
