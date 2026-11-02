export class AppError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function badRequest(message, code = "invalid_request", details) {
  return new AppError(400, code, message, details);
}

export function notFound(message, code = "not_found") {
  return new AppError(404, code, message);
}

export function conflict(message, code = "conflict") {
  return new AppError(409, code, message);
}

export function forbidden(message, code = "forbidden") {
  return new AppError(403, code, message);
}

export function unauthorized(message = "Missing or invalid API key", code = "invalid_api_key") {
  return new AppError(401, code, message);
}

/** OpenAI 风格的错误响应体 */
export function openAiErrorBody({ message, type = "invalid_request_error", code = null, param = null }) {
  return { error: { message, type, param, code } };
}

/** 管理台 / 通用错误响应体 */
export function appErrorBody({ message, code = "error", details }) {
  return { error: { code, message, ...(details ? { details } : {}) } };
}

export function zodDetails(error) {
  return (error?.issues || []).map((issue) => ({
    path: Array.isArray(issue.path) ? issue.path.join(".") : String(issue.path ?? ""),
    message: issue.message,
  }));
}
