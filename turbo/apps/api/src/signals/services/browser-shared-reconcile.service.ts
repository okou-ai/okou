import { browserOwnerProfiles as profiles } from "@okouai/db/schema/browser-owner";
import { browserChatSessions as windows } from "@okouai/db/schema/browser-chat-session";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  browserSessionInstances,
  browserSessionScreenshotDeletions,
} from "@okouai/db/schema/browser-session";
import { command } from "ccstate";
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
  browserUseWindowExists,
  browserUseNativeConnection,
  tryCloseBrowserUseWindow,
  findBrowserUseSession,
  findBrowserUseSessionByInstance,
  stopBrowserUseSessionForCleanup,
  type BrowserUseNativeConnection,
} from "./browser-use.service";
import {
  captureSharedSnapshot$,
  sharedBrowserLifetime,
  sharedSnapshotPublication,
} from "./browser-shared-snapshot.service";

const BATCH_SIZE = 20;
const L = logger("SharedBrowserReconcile");
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

/** Never pass provider messages, validation input or SQL to the logger. */
function sharedWindowFailure(error: unknown) {
  if (error instanceof BrowserUseWindowHealthError) {
    return {
      errorKind: error.phase === "validation" ? "validation" : "transport",
      nativePhase: error.phase,
      errorClass: nativeHealthErrorClass(error.cause),
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

type SharedWindowObservation =
  | {
      readonly kind: "gone";
      readonly providerStatus: "missing" | "stopped";
    }
  | { readonly kind: "healthy"; readonly observedAt: Date }
  | {
      readonly kind: "retire";
      readonly connection: BrowserUseNativeConnection | null;
      readonly nativeMissing: boolean;
    };

/** Remote observation cannot turn independently expired usage into live usage. */
async function observeSharedWindow(
  target: Candidate,
  progress: RetirementProgress,
  signal: AbortSignal,
): Promise<SharedWindowObservation> {
  const { profile, window } = target;
  progress.phase = "find-provider";
  if (!profile.providerSessionId) {
    throw new Error("A shared Browser window has no provider session");
  }
  const found = await settleIncludingAbort(
    findBrowserUseSession(profile.providerSessionId, signal),
  );
  signal.throwIfAborted();
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
    return { kind: "retire", connection, nativeMissing: false };
  }
  progress.phase = "check-native-window";
  const health = await settleIncludingAbort(
    browserUseWindowExists(connection, window.primaryWindowId, signal),
  );
  signal.throwIfAborted();
  const at = nowDate();
  const dueAfterHealth = needsWindowRetirement(
    profile,
    window,
    target.threadId,
    at,
  );
  if (!health.ok && !dueAfterHealth) {
    throw health.error;
  }
  if (health.ok && health.value && !dueAfterHealth) {
    return { kind: "healthy", observedAt: at };
  }
  return {
    kind: "retire",
    connection,
    nativeMissing: health.ok && !health.value,
  };
}

const claimSharedWindowRetirement$ = command(
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
    const identity = sharedBrowserLifetime(owner, profile, current);
    const db = set(writeDb$);
    progress.phase = "prepare-snapshot";
    const capture =
      !nativeMissing && target.threadId !== null && connection !== null
        ? await set(
            captureSharedSnapshot$,
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
        ...(capture ? sharedSnapshotPublication(capture).set : {}),
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
        idleExpired: lte(windows.expiresAt, at).mapWith(Boolean),
        instanceExpired: exists(
          new QueryBuilder()
            .select({ id: profiles.id })
            .from(profiles)
            .where(and(exactProfile(profile), lte(profiles.timeoutAt, at))),
        ).mapWith(Boolean),
        threadDeleted: orphanedWindow().mapWith(Boolean),
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

const markSharedProviderGone$ = command(
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

const retireSharedWindow$ = command(
  async (
    { get, set },
    target: Candidate,
    progress: RetirementProgress,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const { profile } = target;
    const owner = {
      orgId: profile.orgId,
      userId: profile.userId,
      chatThreadId: target.window.chatThreadId,
    };
    const identity = sharedBrowserLifetime(owner, profile, target.window);
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
    const observed = await observeSharedWindow(
      { ...target, window: current },
      progress,
      signal,
    );
    signal.throwIfAborted();
    if (observed.kind === "gone") {
      progress.phase = "mark-provider-gone";
      await set(
        markSharedProviderGone$,
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
        claimSharedWindowRetirement$,
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

const stopEmptySharedBrowser$ = command(
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
        throw new Error("Shared Browser provider stop is not confirmed");
      }
    }
    const stopped = db.$with("stopped_shared_browser").as(
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
    const closed = db.$with("closed_shared_browser_windows").as(
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

const recoverSharedCreations$ = command(
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
              notExists(
                new QueryBuilder()
                  .select({ id: browserSessionInstances.providerSessionId })
                  .from(browserSessionInstances)
                  .where(
                    eq(
                      browserSessionInstances.providerSessionId,
                      providerSessionId,
                    ),
                  ),
              ),
            ),
          )
          .returning();
        signal.throwIfAborted();
        if (bound) {
          stopped += (await set(stopEmptySharedBrowser$, bound, signal))
            ? 1
            : 0;
        }
      })();
      const recovered = await settleIncludingAbort(recoveryWork);
      signal.throwIfAborted();
      if (!recovered.ok) {
        errors += 1;
        L.warn("Shared Browser creation could not be reconciled", {
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

function sharedBrowserStopCondition(
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

const reconcileSharedWindows$ = command(
  async ({ get, set }, owner: Owner | null, signal: AbortSignal) => {
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
                openNeedsReclamation(owner),
                eq(windows.chatThreadId, owner.chatThreadId),
              )
            : undefined,
          inArray(profiles.status, ["active", "stopping"]),
        ),
      )
      .orderBy(windows.updatedAt)
      .limit(BATCH_SIZE);
    signal.throwIfAborted();
    const closedInstances = new Set<string>();
    let errors = 0;
    for (const raw of rows) {
      const binding = browserChatWindow(raw.window);
      if (!binding) {
        throw new Error("A bound Browser chat has no live window");
      }
      const row = {
        ...raw,
        window: binding,
        operationId: owner?.operationId,
      };
      // Each candidate owns its diagnostic progress, including concurrent sweeps.
      const progress: RetirementProgress = { phase: "read-window" };
      const result = await settleIncludingAbort(
        set(retireSharedWindow$, row, progress, signal),
      );
      signal.throwIfAborted();
      if (result.ok) {
        if (result.value) {
          closedInstances.add(result.value);
        }
      } else {
        errors += 1;
        // Preserve the original failure even if timestamp rotation also fails.
        L.warn("Shared Browser window reconciliation failed", {
          instanceId: row.profile.instanceId,
          primaryWindowId: row.window.primaryWindowId,
          phase: progress.phase,
          ...sharedWindowFailure(result.error),
        });
        await set(writeDb$)
          .update(windows)
          .set({ updatedAt: nowDate() })
          .where(
            and(
              sharedBrowserLifetime(
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
      }
    }
    const empty = await get(db$)
      .select()
      .from(profiles)
      .where(sharedBrowserStopCondition(owner, [...closedInstances], nowDate()))
      .orderBy(profiles.updatedAt)
      .limit(BATCH_SIZE);
    signal.throwIfAborted();
    let stopped = 0;
    for (const candidate of empty) {
      const result = await settleIncludingAbort(
        set(stopEmptySharedBrowser$, candidate, signal),
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
        L.warn("Shared Browser provider stop could not be confirmed", {
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
    const candidates = db.$with("inactive_browser_chats").as(
      db
        .select({ id: windows.chatThreadId })
        .from(windows)
        .where(and(scope, isNull(windows.instanceId)))
        .orderBy(windows.updatedAt)
        .limit(BATCH_SIZE),
    );
    const removed = db.$with("deleted_orphaned_browser_chats").as(
      db
        .delete(windows)
        .where(
          and(
            scope,
            isNull(windows.instanceId),
            orphanedWindow(),
            inArray(
              windows.chatThreadId,
              new QueryBuilder().select().from(candidates),
            ),
          ),
        )
        .returning({
          screenshotObjectKey: windows.screenshotObjectKey,
          chatThreadId: windows.chatThreadId,
          updatedAt: windows.updatedAt,
        }),
    );
    // Rotate retained chats in the same bounded observation batch. Its live
    // parent predicate is disjoint from deletion, so each row is mutated once.
    const retained = db.$with("retained_browser_chats").as(
      db
        .update(windows)
        .set({ updatedAt: nowDate() })
        .where(
          and(
            scope,
            isNull(windows.instanceId),
            not(orphanedWindow()),
            inArray(
              windows.chatThreadId,
              new QueryBuilder().select().from(candidates),
            ),
          ),
        )
        .returning({ id: windows.chatThreadId }),
    );
    await db
      .with(candidates, removed, retained)
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
  },
);

/** Independent creation recovery cannot hold up existing windows or their final stop. */
export const reconcileSharedBrowsers$ = command(
  async ({ set }, owner: Owner | null, signal: AbortSignal) => {
    const [creation, windows] = await joinAll([
      set(recoverSharedCreations$, owner, signal),
      set(reconcileSharedWindows$, owner, signal),
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
