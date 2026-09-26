import { runEventHistory } from "./run-event-provenance.service";
import { isDeepStrictEqual } from "node:util";
import { command } from "ccstate";
import {
  and,
  count,
  desc,
  eq,
  exists,
  isNotNull,
  max,
  sql,
  sum,
} from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  chatEvents,
  type ChatEventUsageKindBreakdown,
  type ChatEventUsagePayload,
  type ChatEventUsageProviderBreakdown,
} from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { usageEvent } from "@okouai/db/schema/usage-event";

import {
  pgBooleanDecoder,
  pgIntegerDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { chatEventTypeIn } from "./chat-event-type.service";
import { insertChatEvent, replaceLoadedChatEvent } from "./chat-event.service";
import {
  buildFinalizedUsageRelation,
  type FinalizedUsageRelation,
} from "./finalized-usage-relation";
import type { Tx } from "../../lib/db-types";

const L = logger("ChatUsageMessage");
type WriteTx = Tx;

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;
const USAGE_CONTEXT_GROUP_BY_COLUMNS = [
  agentRuns.status,
  agentRuns.chatThreadId,
  agentRuns.orgId,
  chatThreads.userId,
] as const;

function buildUsageBreakdown(
  rows: readonly {
    readonly kind: string;
    readonly provider: string;
    readonly credits: number;
  }[],
): readonly ChatEventUsageKindBreakdown[] {
  const byKind = new Map<string, ChatEventUsageProviderBreakdown[]>();
  for (const row of rows) {
    const providers = byKind.get(row.kind) ?? [];
    providers.push({
      provider: row.provider,
      credits: Math.max(0, row.credits),
    });
    byKind.set(row.kind, providers);
  }

  return Array.from(byKind.entries()).map(([kind, providers]) => {
    const credits = providers.reduce((sum, provider) => {
      return sum + provider.credits;
    }, 0);
    return { kind, credits, providers };
  });
}

function usageCreditsExpression(usage: FinalizedUsageRelation) {
  return sql`${usage.creditsCharged} + ${usage.allowanceUnits}`;
}

async function loadUsageEventContext(tx: WriteTx, runId: string) {
  const usage = buildFinalizedUsageRelation();
  return await tx
    .select({
      status: agentRuns.status,
      chatThreadId: agentRuns.chatThreadId,
      orgId: agentRuns.orgId,
      userId: chatThreads.userId,
      hasPending: exists(
        tx
          .select({ id: usageEvent.id })
          .from(usageEvent)
          .where(
            and(eq(usageEvent.runId, runId), eq(usageEvent.status, "pending")),
          ),
      )
        .mapWith(pgBooleanDecoder)
        .as("has_pending"),
      finalizedCount: sql`${count(usage.orgId)}::int`
        .mapWith(pgIntegerDecoder)
        .as("finalized_count"),
      totalCredits:
        sql`COALESCE(${sum(usageCreditsExpression(usage))}, 0)::bigint`.mapWith(
          pgInt8ToSafeIntegerDecoder,
        ),
      settledAt: sql`COALESCE(
        ${max(agentRuns.completedAt)},
        ${max(agentRuns.createdAt)}
      )`.mapWith(agentRuns.createdAt),
    })
    .from(agentRuns)
    .leftJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .leftJoin(usage, eq(usage.runId, agentRuns.id))
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .groupBy(...USAGE_CONTEXT_GROUP_BY_COLUMNS)
    .limit(1);
}

async function loadUsageBreakdownRows(tx: WriteTx, runId: string) {
  const usage = buildFinalizedUsageRelation();
  return await tx
    .select({
      kind: usage.kind,
      provider: sql`COALESCE(NULLIF(${usage.provider}, ''), 'unknown')`.mapWith(
        pgTextDecoder,
      ),
      credits:
        sql`COALESCE(${sum(usageCreditsExpression(usage))}, 0)::bigint`.mapWith(
          pgInt8ToSafeIntegerDecoder,
        ),
    })
    .from(usage)
    .where(eq(usage.runId, runId))
    .groupBy(usage.kind, usage.provider)
    .orderBy(usage.kind, usage.provider);
}

export type RunUsageProjectionResult =
  | "updated"
  | "unchanged"
  | "deferred"
  | "discarded";

function logRunUsageProjection(emitted: {
  readonly action: "emitted" | "revised";
  readonly runId: string;
  readonly chatThreadId: string;
  readonly totalCredits: number;
}): void {
  L.debug(
    emitted.action === "emitted"
      ? "Emitted chat usage message"
      : "Revised chat usage message",
    {
      runId: emitted.runId,
      chatThreadId: emitted.chatThreadId,
      totalCredits: emitted.totalCredits,
    },
  );
}

/** The content-owned projection result also tells the durable worker when to retry. */
export const projectRunUsageEvent$ = command(
  async (
    { set },
    runId: string,
    signal: AbortSignal,
  ): Promise<RunUsageProjectionResult> => {
    const db = set(writeDb$);
    const emitted = await db.transaction(async (tx) => {
      // Multiple terminal side effects can attempt emission for the same run.
      await tx.execute(
        // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
        sql`SELECT pg_advisory_xact_lock(hashtext('chat_usage_message:' || ${runId}))`,
      );
      signal.throwIfAborted();

      const [context] = await loadUsageEventContext(tx, runId);
      signal.throwIfAborted();

      if (!context) {
        return { state: "discarded" as const };
      }
      if (
        !TERMINAL_RUN_STATUSES.includes(
          context.status as (typeof TERMINAL_RUN_STATUSES)[number],
        )
      ) {
        return { state: "deferred" as const };
      }
      if (!context.chatThreadId || !context.userId) {
        return { state: "discarded" as const };
      }
      if (context.hasPending) {
        return { state: "deferred" as const };
      }
      if (context.finalizedCount === 0) {
        return { state: "unchanged" as const };
      }

      const breakdownRows = await loadUsageBreakdownRows(tx, runId);
      signal.throwIfAborted();

      const payload: ChatEventUsagePayload = {
        version: 1,
        totalCredits: Math.max(0, context.totalCredits),
        settledAt: context.settledAt.toISOString(),
        breakdown: buildUsageBreakdown(breakdownRows),
      };

      const [hotUsageEvent] = await tx
        .select({
          id: chatEvents.id,
          chatThreadId: chatEvents.chatThreadId,
          createdAt: chatEvents.createdAt,
          eventType: chatEvents.eventType,
          contextType: chatEvents.contextType,
          contextId: chatEvents.contextId,
          payload: chatEvents.payload,
        })
        .from(chatEvents)
        .where(
          and(eq(chatEvents.runId, runId), chatEventTypeIn(["usage.recorded"])),
        )
        .orderBy(desc(chatEvents.seqId))
        .limit(1);
      signal.throwIfAborted();

      // An archived usage event is only found through canonical history.
      const history = hotUsageEvent
        ? undefined
        : await runEventHistory(tx, context.chatThreadId, runId, signal);
      const archivedUsageEvent = history
        ? [...history].reverse().find((event) => {
            return (
              event.runId === runId && event.eventType === "usage.recorded"
            );
          })
        : undefined;
      const existingUsageEvent =
        hotUsageEvent ??
        (archivedUsageEvent
          ? {
              ...archivedUsageEvent,
              createdAt: new Date(archivedUsageEvent.createdAt),
            }
          : undefined);
      signal.throwIfAborted();

      if (
        existingUsageEvent &&
        isDeepStrictEqual(existingUsageEvent.payload?.usage, payload)
      ) {
        return { state: "unchanged" as const };
      }

      const event = {
        chatThreadId: context.chatThreadId,
        eventType: "usage.recorded" as const,
        content: null,
        runId,
        // A replacement inherits the exact context pointer, including null.
        usagePayload: payload,
      };
      const inserted = existingUsageEvent
        ? await replaceLoadedChatEvent(tx, existingUsageEvent, event)
        : await insertChatEvent(tx, {
            ...event,
            createdAt: new Date(payload.settledAt),
          });
      signal.throwIfAborted();

      if (!inserted) {
        return { state: "deferred" as const };
      }

      return {
        state: "updated" as const,
        action: existingUsageEvent
          ? ("revised" as const)
          : ("emitted" as const),
        chatThreadId: context.chatThreadId,
        orgId: context.orgId,
        userId: context.userId,
        totalCredits: payload.totalCredits,
      };
    });
    signal.throwIfAborted();

    if (emitted.state !== "updated") {
      return emitted.state;
    }

    await publishChatThreadMessageCreatedSafely({
      userId: emitted.userId,
      orgId: emitted.orgId,
      threadId: emitted.chatThreadId,
    });
    signal.throwIfAborted();

    logRunUsageProjection({ ...emitted, runId });

    return "updated";
  },
);

/** Retain the prior boolean surface for old postcommit callers. */
export const maybeEmitRunUsageEvent$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<boolean> => {
    return (await set(projectRunUsageEvent$, runId, signal)) === "updated";
  },
);
