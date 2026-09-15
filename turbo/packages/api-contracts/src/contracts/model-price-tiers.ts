/**
 * Canonical built-in run models and credit price tiers.
 *
 * Keep this module lightweight so public UI surfaces can read price tier data
 * without importing the full model provider contract schema.
 */
// Ordered by model family (claude → gpt → deepseek), and within each family
// from newest/highest capability to oldest/lowest. This order is load-bearing:
// it drives the model dropdown and all model-related UI via sortRowsByCatalog.
// Recognized wire and historical IDs. Use ACTIVE_RUN_MODELS for model selection.
export const SUPPORTED_RUN_MODELS = [
  "claude-fable-5-1",
  "claude-fable-5",
  "claude-opus-5",
  "claude-opus-4-8",
  "claude-sonnet-5",
  "claude-sonnet-4-6",
  "gpt-6-astra",
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "deepseek-v4.1-flash",
  "deepseek-v4-pro",
  "deepseek-v4-flash",
] as const;

export type SupportedRunModel = (typeof SUPPORTED_RUN_MODELS)[number];

export type ModelPriceTier = "$" | "$$" | "$$$" | "$$$$";

/**
 * User-facing credit cost tier for Built-in model offerings. Only applies to
 * the `built-in` provider type; BYOK providers pay the vendor directly and do not
 * carry a platform tier.
 */
export const BUILT_IN_MODEL_PRICE_TIER = Object.freeze<
  Record<SupportedRunModel, ModelPriceTier>
>({
  "claude-fable-5-1": "$$$$",
  "claude-fable-5": "$$$$",
  "claude-opus-5": "$$$",
  "gpt-6-astra": "$$$$",
  "gpt-5.6-sol": "$$$",
  "gpt-5.6-terra": "$$",
  "gpt-5.6-luna": "$",
  "gpt-5.5": "$$$",
  "claude-opus-4-8": "$$$",
  "claude-sonnet-5": "$$",
  "claude-sonnet-4-6": "$$",
  "deepseek-v4.1-flash": "$",
  "deepseek-v4-flash": "$",
  // Display tier only. Runtime token pricing is seeded separately.
  "deepseek-v4-pro": "$",
});

/**
 * Inclusive total-input boundary for built-in model long-context pricing.
 * Total input includes uncached input, cache reads, and cache creation.
 */
export const MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS: Readonly<
  Partial<Record<SupportedRunModel, number>>
> = Object.freeze({
  "gpt-6-astra": 272_001,
  "gpt-5.5": 272_001,
  "gpt-5.6-sol": 272_001,
  "gpt-5.6-terra": 272_001,
  "gpt-5.6-luna": 272_001,
} satisfies Partial<Record<SupportedRunModel, number>>);
