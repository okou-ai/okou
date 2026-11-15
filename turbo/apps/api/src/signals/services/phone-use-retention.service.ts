import { command } from "ccstate";
import { and, asc, inArray, lte } from "drizzle-orm";
import { phoneUseOperations } from "@okouai/db/schema/phone-use";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { deleteS3Objects } from "../external/s3";

/** Retire private command bodies, observations and images after 72 hours. */
export const cleanupPhoneUseOperations$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const cutoff = new Date(nowDate().getTime() - 72 * 60 * 60 * 1000);
    const expired = and(
      lte(phoneUseOperations.createdAt, cutoff),
      lte(phoneUseOperations.expiresAt, cutoff),
    );
    const rows = await get(db$)
      .select({
        id: phoneUseOperations.id,
        key: phoneUseOperations.screenshotKey,
      })
      .from(phoneUseOperations)
      .where(expired)
      .orderBy(asc(phoneUseOperations.createdAt))
      .limit(500);
    signal.throwIfAborted();
    const keys = rows.flatMap((row) => {
      return row.key ? [row.key] : [];
    });
    if (keys.length) {
      await get(
        deleteS3Objects(env("R2_USER_STORAGES_BUCKET_NAME"), keys, signal),
      );
      signal.throwIfAborted();
    }
    if (!rows.length) {
      return 0;
    }
    const deleted = await set(writeDb$)
      .delete(phoneUseOperations)
      .where(
        and(
          expired,
          inArray(
            phoneUseOperations.id,
            rows.map((row) => {
              return row.id;
            }),
          ),
        ),
      )
      .returning({ id: phoneUseOperations.id });
    signal.throwIfAborted();
    return deleted.length;
  },
);
