/**
 * What the Fast service tier does to a model's cost, for display. Whether a
 * route offers a tier, and a model's reasoning efforts, are owned by the
 * global model catalog (`model_routes`).
 *
 * Keys are canonical ChatGPT subscription model ids; unknown models have no
 * multipliers.
 */
export interface ModelFastServiceTierOptions {
  /** ChatGPT plan usage relative to Standard on a ChatGPT subscription. */
  readonly chatGptUsageMultiplier: number;
}

export interface ModelRunOptions {
  /** Present only for models that support the Fast service tier. */
  readonly fast?: ModelFastServiceTierOptions;
}

const CODEX_FAST_RUN_OPTIONS: ModelRunOptions = Object.freeze({
  fast: Object.freeze({ chatGptUsageMultiplier: 2.5 }),
});

const MODEL_RUN_OPTIONS: Readonly<Record<string, ModelRunOptions>> =
  Object.freeze({
    "gpt-6-astra": CODEX_FAST_RUN_OPTIONS,
    "gpt-6.1-sol": CODEX_FAST_RUN_OPTIONS,
    "gpt-6-sol": CODEX_FAST_RUN_OPTIONS,
    "gpt-6-luna": CODEX_FAST_RUN_OPTIONS,
    "gpt-5.6-sol": CODEX_FAST_RUN_OPTIONS,
    "gpt-5.6-luna": CODEX_FAST_RUN_OPTIONS,
  });

const NO_RUN_OPTIONS: ModelRunOptions = Object.freeze({});

/** Look up a model's tier multipliers; unknown models have none. */
export function getModelRunOptions(
  model: string | null | undefined,
): ModelRunOptions {
  return model && Object.hasOwn(MODEL_RUN_OPTIONS, model)
    ? (MODEL_RUN_OPTIONS[model] ?? NO_RUN_OPTIONS)
    : NO_RUN_OPTIONS;
}
