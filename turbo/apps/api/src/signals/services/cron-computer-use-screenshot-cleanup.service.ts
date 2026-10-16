import { command } from "ccstate";
import { and, asc, inArray, lte } from "drizzle-orm";

import { isStoredScreenshotPointer } from "@okouai/api-contracts/contracts/computer-use";
import {
  computerUseCommandAuditEvents,
  computerUseCommands,
} from "@okouai/db/schema/computer-use-host";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { deleteS3Objects } from "../external/s3";

const COMMAND_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;
const COMMAND_CLEANUP_BATCH_SIZE = 500;
const MAX_CLEANUP_BATCHES = 10;

/**
 * Retire completed commands, their payloads/results, screenshots and audit
 * events together after 72 hours. Delete objects before their references so
 * a failed or interrupted batch remains discoverable by the next hourly sweep.
 */
export const cleanupComputerUseCommands$ = command(
  async ({ get, set }, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const cutoff = new Date(nowDate().getTime() - COMMAND_RETENTION_MS);
    const expired = and(
      // Retain the existing created_at index as the scan's lower-cost bound.
      lte(computerUseCommands.createdAt, cutoff),
      lte(computerUseCommands.completedAt, cutoff),
      inArray(computerUseCommands.status, ["succeeded", "failed"]),
    );

    let totalCleaned = 0;
    for (let batch = 0; batch < MAX_CLEANUP_BATCHES; batch++) {
      const rows = await db
        .select({
          id: computerUseCommands.id,
          result: computerUseCommands.result,
        })
        .from(computerUseCommands)
        .where(expired)
        .orderBy(
          asc(computerUseCommands.createdAt),
          asc(computerUseCommands.id),
        )
        .limit(COMMAND_CLEANUP_BATCH_SIZE);
      signal.throwIfAborted();

      if (rows.length === 0) {
        break;
      }

      const keysByBucket = new Map<string, string[]>();
      const ids: string[] = [];
      for (const row of rows) {
        ids.push(row.id);
        const screenshot = row.result?.screenshot;
        if (isStoredScreenshotPointer(screenshot)) {
          const keys = keysByBucket.get(screenshot.bucket) ?? [];
          keys.push(screenshot.key);
          keysByBucket.set(screenshot.bucket, keys);
        }
      }

      for (const [bucket, keys] of keysByBucket) {
        await get(deleteS3Objects(bucket, keys, signal));
      }

      // One statement removes both sides of the audit foreign key atomically.
      const deletedAuditEvents = db
        .$with("deleted_audit_events")
        .as(
          db
            .delete(computerUseCommandAuditEvents)
            .where(inArray(computerUseCommandAuditEvents.commandId, ids))
            .returning({ id: computerUseCommandAuditEvents.id }),
        );
      const deleted = await db
        .with(deletedAuditEvents)
        .delete(computerUseCommands)
        .where(and(inArray(computerUseCommands.id, ids), expired))
        .returning({ id: computerUseCommands.id });
      signal.throwIfAborted();

      totalCleaned += deleted.length;
      if (rows.length < COMMAND_CLEANUP_BATCH_SIZE) {
        break;
      }
    }

    return totalCleaned;
  },
);
