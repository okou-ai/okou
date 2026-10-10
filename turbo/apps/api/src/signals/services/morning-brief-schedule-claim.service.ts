import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import {
  morningBriefScheduleClaims,
  type MorningBriefScheduleClaimSettlement,
} from "@okouai/db/schema/morning-brief-schedule-claim";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { workflowAutomations, workflows } from "@okouai/db/schema/workflow";
import { command } from "ccstate";
import { and, asc, desc, eq, exists, gt, type SQL } from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";

import type { Tx } from "../../lib/db-types";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$, type Db } from "../external/db";
import { settle } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";

import { advanceInFlightSchedule } from "./workflow-schedule-settlement";

type AutomationRow = typeof workflowAutomations.$inferSelect;

const log = logger("MorningBriefScheduleClaim");

/** Matches the Official poller and callback policy; they share one constant. */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * Whether the poller should journal this automation.
 *
 * Only the installation S1's canonical selection reports as the member's
 * installed Morning Brief is journaled. The cheap blueprint predicate keeps the
 * canonical read off every unrelated due automation.
 */
function canJournalMorningBrief(automation: AutomationRow) {
  return (
    automation.kind === "schedule" &&
    automation.scheduleType === "cron" &&
    automation.officialBlueprintKey === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY
  );
}

export const isCanonicalMorningBriefAutomation$ = command(
  async (
    { set },
    automation: AutomationRow,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (!canJournalMorningBrief(automation)) {
      return false;
    }
    const db = set(writeDb$);
    const owner = { orgId: automation.orgId, userId: automation.ownerUserId };
    const [enrollment] = await db
      .select({ workflowId: morningBriefEnrollments.workflowId })
      .from(morningBriefEnrollments)
      .where(
        and(
          eq(morningBriefEnrollments.orgId, owner.orgId),
          eq(morningBriefEnrollments.userId, owner.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    const installations = await db
      .select({
        id: workflows.id,
        installationState: workflows.officialInstallationState,
        agentId: workflows.agentId,
      })
      .from(workflows)
      .where(
        and(
          eq(workflows.orgId, owner.orgId),
          eq(workflows.ownerUserId, owner.userId),
          eq(workflows.visibility, "private"),
          eq(
            workflows.officialDefinitionName,
            MORNING_BRIEF_OFFICIAL_DEFINITION_NAME,
          ),
        ),
      )
      .orderBy(asc(workflows.createdAt), asc(workflows.id));
    signal.throwIfAborted();
    let selected =
      installations.length <= 1
        ? installations[0]
        : installations.find((installation) => {
            return installation.id === enrollment?.workflowId;
          });
    if (!selected && installations.length > 1) {
      const [candidate] = await db
        .select({
          id: agents.id,
          owner: agents.owner,
          visibility: agents.visibility,
        })
        .from(orgMetadata)
        .leftJoin(
          agents,
          and(
            eq(agents.id, orgMetadata.defaultAgentId),
            eq(agents.orgId, orgMetadata.orgId),
          ),
        )
        .where(eq(orgMetadata.orgId, owner.orgId))
        .limit(1);
      signal.throwIfAborted();
      const defaultAgentId =
        candidate?.id &&
        (candidate.visibility !== "private" || candidate.owner === owner.userId)
          ? candidate.id
          : null;
      selected =
        installations.find((installation) => {
          return installation.agentId === defaultAgentId;
        }) ?? installations[0];
    }
    if (selected?.installationState !== "installed") {
      return false;
    }
    const rows = await db
      .select({
        id: workflowAutomations.id,
        kind: workflowAutomations.kind,
        scheduleType: workflowAutomations.scheduleType,
        blueprintKey: workflowAutomations.officialBlueprintKey,
        reconciliationStatus: workflowAutomations.officialReconciliationStatus,
        resultEmailEnabled: workflowAutomations.officialResultEmailEnabled,
      })
      .from(workflowAutomations)
      .where(
        and(
          eq(workflowAutomations.orgId, owner.orgId),
          eq(workflowAutomations.ownerUserId, owner.userId),
          eq(workflowAutomations.workflowId, selected.id),
        ),
      )
      .limit(2);
    signal.throwIfAborted();
    const current = rows[0];
    return (
      rows.length === 1 &&
      current?.id === automation.id &&
      current.kind === "schedule" &&
      current.scheduleType === "cron" &&
      current.blueprintKey === MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY &&
      current.reconciliationStatus === "current" &&
      // Both legacy completion mail and Agent-controlled delivery are valid.
      current.resultEmailEnabled !== null
    );
  },
);

type MorningBriefScheduleRevocationScope =
  | {
      readonly kind: "membership";
      readonly orgId: string;
      readonly userId: string;
    }
  | { readonly kind: "user"; readonly userId: string }
  | { readonly kind: "organization"; readonly orgId: string };

function revocationWhere(scope: MorningBriefScheduleRevocationScope): SQL {
  if (scope.kind === "membership") {
    return and(
      eq(morningBriefScheduleClaims.orgId, scope.orgId),
      eq(morningBriefScheduleClaims.ownerUserId, scope.userId),
    ) as SQL;
  }
  return scope.kind === "user"
    ? eq(morningBriefScheduleClaims.ownerUserId, scope.userId)
    : eq(morningBriefScheduleClaims.orgId, scope.orgId);
}

/**
 * Revoke this scope's legacy schedule occurrences inside a cleanup transaction.
 *
 * `workflows.owner_user_id` and `workflow_automations.owner_user_id` are plain
 * text with no users foreign key, and user cleanup retains every Agent, so a
 * departing member would keep this journal if an Agent cascade were the only
 * path. This runs at the same owner, organization and membership
 * revocation points the rest of Morning Brief already uses.
 *
 * It scrubs owner identity rather than deleting the row. Deleting would make a
 * callback that is still in flight look like an execution this table never
 * recorded, which is exactly the untracked legacy branch that may advance a
 * schedule. What remains is content-free: automation, workflow, occurrence
 * identity and timestamps, with a terminal `revoked` settlement that makes any
 * later callback a no-op. Only this scope's own occurrences change; no
 * automation, workflow or other owner is touched.
 */
export async function revokeMorningBriefScheduleOwnership(
  executor: Pick<Db, "update"> | Tx,
  scope: MorningBriefScheduleRevocationScope,
): Promise<void> {
  const revokedAt = nowDate();
  await executor
    .update(morningBriefScheduleClaims)
    .set({
      orgId: null,
      ownerUserId: null,
      settlement: "revoked",
      settledAt: revokedAt,
      updatedAt: revokedAt,
    })
    .where(revocationWhere(scope));
}

/** How the caller identifies the occurrence it is settling. */
type MorningBriefScheduleSettlementSubject =
  | { readonly kind: "claim"; readonly claimId: string }
  | { readonly kind: "run"; readonly runId: string };

interface SettleMorningBriefScheduleInput {
  readonly automationId: string;
  readonly subject: MorningBriefScheduleSettlementSubject;
  readonly settlement: Exclude<
    MorningBriefScheduleClaimSettlement,
    "unsettled"
  >;
  readonly isCreditError?: boolean;
}

interface SettleMorningBriefScheduleArgs extends SettleMorningBriefScheduleInput {
  readonly isCreditError: boolean;
}

function settlementClaimCondition(args: SettleMorningBriefScheduleInput) {
  return and(
    eq(morningBriefScheduleClaims.automationId, args.automationId),
    args.subject.kind === "claim"
      ? eq(morningBriefScheduleClaims.id, args.subject.claimId)
      : eq(morningBriefScheduleClaims.runId, args.subject.runId),
  );
}

const prepareMorningBriefScheduleSettlement$ = command(
  async (
    { set },
    args: SettleMorningBriefScheduleInput,
    signal?: AbortSignal,
  ): Promise<SettleMorningBriefScheduleArgs | null> => {
    const db = set(writeDb$);
    const [binding] = await db
      .select({
        orgId: morningBriefScheduleClaims.orgId,
        userId: morningBriefScheduleClaims.ownerUserId,
        workflowId: morningBriefScheduleClaims.workflowId,
      })
      .from(morningBriefScheduleClaims)
      .where(settlementClaimCondition(args))
      .limit(1);
    signal?.throwIfAborted();
    if (!binding) {
      return null;
    }
    let isCreditError = args.isCreditError ?? false;
    if (args.subject.kind === "run" && args.settlement !== "completed") {
      // The exact journal binding authorizes this read; no unrelated Run is inspected.
      const [run] = await db
        .select({ failureReason: agentRuns.failureReason })
        .from(agentRuns)
        .where(eq(agentRuns.id, args.subject.runId))
        .limit(1);
      signal?.throwIfAborted();
      isCreditError = run?.failureReason === "insufficient_credits";
    }
    return { ...args, isCreditError };
  },
);

function officialMorningBriefSettlementPlan(
  automation: AutomationRow,
  args: SettleMorningBriefScheduleArgs,
  settledAt: Date,
) {
  if (
    !automation.enabled ||
    automation.nextRunAt !== null ||
    automation.scheduleType !== "cron"
  ) {
    return null;
  }
  const consecutiveFailures =
    args.settlement === "completed"
      ? 0
      : automation.consecutiveFailures + (args.isCreditError ? 0 : 1);
  const shouldDisable =
    !args.isCreditError && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES;
  const nextRunAt = advanceTimeAutomationAfterCompletion({
    scheduleType: "cron",
    cronExpression: automation.cronExpression,
    intervalSeconds: automation.intervalSeconds,
    timezone: automation.timezone,
    completedAt: settledAt,
    shouldDisable,
  });
  return {
    shouldDisable,
    consecutiveFailures,
    automationValues: {
      consecutiveFailures,
      ...(shouldDisable ? { enabled: false } : {}),
      ...(shouldDisable ? { officialIntendedEnabled: false } : {}),
      nextRunAt,
      updatedAt: settledAt,
    },
  };
}

type MorningBriefScheduleSettlementOutcome = {
  readonly orgId: string | null;
  readonly userId: string | null;
  readonly consecutiveFailures: number;
} | null;

/** Another settler already settled this occurrence; roll back this transaction. */
class MorningBriefClaimAlreadySettled extends Error {}

/** Settle a current claim exactly once; publishing a successor and the claim share rollback authority. */
async function attemptMorningBriefScheduleSettlement(
  tx: Tx,
  args: SettleMorningBriefScheduleArgs,
): Promise<MorningBriefScheduleSettlementOutcome> {
  const [automation] = await tx
    .select(workflowAutomationColumns())
    .from(workflowAutomations)
    .where(eq(workflowAutomations.id, args.automationId))
    .limit(1);
  if (!automation) {
    return null;
  }
  const [claim] = await tx
    .select()
    .from(morningBriefScheduleClaims)
    .where(settlementClaimCondition(args))
    .limit(1);
  if (!claim || claim.settlement !== "unsettled") {
    return null;
  }
  const [current] = await tx
    .select({ claimSequence: morningBriefScheduleClaims.claimSequence })
    .from(morningBriefScheduleClaims)
    .where(eq(morningBriefScheduleClaims.automationId, args.automationId))
    .orderBy(desc(morningBriefScheduleClaims.claimSequence))
    .limit(1);
  if (current?.claimSequence !== claim.claimSequence) {
    return null;
  }
  const settledAt = nowDate();
  const plan = officialMorningBriefSettlementPlan(automation, args, settledAt);
  const advanced = plan
    ? await advanceInFlightSchedule(tx, {
        automationId: args.automationId,
        read: {
          scheduleType: "cron",
          cronExpression: automation.cronExpression,
          intervalSeconds: automation.intervalSeconds,
          timezone: automation.timezone,
        },
        automationValues: plan.automationValues,
        at: settledAt,
        requireEmptySlot: true,
      })
    : "superseded";
  const [settled] = await tx
    .update(morningBriefScheduleClaims)
    .set({ settlement: args.settlement, settledAt, updatedAt: settledAt })
    .where(
      and(
        eq(morningBriefScheduleClaims.id, claim.id),
        eq(morningBriefScheduleClaims.settlement, "unsettled"),
      ),
    )
    .returning({ id: morningBriefScheduleClaims.id });
  if (!settled) {
    // Another settler won this occurrence; discard everything written here.
    throw new MorningBriefClaimAlreadySettled();
  }
  return plan?.shouldDisable && advanced === "advanced"
    ? {
        orgId: claim.orgId,
        userId: claim.ownerUserId,
        consecutiveFailures: plan.consecutiveFailures,
      }
    : null;
}

/** Settle the Official occurrence and its successor in one commit. */
const commitMorningBriefScheduleSettlement$ = command(
  async (
    { set },
    args: SettleMorningBriefScheduleArgs,
    signal?: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const result = await settle(
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0189; new non-billing transactions are prohibited.
      db.transaction(async (tx) => {
        const attempted = await attemptMorningBriefScheduleSettlement(tx, args);
        signal?.throwIfAborted();
        return attempted;
      }),
      signal,
    );
    signal?.throwIfAborted();
    if (!result.ok) {
      if (result.error instanceof MorningBriefClaimAlreadySettled) {
        return;
      }
      throw result.error;
    }
    if (result.value) {
      log.debug(
        "Morning Brief schedule auto-disabled after consecutive failures",
        { automationId: args.automationId, ...result.value },
      );
    }
  },
);

export const settleMorningBriefScheduleForRun$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly runId: string;
      readonly settlement: Exclude<
        MorningBriefScheduleClaimSettlement,
        "unsettled" | "pre_run_failure"
      >;
    },
    signal?: AbortSignal,
  ): Promise<boolean> => {
    const prepared = await set(
      prepareMorningBriefScheduleSettlement$,
      {
        automationId: args.automationId,
        subject: { kind: "run", runId: args.runId },
        settlement: args.settlement,
      },
      signal,
    );
    if (!prepared) {
      return false;
    }
    await set(commitMorningBriefScheduleSettlement$, prepared, signal);
    return true;
  },
);

export const settleMorningBriefSchedulePreRunFailure$ = command(
  async (
    { set },
    args: {
      readonly automationId: string;
      readonly claimId: string;
      readonly isCreditError: boolean;
    },
    signal?: AbortSignal,
  ): Promise<void> => {
    const prepared = await set(
      prepareMorningBriefScheduleSettlement$,
      {
        automationId: args.automationId,
        subject: { kind: "claim", claimId: args.claimId },
        settlement: "pre_run_failure",
        isCreditError: args.isCreditError,
      },
      signal,
    );
    if (prepared) {
      await set(commitMorningBriefScheduleSettlement$, prepared, signal);
    }
  },
);

export const morningBriefScheduleClaimBound$ = command(
  async ({ get }, runId: string, signal: AbortSignal): Promise<boolean> => {
    const [bound] = await get(db$)
      .select({ id: morningBriefScheduleClaims.id })
      .from(morningBriefScheduleClaims)
      .where(eq(morningBriefScheduleClaims.runId, runId))
      .limit(1);
    signal.throwIfAborted();
    return bound !== undefined;
  },
);

/** Pure predicate, evaluated by the post-commit owner after its existing lock. */
export function morningBriefScheduleClaimSupersededCondition(runId: string) {
  const own = alias(morningBriefScheduleClaims, "own_schedule_claim");
  const successor = alias(
    morningBriefScheduleClaims,
    "successor_schedule_claim",
  );
  return exists(
    new QueryBuilder()
      .select({ id: successor.id })
      .from(own)
      .innerJoin(
        successor,
        and(
          eq(successor.automationId, own.automationId),
          gt(successor.claimSequence, own.claimSequence),
        ),
      )
      .where(eq(own.runId, runId)),
  );
}
