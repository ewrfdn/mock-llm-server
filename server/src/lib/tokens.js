/**
 * 词表 token 数的离线估算规则。
 *
 * 词表在构建 / 启动时用该规则为每个词算好 token 数并缓存，请求生成文本时
 * 只做整数相加，不再做任何分词。规则参考 cl100k 的常见切分：
 * 常见短词 1 token，长词 2-4 token，并保留至少 1 token。
 */
export function estimateWordTokens(word) {
  const length = String(word).replace(/[^A-Za-z0-9'-]/g, "").length;
  if (length <= 6) return 1;
  if (length <= 11) return 2;
  if (length <= 16) return 3;
  if (length <= 22) return 4;
  return Math.max(4, Math.ceil(length / 5));
}

/** 提示词里不在词表内的内容使用保守估算。 */
export function estimateUnknownToken(text) {
  const clean = String(text).trim();
  if (!clean) return 0;
  return Math.max(1, Math.ceil(clean.length / 4));
}
