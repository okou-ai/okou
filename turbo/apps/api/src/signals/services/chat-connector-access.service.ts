import { command, computed, type Computed } from "ccstate";
import type {
  ChatConnectorAccess,
  ConnectorAccountPolicyChoice,
} from "@okouai/api-contracts/contracts/chat-connector-access";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { and, asc, eq, not } from "drizzle-orm";
import { boolean, object, string, uuid } from "zod";

import { parseRawRows } from "../../lib/db-raw-rows";
import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import { isConnectorAccountDefaultConflict } from "./connector-account-lifecycle.service";
import {
  accountDefaultEnabledSql,
  approveMemberConnectorAccountSql,
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
import { synchronizeChatConnectorAutomationAccounts$ } from "./chat-connector-automation-accounts.service";
import {
  connectorAccountAllowedSql,
  memberConnectorAccountAllowed,
  memberConnectorAccountAccessEnabledSql,
} from "./member-connector-account-access";

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
          enabled: connectorAccountAllowedSql(owner),
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
    const allowed = accounts.filter((account) => {
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
      accounts,
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

function policyColumns() {
  return {
    connectionId: connectors.id,
    defaultEnabledForChats: connectors.defaultEnabledForChats,
    chatAccessAllowed: connectors.chatAccessAllowed,
    chatAccessExpiresAt: connectors.chatAccessExpiresAt,
  };
}

function accountPolicy(
  row: {
    readonly connectionId: string;
    readonly defaultEnabledForChats: boolean;
    readonly chatAccessAllowed: boolean | null;
    readonly chatAccessExpiresAt: Date | null;
  },
  at: Date,
) {
  return {
    connectionId: row.connectionId,
    allowed: row.chatAccessAllowed ?? row.defaultEnabledForChats,
    enabled: memberConnectorAccountAllowed(row, at),
    expiresAt: row.chatAccessExpiresAt?.toISOString() ?? null,
  };
}

export function connectorAccountPolicies(
  scope$: Computed<ConnectorAccessOwner>,
) {
  return computed(async (get) => {
    const owner = get(scope$);
    const rows = await get(db$)
      .select(policyColumns())
      .from(connectors)
      .where(
        and(
          connectorAccessAccountOwner(owner),
          memberConnectorAccountAccessEnabledSql(owner),
        ),
      )
      .orderBy(asc(connectors.createdAt), asc(connectors.id));
    const at = nowDate();
    return rows.map((row) => {
      return accountPolicy(row, at);
    });
  });
}

const policyDurationHours = {
  deny: null,
  "allow-always": null,
  "allow-1h": 1,
  "allow-24h": 24,
  "allow-7d": 168,
} satisfies Record<ConnectorAccountPolicyChoice, number | null>;

export const updateConnectorAccountPolicy$ = command(
  async (
    { set },
    owner: ConnectorAccessOwner,
    connectionId: string,
    policy: ConnectorAccountPolicyChoice,
    signal: AbortSignal,
  ) => {
    const at = nowDate();
    const hours = policyDurationHours[policy];
    const [row] = await set(writeDb$)
      .update(connectors)
      .set({
        chatAccessAllowed: policy !== "deny",
        chatAccessExpiresAt:
          hours === null ? null : new Date(at.getTime() + hours * 3_600_000),
        updatedAt: at,
      })
      .where(
        and(
          connectorAccessAccountOwner(owner),
          eq(connectors.id, connectionId),
          memberConnectorAccountAccessEnabledSql(owner),
        ),
      )
      .returning(policyColumns());
    signal.throwIfAborted();
    if (!row) {
      return null;
    }
    await set(synchronizeChatConnectorAutomationAccounts$, owner, signal);
    return accountPolicy(row, at);
  },
);

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
    await set(synchronizeChatConnectorAutomationAccounts$, owner, signal);
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

      .innerJoin(connectors, connectorAccessAccountOwner(owner))
      .where(
        and(
          connectorAccessThreadOwner(owner),
          eq(connectors.id, connectionId),
          not(memberConnectorAccountAccessEnabledSql(owner)),
        ),
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
    await set(synchronizeChatConnectorAutomationAccounts$, owner, signal);
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
    if (rows.length === 0) {
      return false;
    }
    await set(synchronizeChatConnectorAutomationAccounts$, owner, signal);
    return true;
  },
);

export const approveMemberConnectorAccount$ = command(
  async (
    { set },
    owner: ChatConnectorAccessOwner,
    connectionId: string,
    signal: AbortSignal,
  ) => {
    const at = nowDate();
    const expiresAt = new Date(
      at.getTime() + policyDurationHours["allow-1h"] * 3_600_000,
    );
    const selected = parseRawRows(
      object({ connector_id: uuid() }),
      await set(writeDb$).execute(
        approveMemberConnectorAccountSql(owner, connectionId, at, expiresAt),
      ),
    );
    signal.throwIfAborted();
    if (selected.length === 0) {
      return false;
    }
    await set(synchronizeChatConnectorAutomationAccounts$, owner, signal);
    return true;
  },
);
