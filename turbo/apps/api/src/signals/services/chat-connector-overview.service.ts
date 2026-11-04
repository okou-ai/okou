import { computed, type Computed } from "ccstate";
import type { ChatConnectorOverviewEntry } from "@okouai/api-contracts/contracts/chat-connector-access";
import {
  connectorAccountTargetKey,
  connectorAccountTargetSchema,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorAuthMethodIdSchema } from "@okouai/api-contracts/contracts/connector-identity";
import type { FeatureSwitchContext } from "@okouai/core/feature-switch";
import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { and, asc, eq, sql } from "drizzle-orm";

import { db$ } from "../external/db";
import { connectedConnectorBriefs } from "./connected-connectors.service";
import { connectorAccessAccountOwner } from "./connector-access-owner";

interface OverviewOwner {
  readonly orgId: string;
  readonly userId: string;
  readonly threadId?: string;
  readonly target?: ConnectorAccountTarget;
}

function overviewAccountRows(owner$: Computed<OverviewOwner>) {
  return computed(async (get) => {
    const owner = get(owner$);
    return await get(db$)
      .select({
        connectionId: connectors.id,
        connectorSlug: connectors.connectorSlug,
        customConnectorId: connectors.customConnectorId,
        displayName: connectors.displayName,
        authMethod: connectors.authMethod,
        externalId: connectors.externalId,
        externalUsername: connectors.externalUsername,
        externalEmail: connectors.externalEmail,
        isDefault: connectors.isDefault,
        defaultEnabled: connectors.defaultEnabledForChats,
        overrideEnabled: chatThreadConnectorAccessOverrides.enabled,
        selectedId: chatThreadConnectorSelections.connectorId,
      })
      .from(connectors)
      .leftJoin(
        chatThreadConnectorAccessOverrides,
        owner.threadId
          ? and(
              eq(chatThreadConnectorAccessOverrides.connectorId, connectors.id),
              eq(
                chatThreadConnectorAccessOverrides.chatThreadId,
                owner.threadId,
              ),
            )
          : sql`false`,
      )
      .leftJoin(
        chatThreadConnectorSelections,
        owner.threadId
          ? and(
              eq(chatThreadConnectorSelections.connectorId, connectors.id),
              eq(chatThreadConnectorSelections.chatThreadId, owner.threadId),
            )
          : sql`false`,
      )
      .where(
        owner.target
          ? connectorAccessAccountOwner({ ...owner, target: owner.target })
          : and(
              eq(connectors.orgId, owner.orgId),
              eq(connectors.userId, owner.userId),
            ),
      )
      .orderBy(asc(connectors.createdAt), asc(connectors.id));
  });
}

/** Account identities and preferences only, without credential/setup projections. */
export function chatConnectorOverview(
  owner$: Computed<OverviewOwner>,
  context$: Computed<Promise<FeatureSwitchContext>>,
) {
  const connected$ = connectedConnectorBriefs(owner$, context$);
  const rows$ = overviewAccountRows(owner$);
  const owned$ = computed(async (get) => {
    const owner = get(owner$);
    if (!owner.threadId) {
      return true;
    }
    const [thread] = await get(db$)
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(
        and(
          eq(chatThreads.id, owner.threadId),
          eq(chatThreads.userId, owner.userId),
          eq(agents.orgId, owner.orgId),
        ),
      )
      .limit(1);
    return thread !== undefined;
  });
  return computed(
    async (get): Promise<readonly ChatConnectorOverviewEntry[] | null> => {
      if (!(await get(owned$))) {
        return null;
      }
      const [connected, rows] = await Promise.all([
        get(connected$),
        get(rows$),
      ]);
      const groups = new Map<
        string,
        {
          accounts: ChatConnectorOverviewEntry["accounts"];
          selectedId: string | null;
        }
      >();
      for (const {
        connectorSlug,
        customConnectorId,
        selectedId,
        ...row
      } of rows) {
        const target = connectorAccountTargetSchema.parse(
          connectorSlug !== null
            ? { kind: "builtin", connectorSlug }
            : { kind: "custom", customConnectorId },
        );
        const key = connectorAccountTargetKey(target);
        const group = groups.get(key) ?? { accounts: [], selectedId: null };
        group.accounts.push({
          ...row,
          authMethod: connectorAuthMethodIdSchema.parse(row.authMethod),
          enabled: row.overrideEnabled ?? row.defaultEnabled,
        });
        if (selectedId !== null) {
          group.selectedId = selectedId;
        }
        groups.set(key, group);
      }
      const targets = [
        ...connected.builtinConnectors.map((connector) => {
          return {
            target: { kind: "builtin" as const, connectorSlug: connector.slug },
            label: connector.label,
            icon: connector.icon,
            hasPermissions: connector.hasPermissions,
          };
        }),
        ...connected.customConnectors.map((connector) => {
          return {
            target: {
              kind: "custom" as const,
              customConnectorId: connector.id,
            },
            label: connector.displayName,
            icon: null,
            hasPermissions: false,
          };
        }),
      ];
      return targets.map((entry) => {
        const group = groups.get(connectorAccountTargetKey(entry.target));
        const accounts = group?.accounts ?? [];
        const allowed = accounts.filter((account) => {
          return account.enabled;
        });
        const current =
          allowed.find((account) => {
            return account.connectionId === group?.selectedId;
          }) ??
          allowed.find((account) => {
            return account.isDefault;
          }) ??
          allowed[0];
        return {
          ...entry,
          accounts,
          currentConnectionId: current?.connectionId ?? null,
        };
      });
    },
  );
}
