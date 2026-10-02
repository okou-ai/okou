import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  isMemberSubscriptionRoute,
  loadedMemberModelRouteContext,
  prepareMemberModelRouteContext,
  resolveEffectivePolicyRoute,
  resolveEffectivePolicyRouteFromSnapshot,
  type MemberModelRouteContext,
  type PreparedMemberModelRouteContext,
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
import { and, eq, or } from "drizzle-orm";
import { badRequestMessage, insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";
import {
  loadOrgModelPolicyFacts,
  type OrgModelPolicyRow,
} from "./model-policy.service";
import {
  loadModelCatalog,
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
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import {
  loadMemberSubscriptionModels,
  type MemberSubscriptionModelRoute,
  memberSubscriptionModelRoutesFromCatalog,
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

const modelRoutingFactsSource = Symbol("modelRoutingFactsSource");

/**
 * Immutable facts for one selection decision. Identity plus the private DB
 * provenance make the scope explicit; callers receive resolved pins, never a
 * cacheable facts object. A null capability or policy field is authoritative.
 */
interface ModelRoutingFacts {
  readonly identity: {
    readonly orgId: string;
    readonly userId: string;
    readonly selectedModel: string | null;
  };
  readonly orgPlanCapabilities: OrgPlanCapabilities | null;
  readonly policies: readonly OrgModelPolicyRow[];
  readonly replacedPolicies: readonly OrgModelPolicyRow[];
  readonly catalog: ModelCatalog;
  readonly member: PreparedMemberModelRouteContext | MemberModelRouteContext;
  readonly subscriptionModels?: readonly MemberSubscriptionModelRoute[];
  readonly modelMode: "auto" | "custom";
  readonly [modelRoutingFactsSource]: Db;
}

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

interface AvailableModelProviderPin {
  readonly type: string;
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

async function prepareModelRoutingFacts(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly selectedModel: string | null;
  readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
  readonly catalog?: ModelCatalog;
  readonly modelBootstrap?: ModelSelectionBootstrap;
}): Promise<ModelRoutingFacts> {
  if (params.modelBootstrap) {
    const { org, member } = params.modelBootstrap;
    if (
      org.orgId !== params.orgId ||
      member.orgId !== params.orgId ||
      member.userId !== params.userId
    ) {
      throw new Error("Model bootstrap identity mismatch");
    }
    return {
      identity: {
        orgId: params.orgId,
        userId: params.userId,
        selectedModel: params.selectedModel,
      },
      orgPlanCapabilities: org.capabilities,
      policies: org.policyFacts.policies,
      replacedPolicies: org.policyFacts.replacedPolicies,
      catalog: org.catalog,
      member: member.member,
      modelMode: org.org?.modelMode === "auto" ? "auto" : "custom",
      subscriptionModels: memberSubscriptionModelRoutesFromCatalog(
        org.catalog,
        member.member,
      ),
      [modelRoutingFactsSource]: params.db,
    };
  }
  const policyFactsPromise = loadOrgModelPolicyFacts(
    params.db,
    params.orgId,
    params.orgPlanCapabilities,
    params.catalog,
  );
  const [policyFacts, org] = await Promise.all([
    policyFactsPromise,
    params.db
      .select({ mode: orgMetadata.modelMode })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, params.orgId))
      .limit(1),
  ]);
  const member = prepareMemberModelRouteContext(
    params.db,
    params.orgId,
    params.userId,
  );
  return Object.freeze({
    identity: Object.freeze({
      orgId: params.orgId,
      userId: params.userId,
      selectedModel: params.selectedModel,
    }),
    orgPlanCapabilities:
      policyFacts.orgPlanCapabilities === null
        ? null
        : Object.freeze({ ...policyFacts.orgPlanCapabilities }),
    policies: Object.freeze(
      policyFacts.policies.map((policy) => {
        return Object.freeze({ ...policy });
      }),
    ),
    catalog: policyFacts.catalog,
    replacedPolicies: policyFacts.replacedPolicies,
    member,
    modelMode: org[0]?.mode === "auto" ? "auto" : "custom",
    [modelRoutingFactsSource]: params.db,
  });
}

async function resolveValidPolicyRoute(params: {
  readonly facts: ModelRoutingFacts;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly selectedModel: string;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
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
    return await resolveEffectivePolicyRoute({
      catalog: params.facts.catalog,
      db: params.facts[modelRoutingFactsSource],
      orgId: params.facts.identity.orgId,
      member: params.facts.member,
      capabilities: params.capabilities,
      policy,
    });
  }
  if (params.facts.modelMode !== "auto") {
    return null;
  }
  const personal = (
    params.facts.subscriptionModels ??
    (await loadMemberSubscriptionModels(
      params.facts[modelRoutingFactsSource],
      params.facts.member,
    ))
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
export async function resolveDefaultModelFirstPin(
  db: Db,
  orgId: string,
  userId: string,
  defaultSource: "member" | "workspace" = "member",
  supplied?: {
    readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
    readonly modelBootstrap?: ModelSelectionBootstrap;
  },
): Promise<DefaultModelFirstPin> {
  const facts = await prepareModelRoutingFacts({
    db,
    orgId,
    userId,
    selectedModel: null,
    orgPlanCapabilities: supplied?.orgPlanCapabilities,
    modelBootstrap: supplied?.modelBootstrap,
  });
  const capabilities = modelRouteCapabilities(facts.orgPlanCapabilities);
  if (defaultSource === "member" && userId !== "__no_preference__") {
    const [preference] = await db
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
    if (preference?.selectedModel) {
      const preferredRoute = await resolveValidPolicyRoute({
        facts,
        capabilities,
        selectedModel: preference.selectedModel,
      });
      if (preferredRoute) {
        const catalogTier =
          facts.modelMode === "auto" &&
          preferredRoute.modelProviderCredentialScope === "member"
            ? (
                facts.subscriptionModels ??
                (await loadMemberSubscriptionModels(db, facts.member))
              ).find((entry) => {
                return entry.model === preferredRoute.selectedModel;
              })?.serviceTier
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

  const route = await resolveWorkspaceDefaultModelFirstRoute({
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
}

/** The DB system default resolves through its projected policy route. */
async function resolveWorkspaceDefaultModelFirstRoute(params: {
  readonly facts: ModelRoutingFacts;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  return await resolveValidPolicyRoute({
    facts: params.facts,
    capabilities: params.capabilities,
    selectedModel: params.facts.catalog.systemDefaultModel,
  });
}

async function loadAvailableModelProviderPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderId: string;
}): Promise<AvailableModelProviderPin | null> {
  const [provider] = await params.db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);
  return provider ?? null;
}

export async function resolveModelSelectionPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelSelection: ModelSelectionRequest;
  /** The organization's plan, when the caller already read it in this request. */
  readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
  /** The request's catalog snapshot, when the caller already loaded it. */
  readonly catalog?: ModelCatalog;
  readonly modelBootstrap?: ModelSelectionBootstrap;
}): Promise<
  | ModelFirstPin
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof insufficientCredits>
> {
  const { db, orgId, userId } = params;
  // Legacy clients can still send a replaced model ID: resolve it to the final
  // active model. Only the model is replaced; the route below is chosen again
  // for that model, and an incompatible explicit provider is rejected.
  const catalog = params.catalog ?? (await loadModelCatalog(db));
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
    if (org?.mode === "auto") {
      return badRequestMessage("Use the available models for this workspace");
    }
    const capabilities = modelRouteCapabilities(
      params.orgPlanCapabilities === undefined
        ? await loadOrgPlanCapabilities(db, orgId)
        : params.orgPlanCapabilities,
    );
    const provider = await loadAvailableModelProviderPin({
      db,
      orgId,
      userId,
      modelProviderId: modelSelection.modelProviderId,
    });
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

  const facts = await prepareModelRoutingFacts({
    db,
    orgId,
    userId,
    selectedModel: modelSelection.selectedModel,
    orgPlanCapabilities: params.orgPlanCapabilities,
    catalog,
    modelBootstrap: params.modelBootstrap,
  });
  // Resolve the configured route without plan filtering first. Model access is
  // decided from that route so BYOK never inherits a built-in-only model gate.
  const route = await resolveValidPolicyRoute({
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
      member: await loadedMemberModelRouteContext(facts.member),
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
  const planRoute = await resolveValidPolicyRoute({
    facts,
    capabilities: planCapabilities,
    selectedModel: modelSelection.selectedModel,
  });
  return planRoute ? modelFirstPinFromRoute(planRoute) : insufficientCredits();
}

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
