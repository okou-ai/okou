import { and, asc, eq, gt, inArray, sql, sum } from "drizzle-orm";

import {
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import type { Db } from "../external/db";
import {
  buildFinalizedUsageRelation,
  type FinalizedUsageRelation,
} from "./finalized-usage-relation";
import { normalizeFinalizedUsagePeriod } from "./finalized-usage-time";
import {
  MODEL_CACHE_CREATION_TOKEN_CATEGORIES,
  MODEL_CACHE_READ_TOKEN_CATEGORIES,
  MODEL_INPUT_TOKEN_CATEGORIES,
  MODEL_OUTPUT_TOKEN_CATEGORIES,
  MODEL_TOKEN_USAGE_KINDS,
} from "./model-token-categories";
import {
  buildUsageBreakdowns,
  usageBreakdownKindExpr,
  usageCreditsExpr,
  type UsageBreakdownSqlRow,
} from "./usage-reporting-breakdown";

interface BillingWindow {
  readonly start: Date;
  readonly end: Date;
}

interface UsageMemberTotalsRow {
  readonly userId: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadInputTokens: number;
  readonly cacheCreationInputTokens: number;
  readonly creditsCharged: number;
}

type UsageReportingDb = Pick<Db, "select">;

export async function getMemberUsageTotals(
  db: UsageReportingDb,
  orgId: string,
  billingWindow: BillingWindow,
): Promise<UsageMemberTotalsRow[]> {
  const usage = buildFinalizedUsageRelation(
    normalizeFinalizedUsagePeriod(billingWindow),
  );
  const totalsSelect = {
    userId: usage.userId,
    inputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_INPUT_TOKEN_CATEGORIES,
      "input_tokens",
    ),
    outputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_OUTPUT_TOKEN_CATEGORIES,
      "output_tokens",
    ),
    cacheReadInputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_CACHE_READ_TOKEN_CATEGORIES,
      "cache_read_input_tokens",
    ),
    cacheCreationInputTokens: finalizedUsageTokenSum(
      usage,
      MODEL_CACHE_CREATION_TOKEN_CATEGORIES,
      "cache_creation_input_tokens",
    ),
    creditsCharged: usageCreditsSum(usage, "credits_charged"),
  } satisfies Record<keyof UsageMemberTotalsRow, unknown>;

  return await db
    .select(totalsSelect)
    .from(usage)
    .where(eq(usage.orgId, orgId))
    .groupBy(usage.userId);
}

export async function getMemberUsageBreakdowns(
  db: UsageReportingDb,
  orgId: string,
  billingWindow: BillingWindow,
) {
  const usage = buildFinalizedUsageRelation(
    normalizeFinalizedUsagePeriod(billingWindow),
  );
  const kind = usageBreakdownKindExpr(usage);
  const credits = usageCreditsExpr(usage);
  const rows: UsageBreakdownSqlRow[] = await db
    .select({
      key: sql`${usage.userId}`.mapWith(pgTextDecoder).as("key"),
      kind: kind.as("kind"),
      usageKind: sql`${usage.kind}`.mapWith(pgTextDecoder).as("usage_kind"),
      provider: sql`COALESCE(NULLIF(${usage.provider}, ''), 'unknown')`
        .mapWith(pgTextDecoder)
        .as("provider"),
      credits: sql`${sum(credits)}::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("credits"),
    })
    .from(usage)
    .where(eq(usage.orgId, orgId))
    .groupBy(usage.userId, kind, usage.kind, usage.provider)
    .having(gt(sum(credits), sql`0`))
    .orderBy(
      asc(usage.userId),
      asc(kind),
      asc(usage.provider),
      asc(usage.kind),
    );

  return buildUsageBreakdowns(rows);
}

function finalizedUsageTokenSum(
  usage: FinalizedUsageRelation,
  categories: readonly string[],
  alias: string,
) {
  return sql`COALESCE(${sum(
    sql`CASE WHEN ${and(
      inArray(usage.kind, MODEL_TOKEN_USAGE_KINDS),
      inArray(usage.category, categories),
    )} THEN ${usage.quantity} ELSE 0 END`,
  )}, 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}

function usageCreditsSum(usage: FinalizedUsageRelation, alias: string) {
  return sql`COALESCE(${sum(
    sql`${usage.creditsCharged} + ${usage.allowanceUnits}`,
  )}, 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}
