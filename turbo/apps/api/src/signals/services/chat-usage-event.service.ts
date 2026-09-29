import { runEventHistory$ } from "./run-event-provenance.service";
import { randomUUID } from "node:crypto";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { chatEventSnapshots } from "@okouai/db/schema/chat-event-snapshot";
import { READABLE_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSIONS } from "./chat-event-snapshot-upgrade.service";
import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import {
  appendCanonicalChatEventsSql,
  chatEventAppendResultSchema,
  type PreparedChatEventRow,
} from "./chat-event-append.service";
import { isDeepStrictEqual } from "node:util";
import { command } from "ccstate";
import { v5 as uuidv5 } from "uuid";
import {
  and,
  count,
  desc,
  eq,
  exists,
  inArray,
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
import {
  buildFinalizedUsageRelation,
  type FinalizedUsageRelation,
} from "./finalized-usage-relation";

const L = logger("ChatUsageMessage");

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

function usageEventContextQuery(runId: string) {
  const queryBuilder = new QueryBuilder();
  const usage = buildFinalizedUsageRelation();
  return queryBuilder
    .select({
      status: agentRuns.status,
      chatThreadId: agentRuns.chatThreadId,
      orgId: agentRuns.orgId,
      userId: chatThreads.userId,
      hasPending: exists(
        queryBuilder
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
        sql`COALESCE(${sum(usageCreditsExpression(usage))}, 0)::bigint`
          .mapWith(pgInt8ToSafeIntegerDecoder)
          .as("total_credits"),
      settledAt: sql`COALESCE(
        ${max(agentRuns.completedAt)},
        ${max(agentRuns.createdAt)}
      )`
        .mapWith(agentRuns.createdAt)
        .as("settled_at"),
    })
    .from(agentRuns)
    .leftJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .leftJoin(usage, eq(usage.runId, agentRuns.id))
    .where(and(eq(agentRuns.id, runId), isNotNull(agentRuns.triggerSource)))
    .groupBy(...USAGE_CONTEXT_GROUP_BY_COLUMNS)
    .limit(1)
    .as("usage_context");
}

function usageBreakdownQuery(runId: string) {
  const queryBuilder = new QueryBuilder();
  const usage = buildFinalizedUsageRelation();
  return queryBuilder
    .select({
      kind: usage.kind,
      provider: sql`COALESCE(NULLIF(${usage.provider}, ''), 'unknown')`
        .mapWith(pgTextDecoder)
        .as("provider"),
      credits: sql`COALESCE(${sum(usageCreditsExpression(usage))}, 0)::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("credits"),
    })
    .from(usage)
    .where(eq(usage.runId, runId))
    .groupBy(usage.kind, usage.provider)
    .orderBy(usage.kind, usage.provider)
    .as("usage_breakdown");
}

interface EmittedRunUsage {
  readonly action: "emitted" | "revised";
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly totalCredits: number;
}

function usageArchiveHeadQuery(threadId: string) {
  return new QueryBuilder()
    .select({
      objectKey: chatEventSnapshots.objectKey,
      lastSeqId: chatEventSnapshots.lastSeqId,
    })
    .from(chatEventSnapshots)
    .where(
      and(
        eq(chatEventSnapshots.chatThreadId, threadId),
        inArray(chatEventSnapshots.archiveSchemaVersion, [
          ...READABLE_CHAT_EVENT_SNAPSHOT_SCHEMA_VERSIONS,
        ]),
      ),
    )
    .orderBy(desc(chatEventSnapshots.archiveSchemaVersion))
    .limit(1)
    .as("usage_archive_head");
}
const prepareRunUsageArchive$ = command(
  async ({ set }, runId: string, signal: AbortSignal) => {
    const db = set(writeDb$);
    const [run] = await db
      .select({ chatThreadId: agentRuns.chatThreadId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);
    signal.throwIfAborted();
    if (!run?.chatThreadId) {
      return null;
    }
    const [hot] = await db
      .select({ id: chatEvents.id })
      .from(chatEvents)
      .where(
        and(eq(chatEvents.runId, runId), chatEventTypeIn(["usage.recorded"])),
      )
      .limit(1);
    signal.throwIfAborted();
    const [head] = await db
      .select()
      .from(usageArchiveHeadQuery(run.chatThreadId));
    signal.throwIfAborted();
    // Canonical archive reads can download R2 objects and must finish before
    // taking the writer's SQL transaction or its outgoing-writer compatibility key.
    const history = hot
      ? undefined
      : await set(runEventHistory$, db, run.chatThreadId, runId, signal);
    signal.throwIfAborted();
    const archived = history
      ? [...history].reverse().find((event) => {
          return event.runId === runId && event.eventType === "usage.recorded";
        })
      : undefined;
    return {
      threadId: run.chatThreadId,
      loaded: !hot,
      head,
      event: archived
        ? { ...archived, createdAt: new Date(archived.createdAt) }
        : undefined,
    };
  },
);
function usageAppendValues(args: {
  readonly runId: string;
  readonly threadId: string;
  readonly payload: ChatEventUsagePayload;
  readonly target:
    | {
        readonly id: string;
        readonly createdAt: Date;
        readonly contextType: string | null;
        readonly contextId: string | null;
      }
    | undefined;
}): PreparedChatEventRow {
  const target = args.target;
  return {
    id: target
      ? randomUUID()
      : uuidv5(`okou:run-usage:${args.runId}`, uuidv5.URL),
    chatThreadId: args.threadId,
    runId: args.runId,
    eventType: "usage.recorded",
    payload: { usage: args.payload },
    contextType: target?.contextType,
    contextId: target?.contextId,
    revokesEventId: target?.id,
    createdAt: target
      ? new Date(Math.max(nowDate().getTime(), target.createdAt.getTime() + 1))
      : new Date(args.payload.settledAt),
  };
}

function usageArchiveMatches(
  archive: {
    readonly loaded: boolean;
    readonly threadId: string;
    readonly head:
      | { readonly objectKey: string; readonly lastSeqId: number }
      | undefined;
  },
  head: { readonly objectKey: string; readonly lastSeqId: number } | undefined,
  threadId: string,
): boolean {
  return (
    archive.loaded &&
    archive.threadId === threadId &&
    head?.objectKey === archive.head?.objectKey &&
    head?.lastSeqId === archive.head?.lastSeqId
  );
}

const emitRunUsageEventAttempt$ = command(
  async (
    { set },
    runId: string,
    signal: AbortSignal,
  ): Promise<EmittedRunUsage | "conflict" | null> => {
    const archive = await set(prepareRunUsageArchive$, runId, signal);
    if (!archive) {
      return null;
    }
    const db = set(writeDb$);
    const emitted = await db.transaction(async (tx) => {
      // DB/API rollout: outgoing writers assign random initial event IDs and
      // do not retry a lost replacement. Retain their key through Release 1;
      // remove it after those serving/in-flight/rollback APIs are gone. Both
      // Release 1 and 2 then use the stable initial ID and unique revoke edge.
      await tx.execute(
        // eslint-disable-next-line api/no-new-advisory-lock -- 2026-09-26 前存量；禁止新增 advisory lock
        sql`SELECT pg_advisory_xact_lock(hashtext('chat_usage_message:' || ${runId}))`,
      );
      signal.throwIfAborted();

      // Initial identity and revoke uniqueness live only in the hot table.
      // Serialize this run's writers before checking its archive pointer, so
      // another writer cannot publish and be retained between that check and
      // our append. NO KEY UPDATE remains compatible with compaction's parent
      // KEY SHARE; run deletion must finish before this owner can proceed.
      const [ownedRun] = await tx
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .for("no key update");
      signal.throwIfAborted();
      if (!ownedRun) {
        return null;
      }

      const [context] = await tx.select().from(usageEventContextQuery(runId));
      signal.throwIfAborted();

      if (!context) {
        return null;
      }
      if (
        !TERMINAL_RUN_STATUSES.includes(
          context.status as (typeof TERMINAL_RUN_STATUSES)[number],
        )
      ) {
        return null;
      }
      if (!context.chatThreadId || !context.userId) {
        return null;
      }
      if (context.hasPending || context.finalizedCount === 0) {
        return null;
      }

      const breakdown = usageBreakdownQuery(runId);
      const breakdownRows = await tx
        .select()
        .from(breakdown)
        .orderBy(breakdown.kind, breakdown.provider);
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

      // If retention moved the hot event, retry preparation. If a snapshot
      // advanced while external data was read, never treat stale absence as a
      // first event; the old writer may have used a random event identity.
      const [head] = hotUsageEvent
        ? []
        : await tx.select().from(usageArchiveHeadQuery(context.chatThreadId));
      if (
        !hotUsageEvent &&
        !usageArchiveMatches(archive, head, context.chatThreadId)
      ) {
        return "conflict" as const;
      }
      const existingUsageEvent = hotUsageEvent ?? archive.event;
      signal.throwIfAborted();

      if (
        existingUsageEvent &&
        isDeepStrictEqual(existingUsageEvent.payload?.usage, payload)
      ) {
        return null;
      }

      const row = usageAppendValues({
        runId,
        threadId: context.chatThreadId,
        payload,
        target: existingUsageEvent,
      });
      const [inserted] = parseRawRows(
        chatEventAppendResultSchema,
        await tx.execute(
          appendCanonicalChatEventsSql(
            [row],
            existingUsageEvent ? "any" : "id",
          ),
        ),
      );
      signal.throwIfAborted();

      if (!inserted) {
        return "conflict" as const;
      }

      return {
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

    return emitted;
  },
);

/** Retry only an observed identity/revoke conflict, using a fresh usage snapshot. */
export const maybeEmitRunUsageEvent$ = command(
  async ({ set }, runId: string, signal: AbortSignal): Promise<boolean> => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const emitted = await set(emitRunUsageEventAttempt$, runId, signal);
      signal.throwIfAborted();
      if (!emitted) {
        return false;
      }
      if (emitted === "conflict") {
        continue;
      }
      await publishChatThreadMessageCreatedSafely({
        userId: emitted.userId,
        orgId: emitted.orgId,
        threadId: emitted.chatThreadId,
      });
      signal.throwIfAborted();
      L.debug(
        emitted.action === "emitted"
          ? "Emitted chat usage message"
          : "Revised chat usage message",
        {
          runId,
          chatThreadId: emitted.chatThreadId,
          totalCredits: emitted.totalCredits,
        },
      );
      return true;
    }
    throw new Error(
      "Run usage publication repeatedly lost its conditional append",
    );
  },
);
