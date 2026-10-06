import { nowDate } from "../../lib/time";
import {
  invalidatePiStableContextsForCatalogSourceSql,
  invalidateAllPiStableContextsSql,
} from "./pi-stable-context-generation.service";
import { command } from "ccstate";

import { writeDb$ } from "../external/db";
import { reconcileConnectorCatalogRuntimeProjectionInTransaction } from "./connector-catalog-runtime-projection.service";
import {
  connectorCatalogSource,
  connectorCatalogSourceIsTestScoped,
} from "./connector-catalog-source";

/** Atomically publish a repaired runtime projection and its stable-context demand. */
export const reconcileConnectorCatalogRuntimeProjection$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      const changed =
        await reconcileConnectorCatalogRuntimeProjectionInTransaction(tx);
      if (changed) {
        if (connectorCatalogSourceIsTestScoped()) {
          await tx.execute(
            invalidatePiStableContextsForCatalogSourceSql(
              connectorCatalogSource().sourceId,
              nowDate(),
            ),
          );
        } else {
          await tx.execute(invalidateAllPiStableContextsSql(nowDate()));
        }
      }
    });
    signal.throwIfAborted();
  },
);
