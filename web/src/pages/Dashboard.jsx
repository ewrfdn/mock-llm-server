import { useCallback, useEffect, useState } from "react";
import { api } from "../api.js";
import { Badge, CopyButton, EmptyState, Icon, PageHeader, Sparkline, Spinner, useToast } from "../components/ui.jsx";
import {
  compactNumber,
  formatDateTime,
  formatMs,
  formatNumber,
  formatPercent,
  formatTps,
  formatUptime,
  timeAgo,
} from "../lib/format.js";

const ORIGIN = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8787";

const CURL_EXAMPLE = `curl ${ORIGIN}/v1/chat/completions \\
  -H "Authorization: Bearer $MOCK_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "mock-fast",
    "stream": true,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;

function StatCard({ icon, label, value, sub, tone = "default" }) {
  return (
    <div className={`stat-card tone-${tone}`}>
      <div className="stat-icon">
        <Icon name={icon} size={18} />
      </div>
      <div className="stat-label">{label}</div>
      <div className="stat-value">{value}</div>
      <div className="stat-sub">{sub}</div>
    </div>
  );
}

function redisState(redis) {
  if (!redis) return { tone: "default", label: "未知", detail: "尚未读取系统状态" };
  if (redis.enforced) return { tone: "ok", label: "已连接", detail: "QPM / TPM 限流生效" };
  if (redis.configured) return { tone: "warn", label: "连接失败", detail: "fail-open：服务可用，但限流暂不生效" };
  return { tone: "default", label: "未配置", detail: "不配置 Redis 时限流不生效，服务正常可用" };
}

export default function Dashboard({ session }) {
  const { push } = useToast();
  const [stats, setStats] = useState(null);
  const [system, setSystem] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const [statsData, systemData] = await Promise.all([api("/stats?window=24h"), api("/system")]);
        setStats(statsData);
        setSystem(systemData);
        setError("");
      } catch (requestError) {
        setError(requestError.message);
        if (!silent) push(requestError.message, "error");
      } finally {
        if (!silent) setLoading(false);
      }
    },
    [push],
  );

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const timer = setInterval(() => load(true), 30000);
    return () => clearInterval(timer);
  }, [load]);

  const overview = stats?.overview || {};
  const series = stats?.series || [];
  const recent = stats?.recent || [];
  const models = stats?.models || [];
  const redis = redisState(system?.redis);
  const seriesMax = Math.max(1, ...series.map((point) => point.requests));
  const seriesTotal = series.reduce((sum, point) => sum + point.requests, 0);

  return (
    <>
      <PageHeader
        title="概览"
        description={`过去 24 小时的服务表现 · ${session.key?.name || "admin"}`}
        actions={
          <button type="button" className="btn btn-ghost" onClick={() => load()} disabled={loading}>
            {loading ? <Spinner size={15} /> : <Icon name="refresh" size={15} />}
            刷新
          </button>
        }
      />

      {error ? (
        <div className="alert alert-error">
          <Icon name="alert" size={16} />
          <span>{error}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => load()}>
            重试
          </button>
        </div>
      ) : null}

      <div className="stat-grid">
        <StatCard
          icon="activity"
          label="24h 请求"
          value={formatNumber(overview.requests)}
          sub={`${formatNumber(overview.errors)} 次错误 · ${formatPercent(overview.error_rate)}`}
        />
        <StatCard
          icon="zap"
          label="24h Token"
          value={compactNumber(overview.tokens)}
          sub={`输入 ${compactNumber(overview.prompt_tokens)} · 输出 ${compactNumber(overview.completion_tokens)}`}
        />
        <StatCard
          icon="clock"
          label="平均 TTFT"
          value={formatMs(overview.avg_ttft_ms)}
          sub="仅统计未命中缓存的成功请求"
        />
        <StatCard
          icon="gauge"
          label="平均 TPS"
          value={formatTps(overview.avg_tps)}
          sub="按实际完成时间折算"
        />
        <StatCard
          icon="layers"
          label="缓存命中率"
          value={formatPercent(overview.cache_hit_rate)}
          sub={`${formatNumber(overview.cache_hits)} 次命中`}
        />
        <StatCard
          icon="alert"
          label="错误率"
          value={formatPercent(overview.error_rate)}
          sub={`${formatNumber(overview.errors)} 次失败 / ${formatNumber(overview.requests)} 次请求`}
          tone={overview.errors > 0 ? "warn" : "default"}
        />
      </div>

      <div className="dashboard-grid">
        <section className="card chart-card">
          <div className="card-head">
            <div>
              <h2>最近 60 分钟请求</h2>
              <p>每分钟聚合一次，用于观察突发流量与限流效果。</p>
            </div>
            <Badge tone="default">{formatNumber(seriesTotal)} 次</Badge>
          </div>
          {series.length ? (
            <>
              <Sparkline values={series.map((point) => point.requests)} height={120} />
              <div className="chart-axis">
                <span>{series[0] ? new Date(series[0].t).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }) : ""}</span>
                <span>峰值 {formatNumber(seriesMax)} 次/分</span>
                <span>现在</span>
              </div>
            </>
          ) : (
            <EmptyState icon="activity" title="还没有请求" description="去调试台发一条消息，统计会实时出现。" />
          )}
        </section>

        <section className="card system-card">
          <div className="card-head">
            <div>
              <h2>系统状态</h2>
              <p>限流、词表与缓存运行信息。</p>
            </div>
            <Badge tone={redis.tone} dot>
              Redis {redis.label}
            </Badge>
          </div>

          <div className="kv-list">
            <div className="kv">
              <span>Redis 限流</span>
              <strong className={redis.tone === "warn" ? "text-warn" : ""}>{redis.detail}</strong>
            </div>
            <div className="kv">
              <span>词表</span>
              <strong>{system ? `${formatNumber(system.vocab.words)} 词 · 平均 ${system.vocab.average_tokens_per_word} tok/词` : "—"}</strong>
            </div>
            <div className="kv">
              <span>模拟缓存</span>
              <strong>{system ? `${formatNumber(system.cache.entries)} 条` : "—"}</strong>
            </div>
            <div className="kv">
              <span>活跃流</span>
              <strong>{system ? formatNumber(system.active_streams) : "—"}</strong>
            </div>
            <div className="kv">
              <span>数据库</span>
              <strong className="mono">{system?.db?.driver || "—"}</strong>
            </div>
            <div className="kv">
              <span>运行时长</span>
              <strong>{system ? formatUptime(system.uptime_s) : "—"}</strong>
            </div>
            <div className="kv">
              <span>Node</span>
              <strong>{system?.node || "—"}</strong>
            </div>
          </div>

          <div className="system-foot">
            <Icon name="database" size={14} />
            <span className="mono ellipsis" title={system?.db?.path}>
              {system?.db?.path || "data/mock-llm.db"}
            </span>
          </div>
        </section>
      </div>

      <div className="dashboard-grid">
        <section className="card">
          <div className="card-head">
            <div>
              <h2>模型用量</h2>
              <p>按模型聚合的 24 小时请求与性能。</p>
            </div>
            <Badge tone="default">{models.length} 个模型有请求</Badge>
          </div>
          {models.length ? (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>模型</th>
                    <th className="num">请求</th>
                    <th className="num">Token</th>
                    <th className="num">TTFT</th>
                    <th className="num">TPS</th>
                    <th className="num">缓存命中</th>
                  </tr>
                </thead>
                <tbody>
                  {models.map((model) => (
                    <tr key={model.model_id}>
                      <td className="mono">{model.model_id}</td>
                      <td className="num">{formatNumber(model.requests)}</td>
                      <td className="num">{compactNumber(model.tokens)}</td>
                      <td className="num">{formatMs(model.avg_ttft_ms)}</td>
                      <td className="num">{formatTps(model.avg_tps)}</td>
                      <td className="num">
                        {formatNumber(model.cache_hits)}
                        {model.errors > 0 ? <span className="text-danger"> · {model.errors} 错误</span> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState icon="models" title="暂无模型用量" description="创建模型并在调试台发起请求后即可看到聚合数据。" />
          )}
        </section>

        <section className="card quickstart-card">
          <div className="card-head">
            <div>
              <h2>快速开始</h2>
              <p>用任意 OpenAI SDK 指向本服务。</p>
            </div>
            <CopyButton text={CURL_EXAMPLE} label="复制 cURL" />
          </div>
          <div className="quick-links">
            <div>
              <span>OpenAI Base URL</span>
              <code>{ORIGIN}/v1</code>
            </div>
            <div>
              <span>MCP</span>
              <code>{ORIGIN}/mcp</code>
            </div>
          </div>
          <pre className="code-block small">{CURL_EXAMPLE}</pre>
          <p className="hint">
            首次启动的管理 Key 在 <code>data/bootstrap-key.txt</code>。API Key 同时用于 <code>/v1</code> 与 <code>/api/v1</code>。
          </p>
        </section>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>最近请求</h2>
            <p>最新 12 条推理请求，包含缓存、TTFT 与状态。</p>
          </div>
          <Badge tone="default">{recent.length} 条</Badge>
        </div>
        {recent.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>时间</th>
                  <th>模型</th>
                  <th>Key</th>
                  <th>状态</th>
                  <th className="num">Token</th>
                  <th className="num">TTFT</th>
                  <th className="num">耗时</th>
                  <th>缓存</th>
                </tr>
              </thead>
              <tbody>
                {recent.map((request) => (
                  <tr key={request.id}>
                    <td className="muted nowrap" title={formatDateTime(request.created_at)}>
                      {timeAgo(request.created_at)}
                    </td>
                    <td className="mono">{request.model_id}</td>
                    <td className="muted">{request.api_key_name || "—"}</td>
                    <td>
                      <Badge tone={request.status < 300 ? "ok" : request.status < 500 ? "warn" : "danger"}>{request.status}</Badge>
                    </td>
                    <td className="num">
                      {formatNumber(request.total_tokens)}
                      <span className="muted"> · {request.stream ? "流式" : "非流式"}</span>
                    </td>
                    <td className="num">{formatMs(request.ttft_ms)}</td>
                    <td className="num">{formatMs(request.duration_ms)}</td>
                    <td>{request.cached ? <Badge tone="accent">HIT</Badge> : <span className="muted">MISS</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState
            icon="terminal"
            title="还没有请求记录"
            description="去调试台发一条流式消息，或者用上面的 cURL 试一下。"
          />
        )}
      </section>
    </>
  );
}
