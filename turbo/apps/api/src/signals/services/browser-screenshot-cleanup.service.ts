import { command } from "ccstate";
import { and, asc, eq, isNull, notExists } from "drizzle-orm";
import { uuid } from "zod";
import { browserSessionScreenshotDeletions } from "@okouai/db/schema/browser-screenshot-deletion";
import { files } from "@okouai/db/schema/file";
import { browserChatSessions } from "@okouai/db/schema/browser-chat-session";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { deleteS3Objects } from "../external/s3";
import { settleIncludingAbort } from "../utils";
import { fileStorageBucket } from "./private-artifact-storage.service";

const L = logger("BrowserScreenshotCleanup");

const retireBrowserScreenshot$ = command(
  async (
    { get, set },
    item: { readonly objectKey: string; readonly chatThreadId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const unreferenced = notExists(
      db
        .select({ id: browserChatSessions.chatThreadId })
        .from(browserChatSessions)
        .where(eq(browserChatSessions.screenshotObjectKey, item.objectKey)),
    );
    let bucket: string;
    if (item.objectKey.startsWith("private-artifacts/")) {
      const id = uuid().parse(item.objectKey.split("/")[1]);
      const [file] = await db
        .select()
        .from(files)
        .where(and(eq(files.id, id), eq(files.storageKey, item.objectKey)));
      signal.throwIfAborted();
      if (!file?.storageKey) {
        throw new Error("Browser screenshot has no private storage identity");
      }
      bucket = fileStorageBucket(file.storageKey);
      // Serialize retirement with pending-to-ready (`sizeBytes: null -> N`)
      // publication on the same `files` row. If publication wins, a stale
      // pending observation cannot delete its now-ready object. If retirement
      // wins, the publisher's `deletedAt IS NULL` predicate rejects it.
      const retired = await db
        .update(files)
        .set({ deletedAt: file.deletedAt ?? nowDate() })
        .where(
          and(
            eq(files.id, file.id),
            eq(files.storageKey, item.objectKey),
            eq(files.ownerUserId, file.ownerUserId),
            eq(files.orgId, file.orgId),
            file.sizeBytes === null
              ? isNull(files.sizeBytes)
              : eq(files.sizeBytes, file.sizeBytes),
            unreferenced,
          ),
        )
        .returning({ id: files.id });
      signal.throwIfAborted();
      if (retired.length === 0) {
        return false;
      }
    } else if (item.objectKey.startsWith("artifacts/")) {
      bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    } else {
      throw new Error("Unsupported Browser screenshot storage identity");
    }

    await get(deleteS3Objects(bucket, [item.objectKey], signal));
    signal.throwIfAborted();
    await db
      .delete(browserSessionScreenshotDeletions)
      .where(
        and(
          eq(browserSessionScreenshotDeletions.objectKey, item.objectKey),
          eq(browserSessionScreenshotDeletions.chatThreadId, item.chatThreadId),
          unreferenced,
        ),
      );
    signal.throwIfAborted();
    return true;
  },
);

/** A current immutable key is dormant work, not garbage. Its durable intent
 * survives replacement, deletion and interrupted storage retirement.
 */
export const cleanupBrowserScreenshots$ = command(
  async (
    { set },
    selection: { readonly limit: number; readonly chatThreadId: string | null },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const pending = await db
      .select()
      .from(browserSessionScreenshotDeletions)
      .where(
        and(
          selection.chatThreadId === null
            ? undefined
            : eq(
                browserSessionScreenshotDeletions.chatThreadId,
                selection.chatThreadId,
              ),
          notExists(
            db
              .select({ id: browserChatSessions.chatThreadId })
              .from(browserChatSessions)
              .where(
                eq(
                  browserChatSessions.screenshotObjectKey,
                  browserSessionScreenshotDeletions.objectKey,
                ),
              ),
          ),
        ),
      )
      .orderBy(
        asc(browserSessionScreenshotDeletions.createdAt),
        asc(browserSessionScreenshotDeletions.objectKey),
      )
      .limit(selection.limit);
    signal.throwIfAborted();

    let cleaned = 0;
    let errors = 0;
    for (const item of pending) {
      const result = await settleIncludingAbort(
        set(retireBrowserScreenshot$, item, signal),
      );
      signal.throwIfAborted();
      if (result.ok) {
        cleaned += result.value ? 1 : 0;
      } else {
        errors += 1;
        L.warn("Managed browser screenshot cleanup failed", {
          chatThreadId: item.chatThreadId,
          objectKey: item.objectKey,
          error: result.error,
        });
      }
    }
    return { checked: pending.length, cleaned, errors };
  },
);
