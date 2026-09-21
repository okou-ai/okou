import {
  getBuiltInModelRouteCandidates,
  getProviderRuntimeModel,
  isActiveRunModel,
  isBuiltInModelProviderType,
  isModelSupportedByProvider,
  modelProviderTypeSchema,
  type ActiveRunModel,
  type BuiltInModelRouteProviderType,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";

import {
  isPiRuntimeIdentityResolvable,
  type PiCatalogProvider,
  type PiRuntimeIdentity,
} from "./pi-runtime-capability";

/**
 * Why a model or route stays off the Pi loop, and what would change it.
 *
 * - `frontier-vendor-harness`: the model line runs on its vendor's own harness.
 *   Re-evaluated only when that principle changes.
 * - `subscription-terms`: the vendor's subscription terms do not permit Pi to
 *   use the credential. Never re-evaluated.
 * - `capability`: the pinned Pi runtime cannot resolve the model. The dynamic
 *   gate in `isPiRouteRuntimeCapable` does clear itself once the pinned SDK
 *   catalog carries the identity, but a model also pinned `pi: false` here for
 *   this reason — `gpt-6-sol` today — still needs a human to flip the table.
 *   Keeping the static exclusion is deliberate: a model must not reach Pi
 *   without a recorded decision and a billing check.
 */
export type PiExclusionReason =
  | "frontier-vendor-harness"
  | "subscription-terms"
  | "capability";

/** Which family of route rules a Pi-eligible model is admitted through. */
export type PiRouteClass = "claude-native" | "gpt-codex" | "deepseek";

export type PiModelPolicy =
  | { readonly pi: true; readonly route: PiRouteClass }
  | {
      readonly pi: false;
      readonly exception: PiExclusionReason;
      readonly reason: string;
    };

/**
 * The exhaustive Pi admission decision for every active run model.
 *
 * `satisfies Record<ActiveRunModel, PiModelPolicy>` is the enforcement: adding
 * a model to `SUPPORTED_RUN_MODELS` fails type-check until a decision is
 * recorded here, so admission, credential capture and API-owned billing can no
 * longer drift apart behind a comment. Admission narrows here only; the Gen4
 * reader vocabulary in `pi-native-models.ts` stays frozen.
 */
export const PI_MODEL_POLICY = {
  "claude-fable-5-1": {
    pi: false,
    exception: "frontier-vendor-harness",
    reason: "The Fable frontier line runs on the Claude Code vendor harness.",
  },
  "claude-opus-5": { pi: true, route: "claude-native" },
  "claude-opus-4-8": { pi: true, route: "claude-native" },
  "claude-sonnet-5": { pi: true, route: "claude-native" },
  "claude-sonnet-4-6": { pi: true, route: "claude-native" },
  "gpt-6-astra": {
    pi: false,
    exception: "frontier-vendor-harness",
    reason: "The Astra frontier line runs on the Codex vendor harness.",
  },
  "gpt-6-sol": {
    pi: false,
    exception: "capability",
    reason:
      "Pre-launch and absent from the pinned Pi SDK catalog on every route.",
  },
  "gpt-5.6-sol": { pi: true, route: "gpt-codex" },
  "gpt-5.6-terra": { pi: true, route: "gpt-codex" },
  "gpt-5.6-luna": { pi: true, route: "gpt-codex" },
  "deepseek-v4.1-flash": { pi: true, route: "deepseek" },
  "deepseek-v4-pro": { pi: true, route: "deepseek" },
  "deepseek-v4-flash": { pi: true, route: "deepseek" },
} as const satisfies Record<ActiveRunModel, PiModelPolicy>;

/** Fails to compile when the table and `ActiveRunModel` stop covering each other. */
type AssertTrue<T extends true> = T;
type Identical<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
    ? true
    : false;
export type PiModelPolicyCoversEveryActiveModel = AssertTrue<
  Identical<keyof typeof PI_MODEL_POLICY, ActiveRunModel>
>;

type PiModelOfRouteClass<R extends PiRouteClass> = {
  [K in keyof typeof PI_MODEL_POLICY]: (typeof PI_MODEL_POLICY)[K] extends {
    readonly pi: true;
    readonly route: R;
  }
    ? K
    : never;
}[keyof typeof PI_MODEL_POLICY];

export type PiGptModel = PiModelOfRouteClass<"gpt-codex">;

export type PiDeepSeekModel = PiModelOfRouteClass<"deepseek">;

function activeRunModel(
  model: string | null | undefined,
): ActiveRunModel | null {
  return typeof model === "string" && isActiveRunModel(model) ? model : null;
}

function piRouteClass(model: string | null | undefined): PiRouteClass | null {
  const active = activeRunModel(model);
  if (active === null) {
    return null;
  }
  const policy: PiModelPolicy = PI_MODEL_POLICY[active];
  return policy.pi ? policy.route : null;
}

export function isPiGptModel(
  model: string | null | undefined,
): model is PiGptModel {
  return piRouteClass(model) === "gpt-codex";
}

export function isPiDeepSeekModel(
  model: string | null | undefined,
): model is PiDeepSeekModel {
  return piRouteClass(model) === "deepseek";
}

export function isPiNativeModel(model: string | null | undefined): boolean {
  return piRouteClass(model) === "claude-native";
}

/** Routes the Pi loop must never take, with the exception class that owns them. */
const PI_EXCLUDED_ROUTES = {
  // Anthropic's subscription terms do not permit Pi to use this credential.
  // `codex-oauth-token` carries no such restriction and stays admitted.
  "claude-code-oauth-token": "subscription-terms",
} as const satisfies Partial<Record<ModelProviderType, PiExclusionReason>>;

export function isPiNativeRoute(
  type: string | null | undefined,
  model: string | null | undefined,
): boolean {
  const provider = modelProviderTypeSchema.safeParse(type);
  return (
    isPiNativeModel(model) &&
    typeof model === "string" &&
    provider.success &&
    !Object.hasOwn(PI_EXCLUDED_ROUTES, provider.data) &&
    (provider.data === "custom-anthropic-messages" ||
      isModelSupportedByProvider(model, provider.data))
  );
}

function isGptApiKeyPiProviderType(value: string | null | undefined): boolean {
  return (
    value === "openai-api-key" ||
    value === "openrouter-codex" ||
    value === "vercel-ai-gateway-codex"
  );
}

function isDeepSeekPiProviderType(
  value: string | null | undefined,
): value is "deepseek" | "openrouter-codex" {
  return value === "deepseek" || value === "openrouter-codex";
}

/** Route rules, unchanged: model policy decides eligibility, this decides reach. */
function isPiRouteAdmitted(args: {
  readonly model: ActiveRunModel;
  readonly route: PiRouteClass;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
  readonly codexServiceTier: "fast" | undefined;
}): boolean {
  if (args.route === "claude-native") {
    return isPiNativeRoute(args.modelProviderType, args.model);
  }
  const builtIn = isBuiltInModelProviderType(args.modelProviderType);
  const custom = args.modelProviderType === "custom-openai-responses";
  if (args.route === "deepseek") {
    return (
      (builtIn && isDeepSeekPiProviderType(args.runtimeProviderType)) ||
      custom ||
      (isDeepSeekPiProviderType(args.modelProviderType) &&
        isModelSupportedByProvider(args.model, args.modelProviderType))
    );
  }
  const direct =
    args.modelProviderType === "codex-oauth-token" ||
    isGptApiKeyPiProviderType(args.modelProviderType);
  if (!builtIn && !custom && !direct) return false;
  // Codex fast tier is only honoured on a runtime route that can carry it.
  return (
    args.codexServiceTier === undefined ||
    custom ||
    direct ||
    (builtIn &&
      (args.runtimeProviderType === "openai-api-key" ||
        args.runtimeProviderType === "openrouter-codex"))
  );
}

function builtInCatalogProvider(
  type: BuiltInModelRouteProviderType,
): PiCatalogProvider | null {
  switch (type) {
    case "deepseek": {
      return "deepseek";
    }
    case "openai-api-key": {
      return "openai";
    }
    case "openrouter-codex": {
      return "openrouter";
    }
    default: {
      // Anthropic vendors reach Pi through the native dialect, which resolves
      // its capabilities from the `anthropic` catalog instead.
      return null;
    }
  }
}

function builtInRouteIdentities(
  model: ActiveRunModel,
  runtimeProviderType: string | null | undefined,
): readonly PiRuntimeIdentity[] {
  const candidates = getBuiltInModelRouteCandidates(model);
  const selected = candidates.filter((candidate) => {
    return candidate.providerType === runtimeProviderType;
  });
  // Built-in availability routing picks the vendor at launch. When the caller
  // already knows it, gate on that one; otherwise every candidate the run could
  // land on has to resolve.
  const targets = selected.length > 0 ? selected : candidates;
  const identities: PiRuntimeIdentity[] = [];
  for (const target of targets) {
    const provider = builtInCatalogProvider(target.providerType);
    if (provider === null) {
      return [];
    }
    identities.push({ provider, model: target.upstreamModel });
  }
  return identities;
}

function responsesRouteIdentity(
  route: "gpt-codex" | "deepseek",
  model: ActiveRunModel,
  providerType: ModelProviderType,
): PiRuntimeIdentity | null {
  switch (providerType) {
    case "codex-oauth-token": {
      return { provider: "openai-codex", model };
    }
    // Both gateways send an aliased request model but pin `catalogModel` to the
    // selected model, so capability follows the selected model itself.
    case "custom-openai-responses":
    case "vercel-ai-gateway-codex": {
      return {
        provider: route === "gpt-codex" ? "openai" : "deepseek",
        model,
      };
    }
    case "openai-api-key": {
      return {
        provider: "openai",
        model: getProviderRuntimeModel(providerType, model),
      };
    }
    case "openrouter-codex": {
      return {
        provider: "openrouter",
        model: getProviderRuntimeModel(providerType, model),
      };
    }
    case "deepseek": {
      return {
        provider: "deepseek",
        model: getProviderRuntimeModel(providerType, model),
      };
    }
    default: {
      return null;
    }
  }
}

/**
 * The Pi catalog identities a route would ask the runtime to resolve, mirroring
 * the launch metadata built in `pi-sandbox-config.ts`. An empty result means no
 * identity is derivable, which fails the capability gate closed.
 */
export function piRouteCatalogIdentities(args: {
  readonly selectedModel: string | null | undefined;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
}): readonly PiRuntimeIdentity[] {
  const model = activeRunModel(args.selectedModel);
  const route = piRouteClass(args.selectedModel);
  const provider = modelProviderTypeSchema.safeParse(args.modelProviderType);
  if (model === null || route === null || !provider.success) {
    return [];
  }
  if (route === "claude-native") {
    // Every native route, Bedrock included, resolves its capabilities from Pi's
    // `anthropic` catalog with the selected model as `catalogModel`.
    return [{ provider: "anthropic", model }];
  }
  if (isBuiltInModelProviderType(provider.data)) {
    return builtInRouteIdentities(model, args.runtimeProviderType);
  }
  const identity = responsesRouteIdentity(route, model, provider.data);
  return identity === null ? [] : [identity];
}

/**
 * Model policy and route rules only, without the runtime capability gate. The
 * capability tests enumerate from here so that dropping an identity from the
 * capability data shows up as a disagreement with the resolver rather than
 * quietly shrinking the set of routes under test.
 */
export function isPiPolicyAdmittedRoute(args: {
  readonly selectedModel: string | null | undefined;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
  readonly codexServiceTier: "fast" | undefined;
}): boolean {
  const model = activeRunModel(args.selectedModel);
  const route = piRouteClass(args.selectedModel);
  return (
    model !== null &&
    route !== null &&
    isPiRouteAdmitted({
      model,
      route,
      modelProviderType: args.modelProviderType,
      runtimeProviderType: args.runtimeProviderType,
      codexServiceTier: args.codexServiceTier,
    })
  );
}

/** The pinned Pi runtime can resolve every identity this route may request. */
export function isPiRouteRuntimeCapable(args: {
  readonly selectedModel: string | null | undefined;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
}): boolean {
  const identities = piRouteCatalogIdentities(args);
  return (
    identities.length > 0 && identities.every(isPiRuntimeIdentityResolvable)
  );
}

/**
 * Shared by Chat controls and server admission; trigger source does not select
 * a runtime. Admission is model policy, then route rules, then runtime
 * capability: a capability miss falls back to the legacy loop instead of
 * reaching the session-creation throw in `@okouai/pi-agent-runtime`.
 */
export function isPiExecutionRoute(args: {
  readonly selectedModel: string | null | undefined;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
  readonly codexServiceTier: "fast" | undefined;
  readonly piEnabled: boolean;
}): boolean {
  return (
    args.piEnabled &&
    isPiPolicyAdmittedRoute(args) &&
    isPiRouteRuntimeCapable(args)
  );
}
