import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import {
  AUTO_SELECTED_MODEL,
  isAutoRunPreset,
} from "@okouai/core/auto-run-model";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { and, count, eq, exists, ne, notExists, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import {
  nullableDriverValueDecoder,
  pgIntegerDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";
import { isForeignKeyViolation, safeSqlStateCode } from "../../lib/pg-errors";
import { settle } from "../utils";
import { writeDb$ } from "../external/db";
import {
  attributedUsageIdentity,
  managedAttributionQuery,
  managedAttributionWrite,
  managedBillingRunQuery,
  type BillingAttribution,
  type BillingRun,
} from "./managed-usage-attribution";

interface ProviderUsageBatch {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string | undefined;
  readonly billingRunId?: string | null;
  readonly billingContext: string;
  readonly events: readonly {
    readonly idempotencyKey: string;
    readonly kind: string;
    readonly provider: string;
    readonly category: string;
    readonly quantity: number;
  }[];
}

export class RunnerUsageRunMissingError extends Error {}

interface RunnerUsageBatch {
  readonly orgId: string;
  readonly userId: string;
  readonly runId: string;
  readonly events: ProviderUsageBatch["events"];
}

function billableRunnerEvents(
  events: ProviderUsageBatch["events"],
  run: {
    readonly triggerSource: string | null;
    readonly modelProvider: string | null;
    readonly selectedModel: string | null;
    readonly modelRuntimeModel: string | null;
    readonly modelUsageProvider: string | null;
  },
) {
  return events
    .filter((event) => {
      return (
        event.quantity > 0 &&
        (event.kind !== "model" ||
          run.triggerSource === null ||
          run.modelProvider === null ||
          isBuiltInModelProviderType(run.modelProvider))
      );
    })
    .map((event) => {
      if (event.kind !== "model") {
        return event;
      }
      if (run.modelUsageProvider !== null) {
        return { ...event, provider: run.modelUsageProvider };
      }
      // Outgoing API captures have no independent usage identity until the operator backfill.
      if (run.selectedModel !== AUTO_SELECTED_MODEL) {
        return event;
      }
      if (!isAutoRunPreset(run.modelRuntimeModel)) {
        throw new Error(
          "Canonical Auto usage requires its captured runtime model",
        );
      }
      // The Run, not an upstream response or the current org preset, owns billing.
      // Legacy captures below PR2 retain their producer's original billing key.
      return { ...event, provider: run.modelRuntimeModel };
    })
    .sort((left, right) => {
      return left.idempotencyKey
        .toLowerCase()
        .localeCompare(right.idempotencyKey.toLowerCase());
    });
}

function runnerUsageRunQuery(
  args: Pick<RunnerUsageBatch, "runId" | "orgId" | "userId">,
) {
  return new QueryBuilder()
    .select({
      id: agentRuns.id,
      orgId: agentRuns.orgId,
      userId: agentRuns.userId,
      startedAt: sql`${agentRuns.createdAt}::text`
        .mapWith(pgTextDecoder)
        .as("started_at"),
      triggerSource: agentRuns.triggerSource,
      threadId: agentRuns.chatThreadId,
      status: agentRuns.status,
      billingCompletedAt: sql`${agentRuns.completedAt}::text`
        .mapWith(nullableDriverValueDecoder(pgTextDecoder))
        .as("billing_completed_at"),
      modelProvider: agentRuns.modelProvider,
      selectedModel: agentRuns.selectedModel,
      modelRuntimeModel: agentRuns.modelRuntimeModel,
      modelUsageProvider: agentRuns.modelUsageProvider,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.id, args.runId),
        eq(agentRuns.orgId, args.orgId),
        eq(agentRuns.userId, args.userId),
      ),
    )
    .as("runner_usage_run");
}

function preparedRunnerUsageValues(
  args: RunnerUsageBatch,
  events: ProviderUsageBatch["events"],
  run: BillingRun,
  attribution: BillingAttribution | undefined,
) {
  const capture = attribution
    ? undefined
    : managedAttributionWrite({ actor: args }, run);
  const expectedAttribution = attribution ?? {
    runId: run.id,
    orgId: run.orgId,
    userId: run.userId,
    startedAt: run.startedAt,
  };
  const identity = attributedUsageIdentity(
    { actor: args },
    run,
    expectedAttribution,
  );
  return {
    capture,
    values: events.map((event) => {
      return {
        ...event,
        ...identity,
        orgId: args.orgId,
        userId: args.userId,
      };
    }),
  };
}

/** A Runner batch retains its live owner and commits captured identity with its events. */
export const recordRunnerUsageBatch$ = command(
  async (
    { set },
    args: RunnerUsageBatch,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const outcome = await settle(
      (async () => {
        const [run] = await db.select().from(runnerUsageRunQuery(args));
        if (!run) {
          throw new RunnerUsageRunMissingError("Run not found");
        }
        const events = billableRunnerEvents(args.events, run);
        if (events.length === 0) {
          return;
        }
        const [attribution] = await db
          .select()
          .from(managedAttributionQuery(args.runId));
        const { capture, values } = preparedRunnerUsageValues(
          args,
          events,
          run,
          attribution,
        );
        signal.throwIfAborted();
        if (capture) {
          const expectedInsert = providerBatchInsertionExpected(values);
          const captured = db.$with("runner_captured_attribution").as(
            db
              .insert(billingRunAttribution)
              .values({ ...capture.values, usageObserved: expectedInsert })
              .onConflictDoUpdate({
                ...capture.conflict,
                set: {
                  ...capture.conflict.set,
                  usageObserved: or(
                    eq(billingRunAttribution.usageObserved, true),
                    expectedInsert,
                  ),
                },
              })
              .returning({ runId: billingRunAttribution.runId }),
          );
          const captureCount = db.select({ value: count() }).from(captured);
          const inserted = db.$with("runner_inserted_usage").as(
            db
              .insert(usageEvent)
              .values(
                values.map((value) => {
                  return {
                    ...value,
                    // Resolve the real capture before any event's Run FK lock.
                    quantity: sql`${sql.param(value.quantity, usageEvent.quantity)}::bigint / (${captureCount})`,
                  };
                }),
              )
              .onConflictDoNothing({ target: usageEvent.idempotencyKey })
              .returning({ id: usageEvent.id }),
          );
          const insertedAny = exists(
            db.select({ id: inserted.id }).from(inserted),
          );
          const query = db
            .with(captured, inserted)
            .select({
              checked:
                sql`1 / CASE WHEN ${ne(count(), 1)} THEN 0 WHEN ${ne(insertedAny, expectedInsert)} THEN 0 ELSE 1 END`.mapWith(
                  pgIntegerDecoder,
                ),
            })
            .from(captured);
          // Re-execute once only after a definite guarded statement rollback,
          // retaining this same filtered/sorted batch and captured Run context.
          for (let attempt = 0; attempt < 2; attempt += 1) {
            const published = await settle(
              (async () => {
                await query;
              })(),
            );
            signal.throwIfAborted();
            if (published.ok) {
              return;
            }
            if (safeSqlStateCode(published.error) !== "22012") {
              throw published.error;
            }
            if (attempt === 1) {
              throw new Error(
                "Runner usage attribution conflicts with history",
              );
            }
          }
        }
        const inserted = db
          .$with("runner_inserted_usage")
          .as(
            db
              .insert(usageEvent)
              .values(values)
              .onConflictDoNothing({ target: usageEvent.idempotencyKey })
              .returning({ id: usageEvent.id }),
          );
        const observed = db.$with("runner_observed_attribution").as(
          db
            .update(billingRunAttribution)
            .set({ usageObserved: true })
            .where(
              and(
                eq(billingRunAttribution.runId, args.runId),
                eq(billingRunAttribution.usageObserved, false),
                exists(db.select({ id: inserted.id }).from(inserted)),
              ),
            ),
        );
        await db
          .with(inserted, observed)
          .select({ id: inserted.id })
          .from(inserted);
        signal.throwIfAborted();
      })(),
      signal,
    );
    // usage_event.run_id is the only FK written here. Its implicit key-share
    // check replaces a Run row lock; losing it means the Run was deleted after
    // the read above, the same outcome as a Run that was never found.
    if (!outcome.ok) {
      throw isForeignKeyViolation(outcome.error)
        ? new RunnerUsageRunMissingError("Run not found")
        : outcome.error;
    }
  },
);

function providerBatchInsertionExpected(events: ProviderUsageBatch["events"]) {
  return sql`(${sql.join(
    events.map((event) => {
      return notExists(
        new QueryBuilder()
          .select({ id: usageEvent.id })
          .from(usageEvent)
          .where(eq(usageEvent.idempotencyKey, event.idempotencyKey)),
      );
    }),
    sql` OR `,
  )})`;
}

function preparedProviderUsageValues(
  args: ProviderUsageBatch,
  actor: Pick<ProviderUsageBatch, "orgId" | "userId" | "runId">,
  run: BillingRun | undefined,
  attribution: BillingAttribution | undefined,
) {
  const capture =
    !attribution && run ? managedAttributionWrite({ actor }, run) : undefined;
  const expectedAttribution =
    attribution ??
    (capture && run
      ? {
          runId: run.id,
          orgId: run.orgId,
          userId: run.userId,
          startedAt: run.startedAt,
        }
      : undefined);
  const identity = attributedUsageIdentity({ actor }, run, expectedAttribution);
  const values = args.events.map((event) => {
    return {
      ...event,
      ...identity,
      orgId: args.orgId,
      userId: args.userId,
      // An old generation with no original identity is not proof of runless usage.
      ...(!actor.runId && args.billingContext !== "runless"
        ? { billingContext: "legacy_unknown", billingAnchorAt: null }
        : {}),
      // Retained billing identity alone never restores a deleted content link.
      runId: args.runId === undefined ? null : identity.runId,
    };
  });
  return { capture, values };
}

/** One provider response's categories and captured billing identity commit together. */
export const recordProviderUsageBatch$ = command(
  async (
    { set },
    args: ProviderUsageBatch,
    signal: AbortSignal,
  ): Promise<void> => {
    if (args.events.length === 0) {
      return;
    }
    if (args.runId && args.billingRunId && args.runId !== args.billingRunId) {
      throw new Error("Live and billing Run identities disagree");
    }
    const runId = args.billingRunId ?? args.runId ?? undefined;
    const actor = { orgId: args.orgId, userId: args.userId, runId };
    const db = set(writeDb$);
    signal.throwIfAborted();
    await (async () => {
      const [run] = runId
        ? await db.select().from(managedBillingRunQuery(runId))
        : [];
      const [attribution] = runId
        ? await db.select().from(managedAttributionQuery(runId))
        : [];
      const { capture, values } = preparedProviderUsageValues(
        args,
        actor,
        run,
        attribution,
      );
      signal.throwIfAborted();
      if (capture) {
        const expectedInsert = providerBatchInsertionExpected(values);
        const captured = db.$with("provider_captured_attribution").as(
          db
            .insert(billingRunAttribution)
            .values({ ...capture.values, usageObserved: expectedInsert })
            .onConflictDoUpdate({
              ...capture.conflict,
              set: {
                ...capture.conflict.set,
                usageObserved: or(
                  eq(billingRunAttribution.usageObserved, true),
                  expectedInsert,
                ),
              },
            })
            .returning({ runId: billingRunAttribution.runId }),
        );
        const captureCount = db.select({ value: count() }).from(captured);
        const inserted = db.$with("provider_inserted_usage").as(
          db
            .insert(usageEvent)
            .values(
              values.map((value) => {
                return {
                  ...value,
                  // Resolve the actual capture before any event's Run FK lock.
                  quantity: sql`${sql.param(value.quantity, usageEvent.quantity)}::bigint / (${captureCount})`,
                };
              }),
            )
            .onConflictDoNothing({ target: usageEvent.idempotencyKey })
            .returning({ id: usageEvent.id }),
        );
        const insertedAny = exists(
          db.select({ id: inserted.id }).from(inserted),
        );
        const query = db
          .with(captured, inserted)
          .select({
            checked:
              sql`1 / CASE WHEN ${ne(count(), 1)} THEN 0 WHEN ${ne(insertedAny, expectedInsert)} THEN 0 ELSE 1 END`.mapWith(
                pgIntegerDecoder,
              ),
          })
          .from(captured);
        // Concurrent idempotency winners can invalidate the snapshot prediction.
        // Retry this same atomic statement once, only after definite rollback.
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const published = await settle(
            (async () => {
              await query;
            })(),
          );
          signal.throwIfAborted();
          if (published.ok) {
            return;
          }
          if (safeSqlStateCode(published.error) !== "22012") {
            throw published.error;
          }
          if (attempt === 1) {
            throw new Error(
              "Provider usage Run attribution conflicts with history",
            );
          }
        }
      }
      const inserted = db
        .$with("provider_inserted_usage")
        .as(
          db
            .insert(usageEvent)
            .values(values)
            .onConflictDoNothing({ target: usageEvent.idempotencyKey })
            .returning({ id: usageEvent.id }),
        );
      if (attribution) {
        const observed = db.$with("provider_observed_attribution").as(
          db
            .update(billingRunAttribution)
            .set({ usageObserved: true })
            .where(
              and(
                eq(billingRunAttribution.runId, attribution.runId),
                eq(billingRunAttribution.usageObserved, false),
                exists(db.select({ id: inserted.id }).from(inserted)),
              ),
            ),
        );
        await db
          .with(inserted, observed)
          .select({ id: inserted.id })
          .from(inserted);
      } else {
        await db.with(inserted).select({ id: inserted.id }).from(inserted);
      }
      signal.throwIfAborted();
    })();
    signal.throwIfAborted();
  },
);
