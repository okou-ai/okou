import {
  usageRecordKindSchema,
  type UsageRecordKind,
  type UsageRecordKindBreakdown,
} from "@okouai/api-contracts/contracts/usage-record";
import { inArray, sql, sum, type SQLWrapper } from "drizzle-orm";

import {
  pgInt8ToSafeIntegerDecoder,
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

export function usageCreditsExpr(usage: FinalizedUsageRelation) {
  return sql`${usage.creditsCharged} + ${usage.allowanceUnits}::bigint`.mapWith(
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
