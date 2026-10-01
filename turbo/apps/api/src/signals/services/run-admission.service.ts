import {
  isBuiltInModelProviderType,
  RETIRED_RUN_MODEL_MESSAGE,
} from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { computed, command, type Computed } from "ccstate";
import { and, eq, gt, lte, sql, sum } from "drizzle-orm";
import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
} from "../../lib/db-structured-result";
import {
  badRequestMessage,
  insufficientCredits,
  paidPlanRequired,
} from "../../lib/error";
import { nowDate } from "../../lib/time";
import { db$, type Db } from "../external/db";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { getSpendableUsagePackCredits } from "./usage-pack-credit.service";
import { isPersonalSubscriptionRoute } from "./member-subscription-models.service";
import {
  createUsageAllowanceObjects,
  resolveUsageAllowanceAvailability,
} from "./usage-allowance.service";
import {
  catalogModelForSelectedId,
  catalogRunModelRouteAccess,
} from "./model-route-capabilities.service";
import {
  catalogHasProviderRoute,
  isCatalogModelRunnable,
  type ModelCatalog,
} from "./model-catalog.service";
type RunAdmissionFailure =
  | ReturnType<typeof insufficientCredits>
  | ReturnType<typeof paidPlanRequired>
  | ReturnType<typeof badRequestMessage>;

type CreditDb = Pick<Db, "$with" | "select" | "with">;

export interface OrgCreditAvailability {
  readonly status: OrgPlanCapabilities["status"];
  readonly supportByok: boolean;
  readonly restrictedBuiltInModels: boolean;
  readonly spendableCredits: number;
  readonly usagePackCredits: number;
}

type OrgPlanRunAdmissionCapabilities = Pick<
  OrgPlanCapabilities,
  "status" | "supportByok" | "restrictedBuiltInModels"
>;

export interface RunCreditAdmissionState {
  readonly orgId: string;
  readonly status: typeof agentRuns.$inferSelect.status;
  /** Persisted permission for this active run to continue after credits run out. */
  readonly creditAdmitted: boolean;
}

/** One admission phase; callers replace this input before a fresh check. */
export interface RunAdmissionInput {
  /** The run's catalog snapshot, loaded once by the caller. */
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly enforceBuiltInCredits: boolean;
}

type RunAdmissionInputObject = Computed<
  RunAdmissionInput | Promise<RunAdmissionInput>
>;

function createRunAdmissionReadInput(input$: RunAdmissionInputObject) {
  return computed(async (get) => {
    return { ...(await get(input$)), at: nowDate() };
  });
}

type RunAdmissionReadInput = ReturnType<typeof createRunAdmissionReadInput>;

function createRunAdmissionCapabilitiesObject(input$: RunAdmissionReadInput) {
  return computed(async (get): Promise<OrgPlanCapabilities | null> => {
    const { orgId } = await get(input$);
    return await loadOrgPlanCapabilities(get(db$), orgId);
  });
}

function createRunAdmissionCreditBalanceObject(input$: RunAdmissionReadInput) {
  return computed(async (get) => {
    const { orgId, at } = await get(input$);

    const db = get(db$);
    // Preserve the single-statement credit/expiry snapshot and precision check.
    const expired = db.$with("expired").as(
      db
        .select({
          total: sum(creditExpiresRecord.remaining)
            .mapWith(nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder))
            .as("total"),
        })
        .from(creditExpiresRecord)
        .where(
          and(
            eq(creditExpiresRecord.orgId, orgId),
            lte(creditExpiresRecord.expiresAt, at),
            gt(creditExpiresRecord.remaining, 0),
          ),
        ),
    );
    const [row] = await db
      .with(expired)
      .select({
        credits: sql`${orgMetadata.credits}`.mapWith(
          nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
        ),
        unsettledExpired: expired.total,
      })
      .from(expired)
      .leftJoin(orgMetadata, eq(orgMetadata.orgId, orgId));
    return row?.credits === null || row === undefined
      ? null
      : row.credits - (row.unsettledExpired ?? 0);
  });
}

function createRunAdmissionUsagePackObject(input$: RunAdmissionReadInput) {
  return computed(async (get) => {
    const { orgId, userId, at } = await get(input$);

    const db = get(db$);
    const [row] = await db
      .select({
        total: sum(usagePackCreditGrants.remainingAmount).mapWith(
          nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
        ),
      })
      .from(usagePackCreditGrants)
      .where(
        and(
          eq(usagePackCreditGrants.orgId, orgId),
          eq(usagePackCreditGrants.userId, userId),
          gt(usagePackCreditGrants.remainingAmount, 0),
          gt(usagePackCreditGrants.expiresAt, at),
        ),
      );
    return row?.total ?? 0;
  });
}

function createRunAdmissionAvailabilityObject(
  capabilities$: ReturnType<typeof createRunAdmissionCapabilitiesObject>,
  balance$: ReturnType<typeof createRunAdmissionCreditBalanceObject>,
  usagePack$: ReturnType<typeof createRunAdmissionUsagePackObject>,
) {
  return computed(async (get): Promise<OrgCreditAvailability | null> => {
    const [capabilities, spendableCredits, usagePackCredits] =
      await Promise.all([get(capabilities$), get(balance$), get(usagePack$)]);
    return capabilities && spendableCredits !== null
      ? {
          status: capabilities.status,
          supportByok: capabilities.supportByok,
          restrictedBuiltInModels: capabilities.restrictedBuiltInModels,
          spendableCredits,
          usagePackCredits,
        }
      : null;
  });
}

/** Fixed read nodes plus the explicit, conditional allowance refresh command. */
export function createRunAdmissionObjects(input$: RunAdmissionInputObject) {
  const readInput$ = createRunAdmissionReadInput(input$);
  const capabilities$ = createRunAdmissionCapabilitiesObject(readInput$);
  const availability$ = createRunAdmissionAvailabilityObject(
    capabilities$,
    createRunAdmissionCreditBalanceObject(readInput$),
    createRunAdmissionUsagePackObject(readInput$),
  );
  const allowanceObjects$ = computed(async (get) => {
    const input = await get(readInput$);
    return createUsageAllowanceObjects(input.orgId);
  });
  const personalSubscription$ = computed(async (get) => {
    const input = await get(readInput$);
    return await isPersonalSubscriptionRoute({
      db: get(db$),
      catalog: input.catalog,
      orgId: input.orgId,
      userId: input.userId,
      model: input.selectedModel,
      providerType: input.modelProviderType,
    });
  });
  const checkAdmission$ = command(async ({ get, set }, signal: AbortSignal) => {
    const [input, personalSubscription] = await Promise.all([
      get(readInput$),
      get(personalSubscription$),
    ]);
    signal.throwIfAborted();
    if (!input.enforceBuiltInCredits) {
      const capabilities = await get(capabilities$);
      signal.throwIfAborted();
      return (
        checkOrgPlanRunAdmission({
          ...input,
          capabilities,
          personalSubscription,
        }) ?? null
      );
    }
    const availability = await get(availability$);
    signal.throwIfAborted();
    const routeFailure = checkCatalogRunRoute(input.catalog, input);
    if (routeFailure) {
      return routeFailure;
    }
    if (!availability) {
      return insufficientCredits();
    }
    const failure = checkOrgPlanRunAdmission({
      ...input,
      capabilities: availability,
      personalSubscription,
    });
    if (failure) {
      return failure;
    }
    if (
      !isBuiltInModelProviderType(input.modelProviderType) ||
      availability.usagePackCredits > 0 ||
      availability.spendableCredits > 0
    ) {
      return null;
    }
    const allowanceObjects = await get(allowanceObjects$);
    signal.throwIfAborted();
    const allowance = await set(allowanceObjects.resolveAvailability$, signal);
    signal.throwIfAborted();
    return allowance && allowance.remainingUnits > 0
      ? null
      : insufficientCredits();
  });
  return { capabilities$, availability$, checkAdmission$ };
}

export function isFreePlanForCreditAdmission(
  planKey: string | null | undefined,
): boolean {
  return planKey === "free" || planKey === "limited-free-1";
}

export function runHasActiveCreditAdmission(
  run: Pick<RunCreditAdmissionState, "status" | "creditAdmitted">,
): boolean {
  return (
    run.creditAdmitted && (run.status === "pending" || run.status === "running")
  );
}

export async function loadRunCreditAdmissionState(params: {
  readonly db: Db;
  readonly runId: string;
  readonly orgId: string;
  readonly userId: string;
}): Promise<RunCreditAdmissionState | undefined> {
  const [run] = await params.db
    .select({
      orgId: agentRuns.orgId,
      status: agentRuns.status,
      creditAdmitted: agentRuns.creditAdmitted,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, params.runId),
        eq(agentRuns.orgId, params.orgId),
        eq(agentRuns.userId, params.userId),
      ),
    )
    .limit(1);
  return run;
}

export async function resolveActiveRunCreditAdmission(params: {
  readonly db: Db;
  readonly runId: string | undefined;
  readonly orgId: string;
  readonly userId: string;
}): Promise<boolean> {
  if (!params.runId) {
    return false;
  }
  const run = await loadRunCreditAdmissionState({
    ...params,
    runId: params.runId,
  });
  return run !== undefined && runHasActiveCreditAdmission(run);
}

export async function resolveOrgCreditAvailability(params: {
  readonly db: CreditDb;
  readonly orgId: string;
  readonly userId: string;
}): Promise<OrgCreditAvailability | null> {
  const at = nowDate();
  const expired = params.db.$with("expired").as(
    params.db
      .select({
        total: sql`COALESCE(${sum(creditExpiresRecord.remaining)}, 0)::bigint`
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("total"),
      })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, params.orgId),
          lte(creditExpiresRecord.expiresAt, at),
          gt(creditExpiresRecord.remaining, sql`0`),
        ),
      ),
  );
  const rows = await params.db
    .with(expired)
    .select({
      credits: sql`${orgMetadata.credits}`.mapWith(
        nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
      ),
      unsettledExpired: expired.total,
    })
    .from(expired)
    .leftJoin(orgMetadata, eq(orgMetadata.orgId, params.orgId));

  const row = rows[0];
  if (!row || row.credits === null) {
    return null;
  }

  const credits = row.credits;
  const spendableCredits = credits - row.unsettledExpired;
  const capabilities = await loadOrgPlanCapabilities(params.db, params.orgId);
  if (!capabilities) {
    return null;
  }
  const usagePackCredits = await getSpendableUsagePackCredits(params.db, {
    orgId: params.orgId,
    userId: params.userId,
    at,
  });
  return {
    status: capabilities.status,
    supportByok: capabilities.supportByok,
    restrictedBuiltInModels: capabilities.restrictedBuiltInModels,
    spendableCredits,
    usagePackCredits,
  };
}

export async function checkOrgCreditsForRunAdmission(params: {
  readonly db: Db;
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel?: string | null;
}): Promise<RunAdmissionFailure | undefined> {
  const availability = await resolveOrgCreditAvailability(params);
  return await checkResolvedOrgCreditsForRunAdmission({
    ...params,
    availability,
  });
}

export async function checkResolvedOrgCreditsForRunAdmission(params: {
  readonly db: Db;
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel?: string | null;
  readonly availability: OrgCreditAvailability | null;
}): Promise<RunAdmissionFailure | undefined> {
  const personalSubscription = await isPersonalSubscriptionRoute({
    db: params.db,
    catalog: params.catalog,
    orgId: params.orgId,
    userId: params.userId,
    model: params.selectedModel,
    providerType: params.modelProviderType,
  });
  return await checkResolvedOrgCreditsForRunAdmissionWithAllowance({
    ...params,
    personalSubscription,
    resolveAllowance: async () => {
      return await resolveUsageAllowanceAvailability(params.db, params.orgId);
    },
  });
}

async function checkResolvedOrgCreditsForRunAdmissionWithAllowance(params: {
  readonly catalog: ModelCatalog;
  readonly orgId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel?: string | null;
  readonly availability: OrgCreditAvailability | null;
  readonly personalSubscription: boolean;
  readonly resolveAllowance: () => Promise<{
    readonly remainingUnits: number;
  } | null>;
}): Promise<RunAdmissionFailure | undefined> {
  const { availability } = params;
  if (!availability) {
    return (
      checkCatalogRunRoute(params.catalog, params) ?? insufficientCredits()
    );
  }
  const planAdmission = checkOrgPlanRunAdmission({
    catalog: params.catalog,
    capabilities: availability,
    modelProviderType: params.modelProviderType,
    selectedModel: params.selectedModel,
    personalSubscription: params.personalSubscription,
  });
  if (planAdmission) {
    return planAdmission;
  }

  if (!isBuiltInModelProviderType(params.modelProviderType)) {
    return undefined;
  }

  if (availability.usagePackCredits > 0 || availability.spendableCredits > 0) {
    return undefined;
  }

  const allowance = await params.resolveAllowance();
  return allowance && allowance.remainingUnits > 0
    ? undefined
    : insufficientCredits();
}

/**
 * Runtime guard from the run's catalog snapshot: the selected model must be
 * an active catalog model with an enabled route, and a Built-in run needs an
 * enabled Built-in route. Retired or unknown IDs are resolved (or rejected)
 * before admission; this only stops an unresolved ID from reaching a runner.
 */
export function checkCatalogRunRoute(
  catalog: ModelCatalog,
  params: {
    readonly modelProviderType: string | null | undefined;
    readonly selectedModel?: string | null;
  },
): RunAdmissionFailure | undefined {
  if (!params.selectedModel) {
    return undefined;
  }
  // Normalized through the catalog like the plan check: a catalog model ID,
  // or a route upstream ID that names exactly one catalog model.
  const model = catalogModelForSelectedId(catalog, params.selectedModel);
  const builtIn = isBuiltInModelProviderType(params.modelProviderType);
  if (model !== null) {
    if (!isCatalogModelRunnable(catalog, model)) {
      return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
    }
    return builtIn && !catalogHasProviderRoute(catalog, model, "built-in")
      ? badRequestMessage(RETIRED_RUN_MODEL_MESSAGE)
      : undefined;
  }
  // Built-in only runs catalog models.
  if (builtIn) {
    return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
  }
  // A provider-native ID is an upstream model of catalog routes. It is
  // retired only when every catalog model it is an upstream of is retired;
  // an ID the catalog does not know stays the provider's own model.
  const upstreamOf = catalog.routes.filter((route) => {
    return route.upstreamModel === params.selectedModel;
  });
  return upstreamOf.length > 0 &&
    !upstreamOf.some((route) => {
      return route.enabled && isCatalogModelRunnable(catalog, route.model);
    })
    ? badRequestMessage(RETIRED_RUN_MODEL_MESSAGE)
    : undefined;
}

/**
 * The denial for a catalog model a free (restricted) plan cannot run on the
 * requested route. It names the catalog's free Built-in models and the one
 * other way in: the member's own connected subscription.
 */
export function restrictedPlanModelRequired(
  catalog: ModelCatalog,
  displayName: string,
): ReturnType<typeof paidPlanRequired> {
  const freeModels = catalog.models
    .filter((model) => {
      return model.builtInOnRestrictedPlans && model.replacedBy === null;
    })
    .map((model) => {
      return model.displayName;
    });
  const choose =
    freeModels.length > 0 ? `choose ${freeModels.join(" or ")} or ` : "";
  return paidPlanRequired(
    displayName,
    `On the free plan, ${choose}connect your own Claude Code or Codex subscription.`,
  );
}

export function checkOrgPlanRunAdmission(params: {
  /** The run's catalog snapshot, loaded once by the caller. */
  readonly catalog: ModelCatalog;
  readonly capabilities: OrgPlanRunAdmissionCapabilities | null;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
  /**
   * The run uses the member's own connected, valid subscription on the
   * model's catalog subscription route (Auto or Custom), verified by the
   * caller through `isMemberSubscriptionRoute`. It is the only route a free
   * plan may use besides its free Built-in models.
   */
  readonly personalSubscription?: boolean;
}): RunAdmissionFailure | undefined {
  const { capabilities } = params;
  const modelAccess = catalogRunModelRouteAccess(
    params.catalog,
    params.selectedModel,
    params.modelProviderType,
    capabilities?.restrictedBuiltInModels && !params.personalSubscription,
  );
  const routeFailure = checkCatalogRunRoute(params.catalog, params);
  if (routeFailure) {
    return routeFailure;
  }
  if (!capabilities || capabilities.status !== "active") {
    return insufficientCredits();
  }
  // A catalog model a free plan cannot run on this route asks for a paid
  // plan by name and points at the free alternatives.
  const restrictedModel =
    modelAccess === "pro_required" && params.selectedModel
      ? params.catalog.byModel.get(
          catalogModelForSelectedId(params.catalog, params.selectedModel) ?? "",
        )
      : undefined;
  if (restrictedModel) {
    return restrictedPlanModelRequired(
      params.catalog,
      restrictedModel.displayName,
    );
  }
  return (!capabilities.supportByok &&
    !params.personalSubscription &&
    !isBuiltInModelProviderType(params.modelProviderType)) ||
    modelAccess === "pro_required"
    ? insufficientCredits()
    : undefined;
}
