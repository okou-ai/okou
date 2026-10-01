import { command } from "ccstate";
import type {
  UsageRecordResponse,
  UsageRecordScope,
} from "@okouai/api-contracts/contracts/usage-record";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { usageEvent } from "@okouai/db/schema/usage-event";
import {
  and,
  asc,
  count,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  max,
  sql,
  sum,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { writeDb$ } from "../external/db";
import {
  buildFinalizedUsageRelation,
  type FinalizedUsageRelation,
} from "./finalized-usage-relation";
import { normalizeFinalizedUsagePeriod } from "./finalized-usage-time";
import {
  MODEL_TOKEN_CATEGORIES,
  MODEL_TOKEN_USAGE_KINDS,
} from "./model-token-categories";
import { getOrgBillingPeriod$ } from "./org-billing-period.service";
import {
  buildUsageBreakdowns,
  safeUsageIntegerSum,
  usageBreakdownKindExpr,
  usageCreditsExpr,
  usageDisplayProviderExpr,
} from "./usage-reporting-breakdown";
import {
  fixedRangeToPeriod,
  type UsagePeriod,
  type UsageRangeArg,
} from "./usage-period";
import { resolveUsageEmails$ } from "./usage.service";
interface UsageRecordArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly scope: UsageRecordScope;
  readonly range: UsageRangeArg;
  readonly tz: string;
  readonly page: number;
  readonly pageSize: number;
}

function tokenExpr(usage: FinalizedUsageRelation) {
  return sql`CASE WHEN ${and(
    inArray(usage.kind, MODEL_TOKEN_USAGE_KINDS),
    inArray(usage.category, MODEL_TOKEN_CATEGORIES),
  )} THEN ${usage.quantity} ELSE 0 END::bigint`.mapWith(
    pgInt8ToSafeIntegerDecoder,
  );
}

/**
 * Grouping identity for a usage row, resolved without requiring its `agent_runs`
 * row to survive. `billing_run_attribution` carries the original thread id; the
 * live `chat_threads` row decides whether the bill still groups by that thread,
 * so deleting a thread keeps collapsing its usage into the threadless row.
 *
 * ROLLOUT FALLBACK — the `agent_runs` join. Surface: DB vs API, for rows written
 * before migration 1192 whose attribution still reports `thread_context =
 * 'unknown'`. Removal condition: `pnpm -F @okouai/db billing:attribution`
 * reports `thread_gaps: 0` and `conflicts: 0` on a complete (non-truncated)
 * production inventory; the backfill leaves a conflicting row uncaptured on
 * purpose, so a non-zero conflict count is a human-resolution gate rather than
 * a reason to drop this join.
 * Follow-up: the drop pull request of #35875, which deletes this join.
 */
const groupingThreadId = sql`COALESCE(${billingRunAttribution.threadId}, ${agentRuns.chatThreadId})`;

function usageRecordRunsWith(
  userId: string | null,
  orgId: string,
  period: UsagePeriod | null,
) {
  const builder = new QueryBuilder();
  const usage = buildFinalizedUsageRelation(period ?? undefined);
  const usageRows = builder.$with("usage_rows").as(
    builder
      .select({
        runId: usage.runId,
        billingRunId: usage.billingRunId,
        billingAnchorAt: usage.billingAnchorAt,
        userId: usage.userId,
        credits: usageCreditsExpr(usage).as("credits"),
        tokens: tokenExpr(usage).as("tokens"),
        processedHour: usage.processedHour,
      })
      .from(usage)
      .where(
        and(
          eq(usage.orgId, orgId),
          userId === null ? undefined : eq(usage.userId, userId),
        ),
      ),
  );
  const runs = builder.$with("runs").as(
    builder
      .select({
        runId: usageRows.runId,
        userId: usageRows.userId,
        credits: usageRows.credits,
        tokens: usageRows.tokens,
        chatThreadId: chatThreads.id,
        title: chatThreads.title,
        createdAt:
          sql`COALESCE(${usageRows.billingAnchorAt}, ${usageRows.processedHour})`
            .mapWith(usageEvent.createdAt)
            .as("usage_created_at"),
      })
      .from(usageRows)
      .leftJoin(
        billingRunAttribution,
        eq(billingRunAttribution.runId, usageRows.billingRunId),
      )
      .leftJoin(agentRuns, eq(agentRuns.id, usageRows.runId))
      .leftJoin(chatThreads, eq(chatThreads.id, groupingThreadId)),
  );
  return { usageRows, runs };
}

type UsageRecordRuns = ReturnType<typeof usageRecordRunsWith>["runs"];

function threadedUsageRecordWith(runs: UsageRecordRuns) {
  const builder = new QueryBuilder();
  return builder.$with("threaded").as(
    builder
      .select({
        rowKey:
          sql`CONCAT('thread:', ${runs.chatThreadId}::text, ':user:', ${runs.userId})`
            .mapWith(pgTextDecoder)
            .as("row_key"),
        userId: runs.userId,
        threadId: sql`${runs.chatThreadId}::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("thread_id"),
        title: runs.title,
        credits: safeUsageIntegerSum(runs.credits).as("credits"),
        tokens: safeUsageIntegerSum(runs.tokens).as("tokens"),
        lastActivity: max(runs.createdAt)
          .mapWith(usageEvent.createdAt)
          .as("last_activity"),
      })
      .from(runs)
      .where(isNotNull(runs.chatThreadId))
      .groupBy(runs.userId, runs.chatThreadId, runs.title),
  );
}

// Persisted usage can legitimately outlive its thread or originate without one,
// and an erased thread lands here by design: the ledger keeps the amounts and
// the opaque identifier, never the title. Keep this non-navigable row until that
// historical data is migrated or retired; #35077 tracks the durable-data boundary.
function threadlessUsageRecordWith(runs: UsageRecordRuns) {
  const builder = new QueryBuilder();
  return builder.$with("threadless").as(
    builder
      .select({
        rowKey: sql`CONCAT('threadless:user:', ${runs.userId})`
          .mapWith(pgTextDecoder)
          .as("row_key"),
        userId: runs.userId,
        threadId: sql`NULL::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("thread_id"),
        title: sql`'Unavailable thread'::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("title"),
        credits: safeUsageIntegerSum(runs.credits).as("credits"),
        tokens: safeUsageIntegerSum(runs.tokens).as("tokens"),
        lastActivity: max(runs.createdAt)
          .mapWith(usageEvent.createdAt)
          .as("last_activity"),
      })
      .from(runs)
      .where(isNull(runs.chatThreadId))
      .groupBy(runs.userId),
  );
}

function recordWith(
  userId: string | null,
  orgId: string,
  period: UsagePeriod | null,
) {
  const builder = new QueryBuilder();
  const { usageRows, runs } = usageRecordRunsWith(userId, orgId, period);
  const threaded = threadedUsageRecordWith(runs);
  const threadless = threadlessUsageRecordWith(runs);
  const record = builder.$with("record").as(
    builder
      .select({
        rowKey: threaded.rowKey,
        userId: threaded.userId,
        threadId: threaded.threadId,
        title: threaded.title,
        credits: threaded.credits,
        tokens: threaded.tokens,
        lastActivity: threaded.lastActivity,
      })
      .from(threaded)
      .unionAll(
        builder
          .select({
            rowKey: threadless.rowKey,
            userId: threadless.userId,
            threadId: threadless.threadId,
            title: threadless.title,
            credits: threadless.credits,
            tokens: threadless.tokens,
            lastActivity: threadless.lastActivity,
          })
          .from(threadless),
      ),
  );
  return { usageRows, runs, threaded, threadless, record };
}

type UsageRecordRelations = ReturnType<typeof recordWith>;

function usageRecordRowsQuery(
  relations: UsageRecordRelations,
  pageSize: number,
  offset: number,
) {
  return new QueryBuilder()
    .with(
      relations.usageRows,
      relations.runs,
      relations.threaded,
      relations.threadless,
      relations.record,
    )
    .select({
      rowKey: relations.record.rowKey,
      userId: relations.record.userId,
      threadId: relations.record.threadId,
      title: relations.record.title,
      credits: relations.record.credits,
      tokens: relations.record.tokens,
      lastActivity: relations.record.lastActivity,
    })
    .from(relations.record)
    .orderBy(desc(relations.record.lastActivity), asc(relations.record.rowKey))
    .limit(pageSize)
    .offset(offset)
    .as("record_page");
}

function usageRecordTotalsQuery(relations: UsageRecordRelations) {
  return new QueryBuilder()
    .with(
      relations.usageRows,
      relations.runs,
      relations.threaded,
      relations.threadless,
      relations.record,
    )
    .select({
      total: sql`${count()}::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("total"),
      totalCredits: safeUsageIntegerSum(relations.record.credits).as(
        "total_credits",
      ),
    })
    .from(relations.record)
    .as("record_totals");
}

function usageRecordBreakdownQuery(
  userId: string | null,
  orgId: string,
  period: UsagePeriod | null,
  rowKeys: readonly string[],
) {
  const builder = new QueryBuilder();
  const usage = buildFinalizedUsageRelation(period ?? undefined);
  const usageRows = builder.$with("usage_rows").as(
    builder
      .select({
        chatThreadId: chatThreads.id,
        userId: usage.userId,
        kind: usageBreakdownKindExpr(usage).as("kind"),
        usageKind: sql`${usage.kind}`.mapWith(pgTextDecoder).as("usage_kind"),
        provider: usageDisplayProviderExpr(usage).as("provider"),
        credits: usageCreditsExpr(usage).as("credits"),
      })
      .from(usage)
      .leftJoin(
        billingRunAttribution,
        eq(billingRunAttribution.runId, usage.billingRunId),
      )
      .leftJoin(agentRuns, eq(agentRuns.id, usage.runId))
      .leftJoin(chatThreads, eq(chatThreads.id, groupingThreadId))
      .where(
        and(
          eq(usage.orgId, orgId),
          userId === null ? undefined : eq(usage.userId, userId),
        ),
      ),
  );
  const rowKey = sql`
    CASE
      WHEN ${isNotNull(usageRows.chatThreadId)}
        THEN CONCAT('thread:', ${usageRows.chatThreadId}::text, ':user:', ${usageRows.userId})
      ELSE CONCAT('threadless:user:', ${usageRows.userId})
    END`.mapWith(pgTextDecoder);
  const keyed = builder.$with("keyed").as(
    builder
      .select({
        key: rowKey.as("key"),
        kind: usageRows.kind,
        usageKind: usageRows.usageKind,
        provider: usageRows.provider,
        credits: usageRows.credits,
      })
      .from(usageRows),
  );
  return builder
    .with(usageRows, keyed)
    .select({
      key: keyed.key,
      kind: keyed.kind,
      usageKind: keyed.usageKind,
      provider: keyed.provider,
      credits: sql`${sum(keyed.credits)}::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("credits"),
    })
    .from(keyed)
    .where(inArray(keyed.key, [...rowKeys]))
    .groupBy(keyed.key, keyed.kind, keyed.usageKind, keyed.provider)
    .having(gt(sum(keyed.credits), sql`0`))
    .orderBy(
      asc(keyed.key),
      asc(keyed.kind),
      asc(keyed.provider),
      asc(keyed.usageKind),
    )
    .as("record_breakdown");
}

export const usageRecord$ = command(
  async (
    { set },
    args: UsageRecordArgs,
    signal: AbortSignal,
  ): Promise<UsageRecordResponse> => {
    const billingPeriod =
      args.range === "billingPeriod"
        ? await set(getOrgBillingPeriod$, args.orgId, signal)
        : null;
    signal.throwIfAborted();

    if (args.range === "billingPeriod" && !billingPeriod) {
      return {
        period: null,
        rows: [],
        totalCredits: 0,
        pagination: {
          page: args.page,
          pageSize: args.pageSize,
          total: 0,
        },
      };
    }

    const period =
      args.range === "all"
        ? null
        : args.range === "billingPeriod"
          ? billingPeriod
          : fixedRangeToPeriod(args.range, args.tz);
    if (args.range !== "all" && !period) {
      throw new Error("usage record period was not resolved");
    }

    const db = set(writeDb$);
    const userId = args.scope === "mine" ? args.userId : null;
    const offset = (args.page - 1) * args.pageSize;
    const queryPeriod = period ? normalizeFinalizedUsagePeriod(period) : null;
    const relations = recordWith(userId, args.orgId, queryPeriod);

    const page = usageRecordRowsQuery(relations, args.pageSize, offset);
    const rows = await db
      .select()
      .from(page)
      .orderBy(desc(page.lastActivity), asc(page.rowKey));
    signal.throwIfAborted();
    const breakdownQuery = usageRecordBreakdownQuery(
      userId,
      args.orgId,
      queryPeriod,
      rows.map((row) => {
        return row.rowKey;
      }),
    );
    const breakdown =
      rows.length === 0
        ? []
        : await db
            .select()
            .from(breakdownQuery)
            .orderBy(
              asc(breakdownQuery.key),
              asc(breakdownQuery.kind),
              asc(breakdownQuery.provider),
              asc(breakdownQuery.usageKind),
            );
    signal.throwIfAborted();
    const breakdownByRow = buildUsageBreakdowns(breakdown);
    const [totals] = await db.select().from(usageRecordTotalsQuery(relations));
    signal.throwIfAborted();
    const total = totals?.total ?? 0;
    const totalCredits = totals?.totalCredits ?? 0;

    const emailMap =
      args.scope === "team"
        ? await set(
            resolveUsageEmails$,
            [
              ...new Set(
                rows.map((row) => {
                  return row.userId;
                }),
              ),
            ],
            signal,
          )
        : new Map<string, string>();
    signal.throwIfAborted();

    return {
      period: period
        ? {
            start: period.start.toISOString(),
            end: period.end.toISOString(),
          }
        : null,
      rows: rows.map((row) => {
        return {
          threadId: row.threadId,
          title: row.title,
          credits: row.credits,
          tokens: row.tokens,
          breakdown: breakdownByRow.get(row.rowKey) ?? [],
          member:
            args.scope === "team"
              ? {
                  userId: row.userId,
                  email: emailMap.get(row.userId) ?? "unknown",
                }
              : null,
          lastActivityAt: row.lastActivity.toISOString(),
        };
      }),
      totalCredits,
      pagination: {
        page: args.page,
        pageSize: args.pageSize,
        total,
      },
    };
  },
);
