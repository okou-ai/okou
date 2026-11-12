import { hostAuthorizationPermissionsSchema } from "@okouai/api-contracts/contracts/host-authorization";
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
  sshAuthorizationSchema,
  type SshAuthorization,
} from "@okouai/api-contracts/contracts/ssh-authorization";
import { vncAuthorizations } from "@okouai/db/schema/vnc-authorization";
import { vncAuthorizationSchema } from "@okouai/api-contracts/contracts/vnc-authorization";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { chatThreadVncAccessOverrides } from "@okouai/db/schema/chat-thread-vnc-access-override";
import {
  vncAuthorizationConditions,
  readVncSshDependencies$,
} from "./vnc-authorization-dependencies.service";
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

type Protocol = "ssh" | "vnc";
function configuration(protocol: Protocol) {
  const requests = protocol === "ssh" ? sshAuthorizations : vncAuthorizations;
  const hosts = protocol === "ssh" ? sshConnections : vncConnections;
  const overrides =
    protocol === "ssh"
      ? chatThreadSshAccessOverrides
      : chatThreadVncAccessOverrides;
  const conditions = vncAuthorizationConditions(requests.chatThreadId);
  const needsRebind =
    protocol === "ssh" ? sshConnectionNeedsRebind : not(conditions.available);
  const available =
    protocol === "ssh" ? not(sshConnectionNeedsRebind) : conditions.available;
  const dependenciesAllowed =
    protocol === "ssh" ? sql`true` : conditions.dependenciesAllowed;
  return {
    requests,
    hosts,
    overrides,
    needsRebind,
    available,
    dependenciesAllowed,
  };
}
function ownedHost(owner: Owner, protocol: Protocol) {
  const { requests, hosts } = configuration(protocol);
  return and(
    eq(hosts.id, requests.connectionId),
    eq(hosts.orgId, owner.orgId),
    eq(hosts.userId, owner.userId),
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

const readHostAuthorizationContext$ = command(
  async (
    { get },
    protocol: Protocol,
    owner: Owner,
    id: string,
    signal: AbortSignal,
  ) => {
    const { requests, hosts, overrides, needsRebind, dependenciesAllowed } =
      configuration(protocol);
    const q = new QueryBuilder();
    const [context] = await get(db$)
      .select({
        row: requests,
        agentId: chatThreads.agentId,
        displayName: hosts.displayName,
        host: hosts.host,
        port: hosts.port,
        username:
          protocol === "ssh"
            ? sql`(SELECT coalesce(${sshConnections.tailscaleSshUsername}, ${sshCredentials.username})
        FROM ${sshConnections} LEFT JOIN ${sshCredentials} ON ${sshCredentials.id} = ${sshConnections.credentialId}
        WHERE ${sshConnections.id} = ${requests.connectionId})`.mapWith(
                sshCredentials.username,
              )
            : sql`''`.mapWith(sshCredentials.username),
        generation: hosts.generation,
        needsRebind: sql`${needsRebind}`.mapWith(pgBooleanDecoder),
        dependenciesAllowed: sql`${dependenciesAllowed}`.mapWith(
          pgBooleanDecoder,
        ),
        sourceRunStatus: agentRuns.status,
        enabled:
          sql`coalesce(${overrides.enabled}, ${hosts.defaultEnabledForChats})`.mapWith(
            pgBooleanDecoder,
          ),
        continued: exists(
          q
            .select({ id: chatEvents.id })
            .from(chatEvents)
            .where(
              and(
                eq(chatEvents.id, requests.id),
                eq(chatEvents.chatThreadId, requests.chatThreadId),
              ),
            ),
        ).mapWith(pgBooleanDecoder),
        busy: exists(
          q
            .select({ id: activeAgentRuns.runId })
            .from(activeAgentRuns)
            .where(eq(activeAgentRuns.chatThreadId, requests.chatThreadId)),
        ).mapWith(pgBooleanDecoder),
      })
      .from(requests)
      .innerJoin(
        chatThreads,
        and(
          eq(chatThreads.id, requests.chatThreadId),
          eq(chatThreads.userId, owner.userId),
        ),
      )
      .innerJoin(
        agents,
        and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, owner.orgId)),
      )
      .innerJoin(hosts, ownedHost(owner, protocol))
      .leftJoin(
        overrides,
        and(
          eq(overrides.chatThreadId, chatThreads.id),
          eq(overrides.connectionId, hosts.id),
        ),
      )
      .leftJoin(
        agentRuns,
        and(
          eq(agentRuns.id, requests.requestedByRunId),
          eq(agentRuns.chatThreadId, chatThreads.id),
          eq(agentRuns.userId, owner.userId),
          eq(agentRuns.orgId, owner.orgId),
        ),
      )
      .where(
        and(
          eq(requests.id, id),
          eq(requests.orgId, owner.orgId),
          eq(requests.userId, owner.userId),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return context ?? null;
  },
);

type ReadContext = NonNullable<
  Awaited<ReturnType<(typeof readHostAuthorizationContext$)["write"]>>
>;
function authorizationStatus(
  context: ReadContext,
  at: Date,
): SshAuthorization["status"] {
  if (context.generation !== context.row.generation || context.needsRebind) {
    return "stale";
  }
  if (context.row.status === "pending" && context.row.requestExpiresAt <= at) {
    return "expired";
  }
  if (context.row.status === "approved" && !context.enabled) {
    return "revoked";
  }
  return context.row.status;
}
function approvalBlocker(
  context: ReadContext,
  status: SshAuthorization["status"],
  permissionsAllowed: boolean,
): SshAuthorization["approvalBlockedReason"] {
  if (status === "stale") {
    return "host_changed";
  }
  if (status !== "pending") {
    return null;
  }
  if (context.sourceRunStatus === null) {
    return "run_unavailable";
  }
  if (
    !["completed", "failed", "cancelled", "timeout"].includes(
      context.sourceRunStatus,
    )
  ) {
    return "run_active";
  }
  if (context.busy) {
    return "chat_busy";
  }
  if (!permissionsAllowed) {
    return "permissions_required";
  }
  if (!context.dependenciesAllowed) {
    return "ssh_access_required";
  }
  return null;
}

export const readHostAuthorization$ = command(
  async (
    { get, set },
    protocol: Protocol,
    owner: Owner,
    id: string,
    signal: AbortSignal,
  ) => {
    const { requests } = configuration(protocol);
    const schema =
      protocol === "ssh" ? sshAuthorizationSchema : vncAuthorizationSchema;
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
    const context = await set(
      readHostAuthorizationContext$,
      protocol,
      owner,
      id,
      signal,
    );
    if (!context?.agentId) {
      return null;
    }
    const { row } = context;
    const required = hostAuthorizationPermissionsSchema.parse(
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
            .from(requests)
            .where(eq(requests.id, id));
    signal.throwIfAborted();
    const status = authorizationStatus(context, nowDate());
    const blocker = approvalBlocker(
      context,
      status,
      permissions?.allowed === true,
    );
    const requiredSshHosts =
      protocol === "vnc"
        ? await set(
            readVncSshDependencies$,
            owner,
            row.connectionId,
            row.chatThreadId,
            signal,
          )
        : [];
    const authorization = schema.parse({
      id: row.id,
      chatThreadId: row.chatThreadId,
      connectionId: row.connectionId,
      requestedByRunId: row.requestedByRunId,
      displayName: context.displayName,
      host: context.host,
      port: context.port,
      ...(protocol === "ssh"
        ? { username: context.username }
        : { requiredSshHosts }),
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
      authorizationUrl: `${env("APP_URL")}/${protocol}/authorize/${row.id}`,
    });
    return {
      protocol,
      authorization,
      row,
      agentId: context.agentId,
      memberMode,
      permissionsAllowed: permissions?.allowed === true,
      dependenciesAllowed: context.dependenciesAllowed,
    };
  },
);

export const createHostAuthorization$ = command(
  async (
    { get, set },
    protocol: Protocol,
    args: Owner & {
      readonly runId: string;
      readonly connectionId: string;
      readonly reason: string;
      readonly callbackPrompt: string;
      readonly requiredPermissions: Request["requiredPermissions"];
    },
    signal: AbortSignal,
  ) => {
    const { requests, hosts, available } = configuration(protocol);
    const db = set(writeDb$);
    // Both request tables use the same PostgreSQL column representations.
    const source = db
      .select({
        id: sql`${randomUUID()}::uuid`.mapWith(sshAuthorizations.id).as("id"),
        orgId: agentRuns.orgId,
        userId: agentRuns.userId,
        chatThreadId: chatThreads.id,
        connectionId: hosts.id,
        generation: hosts.generation,
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
        hosts,
        and(
          eq(hosts.id, args.connectionId),
          eq(hosts.orgId, args.orgId),
          eq(hosts.userId, args.userId),
          available,
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
      .insert(requests)
      .select(source)
      .onConflictDoNothing()
      .returning({ id: requests.id });
    signal.throwIfAborted();
    if (created) {
      return created.id;
    }
    const [existing] = await get(db$)
      .select({ id: requests.id })
      .from(requests)
      .innerJoin(hosts, ownedHost(args, protocol))
      .where(
        and(
          eq(requests.orgId, args.orgId),
          eq(requests.userId, args.userId),
          eq(requests.requestedByRunId, args.runId),
          eq(requests.connectionId, args.connectionId),
          eq(requests.generation, hosts.generation),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    return existing?.id ?? null;
  },
);

type Context = NonNullable<
  Awaited<ReturnType<(typeof readHostAuthorization$)["write"]>>
>;

/** Request decision and effective chat selection commit in one SQL statement. */
export const decideHostAuthorization$ = command(
  async (
    { set },
    owner: Owner,
    context: Context,
    action: "approve" | "deny" | "revoke",
    signal: AbortSignal,
  ) => {
    const { requests, hosts, overrides, available, dependenciesAllowed } =
      configuration(context.protocol);
    const { row, agentId, memberMode, protocol } = context;
    const db = set(writeDb$);
    const q = new QueryBuilder();
    const validScope = exists(
      q
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .innerJoin(agents, eq(agents.id, chatThreads.agentId))
        .innerJoin(hosts, ownedHost(owner, protocol))
        .where(
          and(
            eq(chatThreads.id, row.chatThreadId),
            eq(chatThreads.userId, owner.userId),
            eq(agents.orgId, owner.orgId),
            eq(hosts.generation, row.generation),
            available,
            action === "approve" ? dependenciesAllowed : undefined,
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
      .update(hosts)
      .set({ generation: hosts.generation })
      .where(
        and(
          eq(hosts.id, row.connectionId),
          eq(hosts.orgId, owner.orgId),
          eq(hosts.userId, owner.userId),
          eq(hosts.generation, row.generation),
          action === "approve" ? sql`true` : sql`false`,
        ),
      )
      .returning({ id: hosts.id });
    const decision = db
      .update(requests)
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
          eq(requests.id, row.id),
          eq(requests.orgId, owner.orgId),
          eq(requests.userId, owner.userId),
          eq(requests.status, action === "revoke" ? "approved" : "pending"),
          validScope,
          action === "approve"
            ? and(
                gt(requests.requestExpiresAt, nowDate()),
                sql`EXISTS (SELECT 1 FROM reviewed_remote_authorization_host)`,
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
        id: requests.id,
        chatThreadId: requests.chatThreadId,
        connectionId: requests.connectionId,
      });
    const outcome =
      action === "deny"
        ? await decision
        : parseRawRows(
            object({ id: uuid() }),
            await db.execute(sql`
  WITH reviewed_remote_authorization_host AS (${reviewedHost.getSQL()}), decided AS (${decision.getSQL()}), enabled AS (
    INSERT INTO ${overrides} (chat_thread_id, connection_id, enabled)
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
export const markHostAuthorizationContinued$ = command(
  async (
    { set },
    protocol: Protocol,
    owner: Owner,
    id: string,
    signal: AbortSignal,
  ) => {
    const { requests } = configuration(protocol);
    await set(writeDb$)
      .update(requests)
      .set({
        continuationQueuedAt: sql`coalesce(${requests.continuationQueuedAt}, ${nowDate().toISOString()}::timestamp)`,
      })
      .where(
        and(
          eq(requests.id, id),
          eq(requests.orgId, owner.orgId),
          eq(requests.userId, owner.userId),
        ),
      );
    signal.throwIfAborted();
  },
);
