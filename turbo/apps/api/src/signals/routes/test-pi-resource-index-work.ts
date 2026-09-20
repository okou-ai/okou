import { testPiResourceIndexWorkContract } from "@okouai/api-contracts/contracts/test-pi-resource-index-work";
import {
  piStableContextArtifactResources,
  piStableContextHeads,
} from "@okouai/db/schema/pi-stable-context";
import { piResourceVersionIndexes } from "@okouai/db/schema/pi-resource-version-index";
import { storages, storageVersions } from "@okouai/db/schema/storage";
import { command } from "ccstate";
import { and, eq, inArray } from "drizzle-orm";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { executePiResourceIndexWork$ } from "../services/pi-resource-version-index.service";
import { executePiStableContextWork } from "../services/pi-stable-context.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const body$ = bodyResultOf(testPiResourceIndexWorkContract.run);
const run$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    executePiResourceIndexWork$,
    body.data.versionIds,
    signal,
  );
  signal.throwIfAborted();
  const db = set(writeDb$);
  const owner = body.data.stableContextOwner;
  const heads = owner
    ? await db
        .select({ id: piStableContextHeads.id })
        .from(piStableContextHeads)
        .where(
          and(
            eq(piStableContextHeads.orgId, owner.orgId),
            eq(piStableContextHeads.userId, owner.userId),
            eq(piStableContextHeads.agentId, owner.agentId),
          ),
        )
        .limit(16)
    : [];
  signal.throwIfAborted();
  const headIds = heads.map((head) => {
    return head.id;
  });
  const stableContext =
    headIds.length > 0
      ? await executePiStableContextWork(db, signal, {
          scope: { headIds },
        })
      : {
          claimed: 0,
          ready: 0,
          pending: 0,
          unindexable: 0,
          failed: 0,
          stale: 0,
        };
  signal.throwIfAborted();
  if (
    body.data.removeStableContextResourceIndexes &&
    owner &&
    headIds.length > 0
  ) {
    const resources = await db
      .select({ versionId: piStableContextArtifactResources.storageVersionId })
      .from(piStableContextArtifactResources)
      .innerJoin(
        piStableContextHeads,
        eq(
          piStableContextHeads.artifactDigest,
          piStableContextArtifactResources.artifactDigest,
        ),
      )
      .innerJoin(
        storageVersions,
        eq(
          storageVersions.id,
          piStableContextArtifactResources.storageVersionId,
        ),
      )
      .innerJoin(storages, eq(storages.id, storageVersions.storageId))
      .where(
        and(
          inArray(piStableContextHeads.id, headIds),
          eq(storages.orgId, owner.orgId),
          inArray(
            storages.name,
            body.data.removeStableContextResourceIndexes.ownedStorageNames,
          ),
        ),
      );
    signal.throwIfAborted();
    const versionIds = resources.map((resource) => {
      return resource.versionId;
    });
    if (versionIds.length === 0) {
      throw new Error(
        "Expected a fixture-owned stable-context resource index to remove",
      );
    }
    await db
      .delete(piResourceVersionIndexes)
      .where(inArray(piResourceVersionIndexes.storageVersionId, versionIds));
    signal.throwIfAborted();
  }
  return {
    status: 200 as const,
    body: { success: true as const, ...result, stableContext },
  };
});

// Mounted only by the test route slice; production uses the authenticated cron.
export const testPiResourceIndexWorkRoutes: readonly RouteEntry[] = [
  { route: testPiResourceIndexWorkContract.run, handler: run$ },
];
