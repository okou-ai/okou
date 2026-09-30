/** Run model IDs known to the runtime, and the display price tier type. */
// Model IDs this code has runtime knowledge of (protocol adapters, run
// options, long-context billing). Names, order, availability, replacement and
// display price tiers come from the global model catalog.
export const SUPPORTED_RUN_MODELS = [
  "okou-1.0",
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5-5",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "gpt-6-astra",
  "gpt-6.1-sol",
  "gpt-6-sol",
  "gpt-6-luna",
  "gpt-5.6-sol",
  "gpt-5.6-luna",
  "gpt-5.5",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
] as const;

export type SupportedRunModel = (typeof SUPPORTED_RUN_MODELS)[number];

export type ModelPriceTier = "$" | "$$" | "$$$" | "$$$$";

/**
 * Inclusive total-input boundary for built-in model long-context pricing.
 * Total input includes uncached input, cache reads, and cache creation.
 */
export const MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS: Readonly<
  Partial<Record<SupportedRunModel, number>>
> = Object.freeze({
  "okou-1.0": 272_001,
  "gpt-6-astra": 272_001,
  "gpt-6.1-sol": 272_001,
  "gpt-6-sol": 272_001,
  "gpt-6-luna": 272_001,
  "gpt-5.5": 272_001,
  "gpt-5.6-sol": 272_001,
  "gpt-5.6-luna": 272_001,
} satisfies Partial<Record<SupportedRunModel, number>>);
