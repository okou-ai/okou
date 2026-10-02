import { createHash } from "node:crypto";
import type { OnboardingSubscriptionProvider } from "@okouai/api-contracts/contracts/onboarding";
import {
  builtInModelKeyIdsByVendor$,
  resolveBuiltInModelRuntimeRouteWithKeys,
  type BuiltInModelKeyIdsByVendor,
} from "./built-in-model-runtime-route.service";
import {
  isMemberSubscriptionRoute,
  loadMemberModelRouteContext,
  resolveEffectivePolicyRoute,
  type MemberModelRouteContext,
  type ResolvedModelFirstPolicyRoute,
} from "./effective-model-route.service";
import {
  checkOrgPlanRunAdmission,
  restrictedPlanModelRequired,
} from "./run-admission.service";
import { isCloudModelMappingValid } from "@okouai/api-contracts/contracts/cloud-model-mapping";
import { command } from "ccstate";
import { and, eq, inArray, notInArray } from "drizzle-orm";
import {
  MODEL_PROVIDER_TYPES,
  getFrameworkForType,
  isBuiltInModelProviderType,
  RETIRED_RUN_MODEL_MESSAGE,
  type ModelProviderCredentialScope,
  type OrgModelPoliciesResponse,
  type OrgModelPolicy,
  type OrgModelPolicyRouteStatus,
  type UpdateOrgModelPolicy,
  type ModelProviderType,
} from "@okouai/api-contracts/contracts/model-providers";
import {
  getModelProviderTypeForSurfaceProtocol,
  modelProviderSurfaceProtocolSchema,
} from "@okouai/api-contracts/contracts/model-provider-gateways";
import { modelProviders } from "@okouai/db/schema/model-provider";
import {
  modelProviderConnections,
  modelProviderSurfaces,
} from "@okouai/db/schema/model-provider-gateway";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import {
  loadMemberSubscriptionModels,
  type MemberSubscriptionModel,
} from "./member-subscription-models.service";
import {
  catalogActiveModels,
  catalogDisplayName,
  catalogHasProviderRoute,
  catalogModelRank,
  isCatalogModelAddable,
  isCatalogModelRunnable,
  catalogBuiltInCandidates,
  resolveCatalogModel,
  type ModelCatalog,
  modelCatalog$,
} from "./model-catalog.service";
import {
  catalogModelAllowsCustomGateway,
  catalogRunModelRouteAccess,
} from "./model-route-capabilities.service";
import {
  conflict,
  insufficientCredits,
  paidPlanRequired,
} from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
export type OrgModelPolicyRow = Readonly<
  Omit<typeof orgModelPolicies.$inferSelect, "modelProviderSurfaceId"> & {
    readonly modelProviderSurfaceId: string | null;
  }
>;

interface ProviderRouteInfo {
  readonly selectedModel: string | null;
  readonly id: string;
  readonly userId: string;
  readonly type: ModelProviderType;
}

interface SurfaceRouteInfo {
  readonly id: string;
  readonly protocol: string;
  readonly modelMappings: Record<string, string>;
}

type ServiceResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly message: string }
  | {
      readonly ok: false;
      readonly response:
        | ReturnType<typeof insufficientCredits>
        | ReturnType<typeof paidPlanRequired>
        | ReturnType<typeof conflict>;
    };

const ORG_SENTINEL_USER_ID = "__org__";

const ONBOARDING_MODEL_POLICY_SEEDS = {
  codex: {
    models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
    providerType: "codex-oauth-token",
  },
  claudeCode: {
    models: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5"],
    providerType: "claude-code-oauth-token",
  },
} as const satisfies Record<
  OnboardingSubscriptionProvider,
  {
    readonly models: readonly string[];
    readonly providerType: ModelProviderType;
  }
>;

// Built-in seeds written by APIs that predate the fixed Auto default. An org
// created during that rollout can still hold one untouched when it finishes
// onboarding; see #36167 for the `gpt-5.6-luna` variant.
const PREVIOUS_STANDARD_SEED_MODELS: readonly (readonly string[])[] = [
  ["claude-fable-5-1", "gpt-6-astra", "gpt-6-luna"],
  ["claude-fable-5-1", "gpt-6-astra", "gpt-5.6-luna"],
];

/**
 * The system default is projected into every organization's policy list and
 * never persisted per organization. Its identity is derived from the org and
 * model so clients see a stable ID across reads.
 */
function projectedDefaultPolicyId(orgId: string, model: string): string {
  const hex = createHash("sha256")
    .update(`org-model-policy-default:${orgId}:${model}`)
    .digest("hex");
  const variant = (
    (Number.parseInt(hex.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function projectedDefaultPolicy(
  orgId: string,
  model: string,
): OrgModelPolicyRow {
  return {
    id: projectedDefaultPolicyId(orgId, model),
    orgId,
    model,
    defaultProviderType: "built-in",
    credentialScope: "org",
    modelProviderId: null,
    modelProviderSurfaceId: null,
    createdByUserId: ORG_SENTINEL_USER_ID,
    updatedByUserId: ORG_SENTINEL_USER_ID,
    // A stable epoch timestamp: the projected policy has no stored row.
    createdAt: new Date(0),
    updatedAt: new Date(0),
  };
}

/**
 * Effective organization policies: the projected system default first, then
 * stored policies of other active models. Stored rows of replaced models are
 * converted by the stored-configuration migration and are not policies; a
 * stored row of the default model is superseded by the projection.
 */
function projectPolicyRows(
  catalog: ModelCatalog,
  orgId: string,
  stored: readonly OrgModelPolicyRow[],
): OrgModelPolicyRow[] {
  const defaultModel = catalog.systemDefaultModel;
  return sortRowsByCatalog(catalog, [
    projectedDefaultPolicy(orgId, defaultModel),
    ...stored.filter((row) => {
      return (
        row.model !== defaultModel &&
        parseSupportedModel(catalog, row.model) !== null
      );
    }),
  ]);
}

function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

function bad<T>(message: string): ServiceResult<T> {
  return { ok: false, message };
}

/**
 * A catalog model a free plan cannot configure on the route asks for a paid
 * plan by name and names the free alternatives; other restrictions report
 * insufficient credits.
 */
function planRestricted<T>(
  catalog: ModelCatalog,
  model?: string,
): ServiceResult<T> {
  const row = model === undefined ? undefined : catalog.byModel.get(model);
  return {
    ok: false,
    response: row
      ? restrictedPlanModelRequired(catalog, row.displayName)
      : insufficientCredits(),
  };
}

function isOAuthMemberProviderType(type: ModelProviderType): boolean {
  return type === "claude-code-oauth-token" || type === "codex-oauth-token";
}

function providerTypeForSurface(protocol: string): ModelProviderType | null {
  const parsed = modelProviderSurfaceProtocolSchema.safeParse(protocol);
  return parsed.success
    ? getModelProviderTypeForSurfaceProtocol(parsed.data)
    : null;
}

function surfaceSupportsModel(
  catalog: ModelCatalog,
  surface: SurfaceRouteInfo,
  model: string,
): boolean {
  if (!catalogModelAllowsCustomGateway(catalog, model)) {
    return false;
  }
  // A custom gateway serves the model through the same protocol framework as
  // the model's primary Built-in catalog candidate.
  const [primary] = catalogBuiltInCandidates(catalog, model);
  const concreteType = parseProviderType(primary?.concreteProviderType ?? "");
  const providerType = providerTypeForSurface(surface.protocol);
  return (
    providerType !== null &&
    concreteType !== null &&
    getFrameworkForType(providerType) === getFrameworkForType(concreteType) &&
    typeof surface.modelMappings[model] === "string"
  );
}

function parseProviderType(value: string): ModelProviderType | null {
  return value in MODEL_PROVIDER_TYPES ? (value as ModelProviderType) : null;
}

/** The catalog alone decides which models can be configured. */
function parseSupportedModel(
  catalog: ModelCatalog,
  value: string,
): string | null {
  return isCatalogModelAddable(catalog, value) &&
    isCatalogModelRunnable(catalog, value)
    ? value
    : null;
}

function parseCredentialScope(
  value: string,
): ModelProviderCredentialScope | null {
  return value === "org" || value === "member" ? value : null;
}

/** Every stored policy row of the organization, whatever its model. */
function loadRows(db: Db, orgId: string): Promise<OrgModelPolicyRow[]> {
  return db
    .select({
      id: orgModelPolicies.id,
      orgId: orgModelPolicies.orgId,
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
      modelProviderSurfaceId: orgModelPolicies.modelProviderSurfaceId,
      createdByUserId: orgModelPolicies.createdByUserId,
      updatedByUserId: orgModelPolicies.updatedByUserId,
      createdAt: orgModelPolicies.createdAt,
      updatedAt: orgModelPolicies.updatedAt,
    })
    .from(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, orgId));
}

function policyRevision(rows: readonly OrgModelPolicyRow[]): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        [...rows].sort((a, b) => {
          return a.model.localeCompare(b.model);
        }),
      ),
    )
    .digest("hex");
}

function policiesByModel(
  rows: readonly OrgModelPolicyRow[],
): Map<string, OrgModelPolicyRow> {
  return new Map(
    rows.map((row) => {
      return [row.model, row];
    }),
  );
}

function modelsAvailableToAdd(
  catalog: ModelCatalog,
  rows: readonly OrgModelPolicyRow[],
): string[] {
  const configured = new Set(
    rows.map((row) => {
      return row.model;
    }),
  );
  return catalog.models.flatMap((row) => {
    const model = parseSupportedModel(catalog, row.model);
    return model && !configured.has(model) ? [model] : [];
  });
}

function routeIdentityUnchanged(
  policy: Pick<
    UpdateOrgModelPolicy,
    "defaultProviderType" | "credentialScope" | "modelProviderId"
  >,
  existing: OrgModelPolicyRow | undefined,
): boolean {
  return (
    existing !== undefined &&
    existing.defaultProviderType === policy.defaultProviderType &&
    existing.credentialScope === policy.credentialScope &&
    (existing.modelProviderId ?? null) === (policy.modelProviderId ?? null)
  );
}

function resolveOmittedModelProviderSurfaceIds(
  policies: readonly UpdateOrgModelPolicy[],
  existingRows: readonly OrgModelPolicyRow[],
): UpdateOrgModelPolicy[] {
  const existingByModel = policiesByModel(existingRows);
  return policies.map((policy) => {
    if (policy.modelProviderSurfaceId !== undefined) {
      return policy;
    }
    const existing = existingByModel.get(policy.model);
    return {
      ...policy,
      modelProviderSurfaceId: routeIdentityUnchanged(policy, existing)
        ? (existing?.modelProviderSurfaceId ?? null)
        : null,
    };
  });
}

/** True when the write keeps an already-stored route exactly as persisted. */
function storedRouteUnchanged(
  policy: UpdateOrgModelPolicy,
  existing: OrgModelPolicyRow | undefined,
): boolean {
  return (
    routeIdentityUnchanged(policy, existing) &&
    (existing?.modelProviderSurfaceId ?? null) ===
      (policy.modelProviderSurfaceId ?? null)
  );
}

export function modelPolicyCapabilities(
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

async function orgModelCapabilities(
  db: Db,
  orgId: string,
): Promise<
  Pick<OrgPlanCapabilities, "restrictedBuiltInModels" | "supportByok">
> {
  return modelPolicyCapabilities(await loadOrgPlanCapabilities(db, orgId));
}

export interface EnsuredOrgModelPolicyFacts {
  readonly orgPlanCapabilities: OrgPlanCapabilities | null;
  readonly policies: readonly OrgModelPolicyRow[];
  /** Stored policies of replaced models, kept to re-route their selections. */
  readonly replacedPolicies: readonly OrgModelPolicyRow[];
  readonly catalog: ModelCatalog;
}

/**
 * A member-scope policy on the model's catalog subscription route carries no
 * credential: each member runs it only with their own valid subscription,
 * verified per run (`isMemberSubscriptionRoute`), so any plan may configure it.
 */
function isMemberSubscriptionPolicyRoute(
  catalog: ModelCatalog,
  model: string,
  providerType: ModelProviderType,
  credentialScope: string,
): boolean {
  return (
    credentialScope === "member" &&
    (providerType === "claude-code-oauth-token" ||
      providerType === "codex-oauth-token") &&
    catalog.routes.some((route) => {
      return (
        route.enabled &&
        route.model === model &&
        route.subscriptionType === providerType
      );
    })
  );
}

function modelRouteAllowedForOrgPlan(
  catalog: ModelCatalog,
  model: string,
  providerType: ModelProviderType,
  capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >,
): boolean {
  return (
    catalogRunModelRouteAccess(
      catalog,
      model,
      providerType,
      capabilities.restrictedBuiltInModels,
    ) === "allowed" &&
    (capabilities.supportByok || isBuiltInModelProviderType(providerType))
  );
}

function sortRowsByCatalog(
  catalog: ModelCatalog,
  rows: OrgModelPolicyRow[],
): OrgModelPolicyRow[] {
  return [...rows].sort((a, b) => {
    return (
      catalogModelRank(catalog, a.model) - catalogModelRank(catalog, b.model)
    );
  });
}

/**
 * Build policy facts from rows already read with a run-scoped catalog. The
 * queue pick uses this: the system default is projected from the catalog, so
 * the pick never seeds per-organization policies.
 */
export function orgModelPolicyFactsFromSnapshot(args: {
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly orgPlanCapabilities: OrgPlanCapabilities | null;
  readonly stored: readonly OrgModelPolicyRow[];
}): EnsuredOrgModelPolicyFacts {
  return {
    orgPlanCapabilities: args.orgPlanCapabilities,
    policies: projectPolicyRows(args.catalog, args.orgId, args.stored),
    replacedPolicies: args.stored.filter((row) => {
      return resolveCatalogModel(args.catalog, row.model).kind === "replaced";
    }),
    catalog: args.catalog,
  };
}

async function listOrgProviderRoutes(
  db: Db,
  orgId: string,
): Promise<ProviderRouteInfo[]> {
  const rows = await db
    .select({
      id: modelProviders.id,
      userId: modelProviders.userId,
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
      ),
    );

  return rows.flatMap((row) => {
    const type = parseProviderType(row.type);
    return type
      ? [
          {
            id: row.id,
            userId: row.userId,
            type,
            selectedModel: row.selectedModel,
          },
        ]
      : [];
  });
}

async function listOrgSurfaceRoutes(
  db: Db,
  orgId: string,
): Promise<SurfaceRouteInfo[]> {
  return await db
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
    .where(eq(modelProviderConnections.orgId, orgId));
}

async function validateOrgProviderRoute(
  db: Db,
  catalog: ModelCatalog,
  orgId: string,
  policy: UpdateOrgModelPolicy,
): Promise<string | null> {
  const surfaceId = policy.modelProviderSurfaceId ?? null;
  if (surfaceId) {
    if (policy.credentialScope !== "org") {
      return "Custom gateway routes require workspace credentials";
    }
    if (policy.modelProviderId) {
      return "Custom gateway routes cannot store a legacy provider ID";
    }
    const [surface] = await db
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
      .where(
        and(
          eq(modelProviderSurfaces.id, surfaceId),
          eq(modelProviderConnections.orgId, orgId),
        ),
      )
      .limit(1);
    if (!surface) {
      return "Selected custom gateway surface is not configured for this workspace";
    }
    if (
      providerTypeForSurface(surface.protocol) !== policy.defaultProviderType
    ) {
      return "Selected custom gateway protocol does not match the route";
    }
    return surfaceSupportsModel(catalog, surface, policy.model)
      ? null
      : `Model "${policy.model}" is not mapped on the selected custom gateway surface`;
  }

  if (
    !catalogHasProviderRoute(catalog, policy.model, policy.defaultProviderType)
  ) {
    return `Model "${policy.model}" is not supported by provider "${policy.defaultProviderType}"`;
  }

  if (policy.credentialScope === "member") {
    if (!isOAuthMemberProviderType(policy.defaultProviderType)) {
      return "Member routes require an OAuth provider";
    }
    if (policy.modelProviderId) {
      return "Member routes cannot store a provider ID";
    }
    return null;
  }

  if (isOAuthMemberProviderType(policy.defaultProviderType)) {
    return "OAuth provider routes must use member credentials";
  }

  if (isBuiltInModelProviderType(policy.defaultProviderType)) {
    if (policy.modelProviderId) {
      return "Built-in routes cannot store a provider ID";
    }
    return null;
  }

  if (!policy.modelProviderId) {
    return "Org provider routes require a provider ID";
  }

  const [provider] = await db
    .select({
      id: modelProviders.id,
      type: modelProviders.type,
      selectedModel: modelProviders.selectedModel,
      userId: modelProviders.userId,
    })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
        eq(modelProviders.id, policy.modelProviderId),
      ),
    )
    .limit(1);

  if (!provider || provider.userId !== ORG_SENTINEL_USER_ID) {
    return "Selected provider is not configured for this workspace";
  }
  if (
    !isCloudModelMappingValid(
      policy.defaultProviderType,
      policy.model,
      provider.selectedModel,
      catalogHasProviderRoute(
        catalog,
        policy.model,
        policy.defaultProviderType,
      ),
      catalog.byModel,
    )
  ) {
    return "Cloud route requires an explicit compatible saved deployment or profile";
  }
  if (provider.type !== policy.defaultProviderType) {
    return "Selected provider type does not match the route";
  }

  return null;
}

/**
 * Plan restrictions gate what a workspace may newly configure, not what it
 * already stores. A workspace can own rows its plan could not add today, and
 * the client always re-sends the full list. Re-validating those untouched rows
 * would freeze the list and block writes the plan does allow, such as adding a
 * BYOK route. Only an added or re-routed policy has to satisfy the plan.
 */
function planRestrictedWrite(params: {
  readonly catalog: ModelCatalog;
  readonly policy: UpdateOrgModelPolicy;
  readonly providerType: ModelProviderType;
  readonly existing: OrgModelPolicyRow | undefined;
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
}): boolean {
  if (
    modelRouteAllowedForOrgPlan(
      params.catalog,
      params.policy.model,
      params.providerType,
      params.capabilities,
    ) ||
    isMemberSubscriptionPolicyRoute(
      params.catalog,
      params.policy.model,
      params.providerType,
      params.policy.credentialScope,
    )
  ) {
    return false;
  }
  return !storedRouteUnchanged(params.policy, params.existing);
}

interface UpdatePolicyValidationContext {
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly existingRows: readonly OrgModelPolicyRow[];
  readonly catalog: ModelCatalog;
}

async function validateUpdatePolicies(
  db: Db,
  orgId: string,
  policies: UpdateOrgModelPolicy[],
  context: UpdatePolicyValidationContext,
): Promise<ServiceResult<UpdateOrgModelPolicy[]>> {
  const { capabilities, existingRows, catalog } = context;
  const existingByModel = policiesByModel(existingRows);
  const seenModels = new Set<string>();

  for (const policy of policies) {
    const resolution = resolveCatalogModel(catalog, policy.model);
    if (resolution.kind === "unknown") {
      return bad(`Unknown model "${policy.model}"`);
    }
    if (resolution.kind === "replaced") {
      return bad(RETIRED_RUN_MODEL_MESSAGE);
    }
    const model = policy.model;
    const existing = existingByModel.get(policy.model);
    const providerType = parseProviderType(policy.defaultProviderType);
    if (!providerType) {
      return bad(`Unknown model provider type "${policy.defaultProviderType}"`);
    }
    if (
      planRestrictedWrite({
        catalog,
        policy,
        providerType,
        existing,
        capabilities,
      })
    ) {
      return planRestricted(
        catalog,
        capabilities.restrictedBuiltInModels ? model : undefined,
      );
    }
    if (!parseCredentialScope(policy.credentialScope)) {
      return bad(`Unknown credential scope "${policy.credentialScope}"`);
    }

    if (seenModels.has(policy.model)) {
      return bad(`Duplicate model "${policy.model}"`);
    }
    seenModels.add(policy.model);

    // Custom gateway surfaces are organization-owned mappings validated
    // below; every other route must exist in the global catalog.
    if (
      !existing &&
      (policy.modelProviderSurfaceId ?? null) === null &&
      !catalogHasProviderRoute(catalog, model, providerType)
    ) {
      return bad(
        `Model "${model}" has no route for provider "${providerType}"`,
      );
    }

    const routeError = await validateOrgProviderRoute(
      db,
      catalog,
      orgId,
      policy,
    );
    if (routeError) {
      return bad(routeError);
    }
  }

  return ok([...policies]);
}

function getRouteStatus(params: {
  readonly catalog: ModelCatalog;
  readonly model: string;
  readonly providerType: ModelProviderType;
  readonly credentialScope: ModelProviderCredentialScope;
  readonly modelProviderId: string | null;
  readonly modelProviderSurfaceId: string | null;
  readonly providersById: Map<string, ProviderRouteInfo>;
  readonly surfacesById: Map<string, SurfaceRouteInfo>;
}): {
  readonly status: OrgModelPolicyRouteStatus;
  readonly reason: string | null;
} {
  const {
    catalog,
    model,
    providerType,
    credentialScope,
    modelProviderId,
    modelProviderSurfaceId,
    providersById,
    surfacesById,
  } = params;

  if (modelProviderSurfaceId) {
    const surface = surfacesById.get(modelProviderSurfaceId);
    if (
      !surface ||
      providerTypeForSurface(surface.protocol) !== providerType ||
      !surfaceSupportsModel(catalog, surface, model)
    ) {
      return {
        status: "missing_provider",
        reason: "The selected custom gateway route is missing or unmapped.",
      };
    }
    return { status: "valid", reason: null };
  }

  if (!catalogHasProviderRoute(catalog, model, providerType)) {
    return {
      status: "invalid",
      reason: "Provider does not support this model.",
    };
  }
  if (credentialScope === "member") {
    if (!isOAuthMemberProviderType(providerType)) {
      return {
        status: "invalid",
        reason: "Member route requires an OAuth provider.",
      };
    }
    return { status: "valid", reason: null };
  }
  if (isBuiltInModelProviderType(providerType)) {
    if (modelProviderId !== null) {
      return {
        status: "invalid",
        reason: "Built-in routes cannot store a provider ID",
      };
    }
    return { status: "valid", reason: null };
  }
  if (!modelProviderId) {
    return {
      status: "missing_provider",
      reason: "The selected workspace provider is missing.",
    };
  }
  const provider = providersById.get(modelProviderId);
  if (!provider || provider.type !== providerType) {
    return {
      status: "missing_provider",
      reason: "The selected workspace provider is missing.",
    };
  }
  if (
    !isCloudModelMappingValid(
      providerType,
      model,
      provider.selectedModel,
      catalogHasProviderRoute(catalog, model, providerType),
      catalog.byModel,
    )
  ) {
    return {
      status: "invalid",
      reason:
        "The saved cloud deployment or profile is not mapped to this model.",
    };
  }
  return { status: "valid", reason: null };
}

function serializePolicy(
  catalog: ModelCatalog,
  policy: OrgModelPolicyRow,
  providersById: Map<string, ProviderRouteInfo>,
  surfacesById: Map<string, SurfaceRouteInfo>,
): OrgModelPolicy {
  const model = parseSupportedModel(catalog, policy.model);
  const providerType = parseProviderType(policy.defaultProviderType);
  const credentialScope = parseCredentialScope(policy.credentialScope);
  if (!model || !providerType || !credentialScope) {
    throw new Error("Stored org model policy contains unsupported values");
  }

  const route = getRouteStatus({
    catalog,
    model,
    providerType,
    credentialScope,
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderSurfaceId: policy.modelProviderSurfaceId ?? null,
    providersById,
    surfacesById,
  });

  return {
    id: policy.id,
    model,
    modelLabel: catalogDisplayName(catalog, model),
    defaultProviderType: providerType,
    credentialScope,
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderSurfaceId: policy.modelProviderSurfaceId ?? null,
    routeStatus: route.status,
    routeStatusReason: route.reason,
    createdAt: policy.createdAt.toISOString(),
    updatedAt: policy.updatedAt.toISOString(),
  };
}

function memberRouteAvailability(params: {
  readonly planDenied: boolean;
  readonly effective: ResolvedModelFirstPolicyRoute | null;
  readonly orgRouteAvailable: boolean;
}): NonNullable<OrgModelPolicy["memberEffective"]>["availability"] {
  if (params.planDenied) {
    return "plan_restricted";
  }
  const effective = params.effective;
  if (
    !effective ||
    effective.personalConnectionState === "unavailable" ||
    (effective.modelProviderCredentialScope === "org" &&
      !params.orgRouteAvailable)
  ) {
    return "unavailable";
  }
  return effective.personalConnectionState === "reconnect_required"
    ? "reconnect_required"
    : "available";
}

function memberSubscriptionPolicy(
  catalog: ModelCatalog,
  entry: MemberSubscriptionModel,
  capabilities: OrgPlanCapabilities | null,
): OrgModelPolicy {
  const restricted = checkOrgPlanRunAdmission({
    catalog,
    capabilities,
    modelProviderType: entry.providerType,
    selectedModel: entry.model,
    // Listed from the member's connected account and catalog subscription
    // route; a reconnect-required account reports that state first.
    personalSubscription: true,
  });
  return {
    id: entry.id,
    model: entry.model,
    modelLabel: entry.displayName,
    defaultProviderType: entry.providerType,
    runtimeProviderType: entry.providerType,
    credentialScope: "member",
    modelProviderId: null,
    modelProviderSurfaceId: null,
    routeStatus: "valid",
    routeStatusReason: null,
    subscriptionOptions: {
      efforts: [...entry.efforts],
      serviceTier: entry.serviceTier === "priority" ? "priority" : null,
    },
    memberEffective: {
      providerType: entry.providerType,
      runtimeProviderType: entry.providerType,
      credentialScope: "member",
      availability: entry.needsReconnect
        ? "reconnect_required"
        : restricted
          ? "plan_restricted"
          : "available",
      accountSelection: "capture_required",
    },
    createdAt: entry.createdAt.toISOString(),
    updatedAt: entry.updatedAt.toISOString(),
  };
}

async function loadAutoMemberPolicies(
  db: Db,
  catalog: ModelCatalog,
  member: MemberModelRouteContext,
  capabilities: OrgPlanCapabilities | null,
  policies: readonly OrgModelPolicy[],
): Promise<OrgModelPolicy[]> {
  const personalModels = await loadMemberSubscriptionModels(db, member);
  return personalModels
    .filter((entry) => {
      return !policies.some((policy) => {
        return policy.model === entry.model;
      });
    })
    .map((entry) => {
      return memberSubscriptionPolicy(catalog, entry, capabilities);
    });
}

async function loadOrgModelMode(db: Db, orgId: string) {
  const [org] = await db
    .select({ modelMode: orgMetadata.modelMode })
    .from(orgMetadata)
    .where(eq(orgMetadata.orgId, orgId))
    .limit(1);
  return org?.modelMode === "auto" ? "auto" : "custom";
}

export interface OrgModelPolicyListing {
  readonly response: OrgModelPoliciesResponse;
  /** The catalog system default the listing was projected from. */
  readonly systemDefaultModel: string;
}

function modelPolicyListingResponse(args: {
  readonly modelMode: OrgModelPoliciesResponse["modelMode"];
  readonly policies: readonly OrgModelPolicy[];
  readonly memberPolicies: readonly OrgModelPolicy[];
  readonly persistedRows: readonly OrgModelPolicyRow[];
  readonly catalog: ModelCatalog;
  readonly rows: ReturnType<typeof projectPolicyRows>;
}): OrgModelPoliciesResponse {
  const { modelMode, policies, memberPolicies, persistedRows, catalog, rows } =
    args;
  return {
    modelMode,
    policies: [...policies, ...memberPolicies],
    revision: policyRevision(persistedRows),
    // Permanent since the personal subscription priority rollout completed.
    // Removing the field needs its own client-compatibility window.
    writePreconditionRequired: true,
    modelsAvailableToAdd:
      modelMode === "auto" ? [] : modelsAvailableToAdd(catalog, rows),
  };
}
function memberPolicyProjection(args: {
  readonly policy: OrgModelPolicy;
  readonly administrative: OrgModelPolicy;
  readonly effective: ResolvedModelFirstPolicyRoute | null;
  readonly catalog: ModelCatalog;
  readonly capabilities: OrgPlanCapabilities | null;
  readonly member: MemberModelRouteContext;
  readonly runtimeRoute: Awaited<
    ReturnType<typeof resolveBuiltInModelRuntimeRouteWithKeys>
  >;
}): OrgModelPolicy {
  const {
    policy,
    administrative,
    effective,
    catalog,
    capabilities,
    member,
    runtimeRoute,
  } = args;
  const providerType =
    effective?.modelProviderType ?? policy.defaultProviderType;
  const credentialScope =
    effective?.modelProviderCredentialScope ?? policy.credentialScope;
  const planDenied = checkOrgPlanRunAdmission({
    catalog,
    capabilities,
    modelProviderType: providerType,
    selectedModel: policy.model,
    personalSubscription: isMemberSubscriptionRoute({
      catalog,
      member,
      model: policy.model,
      providerType,
      credentialScope,
    }),
  });
  const availability = memberRouteAvailability({
    planDenied: !!planDenied,
    effective,
    orgRouteAvailable:
      policy.routeStatus === "valid" &&
      (!isBuiltInModelProviderType(providerType) || runtimeRoute !== null),
  });
  return {
    ...administrative,
    memberEffective: {
      providerType,
      runtimeProviderType: isBuiltInModelProviderType(providerType)
        ? (runtimeRoute?.providerType ?? null)
        : providerType,
      credentialScope,
      availability,
      accountSelection:
        credentialScope === "member" ? "capture_required" : "not_applicable",
    },
  } satisfies OrgModelPolicy;
}
async function listOrgModelPolicies(
  catalogSnapshot: ModelCatalog,
  db: Db,
  orgId: string,
  userId: string,
  keyIdsByVendor: BuiltInModelKeyIdsByVendor,
): Promise<OrgModelPolicyListing> {
  const [persistedRows, catalog] = await Promise.all([
    loadRows(db, orgId),
    catalogSnapshot,
  ]);
  const rows = projectPolicyRows(catalog, orgId, persistedRows);
  const member = await loadMemberModelRouteContext(db, orgId, userId);
  const capabilities = await loadOrgPlanCapabilities(db, orgId);
  const providers = await listOrgProviderRoutes(db, orgId);
  const surfaces = await listOrgSurfaceRoutes(db, orgId);
  const providersById = new Map(
    providers.map((provider) => {
      return [provider.id, provider];
    }),
  );
  const surfacesById = new Map(
    surfaces.map((surface) => {
      return [surface.id, surface];
    }),
  );
  const policies = await Promise.all(
    rows.map(async (row) => {
      const policy = serializePolicy(catalog, row, providersById, surfacesById);
      const runtimeRoute = isBuiltInModelProviderType(
        policy.defaultProviderType,
      )
        ? await resolveBuiltInModelRuntimeRouteWithKeys(
            db,
            catalog,
            policy.model,
            keyIdsByVendor,
          )
        : null;
      const administrative: OrgModelPolicy = isBuiltInModelProviderType(
        policy.defaultProviderType,
      )
        ? { ...policy, runtimeProviderType: runtimeRoute?.providerType ?? null }
        : policy;
      const effective = await resolveEffectivePolicyRoute({
        catalog,
        db,
        orgId,
        policy: row,
        member,
        capabilities:
          capabilities?.status === "active"
            ? capabilities
            : { restrictedBuiltInModels: false, supportByok: true },
      });
      return memberPolicyProjection({
        policy,
        administrative,
        effective,
        catalog,
        capabilities,
        member,
        runtimeRoute,
      });
    }),
  );
  const modelMode = await loadOrgModelMode(db, orgId);
  const memberPolicies =
    modelMode === "auto"
      ? await loadAutoMemberPolicies(
          db,
          catalog,
          member,
          capabilities,
          policies,
        )
      : [];

  const response = modelPolicyListingResponse({
    modelMode,
    policies,
    memberPolicies,
    persistedRows,
    catalog,
    rows,
  });
  return { response, systemDefaultModel: catalog.systemDefaultModel };
}

async function persistOrgModelPolicyUpdates(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly policies: UpdateOrgModelPolicy[];
  readonly systemDefaultModel: string;
  readonly activeModels: readonly string[];
  readonly now: Date;
}): Promise<void> {
  const tx = params.db;
  // The system default is projected, never persisted per organization.
  const policies = params.policies.filter((policy) => {
    return policy.model !== params.systemDefaultModel;
  });
  if (policies.length > 0) {
    await tx
      .insert(orgModelPolicies)
      .values(
        policies.map((policy) => {
          return {
            orgId: params.orgId,
            model: policy.model,
            defaultProviderType: policy.defaultProviderType,
            credentialScope: policy.credentialScope,
            modelProviderId: policy.modelProviderId,
            modelProviderSurfaceId: policy.modelProviderSurfaceId ?? null,
            createdByUserId: params.userId,
            updatedByUserId: params.userId,
            createdAt: params.now,
            updatedAt: params.now,
          };
        }),
      )
      .onConflictDoNothing({
        target: [orgModelPolicies.orgId, orgModelPolicies.model],
      });
  }

  // Stored rows of replaced models belong to the stored-configuration
  // migration, so a full-list write removes only active-model rows.
  const removedRows = await tx
    .delete(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, params.orgId),
        inArray(orgModelPolicies.model, [...params.activeModels]),
        policies.length > 0
          ? notInArray(
              orgModelPolicies.model,
              policies.map((policy) => {
                return policy.model;
              }),
            )
          : undefined,
      ),
    )
    .returning({ model: orgModelPolicies.model });

  const removedModels = removedRows.map((row) => {
    return row.model;
  });
  if (removedModels.length > 0) {
    await tx
      .update(orgMembersMetadata)
      .set({
        selectedModel: params.systemDefaultModel,
        serviceTier: null,
        updatedAt: params.now,
      })
      .where(
        and(
          eq(orgMembersMetadata.orgId, params.orgId),
          inArray(orgMembersMetadata.selectedModel, removedModels),
        ),
      );
  }

  for (const policy of policies) {
    await tx
      .update(orgModelPolicies)
      .set({
        defaultProviderType: policy.defaultProviderType,
        credentialScope: policy.credentialScope,
        modelProviderId: policy.modelProviderId,
        modelProviderSurfaceId: policy.modelProviderSurfaceId ?? null,
        updatedAt: params.now,
        updatedByUserId: params.userId,
      })
      .where(
        and(
          eq(orgModelPolicies.orgId, params.orgId),
          eq(orgModelPolicies.model, policy.model),
        ),
      );
  }
}

function isUntouchedStandardSeed(
  catalog: ModelCatalog,
  rows: readonly OrgModelPolicyRow[],
): boolean {
  if (
    !rows.every((row) => {
      return (
        row.defaultProviderType === "built-in" &&
        row.credentialScope === "org" &&
        row.modelProviderId === null &&
        row.modelProviderSurfaceId === null
      );
    })
  ) {
    return false;
  }
  const models = new Set(
    rows
      .map((row) => {
        return row.model;
      })
      .filter((model) => {
        return model !== catalog.systemDefaultModel && model !== "okou-1.0";
      }),
  );
  return (
    models.size === 0 ||
    PREVIOUS_STANDARD_SEED_MODELS.some((seed) => {
      return (
        seed.length === models.size &&
        seed.every((model) => {
          return models.has(model);
        })
      );
    })
  );
}

export const listOrgModelPolicies$ = command(
  async (
    { get, set },
    params: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<OrgModelPoliciesResponse> => {
    const db = set(writeDb$);
    const { response } = await listOrgModelPolicies(
      await get(modelCatalog$),
      db,
      params.orgId,
      params.userId,
      await get(builtInModelKeyIdsByVendor$),
    );
    signal.throwIfAborted();
    return response;
  },
);

/**
 * The policy list together with the catalog system default it projects, for
 * integration model pickers that mark the default option.
 */
export const listOrgModelPoliciesWithSystemDefault$ = command(
  async (
    { get, set },
    params: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<OrgModelPolicyListing> => {
    const listing = await listOrgModelPolicies(
      await get(modelCatalog$),
      set(writeDb$),
      params.orgId,
      params.userId,
      await get(builtInModelKeyIdsByVendor$),
    );
    signal.throwIfAborted();
    return listing;
  },
);

export const updateOrgModelPolicies$ = command(
  async (
    { get, set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly policies: UpdateOrgModelPolicy[];
      readonly revision?: string;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<OrgModelPoliciesResponse>> => {
    const db = set(writeDb$);
    const refreshConflict = () => {
      return {
        ok: false as const,
        response: conflict(
          "Model settings changed or this client is out of date. Refresh model settings and try again, or upgrade your client.",
        ),
      };
    };
    // Reject unidentified old writers before even the lazy seed/default path.
    if (!params.revision) {
      return refreshConflict();
    }
    const catalog = await get(modelCatalog$);
    signal.throwIfAborted();
    const written = await db.transaction(async (tx) => {
      const [org] = await tx
        .select({ mode: orgMetadata.modelMode })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, params.orgId))
        .limit(1);
      if (org?.mode === "auto") {
        return bad<OrgModelPoliciesResponse>(
          "Model policies are managed automatically in Auto mode",
        );
      }
      signal.throwIfAborted();
      const existing = await loadRows(tx, params.orgId);
      if (
        params.revision !== undefined &&
        params.revision !== policyRevision(existing)
      ) {
        return refreshConflict();
      }
      // The system default is projected; a client that still sends it is
      // accepted and the row is ignored.
      const policies = resolveOmittedModelProviderSurfaceIds(
        params.policies.filter((policy) => {
          return policy.model !== catalog.systemDefaultModel;
        }),
        existing,
      );
      const capabilities = await orgModelCapabilities(tx, params.orgId);
      const validation = await validateUpdatePolicies(
        tx,
        params.orgId,
        policies,
        {
          capabilities,
          existingRows: projectPolicyRows(catalog, params.orgId, existing),
          catalog,
        },
      );
      signal.throwIfAborted();
      if (!validation.ok) {
        return validation;
      }
      await persistOrgModelPolicyUpdates({
        db: tx,
        orgId: params.orgId,
        userId: params.userId,
        policies: validation.data,
        systemDefaultModel: catalog.systemDefaultModel,
        activeModels: catalogActiveModels(catalog),
        now: nowDate(),
      });
      signal.throwIfAborted();
      return ok(undefined);
    });
    signal.throwIfAborted();
    if (!written.ok) {
      return written;
    }

    const { response } = await listOrgModelPolicies(
      await get(modelCatalog$),
      db,
      params.orgId,
      params.userId,
      await get(builtInModelKeyIdsByVendor$),
    );
    signal.throwIfAborted();
    return ok(response);
  },
);

export function onboardingModelPolicyWritePlan(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly provider: OnboardingSubscriptionProvider;
  readonly existing: readonly OrgModelPolicyRow[];
  readonly catalog: ModelCatalog;
  readonly now: Date;
}) {
  if (!isUntouchedStandardSeed(params.catalog, params.existing)) {
    return null;
  }
  const seed = ONBOARDING_MODEL_POLICY_SEEDS[params.provider];
  const policies: UpdateOrgModelPolicy[] = seed.models
    .filter((model) => {
      return isCatalogModelAddable(params.catalog, model);
    })
    .map((model) => {
      return {
        model,
        defaultProviderType: seed.providerType,
        credentialScope: "member",
        modelProviderId: null,
        modelProviderSurfaceId: null,
      };
    });
  return {
    insertValues: replacementPolicyValues({ ...params, policies }, params.now),
    removalCondition: and(
      eq(orgModelPolicies.orgId, params.orgId),
      inArray(orgModelPolicies.model, catalogActiveModels(params.catalog)),
      notInArray(
        orgModelPolicies.model,
        policies.map((policy) => {
          return policy.model;
        }),
      ),
    ),
    defaultModel: params.catalog.systemDefaultModel,
    updates: policies.map((policy) => {
      return {
        values: policyUpdateValues(policy, params.userId, params.now),
        condition: and(
          eq(orgModelPolicies.orgId, params.orgId),
          eq(orgModelPolicies.model, policy.model),
        ),
      };
    }),
  };
}

function replacementPolicyValues(
  params: {
    readonly orgId: string;
    readonly userId: string;
    readonly policies: UpdateOrgModelPolicy[];
  },
  now: Date,
) {
  return params.policies.map((policy) => {
    return {
      orgId: params.orgId,
      model: policy.model,
      isDefault: false,
      defaultProviderType: policy.defaultProviderType,
      credentialScope: policy.credentialScope,
      modelProviderId: policy.modelProviderId,
      modelProviderSurfaceId: policy.modelProviderSurfaceId ?? null,
      createdByUserId: params.userId,
      updatedByUserId: params.userId,
      createdAt: now,
      updatedAt: now,
    };
  });
}

function policyUpdateValues(
  policy: UpdateOrgModelPolicy,
  userId: string,
  now: Date,
) {
  return {
    isDefault: false,
    defaultProviderType: policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
    modelProviderSurfaceId: policy.modelProviderSurfaceId ?? null,
    updatedAt: now,
    updatedByUserId: userId,
  };
}
