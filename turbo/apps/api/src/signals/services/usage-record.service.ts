import { command } from "ccstate";
import type {
  UsageRecordRow,
  UsageRecordResponse,
  UsageRecordScope,
} from "@okouai/api-contracts/contracts/usage-record";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/schema/chat-thread";
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
import { unionAll } from "drizzle-orm/pg-core";

import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { clerk$ } from "../external/clerk";
import { writeDb$, type Db } from "../external/db";
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
  type UsageBreakdownSqlRow,
} from "./usage-reporting-breakdown";
import { resolveEmails } from "./usage.service";
import {
  fixedRangeToPeriod,
  type UsagePeriod,
  type UsageRangeArg,
} from "./usage-period";

interface UsageRecordArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly scope: UsageRecordScope;
  readonly range: UsageRangeArg;
  readonly tz: string;
  readonly page: number;
  readonly pageSize: number;
}

interface UsageRecordIntermediateRow {
  readonly rowKey: string;
  readonly userId: string;
  readonly threadId: string | null;
  readonly title: string | null;
  readonly credits: number;
  readonly tokens: number;
  readonly lastActivityAt: string;
}

function tokenExpr(usage: FinalizedUsageRelation) {
  return sql`CASE WHEN ${and(
    inArray(usage.kind, MODEL_TOKEN_USAGE_KINDS),
    inArray(usage.category, MODEL_TOKEN_CATEGORIES),
  )} THEN ${usage.quantity} ELSE 0 END::bigint`.mapWith(
    pgInt8ToSafeIntegerDecoder,
  );
}

function usageRecordRunsWith(
  db: Db,
  userId: string | null,
  orgId: string,
  period: UsagePeriod | null,
) {
  const usage = buildFinalizedUsageRelation(period ?? undefined);
  const usageRows = db.$with("usage_rows").as(
    db
      .select({
        runId: usage.runId,
        userId: usage.userId,
        credits: usageCreditsExpr(usage).as("credits"),
        tokens: tokenExpr(usage).as("tokens"),
      })
      .from(usage)
      .where(
        and(
          eq(usage.orgId, orgId),
          userId === null ? undefined : eq(usage.userId, userId),
        ),
      ),
  );
  const runs = db.$with("runs").as(
    db
      .select({
        runId: usageRows.runId,
        userId: usageRows.userId,
        credits: usageRows.credits,
        tokens: usageRows.tokens,
        chatThreadId: agentRuns.chatThreadId,
        createdAt: agentRuns.createdAt,
      })
      .from(usageRows)
      .innerJoin(agentRuns, eq(agentRuns.id, usageRows.runId)),
  );
  return { usageRows, runs };
}

type UsageRecordRuns = ReturnType<typeof usageRecordRunsWith>["runs"];

function threadedUsageRecordWith(db: Db, runs: UsageRecordRuns) {
  return db.$with("threaded").as(
    db
      .select({
        rowKey:
          sql`CONCAT('thread:', ${runs.chatThreadId}::text, ':user:', ${runs.userId})`
            .mapWith(pgTextDecoder)
            .as("row_key"),
        userId: runs.userId,
        threadId: sql`${runs.chatThreadId}::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("thread_id"),
        title: chatThreads.title,
        credits: safeUsageIntegerSum(runs.credits).as("credits"),
        tokens: safeUsageIntegerSum(runs.tokens).as("tokens"),
        lastActivity: max(runs.createdAt)
          .mapWith(agentRuns.createdAt)
          .as("last_activity"),
      })
      .from(runs)
      .leftJoin(chatThreads, eq(chatThreads.id, runs.chatThreadId))
      .where(isNotNull(runs.chatThreadId))
      .groupBy(runs.userId, runs.chatThreadId, chatThreads.title),
  );
}

// Persisted usage can legitimately outlive its thread or originate without one.
// Keep this non-navigable row until that historical data is migrated or retired;
// #35077 tracks the durable-data boundary.
function threadlessUsageRecordWith(db: Db, runs: UsageRecordRuns) {
  return db.$with("threadless").as(
    db
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
          .mapWith(agentRuns.createdAt)
          .as("last_activity"),
      })
      .from(runs)
      .where(isNull(runs.chatThreadId))
      .groupBy(runs.userId),
  );
}

function recordWith(
  db: Db,
  userId: string | null,
  orgId: string,
  period: UsagePeriod | null,
) {
  const { usageRows, runs } = usageRecordRunsWith(db, userId, orgId, period);
  const threaded = threadedUsageRecordWith(db, runs);
  const threadless = threadlessUsageRecordWith(db, runs);
  const record = db.$with("record").as(
    unionAll(
      db
        .select({
          rowKey: threaded.rowKey,
          userId: threaded.userId,
          threadId: threaded.threadId,
          title: threaded.title,
          credits: threaded.credits,
          tokens: threaded.tokens,
          lastActivity: threaded.lastActivity,
        })
        .from(threaded),
      db
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

async function queryUsageRecordRows(
  db: Db,
  relations: UsageRecordRelations,
  pageSize: number,
  offset: number,
): Promise<UsageRecordIntermediateRow[]> {
  const rows = await db
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
    .offset(offset);
  return rows.map((row) => {
    return {
      rowKey: row.rowKey,
      userId: row.userId,
      threadId: row.threadId,
      title: row.title,
      credits: row.credits,
      tokens: row.tokens,
      lastActivityAt: row.lastActivity.toISOString(),
    };
  });
}

async function queryUsageRecordTotals(
  db: Db,
  relations: UsageRecordRelations,
): Promise<{ total: number; totalCredits: number }> {
  const rows = await db
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
    .from(relations.record);
  return {
    total: rows[0]?.total ?? 0,
    totalCredits: rows[0]?.totalCredits ?? 0,
  };
}

async function queryUsageRecordBreakdown(
  db: Db,
  userId: string | null,
  orgId: string,
  period: UsagePeriod | null,
  rowKeys: readonly string[],
): Promise<Map<string, UsageRecordRow["breakdown"]>> {
  if (rowKeys.length === 0) {
    return new Map();
  }

  const usage = buildFinalizedUsageRelation(period ?? undefined);
  const usageRows = db.$with("usage_rows").as(
    db
      .select({
        chatThreadId: agentRuns.chatThreadId,
        userId: usage.userId,
        kind: usageBreakdownKindExpr(usage).as("kind"),
        usageKind: sql`${usage.kind}`.mapWith(pgTextDecoder).as("usage_kind"),
        provider: sql`COALESCE(NULLIF(${usage.provider}, ''), 'unknown')`
          .mapWith(pgTextDecoder)
          .as("provider"),
        credits: usageCreditsExpr(usage).as("credits"),
      })
      .from(usage)
      .innerJoin(agentRuns, eq(agentRuns.id, usage.runId))
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
  const keyed = db.$with("keyed").as(
    db
      .select({
        key: rowKey.as("key"),
        kind: usageRows.kind,
        usageKind: usageRows.usageKind,
        provider: usageRows.provider,
        credits: usageRows.credits,
      })
      .from(usageRows),
  );
  const rows: UsageBreakdownSqlRow[] = await db
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
    );

  return buildUsageBreakdowns(rows);
}

export const usageRecord$ = command(
  async (
    { get, set },
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
    const relations = recordWith(db, userId, args.orgId, queryPeriod);

    const rows = await queryUsageRecordRows(
      db,
      relations,
      args.pageSize,
      offset,
    );
    signal.throwIfAborted();
    const breakdownByRow = await queryUsageRecordBreakdown(
      db,
      userId,
      args.orgId,
      queryPeriod,
      rows.map((row) => {
        return row.rowKey;
      }),
    );
    signal.throwIfAborted();
    const { total, totalCredits } = await queryUsageRecordTotals(db, relations);
    signal.throwIfAborted();

    const emailMap =
      args.scope === "team"
        ? await resolveEmails(
            get(clerk$),
            db,
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
          lastActivityAt: row.lastActivityAt,
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
