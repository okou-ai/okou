import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { and, asc, eq } from "drizzle-orm";

import { computed, type Computed } from "ccstate";
import { db$ } from "../external/db";
import { connectorAccountsByIds } from "./connector-account-lifecycle.service";
import { connectorAccountTargetKey } from "./connector-account-resolution.service";

interface ConnectorSelectionRow {
  readonly connectorId: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
}

interface ChatThreadConnectorSelectionList {
  readonly selections: readonly ConnectorAccountSelection[];
  readonly selectedConnections: readonly ConnectorAccountConnection[];
}

function targetFromRow(row: ConnectorSelectionRow): ConnectorAccountTarget {
  if (row.connectorSlug !== null && row.customConnectorId === null) {
    return {
      kind: "builtin",
      connectorSlug: connectorSlugSchema.parse(row.connectorSlug),
    };
  }
  if (row.customConnectorId !== null && row.connectorSlug === null) {
    return { kind: "custom", customConnectorId: row.customConnectorId };
  }
  throw new Error("Expected exactly one thread connector selection target");
}

function selectionFromRow(
  row: ConnectorSelectionRow,
): ConnectorAccountSelection {
  return {
    connectionId: row.connectorId,
    target: targetFromRow(row),
  };
}

interface ChatThreadConnectorSelectionScope {
  readonly orgId: string;
  readonly userId: string;
  readonly chatThreadId: string;
}

export function connectorSelectionsForChatThread(
  scope$: Computed<ChatThreadConnectorSelectionScope>,
): Computed<Promise<ChatThreadConnectorSelectionList | null>> {
  const ownedThread$ = computed(async (get) => {
    const args = get(scope$);
    const db = get(db$);
    const [thread] = await db
      .select({ id: chatThreads.id })
      .from(chatThreads)

      .where(
        and(
          eq(chatThreads.id, args.chatThreadId),
          eq(chatThreads.userId, args.userId),
          eq(chatThreads.orgId, args.orgId),
        ),
      )
      .limit(1);
    return thread;
  });
  const selections$ = computed(async (get) => {
    const args = get(scope$);
    if (!(await get(ownedThread$))) {
      return null;
    }
    const db = get(db$);
    const rows = await db
      .select({
        connectorId: chatThreadConnectorSelections.connectorId,
        connectorSlug: chatThreadConnectorSelections.connectorSlug,
        customConnectorId: chatThreadConnectorSelections.customConnectorId,
      })
      .from(chatThreadConnectorSelections)
      .where(eq(chatThreadConnectorSelections.chatThreadId, args.chatThreadId))
      .orderBy(
        asc(chatThreadConnectorSelections.connectorSlug),
        asc(chatThreadConnectorSelections.customConnectorId),
      );
    return rows.map(selectionFromRow);
  });
  const batchScope$ = computed(async (get) => {
    const args = get(scope$);
    const selections = await get(selections$);
    return selections === null
      ? null
      : {
          orgId: args.orgId,
          userId: args.userId,
          connectionIds: selections.map((selection) => {
            return selection.connectionId;
          }),
        };
  });
  const connections$ = connectorAccountsByIds(batchScope$);
  return computed(async (get) => {
    const storedSelections = await get(selections$);
    if (storedSelections === null) {
      return null;
    }
    const projectedConnections = await get(connections$);
    const connectionById = new Map(
      projectedConnections.map((connection) => {
        return [connection.id, connection];
      }),
    );
    const selections: ConnectorAccountSelection[] = [];
    const selectedConnections: ConnectorAccountConnection[] = [];
    for (const selection of storedSelections) {
      const connection = connectionById.get(selection.connectionId);
      if (
        connection &&
        connectorAccountTargetKey(connection.target) ===
          connectorAccountTargetKey(selection.target)
      ) {
        selections.push(selection);
        selectedConnections.push(connection);
      }
    }
    return { selections, selectedConnections };
  });
}
