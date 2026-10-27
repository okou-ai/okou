import type {
  ConnectorAccountMutationIntent,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectors } from "@okouai/db/schema/connector";
import { and, eq, sql } from "drizzle-orm";
import { QueryBuilder, type PgUpdateSetSource } from "drizzle-orm/pg-core";

import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";

import {
  connectorConnectionDefaultConflict,
  connectorConnectionIdentityValues,
  connectorConnectionReplacementValues,
  connectorConnectionTargetValues,
  type ConnectorConnectionMetadataArgs,
} from "./connector-account-mutation.service";

const log = logger("api:connector-account-mutation");

export interface StoredConnectorConnectionRow {
  readonly id: string;
  readonly authMethod: string;
  readonly automaticAuthType: "none" | "oauth" | null;
  readonly displayName: string | null;
  readonly isDefault: boolean;
  readonly externalId: string | null;
  readonly externalUsername: string | null;
  readonly externalEmail: string | null;
  readonly oauthScopes: string | null;
  readonly oauthGrantedScopes: string | null;
  readonly needsReconnect: boolean;
  readonly reconnectReason: string | null;
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface ConnectorConnectionMetadataQuery {
  returning(
    fields: ReturnType<typeof connectorConnectionSelection>,
  ): PromiseLike<StoredConnectorConnectionRow[]>;
}

interface ExistingConnectorConnectionRow extends StoredConnectorConnectionRow {
  readonly stateRevision: string;
  readonly connectorSlug: string | null;
  readonly customConnectorId: string | null;
}

type InsertConnectorConnectionMutation = {
  readonly kind: "insert";
  readonly displayName: string | null;
  /**
   * Observed at resolution time only. The write always tries the default
   * first and lets the target's partial default unique index decide, so a
   * concurrent first create or default removal cannot leave two defaults or
   * none.
   */
  readonly isDefault: boolean;
  /**
   * Resolution inputs re-applied when a concurrent writer committed a default
   * after resolution: the insert becomes an update of a same-identity winner,
   * a non-default sibling, or sibling-disabled, as the serialized order would.
   */
  readonly allowSiblings: boolean;
  readonly matchExternalId: string | null;
};

export type ReadyConnectorConnectionMutation =
  | InsertConnectorConnectionMutation
  | {
      readonly kind: "update";
      readonly existing: ExistingConnectorConnectionRow;
      /**
       * An `add` matched by external identity inserts instead when that row
       * was deleted after resolution; an explicit reconnect reports missing.
       */
      readonly insertIfMissing: InsertConnectorConnectionMutation | null;
    };

/**
 * Outcome of a connection write whose resolution was read without locks: a
 * concurrent writer may have deleted the reconnected row, or a
 * single-account target may have received its first account meanwhile.
 */
export type ConnectorConnectionWriteOutcome =
  | { readonly kind: "written"; readonly row: StoredConnectorConnectionRow }
  | { readonly kind: "missing" }
  | { readonly kind: "sibling-disabled" };

export type ConnectorConnectionMutationResolution =
  | {
      readonly kind: "ready";
      readonly mutation: ReadyConnectorConnectionMutation;
    }
  | { readonly kind: "missing" }
  | { readonly kind: "ambiguous" }
  | { readonly kind: "sibling-disabled" };

type ConnectorConnectionMutationOutcome =
  | ReadyConnectorConnectionMutation["kind"]
  | Exclude<
      ConnectorConnectionMutationResolution,
      { readonly kind: "ready" }
    >["kind"];

type ConnectorConnectionSelectionCardinality = "zero" | "one" | "multiple";

function connectorConnectionSelectionCardinality(
  count: number,
): ConnectorConnectionSelectionCardinality {
  if (count === 0) {
    return "zero";
  }
  return count === 1 ? "one" : "multiple";
}

function connectorConnectionMutationOutcome(
  resolution: ConnectorConnectionMutationResolution,
): ConnectorConnectionMutationOutcome {
  return resolution.kind === "ready"
    ? resolution.mutation.kind
    : resolution.kind;
}

function observeConnectorConnectionMutation(
  args: {
    readonly targetKind: ConnectorAccountTarget["kind"];
    readonly intent: ConnectorAccountMutationIntent["intent"];
    readonly selectedCount: number;
  },
  resolution: ConnectorConnectionMutationResolution,
): ConnectorConnectionMutationResolution {
  log.debug("Resolved connector account mutation", {
    targetKind: args.targetKind,
    intent: args.intent,
    selectionCardinality: connectorConnectionSelectionCardinality(
      args.selectedCount,
    ),
    outcome: connectorConnectionMutationOutcome(resolution),
  });
  return resolution;
}

export function connectorConnectionSelection() {
  return {
    id: connectors.id,
    authMethod: connectors.authMethod,
    automaticAuthType: connectors.automaticAuthType,
    displayName: connectors.displayName,
    isDefault: connectors.isDefault,
    externalId: connectors.externalId,
    externalUsername: connectors.externalUsername,
    externalEmail: connectors.externalEmail,
    oauthScopes: connectors.oauthScopes,
    oauthGrantedScopes: connectors.oauthGrantedScopes,
    needsReconnect: connectors.needsReconnect,
    reconnectReason: connectors.reconnectReason,
    storageVersion: connectors.storageVersion,
    tokenExpiresAt: connectors.tokenExpiresAt,
    createdAt: connectors.createdAt,
    updatedAt: connectors.updatedAt,
  };
}

export function existingConnectorConnectionSelection() {
  return {
    ...connectorConnectionSelection(),
    stateRevision: sql`${connectors.updatedAt}::text`.mapWith(pgTextDecoder),
    connectorSlug: connectors.connectorSlug,
    customConnectorId: connectors.customConnectorId,
  };
}

function targetCondition(target: ConnectorAccountTarget) {
  return target.kind === "builtin"
    ? eq(connectors.connectorSlug, target.connectorSlug)
    : eq(connectors.customConnectorId, target.customConnectorId);
}

export interface ConnectorConnectionMutationArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly target: ConnectorAccountTarget;
  readonly mutation: ConnectorAccountMutationIntent;
  readonly allowSiblings: boolean;
  readonly matchExternalId?: string;
}

function connectorConnectionTargetReadPlan(
  args: Pick<ConnectorConnectionMutationArgs, "orgId" | "userId" | "target">,
) {
  return {
    columns: existingConnectorConnectionSelection(),
    from: connectors,
    where: and(
      eq(connectors.orgId, args.orgId),
      eq(connectors.userId, args.userId),
      targetCondition(args.target),
    ),
    orderBy: [connectors.id],
    limit: 2,
  };
}

export function connectorConnectionMutationReadPlan(
  args: ConnectorConnectionMutationArgs,
) {
  // Reads observe the account set; the write still arbitrates its own identity.
  if (args.mutation.intent === "reconnect") {
    return {
      kind: "reconnect" as const,
      columns: existingConnectorConnectionSelection(),
      from: connectors,
      where: and(
        eq(connectors.id, args.mutation.connectionId),
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        targetCondition(args.target),
      ),
      limit: 1,
      orderBy: [],
    };
  }
  const displayName =
    args.mutation.intent === "add" ? (args.mutation.displayName ?? null) : null;
  if (args.mutation.intent === "add" && args.matchExternalId !== undefined) {
    return {
      kind: "external" as const,
      displayName,
      columns: existingConnectorConnectionSelection(),
      from: connectors,
      where: and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        targetCondition(args.target),
        eq(connectors.externalId, args.matchExternalId),
      ),
      orderBy: [connectors.id],
      limit: 2,
    };
  }
  return {
    kind: "target" as const,
    displayName,
    ...connectorConnectionTargetReadPlan(args),
  };
}

type ConnectorConnectionMutationSelection =
  | {
      readonly kind: "reconnect";
      readonly existing: ExistingConnectorConnectionRow | undefined;
    }
  | {
      readonly kind: "external";
      readonly existing: ExistingConnectorConnectionRow;
      readonly duplicate: ExistingConnectorConnectionRow | undefined;
      readonly selectedCount: number;
      readonly displayName: string | null;
    }
  | {
      readonly kind: "target";
      readonly selectedCount: number;
      readonly displayName: string | null;
    };

export function connectorConnectionMutationReadResult(
  args: ConnectorConnectionMutationArgs,
  read: ReturnType<typeof connectorConnectionMutationReadPlan>,
  rows: readonly ExistingConnectorConnectionRow[],
) {
  if (read.kind === "reconnect") {
    return {
      kind: "resolved" as const,
      resolution: connectorConnectionMutationResolution(args, {
        kind: "reconnect",
        existing: rows[0],
      }),
    };
  }
  if (read.kind === "external") {
    const [existing, duplicate] = rows;
    if (existing) {
      return {
        kind: "resolved" as const,
        resolution: connectorConnectionMutationResolution(args, {
          kind: "external",
          existing,
          duplicate,
          selectedCount: rows.length,
          displayName: read.displayName,
        }),
      };
    }
    return {
      kind: "read" as const,
      read: {
        kind: "target" as const,
        displayName: read.displayName,
        ...connectorConnectionTargetReadPlan(args),
      },
    };
  }
  return {
    kind: "resolved" as const,
    resolution: connectorConnectionMutationResolution(args, {
      kind: "target",
      selectedCount: rows.length,
      displayName: read.displayName,
    }),
  };
}

function connectorConnectionMutationResolution(
  args: ConnectorConnectionMutationArgs,
  selection: ConnectorConnectionMutationSelection,
): ConnectorConnectionMutationResolution {
  if (selection.kind === "reconnect") {
    const existing = selection.existing;
    const resolution: ConnectorConnectionMutationResolution = existing
      ? {
          kind: "ready",
          mutation: { kind: "update", existing, insertIfMissing: null },
        }
      : { kind: "missing" };
    return observeConnectorConnectionMutation(
      {
        targetKind: args.target.kind,
        intent: args.mutation.intent,
        selectedCount: existing ? 1 : 0,
      },
      resolution,
    );
  }
  const displayName = selection.displayName;
  const insertMutation = (
    isDefault: boolean,
  ): InsertConnectorConnectionMutation => {
    return {
      kind: "insert",
      displayName,
      isDefault,
      allowSiblings: args.allowSiblings,
      matchExternalId:
        args.mutation.intent === "add" ? (args.matchExternalId ?? null) : null,
    };
  };
  if (selection.kind === "external") {
    const resolution: ConnectorConnectionMutationResolution =
      selection.duplicate
        ? { kind: "ambiguous" }
        : {
            kind: "ready",
            mutation: {
              kind: "update",
              existing: selection.existing,
              insertIfMissing: insertMutation(false),
            },
          };
    return observeConnectorConnectionMutation(
      {
        targetKind: args.target.kind,
        intent: args.mutation.intent,
        selectedCount: selection.selectedCount,
      },
      resolution,
    );
  }
  let resolution: ConnectorConnectionMutationResolution;
  if (selection.selectedCount > 0 && !args.allowSiblings) {
    resolution = { kind: "sibling-disabled" };
  } else {
    resolution = {
      kind: "ready",
      mutation: insertMutation(selection.selectedCount === 0),
    };
  }
  return observeConnectorConnectionMutation(
    {
      targetKind: args.target.kind,
      intent: args.mutation.intent,
      selectedCount: selection.selectedCount,
    },
    resolution,
  );
}

export type ConnectorConnectionWriteArgs = ConnectorConnectionMetadataArgs & {
  readonly resolution: ReadyConnectorConnectionMutation;
};

function connectorConnectionMetadataValues(args: ConnectorConnectionWriteArgs) {
  const identityValues = connectorConnectionIdentityValues(args.target);
  const targetValues = connectorConnectionTargetValues(args.target);
  const replacementValues = connectorConnectionReplacementValues(
    args.authMethod,
    args.automaticAuthType ?? null,
    args.storageVersion,
    identityValues,
    args.tokenExpiresAt,
  );
  const ownerCondition = and(
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    args.target.kind === "builtin"
      ? eq(connectors.connectorSlug, args.target.connectorSlug)
      : eq(connectors.customConnectorId, args.target.customConnectorId),
  );
  return { args, targetValues, replacementValues, ownerCondition };
}

type ConnectorConnectionMetadataValues = ReturnType<
  typeof connectorConnectionMetadataValues
>;

type ConnectorConnectionMetadataWrite = {
  readonly context: ConnectorConnectionMetadataValues;
  readonly insert: InsertConnectorConnectionMutation | null;
} & (
  | {
      readonly kind: "update";
      readonly phase: "existing" | "identity";
      readonly values: PgUpdateSetSource<typeof connectors>;
      readonly where: ReturnType<typeof and>;
    }
  | {
      readonly kind: "insert";
      readonly phase: "default" | "sibling";
      readonly values: typeof connectors.$inferInsert;
      readonly conflict: ReturnType<
        typeof connectorConnectionDefaultConflict
      > | null;
    }
);

function connectorConnectionMetadataInsert(
  context: ConnectorConnectionMetadataValues,
  insert: InsertConnectorConnectionMutation,
  isDefault: boolean,
): ConnectorConnectionMetadataWrite {
  const { args, targetValues, replacementValues } = context;
  return {
    kind: "insert",
    phase: isDefault ? "default" : "sibling",
    context,
    insert,
    values: {
      ...(args.insertConnectionId ? { id: args.insertConnectionId } : {}),
      orgId: args.orgId,
      userId: args.userId,
      displayName: insert.displayName,
      isDefault,
      ...targetValues,
      ...replacementValues,
    },
    conflict: isDefault
      ? connectorConnectionDefaultConflict(args.target.kind)
      : null,
  };
}

/** The default unique index arbitrates every insertion before sibling creation. */
export function connectorConnectionMetadataWritePlan(
  args: ConnectorConnectionWriteArgs,
): ConnectorConnectionMetadataWrite {
  const context = connectorConnectionMetadataValues(args);
  if (args.resolution.kind === "update") {
    return {
      kind: "update",
      phase: "existing",
      context,
      insert: args.resolution.insertIfMissing,
      values: {
        ...context.replacementValues,
        updatedAt: sql`clock_timestamp()`,
      },
      where: and(
        context.ownerCondition,
        eq(connectors.id, args.resolution.existing.id),
      ),
    };
  }
  return connectorConnectionMetadataInsert(context, args.resolution, true);
}

function connectorConnectionIdentityWrite(
  context: ConnectorConnectionMetadataValues,
  insert: InsertConnectorConnectionMutation,
  matchExternalId: string,
): ConnectorConnectionMetadataWrite {
  const sameIdentity = and(
    context.ownerCondition,
    eq(connectors.externalId, matchExternalId),
  );
  return {
    kind: "update",
    phase: "identity",
    context,
    insert,
    values: {
      ...context.replacementValues,
      updatedAt: sql`clock_timestamp()`,
    },
    where: and(
      sameIdentity,
      eq(
        connectors.id,
        new QueryBuilder()
          .select({ id: connectors.id })
          .from(connectors)
          .where(sameIdentity)
          .orderBy(connectors.id)
          .limit(1),
      ),
    ),
  };
}

type ConnectorConnectionMetadataWriteResult =
  | { readonly kind: "write"; readonly write: ConnectorConnectionMetadataWrite }
  | {
      readonly kind: "resolved";
      readonly outcome: ConnectorConnectionWriteOutcome;
    };

/** Each miss advances once through the existing arbitration, never retries. */
export function connectorConnectionMetadataWriteResult(
  write: ConnectorConnectionMetadataWrite,
  row: StoredConnectorConnectionRow | undefined,
): ConnectorConnectionMetadataWriteResult {
  if (row) {
    return { kind: "resolved", outcome: { kind: "written", row } };
  }
  const { context, insert } = write;
  if (insert === null) {
    return { kind: "resolved", outcome: { kind: "missing" } };
  }
  if (write.phase === "existing") {
    return {
      kind: "write",
      write: connectorConnectionMetadataInsert(context, insert, true),
    };
  }
  if (write.phase === "sibling") {
    throw new Error(
      `Failed to write ${context.args.target.kind === "builtin" ? "Builtin" : "Custom"} connector connection`,
    );
  }
  if (write.phase === "default" && insert.matchExternalId !== null) {
    return {
      kind: "write",
      write: connectorConnectionIdentityWrite(
        context,
        insert,
        insert.matchExternalId,
      ),
    };
  }
  if (!insert.allowSiblings) {
    log.debug("Concurrent first connector account create lost", {
      targetKind: context.args.target.kind,
    });
    return { kind: "resolved", outcome: { kind: "sibling-disabled" } };
  }
  return {
    kind: "write",
    write: connectorConnectionMetadataInsert(context, insert, false),
  };
}
