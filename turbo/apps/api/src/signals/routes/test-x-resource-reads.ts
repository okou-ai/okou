import { initContract } from "@okouai/api-contracts/contracts/trpc-contract";
import { xResourceReads } from "@okouai/db/schema/x-resource-usage";
import { command } from "ccstate";
import { asc, inArray } from "drizzle-orm";
import { z } from "zod";

import { request$ } from "../context/hono";
import { bodyResultOf } from "../context/request";
import { writeDb$ } from "../external/db";
import type { RouteEntry } from "../route-entry";
import { cleanupXResourceReadsForTest$ } from "../services/cron-cleanup-x-resource-reads.service";
import {
  isTestEndpointAllowed,
  testEndpointNotFoundResponse,
} from "./test-endpoint-helpers";

const resourceIdSchema = z.string().regex(/^[0-9]{1,32}(?![\s\S])/);
const resourceIdsSchema = z.array(resourceIdSchema).min(1).max(1000);
const resourceReadSchema = z.object({
  utcDay: z.iso.date(),
  resourceType: z.enum(["post", "user"]),
  resourceId: resourceIdSchema,
});
// Infrastructure exception: production ingestion rejects expired observations,
// so it cannot construct historical rows for retention tests. These fixtures
// are scoped to explicitly owned IDs and are not ordinary ingestion setup.
const actionBodySchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("seed"),
    rows: z.array(resourceReadSchema).min(1).max(1000),
  }),
  z.object({
    action: z.enum(["read", "delete"]),
    resourceIds: resourceIdsSchema,
  }),
  z.object({
    action: z.literal("cleanup"),
    resourceIds: resourceIdsSchema,
  }),
]);

const c = initContract();
export const testXResourceReadsContract = c.router({
  action: {
    method: "POST",
    path: "/api/test/x-resource-reads/action",
    body: actionBodySchema,
    responses: {
      200: z.object({
        rows: z.array(resourceReadSchema),
        deleted: z.number().int().nonnegative(),
      }),
      400: z.object({
        error: z.object({ code: z.string(), message: z.string() }),
      }),
      404: z.string(),
    },
  },
});
export type TestXResourceReadsAction = z.infer<typeof actionBodySchema>;
const actionBody$ = bodyResultOf(testXResourceReadsContract.action);

const mutateTestXResourceReads$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    if (!isTestEndpointAllowed(get(request$))) {
      return testEndpointNotFoundResponse();
    }
    const bodyResult = await get(actionBody$);
    signal.throwIfAborted();
    if (!bodyResult.ok) {
      return bodyResult.response;
    }

    const body = bodyResult.data;
    const db = set(writeDb$);
    if (body.action === "seed") {
      await db.insert(xResourceReads).values(body.rows);
      signal.throwIfAborted();
    } else if (body.action === "read") {
      const rows = await db
        .select()
        .from(xResourceReads)
        .where(inArray(xResourceReads.resourceId, body.resourceIds))
        .orderBy(
          asc(xResourceReads.utcDay),
          asc(xResourceReads.resourceType),
          asc(xResourceReads.resourceId),
        );
      signal.throwIfAborted();
      return { status: 200 as const, body: { rows, deleted: 0 } };
    } else if (body.action === "delete") {
      await db
        .delete(xResourceReads)
        .where(inArray(xResourceReads.resourceId, body.resourceIds));
      signal.throwIfAborted();
    } else {
      const deleted = await set(
        cleanupXResourceReadsForTest$,
        body.resourceIds,
        signal,
      );
      return { status: 200 as const, body: { rows: [], deleted } };
    }
    return { status: 200 as const, body: { rows: [], deleted: 0 } };
  },
);

export const testXResourceReadsRoutes: readonly RouteEntry[] = [
  {
    route: testXResourceReadsContract.action,
    handler: mutateTestXResourceReads$,
  },
];
