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
import { command } from "ccstate";
import { writeDb$, type Db } from "../external/db";
import { usagePackCreditGrants } from "@okouai/db/schema/usage-pack-credit-grant";
import { resolveUsageAllowanceAvailability$ } from "./usage-allowance-availability.service";
import {
  loadOrgPlanCapabilities,
  loadOrgPlanCapabilities$,
  type OrgPlanCapabilities,
} from "./org-plan-entitlement-read.service";
import { getSpendableUsagePackCredits } from "./usage-pack-credit.service";
import { isAutoPersonalSubscriptionRoute } from "./subscription-model-catalog.service";
import { resolveUsageAllowanceAvailability } from "./usage-allowance.service";

type RunAdmissionFailure =
  | ReturnType<typeof insufficientCredits>
  | ReturnType<typeof paidPlanRequired>
  | ReturnType<typeof badRequestMessage>;

type CreditDb = Pick<Db, "$with" | "select" | "with">;

interface OrgCreditAvailability {
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

/** Read ordinary balances; settlement remains the owner of every debit. */
export const resolveOrgCreditAvailability$ = command(
  async (
    { set },
    params: { readonly orgId: string; readonly userId: string },
    signal?: AbortSignal,
  ): Promise<OrgCreditAvailability | null> => {
    const db = set(writeDb$);
    const at = nowDate();
    const expired = db
      .select({
        total:
          sql`COALESCE(SUM(${creditExpiresRecord.remaining}), 0)::bigint`.mapWith(
            pgInt8ToSafeIntegerDecoder,
          ),
      })
      .from(creditExpiresRecord)
      .where(
        and(
          eq(creditExpiresRecord.orgId, params.orgId),
          lte(creditExpiresRecord.expiresAt, at),
          gt(creditExpiresRecord.remaining, 0),
        ),
      );
    const purchased = db
      .select({
        total:
          sql`COALESCE(SUM(${usagePackCreditGrants.remainingAmount}), 0)::bigint`.mapWith(
            pgInt8ToSafeIntegerDecoder,
          ),
      })
      .from(usagePackCreditGrants)
      .where(
        and(
          eq(usagePackCreditGrants.orgId, params.orgId),
          eq(usagePackCreditGrants.userId, params.userId),
          gt(usagePackCreditGrants.expiresAt, at),
          gt(usagePackCreditGrants.remainingAmount, 0),
        ),
      );
    const [balance] = await db
      .select({
        credits: sql`${orgMetadata.credits}`.mapWith(
          nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder),
        ),
        expired: sql`(${expired})`.mapWith(pgInt8ToSafeIntegerDecoder),
        purchased: sql`(${purchased})`.mapWith(pgInt8ToSafeIntegerDecoder),
      })
      .from(orgMetadata)
      .where(eq(orgMetadata.orgId, params.orgId))
      .limit(1);
    signal?.throwIfAborted();
    if (!balance || balance.credits === null) {
      return null;
    }
    const capabilities = await set(
      loadOrgPlanCapabilities$,
      params.orgId,
      signal,
    );
    signal?.throwIfAborted();
    return capabilities
      ? {
          status: capabilities.status,
          supportByok: capabilities.supportByok,
          restrictedBuiltInModels: capabilities.restrictedBuiltInModels,
          spendableCredits: balance.credits - balance.expired,
          usagePackCredits: balance.purchased,
        }
      : null;
  },
);

export const resolveActiveRunCreditAdmission$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly runId?: string;
    },
    signal?: AbortSignal,
  ) => {
    if (!params.runId) {
      return false;
    }
    const db = set(writeDb$);
    const [run] = await db
      .select({
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
    signal?.throwIfAborted();
    return run !== undefined && runHasActiveCreditAdmission(run);
  },
);

/** Admission prepares bounded allowance state before the launch transaction. */
export const checkOrgCreditsForRunAdmission$ = command(
  async (
    { set },
    params: {
      readonly orgId: string;
      readonly userId: string;
      readonly modelProviderType: string | null | undefined;
      readonly selectedModel?: string | null;
    },
    signal?: AbortSignal,
  ): Promise<RunAdmissionFailure | undefined> => {
    if (getRunModelAccess(params.selectedModel) === "retired") {
      return badRequestMessage(RETIRED_RUN_MODEL_MESSAGE);
    }
    const availability = await set(
      resolveOrgCreditAvailability$,
      { orgId: params.orgId, userId: params.userId },
      signal,
    );
    signal?.throwIfAborted();
    if (!availability) {
      return insufficientCredits();
    }
    const denied = checkOrgPlanRunAdmission({
      capabilities: availability,
      modelProviderType: params.modelProviderType,
      selectedModel: params.selectedModel,
    });
    if (denied) {
      return denied;
    }
    if (
      !isBuiltInModelProviderType(params.modelProviderType) ||
      availability.usagePackCredits > 0 ||
      availability.spendableCredits > 0
    ) {
      return undefined;
    }
    const allowance = await set(
      resolveUsageAllowanceAvailability$,
      params.orgId,
      signal,
    );
    signal?.throwIfAborted();
    return allowance && allowance.remainingUnits > 0
      ? undefined
      : insufficientCredits();
  },
);
