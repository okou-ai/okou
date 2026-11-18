import { browserOwnerProfiles as profiles } from "@okouai/db/schema/browser-owner";
import { browserChatSessions as windows } from "@okouai/db/schema/browser-chat-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { browserSessionScreenshotDeletions } from "@okouai/db/schema/browser-screenshot-deletion";
import { command } from "ccstate";
import {
  BrowserBridgeError,
  CdpConnectionError,
} from "@okouai/browser-extension-client";
import {
  browserChatWindow,
  type BrowserChatWindow,
} from "./browser-chat-session";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  notExists,
  or,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { ZodError } from "zod";
import { isForeignKeyViolation, safeSqlStateCode } from "../../lib/pg-errors";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { recordBrowserLifecycleFact } from "./browser-lifecycle-telemetry";
import { db$, writeDb$ } from "../external/db";
import { publishBrowserSessionChangedSafely } from "../external/realtime";
import { joinAll, settleIncludingAbort } from "../utils";
import {
  BrowserUseCdpCommandError,
  BrowserUseProviderError,
  BrowserUseWindowHealthError,
  BrowserUseWindowHealthTimeoutError,
  browserUseWindowsExist,
  browserUseNativeConnection,
  tryCloseBrowserUseWindow,
  findBrowserUseSession,
  findBrowserUseSessionByInstance,
  stopBrowserUseSessionForCleanup,
  type BrowserUseNativeConnection,
  type BrowserUseSession,
  type BrowserUseWindowHealth,
} from "./browser-use.service";
import {
  captureBrowserSnapshot$,
  browserLifetime,
  browserSnapshotPublication,
} from "./browser-snapshot.service";

const BATCH_SIZE = 20;
const L = logger("BrowserReconcile");
type Profile = typeof profiles.$inferSelect;
type Window = BrowserChatWindow;
interface Owner {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId?: string;
  // Open can retire its previous window before publishing the new one.
  readonly operationId?: string;
}
interface Candidate {
  readonly profile: Profile;
  readonly window: Window;
  readonly threadId: string | null;
  readonly operationId?: string;
}

interface RetirementProgress {
  phase:
    | "read-window"
    | "find-provider"
    | "check-native-window"
    | "mark-provider-gone"
    | "record-healthy-window"
    | "prepare-snapshot"
    | "claim-retirement"
    | "close-native-window"
    | "release-window"
    | "publish-window-change";
}

const RETIREMENT_PROVIDER_ERROR_CODES = Object.freeze([
  "BROWSER_USE_NOT_CONFIGURED",
  "BROWSER_USE_AUTH_ERROR",
  "BROWSER_USE_CAPACITY",
  "BROWSER_USE_ERROR",
  "BROWSER_USE_INVALID_RESPONSE",
  "BROWSER_USE_OUTPUT_TOO_LARGE",
  "BROWSER_USE_TIMEOUT",
]);

/** Class names are fixed labels, never arbitrary provider-controlled names. */
function nativeHealthErrorClass(error: unknown) {
  if (error instanceof CdpConnectionError) {
    return "CdpConnectionError";
  }
  if (error instanceof BrowserBridgeError) {
    return "BrowserBridgeError";
  }
  if (error instanceof ZodError) {
    return "ZodError";
  }
  if (error instanceof DOMException) {
    return "DOMException";
  }
  if (error instanceof TypeError) {
    return "TypeError";
  }
  if (error instanceof SyntaxError) {
    return "SyntaxError";
  }
  if (error instanceof RangeError) {
    return "RangeError";
  }
  return error instanceof Error ? "Error" : "unknown";
}

function nativeConnectionFailure(error: unknown) {
  const connection =
    error instanceof CdpConnectionError
      ? error.connection
      : error instanceof BrowserBridgeError
        ? error.diagnostics.connection
        : undefined;
  if (!connection) {
    return undefined;
  }
  return {
    socketSource: connection.source,
    socketPhase: connection.phase,
    socketReadyState: connection.ready_state,
    ...(connection.code !== undefined ? { closeCode: connection.code } : {}),
    ...(connection.was_clean !== undefined
      ? { wasClean: connection.was_clean }
      : {}),
  };
}

/** Never pass provider messages, validation input or SQL to the logger. */
function browserWindowFailure(error: unknown) {
  if (error instanceof BrowserUseWindowHealthError) {
    return {
      errorKind: error.phase === "validation" ? "validation" : "transport",
      nativePhase: error.phase,
      errorClass: nativeHealthErrorClass(error.cause),
      ...nativeConnectionFailure(error.cause),
    };
  }
  const connection = nativeConnectionFailure(error);
  if (connection) {
    return {
      errorKind: "transport",
      errorClass: nativeHealthErrorClass(error),
      ...connection,
    };
  }
  const sqlState = safeSqlStateCode(error);
  if (sqlState) {
    return { errorKind: "database", errorCode: sqlState };
  }
  if (error instanceof BrowserUseProviderError) {
    return {
      errorKind: "provider",
      providerStatus: error.status,
      ...(error instanceof BrowserUseWindowHealthTimeoutError
        ? { nativePhase: error.phase }
        : {}),
      ...(RETIREMENT_PROVIDER_ERROR_CODES.includes(error.code)
        ? { errorCode: error.code }
        : {}),
    };
  }
  if (error instanceof BrowserUseCdpCommandError) {
    return {
      errorKind: "cdp",
      ...(typeof error.code === "number" && Number.isSafeInteger(error.code)
        ? { errorCode: error.code }
        : {}),
    };
  }
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { errorKind: "timeout" };
  }
  return { errorKind: error instanceof Error ? "error" : "unknown" };
}

function ownerScope(owner: Owner | null) {
  return owner
    ? and(eq(profiles.orgId, owner.orgId), eq(profiles.userId, owner.userId))
    : undefined;
}

function openNeedsReclamation(owner: Owner | null) {
  if (!owner?.chatThreadId) {
    return undefined;
  }
  // A healthy chat must not wait for a sibling's failed capture or close.
  const current = alias(windows, "requested_browser_window");
  const at = nowDate();
  return notExists(
    new QueryBuilder()
      .select({ id: current.chatThreadId })
      .from(current)
      .where(
        and(
          eq(current.chatThreadId, owner.chatThreadId),
          eq(current.instanceId, profiles.instanceId),
          eq(current.state, "active"),
          gt(current.expiresAt, at),
          eq(profiles.status, "active"),
          gt(profiles.timeoutAt, at),
        ),
      ),
  );
}

function exactProfile(profile: Profile) {
  return and(
    eq(profiles.id, profile.id),
    eq(profiles.orgId, profile.orgId),
    eq(profiles.userId, profile.userId),
    eq(profiles.instanceId, profile.instanceId),
    profile.providerSessionId === null
      ? isNull(profiles.providerSessionId)
      : eq(profiles.providerSessionId, profile.providerSessionId),
  );
}

function orphanedWindow() {
  return notExists(
    new QueryBuilder()
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.id, windows.chatThreadId)),
  );
}

function noWindows(state?: Window["state"]) {
  return notExists(
    new QueryBuilder()
      .select({ id: windows.chatThreadId })
      .from(windows)
      .where(
        and(
          eq(windows.instanceId, profiles.instanceId),
          state ? eq(windows.state, state) : undefined,
        ),
      ),
  );
}

function needsWindowRetirement(
  profile: Profile,
  window: Window,
  threadId: string | null,
  at: Date,
) {
  return (
    window.state === "closing" ||
    threadId === null ||
    window.expiresAt <= at ||
    profile.timeoutAt <= at
  );
}

type BrowserWindowObservation =
  | {
      readonly kind: "gone";
      readonly providerStatus: "missing" | "stopped";
    }
  | { readonly kind: "healthy"; readonly observedAt: Date }
  | { readonly kind: "unobserved" }
  | {
      readonly kind: "retire";
      readonly connection: BrowserUseNativeConnection | null;
      readonly nativeMissing: boolean;
    };

type ProviderObservation =
  | { readonly ok: true; readonly value: BrowserUseSession | null }
  | { readonly ok: false; readonly error: unknown };
interface WindowObservation {
  readonly provider: ProviderObservation;
  readonly health?: BrowserUseWindowHealth;
}

/** Captured IO never overrides current expiry or exact binding authority. */
function observeBrowserWindow(
  target: Candidate,
  observation: WindowObservation,
  progress: RetirementProgress,
): BrowserWindowObservation {
  const { profile, window } = target;
  progress.phase = "find-provider";
  if (!profile.providerSessionId) {
    throw new Error("A shared Browser window has no provider session");
  }
  const found = observation.provider;
  const retirementDue = needsWindowRetirement(
    profile,
    window,
    target.threadId,
    nowDate(),
  );
  if (!found.ok) {
    if (!retirementDue) {
      throw found.error;
    }
    return { kind: "retire", connection: null, nativeMissing: false };
  }
  const provider = found.value;
  if (!provider || provider.status === "stopped") {
    return {
      kind: "gone",
      providerStatus: provider ? "stopped" : "missing",
    };
  }
  if (!provider.cdpUrl) {
    if (retirementDue) {
      return { kind: "retire", connection: null, nativeMissing: false };
    }
    throw new BrowserUseProviderError(
      502,
      "BROWSER_USE_INVALID_RESPONSE",
      "The active Browser has no native connection",
    );
  }
  const connection = browserUseNativeConnection(provider);
  if (retirementDue) {
    return {
      kind: "retire",
      connection,
      nativeMissing:
        observation.health?.ok === true && !observation.health.value,
    };
  }
  progress.phase = "check-native-window";
  const health = observation.health;
  // A selected due window may have been renewed before its exact binding read.
  // It has no positive native observation and must remain live for a later sweep.
  if (!health) {
    return { kind: "unobserved" };
  }
  if (!health.ok) {
    throw health.error;
  }
  if (health.value) {
    return { kind: "healthy", observedAt: health.observedAt };
  }
  return {
    kind: "retire",
    connection,
    nativeMissing: true,
  };
}

const claimBrowserWindowRetirement$ = command(
  async (
    { set },
    target: Candidate & {
      readonly connection: BrowserUseNativeConnection | null;
      readonly nativeMissing: boolean;
    },
    progress: RetirementProgress,
    signal: AbortSignal,
  ): Promise<Window | null> => {
    const { profile, window: current, connection, nativeMissing } = target;
    const owner = {
      orgId: profile.orgId,
      userId: profile.userId,
      chatThreadId: current.chatThreadId,
    };
    const identity = browserLifetime(owner, profile, current);
    const db = set(writeDb$);
    progress.phase = "prepare-snapshot";
    const capture =
      !nativeMissing && target.threadId !== null && connection !== null
        ? await set(
            captureBrowserSnapshot$,
            { owner, window: current, ...connection, purpose: "retirement" },
            signal,
          )
        : null;
    signal.throwIfAborted();
    const at = nowDate();
    // Claim retirement and publish recovery in one UPDATE of this chat row.
    progress.phase = "claim-retirement";
    const [closing] = await db
      .update(windows)
      .set({
        state: "closing",
        updatedAt: at,
        ...(capture ? browserSnapshotPublication(capture).set : {}),
      })
      .where(
        and(
          identity,
          eq(windows.state, "active"),
          or(
            lte(windows.expiresAt, at),
            exists(
              new QueryBuilder()
                .select({ id: profiles.id })
                .from(profiles)
                .where(and(exactProfile(profile), lte(profiles.timeoutAt, at))),
            ),
            orphanedWindow(),
            nativeMissing ? eq(windows.state, "active") : undefined,
          ),
        ),
      )
      .returning({
        chatThreadId: windows.chatThreadId,
        instanceId: windows.instanceId,
        state: windows.state,
        primaryWindowId: windows.primaryWindowId,
        expiresAt: windows.expiresAt,
        idleExpired: lte(windows.expiresAt, at).mapWith(pgBooleanDecoder),
        instanceExpired: exists(
          new QueryBuilder()
            .select({ id: profiles.id })
            .from(profiles)
            .where(and(exactProfile(profile), lte(profiles.timeoutAt, at))),
        ).mapWith(pgBooleanDecoder),
        threadDeleted: orphanedWindow().mapWith(pgBooleanDecoder),
      });
    signal.throwIfAborted();
    if (!closing) {
      return null;
    }
    // Capture can race renewal/deletion. Only the accepted SQL row is evidence.
    recordBrowserLifecycleFact({
      lifecycleEvent: "retirement-claimed",
      instanceId: closing.instanceId,
      primaryWindowId: closing.primaryWindowId,
      idleExpired: closing.idleExpired,
      instanceExpired: closing.instanceExpired,
      threadDeleted: closing.threadDeleted,
      // False means absence was not confirmed, not that native health passed.
      nativeMissing,
    });
    return browserChatWindow(closing);
  },
);

const markBrowserProviderGone$ = command(
  async (
    { set },
    profile: Profile,
    providerStatus: "missing" | "stopped",
    signal: AbortSignal,
  ): Promise<void> => {
    // Preserve accepted snapshots; the provider confirms no live native state.
    const affected = await set(writeDb$)
      .update(windows)
      .set({ state: "closing", updatedAt: nowDate() })
      .where(
        and(
          eq(windows.instanceId, profile.instanceId),
          eq(windows.state, "active"),
          exists(
            new QueryBuilder()
              .select({ id: profiles.id })
              .from(profiles)
              .where(exactProfile(profile)),
          ),
        ),
      )
      .returning({
        instanceId: windows.instanceId,
        primaryWindowId: windows.primaryWindowId,
      });
    signal.throwIfAborted();
    for (const binding of affected) {
      recordBrowserLifecycleFact({
        lifecycleEvent: "provider-gone",
        ...binding,
        providerStatus,
      });
    }
  },
);

const retireBrowserWindow$ = command(
  async (
    { get, set },
    target: Candidate,
    observation: WindowObservation,
    progress: RetirementProgress,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const { profile } = target;
    const owner = {
      orgId: profile.orgId,
      userId: profile.userId,
      chatThreadId: target.window.chatThreadId,
    };
    const identity = browserLifetime(owner, profile, target.window);
    progress.phase = "read-window";
    const [currentRow] = await get(db$)
      .select({
        chatThreadId: windows.chatThreadId,
        instanceId: windows.instanceId,
        state: windows.state,
        primaryWindowId: windows.primaryWindowId,
        expiresAt: windows.expiresAt,
      })
      .from(windows)
      .where(identity)
      .limit(1);
    signal.throwIfAborted();
    let current = currentRow ? browserChatWindow(currentRow) : null;
    if (!current) {
      return null;
    }
    const observed = observeBrowserWindow(
      { ...target, window: current },
      observation,
      progress,
    );
    if (observed.kind === "unobserved") {
      return null;
    }
    if (observed.kind === "gone") {
      progress.phase = "mark-provider-gone";
      await set(
        markBrowserProviderGone$,
        profile,
        observed.providerStatus,
        signal,
      );
      return null;
    }
    const db = set(writeDb$);
    if (observed.kind === "healthy") {
      // Rotate healthy observations as well as failures in the bounded sweep.
      progress.phase = "record-healthy-window";
      await db
        .update(windows)
        .set({ updatedAt: observed.observedAt })
        .where(identity);
      signal.throwIfAborted();
      return null;
    }
    const { connection, nativeMissing } = observed;
    if (current.state === "active") {
      const closing = await set(
        claimBrowserWindowRetirement$,
        { ...target, window: current, connection, nativeMissing },
        progress,
        signal,
      );
      signal.throwIfAborted();
      if (!closing) {
        return null;
      }
      current = closing;
    } else {
      // A resumed claim cannot reconstruct its original retirement cause.
      recordBrowserLifecycleFact({
        lifecycleEvent: "retirement-resumed",
        instanceId: profile.instanceId,
        primaryWindowId: current.primaryWindowId,
        nativeMissing,
      });
    }
    if (connection && !nativeMissing) {
      progress.phase = "close-native-window";
      // The best-effort call below does not acknowledge physical closure.
      recordBrowserLifecycleFact({
        lifecycleEvent: "native-close-requested",
        instanceId: profile.instanceId,
        primaryWindowId: current.primaryWindowId,
      });
      await tryCloseBrowserUseWindow(
        connection,
        current.primaryWindowId,
        signal,
      );
    }
    // Recovery uses only an accepted snapshot, even if fresh capture failed.
    progress.phase = "release-window";
    const [closed] = await db
      .update(windows)
      .set({
        instanceId: null,
        state: null,
        primaryWindowId: null,
        expiresAt: null,
        updatedAt: nowDate(),
      })
      .where(and(identity, eq(windows.state, "closing")))
      .returning({ id: windows.chatThreadId });
    signal.throwIfAborted();
    if (!closed) {
      return null;
    }
    recordBrowserLifecycleFact({
      lifecycleEvent: "binding-released",
      instanceId: profile.instanceId,
      primaryWindowId: current.primaryWindowId,
    });
    if (target.threadId !== null) {
      progress.phase = "publish-window-change";
      await publishBrowserSessionChangedSafely(profile.userId, {
        threadId: current.chatThreadId,
        ...(target.operationId ? { operationId: target.operationId } : {}),
      });
      signal.throwIfAborted();
    }
    return profile.instanceId;
  },
);

const stopEmptyBrowser$ = command(
  async (
    { set },
    candidate: Profile,
    signal: AbortSignal,
  ): Promise<boolean> => {
    const db = set(writeDb$);
    if (candidate.status === "active") {
      // The existing active-instance FK also protects a concurrent admission
      // invisible to this statement's initial no-active-window snapshot.
      const claim = await settleIncludingAbort(
        db
          .update(profiles)
          .set({ status: "stopping", updatedAt: nowDate() })
          .where(
            and(
              exactProfile(candidate),
              eq(profiles.status, "active"),
              noWindows("active"),
            ),
          )
          .returning({ id: profiles.id }),
      );
      signal.throwIfAborted();
      if (!claim.ok) {
        if (isForeignKeyViolation(claim.error)) {
          return false;
        }
        throw claim.error;
      }
      if (claim.value.length === 0) {
        return false;
      }
    }
    if (!candidate.providerSessionId) {
      throw new Error("A shared Browser stop has no provider session");
    }
    const provider = await findBrowserUseSession(
      candidate.providerSessionId,
      signal,
    );
    if (provider?.status === "active") {
      recordBrowserLifecycleFact({
        lifecycleEvent: "provider-stop-requested",
        instanceId: candidate.instanceId,
      });
      await stopBrowserUseSessionForCleanup(
        candidate.providerSessionId,
        signal,
      );
      // HTTP success (including an accepted stop) is not stop acknowledgement.
      const confirmed = await findBrowserUseSession(
        candidate.providerSessionId,
        signal,
      );
      if (confirmed && confirmed.status !== "stopped") {
        throw new Error("Browser provider stop is not confirmed");
      }
    }
    const stopped = db.$with("stopped_browser").as(
      db
        .update(profiles)
        .set({
          status: "stopped",
          browserExtensionId: null,
          updatedAt: nowDate(),
        })
        .where(
          and(
            exactProfile(candidate),
            eq(profiles.status, "stopping"),
            noWindows("active"),
          ),
        )
        .returning({ id: profiles.id, instanceId: profiles.instanceId }),
    );
    const closed = db.$with("closed_browser_windows").as(
      db
        .update(windows)
        .set({
          instanceId: null,
          state: null,
          primaryWindowId: null,
          expiresAt: null,
          updatedAt: nowDate(),
        })
        .where(
          and(
            eq(windows.instanceId, candidate.instanceId),
            eq(windows.state, "closing"),
            exists(new QueryBuilder().select({ id: stopped.id }).from(stopped)),
          ),
        )
        .returning({ chatThreadId: windows.chatThreadId }),
    );
    const [confirmed] = await db.with(stopped, closed).select().from(stopped);
    signal.throwIfAborted();
    if (confirmed) {
      recordBrowserLifecycleFact({
        lifecycleEvent: "provider-stop-confirmed",
        instanceId: confirmed.instanceId,
      });
    }
    return confirmed !== undefined;
  },
);

const recoverBrowserCreations$ = command(
  async ({ get, set }, owner: Owner | null, signal: AbortSignal) => {
    let errors = 0;
    let stopped = 0;
    const creating = await get(db$)
      .select()
      .from(profiles)
      .where(
        and(
          ownerScope(owner),
          eq(profiles.status, "creating"),
          lte(profiles.creationExpiresAt, nowDate()),
        ),
      )
      .orderBy(profiles.updatedAt)
      .limit(BATCH_SIZE);
    signal.throwIfAborted();
    for (const candidate of creating) {
      const recoveryWork = (async () => {
        const providerSessionId = await findBrowserUseSessionByInstance(
          candidate.instanceId,
          signal,
        );
        if (!providerSessionId) {
          // A lost/unfinished POST and a POST never issued remain indistinguishable.
          // A local timeout or empty provider list cannot authorize replacement.
          return;
        }
        const [bound] = await set(writeDb$)
          .update(profiles)
          .set({ providerSessionId, status: "stopping", updatedAt: nowDate() })
          .where(
            and(
              exactProfile(candidate),
              eq(profiles.status, "creating"),
              noWindows(),
            ),
          )
          .returning();
        signal.throwIfAborted();
        if (bound) {
          stopped += (await set(stopEmptyBrowser$, bound, signal)) ? 1 : 0;
        }
      })();
      const recovered = await settleIncludingAbort(recoveryWork);
      signal.throwIfAborted();
      if (!recovered.ok) {
        errors += 1;
        L.warn("Browser creation could not be reconciled", {
          instanceId: candidate.instanceId,
        });
      }
      await set(writeDb$)
        .update(profiles)
        .set({ updatedAt: nowDate() })
        .where(and(exactProfile(candidate), eq(profiles.status, "creating")));
      signal.throwIfAborted();
    }

    return { checked: creating.length, stopped, errors };
  },
);

function browserStopCondition(
  owner: Owner | null,
  closedInstances: readonly string[],
  at: Date,
) {
  return and(
    ownerScope(owner),
    isNotNull(profiles.providerSessionId),
    noWindows("active"),
    or(
      eq(profiles.status, "stopping"),
      and(
        eq(profiles.status, "active"),
        or(
          // Fresh setup keeps its deadline; final retirement stops immediately.
          lte(profiles.creationExpiresAt, at),
          inArray(profiles.instanceId, closedInstances),
          exists(
            new QueryBuilder()
              .select({ id: windows.chatThreadId })
              .from(windows)
              .where(
                and(
                  eq(windows.instanceId, profiles.instanceId),
                  eq(windows.state, "closing"),
                ),
              ),
          ),
        ),
      ),
    ),
  );
}

const reconcileBrowserWindow$ = command(
  async (
    { set },
    row: Candidate,
    observation: WindowObservation,
    signal: AbortSignal,
  ) => {
    const progress: RetirementProgress = { phase: "read-window" };
    const result = await settleIncludingAbort(
      set(retireBrowserWindow$, row, observation, progress, signal),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return { closedInstance: result.value, failed: false };
    }
    // Preserve the original failure even if timestamp rotation also fails.
    L.warn("Browser window reconciliation failed", {
      instanceId: row.profile.instanceId,
      primaryWindowId: row.window.primaryWindowId,
      phase: progress.phase,
      ...browserWindowFailure(result.error),
    });
    await set(writeDb$)
      .update(windows)
      .set({ updatedAt: nowDate() })
      .where(
        and(
          browserLifetime(
            {
              orgId: row.profile.orgId,
              userId: row.profile.userId,
              chatThreadId: row.window.chatThreadId,
            },
            row.profile,
            row.window,
          ),
          inArray(windows.state, ["active", "closing"]),
        ),
      );
    signal.throwIfAborted();
    return { closedInstance: null, failed: true };
  },
);

const reconcileBrowserCandidates$ = command(
  async ({ set }, rows: readonly Candidate[], signal: AbortSignal) => {
    const closedInstances = new Set<string>();
    let errors = 0;
    const groups = new Map<string, Candidate[]>();
    for (const row of rows) {
      const group = groups.get(row.profile.instanceId) ?? [];
      group.push(row);
      groups.set(row.profile.instanceId, group);
    }
    const results: {
      readonly closedInstance: string | null;
      readonly failed: boolean;
    }[] = [];
    const observations: {
      readonly live: readonly Candidate[];
      readonly found: ProviderObservation;
    }[] = [];
    for (const group of groups.values()) {
      const [first] = group;
      if (!first) {
        throw new Error("A Browser reconciliation group has no instance");
      }
      const found = await settleIncludingAbort(async () => {
        if (!first.profile.providerSessionId) {
          throw new Error("A shared Browser window has no provider session");
        }
        return await findBrowserUseSession(
          first.profile.providerSessionId,
          signal,
        );
      });
      signal.throwIfAborted();
      const due: Candidate[] = [];
      const live: Candidate[] = [];
      const observedAt = nowDate();
      for (const row of group) {
        (needsWindowRetirement(
          row.profile,
          row.window,
          row.threadId,
          observedAt,
        )
          ? due
          : live
        ).push(row);
      }
      // Independent expiry gets its own cleanup before any live health wait.
      for (const row of due) {
        results.push(
          await set(reconcileBrowserWindow$, row, { provider: found }, signal),
        );
        signal.throwIfAborted();
      }
      observations.push({ live, found });
    }
    for (const { live, found } of observations) {
      const provider = found.ok ? found.value : null;
      const checks =
        provider?.status === "active" && provider.cdpUrl
          ? await browserUseWindowsExist(
              browserUseNativeConnection(provider),
              live.map((row) => {
                return row.window.primaryWindowId;
              }),
              signal,
            )
          : new Map<number, BrowserUseWindowHealth>();
      signal.throwIfAborted();
      // The shared health wire has closed before snapshot/retirement IO begins.
      for (const row of live) {
        results.push(
          await set(
            reconcileBrowserWindow$,
            row,
            {
              provider: found,
              health: checks.get(row.window.primaryWindowId),
            },
            signal,
          ),
        );
        signal.throwIfAborted();
      }
    }
    for (const result of results) {
      if (result.closedInstance) {
        closedInstances.add(result.closedInstance);
      }
      errors += result.failed ? 1 : 0;
    }
    return { closedInstances: [...closedInstances], errors };
  },
);

const reconcileBrowserWindows$ = command(
  async ({ get, set }, owner: Owner | null, signal: AbortSignal) => {
    const at = nowDate();
    const rows = await get(db$)
      .select({
        profile: profiles,
        window: {
          chatThreadId: windows.chatThreadId,
          instanceId: windows.instanceId,
          state: windows.state,
          primaryWindowId: windows.primaryWindowId,
          expiresAt: windows.expiresAt,
        },
        threadId: chatThreads.id,
      })
      .from(windows)
      .innerJoin(profiles, eq(profiles.instanceId, windows.instanceId))
      .leftJoin(chatThreads, eq(chatThreads.id, windows.chatThreadId))
      .where(
        and(
          ownerScope(owner),
          owner?.chatThreadId
            ? or(
                and(
                  openNeedsReclamation(owner),
                  or(
                    eq(windows.state, "closing"),
                    lte(windows.expiresAt, at),
                    lte(profiles.timeoutAt, at),
                    isNull(chatThreads.id),
                  ),
                ),
                eq(windows.chatThreadId, owner.chatThreadId),
              )
            : undefined,
          inArray(profiles.status, ["active", "stopping"]),
        ),
      )
      .orderBy(windows.updatedAt)
      .limit(BATCH_SIZE);
    signal.throwIfAborted();
    const candidates = rows.map((row) => {
      const binding = browserChatWindow(row.window);
      if (!binding) {
        throw new Error("A bound Browser chat has no live window");
      }
      return { ...row, window: binding, operationId: owner?.operationId };
    });
    const reconciled = await set(
      reconcileBrowserCandidates$,
      candidates,
      signal,
    );
    signal.throwIfAborted();
    let errors = reconciled.errors;
    const empty = await get(db$)
      .select()
      .from(profiles)
      .where(browserStopCondition(owner, reconciled.closedInstances, nowDate()))
      .orderBy(profiles.updatedAt)
      .limit(BATCH_SIZE);
    signal.throwIfAborted();
    let stopped = 0;
    for (const candidate of empty) {
      const result = await settleIncludingAbort(
        set(stopEmptyBrowser$, candidate, signal),
      );
      signal.throwIfAborted();
      if (result.ok) {
        stopped += result.value ? 1 : 0;
      } else {
        errors += 1;
        await set(writeDb$)
          .update(profiles)
          .set({ updatedAt: nowDate() })
          .where(and(exactProfile(candidate), eq(profiles.status, "stopping")));
        signal.throwIfAborted();
        L.warn("Browser provider stop could not be confirmed", {
          instanceId: candidate.instanceId,
        });
      }
    }
    return {
      checked: rows.length + empty.length,
      stopped,
      errors,
    };
  },
);

/** Retain recovery until the chat itself is deleted, then hand off its preview. */
const deleteOrphanedBrowserChats$ = command(
  async ({ set }, owner: Owner | null, signal: AbortSignal) => {
    const db = set(writeDb$);
    const scope = owner
      ? and(eq(windows.orgId, owner.orgId), eq(windows.userId, owner.userId))
      : undefined;
    const candidates = await db
      .select({ id: windows.chatThreadId })
      .from(windows)
      .where(and(scope, isNull(windows.instanceId)))
      .orderBy(windows.updatedAt, windows.chatThreadId)
      .limit(BATCH_SIZE);
    signal.throwIfAborted();
    // Candidate order does not order a batch DELETE/UPDATE's row locks. Commit
    // each chat independently so overlapping sweeps cannot hold one chat while
    // waiting for another. Recheck ownership and inactivity after selection.
    for (const candidate of candidates) {
      const inactive = and(
        scope,
        eq(windows.chatThreadId, candidate.id),
        isNull(windows.instanceId),
      );
      const removed = db.$with("deleted_orphaned_browser_chats").as(
        db.delete(windows).where(and(inactive, orphanedWindow())).returning({
          screenshotObjectKey: windows.screenshotObjectKey,
          chatThreadId: windows.chatThreadId,
          updatedAt: windows.updatedAt,
        }),
      );
      // The live-parent predicate is disjoint from deletion in this statement's
      // snapshot. Retained recovery still rotates through the bounded batch.
      const retained = db.$with("retained_browser_chats").as(
        db
          .update(windows)
          .set({ updatedAt: nowDate() })
          .where(and(inactive, not(orphanedWindow())))
          .returning({ id: windows.chatThreadId }),
      );
      // Keep the exact deleted preview and its durable cleanup handoff atomic.
      await db
        .with(removed, retained)
        .insert(browserSessionScreenshotDeletions)
        .select(
          new QueryBuilder()
            .select({
              objectKey: removed.screenshotObjectKey,
              chatThreadId: removed.chatThreadId,
              createdAt: removed.updatedAt,
            })
            .from(removed)
            .where(isNotNull(removed.screenshotObjectKey))
            .getSQL(),
        )
        .onConflictDoNothing();
      signal.throwIfAborted();
    }
  },
);

/** Independent creation recovery cannot hold up existing windows or their final stop. */
export const reconcileBrowsers$ = command(
  async ({ set }, owner: Owner | null, signal: AbortSignal) => {
    const [creation, windows] = await joinAll([
      set(recoverBrowserCreations$, owner, signal),
      set(reconcileBrowserWindows$, owner, signal),
    ]);
    signal.throwIfAborted();
    await set(deleteOrphanedBrowserChats$, owner, signal);
    return {
      checked: creation.checked + windows.checked,
      stopped: creation.stopped + windows.stopped,
      errors: creation.errors + windows.errors,
    };
  },
);
