import { xResourceReads } from "@okouai/db/schema/x-resource-usage";
import { command } from "ccstate";
import { and, asc, inArray, lt, sql } from "drizzle-orm";

import { type Db, writeDb$ } from "../external/db";
import { readXResourceClock } from "./x-resource-usage-lifecycle";

const DELETE_BATCH_SIZE = 1000;

async function cleanupXResourceReads(
  db: Db,
  resourceIds: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  // Admission is limited to today and yesterday. Sample the database clock
  // before selecting keys; delayed cleanup never extends that admission window.
  const now = await readXResourceClock(db);
  signal.throwIfAborted();
  const yesterday = new Date(now);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  const cutoff = yesterday.toISOString().slice(0, 10);
  const keys = await db
    .select({
      utcDay: xResourceReads.utcDay,
      resourceType: xResourceReads.resourceType,
      resourceId: xResourceReads.resourceId,
    })
    .from(xResourceReads)
    .where(
      and(
        lt(xResourceReads.utcDay, cutoff),
        resourceIds === undefined
          ? undefined
          : inArray(xResourceReads.resourceId, resourceIds),
      ),
    )
    .orderBy(
      asc(xResourceReads.utcDay),
      asc(xResourceReads.resourceType),
      asc(xResourceReads.resourceId),
    )
    .limit(DELETE_BATCH_SIZE);
  signal.throwIfAborted();
  if (keys.length === 0) {
    return 0;
  }

  // One bounded statement: never hold locks across reads and writes. Repeat
  // the day predicate so a changed row cannot be deleted on stale eligibility;
  // the full primary key keeps the delete confined to the selected rows.
  const deleted = await db
    .delete(xResourceReads)
    .where(
      and(
        lt(xResourceReads.utcDay, cutoff),
        inArray(
          sql`(${xResourceReads.utcDay}, ${xResourceReads.resourceType}, ${xResourceReads.resourceId})`,
          keys.map((key) => {
            return sql`(${key.utcDay}, ${key.resourceType}, ${key.resourceId})`;
          }),
        ),
      ),
    )
    .returning({ resourceId: xResourceReads.resourceId });
  // A cancellation after this single statement has committed can still be
  // reported to the caller; a retry is idempotent and drains the next batch.
  signal.throwIfAborted();
  return deleted.length;
}

export const cleanupXResourceReads$ = command(
  async ({ set }, signal: AbortSignal): Promise<number> => {
    return await cleanupXResourceReads(set(writeDb$), undefined, signal);
  },
);

export const cleanupXResourceReadsForTest$ = command(
  async (
    { set },
    resourceIds: readonly string[],
    signal: AbortSignal,
  ): Promise<number> => {
    return await cleanupXResourceReads(set(writeDb$), resourceIds, signal);
  },
);
