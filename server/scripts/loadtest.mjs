import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
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

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const base = (arg("base", process.env.MOCK_BASE_URL || "http://127.0.0.1:8787")).replace(/\/+$/, "");
const key = arg("key", process.env.MOCK_API_KEY || readBootstrapKey());
const total = Math.max(1, Number(arg("requests", 200)));
const concurrency = Math.max(1, Number(arg("concurrency", 50)));
const maxTokens = Math.max(1, Number(arg("max-tokens", 64)));
const stream = process.argv.includes("--stream");

if (!key) {
  console.error("没有找到 API Key。请设置 MOCK_API_KEY，或确认 data/bootstrap-key.txt 已生成。");
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${key}`,
  "Content-Type": "application/json",
};

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

async function pickModel() {
  const explicit = arg("model", process.env.MOCK_MODEL || "");
  if (explicit) return explicit;
  const response = await fetch(`${base}/v1/models`, { headers });
  const data = await response.json().catch(() => null);
  if (!response.ok) throw new Error(`获取模型失败：HTTP ${response.status} ${data?.error?.message || ""}`);
  const model = data?.data?.[0]?.id;
  if (!model) throw new Error("没有可用模型");
  return model;
}

async function oneRequest(model) {
  const startedAt = performance.now();
  const body = {
    model,
    max_tokens: maxTokens,
    temperature: 0,
    messages: [{ role: "user", content: `load test ${Math.random().toString(36).slice(2)}` }],
  };

  if (!stream) {
    const response = await fetch(`${base}/v1/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const error = new Error(data?.error?.message || `HTTP ${response.status}`);
      error.status = response.status;
      error.code = data?.error?.code;
      throw error;
    }
    return {
      ms: performance.now() - startedAt,
      ttft: data?.mock?.ttft_ms ?? null,
      tokens: data?.usage?.completion_tokens || 0,
    };
  }

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers,
    body: JSON.stringify({ ...body, stream: true }),
  });
  if (!response.ok) {
    const data = await response.json().catch(() => null);
    const error = new Error(data?.error?.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = data?.error?.code;
    throw error;
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let firstAt = null;
  let chars = 0;
  let buffer = "";
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
        if (payload === "[DONE]") continue;
        try {
          const delta = JSON.parse(payload).choices?.[0]?.delta?.content;
          if (delta) {
            if (firstAt === null) firstAt = performance.now();
            chars += delta.length;
          }
        } catch {
          /* ignore */
        }
      }
    }
  }
  return {
    ms: performance.now() - startedAt,
    ttft: firstAt === null ? null : firstAt - startedAt,
    tokens: Math.ceil(chars / 4),
  };
}

async function main() {
  const model = await pickModel();
  console.log(`Load test ${base} → ${model}`);
  console.log(`requests=${total} concurrency=${concurrency} max_tokens=${maxTokens} stream=${stream}`);

  let nextIndex = 0;
  const latencies = [];
  const ttfts = [];
  let tokens = 0;
  let success = 0;
  const failures = new Map();
  const startedAt = performance.now();

  const worker = async () => {
    while (true) {
      const current = nextIndex;
      nextIndex += 1;
      if (current >= total) return;
      try {
        const result = await oneRequest(model);
        success += 1;
        tokens += result.tokens;
        latencies.push(result.ms);
        if (result.ttft !== null) ttfts.push(result.ttft);
      } catch (error) {
        const key = `${error.status || 0} ${error.code || "error"}: ${String(error.message).slice(0, 100)}`;
        failures.set(key, (failures.get(key) || 0) + 1);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, worker));

  const wallMs = performance.now() - startedAt;
  latencies.sort((a, b) => a - b);
  ttfts.sort((a, b) => a - b);

  console.log("\n结果");
  console.log(`  成功 / 失败: ${success} / ${total - success}`);
  console.log(`  墙钟时间: ${(wallMs / 1000).toFixed(2)}s`);
  console.log(`  RPS: ${(total / (wallMs / 1000)).toFixed(1)}`);
  console.log(`  输出 token: ${tokens}（${(tokens / (wallMs / 1000)).toFixed(0)} tok/s 聚合）`);
  if (latencies.length) {
    console.log(
      `  延迟 p50/p95/p99: ${percentile(latencies, 0.5).toFixed(0)} / ${percentile(latencies, 0.95).toFixed(0)} / ${percentile(
        latencies,
        0.99,
      ).toFixed(0)} ms`,
    );
  }
  if (ttfts.length) {
    console.log(`  TTFT p50/p95: ${percentile(ttfts, 0.5).toFixed(0)} / ${percentile(ttfts, 0.95).toFixed(0)} ms`);
  }
  if (failures.size) {
    console.log("  失败分组:");
    for (const [reason, count] of failures) console.log(`    ${count} × ${reason}`);
  }
}

main().catch((error) => {
  console.error(`压测失败：${error.message}`);
  process.exitCode = 1;
});
