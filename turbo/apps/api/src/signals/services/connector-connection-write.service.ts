import type {
  ConnectorAccountMutationIntent,
  ConnectorAccountTarget,
} from "@okouai/api-contracts/contracts/connector-accounts";
import { connectors } from "@okouai/db/schema/connector";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import { and, eq, sql } from "drizzle-orm";

import type { Tx } from "../../lib/db-types";
import { pgTextDecoder } from "../../lib/db-structured-result";
import { logger } from "../../lib/log";
import { deleteConnectorOwnedCredentialRows } from "./connector-credential-storage-write.service";

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

type ConnectorConnectionTarget =
  | {
      readonly kind: "builtin";
      readonly connectorSlug: string;
      readonly identity:
        | { readonly kind: "local" }
        | {
            readonly kind: "external";
            readonly externalId: string;
            readonly externalUsername: string | null;
            readonly externalEmail: string | null;
            readonly oauthRequestedScopes: readonly string[] | null;
            readonly oauthGrantedScopes: readonly string[] | null;
          };
    }
  | {
      readonly kind: "custom";
      readonly customConnectorId: string;
      readonly oauthScopes: readonly string[] | null;
      readonly identity:
        | { readonly kind: "local" }
        | {
            readonly kind: "external";
            readonly externalId: string;
            readonly externalUsername: string | null;
            readonly externalEmail: string | null;
          };
    };

interface ConnectorCredentialWriteContext {
  readonly db: Tx;
  readonly connectorId: string;
}

export interface ConnectorConnectionMetadataArgs {
  readonly orgId: string;
  readonly userId: string;
  readonly authMethod: string;
  readonly automaticAuthType?: "none" | "oauth";
  readonly storageVersion: number;
  readonly tokenExpiresAt: Date | null;
  readonly target: ConnectorConnectionTarget;
  readonly insertConnectionId?: string;
}

interface ReplaceConnectorConnectionArgs extends ConnectorConnectionMetadataArgs {
  readonly resolution: ReadyConnectorConnectionMutation;
  readonly writeCredentials: (
    context: ConnectorCredentialWriteContext,
    signal: AbortSignal,
  ) => Promise<void>;
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
 * Thrown only by the row-returning compatibility wrappers when a concurrent
 * writer changed the resolved account set. Callers using the `*Outcome`
 * variants receive the deterministic outcome instead.
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

function connectorConnectionSelection() {
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

function existingConnectorConnectionSelection() {
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

export async function resolveConnectorConnectionMutation(
  db: Tx,
  args: {
    readonly orgId: string;
    readonly userId: string;
    readonly target: ConnectorAccountTarget;
    readonly mutation: ConnectorAccountMutationIntent;
    readonly allowSiblings: boolean;
    readonly matchExternalId?: string;
  },
): Promise<ConnectorConnectionMutationResolution> {
  // No row locks: the write re-checks what it depends on (exact identity on
  // update, the partial default unique index on insert) and turns a lost race
  // into a deterministic outcome.
  if (args.mutation.intent === "reconnect") {
    const [existing] = await db
      .select(existingConnectorConnectionSelection())
      .from(connectors)
      .where(
        and(
          eq(connectors.id, args.mutation.connectionId),
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          targetCondition(args.target),
        ),
      )
      .limit(1);
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

  const displayName =
    args.mutation.intent === "add" ? (args.mutation.displayName ?? null) : null;
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

  if (args.mutation.intent === "add" && args.matchExternalId !== undefined) {
    const existingByExternalId = await db
      .select(existingConnectorConnectionSelection())
      .from(connectors)
      .where(
        and(
          eq(connectors.orgId, args.orgId),
          eq(connectors.userId, args.userId),
          targetCondition(args.target),
          eq(connectors.externalId, args.matchExternalId),
        ),
      )
      .orderBy(connectors.id)
      .limit(2);
    const [existing, duplicate] = existingByExternalId;
    if (existing) {
      const resolution: ConnectorConnectionMutationResolution = duplicate
        ? { kind: "ambiguous" }
        : {
            kind: "ready",
            mutation: {
              kind: "update",
              existing,
              insertIfMissing: insertMutation(false),
            },
          };
      return observeConnectorConnectionMutation(
        {
          targetKind: args.target.kind,
          intent: args.mutation.intent,
          selectedCount: existingByExternalId.length,
        },
        resolution,
      );
    }
  }

  const existing = await db
    .select(existingConnectorConnectionSelection())
    .from(connectors)
    .where(
      and(
        eq(connectors.orgId, args.orgId),
        eq(connectors.userId, args.userId),
        targetCondition(args.target),
      ),
    )
    .orderBy(connectors.id)
    .limit(2);
  let resolution: ConnectorConnectionMutationResolution;
  if (existing.length > 0 && !args.allowSiblings) {
    resolution = { kind: "sibling-disabled" };
  } else {
    resolution = {
      kind: "ready",
      mutation: insertMutation(existing.length === 0),
    };
  }
  return observeConnectorConnectionMutation(
    {
      targetKind: args.target.kind,
      intent: args.mutation.intent,
      selectedCount: existing.length,
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
  const identityValues =
    args.target.kind === "custom"
      ? {
          externalId:
            args.target.identity.kind === "external"
              ? args.target.identity.externalId
              : null,
          externalUsername:
            args.target.identity.kind === "external"
              ? args.target.identity.externalUsername
              : null,
          externalEmail:
            args.target.identity.kind === "external"
              ? args.target.identity.externalEmail
              : null,
          oauthScopes:
            args.target.oauthScopes === null
              ? null
              : JSON.stringify(args.target.oauthScopes),
          oauthGrantedScopes: null,
        }
      : args.target.identity.kind === "external"
        ? {
            externalId: args.target.identity.externalId,
            externalUsername: args.target.identity.externalUsername,
            externalEmail: args.target.identity.externalEmail,
            oauthScopes:
              args.target.identity.oauthRequestedScopes === null
                ? null
                : JSON.stringify(args.target.identity.oauthRequestedScopes),
            oauthGrantedScopes:
              args.target.identity.oauthGrantedScopes === null
                ? null
                : JSON.stringify(args.target.identity.oauthGrantedScopes),
          }
        : {
            externalId: null,
            externalUsername: null,
            externalEmail: null,
            oauthScopes: null,
            oauthGrantedScopes: null,
          };
  const targetValues =
    args.target.kind === "builtin"
      ? {
          connectorSlug: args.target.connectorSlug,
          customConnectorId: null,
        }
      : {
          connectorSlug: null,
          customConnectorId: args.target.customConnectorId,
        };
  const replacementValues = {
    authMethod: args.authMethod,
    automaticAuthType: args.automaticAuthType ?? null,
    storageVersion: args.storageVersion,
    ...identityValues,
    tokenExpiresAt: args.tokenExpiresAt,
    needsReconnect: false,
    reconnectReason: null,
  };
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
  return await insertConnectorConnection(db, {
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
  });
}

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
async function insertConnectorConnection(
  db: Tx,
  args: {
    readonly target: ConnectorConnectionTarget;
    readonly ownerCondition: ReturnType<typeof and>;
    readonly resolution: InsertConnectorConnectionMutation;
    readonly insertValues: (
      isDefault: boolean,
    ) => typeof connectors.$inferInsert;
    readonly replacementValues: Partial<typeof connectors.$inferInsert>;
  },
): Promise<ConnectorConnectionWriteOutcome> {
  const [inserted] = await db
    .insert(connectors)
    .values(args.insertValues(true))
    .onConflictDoNothing(
      args.target.kind === "builtin"
        ? {
            target: [
              connectors.orgId,
              connectors.userId,
              connectors.connectorSlug,
            ],
            where: sql`${connectors.connectorSlug} IS NOT NULL AND ${connectors.isDefault} = true`,
          }
        : {
            target: [
              connectors.orgId,
              connectors.userId,
              connectors.customConnectorId,
            ],
            where: sql`${connectors.customConnectorId} IS NOT NULL AND ${connectors.isDefault} = true`,
          },
    )
    .returning(connectorConnectionSelection());
  if (inserted) {
    return { kind: "written", row: inserted };
  }

  const matchExternalId = args.resolution.matchExternalId;
  if (matchExternalId !== null) {
    const sameIdentity = and(
      args.ownerCondition,
      eq(connectors.externalId, matchExternalId),
    );
    const [updated] = await db
      .update(connectors)
      .set({ ...args.replacementValues, updatedAt: sql`clock_timestamp()` })
      .where(
        and(
          sameIdentity,
          eq(
            connectors.id,
            db
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
  if (!args.resolution.allowSiblings) {
    log.debug("Concurrent first connector account create lost", {
      targetKind: args.target.kind,
    });
    return { kind: "sibling-disabled" };
  }
  const [sibling] = await db
    .insert(connectors)
    .values(args.insertValues(false))
    .returning(connectorConnectionSelection());
  if (!sibling) {
    throw new Error(
      `Failed to write ${args.target.kind === "builtin" ? "Builtin" : "Custom"} connector connection`,
    );
  }
  return { kind: "written", row: sibling };
}

function writtenRowOrThrow(
  outcome: ConnectorConnectionWriteOutcome,
): StoredConnectorConnectionRow {
  if (outcome.kind !== "written") {
    throw new ConnectorConnectionWriteLostError(outcome.kind);
  }
  return outcome.row;
}

/**
 * Row-returning form of {@link writeConnectorConnectionMetadataOutcome}; a
 * concurrently lost resolution throws {@link ConnectorConnectionWriteLostError}.
 */
export async function writeConnectorConnectionMetadata(
  db: Tx,
  args: ConnectorConnectionMetadataArgs & {
    readonly resolution: ReadyConnectorConnectionMutation;
  },
): Promise<StoredConnectorConnectionRow> {
  return writtenRowOrThrow(
    await writeConnectorConnectionMetadataOutcome(db, args),
  );
}

export async function replaceConnectorConnectionOutcome(
  db: Tx,
  args: ReplaceConnectorConnectionArgs,
  signal: AbortSignal,
): Promise<ConnectorConnectionWriteOutcome> {
  const outcome = await writeConnectorConnectionMetadataOutcome(db, args);
  signal.throwIfAborted();
  if (outcome.kind !== "written") {
    return outcome;
  }
  const connection = outcome.row;

  await deleteConnectorOwnedCredentialRows(
    db,
    { connectorId: connection.id },
    signal,
  );
  await db
    .delete(builtinConnectorAccountOauthBindings)
    .where(
      eq(
        builtinConnectorAccountOauthBindings.connectorAccountId,
        connection.id,
      ),
    );
  await args.writeCredentials({ db, connectorId: connection.id }, signal);
  signal.throwIfAborted();

  return outcome;
}

/**
 * Row-returning form of {@link replaceConnectorConnectionOutcome}; a
 * concurrently lost resolution throws {@link ConnectorConnectionWriteLostError}.
 */
export async function replaceConnectorConnection(
  db: Tx,
  args: ReplaceConnectorConnectionArgs,
  signal: AbortSignal,
): Promise<StoredConnectorConnectionRow> {
  return writtenRowOrThrow(
    await replaceConnectorConnectionOutcome(db, args, signal),
  );
}
