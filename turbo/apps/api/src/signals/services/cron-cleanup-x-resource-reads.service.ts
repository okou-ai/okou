import { xResourceReads } from "@okouai/db/schema/x-resource-usage";
import { command } from "ccstate";
import { and, asc, eq, exists, inArray, lt } from "drizzle-orm";

import { type Db, writeDb$ } from "../external/db";
import {
  lockXResourceAdmission,
  readXResourceClock,
  setXResourceTransactionTimeouts,
} from "./x-resource-usage-lifecycle";

const DELETE_BATCH_SIZE = 1000;

async function cleanupXResourceReads(
  db: Db,
  resourceIds: readonly string[] | undefined,
  signal: AbortSignal,
): Promise<number> {
  signal.throwIfAborted();
  return await db.transaction(
    async (tx) => {
      await setXResourceTransactionTimeouts(tx);
      signal.throwIfAborted();
      await lockXResourceAdmission(tx, "exclusive");
      signal.throwIfAborted();

      // Read the database clock after waiting for in-flight admissions. An
      // older transaction timestamp would retain an extra day across midnight.
      const now = await readXResourceClock(tx);
      signal.throwIfAborted();
      const yesterday = new Date(now);
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const cutoff = yesterday.toISOString().slice(0, 10);
      const expired = tx.$with("expired_x_resource_reads").as(
        tx
          .select()
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
          .limit(DELETE_BATCH_SIZE),
      );
      const deleted = await tx
        .with(expired)
        .delete(xResourceReads)
        .where(
          exists(
            tx
              .select({ resourceId: expired.resourceId })
              .from(expired)
              .where(
                and(
                  eq(xResourceReads.utcDay, expired.utcDay),
                  eq(xResourceReads.resourceType, expired.resourceType),
                  eq(xResourceReads.resourceId, expired.resourceId),
                ),
              ),
          ),
        )
        .returning({ resourceId: xResourceReads.resourceId });
      // Cancellation must roll back the deletion, rather than report an error
      // after committing a request whose owner has gone away.
      signal.throwIfAborted();
      return deleted.length;
    },
    { isolationLevel: "read committed" },
  );
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
