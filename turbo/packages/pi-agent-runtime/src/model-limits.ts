/** Verified corrections to the pinned Pi catalog; see model-limits-audit.md. */
interface PiModelLimits {
  readonly contextWindow: number;
  readonly maxTokens: number;
}

const OPENAI_API_LIMITS = {
  contextWindow: 1_050_000,
  maxTokens: 128_000,
} as const;

const DEEPSEEK_V41_LIMITS = {
  contextWindow: 1_048_576,
  maxTokens: 393_216,
} as const;

/**
 * Exact catalog bindings, not a second admission list or a live metadata cache.
 * Included in installed-CLI parity so a corrected API cannot reuse stale limits.
 */
export const PI_MODEL_LIMIT_OVERRIDES = {
  openai: {
    "gpt-6-sol": OPENAI_API_LIMITS,
    "gpt-6-luna": OPENAI_API_LIMITS,
    "gpt-5.6-sol": OPENAI_API_LIMITS,
    "gpt-5.6-luna": OPENAI_API_LIMITS,
  },
  "openai-codex": {
    // Subscription runtime defaults are not the public API's total context.
    "gpt-6.1-sol": { contextWindow: 272_000, maxTokens: 128_000 },
  },
  deepseek: {
    "deepseek-flash": DEEPSEEK_V41_LIMITS,
    "deepseek-v4.1-flash": DEEPSEEK_V41_LIMITS,
  },
  openrouter: {
    // Gateway primary-provider ceiling, not DeepSeek's direct API ceiling.
    "deepseek/deepseek-v4.1-flash": {
      contextWindow: 1_048_576,
      maxTokens: 943_718,
    },
  },
} as const satisfies Record<string, Record<string, PiModelLimits>>;

const LIMITS_BY_PROVIDER: Readonly<
  Record<string, Readonly<Record<string, PiModelLimits>>>
> = PI_MODEL_LIMIT_OVERRIDES;

export function piModelLimitOverride(
  provider: string,
  catalogModel: string,
): PiModelLimits | undefined {
  if (!Object.hasOwn(LIMITS_BY_PROVIDER, provider)) return undefined;
  const models = LIMITS_BY_PROVIDER[provider];
  return models && Object.hasOwn(models, catalogModel)
    ? models[catalogModel]
    : undefined;
}
