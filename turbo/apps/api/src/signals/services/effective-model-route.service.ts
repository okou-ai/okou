import {
  getDefaultAuthMethod,
  getProvidersForModel,
  getSecretNameForType,
  getSecretNamesForAuthMethod,
  getRunModelAccess,
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
import {
  isFeatureEnabled,
  type FeatureSwitchContext,
} from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { modelProviders } from "@okouai/db/schema/model-provider";
import { modelProviderAccounts } from "@okouai/db/schema/model-provider-account";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { secrets } from "@okouai/db/schema/secret";
import { and, eq, exists, inArray, isNull } from "drizzle-orm";
import type { Db } from "../external/db";
import type { OrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";

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
  readonly priorityEnabled: boolean;
  readonly subscriptions: readonly PersonalCandidate[];
}

interface LoadedPersonalModelRouteMetadata {
  readonly kind: "loaded";
  readonly subscriptions: readonly PersonalCandidate[];
}

/**
 * One request's member observations. `not-applicable` is authoritative;
 * `not-loaded` is the only state that may issue the scoped metadata read.
 */
export interface PreparedMemberModelRouteContext {
  readonly orgId: string;
  readonly userId: string;
  readonly priorityEnabled: boolean;
  readonly personalMetadata:
    | { readonly kind: "not-applicable" }
    | {
        readonly kind: "not-loaded";
        readonly load: () => Promise<LoadedPersonalModelRouteMetadata>;
      };
}

type ModelRouteMemberContext =
  | MemberModelRouteContext
  | PreparedMemberModelRouteContext;

function personalSecretNames(type: PersonalType): readonly string[] {
  const authMethod = getDefaultAuthMethod(type);
  const name = getSecretNameForType(type);
  const names = authMethod
    ? getSecretNamesForAuthMethod(type, authMethod)
    : name
      ? [name]
      : undefined;
  if (!names?.length) {
    throw new Error(`Personal subscription ${type} has no secret contract`);
  }
  return names;
}

function assertFeatureSwitchContextIdentity(
  context: FeatureSwitchContext,
  orgId: string,
  userId: string,
): void {
  if (context.orgId !== orgId || context.userId !== userId) {
    throw new Error("Captured feature-switch context has the wrong identity");
  }
}

export async function prepareMemberModelRouteContext(
  db: Db,
  orgId: string,
  userId: string,
  capturedFeatureSwitchContext?: FeatureSwitchContext,
): Promise<PreparedMemberModelRouteContext> {
  if (userId === "__no_preference__" || userId === ORG_SENTINEL_USER_ID) {
    return Object.freeze({
      orgId,
      userId,
      priorityEnabled: false,
      personalMetadata: Object.freeze({ kind: "not-applicable" as const }),
    });
  }
  const featureSwitchContext =
    capturedFeatureSwitchContext ??
    (await loadUserFeatureSwitchContext(db, orgId, userId));
  assertFeatureSwitchContextIdentity(featureSwitchContext, orgId, userId);
  if (
    !isFeatureEnabled(
      FeatureSwitchKey.PersonalSubscriptionPriority,
      featureSwitchContext,
    )
  ) {
    return Object.freeze({
      orgId,
      userId,
      priorityEnabled: false,
      personalMetadata: Object.freeze({ kind: "not-applicable" as const }),
    });
  }

  let loading: Promise<LoadedPersonalModelRouteMetadata> | undefined;
  const personalMetadata = Object.freeze({
    kind: "not-loaded" as const,
    load: (): Promise<LoadedPersonalModelRouteMetadata> => {
      loading ??= (async () => {
        const subscriptions = await loadPersonalModelRouteSubscriptions(
          db,
          orgId,
          userId,
        );
        return Object.freeze({
          kind: "loaded" as const,
          subscriptions: Object.freeze(
            subscriptions.map((candidate) => {
              return Object.freeze({ ...candidate });
            }),
          ),
        });
      })();
      return loading;
    },
  });
  return Object.freeze({
    orgId,
    userId,
    priorityEnabled: true,
    personalMetadata,
  });
}

export async function loadMemberModelRouteContext(
  db: Db,
  orgId: string,
  userId: string,
): Promise<MemberModelRouteContext> {
  const prepared = await prepareMemberModelRouteContext(db, orgId, userId);
  if (prepared.personalMetadata.kind === "not-applicable") {
    return { priorityEnabled: false, subscriptions: [] };
  }
  const loaded = await prepared.personalMetadata.load();
  return {
    priorityEnabled: true,
    subscriptions: loaded.subscriptions,
  };
}

/** Request-local metadata only. This also runs under thread lifecycle locks.
 * Never call account list/ensure/capture, decrypt, or probe a provider here.
 * A retained parent is absent only after its connection AND mirror were cleared.
 * Actual old writers can recreate a mirror (even only the first Claude write)
 * before updating the parent; canonical A capture owns importing that identity.
 * #34010 owns removal after the serving-writer/context/rollback gates close. */
export async function loadPersonalModelRouteSubscriptions(
  db: Db,
  orgId: string,
  userId: string,
): Promise<readonly PersonalCandidate[]> {
  const accountOwner = and(
    eq(modelProviderAccounts.modelProviderId, modelProviders.id),
    eq(modelProviderAccounts.orgId, orgId),
    eq(modelProviderAccounts.userId, userId),
    eq(modelProviderAccounts.type, modelProviders.type),
  );
  const rows = await db
    .select({
      providerId: modelProviders.id,
      type: modelProviders.type,
      secretId: modelProviders.secretId,
      authMethod: modelProviders.authMethod,
      needsReconnect: modelProviders.needsReconnect,
      hasAccounts: exists(
        db
          .select({ id: modelProviderAccounts.id })
          .from(modelProviderAccounts)
          .where(accountOwner),
      ).mapWith(modelProviders.needsReconnect),
      hasConnectedAccounts: exists(
        db
          .select({ id: modelProviderAccounts.id })
          .from(modelProviderAccounts)
          .where(
            and(accountOwner, isNull(modelProviderAccounts.disconnectedAt)),
          ),
      ).mapWith(modelProviders.needsReconnect),
      activeNeedsReconnect: exists(
        db
          .select({ id: modelProviderAccounts.id })
          .from(modelProviderAccounts)
          .where(
            and(
              accountOwner,
              isNull(modelProviderAccounts.disconnectedAt),
              eq(modelProviderAccounts.isActive, true),
              eq(modelProviderAccounts.needsReconnect, true),
            ),
          ),
      ).mapWith(modelProviders.needsReconnect),
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, userId),
        inArray(modelProviders.type, [...PERSONAL_TYPES]),
      ),
    );
  const mirror = await db
    .select({ name: secrets.name })
    .from(secrets)
    .where(
      and(
        eq(secrets.orgId, orgId),
        eq(secrets.userId, userId),
        eq(secrets.type, "model-provider"),
        inArray(secrets.name, PERSONAL_TYPES.flatMap(personalSecretNames)),
      ),
    );
  const subscriptions: PersonalCandidate[] = [];
  for (const type of PERSONAL_TYPES) {
    const provider = rows.find((row) => {
      return row.type === type;
    });
    const names = personalSecretNames(type);
    const hasMirror = mirror.some((secret) => {
      return names.includes(secret.name);
    });
    const retainedOnly =
      provider?.hasAccounts && !provider.hasConnectedAccounts;
    if (
      (!provider && !hasMirror) ||
      (retainedOnly &&
        provider.secretId === null &&
        provider.authMethod === null &&
        !hasMirror)
    ) {
      continue;
    }
    subscriptions.push({
      type,
      // This is a logical candidate, never an admitted account ID. Historical
      // replacement must be coordinated before A fixes a concrete identity.
      providerId: provider?.providerId ?? null,
      needsReconnect:
        provider?.needsReconnect === true ||
        provider?.activeNeedsReconnect === true,
    });
  }
  return subscriptions;
}

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

async function resolveCustomSurfacePolicyRoute(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly policy: {
    readonly model: SupportedRunModel;
    readonly modelProviderId: string | null;
    readonly modelProviderSurfaceId: string;
  };
  readonly providerType: ModelProviderType;
  readonly credentialScope: ModelProviderCredentialScope;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  if (
    params.credentialScope !== "org" ||
    params.policy.modelProviderId !== null ||
    isOAuthMemberProviderType(params.providerType)
  ) {
    return null;
  }
  const [surface] = await params.db
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
        eq(modelProviderSurfaces.id, params.policy.modelProviderSurfaceId),
        eq(modelProviderConnections.orgId, params.orgId),
      ),
    )
    .limit(1);
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

function policyCanUsePersonalMetadata(args: {
  readonly policy: ModelRoutePolicy;
  readonly credentialScope: ModelProviderCredentialScope;
}): boolean {
  if (args.credentialScope === "member") {
    return true;
  }
  // Subscriptions only ever carry a personal type, so a model that supports
  // none of them can never match one and needs no metadata read.
  return getProvidersForModel(args.policy.model).some((providerType) => {
    return PERSONAL_TYPES.some((personalType): boolean => {
      return personalType === providerType;
    });
  });
}

async function memberContextForPolicy(
  member: ModelRouteMemberContext,
  policy: ModelRoutePolicy,
  credentialScope: ModelProviderCredentialScope,
): Promise<MemberModelRouteContext> {
  if (!("personalMetadata" in member)) {
    return member;
  }
  if (
    !member.priorityEnabled ||
    !policyCanUsePersonalMetadata({ policy, credentialScope }) ||
    member.personalMetadata.kind === "not-applicable"
  ) {
    return { priorityEnabled: member.priorityEnabled, subscriptions: [] };
  }
  const loaded = await member.personalMetadata.load();
  return { priorityEnabled: true, subscriptions: loaded.subscriptions };
}

/** Shared by runtime model selection and the additive member response. */
export async function resolveEffectivePolicyRoute(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly member: ModelRouteMemberContext;
  readonly policy: ModelRoutePolicy;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  const { policy } = params;
  if (
    !isSupportedRunModel(policy.model) ||
    getRunModelAccess(
      policy.model,
      params.capabilities.restrictedBuiltInModels,
    ) !== "allowed"
  ) {
    return null;
  }
  const { providerType, credentialScope } = parsePolicyRoute(policy);
  const member = await memberContextForPolicy(
    params.member,
    policy,
    credentialScope,
  );
  // Organization Subscription policies keep their required member route under either switch state.
  // A missing nullable org FK is configuration loss, not malformed structure.
  if (member.priorityEnabled && credentialScope === "org") {
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
    (!policy.modelProviderSurfaceId &&
      !isModelSupportedByProvider(policy.model, providerType)) ||
    (!params.capabilities.supportByok &&
      !isBuiltInModelProviderType(providerType))
  ) {
    return null;
  }
  if (policy.modelProviderSurfaceId) {
    return await resolveCustomSurfacePolicyRoute({
      db: params.db,
      orgId: params.orgId,
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
    const [provider] = await params.db
      .select({ type: modelProviders.type })
      .from(modelProviders)
      .where(
        and(
          eq(modelProviders.id, legacyOrgProviderId),
          eq(modelProviders.orgId, params.orgId),
          eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        ),
      )
      .limit(1);
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
    ...(credentialScope === "member" && member.priorityEnabled
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
