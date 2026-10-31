import { rootSignal$ } from "../context/root";
import {
  BROWSER_IDLE_LEASE_MINUTES,
  BROWSER_INITIAL_SCREEN_HEIGHT,
  BROWSER_MAX_SCREEN_HEIGHT,
  BROWSER_MIN_SCREEN_HEIGHT,
  BROWSER_PROVIDER_TIMEOUT_MINUTES,
  BROWSER_SCREEN_WIDTH,
  type BrowserSession,
  type BrowserViewerConnection,
  type BrowserSuspensionReason,
  type BrowserWindowContext,
} from "@okouai/api-contracts/contracts/browser";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { runUploadedFiles } from "@okouai/db/schema/run-uploaded-file";
import {
  browserSessionInstances,
  browserSessionResizeStates,
  browserSessionScreenshots,
  browserSessionScreenshotDeletions,
  browserSessionTabSnapshots,
  browserSessions,
  browserThreadProfiles,
  browserUserActionRequests,
} from "@okouai/db/schema/browser-session";
import { browserOwnerProfiles } from "@okouai/db/schema/browser-owner";
import { browserChatSessions } from "@okouai/db/schema/browser-chat-session";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { BRAND_PRESENTATION } from "@okouai/core/brand-presentation";
import { command } from "ccstate";
import {
  and,
  asc,
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
import { array, boolean, object, string, ZodError } from "zod";
import { parseRawRows } from "../../lib/db-raw-rows";
import {
  pgBooleanDecoder,
  pgIntegerDecoder,
} from "../../lib/db-structured-result";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { isUniqueViolation, safeSqlStateCode } from "../../lib/pg-errors";
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
  createBrowserUseProfile,
  createBrowserUseSession,
  deleteBrowserUseProfile,
  getBrowserUseSession,
  listBrowserUseTabUrls,
  resizeBrowserUseSession,
  resolveBrowserUseViewerConnection,
  restoreBrowserUseTabUrls,
  stopBrowserUseSession,
  stopBrowserUseSessionForCleanup,
  type BrowserUseSession,
} from "./browser-use.service";
import {
  resolveArtifactFileReference$,
  allocatePrivateArtifact$,
  privateArtifactRecord$,
} from "./private-artifact-storage.service";
import {
  decryptPersistentSecretValue,
  encryptPersistentSecretValue,
} from "./crypto.utils";
import {
  loadActivePaidConcurrencySlots$,
  cappedBaseConcurrencyLimit,
  totalConcurrencyLimit,
} from "./org-concurrency-entitlements.service";
import { loadOrgPlanCapabilities$ } from "./org-plan-entitlement-read.service";
import { reconcileBrowserUserActions$ } from "./browser-user-actions.service";
import { browserCapturePublication } from "./browser-capture-publication";

const RECONCILE_BATCH_SIZE = 20;
const BROWSER_RESIZE_TIMEOUT_MS = 30_000;
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
const browserTabSnapshotSchema = array(string().max(8192)).max(50);

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
type BrowserThreadProfileRow = typeof browserThreadProfiles.$inferSelect;
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
}

interface BrowserMutation {
  readonly browser: BrowserSession;
}

interface BrowserScreen {
  readonly width: typeof BROWSER_SCREEN_WIDTH;
  readonly height: number;
  readonly resizable: true;
}

interface BrowserActor {
  readonly orgId: string;
  readonly userId: string;
  readonly runId?: string;
}

interface BrowserRunContext {
  readonly orgId: string;
  readonly userId: string;
  // Run associated with the provider instance. For run tokens this is the
  // calling run; for viewer requests it is the thread's most recent run.
  readonly runId: string;
  readonly chatThreadId: string;
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
    `Managed browsers can only be started from an ${BRAND_PRESENTATION.assistantName} chat run`,
  );
}

function browserReclaiming() {
  return conflict(
    `${BRAND_PRESENTATION.assistantName} is still reclaiming this thread's previous managed browser; retry in a moment`,
    "BROWSER_STOPPING",
  );
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

const loadBrowserScreen$ = command(
  async (
    { get },
    providerSessionId: string,
    signal: AbortSignal,
  ): Promise<BrowserScreen | null> => {
    const db = get(db$);
    const [screen] = await db
      .select({
        width: browserSessionResizeStates.screenWidth,
        height: browserSessionResizeStates.screenHeight,
      })
      .from(browserSessionResizeStates)
      .where(
        eq(browserSessionResizeStates.providerSessionId, providerSessionId),
      )
      .limit(1);
    signal.throwIfAborted();
    return screen?.width === BROWSER_SCREEN_WIDTH
      ? {
          width: BROWSER_SCREEN_WIDTH,
          height: screen.height,
          resizable: true,
        }
      : null;
  },
);

const loadBrowserScreenshotUrl$ = command(
  async (
    { set },
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const db = set(writeDb$);
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
    return await set(resolveBrowserScreenshotUrl$, screenshot, signal);
  },
);

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

const loadBrowserScreenHeightForThread$ = command(
  async (
    { get },
    chatThreadId: string,
    signal: AbortSignal,
  ): Promise<number> => {
    const db = get(db$);
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
  },
);

// Extending the lease is unconditional and fixed-length: every toucher gets the
// same 10 minutes from now, so leases cannot be stacked into a longer lifetime.
const touchInstanceLease$ = command(
  async (
    { set },
    providerSessionId: string,
    signal: AbortSignal,
  ): Promise<BrowserInstanceRow | null> => {
    const db = set(writeDb$);
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
  },
);

const persistBrowserScreen$ = command(
  async (
    { set },
    providerSessionId: string,
    screenHeight: number,
    signal: AbortSignal,
  ): Promise<
    BrowserServiceResult<{
      readonly instance: BrowserInstanceRow;
      readonly screen: BrowserScreen;
    }>
  > => {
    const db = set(writeDb$);
    const [updatedScreen] = await db
      .update(browserSessionResizeStates)
      .set({
        screenWidth: BROWSER_SCREEN_WIDTH,
        screenHeight,
        updatedAt: nowDate(),
      })
      .where(
        eq(browserSessionResizeStates.providerSessionId, providerSessionId),
      )
      .returning({ height: browserSessionResizeStates.screenHeight });
    signal.throwIfAborted();
    if (!updatedScreen) {
      return conflict(
        "This managed browser was started before window resizing was enabled; resume it before resizing it",
        "BROWSER_RESIZE_UNSUPPORTED",
      );
    }
    const instance = await set(touchInstanceLease$, providerSessionId, signal);
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
  },
);

interface ActiveBrowserInstance {
  readonly chatThreadId: string;
  readonly providerSessionId: string;
  readonly orgId: string;
  readonly userId: string;
}

// Shared ownership persists across instance stops; legacy writers and
// retention must not reclaim that owner's chat snapshots after cutover.
function uncutBrowserOwner() {
  return notExists(
    new QueryBuilder()
      .select({ id: browserOwnerProfiles.id })
      .from(browserOwnerProfiles)
      .where(
        and(
          eq(browserOwnerProfiles.orgId, browserSessions.orgId),
          eq(browserOwnerProfiles.userId, browserSessions.userId),
        ),
      ),
  );
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
              uncutBrowserOwner(),
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

const restoreBrowserTabSnapshot$ = command(
  async (
    { get },
    browser: BrowserSessionRow,
    cdpUrl: string,
    signal: AbortSignal,
  ): Promise<void> => {
    const db = get(db$);
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
    suppliedOptions:
      | {
          readonly stopProvider: boolean;
          readonly saveTabSnapshot?: boolean;
        }
      | undefined,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const options = suppliedOptions ?? { stopProvider: true };
    if (options.saveTabSnapshot ?? options.stopProvider) {
      await set(saveBrowserTabSnapshot$, target, signal);
    }
    const stopped = await set(
      commitBrowserStop$,
      target,
      reason,
      options.stopProvider,
    );
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

const suspendBrowserWithoutActiveInstance$ = command(
  async (
    { set },
    browser: BrowserSessionRow,
    reason: BrowserSuspensionReason,
    signal: AbortSignal,
  ): Promise<BrowserSessionRow | null> => {
    const db = set(writeDb$);
    const [suspended] = await db
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
    signal.throwIfAborted();
    if (!suspended) {
      return null;
    }
    await publishBrowserSessionChangedSafely(browser.userId, {
      threadId: browser.chatThreadId,
    });
    signal.throwIfAborted();
    return suspended;
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

const ensureBrowserCapacity$ = command(
  async (
    { get, set },
    orgId: string,
    signal: AbortSignal,
  ): Promise<BrowserServiceError | null> => {
    const db = get(db$);
    const available = await set(browserAvailableConcurrency$, orgId);
    signal.throwIfAborted();
    if (!Number.isFinite(available)) {
      return null;
    }
    if (available <= 0) {
      return conflict(
        "This organization has no managed browser concurrency available",
        "BROWSER_CONCURRENCY_LIMIT",
      );
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
    const reclaimCount = active.length - available + 1;
    for (const target of active.slice(0, Math.max(reclaimCount, 0))) {
      await set(
        stopActiveBrowserInstance$,
        target,
        "reconcile",
        undefined,
        signal,
      );
    }
    return null;
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

const latestThreadRunId$ = command(
  async ({ get }, chatThreadId: string): Promise<string | null> => {
    const db = get(db$);
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
  },
);

const resolveRunContext$ = command(
  async (
    { get },
    actor: BrowserActor,
  ): Promise<BrowserServiceResult<BrowserRunContext>> => {
    const db = get(db$);
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
        requireLiveRun: true,
      },
    };
  },
);

const resolveViewerStartContext$ = command(
  async (
    { get, set },
    access: BrowserSessionAccess,
  ): Promise<BrowserServiceResult<BrowserRunContext>> => {
    const db = get(db$);
    if (access.runId) {
      const context = await set(resolveRunContext$, access);
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
      .leftJoin(
        browserSessions,
        eq(browserSessions.chatThreadId, chatThreads.id),
      )
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
      (await set(latestThreadRunId$, access.chatThreadId)) ??
      thread.browserRunId;
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
        requireLiveRun: false,
      },
    };
  },
);

const browserSessionAccessError$ = command(
  async (
    { get },
    browser: Pick<BrowserSessionRow, "chatThreadId">,
    access: BrowserOwnerAccess,
  ): Promise<BrowserServiceError | null> => {
    const db = get(db$);
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
  },
);

const loadOwnedBrowserSidebarThread$ = command(
  async (
    { get },
    access: BrowserSessionAccess,
  ): Promise<BrowserSidebarThread | null> => {
    const db = get(db$);
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
  },
);

const loadOwnedBrowser$ = command(
  async (
    { get },
    access: BrowserSessionAccess,
  ): Promise<BrowserSessionRow | null> => {
    const [row] = await get(db$)
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
  },
);

const loadCurrentBrowser$ = command(
  async (
    { get },
    context: Pick<BrowserRunContext, "orgId" | "userId" | "chatThreadId">,
  ): Promise<BrowserSessionRow | null> => {
    const db = get(db$);
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

const loadOwnedThreadBrowserProfile$ = command(
  async (
    { get },
    owner: Pick<BrowserRunContext, "orgId" | "userId" | "chatThreadId">,
  ): Promise<BrowserThreadProfileRow | null> => {
    const db = get(db$);
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
  },
);

const loadBrowserProfileForBrowser$ = command(
  async (
    { get },
    browser: BrowserSessionRow,
  ): Promise<BrowserThreadProfileRow> => {
    const db = get(db$);
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
  },
);

async function deleteUnusedProfile(
  profileId: string,
  signal: AbortSignal,
): Promise<void> {
  await settle(deleteBrowserUseProfile(profileId, signal));
}

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

const claimBrowserProfile$ = command(
  async (
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly chatThreadId: string;
      readonly providerProfileId: string;
    },
  ): Promise<{
    readonly profile: BrowserThreadProfileRow | null;
    readonly created: boolean;
  }> => {
    const db = set(writeDb$);
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
    const existing = await set(loadOwnedThreadBrowserProfile$, args);
    return { profile: existing, created: false };
  },
);

const getOrCreateBrowserProfile$ = command(
  async (
    { get, set },
    context: BrowserRunContext,
  ): Promise<BrowserServiceResult<BrowserThreadProfileRow>> => {
    const existing = await set(loadOwnedThreadBrowserProfile$, context);
    if (existing) {
      return { kind: "ok", value: existing };
    }

    const provider = await providerCall(
      createBrowserUseProfile(
        `okou-browser-profile-${context.chatThreadId}`,
        get(rootSignal$),
      ),
    );
    if (provider.kind === "error") {
      return provider;
    }

    const claimed = await settle(
      set(claimBrowserProfile$, {
        orgId: context.orgId,
        userId: context.userId,
        chatThreadId: context.chatThreadId,
        providerProfileId: provider.value,
      }),
    );
    if (!claimed.ok || !claimed.value.created) {
      await deleteUnusedProfile(provider.value, get(rootSignal$));
    }
    if (!claimed.ok) {
      throw claimed.error;
    }
    // Cleanup can retire the winning claim before the losing request reads it.
    return claimed.value.profile
      ? { kind: "ok", value: claimed.value.profile }
      : browserReclaiming();
  },
);

class BrowserPublicationLostError extends Error {}

interface StartedBrowserClaimArgs {
  readonly browser: BrowserSessionRow;
  readonly context: BrowserRunContext;
  readonly provider: BrowserUseSession;
  readonly screenHeight: number;
}

function browserStartInstanceValues(
  current: BrowserSessionRow,
  args: StartedBrowserClaimArgs,
): typeof browserSessionInstances.$inferInsert {
  const cleanupAfterStart = current.status === "stopping";
  return {
    providerSessionId: args.provider.id,
    chatThreadId: current.chatThreadId,
    runId: args.context.runId,
    status: cleanupAfterStart ? "stopped" : "active",
    timeoutAt: new Date(args.provider.timeoutAt),
    startedAt: new Date(args.provider.startedAt),
    lastTouchedAt: nowDate(),
    idleExpiresAt: nextIdleDeadline(),
    stopRequestedAt: cleanupAfterStart ? nowDate() : null,
    finishedAt: cleanupAfterStart ? nowDate() : null,
  };
}

function browserStartClaimIsCurrent(
  current: BrowserSessionRow | undefined,
  expected: BrowserSessionRow,
  context: BrowserRunContext,
): current is BrowserSessionRow {
  return (
    current !== undefined &&
    current.runId === context.runId &&
    (current.status === "stopping" ||
      (["creating", "resuming"].includes(current.status) &&
        current.status === expected.status &&
        current.updatedAt.getTime() === expected.updatedAt.getTime()))
  );
}

interface StartedBrowserPublicationRow {
  readonly browser: BrowserSessionRow | null;
  readonly instance: { readonly idleExpiresAt: Date };
  readonly height?: number | null;
}

function browserStartPublicationResult(
  publication: StartedBrowserPublicationRow | undefined,
  cleanupAfterStart: boolean,
) {
  if (!publication?.browser) {
    throw new BrowserPublicationLostError("Managed browser claim changed");
  }
  if (cleanupAfterStart) {
    return {
      kind: "cleanup" as const,
      browser: publication.browser,
      instance: publication.instance,
    };
  }
  if (publication.height === undefined || publication.height === null) {
    throw new Error("Failed to persist managed browser resize state");
  }
  const screen: BrowserScreen = {
    width: BROWSER_SCREEN_WIDTH,
    height: publication.height,
    resizable: true,
  };
  return {
    kind: "active" as const,
    browser: publication.browser,
    instance: publication.instance,
    screen,
  };
}

const claimStartedProviderInstance$ = command(
  async ({ set }, args: StartedBrowserClaimArgs) => {
    const db = set(writeDb$);
    const result = await settle(
      (async () => {
        const [current] = await db
          .select(BROWSER_SESSION_SELECTION)
          .from(browserSessions)
          .where(
            and(
              eq(browserSessions.id, args.browser.id),
              eq(browserSessions.chatThreadId, args.context.chatThreadId),
              eq(browserSessions.orgId, args.context.orgId),
              eq(browserSessions.userId, args.context.userId),
            ),
          )
          .limit(1);
        if (!browserStartClaimIsCurrent(current, args.browser, args.context)) {
          return { kind: "rejected" as const };
        }
        const cleanupAfterStart = current.status === "stopping";
        const instance = db.$with("started_browser_instance").as(
          db
            .insert(browserSessionInstances)
            .values(browserStartInstanceValues(current, args))
            .returning({
              providerSessionId: browserSessionInstances.providerSessionId,
              idleExpiresAt: browserSessionInstances.idleExpiresAt,
            }),
        );
        const resized = cleanupAfterStart
          ? undefined
          : db.$with("started_browser_screen").as(
              db
                .insert(browserSessionResizeStates)
                .values({
                  providerSessionId: sql`(${db
                    .select({ providerSessionId: instance.providerSessionId })
                    .from(instance)})`,
                  screenWidth: BROWSER_SCREEN_WIDTH,
                  screenHeight: args.screenHeight,
                })
                .returning({
                  providerSessionId:
                    browserSessionResizeStates.providerSessionId,
                  height: browserSessionResizeStates.screenHeight,
                }),
            );
        // Preserve instance -> screen -> logical order, shared with stop and
        // stranded cleanup. The count consumes the preceding write first.
        const preceding = resized ?? instance;
        const published = db.$with("started_browser_publication").as(
          db
            .update(browserSessions)
            .set({
              status: cleanupAfterStart ? "suspended" : "active",
              suspendedAt: cleanupAfterStart ? nowDate() : null,
              suspensionReason: cleanupAfterStart
                ? (current.suspensionReason ?? "reconcile")
                : null,
              updatedAt: nowDate(),
            })
            .where(
              and(
                eq(browserSessions.id, current.id),
                eq(browserSessions.chatThreadId, args.context.chatThreadId),
                eq(browserSessions.orgId, args.context.orgId),
                eq(browserSessions.userId, args.context.userId),
                eq(browserSessions.runId, args.context.runId),
                eq(browserSessions.status, current.status),
                eq(browserSessions.updatedAt, current.updatedAt),
                eq(db.select({ count: count() }).from(preceding), 1),
              ),
            )
            .returning(BROWSER_SESSION_SELECTION),
        );
        // The instance row keeps this SELECT nonempty even when the logical
        // CAS loses. Its only division aborts every write before rejection.
        const complete = sql`1 / CASE WHEN ${exists(
          db.select({ id: published.id }).from(published),
        )} THEN 1 ELSE 0 END`.mapWith(pgIntegerDecoder);
        const selection = {
          browser: { ...published._.selectedFields },
          instance: { idleExpiresAt: instance.idleExpiresAt },
          complete,
        };
        const rows = resized
          ? await db
              .with(instance, resized, published)
              .select({ ...selection, height: resized.height })
              .from(instance)
              .leftJoin(
                resized,
                eq(resized.providerSessionId, instance.providerSessionId),
              )
              .leftJoin(published, eq(published.id, current.id))
          : await db
              .with(instance, published)
              .select(selection)
              .from(instance)
              .leftJoin(published, eq(published.id, current.id));
        return browserStartPublicationResult(rows[0], cleanupAfterStart);
      })(),
    );
    if (!result.ok) {
      if (
        result.error instanceof BrowserPublicationLostError ||
        safeSqlStateCode(result.error) === "22012" ||
        isUniqueViolation(
          result.error,
          "uq_browser_session_instances_thread_owned",
        )
      ) {
        // 22012 belongs only to this statement's completion guard. PostgreSQL
        // has rolled back its instance/screen writes before this rejection.
        return { kind: "rejected" as const };
      }
      throw result.error;
    }
    const claimed = result.value;
    if (claimed.kind === "cleanup" || claimed.kind === "active") {
      await publishBrowserSessionChangedSafely(args.browser.userId, {
        threadId: args.browser.chatThreadId,
      });
    }
    return claimed;
  },
);

const createAndClaimProviderInstance$ = command(
  async (
    { get, set },
    args: {
      readonly browser: BrowserSessionRow;
      readonly profile: Pick<BrowserThreadProfileRow, "providerProfileId">;
      readonly context: BrowserRunContext;
      readonly screenHeight: number;
    },
  ) => {
    const provider = await providerCall(
      createBrowserUseSession(
        {
          profileId: args.profile.providerProfileId,
          extensionId: env("OKOU_BROWSER_USE_EXTENSION_ID"),
          proxyCountryCode: args.browser.proxyCountryCode,
          // Okou owns reclamation through the idle lease, so the provider only
          // needs to enforce the absolute upper bound.
          timeoutMinutes: BROWSER_PROVIDER_TIMEOUT_MINUTES,
        },
        get(rootSignal$),
      ),
    );
    if (provider.kind === "error") {
      return provider;
    }
    const { cdpUrl, liveUrl } = provider.value;
    if (provider.value.status !== "active" || !cdpUrl || !liveUrl) {
      stopProviderSessionLater(provider.value.id, get(rootSignal$));
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
        AbortSignal.timeout(BROWSER_RESIZE_TIMEOUT_MS),
      ),
    );
    if (resized.kind === "error") {
      stopProviderSessionLater(provider.value.id, get(rootSignal$));
      return resized;
    }

    const claimResult = await settleIncludingAbort(
      set(claimStartedProviderInstance$, {
        browser: args.browser,
        context: args.context,
        provider: provider.value,
        screenHeight: args.screenHeight,
      }),
    );
    if (!claimResult.ok) {
      // Provider creation is irreversible. Any failed claim must reclaim the
      // provider because the atomic statement rolls back every durable owner row.
      stopProviderSessionLater(provider.value.id, get(rootSignal$));
      throw claimResult.error;
    }
    const claimed = claimResult.value;
    if (claimed.kind === "cleanup" || claimed.kind === "rejected") {
      // Reclaim an unpublished provider before the lifecycle signal can abort
      // the caller, including a conditional-write loser after database rollback.
      stopProviderSessionLater(provider.value.id, get(rootSignal$));
    }
    return {
      kind: "claimed" as const,
      provider: provider.value,
      cdpUrl,
      liveUrl,
      claimed,
    };
  },
);

type BrowserStartResult =
  | BrowserServiceResult<BrowserConnection>
  | { readonly kind: "superseded"; readonly error: BrowserServiceError };

const startProviderInstance$ = command(
  async (
    { set },
    args: {
      readonly browser: BrowserSessionRow;
      readonly context: BrowserRunContext;
    },
    signal: AbortSignal,
  ): Promise<BrowserStartResult> => {
    const capacityError = await set(
      ensureBrowserCapacity$,
      args.context.orgId,
      signal,
    );
    signal.throwIfAborted();
    if (capacityError) {
      return capacityError;
    }
    const profile = await set(loadBrowserProfileForBrowser$, args.browser);
    signal.throwIfAborted();
    const screenHeight = await set(
      loadBrowserScreenHeightForThread$,
      args.context.chatThreadId,
      signal,
    );

    const started = await set(createAndClaimProviderInstance$, {
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

    if (claimed.kind === "cleanup" || claimed.kind === "rejected") {
      return {
        kind: "superseded",
        error: conflict(
          "The chat run ended while the managed browser was starting",
          "BROWSER_RUN_ENDED",
        ),
      };
    }

    await set(
      restoreBrowserTabSnapshot$,
      claimed.browser,
      started.cdpUrl,
      signal,
    );
    const screenshotUrl = await set(
      loadBrowserScreenshotUrl$,
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
      },
    };
  },
);

const claimFreshBrowser$ = command(
  async (
    { set },
    context: BrowserRunContext,
    args: BrowserCreateInput,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserSessionRow>> => {
    const db = set(writeDb$);
    signal.throwIfAborted();
    const [owned, run] = await Promise.all([
      db
        .select({ chatThreadId: browserSessions.chatThreadId })
        .from(browserSessions)
        .where(
          and(
            eq(browserSessions.chatThreadId, context.chatThreadId),
            inArray(browserSessions.status, [...OWNED_BROWSER_STATUSES]),
          ),
        )
        .limit(1),
      db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, context.runId))
        .limit(1),
    ]);
    signal.throwIfAborted();
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
    const [browser] = await db
      .insert(browserSessions)
      .values({
        chatThreadId: context.chatThreadId,
        runId: context.runId,
        orgId: context.orgId,
        userId: context.userId,
        name: args.name,
        status: "creating",
        proxyCountryCode: args.proxyCountryCode,
        timeoutMinutes: BROWSER_PROVIDER_TIMEOUT_MINUTES,
        updatedAt: nowDate(),
      })
      .onConflictDoNothing({
        target: browserSessions.chatThreadId,
        where: sql`${browserSessions.status} IN ('creating', 'active', 'resuming', 'stopping')`,
      })
      .returning(BROWSER_SESSION_SELECTION);
    signal.throwIfAborted();
    if (!browser) {
      return conflict(
        "This chat thread already has an active managed browser",
        "BROWSER_THREAD_ACTIVE",
      );
    }
    return {
      kind: "ok",
      value: browser,
    };
  },
);

const createBrowserForContext$ = command(
  async (
    { get, set },
    args: {
      readonly context: BrowserRunContext;
      readonly input: BrowserCreateInput;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const profile = await set(getOrCreateBrowserProfile$, args.context);
    signal.throwIfAborted();
    if (profile.kind === "error") {
      return profile;
    }
    const claimed = await set(
      claimFreshBrowser$,
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
      get(rootSignal$),
    );
    signal.throwIfAborted();
    if (connection.kind === "superseded") {
      return connection.error;
    }
    if (connection.kind === "error") {
      await db
        .update(browserSessions)
        .set({ status: "error", updatedAt: nowDate() })
        .where(
          and(
            eq(browserSessions.id, claimed.value.id),
            eq(browserSessions.chatThreadId, claimed.value.chatThreadId),
            eq(browserSessions.orgId, claimed.value.orgId),
            eq(browserSessions.userId, claimed.value.userId),
            eq(browserSessions.runId, args.context.runId),
            eq(browserSessions.status, claimed.value.status),
            eq(browserSessions.updatedAt, claimed.value.updatedAt),
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
    const context = await set(resolveRunContext$, args.actor);
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
    const instance = await set(loadActiveInstance$, browser.chatThreadId);
    signal.throwIfAborted();
    if (!instance) {
      const suspended = await set(
        suspendBrowserWithoutActiveInstance$,
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
      const leased = await set(
        touchInstanceLease$,
        instance.providerSessionId,
        signal,
      );
      const screen = await set(
        loadBrowserScreen$,
        instance.providerSessionId,
        signal,
      );
      const screenshotUrl = await set(
        loadBrowserScreenshotUrl$,
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
        },
      };
    }
    await set(
      stopActiveBrowserInstance$,
      {
        chatThreadId: browser.chatThreadId,
        providerSessionId: instance.providerSessionId,
        orgId: browser.orgId,
        userId: browser.userId,
      },
      "provider",
      { stopProvider: false },
      signal,
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

const claimBrowserForResume$ = command(
  async (
    { set },
    context: BrowserRunContext,
    signal: AbortSignal,
  ): Promise<ResumeClaim> => {
    const db = set(writeDb$);
    const result = await settle(
      (async (): Promise<ResumeClaim> => {
        signal.throwIfAborted();
        const [run] = await db
          .select({ status: agentRuns.status })
          .from(agentRuns)
          .where(eq(agentRuns.id, context.runId))
          .limit(1);
        if (
          context.requireLiveRun &&
          (!run || isTerminalRunStatus(run.status))
        ) {
          return conflict("The chat run already ended", "BROWSER_RUN_ENDED");
        }
        const [owned] = await db
          .select(BROWSER_SESSION_SELECTION)
          .from(browserSessions)
          .where(
            and(
              eq(browserSessions.chatThreadId, context.chatThreadId),
              inArray(browserSessions.status, [...OWNED_BROWSER_STATUSES]),
            ),
          )
          .limit(1);
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
        const [current] = await db
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
        if (!current) {
          return { kind: "missing" };
        }
        const [claimed] = await db
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
              eq(browserSessions.id, current.id),
              eq(browserSessions.chatThreadId, current.chatThreadId),
              eq(browserSessions.orgId, context.orgId),
              eq(browserSessions.userId, context.userId),
              eq(browserSessions.status, current.status),
              inArray(browserSessions.status, ["suspended", "error"]),
              eq(browserSessions.updatedAt, current.updatedAt),
            ),
          )
          .returning(BROWSER_SESSION_SELECTION);
        return claimed
          ? { kind: "claimed", browser: claimed }
          : conflict("The managed browser is busy", "BROWSER_BUSY");
      })(),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (isUniqueViolation(result.error, "uq_browser_sessions_thread_owned")) {
        return conflict("The managed browser is busy", "BROWSER_BUSY");
      }
      throw result.error;
    }
    signal.throwIfAborted();
    return result.value;
  },
);

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
    { get, set },
    args: {
      readonly context: BrowserRunContext;
      readonly current: BrowserSessionRow;
    },
    signal: AbortSignal,
  ): Promise<ReuseLiveBrowser> => {
    const db = get(db$);
    const chatThreadId = args.context.chatThreadId;
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
    signal.throwIfAborted();
    const owned = row ?? null;
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
    { get, set },
    args: {
      readonly context: BrowserRunContext;
      readonly current: BrowserSessionRow;
    },
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserConnection>> => {
    const db = set(writeDb$);
    const { context } = args;

    const claim = await set(claimBrowserForResume$, context, signal);
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
      get(rootSignal$),
    );
    signal.throwIfAborted();
    if (connection.kind === "superseded") {
      return connection.error;
    }
    if (connection.kind === "error") {
      await db
        .update(browserSessions)
        .set({ status: "error", updatedAt: nowDate() })
        .where(
          and(
            eq(browserSessions.id, claim.browser.id),
            eq(browserSessions.chatThreadId, claim.browser.chatThreadId),
            eq(browserSessions.orgId, claim.browser.orgId),
            eq(browserSessions.userId, claim.browser.userId),
            eq(browserSessions.runId, context.runId),
            eq(browserSessions.status, claim.browser.status),
            eq(browserSessions.updatedAt, claim.browser.updatedAt),
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
    const { context } = args;

    const current = await set(loadCurrentBrowser$, context);
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
    const context = await set(resolveRunContext$, actor);
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
    args: BrowserSessionAccess,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserMutation>> => {
    const context = await set(resolveViewerStartContext$, args);
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
    // Keep lifecycle responses compatible with existing clients. The
    // first-party viewer obtains CDP through its session-only endpoint.
    return {
      kind: "ok",
      value: {
        browser: connection.value.browser,
      },
    };
  },
);

export const closeBrowserForThread$ = command(
  async (
    { set },
    args: BrowserSessionAccess,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<Record<string, never>>> => {
    const thread = await set(loadOwnedBrowserSidebarThread$, args);
    signal.throwIfAborted();
    if (!thread) {
      return notFound();
    }
    const accessError = await set(browserSessionAccessError$, thread, args);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    // Closing the viewer does not stop the browser.
    return { kind: "ok", value: {} };
  },
);

const leaseInstanceForBrowser$ = command(
  async (
    { set },
    browser: BrowserSessionRow,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserSession>> => {
    const instance = await set(loadActiveInstance$, browser.chatThreadId);
    signal.throwIfAborted();
    const leased = instance
      ? await set(touchInstanceLease$, instance.providerSessionId, signal)
      : null;
    if (!leased) {
      return conflict(
        "This managed browser is no longer live; resume it to keep working in it",
        "BROWSER_NOT_LIVE",
      );
    }
    const [screen, screenshotUrl] = await Promise.all([
      set(loadBrowserScreen$, leased.providerSessionId, signal),
      set(loadBrowserScreenshotUrl$, browser.chatThreadId, signal),
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
    const context = await set(resolveRunContext$, actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    const browser = await set(loadCurrentBrowser$, context.value);
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
    const browser = await set(loadOwnedBrowser$, access);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    const accessError = await set(browserSessionAccessError$, browser, access);
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
    const browser = await set(loadOwnedBrowser$, access);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    const accessError = await set(browserSessionAccessError$, browser, access);
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
    const instance = await set(loadActiveInstance$, browser.chatThreadId);
    signal.throwIfAborted();
    if (!instance) {
      return conflict(
        "This managed browser is no longer live; resume it before resizing it",
        "BROWSER_NOT_LIVE",
      );
    }
    const screen = await set(
      loadBrowserScreen$,
      instance.providerSessionId,
      signal,
    );
    if (!screen) {
      return conflict(
        "This managed browser was started before window resizing was enabled; resume it before resizing it",
        "BROWSER_RESIZE_UNSUPPORTED",
      );
    }
    const touched = await set(
      touchInstanceLease$,
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
    const persisted = await set(
      persistBrowserScreen$,
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
    const row = await set(loadOwnedBrowser$, access);
    signal.throwIfAborted();
    if (!row) {
      return notFound();
    }
    const accessError = await set(browserSessionAccessError$, row, access);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    const screenshotUrl = await set(
      loadBrowserScreenshotUrl$,
      row.chatThreadId,
      signal,
    );
    let liveUrl: string | null = null;
    let idleExpiresAt: Date | null = null;
    let screen: BrowserScreen | null = null;
    if (row.status === "active") {
      const instance = await set(loadActiveInstance$, row.chatThreadId);
      signal.throwIfAborted();
      if (instance) {
        idleExpiresAt = instance.idleExpiresAt;
        screen = await set(
          loadBrowserScreen$,
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

export const getBrowserViewerConnection$ = command(
  async (
    { set },
    access: BrowserSessionAccess,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserViewerConnection>> => {
    const browser = await set(loadOwnedBrowser$, access);
    signal.throwIfAborted();
    if (!browser) {
      return notFound();
    }
    const accessError = await set(browserSessionAccessError$, browser, access);
    signal.throwIfAborted();
    if (accessError) {
      return accessError;
    }
    const instance =
      browser.status === "active"
        ? await set(loadActiveInstance$, browser.chatThreadId)
        : null;
    signal.throwIfAborted();
    if (!instance) {
      return conflict(
        "This managed browser is no longer live",
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
        "This managed browser is no longer live",
        "BROWSER_NOT_LIVE",
      );
    }
    const connection = await providerCall(
      resolveBrowserUseViewerConnection(
        provider.value.cdpUrl,
        provider.value.liveUrl,
        signal,
      ),
    );
    signal.throwIfAborted();
    return connection.kind === "error"
      ? connection
      : {
          kind: "ok",
          value: {
            cdpUrl: connection.value,
            extension: browserUseNativeConnection(provider.value).extension,
          },
        };
  },
);

export const getCurrentBrowser$ = command(
  async (
    { set },
    actor: BrowserActor,
    signal: AbortSignal,
  ): Promise<BrowserServiceResult<BrowserSession>> => {
    const context = await set(resolveRunContext$, actor);
    signal.throwIfAborted();
    if (context.kind === "error") {
      return context;
    }
    const browser = await set(loadCurrentBrowser$, context.value);
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
        await set(
          stopActiveBrowserInstance$,
          target,
          "reconcile",
          {
            stopProvider: false,
            saveTabSnapshot: false,
          },
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
    uncutBrowserOwner(),
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
        .where(
          eq(
            browserUserActionRequests.chatThreadId,
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
          uncutBrowserOwner(),
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
              .where(
                eq(
                  browserUserActionRequests.chatThreadId,
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
      { stopProvider },
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
