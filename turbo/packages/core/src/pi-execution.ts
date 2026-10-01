import {
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  isPiRouteClass,
  ownRoutesAllowCustomGateway,
  type PiRouteClass,
} from "@okouai/api-contracts/contracts/model-catalog";

import {
  isPiRuntimeIdentityResolvable,
  type PiCatalogProvider,
  type PiRuntimeIdentity,
} from "./pi-runtime-capability";

export type { PiRouteClass };

/**
 * Why a route stays off the Pi loop even when its model is Pi-eligible.
 *
 * - `subscription-terms`: the vendor's subscription terms do not permit Pi to
 *   use the credential. Never re-evaluated.
 *
 * Model eligibility itself is catalog data (`run_model_catalog.pi_route_class`,
 * NULL = not eligible, the default for a new model); this module keeps only
 * protocol rules and terms restrictions.
 */
export type PiExclusionReason = "subscription-terms";

/** One enabled catalog route as Pi admission reads it. */
export interface PiCatalogRoute {
  /** Provider that serves the request (`concrete_provider_type`). */
  readonly concreteProviderType: string;
  readonly upstreamModel: string;
  readonly serviceTiers: readonly string[];
}

/**
 * The catalog facts about one model that Pi admission reads, built from
 * `run_model_catalog` and its enabled `model_routes` by `piCatalogModel`.
 */
export interface PiCatalogModel {
  readonly model: string;
  /** `run_model_catalog.pi_route_class`; null means not Pi-eligible. */
  readonly piRouteClass: PiRouteClass | null;
  /** Enabled Built-in candidates in ascending fallback priority. */
  readonly builtIn: readonly PiCatalogRoute[];
  /** Enabled non-Built-in routes by provider type. */
  readonly own: ReadonlyMap<string, PiCatalogRoute>;
  /** Whether an organization's custom gateway may serve the model. */
  readonly customGatewayAllowed: boolean;
}

/** The catalog shape shared by the API snapshot and `GET /api/model-catalog`. */
export interface PiCatalogSource {
  readonly models: readonly {
    readonly model: string;
    readonly piRouteClass: string | null;
  }[];
  readonly routes: readonly {
    readonly model: string;
    readonly providerType: string;
    readonly concreteProviderType: string;
    readonly subscriptionType: string | null;
    readonly upstreamModel: string;
    readonly enabled: boolean;
    readonly priority: number;
    readonly serviceTiers: readonly string[];
  }[];
}

/**
 * Project one catalog model for Pi admission. A model outside the catalog is
 * null, which no Pi rule admits.
 */
export function piCatalogModel(
  catalog: PiCatalogSource,
  model: string | null | undefined,
): PiCatalogModel | null {
  const row = catalog.models.find((entry) => {
    return entry.model === model;
  });
  if (!row) {
    return null;
  }
  const routes = catalog.routes
    .filter((route) => {
      return route.enabled && route.model === row.model;
    })
    .sort((left, right) => {
      return left.priority - right.priority;
    });
  const toRoute = (route: (typeof routes)[number]): PiCatalogRoute => {
    return {
      concreteProviderType: route.concreteProviderType,
      upstreamModel: route.upstreamModel,
      serviceTiers: route.serviceTiers,
    };
  };
  const ownRoutes = routes.filter((route) => {
    return !isBuiltInModelProviderType(route.providerType);
  });
  const own = new Map<string, PiCatalogRoute>();
  // A provider-selected row wins over an Auto-mode subscription row.
  const ordered = [
    ...ownRoutes.filter((route) => {
      return route.subscriptionType === null;
    }),
    ...ownRoutes.filter((route) => {
      return route.subscriptionType !== null;
    }),
  ];
  for (const route of ordered) {
    if (!own.has(route.providerType)) {
      own.set(route.providerType, toRoute(route));
    }
  }
  return {
    model: row.model,
    piRouteClass: isPiRouteClass(row.piRouteClass) ? row.piRouteClass : null,
    builtIn: routes
      .filter((route) => {
        return isBuiltInModelProviderType(route.providerType);
      })
      .map(toRoute),
    own,
    customGatewayAllowed: ownRoutesAllowCustomGateway(
      ownRoutes.map((route) => {
        return route.providerType;
      }),
    ),
  };
}

function piRouteClass(model: PiCatalogModel | null): PiRouteClass | null {
  return model?.piRouteClass ?? null;
}

/** Routes the Pi loop must never take, with the exception class that owns them. */
const PI_EXCLUDED_ROUTES = {
  // Anthropic's subscription terms do not permit Pi to use this credential.
  // `codex-oauth-token` carries no such restriction and stays admitted.
  "claude-code-oauth-token": "subscription-terms",
} as const satisfies Partial<Record<ModelProviderType, PiExclusionReason>>;

/**
 * Codex Fast is carried on the wire as the `priority` service tier; a route
 * offers it only when its catalog row lists that tier.
 */
function routeCarriesFast(route: PiCatalogRoute | undefined): boolean {
  return route?.serviceTiers.includes("priority") ?? false;
}

function builtInRuntimeRoute(
  model: PiCatalogModel,
  runtimeProviderType: string | null | undefined,
): PiCatalogRoute | undefined {
  return model.builtIn.find((route) => {
    return route.concreteProviderType === runtimeProviderType;
  });
}

export function isPiNativeRoute(
  type: string | null | undefined,
  model: PiCatalogModel | null,
): boolean {
  const provider = modelProviderTypeSchema.safeParse(type);
  if (
    model === null ||
    piRouteClass(model) !== "claude-native" ||
    !provider.success ||
    Object.hasOwn(PI_EXCLUDED_ROUTES, provider.data)
  ) {
    return false;
  }
  if (provider.data === "custom-anthropic-messages") {
    return model.customGatewayAllowed;
  }
  if (isBuiltInModelProviderType(provider.data)) {
    return model.builtIn.length > 0;
  }
  return model.own.has(provider.data);
}

/** Direct Responses routes the Pi GPT dialect speaks. */
function isGptDirectPiProviderType(value: string | null | undefined): boolean {
  return (
    value === "codex-oauth-token" ||
    value === "openai-api-key" ||
    value === "openrouter-codex" ||
    value === "vercel-ai-gateway-codex"
  );
}

/** Runtime providers that honour Codex Fast on a Built-in route. */
function isFastCapableBuiltInRuntime(
  value: string | null | undefined,
): boolean {
  return value === "openai-api-key" || value === "openrouter-codex";
}

function isDeepSeekPiProviderType(value: string | null | undefined): boolean {
  return value === "deepseek" || value === "openrouter-codex";
}

function isBuiltInRouteAdmitted(
  model: PiCatalogModel,
  modelProviderType: string | null | undefined,
  runtimeProviderType: string | null | undefined,
): boolean {
  if (!isBuiltInModelProviderType(modelProviderType)) return false;
  // Admitted on one of the model's enabled Built-in candidates, or before the
  // vendor is picked (every candidate must then pass the capability gate).
  const runtimeUnpicked =
    runtimeProviderType === null ||
    runtimeProviderType === undefined ||
    isBuiltInModelProviderType(runtimeProviderType);
  return (
    model.builtIn.length > 0 &&
    (runtimeUnpicked ||
      builtInRuntimeRoute(model, runtimeProviderType) !== undefined)
  );
}

function isDeepSeekRouteAdmitted(args: {
  readonly model: PiCatalogModel;
  readonly builtIn: boolean;
  readonly custom: boolean;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
}): boolean {
  return (
    (args.builtIn && isDeepSeekPiProviderType(args.runtimeProviderType)) ||
    args.custom ||
    (isDeepSeekPiProviderType(args.modelProviderType) &&
      args.model.own.has(args.modelProviderType ?? ""))
  );
}

function isGptRouteAdmitted(args: {
  readonly model: PiCatalogModel;
  readonly builtIn: boolean;
  readonly custom: boolean;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
  readonly codexServiceTier: "fast" | undefined;
}): boolean {
  const ownRoute = isGptDirectPiProviderType(args.modelProviderType)
    ? args.model.own.get(args.modelProviderType ?? "")
    : undefined;
  if (!args.builtIn && !args.custom && ownRoute === undefined) return false;
  if (args.codexServiceTier === undefined || args.custom) return true;
  // Codex Fast is honoured only on a route that carries it.
  if (ownRoute !== undefined) return routeCarriesFast(ownRoute);
  return (
    isFastCapableBuiltInRuntime(args.runtimeProviderType) &&
    routeCarriesFast(builtInRuntimeRoute(args.model, args.runtimeProviderType))
  );
}

/** Route rules: the catalog decides eligibility and routes, this decides reach. */
function isPiRouteAdmitted(args: {
  readonly model: PiCatalogModel;
  readonly route: PiRouteClass;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
  readonly codexServiceTier: "fast" | "ultrafast" | undefined;
}): boolean {
  if (args.route === "claude-native") {
    return isPiNativeRoute(args.modelProviderType, args.model);
  }
  // Ultrafast is a vendor-harness tier; Pi never carries it.
  if (args.codexServiceTier === "ultrafast") return false;
  const custom = args.modelProviderType === "custom-openai-responses";
  if (custom && !args.model.customGatewayAllowed) return false;
  const routeArgs = {
    model: args.model,
    builtIn: isBuiltInRouteAdmitted(
      args.model,
      args.modelProviderType,
      args.runtimeProviderType,
    ),
    custom,
    modelProviderType: args.modelProviderType,
    runtimeProviderType: args.runtimeProviderType,
  };
  return args.route === "deepseek"
    ? isDeepSeekRouteAdmitted(routeArgs)
    : isGptRouteAdmitted({
        ...routeArgs,
        codexServiceTier: args.codexServiceTier,
      });
}

/** Concrete Built-in provider → the Pi catalog provider that resolves it. */
function builtInCatalogProvider(type: string): PiCatalogProvider | null {
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

/**
 * An OpenRouter preset (`@preset/...`) is an opaque upstream name; Pi resolves
 * its capabilities from the catalog model it is pinned to.
 */
export function isPresetUpstreamModel(
  upstreamModel: string | null | undefined,
): boolean {
  if (typeof upstreamModel !== "string") {
    return false;
  }
  return upstreamModel.startsWith("@preset/");
}

function builtInRouteIdentities(
  model: PiCatalogModel,
  runtimeProviderType: string | null | undefined,
): readonly PiRuntimeIdentity[] {
  const selected = model.builtIn.filter((candidate) => {
    return candidate.concreteProviderType === runtimeProviderType;
  });
  // Built-in availability routing picks the vendor at launch. When the caller
  // already knows it, gate on that one; otherwise every candidate the run could
  // land on has to resolve.
  const targets = selected.length > 0 ? selected : model.builtIn;
  const identities: PiRuntimeIdentity[] = [];
  for (const target of targets) {
    const provider = builtInCatalogProvider(target.concreteProviderType);
    if (provider === null) {
      return [];
    }
    identities.push({
      provider,
      model: isPresetUpstreamModel(target.upstreamModel)
        ? model.model
        : target.upstreamModel,
    });
  }
  return identities;
}

function responsesRouteIdentity(
  route: "gpt-codex" | "deepseek",
  model: PiCatalogModel,
  providerType: ModelProviderType,
): PiRuntimeIdentity | null {
  const upstreamModel = model.own.get(providerType)?.upstreamModel;
  switch (providerType) {
    case "codex-oauth-token": {
      return { provider: "openai-codex", model: model.model };
    }
    // Both gateways send an aliased request model but pin `catalogModel` to the
    // selected model, so capability follows the selected model itself.
    case "custom-openai-responses":
    case "vercel-ai-gateway-codex": {
      return {
        provider: route === "gpt-codex" ? "openai" : "deepseek",
        model: model.model,
      };
    }
    case "openai-api-key": {
      return upstreamModel === undefined
        ? null
        : { provider: "openai", model: upstreamModel };
    }
    case "openrouter-codex": {
      return upstreamModel === undefined
        ? null
        : { provider: "openrouter", model: upstreamModel };
    }
    case "deepseek": {
      return upstreamModel === undefined
        ? null
        : { provider: "deepseek", model: upstreamModel };
    }
    default: {
      return null;
    }
  }
}

export interface PiRouteArgs {
  /** The selected model's catalog projection (`piCatalogModel`). */
  readonly catalogModel: PiCatalogModel | null;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
}

export interface PiExecutionRouteArgs extends PiRouteArgs {
  readonly codexServiceTier: "fast" | "ultrafast" | undefined;
}

/**
 * The Pi catalog identities a route would ask the runtime to resolve, mirroring
 * the launch metadata built in `pi-sandbox-config.ts`. An empty result means no
 * identity is derivable, which fails the capability gate closed.
 */
export function piRouteCatalogIdentities(
  args: PiRouteArgs,
): readonly PiRuntimeIdentity[] {
  const model = args.catalogModel;
  const route = piRouteClass(model);
  const provider = modelProviderTypeSchema.safeParse(args.modelProviderType);
  if (model === null || route === null || !provider.success) {
    return [];
  }
  if (route === "claude-native") {
    // Every native route, Bedrock included, resolves its capabilities from Pi's
    // `anthropic` catalog with the selected model as `catalogModel`.
    return [{ provider: "anthropic", model: model.model }];
  }
  if (isBuiltInModelProviderType(provider.data)) {
    return builtInRouteIdentities(model, args.runtimeProviderType);
  }
  const identity = responsesRouteIdentity(route, model, provider.data);
  return identity === null ? [] : [identity];
}

/**
 * Catalog eligibility and route rules only, without the runtime capability
 * gate. The capability tests enumerate from here so that dropping an identity
 * from the capability data shows up as a disagreement with the resolver rather
 * than quietly shrinking the set of routes under test.
 */
export function isPiPolicyAdmittedRoute(args: PiExecutionRouteArgs): boolean {
  const model = args.catalogModel;
  const route = piRouteClass(model);
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
export function isPiRouteRuntimeCapable(args: PiRouteArgs): boolean {
  const identities = piRouteCatalogIdentities(args);
  return (
    identities.length > 0 && identities.every(isPiRuntimeIdentityResolvable)
  );
}

/**
 * Shared by Chat controls and server admission; trigger source does not select
 * a runtime. Admission is catalog eligibility, then route rules, then runtime
 * capability: a capability miss falls back to the legacy loop instead of
 * reaching the session-creation throw in `@okouai/pi-agent-runtime`.
 */
export function isPiExecutionRoute(args: PiExecutionRouteArgs): boolean {
  return isPiPolicyAdmittedRoute(args) && isPiRouteRuntimeCapable(args);
}
