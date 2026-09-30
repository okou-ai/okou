import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectorSlugSchema } from "@okouai/api-contracts/contracts/connector-identity";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { agents } from "@okouai/db/schema/agent";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import type { Tx } from "../../lib/db-types";
import { isForeignKeyViolation } from "../../lib/pg-errors";
import type { Db, ReadonlyDb } from "../external/db";
import { settle } from "../utils";
import {
  loadAgentConnectorScope,
  type AgentConnectorScope,
} from "./agent-connector-scope.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";
import { listConnectorAccountsByIds } from "./connector-account-lifecycle.service";
import { connectorAccountTargetKey } from "./connector-account-resolution.service";
import {
  getConnectorRuntimeConnector,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import { invalidatePiStableContext } from "./pi-stable-context-generation.service";
import { isWorkflowAutomationAccountConnectorSlug } from "./workflow-automation-account-classification.service";
import { reprojectWorkflowAutomationsForOwner } from "./workflow-automation-account-projection.service";

interface OwnedChatThread {
  readonly agentId: string;
}

interface ConnectorSelectionRow {
  readonly connectorId: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
}

interface ConnectorTargetOwnership extends ConnectorSelectionRow {
  readonly orgId: string;
  readonly userId: string;
}

export type PreparedChatThreadConnectorSelection = ConnectorAccountSelection;

type PrepareChatThreadConnectorSelectionsResult =
  | {
      readonly kind: "ready";
      readonly selections: readonly PreparedChatThreadConnectorSelection[];
    }
  | { readonly kind: "invalid"; readonly message: string };

interface ChatThreadConnectorSelectionList {
  readonly selections: readonly ConnectorAccountSelection[];
  readonly selectedConnections: readonly ConnectorAccountConnection[];
}

type UpdateChatThreadConnectorSelectionResult =
  | { readonly kind: "updated"; readonly selection: ConnectorAccountSelection }
  | { readonly kind: "not_found" }
  | { readonly kind: "invalid"; readonly message: string };

type ClearChatThreadConnectorSelectionResult =
  | { readonly kind: "cleared" }
  | { readonly kind: "not_found" };

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

function targetExistsInCatalog(
  snapshot: ConnectorRuntimeSelection | undefined,
  target: ConnectorAccountTarget,
): boolean {
  return (
    target.kind === "custom" ||
    (snapshot !== undefined &&
      getConnectorRuntimeConnector(snapshot, target.connectorSlug) !==
        undefined)
  );
}

async function loadSnapshotForBuiltinTargets(
  db: ReadonlyDb,
  selections: readonly ConnectorAccountSelection[],
): Promise<ConnectorRuntimeSelection | undefined> {
  return selections.some((selection) => {
    return selection.target.kind === "builtin";
  })
    ? await loadConnectorRuntimeSnapshot(db)
    : undefined;
}

function targetColumns(target: ConnectorAccountTarget): {
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
} {
  return target.kind === "builtin"
    ? { connectorSlug: target.connectorSlug, customConnectorId: null }
    : { connectorSlug: null, customConnectorId: target.customConnectorId };
}

function targetIsAuthorized(
  scope: AgentConnectorScope,
  target: ConnectorAccountTarget,
): boolean {
  return target.kind === "builtin"
    ? scope.allowedConnectorSlugs.includes(target.connectorSlug)
    : scope.allowedCustomConnectorIds.includes(target.customConnectorId);
}

async function loadOwnedChatThread(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
  },
): Promise<OwnedChatThread | undefined> {
  const [thread] = await db
    .select({ agentId: agents.id })
    .from(chatThreads)
    .innerJoin(
      agents,
      and(eq(agents.id, chatThreads.agentId), eq(agents.orgId, args.orgId)),
    )
    .where(
      and(
        eq(chatThreads.id, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
      ),
    )
    .limit(1);
  return thread?.agentId ? { agentId: thread.agentId } : undefined;
}

async function loadLockedOwnedChatThread(
  tx: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
  },
): Promise<OwnedChatThread | undefined> {
  const observed = await loadOwnedChatThread(tx, args);
  if (!observed) {
    return undefined;
  }
  // A selection and its generation must not outlive either parent. Shared
  // parent protection still permits unrelated selections on the same Agent.
  const [agent] = await tx
    .select({ id: agents.id })
    .from(agents)
    .where(and(eq(agents.id, observed.agentId), eq(agents.orgId, args.orgId)))
    .for("key share")
    .limit(1);
  if (!agent) {
    return undefined;
  }
  const [thread] = await tx
    .select({ agentId: chatThreads.agentId })
    .from(chatThreads)
    .where(
      and(
        eq(chatThreads.id, args.chatThreadId),
        eq(chatThreads.userId, args.userId),
        eq(chatThreads.agentId, agent.id),
      ),
    )
    .for("key share")
    .limit(1);
  return thread?.agentId ? { agentId: thread.agentId } : undefined;
}

async function loadSelectionRows(
  db: ReadonlyDb,
  chatThreadId: string,
): Promise<readonly ConnectorSelectionRow[]> {
  return await db
    .select({
      connectorId: chatThreadConnectorSelections.connectorId,
      connectorSlug: chatThreadConnectorSelections.connectorSlug,
      customConnectorId: chatThreadConnectorSelections.customConnectorId,
    })
    .from(chatThreadConnectorSelections)
    .where(eq(chatThreadConnectorSelections.chatThreadId, chatThreadId))
    .orderBy(
      asc(chatThreadConnectorSelections.connectorSlug),
      asc(chatThreadConnectorSelections.customConnectorId),
    );
}

async function loadConnectorTargetOwnerships(
  db: ReadonlyDb,
  args: {
    readonly connectorIds: readonly string[];
  },
): Promise<ReadonlyMap<string, ConnectorTargetOwnership>> {
  if (args.connectorIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({
      connectorId: connectors.id,
      connectorSlug: connectors.connectorSlug,
      customConnectorId: connectors.customConnectorId,
      orgId: connectors.orgId,
      userId: connectors.userId,
    })
    .from(connectors)
    .where(inArray(connectors.id, [...new Set(args.connectorIds)]));
  return new Map(
    rows.map((row) => {
      return [row.connectorId, row];
    }),
  );
}

export async function listChatThreadConnectorSelections(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
  },
): Promise<ChatThreadConnectorSelectionList | null> {
  const thread = await loadOwnedChatThread(db, args);
  if (!thread) {
    return null;
  }
  const rows = await loadSelectionRows(db, args.chatThreadId);
  const storedSelections = rows.map(selectionFromRow);
  const projectedConnections = await listConnectorAccountsByIds(db, {
    orgId: args.orgId,
    userId: args.userId,
    connectionIds: storedSelections.map((selection) => {
      return selection.connectionId;
    }),
  });
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
}

export async function prepareChatThreadConnectorSelections(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly agentId: string;
    readonly selections: readonly ConnectorAccountSelection[];
    readonly missingAccountPolicy?: "reject" | "omit";
  },
): Promise<PrepareChatThreadConnectorSelectionsResult> {
  const byTarget = new Map<string, ConnectorAccountSelection>();
  for (const selection of args.selections) {
    const key = connectorAccountTargetKey(selection.target);
    if (byTarget.has(key)) {
      return {
        kind: "invalid",
        message: "Only one connector account may be selected per target",
      };
    }
    byTarget.set(key, selection);
  }
  if (byTarget.size === 0) {
    return { kind: "ready", selections: [] };
  }

  const selections = [...byTarget.values()];
  for (const selection of [...selections].sort((left, right) => {
    return connectorAccountTargetKey(left.target).localeCompare(
      connectorAccountTargetKey(right.target),
    );
  })) {
    await lockConnectorAccountTarget(db, {
      orgId: args.orgId,
      userId: args.userId,
      target: selection.target,
    });
  }
  const scope = await loadAgentConnectorScope(db, args);
  const snapshot = await loadSnapshotForBuiltinTargets(db, selections);
  for (const selection of byTarget.values()) {
    if (!targetExistsInCatalog(snapshot, selection.target)) {
      return {
        kind: "invalid",
        message: "Connector target is unavailable",
      };
    }
    if (!targetIsAuthorized(scope, selection.target)) {
      return {
        kind: "invalid",
        message: "Connector target is not authorized for this chat thread",
      };
    }
  }

  const connectionIds = selections.map((selection) => {
    return selection.connectionId;
  });
  const targetOwnerships = await loadConnectorTargetOwnerships(db, {
    connectorIds: connectionIds,
  });
  const projectedConnections = await listConnectorAccountsByIds(db, {
    orgId: args.orgId,
    userId: args.userId,
    connectionIds,
  });
  const projectedById = new Map(
    projectedConnections.map((connection) => {
      return [connection.id, connection];
    }),
  );
  for (const [key, selection] of byTarget) {
    const ownership = targetOwnerships.get(selection.connectionId);
    if (!ownership) {
      if (args.missingAccountPolicy === "omit") {
        byTarget.delete(key);
        continue;
      }
      return {
        kind: "invalid",
        message: "Connector account does not match the requested target",
      };
    }
    if (ownership.orgId !== args.orgId || ownership.userId !== args.userId) {
      return {
        kind: "invalid",
        message: "Connector account does not match the requested target",
      };
    }
    const ownedTarget = targetFromRow(ownership);
    if (
      connectorAccountTargetKey(ownedTarget) !==
      connectorAccountTargetKey(selection.target)
    ) {
      return {
        kind: "invalid",
        message: "Connector account does not match the requested target",
      };
    }
    const projected = projectedById.get(selection.connectionId);
    if (!projected) {
      return {
        kind: "invalid",
        message: "Connector account is unavailable for thread selection",
      };
    }
  }
  return { kind: "ready", selections: [...byTarget.values()] };
}

async function upsertSelection(
  tx: Tx,
  chatThreadId: string,
  selection: ConnectorAccountSelection,
): Promise<ConnectorAccountSelection> {
  const values = {
    chatThreadId,
    connectorId: selection.connectionId,
    ...targetColumns(selection.target),
  };
  const [row] =
    selection.target.kind === "builtin"
      ? await tx
          .insert(chatThreadConnectorSelections)
          .values(values)
          .onConflictDoUpdate({
            target: [
              chatThreadConnectorSelections.chatThreadId,
              chatThreadConnectorSelections.connectorSlug,
            ],
            targetWhere: isNotNull(chatThreadConnectorSelections.connectorSlug),
            set: { connectorId: selection.connectionId },
          })
          .returning({
            connectorId: chatThreadConnectorSelections.connectorId,
          })
      : await tx
          .insert(chatThreadConnectorSelections)
          .values(values)
          .onConflictDoUpdate({
            target: [
              chatThreadConnectorSelections.chatThreadId,
              chatThreadConnectorSelections.customConnectorId,
            ],
            targetWhere: isNotNull(
              chatThreadConnectorSelections.customConnectorId,
            ),
            set: { connectorId: selection.connectionId },
          })
          .returning({
            connectorId: chatThreadConnectorSelections.connectorId,
          });
  if (!row) {
    throw new Error("Failed to persist chat thread connector selection");
  }
  return selection;
}

function isCustomSelectionAccountMissing(error: unknown): boolean {
  return (
    isForeignKeyViolation(error) &&
    error instanceof Error &&
    typeof error.cause === "object" &&
    error.cause !== null &&
    "constraint" in error.cause &&
    error.cause.constraint ===
      "fk_chat_thread_connector_selections_custom_connector"
  );
}

export async function updateChatThreadConnectorSelection(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly selection: ConnectorAccountSelection;
  },
  signal: AbortSignal,
): Promise<UpdateChatThreadConnectorSelectionResult> {
  const result = await settle(
    db.transaction(
      async (tx): Promise<UpdateChatThreadConnectorSelectionResult> => {
        const thread = await loadLockedOwnedChatThread(tx, args);
        if (!thread) {
          return { kind: "not_found" };
        }
        const prepared = await prepareChatThreadConnectorSelections(tx, {
          orgId: args.orgId,
          userId: args.userId,
          agentId: thread.agentId,
          selections: [args.selection],
        });
        if (prepared.kind === "invalid") {
          return prepared;
        }
        const [selection] = prepared.selections;
        if (!selection) {
          throw new Error("Expected one prepared connector selection");
        }
        const updated = await upsertSelection(tx, args.chatThreadId, selection);
        await reprojectWorkflowAutomationsForOwner(
          tx,
          { ...args, target: selection.target },
          signal,
        );
        await invalidatePiStableContext(tx, {
          orgId: args.orgId,
          userId: args.userId,
          agentId: thread.agentId,
        });
        return {
          kind: "updated",
          selection: updated,
        };
      },
    ),
  );
  if (result.ok) {
    return result.value;
  }
  // Wait for the whole transaction to roll back before reporting a lost
  // account, including its selection change and generation invalidation.
  if (
    args.selection.target.kind === "custom" &&
    isCustomSelectionAccountMissing(result.error)
  ) {
    return {
      kind: "invalid",
      message: "Connector account does not match the requested target",
    };
  }
  throw result.error;
}

export async function clearChatThreadConnectorSelection(
  db: Db,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly target: ConnectorAccountTarget;
  },
  signal: AbortSignal,
): Promise<ClearChatThreadConnectorSelectionResult> {
  return await db.transaction(async (tx) => {
    const thread = await loadLockedOwnedChatThread(tx, args);
    if (!thread) {
      return { kind: "not_found" };
    }
    // Only event sources also change the owner's automation projections.
    if (
      args.target.kind === "builtin" &&
      isWorkflowAutomationAccountConnectorSlug(args.target.connectorSlug)
    ) {
      await lockConnectorAccountTarget(tx, args);
    }
    await tx
      .delete(chatThreadConnectorSelections)
      .where(
        and(
          eq(chatThreadConnectorSelections.chatThreadId, args.chatThreadId),
          args.target.kind === "builtin"
            ? eq(
                chatThreadConnectorSelections.connectorSlug,
                args.target.connectorSlug,
              )
            : eq(
                chatThreadConnectorSelections.customConnectorId,
                args.target.customConnectorId,
              ),
        ),
      );
    await reprojectWorkflowAutomationsForOwner(tx, args, signal);
    await invalidatePiStableContext(tx, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: thread.agentId,
    });
    return { kind: "cleared" };
  });
}

export async function insertInitialChatThreadConnectorSelections(
  tx: Tx,
  args: {
    readonly chatThreadId: string;
    readonly selections: readonly PreparedChatThreadConnectorSelection[];
  },
): Promise<void> {
  if (args.selections.length === 0) {
    return;
  }
  const builtinSelections = args.selections.filter((selection) => {
    return selection.target.kind === "builtin";
  });
  if (builtinSelections.length > 0) {
    await tx.insert(chatThreadConnectorSelections).values(
      builtinSelections.map((selection) => {
        return {
          chatThreadId: args.chatThreadId,
          connectorId: selection.connectionId,
          ...targetColumns(selection.target),
        };
      }),
    );
  }
  for (const selection of args.selections) {
    if (selection.target.kind !== "custom") {
      continue;
    }
    // Initial thread creation omits vanished accounts. A savepoint contains
    // only this child insert, preserving the thread and its other selections.
    const inserted = await settle(
      tx.transaction(async (selectionTx) => {
        await selectionTx.insert(chatThreadConnectorSelections).values({
          chatThreadId: args.chatThreadId,
          connectorId: selection.connectionId,
          ...targetColumns(selection.target),
        });
      }),
    );
    if (!inserted.ok && !isCustomSelectionAccountMissing(inserted.error)) {
      throw inserted.error;
    }
  }
}
