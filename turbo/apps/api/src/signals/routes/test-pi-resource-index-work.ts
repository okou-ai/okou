import { testPiResourceIndexWorkContract } from "@okouai/api-contracts/contracts/test-pi-resource-index-work";
import { piStableContextHeads } from "@okouai/db/schema/pi-stable-context";
import { command } from "ccstate";
import { and, eq } from "drizzle-orm";

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
  return {
    status: 200 as const,
    body: { success: true as const, ...result, stableContext },
  };
});

// Mounted only by the test route slice; production uses the authenticated cron.
export const testPiResourceIndexWorkRoutes: readonly RouteEntry[] = [
  { route: testPiResourceIndexWorkContract.run, handler: run$ },
];
