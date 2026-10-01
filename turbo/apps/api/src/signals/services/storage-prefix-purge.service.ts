import { command } from "ccstate";

import { logger } from "../../lib/log";
import { tapError } from "../utils";
import { executeStorageObjectCleanupWork$ } from "./storage-object-cleanup.service";

const L = logger("StoragePrefixPurge");

/**
 * Attempt a bounded batch only after reference deletion and cleanup inventory
 * have committed together. Post-commit effects may fail or cancel before this
 * optional attempt; cron still owns the durable exact targets. The worker keeps
 * its ordinary live-reference checks, page bounds and retry/lease fencing.
 */
export const purgeDeletedStoragePrefix$ = command(
  async (
    { set },
    args: { readonly jobIds: readonly string[] },
    signal: AbortSignal,
  ): Promise<void> => {
    await tapError(
      set(executeStorageObjectCleanupWork$, args, signal),
      (error) => {
        L.warn("Failed to attempt durable storage cleanup", {
          jobIds: args.jobIds,
          error,
        });
      },
    );
    signal.throwIfAborted();
  },
);
