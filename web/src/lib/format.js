export function formatNumber(value) {
  const number = Number(value) || 0;
  return new Intl.NumberFormat("zh-CN").format(number);
}

export function compactNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) >= 1e9) return `${(number / 1e9).toFixed(2)}B`;
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(2)}M`;
  if (Math.abs(number) >= 1e4) return `${(number / 1e4).toFixed(2)}W`;
  return formatNumber(number);
}

export function formatMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)} s`;
  return `${(ms / 60_000).toFixed(2)} min`;
}

export function formatTps(value) {
  const tps = Number(value);
  if (!Number.isFinite(tps) || tps <= 0) return "—";
  return `${tps.toFixed(1)} tok/s`;
}

export function formatPercent(value, digits = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return `${number.toFixed(digits)}%`;
}

export function formatDateTime(value) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function timeAgo(value) {
  if (!value) return "—";
  const date = new Date(value).getTime();
  if (!Number.isFinite(date)) return "—";
  const diff = Date.now() - date;
  if (diff < 0) return "刚刚";
  if (diff < 60_000) return `${Math.max(1, Math.floor(diff / 1000))} 秒前`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 30 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return formatDateTime(value);
}

export function formatUptime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const days = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  if (days) return `${days} 天 ${hours} 小时`;
  if (hours) return `${hours} 小时 ${minutes} 分`;
  return `${minutes} 分`;
}

export function shortId(value, length = 10) {
  const text = String(value || "");
  if (text.length <= length) return text;
  return `${text.slice(0, length)}…`;
}
