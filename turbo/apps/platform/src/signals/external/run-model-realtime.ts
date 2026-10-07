import { command } from "ccstate";
import { setAblyInvalidationLoop$ } from "../realtime.ts";
import { invalidateModelCatalog$ } from "./model-catalog.ts";
import { invalidateAvailableRunModels$ } from "./run-models.ts";

/**
 * Only invalidate the cheap available-model projection and the global model
 * catalog. Listing subscriptions
 * here would read upstream usage for every notice and connection resync.
 */
export const setupRunModelRealtime$ = command(
  ({ set }, signal: AbortSignal): void => {
    set(
      setAblyInvalidationLoop$,
      {
        scope: "user",
        topic: "runModelsChanged",
        invalidations: [invalidateAvailableRunModels$, invalidateModelCatalog$],
      },
      signal,
    );
  },
);
