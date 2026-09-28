import { request$ } from "../context/hono";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { eq } from "drizzle-orm";
import { initContract } from "@okouai/api-contracts/contracts/base";
import { z } from "zod";
import { command } from "ccstate";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { processGetStartedClaims } from "../services/get-started-review.service";

// Imported only by tests, never registered in the deployed router. The global
// worker is restricted to claims created by this test through the real API.
const c = initContract();
export const scopedReviewContract = c.router({
  process: {
    method: "POST",
    path: "/test/get-started-review",
    body: z.union([
      z.object({ claimIds: z.array(z.string().uuid()).min(1) }),
      z.object({ orgId: z.string().min(1) }),
    ]),
    responses: {
      200: z.object({ processed: z.number() }),
      400: apiErrorSchema,
      404: z.string(),
    },
  },
});
const body$ = bodyResultOf(scopedReviewContract.process);
const process$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const body = await get(body$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const db = set(writeDb$);
  const claimIds =
    "claimIds" in body.data
      ? body.data.claimIds
      : (
          await db
            .select({ id: getStartedClaims.id })
            .from(getStartedClaims)
            .where(eq(getStartedClaims.orgId, body.data.orgId))
        ).map((row) => {
          return row.id;
        });
  signal.throwIfAborted();
  const processed = await processGetStartedClaims(db, { claimIds }, signal);
  signal.throwIfAborted();
  return { status: 200 as const, body: { processed } };
});
export const scopedReviewRoutes: readonly RouteEntry[] = [
  { route: scopedReviewContract.process, handler: process$ },
];
