import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import { reconcileConnectorCatalogRuntimeProjectionInTransaction } from "./connector-catalog-runtime-projection.service";
import {
  connectorCatalogSource,
  connectorCatalogSourceIsTestScoped,
} from "./connector-catalog-source";
import {
  invalidateAllPiStableContexts,
  invalidatePiStableContextsForCatalogSource,
} from "./pi-stable-context-generation.service";

/** Atomically publish a repaired runtime projection and its stable-context demand. */
export const reconcileConnectorCatalogRuntimeProjection$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const changed =
        await reconcileConnectorCatalogRuntimeProjectionInTransaction(tx);
      if (changed) {
        if (connectorCatalogSourceIsTestScoped()) {
          await invalidatePiStableContextsForCatalogSource(
            tx,
            connectorCatalogSource().sourceId,
          );
        } else {
          await invalidateAllPiStableContexts(tx);
        }
      }
    });
    signal.throwIfAborted();
  },
);
