import { randomUUID } from "node:crypto";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { browserOwnerProfiles } from "@okouai/db/schema/browser-owner";
import { browserChatSessions } from "@okouai/db/schema/browser-chat-session";
import {
  browserProfiles,
  browserSessionInstances,
  browserThreadProfiles,
} from "@okouai/db/schema/browser-session";
import { command } from "ccstate";
import {
  and,
  eq,
  exists,
  getTableColumns,
  gt,
  isNull,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { isForeignKeyViolation, isUniqueViolation } from "../../lib/pg-errors";
import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";
import { settle } from "../utils";

import {
  browserChatWindow,
  type BrowserChatWindow,
} from "./browser-chat-session";

const SETUP_MS = 60_000;
const IDLE_MS = 10 * 60_000;
const MAX_BROWSER_MS = 240 * 60_000;
const profiles = browserOwnerProfiles;
const windows = browserChatSessions;
type ProfileRow = typeof profiles.$inferSelect;
type WindowView = Pick<
  typeof windows.$inferSelect,
  "chatThreadId" | "instanceId" | "state" | "expiresAt" | "primaryWindowId"
>;
interface BrowserView {
  readonly profile: ProfileRow;
  readonly window?: WindowView | null;
}
export type BrowserOwnerResult =
  | { readonly outcome: "unavailable" }
  | {
      readonly outcome: "accepted";
      readonly profile: ProfileRow;
      readonly window?: BrowserChatWindow | null;
    };

type BrowserOwnerMutation =
  | {
      readonly kind: "allocate";
      readonly providerProfileId: string;
      readonly previousProfile: {
        readonly providerProfileId: string;
        readonly instanceId: string;
      } | null;
    }
  | {
      readonly kind: "publish";
      readonly instanceId: string;
      readonly providerSessionId: string;
      readonly timeoutAt: string;
    }
  | {
      readonly kind: "admit";
      readonly instanceId: string;
      readonly primaryWindowId: number;
    }
  | {
      readonly kind: "renew";
      readonly instanceId: string;
      readonly primaryWindowId: number;
    };

export interface BrowserPublicAuthority {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
  readonly runId: string;
  readonly requireLiveRun: boolean;
}

export function authorityStillCurrent(owner: BrowserPublicAuthority) {
  return exists(
    new QueryBuilder()
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(
        and(
          browserAuthorityRun(owner),
          eq(agentRuns.orgId, owner.orgId),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.chatThreadId, owner.chatThreadId),
        ),
      ),
  );
}

function browserAuthorityRun(owner: BrowserPublicAuthority) {
  return and(
    eq(agentRuns.id, owner.runId),
    eq(agentRuns.orgId, owner.orgId),
    eq(agentRuns.userId, owner.userId),
    eq(agentRuns.chatThreadId, owner.chatThreadId),
    owner.requireLiveRun
      ? or(eq(agentRuns.status, "pending"), eq(agentRuns.status, "running"))
      : undefined,
    exists(
      new QueryBuilder()
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .innerJoin(
          agents,
          and(
            eq(agents.id, chatThreads.agentId),
            eq(agents.orgId, owner.orgId),
          ),
        )
        .where(
          and(
            eq(chatThreads.id, owner.chatThreadId),
            eq(chatThreads.userId, owner.userId),
            eq(chatThreads.cloudBrowserEnabled, true),
            eq(agentRuns.agentId, chatThreads.agentId),
            or(eq(agents.visibility, "public"), eq(agents.owner, owner.userId)),
          ),
        ),
    ),
  );
}

function ownedInstance(owner: BrowserPublicAuthority, instanceId: string) {
  return and(
    eq(profiles.instanceId, instanceId),
    eq(profiles.orgId, owner.orgId),
    eq(profiles.userId, owner.userId),
    authorityStillCurrent(owner),
  );
}

function activeInstance(
  owner: BrowserPublicAuthority,
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
  owner: BrowserPublicAuthority,
  action: { readonly instanceId: string; readonly primaryWindowId: number },
  now: Date,
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
            activeInstance(owner, action.instanceId, now),
          ),
        ),
    ),
  );
}

function windowHardDeadline() {
  return sql`(${new QueryBuilder().select({ timeoutAt: profiles.timeoutAt }).from(profiles).where(eq(profiles.instanceId, windows.instanceId))})`;
}

function mutationResult(row: BrowserView | undefined): BrowserOwnerResult {
  if (!row) {
    return { outcome: "unavailable" };
  }
  return {
    outcome: "accepted",
    profile: row.profile,
    window: row.window ? browserChatWindow(row.window) : null,
  };
}

/** Only the named business-key competitions are normal unavailable outcomes. */
function lifecycleCompetition(error: unknown): boolean {
  return (
    isUniqueViolation(error, "uq_browser_chat_sessions_native_window") ||
    (isForeignKeyViolation(error) &&
      error instanceof Error &&
      typeof error.cause === "object" &&
      error.cause !== null &&
      "constraint" in error.cause &&
      (error.cause.constraint === "browser_chat_sessions_active_instance_fk" ||
        error.cause.constraint === "browser_chat_sessions_instance_fk"))
  );
}

const allocateOwnerBrowser$ = command(
  async (
    { set },
    owner: BrowserPublicAuthority,
    action: Extract<BrowserOwnerMutation, { kind: "allocate" }>,
    now: Date,
    signal: AbortSignal,
  ): Promise<BrowserView[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();

    const instanceId = randomUUID();
    const creationExpiresAt = new Date(nowMs + SETUP_MS);
    const timeoutAt = new Date(nowMs + MAX_BROWSER_MS);
    const expectedProfile = and(
      eq(profiles.status, "stopped"),
      eq(
        profiles.providerProfileId,
        action.previousProfile?.providerProfileId ?? action.providerProfileId,
      ),
      action.previousProfile
        ? eq(profiles.instanceId, action.previousProfile.instanceId)
        : undefined,
    );
    // Missing-provider recovery replaces only the exact stopped lifetime
    // whose profile the server resolved, never a concurrent winner.
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
                browserAuthorityRun(owner),
                action.previousProfile
                  ? exists(
                      new QueryBuilder()
                        .select({ id: profiles.id })
                        .from(profiles)
                        .where(
                          and(
                            eq(profiles.orgId, owner.orgId),
                            eq(profiles.userId, owner.userId),
                            expectedProfile,
                          ),
                        ),
                    )
                  : undefined,
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
            providerProfileId: action.providerProfileId,
            instanceId,
            providerSessionId: null,
            status: "creating",
            creationExpiresAt,
            timeoutAt,
            updatedAt: now,
          },
          setWhere: and(expectedProfile, authorityStillCurrent(owner)),
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
    owner: BrowserPublicAuthority,
    action: Extract<BrowserOwnerMutation, { kind: "publish" }>,
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
    owner: BrowserPublicAuthority,
    action: Extract<BrowserOwnerMutation, { kind: "admit" }>,
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
              orgId: profiles.orgId,
              userId: profiles.userId,
              name: sql`'browser'`.mapWith(windows.name).as("name"),
              instanceId: profiles.instanceId,
              state: sql`'active'`.mapWith(windows.state).as("state"),
              primaryWindowId: sql`${action.primaryWindowId}::bigint`
                .mapWith(windows.primaryWindowId)
                .as("primary_window_id"),
              expiresAt:
                sql`least(${profiles.timeoutAt}, ${sql.param(new Date(now.getTime() + IDLE_MS), windows.expiresAt)}::timestamp)`
                  .mapWith(windows.expiresAt)
                  .as("expires_at"),
              encryptedTabUrls: sql`NULL::text`.as("encrypted_tab_urls"),
              tabUrlsCapturedAt: sql`NULL::timestamp`.as(
                "tab_urls_captured_at",
              ),
              screenshotObjectKey: sql`NULL::text`.as("screenshot_object_key"),
              screenshotUrl: sql`NULL::text`.as("screenshot_url"),
              screenshotCapturedAt: sql`NULL::timestamp`.as(
                "screenshot_captured_at",
              ),
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
        .onConflictDoUpdate({
          target: windows.chatThreadId,
          set: {
            instanceId: action.instanceId,
            state: "active",
            primaryWindowId: action.primaryWindowId,
            expiresAt: sql`excluded.expires_at`,
            updatedAt: now,
          },
          setWhere: and(
            eq(windows.orgId, owner.orgId),
            eq(windows.userId, owner.userId),
            isNull(windows.instanceId),
            isNull(windows.state),
            exists(
              new QueryBuilder()
                .select({ id: profiles.id })
                .from(profiles)
                .where(activeInstance(owner, action.instanceId, now)),
            ),
          ),
        })
        .returning(),
    );
    const rows = await db
      .with(changed)
      .select({
        profile: getTableColumns(profiles),
        window: {
          chatThreadId: changed.chatThreadId,
          instanceId: changed.instanceId,
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
    owner: BrowserPublicAuthority,
    action: Extract<BrowserOwnerMutation, { kind: "renew" }>,
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
          instanceId: changed.instanceId,
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

/** Each action owns one atomic statement; provider effects stay outside it. */
const mutateBrowserOwner$ = command(
  async (
    { set },
    owner: BrowserPublicAuthority,
    action: BrowserOwnerMutation,
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
    }
  },
);

export const controlBrowserOwner$ = command(
  async (
    { set },
    owner: BrowserPublicAuthority,
    action: BrowserOwnerMutation,
    signal: AbortSignal,
  ): Promise<BrowserOwnerResult> => {
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
    return mutationResult(result.value[0]);
  },
);
