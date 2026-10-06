import { createStore } from "ccstate";
import { z } from "zod";

import { recordChatEventSnapshotCompleted } from "../signals/routes/cron-snapshot-chat-events";
import { snapshotChatEvents$ } from "../signals/services/cron-snapshot-chat-events.service";

const ownedSnapshotScopeSchema = z.object({
  chatThreadIds: z.array(z.uuid()).max(100),
  r2ObjectKeys: z.array(z.string().min(1)).max(2000),
});

// Empty thread or object-key scopes remain valid for independently owned work.
export async function snapshotChatEventsForTest(
  chatThreadIds: readonly string[],
  r2ObjectKeys: readonly string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const scope = ownedSnapshotScopeSchema.parse({ chatThreadIds, r2ObjectKeys });
  const result = await createStore().set(
    snapshotChatEvents$,
    { kind: "fixtures", ...scope },
    signal,
  );
  signal.throwIfAborted();
  recordChatEventSnapshotCompleted(result);
  return result;
}
