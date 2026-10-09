import { billingRunAttribution } from "@okouai/db/schema/billing-run-attribution";
import {
  AUTO_SELECTED_MODEL,
  isAutoRunPreset,
} from "@okouai/core/auto-run-model";
import { isBuiltInModelProviderType } from "@okouai/api-contracts/contracts/model-providers";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { usageEvent } from "@okouai/db/schema/usage-event";
import { command } from "ccstate";
import { and, eq, sql } from "drizzle-orm";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { settle } from "../utils";
import { writeDb$ } from "../external/db";
import {
  attributedUsageIdentity,
  managedAttributionQuery,
  managedAttributionWrite,
  managedBillingRunQuery,
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
      if (event.kind !== "model" || run.selectedModel !== AUTO_SELECTED_MODEL) {
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
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0234; new non-billing transactions are prohibited.
      db.transaction(async (tx) => {
        const [run] = await tx
          .select({
            id: agentRuns.id,
            orgId: agentRuns.orgId,
            userId: agentRuns.userId,
            startedAt: sql`${agentRuns.createdAt}::text`.mapWith(pgTextDecoder),
            triggerSource: agentRuns.triggerSource,
            threadId: agentRuns.chatThreadId,
            modelProvider: agentRuns.modelProvider,
            selectedModel: agentRuns.selectedModel,
            modelRuntimeModel: agentRuns.modelRuntimeModel,
          })
          .from(agentRuns)
          .where(
            and(
              eq(agentRuns.id, args.runId),
              eq(agentRuns.orgId, args.orgId),
              eq(agentRuns.userId, args.userId),
            ),
          );
        if (!run) {
          throw new RunnerUsageRunMissingError("Run not found");
        }
        const events = billableRunnerEvents(args.events, run);
        if (events.length === 0) {
          return;
        }
        let [attribution] = await tx
          .select()
          .from(managedAttributionQuery(args.runId));
        if (!attribution) {
          const capture = managedAttributionWrite({ actor: args }, run);
          [attribution] = await tx
            .insert(billingRunAttribution)
            .values(capture.values)
            .onConflictDoUpdate(capture.conflict)
            .returning({
              runId: billingRunAttribution.runId,
              orgId: billingRunAttribution.orgId,
              userId: billingRunAttribution.userId,
              startedAt:
                sql`${billingRunAttribution.runStartedAt}::text`.mapWith(
                  pgTextDecoder,
                ),
            });
          if (!attribution) {
            throw new Error("Runner usage attribution conflicts with history");
          }
        }
        const identity = attributedUsageIdentity(
          { actor: args },
          run,
          attribution,
        );
        const inserted = await tx
          .insert(usageEvent)
          .values(
            events.map((event) => {
              return {
                ...event,
                ...identity,
                orgId: args.orgId,
                userId: args.userId,
              };
            }),
          )
          .onConflictDoNothing({ target: usageEvent.idempotencyKey })
          .returning({ id: usageEvent.id });
        if (inserted.length > 0) {
          await tx
            .update(billingRunAttribution)
            .set({ usageObserved: true })
            .where(
              and(
                eq(billingRunAttribution.runId, args.runId),
                eq(billingRunAttribution.usageObserved, false),
              ),
            );
        }
        signal.throwIfAborted();
      }),
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
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0235; new non-billing transactions are prohibited.
    await db.transaction(async (tx) => {
      const [run] = runId
        ? await tx.select().from(managedBillingRunQuery(runId))
        : [];
      let [attribution] = runId
        ? await tx.select().from(managedAttributionQuery(runId))
        : [];
      if (!attribution && run) {
        const capture = managedAttributionWrite({ actor }, run);
        [attribution] = await tx
          .insert(billingRunAttribution)
          .values(capture.values)
          .onConflictDoUpdate(capture.conflict)
          .returning({
            runId: billingRunAttribution.runId,
            orgId: billingRunAttribution.orgId,
            userId: billingRunAttribution.userId,
            startedAt: sql`${billingRunAttribution.runStartedAt}::text`.mapWith(
              pgTextDecoder,
            ),
          });
        if (!attribution) {
          throw new Error(
            "Provider usage Run attribution conflicts with history",
          );
        }
      }
      const identity = attributedUsageIdentity({ actor }, run, attribution);
      const inserted = await tx
        .insert(usageEvent)
        .values(
          args.events.map((event) => {
            return {
              ...event,
              ...identity,
              orgId: args.orgId,
              userId: args.userId,
              // An old generation with no original identity is not proof of runless usage.
              ...(!runId && args.billingContext !== "runless"
                ? {
                    billingContext: "legacy_unknown",
                    billingAnchorAt: null,
                  }
                : {}),
              // Retained billing identity alone never restores a deleted content link.
              runId: args.runId === undefined ? null : identity.runId,
            };
          }),
        )
        .onConflictDoNothing({ target: usageEvent.idempotencyKey })
        .returning({ id: usageEvent.id });
      if (inserted.length > 0 && attribution) {
        await tx
          .update(billingRunAttribution)
          .set({ usageObserved: true })
          .where(
            and(
              eq(billingRunAttribution.runId, attribution.runId),
              eq(billingRunAttribution.usageObserved, false),
            ),
          );
      }
      signal.throwIfAborted();
    });
    signal.throwIfAborted();
  },
);
