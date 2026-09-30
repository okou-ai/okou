/** Display price tier type and long-context billing thresholds. */
export type ModelPriceTier = "$" | "$$" | "$$$" | "$$$$";

/**
 * Inclusive total-input boundary for built-in model long-context pricing,
 * keyed by `usage_pricing` provider or catalog model ID. Total input includes
 * uncached input, cache reads, and cache creation.
 *
 * The API resolves a run's threshold with
 * `modelLongContextMinTotalInputTokens` and sends it to the Runner as
 * `modelUsageLongContextMinTotalInputTokens`, so a route whose pricing
 * provider is an alias of an actual model inherits that model's threshold
 * without a new key here. The Runner mitm addon also compiles this map through
 * the generated Python bindings (`generate:python`) as the fallback for claims
 * from an API that does not send the threshold. It is not a product list: a
 * provider absent here bills a single tier, and admission, names and
 * availability never read it.
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

/**
 * The long-context threshold that applies to usage reported under
 * `usageProvider`, looked up by the pricing provider first and then by the
 * run's other model identities in order (the actual catalog model, then the
 * Built-in route's upstream model). A pricing alias therefore follows the
 * model it prices without a key of its own. `undefined` bills a single tier.
 */
export function modelLongContextMinTotalInputTokens(
  usageProvider: string | undefined,
  modelIdentities: readonly (string | undefined)[],
): number | undefined {
  if (!usageProvider) {
    return undefined;
  }
  for (const key of [usageProvider, ...modelIdentities]) {
    const threshold = key
      ? MODEL_LONG_CONTEXT_MIN_TOTAL_INPUT_TOKENS[key]
      : undefined;
    if (threshold !== undefined) {
      return threshold;
    }
  }
  return undefined;
}
