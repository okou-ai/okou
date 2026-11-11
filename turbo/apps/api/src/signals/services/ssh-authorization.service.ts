import { randomUUID } from "node:crypto";
import { command } from "ccstate";
import {
  and,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  not,
  or,
  sql,
} from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";
import { object, uuid } from "zod";
import { isFeatureEnabled } from "@okouai/core/feature-switch";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import {
  sshAuthorizationPermissionsSchema,
  type SshAuthorization,
} from "@okouai/api-contracts/contracts/ssh-authorization";
import { sshAuthorizations } from "@okouai/db/schema/ssh-authorization";
import {
  sshConnections,
  sshConnectionNeedsRebind,
} from "@okouai/db/runtime/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
import { chatThreadSshAccessOverrides } from "@okouai/db/schema/chat-thread-ssh-access-override";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { agents } from "@okouai/db/schema/agent";
import { activeAgentRuns } from "@okouai/db/schema/active-agent-run";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { connectorPermissionGrants } from "@okouai/db/schema/connector-permission-grant";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { env } from "../../lib/env";
import { nowDate } from "../../lib/time";
import { parseRawRows } from "../../lib/db-raw-rows";
import { pgBooleanDecoder } from "../../lib/db-structured-result";
import { db$, writeDb$ } from "../external/db";
import { loadUserFeatureSwitchContext$ } from "./feature-switches.service";
import {
  memberConnectorPermissionColumns,
  activeMemberConnectorPermissionCondition,
} from "./member-connector-selection";

interface Owner {
  readonly orgId: string;
  readonly userId: string;
}
type Request = typeof sshAuthorizations.$inferSelect;

function ownedHost(owner: Owner) {
  return and(
    eq(sshConnections.id, sshAuthorizations.connectionId),
    eq(sshConnections.orgId, owner.orgId),
    eq(sshConnections.userId, owner.userId),
  );
}

/** Dependencies are the explicit approvals accompanying this request. */
function permissionsCondition(
  owner: Owner,
  agentId: string,
  required: Request["requiredPermissions"],
  memberMode: boolean,
  at: Date,
) {
  const q = new QueryBuilder();
  return (
    and(
      ...required.map((item) => {
        return memberMode
          ? exists(
              q
                .select({ id: connectorPermissionGrants.id })
                .from(connectorPermissionGrants)
                .where(
                  and(
                    activeMemberConnectorPermissionCondition(owner, at),
                    eq(
                      memberConnectorPermissionColumns().connectorSlug,
                      item.connectorSlug,
                    ),
                    eq(connectorPermissionGrants.permission, item.permission),
                    eq(connectorPermissionGrants.action, "allow"),
                  ),
                ),
            )
          : exists(
              q
                .select({ id: userPermissionGrants.id })
                .from(userPermissionGrants)
                .where(
                  and(
                    eq(userPermissionGrants.orgId, owner.orgId),
                    eq(userPermissionGrants.userId, owner.userId),
                    eq(userPermissionGrants.agentId, agentId),
                    eq(userPermissionGrants.connectorSlug, item.connectorSlug),
                    eq(userPermissionGrants.permission, item.permission),
                    eq(userPermissionGrants.action, "allow"),
                    or(
                      isNull(userPermissionGrants.expiresAt),
                      gt(userPermissionGrants.expiresAt, at),
                    ),
                  ),
                ),
            );
      }),
    ) ?? sql`true`
  );
}

const readSshAuthorizationContext$ = command(
  async ({ get }, owner: Owner, id: string, signal: AbortSignal) => {
    const q = new QueryBuilder();
    const [context] = await get(db$)
      .select({
        row: sshAuthorizations,
        agentId: chatThreads.agentId,
        displayName: sshConnections.displayName,
        host: sshConnections.host,
        port: sshConnections.port,
        username:
          sql`coalesce(${sshConnections.tailscaleSshUsername}, ${sshCredentials.username})`.mapWith(
            sshCredentials.username,
          ),
        generation: sshConnections.generation,
        needsRebind: sshConnectionNeedsRebind,
        sourceRunStatus: agentRuns.status,
        enabled:
          sql`coalesce(${chatThreadSshAccessOverrides.enabled}, ${sshConnections.defaultEnabledForChats})`.mapWith(
            pgBooleanDecoder,
          ),
        continued: exists(
          q
            .select({ id: chatEvents.id })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.id, sshAuthorizations.id),
                eq(chatEvents.chatThreadId, sshAuthorizations.chatThreadId),
              ),
            ),
        ).mapWith(pgBooleanDecoder),
        busy: exists(
          q
            .select({ id: activeAgentRuns.runId })
            .from(activeAgentRuns)
            .where(
              eq(activeAgentRuns.chatThreadId, sshAuthorizations.chatThreadId),
            ),
        ).mapWith(pgBooleanDecoder),
      })
      .from(sshAuthorizations)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, sshAuthorizations.chatThreadId),
          eq(chatThreads.userId, owner.userId),
        ),
      )
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, owner.orgId)),
      )
      .innerJoin(sshConnections, ownedHost(owner))
      .leftJoin(
        sshCredentials,
        eq(sshCredentials.id, sshConnections.credentialId),
      )
      .leftJoin(
        chatThreadSshAccessOverrides,
        and(
          eq(chatThreadSshAccessOverrides.chatThreadId, chatThreads.id),
          eq(chatThreadSshAccessOverrides.connectionId, sshConnections.id),
        ),
      )
      .leftJoin(
        agentRuns,
        and(
          eq(agentRuns.id, sshAuthorizations.requestedByRunId),
          eq(agentRuns.chatThreadId, chatThreads.id),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.orgId, owner.orgId),
        ),
      )
      .where(
        and(
          eq(sshAuthorizations.id, id),
          eq(sshAuthorizations.orgId, owner.orgId),
          eq(sshAuthorizations.userId, owner.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return context ?? null;
  },
);

export const readSshAuthorization$ = command(
  async ({ get, set }, owner: Owner, id: string, signal: AbortSignal) => {
    const features = await set(
      loadUserFeatureSwitchContext$,
      owner.orgId,
      owner.userId,
      signal,
    );
    const memberMode = isFeatureEnabled(
      FeatureSwitchKey.ConnectorChatAccountAccess,
      features,
    );
    const context = await set(readSshAuthorizationContext$, owner, id, signal);
    if (!context?.agentId) {
      return null;
    }
    const { row } = context;
    const required = sshAuthorizationPermissionsSchema.parse(
      row.requiredPermissions,
    );
    const permissionPredicate = permissionsCondition(
      owner,
      context.agentId,
      required,
      memberMode,
      nowDate(),
    );
    const [permissions] =
      required.length === 0
        ? [{ allowed: true }]
        : await get(db$)
            .select({
              allowed: sql`${permissionPredicate}`.mapWith(pgBooleanDecoder),
            })
            .from(sshAuthorizations)
            .where(eq(sshAuthorizations.id, id));
    signal.throwIfAborted();
    const changed =
      context.generation !== row.generation || context.needsRebind;
    const status: SshAuthorization["status"] = changed
      ? "stale"
      : row.status === "pending" && row.requestExpiresAt <= nowDate()
        ? "expired"
        : row.status === "approved" && !context.enabled
          ? "revoked"
          : row.status;
    const blocker: SshAuthorization["approvalBlockedReason"] = changed
      ? "host_changed"
      : status !== "pending"
        ? null
        : context.sourceRunStatus === null
          ? "run_unavailable"
          : !["completed", "failed", "cancelled", "timeout"].includes(
                context.sourceRunStatus,
              )
            ? "run_active"
            : context.busy
              ? "chat_busy"
              : !permissions?.allowed
                ? "permissions_required"
                : null;
    const authorization: SshAuthorization = {
      id: row.id,
      chatThreadId: row.chatThreadId,
      connectionId: row.connectionId,
      requestedByRunId: row.requestedByRunId,
      displayName: context.displayName,
      host: context.host,
      port: context.port,
      username: context.username,
      reason: row.reason,
      status,
      requestExpiresAt: row.requestExpiresAt.toISOString(),
      enabled: context.enabled,
      continuationPending:
        row.status === "approved" &&
        row.continuationQueuedAt === null &&
        !context.continued,
      approvalBlockedReason: blocker,
      requiredPermissions: required,
      authorizationUrl: `${env("APP_URL")}/ssh/authorize/${row.id}`,
    };
    return {
      authorization,
      row,
      agentId: context.agentId,
      memberMode,
      permissionsAllowed: permissions?.allowed === true,
    };
  },
);

export const createSshAuthorization$ = command(
  async (
    { get, set },
    args: Owner & {
      readonly runId: string;
      readonly connectionId: string;
      readonly reason: string;
      readonly callbackPrompt: string;
      readonly requiredPermissions: Request["requiredPermissions"];
    },
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const source = db
      .select({
        id: sql`${randomUUID()}::uuid`.mapWith(sshAuthorizations.id).as("id"),
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        chatThreadId: chatThreads.id,
        connectionId: sshConnections.id,
        generation: sshConnections.generation,
        requestedByRunId: agentRuns.id,
        reason: sql`${args.reason}`
          .mapWith(sshAuthorizations.reason)
          .as("reason"),
        callbackPrompt: sql`${args.callbackPrompt}`
          .mapWith(sshAuthorizations.callbackPrompt)
          .as("callback_prompt"),
        requiredPermissions:
          sql`${JSON.stringify(args.requiredPermissions)}::jsonb`
            .mapWith(sshAuthorizations.requiredPermissions)
            .as("required_permissions"),
        status: sql`'pending'`.mapWith(sshAuthorizations.status).as("status"),
        requestExpiresAt:
          sql`${new Date(nowDate().getTime() + 3_600_000).toISOString()}::timestamp`
            .mapWith(sshAuthorizations.requestExpiresAt)
            .as("request_expires_at"),
        continuationQueuedAt: sql`NULL::timestamp`
          .mapWith(sshAuthorizations.continuationQueuedAt)
          .as("continuation_queued_at"),
        createdAt: sql`${nowDate().toISOString()}::timestamp`
          .mapWith(sshAuthorizations.createdAt)
          .as("created_at"),
      })
      .from(agentRuns)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, agentRuns.chatThreadId),
          eq(chatThreads.userId, args.userId),
        ),
      )
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, args.orgId)),
      )
      .innerJoin(
        sshConnections,
        and(
          eq(sshConnections.id, args.connectionId),
          eq(sshConnections.orgId, args.orgId),
          eq(sshConnections.userId, args.userId),
          not(sshConnectionNeedsRebind),
        ),
      )
      .where(
        and(
          eq(agentRuns.id, args.runId),
          eq(agentRuns.orgId, args.orgId),
          eq(agentRuns.userId, args.userId),
          eq(agentRuns.triggerSource, "web"),
          inArray(agentRuns.status, ["pending", "running"]),
        ),
      );
    const [created] = await db
      .insert(sshAuthorizations)
      .select(source)
      .onConflictDoNothing()
      .returning({ id: sshAuthorizations.id });
    signal.throwIfAborted();
    if (created) {
      return created.id;
    }
    const [existing] = await get(db$)
      .select({ id: sshAuthorizations.id })
      .from(sshAuthorizations)
      .innerJoin(sshConnections, ownedHost(args))
      .where(
        and(
          eq(sshAuthorizations.orgId, args.orgId),
          eq(sshAuthorizations.userId, args.userId),
          eq(sshAuthorizations.requestedByRunId, args.runId),
          eq(sshAuthorizations.connectionId, args.connectionId),
          eq(sshAuthorizations.generation, sshConnections.generation),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return existing?.id ?? null;
  },
);

type Context = NonNullable<
  Awaited<ReturnType<(typeof readSshAuthorization$)["write"]>>
>;

/** Request decision and effective chat selection commit in one SQL statement. */
export const decideSshAuthorization$ = command(
  async (
    { set },
    owner: Owner,
    context: Context,
    action: "approve" | "deny" | "revoke",
    signal: AbortSignal,
  ) => {
    const { row, agentId, memberMode } = context;
    const db = set(writeDb$);
    const q = new QueryBuilder();
    const validScope = exists(
      q
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .innerJoin(sshConnections, ownedHost(owner))
        .where(
          and(
            eq(chatThreads.id, row.chatThreadId),
            eq(chatThreads.userId, owner.userId),
            eq(agents.orgId, owner.orgId),
            eq(sshConnections.generation, row.generation),
            not(sshConnectionNeedsRebind),
          ),
        ),
    );
    const runEnded = exists(
      q
        .select({ id: agentRuns.id })
        .from(agentRuns)
        .where(
          and(
            eq(agentRuns.id, row.requestedByRunId),
            eq(agentRuns.orgId, owner.orgId),
            eq(agentRuns.userId, owner.userId),
            eq(agentRuns.chatThreadId, row.chatThreadId),
            inArray(agentRuns.status, [
              "completed",
              "failed",
              "cancelled",
              "timeout",
            ]),
          ),
        ),
    );
    const idle = not(
      exists(
        q
          .select({ id: activeAgentRuns.runId })
          .from(activeAgentRuns)
          .where(eq(activeAgentRuns.chatThreadId, row.chatThreadId)),
      ),
    );
    // Validate the reviewed generation at the write boundary too. A conditional
    // identity write serializes this publication with ordinary host edits without
    // changing the host configuration or its generation.
    const reviewedHost = db
      .update(sshConnections)
      .set({ generation: sshConnections.generation })
      .where(
        and(
          eq(sshConnections.id, row.connectionId),
          eq(sshConnections.orgId, owner.orgId),
          eq(sshConnections.userId, owner.userId),
          eq(sshConnections.generation, row.generation),
          action === "approve" ? sql`true` : sql`false`,
        ),
      )
      .returning({ id: sshConnections.id });
    const decision = db
      .update(sshAuthorizations)
      .set({
        status:
          action === "approve"
            ? "approved"
            : action === "deny"
              ? "denied"
              : "revoked",
      })
      .where(
        and(
          eq(sshAuthorizations.id, row.id),
          eq(sshAuthorizations.orgId, owner.orgId),
          eq(sshAuthorizations.userId, owner.userId),
          eq(
            sshAuthorizations.status,
            action === "revoke" ? "approved" : "pending",
          ),
          validScope,
          action === "approve"
            ? and(
                gt(sshAuthorizations.requestExpiresAt, nowDate()),
                sql`EXISTS (SELECT 1 FROM reviewed_ssh_authorization_host)`,
                runEnded,
                idle,
                permissionsCondition(
                  owner,
                  agentId,
                  row.requiredPermissions,
                  memberMode,
                  nowDate(),
                ),
              )
            : undefined,
        ),
      )
      .returning({
        id: sshAuthorizations.id,
        chatThreadId: sshAuthorizations.chatThreadId,
        connectionId: sshAuthorizations.connectionId,
      });
    const outcome =
      action === "deny"
        ? await decision
        : parseRawRows(
            object({ id: uuid() }),
            await db.execute(sql`
    WITH reviewed_ssh_authorization_host AS (${reviewedHost.getSQL()}), decided AS (${decision.getSQL()}), enabled AS (
      INSERT INTO ${chatThreadSshAccessOverrides} (chat_thread_id, connection_id, enabled)
      SELECT chat_thread_id, connection_id, ${action === "approve"} FROM decided
      ON CONFLICT (chat_thread_id, connection_id) DO UPDATE SET enabled = excluded.enabled
      RETURNING connection_id
    ) SELECT decided.id FROM decided JOIN enabled ON enabled.connection_id = decided.connection_id
  `),
          );
    signal.throwIfAborted();
    return outcome.length > 0;
  },
);

/** Retain the enqueue receipt independently of chat-event retention. */
export const markSshAuthorizationContinued$ = command(
  async ({ set }, owner: Owner, id: string, signal: AbortSignal) => {
    await set(writeDb$)
      .update(sshAuthorizations)
      .set({
        continuationQueuedAt: sql`coalesce(${sshAuthorizations.continuationQueuedAt}, ${nowDate().toISOString()}::timestamp)`,
      })
      .where(
        and(
          eq(sshAuthorizations.id, id),
          eq(sshAuthorizations.orgId, owner.orgId),
          eq(sshAuthorizations.userId, owner.userId),
        ),
      );
    signal.throwIfAborted();
  },
);
