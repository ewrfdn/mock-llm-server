import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import express from "express";
import { config } from "./config.js";
import { logger } from "./logger.js";
import { newRequestId } from "./lib/ids.js";
import { appErrorBody, openAiErrorBody, zodDetails } from "./lib/errors.js";
import { openaiRouter } from "./routes/openai.js";
import { adminRouter } from "./routes/admin.js";
import { mcpRouter } from "./routes/mcp.js";
import { listSkills, readSkill, skillArchive, SKILL_NAME } from "./mcp/skill.js";

function requestContext(req, res, next) {
  const incoming = req.get("x-request-id");
  req.requestId = incoming && incoming.length <= 100 ? incoming : newRequestId();
  res.setHeader("x-request-id", req.requestId);
  next();
}

function cors(req, res, next) {
  const origin = req.get("origin");
  const configured = config.corsOrigin;
  if (configured === "*") {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  } else {
    res.setHeader("Access-Control-Allow-Origin", configured);
  }
  res.setHeader(
    "Access-Control-Allow-Headers",
    "authorization, content-type, x-api-key, x-request-id, mcp-session-id, mcp-protocol-version, last-event-id",
  );
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader(
    "Access-Control-Expose-Headers",
    "x-request-id, x-mock-model, x-mock-cache, x-mock-plan-ttft-ms, x-mock-plan-tps, x-mock-output-tokens, x-mock-availability-level, x-mock-availability-percent, x-mock-failure-delay-ms, x-mock-ratelimit, x-ratelimit-limit-requests, x-ratelimit-remaining-requests, x-ratelimit-limit-tokens, x-ratelimit-remaining-tokens, x-ratelimit-reset, retry-after",
  );
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
}

function accessLog(req, res, next) {
  if (!config.logRequests) {
    next();
    return;
  }
  const startedAt = performance.now();
  res.on("finish", () => {
    logger.info(`${req.method} ${req.originalUrl} ${res.statusCode} ${Math.round(performance.now() - startedAt)}ms`);
  });
  next();
}

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", true);

  app.use(requestContext);
  app.use(cors);
  app.use(accessLog);

  // MCP 必须在全局 JSON 解析之前挂载：Streamable HTTP 传输层需要自己读取请求体。
  app.use("/mcp", mcpRouter);

  app.use(express.json({ limit: "16mb" }));

  app.get("/api/v1/health", (req, res) => {
    res.json({ ok: true, service: "mock-llm-server", version: config.version, uptime_s: Math.round(process.uptime()) });
  });

  // Skill 文档公开，方便 Agent 在拿到 Key 之前先读取接入说明。
  app.get("/api/v1/skill", (req, res) => {
    const name = typeof req.query.name === "string" ? req.query.name : SKILL_NAME;
    res.json({ name, content: readSkill(name), skills: listSkills() });
  });

  app.get("/api/v1/skill/download", (req, res) => {
    const name = typeof req.query.name === "string" ? req.query.name : SKILL_NAME;
    const archive = skillArchive(name);
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="${name}.zip"`);
    res.setHeader("Content-Length", String(archive.length));
    res.send(archive);
  });

  app.use("/v1", openaiRouter);
  app.use("/api/v1", adminRouter);

  const distDir = config.webDist;
  const hasDist = fs.existsSync(path.join(distDir, "index.html"));

  if (hasDist) {
    app.use(express.static(distDir, { index: false, maxAge: "1y", immutable: true }));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith("/api/") || req.path.startsWith("/v1/") || req.path === "/mcp") {
        next();
        return;
      }
      res.sendFile(path.join(distDir, "index.html"));
    });
  } else {
    app.get("/", (req, res) => {
      res.status(200).json({
        service: "mock-llm-server",
        version: config.version,
        message: "前端尚未构建。开发模式请访问 Vite（默认 http://127.0.0.1:5173），或先运行 npm run build。",
        endpoints: { openai: "/v1", admin: "/api/v1", mcp: "/mcp", skill: "/api/v1/skill" },
      });
    });
  }

  app.use((req, res, next) => {
    if (req.originalUrl.startsWith("/api/") || req.originalUrl.startsWith("/v1/")) {
      res.status(404).json({ error: { code: "not_found", message: `未找到接口 ${req.method} ${req.path}` } });
      return;
    }
    next();
  });

  app.use((req, res) => {
    res.status(404).json({ error: { code: "not_found", message: "Not found" } });
  });

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (res.headersSent) {
      if (!res.writableEnded) res.end();
      return;
    }

    let status = Number(error?.status) || 500;
    let code = typeof error?.code === "string" ? error.code : "internal_error";
    let message = error?.message || "内部错误";
    let details;

    if (error?.name === "ZodError") {
      status = 422;
      code = "validation_error";
      message = "参数校验失败";
      details = zodDetails(error);
    }
    if (error?.type === "entity.parse.failed") {
      status = 400;
      code = "invalid_json";
      message = "请求体不是合法 JSON";
    }
    if (error?.type === "entity.too.large") {
      status = 413;
      code = "payload_too_large";
      message = "请求体过大";
    }

    if (status >= 500) logger.error(`${req.method} ${req.originalUrl} 失败`, error);

    if (req.originalUrl.startsWith("/v1/")) {
      res.status(status).json(
        openAiErrorBody({
          message,
          type: status >= 500 ? "server_error" : status === 401 ? "authentication_error" : "invalid_request_error",
          code: error?.code || null,
        }),
      );
      return;
    }

    res.status(status).json(appErrorBody({ message, code, details }));
  });

  return app;
}
