import { command } from "ccstate";
import {
  commitRunCancellation$,
  commitClerkDeletedOwnerRuns$,
  type CancelRunArgs,
  type DeletedOwner,
} from "./agent-run-terminal-transition.service";
import { scheduleReleasedSlotPicks$ } from "./agent-run-slot-scheduling.service";

/** Schedule only the committed releases, before cancellation's other effects. */
export const cancelRun$ = command(
  async ({ set }, args: CancelRunArgs, signal: AbortSignal) => {
    const committed = await set(commitRunCancellation$, args, signal);
    signal.throwIfAborted();
    set(scheduleReleasedSlotPicks$, committed.releasedSlots, signal);
    return committed.result;
  },
);

export const cancelClerkDeletedOwnerRuns$ = command(
  async ({ set }, owner: DeletedOwner, signal: AbortSignal) => {
    const runs = await set(commitClerkDeletedOwnerRuns$, owner, signal);
    signal.throwIfAborted();
    set(
      scheduleReleasedSlotPicks$,
      runs.flatMap((run) => {
        return run.releasedOrgId === null
          ? []
          : [{ runId: run.runId, orgId: run.releasedOrgId }];
      }),
      signal,
    );
    return runs;
  },
);
