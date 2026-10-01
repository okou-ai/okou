/** Display price tier type and long-context billing thresholds. */
export type ModelPriceTier = "$" | "$$" | "$$$" | "$$$$";

/**
 * Runner compatibility fallback only; not a pricing authority.
 *
 * Long-context thresholds are catalog data:
 * `model_routes.long_context_min_total_input_tokens` on each Built-in route
 * (NULL: single tier). The API captures the assigned route's value into the
 * run's execution context as `modelUsageLongContextMinTotalInputTokens`
 * (`0` for an explicit single tier), and admission preflight and Pi memory
 * Stage 1 read the catalog. This map is compiled into the Runner mitm addon
 * (`generate:python`) solely for claims from an API that predates the catalog
 * column and omits the field; the addon never consults it when the field is
 * present. Do not add entries for new models: a new model is priced by its
 * route row. Delete this map, its Python binding and the addon fallback once
 * no API version that omits the field is serving or a rollback target (see
 * docs/deployment-compatibility.md).
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
