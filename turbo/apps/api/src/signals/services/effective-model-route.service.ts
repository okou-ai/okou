import {
  getProvidersForModel,
  getRunModelAccess,
  getRunModelRouteAccess,
  isBuiltInModelProviderType,
  isModelSupportedByProvider,
  isSupportedRunModel,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
  type SupportedRunModel,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  getModelProviderTypeForSurfaceProtocol,
  modelProviderSurfaceProtocolSchema,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { and, eq, inArray, isNull } from "drizzle-orm";
import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";

const ORG_SENTINEL_USER_ID = "__org__";
const PERSONAL_TYPES = [
  "claude-code-oauth-token",
  "codex-oauth-token",
] as const;
type PersonalType = (typeof PERSONAL_TYPES)[number];

export interface ResolvedModelFirstPolicyRoute {
  readonly modelProviderId: string | null;
  readonly modelProviderType: ModelProviderType;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope;
  readonly selectedModel: SupportedRunModel;
  readonly personalConnectionState?:
    | "capture_required"
    | "reconnect_required"
    | "unavailable";
}

interface PersonalCandidate {
  readonly type: PersonalType;
  readonly providerId: string | null;
  readonly needsReconnect: boolean;
}

export interface MemberModelRouteContext {
  /** False only for the `__no_preference__` and `__org__` sentinel contexts. */
  readonly memberScoped: boolean;
  readonly subscriptions: readonly PersonalCandidate[];
}

export interface ModelRouteSources {
  readonly member: MemberModelRouteContext;
  readonly providers: readonly {
    readonly id: string;
    readonly type: string;
    readonly userId: string;
    readonly selectedModel: string | null;
  }[];
  readonly surfaces: readonly {
    readonly id: string;
    readonly protocol: string;
    readonly modelMappings: Record<string, string>;
  }[];
}

function personalModelRouteSubscriptions(
  accounts: readonly {
    readonly type: string;
    readonly modelProviderId: string | null;
    readonly isActive: boolean;
    readonly needsReconnect: boolean;
  }[],
): readonly PersonalCandidate[] {
  return PERSONAL_TYPES.flatMap((type) => {
    const connected = accounts.filter((account) => {
      return account.type === type;
    });
    const first = connected[0];
    return first
      ? [
          {
            type,
            providerId: first.modelProviderId,
            needsReconnect: connected.some((account) => {
              return account.isActive && account.needsReconnect;
            }),
          },
        ]
      : [];
  });
}

/** Plain request observations; no account capture, decryption or provider I/O. */
export const loadModelRouteSources$ = command(
  async (
    { set },
    orgId: string,
    userId: string,
    models?: readonly string[],
    abortSignal?: AbortSignal,
  ): Promise<ModelRouteSources> => {
    const db = set(writeDb$);
    const memberScoped =
      userId !== "__no_preference__" && userId !== ORG_SENTINEL_USER_ID;
    const needsPersonal =
      memberScoped &&
      (models === undefined ||
        models.some((model) => {
          return getProvidersForModel(model).some((type) => {
            return PERSONAL_TYPES.some((personal) => {
              return personal === type;
            });
          });
        }));
    const [accounts, providers, surfaces] = await Promise.all([
      needsPersonal
        ? db
            .select({
              type: modelProviderAccounts.type,
              modelProviderId: modelProviderAccounts.modelProviderId,
              isActive: modelProviderAccounts.isActive,
              needsReconnect: modelProviderAccounts.needsReconnect,
            })
            .from(modelProviderAccounts)
            .where(
              and(
                eq(modelProviderAccounts.orgId, orgId),
                eq(modelProviderAccounts.userId, userId),
                inArray(modelProviderAccounts.type, [...PERSONAL_TYPES]),
                isNull(modelProviderAccounts.disconnectedAt),
              ),
            )
        : [],
      db
        .select({
          id: modelProviders.id,
          type: modelProviders.type,
          userId: modelProviders.userId,
          selectedModel: modelProviders.selectedModel,
        })
        .from(modelProviders)
        .where(
          and(
            eq(modelProviders.orgId, orgId),
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
        .where(eq(modelProviderConnections.orgId, orgId)),
    ]);
    abortSignal?.throwIfAborted();
    return {
      member: {
        memberScoped,
        subscriptions: personalModelRouteSubscriptions(accounts),
      },
      providers,
      surfaces,
    };
  },
);

export function providerTypeForSurfaceProtocol(
  protocol: string,
): ModelProviderType | null {
  const parsed = modelProviderSurfaceProtocolSchema.safeParse(protocol);
  return parsed.success
    ? getModelProviderTypeForSurfaceProtocol(parsed.data)
    : null;
}

function isOAuthMemberProviderType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function resolveCustomSurfacePolicyRoute(params: {
  readonly sources: ModelRouteSources;
  readonly policy: {
    readonly model: SupportedRunModel;
    readonly modelProviderId: string | null;
    readonly modelProviderSurfaceId: string;
  };
  readonly providerType: ModelProviderType;
  readonly credentialScope: ModelProviderCredentialScope;
}): ResolvedModelFirstPolicyRoute | null {
  if (
    params.credentialScope !== "org" ||
    params.policy.modelProviderId !== null ||
    isOAuthMemberProviderType(params.providerType)
  ) {
    return null;
  }
  const surface = params.sources.surfaces.find((candidate) => {
    return candidate.id === params.policy.modelProviderSurfaceId;
  });
  if (
    !surface ||
    providerTypeForSurfaceProtocol(surface.protocol) !== params.providerType ||
    typeof surface.modelMappings[params.policy.model] !== "string"
  ) {
    return null;
  }
  return {
    modelProviderId: params.policy.modelProviderSurfaceId,
    modelProviderType: params.providerType,
    modelProviderCredentialScope: params.credentialScope,
    selectedModel: params.policy.model,
  };
}

function isLegacyPolicyRouteShapeValid(params: {
  readonly credentialScope: ModelProviderCredentialScope;
  readonly providerType: ModelProviderType;
  readonly modelProviderId: string | null;
}): boolean {
  if (params.credentialScope === "member") {
    return (
      isOAuthMemberProviderType(params.providerType) &&
      params.modelProviderId === null
    );
  }
  if (isOAuthMemberProviderType(params.providerType)) {
    return false;
  }
  return isBuiltInModelProviderType(params.providerType)
    ? params.modelProviderId === null
    : params.modelProviderId !== null;
}

function getLegacyOrgProviderId(params: {
  readonly credentialScope: ModelProviderCredentialScope;
  readonly providerType: ModelProviderType;
  readonly modelProviderId: string | null;
}): string | null {
  return params.credentialScope === "org" &&
    !isBuiltInModelProviderType(params.providerType)
    ? params.modelProviderId
    : null;
}

interface ModelRoutePolicy {
  readonly model: string;
  readonly defaultProviderType: string;
  readonly credentialScope: string;
  readonly modelProviderId: string | null;
  readonly modelProviderSurfaceId: string | null;
}

function parsePolicyRoute(policy: ModelRoutePolicy): {
  readonly providerType: ModelProviderType;
  readonly credentialScope: ModelProviderCredentialScope;
} {
  const providerType = modelProviderTypeSchema.parse(
    policy.defaultProviderType,
  );
  const credentialScope = policy.credentialScope;
  if (
    (credentialScope !== "org" && credentialScope !== "member") ||
    (policy.modelProviderId !== null &&
      policy.modelProviderSurfaceId !== null) ||
    (isBuiltInModelProviderType(providerType) &&
      (policy.modelProviderId !== null ||
        policy.modelProviderSurfaceId !== null)) ||
    (credentialScope === "member" &&
      (!isOAuthMemberProviderType(providerType) ||
        policy.modelProviderId !== null ||
        policy.modelProviderSurfaceId !== null)) ||
    (credentialScope === "org" && isOAuthMemberProviderType(providerType))
  ) {
    throw new Error(
      "Stored org model policy contains contradictory route values",
    );
  }
  return { providerType, credentialScope };
}

function policyRouteAllowedForPlan(args: {
  readonly policy: ModelRoutePolicy;
  readonly providerType: ModelProviderType;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
}): boolean {
  return (
    getRunModelRouteAccess(
      args.policy.model,
      args.providerType,
      args.capabilities.restrictedBuiltInModels,
    ) === "allowed" &&
    (args.policy.modelProviderSurfaceId !== null ||
      isModelSupportedByProvider(args.policy.model, args.providerType)) &&
    (args.capabilities.supportByok ||
      isBuiltInModelProviderType(args.providerType))
  );
}

/** Shared by runtime model selection and the additive member response. */
export function resolveEffectivePolicyRoute(params: {
  readonly sources: ModelRouteSources;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly policy: ModelRoutePolicy;
}): ResolvedModelFirstPolicyRoute | null {
  const { policy } = params;
  if (
    !isSupportedRunModel(policy.model) ||
    getRunModelAccess(policy.model) !== "allowed"
  ) {
    return null;
  }
  const { providerType, credentialScope } = parsePolicyRoute(policy);
  const member = params.sources.member;
  // Organization Subscription policies keep their required member route under either switch state.
  // A missing nullable org FK is configuration loss, not malformed structure.
  if (member.memberScoped && credentialScope === "org") {
    const supported = getProvidersForModel(policy.model);
    const personal = member.subscriptions.find((candidate) => {
      return supported.includes(candidate.type);
    });
    if (personal) {
      // Do not turn an effective personal entitlement denial into a null route:
      // admission owns that error and must never select a different model/API.
      return {
        modelProviderId: personal.providerId,
        modelProviderType: personal.type,
        modelProviderCredentialScope: "member",
        selectedModel: policy.model,
        personalConnectionState: personal.needsReconnect
          ? "reconnect_required"
          : "capture_required",
      };
    }
  }
  if (
    !policyRouteAllowedForPlan({
      policy,
      providerType,
      capabilities: params.capabilities,
    })
  ) {
    return null;
  }
  if (policy.modelProviderSurfaceId) {
    return resolveCustomSurfacePolicyRoute({
      sources: params.sources,
      policy: {
        model: policy.model,
        modelProviderId: policy.modelProviderId,
        modelProviderSurfaceId: policy.modelProviderSurfaceId,
      },
      providerType,
      credentialScope,
    });
  }
  if (
    !isLegacyPolicyRouteShapeValid({
      credentialScope,
      providerType,
      modelProviderId: policy.modelProviderId,
    })
  ) {
    return null;
  }
  const legacyOrgProviderId = getLegacyOrgProviderId({
    credentialScope,
    providerType,
    modelProviderId: policy.modelProviderId,
  });
  if (legacyOrgProviderId) {
    const provider = params.sources.providers.find((candidate) => {
      return candidate.id === legacyOrgProviderId;
    });
    if (provider?.type !== providerType) {
      return null;
    }
  }

  const legacyPersonal = member.subscriptions.find((candidate) => {
    return candidate.type === providerType;
  });
  return {
    modelProviderId: policy.modelProviderId,
    modelProviderType: providerType,
    modelProviderCredentialScope: credentialScope,
    selectedModel: policy.model,
    ...(credentialScope === "member" && member.memberScoped
      ? {
          personalConnectionState: legacyPersonal
            ? legacyPersonal.needsReconnect
              ? ("reconnect_required" as const)
              : ("capture_required" as const)
            : ("unavailable" as const),
        }
      : {}),
  };
}
