import {
  loadModelRouteSources$,
  resolveEffectivePolicyRoute,
  type ModelRouteSources,
  type ResolvedModelFirstPolicyRoute,
} from "./effective-model-route.service";
import {
  isCodexFastModeModel,
  isBuiltInModelProviderType,
  getRunModelAccess,
  getRunModelRouteAccess,
  RETIRED_RUN_MODEL_MESSAGE,
  isSupportedRunModel,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderWriteType,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import {
  loadMemberSubscriptionModels$,
  type MemberSubscriptionModel,
} from "./subscription-model-catalog.service";
import { and, eq, or } from "drizzle-orm";

import { badRequestMessage, insufficientCredits } from "../../lib/error";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import {
  ensureOrgModelPolicyFacts$,
  loadOrgModelPolicyFacts$,
  type OrgModelPolicyRow,
} from "./model-policy.service";
import {
  loadOrgPlanCapabilities$,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";

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

/** One selection's ordinary immutable observations. No database provenance or loaders. */
interface ModelRoutingFacts {
  readonly orgPlanCapabilities: OrgPlanCapabilities | null;
  readonly policies: readonly OrgModelPolicyRow[];
  readonly sources: ModelRouteSources;
  readonly modelMode: "auto" | "custom";
  /** Connected subscription catalog models; loaded only in Auto mode. */
  readonly subscriptionModels: readonly MemberSubscriptionModel[];
}

export type ExternalModelProviderPlanCapabilitiesSource =
  | { readonly kind: "load-current" }
  | {
      readonly kind: "resolved";
      readonly capabilities: OrgPlanCapabilities | null;
    };

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

const prepareModelRoutingFacts$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly selectedModel: string | null;
      readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
    },
    abortSignal?: AbortSignal,
  ): Promise<ModelRoutingFacts> => {
    const policyFacts =
      params.userId === "__no_preference__"
        ? await set(
            loadOrgModelPolicyFacts$,
            params.orgId,
            params.orgPlanCapabilities,
            abortSignal,
          )
        : await set(
            ensureOrgModelPolicyFacts$,
            params.orgId,
            params.userId,
            params.orgPlanCapabilities,
            abortSignal,
          );
    const [org] = await set(writeDb$)
      .select({ mode: orgMetadata.modelMode })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, params.orgId))
      .limit(1);
    abortSignal?.throwIfAborted();
    const modelMode = org?.mode === "auto" ? "auto" : "custom";
    const sources = await set(
      loadModelRouteSources$,
      params.orgId,
      params.userId,
      params.selectedModel
        ? [params.selectedModel]
        : modelMode === "auto"
          ? // Auto members may prefer a subscription model outside the policies.
            undefined
          : policyFacts.policies.map((policy) => {
              return policy.model;
            }),
      abortSignal,
    );
    const subscriptionModels =
      modelMode === "auto"
        ? await set(loadMemberSubscriptionModels$, sources.member, abortSignal)
        : [];
    return {
      orgPlanCapabilities: policyFacts.orgPlanCapabilities,
      policies: policyFacts.policies,
      sources,
      modelMode,
      subscriptionModels,
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
  if (!isSupportedRunModel(params.selectedModel)) {
    return null;
  }
  const policy = params.facts.policies.find((candidate) => {
    return candidate.model === params.selectedModel;
  });
  if (policy) {
    return resolveEffectivePolicyRoute({
      sources: params.facts.sources,
      capabilities: params.capabilities,
      policy,
    });
  }
  if (params.facts.modelMode !== "auto") {
    return null;
  }
  const personal = params.facts.subscriptionModels.find((entry) => {
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
export const resolveDefaultModelFirstPin$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly defaultSource?: "member" | "workspace";
      readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
    },
    abortSignal?: AbortSignal,
  ): Promise<DefaultModelFirstPin> => {
    const db = set(writeDb$);
    const {
      orgId,
      userId,
      orgPlanCapabilities,
      defaultSource = "member",
    } = params;
    const facts = await set(
      prepareModelRoutingFacts$,
      {
        orgId,
        userId,
        selectedModel: null,
        orgPlanCapabilities,
      },
      abortSignal,
    );
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
      abortSignal?.throwIfAborted();
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
              ? facts.subscriptionModels.find((entry) => {
                  return entry.model === preferredRoute.selectedModel;
                })?.serviceTier
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

function resolveWorkspaceDefaultModelFirstRoute(params: {
  readonly facts: ModelRoutingFacts;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
}): ResolvedModelFirstPolicyRoute | null {
  const policy = params.facts.policies.find((candidate) => {
    return candidate.isDefault;
  });
  return policy
    ? resolveValidPolicyRoute({
        facts: params.facts,
        capabilities: params.capabilities,
        selectedModel: policy.model,
      })
    : null;
}

export const resolveModelSelectionPin$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly modelSelection: ModelSelectionRequest;
      /** The organization's plan, when the caller already read it in this request. */
      readonly orgPlanCapabilities?: OrgPlanCapabilities | null;
    },
    abortSignal?: AbortSignal,
  ): Promise<
    | ModelFirstPin
    | ReturnType<typeof badRequestMessage>
    | ReturnType<typeof insufficientCredits>
  > => {
    const db = set(writeDb$);
    const { orgId, userId, modelSelection } = params;
    if (getRunModelAccess(modelSelection.selectedModel) === "retired") {
      return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
    }
    if (modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID) {
      const [org] = await db
        .select({ mode: orgMetadata.modelMode })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      abortSignal?.throwIfAborted();
      if (org?.mode === "auto") {
        return badRequestMessage("Use the available models for this workspace");
      }
      const capabilities = modelRouteCapabilities(
        params.orgPlanCapabilities === undefined
          ? await set(loadOrgPlanCapabilities$, orgId, abortSignal)
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
      abortSignal?.throwIfAborted();
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

    const facts = await set(
      prepareModelRoutingFacts$,
      {
        orgId,
        userId,
        selectedModel: modelSelection.selectedModel,
        orgPlanCapabilities: params.orgPlanCapabilities,
      },
      abortSignal,
    );
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

/** An enqueue already validated its model; execution may trust that choice. */
export type ProviderModelSupport = "validate" | "trust-enqueued";

export function isCodexFastServiceTierSupported(params: {
  readonly selectedModel: string | null | undefined;
}): boolean {
  return isCodexFastModeModel(params.selectedModel);
}

export function validateCodexServiceTier(params: {
  readonly pin: ModelFirstPin;
  readonly codexServiceTier: "fast" | null;
}): ReturnType<typeof badRequestMessage> | undefined {
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
