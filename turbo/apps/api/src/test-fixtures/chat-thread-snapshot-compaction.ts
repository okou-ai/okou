import { createStore } from "ccstate";
import { z } from "zod";

import { compactChatThreadSnapshots$ } from "../signals/services/cron-compact-chat-thread-snapshots.service";

const ownedScopesSchema = z
  .array(z.object({ userId: z.string().min(1), orgId: z.string().min(1) }))
  .min(1)
  .max(100);

// User and organization IDs are nonempty strings, not necessarily UUIDs.
export async function compactChatThreadSnapshotsForTest(
  scopes: readonly { readonly userId: string; readonly orgId: string }[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const ownedScopes = ownedScopesSchema.parse(scopes);
  const result = await createStore().set(
    compactChatThreadSnapshots$,
    { kind: "fixtures", scopes: ownedScopes },
    signal,
  );
  signal.throwIfAborted();
  return result;
}
