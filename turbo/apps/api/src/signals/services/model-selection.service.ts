import {
  prepareMemberModelRouteContext,
  providerTypeForSurfaceProtocol,
  resolveEffectivePolicyRoute,
  type PreparedMemberModelRouteContext,
  type ResolvedModelFirstPolicyRoute,
} from "./effective-model-route.service";
import {
  getFrameworkForType,
  getBuiltInConcreteProviderType,
  isCodexFastModeModel,
  isBuiltInModelProviderType,
  getRunModelAccess,
  RETIRED_RUN_MODEL_MESSAGE,
  isSupportedRunModel,
  isModelSupportedByProvider,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderWriteType,
} from "@okouai/api-contracts/contracts/model-providers";
import type { ChatThreadServiceTier } from "@okouai/api-contracts/contracts/chat-threads";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import type { SupportedFramework } from "@okouai/core/frameworks";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { and, eq, or } from "drizzle-orm";

import { badRequestMessage, insufficientCredits } from "../../lib/error";
import type { Db } from "../external/db";
import {
  ensureOrgModelPolicyFacts,
  loadOrgModelPolicyFacts,
  type OrgModelPolicyRow,
} from "./model-policy.service";
import {
  checkOrgCreditsForRunAdmission,
  checkOrgPlanRunAdmission,
} from "./run-admission.service";
import {
  loadOrgPlanCapabilities,
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

interface PersistedModelFirstRouteResolution {
  readonly route: ResolvedModelFirstPolicyRoute | null;
  readonly selectedModelChanged: boolean;
  readonly orgPlanCapabilities: OrgPlanCapabilities | null;
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
  readonly [modelRoutingFactsSource]: Db;
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

function modelAllowedForOrgPlan(args: {
  readonly capabilities: Pick<OrgPlanCapabilities, "restrictedBuiltInModels">;
  readonly selectedModel: string | null | undefined;
}): boolean {
  return (
    getRunModelAccess(
      args.selectedModel,
      args.capabilities.restrictedBuiltInModels,
    ) === "allowed"
  );
}

function modelProviderAllowedForOrgPlan(args: {
  readonly capabilities: Pick<OrgPlanCapabilities, "supportByok">;
  readonly modelProviderType: string | null | undefined;
}): boolean {
  return (
    args.capabilities.supportByok ||
    isBuiltInModelProviderType(args.modelProviderType)
  );
}

async function prepareModelRoutingFacts(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly selectedModel: string | null;
  readonly featureSwitchContext?: FeatureSwitchContext;
}): Promise<ModelRoutingFacts> {
  const policyFactsPromise =
    params.userId === "__no_preference__"
      ? loadOrgModelPolicyFacts(params.db, params.orgId)
      : ensureOrgModelPolicyFacts(params.db, params.orgId, params.userId);
  const [policyFacts, member] = await Promise.all([
    policyFactsPromise,
    prepareMemberModelRouteContext(
      params.db,
      params.orgId,
      params.userId,
      params.featureSwitchContext,
    ),
  ]);
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
  return policy
    ? await resolveEffectivePolicyRoute({
        db: params.facts[modelRoutingFactsSource],
        orgId: params.facts.identity.orgId,
        member: params.facts.member,
        capabilities: params.capabilities,
        policy,
      })
    : null;
}

export async function resolveDefaultModelFirstPin(
  db: Db,
  orgId: string,
  userId: string,
  options?: { readonly featureSwitchContext?: FeatureSwitchContext },
): Promise<DefaultModelFirstPin> {
  const facts = await prepareModelRoutingFacts({
    db,
    orgId,
    userId,
    selectedModel: null,
    featureSwitchContext: options?.featureSwitchContext,
  });
  const capabilities = modelRouteCapabilities(facts.orgPlanCapabilities);
  if (userId !== "__no_preference__") {
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
        const serviceTier =
          preference.serviceTier === "priority" &&
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

export async function resolvePersistedModelFirstRoute(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly selectedModel: string | null;
  readonly featureSwitchContext?: FeatureSwitchContext;
}): Promise<PersistedModelFirstRouteResolution> {
  const facts = await prepareModelRoutingFacts(params);
  const capabilities = modelRouteCapabilities(facts.orgPlanCapabilities);
  const currentRoute = params.selectedModel
    ? await resolveValidPolicyRoute({
        facts,
        capabilities,
        selectedModel: params.selectedModel,
      })
    : null;
  if (currentRoute) {
    return {
      route: currentRoute,
      selectedModelChanged: false,
      orgPlanCapabilities: facts.orgPlanCapabilities,
    };
  }

  const defaultRoute = await resolveWorkspaceDefaultModelFirstRoute({
    facts,
    capabilities,
  });
  return {
    route: defaultRoute,
    selectedModelChanged:
      defaultRoute !== null &&
      defaultRoute.selectedModel !== params.selectedModel,
    orgPlanCapabilities: facts.orgPlanCapabilities,
  };
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
  readonly featureSwitchContext?: FeatureSwitchContext;
}): Promise<
  | ModelFirstPin
  | ReturnType<typeof badRequestMessage>
  | ReturnType<typeof insufficientCredits>
> {
  const { db, orgId, userId, modelSelection } = params;
  if (getRunModelAccess(modelSelection.selectedModel) === "retired") {
    return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
  }
  const orgPlanCapabilities = await loadOrgPlanCapabilities(db, orgId);
  const capabilities = modelRouteCapabilities(orgPlanCapabilities);
  if (
    !modelAllowedForOrgPlan({
      capabilities,
      selectedModel: modelSelection.selectedModel,
    })
  ) {
    return insufficientCredits();
  }
  if (modelSelection.modelProviderId !== MODEL_FIRST_SELECTION_PROVIDER_ID) {
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
      !modelProviderAllowedForOrgPlan({
        capabilities,
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
    featureSwitchContext: params.featureSwitchContext,
  });
  const route = await resolveValidPolicyRoute({
    facts,
    capabilities: modelRouteCapabilities(facts.orgPlanCapabilities),
    selectedModel: modelSelection.selectedModel,
  });
  return route
    ? modelFirstPinFromRoute(route)
    : badRequestMessage(
        "The selected model is not available in this workspace",
      );
}

async function resolveEffectiveModelProviderType(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ModelFirstPin;
  readonly requestedModelProvider: string | undefined;
}): Promise<string | null | undefined> {
  if (params.modelPin.modelProviderType) {
    return params.modelPin.modelProviderType;
  }
  if (!params.modelPin.modelProviderId) {
    return params.requestedModelProvider;
  }

  const [provider] = await params.db
    .select({ type: modelProviders.type })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.id, params.modelPin.modelProviderId),
        eq(modelProviders.orgId, params.orgId),
        or(
          eq(modelProviders.userId, params.userId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      ),
    )
    .limit(1);

  return provider?.type ?? params.requestedModelProvider;
}

export async function resolveModelFirstProviderAdmission(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly modelPin: ModelFirstPin;
  readonly requestedModelProvider: string | undefined;
  readonly externalPlanCapabilities: ExternalModelProviderPlanCapabilitiesSource;
}): Promise<{
  readonly effectiveModelProvider: string | null | undefined;
  readonly cliAgentType: SupportedFramework | null;
  readonly error:
    | Awaited<ReturnType<typeof checkOrgCreditsForRunAdmission>>
    | ReturnType<typeof badRequestMessage>;
}> {
  const effectiveModelProvider =
    await resolveEffectiveModelProviderType(params);
  const selectedModel = params.modelPin.selectedModel;
  const [customSurface] =
    params.modelPin.modelProviderId === null
      ? []
      : await params.db
          .select({
            protocol: modelProviderSurfaces.protocol,
            modelMappings: modelProviderSurfaces.modelMappings,
          })
          .from(modelProviderSurfaces)
          .innerJoin(
            modelProviderConnections,
            eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
          )
          .where(
            and(
              eq(modelProviderSurfaces.id, params.modelPin.modelProviderId),
              eq(modelProviderConnections.orgId, params.orgId),
            ),
          )
          .limit(1);
  const customSurfaceProviderType = customSurface
    ? providerTypeForSurfaceProtocol(customSurface.protocol)
    : null;
  const usesCustomSurface =
    customSurfaceProviderType !== null &&
    customSurfaceProviderType === effectiveModelProvider &&
    isSupportedRunModel(selectedModel) &&
    typeof customSurface?.modelMappings[selectedModel] === "string";
  const parsedProvider = modelProviderTypeSchema.safeParse(
    effectiveModelProvider,
  );
  const knownProvider = parsedProvider.success ? parsedProvider.data : null;
  const cliAgentType = knownProvider
    ? getFrameworkForType(
        isBuiltInModelProviderType(knownProvider) &&
          isSupportedRunModel(selectedModel)
          ? getBuiltInConcreteProviderType(selectedModel)
          : knownProvider,
      )
    : null;
  if (
    isSupportedRunModel(selectedModel) &&
    !usesCustomSurface &&
    (!knownProvider ||
      !isModelSupportedByProvider(selectedModel, knownProvider))
  ) {
    return {
      effectiveModelProvider,
      cliAgentType,
      error: badRequestMessage(
        "The selected model is not supported by the current model provider",
      ),
    };
  }
  const error = isBuiltInModelProviderType(effectiveModelProvider)
    ? await checkOrgCreditsForRunAdmission({
        db: params.db,
        orgId: params.orgId,
        userId: params.userId,
        modelProviderType: effectiveModelProvider,
        selectedModel,
      })
    : checkOrgPlanRunAdmission({
        capabilities:
          params.externalPlanCapabilities.kind === "resolved"
            ? params.externalPlanCapabilities.capabilities
            : await loadOrgPlanCapabilities(params.db, params.orgId),
        modelProviderType: effectiveModelProvider,
        selectedModel,
      });
  return { effectiveModelProvider, cliAgentType, error };
}

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
