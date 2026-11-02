import {
  connectorAccountTargetKey,
  type ConnectorAccountSelection,
  type ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { agents } from "@okouai/db/schema/agent";
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { chatThreadConnectorAccessOverrides } from "@okouai/db/schema/chat-thread-connector-access";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { and, asc, eq, or, sql } from "drizzle-orm";
import { QueryBuilder } from "drizzle-orm/pg-core";

export type ChatConnectorExecutionOwner = {
  readonly orgId: string;
  readonly userId: string;
} & (
  | { readonly kind: "run"; readonly runId: string }
  | { readonly kind: "chat"; readonly chatThreadId: string }
);

/** One owned Chat/account snapshot, without credential material or Agent grants. */
export function chatConnectorExecutionReadPlan(
  owner: ChatConnectorExecutionOwner,
) {
  return new QueryBuilder()
    .select({
      chatThreadId: sql`${chatThreads.id}`
        .mapWith(chatThreads.id)
        .as("chat_thread_id"),
      connectionId: sql`${connectors.id}`
        .mapWith(connectors.id)
        .as("connection_id"),
      connectorSlug: connectors.connectorSlug,
      customConnectorId: connectors.customConnectorId,
      displayName: connectors.displayName,
      isDefault: connectors.isDefault,
      defaultEnabled: connectors.defaultEnabledForChats,
      overrideEnabled: chatThreadConnectorAccessOverrides.enabled,
      selectedConnectionId: chatThreadConnectorSelections.connectorId,
    })
    .from(chatThreads)
    .innerJoin(
      agents,
      and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, owner.orgId)),
    )
    .leftJoin(
      agentRuns,
      owner.kind === "run"
        ? and(
            eq(agentRuns.id, owner.runId),
            eq(agentRuns.chatThreadId, chatThreads.id),
            eq(agentRuns.orgId, owner.orgId),
            eq(agentRuns.userId, owner.userId),
            eq(agentRuns.agentId, chatThreads.agentId),
            eq(agentRuns.status, "running"),
          )
        : sql`false`,
    )
    .innerJoin(
      connectors,
      and(
        eq(connectors.orgId, owner.orgId),
        eq(connectors.userId, owner.userId),
      ),
    )
    .leftJoin(
      chatThreadConnectorAccessOverrides,
      and(
        eq(chatThreadConnectorAccessOverrides.chatThreadId, chatThreads.id),
        eq(chatThreadConnectorAccessOverrides.connectorId, connectors.id),
      ),
    )
    .leftJoin(
      chatThreadConnectorSelections,
      and(
        eq(chatThreadConnectorSelections.chatThreadId, chatThreads.id),
        or(
          eq(
            chatThreadConnectorSelections.connectorSlug,
            connectors.connectorSlug,
          ),
          eq(
            chatThreadConnectorSelections.customConnectorId,
            connectors.customConnectorId,
          ),
        ),
      ),
    )
    .where(
      and(
        eq(chatThreads.userId, owner.userId),
        owner.kind === "run"
          ? eq(agentRuns.id, owner.runId)
          : eq(chatThreads.id, owner.chatThreadId),
      ),
    )
    .orderBy(asc(connectors.createdAt), asc(connectors.id));
}

export function chatConnectorExecutionFromRows(
  rows: readonly {
    readonly chatThreadId: string;
    readonly connectionId: string;
    readonly connectorSlug: string | null;
    readonly customConnectorId: string | null;
    readonly displayName: string | null;
    readonly isDefault: boolean;
    readonly defaultEnabled: boolean;
    readonly overrideEnabled: boolean | null;
    readonly selectedConnectionId: string | null;
  }[],
) {
  const accounts = rows.map((row) => {
    const target: ConnectorAccountTarget =
      row.connectorSlug !== null
        ? {
            kind: "builtin",
            connectorSlug: connectorSlugSchema.parse(row.connectorSlug),
          }
        : row.customConnectorId !== null
          ? { kind: "custom", customConnectorId: row.customConnectorId }
          : (() => {
              throw new Error("Connector account has no target");
            })();
    return {
      ...row,
      target,
      enabled: row.overrideEnabled ?? row.defaultEnabled,
    };
  });
  const current = new Map<string, (typeof accounts)[number]>();
  for (const account of accounts) {
    if (!account.enabled) {
      continue;
    }
    const key = connectorAccountTargetKey(account.target);
    const selected = current.get(key);
    if (
      !selected ||
      account.connectionId === account.selectedConnectionId ||
      (selected.connectionId !== selected.selectedConnectionId &&
        account.isDefault)
    ) {
      current.set(key, account);
    }
  }
  const selections: ConnectorAccountSelection[] = [...current.values()].map(
    ({ target, connectionId }) => {
      return { target, connectionId };
    },
  );
  return { accounts, selections };
}
