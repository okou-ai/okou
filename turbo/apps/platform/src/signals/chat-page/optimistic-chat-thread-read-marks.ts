import { command, computed, state } from "ccstate";

import { now } from "../../lib/time.ts";

/**
 * Local optimistic mark-read timestamps. A thread in the server indicators
 * stays hidden while the local mark is newer than its `unreadAt`.
 */
const internalOptimisticReadMarks$ = state<ReadonlyMap<string, number>>(
  new Map(),
);

export const optimisticReadMarks$ = computed((get) => {
  return get(internalOptimisticReadMarks$);
});

export const recordOptimisticReadMark$ = command(
  ({ get, set }, threadId: string) => {
    const next = new Map(get(internalOptimisticReadMarks$));
    next.set(threadId, now());
    set(internalOptimisticReadMarks$, next);
  },
);

export const clearOptimisticReadMark$ = command(
  ({ get, set }, threadId: string) => {
    const marks = get(internalOptimisticReadMarks$);
    if (!marks.has(threadId)) {
      return;
    }
    const next = new Map(marks);
    next.delete(threadId);
    set(internalOptimisticReadMarks$, next);
  },
);
