import { command } from "ccstate";
import {
  connectorRuntimeTargetKey,
  type ConnectorRuntimeTarget,
} from "@okouai/api-contracts/contracts/runners";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { and, eq, isNotNull, type SQL } from "drizzle-orm";

import { logger } from "../../lib/log";
import { db$, type ReadonlyDb } from "../external/db";
import { publishConnectorRuntimeSyncBatch } from "../external/realtime";
import {
  connectorRuntimeWakeupBatches,
  type ConnectorRuntimeWakeup,
} from "./connector-runtime-wakeup-batches";
import { settle } from "../utils";

const L = logger("ConnectorRuntimeWakeup");

interface ConnectorRuntimeWakeupScope {
  readonly orgId: string;
  readonly userId?: string;
  readonly agentId?: string;
}

interface ConnectorRuntimeWakeupArgs {
  readonly db: ReadonlyDb;
  readonly scope: ConnectorRuntimeWakeupScope;
  readonly targets: readonly ConnectorRuntimeTarget[];
}

/**
 * Treats a committed mutation and its best-effort wakeup as one cancellation
 * boundary. Callers may observe request cancellation only after this returns.
 */
export async function commitConnectorRuntimeMutation<T>(
  commit: Promise<T>,
  wakeupForResult: (result: T) => ConnectorRuntimeWakeupArgs | undefined,
): Promise<T> {
  const result = await commit;
  const wakeup = wakeupForResult(result);
  if (wakeup) {
    await (async () => {
      const result = await settle(
        (async () => {
          const targets = uniqueConnectorRuntimeTargets(wakeup.targets);
          if (targets.length === 0) {
            return;
          }

          const rows = await wakeup.db
            .select({ runId: agentRuns.id, runnerGroup: agentRuns.runnerGroup })
            .from(agentRuns)

            .where(connectorRuntimeWakeupCondition(wakeup.scope));

          await publishConnectorRuntimeWakeupRows({
            scope: wakeup.scope,
            targets,
            rows,
          });
        })(),
      );
      if (!result.ok) {
        reportConnectorRuntimeWakeupDiscoveryFailure({
          orgId: wakeup.scope.orgId,
          scopedToUser: wakeup.scope.userId !== undefined,
          scopedToAgent: wakeup.scope.agentId !== undefined,
          targetCount: uniqueConnectorRuntimeTargets(wakeup.targets).length,
          error: result.error,
        });
      }
    })();
  }
  return result;
}

export function uniqueConnectorRuntimeTargets(
  targets: readonly ConnectorRuntimeTarget[],
): readonly ConnectorRuntimeTarget[] {
  const targetsByKey = new Map<string, ConnectorRuntimeTarget>();
  for (const target of targets) {
    targetsByKey.set(connectorRuntimeTargetKey(target), target);
  }
  return [...targetsByKey.values()];
}

export interface ConnectorRuntimeWakeupBusinessArgs {
  readonly scope: ConnectorRuntimeWakeupScope;
  readonly targets: readonly ConnectorRuntimeTarget[];
}

export function connectorRuntimeWakeupCondition(
  scope: ConnectorRuntimeWakeupScope,
) {
  const conditions: SQL[] = [
    eq(agentRuns.orgId, scope.orgId),
    eq(agentRuns.status, "running"),
    isNotNull(agentRuns.runnerGroup),
  ];
  if (scope.userId !== undefined) {
    conditions.push(eq(agentRuns.userId, scope.userId));
  }
  if (scope.agentId !== undefined) {
    conditions.push(eq(agentRuns.agentId, scope.agentId));
  }
  return and(...conditions);
}

export async function publishConnectorRuntimeWakeupRows(
  args: ConnectorRuntimeWakeupBusinessArgs & {
    readonly rows: readonly {
      readonly runId: string;
      readonly runnerGroup: string | null;
    }[];
  },
): Promise<void> {
  const { rows, targets } = args;
  const wakeups: ConnectorRuntimeWakeup[] = [];
  const wakeupKeys = new Set<string>();
  for (const row of rows) {
    if (!row.runnerGroup) {
      continue;
    }
    for (const target of targets) {
      const targetKey = connectorRuntimeTargetKey(target);
      const wakeupKey = `${row.runId}:${targetKey}`;
      if (wakeupKeys.has(wakeupKey)) {
        continue;
      }
      wakeupKeys.add(wakeupKey);
      wakeups.push({
        runId: row.runId,
        runnerGroup: row.runnerGroup,
        target,
      });
    }
  }

  const batches = connectorRuntimeWakeupBatches(wakeups);
  const pending = batches.values();
  let failedBatchCount = 0;
  let failedWakeupCount = 0;
  let firstFailure:
    | { readonly wakeup: ConnectorRuntimeWakeup; readonly error: unknown }
    | undefined;
  async function publishBatches(): Promise<void> {
    for (const batch of pending) {
      const outcome = await settle(
        publishConnectorRuntimeSyncBatch(batch.runnerGroup, batch.messages),
      );
      if (!outcome.ok) {
        failedBatchCount += 1;
        failedWakeupCount += batch.wakeups.length;
        const [wakeup] = batch.wakeups;
        if (wakeup) {
          firstFailure ??= { wakeup, error: outcome.error };
        }
      }
    }
  }
  // Bound request concurrency per mutation; this is not a cross-instance rate limiter.
  await Promise.all(
    Array.from({ length: Math.min(4, batches.length) }, publishBatches),
  );

  if (firstFailure) {
    L.warn("Failed to publish connector runtime sync wakeups", {
      orgId: args.scope.orgId,
      scopedToUser: args.scope.userId !== undefined,
      scopedToAgent: args.scope.agentId !== undefined,
      targetCount: targets.length,
      examinedRunCount: rows.length,
      batchCount: batches.length,
      failedBatchCount,
      failedWakeupCount,
      firstFailedRunId: firstFailure.wakeup.runId,
      firstFailedRunnerGroup: firstFailure.wakeup.runnerGroup,
      firstFailedTarget: firstFailure.wakeup.target,
      error: firstFailure.error,
    });
  }
  L.debug("Published connector runtime sync wakeups", {
    orgId: args.scope.orgId,
    scopedToUser: args.scope.userId !== undefined,
    scopedToAgent: args.scope.agentId !== undefined,
    targetCount: targets.length,
    examinedRunCount: rows.length,
    matchedWakeupCount: wakeups.length,
    publishedWakeupCount: wakeups.length - failedWakeupCount,
    failedWakeupCount,
    batchCount: batches.length,
    publishedBatchCount: batches.length - failedBatchCount,
    failedBatchCount,
  });
}

export function reportConnectorRuntimeWakeupDiscoveryFailure(args: {
  readonly orgId: string;
  readonly scopedToUser: boolean;
  readonly scopedToAgent: boolean;
  readonly targetCount: number;
  readonly error: unknown;
}): void {
  L.warn("Failed to discover connector runtime sync wakeups", args);
}

/** Post-commit notification owns its read and never receives a database handle. */
export const publishConnectorRuntimeSyncWakeups$ = command(
  async (
    { get },
    args: ConnectorRuntimeWakeupBusinessArgs,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
    const targets = uniqueConnectorRuntimeTargets(args.targets);
    if (targets.length === 0) {
      signal.throwIfAborted();
      return;
    }
    // A committed mutation must attempt its wakeup before observing cancellation.
    // eslint-disable-next-line api/signal-check-await -- Finish the committed runtime wakeup before propagating cancellation.
    const read = await settle(
      db
        .select({ runId: agentRuns.id, runnerGroup: agentRuns.runnerGroup })
        .from(agentRuns)

        .where(connectorRuntimeWakeupCondition(args.scope)),
    );
    const result = read.ok
      ? await settle(
          publishConnectorRuntimeWakeupRows({
            scope: args.scope,
            targets,
            rows: read.value,
          }),
        )
      : read;
    if (!result.ok) {
      L.warn("Failed to discover connector runtime sync wakeups", {
        orgId: args.scope.orgId,
        scopedToUser: args.scope.userId !== undefined,
        scopedToAgent: args.scope.agentId !== undefined,
        targetCount: targets.length,
        error: result.error,
      });
    }
    signal.throwIfAborted();
  },
);
