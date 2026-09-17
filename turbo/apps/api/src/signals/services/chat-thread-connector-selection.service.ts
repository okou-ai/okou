import type {
  ConnectorAccountConnection,
  ConnectorAccountSelection,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import {
  connectorSlugSchema,
  type ConnectorSlug,
} from "@okouai/api-contracts/contracts/connector-identity";
import { agents } from "@okouai/db/schema/agent";
import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { connectors } from "@okouai/db/schema/connector";
import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import type { Db, ReadonlyDb } from "../external/db";
import { connectorAccountTargetKey } from "./connector-account-resolution.service";
import {
  loadAgentConnectorScope,
  type AgentConnectorScope,
} from "./agent-connector-scope.service";
import {
  getConnectorRuntimeConnector,
  loadConnectorRuntimeSnapshot,
  type ConnectorRuntimeSelection,
} from "./connector-catalog-runtime.service";
import { lockConnectorAccountTarget } from "./auth-state-lock.service";
import { listConnectorAccountsByIds } from "./connector-account-lifecycle.service";
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

type ResolveChatThreadConnectorSelectionsResult =
  | {
      readonly kind: "resolved";
      readonly connectorIdCandidatesBySlug: ReadonlyMap<
        ConnectorSlug,
        readonly string[]
      >;
      readonly connectorIdCandidatesByCustomConnectorId: ReadonlyMap<
        string,
        readonly string[]
      >;
    }
  | { readonly kind: "invalid"; readonly message: string };

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

async function loadConnectorTarget(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly connectorId: string;
  },
): Promise<ConnectorAccountTarget | undefined> {
  const [row] = await db
    .select({
      connectorId: connectors.id,
      connectorSlug: connectors.connectorSlug,
      customConnectorId: connectors.customConnectorId,
    })
    .from(connectors)
    .where(
      and(
        eq(connectors.id, args.connectorId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
      ),
    )
    .limit(1);
  return row ? targetFromRow(row) : undefined;
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

async function projectStoredSelections(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly selections: readonly ConnectorAccountSelection[];
  },
): Promise<readonly ConnectorAccountSelection[]> {
  const connections = await listConnectorAccountsByIds(db, {
    orgId: args.orgId,
    userId: args.userId,
    connectionIds: args.selections.map((selection) => {
      return selection.connectionId;
    }),
  });
  const connectionTargetById = new Map(
    connections.map((connection) => {
      return [connection.id, connectorAccountTargetKey(connection.target)];
    }),
  );
  return args.selections.filter((selection) => {
    return (
      connectionTargetById.get(selection.connectionId) ===
      connectorAccountTargetKey(selection.target)
    );
  });
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
  return await db.transaction(async (tx) => {
    const thread = await loadOwnedChatThread(tx, args);
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
    return {
      kind: "updated",
      selection: updated,
    };
  });
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
    const thread = await loadOwnedChatThread(tx, args);
    if (!thread) {
      return { kind: "not_found" };
    }
    await lockConnectorAccountTarget(tx, args);
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
  await tx.insert(chatThreadConnectorSelections).values(
    args.selections.map((selection) => {
      return {
        chatThreadId: args.chatThreadId,
        connectorId: selection.connectionId,
        ...targetColumns(selection.target),
      };
    }),
  );
}

export async function resolveChatThreadConnectorSelections(
  db: ReadonlyDb,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly chatThreadId: string;
    readonly scope: AgentConnectorScope;
    readonly connectorSourceId?: string;
  },
): Promise<ResolveChatThreadConnectorSelectionsResult> {
  const thread = await loadOwnedChatThread(db, args);
  if (!thread) {
    return {
      kind: "invalid",
      message: "Chat thread is no longer available",
    };
  }
  const rows = await loadSelectionRows(db, args.chatThreadId);
  const storedSelections = await projectStoredSelections(db, {
    orgId: args.orgId,
    userId: args.userId,
    selections: rows.map(selectionFromRow).filter((selection) => {
      return targetIsAuthorized(args.scope, selection.target);
    }),
  });
  const selectionCandidates = new Map<
    string,
    readonly ConnectorAccountSelection[]
  >();
  for (const selection of storedSelections) {
    selectionCandidates.set(connectorAccountTargetKey(selection.target), [
      selection,
    ]);
  }
  if (args.connectorSourceId !== undefined) {
    const target = await loadConnectorTarget(db, {
      orgId: args.orgId,
      userId: args.userId,
      connectorId: args.connectorSourceId,
    });
    if (target && targetIsAuthorized(args.scope, target)) {
      const key = connectorAccountTargetKey(target);
      const sourceSelection = {
        connectionId: args.connectorSourceId,
        target,
      } satisfies ConnectorAccountSelection;
      const threadSelection = selectionCandidates.get(key)?.[0];
      selectionCandidates.set(
        key,
        threadSelection &&
          threadSelection.connectionId !== sourceSelection.connectionId
          ? [sourceSelection, threadSelection]
          : [sourceSelection],
      );
    }
  }

  const connectorIdCandidatesBySlug = new Map<
    ConnectorSlug,
    readonly string[]
  >();
  const connectorIdCandidatesByCustomConnectorId = new Map<
    string,
    readonly string[]
  >();
  for (const candidates of selectionCandidates.values()) {
    const first = candidates[0];
    if (!first) {
      continue;
    }
    const connectorIds = candidates.map((candidate) => {
      return candidate.connectionId;
    });
    if (first.target.kind === "builtin") {
      connectorIdCandidatesBySlug.set(first.target.connectorSlug, connectorIds);
    } else {
      connectorIdCandidatesByCustomConnectorId.set(
        first.target.customConnectorId,
        connectorIds,
      );
    }
  }
  return {
    kind: "resolved",
    connectorIdCandidatesBySlug,
    connectorIdCandidatesByCustomConnectorId,
  };
}
