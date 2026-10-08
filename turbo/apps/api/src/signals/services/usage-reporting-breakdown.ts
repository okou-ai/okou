import {
  usageRecordKindSchema,
  type UsageRecordKind,
  type UsageRecordKindBreakdown,
} from "@okouai/api-contracts/contracts/usage-record";
import { inArray, sql, sum, type SQLWrapper } from "drizzle-orm";
import { agentRuns } from "@okouai/db/runtime/agent-run";

import {
  pgInt8ToSafeIntegerDecoder,
  pgTextDecoder,
  zodEnumDriverValueDecoder,
} from "../../lib/db-structured-result";
import type { FinalizedUsageRelation } from "./finalized-usage-relation";

const REPORTING_KINDS = ["model", "image", "video", "connector"] as const;
const usageRecordKindDecoder = zodEnumDriverValueDecoder(usageRecordKindSchema);

export interface UsageBreakdownSqlRow {
  readonly key: string;
  readonly kind: UsageRecordKind;
  readonly usageKind: string;
  readonly provider: string;
  readonly credits: number;
}

interface ProviderAccumulator {
  readonly provider: string;
  credits: number;
  readonly usageKinds: {
    readonly kind: string;
    readonly credits: number;
  }[];
}

export function usageBreakdownKindExpr(usage: FinalizedUsageRelation) {
  return sql`
    CASE
      WHEN ${inArray(usage.kind, REPORTING_KINDS)} THEN ${usage.kind}
      ELSE 'other'
    END`.mapWith(usageRecordKindDecoder);
}

/**
 * The name a usage row is shown under. Model usage of a run names the model
 * the run actually used (`agent_runs.selected_model`, joined by `run_id`):
 * the recorded provider is the `usage_pricing` identity, which for a Built-in
 * route with a pricing alias differs from the model. Stored usage keeps its
 * provider; only this projection changes. Other usage, and model usage
 * without a run (or whose run row is gone), keeps the recorded provider.
 * Callers must left join `agent_runs` on the usage row's `run_id`.
 */
export function usageDisplayProviderExpr(usage: FinalizedUsageRelation) {
  return sql`
    CASE
      WHEN ${usage.kind} = 'model' AND NULLIF(${agentRuns.selectedModel}, '') IS NOT NULL
        THEN ${agentRuns.selectedModel}
      ELSE COALESCE(NULLIF(${usage.provider}, ''), 'unknown')
    END`.mapWith(pgTextDecoder);
}

export function usageCreditsExpr(usage: FinalizedUsageRelation) {
  return sql`${usage.creditsCharged}::bigint`.mapWith(
    pgInt8ToSafeIntegerDecoder,
  );
}

export function safeUsageIntegerSum(value: SQLWrapper) {
  return sql`COALESCE(${sum(value)}, 0)::bigint`.mapWith(
    pgInt8ToSafeIntegerDecoder,
  );
}

export function buildUsageBreakdowns(
  rows: readonly UsageBreakdownSqlRow[],
): Map<string, UsageRecordKindBreakdown[]> {
  const byKey = new Map<
    string,
    Map<UsageRecordKind, Map<string, ProviderAccumulator>>
  >();

  for (const row of rows) {
    const kinds = byKey.get(row.key) ?? new Map();
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
    byKey.set(row.key, kinds);
  }

  const breakdownByKey = new Map<string, UsageRecordKindBreakdown[]>();
  for (const [key, kindMap] of byKey) {
    const breakdown: UsageRecordKindBreakdown[] = [];
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
        credits: providers.reduce((total, provider) => {
          return total + provider.credits;
        }, 0),
        providers,
      });
    }
    breakdownByKey.set(key, breakdown);
  }

  return breakdownByKey;
}
