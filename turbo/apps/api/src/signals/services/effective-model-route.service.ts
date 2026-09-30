import {
  isBuiltInModelProviderType,
  modelProviderTypeSchema,
  type ModelProviderCredentialScope,
  type ModelProviderType,
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
import type { Db, ReadonlyDb } from "../external/db";
import {
  catalogHasProviderRoute,
  isCatalogModelRunnable,
  type ModelCatalog,
} from "./model-catalog.service";
import { catalogRunModelRouteAccess } from "./model-route-capabilities.service";
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
  readonly selectedModel: string;
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
  readonly memberScoped: boolean;
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

export function prepareMemberModelRouteContext(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): PreparedMemberModelRouteContext {
  if (userId === "__no_preference__" || userId === ORG_SENTINEL_USER_ID) {
    return Object.freeze({
      orgId,
      userId,
      memberScoped: false,
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
    memberScoped: true,
    personalMetadata,
  });
}

export async function loadMemberModelRouteContext(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<MemberModelRouteContext> {
  const prepared = prepareMemberModelRouteContext(db, orgId, userId);
  if (prepared.personalMetadata.kind === "not-applicable") {
    return { memberScoped: false, subscriptions: [] };
  }
  const loaded = await prepared.personalMetadata.load();
  return {
    memberScoped: true,
    subscriptions: loaded.subscriptions,
  };
}

/** Request-local metadata only. This also runs under thread lifecycle locks.
 * Never call account list/capture, decrypt, or probe a provider here. A type is
 * a candidate only while its logical provider has a connected account. */
async function loadPersonalModelRouteSubscriptions(
  db: ReadonlyDb,
  orgId: string,
  userId: string,
): Promise<readonly PersonalCandidate[]> {
  const accounts = await db
    .select({
      type: modelProviderAccounts.type,
      providerId: modelProviderAccounts.modelProviderId,
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
    );
  return PERSONAL_TYPES.flatMap((type) => {
    const connected = accounts.filter((account) => {
      return account.type === type;
    });
    const first = connected[0];
    if (!first) {
      return [];
    }
    return [
      {
        type,
        // This is a logical candidate, never an admitted account ID.
        providerId: first.providerId,
        needsReconnect: connected.some((account) => {
          return account.isActive && account.needsReconnect;
        }),
      },
    ];
  });
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
    readonly model: string;
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

export interface ModelRoutePolicy {
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

/** Whether the catalog has an enabled route of the selected provider type. */
function catalogServesModel(
  catalog: ModelCatalog,
  model: string,
  providerType: ModelProviderType,
): boolean {
  return catalogHasProviderRoute(
    catalog,
    model,
    isBuiltInModelProviderType(providerType) ? "built-in" : providerType,
  );
}

function policyCanUsePersonalMetadata(args: {
  readonly catalog: ModelCatalog;
  readonly policy: ModelRoutePolicy;
  readonly credentialScope: ModelProviderCredentialScope;
}): boolean {
  if (args.credentialScope === "member") {
    return true;
  }
  // Subscriptions only ever carry a personal type, so a model that supports
  // none of them can never match one and needs no metadata read.
  return PERSONAL_TYPES.some((personalType): boolean => {
    return catalogServesModel(args.catalog, args.policy.model, personalType);
  });
}

async function memberContextForPolicy(
  catalog: ModelCatalog,
  member: ModelRouteMemberContext,
  policy: ModelRoutePolicy,
  credentialScope: ModelProviderCredentialScope,
): Promise<MemberModelRouteContext> {
  if (!("personalMetadata" in member)) {
    return member;
  }
  if (
    !member.memberScoped ||
    !policyCanUsePersonalMetadata({ catalog, policy, credentialScope }) ||
    member.personalMetadata.kind === "not-applicable"
  ) {
    return { memberScoped: member.memberScoped, subscriptions: [] };
  }
  const loaded = await member.personalMetadata.load();
  return { memberScoped: true, subscriptions: loaded.subscriptions };
}

/** The member's loaded logical subscriptions (none for sentinel contexts). */
export async function loadedMemberModelRouteContext(
  member: ModelRouteMemberContext,
): Promise<MemberModelRouteContext> {
  if (!("personalMetadata" in member)) {
    return member;
  }
  if (member.personalMetadata.kind === "not-applicable") {
    return { memberScoped: false, subscriptions: [] };
  }
  const loaded = await member.personalMetadata.load();
  return { memberScoped: true, subscriptions: loaded.subscriptions };
}

/**
 * The one free-plan exemption besides free Built-in models, for Auto and
 * Custom alike: the route uses the requesting member's own connected, valid
 * (not reconnect-required) Claude Code or Codex account with member credential
 * scope, and the model has an enabled catalog subscription route
 * (`model_routes.subscription_type`) of that type. A model name or provider
 * type alone is never exempt; API keys, custom gateways and organization
 * credentials never are.
 */
export function isMemberSubscriptionRoute(args: {
  readonly catalog: ModelCatalog;
  readonly member: MemberModelRouteContext;
  readonly model: string | null | undefined;
  readonly providerType: string | null | undefined;
  /** The route's credential scope when the caller knows it. */
  readonly credentialScope?: string | null;
}): boolean {
  const { model } = args;
  const type = PERSONAL_TYPES.find((candidate) => {
    return candidate === args.providerType;
  });
  if (
    !model ||
    !type ||
    !args.member.memberScoped ||
    (args.credentialScope !== undefined &&
      args.credentialScope !== null &&
      args.credentialScope !== "member") ||
    !isCatalogModelRunnable(args.catalog, model)
  ) {
    return false;
  }
  return (
    args.member.subscriptions.some((candidate) => {
      return candidate.type === type && !candidate.needsReconnect;
    }) &&
    args.catalog.routes.some((route) => {
      return (
        route.enabled &&
        route.model === model &&
        route.subscriptionType === type
      );
    })
  );
}

function policyRouteAllowedForPlan(args: {
  readonly catalog: ModelCatalog;
  readonly policy: ModelRoutePolicy;
  readonly providerType: ModelProviderType;
  readonly credentialScope: ModelProviderCredentialScope;
  readonly member: MemberModelRouteContext;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
}): boolean {
  if (
    isMemberSubscriptionRoute({
      catalog: args.catalog,
      member: args.member,
      model: args.policy.model,
      providerType: args.providerType,
      credentialScope: args.credentialScope,
    })
  ) {
    return catalogServesModel(
      args.catalog,
      args.policy.model,
      args.providerType,
    );
  }
  return (
    catalogRunModelRouteAccess(
      args.catalog,
      args.policy.model,
      args.providerType,
      args.capabilities.restrictedBuiltInModels,
    ) === "allowed" &&
    (args.policy.modelProviderSurfaceId !== null ||
      catalogServesModel(args.catalog, args.policy.model, args.providerType)) &&
    (args.capabilities.supportByok ||
      isBuiltInModelProviderType(args.providerType))
  );
}

/** Shared by runtime model selection and the additive member response. */
export async function resolveEffectivePolicyRoute(params: {
  readonly db: Db;
  /** Loaded once by the caller and shared across every policy it resolves. */
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly member: ModelRouteMemberContext;
  readonly policy: ModelRoutePolicy;
}): Promise<ResolvedModelFirstPolicyRoute | null> {
  const { policy } = params;
  if (!isCatalogModelRunnable(params.catalog, policy.model)) {
    return null;
  }
  const { providerType, credentialScope } = parsePolicyRoute(policy);
  const member = await memberContextForPolicy(
    params.catalog,
    params.member,
    policy,
    credentialScope,
  );
  // Organization Subscription policies keep their required member route under either switch state.
  // A missing nullable org FK is configuration loss, not malformed structure.
  if (member.memberScoped && credentialScope === "org") {
    const personal = member.subscriptions.find((candidate) => {
      return catalogServesModel(params.catalog, policy.model, candidate.type);
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
      catalog: params.catalog,
      policy,
      providerType,
      credentialScope,
      member,
      capabilities: params.capabilities,
    })
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

/** Resolve routing from already-loaded facts without another database read. */
export function resolveEffectivePolicyRouteFromSnapshot(params: {
  readonly catalog: ModelCatalog;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly member: MemberModelRouteContext;
  readonly policy: ModelRoutePolicy;
  readonly orgProviderType?: string | null;
  readonly customSurface?: {
    readonly protocol: string;
    readonly modelMappings: Readonly<Record<string, string>>;
  } | null;
}): ResolvedModelFirstPolicyRoute | null {
  const { policy, member } = params;
  if (!isCatalogModelRunnable(params.catalog, policy.model)) {
    return null;
  }
  const { providerType, credentialScope } = parsePolicyRoute(policy);
  if (member.memberScoped && credentialScope === "org") {
    const personal = member.subscriptions.find((candidate) => {
      return catalogServesModel(params.catalog, policy.model, candidate.type);
    });
    if (personal) {
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
      catalog: params.catalog,
      policy,
      providerType,
      credentialScope,
      member,
      capabilities: params.capabilities,
    })
  ) {
    return null;
  }
  if (policy.modelProviderSurfaceId) {
    const surface = params.customSurface;
    if (
      credentialScope !== "org" ||
      policy.modelProviderId !== null ||
      isOAuthMemberProviderType(providerType) ||
      !surface ||
      providerTypeForSurfaceProtocol(surface.protocol) !== providerType ||
      typeof surface.modelMappings[policy.model] !== "string"
    ) {
      return null;
    }
    return {
      modelProviderId: policy.modelProviderSurfaceId,
      modelProviderType: providerType,
      modelProviderCredentialScope: credentialScope,
      selectedModel: policy.model,
    };
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
  if (
    getLegacyOrgProviderId({
      credentialScope,
      providerType,
      modelProviderId: policy.modelProviderId,
    }) &&
    params.orgProviderType !== providerType
  ) {
    return null;
  }
  const personal = member.subscriptions.find((candidate) => {
    return candidate.type === providerType;
  });
  return {
    modelProviderId: policy.modelProviderId,
    modelProviderType: providerType,
    modelProviderCredentialScope: credentialScope,
    selectedModel: policy.model,
    ...(credentialScope === "member" && member.memberScoped
      ? {
          personalConnectionState:
            personalConnectionStateFromCandidate(personal),
        }
      : {}),
  };
}

/** Whether the exact policy can use the member's logical subscription routes. */
export function modelPolicyUsesPersonalMetadata(
  catalog: ModelCatalog,
  policy: ModelRoutePolicy,
): boolean {
  return policyCanUsePersonalMetadata({
    catalog,
    policy,
    credentialScope: parsePolicyRoute(policy).credentialScope,
  });
}

/** Share logical-account selection with queue graphs that own the batch read. */
export function memberModelRouteContextFromAccounts(
  userId: string,
  accounts: readonly {
    readonly type: string;
    readonly providerId: string;
    readonly isActive: boolean;
    readonly needsReconnect: boolean;
  }[],
): MemberModelRouteContext {
  return {
    memberScoped:
      userId !== "__no_preference__" && userId !== ORG_SENTINEL_USER_ID,
    subscriptions: PERSONAL_TYPES.flatMap((type) => {
      const connected = accounts.filter((account) => {
        return account.type === type;
      });
      const first = connected[0];
      return first
        ? [
            {
              type,
              providerId: first.providerId,
              needsReconnect: connected.some((account) => {
                return account.isActive && account.needsReconnect;
              }),
            },
          ]
        : [];
    }),
  };
}

function personalConnectionStateFromCandidate(
  personal: PersonalCandidate | undefined,
) {
  if (!personal) {
    return "unavailable" as const;
  }
  return personal.needsReconnect
    ? ("reconnect_required" as const)
    : ("capture_required" as const);
}
