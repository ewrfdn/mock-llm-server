import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { logger } from "../logger.js";
import { migrate } from "./schema.js";

let database;
let driver = "unknown";
let transactionDepth = 0;

async function open() {
  if (config.dbPath !== ":memory:") {
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
  }

  // Node >= 22.13 自带 node:sqlite，无需原生依赖；旧版本回退到可选依赖 better-sqlite3。
  try {
    const { DatabaseSync } = await import("node:sqlite");
    database = new DatabaseSync(config.dbPath);
    driver = "node:sqlite";
  } catch (builtinError) {
    try {
      const mod = await import("better-sqlite3");
      const Database = mod.default;
      database = new Database(config.dbPath);
      driver = "better-sqlite3";
    } catch (fallbackError) {
      throw new Error(
        `无法初始化 SQLite：当前 Node ${process.version} 不提供可直接使用的 node:sqlite，且 better-sqlite3 不可用。` +
          `请升级 Node 到 24 LTS，或安装 better-sqlite3。原始错误：${fallbackError?.message || builtinError?.message}`,
      );
    }
  }

  try {
    database.exec("PRAGMA journal_mode = WAL");
  } catch (error) {
    logger.warn("SQLite WAL 模式不可用，继续使用默认日志模式", error?.message);
  }
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");

  migrate(database);

  logger.info(`SQLite 已打开 (${driver})`, { path: config.dbPath });
  return database;
}

export const db = await open();
export { driver };

const statements = new Map();

export function prepare(sql) {
  let statement = statements.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    statements.set(sql, statement);
  }
  return statement;
}

/**
 * 同步事务。node:sqlite 与 better-sqlite3 都没有统一的 transaction API，
 * 这里用 BEGIN IMMEDIATE / COMMIT 包装，并支持同进程内嵌套调用（内层直接执行）。
 */
export function transaction(fn) {
  if (transactionDepth > 0) return fn();
  transactionDepth += 1;
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore rollback failure */
    }
    throw error;
  } finally {
    transactionDepth -= 1;
  }
}

export function closeDatabase() {
  try {
    db.close();
  } catch {
    /* ignore */
  }
}
