import { and, asc, eq, gt, inArray, sql, sum } from "drizzle-orm";
import { usageRecordKindSchema } from "@okouai/api-contracts/contracts/usage-record";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  nullableDriverValueDecoder,
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
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
  usageDisplayProviderExpr,
  usageBreakdownKindExpr,
  usageCreditsExpr,
} from "./usage-reporting-breakdown";
import { QueryBuilder } from "drizzle-orm/pg-core";
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

/** Totals and display groups share one statement snapshot, including compaction. */
export function memberUsageQuery(orgId: string, billingWindow: BillingWindow) {
  const totals = memberUsageTotalsQuery(orgId, billingWindow);
  const breakdown = memberUsageBreakdownQuery(orgId, billingWindow);
  return new QueryBuilder()
    .select({
      userId: totals.userId,
      inputTokens: totals.inputTokens,
      outputTokens: totals.outputTokens,
      cacheReadInputTokens: totals.cacheReadInputTokens,
      cacheCreationInputTokens: totals.cacheCreationInputTokens,
      creditsCharged: totals.creditsCharged,
      breakdownKey: sql`${breakdown.key}`
        .mapWith(nullableDriverValueDecoder(pgTextDecoder))
        .as("breakdown_key"),
      breakdownKind: sql`${breakdown.kind}`
        .mapWith(
          nullableDriverValueDecoder(
            zodEnumDriverValueDecoder(usageRecordKindSchema),
          ),
        )
        .as("breakdown_kind"),
      breakdownUsageKind: sql`${breakdown.usageKind}`
        .mapWith(nullableDriverValueDecoder(pgTextDecoder))
        .as("breakdown_usage_kind"),
      breakdownProvider: sql`${breakdown.provider}`
        .mapWith(nullableDriverValueDecoder(pgTextDecoder))
        .as("breakdown_provider"),
      breakdownCredits: sql`${breakdown.credits}`
        .mapWith(nullableDriverValueDecoder(pgInt8ToSafeIntegerDecoder))
        .as("breakdown_credits"),
    })
    .from(totals)
    .leftJoin(breakdown, eq(totals.userId, breakdown.key))
    .as("member_usage");
}

function memberUsageTotalsQuery(orgId: string, billingWindow: BillingWindow) {
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

  return new QueryBuilder()
    .select(totalsSelect)
    .from(usage)
    .where(eq(usage.orgId, orgId))
    .groupBy(usage.userId)
    .as("member_usage_totals");
}

function memberUsageBreakdownQuery(
  orgId: string,
  billingWindow: BillingWindow,
) {
  const usage = buildFinalizedUsageRelation(
    normalizeFinalizedUsagePeriod(billingWindow),
  );
  const provider = usageDisplayProviderExpr(usage);
  const kind = usageBreakdownKindExpr(usage);
  const credits = usageCreditsExpr(usage);
  return new QueryBuilder()
    .select({
      key: sql`${usage.userId}`.mapWith(pgTextDecoder).as("key"),
      kind: kind.as("kind"),
      usageKind: sql`${usage.kind}`.mapWith(pgTextDecoder).as("usage_kind"),
      provider: provider.as("provider"),
      credits: sql`${sum(credits)}::bigint`
        .mapWith(pgInt8ToSafeIntegerDecoder)
        .as("credits"),
    })
    .from(usage)
    .leftJoin(agentRuns, eq(agentRuns.id, usage.runId))
    .where(eq(usage.orgId, orgId))
    .groupBy(usage.userId, kind, usage.kind, provider)
    .having(gt(sum(credits), sql`0`))
    .orderBy(asc(usage.userId), asc(kind), asc(provider), asc(usage.kind))
    .as("member_usage_breakdown");
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
  return sql`COALESCE(${sum(usage.creditsCharged)}, 0)::bigint`
    .mapWith(pgInt8ToSafeIntegerDecoder)
    .as(alias);
}
