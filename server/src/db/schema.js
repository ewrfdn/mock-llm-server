export function migrate(database) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      key_hash TEXT NOT NULL UNIQUE,
      key_prefix TEXT NOT NULL,
      scopes TEXT NOT NULL DEFAULT 'admin,inference',
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      last_used_at INTEGER,
      expires_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

    CREATE TABLE IF NOT EXISTS models (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      qpm_limit INTEGER NOT NULL DEFAULT 0,
      tpm_limit INTEGER NOT NULL DEFAULT 0,
      output_tokens_min INTEGER NOT NULL DEFAULT 128,
      output_tokens_max INTEGER NOT NULL DEFAULT 1024,
      tps_min REAL NOT NULL DEFAULT 20,
      tps_max REAL NOT NULL DEFAULT 60,
      ttft_ms_min INTEGER NOT NULL DEFAULT 200,
      ttft_ms_max INTEGER NOT NULL DEFAULT 600,
      availability_level INTEGER NOT NULL DEFAULT 1,
      cache_hit_rate_min REAL NOT NULL DEFAULT 0,
      cache_hit_rate_max REAL NOT NULL DEFAULT 0,
      failure_delay_ms INTEGER NOT NULL DEFAULT 0,
      context_window INTEGER NOT NULL DEFAULT 128000,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY,
      request_id TEXT NOT NULL,
      api_key_id TEXT,
      api_key_name TEXT,
      model_id TEXT NOT NULL,
      endpoint TEXT NOT NULL,
      stream INTEGER NOT NULL DEFAULT 0,
      status INTEGER NOT NULL,
      finish_reason TEXT,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cached INTEGER NOT NULL DEFAULT 0,
      ttft_ms INTEGER,
      duration_ms INTEGER,
      tps REAL,
      error TEXT,
      created_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created ON requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_model ON requests(model_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_requests_key ON requests(api_key_id, created_at);
  `);

  // 向前兼容早于 failure_delay_ms 的数据库文件。
  const columns = database.prepare("PRAGMA table_info(models)").all();
  if (!columns.some((column) => column.name === "failure_delay_ms")) {
    database.exec("ALTER TABLE models ADD COLUMN failure_delay_ms INTEGER NOT NULL DEFAULT 0");
  }
}
