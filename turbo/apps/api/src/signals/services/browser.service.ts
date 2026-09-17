import { randomUUID } from "node:crypto";
import {
  BROWSER_IDLE_LEASE_MINUTES,
  BROWSER_INITIAL_SCREEN_HEIGHT,
  BROWSER_MAX_SCREEN_HEIGHT,
  BROWSER_MIN_SCREEN_HEIGHT,
  BROWSER_PROVIDER_TIMEOUT_MINUTES,
  BROWSER_SCREEN_WIDTH,
  type BrowserSession,
  type BrowserSuspensionReason,
} from "@okouai/api-contracts/contracts/browser";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import {
  browserSessionInstances,
  browserSessionResizeStates,
  browserSessionScreenshots,
  browserSessionTabSnapshots,
  browserSessions,
  browserThreadProfiles,
} from "@okouai/db/schema/browser-session";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { PUBLIC_BRAND_PRESENTATION } from "@okouai/core/public-brand";
import { command } from "ccstate";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  sql,
} from "drizzle-orm";
import { z } from "zod";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { waitUntil } from "../context/wait-until";
import { writeDb$, type Db } from "../external/db";
import {
  publishBrowserSessionChangedSafely,
  publishChatThreadMessageCreatedSafely,
} from "../external/realtime";
import { now, nowDate } from "../../lib/time";
import { flushAxiom, getDatasetName, ingestToAxiom } from "../external/axiom";
import {
  generateArtifactPreviewUrl,
  putImmutableS3Object,
} from "../external/s3";
import { settle, settleIncludingAbort } from "../utils";
import {
  BrowserUseProviderError,
  captureBrowserUseScreenshot,
  createBrowserUseProfile,
  createBrowserUseSession,
  deleteBrowserUseProfile,
  getBrowserUseSession,
  listBrowserUseTabUrls,
  resizeBrowserUseSession,
  restoreBrowserUseTabUrls,
  stopBrowserUseSession,
  stopBrowserUseSessionForCleanup,
  type BrowserUseSession,
} from "./browser-use.service";
import { allocateUploadedArtifact$ } from "./uploaded-artifact.service";
import {
  resolveArtifactFileReference,
  completePrivateArtifact$,
  privateArtifactRecord,
} from "./private-artifact-storage.service";
import { browserScreenshotSchemaAvailable } from "./browser-screenshot-schema.service";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";
import {
  activePaidConcurrencySlots,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities } from "./org-plan-entitlement-read.service";
import { insertChatEvent } from "./chat-event.service";
import type { Tx } from "../../lib/db-types";

const RECONCILE_BATCH_SIZE = 20;
const PROVIDER_CLEANUP_TIMEOUT_MS = 30_000;
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
const OWNED_BROWSER_STATUSES = [
  "creating",
  "active",
  "resuming",
  "stopping",
] as const;
const TERMINAL_RUN_STATUSES = [
  "completed",
  "failed",
  "timeout",
  "cancelled",
] as const;
const L = logger("Browser");
const browserTabSnapshotSchema = z.array(z.string().max(8192)).max(50);

const BROWSER_SESSION_SELECTION = {
  id: browserSessions.id,
  chatThreadId: browserSessions.chatThreadId,
  runId: browserSessions.runId,
  orgId: browserSessions.orgId,
  userId: browserSessions.userId,
  publicBrand: browserSessions.publicBrand,
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
type BrowserThreadProfileRow = typeof browserThreadProfiles.$inferSelect;
type DbTransaction = Tx;
type InactiveBrowserStatus = (typeof INACTIVE_BROWSER_STATUSES)[number];

export interface BrowserServiceError {
  readonly kind: "error";
  readonly status: 400 | 403 | 404 | 409 | 502 | 503;
  readonly code: string;
  readonly message: string;
}

interface BrowserServiceOk<T> {
  readonly kind: "ok";
  readonly value: T;
}

type BrowserServiceResult<T> = BrowserServiceOk<T> | BrowserServiceError;

interface BrowserConnection {
  readonly browser: BrowserSession;
  readonly cdpUrl: string;
  readonly lifecycleEventId: string | null;
}

interface BrowserMutation {
  readonly browser: BrowserSession;
  readonly lifecycleEventId: string | null;
}

interface BrowserCloseMutation {
  readonly lifecycleEventId: string;
}

interface BrowserScreen {
  readonly width: typeof BROWSER_SCREEN_WIDTH;
  readonly height: number;
  readonly resizable: true;
}

interface BrowserActor {
  readonly orgId: string;
  readonly userId: string;
  readonly publicBrand: PublicBrand;
  readonly runId?: string;
}

interface BrowserRunContext {
  readonly orgId: string;
  readonly userId: string;
  // Run associated with the provider instance. For run tokens this is the
  // calling run; for viewer requests it is the thread's most recent run.
  readonly runId: string;
  readonly chatThreadId: string;
  readonly publicBrand: PublicBrand;
  // Viewer requests may start a browser while no run is alive, so only run
  // tokens assert that their own run is still running.
  readonly requireLiveRun: boolean;
}

interface BrowserCreateInput {
  readonly name: string;
  readonly proxyCountryCode: string | null;
}

interface BrowserOwnerAccess {
  readonly orgId: string;
  readonly userId: string;
  readonly publicBrand: PublicBrand;
  readonly runId?: string;
}

interface BrowserSessionAccess extends BrowserOwnerAccess {
  readonly chatThreadId: string;
}

interface BrowserSidebarThread {
  readonly chatThreadId: string;
  readonly userId: string;
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

function notFound(): BrowserServiceError {
  return serviceError(404, "BROWSER_NOT_FOUND", "Managed browser not found");
}

function conflict(message: string, code = "BROWSER_CONFLICT") {
  return serviceError(409, code, message);
}

function chatRunRequired(
  code: "BROWSER_RUN_REQUIRED" | "BROWSER_CHAT_THREAD_REQUIRED",
) {
  return serviceError(
    400,
    code,
    `Managed browsers can only be started from an ${PUBLIC_BRAND_PRESENTATION.assistantName} chat run`,
  );
}

function browserReclaiming() {
  return conflict(
    `${PUBLIC_BRAND_PRESENTATION.assistantName} is still reclaiming this thread's previous managed browser; retry in a moment`,
    "BROWSER_STOPPING",
  );
}

function providerFailure(error: unknown): BrowserServiceError {
  if (error instanceof BrowserUseProviderError) {
    return serviceError(error.status, error.code, error.message);
  }
  if (error instanceof z.ZodError) {
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

function browserViewerUrl(chatThreadId: string): string {
  return `${env("APP_URL")}/browsers/${chatThreadId}`;
}

function publicBrowser(
  row: BrowserSessionRow,
  presentation: {
    readonly liveUrl: string | null;
    readonly screenshotUrl: string | null;
    readonly idleExpiresAt?: Date | null;
    readonly screen?: BrowserScreen | null;
  },
): BrowserSession {
  return {
    threadId: row.chatThreadId,
    name: row.name,
    status: row.status,
    viewerUrl: browserViewerUrl(row.chatThreadId),
    liveUrl: presentation.liveUrl,
    screenshotUrl: presentation.screenshotUrl,
    proxyCountryCode: row.proxyCountryCode,
    timeoutMinutes: row.timeoutMinutes,
    ...(presentation.screen ? { screen: presentation.screen } : {}),
    idleExpiresAt: presentation.idleExpiresAt?.toISOString() ?? null,
    suspendedAt: row.suspendedAt?.toISOString() ?? null,
    suspensionReason: row.suspensionReason,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function nextIdleDeadline(): Date {
  return new Date(nowDate().getTime() + IDLE_LEASE_MS);
}

function browserScreenHeightForAspectRatio(aspectRatio: number): number {
  return Math.min(
    Math.max(
      Math.round(BROWSER_SCREEN_WIDTH / aspectRatio),
      BROWSER_MIN_SCREEN_HEIGHT,
    ),
    BROWSER_MAX_SCREEN_HEIGHT,
  );
}

async function loadBrowserScreen(
  db: Db,
  providerSessionId: string,
  signal: AbortSignal,
): Promise<BrowserScreen | null> {
  const [screen] = await db
    .select({
      width: browserSessionResizeStates.screenWidth,
      height: browserSessionResizeStates.screenHeight,
    })
    .from(browserSessionResizeStates)
    .where(eq(browserSessionResizeStates.providerSessionId, providerSessionId))
    .limit(1);
  signal.throwIfAborted();
  return screen?.width === BROWSER_SCREEN_WIDTH
    ? {
        width: BROWSER_SCREEN_WIDTH,
        height: screen.height,
        resizable: true,
      }
    : null;
}

const loadBrowserScreenshotUrl$ = command(
  async (
    { get },
    db: Db,
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    if (!(await browserScreenshotSchemaAvailable(db))) {
      signal.throwIfAborted();
      return null;
    }
    const [screenshot] = await db
      .select({
        url: browserSessionScreenshots.url,
        objectKey: browserSessionScreenshots.objectKey,
        userId: browserSessions.userId,
        orgId: browserSessions.orgId,
      })
      .from(browserSessionScreenshots)
      .innerJoin(
        browserSessions,
        eq(
          browserSessions.chatThreadId,
          browserSessionScreenshots.chatThreadId,
        ),
      )
      .where(eq(browserSessionScreenshots.chatThreadId, chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (!screenshot) {
      return null;
    }
    const reference = await get(
      resolveArtifactFileReference(screenshot.url, signal),
    );
    signal.throwIfAborted();
    if (!reference) {
      return screenshot.url;
    }
    const file = await get(privateArtifactRecord(reference.id));
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
    const preview = await get(
      generateArtifactPreviewUrl(file.bucket, file.key, {
        signingDate: nowDate(),
      }),
    );
    signal.throwIfAborted();
    return preview.url;
  },
);

async function loadBrowserScreenHeightForThread(
  db: Db,
  chatThreadId: string,
  signal: AbortSignal,
): Promise<number> {
  // Stopped instances retain their applied screen rows, so the latest one
  // carries the thread's preferred height across provider replacements.
  const [screen] = await db
    .select({
      width: browserSessionResizeStates.screenWidth,
      height: browserSessionResizeStates.screenHeight,
    })
    .from(browserSessionResizeStates)
    .innerJoin(
      browserSessionInstances,
      eq(
        browserSessionInstances.providerSessionId,
        browserSessionResizeStates.providerSessionId,
      ),
    )
    .where(eq(browserSessionInstances.chatThreadId, chatThreadId))
    .orderBy(desc(browserSessionInstances.createdAt))
    .limit(1);
  signal.throwIfAborted();
  return screen?.width === BROWSER_SCREEN_WIDTH
    ? screen.height
    : BROWSER_INITIAL_SCREEN_HEIGHT;
}

// Extending the lease is unconditional and fixed-length: every toucher gets the
// same 10 minutes from now, so leases cannot be stacked into a longer lifetime.
async function touchInstanceLease(
  db: Db,
  providerSessionId: string,
  signal: AbortSignal,
): Promise<BrowserInstanceRow | null> {
  const [touched] = await db
    .update(browserSessionInstances)
    .set({
      lastTouchedAt: nowDate(),
      idleExpiresAt: nextIdleDeadline(),
      updatedAt: nowDate(),
    })
    .where(
      and(
        eq(browserSessionInstances.providerSessionId, providerSessionId),
        eq(browserSessionInstances.status, "active"),
      ),
    )
    .returning();
  signal.throwIfAborted();
  return touched ?? null;
}

async function persistBrowserScreen(
  db: Db,
  providerSessionId: string,
  screenHeight: number,
  signal: AbortSignal,
): Promise<
  BrowserServiceResult<{
    readonly instance: BrowserInstanceRow;
    readonly screen: BrowserScreen;
  }>
> {
  const [updatedScreen] = await db
    .update(browserSessionResizeStates)
    .set({
      screenWidth: BROWSER_SCREEN_WIDTH,
      screenHeight,
      updatedAt: nowDate(),
    })
    .where(eq(browserSessionResizeStates.providerSessionId, providerSessionId))
    .returning({ height: browserSessionResizeStates.screenHeight });
  signal.throwIfAborted();
  if (!updatedScreen) {
    return conflict(
      "This managed browser was started before window resizing was enabled; resume it before resizing it",
      "BROWSER_RESIZE_UNSUPPORTED",
    );
  }
  const instance = await touchInstanceLease(db, providerSessionId, signal);
  if (!instance) {
    return conflict(
      "This managed browser is no longer live; resume it before resizing it",
      "BROWSER_NOT_LIVE",
    );
  }
  return {
    kind: "ok",
    value: {
      instance,
      screen: {
        width: BROWSER_SCREEN_WIDTH,
        height: updatedScreen.height,
        resizable: true,
      },
    },
  };
}

async function createBrowserScreenState(
  tx: DbTransaction,
  providerSessionId: string,
  screenHeight: number,
): Promise<BrowserScreen> {
  const [resizeState] = await tx
    .insert(browserSessionResizeStates)
    .values({
      providerSessionId,
      screenWidth: BROWSER_SCREEN_WIDTH,
      screenHeight,
    })
    .returning({ height: browserSessionResizeStates.screenHeight });
  if (!resizeState) {
    throw new Error("Failed to persist managed browser resize state");
  }
  return {
    width: BROWSER_SCREEN_WIDTH,
    height: resizeState.height,
    resizable: true,
  };
}

interface ActiveBrowserInstance {
  readonly chatThreadId: string;
  readonly providerSessionId: string;
  readonly orgId: string;
  readonly userId: string;
}

async function saveBrowserTabSnapshot(
  db: Db,
  target: ActiveBrowserInstance,
  signal: AbortSignal,
): Promise<void> {
  const snapshotSignal = AbortSignal.any([
    signal,
    AbortSignal.timeout(BROWSER_TAB_SNAPSHOT_TIMEOUT_MS),
  ]);
  const saved = await settle(
    (async () => {
      const provider = await getBrowserUseSession(
        target.providerSessionId,
        snapshotSignal,
      );
      snapshotSignal.throwIfAborted();
      if (provider.status !== "active" || !provider.cdpUrl) {
        return;
      }
      const urls = await listBrowserUseTabUrls(provider.cdpUrl, snapshotSignal);
      snapshotSignal.throwIfAborted();
      const encryptedTabUrls = await encryptPersistentSecretValue(
        JSON.stringify(urls),
        { userId: target.userId },
      );
      snapshotSignal.throwIfAborted();
      await db
        .insert(browserSessionTabSnapshots)
        .values({
          chatThreadId: target.chatThreadId,
          encryptedTabUrls,
        })
        .onConflictDoUpdate({
          target: browserSessionTabSnapshots.chatThreadId,
          set: {
            encryptedTabUrls,
            updatedAt: nowDate(),
          },
        });
      snapshotSignal.throwIfAborted();
    })(),
  );
  signal.throwIfAborted();
  if (!saved.ok) {
    L.warn("Managed browser tab snapshot failed", {
      chatThreadId: target.chatThreadId,
    });
  }
}

async function restoreBrowserTabSnapshot(
  db: Db,
  browser: BrowserSessionRow,
  cdpUrl: string,
  signal: AbortSignal,
): Promise<void> {
  const restored = await settle(
    (async () => {
      const [snapshot] = await db
        .select({
          encryptedTabUrls: browserSessionTabSnapshots.encryptedTabUrls,
        })
        .from(browserSessionTabSnapshots)
        .where(
          eq(browserSessionTabSnapshots.chatThreadId, browser.chatThreadId),
        )
        .limit(1);
      signal.throwIfAborted();
      if (!snapshot) {
        return;
      }
      const urls = browserTabSnapshotSchema.parse(
        JSON.parse(
          await decryptPersistentSecretValue(snapshot.encryptedTabUrls, {
            userId: browser.userId,
          }),
        ) as unknown,
      );
      signal.throwIfAborted();
      await restoreBrowserUseTabUrls(cdpUrl, urls, signal);
    })(),
  );
  signal.throwIfAborted();
  if (!restored.ok) {
    L.warn("Managed browser tab restoration failed", {
      chatThreadId: browser.chatThreadId,
    });
  }
}

function stopProviderSessionLater(providerSessionId: string): void {
  waitUntil(
    (async () => {
      const result = await settleIncludingAbort(
        stopBrowserUseSession(
          providerSessionId,
          AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
        ),
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

async function stopActiveBrowserInstance(
  db: Db,
  target: ActiveBrowserInstance,
  reason: BrowserSuspensionReason,
  signal: AbortSignal,
  options: {
    readonly emitCloseEvent?: boolean;
    readonly stopProvider: boolean;
    readonly saveTabSnapshot?: boolean;
  } = { stopProvider: true },
): Promise<boolean> {
  if (options.saveTabSnapshot ?? options.stopProvider) {
    await saveBrowserTabSnapshot(db, target, signal);
  }
  const stopped = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, target.chatThreadId);
    const [instance] = await tx
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
      });
    if (!instance) {
      return false;
    }
    await tx
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: nowDate(),
        suspensionReason: reason,
        updatedAt: nowDate(),
      })
      .where(eq(browserSessions.chatThreadId, target.chatThreadId));
    if (options.emitCloseEvent === false) {
      return { eventSeqId: null };
    }
    const event = await insertChatEvent(
      tx,
      {
        id: randomUUID(),
        chatThreadId: target.chatThreadId,
        eventType: "browser.close",
        content: null,
      },
      "id",
    );
    if (!event) {
      throw new Error("Failed to persist managed browser close event");
    }
    return { eventSeqId: event.seqId };
  });
  if (stopped && options.stopProvider) {
    stopProviderSessionLater(target.providerSessionId);
  }
  signal.throwIfAborted();
  if (!stopped) {
    return false;
  }
  await publishBrowserSessionChangedSafely(target.userId, {
    threadId: target.chatThreadId,
  });
  if (stopped.eventSeqId !== null) {
    await publishChatThreadMessageCreatedSafely({
      userId: target.userId,
      orgId: target.orgId,
      threadId: target.chatThreadId,
      syncThroughSeqId: stopped.eventSeqId,
    });
  }
  signal.throwIfAborted();
  return true;
}

async function suspendBrowserWithoutActiveInstance(
  db: Db,
  browser: BrowserSessionRow,
  reason: BrowserSuspensionReason,
  signal: AbortSignal,
): Promise<BrowserSessionRow | null> {
  const suspended = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, browser.chatThreadId);
    const [next] = await tx
      .update(browserSessions)
      .set({
        status: "suspended",
        suspendedAt: nowDate(),
        suspensionReason: reason,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, browser.chatThreadId),
          eq(browserSessions.status, "active"),
        ),
      )
      .returning(BROWSER_SESSION_SELECTION);
    return next ?? null;
  });
  signal.throwIfAborted();
  if (!suspended) {
    return null;
  }
  await publishBrowserSessionChangedSafely(browser.userId, {
    threadId: browser.chatThreadId,
  });
  signal.throwIfAborted();
  return suspended;
}

async function browserConcurrencyLimit(db: Db, orgId: string): Promise<number> {
  const [capabilities, paidSlots] = await Promise.all([
    loadOrgPlanCapabilities(db, orgId),
    activePaidConcurrencySlots(db, orgId),
  ]);
  if (!capabilities) {
    return 0;
  }
  return totalConcurrencyLimit({
    baseLimit: cappedBaseConcurrencyLimit(capabilities.baseConcurrencyLimit),
    paidSlots,
  });
}

async function ensureBrowserCapacity(
  db: Db,
  orgId: string,
  signal: AbortSignal,
): Promise<BrowserServiceError | null> {
  const limit = await browserConcurrencyLimit(db, orgId);
  signal.throwIfAborted();
  if (limit === 0) {
    return conflict(
      "This organization has no managed browser concurrency available",
      "BROWSER_CONCURRENCY_LIMIT",
    );
  }
  if (!Number.isFinite(limit)) {
    return null;
  }
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
        eq(browserSessions.orgId, orgId),
        eq(browserSessionInstances.status, "active"),
      ),
    )
    .orderBy(
      asc(browserSessionInstances.idleExpiresAt),
      asc(browserSessionInstances.startedAt),
    );
  signal.throwIfAborted();
  const reclaimCount = active.length - limit + 1;
  for (const target of active.slice(0, Math.max(reclaimCount, 0))) {
    await stopActiveBrowserInstance(db, target, "reconcile", signal);
  }
  return null;
}

async function lockBrowserThread(
  tx: DbTransaction,
  chatThreadId: string,
): Promise<void> {
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock(hashtext('zero_browser:' || ${chatThreadId}))`,
  );
}

type BrowserScreenshotStage = "prepare" | "capture" | "upload" | "save";

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

const captureAndStoreBrowserScreenshot$ = command(
  async ({ get, set }, browser: BrowserSessionRow): Promise<void> => {
    const startedAt = now();
    const signal = AbortSignal.timeout(BROWSER_SCREENSHOT_CAPTURE_TIMEOUT_MS);
    let stage: BrowserScreenshotStage = "prepare";
    // This task owns its timeout. Include aborts in the final outcome instead
    // of losing timed-out attempts through tapError's cancellation path.
    const [result] = await Promise.allSettled([
      (async () => {
        const db = set(writeDb$);
        if (!(await browserScreenshotSchemaAvailable(db))) {
          signal.throwIfAborted();
          return;
        }
        const instance = await loadActiveInstance(db, browser.chatThreadId);
        signal.throwIfAborted();
        if (!instance) {
          return;
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
        const image = await captureBrowserUseScreenshot(
          provider.cdpUrl,
          signal,
        );
        signal.throwIfAborted();
        stage = "upload";
        const artifact = await set(
          allocateUploadedArtifact$,
          {
            userId: browser.userId,
            orgId: browser.orgId,
            filename: BROWSER_SCREENSHOT_FILENAME,
            contentType: BROWSER_SCREENSHOT_CONTENT_TYPE,
            size: image.byteLength,
            publicBrand: browser.publicBrand,
          },
          signal,
        );
        const bucket = artifact.bucket;
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
        if ("storage" in artifact.storageMetadata) {
          await set(
            completePrivateArtifact$,
            {
              id: artifact.id,
              url: null,
              contentType: BROWSER_SCREENSHOT_CONTENT_TYPE,
              size: image.byteLength,
            },
            signal,
          );
        }
        await db.transaction(async (tx) => {
          await lockBrowserThread(tx, browser.chatThreadId);
          await tx
            .insert(browserSessionScreenshots)
            .values({
              chatThreadId: browser.chatThreadId,
              objectKey: artifact.key,
              url: artifact.url,
            })
            .onConflictDoUpdate({
              target: browserSessionScreenshots.chatThreadId,
              set: {
                objectKey: artifact.key,
                url: artifact.url,
                updatedAt: nowDate(),
              },
            });
        });

        // Persistence is the success boundary; a deadline after commit must
        // not turn an available preview into a failed capture metric.
        await publishBrowserSessionChangedSafely(browser.userId, {
          threadId: browser.chatThreadId,
        });
        return true;
      })(),
    ]);
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

async function lockBrowserProfileCreation(
  tx: DbTransaction,
  chatThreadId: string,
): Promise<void> {
  const lockKey = `zero_browser_profile:${chatThreadId}`;
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);
}

async function latestThreadRunId(
  db: Pick<Db, "select">,
  chatThreadId: string,
): Promise<string | null> {
  const [run] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.chatThreadId, chatThreadId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .orderBy(desc(agentRuns.createdAt))
    .limit(1);
  return run?.id ?? null;
}

async function resolveRunContext(
  db: Db,
  actor: BrowserActor,
): Promise<BrowserServiceResult<BrowserRunContext>> {
  if (!actor.runId) {
    return chatRunRequired("BROWSER_RUN_REQUIRED");
  }
  const [run] = await db
    .select({
      chatThreadId: agentRuns.chatThreadId,
      status: agentRuns.status,
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, actor.runId),
        eq(agentRuns.orgId, actor.orgId),
        eq(agentRuns.userId, actor.userId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);
  if (!run?.chatThreadId) {
    return chatRunRequired("BROWSER_CHAT_THREAD_REQUIRED");
  }
  if (isTerminalRunStatus(run.status)) {
    return conflict("The chat run already ended", "BROWSER_RUN_ENDED");
  }
  if (!run.cloudBrowserEnabled) {
    return serviceError(
      403,
      "BROWSER_AUTHORIZATION_REQUIRED",
      "Cloud browser is not enabled for this chat thread",
    );
  }
  return {
    kind: "ok",
    value: {
      orgId: actor.orgId,
      userId: actor.userId,
      runId: actor.runId,
      chatThreadId: run.chatThreadId,
      publicBrand: actor.publicBrand,
      requireLiveRun: true,
    },
  };
}

async function resolveViewerStartContext(
  db: Db,
  access: BrowserSessionAccess,
): Promise<BrowserServiceResult<BrowserRunContext>> {
  if (access.runId) {
    const context = await resolveRunContext(db, access);
    if (context.kind === "error") {
      return context;
    }
    return context.value.chatThreadId === access.chatThreadId
      ? context
      : notFound();
  }
  const [thread] = await db
    .select({
      id: chatThreads.id,
      browserRunId: browserSessions.runId,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .leftJoin(browserSessions, eq(browserSessions.chatThreadId, chatThreads.id))
    .where(
      and(
        eq(chatThreads.id, access.chatThreadId),
        eq(chatThreads.userId, access.userId),
        eq(agents.orgId, access.orgId),
      ),
    )
    .limit(1);
  if (!thread) {
    return notFound();
  }
  const latestRunId =
    (await latestThreadRunId(db, access.chatThreadId)) ?? thread.browserRunId;
  if (!latestRunId) {
    return conflict(
      "This browser's chat thread has no run; send a message first",
      "BROWSER_RUN_REQUIRED",
    );
  }
  return {
    kind: "ok",
    value: {
      orgId: access.orgId,
      userId: access.userId,
      runId: latestRunId,
      chatThreadId: access.chatThreadId,
      publicBrand: access.publicBrand,
      requireLiveRun: false,
    },
  };
}

async function browserSessionAccessError(
  db: Db,
  browser: Pick<BrowserSessionRow, "chatThreadId">,
  access: BrowserOwnerAccess,
): Promise<BrowserServiceError | null> {
  // Session callers are authorized by ownership. Run-scoped callers must also
  // belong to this thread and retain its agent browser authorization.
  if (!access.runId) {
    return null;
  }
  const [run] = await db
    .select({
      chatThreadId: agentRuns.chatThreadId,
      cloudBrowserEnabled: chatThreads.cloudBrowserEnabled,
    })
    .from(agentRuns)
    .innerJoin(chatThreads, eq(chatThreads.id, agentRuns.chatThreadId))
    .where(
      and(
        eq(agentRuns.id, access.runId),
        eq(agentRuns.orgId, access.orgId),
        eq(agentRuns.userId, access.userId),
        isNotNull(agentRuns.triggerSource),
      ),
    )
    .limit(1);
  if (!run?.chatThreadId || run.chatThreadId !== browser.chatThreadId) {
    return notFound();
  }
  if (!run.cloudBrowserEnabled) {
    return serviceError(
      403,
      "BROWSER_AUTHORIZATION_REQUIRED",
      "Cloud browser is not enabled for this chat thread",
    );
  }
  return null;
}

async function loadOwnedBrowserSidebarThread(
  db: Db,
  access: BrowserSessionAccess,
): Promise<BrowserSidebarThread | null> {
  const [thread] = await db
    .select({
      chatThreadId: chatThreads.id,
      userId: chatThreads.userId,
    })
    .from(chatThreads)
    .innerJoin(agents, eq(agents.id, chatThreads.agentId))
    .where(
      and(
        eq(chatThreads.id, access.chatThreadId),
        eq(chatThreads.userId, access.userId),
        eq(agents.orgId, access.orgId),
      ),
    )
    .limit(1);
  return thread ?? null;
}

async function loadOwnedBrowser(
  db: Db,
  access: BrowserSessionAccess,
): Promise<BrowserSessionRow | null> {
  const [row] = await db
    .select({ browser: BROWSER_SESSION_SELECTION })
    .from(browserSessions)
    .innerJoin(chatThreads, eq(chatThreads.id, browserSessions.chatThreadId))
    .where(
      and(
        eq(browserSessions.chatThreadId, access.chatThreadId),
        eq(browserSessions.orgId, access.orgId),
        eq(browserSessions.userId, access.userId),
        eq(chatThreads.userId, access.userId),
      ),
    )
    .limit(1);
  return row?.browser ?? null;
}

async function loadCurrentBrowser(
  db: Db,
  context: Pick<BrowserRunContext, "orgId" | "userId" | "chatThreadId">,
): Promise<BrowserSessionRow | null> {
  const [row] = await db
    .select(BROWSER_SESSION_SELECTION)
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.chatThreadId, context.chatThreadId),
        eq(browserSessions.orgId, context.orgId),
        eq(browserSessions.userId, context.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadOwnedThreadBrowser(
  db: Db,
  chatThreadId: string,
): Promise<BrowserSessionRow | null> {
  const [row] = await db
    .select(BROWSER_SESSION_SELECTION)
    .from(browserSessions)
    .where(
      and(
        eq(browserSessions.chatThreadId, chatThreadId),
        inArray(browserSessions.status, [...OWNED_BROWSER_STATUSES]),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadActiveInstance(
  db: Db,
  chatThreadId: string,
): Promise<BrowserInstanceRow | null> {
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
}

async function loadOwnedThreadBrowserProfile(
  db: Db,
  owner: Pick<BrowserRunContext, "orgId" | "userId" | "chatThreadId">,
): Promise<BrowserThreadProfileRow | null> {
  const [row] = await db
    .select()
    .from(browserThreadProfiles)
    .where(
      and(
        eq(browserThreadProfiles.chatThreadId, owner.chatThreadId),
        eq(browserThreadProfiles.orgId, owner.orgId),
        eq(browserThreadProfiles.userId, owner.userId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function loadBrowserProfileForBrowser(
  db: Db,
  browser: BrowserSessionRow,
): Promise<BrowserThreadProfileRow> {
  const [row] = await db
    .select()
    .from(browserThreadProfiles)
    .where(
      and(
        eq(browserThreadProfiles.chatThreadId, browser.chatThreadId),
        eq(browserThreadProfiles.orgId, browser.orgId),
        eq(browserThreadProfiles.userId, browser.userId),
      ),
    )
    .limit(1);
  if (!row) {
    throw new Error("Managed browser thread profile ownership is invalid");
  }
  return row;
}

async function deleteUnusedProfile(profileId: string): Promise<void> {
  await settle(
    deleteBrowserUseProfile(
      profileId,
      AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
    ),
  );
}

interface BrowserProfileCleanupTarget {
  readonly chatThreadId: string;
  readonly providerProfileId: string;
}

async function latestBrowserProviderSessionId(
  db: Db,
  chatThreadId: string,
): Promise<string | null> {
  const [instance] = await db
    .select({
      providerSessionId: browserSessionInstances.providerSessionId,
    })
    .from(browserSessionInstances)
    .where(eq(browserSessionInstances.chatThreadId, chatThreadId))
    .orderBy(desc(browserSessionInstances.createdAt))
    .limit(1);
  return instance?.providerSessionId ?? null;
}

async function retireBrowserProfileOwnership(
  db: Db,
  target: BrowserProfileCleanupTarget,
  signal: AbortSignal,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockBrowserProfileCreation(tx, target.chatThreadId);
    const [profile] = await tx
      .select({
        providerProfileId: browserThreadProfiles.providerProfileId,
      })
      .from(browserThreadProfiles)
      .where(eq(browserThreadProfiles.chatThreadId, target.chatThreadId))
      .limit(1);
    if (profile?.providerProfileId !== target.providerProfileId) {
      return;
    }
    await tx
      .delete(browserSessions)
      .where(eq(browserSessions.chatThreadId, target.chatThreadId));
    await tx
      .delete(browserThreadProfiles)
      .where(
        and(
          eq(browserThreadProfiles.chatThreadId, target.chatThreadId),
          eq(browserThreadProfiles.providerProfileId, target.providerProfileId),
        ),
      );
  });
  signal.throwIfAborted();
}

async function cleanupBrowserProfile(
  db: Db,
  target: BrowserProfileCleanupTarget,
  signal: AbortSignal,
  providerSessionIds?: readonly string[],
): Promise<void> {
  const retryProviderSessionId =
    providerSessionIds === undefined
      ? await latestBrowserProviderSessionId(db, target.chatThreadId)
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
  await retireBrowserProfileOwnership(db, target, signal);
}

function cleanupBrowserProfileLater(
  db: Db,
  target: BrowserProfileCleanupTarget,
  providerSessionIds: readonly string[],
): void {
  const backgroundSignal = new AbortController().signal;
  waitUntil(
    (async () => {
      const result = await settleIncludingAbort(
        cleanupBrowserProfile(db, target, backgroundSignal, providerSessionIds),
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
}

async function claimBrowserProfile(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly providerProfileId: string;
  },
): Promise<{
  readonly profile: BrowserThreadProfileRow;
  readonly created: boolean;
}> {
  const [created] = await db
    .insert(browserThreadProfiles)
    .values(args)
    .onConflictDoNothing({
      target: browserThreadProfiles.chatThreadId,
    })
    .returning();
  if (created) {
    return { profile: created, created: true };
  }
  const existing = await loadOwnedThreadBrowserProfile(db, args);
  if (!existing) {
    throw new Error("Managed browser profile claim did not resolve an owner");
  }
  return { profile: existing, created: false };
}

async function getOrCreateBrowserProfile(
  db: Db,
  context: BrowserRunContext,
): Promise<BrowserServiceResult<BrowserThreadProfileRow>> {
  const existing = await loadOwnedThreadBrowserProfile(db, context);
  if (existing) {
    return { kind: "ok", value: existing };
  }

  let createdProviderProfileId: string | null = null;
  let retainedCreatedProfile = false;
  const transaction = await settle(
    db.transaction(async (tx) => {
      await lockBrowserProfileCreation(tx, context.chatThreadId);
      const lockedExisting = await loadOwnedThreadBrowserProfile(tx, context);
      if (lockedExisting) {
        return { kind: "ok" as const, value: lockedExisting };
      }

      const provider = await providerCall(
        createBrowserUseProfile(
          context.chatThreadId,
          AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
        ),
      );
      if (provider.kind === "error") {
        return provider;
      }
      createdProviderProfileId = provider.value;

      const claimed = await claimBrowserProfile(tx, {
        orgId: context.orgId,
        userId: context.userId,
        chatThreadId: context.chatThreadId,
        providerProfileId: provider.value,
      });
      retainedCreatedProfile = claimed.created;
      return { kind: "ok" as const, value: claimed.profile };
    }),
  );
  if (
    createdProviderProfileId &&
    (!transaction.ok || !retainedCreatedProfile)
  ) {
    await deleteUnusedProfile(createdProviderProfileId);
  }
  if (!transaction.ok) {
    throw transaction.error;
  }
  return transaction.value;
}

async function persistStartedProviderInstance(
  tx: DbTransaction,
  args: {
    readonly current: BrowserSessionRow;
    readonly provider: BrowserUseSession;
    readonly runId: string;
    readonly cleanupAfterStart: boolean;
    readonly screenHeight: number;
  },
) {
  const status = args.cleanupAfterStart ? "stopped" : "active";
  const stopRequestedAt = args.cleanupAfterStart ? nowDate() : null;
  const finishedAt = args.cleanupAfterStart ? nowDate() : null;
  const [instance] = await tx
    .insert(browserSessionInstances)
    .values({
      providerSessionId: args.provider.id,
      chatThreadId: args.current.chatThreadId,
      runId: args.runId,
      status,
      timeoutAt: new Date(args.provider.timeoutAt),
      startedAt: new Date(args.provider.startedAt),
      lastTouchedAt: nowDate(),
      idleExpiresAt: nextIdleDeadline(),
      stopRequestedAt,
      finishedAt,
    })
    .returning();
  if (!instance) {
    throw new Error("Failed to persist managed browser provider instance");
  }
  const screen = !args.cleanupAfterStart
    ? await createBrowserScreenState(
        tx,
        instance.providerSessionId,
        args.screenHeight,
      )
    : null;
  return { instance, screen };
}

async function claimStartedProviderInstance(
  db: Db,
  args: {
    readonly browser: BrowserSessionRow;
    readonly context: BrowserRunContext;
    readonly provider: BrowserUseSession;
    readonly screenHeight: number;
  },
) {
  const claimed = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, args.context.chatThreadId);
    const [current] = await tx
      .select(BROWSER_SESSION_SELECTION)
      .from(browserSessions)
      .where(eq(browserSessions.chatThreadId, args.browser.chatThreadId))
      .limit(1);
    if (!current || current.runId !== args.context.runId) {
      return { kind: "rejected" as const };
    }
    const cleanupAfterStart = current.status === "stopping";
    if (
      !cleanupAfterStart &&
      !["creating", "resuming"].includes(current.status)
    ) {
      return { kind: "rejected" as const };
    }
    const { instance, screen } = await persistStartedProviderInstance(tx, {
      current,
      provider: args.provider,
      runId: args.context.runId,
      cleanupAfterStart,
      screenHeight: args.screenHeight,
    });
    if (cleanupAfterStart) {
      const [browser] = await tx
        .update(browserSessions)
        .set({
          status: "suspended",
          suspendedAt: nowDate(),
          suspensionReason: current.suspensionReason ?? "reconcile",
          updatedAt: nowDate(),
        })
        .where(eq(browserSessions.chatThreadId, current.chatThreadId))
        .returning(BROWSER_SESSION_SELECTION);
      if (!browser) {
        throw new Error("Failed to suspend managed browser");
      }
      return {
        kind: "cleanup" as const,
        browser,
        instance,
      };
    }
    const [browser] = await tx
      .update(browserSessions)
      .set({
        status: "active",
        suspendedAt: null,
        suspensionReason: null,
        updatedAt: nowDate(),
      })
      .where(eq(browserSessions.chatThreadId, current.chatThreadId))
      .returning(BROWSER_SESSION_SELECTION);
    if (!browser) {
      throw new Error("Failed to activate managed browser");
    }
    return {
      kind: "active" as const,
      browser,
      instance,
      screen,
    };
  });
  if (claimed.kind === "cleanup" || claimed.kind === "active") {
    await publishBrowserSessionChangedSafely(args.browser.userId, {
      threadId: args.browser.chatThreadId,
    });
  }
  return claimed;
}

async function createAndClaimProviderInstance(
  db: Db,
  args: {
    readonly browser: BrowserSessionRow;
    readonly profile: Pick<BrowserThreadProfileRow, "providerProfileId">;
    readonly context: BrowserRunContext;
    readonly screenHeight: number;
  },
) {
  const provider = await providerCall(
    createBrowserUseSession(
      {
        profileId: args.profile.providerProfileId,
        proxyCountryCode: args.browser.proxyCountryCode,
        // Okou owns reclamation through the idle lease, so the provider only
        // needs to enforce the absolute upper bound.
        timeoutMinutes: BROWSER_PROVIDER_TIMEOUT_MINUTES,
      },
      AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
    ),
  );
  if (provider.kind === "error") {
    return provider;
  }
  const { cdpUrl, liveUrl } = provider.value;
  if (provider.value.status !== "active" || !cdpUrl || !liveUrl) {
    stopProviderSessionLater(provider.value.id);
    return serviceError(
      502,
      "BROWSER_USE_INVALID_RESPONSE",
      "Managed browser provider did not return an active connection",
    );
  }

  const resized = await providerCall(
    resizeBrowserUseSession(
      cdpUrl,
      BROWSER_SCREEN_WIDTH,
      args.screenHeight,
      AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
    ),
  );
  if (resized.kind === "error") {
    stopProviderSessionLater(provider.value.id);
    return resized;
  }

  const claimResult = await settleIncludingAbort(
    claimStartedProviderInstance(db, {
      browser: args.browser,
      context: args.context,
      provider: provider.value,
      screenHeight: args.screenHeight,
    }),
  );
  if (!claimResult.ok) {
    // Provider creation is irreversible. Any failed claim must reclaim the
    // provider because the transaction rolls back every durable owner row.
    stopProviderSessionLater(provider.value.id);
    throw claimResult.error;
  }
  const claimed = claimResult.value;
  return {
    kind: "claimed" as const,
    provider: provider.value,
    cdpUrl,
    liveUrl,
    claimed,
  };
}

const startProviderInstance$ = command(
  async (
    { set },
    args: {
      readonly browser: BrowserSessionRow;
      readonly context: BrowserRunContext;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const capacityError = await ensureBrowserCapacity(
      db,
      args.context.orgId,
      signal,
    );
    signal.throwIfAborted();
    if (capacityError) {
      return capacityError;
    }
    const profile = await loadBrowserProfileForBrowser(db, args.browser);
    signal.throwIfAborted();
    const screenHeight = await loadBrowserScreenHeightForThread(
      db,
      args.context.chatThreadId,
      signal,
    );

    const started = await createAndClaimProviderInstance(db, {
      browser: args.browser,
      profile,
      context: args.context,
      screenHeight,
    });
    signal.throwIfAborted();
    if (started.kind === "error") {
      return started;
    }
    const { claimed } = started;

    if (claimed.kind === "cleanup") {
      stopProviderSessionLater(claimed.instance.providerSessionId);
      signal.throwIfAborted();
      return conflict(
        "The chat run ended while the managed browser was starting",
        "BROWSER_RUN_ENDED",
      );
    }

    if (claimed.kind === "rejected") {
      stopProviderSessionLater(started.provider.id);
      signal.throwIfAborted();
      return conflict(
        "The chat run ended while the managed browser was starting",
        "BROWSER_RUN_ENDED",
      );
    }

    await restoreBrowserTabSnapshot(
      db,
      claimed.browser,
      started.cdpUrl,
      signal,
    );
    const screenshotUrl = await set(
      loadBrowserScreenshotUrl$,
      db,
      claimed.browser.chatThreadId,
      signal,
    );

    return {
      kind: "ok",
      value: {
        browser: publicBrowser(claimed.browser, {
          liveUrl: started.liveUrl,
          screenshotUrl,
          idleExpiresAt: claimed.instance.idleExpiresAt,
          screen: claimed.screen,
        }),
        cdpUrl: started.cdpUrl,
        lifecycleEventId: null,
      },
    };
  },
);

async function claimFreshBrowser(
  db: Db,
  context: BrowserRunContext,
  args: BrowserCreateInput,
  signal: AbortSignal,
): Promise<BrowserServiceResult<BrowserSessionRow>> {
  return await db.transaction(async (tx) => {
    await lockBrowserThread(tx, context.chatThreadId);
    signal.throwIfAborted();
    const [owned, run] = await Promise.all([
      tx
        .select({ chatThreadId: browserSessions.chatThreadId })
        .from(browserSessions)
        .where(
          and(
            eq(browserSessions.chatThreadId, context.chatThreadId),
            inArray(browserSessions.status, [...OWNED_BROWSER_STATUSES]),
          ),
        )
        .limit(1),
      tx
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, context.runId))
        .limit(1),
    ]);
    if (
      context.requireLiveRun &&
      (!run[0] || isTerminalRunStatus(run[0].status))
    ) {
      return conflict("The chat run already ended", "BROWSER_RUN_ENDED");
    }
    if (owned[0]) {
      return conflict(
        "This chat thread already has an active managed browser",
        "BROWSER_THREAD_ACTIVE",
      );
    }
    const [browser] = await tx
      .insert(browserSessions)
      .values({
        chatThreadId: context.chatThreadId,
        runId: context.runId,
        orgId: context.orgId,
        userId: context.userId,
        publicBrand: context.publicBrand,
        name: args.name,
        status: "creating",
        proxyCountryCode: args.proxyCountryCode,
        timeoutMinutes: BROWSER_PROVIDER_TIMEOUT_MINUTES,
      })
      .returning(BROWSER_SESSION_SELECTION);
    if (!browser) {
      throw new Error("Failed to create managed browser");
    }
    return {
      kind: "ok",
      value: browser,
    };
  });
}

const createBrowserForContext$ = command(
  async (
    { set },
    args: {
      readonly context: BrowserRunContext;
      readonly input: BrowserCreateInput;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const profile = await getOrCreateBrowserProfile(db, args.context);
    signal.throwIfAborted();
    if (profile.kind === "error") {
      return profile;
    }
    const claimed = await claimFreshBrowser(
      db,
      args.context,
      args.input,
      signal,
    );
    signal.throwIfAborted();
    if (claimed.kind === "error") {
      return claimed;
    }
    const connection = await set(
      startProviderInstance$,
      {
        browser: claimed.value,
        context: args.context,
      },
      AbortSignal.timeout(PROVIDER_START_LIFECYCLE_TIMEOUT_MS),
    );
    signal.throwIfAborted();
    if (connection.kind === "error") {
      await db
        .update(browserSessions)
        .set({ status: "error", updatedAt: nowDate() })
        .where(
          and(
            eq(browserSessions.chatThreadId, claimed.value.chatThreadId),
            inArray(browserSessions.status, ["creating", "resuming"]),
          ),
        );
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    return connection;
  },
);

export const createBrowser$ = command(
  async (
    { set },
    args: {
      readonly actor: BrowserActor;
      readonly input: BrowserCreateInput;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const context = await resolveRunContext(db, args.actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    return await set(
      openBrowserForContext$,
      {
        context: context.value,
        input: args.input,
      },
      signal,
    );
  },
);

interface InspectActiveConnectionResume {
  readonly kind: "resume";
  readonly browser: BrowserSessionRow;
}

const inspectActiveConnection$ = command(
  async (
    { set },
    args: {
      readonly browser: BrowserSessionRow;
      readonly context: BrowserRunContext;
    },
    signal: AbortSignal,
  ): Promise<
    BrowserServiceResult<BrowserConnection> | InspectActiveConnectionResume
  > => {
    const { browser } = args;
    const db = set(writeDb$);
    const instance = await loadActiveInstance(db, browser.chatThreadId);
    signal.throwIfAborted();
    if (!instance) {
      const suspended = await suspendBrowserWithoutActiveInstance(
        db,
        browser,
        "provider",
        signal,
      );
      if (!suspended) {
        throw new Error("Failed to suspend managed browser");
      }
      return {
        kind: "resume",
        browser: suspended,
      };
    }
    const provider = await providerCall(
      getBrowserUseSession(instance.providerSessionId, signal),
    );
    signal.throwIfAborted();
    if (provider.kind === "error") {
      return provider;
    }
    const { cdpUrl, liveUrl } = provider.value;
    if (provider.value.status === "active" && cdpUrl && liveUrl) {
      // A later run in the same thread takes the live instance over instead of
      // waiting for it to be reclaimed, and its lease restarts from now.
      const [owner] = await db
        .update(browserSessions)
        .set({ runId: args.context.runId, updatedAt: nowDate() })
        .where(
          and(
            eq(browserSessions.chatThreadId, browser.chatThreadId),
            eq(browserSessions.status, "active"),
          ),
        )
        .returning(BROWSER_SESSION_SELECTION);
      signal.throwIfAborted();
      const leased = await touchInstanceLease(
        db,
        instance.providerSessionId,
        signal,
      );
      const screen = await loadBrowserScreen(
        db,
        instance.providerSessionId,
        signal,
      );
      const screenshotUrl = await set(
        loadBrowserScreenshotUrl$,
        db,
        browser.chatThreadId,
        signal,
      );
      return {
        kind: "ok",
        value: {
          browser: publicBrowser(owner ?? browser, {
            liveUrl,
            screenshotUrl,
            idleExpiresAt: leased?.idleExpiresAt ?? instance.idleExpiresAt,
            screen,
          }),
          cdpUrl,
          lifecycleEventId: null,
        },
      };
    }
    await stopActiveBrowserInstance(
      db,
      {
        chatThreadId: browser.chatThreadId,
        providerSessionId: instance.providerSessionId,
        orgId: browser.orgId,
        userId: browser.userId,
      },
      "provider",
      signal,
      { stopProvider: false },
    );
    signal.throwIfAborted();
    const [suspended] = await db
      .select(BROWSER_SESSION_SELECTION)
      .from(browserSessions)
      .where(eq(browserSessions.chatThreadId, browser.chatThreadId))
      .limit(1);
    signal.throwIfAborted();
    if (!suspended) {
      throw new Error("Managed browser disappeared during mutation");
    }
    return {
      kind: "resume",
      browser: suspended,
    };
  },
);

type ResumeClaim =
  | { readonly kind: "active"; readonly browser: BrowserSessionRow }
  | { readonly kind: "claimed"; readonly browser: BrowserSessionRow }
  | { readonly kind: "missing" }
  | BrowserServiceError;

async function claimBrowserForResume(
  db: Db,
  context: BrowserRunContext,
  signal: AbortSignal,
): Promise<ResumeClaim> {
  return await db.transaction(async (tx) => {
    await lockBrowserThread(tx, context.chatThreadId);
    signal.throwIfAborted();
    const [run] = await tx
      .select({ status: agentRuns.status })
      .from(agentRuns)
      .where(eq(agentRuns.id, context.runId))
      .limit(1);
    if (context.requireLiveRun && (!run || isTerminalRunStatus(run.status))) {
      return conflict("The chat run already ended", "BROWSER_RUN_ENDED");
    }
    const owned = await loadOwnedThreadBrowser(tx, context.chatThreadId);
    if (owned) {
      // A live instance is shared across the thread's runs, so ownership no
      // longer decides who may attach to it.
      if (owned.status === "active") {
        return { kind: "active", browser: owned };
      }
      if (["creating", "resuming"].includes(owned.status)) {
        return conflict(
          "The managed browser is already starting",
          "BROWSER_STARTING",
        );
      }
      return browserReclaiming();
    }
    const current = await loadCurrentBrowser(tx, context);
    if (!current) {
      return { kind: "missing" };
    }
    const [claimed] = await tx
      .update(browserSessions)
      .set({
        runId: context.runId,
        status: "resuming",
        suspendedAt: null,
        suspensionReason: null,
        updatedAt: nowDate(),
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, current.chatThreadId),
          inArray(browserSessions.status, ["suspended", "error"]),
        ),
      )
      .returning(BROWSER_SESSION_SELECTION);
    return claimed
      ? { kind: "claimed", browser: claimed }
      : conflict("The managed browser is busy", "BROWSER_BUSY");
  });
}

type ReuseLiveBrowser =
  | { readonly kind: "resume"; readonly browser: BrowserSessionRow }
  | {
      readonly kind: "connection";
      readonly result: BrowserServiceResult<BrowserConnection>;
    };

// Attach to the thread's live provider instance when it still has one, taking it
// over from whichever run opened it. Returns "resume" when the instance is gone
// and the logical browser has to be restarted instead.
const reuseLiveThreadBrowser$ = command(
  async (
    { set },
    args: {
      readonly context: BrowserRunContext;
      readonly current: BrowserSessionRow;
    },
    signal: AbortSignal,
  ): Promise<ReuseLiveBrowser> => {
    const db = set(writeDb$);
    const owned = await loadOwnedThreadBrowser(db, args.context.chatThreadId);
    signal.throwIfAborted();
    if (!owned) {
      return { kind: "resume", browser: args.current };
    }
    if (owned.status !== "active") {
      return {
        kind: "connection",
        result: ["creating", "resuming"].includes(owned.status)
          ? conflict(
              "The managed browser is already starting",
              "BROWSER_STARTING",
            )
          : browserReclaiming(),
      };
    }
    const inspected = await set(
      inspectActiveConnection$,
      { browser: owned, context: args.context },
      signal,
    );
    return inspected.kind === "resume"
      ? { kind: "resume", browser: inspected.browser }
      : { kind: "connection", result: inspected };
  },
);

const resumeSuspendedBrowser$ = command(
  async (
    { set },
    args: {
      readonly context: BrowserRunContext;
      readonly current: BrowserSessionRow;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const { context } = args;

    const claim = await claimBrowserForResume(db, context, signal);
    signal.throwIfAborted();
    if (claim.kind === "error") {
      return claim;
    }
    if (claim.kind === "missing") {
      return conflict(
        "The current managed browser changed; retry resume",
        "BROWSER_CHANGED",
      );
    }
    if (claim.kind === "active") {
      const inspected = await set(
        inspectActiveConnection$,
        { browser: claim.browser, context },
        signal,
      );
      return inspected.kind === "resume"
        ? conflict(
            "The managed browser changed; retry resume",
            "BROWSER_CHANGED",
          )
        : inspected;
    }

    const connection = await set(
      startProviderInstance$,
      {
        browser: claim.browser,
        context,
      },
      AbortSignal.timeout(PROVIDER_START_LIFECYCLE_TIMEOUT_MS),
    );
    signal.throwIfAborted();
    if (connection.kind === "error") {
      await db
        .update(browserSessions)
        .set({ status: "error", updatedAt: nowDate() })
        .where(
          and(
            eq(browserSessions.chatThreadId, claim.browser.chatThreadId),
            inArray(browserSessions.status, ["creating", "resuming"]),
          ),
        );
      signal.throwIfAborted();
    }
    signal.throwIfAborted();
    return connection;
  },
);

// Create, reuse, or resume the thread's browser. A live provider instance is
// reused across runs and its lease restarts; a suspended one is restarted from
// the saved profile and its last captured HTTP(S) tab URLs are reopened on a
// best-effort basis.
const openBrowserForContext$ = command(
  async (
    { set },
    args: {
      readonly context: BrowserRunContext;
      readonly input?: BrowserCreateInput;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const { context } = args;

    const current = await loadCurrentBrowser(db, context);
    signal.throwIfAborted();
    if (!current) {
      return await set(
        createBrowserForContext$,
        {
          context,
          input: args.input ?? {
            name: "browser",
            proxyCountryCode: null,
          },
        },
        signal,
      );
    }

    const reused = await set(
      reuseLiveThreadBrowser$,
      { context, current },
      signal,
    );
    signal.throwIfAborted();
    return reused.kind === "connection"
      ? reused.result
      : await set(
          resumeSuspendedBrowser$,
          {
            context,
            current: reused.browser,
          },
          signal,
        );
  },
);

export const useBrowser$ = command(
  async (
    { set },
    actor: BrowserActor,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const context = await resolveRunContext(db, actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    return await set(
      openBrowserForContext$,
      {
        context: context.value,
      },
      signal,
    );
  },
);

export const openBrowserForThread$ = command(
  async (
    { set },
    args: BrowserSessionAccess & { readonly lifecycleEventId: string },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserMutation>> => {
    const db = set(writeDb$);
    const context = await resolveViewerStartContext(db, args);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    const connection = await set(
      openBrowserForContext$,
      {
        context: context.value,
      },
      signal,
    );
    signal.throwIfAborted();
    if (connection.kind === "error") {
      return connection;
    }
    // The viewer runs in the user's browser, so it only ever learns the live
    // view; the CDP endpoint stays inside the agent runtime.
    const event = await db.transaction(async (tx) => {
      return await insertChatEvent(
        tx,
        {
          id: args.lifecycleEventId,
          chatThreadId: context.value.chatThreadId,
          eventType: "browser.open",
          content: null,
        },
        "id",
      );
    });
    signal.throwIfAborted();
    if (!event) {
      return conflict(
        "The managed browser open event ID is already in use",
        "BROWSER_EVENT_ID_CONFLICT",
      );
    }
    await publishChatThreadMessageCreatedSafely({
      userId: context.value.userId,
      orgId: context.value.orgId,
      threadId: context.value.chatThreadId,
      syncThroughSeqId: event.seqId,
    });
    signal.throwIfAborted();
    return {
      kind: "ok",
      value: {
        browser: connection.value.browser,
        lifecycleEventId: event.id,
      },
    };
  },
);

export const closeBrowserForThread$ = command(
  async (
    { set },
    args: BrowserSessionAccess & { readonly lifecycleEventId: string },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserCloseMutation>> => {
    const db = set(writeDb$);
    const thread = await loadOwnedBrowserSidebarThread(db, args);
    signal.throwIfAborted();
    if (!thread) {
      return notFound();
    }
    const accessError = await browserSessionAccessError(db, thread, args);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    const event = await db.transaction(async (tx) => {
      return await insertChatEvent(
        tx,
        {
          id: args.lifecycleEventId,
          chatThreadId: thread.chatThreadId,
          eventType: "browser.close",
          content: null,
        },
        "id",
      );
    });
    signal.throwIfAborted();
    if (!event) {
      return conflict(
        "The managed browser close event ID is already in use",
        "BROWSER_EVENT_ID_CONFLICT",
      );
    }
    await publishChatThreadMessageCreatedSafely({
      userId: thread.userId,
      orgId: args.orgId,
      threadId: thread.chatThreadId,
      syncThroughSeqId: event.seqId,
    });
    signal.throwIfAborted();
    return {
      kind: "ok",
      value: {
        lifecycleEventId: event.id,
      },
    };
  },
);

const leaseInstanceForBrowser$ = command(
  async (
    { set },
    browser: BrowserSessionRow,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserSession>> => {
    const db = set(writeDb$);
    const instance = await loadActiveInstance(db, browser.chatThreadId);
    signal.throwIfAborted();
    const leased = instance
      ? await touchInstanceLease(db, instance.providerSessionId, signal)
      : null;
    if (!leased) {
      return conflict(
        "This managed browser is no longer live; resume it to keep working in it",
        "BROWSER_NOT_LIVE",
      );
    }
    const [screen, screenshotUrl] = await Promise.all([
      loadBrowserScreen(db, leased.providerSessionId, signal),
      set(loadBrowserScreenshotUrl$, db, browser.chatThreadId, signal),
    ]);
    signal.throwIfAborted();
    return {
      kind: "ok",
      value: publicBrowser(browser, {
        liveUrl: null,
        screenshotUrl,
        idleExpiresAt: leased.idleExpiresAt,
        screen,
      }),
    };
  },
);

export const leaseCurrentBrowser$ = command(
  async (
    { set },
    actor: BrowserActor,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserSession>> => {
    const db = set(writeDb$);
    const context = await resolveRunContext(db, actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    const browser = await loadCurrentBrowser(db, context.value);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    return await set(leaseInstanceForBrowser$, browser, signal);
  },
);

export const leaseBrowserByThread$ = command(
  async (
    { set },
    access: BrowserSessionAccess,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserSession>> => {
    const db = set(writeDb$);
    const browser = await loadOwnedBrowser(db, access);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    const accessError = await browserSessionAccessError(db, browser, access);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    return await set(leaseInstanceForBrowser$, browser, signal);
  },
);

export const resizeBrowserByThread$ = command(
  async (
    { set },
    access: BrowserSessionAccess & { readonly aspectRatio: number },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserSession>> => {
    const db = set(writeDb$);
    const browser = await loadOwnedBrowser(db, access);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    const accessError = await browserSessionAccessError(db, browser, access);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    if (browser.status !== "active") {
      return conflict(
        "This managed browser is no longer live; resume it before resizing it",
        "BROWSER_NOT_LIVE",
      );
    }
    const instance = await loadActiveInstance(db, browser.chatThreadId);
    signal.throwIfAborted();
    if (!instance) {
      return conflict(
        "This managed browser is no longer live; resume it before resizing it",
        "BROWSER_NOT_LIVE",
      );
    }
    const screen = await loadBrowserScreen(
      db,
      instance.providerSessionId,
      signal,
    );
    if (!screen) {
      return conflict(
        "This managed browser was started before window resizing was enabled; resume it before resizing it",
        "BROWSER_RESIZE_UNSUPPORTED",
      );
    }
    const touched = await touchInstanceLease(
      db,
      instance.providerSessionId,
      signal,
    );
    if (!touched) {
      return conflict(
        "This managed browser is no longer live; resume it before resizing it",
        "BROWSER_NOT_LIVE",
      );
    }
    const provider = await providerCall(
      getBrowserUseSession(instance.providerSessionId, signal),
    );
    signal.throwIfAborted();
    if (provider.kind === "error") {
      return provider;
    }
    if (provider.value.status !== "active" || !provider.value.cdpUrl) {
      return conflict(
        "This managed browser is no longer live; resume it before resizing it",
        "BROWSER_NOT_LIVE",
      );
    }
    const screenHeight = browserScreenHeightForAspectRatio(access.aspectRatio);
    const resized = await providerCall(
      resizeBrowserUseSession(
        provider.value.cdpUrl,
        BROWSER_SCREEN_WIDTH,
        screenHeight,
        signal,
      ),
    );
    signal.throwIfAborted();
    if (resized.kind === "error") {
      return resized;
    }
    const persisted = await persistBrowserScreen(
      db,
      instance.providerSessionId,
      screenHeight,
      signal,
    );
    if (persisted.kind === "error") {
      return persisted;
    }
    await publishBrowserSessionChangedSafely(browser.userId, {
      threadId: browser.chatThreadId,
    });
    signal.throwIfAborted();
    const screenshotUrl = await set(
      loadBrowserScreenshotUrl$,
      db,
      browser.chatThreadId,
      signal,
    );
    return {
      kind: "ok",
      value: publicBrowser(browser, {
        liveUrl: provider.value.liveUrl,
        screenshotUrl,
        idleExpiresAt: persisted.value.instance.idleExpiresAt,
        screen: persisted.value.screen,
      }),
    };
  },
);

export const getBrowser$ = command(
  async (
    { set },
    access: BrowserSessionAccess,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserSession>> => {
    const db = set(writeDb$);
    const row = await loadOwnedBrowser(db, access);
    signal.throwIfAborted();
    if (!row) {
      return notFound();
    }
    const accessError = await browserSessionAccessError(db, row, access);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    const screenshotUrl = await set(
      loadBrowserScreenshotUrl$,
      db,
      row.chatThreadId,
      signal,
    );
    let liveUrl: string | null = null;
    let idleExpiresAt: Date | null = null;
    let screen: BrowserScreen | null = null;
    if (row.status === "active") {
      const instance = await loadActiveInstance(db, row.chatThreadId);
      signal.throwIfAborted();
      if (instance) {
        idleExpiresAt = instance.idleExpiresAt;
        screen = await loadBrowserScreen(
          db,
          instance.providerSessionId,
          signal,
        );
        const provider = await providerCall(
          getBrowserUseSession(instance.providerSessionId, signal),
        );
        signal.throwIfAborted();
        if (provider.kind === "error") {
          return provider;
        }
        liveUrl =
          provider.value.status === "active" ? provider.value.liveUrl : null;
      }
    }
    return {
      kind: "ok",
      value: publicBrowser(row, {
        liveUrl,
        screenshotUrl,
        idleExpiresAt,
        screen,
      }),
    };
  },
);

export const getCurrentBrowser$ = command(
  async (
    { set },
    actor: BrowserActor,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserSession>> => {
    const db = set(writeDb$);
    const context = await resolveRunContext(db, actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    const browser = await loadCurrentBrowser(db, context.value);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    return await set(
      getBrowser$,
      {
        orgId: actor.orgId,
        userId: actor.userId,
        chatThreadId: context.value.chatThreadId,
        publicBrand: actor.publicBrand,
      },
      signal,
    );
  },
);

function isTerminalRunStatus(status: string): boolean {
  return TERMINAL_RUN_STATUSES.some((terminalStatus) => {
    return terminalStatus === status;
  });
}

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
        await stopActiveBrowserInstance(db, target, "reconcile", signal, {
          emitCloseEvent: false,
          stopProvider: false,
          saveTabSnapshot: false,
        })
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
      cleanupBrowserProfileLater(
        db,
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

async function releaseStrandedBrowserStarts(
  db: Db,
  limit: number,
  chatThreadIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<number> {
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
        chatThreadIds === null
          ? undefined
          : inArray(browserSessions.chatThreadId, chatThreadIds),
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
    await db.transaction(async (tx) => {
      await tx
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
        );
      await tx
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
          ),
        );
    });
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
        chatThreadIds === null
          ? undefined
          : inArray(browserSessions.chatThreadId, chatThreadIds),
      ),
    )
    .returning({ chatThreadId: browserSessions.chatThreadId });
  signal.throwIfAborted();
  return stranded.length + abandonedStarts.length;
}

interface ExpiredInactiveBrowserTarget {
  readonly chatThreadId: string;
  readonly userId: string;
  readonly status: InactiveBrowserStatus;
  readonly suspendedAt: Date | null;
  readonly suspensionReason: BrowserSuspensionReason | null;
  readonly updatedAt: Date;
  readonly providerProfileId: string | null;
}

async function claimExpiredInactiveBrowser(
  db: Db,
  target: ExpiredInactiveBrowserTarget,
  cutoff: Date,
  screenshotSchemaReady: boolean,
  signal: AbortSignal,
): Promise<Date | null> {
  const claimedAt = nowDate();
  const claimed = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, target.chatThreadId);
    await lockBrowserProfileCreation(tx, target.chatThreadId);
    const [profile] = await tx
      .select({
        providerProfileId: browserThreadProfiles.providerProfileId,
      })
      .from(browserThreadProfiles)
      .where(eq(browserThreadProfiles.chatThreadId, target.chatThreadId))
      .limit(1);
    if ((profile?.providerProfileId ?? null) !== target.providerProfileId) {
      return false;
    }
    const [browser] = await tx
      .update(browserSessions)
      .set({
        status: "stopping",
        suspendedAt: target.updatedAt,
        suspensionReason: "reconcile",
        updatedAt: claimedAt,
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, target.chatThreadId),
          eq(browserSessions.status, target.status),
          eq(browserSessions.updatedAt, target.updatedAt),
          lte(browserSessions.updatedAt, cutoff),
          notExists(
            tx
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
        ),
      )
      .returning({ chatThreadId: browserSessions.chatThreadId });
    if (!browser) {
      return false;
    }

    if (screenshotSchemaReady) {
      await tx
        .delete(browserSessionScreenshots)
        .where(eq(browserSessionScreenshots.chatThreadId, target.chatThreadId));
    }
    await tx
      .delete(browserSessionTabSnapshots)
      .where(eq(browserSessionTabSnapshots.chatThreadId, target.chatThreadId));
    await tx
      .delete(browserSessionInstances)
      .where(eq(browserSessionInstances.chatThreadId, target.chatThreadId));
    return true;
  });
  signal.throwIfAborted();
  return claimed ? claimedAt : null;
}

async function releaseExpiredInactiveBrowserClaim(
  db: Db,
  target: ExpiredInactiveBrowserTarget,
  claimedAt: Date,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockBrowserThread(tx, target.chatThreadId);
    await tx
      .update(browserSessions)
      .set({
        status: target.status,
        suspendedAt: target.suspendedAt,
        suspensionReason: target.suspensionReason,
        updatedAt: target.updatedAt,
      })
      .where(
        and(
          eq(browserSessions.chatThreadId, target.chatThreadId),
          eq(browserSessions.status, "stopping"),
          eq(browserSessions.updatedAt, claimedAt),
        ),
      );
  });
}

async function retireExpiredInactiveBrowser(
  db: Db,
  target: ExpiredInactiveBrowserTarget,
  claimedAt: Date,
  signal: AbortSignal,
): Promise<boolean> {
  const retired = await db.transaction(async (tx) => {
    await lockBrowserThread(tx, target.chatThreadId);
    await lockBrowserProfileCreation(tx, target.chatThreadId);
    const [[browser], [profile]] = await Promise.all([
      tx
        .select({
          status: browserSessions.status,
          updatedAt: browserSessions.updatedAt,
        })
        .from(browserSessions)
        .where(eq(browserSessions.chatThreadId, target.chatThreadId))
        .limit(1),
      tx
        .select({
          providerProfileId: browserThreadProfiles.providerProfileId,
        })
        .from(browserThreadProfiles)
        .where(eq(browserThreadProfiles.chatThreadId, target.chatThreadId))
        .limit(1),
    ]);
    if (profile && profile.providerProfileId !== target.providerProfileId) {
      return false;
    }
    if (
      browser &&
      (browser.status !== "stopping" ||
        browser.updatedAt.getTime() !== claimedAt.getTime())
    ) {
      return false;
    }
    if (browser) {
      await tx
        .delete(browserSessions)
        .where(eq(browserSessions.chatThreadId, target.chatThreadId));
    }
    if (target.providerProfileId !== null) {
      await tx
        .delete(browserThreadProfiles)
        .where(
          and(
            eq(browserThreadProfiles.chatThreadId, target.chatThreadId),
            eq(
              browserThreadProfiles.providerProfileId,
              target.providerProfileId,
            ),
          ),
        );
    }
    return true;
  });
  signal.throwIfAborted();
  if (retired) {
    await publishBrowserSessionChangedSafely(target.userId, {
      threadId: target.chatThreadId,
    });
  }
  signal.throwIfAborted();
  return retired;
}

async function cleanupExpiredInactiveBrowser(
  db: Db,
  target: ExpiredInactiveBrowserTarget,
  cutoff: Date,
  screenshotSchemaReady: boolean,
  signal: AbortSignal,
): Promise<boolean> {
  const claimedAt = await claimExpiredInactiveBrowser(
    db,
    target,
    cutoff,
    screenshotSchemaReady,
    signal,
  );
  if (claimedAt === null) {
    return false;
  }

  const cleanup = await settle(
    (async () => {
      if (target.providerProfileId !== null) {
        await deleteBrowserUseProfile(
          target.providerProfileId,
          AbortSignal.any([
            signal,
            AbortSignal.timeout(PROVIDER_CLEANUP_TIMEOUT_MS),
          ]),
        );
      }
      const retired = await retireExpiredInactiveBrowser(
        db,
        target,
        claimedAt,
        signal,
      );
      if (!retired) {
        throw new Error("Expired managed browser cleanup claim changed");
      }
    })(),
  );
  if (!cleanup.ok) {
    await releaseExpiredInactiveBrowserClaim(db, target, claimedAt);
    signal.throwIfAborted();
    throw cleanup.error;
  }
  signal.throwIfAborted();
  return true;
}

async function reconcileExpiredInactiveBrowsers(
  db: Db,
  limit: number,
  screenshotSchemaReady: boolean,
  chatThreadIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<{
  readonly checked: number;
  readonly cleaned: number;
  readonly errors: number;
}> {
  const cutoff = new Date(nowDate().getTime() - INACTIVE_BROWSER_RETENTION_MS);
  const rows = await db
    .select({
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
                inArray(browserSessionInstances.status, ["active", "stopping"]),
              ),
            ),
        ),
        chatThreadIds === null
          ? undefined
          : inArray(browserSessions.chatThreadId, chatThreadIds),
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
      cleanupExpiredInactiveBrowser(
        db,
        { ...row, status: row.status },
        cutoff,
        screenshotSchemaReady,
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
}

async function purgeExpiredStoppedBrowserInstances(
  db: Db,
  limit: number,
  chatThreadIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<{ readonly checked: number; readonly cleaned: number }> {
  const cutoff = new Date(nowDate().getTime() - INACTIVE_BROWSER_RETENTION_MS);
  const rows = await db
    .select({
      providerSessionId: browserSessionInstances.providerSessionId,
    })
    .from(browserSessionInstances)
    .where(
      and(
        eq(browserSessionInstances.status, "stopped"),
        lte(browserSessionInstances.finishedAt, cutoff),
        chatThreadIds === null
          ? undefined
          : inArray(browserSessionInstances.chatThreadId, chatThreadIds),
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
        chatThreadIds === null
          ? undefined
          : inArray(browserSessionInstances.chatThreadId, chatThreadIds),
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
}

async function deferBrowserInstanceReconcile(
  db: Db,
  providerSessionId: string,
  signal: AbortSignal,
): Promise<void> {
  await db
    .update(browserSessionInstances)
    .set({ updatedAt: nowDate() })
    .where(eq(browserSessionInstances.providerSessionId, providerSessionId));
  signal.throwIfAborted();
}

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

async function reconcileOrphanedBrowserProfiles(
  db: Db,
  limit: number,
  chatThreadIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<{
  readonly checked: number;
  readonly cleaned: number;
  readonly errors: number;
}> {
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
    .where(
      and(
        isNull(chatThreads.id),
        chatThreadIds === null
          ? undefined
          : inArray(browserThreadProfiles.chatThreadId, chatThreadIds),
      ),
    )
    .orderBy(browserThreadProfiles.updatedAt)
    .limit(limit);
  signal.throwIfAborted();

  let cleaned = 0;
  let errors = 0;
  for (const profile of profiles) {
    const result = await settleIncludingAbort(
      cleanupBrowserProfile(db, profile, signal),
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
}

async function reconcileOrphanedBrowserScreenshots(
  db: Db,
  limit: number,
  chatThreadIds: readonly string[] | null,
  signal: AbortSignal,
): Promise<{
  readonly checked: number;
  readonly cleaned: number;
  readonly errors: number;
}> {
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
    .where(
      and(
        isNull(chatThreads.id),
        chatThreadIds === null
          ? undefined
          : inArray(browserSessionScreenshots.chatThreadId, chatThreadIds),
      ),
    )
    .orderBy(browserSessionScreenshots.updatedAt)
    .limit(limit);
  signal.throwIfAborted();

  let cleaned = 0;
  let errors = 0;
  for (const screenshot of screenshots) {
    const result = await settleIncludingAbort(
      db
        .delete(browserSessionScreenshots)
        .where(
          and(
            eq(browserSessionScreenshots.chatThreadId, screenshot.chatThreadId),
            eq(browserSessionScreenshots.objectKey, screenshot.objectKey),
          ),
        ),
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
}

const reconcileBrowserInstance$ = command(
  async (
    { set },
    row: BrowserReconcileCandidate,
    signal: AbortSignal,
  ): Promise<BrowserReconcileOutcome> => {
    const db = set(writeDb$);
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
        await deferBrowserInstanceReconcile(
          db,
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
      await deferBrowserInstanceReconcile(
        db,
        row.instance.providerSessionId,
        signal,
      );
      set(scheduleBrowserScreenshotCapture$, row.browser);
      return { stopped: 0, errors: 0, healthy: 1 };
    }

    const stopped = await stopActiveBrowserInstance(
      db,
      {
        chatThreadId: row.browser.chatThreadId,
        providerSessionId: row.instance.providerSessionId,
        orgId: row.browser.orgId,
        userId: row.browser.userId,
      },
      reason,
      signal,
      {
        emitCloseEvent: row.chatThreadId !== null,
        stopProvider,
      },
    );
    return {
      stopped: stopped ? 1 : 0,
      errors: 0,
      healthy: 0,
    };
  },
);

const reconcileBrowsersWithScope$ = command(
  async (
    { set },
    chatThreadIds: readonly string[] | null,
    signal: AbortSignal,
  ): Promise<BrowserReconcileResult> => {
    if (chatThreadIds !== null && chatThreadIds.length === 0) {
      return { checked: 0, stopped: 0, errors: 0, healthy: 0 };
    }
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
      .where(
        and(
          eq(browserSessionInstances.status, "active"),
          chatThreadIds === null
            ? undefined
            : inArray(browserSessionInstances.chatThreadId, chatThreadIds),
        ),
      )
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

    const releasedStarts = await releaseStrandedBrowserStarts(
      db,
      RECONCILE_BATCH_SIZE,
      chatThreadIds,
      signal,
    );
    const screenshotSchemaReady = await browserScreenshotSchemaAvailable(db);
    signal.throwIfAborted();
    const expiredBrowserCleanup = await reconcileExpiredInactiveBrowsers(
      db,
      RECONCILE_BATCH_SIZE,
      screenshotSchemaReady,
      chatThreadIds,
      signal,
    );
    const expiredInstanceCleanup = await purgeExpiredStoppedBrowserInstances(
      db,
      RECONCILE_BATCH_SIZE,
      chatThreadIds,
      signal,
    );
    const profileCleanup = await reconcileOrphanedBrowserProfiles(
      db,
      RECONCILE_BATCH_SIZE,
      chatThreadIds,
      signal,
    );
    const orphanedScreenshotCleanup = screenshotSchemaReady
      ? await reconcileOrphanedBrowserScreenshots(
          db,
          RECONCILE_BATCH_SIZE,
          chatThreadIds,
          signal,
        )
      : { checked: 0, cleaned: 0, errors: 0 };

    return {
      checked:
        rows.length +
        releasedStarts +
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

export const reconcileBrowsers$ = command(
  async ({ set }, signal: AbortSignal): Promise<BrowserReconcileResult> => {
    return await set(reconcileBrowsersWithScope$, null, signal);
  },
);

/** Reconcile only browser resources owned by explicit test fixture threads. */
export const reconcileBrowserFixtures$ = command(
  async (
    { set },
    chatThreadIds: readonly string[],
    signal: AbortSignal,
  ): Promise<BrowserReconcileResult> => {
    return await set(reconcileBrowsersWithScope$, chatThreadIds, signal);
  },
);
