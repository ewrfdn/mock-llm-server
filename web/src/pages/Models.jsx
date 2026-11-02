import { useCallback, useEffect, useMemo, useState } from "react";
import { api } from "../api.js";
import {
  Badge,
  CopyButton,
  EmptyState,
  Field,
  Icon,
  Modal,
  PageHeader,
  RangeField,
  Spinner,
  Switch,
  useToast,
} from "../components/ui.jsx";
import { compactNumber, formatMs, formatNumber } from "../lib/format.js";

const ORIGIN = typeof window !== "undefined" ? window.location.origin : "http://127.0.0.1:8787";

function emptyForm() {
  return {
    id: "",
    display_name: "",
    description: "",
    qpm_limit: "0",
    tpm_limit: "0",
    context_window: "128000",
    output_min: "128",
    output_max: "1024",
    tps_min: "20",
    tps_max: "60",
    ttft_min: "200",
    ttft_max: "600",
    availability_level: "1",
    cache_min: "0",
    cache_max: "0",
    failure_delay: "",
    enabled: true,
  };
}

function toForm(model) {
  return {
    id: model.id,
    display_name: model.display_name,
    description: model.description || "",
    qpm_limit: String(model.qpm_limit),
    tpm_limit: String(model.tpm_limit),
    context_window: String(model.context_window),
    output_min: String(model.output_tokens_min),
    output_max: String(model.output_tokens_max),
    tps_min: String(model.tps_min),
    tps_max: String(model.tps_max),
    ttft_min: String(model.ttft_ms_min),
    ttft_max: String(model.ttft_ms_max),
    availability_level: String(model.availability_level),
    cache_min: String(model.cache_hit_rate_min),
    cache_max: String(model.cache_hit_rate_max),
    failure_delay: model.failure_delay_ms ? String(model.failure_delay_ms) : "",
    enabled: model.enabled,
  };
}

function buildCurl(modelId) {
  return `curl ${ORIGIN}/v1/chat/completions \\
  -H "Authorization: Bearer $MOCK_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
    "model": "${modelId}",
    "stream": true,
    "max_tokens": 512,
    "messages": [{"role": "user", "content": "hello"}]
  }'`;
}

function availabilityOf(meta, level) {
  const found = meta?.availability_levels?.find((item) => item.level === Number(level));
  return found || { level, percent: 100, label: `L${level}` };
}

function rangeText(min, max, suffix = "") {
  const low = compactNumber(min);
  const high = compactNumber(max);
  return Number(min) === Number(max) ? `${low}${suffix}` : `${low} – ${high}${suffix}`;
}

function Metric({ label, value, tone }) {
  return (
    <div className="metric">
      <span>{label}</span>
      <strong className={tone ? `text-${tone}` : ""}>{value}</strong>
    </div>
  );
}

export default function Models() {
  const { push } = useToast();
  const [models, setModels] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [form, setForm] = useState(emptyForm);
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(null);
  const [busyId, setBusyId] = useState("");

  const load = useCallback(async () => {
    try {
      const [modelData, metaData] = await Promise.all([api("/models"), api("/meta")]);
      setModels(modelData.items);
      setMeta(metaData);
    } catch (error) {
      push(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [push]);

  useEffect(() => {
    load();
  }, [load]);

  const openCreate = () => {
    setEditing(null);
    setForm(emptyForm());
    setFormError("");
    setFormOpen(true);
  };

  const openEdit = (model) => {
    setEditing(model);
    setForm(toForm(model));
    setFormError("");
    setFormOpen(true);
  };

  const closeForm = () => {
    if (saving) return;
    setFormOpen(false);
    setFormError("");
  };

  const update = (key, value) => setForm((current) => ({ ...current, [key]: value }));

  const validate = () => {
    if (!editing) {
      if (!form.id.trim()) return "模型 ID 不能为空";
      if (!/^[a-z0-9][a-z0-9._-]*$/.test(form.id.trim().toLowerCase())) {
        return "模型 ID 只能包含小写字母、数字、点、下划线和连字符，且必须以字母或数字开头";
      }
    }
    const numeric = [
      ["qpm_limit", "QPM"],
      ["tpm_limit", "TPM"],
      ["context_window", "上下文窗口"],
      ["output_min", "输出下限"],
      ["output_max", "输出上限"],
      ["tps_min", "TPS 下限"],
      ["tps_max", "TPS 上限"],
      ["ttft_min", "TTFT 下限"],
      ["ttft_max", "TTFT 上限"],
      ["cache_min", "缓存下限"],
      ["cache_max", "缓存上限"],
    ];
    for (const [key, label] of numeric) {
      const number = Number(form[key]);
      if (!Number.isFinite(number)) return `${label} 必须是数字`;
      if (number < 0) return `${label} 不能为负数`;
    }
    if (Number(form.output_min) < 1) return "输出下限至少为 1 token";
    if (Number(form.output_min) > Number(form.output_max)) return "输出下限不能大于输出上限";
    if (Number(form.output_max) > 2_000_000) return "输出上限不能超过 2,000,000 tokens";
    if (Number(form.tps_min) <= 0 || Number(form.tps_max) <= 0) return "TPS 必须大于 0";
    if (Number(form.tps_min) > Number(form.tps_max)) return "TPS 下限不能大于上限";
    if (Number(form.ttft_min) > Number(form.ttft_max)) return "TTFT 下限不能大于上限";
    if (Number(form.cache_min) > Number(form.cache_max)) return "缓存命中率下限不能大于上限";
    if (Number(form.cache_min) < 0 || Number(form.cache_max) > 100) return "缓存命中率必须在 0-100 之间";
    const availabilityLevel = Number(form.availability_level);
    if (!Number.isInteger(availabilityLevel) || availabilityLevel < 1 || availabilityLevel > 5) {
      return "可用性等级必须是 1-5 的整数";
    }
    if (form.failure_delay !== "") {
      const delay = Number(form.failure_delay);
      if (!Number.isFinite(delay) || !Number.isInteger(delay) || delay < 0) return "失败等待时间必须是非负整数毫秒";
      if (delay > 600_000) return "失败等待时间不能超过 600,000 ms";
    }
    if (Number(form.context_window) < Number(form.output_max)) return "上下文窗口不能小于输出上限";
    if (Number(form.context_window) < 1024) return "上下文窗口至少为 1024";
    return "";
  };

  const submit = async (event) => {
    event.preventDefault();
    const message = validate();
    if (message) {
      setFormError(message);
      return;
    }
    const payload = {
      display_name: form.display_name.trim() || undefined,
      description: form.description.trim(),
      qpm_limit: Number(form.qpm_limit),
      tpm_limit: Number(form.tpm_limit),
      context_window: Number(form.context_window),
      output_tokens_min: Number(form.output_min),
      output_tokens_max: Number(form.output_max),
      tps_min: Number(form.tps_min),
      tps_max: Number(form.tps_max),
      ttft_ms_min: Number(form.ttft_min),
      ttft_ms_max: Number(form.ttft_max),
      availability_level: Number(form.availability_level),
      cache_hit_rate_min: Number(form.cache_min),
      cache_hit_rate_max: Number(form.cache_max),
      failure_delay_ms: form.failure_delay === "" ? 0 : Number(form.failure_delay),
      enabled: form.enabled,
    };

    setSaving(true);
    setFormError("");
    try {
      if (editing) {
        await api(`/models/${encodeURIComponent(editing.id)}`, { method: "PATCH", body: payload });
        push(`模型 ${editing.id} 已更新`, "success");
      } else {
        const created = await api("/models", { method: "POST", body: { ...payload, id: form.id.trim().toLowerCase() } });
        push(`模型 ${created.model.id} 已创建`, "success");
      }
      setFormOpen(false);
      await load();
    } catch (error) {
      setFormError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (model) => {
    setBusyId(model.id);
    try {
      await api(`/models/${encodeURIComponent(model.id)}`, { method: "PATCH", body: { enabled: !model.enabled } });
      await load();
      push(`${model.id} 已${model.enabled ? "停用" : "启用"}`, "success");
    } catch (error) {
      push(error.message, "error");
    } finally {
      setBusyId("");
    }
  };

  const confirmDelete = async () => {
    if (!deleting) return;
    setBusyId(deleting.id);
    try {
      await api(`/models/${encodeURIComponent(deleting.id)}`, { method: "DELETE" });
      push(`模型 ${deleting.id} 已删除`, "success");
      setDeleting(null);
      await load();
    } catch (error) {
      push(error.message, "error");
    } finally {
      setBusyId("");
    }
  };

  const totalRequestsLabel = useMemo(() => `${models.filter((model) => model.enabled).length} 个启用 / ${models.length} 个模型`, [models]);

  return (
    <>
      <PageHeader
        title="Mock 模型"
        description="每个指标都在请求时从范围内均匀抽样；QPM / TPM 只在 Redis 连接后生效。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={load} disabled={loading}>
              {loading ? <Spinner size={15} /> : <Icon name="refresh" size={15} />}
              刷新
            </button>
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              <Icon name="plus" size={16} />
              新建模型
            </button>
          </>
        }
      />

      <div className="list-meta">
        <span>{totalRequestsLabel}</span>
        <span className="muted">输出范围支持超长文本；所有流式请求共用一个调度器。</span>
      </div>

      {loading ? (
        <div className="loading-block">
          <Spinner size={20} /> 加载模型…
        </div>
      ) : models.length === 0 ? (
        <div className="card">
          <EmptyState
            icon="models"
            title="还没有模型"
            description="创建第一个 mock 模型，或者重启服务并使用演示模型。"
            action={
              <button type="button" className="btn btn-primary" onClick={openCreate}>
                <Icon name="plus" size={16} />
                新建模型
              </button>
            }
          />
        </div>
      ) : (
        <div className="model-grid">
          {models.map((model) => {
            const availability = availabilityOf(meta, model.availability_level);
            return (
              <article key={model.id} className={`model-card ${model.enabled ? "" : "disabled"}`}>
                <div className="model-card-head">
                  <div>
                    <div className="model-name-row">
                      <h2>{model.display_name}</h2>
                      <Badge tone={model.enabled ? "ok" : "default"} dot>
                        {model.enabled ? "启用" : "停用"}
                      </Badge>
                    </div>
                    <code className="model-id">{model.id}</code>
                  </div>
                  <div className="model-actions">
                    <button type="button" className="icon-btn" onClick={() => openEdit(model)} title="编辑">
                      <Icon name="edit" size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn"
                      onClick={() => toggleEnabled(model)}
                      title={model.enabled ? "停用" : "启用"}
                      disabled={busyId === model.id}
                    >
                      <Icon name={model.enabled ? "stop" : "play"} size={16} />
                    </button>
                    <button type="button" className="icon-btn danger" onClick={() => setDeleting(model)} title="删除">
                      <Icon name="trash" size={16} />
                    </button>
                  </div>
                </div>

                <p className="model-desc">{model.description || "未填写描述"}</p>

                <div className="metric-grid">
                  <Metric
                    label="QPM"
                    value={model.qpm_limit ? formatNumber(model.qpm_limit) : "不限"}
                    tone={model.qpm_limit ? undefined : "muted"}
                  />
                  <Metric
                    label="TPM"
                    value={model.tpm_limit ? compactNumber(model.tpm_limit) : "不限"}
                    tone={model.tpm_limit ? undefined : "muted"}
                  />
                  <Metric label="输出范围" value={rangeText(model.output_tokens_min, model.output_tokens_max)} />
                  <Metric label="TPS" value={rangeText(model.tps_min, model.tps_max)} />
                  <Metric label="TTFT" value={rangeText(model.ttft_ms_min, model.ttft_ms_max, " ms")} />
                  <Metric label="缓存命中率" value={rangeText(model.cache_hit_rate_min, model.cache_hit_rate_max, "%")} />
                  <Metric label="失败等待" value={model.failure_delay_ms ? `${formatNumber(model.failure_delay_ms)} ms` : "立即"} />
                </div>

                <div className="model-foot">
                  <Badge tone={availability.percent >= 99 ? "ok" : availability.percent >= 95 ? "warn" : "danger"}>
                    {availability.label}
                  </Badge>
                  <span className="muted">上下文 {compactNumber(model.context_window)} tokens</span>
                  <CopyButton text={buildCurl(model.id)} label="cURL" />
                </div>
              </article>
            );
          })}
        </div>
      )}

      <Modal
        open={formOpen}
        onClose={closeForm}
        width={760}
        title={editing ? `编辑 ${editing.id}` : "新建 Mock 模型"}
        subtitle="范围会在每次请求时随机抽样；数字越小越可控。"
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={closeForm} disabled={saving}>
              取消
            </button>
            <button type="submit" form="model-form" className="btn btn-primary" disabled={saving}>
              {saving ? <Spinner size={15} /> : <Icon name="check" size={16} />}
              {editing ? "保存修改" : "创建模型"}
            </button>
          </>
        }
      >
        <form id="model-form" onSubmit={submit} className="form">
          {formError ? (
            <div className="alert alert-error">
              <Icon name="alert" size={15} />
              <span>{formError}</span>
            </div>
          ) : null}

          <div className="form-section">
            <h3>基础信息</h3>
            <div className="form-grid">
              <Field label="模型 ID" hint={editing ? "创建后不可修改" : "小写字母、数字、点、下划线和连字符"}>
                <input
                  className="input mono"
                  value={form.id}
                  onChange={(event) => update("id", event.target.value.toLowerCase())}
                  placeholder="mock-fast"
                  disabled={Boolean(editing)}
                  required
                />
              </Field>
              <Field label="展示名称">
                <input
                  className="input"
                  value={form.display_name}
                  onChange={(event) => update("display_name", event.target.value)}
                  placeholder="留空则等于模型 ID"
                />
              </Field>
              <Field label="描述" className="span-2">
                <textarea
                  className="input textarea"
                  rows={2}
                  value={form.description}
                  onChange={(event) => update("description", event.target.value)}
                  placeholder="这个模型模拟什么场景？"
                />
              </Field>
              <Field label="启用状态">
                <Switch checked={form.enabled} onChange={(value) => update("enabled", value)} label={form.enabled ? "启用" : "停用"} />
              </Field>
            </div>
          </div>

          <div className="form-section">
            <h3>限流与上下文</h3>
            <div className="form-grid">
              <Field label="QPM 限制" hint="每个 Key + 模型每分钟请求数；0 = 不限制。需配置 Redis 生效。">
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={form.qpm_limit}
                  onChange={(event) => update("qpm_limit", event.target.value)}
                />
              </Field>
              <Field label="TPM 限制" hint="每分钟 token 上限（提示词 + 预留输出）；0 = 不限制。">
                <input
                  className="input"
                  type="number"
                  min="0"
                  value={form.tpm_limit}
                  onChange={(event) => update("tpm_limit", event.target.value)}
                />
              </Field>
              <Field label="上下文窗口" hint="必须 >= 输出上限。">
                <input
                  className="input"
                  type="number"
                  min="1024"
                  value={form.context_window}
                  onChange={(event) => update("context_window", event.target.value)}
                />
              </Field>
            </div>
          </div>

          <div className="form-section">
            <h3>输出与延迟</h3>
            <div className="form-grid">
              <RangeField
                label="输出长度范围"
                suffix="tokens"
                value={{ min: form.output_min, max: form.output_max }}
                onChange={(value) => setForm((current) => ({ ...current, output_min: value.min, output_max: value.max }))}
                hint="每次请求在范围内均匀抽样；支持超长输出。"
              />
              <RangeField
                label="输出 TPS 范围"
                suffix="tok/s"
                step="0.1"
                value={{ min: form.tps_min, max: form.tps_max }}
                onChange={(value) => setForm((current) => ({ ...current, tps_min: value.min, tps_max: value.max }))}
                hint="流式响应按该速度逐步产出 token。"
              />
              <RangeField
                label="TTFT 范围"
                suffix="ms"
                value={{ min: form.ttft_min, max: form.ttft_max }}
                onChange={(value) => setForm((current) => ({ ...current, ttft_min: value.min, ttft_max: value.max }))}
                hint="首 token 延迟；非流式响应包含在总耗时里。"
              />
            </div>
          </div>

          <div className="form-section">
            <h3>可用性与缓存</h3>
            <div className="form-grid">
              <Field label="可用性等级" hint="输入 1-5：1=100%，2=99.9%，3=99%，4=95%，5=90%；每次请求按概率模拟 503。">
                <input
                  className="input"
                  type="number"
                  inputMode="numeric"
                  min="1"
                  max="5"
                  step="1"
                  value={form.availability_level}
                  onChange={(event) => update("availability_level", event.target.value)}
                  placeholder="1-5"
                />
              </Field>
              <Field label="失败等待时间（ms）" hint="可用性抽样失败时，先等待再返回 503；留空或 0 表示立即失败。">
                <input
                  className="input"
                  type="number"
                  min="0"
                  step="100"
                  value={form.failure_delay}
                  onChange={(event) => update("failure_delay", event.target.value)}
                  placeholder="留空 = 立即失败"
                />
              </Field>
              <RangeField
                label="缓存命中率范围"
                suffix="%"
                step="0.1"
                value={{ min: form.cache_min, max: form.cache_max }}
                onChange={(value) => setForm((current) => ({ ...current, cache_min: value.min, cache_max: value.max }))}
                hint="命中时以 3-12ms 的 TTFT 返回同参数请求的缓存文本。"
              />
            </div>
          </div>
        </form>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => !busyId && setDeleting(null)}
        title="删除模型"
        width={460}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setDeleting(null)} disabled={Boolean(busyId)}>
              取消
            </button>
            <button type="button" className="btn btn-danger" onClick={confirmDelete} disabled={Boolean(busyId)}>
              {busyId ? <Spinner size={15} /> : <Icon name="trash" size={15} />}
              确认删除
            </button>
          </>
        }
      >
        <p className="modal-text">
          确定删除模型 <code>{deleting?.id}</code>？模型将立即不可调用，但历史请求统计会保留。
        </p>
      </Modal>
    </>
  );
}
