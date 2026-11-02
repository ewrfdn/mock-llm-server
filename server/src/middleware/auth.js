import { authenticateToken, touchApiKey } from "../domain/api-keys.js";
import { forbidden, unauthorized } from "../lib/errors.js";

function readToken(req) {
  const header = req.get("authorization") || "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (match) return match[1].trim();
  const apiKeyHeader = req.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader.trim();
  return "";
}

/**
 * API Key 鉴权。scope 为空表示任意有效 Key，否则要求 Key 拥有对应 scope。
 */
export function requireApiKey(scope = null) {
  return function apiKeyMiddleware(req, res, next) {
    const token = readToken(req);
    const auth = token ? authenticateToken(token) : null;
    if (!auth) {
      next(unauthorized());
      return;
    }

    req.apiKey = auth.key;
    req.apiKeyScopes = auth.scopes;
    touchApiKey(auth.key.id);

    if (scope && !auth.scopes.includes(scope)) {
      next(forbidden(`当前 API Key 缺少 ${scope} 权限`, "insufficient_scope"));
      return;
    }

    next();
  };
}
