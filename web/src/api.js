const STORAGE_KEY = "mockllm.apiKey";

export class ApiError extends Error {
  constructor(message, status = 0, code = null, payload = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

export function getToken() {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

export function setToken(token) {
  try {
    if (token) localStorage.setItem(STORAGE_KEY, token);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

export function clearToken() {
  setToken("");
}

function errorMessage(payload, fallback) {
  if (!payload) return fallback;
  if (typeof payload === "string") return payload;
  if (payload.error?.message) return payload.error.message;
  if (typeof payload.error === "string") return payload.error;
  if (payload.message) return payload.message;
  return fallback;
}

async function parseResponse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function request(path, { method = "GET", body, token, headers = {}, signal } = {}) {
  const authToken = token === undefined ? getToken() : token;
  const finalHeaders = { ...headers };
  if (body !== undefined && !finalHeaders["Content-Type"]) finalHeaders["Content-Type"] = "application/json";
  if (authToken) finalHeaders.Authorization = `Bearer ${authToken}`;

  let response;
  try {
    response = await fetch(path, {
      method,
      signal,
      headers: finalHeaders,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    if (error?.name === "AbortError") throw error;
    throw new ApiError(error?.message || "网络请求失败", 0);
  }

  const data = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(
      errorMessage(data, `请求失败（HTTP ${response.status}）`),
      response.status,
      data?.error?.code || null,
      data,
    );
  }
  return data;
}

export function api(path, options = {}) {
  return request(`/api/v1${path}`, options);
}

export function openai(path, options = {}) {
  return request(`/v1${path}`, options);
}

export async function verifyKey(token) {
  return request("/api/v1/auth/whoami", { token });
}

/**
 * 流式 chat/completions。返回 Promise，流结束时 resolve。
 */
export async function streamChat(payload, { signal, onDelta, onUsage, onDone, onEvent, onHeaders } = {}) {
  const token = getToken();
  const response = await fetch("/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      ...payload,
      stream: true,
      stream_options: { include_usage: true },
    }),
  });

  if (!response.ok) {
    const data = await parseResponse(response);
    throw new ApiError(
      errorMessage(data, `请求失败（HTTP ${response.status}）`),
      response.status,
      data?.error?.code || null,
      data,
    );
  }

  onHeaders?.(response.headers);
  if (!response.body) throw new ApiError("当前浏览器不支持流式响应");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;

  const handleBlock = (block) => {
    const dataLines = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    const data = dataLines.join("\n").trim();
    if (!data) return;
    if (data === "[DONE]") {
      if (!finished) {
        finished = true;
        onDone?.();
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    onEvent?.(parsed);
    const delta = parsed.choices?.[0]?.delta?.content;
    if (typeof delta === "string" && delta) onDelta?.(delta);
    if (parsed.usage) onUsage?.(parsed.usage);
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
    let index;
    while ((index = buffer.indexOf("\n\n")) >= 0) {
      const block = buffer.slice(0, index);
      buffer = buffer.slice(index + 2);
      handleBlock(block);
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) handleBlock(buffer);
  if (!finished) {
    finished = true;
    onDone?.();
  }
}
