import { createContext, useCallback, useContext, useEffect, useId, useRef, useState } from "react";

const ICONS = {
  dashboard: ["M4 4h6v6H4z", "M14 4h6v4h-6z", "M14 12h6v8h-6z", "M4 14h6v6H4z"],
  models: [
    "M7 7h10v10H7z",
    "M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3",
    "M10 10h4v4h-4z",
  ],
  key: ["M11 15.5a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0z", "M10.5 13 21 2.5", "M16.5 6.5 19 9", "M19 4 21.5 6.5"],
  play: ["M7 4.5 20 12 7 19.5z"],
  plug: ["M9 2v5M15 2v5", "M6 7h12v4a6 6 0 0 1-12 0z", "M12 17v5"],
  plus: ["M12 5v14M5 12h14"],
  edit: ["M4 20h4L20 8l-4-4L4 16z"],
  trash: ["M4 7h16M9 7V4h6v3M6 7l1 14h10l1-14"],
  copy: ["M9 9h11v11H9z", "M5 15V4h11"],
  check: ["M20 6 9 17l-5-5"],
  x: ["M18 6 6 18M6 6l12 12"],
  refresh: ["M21 12a9 9 0 1 1-3-6.7", "M21 3v6h-6"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M19 14v6H4V5h6"],
  logout: ["M9 21H4V3h5", "M16 17l5-5-5-5", "M21 12H9"],
  alert: ["M12 3 2 21h20z", "M12 9v5", "M12 17h.01"],
  zap: ["M13 2 4 14h7l-1 8 9-12h-7z"],
  clock: ["M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z", "M12 7v5l3 2"],
  database: [
    "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3z",
    "M4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6",
    "M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6",
  ],
  shield: ["M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"],
  download: ["M12 3v12M7 10l5 5 5-5", "M4 21h16"],
  terminal: ["M4 5h16v14H4z", "M8 10l3 2-3 2", "M13 15h4"],
  search: ["M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z", "M21 21l-4.5-4.5"],
  chevronDown: ["m6 9 6 6 6-6"],
  chevronRight: ["m9 6 6 6-6 6"],
  book: ["M4 5.5A2.5 2.5 0 0 1 6.5 3H20v16H6.5A2.5 2.5 0 0 0 4 21.5z", "M4 5.5v16", "M8 7h8M8 11h6"],
  layers: ["m12 3 9 5-9 5-9-5 9-5z", "m3 12 9 5 9-5", "m3 16 9 5 9-5"],
  gauge: ["M4.5 19a9 9 0 1 1 15 0", "M12 13l4-4", "M12 21h.01"],
  spark: ["M12 2v4M12 18v4M2 12h4M18 12h4", "m5 5 3 3M16 16l3 3M19 5l-3 3M8 16l-3 3"],
  menu: ["M4 6h16M4 12h16M4 18h16"],
  send: ["M22 2 11 13", "M22 2 15 22l-4-9-9-4z"],
  stop: ["M6 6h12v12H6z"],
  code: ["m8 8-4 4 4 4", "m16 8 4 4-4 4", "M13 5l-2 14"],
};

export function Icon({ name, size = 18, className = "" }) {
  const paths = ICONS[name];
  if (!paths) return null;
  return (
    <svg
      className={`icon ${className}`.trim()}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {paths.map((path, index) => (
        <path key={index} d={path} />
      ))}
    </svg>
  );
}

export function Badge({ tone = "default", dot = false, children }) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot ? <span className="badge-dot" /> : null}
      {children}
    </span>
  );
}

export function Spinner({ size = 16 }) {
  return <span className="spinner" style={{ width: size, height: size }} aria-label="加载中" />;
}

export function Modal({ open, title, subtitle, onClose, children, footer, width = 620 }) {
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (event) => {
      if (event.key === "Escape") onClose?.();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="modal-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose?.();
      }}
    >
      <div className="modal" style={{ width }} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            {subtitle ? <p className="modal-subtitle">{subtitle}</p> : null}
          </div>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="关闭">
            <Icon name="x" />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer ? <div className="modal-foot">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Field({ label, hint, error, children, className = "" }) {
  return (
    <div className={`field ${error ? "field-error" : ""} ${className}`.trim()}>
      {label ? <span className="label">{label}</span> : null}
      {children}
      {hint ? <span className="hint">{hint}</span> : null}
      {error ? <span className="error-text">{error}</span> : null}
    </div>
  );
}

export function RangeField({ label, hint, value, onChange, step = 1, suffix = "" }) {
  const update = (key, next) => onChange({ ...value, [key]: next });
  return (
    <div className="field">
      <span className="label">{label}</span>
      <div className="range-row">
        <input
          className="input"
          type="number"
          step={step}
          value={value.min}
          placeholder="最小"
          onChange={(event) => update("min", event.target.value)}
        />
        <span className="range-dash">–</span>
        <input
          className="input"
          type="number"
          step={step}
          value={value.max}
          placeholder="最大"
          onChange={(event) => update("max", event.target.value)}
        />
        {suffix ? <span className="range-suffix">{suffix}</span> : null}
      </div>
      {hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export function Switch({ checked, onChange, disabled = false, label }) {
  return (
    <label className={`switch-wrap ${disabled ? "disabled" : ""}`}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        className={`switch ${checked ? "on" : ""}`}
        onClick={() => !disabled && onChange?.(!checked)}
        disabled={disabled}
      >
        <span className="switch-knob" />
      </button>
      {label ? <span>{label}</span> : null}
    </label>
  );
}

export function CopyButton({ text, label = "复制", className = "" }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const area = document.createElement("textarea");
        area.value = text;
        area.style.position = "fixed";
        area.style.opacity = "0";
        document.body.appendChild(area);
        area.select();
        document.execCommand("copy");
        area.remove();
      }
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  return (
    <button type="button" className={`btn btn-ghost btn-sm ${className}`.trim()} onClick={copy}>
      <Icon name={copied ? "check" : "copy"} size={14} />
      {copied ? "已复制" : label}
    </button>
  );
}

export function Sparkline({ values = [], height = 56, color = "#8b5cf6" }) {
  const gradientId = useId().replace(/:/g, "");
  const safe = values.length ? values : [0];
  const max = Math.max(1, ...safe);
  const count = safe.length;
  const points = safe.map((value, index) => {
    const x = count <= 1 ? 0 : (index / (count - 1)) * 100;
    const y = 94 - (Math.max(0, Number(value) || 0) / max) * 78;
    return [Number(x.toFixed(2)), Number(y.toFixed(2))];
  });
  const line = points.map(([x, y], index) => `${index === 0 ? "M" : "L"}${x},${y}`).join(" ");
  const area = `M0,100 L${points.map(([x, y]) => `${x},${y}`).join(" L")} L100,100 Z`;

  return (
    <svg className="sparkline" viewBox="0 0 100 100" preserveAspectRatio="none" style={{ height }}>
      <defs>
        <linearGradient id={`spark-${gradientId}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.32" />
          <stop offset="1" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#spark-${gradientId})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.8" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

export function EmptyState({ icon = "spark", title, description, action }) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <h3>{title}</h3>
      {description ? <p>{description}</p> : null}
      {action}
    </div>
  );
}

export function PageHeader({ title, description, actions }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

const ToastContext = createContext(null);

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);

  const push = useCallback((message, tone = "info") => {
    const id = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    setToasts((current) => [...current, { id, message, tone }]);
    setTimeout(() => {
      setToasts((current) => current.filter((toast) => toast.id !== id));
    }, 4200);
    return id;
  }, []);

  const dismiss = useCallback((id) => {
    setToasts((current) => current.filter((toast) => toast.id !== id));
  }, []);

  return (
    <ToastContext.Provider value={{ push, dismiss }}>
      {children}
      <div className="toast-stack">
        {toasts.map((toast) => (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            <span className="toast-icon">
              <Icon name={toast.tone === "error" ? "alert" : toast.tone === "success" ? "check" : "spark"} size={16} />
            </span>
            <span className="toast-message">{toast.message}</span>
            <button type="button" className="icon-btn toast-close" onClick={() => dismiss(toast.id)} aria-label="关闭">
              <Icon name="x" size={14} />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) throw new Error("useToast 必须在 ToastProvider 内使用");
  return context;
}
