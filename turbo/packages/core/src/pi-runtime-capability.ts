/**
 * Model identities the pinned Pi runtime can resolve, grouped by the Pi catalog
 * provider that owns them.
 *
 * Identities are runtime knowledge, not a product model list. Built-in
 * Responses routes ask the runtime for the route's `upstream_model`, so a
 * model added only as catalog rows is admitted to Pi when its route points at
 * an upstream model listed here (for example a new catalog model whose
 * `openrouter-codex` route sends `openai/gpt-6-luna`). Only routes that pin
 * `catalogModel` (the Codex subscription and OpenRouter presets) resolve by
 * the catalog model ID.
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
export const PI_CATALOG_PROVIDERS = ["openai-codex", "openrouter"] as const;

export type PiCatalogProvider = (typeof PI_CATALOG_PROVIDERS)[number];

/** A model identity as the Pi runtime is asked to resolve it. */
export interface PiRuntimeIdentity {
  readonly provider: PiCatalogProvider;
  readonly model: string;
}

export const PI_RUNTIME_RESOLVABLE_MODELS = {
  "openai-codex": [
    "gpt-6.1-sol",
    "gpt-6-sol",
    "gpt-6-luna",
    "gpt-5.6-sol",
    "gpt-5.6-luna",
  ],
  openrouter: [
    "okou-1.0",
    "deepseek/deepseek-v4.1-flash",
    "deepseek/deepseek-v4-flash",
    "openai/gpt-6-sol",
    "openai/gpt-6-luna",
    "openai/gpt-5.6-sol",
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
