import { QueryBuilder } from "drizzle-orm/pg-core";
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
import {
  connectorCatalog,
  connectorCatalogEntries,
} from "@okouai/db/runtime/connector-catalog";
import { and, asc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { isForeignKeyViolation } from "../../lib/pg-errors";
import { command, computed, type Computed } from "ccstate";
import { db$, writeDb$ } from "../external/db";
import { settle } from "../utils";
import {
  readAgentConnectorScope$,
  type AgentConnectorScope,
} from "./agent-connector-scope.service";
import {
  connectorAccountsByIds,
  readConnectorAccountsByIds$,
} from "./connector-account-lifecycle.service";
import { connectorAccountTargetKey } from "./connector-account-resolution.service";
import { ExternalConnectorCatalogUnavailableError } from "./connector-catalog-external-reader.service";
import {
  connectorCatalogCurrentWhere,
  connectorCatalogSlugJoin,
} from "./connector-catalog-slug-source.service";
import { reprojectWorkflowAutomationsForOwner } from "./workflow-automation-account-projection.service";

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

interface PrepareChatThreadConnectorSelectionsArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly selections: readonly ConnectorAccountSelection[];
  readonly missingAccountPolicy?: "reject" | "omit";
}

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
  { readonly kind: "cleared" } | { readonly kind: "not_found" };

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
  catalogSlugs: ReadonlySet<string> | undefined,
  target: ConnectorAccountTarget,
): boolean {
  return (
    target.kind === "custom" || catalogSlugs?.has(target.connectorSlug) === true
  );
}

function catalogSlugsForBuiltinTargetsFromRows(
  rows: readonly { readonly slug: string | null }[] | undefined,
): ReadonlySet<string> | undefined {
  if (rows === undefined) {
    return undefined;
  }
  if (rows.length === 0) {
    throw new ExternalConnectorCatalogUnavailableError(
      "missing_current_identity",
    );
  }
  return new Set(
    rows.flatMap((row) => {
      return row.slug === null ? [] : [row.slug];
    }),
  );
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

const connectorTargetOwnershipColumns = Object.freeze({
  connectorId: connectors.id,
  connectorSlug: connectors.connectorSlug,
  customConnectorId: connectors.customConnectorId,
  orgId: connectors.orgId,
  userId: connectors.userId,
});

function connectorTargetOwnershipsFromRows(
  rows: readonly ConnectorTargetOwnership[],
): ReadonlyMap<string, ConnectorTargetOwnership> {
  return new Map(
    rows.map((row) => {
      return [row.connectorId, row];
    }),
  );
}

function connectorTargetOwnershipMatches(
  ownership: ConnectorTargetOwnership,
  args: {
    readonly orgId: string;
    readonly userId: string;
  },
  target: ConnectorAccountTarget,
): boolean {
  if (ownership.orgId !== args.orgId || ownership.userId !== args.userId) {
    return false;
  }
  return (
    connectorAccountTargetKey(targetFromRow(ownership)) ===
    connectorAccountTargetKey(target)
  );
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

export const prepareChatThreadConnectorSelections$ = command(
  async (
    { get, set },
    args: PrepareChatThreadConnectorSelectionsArgs,
    signal: AbortSignal,
  ): Promise<PrepareChatThreadConnectorSelectionsResult> => {
    signal.throwIfAborted();
    const db = get(db$);
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
    // No account row is locked here. The selection insert's FK checks on the
    // thread and account arbitrate a concurrent deletion: the loser of that race
    // receives a deterministic invalid/omitted result (see
    // selectionParentMissing), never a stale selection.
    const scope = await set(readAgentConnectorScope$, {
      orgId: args.orgId,
      userId: args.userId,
      agentId: args.agentId,
    });
    signal.throwIfAborted();
    const slugs = selections.flatMap((selection) => {
      return selection.target.kind === "builtin"
        ? [selection.target.connectorSlug]
        : [];
    });
    const catalogSlugs = catalogSlugsForBuiltinTargetsFromRows(
      await (slugs.length > 0
        ? db
            .select({
              current: { schemaVersion: connectorCatalog.schemaVersion },
              slug: connectorCatalogEntries.slug,
            })
            .from(connectorCatalog)
            .leftJoin(connectorCatalogEntries, connectorCatalogSlugJoin(slugs))
            .where(connectorCatalogCurrentWhere())
        : undefined),
    );
    signal.throwIfAborted();
    for (const selection of byTarget.values()) {
      if (!targetExistsInCatalog(catalogSlugs, selection.target)) {
        return {
          kind: "invalid",
          message: "Connector target is unavailable",
        };
      }
      if (!targetIsAuthorized(scope, selection.target)) {
        return {
          kind: "invalid",
          message: "Connector target is not authorized for this agent",
        };
      }
    }

    const connectionIds = selections.map((selection) => {
      return selection.connectionId;
    });
    const targetOwnerships = connectorTargetOwnershipsFromRows(
      await db
        .select(connectorTargetOwnershipColumns)
        .from(connectors)
        .where(inArray(connectors.id, [...new Set(connectionIds)])),
    );
    signal.throwIfAborted();
    const projectedConnections = await set(
      readConnectorAccountsByIds$,
      {
        orgId: args.orgId,
        userId: args.userId,
        connectionIds,
      },
      signal,
    );
    signal.throwIfAborted();
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
      if (!connectorTargetOwnershipMatches(ownership, args, selection.target)) {
        return {
          kind: "invalid",
          message: "Connector account does not match the requested target",
        };
      }
      const projected = projectedById.get(selection.connectionId);
      if (!projected) {
        if (args.missingAccountPolicy === "omit") {
          // Deletion can commit between the ownership read and the projection.
          // Initial thread creation omits a deleted account at either boundary;
          // an existing but unavailable account still receives the same error.
          const current = connectorTargetOwnershipsFromRows(
            await db
              .select(connectorTargetOwnershipColumns)
              .from(connectors)
              .where(inArray(connectors.id, [selection.connectionId])),
          );
          signal.throwIfAborted();
          if (!current.has(selection.connectionId)) {
            byTarget.delete(key);
            continue;
          }
        }
        return {
          kind: "invalid",
          message: "Connector account is unavailable for thread selection",
        };
      }
    }
    signal.throwIfAborted();
    return { kind: "ready", selections: [...byTarget.values()] };
  },
);

function foreignKeyConstraint(error: unknown): string | undefined {
  if (
    !isForeignKeyViolation(error) ||
    !(error instanceof Error) ||
    typeof error.cause !== "object" ||
    error.cause === null ||
    !("constraint" in error.cause) ||
    typeof error.cause.constraint !== "string"
  ) {
    return undefined;
  }
  return error.cause.constraint;
}

/**
 * A selection insert lost a race with deletion of its parent: the thread
 * (and its Agent, which cascades to the thread) or the selected account.
 * PostgreSQL's FK check waits for the deleting transaction and then rejects
 * the insert; callers map it to a deterministic result.
 */
export function selectionParentMissing(
  error: unknown,
): "thread" | "account" | undefined {
  switch (foreignKeyConstraint(error)) {
    case "fk_chat_thread_connector_selections_thread": {
      return "thread";
    }
    case "fk_chat_thread_connector_selections_connector_slug":
    case "fk_chat_thread_connector_selections_custom_connector": {
      return "account";
    }
    default: {
      return undefined;
    }
  }
}

function updatedThreadSelectionPlan(
  chatThreadId: string,
  selection: PreparedChatThreadConnectorSelection,
) {
  const query = new QueryBuilder();
  const account = query
    .$with("selected_connector_account")
    .as(
      query
        .select({ id: connectors.id })
        .from(connectors)
        .where(eq(connectors.id, selection.connectionId)),
    );
  const target = targetColumns(selection.target);
  return {
    account,
    source: sql`SELECT ${chatThreadId}::uuid, ${account.id}, ${target.connectorSlug}::varchar, ${target.customConnectorId}::uuid FROM ${account}`,
    conflict: {
      target:
        selection.target.kind === "builtin"
          ? [
              chatThreadConnectorSelections.chatThreadId,
              chatThreadConnectorSelections.connectorSlug,
            ]
          : [
              chatThreadConnectorSelections.chatThreadId,
              chatThreadConnectorSelections.customConnectorId,
            ],
      targetWhere: isNotNull(
        selection.target.kind === "builtin"
          ? chatThreadConnectorSelections.connectorSlug
          : chatThreadConnectorSelections.customConnectorId,
      ),
      set: { connectorId: selection.connectionId },
    },
  };
}

function failedThreadSelectionUpdate(
  error: unknown,
): UpdateChatThreadConnectorSelectionResult {
  // Wait for the whole transaction to roll back before reporting a lost
  // parent, including its selection change.
  switch (selectionParentMissing(error)) {
    case "thread": {
      return { kind: "not_found" };
    }
    case "account": {
      return {
        kind: "invalid",
        message: "Connector account does not match the requested target",
      };
    }
    default: {
      throw error;
    }
  }
}

const prepareUpdatedThreadSelection$ = command(
  async (
    { set },
    args: ChatThreadConnectorSelectionScope & {
      readonly selection: ConnectorAccountSelection;
    },
    signal: AbortSignal,
  ) => {
    signal.throwIfAborted();
    const db = set(writeDb$);
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
    signal.throwIfAborted();
    if (!thread?.agentId) {
      return { kind: "not_found" as const };
    }
    const prepared = await set(
      prepareChatThreadConnectorSelections$,
      {
        orgId: args.orgId,
        userId: args.userId,
        agentId: thread.agentId,
        selections: [args.selection],
      },
      signal,
    );
    return prepared;
  },
);

export const updateChatThreadConnectorSelection$ = command(
  async (
    { set },
    args: ChatThreadConnectorSelectionScope & {
      readonly selection: ConnectorAccountSelection;
    },
    signal: AbortSignal,
  ): Promise<UpdateChatThreadConnectorSelectionResult> => {
    const db = set(writeDb$);
    const prepared = await set(prepareUpdatedThreadSelection$, args, signal);
    if (prepared.kind === "invalid" || prepared.kind === "not_found") {
      return prepared;
    }
    const result = await settle(
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0092; new non-billing transactions are prohibited.
      db.transaction(
        async (tx): Promise<UpdateChatThreadConnectorSelectionResult> => {
          // No parent row lock: the selection upsert's FK check on the thread
          // (or the row lock on an existing selection) makes a concurrent Agent
          // or thread deletion wait for this commit, or reject the upsert.
          const [selection] = prepared.selections;
          if (!selection) {
            throw new Error("Expected one prepared connector selection");
          }
          // The account CTE and FK keep a concurrent account deletion outside this insert.
          const insert = updatedThreadSelectionPlan(
            args.chatThreadId,
            selection,
          );
          const [row] = await tx
            .with(insert.account)
            .insert(chatThreadConnectorSelections)
            .select(insert.source)
            .onConflictDoUpdate(insert.conflict)
            .returning({
              connectorId: chatThreadConnectorSelections.connectorId,
            });
          const updated = row ? selection : undefined;
          if (!updated) {
            return {
              kind: "invalid",
              message: "Connector account does not match the requested target",
            };
          }
          await reprojectWorkflowAutomationsForOwner(
            tx,
            { ...args, target: selection.target },
            signal,
          );
          return {
            kind: "updated",
            selection: updated,
          };
        },
      ),
    );
    signal.throwIfAborted();
    if (result.ok) {
      return result.value;
    }
    return failedThreadSelectionUpdate(result.error);
  },
);

export const clearChatThreadConnectorSelection$ = command(
  async function clearChatThreadConnectorSelection(
    { set },
    args: {
      readonly orgId: string;
      readonly userId: string;
      readonly chatThreadId: string;
      readonly target: ConnectorAccountTarget;
    },
    signal: AbortSignal,
  ): Promise<ClearChatThreadConnectorSelectionResult> {
    const db = set(writeDb$);
    // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0093; new non-billing transactions are prohibited.
    return await db.transaction(async (tx) => {
      const [thread] = await tx
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
      if (!thread?.agentId) {
        return { kind: "not_found" };
      }
      // Only event sources also change the owner's automation projections.
      // The reprojection recomputes from current rows.
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
  },
);

/** Pure, stably ordered statements. The creation owner executes savepoints. */
export function initialChatThreadConnectorSelectionStatements(args: {
  readonly chatThreadId: string;
  readonly selections: readonly PreparedChatThreadConnectorSelection[];
}) {
  return [...args.selections]
    .sort((a, b) => {
      return a.connectionId < b.connectionId
        ? -1
        : a.connectionId > b.connectionId
          ? 1
          : 0;
    })
    .map((selection) => {
      const target = targetColumns(selection.target);
      return sql`INSERT INTO ${chatThreadConnectorSelections}
      (chat_thread_id, connector_id, connector_slug, custom_connector_id)
      SELECT ${args.chatThreadId}::uuid, ${connectors.id}, ${target.connectorSlug}::varchar, ${target.customConnectorId}::uuid
      FROM ${connectors} WHERE ${connectors.id} = ${selection.connectionId}::uuid`;
    });
}
