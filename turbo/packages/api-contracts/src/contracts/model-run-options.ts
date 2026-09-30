import { normalizeBuiltInModelId } from "./model-providers";

/**
 * Per-model run options: which reasoning efforts a model accepts, which one it
 * launches with, and what the Fast service tier does to its speed and cost.
 *
 * This is the one place to configure a model's options. Reasoning-effort
 * validation, the CLI's effort help and the composer's model panel all read it,
 * so adding a model or changing its multipliers is a single edit here.
 *
 * Keys are canonical built-in model ids. Retired run models keep their entries:
 * persisted member and thread `model_settings` maps still contain their keys and
 * must keep parsing.
 */

export const CODEX_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
] as const;

export const CLAUDE_CODE_EFFORTS = [
  "low",
  "medium",
  "high",
  "extra",
  "max",
  "ultracode",
] as const;

type CodexReasoningEffort = (typeof CODEX_REASONING_EFFORTS)[number];
type ClaudeCodeEffort = (typeof CLAUDE_CODE_EFFORTS)[number];
type RunOptionEffort = CodexReasoningEffort | ClaudeCodeEffort;

/**
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
  /** Reasoning efforts the model accepts, weakest first. Empty when it has none. */
  readonly efforts: readonly RunOptionEffort[];
  /** The effort a model launches with when the user has not chosen one. */
  readonly defaultEffort?: RunOptionEffort;
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
      efforts: CODEX_REASONING_EFFORTS,
      defaultEffort: "max",
      fast: { ...CODEX_FAST, chatGptSpeedMultiplier: 2 },
      ultrafast: { apiCostMultiplier: 6, speedMultiplier: 8 },
    },
    "gpt-6.1-sol": {
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "medium",
      fast: CODEX_FAST,
    },
    "gpt-6-sol": {
      efforts: CODEX_REASONING_EFFORTS,
      defaultEffort: "max",
      fast: CODEX_FAST,
    },
    "gpt-6-luna": {
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "max",
      fast: CODEX_FAST,
    },
    "gpt-5.6-sol": {
      efforts: CODEX_REASONING_EFFORTS,
      defaultEffort: "max",
      fast: {
        ...CODEX_FAST,
        chatGptSpeedMultiplier: 1.5,
        apiSpeedMultiplier: 2.5,
      },
    },
    "gpt-5.6-luna": {
      efforts: ["low", "medium", "high", "xhigh", "max"],
      defaultEffort: "max",
      fast: { ...CODEX_FAST, chatGptSpeedMultiplier: 1.5 },
    },
    "gpt-5.5": {
      efforts: ["low", "medium", "high", "xhigh"],
      defaultEffort: "xhigh",
    },
    "claude-fable-5-1": {
      efforts: CLAUDE_CODE_EFFORTS,
      defaultEffort: "max",
    },
    "claude-opus-5-5": {
      efforts: CLAUDE_CODE_EFFORTS,
      defaultEffort: "medium",
    },
    "claude-opus-5": { efforts: CLAUDE_CODE_EFFORTS, defaultEffort: "high" },
    "claude-opus-4-8": { efforts: CLAUDE_CODE_EFFORTS, defaultEffort: "high" },
    "claude-sonnet-5-5": {
      efforts: CLAUDE_CODE_EFFORTS,
      defaultEffort: "high",
    },
    "claude-sonnet-5": { efforts: CLAUDE_CODE_EFFORTS, defaultEffort: "high" },
    "claude-sonnet-4-6": {
      efforts: ["low", "medium", "high", "max"],
      defaultEffort: "high",
    },
    "deepseek-v4-flash": {
      efforts: ["low", "high", "xhigh", "max"],
      defaultEffort: "high",
    },
    "deepseek-v4-pro": {
      efforts: ["high", "xhigh", "max"],
      defaultEffort: "high",
    },
  } satisfies Record<string, ModelRunOptions>);

const NO_RUN_OPTIONS: ModelRunOptions = Object.freeze({ efforts: [] });

/** Look up a model's options; unknown models have none. */
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
