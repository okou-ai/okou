import {
  browserOwnerProfiles as profiles,
  browserOwnerWindows as windows,
} from "@okouai/db/schema/browser-owner";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import {
  browserSessionInstances,
  browserSessionTabSnapshots,
} from "@okouai/db/schema/browser-session";
import { command } from "ccstate";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  notExists,
  or,
} from "drizzle-orm";
import { alias, QueryBuilder } from "drizzle-orm/pg-core";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import { logger } from "../../lib/log";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { publishBrowserSessionChangedSafely } from "../external/realtime";
import { joinAll, settleIncludingAbort } from "../utils";
import {
  BrowserUseProviderError,
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
type Window = typeof windows.$inferSelect;
interface Owner {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId?: string;
}
interface Candidate {
  readonly profile: Profile;
  readonly window: Window;
  readonly threadId: string | null;
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
  | { readonly kind: "gone" }
  | { readonly kind: "healthy"; readonly observedAt: Date }
  | {
      readonly kind: "retire";
      readonly connection: BrowserUseNativeConnection | null;
      readonly nativeMissing: boolean;
    };

/** Remote observation cannot turn independently expired usage into live usage. */
async function observeSharedWindow(
  target: Candidate,
  signal: AbortSignal,
): Promise<SharedWindowObservation> {
  const { profile, window } = target;
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
    return { kind: "gone" };
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
    const claimed = db.$with("retired_shared_window").as(
      db
        .update(windows)
        .set({ state: "closing", updatedAt: at })
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
                  .where(
                    and(exactProfile(profile), lte(profiles.timeoutAt, at)),
                  ),
              ),
              orphanedWindow(),
              nativeMissing ? eq(windows.state, "active") : undefined,
            ),
          ),
        )
        .returning(),
    );
    // Enter closing and publish its complete snapshot in one statement.
    // A concurrent loser cannot publish pages observed after partial close.
    const publication = capture
      ? sharedSnapshotPublication(capture, claimed)
      : null;
    const snapshot = publication
      ? db
          .$with("retired_shared_snapshot")
          .as(
            db
              .insert(browserSessionTabSnapshots)
              .select(publication.source)
              .onConflictDoUpdate(publication.conflict)
              .returning({ id: browserSessionTabSnapshots.chatThreadId }),
          )
      : null;
    const [closing] = await (
      snapshot ? db.with(claimed, snapshot) : db.with(claimed)
    )
      .select()
      .from(claimed);
    signal.throwIfAborted();
    if (!closing) {
      return null;
    }
    return closing;
  },
);

const retireSharedWindow$ = command(
  async (
    { get, set },
    target: Candidate,
    signal: AbortSignal,
  ): Promise<string | null> => {
    const { profile } = target;
    const owner = {
      orgId: profile.orgId,
      userId: profile.userId,
      chatThreadId: target.window.chatThreadId,
    };
    const identity = sharedBrowserLifetime(owner, profile, target.window);
    let [current] = await get(db$)
      .select()
      .from(windows)
      .where(identity)
      .limit(1);
    signal.throwIfAborted();
    if (!current) {
      return null;
    }
    const observed = await observeSharedWindow(
      { ...target, window: current },
      signal,
    );
    signal.throwIfAborted();
    const db = set(writeDb$);
    if (observed.kind === "gone") {
      // The provider confirms that the whole instance is gone. Preserve every
      // chat's accepted snapshot; there is no live native state left to capture.
      await db
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
        );
      signal.throwIfAborted();
      return null;
    }
    if (observed.kind === "healthy") {
      // Rotate healthy observations as well as failures in the bounded sweep.
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
        signal,
      );
      signal.throwIfAborted();
      if (!closing) {
        return null;
      }
      current = closing;
    }
    if (connection && !nativeMissing) {
      await tryCloseBrowserUseWindow(
        connection,
        current.primaryWindowId,
        signal,
      );
    }
    // Recovery uses only an accepted snapshot, even if fresh capture failed.
    const [closed] = await db
      .delete(windows)
      .where(and(identity, eq(windows.state, "closing")))
      .returning({ id: windows.chatThreadId });
    signal.throwIfAborted();
    if (!closed) {
      return null;
    }
    if (target.threadId !== null) {
      await publishBrowserSessionChangedSafely(profile.userId, {
        threadId: current.chatThreadId,
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
        .set({ status: "stopped", updatedAt: nowDate() })
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
        .delete(windows)
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

const reconcileSharedWindows$ = command(
  async ({ get, set }, owner: Owner | null, signal: AbortSignal) => {
    const rows = await get(db$)
      .select({ profile: profiles, window: windows, threadId: chatThreads.id })
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
    for (const row of rows) {
      const result = await settleIncludingAbort(
        set(retireSharedWindow$, row, signal),
      );
      signal.throwIfAborted();
      if (result.ok) {
        if (result.value) {
          closedInstances.add(result.value);
        }
      } else {
        errors += 1;
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
        L.warn("Shared Browser window retirement could not be confirmed", {
          chatThreadId: row.window.chatThreadId,
          instanceId: row.profile.instanceId,
        });
      }
    }
    const empty = await get(db$)
      .select()
      .from(profiles)
      .where(
        and(
          ownerScope(owner),
          isNotNull(profiles.providerSessionId),
          noWindows("active"),
          or(
            eq(profiles.status, "stopping"),
            and(
              eq(profiles.status, "active"),
              or(
                // Give a newly published instance its existing setup window.
                // Normal final retirement stops immediately in this call.
                lte(profiles.creationExpiresAt, nowDate()),
                inArray(profiles.instanceId, [...closedInstances]),
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
        ),
      )
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

/** Independent creation recovery cannot hold up existing windows or their final stop. */
export const reconcileSharedBrowsers$ = command(
  async ({ set }, owner: Owner | null, signal: AbortSignal) => {
    const [creation, windows] = await joinAll([
      set(recoverSharedCreations$, owner, signal),
      set(reconcileSharedWindows$, owner, signal),
    ]);
    signal.throwIfAborted();
    return {
      checked: creation.checked + windows.checked,
      stopped: creation.stopped + windows.stopped,
      errors: creation.errors + windows.errors,
    };
  },
);
