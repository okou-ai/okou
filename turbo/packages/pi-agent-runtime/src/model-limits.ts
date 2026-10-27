/** Verified corrections to the pinned Pi catalog; see model-limits-audit.md. */
interface PiModelLimits {
  readonly contextWindow: number;
  readonly maxTokens: number;
}

/**
 * Exact catalog bindings, not a second admission list or a live metadata cache.
 * Sandbox sessions receive these corrections through their bundled Runner CLI.
 */
const LIMITS_BY_PROVIDER: Readonly<
  Record<string, Readonly<Record<string, PiModelLimits>>>
> = {
  "openai-codex": {
    // Subscription runtime defaults are not the public API's total context.
    "gpt-6.1-sol": { contextWindow: 272_000, maxTokens: 128_000 },
    "gpt-6.1-terra": { contextWindow: 500_000, maxTokens: 128_000 },
  },
};

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
