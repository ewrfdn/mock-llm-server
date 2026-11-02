import { useCallback, useEffect, useState } from "react";
import { api, clearToken, getToken, setToken, verifyKey } from "./api.js";
import { Icon, ToastProvider, useToast } from "./components/ui.jsx";
import Login from "./pages/Login.jsx";
import Dashboard from "./pages/Dashboard.jsx";
import Models from "./pages/Models.jsx";
import ApiKeys from "./pages/ApiKeys.jsx";
import Playground from "./pages/Playground.jsx";
import McpSkills from "./pages/McpSkills.jsx";

const NAV = [
  { id: "dashboard", label: "概览", icon: "dashboard", description: "请求、延迟与限流状态" },
  { id: "models", label: "模型", icon: "models", description: "配置 mock 模型指标" },
  { id: "keys", label: "API Keys", icon: "key", description: "生成与管理访问 Key" },
  { id: "playground", label: "调试台", icon: "play", description: "实时流式与并发测试" },
  { id: "mcp", label: "MCP & Skills", icon: "plug", description: "Agent 接入与文档下载" },
];

function useHashRoute() {
  const read = () => {
    const value = window.location.hash.replace(/^#\/?/, "").trim();
    return NAV.some((item) => item.id === value) ? value : "dashboard";
  };
  const [route, setRoute] = useState(read);

  useEffect(() => {
    const onChange = () => setRoute(read());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  const navigate = useCallback((next) => {
    window.location.hash = `#/${next}`;
  }, []);

  return [route, navigate];
}

function Splash({ message = "正在验证 Key…" }) {
  return (
    <div className="splash">
      <div className="splash-mark">M</div>
      <div className="splash-text">{message}</div>
      <span className="spinner" style={{ width: 18, height: 18 }} />
    </div>
  );
}

function NoPermission({ session, route, navigate }) {
  return (
    <div className="content">
      <div className="card permission-card">
        <div className="empty-icon">
          <Icon name="shield" size={22} />
        </div>
        <h2>当前 Key 没有管理权限</h2>
        <p>
          这个 Key 的 scope 是 <code>{session.scopes.join(", ") || "无"}</code>。管理台需要 <code>admin</code> 权限的 Key。
          首次启动的管理 Key 在 <code>data/bootstrap-key.txt</code>。
        </p>
        <div className="row">
          {session.can_inference ? (
            <button type="button" className="btn btn-primary" onClick={() => navigate("playground")}>
              去调试台
            </button>
          ) : null}
          <button type="button" className="btn btn-ghost" onClick={() => { clearToken(); window.location.reload(); }}>
            更换 Key
          </button>
        </div>
      </div>
    </div>
  );
}

function Shell({ session, onLogout, route, navigate }) {
  const toast = useToast();
  const [system, setSystem] = useState(null);
  const current = NAV.find((item) => item.id === route) || NAV[0];

  useEffect(() => {
    if (!session.can_admin) return undefined;
    let cancelled = false;
    const load = () => {
      api("/system")
        .then((data) => {
          if (!cancelled) setSystem(data);
        })
        .catch(() => {});
    };
    load();
    const timer = setInterval(load, 20000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [session.can_admin]);

  useEffect(() => {
    document.title = `${current.label} · Mock LLM Server`;
  }, [current.label]);

  const redis = system?.redis;
  const redisTone = !redis ? "default" : redis.enforced ? "ok" : redis.status === "error" ? "warn" : "default";
  const redisLabel = !redis
    ? "Redis 状态未知"
    : redis.enforced
      ? "Redis 限流生效"
      : redis.configured
        ? "Redis 未连接 · 限流关闭"
        : "Redis 未配置 · 限流关闭";

  const renderPage = () => {
    if (route === "playground") return <Playground session={session} />;
    if (!session.can_admin) return <NoPermission session={session} route={route} navigate={navigate} />;
    if (route === "models") return <Models />;
    if (route === "keys") return <ApiKeys session={session} />;
    if (route === "mcp") return <McpSkills />;
    return <Dashboard session={session} />;
  };

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">M</span>
          <div className="brand-text">
            <strong>Mock LLM</strong>
            <span>server console</span>
          </div>
        </div>

        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              type="button"
              className={`nav-item ${route === item.id ? "active" : ""}`}
              onClick={() => navigate(item.id)}
              title={item.description}
            >
              <Icon name={item.icon} size={18} />
              <span>{item.label}</span>
              {route === item.id ? <span className="nav-active-bar" /> : null}
            </button>
          ))}
        </nav>

        <div className="sidebar-bottom">
          <div className="key-chip">
            <Icon name="key" size={15} />
            <div>
              <strong>{session.key?.name || "unknown key"}</strong>
              <span>{session.key?.key_prefix}…</span>
            </div>
          </div>
          <div className="scope-row">
            {session.scopes.map((scope) => (
              <span key={scope} className="chip">
                {scope}
              </span>
            ))}
          </div>
          <button type="button" className="btn btn-ghost btn-sm logout" onClick={() => { onLogout(); toast.push("已退出登录", "info"); }}>
            <Icon name="logout" size={15} />
            退出登录
          </button>
          <span className="version">v{session.version || "1.0.0"}</span>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <span className="crumb">console</span>
            <Icon name="chevronRight" size={13} />
            <strong>{current.label}</strong>
          </div>
          <div className="topbar-actions">
            <span className={`redis-pill ${redisTone}`} title={redis?.last_error || redisLabel}>
              <span className={`dot dot-${redisTone}`} />
              {redisLabel}
            </span>
            {system ? <span className="topbar-meta">{system.counts.models} 模型 · {system.counts.api_keys} Key</span> : null}
          </div>
        </header>
        <div className="page" key={route}>
          {renderPage()}
        </div>
      </main>
    </div>
  );
}

function Root() {
  const [token, setTokenState] = useState(() => getToken());
  const [session, setSession] = useState(null);
  const [checking, setChecking] = useState(Boolean(token));
  const [authError, setAuthError] = useState("");

  useEffect(() => {
    if (!token) {
      setChecking(false);
      setSession(null);
      return undefined;
    }
    let cancelled = false;
    setChecking(true);
    verifyKey(token)
      .then((data) => {
        if (cancelled) return;
        setSession(data);
        setAuthError("");
      })
      .catch((error) => {
        if (cancelled) return;
        clearToken();
        setSession(null);
        setTokenState("");
        setAuthError(error.message || "Key 验证失败");
      })
      .finally(() => {
        if (!cancelled) setChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const [route, navigate] = useHashRoute();

  const login = (nextToken) => {
    setToken(nextToken);
    setAuthError("");
    setTokenState(nextToken);
  };

  const logout = () => {
    clearToken();
    setSession(null);
    setTokenState("");
  };

  if (!token) return <Login onLogin={login} initialError={authError} />;
  if (checking) return <Splash />;
  if (!session) return <Login onLogin={login} initialError={authError} />;

  return <Shell session={session} onLogout={logout} route={route} navigate={navigate} />;
}

export default function App() {
  return (
    <ToastProvider>
      <Root />
    </ToastProvider>
  );
}
