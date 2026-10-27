import {
  MORNING_BRIEF_OFFICIAL_BLUEPRINT_KEY,
  MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
} from "@okouai/api-contracts/contracts/morning-brief-preference";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { morningBriefEnrollments } from "@okouai/db/schema/morning-brief-enrollment";
import {
  morningBriefScheduleClaims,
  type MorningBriefScheduleClaimSettlement,
} from "@okouai/db/schema/morning-brief-schedule-claim";
import { orgMetadata } from "@okouai/db/schema/org-metadata";
import { workflows } from "@okouai/db/schema/workflow";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { command } from "ccstate";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { boolean, literal, object } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { pgTextDecoder } from "../../lib/db-structured-result";

import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { workflowAutomationColumns } from "./autonomy-budget-schema.service";
import { advanceTimeAutomationAfterCompletion } from "./time-automation";

import {
  MORNING_BRIEF_SETTLEMENT_CLAIM_LOST,
  morningBriefScheduleSettlementClaimCondition,
  morningBriefScheduleSettlementPublicationSql,
  type InFlightScheduleAdvance,
} from "./workflow-schedule-settlement";

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
          inArray(workflows.officialDefinitionName, [
            ...MORNING_BRIEF_OFFICIAL_DEFINITION_NAMES,
          ]),
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
      current.reconciliationStatus === "current"
    );
  },
);

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
    shouldDisable: false,
  });
  const advance: InFlightScheduleAdvance = {
    automationId: args.automationId,
    read: {
      scheduleType: "cron",
      cronExpression: automation.cronExpression,
      intervalSeconds: automation.intervalSeconds,
      timezone: automation.timezone,
    },
    automationValues: {
      consecutiveFailures,
      ...(shouldDisable ? { enabled: false } : {}),
      nextRunAt,
      updatedAt: settledAt,
    },
    at: settledAt,
    requireEmptySlot: true,
  };
  return { shouldDisable, consecutiveFailures, advance };
}

type MorningBriefScheduleSettlementOutcome = {
  readonly orgId: string | null;
  readonly userId: string | null;
  readonly consecutiveFailures: number;
} | null;

/** Another settler already settled this occurrence; roll back this transaction. */
class MorningBriefClaimAlreadySettled extends Error {}

interface PreparedMorningBriefScheduleSettlement {
  readonly automationRevision: string;
  readonly claim: typeof morningBriefScheduleClaims.$inferSelect;
  readonly settledAt: Date;
  readonly plan: ReturnType<typeof officialMorningBriefSettlementPlan>;
}

const morningBriefSettlementPublicationRow = object({
  candidate_present: boolean(),
  automation_current: boolean(),
  advanced: boolean(),
  settled: boolean(),
  assertion: literal(0),
}).strict();

function isMorningBriefSettlementClaimLost(error: unknown): boolean {
  const cause = error instanceof Error ? error.cause : undefined;
  return (
    typeof cause === "object" &&
    cause !== null &&
    "code" in cause &&
    cause.code === "22P02" &&
    "message" in cause &&
    cause.message ===
      `invalid input syntax for type integer: "${MORNING_BRIEF_SETTLEMENT_CLAIM_LOST}"`
  );
}

const prepareMorningBriefSchedulePublication$ = command(
  async (
    { set },
    args: SettleMorningBriefScheduleArgs,
  ): Promise<PreparedMorningBriefScheduleSettlement | null> => {
    const db = set(writeDb$);
    const [observed] = await db
      .select({
        automation: workflowAutomationColumns(),
        revision: sql`${workflowAutomations}.xmin::text`.mapWith(pgTextDecoder),
      })
      .from(workflowAutomations)
      .where(eq(workflowAutomations.id, args.automationId))
      .limit(1);
    if (!observed) {
      return null;
    }
    const [claim] = await db
      .select()
      .from(morningBriefScheduleClaims)
      .where(settlementClaimCondition(args))
      .limit(1);
    if (!claim || claim.settlement !== "unsettled") {
      return null;
    }
    const [current] = await db
      .select({ claimSequence: morningBriefScheduleClaims.claimSequence })
      .from(morningBriefScheduleClaims)
      .where(eq(morningBriefScheduleClaims.automationId, args.automationId))
      .orderBy(desc(morningBriefScheduleClaims.claimSequence))
      .limit(1);
    if (current?.claimSequence !== claim.claimSequence) {
      return null;
    }
    const settledAt = nowDate();
    return {
      automationRevision: observed.revision,
      claim,
      settledAt,
      plan: officialMorningBriefSettlementPlan(
        observed.automation,
        args,
        settledAt,
      ),
    };
  },
);

const publishMorningBriefScheduleSettlement$ = command(
  async (
    { set },
    args: SettleMorningBriefScheduleArgs,
    prepared: PreparedMorningBriefScheduleSettlement,
  ): Promise<MorningBriefScheduleSettlementOutcome> => {
    const db = set(writeDb$);
    const identity = {
      automationId: args.automationId,
      claimId: prepared.claim.id,
      claimSequence: prepared.claim.claimSequence,
    };
    const statement = morningBriefScheduleSettlementPublicationSql({
      ...identity,
      automationRevision: prepared.automationRevision,
      settlement: args.settlement,
      settledAt: prepared.settledAt,
      advance: prepared.plan?.advance ?? null,
    });
    const executed = await settle(
      (async () => {
        return parseRawRows(
          morningBriefSettlementPublicationRow,
          await db.execute(statement),
        );
      })(),
    );
    if (!executed.ok) {
      if (isMorningBriefSettlementClaimLost(executed.error)) {
        throw new MorningBriefClaimAlreadySettled();
      }
      throw executed.error;
    }
    const [receipt] = executed.value;
    if (
      executed.value.length !== 1 ||
      !receipt ||
      (receipt.advanced && !receipt.settled)
    ) {
      throw new Error("Invalid Morning Brief settlement publication receipt");
    }
    if (!receipt.candidate_present) {
      return null;
    }
    if (
      !receipt.automation_current ||
      (prepared.plan !== null && !receipt.advanced)
    ) {
      const [current] = await db
        .select({ id: morningBriefScheduleClaims.id })
        .from(morningBriefScheduleClaims)
        .where(morningBriefScheduleSettlementClaimCondition(identity))
        .limit(1);
      if (!current) {
        return null;
      }
      throw new Error("Morning Brief schedule changed while settling; retry");
    }
    const outcome =
      prepared.plan?.shouldDisable && receipt.advanced && receipt.settled
        ? {
            orgId: prepared.claim.orgId,
            userId: prepared.claim.ownerUserId,
            consecutiveFailures: prepared.plan.consecutiveFailures,
          }
        : null;
    if (outcome) {
      // Publication already committed; report an actual pause before the caller observes cancellation.
      log.warn(
        "Morning Brief paused after consecutive failures; recovery is scheduled",
        { automationId: args.automationId, ...outcome },
      );
    }
    return outcome;
  },
);

/** Settle the Official occurrence and its successor in one atomic publication. */
const commitMorningBriefScheduleSettlement$ = command(
  async (
    { set },
    args: SettleMorningBriefScheduleArgs,
    signal?: AbortSignal,
  ): Promise<void> => {
    const result = await settle(
      (async () => {
        const prepared = await set(
          prepareMorningBriefSchedulePublication$,
          args,
        );
        signal?.throwIfAborted();
        if (!prepared) {
          return null;
        }
        const outcome = await set(
          publishMorningBriefScheduleSettlement$,
          args,
          prepared,
        );
        signal?.throwIfAborted();
        return outcome;
      })(),
      signal,
    );
    signal?.throwIfAborted();
    if (!result.ok) {
      if (result.error instanceof MorningBriefClaimAlreadySettled) {
        return;
      }
      throw result.error;
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
