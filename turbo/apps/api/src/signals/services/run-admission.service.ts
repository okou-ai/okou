import {
  isBuiltInModelProviderType,
  getRunModelAccess,
  getRunModelRouteAccess,
  normalizeBuiltInModelId,
  RETIRED_RUN_MODEL_MESSAGE,
} from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { creditExpiresRecord } from "@okouai/db/schema/credit-expires-record";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { orgPlanEntitlements } from "@okouai/db/runtime/org-plan-entitlement";
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
import type { Db } from "../external/db";
import {
  loadOrgPlanCapabilities,
  type OrgPlanCapabilities,
  ORG_PLAN_CAPABILITY_SELECTION,
  runtimeStatusForEntitlement,
} from "./org-plan-entitlement-read.service";
import { getSpendableUsagePackCredits } from "./usage-pack-credit.service";
import { isAutoPersonalSubscriptionRoute } from "./subscription-model-catalog.service";
import {
  createUsageAllowanceObjects,
  resolveUsageAllowanceAvailability,
} from "./usage-allowance.service";

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
  readonly db: Db;
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
    const { db, orgId } = await get(input$);
    const [capabilities] = await db
      .select(ORG_PLAN_CAPABILITY_SELECTION)
      .from(orgPlanEntitlements)
      .where(eq(orgPlanEntitlements.orgId, orgId))
      .limit(1);
    if (!capabilities) {
      const [org] = await db
        .select({ orgId: orgMetadata.orgId })
        .from(orgMetadata)
        .where(eq(orgMetadata.orgId, orgId))
        .limit(1);
      if (!org) {
        return null;
      }
      throw new Error(`Missing org plan entitlement for ${orgId}`);
    }
    if (capabilities.restrictedBuiltInModels === null) {
      throw new Error(
        `Unexpected NULL restricted_built_in_models for org plan entitlement ${orgId}`,
      );
    }
    const { restrictedBuiltInModels, ...runtimeCapabilities } = capabilities;
    return {
      ...runtimeCapabilities,
      restrictedBuiltInModels,
      status: runtimeStatusForEntitlement(capabilities.status),
    };
  });
}

function createRunAdmissionCreditBalanceObject(input$: RunAdmissionReadInput) {
  return computed(async (get) => {
    const { db, orgId, at } = await get(input$);
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
    const { db, orgId, userId, at } = await get(input$);
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
  const { resolveAvailability$ } = createUsageAllowanceObjects(readInput$);
  const autoPersonalSubscription$ = computed(async (get) => {
    const input = await get(readInput$);
    return await isAutoPersonalSubscriptionRoute({
      db: input.db,
      orgId: input.orgId,
      userId: input.userId,
      model: input.selectedModel,
      providerType: input.modelProviderType,
    });
  });
  const checkAdmission$ = command(async ({ get, set }, signal: AbortSignal) => {
    const [input, autoPersonalSubscription] = await Promise.all([
      get(readInput$),
      get(autoPersonalSubscription$),
    ]);
    signal.throwIfAborted();
    if (!input.enforceBuiltInCredits) {
      const capabilities = await get(capabilities$);
      signal.throwIfAborted();
      return (
        checkOrgPlanRunAdmission({
          ...input,
          capabilities,
          autoPersonalSubscription,
        }) ?? null
      );
    }
    const availability = await get(availability$);
    signal.throwIfAborted();
    if (getRunModelAccess(input.selectedModel) === "retired") {
      return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
    }
    if (!availability) {
      return insufficientCredits();
    }
    const failure = checkOrgPlanRunAdmission({
      ...input,
      capabilities: availability,
      autoPersonalSubscription,
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
    const allowance = await set(resolveAvailability$, signal);
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
  readonly orgId: string;
  readonly userId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel?: string | null;
  readonly availability: OrgCreditAvailability | null;
}): Promise<RunAdmissionFailure | undefined> {
  const autoPersonalSubscription = await isAutoPersonalSubscriptionRoute({
    db: params.db,
    orgId: params.orgId,
    userId: params.userId,
    model: params.selectedModel,
    providerType: params.modelProviderType,
  });
  return await checkResolvedOrgCreditsForRunAdmissionWithAllowance({
    ...params,
    autoPersonalSubscription,
    resolveAllowance: async () => {
      return await resolveUsageAllowanceAvailability(params.db, params.orgId);
    },
  });
}

async function checkResolvedOrgCreditsForRunAdmissionWithAllowance(params: {
  readonly orgId: string;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel?: string | null;
  readonly availability: OrgCreditAvailability | null;
  readonly autoPersonalSubscription: boolean;
  readonly resolveAllowance: () => Promise<{
    readonly remainingUnits: number;
  } | null>;
}): Promise<RunAdmissionFailure | undefined> {
  const { availability } = params;
  if (getRunModelAccess(params.selectedModel) === "retired") {
    return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
  }
  if (!availability) {
    return insufficientCredits();
  }
  const planAdmission = checkOrgPlanRunAdmission({
    capabilities: availability,
    modelProviderType: params.modelProviderType,
    selectedModel: params.selectedModel,
    autoPersonalSubscription: params.autoPersonalSubscription,
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

export function checkOrgPlanRunAdmission(params: {
  readonly capabilities: OrgPlanRunAdmissionCapabilities | null;
  readonly modelProviderType: string | null | undefined;
  readonly selectedModel: string | null | undefined;
  readonly autoPersonalSubscription?: boolean;
}): RunAdmissionFailure | undefined {
  const { capabilities } = params;
  const modelAccess = getRunModelRouteAccess(
    params.selectedModel,
    params.modelProviderType,
    capabilities?.restrictedBuiltInModels && !params.autoPersonalSubscription,
  );
  if (modelAccess === "retired") {
    return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
  }
  if (!capabilities || capabilities.status !== "active") {
    return insufficientCredits();
  }
  if (
    modelAccess === "pro_required" &&
    normalizeBuiltInModelId(params.selectedModel ?? "") === "claude-sonnet-5-5"
  ) {
    return paidPlanRequired();
  }
  return (!capabilities.supportByok &&
    !params.autoPersonalSubscription &&
    !isBuiltInModelProviderType(params.modelProviderType)) ||
    modelAccess === "pro_required"
    ? insufficientCredits()
    : undefined;
}
