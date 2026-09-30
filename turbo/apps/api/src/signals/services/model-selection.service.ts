import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import {
  getRunModelAccess,
  getRunModelRouteAccess,
  isBuiltInModelProviderType,
  isCodexFastModeModel,
  isSupportedRunModel,
  modelProviderTypeSchema,
  RETIRED_RUN_MODEL_MESSAGE,
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
  prepareMemberModelRouteContext,
  resolveEffectivePolicyRoute,
  resolveEffectivePolicyRouteFromSnapshot,
  type MemberModelRouteContext,
  type PreparedMemberModelRouteContext,
  type ResolvedModelFirstPolicyRoute,
} from "./effective-model-route.service";
import {
  ensureOrgModelPolicyFacts,
  loadOrgModelPolicyFacts,
  type OrgModelPolicyRow,
} from "./model-policy.service";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import {
  loadMemberSubscriptionModels,
  type MemberSubscriptionModel,
} from "./subscription-model-catalog.service";

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
  readonly member: PreparedMemberModelRouteContext;
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
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly selectedModel: string | null | undefined;
  readonly modelProviderType: string | null | undefined;
}): boolean {
  return (
    getRunModelRouteAccess(
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
}): Promise<ModelRoutingFacts> {
  const policyFactsPromise =
    params.userId === "__no_preference__"
      ? loadOrgModelPolicyFacts(
          params.db,
          params.orgId,
          params.orgPlanCapabilities,
        )
      : ensureOrgModelPolicyFacts(
          params.db,
          params.orgId,
          params.userId,
          params.orgPlanCapabilities,
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
  if (!isSupportedRunModel(params.selectedModel)) {
    return null;
  }
  const policy = params.facts.policies.find((candidate) => {
    return candidate.model === params.selectedModel;
  });
  if (policy) {
    return await resolveEffectivePolicyRoute({
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
    await loadMemberSubscriptionModels(
      params.facts[modelRoutingFactsSource],
      params.facts.member,
    )
  ).find((entry) => {
    return entry.model === params.selectedModel;
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
 * `orgPlanCapabilities` is the organization's plan when the caller already
 * read it in this request; omitted, the plan is read with the policies.
 */
export async function resolveDefaultModelFirstPin(
  db: Db,
  orgId: string,
  userId: string,
  defaultSource: "member" | "workspace" = "member",
  orgPlanCapabilities?: OrgPlanCapabilities | null,
): Promise<DefaultModelFirstPin> {
  const facts = await prepareModelRoutingFacts({
    db,
    orgId,
    userId,
    selectedModel: null,
    orgPlanCapabilities,
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
            ? (await loadMemberSubscriptionModels(db, facts.member)).find(
                (entry) => {
                  return entry.model === preferredRoute.selectedModel;
                },
              )?.serviceTier
            : undefined;
        const serviceTier =
          preference.serviceTier === "priority" &&
          (facts.modelMode !== "auto" || catalogTier === "priority") &&
          isCodexFastServiceTierSupported({
            selectedModel: preferredRoute.selectedModel,
          })
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

async function resolveWorkspaceDefaultModelFirstRoute(params: {
  readonly facts: ModelRoutingFacts;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  const policy = params.facts.policies.find((candidate) => {
    return candidate.isDefault;
  });
  return policy
    ? await resolveValidPolicyRoute({
        facts: params.facts,
        capabilities: params.capabilities,
        selectedModel: policy.model,
      })
    : null;
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
}): Promise<
  | ModelFirstPin
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof insufficientCredits>
> {
  const { db, orgId, userId, modelSelection } = params;
  if (getRunModelAccess(modelSelection.selectedModel) === "retired") {
    return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
  }
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
        capabilities,
        selectedModel: modelSelection.selectedModel,
        modelProviderType: provider.type,
      })
    ) {
      return insufficientCredits();
    }
    if (
      isBuiltInModelProviderType(provider.type) &&
      !isSupportedRunModel(modelSelection.selectedModel)
    ) {
      return badRequestMessage("Invalid model selection");
    }
    return {
      modelProviderId: modelSelection.modelProviderId,
      modelProviderType: null,
      modelProviderCredentialScope: null,
      selectedModel: modelSelection.selectedModel,
    };
  }

  if (!isSupportedRunModel(modelSelection.selectedModel)) {
    return badRequestMessage("Invalid model selection");
  }

  const facts = await prepareModelRoutingFacts({
    db,
    orgId,
    userId,
    selectedModel: modelSelection.selectedModel,
    orgPlanCapabilities: params.orgPlanCapabilities,
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
    (facts.modelMode === "auto" &&
      route.modelProviderCredentialScope === "member") ||
    modelRouteAllowedForOrgPlan({
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

export function isCodexFastServiceTierSupported(params: {
  readonly selectedModel: string | null | undefined;
}): boolean {
  return isCodexFastModeModel(params.selectedModel);
}

export function validateCodexServiceTier(params: {
  readonly pin: ModelFirstPin;
  readonly codexServiceTier: "fast" | "ultrafast" | null;
}): ReturnType<typeof badRequestMessage> | undefined {
  if (params.codexServiceTier === "ultrafast") {
    return badRequestMessage("Astra Ultrafast is temporarily disabled");
  }
  if (params.codexServiceTier !== "fast") {
    return undefined;
  }
  if (
    isCodexFastServiceTierSupported({ selectedModel: params.pin.selectedModel })
  ) {
    return undefined;
  }
  return badRequestMessage(
    "Codex fast mode is only available for GPT 5.6 runs",
  );
}

/** Resolve only the enqueued model from a pick-owned, read-only facts graph. */
export function resolveQueuedModelSelectionPinFromSnapshot(params: {
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
  readonly subscriptionModels: readonly MemberSubscriptionModel[];
}):
  | ModelFirstPin
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof insufficientCredits> {
  if (getRunModelAccess(params.selectedModel) === "retired") {
    return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
  }
  if (!isSupportedRunModel(params.selectedModel)) {
    return badRequestMessage("Invalid model selection");
  }
  const policy = params.facts.policies.find((candidate) => {
    return candidate.model === params.selectedModel;
  });
  if (!policy && params.modelMode === "auto") {
    // Auto: a model outside the org policies routes to the member's
    // connected subscription, which is exempt from the plan restriction.
    const personal = params.subscriptionModels.find((entry) => {
      return entry.model === params.selectedModel;
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
    (params.modelMode === "auto" &&
      route.modelProviderCredentialScope === "member") ||
    modelRouteAllowedForOrgPlan({
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
