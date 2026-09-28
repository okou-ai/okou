import { request$ } from "../context/hono";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";
import { apiErrorSchema } from "@okouai/api-contracts/contracts/errors";
import { getStartedClaims } from "@okouai/db/schema/get-started-claim";
import { and, eq } from "drizzle-orm";
import { initContract } from "@okouai/api-contracts/contracts/base";
import { z } from "zod";
import { command } from "ccstate";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { processGetStartedClaims } from "../services/get-started-review.service";
import { CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY } from "../services/get-started-rewards.service";

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

// Custom connector claims used to be keyed per connector (`custom:<id>`). The
// production API no longer writes that shape, so this rewrites a user's shared
// custom connector claim into the historical form a deployed database still
// contains.
export const legacyCustomConnectorClaimContract = c.router({
  relabel: {
    method: "POST",
    path: "/test/get-started-legacy-custom-connector-claim",
    body: z.object({
      userId: z.string().min(1),
      connectorId: z.string().uuid(),
    }),
    responses: {
      200: z.object({ updated: z.number() }),
      400: apiErrorSchema,
      404: z.string(),
    },
  },
});
const legacyBody$ = bodyResultOf(legacyCustomConnectorClaimContract.relabel);
const relabel$ = command(async ({ get, set }, signal: AbortSignal) => {
  if (!isTestEndpointAllowed(get(request$))) {
    return testEndpointNotFoundResponse();
  }
  const body = await get(legacyBody$);
  signal.throwIfAborted();
  if (!body.ok) {
    return body.response;
  }
  const sourceKey = `${CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY}:${body.data.connectorId}`;
  const updated = await set(writeDb$)
    .update(getStartedClaims)
    .set({
      sourceKey,
      rewardKey: `connector:${body.data.userId}:${sourceKey}`,
    })
    .where(
      and(
        eq(getStartedClaims.beneficiaryUserId, body.data.userId),
        eq(getStartedClaims.questKey, "connector"),
        eq(getStartedClaims.sourceKey, CUSTOM_CONNECTOR_GET_STARTED_SOURCE_KEY),
        eq(getStartedClaims.status, "granted"),
      ),
    )
    .returning({ id: getStartedClaims.id });
  signal.throwIfAborted();
  return { status: 200 as const, body: { updated: updated.length } };
});
export const legacyCustomConnectorClaimRoutes: readonly RouteEntry[] = [
  { route: legacyCustomConnectorClaimContract.relabel, handler: relabel$ },
];
