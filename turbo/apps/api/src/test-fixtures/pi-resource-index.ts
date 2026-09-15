import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { createStore } from "ccstate";
import { and, eq } from "drizzle-orm";

import { db } from "../lib/db";
import { PI_RESOURCE_EXTRACTOR_VERSION } from "../lib/pi-resource-index";
import {
  prepareVolumeServerSide$,
  type PrepareVolumeServerSideInput,
} from "../signals/services/storage-volume-publication.service";

// No production endpoint exposes indexability or the prepare/commit boundary.
// These fixtures inspect only test-owned versions and model an interrupted
// publication; ordinary creation, sync, commits and work use their real routes.
export async function readPiResourceIndexStatusFixture(versionId: string) {
  const [row] = await db()
    .select({ status: piResourceVersionIndexes.status })
    .from(piResourceVersionIndexes)
    .where(
      and(
        eq(piResourceVersionIndexes.storageVersionId, versionId),
        eq(
          piResourceVersionIndexes.extractorVersion,
          PI_RESOURCE_EXTRACTOR_VERSION,
        ),
      ),
    );
  return row?.status;
}

export async function prepareUnpublishedPiVolumeFixture(
  input: PrepareVolumeServerSideInput,
  signal: AbortSignal,
): Promise<void> {
  const store = createStore();
  await store.set(prepareVolumeServerSide$, input, signal);
}
