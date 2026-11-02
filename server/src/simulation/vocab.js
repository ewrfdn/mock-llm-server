import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORDS } from "./wordlist.js";
import { estimateWordTokens, estimateUnknownToken } from "../lib/tokens.js";
import { logger } from "../logger.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const generatedPath = path.join(here, "vocab.generated.json");
const TARGET_SIZE = 2000;

function normalize(words, tokenCounts) {
  const seen = new Set();
  const acceptedWords = [];
  const acceptedTokens = [];

  for (let index = 0; index < words.length; index += 1) {
    const word = String(words[index] ?? "").trim().toLowerCase();
    if (!word || seen.has(word)) continue;
    if (!/^[a-z][a-z'-]*$/.test(word)) continue;

    const provided = Number(tokenCounts?.[index]);
    const tokens = Number.isFinite(provided) && provided > 0 ? Math.round(provided) : estimateWordTokens(word);
    seen.add(word);
    acceptedWords.push(word);
    acceptedTokens.push(tokens);
  }

  // 源词表按主题排列（动词、形容词、名词……）。截断前做一次固定种子的洗牌，
  // 避免 2000 个词全部落在文件靠前的词性上。
  const shuffled = deterministicShuffle(
    acceptedWords.map((word, index) => ({ word, tokens: acceptedTokens[index] })),
  );
  return expandToTarget({
    words: shuffled.map((entry) => entry.word),
    tokens: shuffled.map((entry) => entry.tokens),
  });
}

function deterministicShuffle(items, seed = 0x5f3759df) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    [items[index], items[swapWith]] = [items[swapWith], items[index]];
  }
  return items;
}

/**
 * 源词表不足 2000 时，用规则的形态变化补齐；正常情况下不会触发。
 * 这只是兜底，保证对外暴露的词表规模稳定为 2000。
 */
function expandToTarget(vocabulary) {
  if (vocabulary.words.length >= TARGET_SIZE) {
    return {
      words: vocabulary.words.slice(0, TARGET_SIZE),
      tokens: vocabulary.tokens.slice(0, TARGET_SIZE),
    };
  }

  const seen = new Set(vocabulary.words);
  const suffixes = ["s", "ed", "ing", "ly", "er"];
  for (const base of [...vocabulary.words]) {
    if (!/^[a-z]{4,}$/.test(base)) continue;
    for (const suffix of suffixes) {
      const word = `${base}${suffix}`;
      if (word.length > 24 || seen.has(word)) continue;
      seen.add(word);
      vocabulary.words.push(word);
      vocabulary.tokens.push(estimateWordTokens(word));
      if (vocabulary.words.length >= TARGET_SIZE) return vocabulary;
    }
  }
  return vocabulary;
}

function loadVocabulary() {
  try {
    const parsed = JSON.parse(fs.readFileSync(generatedPath, "utf8"));
    if (Array.isArray(parsed.words) && parsed.words.length >= 100) {
      const normalized = normalize(parsed.words, parsed.tokens);
      logger.info(`已加载离线词表 vocab.generated.json（${normalized.words.length} 词）`);
      return normalized;
    }
  } catch {
    /* 没有预生成文件时使用源词表即时计算 */
  }

  const source = Array.isArray(WORDS) ? WORDS : String(WORDS).split(/\s+/);
  const normalized = normalize(source);
  if (normalized.words.length < TARGET_SIZE) {
    logger.warn(`词表仅 ${normalized.words.length} 个唯一词（目标 ${TARGET_SIZE}），可运行 npm run vocab:build 重新生成`);
  }
  return normalized;
}

const loaded = loadVocabulary();

export const VOCAB_WORDS = Object.freeze(loaded.words);
export const VOCAB_TOKEN_COUNTS = Object.freeze(loaded.tokens);
export const VOCAB_SIZE = loaded.words.length;
export const VOCAB_TOTAL_TOKENS = loaded.tokens.reduce((sum, value) => sum + value, 0);

const TOKEN_INDEX = new Map(loaded.words.map((word, index) => [word, loaded.tokens[index]]));

export function tokenCostOf(word) {
  const lower = String(word).toLowerCase();
  const known = TOKEN_INDEX.get(lower);
  return known === undefined ? estimateUnknownToken(lower) : known;
}

/** 提示词 token 估算：命中词表用离线 token 数，否则按字符数保守估算。 */
export function countTextTokens(text) {
  const input = String(text ?? "");
  if (!input) return 0;
  const pieces = input.match(/[A-Za-z0-9_'-]+|[^\s]/g) || [];
  let total = 0;
  for (const piece of pieces) {
    total += TOKEN_INDEX.get(piece.toLowerCase()) ?? estimateUnknownToken(piece);
  }
  return total;
}

export function getVocabStats() {
  return {
    words: VOCAB_SIZE,
    average_tokens_per_word: VOCAB_SIZE ? Math.round((VOCAB_TOTAL_TOKENS / VOCAB_SIZE) * 100) / 100 : 0,
    total_tokens: VOCAB_TOTAL_TOKENS,
    source: fs.existsSync(generatedPath) ? "generated" : "runtime",
  };
}
