import type { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { xResourceReads } from "@okouai/db/schema/x-resource-usage";
import { and, eq, inArray, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import type { z } from "zod";
import { pgTextDecoder } from "../../lib/db-structured-result";

export type UsageBody = z.output<typeof webhookUsageEventContract.send.body>;
type UsageObservation = UsageBody["events"][number];
type Owner = {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
};
const CLOCK_TOLERANCE_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export class XResourceUsageError extends Error {
  constructor(
    readonly status: 400 | 404 | 409,
    message: string,
  ) {
    super(message);
  }
}

export function orderedUsageSources(events: readonly UsageObservation[]) {
  const ordered = events
    .map((event) => {
      return { ...event, idempotencyKey: event.idempotencyKey.toLowerCase() };
    })
    .sort((left, right) => {
      return left.idempotencyKey.localeCompare(right.idempotencyKey);
    });
  if (
    new Set(
      ordered.map((event) => {
        return event.idempotencyKey;
      }),
    ).size !== ordered.length
  ) {
    throw new XResourceUsageError(
      400,
      "Usage source UUIDs must be distinct within a batch",
    );
  }
  return ordered;
}

export function checkObservationTimes(
  clock: Date | undefined,
  events: readonly UsageObservation[],
  run: { readonly createdAt: Date; readonly completedAt: Date | null },
): void {
  if (!clock) {
    throw new Error("X resource database clock returned no row");
  }
  const today = clock.toISOString().slice(0, 10);
  const yesterday = new Date(clock.getTime() - DAY_MS)
    .toISOString()
    .slice(0, 10);
  for (const event of events) {
    if (!("protocol" in event)) {
      continue;
    }
    const day = event.observedAt.slice(0, 10);
    const observedAt = Date.parse(event.observedAt);
    if (
      (day !== today && day !== yesterday) ||
      observedAt > clock.getTime() + CLOCK_TOLERANCE_MS ||
      observedAt < run.createdAt.getTime() - CLOCK_TOLERANCE_MS ||
      (run.completedAt !== null &&
        observedAt > run.completedAt.getTime() + CLOCK_TOLERANCE_MS)
    ) {
      throw new XResourceUsageError(
        400,
        "X resource observation time is outside the admitted window",
      );
    }
  }
}

/**
 * Plain read, no explicit row lock. Admission re-reads the Run with the
 * database clock before its final check, so a completion committed during the
 * transaction narrows the admitted window; one that commits later is serially
 * after this admission (every observation is at or before that clock sample).
 * A Run deleted meanwhile fails the usage FK insert, reported as 404.
 */
export function xUsageRunQuery(owner: Owner) {
  return new QueryBuilder()
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      createdAt: agentRuns.createdAt,
      completedAt: agentRuns.completedAt,
      startedAt: sql`${agentRuns.createdAt}::text`
        .mapWith(pgTextDecoder)
        .as("started_at"),
      triggerSource: agentRuns.triggerSource,
      threadId: agentRuns.chatThreadId,
      modelProvider: agentRuns.modelProvider,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, owner.runId),
        eq(agentRuns.orgId, owner.orgId),
        eq(agentRuns.userId, owner.userId),
      ),
    )
    .as("x_usage_run");
}

export function billableXUsage(
  events: readonly UsageObservation[],
  run: {
    readonly triggerSource: string | null;
    readonly modelProvider: string | null;
  },
) {
  return events.filter((event) => {
    return (
      event.quantity > 0 &&
      (event.kind !== "model" ||
        run.triggerSource === null ||
        run.modelProvider === null ||
        isBuiltInModelProviderType(run.modelProvider))
    );
  });
}

function sourceColumns() {
  return {
    source: usageEvent.idempotencyKey,
    runId: usageEvent.runId,
    orgId: usageEvent.orgId,
    userId: usageEvent.userId,
    kind: usageEvent.kind,
    provider: usageEvent.provider,
    category: usageEvent.category,
  };
}
type PriorSource = Pick<
  typeof usageEvent.$inferSelect,
  "runId" | "orgId" | "userId" | "kind" | "provider" | "category"
> & { readonly source: string };
export function usageSourceRetryQuery(sources: readonly string[]) {
  return new QueryBuilder()
    .select(sourceColumns())
    .from(usageEvent)
    .where(inArray(usageEvent.idempotencyKey, sources))
    .as("usage_source_retries");
}
export function checkUsageSourceRetries(
  prior: readonly PriorSource[],
  events: readonly UsageObservation[],
  owner: Owner,
): void {
  const bySource = new Map(
    prior.map((row) => {
      return [row.source, row];
    }),
  );
  for (const event of events) {
    const row = bySource.get(event.idempotencyKey);
    if (
      !row ||
      row.runId !== owner.runId ||
      row.orgId !== owner.orgId ||
      row.userId !== owner.userId ||
      row.kind !== event.kind ||
      row.provider !== event.provider ||
      row.category !== event.category
    ) {
      throw new XResourceUsageError(
        409,
        "Usage source identity conflicts with this request",
      );
    }
  }
}

function resourceKey(value: typeof xResourceReads.$inferInsert): string {
  return `${value.utcDay}:${value.resourceType}:${value.resourceId}`;
}
export function xUsageResourceClaims(
  events: readonly UsageObservation[],
  owned: ReadonlySet<string>,
) {
  const quantities = new Map<string, number>();
  const claims = new Map<
    string,
    { read: typeof xResourceReads.$inferInsert; source: string }
  >();
  for (const event of events) {
    if (!owned.has(event.idempotencyKey)) {
      continue;
    }
    if (!("protocol" in event)) {
      quantities.set(event.idempotencyKey, event.quantity);
      continue;
    }
    quantities.set(
      event.idempotencyKey,
      event.remainder.reduce((sum, item) => {
        return sum + item.quantity;
      }, 0),
    );
    for (const resource of event.resources) {
      const read = {
        utcDay: event.observedAt.slice(0, 10),
        resourceType: event.category === "posts.read" ? "post" : "user",
        resourceId: resource.id,
      };
      const key = resourceKey(read);
      if (!claims.has(key)) {
        claims.set(key, { read, source: event.idempotencyKey });
      }
    }
  }
  const ordered = [...claims.entries()]
    .sort(([left], [right]) => {
      return left.localeCompare(right);
    })
    .map(([, claim]) => {
      return claim.read;
    });
  return { quantities, claims, ordered };
}
export function resourceUsagePublicationSql(
  prepared: ReturnType<typeof xUsageResourceClaims>,
  reads: readonly (typeof xResourceReads.$inferSelect)[],
) {
  const quantities = new Map(prepared.quantities);
  for (const read of reads) {
    const claim = prepared.claims.get(resourceKey(read));
    if (!claim) {
      throw new Error("Inserted resource has no source owner");
    }
    const quantity = quantities.get(claim.source);
    if (quantity === undefined) {
      throw new Error("Resource owner has no quantity");
    }
    quantities.set(claim.source, quantity + 1);
  }
  const positive = [...quantities].filter(([, quantity]) => {
    return quantity > 0;
  });
  const zero = [...quantities]
    .filter(([, quantity]) => {
      return quantity === 0;
    })
    .map(([source]) => {
      return source;
    });
  const remove = sql`DELETE FROM ${usageEvent} WHERE ${usageEvent.idempotencyKey} = ANY(${sql.param(zero)}::uuid[])`;
  if (positive.length === 0) {
    return remove;
  }
  const values = positive.map(([source, amount]) => {
    return sql`(${source}::uuid, ${amount}::bigint)`;
  });
  return sql`WITH removed AS (${remove}) UPDATE ${usageEvent} SET quantity = observed.amount
    FROM (VALUES ${sql.join(values, sql`, `)}) AS observed(source, amount)
    WHERE ${usageEvent.idempotencyKey} = observed.source`;
}
