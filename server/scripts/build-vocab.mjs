import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { VOCAB_WORDS, VOCAB_TOKEN_COUNTS, getVocabStats } from "../src/simulation/vocab.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.join(here, "..", "src", "simulation", "vocab.generated.json");

const payload = {
  version: 1,
  generated_at: new Date().toISOString(),
  count: VOCAB_WORDS.length,
  words: VOCAB_WORDS,
  tokens: VOCAB_TOKEN_COUNTS,
};

fs.writeFileSync(target, `${JSON.stringify(payload)}\n`, "utf8");

const stats = getVocabStats();
console.log(`已生成 ${path.relative(process.cwd(), target)}`);
console.log(`词数：${stats.words}，平均 ${stats.average_tokens_per_word} tokens/词，总 token 数：${stats.total_tokens}`);
