import { rootSignal$ } from "../context/root";
import type { BrowserWindowContext } from "@okouai/api-contracts/contracts/browser";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import { browserSessionScreenshotDeletions } from "@okouai/db/schema/browser-screenshot-deletion";
import { browserOwnerProfiles } from "@okouai/db/schema/browser-owner";
import { browserChatSessions } from "@okouai/db/schema/browser-chat-session";
import { command } from "ccstate";
import { and, eq, exists, isNotNull, isNull, sql, type SQL } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { boolean, object } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { logger } from "../../lib/log";
import { db$, writeDb$ } from "../external/db";
import { publishBrowserSessionChangedSafely } from "../external/realtime";
import { now, nowDate } from "../../lib/time";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import { putImmutableS3Object } from "../external/s3";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import { settleIncludingAbort } from "../utils";
import {
  captureBrowserUseScreenshot,
  getBrowserUseSession,
} from "./browser-use.service";
import {
  resolveArtifactFileReference$,
  allocatePrivateArtifact$,
  privateArtifactRecord$,
} from "./private-artifact-storage.service";
import { browserCapturePublication } from "./browser-capture-publication";

const BROWSER_SCREENSHOT_CAPTURE_TIMEOUT_MS = 30_000;
const BROWSER_SCREENSHOT_CONTENT_TYPE = "image/webp";
const BROWSER_SCREENSHOT_FILENAME = "browser-screenshot.webp";
const L = logger("Browser");

type BrowserScreenshotOwner = Pick<
  typeof browserChatSessions.$inferSelect,
  "orgId" | "userId" | "chatThreadId"
>;

/** Resolve preview storage using the logical owner's independent file record. */
export const resolveBrowserScreenshotUrl$ = command(
  async (
    { set },
    screenshot: {
      readonly orgId: string;
      readonly userId: string;
      readonly objectKey: string;
      readonly url: string;
    },
    signal: AbortSignal,
  ): Promise<string | null> => {
    const reference = await set(
      resolveArtifactFileReference$,
      screenshot.url,
      signal,
    );
    signal.throwIfAborted();
    if (!reference) {
      return screenshot.url;
    }
    const file = await set(privateArtifactRecord$, reference.id, signal);
    signal.throwIfAborted();
    if (
      !file ||
      file.userId !== screenshot.userId ||
      file.orgId !== screenshot.orgId ||
      file.key !== screenshot.objectKey ||
      file.materializationStatus !== "ready"
    ) {
      return null;
    }
    const preview = await set(
      resolveArtifactPreviewUrl$,
      { bucket: file.bucket, key: file.key, signingDate: nowDate() },
      signal,
    );
    signal.throwIfAborted();
    return preview.url;
  },
);

type BrowserScreenshotStage = "prepare" | "capture" | "upload" | "save";

interface BrowserScreenshotPublication {
  readonly browser: BrowserScreenshotOwner;
  readonly fileId: string;
  readonly providerSessionId: string;
  readonly window: BrowserWindowContext;
  readonly previousValue: string | null;
  readonly capturedAt: Date;
  readonly objectKey: string;
  readonly url: string;
}

function browserScreenshotFailureKind(error: unknown): string {
  if (!(error instanceof Error)) {
    return "other";
  }
  if (
    error.name === "TimeoutError" ||
    (error.name === "AbortError" &&
      error.cause instanceof Error &&
      error.cause.name === "TimeoutError")
  ) {
    return "timeout";
  }
  switch (error.message) {
    case "Browser Use CDP returned no page target": {
      return "no_page_target";
    }
    case "No target with given id found": {
      return "target_disappeared";
    }
    case "Browser Use CDP connection failed": {
      return "connection_failed";
    }
    case "Browser Use CDP connection closed": {
      return "connection_closed";
    }
    default: {
      return error.name === "AbortError" ? "aborted" : "other";
    }
  }
}

async function recordBrowserScreenshotResult(result: {
  readonly startedAt: number;
  readonly outcome: "success" | "failure";
  readonly failureStage?: BrowserScreenshotStage;
  readonly failureKind?: string;
}): Promise<void> {
  const ingested = ingestToAxiom(getDatasetName("web-logs"), [
    {
      _time: nowDate().toISOString(),
      type: "managed_browser_screenshot",
      source: "api",
      outcome: result.outcome,
      duration_ms: Math.max(0, now() - result.startedAt),
      ...(result.failureStage === undefined
        ? {}
        : { failure_stage: result.failureStage }),
      ...(result.failureKind === undefined
        ? {}
        : { failure_kind: result.failureKind }),
    },
  ]);
  if (ingested) {
    await flushAxiom({ client: "telemetry" });
  }
}

function browserScreenshotPublication(
  args: BrowserScreenshotPublication,
  fileReady: SQL,
) {
  const { browser } = args;
  const t = browserChatSessions;
  const publication = browserCapturePublication({
    value: t.screenshotObjectKey,
    updatedAt: t.screenshotCapturedAt,
    previousValue: args.previousValue,
    capturedAt: args.capturedAt,
  });
  const guard = and(
    eq(t.chatThreadId, browser.chatThreadId),
    eq(t.instanceId, args.window.instanceId),
    eq(t.primaryWindowId, args.window.primaryWindowId),
    exists(
      new QueryBuilder()
        .select({ id: browserOwnerProfiles.id })
        .from(browserOwnerProfiles)
        .where(
          and(
            eq(browserOwnerProfiles.instanceId, args.window.instanceId),
            eq(browserOwnerProfiles.providerSessionId, args.providerSessionId),
            eq(browserOwnerProfiles.orgId, browser.orgId),
            eq(browserOwnerProfiles.userId, browser.userId),
          ),
        ),
    ),
  );
  return {
    updatedAt: publication.updatedAt,
    canReplace: and(guard, fileReady, publication.canReplace),
  };
}

const publishBrowserScreenshot$ = command(
  async ({ set }, args: BrowserScreenshotPublication): Promise<boolean> => {
    const { browser } = args;
    const artifact = { key: args.objectKey, url: args.url };
    const db = set(writeDb$);
    // File completion and preview publication are one operation. Cleanup can
    // retire pending bytes after a lost DB reply, so publication must compete
    // with that tombstone on the same existing business file row.
    const completion = db
      .update(runUploadedFiles)
      .set({
        materializationStatus: "ready",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(runUploadedFiles.id, args.fileId),
          eq(runUploadedFiles.storageKey, artifact.key),
          eq(runUploadedFiles.userId, browser.userId),
          eq(runUploadedFiles.orgId, browser.orgId),
          eq(runUploadedFiles.materializationStatus, "pending"),
          isNull(runUploadedFiles.deletedAt),
        ),
      )
      .returning({ id: runUploadedFiles.id });
    const completed = db.$with("completed_browser_screenshot").as(completion);
    const publication = browserScreenshotPublication(
      args,
      exists(new QueryBuilder().select({ id: completed.id }).from(completed)),
    );
    const publicationSql = db
      .update(browserChatSessions)
      .set({
        screenshotObjectKey: artifact.key,
        screenshotUrl: artifact.url,
        screenshotCapturedAt: publication.updatedAt,
      })
      .where(publication.canReplace)
      .returning({ id: browserChatSessions.chatThreadId })
      .getSQL();
    // Every candidate retains its own cleanup identity, including the accepted
    // preview. The sweeper excludes referenced keys. This also covers a value
    // displaced by a concurrent publication that this snapshot cannot see.
    const previous = db
      .select({
        objectKey: browserChatSessions.screenshotObjectKey,
        chatThreadId: browserChatSessions.chatThreadId,
        createdAt: browserChatSessions.createdAt,
      })
      .from(browserChatSessions)
      .where(
        and(
          eq(browserChatSessions.chatThreadId, browser.chatThreadId),
          isNotNull(browserChatSessions.screenshotObjectKey),
        ),
      );
    const queued = db
      .insert(browserSessionScreenshotDeletions)
      .select(
        sql`${previous}
          UNION SELECT ${artifact.key}, ${browser.chatThreadId}::uuid, now()`,
      )
      .onConflictDoNothing()
      .getSQL();
    const [outcome] = parseRawRows(
      object({ saved: boolean() }),
      await db.execute(sql`WITH completed_browser_screenshot AS (${completion.getSQL()}),
        published AS (${publicationSql}),
        queued AS (${queued})
        SELECT EXISTS(SELECT 1 FROM published) AS saved`),
    );
    if (!outcome) {
      throw new Error("Browser screenshot publication returned no outcome");
    }
    return outcome.saved;
  },
);

const retainAbandonedBrowserScreenshot$ = command(
  async ({ set }, chatThreadId: string, objectKey: string): Promise<void> => {
    const db = set(writeDb$);
    const queued = await settleIncludingAbort(
      db
        .insert(browserSessionScreenshotDeletions)
        .values({ objectKey, chatThreadId })
        .onConflictDoNothing(),
    );
    if (!queued.ok) {
      L.warn("Managed browser screenshot cleanup handoff failed", {
        chatThreadId,
        objectKey,
        error: queued.error,
      });
    }
  },
);

export const captureAndStoreBrowserScreenshot$ = command(
  async (
    { get, set },
    browser: BrowserScreenshotOwner,
    connection: {
      readonly providerSessionId: string;
      readonly window: BrowserWindowContext;
    },
  ): Promise<void> => {
    const startedAt = now();
    const signal = get(rootSignal$);
    let stage: BrowserScreenshotStage = "prepare";
    let allocatedKey: string | undefined;
    // Include capture cancellation in the final outcome so every started
    // screenshot operation has a recorded result.
    const [result] = await Promise.allSettled([
      (async () => {
        const [previous] = await get(db$)
          .select({ objectKey: browserChatSessions.screenshotObjectKey })
          .from(browserChatSessions)
          .where(eq(browserChatSessions.chatThreadId, browser.chatThreadId));
        signal.throwIfAborted();
        const previousValue = previous?.objectKey ?? null;
        const provider = await getBrowserUseSession(
          connection.providerSessionId,
          signal,
        );
        signal.throwIfAborted();
        if (provider.status !== "active" || !provider.cdpUrl) {
          return;
        }
        stage = "capture";
        // A delayed native reply must retain its capture-start ordering.
        const capturedAt = nowDate();
        const image = await captureBrowserUseScreenshot(
          provider.cdpUrl,
          connection.window.primaryWindowId,
          AbortSignal.any([
            signal,
            AbortSignal.timeout(BROWSER_SCREENSHOT_CAPTURE_TIMEOUT_MS),
          ]),
        );
        signal.throwIfAborted();
        stage = "upload";
        const artifact = await set(
          allocatePrivateArtifact$,
          {
            userId: browser.userId,
            orgId: browser.orgId,
            filename: BROWSER_SCREENSHOT_FILENAME,
            contentType: BROWSER_SCREENSHOT_CONTENT_TYPE,
            size: image.byteLength,
          },
          signal,
        );
        const bucket = artifact.bucket;
        allocatedKey = artifact.key;
        await get(
          putImmutableS3Object(
            bucket,
            artifact.key,
            image,
            BROWSER_SCREENSHOT_CONTENT_TYPE,
            { signal, metadata: artifact.metadata },
          ),
        );
        signal.throwIfAborted();

        stage = "save";
        const saved = await set(publishBrowserScreenshot$, {
          browser,
          fileId: artifact.id,
          ...connection,
          previousValue,
          capturedAt,
          objectKey: artifact.key,
          url: artifact.url,
        });
        if (!saved) {
          return;
        }

        // Persistence is the success boundary; a deadline after commit must
        // not turn an available preview into a failed capture metric.
        await publishBrowserSessionChangedSafely(browser.userId, {
          threadId: browser.chatThreadId,
        });
        return true;
      })(),
    ]);
    if (result.status === "rejected" && allocatedKey) {
      // The upload/publication promise has settled, but its commit may be
      // uncertain. Retain only this attempt's immutable identity; the accepted
      // pointer protects a publication that actually succeeded. Do not inherit
      // capture cancellation for this durable recovery handoff.
      await set(
        retainAbandonedBrowserScreenshot$,
        browser.chatThreadId,
        allocatedKey,
      );
    }
    if (result.status === "fulfilled" && !result.value) {
      return;
    }
    // Flush after the background result exists, within the same waitUntil.
    // Telemetry delivery must not reject the screenshot task.
    await Promise.allSettled([
      recordBrowserScreenshotResult({
        startedAt,
        ...(result.status === "fulfilled"
          ? { outcome: "success" }
          : {
              outcome: "failure",
              failureStage: stage,
              failureKind: browserScreenshotFailureKind(result.reason),
            }),
      }),
    ]);
  },
);
