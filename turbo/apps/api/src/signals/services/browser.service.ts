import { rootSignal$ } from "../context/root";
import {
  BROWSER_IDLE_LEASE_MINUTES,
  type BrowserSuspensionReason,
  type BrowserWindowContext,
} from "@okouai/api-contracts/contracts/browser";

import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import {
  browserSessionInstances,
  browserSessionScreenshots,
  browserSessionScreenshotDeletions,
  browserSessionTabSnapshots,
  browserSessions,
  browserThreadProfiles,
  browserUserActionRequests,
} from "@okouai/db/schema/browser-session";
import { browserOwnerProfiles } from "@okouai/db/schema/browser-owner";
import { browserChatSessions } from "@okouai/db/schema/browser-chat-session";

import { chatThreads } from "@okouai/db/runtime/chat-thread";

import { command } from "ccstate";
import {
  and,
  count,
  desc,
  eq,
  exists,
  gt,
  gte,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  notExists,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { boolean, object, ZodError } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import { pgBooleanDecoder } from "../../lib/db-structured-result";

import { logger } from "../../lib/log";

import { waitUntil } from "../context/wait-until";
import { db$, writeDb$ } from "../external/db";
import { publishBrowserSessionChangedSafely } from "../external/realtime";
import { now, nowDate } from "../../lib/time";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import { putImmutableS3Object } from "../external/s3";
import { resolveArtifactPreviewUrl$ } from "./artifact-preview-url.service";
import { settle, settleIncludingAbort } from "../utils";
import {
  BrowserUseProviderError,
  browserUseNativeConnection,
  captureBrowserUseScreenshot,
  deleteBrowserUseProfile,
  getBrowserUseSession,
  listBrowserUseTabUrls,
  stopBrowserUseSession,
  stopBrowserUseSessionForCleanup,
} from "./browser-use.service";
import {
  resolveArtifactFileReference$,
  allocatePrivateArtifact$,
  privateArtifactRecord$,
} from "./private-artifact-storage.service";
import { encryptPersistentSecretValue } from "./crypto.utils";
import {
  loadActivePaidConcurrencySlots$,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";
import { reconcileBrowserUserActions$ } from "./browser-user-actions.service";
import { browserCapturePublication } from "./browser-capture-publication";

const RECONCILE_BATCH_SIZE = 20;
const PROVIDER_START_LIFECYCLE_TIMEOUT_MS = 90_000;
const BROWSER_TAB_SNAPSHOT_TIMEOUT_MS = 10_000;
const BROWSER_SCREENSHOT_CAPTURE_TIMEOUT_MS = 30_000;
const BROWSER_SCREENSHOT_CONTENT_TYPE = "image/webp";
const BROWSER_SCREENSHOT_FILENAME = "browser-screenshot.webp";
const STRANDED_START_GRACE_MS = 60_000;
const INACTIVE_BROWSER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PROVIDER_VALIDATION_ISSUES_TO_LOG = 10;
const IDLE_LEASE_MS = BROWSER_IDLE_LEASE_MINUTES * 60_000;
const INACTIVE_BROWSER_STATUSES = ["suspended", "error"] as const;
const L = logger("Browser");

const BROWSER_SESSION_SELECTION = {
  id: browserSessions.id,
  chatThreadId: browserSessions.chatThreadId,
  runId: browserSessions.runId,
  orgId: browserSessions.orgId,
  userId: browserSessions.userId,
  name: browserSessions.name,
  browserProfileId: browserSessions.browserProfileId,
  browserThreadProfileId: browserSessions.browserThreadProfileId,
  status: browserSessions.status,
  proxyCountryCode: browserSessions.proxyCountryCode,
  timeoutMinutes: browserSessions.timeoutMinutes,
  suspendedAt: browserSessions.suspendedAt,
  suspensionReason: browserSessions.suspensionReason,
  createdAt: browserSessions.createdAt,
  updatedAt: browserSessions.updatedAt,
} as const;

type BrowserSessionRow = typeof browserSessions.$inferSelect;
type BrowserInstanceRow = typeof browserSessionInstances.$inferSelect;
type InactiveBrowserStatus = (typeof INACTIVE_BROWSER_STATUSES)[number];

export interface BrowserServiceError {
  readonly kind: "error";
  readonly status: 400 | 403 | 404 | 409 | 502 | 503;
  readonly code: string;
  readonly message: string;
}

interface ProviderResult<T> {
  readonly kind: "ok";
  readonly value: T;
}

interface BrowserReleaseResult {
  readonly released: number;
}

interface BrowserReconcileResult {
  readonly checked: number;
  readonly stopped: number;
  readonly errors: number;
  readonly healthy: number;
}

function serviceError(
  status: BrowserServiceError["status"],
  code: string,
  message: string,
): BrowserServiceError {
  return { kind: "error", status, code, message };
}

function conflict(message: string, code = "BROWSER_CONFLICT") {
  return serviceError(409, code, message);
}

function providerFailure(error: unknown): BrowserServiceError {
  if (error instanceof BrowserUseProviderError) {
    return serviceError(error.status, error.code, error.message);
  }
  if (error instanceof ZodError) {
    const validationIssueCount = error.issues.length;
    L.warn("Managed browser provider returned an invalid response", {
      validationIssueCount,
      validationIssues: error.issues
        .slice(0, MAX_PROVIDER_VALIDATION_ISSUES_TO_LOG)
        .map((issue) => {
          return {
            path:
              issue.path.length === 0
                ? "<root>"
                : issue.path.map(String).join("."),
            code: issue.code,
            message: issue.message,
          };
        }),
      validationIssuesOmitted: Math.max(
        0,
        validationIssueCount - MAX_PROVIDER_VALIDATION_ISSUES_TO_LOG,
      ),
    });
    return serviceError(
      502,
      "BROWSER_USE_INVALID_RESPONSE",
      "Managed browser provider returned an invalid response",
    );
  }
  throw error;
}

async function providerCall<T>(
  request: Promise<T>,
): Promise<ProviderResult<T> | BrowserServiceError> {
  const result = await settle(request);
  return result.ok
    ? { kind: "ok", value: result.value }
    : providerFailure(result.error);
}

function nextIdleDeadline(): Date {
  return new Date(nowDate().getTime() + IDLE_LEASE_MS);
}

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

interface ActiveBrowserInstance {
  readonly chatThreadId: string;
  readonly providerSessionId: string;
  readonly orgId: string;
  readonly userId: string;
}

const saveBrowserTabSnapshot$ = command(
  async (
    { set },
    target: ActiveBrowserInstance,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const saved = await settle(
      (async () => {
        const provider = await getBrowserUseSession(
          target.providerSessionId,
          signal,
        );
        signal.throwIfAborted();
        if (provider.status !== "active" || !provider.cdpUrl) {
          return;
        }
        const { urls } = await listBrowserUseTabUrls(
          browserUseNativeConnection(provider),
          AbortSignal.any([
            signal,
            AbortSignal.timeout(BROWSER_TAB_SNAPSHOT_TIMEOUT_MS),
          ]),
        );
        signal.throwIfAborted();
        const encryptedTabUrls = await encryptPersistentSecretValue(
          JSON.stringify(urls),
          { userId: target.userId },
        );
        signal.throwIfAborted();
        const t = browserSessionTabSnapshots;
        const savedAt = nowDate();
        // Provider/KMS work may outlive legacy retirement and shared cutover.
        // Recheck the exact instance in both insertion and conflict publication.
        const currentInstance = new QueryBuilder()
          .select({ chatThreadId: browserSessions.chatThreadId })
          .from(browserSessionInstances)
          .innerJoin(
            browserSessions,
            eq(
              browserSessions.chatThreadId,
              browserSessionInstances.chatThreadId,
            ),
          )
          .where(
            and(
              eq(
                browserSessionInstances.providerSessionId,
                target.providerSessionId,
              ),
              eq(browserSessionInstances.status, "active"),
              eq(browserSessions.chatThreadId, target.chatThreadId),
              eq(browserSessions.orgId, target.orgId),
              eq(browserSessions.userId, target.userId),
              eq(browserSessions.status, "active"),
            ),
          );
        const source = new QueryBuilder()
          .select({
            chatThreadId: sql`${target.chatThreadId}::uuid`
              .mapWith(t.chatThreadId)
              .as("chat_thread_id"),
            encryptedTabUrls: sql`${encryptedTabUrls}::text`
              .mapWith(t.encryptedTabUrls)
              .as("encrypted_tab_urls"),
            createdAt: sql`${sql.param(savedAt, t.createdAt)}::timestamp`
              .mapWith(t.createdAt)
              .as("created_at"),
            updatedAt: sql`${sql.param(savedAt, t.updatedAt)}::timestamp`
              .mapWith(t.updatedAt)
              .as("updated_at"),
          })
          .from(currentInstance.as("current_instance"));
        await db
          .insert(t)
          .select(source)
          .onConflictDoUpdate({
            target: t.chatThreadId,
            set: {
              encryptedTabUrls,
              updatedAt: savedAt,
            },
            setWhere: exists(currentInstance),
          });
        signal.throwIfAborted();
      })(),
    );
    signal.throwIfAborted();
    if (!saved.ok) {
      L.warn("Managed browser tab snapshot failed", {
        chatThreadId: target.chatThreadId,
      });
    }
  },
);

function stopProviderSessionLater(
  providerSessionId: string,
  signal: AbortSignal,
): void {
  waitUntil(
    (async () => {
      const result = await settleIncludingAbort(
        stopBrowserUseSession(providerSessionId, signal),
      );
      if (!result.ok) {
        L.warn("Managed browser provider stop failed", {
          providerSessionId,
          error: result.error,
        });
      }
    })(),
  );
}

// Complete the committed stop and schedule exact provider cleanup before a
// caller observes cancellation. Both writes stay in one atomic statement.
const commitBrowserStop$ = command(
  async (
    { get, set },
    target: ActiveBrowserInstance,
    reason: BrowserSuspensionReason,
    stopProvider: boolean,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    const stoppedInstance = db
      .update(browserSessionInstances)
      .set({
        status: "stopped",
        stopRequestedAt: nowDate(),
        finishedAt: nowDate(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(
            browserSessionInstances.providerSessionId,
            target.providerSessionId,
          ),
          eq(browserSessionInstances.status, "active"),
        ),
      )
      .returning({
        providerSessionId: browserSessionInstances.providerSessionId,
      })
      .getSQL();
    const suspendedSession = db
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: nowDate(),
        suspensionReason: reason,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, target.chatThreadId),
          eq(browserSessions.orgId, target.orgId),
          eq(browserSessions.userId, target.userId),
          eq(browserSessions.status, "active"),
          exists(sql`(SELECT 1 FROM stopped_instance)`),
        ),
      )
      .getSQL();
    const rows = parseRawRows(
      object({ stopped: boolean() }),
      await db.execute(sql`WITH stopped_instance AS (${stoppedInstance}),
        suspended_session AS (${suspendedSession})
        SELECT ${exists(sql`(SELECT 1 FROM stopped_instance)`)} AS stopped`),
    );
    const [result] = rows;
    if (rows.length !== 1 || !result) {
      throw new Error("Expected one browser stop result");
    }
    const stopped = result.stopped;
    if (stopped && stopProvider) {
      stopProviderSessionLater(target.providerSessionId, get(rootSignal$));
    }
    return stopped;
  },
);

const stopActiveBrowserInstance$ = command(
  async (
    { set },
    target: ActiveBrowserInstance,
    reason: BrowserSuspensionReason,
    stopProvider: boolean,
    signal: AbortSignal,
  ): Promise<boolean> => {
    if (stopProvider) {
      await set(saveBrowserTabSnapshot$, target, signal);
    }
    const stopped = await set(commitBrowserStop$, target, reason, stopProvider);
    signal.throwIfAborted();
    if (!stopped) {
      return false;
    }
    await publishBrowserSessionChangedSafely(target.userId, {
      threadId: target.chatThreadId,
    });
    signal.throwIfAborted();
    return true;
  },
);

const browserAvailableConcurrency$ = command(
  async ({ get, set }, orgId: string): Promise<number> => {
    const [capabilities, paidSlots] = await Promise.all([
      set(loadOrgPlanCapabilities$, orgId),
      set(loadActivePaidConcurrencySlots$, orgId),
    ]);
    if (!capabilities) {
      return 0;
    }
    const limit = totalConcurrencyLimit({
      baseLimit: cappedBaseConcurrencyLimit(capabilities.baseConcurrencyLimit),
      paidSlots,
    });
    if (!Number.isFinite(limit) || limit === 0) {
      return limit;
    }
    const shared = await get(db$).$count(
      browserOwnerProfiles,
      and(
        eq(browserOwnerProfiles.orgId, orgId),
        inArray(browserOwnerProfiles.status, [
          "creating",
          "active",
          "stopping",
        ]),
      ),
    );
    return limit - shared;
  },
);

/** Shared admission accounts for legacy providers without reclaiming their state. */
export const ensureSharedBrowserCapacity$ = command(
  async (
    { get, set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<BrowserServiceError | null> => {
    const available = await set(browserAvailableConcurrency$, orgId);
    signal.throwIfAborted();
    if (!Number.isFinite(available)) {
      return null;
    }
    if (available > 0) {
      const legacy = await get(db$).$count(
        browserSessionInstances,
        and(
          inArray(browserSessionInstances.status, ["active", "stopping"]),
          exists(
            new QueryBuilder()
              .select({ id: browserThreadProfiles.id })
              .from(browserThreadProfiles)
              .where(
                and(
                  eq(
                    browserThreadProfiles.chatThreadId,
                    browserSessionInstances.chatThreadId,
                  ),
                  eq(browserThreadProfiles.orgId, orgId),
                ),
              ),
          ),
        ),
      );
      signal.throwIfAborted();
      if (legacy < available) {
        return null;
      }
    }
    return conflict(
      "This organization has no managed browser concurrency available",
      "BROWSER_CONCURRENCY_LIMIT",
    );
  },
);

type BrowserScreenshotStage = "prepare" | "capture" | "upload" | "save";

interface BrowserScreenshotPublication {
  readonly browser: Pick<
    BrowserSessionRow,
    "orgId" | "userId" | "chatThreadId"
  >;
  readonly fileId: string;
  readonly shared?: {
    readonly providerSessionId: string;
    readonly window: BrowserWindowContext;
    readonly previousValue: string | null;
    readonly capturedAt: Date;
  };
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

function sharedBrowserScreenshotPublication(
  args: BrowserScreenshotPublication,
  shared: NonNullable<BrowserScreenshotPublication["shared"]>,
  fileReady: SQL,
) {
  const { browser } = args;
  const t = browserChatSessions;
  const publication = browserCapturePublication({
    value: t.screenshotObjectKey,
    updatedAt: t.screenshotCapturedAt,
    previousValue: shared.previousValue,
    capturedAt: shared.capturedAt,
  });
  const guard = and(
    eq(t.chatThreadId, browser.chatThreadId),
    eq(t.instanceId, shared.window.instanceId),
    eq(t.primaryWindowId, shared.window.primaryWindowId),
    exists(
      new QueryBuilder()
        .select({ id: browserOwnerProfiles.id })
        .from(browserOwnerProfiles)
        .where(
          and(
            eq(browserOwnerProfiles.instanceId, shared.window.instanceId),
            eq(
              browserOwnerProfiles.providerSessionId,
              shared.providerSessionId,
            ),
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
    const { browser, shared } = args;
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
    let publicationSql: SQL;
    const t = browserSessionScreenshots;
    if (shared) {
      const publication = sharedBrowserScreenshotPublication(
        args,
        shared,
        exists(new QueryBuilder().select({ id: completed.id }).from(completed)),
      );
      publicationSql = db
        .update(browserChatSessions)
        .set({
          screenshotObjectKey: artifact.key,
          screenshotUrl: artifact.url,
          screenshotCapturedAt: publication.updatedAt,
        })
        .where(publication.canReplace)
        .returning({ id: browserChatSessions.chatThreadId })
        .getSQL();
    } else {
      publicationSql = db
        .insert(browserSessionScreenshots)
        .select(
          new QueryBuilder()
            .select({
              chatThreadId: sql`${browser.chatThreadId}::uuid`
                .mapWith(t.chatThreadId)
                .as("chat_thread_id"),
              objectKey: sql`${artifact.key}`
                .mapWith(t.objectKey)
                .as("object_key"),
              url: sql`${artifact.url}`.mapWith(t.url).as("url"),
              createdAt: sql`now()`.mapWith(t.createdAt).as("created_at"),
              updatedAt: sql`now()`.mapWith(t.updatedAt).as("updated_at"),
            })
            .from(completed),
        )
        .onConflictDoUpdate({
          target: browserSessionScreenshots.chatThreadId,
          set: {
            objectKey: artifact.key,
            url: artifact.url,
            updatedAt: nowDate(),
          },
        })
        .returning({ id: browserSessionScreenshots.chatThreadId })
        .getSQL();
    }
    // Every candidate retains its own cleanup identity, including the accepted
    // preview. The sweeper excludes referenced keys. This also covers a value
    // displaced by a concurrent upsert that this statement's snapshot cannot
    // see; saving only the snapshot-visible predecessor would lose that key.
    const previous = shared
      ? db
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
          )
      : db
          .select({
            objectKey: browserSessionScreenshots.objectKey,
            chatThreadId: browserSessionScreenshots.chatThreadId,
            createdAt: browserSessionScreenshots.createdAt,
          })
          .from(browserSessionScreenshots)
          .where(
            eq(browserSessionScreenshots.chatThreadId, browser.chatThreadId),
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
    browser: Pick<BrowserSessionRow, "orgId" | "userId" | "chatThreadId">,
    shared?: {
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
        const instance =
          shared ?? (await set(loadActiveInstance$, browser.chatThreadId));
        signal.throwIfAborted();
        if (!instance) {
          return;
        }
        let previousValue: string | null = null;
        if (shared) {
          const [previous] = await get(db$)
            .select({ objectKey: browserChatSessions.screenshotObjectKey })
            .from(browserChatSessions)
            .where(eq(browserChatSessions.chatThreadId, browser.chatThreadId));
          signal.throwIfAborted();
          previousValue = previous?.objectKey ?? null;
        }
        const provider = await getBrowserUseSession(
          instance.providerSessionId,
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
          AbortSignal.any([
            signal,
            AbortSignal.timeout(BROWSER_SCREENSHOT_CAPTURE_TIMEOUT_MS),
          ]),
          shared?.window.primaryWindowId,
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
          shared: shared ? { ...shared, previousValue, capturedAt } : undefined,
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

const scheduleBrowserScreenshotCapture$ = command(
  ({ set }, browser: BrowserSessionRow): void => {
    waitUntil(set(captureAndStoreBrowserScreenshot$, browser));
  },
);

const loadActiveInstance$ = command(
  async ({ get }, chatThreadId: string): Promise<BrowserInstanceRow | null> => {
    const db = get(db$);
    const [row] = await db
      .select()
      .from(browserSessionInstances)
      .where(
        and(
          eq(browserSessionInstances.chatThreadId, chatThreadId),
          eq(browserSessionInstances.status, "active"),
        ),
      )
      .orderBy(desc(browserSessionInstances.createdAt))
      .limit(1);
    return row ?? null;
  },
);

interface BrowserProfileCleanupTarget {
  readonly chatThreadId: string;
  readonly providerProfileId: string;
}

const latestBrowserProviderSessionId$ = command(
  async (
    { get },
    target: BrowserProfileCleanupTarget,
  ): Promise<string | null> => {
    const db = get(db$);
    const [instance] = await db
      .select({
        providerSessionId: browserSessionInstances.providerSessionId,
      })
      .from(browserSessionInstances)
      .innerJoin(
        browserThreadProfiles,
        eq(
          browserThreadProfiles.chatThreadId,
          browserSessionInstances.chatThreadId,
        ),
      )
      .where(
        and(
          eq(browserSessionInstances.chatThreadId, target.chatThreadId),
          eq(browserThreadProfiles.providerProfileId, target.providerProfileId),
        ),
      )
      .orderBy(desc(browserSessionInstances.createdAt))
      .limit(1);
    return instance?.providerSessionId ?? null;
  },
);

const retireBrowserProfileOwnership$ = command(
  async (
    { set },
    target: BrowserProfileCleanupTarget,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    const ownedBrowsers = await db
      .select({
        id: browserSessions.id,
        runId: browserSessions.runId,
        status: browserSessions.status,
        updatedAt: browserSessions.updatedAt,
      })
      .from(browserSessions)
      .innerJoin(
        browserThreadProfiles,
        eq(browserThreadProfiles.chatThreadId, browserSessions.chatThreadId),
      )
      .where(
        and(
          eq(browserSessions.chatThreadId, target.chatThreadId),
          eq(browserThreadProfiles.providerProfileId, target.providerProfileId),
        ),
      );
    signal.throwIfAborted();
    const profileScope = and(
      eq(browserThreadProfiles.chatThreadId, target.chatThreadId),
      eq(browserThreadProfiles.providerProfileId, target.providerProfileId),
    );
    if (ownedBrowsers.length > 0) {
      // A profile-qualified snapshot identifies the exact rows being retired.
      // A delayed DELETE must not adopt a replacement row or a resumed owner.
      const retiredBrowsers = db.$with("retired_browsers").as(
        db
          .delete(browserSessions)
          .where(
            and(
              exists(
                db
                  .select({ id: browserThreadProfiles.id })
                  .from(browserThreadProfiles)
                  .where(
                    and(
                      eq(
                        browserThreadProfiles.chatThreadId,
                        target.chatThreadId,
                      ),
                      eq(
                        browserThreadProfiles.providerProfileId,
                        target.providerProfileId,
                      ),
                    ),
                  ),
              ),
              or(
                ...ownedBrowsers.map((browser) => {
                  return and(
                    eq(browserSessions.id, browser.id),
                    browser.runId === null
                      ? isNull(browserSessions.runId)
                      : eq(browserSessions.runId, browser.runId),
                    eq(browserSessions.status, browser.status),
                    eq(browserSessions.updatedAt, browser.updatedAt),
                  );
                }),
              ),
            ),
          )
          .returning({ id: browserSessions.id }),
      );
      // Exhaust the guarded browser DELETE before retiring the exact profile,
      // including when no snapshotted browser remains eligible.
      await db
        .with(retiredBrowsers)
        .delete(browserThreadProfiles)
        .where(
          and(
            profileScope,
            gte(db.select({ count: count() }).from(retiredBrowsers), 0),
          ),
        );
    } else {
      await db.delete(browserThreadProfiles).where(profileScope);
    }
    signal.throwIfAborted();
  },
);

const cleanupBrowserProfile$ = command(
  async (
    { set },
    target: BrowserProfileCleanupTarget,
    providerSessionIds: readonly string[] | undefined,
    signal: AbortSignal,
  ): Promise<void> => {
    const retryProviderSessionId =
      providerSessionIds === undefined
        ? await set(latestBrowserProviderSessionId$, target)
        : null;
    signal.throwIfAborted();
    const cleanupProviderSessionIds =
      providerSessionIds ??
      (retryProviderSessionId === null ? [] : [retryProviderSessionId]);
    for (const providerSessionId of cleanupProviderSessionIds) {
      await stopBrowserUseSessionForCleanup(providerSessionId, signal);
      signal.throwIfAborted();
    }
    await deleteBrowserUseProfile(target.providerProfileId, signal);
    signal.throwIfAborted();
    await set(retireBrowserProfileOwnership$, target, signal);
  },
);

const cleanupBrowserProfileLater$ = command(
  (
    { set },
    target: BrowserProfileCleanupTarget,
    providerSessionIds: readonly string[],
  ): void => {
    const backgroundSignal = new AbortController().signal;
    waitUntil(
      (async () => {
        const result = await settleIncludingAbort(
          set(
            cleanupBrowserProfile$,
            target,
            providerSessionIds,
            backgroundSignal,
          ),
        );
        if (!result.ok) {
          L.warn("Managed browser provider profile cleanup failed", {
            chatThreadId: target.chatThreadId,
            providerProfileId: target.providerProfileId,
            error: result.error,
          });
        }
      })(),
    );
  },
);

// A terminal run no longer stops its browser: the window stays live so the user
// can keep working in it and the next run can attach to it. Refreshing the lease
// here gives that hand-off a full idle window measured from the run's end.
export const releaseThreadBrowsersForRun$ = command(
  async (
    { set },
    args: { readonly chatThreadId: string },
    signal: AbortSignal,
  ): Promise<BrowserReleaseResult> => {
    const db = set(writeDb$);
    const released = await db
      .update(browserSessionInstances)
      .set({
        lastTouchedAt: nowDate(),
        idleExpiresAt: nextIdleDeadline(),
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessionInstances.chatThreadId, args.chatThreadId),
          eq(browserSessionInstances.status, "active"),
        ),
      )
      .returning({
        providerSessionId: browserSessionInstances.providerSessionId,
      });
    signal.throwIfAborted();
    return { released: released.length };
  },
);

export const stopThreadBrowsers$ = command(
  async (
    { set },
    args: { readonly chatThreadId: string },
    signal: AbortSignal,
  ): Promise<BrowserReleaseResult> => {
    const db = set(writeDb$);
    await db
      .update(browserSessions)
      .set({
        status: "stopping",
        suspensionReason: "reconcile",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, args.chatThreadId),
          inArray(browserSessions.status, ["creating", "resuming"]),
        ),
      );
    signal.throwIfAborted();

    const active = await db
      .select({
        chatThreadId: browserSessions.chatThreadId,
        providerSessionId: browserSessionInstances.providerSessionId,
        orgId: browserSessions.orgId,
        userId: browserSessions.userId,
      })
      .from(browserSessionInstances)
      .innerJoin(
        browserSessions,
        eq(browserSessions.chatThreadId, browserSessionInstances.chatThreadId),
      )
      .where(
        and(
          eq(browserSessionInstances.chatThreadId, args.chatThreadId),
          eq(browserSessionInstances.status, "active"),
        ),
      );
    signal.throwIfAborted();

    let released = 0;
    for (const target of active) {
      if (
        await set(
          stopActiveBrowserInstance$,
          target,
          "reconcile",
          false,
          signal,
        )
      ) {
        released += 1;
      }
    }

    await db
      .delete(browserSessionTabSnapshots)
      .where(eq(browserSessionTabSnapshots.chatThreadId, args.chatThreadId));
    signal.throwIfAborted();

    await db
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: nowDate(),
        suspensionReason: "reconcile",
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, args.chatThreadId),
          eq(browserSessions.status, "active"),
          notExists(
            db
              .select({
                providerSessionId: browserSessionInstances.providerSessionId,
              })
              .from(browserSessionInstances)
              .where(
                and(
                  eq(
                    browserSessionInstances.chatThreadId,
                    browserSessions.chatThreadId,
                  ),
                  eq(browserSessionInstances.status, "active"),
                ),
              ),
          ),
        ),
      );
    signal.throwIfAborted();

    const [profile] = await db
      .select({
        chatThreadId: browserThreadProfiles.chatThreadId,
        providerProfileId: browserThreadProfiles.providerProfileId,
      })
      .from(browserThreadProfiles)
      .where(eq(browserThreadProfiles.chatThreadId, args.chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (profile) {
      set(
        cleanupBrowserProfileLater$,
        profile,
        active.map((target) => {
          return target.providerSessionId;
        }),
      );
    } else {
      await db
        .delete(browserSessions)
        .where(eq(browserSessions.chatThreadId, args.chatThreadId));
      signal.throwIfAborted();
    }

    return { released };
  },
);

const releaseStrandedBrowserStarts$ = command(
  async ({ set }, limit: number, signal: AbortSignal): Promise<number> => {
    const db = set(writeDb$);
    const stranded = await db
      .select({
        chatThreadId: browserSessions.chatThreadId,
        userId: browserSessions.userId,
        suspendedAt: browserSessions.suspendedAt,
        suspensionReason: browserSessions.suspensionReason,
      })
      .from(browserSessions)
      .where(
        and(
          eq(browserSessions.status, "stopping"),
          lte(
            browserSessions.updatedAt,
            new Date(nowDate().getTime() - STRANDED_START_GRACE_MS),
          ),
        ),
      )
      .limit(limit);
    signal.throwIfAborted();
    for (const browser of stranded) {
      const retentionCutoff = new Date(
        nowDate().getTime() - INACTIVE_BROWSER_RETENTION_MS,
      );
      const retentionClaimedAt =
        browser.suspensionReason === "reconcile" &&
        browser.suspendedAt !== null &&
        browser.suspendedAt <= retentionCutoff
          ? browser.suspendedAt
          : null;
      const stoppedInstances = db.$with("stopped_instances").as(
        db
          .update(browserSessionInstances)
          .set({
            status: "stopped",
            finishedAt: nowDate(),
            updatedAt: nowDate(),
          })
          .where(
            and(
              eq(browserSessionInstances.chatThreadId, browser.chatThreadId),
              eq(browserSessionInstances.status, "stopping"),
            ),
          )
          .returning({
            providerSessionId: browserSessionInstances.providerSessionId,
          }),
      );
      // Exhaust the instance write before the independently required logical
      // write, including zero matches. Fresh logical timestamps are captured
      // before the instance wait; both writes share one statement snapshot.
      await db
        .with(stoppedInstances)
        .update(browserSessions)
        .set({
          status: "suspended",
          suspendedAt: retentionClaimedAt ?? nowDate(),
          updatedAt: retentionClaimedAt ?? nowDate(),
        })
        .where(
          and(
            eq(browserSessions.chatThreadId, browser.chatThreadId),
            eq(browserSessions.status, "stopping"),
            gte(db.select({ count: count() }).from(stoppedInstances), 0),
          ),
        );
      signal.throwIfAborted();
      await publishBrowserSessionChangedSafely(browser.userId, {
        threadId: browser.chatThreadId,
      });
      signal.throwIfAborted();
    }
    // Nothing stops a browser at run end any more, so a sandbox that dies while
    // its provider instance is starting would otherwise hold the thread's only
    // live-browser slot forever.
    const abandonedStarts = await db
      .update(browserSessions)
      .set({ status: "error", updatedAt: nowDate() })
      .where(
        and(
          inArray(browserSessions.status, ["creating", "resuming"]),
          lte(
            browserSessions.updatedAt,
            new Date(nowDate().getTime() - PROVIDER_START_LIFECYCLE_TIMEOUT_MS),
          ),
          notExists(
            db
              .select({
                providerSessionId: browserSessionInstances.providerSessionId,
              })
              .from(browserSessionInstances)
              .where(
                and(
                  eq(
                    browserSessionInstances.chatThreadId,
                    browserSessions.chatThreadId,
                  ),
                  eq(browserSessionInstances.status, "active"),
                ),
              ),
          ),
        ),
      )
      .returning({ chatThreadId: browserSessions.chatThreadId });
    signal.throwIfAborted();
    return stranded.length + abandonedStarts.length;
  },
);

interface ExpiredInactiveBrowserTarget {
  readonly browserId: string;
  readonly chatThreadId: string;
  readonly userId: string;
  readonly status: InactiveBrowserStatus;
  readonly suspendedAt: Date | null;
  readonly suspensionReason: BrowserSuspensionReason | null;
  readonly updatedAt: Date;
  readonly providerProfileId: string | null;
}

function expiredInactiveBrowserClaim(
  target: ExpiredInactiveBrowserTarget,
  cutoff: Date,
) {
  return and(
    eq(browserSessions.id, target.browserId),
    eq(browserSessions.chatThreadId, target.chatThreadId),
    eq(browserSessions.status, target.status),
    eq(browserSessions.updatedAt, target.updatedAt),
    lte(browserSessions.updatedAt, cutoff),
    target.providerProfileId === null
      ? notExists(
          new QueryBuilder()
            .select({ id: browserThreadProfiles.id })
            .from(browserThreadProfiles)
            .where(eq(browserThreadProfiles.chatThreadId, target.chatThreadId)),
        )
      : exists(
          new QueryBuilder()
            .select({ id: browserThreadProfiles.id })
            .from(browserThreadProfiles)
            .where(
              and(
                eq(browserThreadProfiles.chatThreadId, target.chatThreadId),
                eq(
                  browserThreadProfiles.providerProfileId,
                  target.providerProfileId,
                ),
              ),
            ),
        ),
    notExists(
      new QueryBuilder()
        .select({
          providerSessionId: browserSessionInstances.providerSessionId,
        })
        .from(browserSessionInstances)
        .where(
          and(
            eq(
              browserSessionInstances.chatThreadId,
              browserSessions.chatThreadId,
            ),
            inArray(browserSessionInstances.status, ["active", "stopping"]),
          ),
        ),
    ),
    notExists(
      new QueryBuilder()
        .select({
          requestTokenHash: browserUserActionRequests.requestTokenHash,
        })
        .from(browserUserActionRequests)
        .innerJoin(
          browserSessionInstances,
          eq(
            browserSessionInstances.providerSessionId,
            browserUserActionRequests.providerSessionId,
          ),
        )
        .where(
          eq(
            browserSessionInstances.chatThreadId,
            browserSessions.chatThreadId,
          ),
        ),
    ),
  );
}

const claimExpiredInactiveBrowser$ = command(
  async (
    { set },
    target: ExpiredInactiveBrowserTarget,
    cutoff: Date,
    signal: AbortSignal,
  ): Promise<Date | null> => {
    const db = set(writeDb$);
    const claimedAt = nowDate();
    const claimedBrowser = db.$with("claimed_browser").as(
      db
        .update(browserSessions)
        .set({
          status: "stopping",
          suspendedAt: target.updatedAt,
          suspensionReason: "reconcile",
          updatedAt: claimedAt,
        })
        .where(expiredInactiveBrowserClaim(target, cutoff))
        .returning({ chatThreadId: browserSessions.chatThreadId }),
    );
    const claimedThreads = db
      .select({ chatThreadId: claimedBrowser.chatThreadId })
      .from(claimedBrowser);
    const removedPreview = db
      .$with("removed_browser_preview")
      .as(
        db
          .delete(browserSessionScreenshots)
          .where(
            inArray(browserSessionScreenshots.chatThreadId, claimedThreads),
          )
          .returning(),
      );
    const queuedPreview = db.$with("queued_browser_preview").as(
      db
        .insert(browserSessionScreenshotDeletions)
        .select(
          new QueryBuilder()
            .select({
              objectKey: removedPreview.objectKey,
              chatThreadId: removedPreview.chatThreadId,
              createdAt: removedPreview.createdAt,
            })
            .from(removedPreview),
        )
        .onConflictDoNothing()
        .returning({ objectKey: browserSessionScreenshotDeletions.objectKey }),
    );
    const removedTabs = db
      .$with("removed_browser_tabs")
      .as(
        db
          .delete(browserSessionTabSnapshots)
          .where(
            inArray(browserSessionTabSnapshots.chatThreadId, claimedThreads),
          )
          .returning({ chatThreadId: browserSessionTabSnapshots.chatThreadId }),
      );
    const removedInstances = db.$with("removed_browser_instances").as(
      db
        .delete(browserSessionInstances)
        .where(inArray(browserSessionInstances.chatThreadId, claimedThreads))
        .returning({
          providerSessionId: browserSessionInstances.providerSessionId,
        }),
    );
    // Every local write commits with the exact claim in one statement. Its
    // snapshot deliberately does not fence later cache publications.
    const [claimed] = await db
      .with(
        claimedBrowser,
        removedPreview,
        queuedPreview,
        removedTabs,
        removedInstances,
      )
      .select({ chatThreadId: claimedBrowser.chatThreadId })
      .from(claimedBrowser);
    signal.throwIfAborted();
    return claimed ? claimedAt : null;
  },
);

const releaseExpiredInactiveBrowserClaim$ = command(
  async (
    { set },
    target: ExpiredInactiveBrowserTarget,
    claimedAt: Date,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(browserSessions)
      .set({
        status: target.status,
        suspendedAt: target.suspendedAt,
        suspensionReason: target.suspensionReason,
        updatedAt: target.updatedAt,
      })
      .where(
        and(
          eq(browserSessions.id, target.browserId),
          eq(browserSessions.chatThreadId, target.chatThreadId),
          eq(browserSessions.status, "stopping"),
          eq(browserSessions.updatedAt, claimedAt),
        ),
      );
  },
);

const retireExpiredInactiveBrowser$ = command(
  async (
    { set },
    target: ExpiredInactiveBrowserTarget,
    claimedAt: Date,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    // Both nonlocking observations now share a statement snapshot. The actual
    // conditional DELETE still decides whether a present browser was retired.
    const observedBrowser = db.$with("observed_browser").as(
      db
        .select({
          id: browserSessions.id,
          status: browserSessions.status,
          updatedAt: browserSessions.updatedAt,
        })
        .from(browserSessions)
        .where(
          and(
            eq(browserSessions.id, target.browserId),
            eq(browserSessions.chatThreadId, target.chatThreadId),
          ),
        ),
    );
    const observedProfile = db.$with("observed_profile").as(
      db
        .select({
          providerProfileId: browserThreadProfiles.providerProfileId,
        })
        .from(browserThreadProfiles)
        .where(eq(browserThreadProfiles.chatThreadId, target.chatThreadId)),
    );
    const profileMatches = notExists(
      db
        .select({ providerProfileId: observedProfile.providerProfileId })
        .from(observedProfile)
        .where(
          target.providerProfileId === null
            ? isNotNull(observedProfile.providerProfileId)
            : ne(observedProfile.providerProfileId, target.providerProfileId),
        ),
    );
    const retiredBrowser = db.$with("retired_browser").as(
      db
        .delete(browserSessions)
        .where(
          and(
            eq(browserSessions.id, target.browserId),
            eq(browserSessions.chatThreadId, target.chatThreadId),
            eq(browserSessions.status, "stopping"),
            eq(browserSessions.updatedAt, claimedAt),
            profileMatches,
            exists(
              db
                .select({ id: observedBrowser.id })
                .from(observedBrowser)
                .where(
                  and(
                    eq(observedBrowser.status, "stopping"),
                    eq(observedBrowser.updatedAt, claimedAt),
                  ),
                ),
            ),
          ),
        )
        .returning({ id: browserSessions.id }),
    );
    // COUNT consumes every returned parent row before the dependent DELETE.
    // Observed-present/DELETE-zero is rejection, unlike initially absent.
    const accepted = sql`CASE
      WHEN ${gt(db.select({ count: count() }).from(retiredBrowser), 0)} THEN true
      WHEN ${notExists(db.select({ id: observedBrowser.id }).from(observedBrowser))}
        THEN ${profileMatches}
      ELSE false
    END`;
    const retiredProfile =
      target.providerProfileId === null
        ? null
        : db.$with("retired_profile").as(
            db
              .delete(browserThreadProfiles)
              .where(
                and(
                  eq(browserThreadProfiles.chatThreadId, target.chatThreadId),
                  eq(
                    browserThreadProfiles.providerProfileId,
                    target.providerProfileId,
                  ),
                  accepted,
                ),
              )
              .returning({ id: browserThreadProfiles.id }),
          );
    const [result] = await (retiredProfile === null
      ? db
          .with(observedBrowser, observedProfile, retiredBrowser)
          .select({ retired: accepted.mapWith(pgBooleanDecoder) })
          .from(sql`(VALUES (1)) AS retirement_result`)
      : db
          .with(
            observedBrowser,
            observedProfile,
            retiredBrowser,
            retiredProfile,
          )
          .select({
            retired:
              sql`CASE WHEN ${gte(db.select({ count: count() }).from(retiredProfile), 0)}
                THEN ${accepted} ELSE false END`.mapWith(pgBooleanDecoder),
          })
          .from(sql`(VALUES (1)) AS retirement_result`));
    signal.throwIfAborted();
    if (!result) {
      throw new Error("Expected one expired browser retirement outcome");
    }
    const retired = result.retired;
    if (retired) {
      await publishBrowserSessionChangedSafely(target.userId, {
        threadId: target.chatThreadId,
      });
    }
    signal.throwIfAborted();
    return retired;
  },
);

const cleanupExpiredInactiveBrowser$ = command(
  async (
    { set },
    target: ExpiredInactiveBrowserTarget,
    cutoff: Date,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const claimedAt = await set(
      claimExpiredInactiveBrowser$,
      target,
      cutoff,
      signal,
    );
    if (claimedAt === null) {
      return false;
    }

    const cleanup = await settleIncludingAbort(
      (async () => {
        if (target.providerProfileId !== null) {
          await deleteBrowserUseProfile(target.providerProfileId, signal);
        }
        const retired = await set(
          retireExpiredInactiveBrowser$,
          target,
          claimedAt,
          signal,
        );
        if (!retired) {
          throw new Error("Expired managed browser cleanup claim changed");
        }
      })(),
    );
    if (signal.aborted) {
      if (!cleanup.ok) {
        await set(releaseExpiredInactiveBrowserClaim$, target, claimedAt);
      }
      signal.throwIfAborted();
    }
    if (!cleanup.ok) {
      await set(releaseExpiredInactiveBrowserClaim$, target, claimedAt);
      signal.throwIfAborted();
      throw cleanup.error;
    }
    signal.throwIfAborted();
    return true;
  },
);

const reconcileExpiredInactiveBrowsers$ = command(
  async (
    { set },
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    readonly checked: number;
    readonly cleaned: number;
    readonly errors: number;
  }> => {
    const db = set(writeDb$);
    const cutoff = new Date(
      nowDate().getTime() - INACTIVE_BROWSER_RETENTION_MS,
    );
    const rows = await db
      .select({
        browserId: browserSessions.id,
        chatThreadId: browserSessions.chatThreadId,
        userId: browserSessions.userId,
        status: browserSessions.status,
        suspendedAt: browserSessions.suspendedAt,
        suspensionReason: browserSessions.suspensionReason,
        updatedAt: browserSessions.updatedAt,
        providerProfileId: browserThreadProfiles.providerProfileId,
      })
      .from(browserSessions)
      .leftJoin(
        browserThreadProfiles,
        eq(browserThreadProfiles.chatThreadId, browserSessions.chatThreadId),
      )
      .where(
        and(
          inArray(browserSessions.status, [...INACTIVE_BROWSER_STATUSES]),
          lte(browserSessions.updatedAt, cutoff),
          notExists(
            db
              .select({
                providerSessionId: browserSessionInstances.providerSessionId,
              })
              .from(browserSessionInstances)
              .where(
                and(
                  eq(
                    browserSessionInstances.chatThreadId,
                    browserSessions.chatThreadId,
                  ),
                  inArray(browserSessionInstances.status, [
                    "active",
                    "stopping",
                  ]),
                ),
              ),
          ),
          notExists(
            db
              .select({
                requestTokenHash: browserUserActionRequests.requestTokenHash,
              })
              .from(browserUserActionRequests)
              .innerJoin(
                browserSessionInstances,
                eq(
                  browserSessionInstances.providerSessionId,
                  browserUserActionRequests.providerSessionId,
                ),
              )
              .where(
                eq(
                  browserSessionInstances.chatThreadId,
                  browserSessions.chatThreadId,
                ),
              ),
          ),
        ),
      )
      .orderBy(browserSessions.updatedAt)
      .limit(limit);
    signal.throwIfAborted();

    let cleaned = 0;
    let errors = 0;
    for (const row of rows) {
      if (row.status !== "suspended" && row.status !== "error") {
        throw new Error("Expected an inactive managed browser cleanup target");
      }
      const result = await settleIncludingAbort(
        set(
          cleanupExpiredInactiveBrowser$,
          { ...row, status: row.status },
          cutoff,
          signal,
        ),
      );
      signal.throwIfAborted();
      if (result.ok) {
        cleaned += result.value ? 1 : 0;
      } else {
        errors += 1;
        L.warn("Managed browser retention cleanup failed", {
          chatThreadId: row.chatThreadId,
          providerProfileId: row.providerProfileId,
          error: result.error,
        });
      }
    }
    return { checked: rows.length, cleaned, errors };
  },
);

const purgeExpiredStoppedBrowserInstances$ = command(
  async (
    { set },
    limit: number,
    signal: AbortSignal,
  ): Promise<{ readonly checked: number; readonly cleaned: number }> => {
    const db = set(writeDb$);
    const cutoff = new Date(
      nowDate().getTime() - INACTIVE_BROWSER_RETENTION_MS,
    );
    const rows = await db
      .select({
        providerSessionId: browserSessionInstances.providerSessionId,
      })
      .from(browserSessionInstances)
      .where(
        and(
          eq(browserSessionInstances.status, "stopped"),
          lte(browserSessionInstances.finishedAt, cutoff),
          notExists(
            db
              .select({
                requestTokenHash: browserUserActionRequests.requestTokenHash,
              })
              .from(browserUserActionRequests)
              .where(
                eq(
                  browserUserActionRequests.providerSessionId,
                  browserSessionInstances.providerSessionId,
                ),
              ),
          ),
        ),
      )
      .orderBy(browserSessionInstances.finishedAt)
      .limit(limit);
    signal.throwIfAborted();
    if (rows.length === 0) {
      return { checked: 0, cleaned: 0 };
    }
    const deleted = await db
      .delete(browserSessionInstances)
      .where(
        and(
          eq(browserSessionInstances.status, "stopped"),
          lte(browserSessionInstances.finishedAt, cutoff),
          notExists(
            db
              .select({
                requestTokenHash: browserUserActionRequests.requestTokenHash,
              })
              .from(browserUserActionRequests)
              .where(
                eq(
                  browserUserActionRequests.providerSessionId,
                  browserSessionInstances.providerSessionId,
                ),
              ),
          ),
          inArray(
            browserSessionInstances.providerSessionId,
            rows.map((row) => {
              return row.providerSessionId;
            }),
          ),
        ),
      )
      .returning({
        providerSessionId: browserSessionInstances.providerSessionId,
      });
    signal.throwIfAborted();
    return { checked: rows.length, cleaned: deleted.length };
  },
);

const deferBrowserInstanceReconcile$ = command(
  async (
    { set },
    providerSessionId: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = set(writeDb$);
    await db
      .update(browserSessionInstances)
      .set({ updatedAt: nowDate() })
      .where(eq(browserSessionInstances.providerSessionId, providerSessionId));
    signal.throwIfAborted();
  },
);

interface BrowserReconcileCandidate {
  readonly browser: BrowserSessionRow;
  readonly instance: BrowserInstanceRow;
  readonly chatThreadId: string | null;
}

interface BrowserReconcileOutcome {
  readonly stopped: number;
  readonly errors: number;
  readonly healthy: number;
}

const reconcileOrphanedBrowserProfiles$ = command(
  async (
    { set },
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    readonly checked: number;
    readonly cleaned: number;
    readonly errors: number;
  }> => {
    const db = set(writeDb$);
    const profiles = await db
      .select({
        chatThreadId: browserThreadProfiles.chatThreadId,
        providerProfileId: browserThreadProfiles.providerProfileId,
      })
      .from(browserThreadProfiles)
      .leftJoin(
        chatThreads,
        eq(chatThreads.id, browserThreadProfiles.chatThreadId),
      )
      .where(isNull(chatThreads.id))
      .orderBy(browserThreadProfiles.updatedAt)
      .limit(limit);
    signal.throwIfAborted();

    let cleaned = 0;
    let errors = 0;
    for (const profile of profiles) {
      const result = await settleIncludingAbort(
        set(cleanupBrowserProfile$, profile, undefined, signal),
      );
      signal.throwIfAborted();
      if (result.ok) {
        cleaned += 1;
      } else {
        errors += 1;
        L.warn("Managed browser orphaned profile reconciliation failed", {
          chatThreadId: profile.chatThreadId,
          providerProfileId: profile.providerProfileId,
          error: result.error,
        });
      }
    }
    return { checked: profiles.length, cleaned, errors };
  },
);

const reconcileOrphanedBrowserScreenshots$ = command(
  async (
    { set },
    limit: number,
    signal: AbortSignal,
  ): Promise<{
    readonly checked: number;
    readonly cleaned: number;
    readonly errors: number;
  }> => {
    const db = set(writeDb$);
    const screenshots = await db
      .select({
        chatThreadId: browserSessionScreenshots.chatThreadId,
        objectKey: browserSessionScreenshots.objectKey,
      })
      .from(browserSessionScreenshots)
      .leftJoin(
        chatThreads,
        eq(chatThreads.id, browserSessionScreenshots.chatThreadId),
      )
      .where(isNull(chatThreads.id))
      .orderBy(browserSessionScreenshots.updatedAt)
      .limit(limit);
    signal.throwIfAborted();

    let cleaned = 0;
    let errors = 0;
    for (const screenshot of screenshots) {
      const removed = db.$with("orphaned_browser_preview").as(
        db
          .delete(browserSessionScreenshots)
          .where(
            and(
              eq(
                browserSessionScreenshots.chatThreadId,
                screenshot.chatThreadId,
              ),
              eq(browserSessionScreenshots.objectKey, screenshot.objectKey),
              notExists(
                db
                  .select({ id: chatThreads.id })
                  .from(chatThreads)
                  .where(
                    eq(chatThreads.id, browserSessionScreenshots.chatThreadId),
                  ),
              ),
            ),
          )
          .returning(),
      );
      const result = await settleIncludingAbort(
        db
          .with(removed)
          .insert(browserSessionScreenshotDeletions)
          .select(
            new QueryBuilder()
              .select({
                objectKey: removed.objectKey,
                chatThreadId: removed.chatThreadId,
                createdAt: removed.createdAt,
              })
              .from(removed),
          )
          .onConflictDoNothing(),
      );
      signal.throwIfAborted();
      if (result.ok) {
        cleaned += 1;
      } else {
        errors += 1;
        L.warn("Managed browser orphaned screenshot reconciliation failed", {
          chatThreadId: screenshot.chatThreadId,
          objectKey: screenshot.objectKey,
          error: result.error,
        });
      }
    }
    return { checked: screenshots.length, cleaned, errors };
  },
);

const reconcileBrowserInstance$ = command(
  async (
    { set },
    row: BrowserReconcileCandidate,
    signal: AbortSignal,
  ): Promise<BrowserReconcileOutcome> => {
    let reason: BrowserSuspensionReason | null = null;
    let stopProvider = true;
    if (row.chatThreadId === null) {
      // Nobody can reach a deleted thread's browser, so reclaim it now instead
      // of leaving it alive until the lease runs out.
      reason = "reconcile";
    } else if (row.instance.timeoutAt <= nowDate()) {
      reason = "timeout";
    } else if (row.instance.idleExpiresAt <= nowDate()) {
      reason = "idle";
    } else {
      const provider = await providerCall(
        getBrowserUseSession(row.instance.providerSessionId, signal),
      );
      signal.throwIfAborted();
      if (provider.kind === "error") {
        await set(
          deferBrowserInstanceReconcile$,
          row.instance.providerSessionId,
          signal,
        );
        return { stopped: 0, errors: 1, healthy: 0 };
      }
      if (provider.value.status === "stopped") {
        reason = "provider";
        stopProvider = false;
      }
    }
    if (!reason) {
      await set(
        deferBrowserInstanceReconcile$,
        row.instance.providerSessionId,
        signal,
      );
      set(scheduleBrowserScreenshotCapture$, row.browser);
      return { stopped: 0, errors: 0, healthy: 1 };
    }

    const stopped = await set(
      stopActiveBrowserInstance$,
      {
        chatThreadId: row.browser.chatThreadId,
        providerSessionId: row.instance.providerSessionId,
        orgId: row.browser.orgId,
        userId: row.browser.userId,
      },
      reason,
      stopProvider,
      signal,
    );
    return {
      stopped: stopped ? 1 : 0,
      errors: 0,
      healthy: 0,
    };
  },
);

export const reconcileBrowsers$ = command(
  async ({ set }, signal: AbortSignal): Promise<BrowserReconcileResult> => {
    const db = set(writeDb$);
    const rows = await db
      .select({
        browser: BROWSER_SESSION_SELECTION,
        instance: browserSessionInstances,
        chatThreadId: chatThreads.id,
      })
      .from(browserSessionInstances)
      .innerJoin(
        browserSessions,
        eq(browserSessions.chatThreadId, browserSessionInstances.chatThreadId),
      )
      .leftJoin(
        chatThreads,
        eq(chatThreads.id, browserSessionInstances.chatThreadId),
      )
      .where(eq(browserSessionInstances.status, "active"))
      .orderBy(browserSessionInstances.updatedAt)
      .limit(RECONCILE_BATCH_SIZE);
    signal.throwIfAborted();

    let stopped = 0;
    let errors = 0;
    let healthy = 0;
    for (const row of rows) {
      const outcome = await set(reconcileBrowserInstance$, row, signal);
      stopped += outcome.stopped;
      errors += outcome.errors;
      healthy += outcome.healthy;
    }

    const releasedStarts = await set(
      releaseStrandedBrowserStarts$,
      RECONCILE_BATCH_SIZE,
      signal,
    );
    const checkedUserActions = await set(
      reconcileBrowserUserActions$,
      RECONCILE_BATCH_SIZE,
      signal,
    );
    const expiredBrowserCleanup = await set(
      reconcileExpiredInactiveBrowsers$,
      RECONCILE_BATCH_SIZE,
      signal,
    );
    const expiredInstanceCleanup = await set(
      purgeExpiredStoppedBrowserInstances$,
      RECONCILE_BATCH_SIZE,
      signal,
    );
    const profileCleanup = await set(
      reconcileOrphanedBrowserProfiles$,
      RECONCILE_BATCH_SIZE,
      signal,
    );
    const orphanedScreenshotCleanup = await set(
      reconcileOrphanedBrowserScreenshots$,
      RECONCILE_BATCH_SIZE,
      signal,
    );

    return {
      checked:
        rows.length +
        releasedStarts +
        checkedUserActions +
        expiredBrowserCleanup.checked +
        expiredInstanceCleanup.checked +
        profileCleanup.checked +
        orphanedScreenshotCleanup.checked,
      stopped:
        stopped +
        expiredBrowserCleanup.cleaned +
        expiredInstanceCleanup.cleaned +
        profileCleanup.cleaned +
        orphanedScreenshotCleanup.cleaned,
      errors:
        errors +
        expiredBrowserCleanup.errors +
        profileCleanup.errors +
        orphanedScreenshotCleanup.errors,
      healthy,
    };
  },
);
