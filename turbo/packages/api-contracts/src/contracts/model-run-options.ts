import { normalizeBuiltInModelId } from "./model-providers";

/**
 * What the Fast service tier does to a model's speed and cost, for
 * display. Whether a route offers a tier, and a model's reasoning efforts, are
 * owned by the global model catalog (`model_routes`).
 *
 * Keys are canonical built-in model ids; unknown models have no multipliers.
 *
 * What the Fast service tier costs and gains on each route. Cost multipliers
 * scale the route's Standard price; speed multipliers are the published
 * figures, and an absent speed means the provider publishes no model-specific
 * number.
 */
export interface ModelFastServiceTierOptions {
  /** Okou credits charged relative to Standard on the built-in route. */
  readonly builtInCreditMultiplier: number;
  /** ChatGPT plan usage relative to Standard on a ChatGPT subscription. */
  readonly chatGptUsageMultiplier: number;
  /** Model speed on a ChatGPT subscription (https://developers.openai.com/codex/speed). */
  readonly chatGptSpeedMultiplier?: number;
}

export interface ModelRunOptions {
  /** Present only for models that support the Fast service tier. */
  readonly fast?: ModelFastServiceTierOptions;
}

const CODEX_FAST: ModelFastServiceTierOptions = {
  builtInCreditMultiplier: 2,
  chatGptUsageMultiplier: 2.5,
};

const MODEL_RUN_OPTIONS: Readonly<Record<string, ModelRunOptions>> =
  Object.freeze({
    "gpt-6-astra": {
      fast: { ...CODEX_FAST, chatGptSpeedMultiplier: 2 },
    },
    "gpt-6.1-sol": {
      fast: CODEX_FAST,
    },
    "gpt-6-sol": {
      fast: CODEX_FAST,
    },
    "gpt-6-luna": {
      fast: CODEX_FAST,
    },
    "gpt-5.6-sol": {
      fast: { ...CODEX_FAST, chatGptSpeedMultiplier: 1.5 },
    },
    "gpt-5.6-luna": {
      fast: { ...CODEX_FAST, chatGptSpeedMultiplier: 1.5 },
    },
  } satisfies Record<string, ModelRunOptions>);

const NO_RUN_OPTIONS: ModelRunOptions = Object.freeze({});

/** Look up a model's tier multipliers; unknown models have none. */
export function getModelRunOptions(
  model: string | null | undefined,
): ModelRunOptions {
  const bareModel = model?.startsWith("openai/")
    ? model.slice("openai/".length)
    : model;
  const canonical = normalizeBuiltInModelId(bareModel ?? "");
  return Object.hasOwn(MODEL_RUN_OPTIONS, canonical)
    ? (MODEL_RUN_OPTIONS[canonical] ?? NO_RUN_OPTIONS)
    : NO_RUN_OPTIONS;
}
