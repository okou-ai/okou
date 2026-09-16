import { command } from "ccstate";
import {
  type UsageRecordKind,
  type UsageRecordRow,
  type UsageRecordResponse,
  type UsageRecordScope,
  type UsageRecordSource,
  usageRecordKindSchema,
  usageRecordSourceSchema,
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
  notInArray,
  sql,
  sum,
  type SQLWrapper,
} from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";

import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
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
import { resolveEmails } from "./usage.service";
import {
  fixedRangeToPeriod,
  type UsagePeriod,
  type UsageRangeArg,
} from "./usage-period";

const THREADED_SOURCES = ["chat", "automation"] as const;
const USAGE_RECORD_KINDS = ["model", "image", "video", "connector"] as const;
const PASSTHROUGH_TRIGGER_SOURCES = [
  "slack",
  "teams",
  "telegram",
  "email",
  "agentphone",
  "github",
  "agent",
] as const;
const usageRecordKindDecoder = zodEnumDriverValueDecoder(usageRecordKindSchema);
const usageRecordSourceDecoder = zodEnumDriverValueDecoder(
  usageRecordSourceSchema,
);

interface UsageRecordArgs {
  readonly userId: string;
  readonly orgId: string;
  readonly scope: UsageRecordScope;
  readonly range: UsageRangeArg;
  readonly tz: string;
  readonly page: number;
  readonly pageSize: number;
  readonly source?: UsageRecordSource;
}

interface UsageRecordIntermediateRow extends UsageRecordRow {
  readonly rowKey: string;
  readonly userId: string;
}

interface UsageRecordBreakdownSqlRow {
  readonly rowKey: string;
  readonly kind: UsageRecordKind;
  readonly usageKind: string;
  readonly provider: string;
  readonly credits: number;
}

interface UsageRecordProviderAccumulator {
  readonly provider: string;
  credits: number;
  readonly usageKinds: {
    readonly kind: string;
    readonly credits: number;
  }[];
}

function tokenExpr(usage: FinalizedUsageRelation) {
  return sql`CASE WHEN ${and(
    inArray(usage.kind, MODEL_TOKEN_USAGE_KINDS),
    inArray(usage.category, MODEL_TOKEN_CATEGORIES),
  )} THEN ${usage.quantity} ELSE 0 END::bigint`.mapWith(
    pgInt8ToSafeIntegerDecoder,
  );
}

function sourceExpr() {
  return sql`
    CASE
      WHEN ${eq(agentRuns.triggerSource, sql`'web'`)} THEN 'chat'
      WHEN ${inArray(
        agentRuns.triggerSource,
        sql`(
          'automation-schedule',
          'automation-event',
          'goal'
        )`,
      )} THEN 'automation'
      WHEN ${inArray(
        agentRuns.triggerSource,
        PASSTHROUGH_TRIGGER_SOURCES,
      )} THEN ${agentRuns.triggerSource}
      ELSE 'other'
    END`.mapWith(usageRecordSourceDecoder);
}

function usageKindExpr(usage: FinalizedUsageRelation) {
  return sql`
    CASE
      WHEN ${inArray(usage.kind, USAGE_RECORD_KINDS)} THEN ${usage.kind}
      ELSE 'other'
    END`.mapWith(usageRecordKindDecoder);
}

function usageCreditsExpr(usage: FinalizedUsageRelation) {
  return sql`${usage.creditsCharged} + ${usage.allowanceUnits}::bigint`.mapWith(
    pgInt8ToSafeIntegerDecoder,
  );
}

function safeIntegerSum(value: SQLWrapper) {
  return sql`COALESCE(${sum(value)}, 0)::bigint`.mapWith(
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
        source: sourceExpr().as("source"),
        chatThreadId: agentRuns.chatThreadId,
        summary: agentRuns.summary,
        prompt: agentRuns.prompt,
        createdAt: agentRuns.createdAt,
      })
      .from(usageRows)
      .innerJoin(agentRuns, eq(agentRuns.id, usageRows.runId))
      .where(isNotNull(agentRuns.triggerSource)),
  );
  return { usageRows, runs };
}

type UsageRecordRuns = ReturnType<typeof usageRecordRunsWith>["runs"];

function threadedUsageRecordWith(db: Db, runs: UsageRecordRuns) {
  return db.$with("threaded").as(
    db
      .select({
        rowKey:
          sql`CONCAT(${runs.source}, ':thread:', ${runs.chatThreadId}::text, ':user:', ${runs.userId})`
            .mapWith(pgTextDecoder)
            .as("row_key"),
        source: runs.source,
        userId: runs.userId,
        threadId: sql`${runs.chatThreadId}::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("thread_id"),
        runId: sql`NULL::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("run_id"),
        title: chatThreads.title,
        credits: safeIntegerSum(runs.credits).as("credits"),
        tokens: safeIntegerSum(runs.tokens).as("tokens"),
        lastActivity: max(runs.createdAt)
          .mapWith(agentRuns.createdAt)
          .as("last_activity"),
      })
      .from(runs)
      .leftJoin(chatThreads, eq(chatThreads.id, runs.chatThreadId))
      .where(
        and(
          isNotNull(runs.chatThreadId),
          inArray(runs.source, [...THREADED_SOURCES]),
        ),
      )
      .groupBy(runs.source, runs.userId, runs.chatThreadId, chatThreads.title),
  );
}

function deletedThreadedUsageRecordWith(db: Db, runs: UsageRecordRuns) {
  return db.$with("deleted_threaded").as(
    db
      .select({
        rowKey:
          sql`CONCAT(${runs.source}, ':deleted-thread:user:', ${runs.userId})`
            .mapWith(pgTextDecoder)
            .as("row_key"),
        source: runs.source,
        userId: runs.userId,
        threadId: sql`NULL::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("thread_id"),
        runId: sql`NULL::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("run_id"),
        title: sql`'Deleted chats'::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("title"),
        credits: safeIntegerSum(runs.credits).as("credits"),
        tokens: safeIntegerSum(runs.tokens).as("tokens"),
        lastActivity: max(runs.createdAt)
          .mapWith(agentRuns.createdAt)
          .as("last_activity"),
      })
      .from(runs)
      .where(
        and(
          isNull(runs.chatThreadId),
          inArray(runs.source, [...THREADED_SOURCES]),
        ),
      )
      .groupBy(runs.source, runs.userId),
  );
}

function unthreadedUsageRecordWith(db: Db, runs: UsageRecordRuns) {
  return db.$with("unthreaded").as(
    db
      .select({
        rowKey:
          sql`CONCAT(${runs.source}, ':run:', ${runs.runId}::text, ':user:', ${runs.userId})`
            .mapWith(pgTextDecoder)
            .as("row_key"),
        source: runs.source,
        userId: runs.userId,
        threadId: sql`NULL::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("thread_id"),
        runId: sql`${runs.runId}::text`
          .mapWith(nullableDriverValueDecoder(pgTextDecoder))
          .as("run_id"),
        title:
          sql`LEFT(COALESCE(NULLIF(${max(runs.summary)}, ''), ${max(runs.prompt)}), 120)`
            .mapWith(nullableDriverValueDecoder(pgTextDecoder))
            .as("title"),
        credits: safeIntegerSum(runs.credits).as("credits"),
        tokens: safeIntegerSum(runs.tokens).as("tokens"),
        lastActivity: max(runs.createdAt)
          .mapWith(agentRuns.createdAt)
          .as("last_activity"),
      })
      .from(runs)
      .where(notInArray(runs.source, [...THREADED_SOURCES]))
      .groupBy(runs.runId, runs.source, runs.userId),
  );
}

// Per-source usage for one user in one org. `record` is the shared CTE so the
// row query and the count query stay in sync. Threaded sources collapse to one
// row per source/thread. Deleted threaded rows, whose thread FK has been set to
// NULL, collapse to one synthetic row per source/user. Everything else is one
// row per run.
function recordWith(
  db: Db,
  userId: string | null,
  orgId: string,
  period: UsagePeriod | null,
) {
  const { usageRows, runs } = usageRecordRunsWith(db, userId, orgId, period);
  const threaded = threadedUsageRecordWith(db, runs);
  const deletedThreaded = deletedThreadedUsageRecordWith(db, runs);
  const unthreaded = unthreadedUsageRecordWith(db, runs);
  const record = db.$with("record").as(
    unionAll(
      db
        .select({
          rowKey: threaded.rowKey,
          source: threaded.source,
          userId: threaded.userId,
          threadId: threaded.threadId,
          runId: threaded.runId,
          title: threaded.title,
          credits: threaded.credits,
          tokens: threaded.tokens,
          lastActivity: threaded.lastActivity,
        })
        .from(threaded),
      db
        .select({
          rowKey: deletedThreaded.rowKey,
          source: deletedThreaded.source,
          userId: deletedThreaded.userId,
          threadId: deletedThreaded.threadId,
          runId: deletedThreaded.runId,
          title: deletedThreaded.title,
          credits: deletedThreaded.credits,
          tokens: deletedThreaded.tokens,
          lastActivity: deletedThreaded.lastActivity,
        })
        .from(deletedThreaded),
      db
        .select({
          rowKey: unthreaded.rowKey,
          source: unthreaded.source,
          userId: unthreaded.userId,
          threadId: unthreaded.threadId,
          runId: unthreaded.runId,
          title: unthreaded.title,
          credits: unthreaded.credits,
          tokens: unthreaded.tokens,
          lastActivity: unthreaded.lastActivity,
        })
        .from(unthreaded),
    ),
  );
  return { usageRows, runs, threaded, deletedThreaded, unthreaded, record };
}

type UsageRecordRelations = ReturnType<typeof recordWith>;

async function queryUsageRecordRows(
  db: Db,
  relations: UsageRecordRelations,
  sourceFilter: UsageRecordSource | undefined,
  pageSize: number,
  offset: number,
): Promise<UsageRecordIntermediateRow[]> {
  const rows = await db
    .with(
      relations.usageRows,
      relations.runs,
      relations.threaded,
      relations.deletedThreaded,
      relations.unthreaded,
      relations.record,
    )
    .select({
      rowKey: relations.record.rowKey,
      source: relations.record.source,
      userId: relations.record.userId,
      threadId: relations.record.threadId,
      runId: relations.record.runId,
      title: relations.record.title,
      credits: relations.record.credits,
      tokens: relations.record.tokens,
      lastActivity: relations.record.lastActivity,
    })
    .from(relations.record)
    .where(
      sourceFilter === undefined
        ? undefined
        : eq(relations.record.source, sourceFilter),
    )
    .orderBy(desc(relations.record.lastActivity), asc(relations.record.rowKey))
    .limit(pageSize)
    .offset(offset);
  return rows.map((row): UsageRecordIntermediateRow => {
    return {
      rowKey: row.rowKey,
      source: row.source,
      userId: row.userId,
      threadId: row.threadId,
      runId: row.runId,
      title: row.title,
      credits: row.credits,
      tokens: row.tokens,
      breakdown: [],
      member: null,
      lastActivityAt: row.lastActivity.toISOString(),
    };
  });
}

async function queryUsageRecordTotals(
  db: Db,
  relations: UsageRecordRelations,
  sourceFilter: UsageRecordSource | undefined,
): Promise<{ total: number; totalCredits: number }> {
  const rows = await db
    .with(
      relations.usageRows,
      relations.runs,
      relations.threaded,
      relations.deletedThreaded,
      relations.unthreaded,
      relations.record,
    )
    .select({
      total: sql`${count()}::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("total"),
      totalCredits: safeIntegerSum(relations.record.credits).as(
        "total_credits",
      ),
    })
    .from(relations.record)
    .where(
      sourceFilter === undefined
        ? undefined
        : eq(relations.record.source, sourceFilter),
    );
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
        source: sourceExpr().as("source"),
        chatThreadId: agentRuns.chatThreadId,
        runId: usage.runId,
        userId: usage.userId,
        kind: usageKindExpr(usage).as("kind"),
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
          isNotNull(agentRuns.triggerSource),
          eq(usage.orgId, orgId),
          userId === null ? undefined : eq(usage.userId, userId),
        ),
      ),
  );
  const rowKey = sql`
    CASE
      WHEN ${and(
        isNotNull(usageRows.chatThreadId),
        inArray(usageRows.source, [...THREADED_SOURCES]),
      )}
        THEN CONCAT(${usageRows.source}, ':thread:', ${usageRows.chatThreadId}::text, ':user:', ${usageRows.userId})
      WHEN ${and(
        isNull(usageRows.chatThreadId),
        inArray(usageRows.source, [...THREADED_SOURCES]),
      )}
        THEN CONCAT(${usageRows.source}, ':deleted-thread:user:', ${usageRows.userId})
      ELSE CONCAT(${usageRows.source}, ':run:', ${usageRows.runId}::text, ':user:', ${usageRows.userId})
    END`.mapWith(pgTextDecoder);
  const keyed = db.$with("keyed").as(
    db
      .select({
        rowKey: rowKey.as("row_key"),
        kind: usageRows.kind,
        usageKind: usageRows.usageKind,
        provider: usageRows.provider,
        credits: usageRows.credits,
      })
      .from(usageRows),
  );
  const rows: UsageRecordBreakdownSqlRow[] = await db
    .with(usageRows, keyed)
    .select({
      rowKey: keyed.rowKey,
      kind: keyed.kind,
      usageKind: keyed.usageKind,
      provider: keyed.provider,
      credits: sql`${sum(keyed.credits)}::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("credits"),
    })
    .from(keyed)
    .where(inArray(keyed.rowKey, [...rowKeys]))
    .groupBy(keyed.rowKey, keyed.kind, keyed.usageKind, keyed.provider)
    .having(gt(sum(keyed.credits), sql`0`))
    .orderBy(
      asc(keyed.rowKey),
      asc(keyed.kind),
      asc(keyed.provider),
      asc(keyed.usageKind),
    );

  const byRow = new Map<
    string,
    Map<UsageRecordKind, Map<string, UsageRecordProviderAccumulator>>
  >();
  for (const row of rows) {
    const kinds = byRow.get(row.rowKey) ?? new Map();
    const providers = kinds.get(row.kind) ?? new Map();
    const provider = providers.get(row.provider) ?? {
      provider: row.provider,
      credits: 0,
      usageKinds: [],
    };
    provider.credits += row.credits;
    provider.usageKinds.push({
      kind: row.usageKind,
      credits: row.credits,
    });
    providers.set(row.provider, provider);
    kinds.set(row.kind, providers);
    byRow.set(row.rowKey, kinds);
  }

  const breakdownByRow = new Map<string, UsageRecordRow["breakdown"]>();
  for (const [rowKey, kindMap] of byRow) {
    const breakdown: UsageRecordRow["breakdown"] = [];
    for (const kind of [
      "model",
      "image",
      "video",
      "connector",
      "other",
    ] as const) {
      const providers = Array.from(kindMap.get(kind)?.values() ?? []);
      if (providers.length === 0) {
        continue;
      }
      breakdown.push({
        kind,
        credits: providers.reduce((sum, provider) => {
          return sum + provider.credits;
        }, 0),
        providers,
      });
    }
    breakdownByRow.set(rowKey, breakdown);
  }

  return breakdownByRow;
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

    signal.throwIfAborted();
    const rows = await queryUsageRecordRows(
      db,
      relations,
      args.source,
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
    const { total, totalCredits } = await queryUsageRecordTotals(
      db,
      relations,
      args.source,
    );
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
          source: row.source,
          threadId: row.threadId,
          runId: row.runId,
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
