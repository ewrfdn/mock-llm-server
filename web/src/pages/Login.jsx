import { useState } from "react";
import { verifyKey, setToken } from "../api.js";
import { Field, Icon, Spinner } from "../components/ui.jsx";

export default function Login({ onLogin, initialError = "" }) {
  const [token, setTokenValue] = useState("");
  const [error, setError] = useState(initialError);
  const [loading, setLoading] = useState(false);
  const [visible, setVisible] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const value = token.trim();
    if (!value) {
      setError("请输入 API Key");
      return;
    }
    setLoading(true);
    setError("");
    try {
      await verifyKey(value);
      setToken(value);
      onLogin(value);
    } catch (requestError) {
      setError(requestError.message || "Key 验证失败");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login">
      <div className="login-orb login-orb-a" />
      <div className="login-orb login-orb-b" />
      <div className="login-card">
        <div className="brand brand-lg">
          <span className="brand-mark">M</span>
          <div className="brand-text">
            <strong>Mock LLM</strong>
            <span>server console</span>
          </div>
        </div>

        <h1>登录控制台</h1>
        <p className="login-sub">
          使用 <code>admin</code> 权限的 API Key。首次启动生成的 Key 保存在 <code>data/bootstrap-key.txt</code>。
        </p>

        <form onSubmit={submit} className="login-form">
          <Field label="管理 API Key">
            <div className="input-with-action">
              <input
                className="input mono"
                type={visible ? "text" : "password"}
                value={token}
                onChange={(event) => setTokenValue(event.target.value)}
                placeholder="mllm_..."
                autoFocus
                autoComplete="off"
                spellCheck={false}
              />
              <button
                type="button"
                className="icon-btn input-action"
                onClick={() => setVisible((value) => !value)}
                aria-label={visible ? "隐藏" : "显示"}
              >
                <Icon name={visible ? "shield" : "search"} size={16} />
              </button>
            </div>
          </Field>

          {error ? (
            <div className="alert alert-error">
              <Icon name="alert" size={15} />
              <span>{error}</span>
            </div>
          ) : null}

          <button className="btn btn-primary btn-block" type="submit" disabled={loading}>
            {loading ? <Spinner size={16} /> : <Icon name="logout" size={16} />}
            {loading ? "验证中…" : "进入控制台"}
          </button>
        </form>

        <div className="login-hints">
          <div className="login-hint">
            <span className="hint-icon"><Icon name="terminal" size={14} /></span>
            <div>
              <strong>首次使用</strong>
              <p>服务启动时会打印管理 Key，并写入 <code>data/bootstrap-key.txt</code>。数据库只存哈希，请妥善保存该文件。</p>
            </div>
          </div>
          <div className="login-hint">
            <span className="hint-icon"><Icon name="plug" size={14} /></span>
            <div>
              <strong>MCP 配置模型</strong>
              <p>MCP 端点 <code>/mcp</code> 暂不鉴权，支持 list/create/update/delete 模型。</p>
            </div>
          </div>
        </div>

        <div className="login-endpoints">
          <span><i>API</i> /v1</span>
          <span><i>MCP</i> /mcp</span>
          <span><i>Skill</i> /api/v1/skill</span>
        </div>
      </div>
      <footer className="login-footer">Mock LLM Server · 可配置延迟 / 吞吐 / 可用性 / 缓存的本地 mock 服务</footer>
    </div>
  );
}
