import { normalizeBuiltInModelId } from "./model-providers";

/**
 * What the Fast and Ultrafast service tiers do to a model's speed and cost, for
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
  /** API token cost relative to Standard on an OpenAI API key. */
  readonly apiCostMultiplier: number;
  /** Best-case model speed on an OpenAI API key (https://developers.openai.com/api/docs/guides/fast-mode). */
  readonly apiSpeedMultiplier?: number;
}

export interface ModelUltrafastServiceTierOptions {
  /** Direct OpenAI API key token cost relative to Standard. */
  readonly apiCostMultiplier: number;
  /** Published upper bound on token generation speed in Codex. */
  readonly speedMultiplier: number;
}

export interface ModelRunOptions {
  /** Present only for models that support the Fast service tier. */
  readonly fast?: ModelFastServiceTierOptions;
  /** API-key-only Ultrafast; not available on subscriptions or gateways. */
  readonly ultrafast?: ModelUltrafastServiceTierOptions;
}

const CODEX_FAST: ModelFastServiceTierOptions = {
  builtInCreditMultiplier: 2,
  chatGptUsageMultiplier: 2.5,
  apiCostMultiplier: 2,
};

const MODEL_RUN_OPTIONS: Readonly<Record<string, ModelRunOptions>> =
  Object.freeze({
    "gpt-6-astra": {
      fast: { ...CODEX_FAST, chatGptSpeedMultiplier: 2 },
      ultrafast: { apiCostMultiplier: 6, speedMultiplier: 8 },
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
      fast: {
        ...CODEX_FAST,
        chatGptSpeedMultiplier: 1.5,
        apiSpeedMultiplier: 2.5,
      },
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
