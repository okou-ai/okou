import { command } from "ccstate";
import { and, asc, eq, notExists } from "drizzle-orm";
import { uuid } from "zod";
import {
  browserSessionScreenshotDeletions,
  browserSessionScreenshots,
} from "@okouai/db/schema/browser-session";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { browserChatSessions } from "@okouai/db/schema/browser-chat-session";

import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { deleteS3Objects } from "../external/s3";
import { settleIncludingAbort } from "../utils";
import { artifactStorageBucket } from "./private-artifact-storage.service";
import { revokeDeletedFileArtifactShare$ } from "./artifact-shares.service";

const L = logger("BrowserScreenshotCleanup");

const retireBrowserScreenshot$ = command(
  async (
    { get, set },
    item: { readonly objectKey: string; readonly chatThreadId: string },
    signal: AbortSignal,
  ): Promise<boolean> => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const unreferenced = and(
      notExists(
        db
          .select({ id: browserSessionScreenshots.chatThreadId })
          .from(browserSessionScreenshots)
          .where(eq(browserSessionScreenshots.objectKey, item.objectKey)),
      ),
      notExists(
        db
          .select({ id: browserChatSessions.chatThreadId })
          .from(browserChatSessions)
          .where(eq(browserChatSessions.screenshotObjectKey, item.objectKey)),
      ),
    );
    let bucket: string;
    let file: typeof runUploadedFiles.$inferSelect | undefined;
    if (item.objectKey.startsWith("private-artifacts/")) {
      const id = uuid().parse(item.objectKey.split("/")[1]);
      [file] = await db
        .select()
        .from(runUploadedFiles)
        .where(
          and(
            eq(runUploadedFiles.id, id),
            eq(runUploadedFiles.storageKey, item.objectKey),
          ),
        );
      signal.throwIfAborted();
      if (
        !file?.orgId ||
        file.metadata.storage === undefined ||
        file.materializationStatus === null
      ) {
        throw new Error("Browser screenshot has no private storage identity");
      }
      bucket = artifactStorageBucket(file.metadata);
      // Serialize retirement with pending-to-ready preview publication using
      // the existing file business state. If publication wins, a stale pending
      // observation cannot delete its now-ready object. If retirement wins,
      // the publisher's deleted-at predicate rejects the candidate. Keep the
      // intent and storage metadata through all external effects below.
      const retired = await db
        .update(runUploadedFiles)
        .set({ deletedAt: file.deletedAt ?? nowDate() })
        .where(
          and(
            eq(runUploadedFiles.id, file.id),
            eq(runUploadedFiles.storageKey, item.objectKey),
            eq(runUploadedFiles.userId, file.userId),
            eq(runUploadedFiles.orgId, file.orgId),
            eq(
              runUploadedFiles.materializationStatus,
              file.materializationStatus,
            ),
            unreferenced,
          ),
        )
        .returning({ id: runUploadedFiles.id });
      signal.throwIfAborted();
      if (retired.length === 0) {
        return false;
      }
    } else if (item.objectKey.startsWith("artifacts/")) {
      // Historical captures predate independent private file ownership and
      // current private-only publishers. Retain their exact public key.
      bucket = env("R2_USER_ARTIFACTS_BUCKET_NAME");
    } else {
      throw new Error("Unsupported Browser screenshot storage identity");
    }

    await get(deleteS3Objects(bucket, [item.objectKey], signal));
    signal.throwIfAborted();
    if (file?.orgId) {
      await set(
        revokeDeletedFileArtifactShare$,
        { fileId: file.id, userId: file.userId, orgId: file.orgId },
        signal,
      );
      signal.throwIfAborted();
    }
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
 * survives replacement, deletion and interrupted storage/share retirement.
 */
export const cleanupBrowserScreenshots$ = command(
  async ({ set }, limit: number, signal: AbortSignal) => {
    signal.throwIfAborted();
    const db = set(writeDb$);
    const pending = await db
      .select()
      .from(browserSessionScreenshotDeletions)
      .where(
        and(
          notExists(
            db
              .select({ id: browserSessionScreenshots.chatThreadId })
              .from(browserSessionScreenshots)
              .where(
                eq(
                  browserSessionScreenshots.objectKey,
                  browserSessionScreenshotDeletions.objectKey,
                ),
              ),
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
      .limit(limit);
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
