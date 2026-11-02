import { command, computed, type Computed } from "ccstate";
import type {
  ChatConnectorAccess,
  ChatConnectorPermissions,
  ApplyChatConnectorPermissions,
} from "@okouai/api-contracts/contracts/chat-connector-access";
import { UNKNOWN_PERMISSION_GRANT } from "@okouai/connectors/firewall-types";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import {
  chatThreadConnectorAccessOverrides,
  chatThreadConnectorPolicies,
  chatThreadConnectorPermissionGrants,
} from "@okouai/db/schema/chat-thread-connector-access";
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { and, asc, eq, exists, gt, isNull, or } from "drizzle-orm";
import { boolean, object, string, uuid } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { isConnectorAccountDefaultConflict } from "./connector-account-lifecycle.service";
import {
  connectorCatalogCurrentWhere,
  connectorRuntimeSlugSelectionReadPlan,
  connectorRuntimeSlugSelectionFromRows,
} from "./connector-catalog-slug-source.service";
import {
  customConnectorPermissionBundleDependencySlug,
  loadCustomConnectorPermissionBundle,
} from "./custom-connector-permission-bundle.service";
import {
  accountDefaultEnabledSql,
  chatConnectorPermissionMutationSql,
  connectorAccessAccountOwner,
  connectorAccessPolicyTarget,
  connectorAccessSelectionTarget,
  connectorAccessThreadOwner,
  initializeChatConnectorPolicySql,
  repairChatConnectorSelectionsSql,
  saveChatConnectorCurrentSql,
  type ChatConnectorAccessOwner,
  type ConnectorAccessOwner,
} from "./chat-connector-access-sql";

function accountColumns() {
  return {
    connectionId: connectors.id,
    displayName: connectors.displayName,
    defaultEnabled: connectors.defaultEnabledForChats,
    isDefault: connectors.isDefault,
  };
}

export function connectorAccountAccessDefaults(
  scope$: Computed<ConnectorAccessOwner>,
) {
  return computed(async (get) => {
    const owner = get(scope$);
    return await get(db$)
      .select(accountColumns())
      .from(connectors)
      .where(connectorAccessAccountOwner(owner))
      .orderBy(asc(connectors.createdAt), asc(connectors.id));
  });
}

export function chatConnectorAccess(
  scope$: Computed<
    ChatConnectorAccessOwner | null | Promise<ChatConnectorAccessOwner | null>
  >,
) {
  return computed(async (get): Promise<ChatConnectorAccess | null> => {
    const owner = await get(scope$);
    if (!owner) {
      return null;
    }
    const db = get(db$);
    const [thread] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(connectorAccessThreadOwner(owner))
      .limit(1);
    if (!thread) {
      return null;
    }
    const [accounts, selections] = await Promise.all([
      db
        .select({
          ...accountColumns(),
          overrideEnabled: chatThreadConnectorAccessOverrides.enabled,
        })
        .from(connectors)
        .leftJoin(
          chatThreadConnectorAccessOverrides,
          and(
            eq(chatThreadConnectorAccessOverrides.connectorId, connectors.id),
            eq(
              chatThreadConnectorAccessOverrides.chatThreadId,
              owner.chatThreadId,
            ),
          ),
        )
        .where(connectorAccessAccountOwner(owner))
        .orderBy(asc(connectors.createdAt), asc(connectors.id)),
      db
        .select({ connectionId: chatThreadConnectorSelections.connectorId })
        .from(chatThreadConnectorSelections)
        .where(
          and(
            eq(chatThreadConnectorSelections.chatThreadId, owner.chatThreadId),
            connectorAccessSelectionTarget(owner.target),
          ),
        )
        .limit(1),
    ]);
    const effective = accounts.map((account) => {
      return {
        ...account,
        enabled: account.overrideEnabled ?? account.defaultEnabled,
      };
    });
    const allowed = effective.filter((account) => {
      return account.enabled;
    });
    const current =
      allowed.find((account) => {
        return account.connectionId === selections[0]?.connectionId;
      }) ??
      allowed.find((account) => {
        return account.isDefault;
      }) ??
      allowed[0];
    return {
      target: owner.target,
      accounts: effective,
      currentConnectionId: current?.connectionId ?? null,
      available: allowed.length > 0,
    };
  });
}

const accountDefaultRow = object({
  id: uuid(),
  display_name: string().nullable(),
  default_enabled_for_chats: boolean(),
  is_default: boolean(),
});

export const updateConnectorAccountDefaultEnabled$ = command(
  async (
    { set },
    owner: ConnectorAccessOwner,
    connectionId: string,
    enabled: boolean,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const result = await settle(
      (async () => {
        return parseRawRows(
          accountDefaultRow,
          await db.execute(
            accountDefaultEnabledSql(owner, connectionId, enabled),
          ),
        );
      })(),
    );
    signal.throwIfAborted();
    if (!result.ok) {
      if (isConnectorAccountDefaultConflict(result.error)) {
        return "conflict" as const;
      }
      throw result.error;
    }
    const [row] = result.value;
    if (!row) {
      return null;
    }
    await db.execute(repairChatConnectorSelectionsSql(owner));
    signal.throwIfAborted();
    return {
      connectionId: row.id,
      displayName: row.display_name,
      defaultEnabled: row.default_enabled_for_chats,
      isDefault: row.is_default,
    };
  },
);

export const setChatConnectorAccessOverride$ = command(
  async (
    { set },
    owner: ChatConnectorAccessOwner,
    connectionId: string,
    enabled: boolean | null,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [owned] = await db
      .select({ id: connectors.id })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .innerJoin(connectors, connectorAccessAccountOwner(owner))
      .where(
        and(connectorAccessThreadOwner(owner), eq(connectors.id, connectionId)),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!owned) {
      return false;
    }
    if (enabled === null) {
      await db
        .delete(chatThreadConnectorAccessOverrides)
        .where(
          and(
            eq(
              chatThreadConnectorAccessOverrides.chatThreadId,
              owner.chatThreadId,
            ),
            eq(chatThreadConnectorAccessOverrides.connectorId, connectionId),
          ),
        );
    } else {
      await db
        .insert(chatThreadConnectorAccessOverrides)
        .values({
          chatThreadId: owner.chatThreadId,
          connectorId: connectionId,
          enabled,
        })
        .onConflictDoUpdate({
          target: [
            chatThreadConnectorAccessOverrides.chatThreadId,
            chatThreadConnectorAccessOverrides.connectorId,
          ],
          set: { enabled },
        });
    }
    signal.throwIfAborted();
    await db.execute(
      repairChatConnectorSelectionsSql(owner, owner.chatThreadId),
    );
    signal.throwIfAborted();
    return true;
  },
);

export const setChatConnectorCurrent$ = command(
  async (
    { set },
    owner: ChatConnectorAccessOwner,
    connectionId: string,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const rows = parseRawRows(
      object({ connector_id: uuid() }),
      await db.execute(saveChatConnectorCurrentSql(owner, connectionId)),
    );
    signal.throwIfAborted();
    return rows.length > 0;
  },
);

export const initializeChatConnectorPolicy$ = command(
  async ({ set }, owner: ChatConnectorAccessOwner, signal: AbortSignal) => {
    await set(writeDb$).execute(initializeChatConnectorPolicySql(owner));
    signal.throwIfAborted();
  },
);

export function chatConnectorPermissions(
  scope$: Computed<
    ChatConnectorAccessOwner | null | Promise<ChatConnectorAccessOwner | null>
  >,
) {
  return computed(async (get): Promise<ChatConnectorPermissions | null> => {
    const owner = await get(scope$);
    if (!owner) {
      return null;
    }
    const db = get(db$);
    const [policy] = await db
      .select({
        id: chatThreadConnectorPolicies.id,
        permissionNames: chatThreadConnectorPolicies.permissionNames,
      })
      .from(chatThreadConnectorPolicies)
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, chatThreadConnectorPolicies.chatThreadId),
      )
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          connectorAccessThreadOwner(owner),
          connectorAccessPolicyTarget(owner),
          exists(
            db
              .select({ id: connectors.id })
              .from(connectors)
              .where(connectorAccessAccountOwner(owner)),
          ),
        ),
      )
      .limit(1);
    if (!policy) {
      return null;
    }
    const rows = await db
      .select({
        permission: chatThreadConnectorPermissionGrants.permission,
        action: chatThreadConnectorPermissionGrants.action,
        expiresAt: chatThreadConnectorPermissionGrants.expiresAt,
      })
      .from(chatThreadConnectorPermissionGrants)
      .where(
        and(
          eq(chatThreadConnectorPermissionGrants.policyId, policy.id),
          or(
            isNull(chatThreadConnectorPermissionGrants.expiresAt),
            gt(chatThreadConnectorPermissionGrants.expiresAt, nowDate()),
          ),
        ),
      )
      .orderBy(asc(chatThreadConnectorPermissionGrants.permission));
    return {
      target: owner.target,
      permissionNames: policy.permissionNames,
      grants: rows.map((row) => {
        return {
          ...row,
          expiresAt: row.expiresAt?.toISOString() ?? null,
        };
      }),
    };
  });
}

export const applyChatConnectorPermissions$ = command(
  async (
    { set },
    owner: ChatConnectorAccessOwner,
    apply: ApplyChatConnectorPermissions,
    signal: AbortSignal,
  ) => {
    const db = set(writeDb$);
    const [policy] = await db
      .select({ id: chatThreadConnectorPolicies.id })
      .from(chatThreadConnectorPolicies)
      .innerJoin(
        chatThreads,
        eq(chatThreads.id, chatThreadConnectorPolicies.chatThreadId),
      )
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          connectorAccessThreadOwner(owner),
          connectorAccessPolicyTarget(owner),
          exists(
            db
              .select({ id: connectors.id })
              .from(connectors)
              .where(connectorAccessAccountOwner(owner)),
          ),
        ),
      )
      .limit(1);
    signal.throwIfAborted();
    if (!policy) {
      return "not_found" as const;
    }
    if (
      owner.target.kind === "builtin" &&
      apply.permissionNames !== undefined
    ) {
      return "Selected permission names are only used by custom connectors";
    }
    const [definition] =
      owner.target.kind === "custom"
        ? await db
            .select({
              permissionBundleRef: orgCustomConnectors.permissionBundleRef,
            })
            .from(orgCustomConnectors)
            .where(
              and(
                eq(orgCustomConnectors.orgId, owner.orgId),
                eq(orgCustomConnectors.id, owner.target.customConnectorId),
              ),
            )
            .limit(1)
        : [];
    signal.throwIfAborted();
    const slug =
      owner.target.kind === "builtin"
        ? owner.target.connectorSlug
        : definition?.permissionBundleRef
          ? customConnectorPermissionBundleDependencySlug(
              definition.permissionBundleRef,
            )
          : null;
    const catalogPlan = connectorRuntimeSlugSelectionReadPlan({
      connectorSlugs: slug === null ? [] : [slug],
    });
    const snapshot = connectorRuntimeSlugSelectionFromRows(
      catalogPlan.selection,
      await db
        .select(catalogPlan.columns)
        .from(connectorCatalog)
        .leftJoin(connectorCatalogEntries, catalogPlan.join)
        .where(connectorCatalogCurrentWhere()),
    );
    signal.throwIfAborted();
    const names =
      owner.target.kind === "builtin"
        ? (
            await snapshot.serverFirewalls.loadPermissionIndex(
              owner.target.connectorSlug,
            )
          )?.permissionNames
        : definition?.permissionBundleRef
          ? (
              await loadCustomConnectorPermissionBundle({
                catalog: snapshot.serverFirewalls,
                ref: definition.permissionBundleRef,
              })
            )?.permissionNames
          : undefined;
    signal.throwIfAborted();
    if (
      apply.grants.some((grant) => {
        return (
          grant.permission !== UNKNOWN_PERMISSION_GRANT &&
          !names?.has(grant.permission)
        );
      }) ||
      apply.permissionNames?.some((name) => {
        return !names?.has(name);
      })
    ) {
      return "Unknown connector permission";
    }
    const updated = db
      .update(chatThreadConnectorPolicies)
      .set({
        permissionNames:
          apply.permissionNames === undefined
            ? chatThreadConnectorPolicies.permissionNames
            : [...apply.permissionNames],
      })
      .where(eq(chatThreadConnectorPolicies.id, policy.id))
      .returning({ id: chatThreadConnectorPolicies.id })
      .getSQL();
    await db.execute(
      chatConnectorPermissionMutationSql(policy.id, apply, updated, nowDate()),
    );
    signal.throwIfAborted();
    return "updated" as const;
  },
);
