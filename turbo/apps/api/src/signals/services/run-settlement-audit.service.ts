import type {
  RunSettlementAuditQuery,
  RunSettlementAuditResponse,
  RunSettlementBlocker,
} from "@okouai/api-contracts/contracts/run-settlement";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { agentRunCallbacks } from "@okouai/db/schema/agent-run-callback";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { dataRouterRequests } from "@okouai/db/schema/data-router-request";
import { runnerJobQueue } from "@okouai/db/schema/runner-job-queue";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { computed, type Computed } from "ccstate";
import {
  and,
  asc,
  count,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  not,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder, type PgColumn } from "drizzle-orm/pg-core";

import {
  pgBooleanDecoder,
  pgInt8ToSafeIntegerDecoder,
} from "../../lib/db-structured-result";
import { nowDate } from "../../lib/time";
import { db$ } from "../external/db";
import { internalRunCallbackKinds } from "./internal-run-callback";

const terminalStatuses = Object.freeze([
  "completed",
  "failed",
  "cancelled",
  "timeout",
]);
const oneShotKinds = Object.freeze([
  "slack:chat",
  "feishu:chat",
  "teams:chat",
  "telegram:chat",
  "agentphone:chat",
]);
const recoverableInternalKinds = Object.freeze([
  "chat",
  "feishu:org",
  "workflow-automation:cron",
  "workflow-automation:loop",
]);

function callbackCount(runId: PgColumn, condition?: SQL) {
  const query = new QueryBuilder()
    .select({ total: count() })
    .from(agentRunCallbacks)
    .where(and(eq(agentRunCallbacks.runId, runId), condition));
  return sql`(${query})`.mapWith(pgInt8ToSafeIntegerDecoder);
}

function callbackPredicates() {
  const knownKind = or(
    isNull(agentRunCallbacks.internalKind),
    inArray(agentRunCallbacks.internalKind, internalRunCallbackKinds),
  );
  const delivered = and(
    knownKind,
    eq(agentRunCallbacks.status, "delivered"),
    isNotNull(agentRunCallbacks.deliveredAt),
  );
  // These are the existing delivery endpoints, not a new retry policy. A
  // claimed-but-pending one-shot remains unresolved even if its source finished.
  const policyFinished = and(
    isNotNull(agentRunCallbacks.internalKind),
    eq(agentRunCallbacks.status, "failed"),
    isNull(agentRunCallbacks.deliveredAt),
    isNotNull(agentRunCallbacks.lastAttemptAt),
    isNotNull(agentRunCallbacks.lastError),
    or(
      and(
        isNotNull(agentRunCallbacks.internalKind),
        inArray(agentRunCallbacks.internalKind, oneShotKinds),
        eq(agentRunCallbacks.attempts, 1),
      ),
      and(
        eq(agentRunCallbacks.internalKind, "wechat:chat"),
        gt(agentRunCallbacks.attempts, 0),
        eq(agentRunCallbacks.lastError, "WECHAT_DELIVERY_UNKNOWN"),
      ),
    ),
  );
  const pending = and(
    knownKind,
    eq(agentRunCallbacks.status, "pending"),
    isNull(agentRunCallbacks.deliveredAt),
  );
  const recoverableFailure = and(
    or(
      isNull(agentRunCallbacks.internalKind),
      inArray(agentRunCallbacks.internalKind, recoverableInternalKinds),
    ),
    eq(agentRunCallbacks.status, "failed"),
    isNull(agentRunCallbacks.deliveredAt),
  );
  return {
    delivered,
    policyFinished,
    pending,
    recoverableFailure,
    unknown: not(or(delivered, policyFinished, pending, recoverableFailure)!),
  };
}

type RunSettlementObservation = RunSettlementAuditResponse["callbacks"] & {
  readonly id: string;
  readonly status: string;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly cancellationRecoveryCompleted: boolean | null;
  readonly outputMissing: boolean;
  readonly active: boolean;
  readonly runnerJob: boolean;
  readonly terminalEvent: boolean;
  readonly chatCallbacks: number;
  readonly billingLifecycle: boolean;
  readonly pendingUsage: boolean;
  readonly routerRequests: boolean;
};

function auditRuns(input: RunSettlementAuditQuery, createdBefore: Date) {
  const qb = new QueryBuilder();
  return qb.$with("settlement_audit_runs").as(
    qb
      .select({
        id: agentRuns.id,
        status: agentRuns.status,
        userId: agentRuns.userId,
        orgId: agentRuns.orgId,
        chatThreadId: agentRuns.chatThreadId,
        startedAt: agentRuns.startedAt,
        completedAt: agentRuns.completedAt,
        cancellationRecoveryCompleted: agentRuns.cancellationRecoveryCompleted,
        outputMissing: isNull(agentRuns.result)
          .mapWith(pgBooleanDecoder)
          .as("output_missing"),
      })
      .from(agentRuns)
      .where(
        and(
          isNotNull(agentRuns.chatThreadId),
          isNotNull(agentRuns.triggerSource),
          ne(agentRuns.triggerSource, "test"),
          lte(agentRuns.createdAt, createdBefore),
          input.afterRunId ? gt(agentRuns.id, input.afterRunId) : undefined,
        ),
      )
      .orderBy(asc(agentRuns.id))
      .limit(input.limit),
  );
}

function observationFields(runs: ReturnType<typeof auditRuns>) {
  const qb = new QueryBuilder();
  const predicates = callbackPredicates();
  return {
    id: runs.id,
    status: runs.status,
    startedAt: runs.startedAt,
    completedAt: runs.completedAt,
    cancellationRecoveryCompleted: runs.cancellationRecoveryCompleted,
    outputMissing: runs.outputMissing,
    active: exists(
      qb
        .select({ id: activeAgentRuns.runId })
        .from(activeAgentRuns)
        .where(eq(activeAgentRuns.runId, runs.id)),
    ).mapWith(pgBooleanDecoder),
    runnerJob: exists(
      qb
        .select({ id: runnerJobQueue.runId })
        .from(runnerJobQueue)
        .where(eq(runnerJobQueue.runId, runs.id)),
    ).mapWith(pgBooleanDecoder),
    terminalEvent: exists(
      qb
        .select({ id: chatEvents.id })
        .from(chatEvents)
        .where(
          and(
            eq(chatEvents.runId, runs.id),
            eq(chatEvents.chatThreadId, runs.chatThreadId),
            inArray(chatEvents.eventType, [
              "run.completed",
              "run.failed",
              "run.cancelled",
            ]),
            eq(
              chatEvents.eventType,
              sql`CASE ${runs.status} WHEN 'completed' THEN 'run.completed' WHEN 'cancelled' THEN 'run.cancelled' ELSE 'run.failed' END`,
            ),
          ),
        ),
    ).mapWith(pgBooleanDecoder),
    chatCallbacks: callbackCount(
      runs.id,
      eq(agentRunCallbacks.internalKind, "chat"),
    ),
    billingLifecycle: exists(
      qb
        .select({ id: billingRunAttribution.runId })
        .from(billingRunAttribution)
        .where(
          and(
            eq(billingRunAttribution.runId, runs.id),
            eq(billingRunAttribution.orgId, runs.orgId),
            eq(billingRunAttribution.userId, runs.userId),
            eq(billingRunAttribution.threadId, runs.chatThreadId),
            eq(billingRunAttribution.threadContext, "thread"),
            eq(billingRunAttribution.runLifecycleContext, "captured"),
            eq(billingRunAttribution.runTerminalStatus, runs.status),
            eq(billingRunAttribution.runCompletedAt, runs.completedAt),
          ),
        ),
    ).mapWith(pgBooleanDecoder),
    pendingUsage: exists(
      qb
        .select({ id: usageEvent.id })
        .from(usageEvent)
        .where(
          and(
            or(
              eq(usageEvent.runId, runs.id),
              eq(usageEvent.billingRunId, runs.id),
            ),
            eq(usageEvent.status, "pending"),
          ),
        ),
    ).mapWith(pgBooleanDecoder),
    // Router owns settlement; its local correlation rows have no completion
    // receipt. Their existence cannot be interpreted as successful billing.
    routerRequests: exists(
      qb
        .select({ id: dataRouterRequests.requestId })
        .from(dataRouterRequests)
        .where(eq(dataRouterRequests.runId, runs.id)),
    ).mapWith(pgBooleanDecoder),
    delivered: callbackCount(runs.id, predicates.delivered),
    policyFinished: callbackCount(runs.id, predicates.policyFinished),
    pending: callbackCount(runs.id, predicates.pending),
    recoverableFailure: callbackCount(runs.id, predicates.recoverableFailure),
    unknown: callbackCount(runs.id, predicates.unknown),
  };
}

function blockersForRun(row: RunSettlementObservation): RunSettlementBlocker[] {
  const terminal = terminalStatuses.includes(row.status);
  const conditions: readonly (readonly [RunSettlementBlocker, boolean])[] = [
    ["execution_not_terminal", !terminal],
    ["completion_time_missing", terminal && row.completedAt === null],
    ["active_run_present", row.active],
    [
      "cancellation_recovery_pending",
      row.status === "cancelled" &&
        row.startedAt !== null &&
        row.cancellationRecoveryCompleted === false,
    ],
    ["runner_job_present", row.runnerJob],
    ["chat_terminal_evidence_unavailable", terminal && !row.terminalEvent],
    ["chat_callback_identity_unavailable", row.chatCallbacks !== 1],
    [
      "completion_output_missing",
      row.status === "completed" && row.outputMissing,
    ],
    ["billing_lifecycle_unavailable", terminal && !row.billingLifecycle],
    ["usage_pending", row.pendingUsage],
    ["router_settlement_unverified", row.routerRequests],
    ["callback_pending", row.pending > 0],
    ["callback_recoverable_failure", row.recoverableFailure > 0],
    ["callback_outcome_unknown", row.unknown > 0],
  ];
  return conditions
    .filter(([, blocked]) => {
      return blocked;
    })
    .map(([reason]) => {
      return reason;
    });
}

function summarizeObservations(
  rows: readonly RunSettlementObservation[],
  input: RunSettlementAuditQuery,
  createdBefore: Date,
): RunSettlementAuditResponse {
  const blockers = new Map<RunSettlementBlocker, number>();
  const callbacks = {
    delivered: 0,
    policyFinished: 0,
    pending: 0,
    recoverableFailure: 0,
    unknown: 0,
  };
  let observedCompleteRuns = 0;
  for (const row of rows) {
    const reasons = blockersForRun(row);
    for (const reason of reasons) {
      blockers.set(reason, (blockers.get(reason) ?? 0) + 1);
    }
    if (reasons.length === 0) {
      observedCompleteRuns++;
    }
    for (const key of [
      "delivered",
      "policyFinished",
      "pending",
      "recoverableFailure",
      "unknown",
    ] as const) {
      callbacks[key] += row[key];
    }
  }
  const last = rows.at(-1);
  return {
    assessment: "observed_state_only",
    scope: "thread_runs",
    createdBefore: createdBefore.toISOString(),
    scannedRuns: rows.length,
    observedCompleteRuns,
    blockedRuns: rows.length - observedCompleteRuns,
    blockers: [...blockers].map(([reason, runs]) => {
      return { reason, runs };
    }),
    callbacks,
    nextAfterRunId: rows.length === input.limit && last ? last.id : null,
  };
}

/** A bounded observational read. It neither fences late writers nor authorizes deletion. */
export function createRunSettlementAudit(
  input$: Computed<RunSettlementAuditQuery>,
) {
  return computed(async (get): Promise<RunSettlementAuditResponse> => {
    const input = get(input$);
    const createdBefore = input.createdBefore
      ? new Date(input.createdBefore)
      : nowDate();
    const db = get(db$);
    const runs = auditRuns(input, createdBefore);
    const rows = await db
      .with(runs)
      .select(observationFields(runs))
      .from(runs)
      .orderBy(asc(runs.id));
    return summarizeObservations(rows, input, createdBefore);
  });
}
