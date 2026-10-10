import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import {
  isPiRouteClass,
  type PiRouteClass,
} from "@okouai/api-contracts/contracts/model-catalog";
import {
  AUTO_SELECTED_MODEL,
  AUTO_RUN_PROVIDER,
  isAutoSelectedModel,
} from "./auto-run-model";
import {
  isPiRuntimeIdentityResolvable,
  type PiRuntimeIdentity,
} from "./pi-runtime-capability";

export type { PiRouteClass };

export interface PiCatalogRoute {
  readonly concreteProviderType: string;
  readonly upstreamModel: string;
  readonly serviceTiers: readonly string[];
}

/** Auto is fixed; only personal subscriptions use catalog capabilities. */
export interface PiCatalogModel {
  readonly model: string;
  readonly piRouteClass: PiRouteClass | null;
  readonly own: ReadonlyMap<string, PiCatalogRoute>;
}

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

export function piCatalogModel(
  catalog: PiCatalogSource | null,
  model: string | null | undefined,
): PiCatalogModel | null {
  if (isAutoSelectedModel(model)) {
    return {
      model: AUTO_SELECTED_MODEL,
      piRouteClass: "gpt-codex",
      own: new Map(),
    };
  }
  const row = catalog?.models.find((entry) => {
    return entry.model === model;
  });
  if (!row || !catalog) {
    return null;
  }
  const own = new Map<string, PiCatalogRoute>();
  for (const route of [...catalog.routes].sort((left, right) => {
    return left.priority - right.priority;
  })) {
    if (
      route.enabled &&
      route.model === row.model &&
      // Only a Codex subscription runs on Pi; Claude stays on its harness.
      route.subscriptionType === "codex-oauth-token" &&
      route.providerType === route.subscriptionType &&
      !own.has(route.providerType)
    ) {
      own.set(route.providerType, {
        concreteProviderType: route.concreteProviderType,
        upstreamModel: route.upstreamModel,
        serviceTiers: route.serviceTiers,
      });
    }
  }
  return {
    model: row.model,
    piRouteClass: isPiRouteClass(row.piRouteClass) ? row.piRouteClass : null,
    own,
  };
}

export function isPresetUpstreamModel(
  upstreamModel: string | null | undefined,
): boolean {
  return upstreamModel?.startsWith("@preset/") ?? false;
}

export interface PiRouteArgs {
  readonly catalogModel: PiCatalogModel | null;
  readonly modelProviderType: string | null | undefined;
  readonly runtimeProviderType: string | null | undefined;
}

export interface PiExecutionRouteArgs extends PiRouteArgs {
  readonly codexServiceTier: "fast" | undefined;
}

function isAutoRoute(args: PiRouteArgs): boolean {
  return (
    isAutoSelectedModel(args.catalogModel?.model) &&
    isBuiltInModelProviderType(args.modelProviderType) &&
    (args.runtimeProviderType == null ||
      isBuiltInModelProviderType(args.runtimeProviderType) ||
      args.runtimeProviderType === AUTO_RUN_PROVIDER)
  );
}

/** Claude subscriptions remain on the vendor harness, never Pi (vendor terms). */
export function isPiAdmittedRoute(args: PiExecutionRouteArgs): boolean {
  if (isAutoRoute(args)) {
    return args.codexServiceTier === undefined;
  }
  const model = args.catalogModel;
  const subscription = model?.own.get("codex-oauth-token");
  return (
    model?.piRouteClass === "gpt-codex" &&
    args.modelProviderType === "codex-oauth-token" &&
    (args.runtimeProviderType == null ||
      args.runtimeProviderType === "codex-oauth-token") &&
    subscription !== undefined &&
    (args.codexServiceTier === undefined ||
      subscription.serviceTiers.includes("priority"))
  );
}

export function piRouteCatalogIdentities(
  args: PiRouteArgs,
): readonly PiRuntimeIdentity[] {
  if (isAutoRoute(args)) {
    return [{ provider: "openrouter", model: AUTO_SELECTED_MODEL }];
  }
  const model = args.catalogModel;
  if (
    model?.piRouteClass === "gpt-codex" &&
    args.modelProviderType === "codex-oauth-token" &&
    model.own.has("codex-oauth-token") &&
    (args.runtimeProviderType == null ||
      args.runtimeProviderType === "codex-oauth-token")
  ) {
    return [{ provider: "openai-codex", model: model.model }];
  }
  return [];
}

export function isPiRouteRuntimeCapable(args: PiRouteArgs): boolean {
  const identities = piRouteCatalogIdentities(args);
  return (
    identities.length > 0 && identities.every(isPiRuntimeIdentityResolvable)
  );
}

export function isPiExecutionRoute(args: PiExecutionRouteArgs): boolean {
  return isPiAdmittedRoute(args) && isPiRouteRuntimeCapable(args);
}
