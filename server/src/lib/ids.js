import { randomBytes, randomUUID } from "node:crypto";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function randomString(length) {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i += 1) out += ALPHABET[bytes[i] % ALPHABET.length];
  return out;
}

export function newId(prefix = "id") {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

export function newRequestId() {
  return `req_${randomUUID().replaceAll("-", "").slice(0, 24)}`;
}

export function newCompletionId() {
  return `chatcmpl-${randomUUID().replaceAll("-", "").slice(0, 26)}`;
}

export function newApiKey() {
  return `mllm_${randomString(40)}`;
}

export function newUserId() {
  return newId("user");
}
