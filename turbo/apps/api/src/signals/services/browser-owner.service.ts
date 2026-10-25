import { randomUUID } from "node:crypto";
import type {
  RunnerBrowserAction,
  RunnerBrowserRequest,
  RunnerBrowserResponse,
} from "@okouai/api-contracts/contracts/runner-browser";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { runnerState } from "@okouai/db/runtime/runner-state";
import { agents } from "@okouai/db/schema/agent";
import {
  browserOwnerProfiles,
  browserOwnerWindows,
} from "@okouai/db/schema/browser-owner";
import {
  browserProfiles,
  browserSessionInstances,
  browserThreadProfiles,
} from "@okouai/db/schema/browser-session";
import { command, computed, type Computed } from "ccstate";
import {
  and,
  eq,
  exists,
  getTableColumns,
  gt,
  inArray,
  lte,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";

const SETUP_MS = 60_000;
const IDLE_MS = 10 * 60_000;
const MAX_BROWSER_MS = 240 * 60_000;
const profiles = browserOwnerProfiles;
const windows = browserOwnerWindows;
type ProfileRow = typeof profiles.$inferSelect;
type WindowView = Pick<
  typeof windows.$inferSelect,
  "chatThreadId" | "state" | "expiresAt" | "primaryWindowId"
>;
interface BrowserView {
  readonly profile: ProfileRow;
  readonly window?: WindowView | null;
}
type BrowserAction<K extends RunnerBrowserAction["kind"]> = Extract<
  RunnerBrowserAction,
  { kind: K }
>;

interface RunnerBrowserIdentity {
  readonly runId: string;
  readonly runnerIdentity: RunnerBrowserRequest["runnerIdentity"];
}

export interface BrowserOwnerAuthority extends RunnerBrowserIdentity {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
}

/** The trusted host derives Guest -> Run locally; completion sandboxId is not authority. */
function currentRun(input: RunnerBrowserIdentity) {
  return and(
    eq(agentRuns.id, input.runId),
    eq(agentRuns.status, "running"),
    eq(agentRuns.runnerId, input.runnerIdentity.runnerId),
    eq(
      agentRuns.runnerHeartbeatGeneration,
      input.runnerIdentity.heartbeatGeneration,
    ),
    exists(
      new QueryBuilder()
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .innerJoin(
          agents,
          and(
            eq(agents.id, chatThreads.agentId),
            eq(agents.orgId, agentRuns.orgId),
          ),
        )
        .innerJoin(
          runnerState,
          and(
            eq(runnerState.runnerId, agentRuns.runnerId),
            eq(
              runnerState.heartbeatGeneration,
              agentRuns.runnerHeartbeatGeneration,
            ),
          ),
        )
        .where(
          and(
            eq(chatThreads.id, agentRuns.chatThreadId),
            eq(chatThreads.agentId, agentRuns.agentId),
            eq(chatThreads.userId, agentRuns.userId),
            eq(chatThreads.cloudBrowserEnabled, true),
            or(
              eq(agents.visibility, "public"),
              eq(agents.owner, agentRuns.userId),
            ),
          ),
        ),
    ),
  );
}

function authorityStillCurrent(owner: BrowserOwnerAuthority) {
  return exists(
    new QueryBuilder()
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          currentRun(owner),
          eq(agentRuns.orgId, owner.orgId),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.chatThreadId, owner.chatThreadId),
        ),
      ),
  );
}

function ownedInstance(owner: BrowserOwnerAuthority, instanceId: string) {
  return and(
    eq(profiles.instanceId, instanceId),
    eq(profiles.orgId, owner.orgId),
    eq(profiles.userId, owner.userId),
    authorityStillCurrent(owner),
  );
}

function activeInstance(
  owner: BrowserOwnerAuthority,
  instanceId: string,
  now: Date,
) {
  return and(
    ownedInstance(owner, instanceId),
    eq(profiles.status, "active"),
    gt(profiles.timeoutAt, now),
  );
}

function ownedWindow(
  owner: BrowserOwnerAuthority,
  action: { readonly instanceId: string; readonly primaryWindowId: number },
  now?: Date,
) {
  return and(
    eq(windows.primaryWindowId, action.primaryWindowId),
    eq(windows.instanceId, action.instanceId),
    eq(windows.chatThreadId, owner.chatThreadId),
    exists(
      new QueryBuilder()
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.instanceId, windows.instanceId),
            now === undefined
              ? ownedInstance(owner, action.instanceId)
              : activeInstance(owner, action.instanceId, now),
          ),
        ),
    ),
  );
}

function windowHardDeadline() {
  return sql`(${new QueryBuilder().select({ timeoutAt: profiles.timeoutAt }).from(profiles).where(eq(profiles.instanceId, windows.instanceId))})`;
}

function response(row: BrowserView | undefined): RunnerBrowserResponse {
  if (!row) {
    return { outcome: "unavailable" };
  }
  const { profile, window } = row;
  return {
    outcome: "accepted",
    instance: {
      id: profile.instanceId,
      ownerProfileId: profile.id,
      providerProfileId: profile.providerProfileId,
      providerSessionId: profile.providerSessionId,
      status: profile.status,
      creationExpiresAt: profile.creationExpiresAt.toISOString(),
      timeoutAt: profile.timeoutAt.toISOString(),
      window: window
        ? {
            chatThreadId: window.chatThreadId,
            state: window.state,
            expiresAt: window.expiresAt.getTime(),
            primaryWindowId: window.primaryWindowId,
          }
        : null,
    },
  };
}

export function createRunnerBrowserAuthority(
  input$: Computed<Promise<RunnerBrowserIdentity | null>>,
) {
  return computed(async (get): Promise<BrowserOwnerAuthority | null> => {
    const input = await get(input$);
    if (!input) {
      return null;
    }
    const [run] = await get(db$)
      .select({
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        chatThreadId: agentRuns.chatThreadId,
      })
      .from(agentRuns)
      .where(currentRun(input));
    return run?.chatThreadId
      ? { ...input, ...run, chatThreadId: run.chatThreadId }
      : null;
  });
}

export function createRunnerBrowserInspection(
  owner$: Computed<Promise<BrowserOwnerAuthority | null>>,
  action$: Computed<Promise<BrowserAction<"inspect"> | null>>,
) {
  return computed(async (get): Promise<RunnerBrowserResponse> => {
    const owner = await get(owner$),
      action = await get(action$);
    if (!owner || !action) {
      return { outcome: "unavailable" };
    }
    const [row] = await get(db$)
      .select({
        profile: getTableColumns(profiles),
        window: {
          chatThreadId: windows.chatThreadId,
          state: windows.state,
          expiresAt: windows.expiresAt,
          primaryWindowId: windows.primaryWindowId,
        },
      })
      .from(profiles)
      .leftJoin(
        windows,
        and(
          eq(windows.instanceId, profiles.instanceId),
          eq(windows.chatThreadId, owner.chatThreadId),
        ),
      )
      .where(
        and(
          eq(profiles.orgId, owner.orgId),
          eq(profiles.userId, owner.userId),
          authorityStillCurrent(owner),
          action.instanceId === undefined
            ? inArray(profiles.status, ["creating", "active", "stopping"])
            : eq(profiles.instanceId, action.instanceId),
        ),
      );
    return response(row);
  });
}

/** Only the named business-key competitions are normal unavailable outcomes. */
function lifecycleCompetition(error: unknown): boolean {
  return (
    isUniqueViolation(error, "uq_browser_owner_windows_native_window") ||
    (isForeignKeyViolation(error) &&
      error instanceof Error &&
      typeof error.cause === "object" &&
      error.cause !== null &&
      "constraint" in error.cause &&
      (error.cause.constraint === "browser_owner_windows_active_instance_fk" ||
        error.cause.constraint === "browser_owner_windows_instance_fk"))
  );
}

const allocateOwnerBrowser$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"allocate">,
    now: Date,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();

    const instanceId = randomUUID();
    const creationExpiresAt = new Date(nowMs + SETUP_MS);
    const timeoutAt = new Date(nowMs + MAX_BROWSER_MS);
    // A losing provider candidate is reconciled by exact ID; it must never
    // overwrite the accepted persistent profile.
    const rows = (
      await db
        .insert(profiles)
        .select(
          new QueryBuilder()
            .select({
              id: sql`${randomUUID()}::uuid`.mapWith(profiles.id).as("id"),
              orgId: agentRuns.orgId,
              userId: agentRuns.userId,
              providerProfileId: sql`${action.providerProfileId}::uuid`
                .mapWith(profiles.providerProfileId)
                .as("provider_profile_id"),
              instanceId: sql`${instanceId}::uuid`
                .mapWith(profiles.instanceId)
                .as("instance_id"),
              providerSessionId: sql`NULL::uuid`
                .mapWith(profiles.providerSessionId)
                .as("provider_session_id"),
              status: sql`'creating'`.mapWith(profiles.status).as("status"),
              creationExpiresAt:
                sql`${sql.param(creationExpiresAt, profiles.creationExpiresAt)}::timestamp`
                  .mapWith(profiles.creationExpiresAt)
                  .as("creation_expires_at"),
              timeoutAt:
                sql`${sql.param(timeoutAt, profiles.timeoutAt)}::timestamp`
                  .mapWith(profiles.timeoutAt)
                  .as("timeout_at"),
              createdAt: sql`${sql.param(now, profiles.createdAt)}::timestamp`
                .mapWith(profiles.createdAt)
                .as("created_at"),
              updatedAt: sql`${sql.param(now, profiles.updatedAt)}::timestamp`
                .mapWith(profiles.updatedAt)
                .as("updated_at"),
            })
            .from(agentRuns)
            .where(
              and(
                currentRun(owner),
                notExists(
                  new QueryBuilder()
                    .select({ id: browserProfiles.id })
                    .from(browserProfiles)
                    .where(
                      eq(
                        browserProfiles.providerProfileId,
                        action.providerProfileId,
                      ),
                    ),
                ),
                notExists(
                  new QueryBuilder()
                    .select({ id: browserThreadProfiles.id })
                    .from(browserThreadProfiles)
                    .where(
                      eq(
                        browserThreadProfiles.providerProfileId,
                        action.providerProfileId,
                      ),
                    ),
                ),
              ),
            ),
        )
        .onConflictDoUpdate({
          target: [profiles.orgId, profiles.userId],
          set: {
            instanceId,
            providerSessionId: null,
            status: "creating",
            creationExpiresAt,
            timeoutAt,
            updatedAt: now,
          },
          setWhere: and(
            eq(profiles.status, "stopped"),
            authorityStillCurrent(owner),
          ),
        })
        .returning()
    ).map((profile) => {
      return { profile };
    });
    signal.throwIfAborted();
    return rows;
  },
);

const publishOwnerBrowser$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"publish">,
    now: Date,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();

    const timeout = new Date(action.timeoutAt);
    if (
      timeout.getTime() <= nowMs ||
      timeout.getTime() > nowMs + MAX_BROWSER_MS
    ) {
      return [];
    }
    const rows = (
      await db
        .update(profiles)
        .set({
          status: "active",
          providerSessionId: action.providerSessionId,
          timeoutAt: sql`least(${profiles.timeoutAt}, ${sql.param(timeout, profiles.timeoutAt)}::timestamp)`,
          creationExpiresAt: sql`least(${profiles.creationExpiresAt}, ${sql.param(timeout, profiles.creationExpiresAt)}::timestamp)`,
          updatedAt: now,
        })
        .where(
          and(
            ownedInstance(owner, action.instanceId),
            eq(profiles.status, "creating"),
            gt(profiles.creationExpiresAt, now),
            gt(profiles.timeoutAt, now),
            notExists(
              new QueryBuilder()
                .select({ id: browserSessionInstances.providerSessionId })
                .from(browserSessionInstances)
                .where(
                  eq(
                    browserSessionInstances.providerSessionId,
                    action.providerSessionId,
                  ),
                ),
            ),
          ),
        )
        .returning()
    ).map((profile) => {
      return { profile };
    });
    signal.throwIfAborted();
    return rows;
  },
);

const admitOwnerBrowserWindow$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"admit">,
    now: Date,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const db = set(writeDb$);
    const changed = db.$with("admitted_browser_window").as(
      db
        .insert(windows)
        // Drizzle's INSERT SELECT key check includes generated columns;
        // compile the typed source while INSERT omits its derived status.
        .select(
          new QueryBuilder()
            .select({
              chatThreadId: sql`${owner.chatThreadId}::uuid`
                .mapWith(windows.chatThreadId)
                .as("chat_thread_id"),
              instanceId: profiles.instanceId,
              state: sql`'active'`.mapWith(windows.state).as("state"),
              primaryWindowId: sql`${action.primaryWindowId}::bigint`
                .mapWith(windows.primaryWindowId)
                .as("primary_window_id"),
              expiresAt:
                sql`least(${profiles.timeoutAt}, ${sql.param(new Date(now.getTime() + IDLE_MS), windows.expiresAt)}::timestamp)`
                  .mapWith(windows.expiresAt)
                  .as("expires_at"),
              createdAt: sql`${sql.param(now, windows.createdAt)}::timestamp`
                .mapWith(windows.createdAt)
                .as("created_at"),
              updatedAt: sql`${sql.param(now, windows.updatedAt)}::timestamp`
                .mapWith(windows.updatedAt)
                .as("updated_at"),
            })
            .from(profiles)
            .where(activeInstance(owner, action.instanceId, now))
            .getSQL(),
        )
        .onConflictDoNothing({ target: windows.chatThreadId })
        .returning(),
    );
    const rows = await db
      .with(changed)
      .select({
        profile: getTableColumns(profiles),
        window: {
          chatThreadId: changed.chatThreadId,
          state: changed.state,
          expiresAt: changed.expiresAt,
          primaryWindowId: changed.primaryWindowId,
        },
      })
      .from(changed)
      .innerJoin(profiles, eq(profiles.instanceId, changed.instanceId));
    signal.throwIfAborted();
    return rows;
  },
);

const renewOwnerBrowserWindow$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"renew">,
    now: Date,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();

    const changed = db.$with("renewed_browser_window").as(
      db
        .update(windows)
        .set({
          expiresAt: sql`least(${windowHardDeadline()}, greatest(${windows.expiresAt}, ${sql.param(new Date(nowMs + IDLE_MS), windows.expiresAt)}::timestamp))`,
          updatedAt: now,
        })
        .where(
          and(
            ownedWindow(owner, action, now),
            eq(windows.state, "active"),
            gt(windows.expiresAt, now),
          ),
        )
        .returning(),
    );
    const rows = await db
      .with(changed)
      .select({
        profile: getTableColumns(profiles),
        window: {
          chatThreadId: changed.chatThreadId,
          state: changed.state,
          expiresAt: changed.expiresAt,
          primaryWindowId: changed.primaryWindowId,
        },
      })
      .from(changed)
      .innerJoin(profiles, eq(profiles.instanceId, changed.instanceId));
    signal.throwIfAborted();
    return rows;
  },
);

const retireOwnerBrowserWindow$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"retire">,
    now: Date,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const db = set(writeDb$);

    const changed = db.$with("retired_browser_window").as(
      db
        .update(windows)
        .set({ state: "closing", updatedAt: now })
        .where(
          and(
            ownedWindow(owner, action),
            eq(windows.state, "active"),
            action.reason === "expired"
              ? lte(windows.expiresAt, now)
              : undefined,
          ),
        )
        .returning(),
    );
    const rows = await db
      .with(changed)
      .select({
        profile: getTableColumns(profiles),
        window: {
          chatThreadId: changed.chatThreadId,
          state: changed.state,
          expiresAt: changed.expiresAt,
          primaryWindowId: changed.primaryWindowId,
        },
      })
      .from(changed)
      .innerJoin(profiles, eq(profiles.instanceId, changed.instanceId));
    signal.throwIfAborted();
    return rows;
  },
);

const completeOwnerBrowserWindowClose$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"completeWindowClose">,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const db = set(writeDb$);

    const changed = db.$with("closed_browser_window").as(
      db
        .delete(windows)
        .where(and(ownedWindow(owner, action), eq(windows.state, "closing")))
        .returning({ instanceId: windows.instanceId }),
    );
    const rows = await db
      .with(changed)
      .select({ profile: getTableColumns(profiles) })
      .from(changed)
      .innerJoin(profiles, eq(profiles.instanceId, changed.instanceId));
    signal.throwIfAborted();
    return rows;
  },
);

const beginOwnerBrowserStop$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"beginStop">,
    now: Date,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const db = set(writeDb$);

    // The live-window/active-instance FK also arbitrates a concurrent
    // INSERT invisible to this statement's initial NOT EXISTS snapshot.
    const stopping = db.$with("stopping_browser").as(
      db
        .update(profiles)
        .set({ status: "stopping", updatedAt: now })
        .where(
          and(
            ownedInstance(owner, action.instanceId),
            or(
              eq(profiles.status, "active"),
              and(
                eq(profiles.status, "creating"),
                lte(profiles.creationExpiresAt, now),
              ),
            ),
            notExists(
              new QueryBuilder()
                .select({ chatThreadId: windows.chatThreadId })
                .from(windows)
                .where(
                  and(
                    eq(windows.instanceId, profiles.instanceId),
                    eq(windows.state, "active"),
                  ),
                ),
            ),
          ),
        )
        .returning(),
    );
    const rows = await db
      .with(stopping)
      .select({
        profile: {
          id: stopping.id,
          orgId: stopping.orgId,
          userId: stopping.userId,
          providerProfileId: stopping.providerProfileId,
          instanceId: stopping.instanceId,
          providerSessionId: stopping.providerSessionId,
          status: stopping.status,
          creationExpiresAt: stopping.creationExpiresAt,
          timeoutAt: stopping.timeoutAt,
          createdAt: stopping.createdAt,
          updatedAt: stopping.updatedAt,
        },
        window: {
          chatThreadId: windows.chatThreadId,
          state: windows.state,
          expiresAt: windows.expiresAt,
          primaryWindowId: windows.primaryWindowId,
        },
      })
      .from(stopping)
      .leftJoin(
        windows,
        and(
          eq(windows.instanceId, stopping.instanceId),
          eq(windows.chatThreadId, owner.chatThreadId),
        ),
      );
    signal.throwIfAborted();
    return rows;
  },
);

const completeOwnerBrowserStop$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"completeStop">,
    now: Date,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const db = set(writeDb$);

    const stopped = db.$with("stopped_browser").as(
      db
        .update(profiles)
        .set({ status: "stopped", updatedAt: now })
        .where(
          and(
            ownedInstance(owner, action.instanceId),
            eq(profiles.status, "stopping"),
          ),
        )
        .returning(),
    );
    // Exact provider-stop acknowledgement completes all remaining native
    // cleanup for this instance, including an uncertain per-page close.
    const closed = db.$with("closed_stopped_browser_windows").as(
      db
        .delete(windows)
        .where(
          and(
            eq(windows.instanceId, action.instanceId),
            eq(windows.state, "closing"),
            exists(
              new QueryBuilder()
                .select({ id: stopped.id })
                .from(stopped)
                .where(eq(stopped.instanceId, windows.instanceId)),
            ),
          ),
        )
        .returning({ chatThreadId: windows.chatThreadId }),
    );
    const rows = (await db.with(stopped, closed).select().from(stopped)).map(
      (profile) => {
        return { profile };
      },
    );
    signal.throwIfAborted();
    return rows;
  },
);
/** Each action owns one atomic statement; provider effects stay on the host. */
const mutateBrowserOwner$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: Exclude<RunnerBrowserAction, { kind: "inspect" }>,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const now = nowDate();
    switch (action.kind) {
      case "allocate": {
        return await set(allocateOwnerBrowser$, owner, action, now, signal);
      }
      case "publish": {
        return await set(publishOwnerBrowser$, owner, action, now, signal);
      }
      case "admit": {
        return await set(admitOwnerBrowserWindow$, owner, action, now, signal);
      }
      case "renew": {
        return await set(renewOwnerBrowserWindow$, owner, action, now, signal);
      }
      case "retire": {
        return await set(retireOwnerBrowserWindow$, owner, action, now, signal);
      }
      case "completeWindowClose": {
        return await set(
          completeOwnerBrowserWindowClose$,
          owner,
          action,
          signal,
        );
      }
      case "beginStop": {
        return await set(beginOwnerBrowserStop$, owner, action, now, signal);
      }
      case "completeStop": {
        return await set(completeOwnerBrowserStop$, owner, action, now, signal);
      }
    }
  },
);

export const controlBrowserOwner$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: Exclude<RunnerBrowserAction, { kind: "inspect" }>,
    signal: AbortSignal,
  ): Promise<RunnerBrowserResponse> => {
    const result = await settle(
      set(mutateBrowserOwner$, owner, action, signal),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (lifecycleCompetition(result.error)) {
        return { outcome: "unavailable" };
      }
      throw result.error;
    }
    return response(result.value[0]);
  },
);
