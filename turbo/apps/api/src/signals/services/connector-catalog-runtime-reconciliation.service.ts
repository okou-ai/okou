import { command } from "ccstate";
import { writeDb$ } from "../external/db";
import { reconcileConnectorCatalogRuntimeProjectionInTransaction } from "./connector-catalog-runtime-projection.service";

/** Legacy projection repair is not an immutable-catalog activation. */
export const reconcileConnectorCatalogRuntimeProjection$ = command(
  async ({ set }, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    await db.transaction(async (tx) => {
      await reconcileConnectorCatalogRuntimeProjectionInTransaction(tx);
    });
    signal.throwIfAborted();
  },
);
