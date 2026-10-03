import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  isMemberSubscriptionRoute,
  memberModelRouteContextFromAccounts,
  resolveEffectivePolicyRouteFromSnapshot,
  type MemberModelRouteContext,
  type ResolvedModelFirstPolicyRoute,
} from "./effective-model-route.service";
import {
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderWriteType,
} from "@okouai/api-contracts/contracts/model-providers";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { and, eq, or, inArray, isNull } from "drizzle-orm";
import { badRequestMessage, insufficientCredits } from "../../lib/error";
import { command } from "ccstate";
import { db$ } from "../external/db";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { reasoningEffortSchema } from "@okouai/api-contracts/contracts/model-reasoning-effort";
import {
  orgModelPolicyFactsFromSnapshot,
  type OrgModelPolicyRow,
} from "./model-policy.service";
import {
  loadModelCatalog$,
  resolveCatalogModel,
  resolveCatalogRunModel,
  type ModelCatalog,
} from "./model-catalog.service";
import {
  catalogModelForSelectedId,
  catalogRunModelRouteAccess,
  isCatalogFastServiceTierSupported,
  isCatalogUltrafastServiceTierSupported,
} from "./model-route-capabilities.service";
import {
  loadOrgPlanCapabilities$,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import type {
  MemberSubscriptionModel,
  MemberSubscriptionModelRoute,
} from "./member-subscription-models.service";

import type {
  OrgModelBootstrap,
  MemberModelBootstrap,
} from "./model-bootstrap.service";

export interface ModelSelectionBootstrap {
  readonly org: OrgModelBootstrap;
  readonly member: MemberModelBootstrap;
}

const ORG_SENTINEL_USER_ID = "__org__";
export const MODEL_FIRST_SELECTION_PROVIDER_ID =
  "00000000-0000-4000-8000-000000000000";

export function modelProviderWriteTypeForLaunch(
  type: string,
): ModelProviderWriteType {
  const providerType = modelProviderTypeSchema.parse(type);
  return isBuiltInModelProviderType(providerType) ? "built-in" : providerType;
}

export interface ModelFirstPin {
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

export interface DefaultModelFirstPin extends ModelFirstPin {
  readonly serviceTier: ChatThreadServiceTier | null;
}

/** Plain, request-owned facts: no deferred reads or database provenance. */
interface ModelRoutingFacts {
  readonly orgPlanCapabilities: OrgPlanCapabilities | null;
  readonly policies: readonly OrgModelPolicyRow[];
  readonly replacedPolicies: readonly OrgModelPolicyRow[];
  readonly catalog: ModelCatalog;
  readonly member: MemberModelRouteContext;
  readonly modelMode: "auto" | "custom";
  readonly preference: {
    readonly selectedModel: string | null;
    readonly serviceTier: string | null;
  } | null;
  readonly providers: readonly {
    readonly id: string;
    readonly type: string;
    readonly userId: string;
  }[];
  readonly surfaces: readonly {
    readonly id: string;
    readonly protocol: string;
    readonly modelMappings: Readonly<Record<string, string>>;
  }[];
}

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

function modelFirstPinFromRoute(
  route: ResolvedModelFirstPolicyRoute,
): ModelFirstPin {
  return {
    modelProviderId: route.modelProviderId,
    modelProviderType: route.modelProviderType,
    modelProviderCredentialScope: route.modelProviderCredentialScope,
    selectedModel: route.selectedModel,
  };
}

function modelRouteCapabilities(
  capabilities: OrgPlanCapabilities | null,
): Pick<OrgPlanCapabilities, "restrictedBuiltInModels" | "supportByok"> {
  if (capabilities?.status !== "active") {
    return {
      restrictedBuiltInModels: false,
      supportByok: true,
    };
  }
  return {
    restrictedBuiltInModels: capabilities.restrictedBuiltInModels,
    supportByok: capabilities.supportByok,
  };
}

function modelRouteAllowedForOrgPlan(args: {
  readonly catalog: ModelCatalog;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly selectedModel: string | null | undefined;
  readonly modelProviderType: string | null | undefined;
}): boolean {
  return (
    catalogRunModelRouteAccess(
      args.catalog,
      args.selectedModel,
      args.modelProviderType,
      args.capabilities.restrictedBuiltInModels,
    ) === "allowed" &&
    (args.capabilities.supportByok ||
      isBuiltInModelProviderType(args.modelProviderType))
  );
}

function subscriptionModelsFromCatalog(
  catalog: ModelCatalog,
  member: MemberModelRouteContext,
): readonly Pick<
  MemberSubscriptionModel,
  "model" | "serviceTier" | "providerType" | "providerId" | "needsReconnect"
>[] {
  return catalog.routes.flatMap((route) => {
    const subscription = member.subscriptions.find((candidate) => {
      return candidate.type === route.subscriptionType;
    });
    if (
      !subscription ||
      !route.enabled ||
      catalog.byModel.get(route.model)?.replacedBy !== null
    ) {
      return [];
    }
    const serviceTier = route.serviceTiers.includes("priority")
      ? "priority"
      : null;
    if (
      route.efforts.some((effort) => {
        return !reasoningEffortSchema.safeParse(effort).success;
      }) ||
      (serviceTier === "priority" && subscription.type !== "codex-oauth-token")
    ) {
      throw new Error(
        `Invalid subscription model catalog row ${route.subscriptionType}/${route.model}`,
      );
    }
    return [
      {
        model: route.model,
        serviceTier,
        providerType: subscription.type,
        providerId: subscription.providerId,
        needsReconnect: subscription.needsReconnect,
      },
    ];
  });
}

function requireModelBootstrapIdentity(
  captured: ModelSelectionBootstrap | undefined,
  orgId: string,
  userId: string,
) {
  if (
    captured &&
    (captured.org.orgId !== orgId ||
      captured.member.orgId !== orgId ||
      captured.member.userId !== userId)
  ) {
    throw new Error("Model bootstrap identity mismatch");
  }
}

const memberModelPreference$ = command(
  async ({ get }, orgId: string, userId: string, signal?: AbortSignal) => {
    const rows = await get(db$)
      .select({
        selectedModel: orgMembersMetadata.selectedModel,
        serviceTier: orgMembersMetadata.serviceTier,
      })
      .from(orgMembersMetadata)
      .where(
        and(
          eq(orgMembersMetadata.orgId, orgId),
          eq(orgMembersMetadata.userId, userId),
        ),
      )
      .limit(1);
    signal?.throwIfAborted();
    return rows;
  },
);

const modelRoutingFacts$ = command(
  async (
    { get, set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
      readonly catalog?: ModelCatalog;
      readonly modelBootstrap?: ModelSelectionBootstrap;
    },
    signal?: AbortSignal,
  ): Promise<ModelRoutingFacts> => {
    const db = get(db$);
    const captured = params.modelBootstrap;
    requireModelBootstrapIdentity(captured, params.orgId, params.userId);
    const memberScoped =
      params.userId !== "__no_preference__" &&
      params.userId !== ORG_SENTINEL_USER_ID;
    const [
      catalog,
      orgPlanCapabilities,
      stored,
      [org],
      accounts,
      providers,
      surfaces,
      [preference],
    ] = await Promise.all([
      captured?.org.catalog ?? params.catalog ?? set(loadModelCatalog$, signal),
      captured
        ? captured.org.capabilities
        : params.orgPlanCapabilities === undefined
          ? set(loadOrgPlanCapabilities$, params.orgId, signal)
          : params.orgPlanCapabilities,
      captured
        ? captured.org.policies
        : db
            .select()
            .from(orgModelPolicies)
            .where(eq(orgModelPolicies.orgId, params.orgId)),
      captured
        ? [{ mode: captured.org.org?.modelMode }]
        : db
            .select({ mode: orgMetadata.modelMode })
            .from(orgMetadata)
            .where(eq(orgMetadata.orgId, params.orgId))
            .limit(1),
      captured
        ? captured.member.accounts.map((account) => {
            return {
              ...account,
              providerId: account.modelProviderId,
            };
          })
        : memberScoped
          ? db
              .select({
                type: modelProviderAccounts.type,
                providerId: modelProviderAccounts.modelProviderId,
                isActive: modelProviderAccounts.isActive,
                needsReconnect: modelProviderAccounts.needsReconnect,
              })
              .from(modelProviderAccounts)
              .where(
                and(
                  eq(modelProviderAccounts.orgId, params.orgId),
                  eq(modelProviderAccounts.userId, params.userId),
                  inArray(modelProviderAccounts.type, [
                    "claude-code-oauth-token",
                    "codex-oauth-token",
                  ]),
                  isNull(modelProviderAccounts.disconnectedAt),
                ),
              )
          : [],
      db
        .select({
          id: modelProviders.id,
          type: modelProviders.type,
          userId: modelProviders.userId,
        })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, params.orgId),
            eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
          ),
        ),
      db
        .select({
          id: modelProviderSurfaces.id,
          protocol: modelProviderSurfaces.protocol,
          modelMappings: modelProviderSurfaces.modelMappings,
        })
        .from(modelProviderSurfaces)
        .innerJoin(
          modelProviderConnections,
          eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
        )
        .where(eq(modelProviderConnections.orgId, params.orgId)),
      memberScoped
        ? set(memberModelPreference$, params.orgId, params.userId, signal)
        : [],
    ]);
    signal?.throwIfAborted();
    const member = memberModelRouteContextFromAccounts(params.userId, accounts);
    return {
      ...orgModelPolicyFactsFromSnapshot({
        catalog,
        orgId: params.orgId,
        orgPlanCapabilities,
        stored,
      }),
      member,
      providers,
      surfaces,
      preference: preference ?? null,
      modelMode: org?.mode === "auto" ? "auto" : "custom",
    };
  },
);

function resolveValidPolicyRoute(params: {
  readonly facts: ModelRoutingFacts;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly selectedModel: string;
}): ResolvedModelFirstPolicyRoute | null {
  // A stored or legacy selection resolves along the replacement chain; the
  // route is then chosen among the final model's own routes.
  const selectedModel = resolveCatalogRunModel(
    params.facts.catalog,
    params.selectedModel,
  );
  if (!selectedModel) {
    return null;
  }
  const policy = params.facts.policies.find((candidate) => {
    return candidate.model === selectedModel;
  });
  if (
    selectedModel !== params.selectedModel &&
    !replacementRouteCompatible(params.facts, params.selectedModel, policy)
  ) {
    return null;
  }
  if (policy) {
    return resolveEffectivePolicyRouteFromSnapshot({
      catalog: params.facts.catalog,
      member: params.facts.member,
      capabilities: params.capabilities,
      policy,
      orgProviderType: params.facts.providers.find((provider) => {
        return provider.id === policy.modelProviderId;
      })?.type,
      customSurface:
        params.facts.surfaces.find((surface) => {
          return surface.id === policy.modelProviderSurfaceId;
        }) ?? null,
    });
  }
  if (params.facts.modelMode !== "auto") {
    return null;
  }
  const personal = subscriptionModelsFromCatalog(
    params.facts.catalog,
    params.facts.member,
  ).find((entry) => {
    return entry.model === selectedModel;
  });
  return personal
    ? {
        modelProviderId: personal.providerId,
        modelProviderType: personal.providerType,
        modelProviderCredentialScope: "member",
        selectedModel: personal.model,
        personalConnectionState: personal.needsReconnect
          ? "reconnect_required"
          : "capture_required",
      }
    : null;
}

/**
 * A replacement resolves only the model. When the replaced model was served
 * by a non-Built-in route (BYOK, subscription or custom gateway), the
 * replacement must be served by the same provider type; credentials never
 * move across providers and the selection never falls back to Built-in
 * billing.
 */
function replacementRouteCompatible(
  facts: ModelRoutingFacts,
  replacedModel: string,
  replacementPolicy: OrgModelPolicyRow | undefined,
): boolean {
  const original = facts.replacedPolicies.find((candidate) => {
    return candidate.model === replacedModel;
  });
  if (!original || isBuiltInModelProviderType(original.defaultProviderType)) {
    return true;
  }
  return (
    replacementPolicy !== undefined &&
    replacementPolicy.defaultProviderType === original.defaultProviderType &&
    replacementPolicy.credentialScope === original.credentialScope
  );
}

/**
 * The model a queued or requested run selection runs as, against one
 * run-scoped catalog snapshot: the catalog model the ID names (directly or as
 * the upstream ID of exactly one catalog model), followed along its
 * replacement chain to the final active model. Enqueue validation, the queue
 * pick and run creation all use this, so the same ID resolves identically on
 * every path. Null for an ID the catalog does not know.
 */
export function resolveRunSelectionModel(
  catalog: ModelCatalog,
  selectedId: string,
): string | null {
  const model = catalogModelForSelectedId(catalog, selectedId);
  return model === null ? null : resolveCatalogRunModel(catalog, model);
}

/** Whether a selection names a model the catalog has replaced. */
export function isReplacedModelSelection(
  catalog: ModelCatalog,
  model: string | null,
): boolean {
  return (
    model !== null && resolveCatalogModel(catalog, model).kind === "replaced"
  );
}

/**
 * `orgPlanCapabilities` is the organization's plan when the caller already
 * read it in this request; omitted, the plan is read with the policies.
 */
export const resolveDefaultModelFirstPin$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly defaultSource?: "member" | "workspace";
      readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
      readonly catalog?: ModelCatalog;
      readonly modelBootstrap?: ModelSelectionBootstrap;
    },
    signal?: AbortSignal,
  ): Promise<DefaultModelFirstPin> => {
    const { userId, defaultSource = "member" } = params;
    const facts = await set(modelRoutingFacts$, params, signal);
    const capabilities = modelRouteCapabilities(facts.orgPlanCapabilities);
    if (defaultSource === "member" && userId !== "__no_preference__") {
      const preference = facts.preference;
      if (preference?.selectedModel) {
        const preferredRoute = resolveValidPolicyRoute({
          facts,
          capabilities,
          selectedModel: preference.selectedModel,
        });
        if (preferredRoute) {
          const catalogTier =
            facts.modelMode === "auto" &&
            preferredRoute.modelProviderCredentialScope === "member"
              ? subscriptionModelsFromCatalog(facts.catalog, facts.member).find(
                  (entry) => {
                    return entry.model === preferredRoute.selectedModel;
                  },
                )?.serviceTier
              : undefined;
          const serviceTier =
            preference.serviceTier === "ultrafast" &&
            isCatalogUltrafastServiceTierSupported(
              facts.catalog,
              preferredRoute.selectedModel,
              preferredRoute.modelProviderType,
            )
              ? "ultrafast"
              : preference.serviceTier === "priority" &&
                  (facts.modelMode !== "auto" || catalogTier === "priority") &&
                  isCatalogFastServiceTierSupported(
                    facts.catalog,
                    preferredRoute.selectedModel,
                    preferredRoute.modelProviderType,
                  )
                ? "priority"
                : null;
          return { ...modelFirstPinFromRoute(preferredRoute), serviceTier };
        }
      }
    }

    const route = resolveWorkspaceDefaultModelFirstRoute({
      facts,
      capabilities,
    });
    return route
      ? { ...modelFirstPinFromRoute(route), serviceTier: null }
      : {
          modelProviderId: null,
          modelProviderType: null,
          modelProviderCredentialScope: null,
          selectedModel: null,
          serviceTier: null,
        };
  },
);

/** The DB system default resolves through its projected policy route. */
function resolveWorkspaceDefaultModelFirstRoute(params: {
  readonly facts: ModelRoutingFacts;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
}): ResolvedModelFirstPolicyRoute | null {
  return resolveValidPolicyRoute({
    facts: params.facts,
    capabilities: params.capabilities,
    selectedModel: params.facts.catalog.systemDefaultModel,
  });
}

export const resolveModelSelectionPin$ = command(
  async (
    { get, set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly modelSelection: ModelSelectionRequest;
      /** The organization's plan, when the caller already read it in this request. */
      readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
      /** The request's catalog snapshot, when the caller already loaded it. */
      readonly catalog?: ModelCatalog;
      readonly modelBootstrap?: ModelSelectionBootstrap;
    },
    signal: AbortSignal,
  ): Promise<
    | ModelFirstPin
    | ReturnType<typeof badRequestMessage>
    | ReturnType<typeof insufficientCredits>
  > => {
    const { orgId, userId } = params;
    const db = get(db$);
    // Legacy clients can still send a replaced model ID: resolve it to the final
    // active model. Only the model is replaced; the route below is chosen again
    // for that model, and an incompatible explicit provider is rejected.
    const catalog = params.catalog ?? (await set(loadModelCatalog$, signal));
    signal.throwIfAborted();
    const resolvedModel = resolveRunSelectionModel(
      catalog,
      params.modelSelection.selectedModel,
    );
    if (!resolvedModel) {
      return badRequestMessage(
        `Unknown model "${params.modelSelection.selectedModel}"`,
      );
    }
    const modelSelection: ModelSelectionRequest = {
      ...params.modelSelection,
      selectedModel: resolvedModel,
    };
    if (modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID) {
      const [org] = await db
        .select({ mode: orgMetadata.modelMode })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      signal.throwIfAborted();
      if (org?.mode === "auto") {
        return badRequestMessage("Use the available models for this workspace");
      }
      const capabilities = modelRouteCapabilities(
        params.orgPlanCapabilities === undefined
          ? await set(loadOrgPlanCapabilities$, orgId, signal)
          : params.orgPlanCapabilities,
      );
      const [provider] = await db
        .select({ type: modelProviders.type })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.id, modelSelection.modelProviderId),
            eq(modelProviders.orgId, orgId),
            or(
              eq(modelProviders.userId, userId),
              eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
            ),
          ),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!provider) {
        return badRequestMessage("Unknown model provider for this workspace");
      }
      if (
        !modelRouteAllowedForOrgPlan({
          catalog,
          capabilities,
          selectedModel: modelSelection.selectedModel,
          modelProviderType: provider.type,
        })
      ) {
        return insufficientCredits();
      }
      return {
        modelProviderId: modelSelection.modelProviderId,
        modelProviderType: null,
        modelProviderCredentialScope: null,
        selectedModel: modelSelection.selectedModel,
      };
    }

    const facts = await set(modelRoutingFacts$, { ...params, catalog }, signal);
    // Resolve the configured route without plan filtering first. Model access is
    // decided from that route so BYOK never inherits a built-in-only model gate.
    const route = resolveValidPolicyRoute({
      facts,
      capabilities: {
        restrictedBuiltInModels: false,
        supportByok: true,
      },
      selectedModel: modelSelection.selectedModel,
    });
    if (!route) {
      return badRequestMessage(
        "The selected model is not available in this workspace",
      );
    }
    const planCapabilities = modelRouteCapabilities(facts.orgPlanCapabilities);
    if (
      isMemberSubscriptionRoute({
        catalog: facts.catalog,
        member: facts.member,
        model: route.selectedModel,
        providerType: route.modelProviderType,
        credentialScope: route.modelProviderCredentialScope,
      }) ||
      modelRouteAllowedForOrgPlan({
        catalog: facts.catalog,
        capabilities: planCapabilities,
        selectedModel: route.selectedModel,
        modelProviderType: route.modelProviderType,
      })
    ) {
      return modelFirstPinFromRoute(route);
    }
    // The unfiltered route is the member's own route and the plan cannot use it.
    // Resolving again under the plan restores the workspace route the member
    // falls back to, so a personal subscription the plan does not cover keeps
    // reporting its own availability instead of failing the whole selection.
    const planRoute = resolveValidPolicyRoute({
      facts,
      capabilities: planCapabilities,
      selectedModel: modelSelection.selectedModel,
    });
    return planRoute
      ? modelFirstPinFromRoute(planRoute)
      : insufficientCredits();
  },
);

/**
 * `trust-enqueued` skips re-validating that the resolved provider supports
 * the model an enqueue already captured; a mismatch fails at execution.
 */
export type ProviderModelSupport = "validate" | "trust-enqueued";

/**
 * Service tiers follow the pin's catalog route: Fast (`priority`) and
 * Ultrafast are accepted only when that route lists them.
 */
export function validateCodexServiceTier(params: {
  readonly catalog: ModelCatalog;
  readonly pin: ModelFirstPin;
  readonly codexServiceTier: "fast" | "ultrafast" | null;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (params.codexServiceTier === "ultrafast") {
    return isCatalogUltrafastServiceTierSupported(
      params.catalog,
      params.pin.selectedModel,
      params.pin.modelProviderType,
    )
      ? undefined
      : badRequestMessage("Ultrafast is unavailable for this model route");
  }
  if (params.codexServiceTier !== "fast") {
    return undefined;
  }
  if (
    isCatalogFastServiceTierSupported(
      params.catalog,
      params.pin.selectedModel,
      params.pin.modelProviderType,
    )
  ) {
    return undefined;
  }
  return badRequestMessage(
    "Codex fast mode is only available for GPT 5.6 runs",
  );
}

/** Resolve only the enqueued model from a pick-owned, read-only facts graph. */
export function resolveQueuedModelSelectionPinFromSnapshot(params: {
  /** The catalog current at the pick, not at enqueue. */
  readonly catalog: ModelCatalog;
  readonly selectedModel: string;
  readonly facts: {
    readonly orgPlanCapabilities: OrgPlanCapabilities | null;
    readonly policies: readonly OrgModelPolicyRow[];
  };
  readonly member: MemberModelRouteContext;
  readonly orgProviderType?: string | null;
  readonly customSurface?: {
    readonly protocol: string;
    readonly modelMappings: Readonly<Record<string, string>>;
  } | null;
  /** Organization model mode read with the other pick facts. */
  readonly modelMode: "auto" | "custom";
  /** The member's catalog-listed subscription models; empty outside Auto. */
  readonly subscriptionModels: readonly MemberSubscriptionModelRoute[];
}):
  | ModelFirstPin
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof insufficientCredits> {
  // Queued inputs re-check their captured model at the pick: a model replaced
  // after enqueue resolves to its final replacement before the run starts.
  const selectedModel = resolveRunSelectionModel(
    params.catalog,
    params.selectedModel,
  );
  if (!selectedModel) {
    return badRequestMessage(`Unknown model "${params.selectedModel}"`);
  }
  const policy = params.facts.policies.find((candidate) => {
    return candidate.model === selectedModel;
  });
  if (!policy && params.modelMode === "auto") {
    // Auto: a model outside the org policies routes to the member's
    // connected subscription, which is exempt from the plan restriction.
    const personal = params.subscriptionModels.find((entry) => {
      return entry.model === selectedModel;
    });
    return personal
      ? {
          modelProviderId: personal.providerId,
          modelProviderType: personal.providerType,
          modelProviderCredentialScope: "member",
          selectedModel: personal.model,
        }
      : badRequestMessage(
          "The selected model is not available in this workspace",
        );
  }
  const route = policy
    ? resolveEffectivePolicyRouteFromSnapshot({
        ...params,
        policy,
        capabilities: { restrictedBuiltInModels: false, supportByok: true },
      })
    : null;
  if (!route || !policy) {
    return badRequestMessage(
      "The selected model is not available in this workspace",
    );
  }
  const planCapabilities = modelRouteCapabilities(
    params.facts.orgPlanCapabilities,
  );
  if (
    isMemberSubscriptionRoute({
      catalog: params.catalog,
      member: params.member,
      model: route.selectedModel,
      providerType: route.modelProviderType,
      credentialScope: route.modelProviderCredentialScope,
    }) ||
    modelRouteAllowedForOrgPlan({
      catalog: params.catalog,
      capabilities: planCapabilities,
      selectedModel: route.selectedModel,
      modelProviderType: route.modelProviderType,
    })
  ) {
    return modelFirstPinFromRoute(route);
  }
  const planRoute = resolveEffectivePolicyRouteFromSnapshot({
    ...params,
    policy,
    capabilities: planCapabilities,
  });
  return planRoute ? modelFirstPinFromRoute(planRoute) : insufficientCredits();
}
