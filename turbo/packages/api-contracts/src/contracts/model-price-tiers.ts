/** Display price tier type and long-context billing thresholds. */
export type ModelPriceTier = "$" | "$$" | "$$$" | "$$$$";

/**
 * Inclusive total-input boundary for built-in model long-context pricing,
 * keyed by `usage_pricing` provider (a route's `pricing_provider`), which is
 * the key the Runner mitm addon bills model usage under. Total input includes
 * uncached input, cache reads, and cache creation.
 *
 * This is billing protocol data compiled into the Runner through the
 * generated Python bindings (`generate:python`): the addon meters usage inside
 * the sandbox without an API round trip and receives no route or catalog data
 * at run time, so it cannot read the threshold from `model_routes`. It is not
 * a product list: a provider absent here bills a single tier, and admission,
 * names and availability never read it.
 */
export const MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS: Readonly<
  Record<string, number>
> = Object.freeze({
  "okou-1.0": 272_001,
  "gpt-6-astra": 272_001,
  "gpt-6.1-sol": 272_001,
  "gpt-6-sol": 272_001,
  "gpt-6-luna": 272_001,
  "gpt-5.5": 272_001,
  "gpt-5.6-sol": 272_001,
  "gpt-5.6-luna": 272_001,
});
