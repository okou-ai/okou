import { GptEncoding } from "gpt-tokenizer/GptEncoding";
import ranks from "gpt-tokenizer/bpeRanks/o200k_base";

let encoding: GptEncoding | undefined;

function memoryEncoding(): GptEncoding {
  // RPC sessions without memory need no token indexes. Keep first-use work
  // synchronous so memory budgets always use the complete, exact encoding.
  encoding ??= GptEncoding.getEncodingApi("o200k_base", () => {
    return ranks;
  });
  return encoding;
}

export function piMemorySummaryTokenCount(content: string): number {
  return memoryEncoding().encode(content).length;
}
