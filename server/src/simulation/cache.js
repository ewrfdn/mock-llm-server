import { config } from "../config.js";

/** modelId -> Map<cacheKey, entry>（Map 插入顺序即 LRU 顺序） */
const stores = new Map();

export function getCached(modelId, key) {
  if (config.cacheTtlMs <= 0 || config.cacheMaxEntries <= 0) return null;
  const store = stores.get(modelId);
  if (!store) return null;
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.created_at > config.cacheTtlMs) {
    store.delete(key);
    return null;
  }
  // 刷新 LRU
  store.delete(key);
  store.set(key, entry);
  return entry;
}

export function putCached(modelId, key, value) {
  if (config.cacheTtlMs <= 0 || config.cacheMaxEntries <= 0) return false;
  if (!value?.text || value.text.length > config.cacheMaxChars) return false;
  let store = stores.get(modelId);
  if (!store) {
    store = new Map();
    stores.set(modelId, store);
  }
  if (store.size >= config.cacheMaxEntries) {
    const oldest = store.keys().next().value;
    if (oldest !== undefined) store.delete(oldest);
  }
  store.set(key, { ...value, created_at: Date.now() });
  return true;
}

export function clearModelCache(modelId) {
  stores.delete(modelId);
}

export function clearAllCaches() {
  stores.clear();
}

export function cacheStats() {
  let entries = 0;
  for (const store of stores.values()) entries += store.size;
  return { entries, models: stores.size };
}
