import { useCallback, useEffect, useRef, useState } from "react";
import { openai, streamChat } from "../api.js";
import {
  Badge,
  EmptyState,
  Field,
  Icon,
  PageHeader,
  Spinner,
  Switch,
  useToast,
} from "../components/ui.jsx";
import { formatMs, formatNumber, formatTps } from "../lib/format.js";

const DEFAULT_PROMPT = "用三句话解释什么是 mock LLM server，以及它适合用来做什么测试。";

function percentile(sorted, ratio) {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * ratio) - 1));
  return sorted[index];
}

export default function Playground({ session }) {
  const { push } = useToast();
  const [tab, setTab] = useState("single");
  const [models, setModels] = useState([]);
  const [modelId, setModelId] = useState("");
  const [prompt, setPrompt] = useState(DEFAULT_PROMPT);
  const [maxTokens, setMaxTokens] = useState("");
  const [temperature, setTemperature] = useState("0.7");
  const [stream, setStream] = useState(true);
  const [running, setRunning] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  const [metrics, setMetrics] = useState(null);
  const [elapsed, setElapsed] = useState(0);

  const [burstCount, setBurstCount] = useState("20");
  const [burstMaxTokens, setBurstMaxTokens] = useState("128");
  const [burstRunning, setBurstRunning] = useState(false);
  const [burstResult, setBurstResult] = useState(null);

  const controllerRef = useRef(null);
  const outputRef = useRef(null);
  const startedRef = useRef(0);
  const firstTokenRef = useRef(null);
  const usageRef = useRef(null);
  const finishRef = useRef("");
  const cacheRef = useRef(false);
  const timerRef = useRef(null);

  useEffect(() => {
    openai("/models")
      .then((data) => {
        setModels(data.data || []);
        setModelId((current) => current || data.data?.[0]?.id || "");
      })
      .catch((requestError) => setError(requestError.message));
  }, []);

  useEffect(() => {
    if (outputRef.current) outputRef.current.scrollTop = outputRef.current.scrollHeight;
  }, [text]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  const selectedModel = models.find((model) => model.id === modelId);
  const availability = selectedModel?.mock;

  const stop = useCallback(() => {
    controllerRef.current?.abort();
  }, []);

  const clearAll = () => {
    setText("");
    setError("");
    setMetrics(null);
    setElapsed(0);
  };

  const send = async () => {
    if (!modelId) {
      setError("请选择模型");
      return;
    }
    if (!prompt.trim()) {
      setError("请输入提示词");
      return;
    }
    if (!session.can_inference) {
      setError("当前 Key 没有 inference 权限，无法调用 /v1 推理接口");
      return;
    }

    setRunning(true);
    setError("");
    setText("");
    setMetrics(null);
    setElapsed(0);
    usageRef.current = null;
    finishRef.current = "";
    cacheRef.current = false;
    firstTokenRef.current = null;

    const started = performance.now();
    startedRef.current = started;
    const controller = new AbortController();
    controllerRef.current = controller;
    clearInterval(timerRef.current);
    timerRef.current = setInterval(() => setElapsed(performance.now() - started), 100);

    const body = {
      model: modelId,
      messages: [{ role: "user", content: prompt }],
      temperature: Number(temperature) || 0,
    };
    if (maxTokens) body.max_tokens = Number(maxTokens);

    try {
      let ttft = null;

      if (stream) {
        await streamChat(body, {
          signal: controller.signal,
          onHeaders: (headers) => {
            cacheRef.current = headers.get("x-mock-cache") === "hit";
          },
          onEvent: (payload) => {
            const reason = payload.choices?.[0]?.finish_reason;
            if (reason) finishRef.current = reason;
          },
          onDelta: (delta) => {
            if (firstTokenRef.current === null) firstTokenRef.current = performance.now();
            setText((current) => current + delta);
          },
          onUsage: (usage) => {
            usageRef.current = usage;
          },
        });
        ttft = firstTokenRef.current === null ? null : firstTokenRef.current - started;
      } else {
        const response = await openai("/chat/completions", { method: "POST", body });
        const content = response.choices?.[0]?.message?.content || "";
        usageRef.current = response.usage || null;
        finishRef.current = response.choices?.[0]?.finish_reason || "";
        cacheRef.current = Boolean(response.mock?.cache_hit);
        ttft = response.mock?.ttft_ms ?? null;
        setText(content);
      }

      const ended = performance.now();
      const usage = usageRef.current;
      const completion = usage?.completion_tokens ?? 0;
      const outputMs = ttft === null ? ended - started : ended - started - ttft;
      setMetrics({
        ttft,
        total: ended - started,
        promptTokens: usage?.prompt_tokens ?? 0,
        completionTokens: completion,
        tps: outputMs > 0 ? completion / (outputMs / 1000) : null,
        cached: cacheRef.current,
        finish: finishRef.current || (stream ? "stop" : ""),
      });
      setElapsed(ended - started);
    } catch (requestError) {
      if (requestError.name === "AbortError") {
        push("已停止生成", "info");
      } else {
        setError(requestError.message);
        if (firstTokenRef.current !== null) {
          setMetrics((current) => current || { ttft: firstTokenRef.current - started, total: performance.now() - started, completionTokens: 0 });
        }
      }
    } finally {
      clearInterval(timerRef.current);
      setRunning(false);
      controllerRef.current = null;
    }
  };

  const runBurst = async () => {
    const count = Math.max(1, Math.min(200, Math.floor(Number(burstCount) || 20)));
    const tokens = Math.max(1, Math.min(2048, Math.floor(Number(burstMaxTokens) || 128)));
    if (!modelId) {
      setError("请先选择模型");
      return;
    }
    if (!session.can_inference) {
      setError("当前 Key 没有 inference 权限");
      return;
    }

    setBurstRunning(true);
    setBurstResult(null);
    const started = performance.now();
    const results = await Promise.allSettled(
      Array.from({ length: count }, async (_, index) => {
        const requestStarted = performance.now();
        const response = await openai("/chat/completions", {
          method: "POST",
          body: {
            model: modelId,
            max_tokens: tokens,
            temperature: 0,
            messages: [{ role: "user", content: `并发探针 #${index + 1}：${prompt.slice(0, 240)}` }],
          },
        });
        return {
          ms: performance.now() - requestStarted,
          tokens: response.usage?.completion_tokens || 0,
          ttft: response.mock?.ttft_ms ?? null,
        };
      }),
    );

    const wallMs = performance.now() - started;
    const ok = results.filter((item) => item.status === "fulfilled").map((item) => item.value);
    const failures = results.filter((item) => item.status === "rejected").map((item) => item.reason);
    const durations = ok.map((item) => item.ms).sort((a, b) => a - b);
    const totalTokens = ok.reduce((sum, item) => sum + item.tokens, 0);
    const failureGroups = failures.reduce((groups, failure) => {
      const key = `${failure?.status || 0} · ${failure?.code || failure?.name || "error"} · ${failure?.message || "未知错误"}`;
      groups[key] = (groups[key] || 0) + 1;
      return groups;
    }, {});

    setBurstResult({
      count,
      wallMs,
      success: ok.length,
      failed: failures.length,
      p50: percentile(durations, 0.5),
      p95: percentile(durations, 0.95),
      avg: durations.length ? durations.reduce((sum, value) => sum + value, 0) / durations.length : 0,
      totalTokens,
      tps: wallMs > 0 ? totalTokens / (wallMs / 1000) : 0,
      failureGroups: Object.entries(failureGroups).map(([message, value]) => ({ message, count: value })),
    });
    setBurstRunning(false);
  };

  return (
    <>
      <PageHeader
        title="调试台"
        description="直接请求 OpenAI 兼容接口，观察采样出来的 TTFT、TPS、缓存与限流行为。"
        actions={
          <div className="tabs">
            <button type="button" className={tab === "single" ? "tab active" : "tab"} onClick={() => setTab("single")}>
              单次调试
            </button>
            <button type="button" className={tab === "burst" ? "tab active" : "tab"} onClick={() => setTab("burst")}>
              并发测试
            </button>
          </div>
        }
      />

      {!session.can_inference ? (
        <div className="alert alert-warn">
          <Icon name="alert" size={16} />
          <span>当前 Key 只有管理权限，没有 inference scope，无法调用 /v1。请使用同时包含 admin 和 inference 的 Key。</span>
        </div>
      ) : null}

      {tab === "single" ? (
        <div className="playground-grid">
          <section className="card controls-card">
            <div className="card-head">
              <div>
                <h2>请求参数</h2>
                <p>流式请求会实时展示 token 产出。</p>
              </div>
              <Badge tone={stream ? "accent" : "default"}>{stream ? "SSE 流式" : "一次性 JSON"}</Badge>
            </div>

            <Field label="模型">
              <select className="input" value={modelId} onChange={(event) => setModelId(event.target.value)}>
                {models.length === 0 ? <option value="">暂无可用模型</option> : null}
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </Field>

            {availability ? (
              <div className="model-inline">
                <span>输出 {formatNumber(availability.output_tokens_min)}–{formatNumber(availability.output_tokens_max)} tok</span>
                <span>TPS {availability.tps_min}–{availability.tps_max}</span>
                <span>TTFT {availability.ttft_ms_min}–{availability.ttft_ms_max}ms</span>
                <span>缓存 {availability.cache_hit_rate_min}–{availability.cache_hit_rate_max}%</span>
                <span>L{availability.availability_level}</span>
              </div>
            ) : null}

            <Field label="提示词">
              <textarea
                className="input textarea"
                rows={6}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="输入要发送给模型的 user message"
              />
            </Field>

            <div className="form-grid compact">
              <Field
                label="max_tokens"
                hint={
                  maxTokens
                    ? `当前请求上限 ${maxTokens} tokens；超过模型抽样值时才截断，点 × 使用模型输出范围`
                    : "留空：使用模型的输出范围，每次请求随机抽样"
                }
              >
                <div className="input-with-action">
                  <input
                    className="input"
                    type="number"
                    min="1"
                    value={maxTokens}
                    onChange={(event) => setMaxTokens(event.target.value)}
                    placeholder="模型默认范围"
                  />
                  {maxTokens ? (
                    <button
                      type="button"
                      className="icon-btn input-action"
                      onClick={() => setMaxTokens("")}
                      title="使用模型输出范围"
                      aria-label="使用模型输出范围"
                    >
                      <Icon name="x" size={14} />
                    </button>
                  ) : null}
                </div>
              </Field>
              <Field label="temperature">
                <input
                  className="input"
                  type="number"
                  step="0.1"
                  min="0"
                  max="2"
                  value={temperature}
                  onChange={(event) => setTemperature(event.target.value)}
                />
              </Field>
            </div>

            <div className="control-row">
              <Switch checked={stream} onChange={setStream} label="流式响应" />
              <div className="row">
                {running ? (
                  <button type="button" className="btn btn-danger" onClick={stop}>
                    <Icon name="stop" size={15} />
                    停止
                  </button>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={send}>
                    <Icon name="send" size={15} />
                    发送请求
                  </button>
                )}
                <button type="button" className="btn btn-ghost" onClick={clearAll} disabled={running}>
                  清空
                </button>
              </div>
            </div>

            <p className="hint">
              请求会消耗该 Key 的 QPM/TPM 额度（Redis 已连接时）。模型范围会在每次请求时重新抽样。
            </p>
          </section>

          <section className="card output-card">
            <div className="card-head">
              <div>
                <h2>响应</h2>
                <p>{running ? "正在生成…" : metrics ? "生成完成" : "等待请求"}</p>
              </div>
              <div className="row">
                {metrics?.cached ? <Badge tone="accent">缓存 HIT</Badge> : null}
                {metrics?.finish ? <Badge tone={metrics.finish === "length" ? "warn" : "ok"}>{metrics.finish}</Badge> : null}
                {running ? <Spinner size={16} /> : null}
              </div>
            </div>

            {error ? (
              <div className="alert alert-error">
                <Icon name="alert" size={16} />
                <span>{error}</span>
              </div>
            ) : null}

            {metrics ? (
              <div className="metric-strip">
                <div>
                  <span>TTFT</span>
                  <strong>{formatMs(metrics.ttft)}</strong>
                </div>
                <div>
                  <span>总耗时</span>
                  <strong>{formatMs(metrics.total)}</strong>
                </div>
                <div>
                  <span>输出 token</span>
                  <strong>{formatNumber(metrics.completionTokens)}</strong>
                </div>
                <div>
                  <span>TPS</span>
                  <strong>{formatTps(metrics.tps)}</strong>
                </div>
                <div>
                  <span>输入 token</span>
                  <strong>{formatNumber(metrics.promptTokens)}</strong>
                </div>
              </div>
            ) : (
              <div className="metric-strip subtle">
                <div>
                  <span>已用时</span>
                  <strong>{formatMs(elapsed)}</strong>
                </div>
                <div>
                  <span>模型</span>
                  <strong className="mono">{modelId || "—"}</strong>
                </div>
              </div>
            )}

            <pre ref={outputRef} className={`stream-output ${text ? "" : "empty"}`}>
              {text || (running ? "等待首个 token…" : "输出会显示在这里。点击「发送请求」开始。")}
            </pre>

            {metrics?.completionTokens ? (
              <div className="output-foot">
                <span>
                  实测 {formatNumber(metrics.completionTokens)} tokens / {(metrics.total / 1000).toFixed(2)}s
                </span>
                <span className="muted">客户端计时，包含网络与调度抖动</span>
              </div>
            ) : null}
          </section>
        </div>
      ) : (
        <div className="burst-grid">
          <section className="card controls-card">
            <div className="card-head">
              <div>
                <h2>并发压测</h2>
                <p>一次性发出 N 个非流式请求，观察限流与调度表现。</p>
              </div>
              <Badge tone="default">非流式</Badge>
            </div>

            <Field label="模型">
              <select className="input" value={modelId} onChange={(event) => setModelId(event.target.value)}>
                {models.map((model) => (
                  <option key={model.id} value={model.id}>
                    {model.id}
                  </option>
                ))}
              </select>
            </Field>

            <div className="form-grid compact">
              <Field label="并发数" hint="1 - 200">
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="200"
                  value={burstCount}
                  onChange={(event) => setBurstCount(event.target.value)}
                />
              </Field>
              <Field label="每次 max_tokens" hint="建议 64 - 512，避免压测时间过长">
                <input
                  className="input"
                  type="number"
                  min="1"
                  max="2048"
                  value={burstMaxTokens}
                  onChange={(event) => setBurstMaxTokens(event.target.value)}
                />
              </Field>
            </div>

            <Field label="探针提示词">
              <textarea
                className="input textarea"
                rows={3}
                value={prompt}
                onChange={(event) => setPrompt(event.target.value)}
              />
            </Field>

            <button type="button" className="btn btn-primary" onClick={runBurst} disabled={burstRunning || !models.length}>
              {burstRunning ? <Spinner size={15} /> : <Icon name="zap" size={15} />}
              {burstRunning ? "压测中…" : "开始压测"}
            </button>

            <p className="hint">
              并发请求会同时占用 QPM/TPM 额度。Redis 未配置时限流关闭，全部请求会正常进入生成调度。
            </p>
          </section>

          <section className="card">
            <div className="card-head">
              <div>
                <h2>压测结果</h2>
                <p>成功、失败与延迟分位数。</p>
              </div>
              {burstResult ? <Badge tone={burstResult.failed ? "warn" : "ok"}>{burstResult.success}/{burstResult.count} 成功</Badge> : null}
            </div>

            {!burstResult ? (
              <EmptyState
                icon="zap"
                title="还没有压测结果"
                description="设置并发数后点击「开始压测」，这里会展示延迟分位数和失败原因。"
              />
            ) : (
              <>
                <div className="stat-grid small">
                  <div className="stat-card tone-default">
                    <div className="stat-label">墙钟时间</div>
                    <div className="stat-value">{formatMs(burstResult.wallMs)}</div>
                    <div className="stat-sub">{formatTps(burstResult.tps)} 聚合吞吐</div>
                  </div>
                  <div className="stat-card tone-default">
                    <div className="stat-label">P50 / P95</div>
                    <div className="stat-value">{formatMs(burstResult.p50)}</div>
                    <div className="stat-sub">P95 {formatMs(burstResult.p95)}</div>
                  </div>
                  <div className="stat-card tone-default">
                    <div className="stat-label">平均耗时</div>
                    <div className="stat-value">{formatMs(burstResult.avg)}</div>
                    <div className="stat-sub">输出 {formatNumber(burstResult.totalTokens)} tokens</div>
                  </div>
                  <div className={`stat-card ${burstResult.failed ? "tone-warn" : "tone-ok"}`}>
                    <div className="stat-label">失败</div>
                    <div className="stat-value">{formatNumber(burstResult.failed)}</div>
                    <div className="stat-sub">{burstResult.failed ? "查看下方错误分组" : "全部成功"}</div>
                  </div>
                </div>

                {burstResult.failureGroups.length ? (
                  <div className="failure-list">
                    {burstResult.failureGroups.map((group) => (
                      <div key={group.message} className="failure-item">
                        <Badge tone="danger">{group.count} 次</Badge>
                        <span className="mono">{group.message}</span>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="alert alert-success">
                    <Icon name="check" size={16} />
                    <span>所有并发请求均成功，未触发可用性故障或限流。</span>
                  </div>
                )}
              </>
            )}
          </section>
        </div>
      )}
    </>
  );
}
