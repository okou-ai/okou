import { command, type Command } from "ccstate";
import { waitUntil } from "../context/wait-until";
import type { ReleasedRunSlot } from "./agent-run-terminal-transition.service";

export type RunSlotPickScheduler = Command<
  void,
  [slots: readonly ReleasedRunSlot[], signal: AbortSignal]
>;

/** Construct scheduling at the queue owner, without importing it into a launcher. */
export function createRunSlotPickScheduler(
  pickOrg$: Command<
    Promise<number>,
    [input: { readonly orgId: string }, signal: AbortSignal]
  >,
): RunSlotPickScheduler {
  return command(
    ({ set }, slots: readonly ReleasedRunSlot[], signal: AbortSignal) => {
      signal.throwIfAborted();
      const orgIds = new Set(
        slots.map((slot) => {
          return slot.orgId;
        }),
      );
      for (const orgId of orgIds) {
        waitUntil(set(pickOrg$, { orgId }, signal));
      }
    },
  );
}
