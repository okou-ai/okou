import { cronCompactChatThreadSnapshotsContract } from "@okouai/api-contracts/contracts/cron";
import { command } from "ccstate";

import type { RouteEntry } from "../route-entry";
import { compactChatThreadSnapshots$ } from "../services/cron-compact-chat-thread-snapshots.service";
import { cronUnauthorized, hasValidCronSecret$ } from "./cron-auth";

const compactChatThreadSnapshotsRoute$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!get(hasValidCronSecret$)) {
      return cronUnauthorized();
    }

    const result = await set(compactChatThreadSnapshots$, signal);
    signal.throwIfAborted();
    return {
      status: 200 as const,
      body: { success: true as const, ...result },
    };
  },
);

export const cronCompactChatThreadSnapshotsRoutes: readonly RouteEntry[] = [
  {
    route: cronCompactChatThreadSnapshotsContract.compact,
    handler: compactChatThreadSnapshotsRoute$,
  },
];
