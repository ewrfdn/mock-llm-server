import { config } from "./config.js";

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const threshold = LEVELS[config.logLevel] ?? LEVELS.info;

function stringifyMeta(meta) {
  if (meta === undefined) return "";
  if (meta instanceof Error) return ` ${meta.stack || meta.message}`;
  if (typeof meta !== "object" || meta === null) return ` ${String(meta)}`;
  try {
    return ` ${JSON.stringify(meta)}`;
  } catch {
    return "";
  }
}

function emit(level, message, meta) {
  if ((LEVELS[level] ?? 20) < threshold) return;
  const stamp = new Date().toISOString().slice(11, 23);
  const line = `${stamp} ${level.toUpperCase().padEnd(5)} ${message}${stringifyMeta(meta)}`;
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export const logger = {
  debug: (message, meta) => emit("debug", message, meta),
  info: (message, meta) => emit("info", message, meta),
  warn: (message, meta) => emit("warn", message, meta),
  error: (message, meta) => emit("error", message, meta),
};
