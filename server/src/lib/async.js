export function delay(ms) {
  const wait = Math.max(0, Math.floor(ms));
  return new Promise((resolve) => setTimeout(resolve, wait));
}

export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
