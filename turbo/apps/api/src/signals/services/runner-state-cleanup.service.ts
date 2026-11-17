import { runnerState } from "@okouai/db/runtime/runner-state";
import { command } from "ccstate";
import { and, eq, lt } from "drizzle-orm";

import { writeDb$ } from "../external/db";

const STALE_RUNNER_THRESHOLD_MS = 5 * 60 * 1000;

/** Heartbeats maintain their group; scheduled maintenance owns fleet reclamation. */
export const cleanupStaleRunnerState$ = command(
  async (
    { set },
    scope: { readonly runnerGroup: string | null; readonly at: Date },
    signal: AbortSignal,
  ): Promise<void> => {
    await set(writeDb$)
      .delete(runnerState)
      .where(
        and(
          scope.runnerGroup === null
            ? undefined
            : eq(runnerState.runnerGroup, scope.runnerGroup),
          lt(
            runnerState.lastSeenAt,
            new Date(scope.at.getTime() - STALE_RUNNER_THRESHOLD_MS),
          ),
        ),
      );
    signal.throwIfAborted();
  },
);
