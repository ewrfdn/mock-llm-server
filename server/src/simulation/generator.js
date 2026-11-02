import { VOCAB_WORDS, VOCAB_TOKEN_COUNTS, countTextTokens } from "./vocab.js";
import { uniformInt } from "../lib/random.js";

/**
 * 按目标 token 数从内存词表随机抽样。
 * 每个词的 token 数已在词表加载时算好，这里只做整数累加。
 */
export class WordStream {
  constructor({ targetTokens, rng = Math.random }) {
    this.target = Math.max(1, Math.floor(Number(targetTokens) || 1));
    this.rng = rng;
    this.produced = 0;
    this.sentenceLeft = uniformInt(8, 18, rng);
    this.sentenceStart = true;
  }

  nextToken(out) {
    if (this.produced >= this.target) return 0;
    const index = Math.floor(this.rng() * VOCAB_WORDS.length) % VOCAB_WORDS.length;
    let word = VOCAB_WORDS[index];
    const tokens = VOCAB_TOKEN_COUNTS[index];

    if (this.sentenceStart) {
      word = word.charAt(0).toUpperCase() + word.slice(1);
      this.sentenceStart = false;
    }

    this.sentenceLeft -= 1;
    if (this.sentenceLeft <= 0) {
      word += this.rng() < 0.12 ? "!" : ".";
      this.sentenceLeft = uniformInt(8, 18, this.rng);
      this.sentenceStart = true;
    }

    this.produced += tokens;
    out.push(word);
    return tokens;
  }

  /**
   * 生成至少 tokenBudget 个 token 的文本块。
   * 最后一个词可能让实际 token 数超出 budget 1-3 个，这是词表抽样的自然结果。
   */
  produce(tokenBudget) {
    const budget = Math.max(1, Math.floor(Number(tokenBudget) || 1));
    const parts = [];
    let tokens = 0;

    while (tokens < budget && this.produced < this.target) {
      const added = this.nextToken(parts);
      if (!added) break;
      tokens += added;
    }

    return {
      text: parts.join(" "),
      tokens,
      produced: this.produced,
      done: this.produced >= this.target,
    };
  }
}

export function buildText(targetTokens, rng = Math.random) {
  const stream = new WordStream({ targetTokens, rng });
  const chunk = stream.produce(stream.target);
  return { text: chunk.text, tokens: stream.produced };
}

export function extractMessageText(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (!part || typeof part !== "object") return String(part ?? "");
        if (typeof part.text === "string") return part.text;
        if (typeof part.input_text === "string") return part.input_text;
        if (part.type === "image_url" || part.type === "input_image") return "";
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return String(content);
}

export function countMessageTokens(messages) {
  let total = 3;
  for (const message of messages || []) {
    total += 4;
    total += countTextTokens(extractMessageText(message?.content));
    if (message?.role) total += 1;
    if (message?.name) total += countTextTokens(message.name) + 1;
    if (Array.isArray(message?.content)) {
      for (const part of message.content) {
        if (part?.type === "image_url" || part?.type === "input_image") total += 85;
      }
    }
    if (message?.tool_calls) total += countTextTokens(JSON.stringify(message.tool_calls));
  }
  return total;
}
