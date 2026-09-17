import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import { reconcileConnectorCatalogRuntimeProjectionInTransaction } from "./connector-catalog-runtime-projection.service";
import { invalidateAllPiStableContexts } from "./pi-stable-context-generation.service";

/** Atomically publish a repaired runtime projection and its stable-context demand. */
export const reconcileConnectorCatalogRuntimeProjection$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const changed =
        await reconcileConnectorCatalogRuntimeProjectionInTransaction(tx);
      if (changed) {
        await invalidateAllPiStableContexts(tx);
      }
    });
    signal.throwIfAborted();
  },
);
