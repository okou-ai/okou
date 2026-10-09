import {
  CHAT_THREAD_USAGE_RUN_LIMIT,
  type ChatEventUsagePayload,
} from "@okouai/api-contracts/contracts/chat-threads";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq, inArray, isNull, notExists, or, sql, sum } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

import {
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";
import { buildFinalizedUsageRelation } from "./finalized-usage-relation";

const TERMINAL_RUN_STATUSES = ["completed", "failed", "cancelled"] as const;

interface RunUsageScope {
  readonly runIds: readonly string[];
  readonly threadId?: string;
  readonly orgId?: string;
  readonly userId?: string;
}

/** SQL only. Canonical billing identity survives raw-event compaction and run erasure. */
function settledRunUsageQuery(args: RunUsageScope) {
  const usage = buildFinalizedUsageRelation();
  const query = new QueryBuilder();
  const runId = sql`COALESCE(${usage.billingRunId}, ${usage.runId})`;
  const provider = sql`COALESCE(NULLIF(${usage.provider}, ''), 'unknown')`;
  // Existing unknown attribution can use its still-live Run. Explicitly
  // threadless billing identity never borrows a later content association.
  const threadId = sql`CASE
    WHEN ${billingRunAttribution.threadContext} = 'thread' THEN ${billingRunAttribution.threadId}
    WHEN ${billingRunAttribution.threadContext} = 'threadless' THEN NULL
    ELSE ${agentRuns.chatThreadId} END`;
  return query
    .select({
      runId: sql`${runId}::text`.mapWith(pgTextDecoder).as("run_id"),
      chatThreadId: chatThreads.id,
      orgId: usage.orgId,
      userId: chatThreads.userId,
      kind: usage.kind,
      provider: provider.mapWith(pgTextDecoder).as("provider"),
      credits: sql`COALESCE(${sum(usage.creditsCharged)}, 0)::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("credits"),
      settledAt:
        sql`COALESCE(MAX(${agentRuns.completedAt}), MAX(${billingRunAttribution.runStartedAt}), MAX(${agentRuns.createdAt}), MAX(${usage.processedHour}))`
          .mapWith(agentRuns.createdAt)
          .as("settled_at"),
    })
    .from(usage)
    .leftJoin(
      billingRunAttribution,
      and(
        eq(billingRunAttribution.runId, usage.billingRunId),
        eq(billingRunAttribution.orgId, usage.orgId),
        eq(billingRunAttribution.userId, usage.userId),
      ),
    )
    .leftJoin(
      agentRuns,
      and(eq(agentRuns.id, usage.runId), eq(agentRuns.orgId, usage.orgId)),
    )
    .innerJoin(
      chatThreads,
      and(eq(chatThreads.id, threadId), eq(chatThreads.userId, usage.userId)),
    )
    .innerJoin(
      agents,
      and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, usage.orgId)),
    )
    .where(
      and(
        or(
          inArray(usage.billingRunId, [...args.runIds]),
          and(
            isNull(usage.billingRunId),
            inArray(usage.runId, [...args.runIds]),
          ),
        ),
        args.threadId === undefined
          ? undefined
          : eq(chatThreads.id, args.threadId),
        args.orgId === undefined ? undefined : eq(agents.orgId, args.orgId),
        args.userId === undefined
          ? undefined
          : eq(chatThreads.userId, args.userId),
        or(
          isNull(agentRuns.id),
          inArray(agentRuns.status, [...TERMINAL_RUN_STATUSES]),
        ),
        notExists(
          query
            .select({ id: usageEvent.id })
            .from(usageEvent)
            .where(
              and(
                eq(usageEvent.orgId, usage.orgId),
                eq(usageEvent.userId, usage.userId),
                eq(usageEvent.status, "pending"),
                sql`COALESCE(${usageEvent.billingRunId}, ${usageEvent.runId}) = ${runId}`,
              ),
            ),
        ),
      ),
    )
    .groupBy(
      runId,
      chatThreads.id,
      usage.orgId,
      chatThreads.userId,
      usage.kind,
      provider,
    )
    .orderBy(runId, usage.kind, provider)
    .as("settled_run_usage");
}

interface RunUsageRow {
  readonly runId: string;
  readonly chatThreadId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly kind: string;
  readonly provider: string;
  readonly credits: number;
  readonly settledAt: Date;
}

function groupRunUsage(rows: readonly RunUsageRow[]) {
  const grouped = new Map<
    string,
    {
      runId: string;
      chatThreadId: string;
      orgId: string;
      userId: string;
      usage: ChatEventUsagePayload;
    }
  >();
  for (const row of rows) {
    const run = grouped.get(row.runId) ?? {
      runId: row.runId,
      chatThreadId: row.chatThreadId,
      orgId: row.orgId,
      userId: row.userId,
      usage: {
        version: 1 as const,
        totalCredits: 0,
        settledAt: row.settledAt.toISOString(),
        breakdown: [],
      },
    };
    const credits = Math.max(0, row.credits);
    const kind = run.usage.breakdown.find((item) => {
      return item.kind === row.kind;
    });
    const breakdown = kind
      ? run.usage.breakdown.map((item) => {
          return item === kind
            ? {
                ...item,
                credits: item.credits + credits,
                providers: [
                  ...item.providers,
                  { provider: row.provider, credits },
                ],
              }
            : item;
        })
      : [
          ...run.usage.breakdown,
          {
            kind: row.kind,
            credits,
            providers: [{ provider: row.provider, credits }],
          },
        ];
    grouped.set(row.runId, {
      ...run,
      usage: {
        ...run.usage,
        totalCredits: run.usage.totalCredits + credits,
        breakdown,
      },
    });
  }
  return [...grouped.values()];
}

export const readSettledRunUsage$ = command(
  async ({ set }, args: RunUsageScope, signal: AbortSignal) => {
    if (
      args.runIds.length === 0 ||
      args.runIds.length > CHAT_THREAD_USAGE_RUN_LIMIT
    ) {
      throw new Error("Invalid chat usage batch size");
    }
    const db = set(writeDb$);
    const rows = await db.select().from(settledRunUsageQuery(args));
    signal.throwIfAborted();
    return groupRunUsage(rows);
  },
);

export const readChatThreadUsage$ = command(
  async (
    { set },
    args: {
      readonly threadId: string;
      readonly orgId: string;
      readonly userId: string;
      readonly runIds: readonly string[];
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [thread] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(chatThreads.id, args.threadId),
          eq(agents.orgId, args.orgId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!thread) {
      return null;
    }
    const runs = await set(readSettledRunUsage$, args, signal);
    return {
      runs: runs.map(({ runId, usage }) => {
        return { runId, usage };
      }),
    };
  },
);
