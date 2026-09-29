import { createHash } from "node:crypto";
import { FeatureSwitchKey, isFeatureEnabled } from "@okouai/core";
import type { OnboardingSubscriptionProvider } from "@okouai/api-contracts/contracts/onboarding";
import { loadUserFeatureSwitchContext } from "./feature-switches.service";
import {
  builtInModelKeyIdsByVendor$,
  resolveBuiltInModelRuntimeRouteWithKeys,
  type BuiltInModelKeyIdsByVendor,
} from "./built-in-model-runtime-route.service";
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
  isOkouRunModel,
  isModelSupportedByProvider,
  isLimitedFree1RestrictedRunModel,
  getRunModelAccess,
  getRunModelRouteAccess,
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
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
import { orgMembersMetadata } from "@okouai/db/schema/org-members-metadata";
import { orgModelPolicies } from "@okouai/db/schema/org-model-policy";
import { runModelCatalog } from "@okouai/db/schema/run-model-catalog";
import {
  conflict,
  insufficientCredits,
  paidPlanRequired,
} from "../../lib/error";
import { nowDate } from "../../lib/time";
import { writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import {
  loadOrgPlanCapabilities,
  runtimeStatusForEntitlement,
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

class RejectedModelPolicyUpdate extends Error {
  constructor(
    readonly result: Extract<ServiceResult<never>, { readonly ok: false }>,
  ) {
    super("Model policy update rejected");
  }
}

const ORG_SENTINEL_USER_ID = "__org__";

const ONBOARDING_MODEL_POLICY_SEEDS = {
  codex: {
    models: ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"],
    defaultModel: "gpt-6-sol",
    providerType: "codex-oauth-token",
  },
  claudeCode: {
    models: ["claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5"],
    defaultModel: "claude-opus-5-5",
    providerType: "claude-code-oauth-token",
  },
} as const satisfies Record<
  OnboardingSubscriptionProvider,
  {
    readonly models: readonly SupportedRunModel[];
    readonly defaultModel: SupportedRunModel;
    readonly providerType: ModelProviderType;
  }
>;

function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

function bad<T>(message: string): ServiceResult<T> {
  return { ok: false, message };
}

function planRestricted<T>(model?: SupportedRunModel): ServiceResult<T> {
  return {
    ok: false,
    response:
      model === "claude-sonnet-5-5"
        ? paidPlanRequired()
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
  surface: SurfaceRouteInfo,
  model: SupportedRunModel,
): boolean {
  if (model === "claude-sonnet-5-5") {
    return false;
  }
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
async function lockPolicyWrites(
  db: Db,
  orgId: string,
  userId: string,
): Promise<{ readonly initializeSeed: boolean }> {
  await db.execute(modelPolicyWriterLockSql(orgId));

  const before = await loadRows(db, orgId, true);
  let initializeSeed = false;
  if (before.length === 0) {
    // The existing partial UNIQUE default slot arbitrates an empty policy set.
    // Insert just its real default row: inserting the entire seed could add
    // unwanted models after a concurrent writer replaces that seed.
    const [inserted] = await db
      .insert(orgModelPolicies)
      .values(policySeedValues(orgId, userId))
      .onConflictDoNothing()
      .returning({ id: orgModelPolicies.id });
    initializeSeed = inserted !== undefined;
  }

  // A writer may replace every row while this SELECT waits. Compare against a
  // fresh statement before accepting ownership of the complete current set.
  // R1's legacy key remains until every supported writer uses this protocol.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const lockedIds = await lockPolicyParents(db, orgId);
    const current = await loadRows(db, orgId, true);
    if (
      current.length > 0 &&
      current.length === lockedIds.size &&
      current.every((row) => {
        return lockedIds.has(row.id);
      })
    ) {
      return { initializeSeed };
    }
  }
  throw new Error("Model policies changed concurrently; retry the operation");
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

async function lockPolicyParents(db: Db, orgId: string): Promise<Set<string>> {
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
  const policies = await db
    .select({ id: orgModelPolicies.id })
    .from(orgModelPolicies)
    .where(eq(orgModelPolicies.orgId, orgId))
    .orderBy(asc(orgModelPolicies.id))
    .for("no key update");
  return new Set(
    policies.map((policy) => {
      return policy.id;
    }),
  );
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

async function loadModelsAllowedForNewOrgPolicy(
  db: Db,
  lockRows = false,
): Promise<ReadonlySet<SupportedRunModel>> {
  const query = db
    .select({
      model: runModelCatalog.model,
      allowNewOrgPolicy: runModelCatalog.allowNewOrgPolicy,
    })
    .from(runModelCatalog)
    .where(inArray(runModelCatalog.model, [...ACTIVE_RUN_MODELS]));
  const rows = lockRows ? await query.for("share") : await query;
  const allowed = new Set<SupportedRunModel>();
  for (const row of rows) {
    const model = parseSupportedModel(row.model);
    if (model && row.allowNewOrgPolicy) {
      allowed.add(model);
    }
  }
  return allowed;
}

function modelsAvailableToAdd(
  rows: readonly OrgModelPolicyRow[],
  allowed: ReadonlySet<SupportedRunModel>,
): SupportedRunModel[] {
  const configured = new Set(
    rows.map((row) => {
      return row.model;
    }),
  );
  return ACTIVE_RUN_MODELS.filter((model) => {
    return allowed.has(model) && !configured.has(model);
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

function modelPolicyCapabilities(
  capabilities: Pick<
    OrgPlanCapabilities,
    "status" | "restrictedBuiltInModels" | "supportByok"
  > | null,
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

export interface EnsuredOrgModelPolicyFacts {
  readonly orgPlanCapabilities: OrgPlanCapabilities | null;
  readonly policies: readonly OrgModelPolicyRow[];
}

function modelRouteAllowedForOrgPlan(
  model: string,
  providerType: ModelProviderType,
  capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >,
): boolean {
  return (
    getRunModelRouteAccess(
      model,
      providerType,
      capabilities.restrictedBuiltInModels,
    ) === "allowed" &&
    (capabilities.supportByok || isBuiltInModelProviderType(providerType))
  );
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

export function shouldReplaceExistingDefaultForPlan(
  existingDefault:
    | Pick<
        OrgModelPolicyRow,
        | "model"
        | "defaultProviderType"
        | "credentialScope"
        | "modelProviderId"
        | "modelProviderSurfaceId"
      >
    | undefined,
  capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >,
): boolean {
  if (
    existingDefault === undefined ||
    getRunModelAccess(existingDefault.model) === "retired"
  ) {
    return true;
  }
  if (capabilities.supportByok && !capabilities.restrictedBuiltInModels) {
    return false;
  }
  const shouldReplaceModel =
    capabilities.restrictedBuiltInModels &&
    isBuiltInModelProviderType(existingDefault.defaultProviderType) &&
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
  initializeSeed: boolean,
): Promise<EnsuredOrgModelPolicyFacts> {
  const orgPlanCapabilities = await loadOrgPlanCapabilities(db, orgId);
  const capabilities = modelPolicyCapabilities(orgPlanCapabilities);
  const seedDefaultModel = getSeedDefaultModelForPlan(capabilities);
  const existing = await loadRows(db, orgId);
  if (existing.length > 0 && !initializeSeed) {
    const existingDefault = existing.find((policy) => {
      return policy.isDefault;
    });
    if (!shouldReplaceExistingDefaultForPlan(existingDefault, capabilities)) {
      return {
        orgPlanCapabilities,
        policies: sortRowsByCatalog(existing),
      };
    }

    if (!capabilities.supportByok || capabilities.restrictedBuiltInModels) {
      await setDefaultModelPolicy(db, orgId, userId, seedDefaultModel, {
        resetRouteToBuiltIn: !capabilities.supportByok,
      });
      return {
        orgPlanCapabilities,
        policies: sortRowsByCatalog(await loadRows(db, orgId)),
      };
    }

    const activePolicies = existing.filter((policy) => {
      return getRunModelAccess(policy.model) === "allowed";
    });
    const fallbackDefault =
      activePolicies.find((policy) => {
        return policy.model === seedDefaultModel;
      }) ?? sortRowsByCatalog(activePolicies)[0];
    if (fallbackDefault) {
      await setDefaultModelPolicy(
        db,
        orgId,
        userId,
        parseSupportedModel(fallbackDefault.model) ?? seedDefaultModel,
        {},
      );
      return {
        orgPlanCapabilities,
        policies: sortRowsByCatalog(await loadRows(db, orgId)),
      };
    }
    return {
      orgPlanCapabilities,
      policies: sortRowsByCatalog(existing),
    };
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
    return {
      orgPlanCapabilities,
      policies: sortRowsByCatalog(initialized),
    };
  }

  await db
    .insert(orgModelPolicies)
    .values(missing)
    .onConflictDoNothing({
      target: [orgModelPolicies.orgId, orgModelPolicies.model],
    });

  return {
    orgPlanCapabilities,
    policies: sortRowsByCatalog(await loadRows(db, orgId)),
  };
}

/**
 * A caller that already read the organization's plan in this request supplies
 * it; otherwise the plan and the policies are read in parallel.
 */
export async function loadOrgModelPolicyFacts(
  db: Db,
  orgId: string,
  suppliedPlanCapabilities?: OrgPlanCapabilities | null,
): Promise<EnsuredOrgModelPolicyFacts> {
  const [orgPlanCapabilities, policies] = await Promise.all([
    suppliedPlanCapabilities === undefined
      ? loadOrgPlanCapabilities(db, orgId)
      : suppliedPlanCapabilities,
    loadRows(db, orgId),
  ]);
  return {
    orgPlanCapabilities,
    policies: sortRowsByCatalog(policies),
  };
}

export async function ensureOrgModelPolicyFacts(
  db: Db,
  orgId: string,
  userId: string,
  suppliedPlanCapabilities?: OrgPlanCapabilities | null,
): Promise<EnsuredOrgModelPolicyFacts> {
  const initial = await loadOrgModelPolicyFacts(
    db,
    orgId,
    suppliedPlanCapabilities,
  );
  const capabilities = modelPolicyCapabilities(initial.orgPlanCapabilities);
  if (
    initial.policies.length > 0 &&
    !shouldReplaceExistingDefaultForPlan(
      initial.policies.find((policy) => {
        return policy.isDefault;
      }),
      capabilities,
    )
  ) {
    return initial;
  }
  return db.transaction(async (tx) => {
    const ownership = await lockPolicyWrites(tx, orgId, userId);
    return ensureOrgModelPoliciesLocked(
      tx,
      orgId,
      userId,
      ownership.initializeSeed,
    );
  });
}

export async function ensureOrgModelPolicies(
  db: Db,
  orgId: string,
  userId: string,
): Promise<readonly OrgModelPolicyRow[]> {
  return (await ensureOrgModelPolicyFacts(db, orgId, userId)).policies;
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

interface PolicyRouteSnapshot {
  readonly providers: readonly Pick<
    typeof modelProviders.$inferSelect,
    "id" | "type" | "selectedModel" | "userId"
  >[];
  readonly surfaces: readonly SurfaceRouteInfo[];
}

function validateOrgProviderRoute(
  routes: PolicyRouteSnapshot,
  policy: UpdateOrgModelPolicy,
): string | null {
  const surfaceId = policy.modelProviderSurfaceId ?? null;
  if (surfaceId) {
    if (policy.credentialScope !== "org") {
      return "Custom gateway routes require workspace credentials";
    }
    if (policy.modelProviderId) {
      return "Custom gateway routes cannot store a legacy provider ID";
    }
    const surface = routes.surfaces.find((candidate) => {
      return candidate.id === surfaceId;
    });
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

  const provider = routes.providers.find((candidate) => {
    return candidate.id === policy.modelProviderId;
  });

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

/**
 * Plan restrictions gate what a workspace may newly configure, not what it
 * already stores. Every workspace is seeded with the same built-in models, so a
 * restricted plan owns rows its plan could not add today, and the client always
 * re-sends the full list. Re-validating those untouched rows would freeze the
 * list and block writes the plan does allow, such as adding a BYOK route. Only
 * an added or re-routed policy has to satisfy the plan, and a restricted route
 * may never be promoted into the workspace default it was not already holding.
 */
function planRestrictedWrite(params: {
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
      params.policy.model,
      params.providerType,
      params.capabilities,
    )
  ) {
    return false;
  }
  if (!storedRouteUnchanged(params.policy, params.existing)) {
    return true;
  }
  return params.policy.isDefault && params.existing?.isDefault !== true;
}

interface UpdatePolicyValidationContext {
  readonly capabilities: Pick<
    OrgPlanCapabilities,
    "restrictedBuiltInModels" | "supportByok"
  >;
  readonly existingRows: readonly OrgModelPolicyRow[];
  readonly modelsAllowedForNewPolicy: ReadonlySet<SupportedRunModel>;
}

function validateUpdatePolicies(
  routes: PolicyRouteSnapshot,
  policies: UpdateOrgModelPolicy[],
  context: UpdatePolicyValidationContext,
): ServiceResult<UpdateOrgModelPolicy[]> {
  const { capabilities, existingRows, modelsAllowedForNewPolicy } = context;
  if (policies.length === 0) {
    return bad("Request must include at least one model");
  }

  const existingByModel = policiesByModel(existingRows);
  const seenModels = new Set<string>();
  let defaultCount = 0;

  for (const policy of policies) {
    if (getRunModelAccess(policy.model) === "retired") {
      return bad(RETIRED_RUN_MODEL_MESSAGE);
    }
    const model = parseSupportedModel(policy.model);
    if (!model) {
      return bad(`Unknown model "${policy.model}"`);
    }
    const existing = existingByModel.get(policy.model);
    if (!existingByModel.has(model) && !modelsAllowedForNewPolicy.has(model)) {
      return bad(`Model "${model}" is not available to add`);
    }
    const providerType = parseProviderType(policy.defaultProviderType);
    if (!providerType) {
      return bad(`Unknown model provider type "${policy.defaultProviderType}"`);
    }
    if (
      planRestrictedWrite({
        policy,
        providerType,
        existing,
        capabilities,
      })
    ) {
      return planRestricted(
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

    if (policy.isDefault) {
      defaultCount += 1;
    }

    const routeError = validateOrgProviderRoute(routes, policy);
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
  keyIdsByVendor: BuiltInModelKeyIdsByVendor,
): Promise<OrgModelPoliciesResponse> {
  await ensureOrgModelPolicies(db, orgId, userId);
  const persistedRows = await loadRows(db, orgId, true);
  const rows = sortRowsByCatalog(
    persistedRows.filter((row) => {
      return (
        parseSupportedModel(row.model) &&
        getRunModelAccess(row.model) === "allowed"
      );
    }),
  );
  const modelsAllowedForNewPolicy = await loadModelsAllowedForNewOrgPolicy(db);
  const member = await loadMemberModelRouteContext(db, orgId, userId);
  const featureSwitchContext = await loadUserFeatureSwitchContext(
    db,
    orgId,
    userId,
  );
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
      const policy = serializePolicy(row, providersById, surfacesById);
      const runtimeRoute = isBuiltInModelProviderType(
        policy.defaultProviderType,
      )
        ? await resolveBuiltInModelRuntimeRouteWithKeys(
            db,
            policy.model,
            featureSwitchContext,
            keyIdsByVendor,
          )
        : null;
      const administrative: OrgModelPolicy = isBuiltInModelProviderType(
        policy.defaultProviderType,
      )
        ? { ...policy, runtimeProviderType: runtimeRoute?.providerType ?? null }
        : policy;
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
  const okouModelsEnabled = isFeatureEnabled(
    FeatureSwitchKey.OkouModels,
    featureSwitchContext,
  );

  return {
    policies,
    revision: policyRevision(persistedRows),
    // Permanent since the personal subscription priority rollout completed.
    // Removing the field needs its own client-compatibility window.
    writePreconditionRequired: true,
    modelsAvailableToAdd: modelsAvailableToAdd(
      persistedRows,
      modelsAllowedForNewPolicy,
    ).filter((model) => {
      return okouModelsEnabled || !isOkouRunModel(model);
    }),
    workspaceDefaultModel: workspaceDefault?.model ?? null,
    workspaceDefaultPolicyId: workspaceDefault?.id ?? null,
  };
}

/** Ordinary snapshots only: onboarding must not overwrite an administrator's set. */
export function onboardingModelPolicyWritePlan(params: {
  readonly orgId: string;
  readonly userId: string;
  readonly provider: OnboardingSubscriptionProvider;
  readonly existing: readonly OrgModelPolicyRow[];
  readonly initializeSeed: boolean;
  readonly now: Date;
}) {
  const standardSeed = getDefaultOrgModelPolicySeed();
  // Outgoing APIs can still have the previous untouched seed. Its data and
  // deployment convergence is tracked separately in #36167.
  const previousSeed = standardSeed.map((seed) => {
    return seed.model === "gpt-6-luna"
      ? { ...seed, model: "gpt-5.6-luna" as const }
      : seed;
  });
  const untouched = [standardSeed, previousSeed].some((seedRows) => {
    return (
      params.existing.length === seedRows.length &&
      seedRows.every((seed) => {
        const row = params.existing.find((candidate) => {
          return candidate.model === seed.model;
        });
        return (
          row?.isDefault === seed.isDefault &&
          row.defaultProviderType === seed.defaultProviderType &&
          row.credentialScope === seed.credentialScope &&
          row.modelProviderId === null &&
          row.modelProviderSurfaceId === null
        );
      })
    );
  });
  if (params.existing.length > 0 && !params.initializeSeed && !untouched) {
    return null;
  }
  const seed = ONBOARDING_MODEL_POLICY_SEEDS[params.provider];
  const policies: UpdateOrgModelPolicy[] = seed.models.map((model) => {
    return {
      model,
      isDefault: model === seed.defaultModel,
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
      inArray(orgModelPolicies.model, [...ACTIVE_RUN_MODELS]),
      notInArray(
        orgModelPolicies.model,
        policies.map((policy) => {
          return policy.model;
        }),
      ),
    ),
    defaultModel: seed.defaultModel,
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

/** Parent-before-policy order, shared as SQL values without a database handle. */
export function modelPolicyParentLockSql(orgId: string) {
  return [
    sql`SELECT ${modelProviders.id} FROM ${modelProviders}
      WHERE ${modelProviders.orgId} = ${orgId} AND ${modelProviders.userId} = ${ORG_SENTINEL_USER_ID}
      ORDER BY ${modelProviders.id} FOR SHARE`,
    sql`SELECT ${modelProviderConnections.id} FROM ${modelProviderConnections}
      WHERE ${modelProviderConnections.orgId} = ${orgId}
      ORDER BY ${modelProviderConnections.id} FOR SHARE`,
    sql`SELECT ${modelProviderSurfaces.id} FROM ${modelProviderSurfaces}
      INNER JOIN ${modelProviderConnections} ON ${modelProviderSurfaces.connectionId} = ${modelProviderConnections.id}
      WHERE ${modelProviderConnections.orgId} = ${orgId}
      ORDER BY ${modelProviderSurfaces.id} FOR SHARE OF ${modelProviderSurfaces}`,
  ];
}

export const listOrgModelPolicies$ = command(
  async (
    { get, set },
    params: { readonly orgId: string; readonly userId: string },
    signal: AbortSignal,
  ): Promise<OrgModelPoliciesResponse> => {
    const db = set(writeDb$);
    const response = await listOrgModelPolicies(
      db,
      params.orgId,
      params.userId,
      await get(builtInModelKeyIdsByVendor$),
    );
    signal.throwIfAborted();
    return response;
  },
);

interface ModelPolicyReplacement {
  readonly orgId: string;
  readonly userId: string;
  readonly policies: UpdateOrgModelPolicy[];
  readonly revision: string;
}

function policyRefreshConflict(): Extract<
  ServiceResult<never>,
  { readonly ok: false }
> {
  return {
    ok: false,
    response: conflict(
      "Model settings changed or this client is out of date. Refresh model settings and try again, or upgrade your client.",
    ),
  };
}

export function policySeedValues(orgId: string, userId: string) {
  const seed = getDefaultOrgModelPolicySeed().find((policy) => {
    return policy.isDefault;
  });
  if (!seed) {
    throw new Error("The default model policy seed has no default");
  }
  return { ...seed, orgId, createdByUserId: userId, updatedByUserId: userId };
}

function replacementPolicyValues(
  params: Pick<ModelPolicyReplacement, "orgId" | "userId" | "policies">,
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
    isDefault: policy.isDefault,
    defaultProviderType: policy.defaultProviderType,
    credentialScope: policy.credentialScope,
    modelProviderId: policy.modelProviderId,
    modelProviderSurfaceId: policy.modelProviderSurfaceId ?? null,
    updatedAt: now,
    updatedByUserId: userId,
  };
}

export function policySetOwned(
  locked: readonly OrgModelPolicyRow[],
  current: readonly OrgModelPolicyRow[],
) {
  const ids = new Set(
    locked.map((row) => {
      return row.id;
    }),
  );
  return (
    current.length > 0 &&
    current.length === ids.size &&
    current.every((row) => {
      return ids.has(row.id);
    })
  );
}

function policyWriteCapabilities(
  row:
    | {
        readonly status: string;
        readonly supportByok: boolean;
        readonly restrictedBuiltInModels: boolean | null;
      }
    | undefined,
  orgId: string,
) {
  if (row?.restrictedBuiltInModels === null) {
    throw new Error(
      `Unexpected NULL restricted_built_in_models for org plan entitlement ${orgId}`,
    );
  }
  return modelPolicyCapabilities(
    row
      ? {
          status: runtimeStatusForEntitlement(row.status),
          restrictedBuiltInModels: row.restrictedBuiltInModels,
          supportByok: row.supportByok,
        }
      : null,
  );
}

export function modelPolicyWriterLockSql(orgId: string) {
  // Outgoing writers do not yet fence the complete current policy set. Remove
  // the legacy key only when they no longer serve, drain, or remain rollback targets.
  // eslint-disable-next-line api/no-new-advisory-lock -- Existing R1 acquisition; pure SQL builder only.
  return sql`SELECT pg_advisory_xact_lock(hashtextextended(${`model-policy:${orgId}`}, 0))`;
}

const POLICY_PROVIDER_SELECTION = {
  id: modelProviders.id,
  type: modelProviders.type,
  selectedModel: modelProviders.selectedModel,
  userId: modelProviders.userId,
} as const;
const POLICY_SURFACE_SELECTION = {
  id: modelProviderSurfaces.id,
  protocol: modelProviderSurfaces.protocol,
  modelMappings: modelProviderSurfaces.modelMappings,
} as const;
const POLICY_ENTITLEMENT_SELECTION = {
  status: orgPlanEntitlements.status,
  supportByok: orgPlanEntitlements.supportByok,
  restrictedBuiltInModels: orgPlanEntitlements.restrictedBuiltInModels,
} as const;
const POLICY_CATALOG_SELECTION = {
  model: runModelCatalog.model,
  allowNewOrgPolicy: runModelCatalog.allowNewOrgPolicy,
} as const;

function ownedPolicyProviders(orgId: string) {
  return and(
    eq(modelProviders.orgId, orgId),
    eq(modelProviders.userId, ORG_SENTINEL_USER_ID),
  );
}

function assertPolicyRevision(
  revision: string,
  existing: readonly OrgModelPolicyRow[],
) {
  if (revision !== policyRevision(existing)) {
    throw new RejectedModelPolicyUpdate(policyRefreshConflict());
  }
}

function replacementWritePlan(
  params: ModelPolicyReplacement,
  now: Date,
  input: {
    readonly existing: readonly OrgModelPolicyRow[];
    readonly routes: PolicyRouteSnapshot;
    readonly entitlement: Parameters<typeof policyWriteCapabilities>[0];
    readonly catalog: readonly {
      readonly model: string;
      readonly allowNewOrgPolicy: boolean;
    }[];
  },
) {
  const allowed = new Set(
    input.catalog.flatMap((row) => {
      const model = parseSupportedModel(row.model);
      return model && row.allowNewOrgPolicy ? [model] : [];
    }),
  );
  const validation = validateUpdatePolicies(
    input.routes,
    resolveOmittedModelProviderSurfaceIds(params.policies, input.existing),
    {
      capabilities: policyWriteCapabilities(input.entitlement, params.orgId),
      existingRows: input.existing,
      modelsAllowedForNewPolicy: allowed,
    },
  );
  if (!validation.ok) {
    throw new RejectedModelPolicyUpdate(validation);
  }
  const policies = validation.data;
  const owner = eq(orgModelPolicies.orgId, params.orgId);
  return {
    now,
    insertValues: replacementPolicyValues({ ...params, policies }, now),
    removalCondition: and(
      owner,
      inArray(orgModelPolicies.model, [...ACTIVE_RUN_MODELS]),
      notInArray(
        orgModelPolicies.model,
        policies.map((policy) => {
          return policy.model;
        }),
      ),
    ),
    defaultModel: policies.find((policy) => {
      return policy.isDefault;
    })?.model,
    updates: policies.map((policy) => {
      return {
        values: policyUpdateValues(policy, params.userId, now),
        condition: and(owner, eq(orgModelPolicies.model, policy.model)),
      };
    }),
  };
}

/** Publish one validated complete policy set; every database handle stays here. */
const commitOrgModelPolicyReplacement$ = command(
  async (
    { set },
    params: ModelPolicyReplacement,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    await db.transaction(async (tx) => {
      await tx.execute(modelPolicyWriterLockSql(params.orgId));
      const owner = eq(orgModelPolicies.orgId, params.orgId);
      const before = await tx.select().from(orgModelPolicies).where(owner);
      if (before.length === 0) {
        await tx
          .insert(orgModelPolicies)
          .values(policySeedValues(params.orgId, params.userId))
          .onConflictDoNothing();
      }
      let existing: OrgModelPolicyRow[] = [];
      let routes: PolicyRouteSnapshot = { providers: [], surfaces: [] };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const providers = await tx
          .select(POLICY_PROVIDER_SELECTION)
          .from(modelProviders)
          .where(ownedPolicyProviders(params.orgId))
          .orderBy(asc(modelProviders.id))
          .for("share");
        await tx
          .select({ id: modelProviderConnections.id })
          .from(modelProviderConnections)
          .where(eq(modelProviderConnections.orgId, params.orgId))
          .orderBy(asc(modelProviderConnections.id))
          .for("share");
        const surfaces = await tx
          .select(POLICY_SURFACE_SELECTION)
          .from(modelProviderSurfaces)
          .innerJoin(
            modelProviderConnections,
            eq(modelProviderSurfaces.connectionId, modelProviderConnections.id),
          )
          .where(eq(modelProviderConnections.orgId, params.orgId))
          .orderBy(asc(modelProviderSurfaces.id))
          .for("share", { of: modelProviderSurfaces });
        const locked = await tx
          .select()
          .from(orgModelPolicies)
          .where(owner)
          .orderBy(asc(orgModelPolicies.id))
          .for("no key update");
        existing = await tx.select().from(orgModelPolicies).where(owner);
        if (policySetOwned(locked, existing)) {
          routes = { providers, surfaces };
          break;
        }
        if (attempt === 2) {
          throw new Error(
            "Model policies changed concurrently; retry the operation",
          );
        }
      }
      assertPolicyRevision(params.revision, existing);
      const [entitlement] = await tx
        .select(POLICY_ENTITLEMENT_SELECTION)
        .from(orgPlanEntitlements)
        .where(eq(orgPlanEntitlements.orgId, params.orgId))
        .limit(1);
      if (!entitlement) {
        const [org] = await tx
          .select({ id: orgMetadata.orgId })
          .from(orgMetadata)
          .where(eq(orgMetadata.orgId, params.orgId))
          .limit(1);
        if (org) {
          throw new Error(`Missing org plan entitlement for ${params.orgId}`);
        }
      }
      const catalog = await tx
        .select(POLICY_CATALOG_SELECTION)
        .from(runModelCatalog)
        .where(inArray(runModelCatalog.model, [...ACTIVE_RUN_MODELS]))
        .for("share");
      const plan = replacementWritePlan(params, nowDate(), {
        existing,
        routes,
        entitlement,
        catalog,
      });
      signal.throwIfAborted();
      await tx
        .insert(orgModelPolicies)
        .values(plan.insertValues)
        .onConflictDoNothing({
          target: [orgModelPolicies.orgId, orgModelPolicies.model],
        });
      const removed = await tx
        .delete(orgModelPolicies)
        .where(plan.removalCondition)
        .returning({ model: orgModelPolicies.model });
      if (removed.length > 0 && plan.defaultModel) {
        await tx
          .update(orgMembersMetadata)
          .set({
            selectedModel: plan.defaultModel,
            serviceTier: null,
            updatedAt: plan.now,
          })
          .where(
            and(
              eq(orgMembersMetadata.orgId, params.orgId),
              inArray(
                orgMembersMetadata.selectedModel,
                removed.map((row) => {
                  return row.model;
                }),
              ),
            ),
          );
      }
      await tx.update(orgModelPolicies).set({ isDefault: false }).where(owner);
      for (const update of plan.updates) {
        await tx
          .update(orgModelPolicies)
          .set(update.values)
          .where(update.condition);
      }
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);

export const updateOrgModelPolicies$ = command(
  async (
    { get, set },
    params: Omit<ModelPolicyReplacement, "revision"> & {
      readonly revision?: string;
    },
    signal: AbortSignal,
  ): Promise<ServiceResult<OrgModelPoliciesResponse>> => {
    if (!params.revision) {
      return policyRefreshConflict();
    }
    const written = await settle(
      set(
        commitOrgModelPolicyReplacement$,
        { ...params, revision: params.revision },
        signal,
      ),
      signal,
    );
    if (!written.ok) {
      if (written.error instanceof RejectedModelPolicyUpdate) {
        return written.error.result;
      }
      throw written.error;
    }
    const db = set(writeDb$);
    const response = await listOrgModelPolicies(
      db,
      params.orgId,
      params.userId,
      await get(builtInModelKeyIdsByVendor$),
    );
    signal.throwIfAborted();
    return ok(response);
  },
);
