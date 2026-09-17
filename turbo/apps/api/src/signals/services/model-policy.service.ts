import { createHash } from "node:crypto";
import { FeatureSwitchKey, isFeatureEnabled } from "@okouai/core";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import { resolveBuiltInModelRuntimeRoute } from "./built-in-model-runtime-route.service";
import {
  loadMemberModelRouteContext,
  resolveEffectivePolicyRoute,
  type ResolvedModelFirstPolicyRoute,
} from "./effective-model-route.service";
import { checkOrgPlanRunAdmission } from "./run-admission.service";
import { isCloudModelMappingValid } from "@okouai/api-contracts/contracts/cloud-model-mapping";
import { command } from "ccstate";
import { and, asc, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL,
  LIMITED_FREE1_DEFAULT_RUN_MODEL,
  MODEL_PROVIDER_TYPES,
  ACTIVE_RUN_MODELS,
  getCanonicalModelDisplayName,
  getDefaultOrgModelPolicySeed,
  getFrameworkForType,
  getBuiltInConcreteProviderType,
  isBuiltInModelProviderType,
  isModelSupportedByProvider,
  isLimitedFree1RestrictedRunModel,
  getRunModelAccess,
  RETIRED_RUN_MODEL_MESSAGE,
  type ModelProviderCredentialScope,
  type OrgModelPoliciesResponse,
  type OrgModelPolicy,
  type OrgModelPolicyRouteStatus,
  type SupportedRunModel,
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
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { conflict, insufficientCredits } from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";

type OrgModelPolicyRow = Omit<
  typeof orgModelPolicies.$inferSelect,
  "modelProviderSurfaceId"
> & {
  readonly modelProviderSurfaceId: string | null;
};

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
        | ReturnType<typeof conflict>;
    };

const ORG_SENTINEL_USER_ID = "__org__";

function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

function bad<T>(message: string): ServiceResult<T> {
  return { ok: false, message };
}

function planRestricted<T>(): ServiceResult<T> {
  return { ok: false, response: insufficientCredits() };
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
  surface: SurfaceRouteInfo,
  model: SupportedRunModel,
): boolean {
  const providerType = providerTypeForSurface(surface.protocol);
  return (
    providerType !== null &&
    getFrameworkForType(providerType) ===
      getFrameworkForType(getBuiltInConcreteProviderType(model)) &&
    typeof surface.modelMappings[model] === "string"
  );
}

function parseProviderType(value: string): ModelProviderType | null {
  return value in MODEL_PROVIDER_TYPES ? (value as ModelProviderType) : null;
}

function parseSupportedModel(value: string): SupportedRunModel | null {
  return ACTIVE_RUN_MODELS.includes(value as SupportedRunModel)
    ? (value as SupportedRunModel)
    : null;
}

function parseCredentialScope(
  value: string,
): ModelProviderCredentialScope | null {
  return value === "org" || value === "member" ? value : null;
}

function loadRows(
  db: Db,
  orgId: string,
  allModels = false,
): Promise<OrgModelPolicyRow[]> {
  return db
    .select({
      id: orgModelPolicies.id,
      orgId: orgModelPolicies.orgId,
      model: orgModelPolicies.model,
      isDefault: orgModelPolicies.isDefault,
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
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        allModels
          ? undefined
          : inArray(orgModelPolicies.model, [...ACTIVE_RUN_MODELS]),
      ),
    );
}

// Seeds/repaired defaults and replacement writes share one organization-local
// fence. Normal selection reads take no lock when no repair is needed.
async function lockPolicyWrites(db: Db, orgId: string): Promise<void> {
  await db.execute(
    sql`SELECT pg_advisory_xact_lock(hashtextextended(${`model-policy:${orgId}`}, 0))`,
  );
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

async function lockPolicyParents(db: Db, orgId: string): Promise<void> {
  // Parent rows precede child policy rows. This also fences FK SET NULL from
  // provider/surface deletion without acquiring A's credential lifecycle lock.
  await db
    .select({ id: modelProviders.id })
    .from(modelProviders)
    .where(
      and(
        eq(modelProviders.orgId, orgId),
        eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
      ),
    )
    .orderBy(asc(modelProviders.id))
    .for("share");
  await db
    .select({ id: modelProviderConnections.id })
    .from(modelProviderConnections)
    .where(eq(modelProviderConnections.orgId, orgId))
    .orderBy(asc(modelProviderConnections.id))
    .for("share");
  await db
    .select({ id: modelProviderSurfaces.id })
    .from(modelProviderSurfaces)
    .innerJoin(
      modelProviderConnections,
      eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
    )
    .where(eq(modelProviderConnections.orgId, orgId))
    .orderBy(asc(modelProviderSurfaces.id))
    .for("share", { of: modelProviderSurfaces });
  await db
    .select({ id: orgModelPolicies.id })
    .from(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, orgId))
    .orderBy(asc(orgModelPolicies.id))
    .for("no key update");
}

function resolveOmittedModelProviderSurfaceIds(
  policies: readonly UpdateOrgModelPolicy[],
  existingRows: readonly OrgModelPolicyRow[],
): UpdateOrgModelPolicy[] {
  const existingByModel = new Map(
    existingRows.map((row) => {
      return [row.model, row];
    }),
  );
  return policies.map((policy) => {
    if (policy.modelProviderSurfaceId !== undefined) {
      return policy;
    }
    const existing = existingByModel.get(policy.model);
    const routeIdentityUnchanged =
      existing !== undefined &&
      existing.defaultProviderType === policy.defaultProviderType &&
      existing.credentialScope === policy.credentialScope &&
      (existing.modelProviderId ?? null) === policy.modelProviderId;
    return {
      ...policy,
      modelProviderSurfaceId: routeIdentityUnchanged
        ? existing.modelProviderSurfaceId
        : null,
    };
  });
}

async function orgModelCapabilities(
  db: Db,
  orgId: string,
): Promise<
  Pick<OrgPlanCapabilities, "restrictedBuiltInModels" | "supportByok">
> {
  const capabilities = await loadOrgPlanCapabilities(db, orgId);
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

function modelAllowedForOrgPlan(
  model: string,
  capabilities: Pick<OrgPlanCapabilities, "restrictedBuiltInModels">,
): boolean {
  return (
    getRunModelAccess(model, capabilities.restrictedBuiltInModels) === "allowed"
  );
}

function modelProviderAllowedForOrgPlan(
  providerType: ModelProviderType,
  capabilities: Pick<OrgPlanCapabilities, "supportByok">,
): boolean {
  return capabilities.supportByok || isBuiltInModelProviderType(providerType);
}

function getSupportedModelRank(model: string): number {
  const catalogIndex = ACTIVE_RUN_MODELS.indexOf(model as SupportedRunModel);
  return catalogIndex === -1 ? ACTIVE_RUN_MODELS.length : catalogIndex;
}

function sortRowsByCatalog(rows: OrgModelPolicyRow[]): OrgModelPolicyRow[] {
  return [...rows].sort((a, b) => {
    return getSupportedModelRank(a.model) - getSupportedModelRank(b.model);
  });
}

function getSeedDefaultModelForPlan(
  capabilities: Pick<OrgPlanCapabilities, "restrictedBuiltInModels">,
): SupportedRunModel {
  return capabilities.restrictedBuiltInModels
    ? LIMITED_FREE1_DEFAULT_RUN_MODEL
    : DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL;
}

function shouldReplaceExistingDefaultForPlan(
  existingDefault: OrgModelPolicyRow | undefined,
  capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >,
): boolean {
  if (capabilities.supportByok && !capabilities.restrictedBuiltInModels) {
    return existingDefault === undefined;
  }
  if (existingDefault === undefined) {
    return true;
  }
  const shouldReplaceModel =
    capabilities.restrictedBuiltInModels &&
    existingDefault.model !== LIMITED_FREE1_DEFAULT_RUN_MODEL &&
    (existingDefault.model === DEFAULT_ORG_MODEL_POLICY_DEFAULT_MODEL ||
      isLimitedFree1RestrictedRunModel(existingDefault.model));
  return (
    shouldReplaceModel ||
    (!capabilities.supportByok &&
      (!isBuiltInModelProviderType(existingDefault.defaultProviderType) ||
        existingDefault.credentialScope !== "org" ||
        existingDefault.modelProviderId !== null ||
        existingDefault.modelProviderSurfaceId !== null))
  );
}

async function ensureModelPolicy(
  db: Db,
  orgId: string,
  userId: string,
  model: SupportedRunModel,
): Promise<void> {
  const now = nowDate();
  await db
    .insert(orgModelPolicies)
    .values({
      model,
      isDefault: false,
      defaultProviderType: "built-in",
      credentialScope: "org",
      modelProviderId: null,
      orgId,
      createdByUserId: userId,
      updatedByUserId: userId,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
    });
}

async function setDefaultModelPolicy(
  db: Db,
  orgId: string,
  userId: string,
  model: SupportedRunModel,
  options: {
    readonly resetRouteToBuiltIn?: boolean;
  },
): Promise<void> {
  await ensureModelPolicy(db, orgId, userId, model);
  const now = nowDate();
  await db
    .update(orgModelPolicies)
    .set({
      isDefault: false,
      updatedByUserId: userId,
      updatedAt: now,
    })
    .where(
      and(
        eq(orgModelPolicies.orgId, orgId),
        eq(orgModelPolicies.isDefault, true),
      ),
    );
  await db
    .update(orgModelPolicies)
    .set({
      isDefault: true,
      ...(options?.resetRouteToBuiltIn === true
        ? {
            defaultProviderType: "built-in",
            credentialScope: "org",
            modelProviderId: null,
            modelProviderSurfaceId: null,
          }
        : {}),
      updatedByUserId: userId,
      updatedAt: now,
    })
    .where(
      and(eq(orgModelPolicies.orgId, orgId), eq(orgModelPolicies.model, model)),
    );
}

async function ensureOrgModelPoliciesLocked(
  db: Db,
  orgId: string,
  userId: string,
): Promise<OrgModelPolicyRow[]> {
  const capabilities = await orgModelCapabilities(db, orgId);
  const seedDefaultModel = getSeedDefaultModelForPlan(capabilities);
  const existing = await loadRows(db, orgId);
  if (existing.length > 0) {
    const existingDefault = existing.find((policy) => {
      return policy.isDefault;
    });
    if (!shouldReplaceExistingDefaultForPlan(existingDefault, capabilities)) {
      return sortRowsByCatalog(existing);
    }

    if (!capabilities.supportByok || capabilities.restrictedBuiltInModels) {
      await setDefaultModelPolicy(db, orgId, userId, seedDefaultModel, {
        resetRouteToBuiltIn: !capabilities.supportByok,
      });
      return sortRowsByCatalog(await loadRows(db, orgId));
    }

    const fallbackDefault =
      existing.find((policy) => {
        return policy.model === seedDefaultModel;
      }) ?? sortRowsByCatalog(existing)[0];
    if (fallbackDefault) {
      await setDefaultModelPolicy(
        db,
        orgId,
        userId,
        parseSupportedModel(fallbackDefault.model) ?? seedDefaultModel,
        {},
      );
      return sortRowsByCatalog(await loadRows(db, orgId));
    }
    return sortRowsByCatalog(existing);
  }

  // A retired default can be the only persisted policy while the new API is
  // deployed ahead of the Stage 2 migration. Transfer the org-wide default
  // slot before inserting the rest of the active seed so the hidden row does
  // not collide with the partial unique default index.
  await setDefaultModelPolicy(db, orgId, userId, seedDefaultModel, {
    resetRouteToBuiltIn: true,
  });
  const initialized = await loadRows(db, orgId);
  const existingModels = new Set(
    initialized.map((policy) => {
      return policy.model;
    }),
  );
  const missing = getDefaultOrgModelPolicySeed(seedDefaultModel)
    .filter((seed) => {
      return !existingModels.has(seed.model);
    })
    .map((seed) => {
      return {
        ...seed,
        orgId,
        createdByUserId: userId,
        updatedByUserId: userId,
      };
    });

  if (missing.length === 0) {
    return sortRowsByCatalog(initialized);
  }

  await db
    .insert(orgModelPolicies)
    .values(missing)
    .onConflictDoNothing({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
    });

  return sortRowsByCatalog(await loadRows(db, orgId));
}

export async function ensureOrgModelPolicies(
  db: Db,
  orgId: string,
  userId: string,
): Promise<OrgModelPolicyRow[]> {
  const capabilities = await orgModelCapabilities(db, orgId);
  const existing = await loadRows(db, orgId);
  if (
    existing.length > 0 &&
    !shouldReplaceExistingDefaultForPlan(
      existing.find((policy) => {
        return policy.isDefault;
      }),
      capabilities,
    )
  ) {
    return sortRowsByCatalog(existing);
  }
  return db.transaction(async (tx) => {
    await lockPolicyWrites(tx, orgId);
    return ensureOrgModelPoliciesLocked(tx, orgId, userId);
  });
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
    return surfaceSupportsModel(surface, policy.model)
      ? null
      : `Model "${policy.model}" is not mapped on the selected custom gateway surface`;
  }

  if (!isModelSupportedByProvider(policy.model, policy.defaultProviderType)) {
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
    )
  ) {
    return "Cloud route requires an explicit compatible saved deployment or profile";
  }
  if (provider.type !== policy.defaultProviderType) {
    return "Selected provider type does not match the route";
  }

  return null;
}

async function validateUpdatePolicies(
  db: Db,
  orgId: string,
  policies: UpdateOrgModelPolicy[],
  capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >,
): Promise<ServiceResult<UpdateOrgModelPolicy[]>> {
  if (policies.length === 0) {
    return bad("Request must include at least one model");
  }

  const seenModels = new Set<string>();
  let defaultCount = 0;

  for (const policy of policies) {
    if (getRunModelAccess(policy.model) === "retired") {
      return bad(RETIRED_RUN_MODEL_MESSAGE);
    }
    if (!parseSupportedModel(policy.model)) {
      return bad(`Unknown model "${policy.model}"`);
    }
    if (!modelAllowedForOrgPlan(policy.model, capabilities)) {
      return planRestricted();
    }
    const providerType = parseProviderType(policy.defaultProviderType);
    if (!providerType) {
      return bad(`Unknown model provider type "${policy.defaultProviderType}"`);
    }
    if (!modelProviderAllowedForOrgPlan(providerType, capabilities)) {
      return planRestricted();
    }
    if (!parseCredentialScope(policy.credentialScope)) {
      return bad(`Unknown credential scope "${policy.credentialScope}"`);
    }

    if (seenModels.has(policy.model)) {
      return bad(`Duplicate model "${policy.model}"`);
    }
    seenModels.add(policy.model);

    if (policy.isDefault) {
      defaultCount += 1;
    }

    const routeError = await validateOrgProviderRoute(db, orgId, policy);
    if (routeError) {
      return bad(routeError);
    }
  }

  if (defaultCount !== 1) {
    return bad("Request must include exactly one default model");
  }

  return ok([...policies]);
}

function getRouteStatus(params: {
  readonly model: SupportedRunModel;
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
      !surfaceSupportsModel(surface, model)
    ) {
      return {
        status: "missing_provider",
        reason: "The selected custom gateway route is missing or unmapped.",
      };
    }
    return { status: "valid", reason: null };
  }

  if (!isModelSupportedByProvider(model, providerType)) {
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
  if (!isCloudModelMappingValid(providerType, model, provider.selectedModel)) {
    return {
      status: "invalid",
      reason:
        "The saved cloud deployment or profile is not mapped to this model.",
    };
  }
  return { status: "valid", reason: null };
}

function serializePolicy(
  policy: OrgModelPolicyRow,
  providersById: Map<string, ProviderRouteInfo>,
  surfacesById: Map<string, SurfaceRouteInfo>,
): OrgModelPolicy {
  const model = parseSupportedModel(policy.model);
  const providerType = parseProviderType(policy.defaultProviderType);
  const credentialScope = parseCredentialScope(policy.credentialScope);
  if (!model || !providerType || !credentialScope) {
    throw new Error("Stored org model policy contains unsupported values");
  }

  const route = getRouteStatus({
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
    modelLabel: getCanonicalModelDisplayName(model),
    isDefault: policy.isDefault,
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

function selectWorkspaceDefaultPolicy(
  policies: OrgModelPolicy[],
): OrgModelPolicy | null {
  return (
    policies.find((policy) => {
      return policy.isDefault;
    }) ?? null
  );
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

async function listOrgModelPolicies(
  db: Db,
  orgId: string,
  userId: string,
): Promise<OrgModelPoliciesResponse> {
  await ensureOrgModelPolicies(db, orgId, userId);
  const persistedRows = await loadRows(db, orgId, true);
  const rows = sortRowsByCatalog(
    persistedRows.filter((row) => {
      return parseSupportedModel(row.model);
    }),
  );
  const member = await loadMemberModelRouteContext(db, orgId, userId);
  const capabilities = member.priorityEnabled
    ? await loadOrgPlanCapabilities(db, orgId)
    : null;
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
      const policy = serializePolicy(row, providersById, surfacesById);
      const runtimeRoute = isBuiltInModelProviderType(
        policy.defaultProviderType,
      )
        ? await resolveBuiltInModelRuntimeRoute(db, policy.model)
        : null;
      const administrative: OrgModelPolicy = isBuiltInModelProviderType(
        policy.defaultProviderType,
      )
        ? { ...policy, runtimeProviderType: runtimeRoute?.providerType ?? null }
        : policy;
      if (!member.priorityEnabled) {
        return administrative;
      }
      const effective = await resolveEffectivePolicyRoute({
        db,
        orgId,
        policy: row,
        member,
        capabilities:
          capabilities?.status === "active"
            ? capabilities
            : { restrictedBuiltInModels: false, supportByok: true },
      });
      const providerType =
        effective?.modelProviderType ?? policy.defaultProviderType;
      const credentialScope =
        effective?.modelProviderCredentialScope ?? policy.credentialScope;
      const planDenied = checkOrgPlanRunAdmission({
        capabilities,
        modelProviderType: providerType,
        selectedModel: policy.model,
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
            credentialScope === "member"
              ? "capture_required"
              : "not_applicable",
        },
      } satisfies OrgModelPolicy;
    }),
  );
  const workspaceDefault = selectWorkspaceDefaultPolicy(policies);

  return {
    policies,
    revision: policyRevision(persistedRows),
    writePreconditionRequired: member.priorityEnabled,
    workspaceDefaultModel: workspaceDefault?.model ?? null,
    workspaceDefaultPolicyId: workspaceDefault?.id ?? null,
  };
}

async function persistOrgModelPolicyUpdates(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly userId: string;
  readonly policies: UpdateOrgModelPolicy[];
  readonly now: Date;
}): Promise<void> {
  const tx = params.db;
  await tx
    .insert(orgModelPolicies)
    .values(
      params.policies.map((policy) => {
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
          createdAt: params.now,
          updatedAt: params.now,
        };
      }),
    )
    .onConflictDoNothing({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
    });

  const removedRows = await tx
    .delete(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, params.orgId),
        inArray(orgModelPolicies.model, [...ACTIVE_RUN_MODELS]),
        notInArray(
          orgModelPolicies.model,
          params.policies.map((policy) => {
            return policy.model;
          }),
        ),
      ),
    )
    .returning({ model: orgModelPolicies.model });

  const removedModels = removedRows.map((row) => {
    return row.model;
  });
  const defaultPolicy = params.policies.find((policy) => {
    return policy.isDefault;
  });
  if (removedModels.length > 0 && defaultPolicy) {
    await tx
      .update(orgMembersMetadata)
      .set({
        selectedModel: defaultPolicy.model,
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

  await tx
    .update(orgModelPolicies)
    .set({ isDefault: false })
    .where(eq(orgModelPolicies.orgId, params.orgId));

  for (const policy of params.policies) {
    await tx
      .update(orgModelPolicies)
      .set({
        isDefault: policy.isDefault,
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

export const listOrgModelPolicies$ = command(
  async (
    { set },
    params: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<OrgModelPoliciesResponse> => {
    const db = set(writeDb$);
    const response = await listOrgModelPolicies(
      db,
      params.orgId,
      params.userId,
    );
    signal.throwIfAborted();
    return response;
  },
);

export const updateOrgModelPolicies$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly policies: UpdateOrgModelPolicy[];
      readonly revision?: string;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<OrgModelPoliciesResponse>> => {
    const db = set(writeDb$);
    const context = await loadUserFeatureSwitchContext(
      db,
      params.orgId,
      params.userId,
    );
    signal.throwIfAborted();
    const priorityEnabled = isFeatureEnabled(
      FeatureSwitchKey.PersonalSubscriptionPriority,
      context,
    );
    const refreshConflict = () => {
      return {
        ok: false as const,
        response: conflict(
          "Model settings changed or this client is out of date. Refresh model settings and try again, or upgrade your client.",
        ),
      };
    };
    // Reject unidentified old writers before even the lazy seed/default path.
    if (priorityEnabled && !params.revision) {
      return refreshConflict();
    }
    const written = await db.transaction(async (tx) => {
      await lockPolicyWrites(tx, params.orgId);
      await lockPolicyParents(tx, params.orgId);
      signal.throwIfAborted();
      const existing = await loadRows(tx, params.orgId, true);
      if (
        params.revision !== undefined &&
        params.revision !== policyRevision(existing)
      ) {
        return refreshConflict();
      }
      const policies = resolveOmittedModelProviderSurfaceIds(
        params.policies,
        existing,
      );
      const capabilities = await orgModelCapabilities(tx, params.orgId);
      const validation = await validateUpdatePolicies(
        tx,
        params.orgId,
        policies,
        capabilities,
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
        now: nowDate(),
      });
      signal.throwIfAborted();
      return ok(undefined);
    });
    signal.throwIfAborted();
    if (!written.ok) {
      return written;
    }

    const response = await listOrgModelPolicies(
      db,
      params.orgId,
      params.userId,
    );
    signal.throwIfAborted();
    return ok(response);
  },
);
