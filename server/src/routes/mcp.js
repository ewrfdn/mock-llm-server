import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "../mcp/server.js";
import { logger } from "../logger.js";

export const mcpRouter = express.Router();

mcpRouter.use(express.json({ limit: "4mb" }));

function methodNotAllowed(req, res) {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed. This stateless MCP endpoint only accepts POST /mcp." },
    id: null,
  });
}

mcpRouter.post("/", async (req, res) => {
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });

  let closed = false;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    Promise.resolve(transport.close()).catch(() => {});
    Promise.resolve(server.close()).catch(() => {});
  };
  res.on("close", cleanup);

  try {
    // 部分客户端只发 Accept: */*；SDK 会校验 Streamable HTTP 的 Accept 组合。
    if (!req.headers.accept || req.headers.accept === "*/*") {
      req.headers.accept = "application/json, text/event-stream";
    }
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    logger.error("MCP 请求失败", error?.message || error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal MCP server error" },
        id: null,
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
});

mcpRouter.get("/", methodNotAllowed);
mcpRouter.delete("/", methodNotAllowed);
