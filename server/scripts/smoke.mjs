import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function readBootstrapKey() {
  try {
    const text = fs.readFileSync(path.join(root, "data", "bootstrap-key.txt"), "utf8");
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.startsWith("mllm_"));
  } catch {
    return "";
  }
}

const base = (process.env.MOCK_BASE_URL || "http://127.0.0.1:8787").replace(/\/+$/, "");
const key = process.env.MOCK_API_KEY || readBootstrapKey();

if (!key) {
  console.error("没有找到 API Key。请设置 MOCK_API_KEY，或确认 data/bootstrap-key.txt 已生成。");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

async function requestJson(pathname, options = {}) {
  const response = await fetch(`${base}${pathname}`, { ...options, headers: { ...headers, ...(options.headers || {}) } });
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`${pathname} -> HTTP ${response.status}: ${data?.error?.message || "unknown error"}`);
  }
  return data;
}

async function main() {
  console.log(`Mock LLM smoke test @ ${base}`);

  const health = await requestJson("/api/v1/health");
  console.log(`✓ health: ${health.service} v${health.version}`);

  const system = await requestJson("/api/v1/system");
  console.log(`✓ system: ${system.counts.models} 模型 / ${system.counts.api_keys} Key / 词表 ${system.vocab.words} 词`);
  console.log(`  redis: ${system.redis.status}（限流 ${system.redis.enforced ? "生效" : "关闭"}）`);

  const models = await requestJson("/v1/models");
  const modelId = process.env.MOCK_MODEL || models.data?.[0]?.id;
  if (!modelId) throw new Error("没有可用模型，请先在管理台创建模型或设置 SEED_DEMO=true");
  console.log(`✓ models: 使用 ${modelId}`);

  const body = {
    model: modelId,
    max_tokens: 64,
    temperature: 0,
    messages: [{ role: "user", content: "smoke test: hello from mock llm server" }],
  };

  const startedAt = performance.now();
  const completion = await requestJson("/v1/chat/completions", { method: "POST", body: JSON.stringify(body) });
  const content = completion.choices?.[0]?.message?.content || "";
  if (!content) throw new Error("非流式响应没有 content");
  console.log(
    `✓ chat: ${completion.usage.completion_tokens} tokens / ${Math.round(performance.now() - startedAt)}ms / cache=${
      completion.mock?.cache_hit ? "hit" : "miss"
    }`,
  );

  const streamResponse = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: true, max_tokens: 32 }),
  });
  if (!streamResponse.ok) {
    const data = await streamResponse.json().catch(() => null);
    throw new Error(`流式请求失败：HTTP ${streamResponse.status} ${data?.error?.message || ""}`);
  }

  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let streamedText = "";
  let firstTokenAt = null;
  let sawDone = false;
  const streamStartedAt = performance.now();

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      for (const line of block.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") {
          sawDone = true;
          continue;
        }
        try {
          const parsed = JSON.parse(payload);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) {
            if (firstTokenAt === null) firstTokenAt = performance.now();
            streamedText += delta;
          }
        } catch {
          /* ignore malformed frame */
        }
      }
    }
  }

  if (!sawDone) throw new Error("流式响应缺少 [DONE]");
  if (!streamedText) throw new Error("流式响应没有内容");
  console.log(
    `✓ stream: ${streamedText.length} chars / TTFT ${firstTokenAt ? Math.round(firstTokenAt - streamStartedAt) : "?"}ms / ${
      Math.round(performance.now() - streamStartedAt)
    }ms`,
  );
  console.log("\n全部通过。");
}

main().catch((error) => {
  console.error(`\n✗ smoke test 失败：${error.message}`);
  process.exitCode = 1;
});
