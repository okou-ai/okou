import { command } from "ccstate";
import { connectorCatalogStatus$ } from "../external/connectors.ts";
import { waitForOperation } from "../utils.ts";

/** Wait for the catalog already requested by the first onboarding step. */
export const waitForSourcesFirstCatalog$ = command(
  async ({ get }, signal: AbortSignal): Promise<void> => {
    await waitForOperation(get(connectorCatalogStatus$), signal);
    signal.throwIfAborted();
  },
);
