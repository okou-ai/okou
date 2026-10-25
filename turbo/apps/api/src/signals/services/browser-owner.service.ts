import { randomUUID } from "node:crypto";
import type {
  RunnerBrowserAction,
  RunnerBrowserRequest,
  RunnerBrowserResponse,
} from "@okouai/api-contracts/contracts/runner-browser";
import { parseBrowserOwnerWindows } from "@okouai/db/jsonb-contracts/browser-owner";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { runnerState } from "@okouai/db/runtime/runner-state";
import { agents } from "@okouai/db/schema/agent";
import {
  browserOwnerInstances,
  browserOwnerProfiles,
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
  ne,
  notExists,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";

const SETUP_MS = 60_000;
const IDLE_MS = 10 * 60_000;
const MAX_BROWSER_MS = 240 * 60_000;
const instances = browserOwnerInstances;
const profiles = browserOwnerProfiles;
const liveStates = ["creating", "active", "stopping"] as const;
type InstanceRow = typeof instances.$inferSelect & {
  readonly providerProfileId: string;
};
function instanceSelection() {
  return {
    ...getTableColumns(instances),
    providerProfileId: sql`(${new QueryBuilder()
      .select({ id: profiles.providerProfileId })
      .from(profiles)
      .where(eq(profiles.id, instances.ownerProfileId))})`
      .mapWith(profiles.providerProfileId)
      .as("provider_profile_id"),
  };
}

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
    eq(instances.id, instanceId),
    authorityStillCurrent(owner),
    exists(
      new QueryBuilder()
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(
            eq(profiles.id, instances.ownerProfileId),
            eq(profiles.orgId, owner.orgId),
            eq(profiles.userId, owner.userId),
          ),
        ),
    ),
  );
}

function activeInstance(
  owner: BrowserOwnerAuthority,
  instanceId: string,
  now: Date,
) {
  return and(
    ownedInstance(owner, instanceId),
    eq(instances.status, "active"),
    gt(instances.timeoutAt, now),
  );
}

function windowValue(windowSessionId: string) {
  return sql`${instances.windows} -> ${windowSessionId}`;
}

function ownedWindow(owner: BrowserOwnerAuthority, windowSessionId: string) {
  return eq(
    sql`${windowValue(windowSessionId)} ->> 'chatThreadId'`,
    owner.chatThreadId,
  );
}

function windowState(windowSessionId: string) {
  return sql`${windowValue(windowSessionId)} ->> 'state'`;
}

function windowExpiry(windowSessionId: string) {
  return sql`(${windowValue(windowSessionId)} ->> 'expiresAt')::bigint`;
}

function hardDeadlineMs() {
  return sql`floor(extract(epoch FROM ${instances.timeoutAt}) * 1000)::bigint`;
}

function nativeWindowInSession(
  windowSessionId: string,
  nativeWindowId: number,
) {
  return or(
    eq(
      sql`(${windowValue(windowSessionId)} ->> 'primaryWindowId')::bigint`,
      sql`${nativeWindowId}::bigint`,
    ),
    sql`(${windowValue(windowSessionId)} -> 'auxiliaryWindowIds')
      @> jsonb_build_array(${nativeWindowId}::bigint)`,
  );
}

function nativeWindowUnclaimed(
  windowSessionId: string,
  nativeWindowId: number,
) {
  return notExists(sql`(SELECT 1 FROM jsonb_each(${instances.windows}) AS other
    WHERE other.key <> ${windowSessionId}
      AND ((other.value ->> 'primaryWindowId')::bigint = ${nativeWindowId}::bigint
        OR (other.value -> 'auxiliaryWindowIds')
          @> jsonb_build_array(${nativeWindowId}::bigint)))`);
}

function lifetime(windowSessionId: string, patch: ReturnType<typeof sql>) {
  return sql`jsonb_set(${instances.windows}, ARRAY[${windowSessionId}]::text[],
    ${windowValue(windowSessionId)} || ${patch})`;
}

function response(
  row: InstanceRow | undefined,
  chatThreadId: string,
): RunnerBrowserResponse {
  if (!row) {
    return { outcome: "unavailable" };
  }
  const windows = parseBrowserOwnerWindows(row.windows);
  return {
    outcome: "accepted",
    instance: {
      id: row.id,
      ownerProfileId: row.ownerProfileId,
      providerProfileId: row.providerProfileId,
      providerSessionId: row.providerSessionId,
      status: row.status,
      creationExpiresAt: row.creationExpiresAt.toISOString(),
      timeoutAt: row.timeoutAt.toISOString(),
      windows: Object.fromEntries(
        Object.entries(windows).filter(([, window]) => {
          return window.chatThreadId === chatThreadId;
        }),
      ),
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

/** Each accepted lifecycle transition is one statement over current stored business state. */
type BrowserAction<K extends RunnerBrowserAction["kind"]> = Extract<
  RunnerBrowserAction,
  { kind: K }
>;

export function createRunnerBrowserInspection(
  owner$: Computed<Promise<BrowserOwnerAuthority | null>>,
  action$: Computed<Promise<BrowserAction<"inspect"> | null>>,
) {
  return computed(async (get): Promise<RunnerBrowserResponse> => {
    const owner = await get(owner$);
    const action = await get(action$);
    if (!owner || !action) {
      return { outcome: "unavailable" };
    }
    const [row] = await get(db$)
      .select({
        ...getTableColumns(instances),
        providerProfileId: profiles.providerProfileId,
      })
      .from(instances)
      .innerJoin(profiles, eq(profiles.id, instances.ownerProfileId))
      .where(
        and(
          eq(profiles.orgId, owner.orgId),
          eq(profiles.userId, owner.userId),
          authorityStillCurrent(owner),
          action.instanceId === undefined
            ? inArray(instances.status, liveStates)
            : eq(instances.id, action.instanceId),
        ),
      );
    return response(row, owner.chatThreadId);
  });
}

const allocateOwnerBrowser$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"allocate">,
    now: Date,
    signal: AbortSignal,
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();
    // A losing candidate must be reconciled by its exact ID by the provider
    // preparation owner. Never overwrite the accepted profile on conflict.
    const chosenProfile = db.$with("chosen_browser_owner_profile").as(
      db
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
          set: { orgId: profiles.orgId },
        })
        .returning({
          id: profiles.id,
          providerProfileId: profiles.providerProfileId,
        }),
    );
    const rows = await db
      .with(chosenProfile)
      .insert(instances)
      .select(
        new QueryBuilder()
          .select({
            id: sql`${randomUUID()}::uuid`.mapWith(instances.id).as("id"),
            ownerProfileId: chosenProfile.id,
            providerSessionId: sql`NULL::uuid`
              .mapWith(instances.providerSessionId)
              .as("provider_session_id"),
            status: sql`'creating'`.mapWith(instances.status).as("status"),
            windows: sql`'{}'::jsonb`.mapWith(instances.windows).as("windows"),
            creationExpiresAt:
              sql`${sql.param(new Date(nowMs + SETUP_MS), instances.creationExpiresAt)}::timestamp`
                .mapWith(instances.creationExpiresAt)
                .as("creation_expires_at"),
            timeoutAt:
              sql`${sql.param(new Date(nowMs + MAX_BROWSER_MS), instances.timeoutAt)}::timestamp`
                .mapWith(instances.timeoutAt)
                .as("timeout_at"),
            createdAt: sql`${sql.param(now, instances.createdAt)}::timestamp`
              .mapWith(instances.createdAt)
              .as("created_at"),
            updatedAt: sql`${sql.param(now, instances.updatedAt)}::timestamp`
              .mapWith(instances.updatedAt)
              .as("updated_at"),
          })
          .from(chosenProfile),
      )
      .onConflictDoNothing({
        target: instances.ownerProfileId,
        where: sql`${instances.status} IN ('creating', 'active', 'stopping')`,
      })
      .returning({
        ...getTableColumns(instances),
        providerProfileId: sql`(${new QueryBuilder()
          .select({ id: chosenProfile.providerProfileId })
          .from(chosenProfile)})`
          .mapWith(profiles.providerProfileId)
          .as("provider_profile_id"),
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
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();
    const scoped = ownedInstance(owner, action.instanceId);
    const timeout = new Date(action.timeoutAt);
    if (
      timeout.getTime() <= nowMs ||
      timeout.getTime() > nowMs + MAX_BROWSER_MS
    ) {
      return [];
    }
    const rows = await db
      .update(instances)
      .set({
        status: "active",
        providerSessionId: action.providerSessionId,
        timeoutAt: sql`least(${instances.timeoutAt}, ${sql.param(timeout, instances.timeoutAt)}::timestamp)`,
        creationExpiresAt: sql`least(${instances.creationExpiresAt}, ${sql.param(timeout, instances.creationExpiresAt)}::timestamp)`,
        updatedAt: now,
      })
      .where(
        and(
          scoped,
          eq(instances.status, "creating"),
          gt(instances.creationExpiresAt, now),
          gt(instances.timeoutAt, now),
          // Provider preparation may not adopt an old thread Browser either.
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
      .returning(instanceSelection());
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
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();
    const active = activeInstance(owner, action.instanceId, now);
    const windowSessionId = randomUUID();
    const rows = await db
      .update(instances)
      .set({
        windows: sql`${instances.windows} || jsonb_build_object(${windowSessionId}::text,
              jsonb_build_object('chatThreadId', ${owner.chatThreadId}::text,
                'state', 'creating', 'expiresAt', least(${nowMs + SETUP_MS}::bigint, ${hardDeadlineMs()}),
                'primaryWindowId', NULL, 'auxiliaryWindowIds', '[]'::jsonb))`,
        updatedAt: now,
      })
      .where(
        and(
          active,
          notExists(sql`(SELECT 1 FROM jsonb_each(${instances.windows}) AS entry
              WHERE entry.value ->> 'chatThreadId' = ${owner.chatThreadId}
                AND entry.value ->> 'state' IN ('creating', 'active'))`),
        ),
      )
      .returning(instanceSelection());
    signal.throwIfAborted();
    return rows;
  },
);

const registerOwnerBrowserAuxiliaryWindow$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"registerAuxiliaryWindow">,
    now: Date,
    signal: AbortSignal,
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();
    const windowSessionId = action.windowSessionId;
    // The trusted Runner verifies Chrome's opener before binding a new window.
    // Membership and uniqueness are checked against the current stored aggregate.
    const rows = await db
      .update(instances)
      .set({
        windows: lifetime(
          windowSessionId,
          sql`jsonb_build_object('auxiliaryWindowIds',
            CASE WHEN (${windowValue(windowSessionId)} -> 'auxiliaryWindowIds')
              @> jsonb_build_array(${action.nativeWindowId}::bigint)
            THEN ${windowValue(windowSessionId)} -> 'auxiliaryWindowIds'
            ELSE (${windowValue(windowSessionId)} -> 'auxiliaryWindowIds')
              || jsonb_build_array(${action.nativeWindowId}::bigint) END,
            'expiresAt', least(${hardDeadlineMs()},
              greatest(${windowExpiry(windowSessionId)}, ${nowMs + IDLE_MS}::bigint)))`,
        ),
        updatedAt: now,
      })
      .where(
        and(
          activeInstance(owner, action.instanceId, now),
          ownedWindow(owner, windowSessionId),
          eq(windowState(windowSessionId), "active"),
          gt(windowExpiry(windowSessionId), nowMs),
          nativeWindowInSession(windowSessionId, action.openerWindowId),
          ne(
            sql`(${windowValue(windowSessionId)} ->> 'primaryWindowId')::bigint`,
            sql`${action.nativeWindowId}::bigint`,
          ),
          nativeWindowUnclaimed(windowSessionId, action.nativeWindowId),
        ),
      )
      .returning(instanceSelection());
    signal.throwIfAborted();
    return rows;
  },
);

const activateOwnerBrowserWindow$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"activate">,
    now: Date,
    signal: AbortSignal,
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();
    const active = activeInstance(owner, action.instanceId, now);
    const windowSessionId = action.windowSessionId;
    const rows = await db
      .update(instances)
      .set({
        windows: lifetime(
          windowSessionId,
          sql`jsonb_build_object('state', 'active',
              'expiresAt', least(${nowMs + IDLE_MS}::bigint, ${hardDeadlineMs()}),
              'primaryWindowId', ${action.nativeWindowId}::bigint)`,
        ),
        updatedAt: now,
      })
      .where(
        and(
          active,
          ownedWindow(owner, windowSessionId),
          eq(windowState(windowSessionId), "creating"),
          gt(windowExpiry(windowSessionId), nowMs),
          nativeWindowUnclaimed(windowSessionId, action.nativeWindowId),
        ),
      )
      .returning(instanceSelection());
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
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();
    const active = activeInstance(owner, action.instanceId, now);
    const windowSessionId = action.windowSessionId;
    const rows = await db
      .update(instances)
      .set({
        windows: lifetime(
          windowSessionId,
          sql`jsonb_build_object('expiresAt',
              least(${hardDeadlineMs()}, greatest(${windowExpiry(windowSessionId)}, ${nowMs + IDLE_MS}::bigint)))`,
        ),
        updatedAt: now,
      })
      .where(
        and(
          active,
          ownedWindow(owner, windowSessionId),
          eq(windowState(windowSessionId), "active"),
          gt(windowExpiry(windowSessionId), nowMs),
        ),
      )
      .returning(instanceSelection());
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
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();
    const scoped = ownedInstance(owner, action.instanceId);
    const windowSessionId = action.windowSessionId;
    const rows = await db
      .update(instances)
      .set({
        windows: lifetime(windowSessionId, sql`'{"state":"closing"}'::jsonb`),
        updatedAt: now,
      })
      .where(
        and(
          scoped,
          inArray(instances.status, ["active", "stopping"]),
          ownedWindow(owner, windowSessionId),
          inArray(windowState(windowSessionId), ["creating", "active"]),
          action.reason === "expired"
            ? lte(windowExpiry(windowSessionId), nowMs)
            : undefined,
        ),
      )
      .returning(instanceSelection());
    signal.throwIfAborted();
    return rows;
  },
);

const completeOwnerBrowserWindowClose$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: BrowserAction<"completeWindowClose">,
    now: Date,
    signal: AbortSignal,
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const scoped = ownedInstance(owner, action.instanceId);
    const rows = await db
      .update(instances)
      .set({
        windows: sql`${instances.windows} - ${action.windowSessionId}::text`,
        updatedAt: now,
      })
      .where(
        and(
          scoped,
          ownedWindow(owner, action.windowSessionId),
          eq(windowState(action.windowSessionId), "closing"),
        ),
      )
      .returning(instanceSelection());
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
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const nowMs = now.getTime();
    const scoped = ownedInstance(owner, action.instanceId);
    // This UPDATE competes with admission/renewal on the same current
    // aggregate. A snapshot-only scan of separate target rows cannot.
    const rows = await db
      .update(instances)
      .set({
        status: "stopping",
        windows: sql`(SELECT coalesce(jsonb_object_agg(entry.key,
              entry.value || '{"state":"closing"}'::jsonb), '{}'::jsonb)
              FROM jsonb_each(${instances.windows}) AS entry)`,
        updatedAt: now,
      })
      .where(
        and(
          scoped,
          or(
            eq(instances.status, "active"),
            and(
              eq(instances.status, "creating"),
              lte(instances.creationExpiresAt, now),
            ),
          ),
          notExists(sql`(SELECT 1 FROM jsonb_each(${instances.windows}) AS entry
              WHERE entry.value ->> 'state' IN ('creating', 'active')
                AND (entry.value ->> 'expiresAt')::bigint > ${nowMs})`),
        ),
      )
      .returning(instanceSelection());
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
  ): Promise<InstanceRow[]> => {
    const db = set(writeDb$);
    const scoped = ownedInstance(owner, action.instanceId);
    const rows = await db
      .update(instances)
      .set({ status: "stopped", windows: {}, updatedAt: now })
      .where(and(scoped, eq(instances.status, "stopping")))
      .returning(instanceSelection());
    signal.throwIfAborted();
    return rows;
  },
);

/** Each transition owns one statement over the current stored business state. */
export const controlBrowserOwner$ = command(
  async (
    { set },
    owner: BrowserOwnerAuthority,
    action: Exclude<RunnerBrowserAction, { kind: "inspect" }>,
    signal: AbortSignal,
  ): Promise<RunnerBrowserResponse> => {
    const now = nowDate();
    let rows: InstanceRow[];
    switch (action.kind) {
      case "allocate": {
        rows = await set(allocateOwnerBrowser$, owner, action, now, signal);
        break;
      }
      case "publish": {
        rows = await set(publishOwnerBrowser$, owner, action, now, signal);
        break;
      }
      case "admit": {
        rows = await set(admitOwnerBrowserWindow$, owner, action, now, signal);
        break;
      }
      case "registerAuxiliaryWindow": {
        rows = await set(
          registerOwnerBrowserAuxiliaryWindow$,
          owner,
          action,
          now,
          signal,
        );
        break;
      }
      case "activate": {
        rows = await set(
          activateOwnerBrowserWindow$,
          owner,
          action,
          now,
          signal,
        );
        break;
      }
      case "renew": {
        rows = await set(renewOwnerBrowserWindow$, owner, action, now, signal);
        break;
      }
      case "retire": {
        rows = await set(retireOwnerBrowserWindow$, owner, action, now, signal);
        break;
      }
      case "completeWindowClose": {
        rows = await set(
          completeOwnerBrowserWindowClose$,
          owner,
          action,
          now,
          signal,
        );
        break;
      }
      case "beginStop": {
        rows = await set(beginOwnerBrowserStop$, owner, action, now, signal);
        break;
      }
      case "completeStop": {
        rows = await set(completeOwnerBrowserStop$, owner, action, now, signal);
        break;
      }
    }
    signal.throwIfAborted();
    return response(rows[0], owner.chatThreadId);
  },
);
