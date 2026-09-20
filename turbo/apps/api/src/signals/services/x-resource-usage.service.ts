import { webhookUsageEventContract } from "@okouai/api-contracts/contracts/webhooks";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { assertErasureSubjectWritable } from "@okouai/db/operations/account-erasure";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { xResourceReads } from "@okouai/db/schema/x-resource-usage";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { z } from "zod";

import type { Tx } from "../../lib/db-types";
import type { SandboxAuth } from "../../types/auth";
import type { Db } from "../external/db";
import { settle } from "../utils";
import {
  lockXResourceAdmission,
  readXResourceClock,
  setXResourceTransactionTimeouts,
} from "./x-resource-usage-lifecycle";

type UsageBody = z.output<typeof webhookUsageEventContract.send.body>;
type UsageObservation = UsageBody["events"][number];
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

async function checkObservationTimes(
  tx: Tx,
  events: readonly UsageObservation[],
  runCreatedAt: Date,
  runCompletedAt: Date | null,
): Promise<void> {
  const clock = await readXResourceClock(tx);
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
      observedAt < runCreatedAt.getTime() - CLOCK_TOLERANCE_MS ||
      (runCompletedAt !== null &&
        observedAt > runCompletedAt.getTime() + CLOCK_TOLERANCE_MS)
    ) {
      throw new XResourceUsageError(
        400,
        "X resource observation time is outside the admitted window",
      );
    }
  }
}

function resourceKey(value: typeof xResourceReads.$inferInsert): string {
  return `${value.utcDay}:${value.resourceType}:${value.resourceId}`;
}

async function reserveUsageSources(
  tx: Tx,
  events: readonly UsageObservation[],
  runId: string,
  auth: SandboxAuth,
): Promise<Set<string>> {
  if (events.length === 0) {
    return new Set();
  }
  // Reserve the whole sorted source set before any resource key. Zero
  // placeholders stay invisible to settlement until final quantities commit.
  const inserted = await tx
    .insert(usageEvent)
    .values(
      events.map((event) => {
        return {
          runId,
          orgId: auth.orgId,
          userId: auth.userId,
          kind: event.kind,
          provider: event.provider,
          category: event.category,
          idempotencyKey: event.idempotencyKey,
          quantity: 0,
        };
      }),
    )
    .onConflictDoNothing({ target: usageEvent.idempotencyKey })
    .returning({ source: usageEvent.idempotencyKey });
  const owned = new Set(
    inserted.map((row) => {
      return row.source;
    }),
  );
  const retries = events.filter((event) => {
    return !owned.has(event.idempotencyKey);
  });
  if (retries.length === 0) {
    return owned;
  }
  const prior = await tx
    .select({
      source: usageEvent.idempotencyKey,
      runId: usageEvent.runId,
      orgId: usageEvent.orgId,
      userId: usageEvent.userId,
      kind: usageEvent.kind,
      provider: usageEvent.provider,
      category: usageEvent.category,
    })
    .from(usageEvent)
    .where(
      inArray(
        usageEvent.idempotencyKey,
        retries.map((event) => {
          return event.idempotencyKey;
        }),
      ),
    );
  const bySource = new Map(
    prior.map((row) => {
      return [row.source, row];
    }),
  );
  for (const event of retries) {
    const row = bySource.get(event.idempotencyKey);
    if (
      !row ||
      row.runId !== runId ||
      row.orgId !== auth.orgId ||
      row.userId !== auth.userId ||
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
  return owned;
}

async function claimResources(
  tx: Tx,
  events: readonly UsageObservation[],
  owned: ReadonlySet<string>,
): Promise<Map<string, number>> {
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
  const orderedClaims = [...claims.entries()].sort(([left], [right]) => {
    return left.localeCompare(right);
  });
  if (orderedClaims.length === 0) {
    return quantities;
  }
  const newReads = await tx
    .insert(xResourceReads)
    .values(
      orderedClaims.map(([, claim]) => {
        return claim.read;
      }),
    )
    .onConflictDoNothing()
    .returning();
  for (const read of newReads) {
    const claim = claims.get(resourceKey(read));
    if (!claim) {
      throw new Error("Inserted resource has no source owner");
    }
    const quantity = quantities.get(claim.source);
    if (quantity === undefined) {
      throw new Error("Resource owner has no quantity");
    }
    quantities.set(claim.source, quantity + 1);
  }
  return quantities;
}

/** Complete batch ownership precedes claims. Both commit or both roll back. */
export async function ingestXResourceUsage(
  db: Db,
  body: UsageBody,
  auth: SandboxAuth,
  signal: AbortSignal,
): Promise<void> {
  // UUID spelling is case-insensitive in PostgreSQL; order/deduplicate that identity.
  const events = body.events
    .map((event) => {
      return { ...event, idempotencyKey: event.idempotencyKey.toLowerCase() };
    })
    .sort((left, right) => {
      return left.idempotencyKey.localeCompare(right.idempotencyKey);
    });
  if (
    new Set(
      events.map((event) => {
        return event.idempotencyKey;
      }),
    ).size !== events.length
  ) {
    throw new XResourceUsageError(
      400,
      "Usage source UUIDs must be distinct within a batch",
    );
  }
  await db.transaction(
    async (tx) => {
      await setXResourceTransactionTimeouts(tx);
      const admission = await settle(
        assertErasureSubjectWritable(tx, [
          { subjectKind: "user", subjectId: auth.userId },
          { subjectKind: "organization", subjectId: auth.orgId },
        ]),
      );
      if (!admission.ok) {
        if (
          admission.error instanceof Error &&
          admission.error.message === "account_erasure:subject_closed"
        ) {
          throw new XResourceUsageError(404, "Run not found");
        }
        throw admission.error;
      }
      await lockXResourceAdmission(tx, "shared");
      // Admission precedes Run ownership, matching account cleanup's order.
      // SHARE prevents deletion/owner updates while source rows are created.
      const [run] = await tx
        .select({
          createdAt: agentRuns.createdAt,
          completedAt: agentRuns.completedAt,
          modelProvider: agentRuns.modelProvider,
          triggerSource: agentRuns.triggerSource,
        })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, body.runId),
            eq(agentRuns.orgId, auth.orgId),
            eq(agentRuns.userId, auth.userId),
          ),
        )
        .for("share");
      if (!run) {
        throw new XResourceUsageError(404, "Run not found");
      }
      await checkObservationTimes(tx, events, run.createdAt, run.completedAt);
      signal.throwIfAborted();

      const billable = events.filter((event) => {
        return (
          event.quantity > 0 &&
          (event.kind !== "model" ||
            run.triggerSource === null ||
            run.modelProvider === null ||
            isBuiltInModelProviderType(run.modelProvider))
        );
      });
      const owned = await reserveUsageSources(tx, billable, body.runId, auth);
      await checkObservationTimes(tx, events, run.createdAt, run.completedAt);
      const quantities = await claimResources(tx, billable, owned);
      // Locks acquired by INSERT may have crossed midnight. Cleanup is still
      // excluded; an expired batch rolls all sources and claims back together.
      await checkObservationTimes(tx, events, run.createdAt, run.completedAt);
      const positive = [...quantities].filter(([, quantity]) => {
        return quantity > 0;
      });
      const zeroSources = [...quantities]
        .filter(([, quantity]) => {
          return quantity === 0;
        })
        .map(([source]) => {
          return source;
        });
      // Discard zero results before commit, retaining the shared resource
      // claims but no source receipt. A retry is evaluated again against the
      // current resource history; only persisted positive usage is idempotent.
      if (zeroSources.length > 0) {
        await tx
          .delete(usageEvent)
          .where(inArray(usageEvent.idempotencyKey, zeroSources));
      }
      if (positive.length > 0) {
        const cases = positive.map(([source, quantity]) => {
          return sql`WHEN ${source}::uuid THEN ${quantity}::bigint`;
        });
        await tx
          .update(usageEvent)
          .set({
            quantity: sql`CASE ${usageEvent.idempotencyKey} ${sql.join(cases, sql` `)} END`,
          })
          .where(
            inArray(
              usageEvent.idempotencyKey,
              positive.map(([source]) => {
                return source;
              }),
            ),
          );
      }
      signal.throwIfAborted();
    },
    { isolationLevel: "read committed" },
  );
}
