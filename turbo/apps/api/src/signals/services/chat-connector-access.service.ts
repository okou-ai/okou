import { command, computed, type Computed } from "ccstate";
import type { ChatConnectorAccess } from "@okouai/api-contracts/contracts/chat-connector-access";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { and, asc, eq } from "drizzle-orm";
import { boolean, object, string, uuid } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { isConnectorAccountDefaultConflict } from "./connector-account-lifecycle.service";
import {
  accountDefaultEnabledSql,
  connectorAccessSelectionTarget,
  connectorAccessThreadOwner,
  repairChatConnectorSelectionsSql,
  saveChatConnectorCurrentSql,
  type ChatConnectorAccessOwner,
} from "./chat-connector-access-sql";
import {
  connectorAccessAccountOwner,
  type ConnectorAccessOwner,
} from "./connector-access-owner";

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
