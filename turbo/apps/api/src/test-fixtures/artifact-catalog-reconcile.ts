import { createStore } from "ccstate";

import { reconcileArtifactCatalogFilesForIds$ } from "../signals/services/artifact-catalog.service";

// Invoke the real finite worker for only the files owned by the calling test.
export async function reconcileArtifactCatalogFilesForTest(
  fileIds: readonly string[],
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const result = await createStore().set(
    reconcileArtifactCatalogFilesForIds$,
    fileIds,
    signal,
  );
  signal.throwIfAborted();
  return result;
}
