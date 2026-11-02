import type { ConnectorAccountTarget } from "@okouai/api-contracts/contracts/connector-accounts";
import type { ApplyChatConnectorPermissions } from "@okouai/api-contracts/contracts/chat-connector-access";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import {
  chatThreadConnectorAccessOverrides,
  chatThreadConnectorPolicies,
  chatThreadConnectorPermissionGrants,
} from "@okouai/db/schema/chat-thread-connector-access";
import { userCustomConnectors } from "@okouai/db/schema/user-custom-connector";
import { userPermissionGrants } from "@okouai/db/schema/user-permission-grant";
import { and, eq, sql, type SQL } from "drizzle-orm";
import { resolveGrantExpiresAt } from "./permission-grant-apply-plan";

export interface ConnectorAccessOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly target: ConnectorAccountTarget;
}

export interface ChatConnectorAccessOwner extends ConnectorAccessOwner {
  readonly chatThreadId: string;
}

function connectorAccessTarget(target: ConnectorAccountTarget) {
  return target.kind === "builtin"
    ? eq(connectors.connectorSlug, target.connectorSlug)
    : eq(connectors.customConnectorId, target.customConnectorId);
}

export function connectorAccessAccountOwner(owner: ConnectorAccessOwner) {
  return and(
    eq(connectors.orgId, owner.orgId),
    eq(connectors.userId, owner.userId),
    connectorAccessTarget(owner.target),
  );
}

export function connectorAccessThreadOwner(owner: ChatConnectorAccessOwner) {
  return and(
    eq(chatThreads.id, owner.chatThreadId),
    eq(chatThreads.userId, owner.userId),
    eq(agents.orgId, owner.orgId),
  );
}

export function connectorAccessPolicyTarget(owner: ChatConnectorAccessOwner) {
  return and(
    eq(chatThreadConnectorPolicies.chatThreadId, owner.chatThreadId),
    owner.target.kind === "builtin"
      ? eq(
          chatThreadConnectorPolicies.connectorSlug,
          owner.target.connectorSlug,
        )
      : eq(
          chatThreadConnectorPolicies.customConnectorId,
          owner.target.customConnectorId,
        ),
  );
}

export function connectorAccessSelectionTarget(target: ConnectorAccountTarget) {
  return target.kind === "builtin"
    ? eq(chatThreadConnectorSelections.connectorSlug, target.connectorSlug)
    : eq(
        chatThreadConnectorSelections.customConnectorId,
        target.customConnectorId,
      );
}

/** A default transition uses the same ordered clear/promote ownership as account lifecycle. */
export function accountDefaultEnabledSql(
  owner: ConnectorAccessOwner,
  connectionId: string,
  enabled: boolean,
) {
  const owned = connectorAccessAccountOwner(owner);
  return sql`WITH previous AS MATERIALIZED (
    SELECT id, is_default FROM ${connectors}
    WHERE ${owned} AND ${eq(connectors.id, connectionId)}
  ), changed AS (
    UPDATE ${connectors} SET default_enabled_for_chats = ${enabled},
      is_default = CASE WHEN ${enabled} THEN is_default OR NOT EXISTS (
        SELECT 1 FROM ${connectors} WHERE ${owned}
          AND id <> ${connectionId}::uuid AND is_default
      ) ELSE false END,
      updated_at = clock_timestamp()
    WHERE ${owned} AND ${eq(connectors.id, connectionId)}
    RETURNING id, display_name, default_enabled_for_chats, is_default
  ), promoted AS (
    UPDATE ${connectors} SET is_default = true, updated_at = clock_timestamp()
    WHERE ${owned} AND id = (
      SELECT id FROM ${connectors} WHERE ${owned}
        AND id <> ${connectionId}::uuid AND default_enabled_for_chats
      ORDER BY created_at, id LIMIT 1
    ) AND NOT ${enabled} AND EXISTS (SELECT 1 FROM previous WHERE is_default)
      AND EXISTS (SELECT 1 FROM changed)
    RETURNING id
  ) SELECT id, display_name, default_enabled_for_chats, is_default FROM changed
    WHERE (SELECT count(*) FROM promoted) >= 0`;
}

/** Repair stored invalid choices on normal configuration writes, without touching Runs. */
export function repairChatConnectorSelectionsSql(
  owner: ConnectorAccessOwner,
  chatThreadId?: string,
) {
  const thread =
    chatThreadId === undefined
      ? sql.empty()
      : sql`AND ${eq(chatThreads.id, chatThreadId)}`;
  return sql`WITH invalid AS MATERIALIZED (
    SELECT ${chatThreads.id} AS chat_thread_id
    FROM ${chatThreadConnectorSelections}
    JOIN ${chatThreads} ON ${eq(chatThreads.id, chatThreadConnectorSelections.chatThreadId)}
    JOIN ${agents} ON ${eq(agents.id, chatThreads.agentId)}
    JOIN ${connectors} ON ${eq(connectors.id, chatThreadConnectorSelections.connectorId)}
    LEFT JOIN ${chatThreadConnectorAccessOverrides} ON
      ${eq(chatThreadConnectorAccessOverrides.chatThreadId, chatThreads.id)} AND
      ${eq(chatThreadConnectorAccessOverrides.connectorId, connectors.id)}
    WHERE ${and(eq(chatThreads.userId, owner.userId), eq(agents.orgId, owner.orgId), connectorAccessAccountOwner(owner))}
      AND NOT coalesce(${chatThreadConnectorAccessOverrides.enabled}, ${connectors.defaultEnabledForChats}) ${thread}
  ), choices AS MATERIALIZED (
    SELECT DISTINCT ON (invalid.chat_thread_id) invalid.chat_thread_id, ${connectors.id} AS connector_id
    FROM invalid JOIN ${connectors} ON ${connectorAccessAccountOwner(owner)}
    LEFT JOIN ${chatThreadConnectorAccessOverrides} ON
      ${chatThreadConnectorAccessOverrides.chatThreadId} = invalid.chat_thread_id AND
      ${eq(chatThreadConnectorAccessOverrides.connectorId, connectors.id)}
    WHERE coalesce(${chatThreadConnectorAccessOverrides.enabled}, ${connectors.defaultEnabledForChats})
    ORDER BY invalid.chat_thread_id, ${connectors.isDefault} DESC, ${connectors.createdAt}, ${connectors.id}
  ), replaced AS (
    UPDATE ${chatThreadConnectorSelections} SET connector_id = choices.connector_id
    FROM choices WHERE ${chatThreadConnectorSelections.chatThreadId} = choices.chat_thread_id
      AND ${connectorAccessSelectionTarget(owner.target)} RETURNING ${chatThreadConnectorSelections.chatThreadId}
  ) DELETE FROM ${chatThreadConnectorSelections} USING invalid
    WHERE ${chatThreadConnectorSelections.chatThreadId} = invalid.chat_thread_id
      AND ${connectorAccessSelectionTarget(owner.target)}
      AND NOT EXISTS (SELECT 1 FROM choices WHERE choices.chat_thread_id = invalid.chat_thread_id)
      AND (SELECT count(*) FROM replaced) >= 0`;
}

/** The inserted policy identity is the only source for the one-time grant copy. */
export function initializeChatConnectorPolicySql(
  owner: ChatConnectorAccessOwner,
) {
  const slug =
    owner.target.kind === "builtin" ? owner.target.connectorSlug : null;
  const customId =
    owner.target.kind === "custom" ? owner.target.customConnectorId : null;
  return sql`WITH owned_thread AS MATERIALIZED (
    SELECT ${chatThreads.id} AS id, ${agents.id} AS agent_id
    FROM ${chatThreads} JOIN ${agents} ON ${eq(agents.id, chatThreads.agentId)}
    WHERE ${connectorAccessThreadOwner(owner)}
  ), initialized AS (
    INSERT INTO ${chatThreadConnectorPolicies} (chat_thread_id, connector_slug, custom_connector_id, permission_names)
    SELECT owned_thread.id, ${slug}::varchar, ${customId}::uuid,
      coalesce(${userCustomConnectors.permissionNames}, '{}'::text[])
    FROM owned_thread LEFT JOIN ${userCustomConnectors} ON
      ${eq(userCustomConnectors.orgId, owner.orgId)} AND ${eq(userCustomConnectors.userId, owner.userId)}
      AND ${userCustomConnectors.agentId} = owned_thread.agent_id
      AND ${userCustomConnectors.customConnectorId} = ${customId}::uuid
    WHERE EXISTS (SELECT 1 FROM ${connectors} WHERE ${connectorAccessAccountOwner(owner)})
    ON CONFLICT DO NOTHING RETURNING id
  ) INSERT INTO ${chatThreadConnectorPermissionGrants} (policy_id, permission, action, expires_at)
    SELECT initialized.id, ${userPermissionGrants.permission}, ${userPermissionGrants.action}, ${userPermissionGrants.expiresAt}
    FROM initialized CROSS JOIN owned_thread JOIN ${userPermissionGrants} ON
      ${eq(userPermissionGrants.orgId, owner.orgId)} AND ${eq(userPermissionGrants.userId, owner.userId)}
      AND ${userPermissionGrants.agentId} = owned_thread.agent_id
      AND ${userPermissionGrants.connectorSlug} = ${slug}::varchar`;
}

export function saveChatConnectorCurrentSql(
  owner: ChatConnectorAccessOwner,
  connectionId: string,
) {
  const conflict =
    owner.target.kind === "builtin"
      ? sql`(chat_thread_id, connector_slug) WHERE connector_slug IS NOT NULL`
      : sql`(chat_thread_id, custom_connector_id) WHERE custom_connector_id IS NOT NULL`;
  return sql`INSERT INTO ${chatThreadConnectorSelections} (chat_thread_id, connector_id, connector_slug, custom_connector_id)
    SELECT ${chatThreads.id}, ${connectors.id}, ${connectors.connectorSlug}, ${connectors.customConnectorId}
    FROM ${chatThreads} JOIN ${agents} ON ${eq(agents.id, chatThreads.agentId)}
    JOIN ${connectors} ON ${connectorAccessAccountOwner(owner)}
    LEFT JOIN ${chatThreadConnectorAccessOverrides} ON
      ${eq(chatThreadConnectorAccessOverrides.chatThreadId, chatThreads.id)} AND
      ${eq(chatThreadConnectorAccessOverrides.connectorId, connectors.id)}
    WHERE ${connectorAccessThreadOwner(owner)} AND ${eq(connectors.id, connectionId)}
      AND coalesce(${chatThreadConnectorAccessOverrides.enabled}, ${connectors.defaultEnabledForChats})
    ON CONFLICT ${conflict} DO UPDATE SET connector_id = excluded.connector_id
    RETURNING connector_id`;
}

/** Keep selected names, replacement removals and explicit grants in one statement. */
export function chatConnectorPermissionMutationSql(
  policyId: string,
  apply: ApplyChatConnectorPermissions,
  updatedPolicy: SQL,
  timestamp: Date,
) {
  const values = apply.grants.map((grant) => {
    const expiresAt = resolveGrantExpiresAt(
      grant.action === "allow" ? grant.expiresIn : undefined,
      timestamp,
    );
    return sql`(${policyId}::uuid, ${grant.permission}::varchar, ${grant.action}::varchar, ${sql.param(expiresAt, chatThreadConnectorPermissionGrants.expiresAt)}::timestamp)`;
  });
  const requested = apply.grants.map((grant) => {
    return grant.permission;
  });
  const deletion = sql`DELETE FROM ${chatThreadConnectorPermissionGrants}
    WHERE ${eq(chatThreadConnectorPermissionGrants.policyId, policyId)} AND ${apply.mode === "replace"}
      AND NOT (${chatThreadConnectorPermissionGrants.permission} = ANY(${sql.param(requested)}::varchar[]))
      AND EXISTS (SELECT 1 FROM updated_chat_policy) RETURNING policy_id`;
  const insertion =
    values.length === 0
      ? sql`SELECT count(*) FROM removed_chat_grants`
      : sql`INSERT INTO ${chatThreadConnectorPermissionGrants} (policy_id, permission, action, expires_at)
      SELECT requested.* FROM (VALUES ${sql.join(values, sql`, `)}) AS requested(policy_id, permission, action, expires_at)
      WHERE EXISTS (SELECT 1 FROM updated_chat_policy) AND (SELECT count(*) FROM removed_chat_grants) >= 0
      ON CONFLICT (policy_id, permission) DO UPDATE SET action = excluded.action, expires_at = excluded.expires_at`;
  return sql`WITH updated_chat_policy AS (${updatedPolicy}), removed_chat_grants AS (${deletion}) ${insertion}`;
}
