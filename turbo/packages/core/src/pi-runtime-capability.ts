/**
 * Model identities the pinned Pi runtime can resolve, grouped by the Pi catalog
 * provider that owns them.
 *
 * This is a leaf data module on purpose. `@okouai/core/pi-execution` is part of
 * the Platform browser bundle graph, so Pi admission must never reach for
 * `@earendil-works/pi-ai` to answer a capability question. The entries below
 * mirror what `sourceModel` in `@okouai/pi-agent-runtime` resolves, including
 * its sanctioned hand-pinned definitions for identities the upstream catalog
 * does not ship, so deriving them from an upstream provider catalog alone would
 * be wrong.
 *
 * The list is verified rather than remembered: `pi-runtime-capability.test.ts`
 * in `@okouai/pi-agent-runtime` runs the real resolver over every admitted
 * route and fails when this module and the runtime disagree in either
 * direction.
 */
export const PI_CATALOG_PROVIDERS = [
  "anthropic",
  "deepseek",
  "openai",
  "openai-codex",
  "openrouter",
] as const;

export type PiCatalogProvider = (typeof PI_CATALOG_PROVIDERS)[number];

/** A model identity as the Pi runtime is asked to resolve it. */
export interface PiRuntimeIdentity {
  readonly provider: PiCatalogProvider;
  readonly model: string;
}

export const PI_RUNTIME_RESOLVABLE_MODELS = {
  // `claude-fable-5-1` is absent because the Fable frontier line runs on the
  // Claude Code vendor harness, so no admitted route asks Pi to resolve it.
  anthropic: ["claude-opus-5-5", "claude-opus-5", "claude-sonnet-5"],
  // `deepseek-flash` and `deepseek-v4.1-flash` exist only as hand-pinned
  // definitions; the pinned upstream DeepSeek catalog does not carry them.
  deepseek: ["deepseek-flash", "deepseek-v4.1-flash", "deepseek-v4-flash"],
  openai: [
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ],
  "openai-codex": [
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ],
  openrouter: [
    "okou-1.0",
    "okou-1.0-pro",
    "okou-1.0-max",
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4-flash",
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    "openai/gpt-5.6-sol",
    "openai/gpt-5.6-terra",
    "openai/gpt-5.6-luna",
  ],
} as const satisfies Record<PiCatalogProvider, readonly string[]>;

const RESOLVABLE_BY_PROVIDER: Readonly<
  Record<PiCatalogProvider, readonly string[]>
> = PI_RUNTIME_RESOLVABLE_MODELS;

export function isPiRuntimeIdentityResolvable(
  identity: PiRuntimeIdentity,
): boolean {
  return RESOLVABLE_BY_PROVIDER[identity.provider].includes(identity.model);
}
