import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import { command } from "ccstate";
import { z } from "zod";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import type { RouteEntry } from "../route-entry";
import { reconcileArtifactCatalogFilesForIds$ } from "../services/artifact-catalog.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const c = initContract();
export const testArtifactCatalogReconcileContract = c.router({
  reconcile: {
    method: "POST",
    path: "/api/test/artifact-catalog/reconcile",
    body: z.object({ fileIds: z.array(z.uuid()).min(1).max(100) }),
    responses: {
      200: z.object({
        processed: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
      }),
      400: apiErrorSchema,
      404: z.string(),
    },
  },
});

const body$ = bodyResultOf(testArtifactCatalogReconcileContract.reconcile);
const reconcile$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const result = await set(
    reconcileArtifactCatalogFilesForIds$,
    body.data.fileIds,
    signal,
  );
  signal.throwIfAborted();
  return { status: 200 as const, body: result };
});

// Mounted only by the test route slice; production uses the authenticated cron.
export const testArtifactCatalogReconcileRoutes: readonly RouteEntry[] = [
  {
    route: testArtifactCatalogReconcileContract.reconcile,
    handler: reconcile$,
  },
];
