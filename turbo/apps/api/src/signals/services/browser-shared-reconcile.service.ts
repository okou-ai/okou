import {
  browserOwnerProfiles as profiles,
  browserOwnerWindows as windows,
} from "@okouai/db/schema/browser-owner";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
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
import { settleIncludingAbort } from "../utils";
import {
  BrowserUseProviderError,
  browserUseWindowExists,
  closeBrowserUseWindow,
  findBrowserUseSession,
  stopBrowserUseSessionForCleanup,
} from "./browser-use.service";
import {
  saveSharedSnapshot$,
  sharedBrowserLifetime,
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

function noWindows() {
  return notExists(
    new QueryBuilder()
      .select({ id: windows.chatThreadId })
      .from(windows)
      .where(eq(windows.instanceId, profiles.instanceId)),
  );
}

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
    const db = set(writeDb$);
    if (target.window.state === "active") {
      const at = nowDate();
      const [claimed] = await db
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
            ),
          ),
        )
        .returning({ id: windows.chatThreadId });
      signal.throwIfAborted();
      if (!claimed) {
        return null;
      }
    }
    const [current] = await get(db$)
      .select()
      .from(windows)
      .where(and(identity, eq(windows.state, "closing")))
      .limit(1);
    signal.throwIfAborted();
    if (!current) {
      return null;
    }
    if (!profile.providerSessionId) {
      throw new Error("A shared Browser window has no provider session");
    }
    const provider = await findBrowserUseSession(
      profile.providerSessionId,
      signal,
    );
    if (provider?.status === "active") {
      if (!provider.cdpUrl) {
        throw new BrowserUseProviderError(
          502,
          "BROWSER_USE_INVALID_RESPONSE",
          "The active Browser has no native connection",
        );
      }
      if (target.threadId !== null) {
        await set(
          saveSharedSnapshot$,
          { owner, profile, window: current, cdpUrl: provider.cdpUrl },
          signal,
        );
        signal.throwIfAborted();
      }
      await closeBrowserUseWindow(
        provider.cdpUrl,
        current.primaryWindowId,
        signal,
      );
      if (
        await browserUseWindowExists(
          provider.cdpUrl,
          current.primaryWindowId,
          signal,
        )
      ) {
        throw new Error("Shared Browser window closure is not confirmed");
      }
    }
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
      // invisible to this statement's initial no-window snapshot.
      const claim = await settleIncludingAbort(
        db
          .update(profiles)
          .set({ status: "stopping", updatedAt: nowDate() })
          .where(
            and(
              exactProfile(candidate),
              eq(profiles.status, "active"),
              noWindows(),
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
    const [stopped] = await db
      .update(profiles)
      .set({ status: "stopped", updatedAt: nowDate() })
      .where(
        and(
          exactProfile(candidate),
          eq(profiles.status, "stopping"),
          noWindows(),
        ),
      )
      .returning({ id: profiles.id });
    signal.throwIfAborted();
    return stopped !== undefined;
  },
);

/** The public lifecycle and existing minute cron share exact retirement work. */
export const reconcileSharedBrowsers$ = command(
  async ({ get, set }, owner: Owner | null, signal: AbortSignal) => {
    const rows = await get(db$)
      .select({ profile: profiles, window: windows, threadId: chatThreads.id })
      .from(windows)
      .innerJoin(profiles, eq(profiles.instanceId, windows.instanceId))
      .leftJoin(chatThreads, eq(chatThreads.id, windows.chatThreadId))
      .where(
        and(
          ownerScope(owner),
          openNeedsReclamation(owner),
          inArray(profiles.status, ["active", "stopping"]),
          or(
            eq(windows.state, "closing"),
            lte(windows.expiresAt, nowDate()),
            lte(profiles.timeoutAt, nowDate()),
            isNull(chatThreads.id),
          ),
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
              eq(windows.state, "closing"),
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
          noWindows(),
          or(
            eq(profiles.status, "stopping"),
            and(
              eq(profiles.status, "active"),
              or(
                // Give a newly published instance its existing setup window.
                // Normal final retirement stops immediately in this call.
                lte(profiles.creationExpiresAt, nowDate()),
                inArray(profiles.instanceId, [...closedInstances]),
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
    return { checked: rows.length + empty.length, stopped, errors };
  },
);
