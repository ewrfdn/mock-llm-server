import { useCallback, useEffect, useState } from "react";
import { api, clearToken } from "../api.js";
import {
  Badge,
  CopyButton,
  EmptyState,
  Field,
  Icon,
  Modal,
  PageHeader,
  Spinner,
  Switch,
  useToast,
} from "../components/ui.jsx";
import { formatDateTime, formatNumber, timeAgo } from "../lib/format.js";

const SCOPE_LABEL = { admin: "管理", inference: "推理" };

export default function ApiKeys({ session }) {
  const { push } = useToast();
  const [keys, setKeys] = useState([]);
  const [loading, setLoading] = useState(true);
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ name: "", scopes: { admin: true, inference: true }, expires: "" });
  const [formError, setFormError] = useState("");
  const [saving, setSaving] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [deleting, setDeleting] = useState(null);
  const [rotating, setRotating] = useState(null);
  const [tokenModal, setTokenModal] = useState(null);

  const load = useCallback(async () => {
    try {
      const data = await api("/api-keys");
      setKeys(data.items);
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
    setForm({ name: "", scopes: { admin: true, inference: true }, expires: "" });
    setFormError("");
    setCreateOpen(true);
  };

  const toggleScope = (scope) => {
    setForm((current) => ({ ...current, scopes: { ...current.scopes, [scope]: !current.scopes[scope] } }));
  };

  const submit = async (event) => {
    event.preventDefault();
    const name = form.name.trim();
    const scopes = Object.keys(form.scopes).filter((scope) => form.scopes[scope]);
    if (!name) {
      setFormError("名称不能为空");
      return;
    }
    if (!scopes.length) {
      setFormError("至少选择一个权限范围");
      return;
    }
    if (form.expires && (!Number.isFinite(Number(form.expires)) || Number(form.expires) < 1)) {
      setFormError("有效期必须是正整数天数，或留空表示永久");
      return;
    }

    setSaving(true);
    setFormError("");
    try {
      const result = await api("/api-keys", {
        method: "POST",
        body: {
          name,
          scopes,
          expires_in_days: form.expires ? Number(form.expires) : null,
        },
      });
      setCreateOpen(false);
      setTokenModal({
        title: "API Key 已生成",
        token: result.token,
        name: result.key.name,
        description: "服务端只保存哈希，关闭后无法再次查看完整 Key。请立即复制保存。",
      });
      await load();
    } catch (error) {
      setFormError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const toggleEnabled = async (key) => {
    if (key.id === session.key.id && key.enabled) {
      push("这是当前登录使用的 Key，停用后需要重新登录", "error");
      return;
    }
    setBusyId(key.id);
    try {
      await api(`/api-keys/${key.id}`, { method: "PATCH", body: { enabled: !key.enabled } });
      await load();
      push(`${key.name} 已${key.enabled ? "停用" : "启用"}`, "success");
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
      await api(`/api-keys/${deleting.id}`, { method: "DELETE" });
      if (deleting.id === session.key.id) {
        clearToken();
        window.location.reload();
        return;
      }
      push(`Key ${deleting.name} 已删除`, "success");
      setDeleting(null);
      await load();
    } catch (error) {
      push(error.message, "error");
    } finally {
      setBusyId("");
    }
  };

  const confirmRotate = async () => {
    if (!rotating) return;
    setBusyId(rotating.id);
    try {
      const result = await api(`/api-keys/${rotating.id}/rotate`, { method: "POST" });
      const isCurrent = rotating.id === session.key.id;
      setRotating(null);
      setTokenModal({
        title: "Key 已轮换",
        token: result.token,
        name: result.key.name,
        isCurrent,
        description: isCurrent
          ? "这是当前登录使用的 Key，旧 Key 已立即失效。复制新 Key 后请点击「重新登录」并粘贴新 Key。"
          : "旧 Key 已立即失效。新 Key 只显示这一次，请立即复制保存。",
      });
      await load();
    } catch (error) {
      push(error.message, "error");
    } finally {
      setBusyId("");
    }
  };

  return (
    <>
      <PageHeader
        title="API Keys"
        description="用于 /v1 推理与 /api/v1 管理接口的 Bearer Token。数据库只保存 SHA-256 哈希。"
        actions={
          <>
            <button type="button" className="btn btn-ghost" onClick={load} disabled={loading}>
              {loading ? <Spinner size={15} /> : <Icon name="refresh" size={15} />}
              刷新
            </button>
            <button type="button" className="btn btn-primary" onClick={openCreate}>
              <Icon name="plus" size={16} />
              新建 Key
            </button>
          </>
        }
      />

      <div className="alert alert-info">
        <Icon name="shield" size={16} />
        <span>
          首次启动的 <code>bootstrap-admin</code> Key 保存在 <code>data/bootstrap-key.txt</code>。
          新建 Key 的完整值只返回一次；丢失后只能轮换。至少需要保留一个启用中的 <code>admin</code> Key。
        </span>
      </div>

      <section className="card">
        <div className="card-head">
          <div>
            <h2>Key 列表</h2>
            <p>共 {keys.length} 个 Key，按创建时间排序。</p>
          </div>
          <Badge tone="default">{keys.filter((key) => key.enabled).length} 个启用</Badge>
        </div>

        {loading ? (
          <div className="loading-block">
            <Spinner size={20} /> 加载 Keys…
          </div>
        ) : keys.length === 0 ? (
          <EmptyState
            icon="key"
            title="还没有 Key"
            description="创建第一个 Key，或使用首次启动时写入的 bootstrap Key。"
            action={
              <button type="button" className="btn btn-primary" onClick={openCreate}>
                <Icon name="plus" size={16} />
                新建 Key
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>名称</th>
                  <th>Key</th>
                  <th>权限</th>
                  <th>状态</th>
                  <th className="num">24h 请求</th>
                  <th>最后使用</th>
                  <th>创建时间</th>
                  <th className="right">操作</th>
                </tr>
              </thead>
              <tbody>
                {keys.map((key) => (
                  <tr key={key.id} className={key.enabled ? "" : "row-muted"}>
                    <td>
                      <div className="key-name">
                        <strong>{key.name}</strong>
                        {key.id === session.key.id ? <Badge tone="accent">当前会话</Badge> : null}
                      </div>
                      <span className="muted mono">{key.id}</span>
                    </td>
                    <td>
                      <code className="key-prefix">{key.key_prefix}••••••••</code>
                    </td>
                    <td>
                      <div className="scope-row">
                        {key.scopes.map((scope) => (
                          <span key={scope} className="chip">
                            {SCOPE_LABEL[scope] || scope}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td>
                      <Badge tone={key.enabled ? "ok" : "default"} dot>
                        {key.enabled ? "启用" : "停用"}
                      </Badge>
                      {key.expires_at ? (
                        <div className="muted tiny">到期 {formatDateTime(key.expires_at)}</div>
                      ) : null}
                    </td>
                    <td className="num">
                      {formatNumber(key.requests_24h)}
                      <div className="muted tiny">{formatNumber(key.tokens_24h)} tokens</div>
                    </td>
                    <td className="muted nowrap">{timeAgo(key.last_used_at)}</td>
                    <td className="muted nowrap">{formatDateTime(key.created_at)}</td>
                    <td>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="icon-btn"
                          title="轮换 Key"
                          onClick={() => setRotating(key)}
                          disabled={!key.enabled || busyId === key.id}
                        >
                          <Icon name="refresh" size={15} />
                        </button>
                        <Switch checked={key.enabled} onChange={() => toggleEnabled(key)} disabled={busyId === key.id} />
                        <button type="button" className="icon-btn danger" title="删除" onClick={() => setDeleting(key)}>
                          <Icon name="trash" size={15} />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <Modal
        open={createOpen}
        onClose={() => !saving && setCreateOpen(false)}
        title="新建 API Key"
        subtitle="admin 用于管理台，inference 用于 /v1 推理；通常两者都勾选。"
        width={520}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setCreateOpen(false)} disabled={saving}>
              取消
            </button>
            <button type="submit" form="key-form" className="btn btn-primary" disabled={saving}>
              {saving ? <Spinner size={15} /> : <Icon name="plus" size={15} />}
              生成 Key
            </button>
          </>
        }
      >
        <form id="key-form" onSubmit={submit} className="form">
          {formError ? (
            <div className="alert alert-error">
              <Icon name="alert" size={15} />
              <span>{formError}</span>
            </div>
          ) : null}

          <Field label="名称" hint="用于区分调用方，例如 local-agent / eval-runner。">
            <input
              className="input"
              value={form.name}
              onChange={(event) => setForm((current) => ({ ...current, name: event.target.value }))}
              placeholder="local-agent"
              autoFocus
            />
          </Field>

          <Field label="权限范围">
            <div className="check-row">
              {["admin", "inference"].map((scope) => (
                <label key={scope} className={`check-card ${form.scopes[scope] ? "checked" : ""}`}>
                  <input type="checkbox" checked={form.scopes[scope]} onChange={() => toggleScope(scope)} />
                  <span>
                    <strong>{SCOPE_LABEL[scope]}</strong>
                    <small>{scope === "admin" ? "管理模型 / Key / 统计" : "调用 /v1 推理接口"}</small>
                  </span>
                </label>
              ))}
            </div>
          </Field>

          <Field label="有效期（天）" hint="留空表示永久有效。">
            <input
              className="input"
              type="number"
              min="1"
              value={form.expires}
              onChange={(event) => setForm((current) => ({ ...current, expires: event.target.value }))}
              placeholder="永久"
            />
          </Field>
        </form>
      </Modal>

      <Modal
        open={Boolean(tokenModal)}
        onClose={() => setTokenModal(null)}
        title={tokenModal?.title || "API Key"}
        width={620}
        footer={
          <>
            {tokenModal?.isCurrent ? (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => {
                  clearToken();
                  window.location.reload();
                }}
              >
                重新登录
              </button>
            ) : null}
            <button type="button" className="btn btn-primary" onClick={() => setTokenModal(null)}>
              我已保存
            </button>
          </>
        }
      >
        <div className="alert alert-warn">
          <Icon name="alert" size={16} />
          <span>{tokenModal?.description}</span>
        </div>
        <div className="token-row">
          <code className="token-value">{tokenModal?.token}</code>
          <CopyButton text={tokenModal?.token || ""} label="复制 Key" />
        </div>
        <p className="muted">名称：{tokenModal?.name}</p>
      </Modal>

      <Modal
        open={Boolean(rotating)}
        onClose={() => !busyId && setRotating(null)}
        title="轮换 API Key"
        width={460}
        footer={
          <>
            <button type="button" className="btn btn-ghost" onClick={() => setRotating(null)} disabled={Boolean(busyId)}>
              取消
            </button>
            <button type="button" className="btn btn-primary" onClick={confirmRotate} disabled={Boolean(busyId)}>
              {busyId ? <Spinner size={15} /> : <Icon name="refresh" size={15} />}
              确认轮换
            </button>
          </>
        }
      >
        <p className="modal-text">
          轮换 <code>{rotating?.name}</code> 后，旧 Key 立即失效。新 Key 只会显示一次。
        </p>
      </Modal>

      <Modal
        open={Boolean(deleting)}
        onClose={() => !busyId && setDeleting(null)}
        title="删除 API Key"
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
          确定删除 <code>{deleting?.name}</code>？使用该 Key 的调用会立即返回 401，历史统计保留。
        </p>
      </Modal>
    </>
  );
}
