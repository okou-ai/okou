import { and, eq, inArray, sql, sum } from "drizzle-orm";

import { pgInt8ToSafeIntegerDecoder } from "../../lib/db-structured-result";
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

export async function getMemberUsageTotals(
  db: Db,
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
