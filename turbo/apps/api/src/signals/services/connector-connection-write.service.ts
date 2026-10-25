import type {
  ConnectorAccountMutationIntent,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectors } from "@okouai/db/schema/connector";
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
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

/**
 * Thrown by {@link connectorConnectionWrittenRow} when a concurrent writer
 * changed the resolved account set. Callers using the `*Outcome` variants
 * receive the deterministic outcome instead.
 */
export class ConnectorConnectionWriteLostError extends Error {
  constructor(
    readonly outcome: Exclude<
      ConnectorConnectionWriteOutcome,
      { readonly kind: "written" }
    >["kind"],
  ) {
    super(`Connector connection write lost a concurrent change: ${outcome}`);
    this.name = "ConnectorConnectionWriteLostError";
  }
}

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

export async function writeConnectorConnectionMetadataOutcome(
  db: Tx,
  args: ConnectorConnectionMetadataArgs & {
    readonly resolution: ReadyConnectorConnectionMutation;
  },
): Promise<ConnectorConnectionWriteOutcome> {
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
  let insert: InsertConnectorConnectionMutation;
  if (args.resolution.kind === "update") {
    // Exact identity: zero rows means the account was deleted after
    // resolution.
    const [updated] = await db
      .update(connectors)
      .set({
        ...replacementValues,
        updatedAt: sql`clock_timestamp()`,
      })
      .where(
        and(ownerCondition, eq(connectors.id, args.resolution.existing.id)),
      )
      .returning(connectorConnectionSelection());
    if (updated) {
      return { kind: "written", row: updated };
    }
    if (args.resolution.insertIfMissing === null) {
      return { kind: "missing" };
    }
    insert = args.resolution.insertIfMissing;
  } else {
    insert = args.resolution;
  }
  const insertDb = db;
  const insertArgs: {
    readonly target: ConnectorConnectionMetadataArgs["target"];
    readonly ownerCondition: ReturnType<typeof and>;
    readonly resolution: InsertConnectorConnectionMutation;
    readonly insertValues: (value: boolean) => typeof connectors.$inferInsert;
    readonly replacementValues: Partial<typeof connectors.$inferInsert>;
  } = {
    target: args.target,
    ownerCondition,
    resolution: insert,
    insertValues: (isDefault) => {
      return {
        ...(args.insertConnectionId ? { id: args.insertConnectionId } : {}),
        orgId: args.orgId,
        userId: args.userId,
        displayName: insert.displayName,
        isDefault,
        ...targetValues,
        ...replacementValues,
      };
    },
    replacementValues,
  };
  /**
   * Inserts an account without locking its siblings. The default is always
   * tried first against the target's partial default unique index
   * (idx_connectors_org_user_slug_default / _custom_connector_default): it
   * succeeds only while no committed default exists, and waits for an
   * in-flight default writer. On conflict the serialized outcome is applied:
   * an add whose external identity a concurrent create already stored updates
   * that row, a single-account target reports sibling-disabled, otherwise the
   * account becomes a non-default sibling.
   */
  return await (async (): Promise<ConnectorConnectionWriteOutcome> => {
    const [inserted] = await insertDb
      .insert(connectors)
      .values(insertArgs.insertValues(true))
      .onConflictDoNothing(
        connectorConnectionDefaultConflict(insertArgs.target.kind),
      )
      .returning(connectorConnectionSelection());
    if (inserted) {
      return { kind: "written", row: inserted };
    }

    const matchExternalId = insertArgs.resolution.matchExternalId;
    if (matchExternalId !== null) {
      const sameIdentity = and(
        insertArgs.ownerCondition,
        eq(connectors.externalId, matchExternalId),
      );
      const [updated] = await insertDb
        .update(connectors)
        .set({
          ...insertArgs.replacementValues,
          updatedAt: sql`clock_timestamp()`,
        })
        .where(
          and(
            sameIdentity,
            eq(
              connectors.id,
              insertDb
                .select({ id: connectors.id })
                .from(connectors)
                .where(sameIdentity)
                .orderBy(connectors.id)
                .limit(1),
            ),
          ),
        )
        .returning(connectorConnectionSelection());
      if (updated) {
        return { kind: "written", row: updated };
      }
    }
    if (!insertArgs.resolution.allowSiblings) {
      log.debug("Concurrent first connector account create lost", {
        targetKind: insertArgs.target.kind,
      });
      return { kind: "sibling-disabled" };
    }
    const [sibling] = await insertDb
      .insert(connectors)
      .values(insertArgs.insertValues(false))
      .returning(connectorConnectionSelection());
    if (!sibling) {
      throw new Error(
        `Failed to write ${insertArgs.target.kind === "builtin" ? "Builtin" : "Custom"} connector connection`,
      );
    }
    return { kind: "written", row: sibling };
  })();
}

export function connectorConnectionWrittenRow(
  outcome: ConnectorConnectionWriteOutcome,
): StoredConnectorConnectionRow {
  if (outcome.kind !== "written") {
    throw new ConnectorConnectionWriteLostError(outcome.kind);
  }
  return outcome.row;
}

export type ConnectorConnectionWriteArgs = Parameters<
  typeof writeConnectorConnectionMetadataOutcome
>[1];

export async function awaitConnectorConnectionRow(
  outcome: Promise<ConnectorConnectionWriteOutcome>,
): Promise<StoredConnectorConnectionRow> {
  return connectorConnectionWrittenRow(await outcome);
}
