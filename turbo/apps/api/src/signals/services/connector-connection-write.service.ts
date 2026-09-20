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
import { lockConnectorAccountTarget } from "./auth-state-lock.service";

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
            readonly oauthRequestedScopes: readonly string[];
            readonly oauthGrantedScopes: readonly string[];
          };
    }
  | {
      readonly kind: "custom";
      readonly customConnectorId: string;
      readonly oauthScopes: readonly string[] | null;
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

export type ReadyConnectorConnectionMutation =
  | {
      readonly kind: "insert";
      readonly displayName: string | null;
      readonly isDefault: boolean;
    }
  | {
      readonly kind: "update";
      readonly existing: ExistingConnectorConnectionRow;
    };

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
  await lockConnectorAccountTarget(db, args);

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
      .for("update")
      .limit(1);
    const resolution: ConnectorConnectionMutationResolution = existing
      ? { kind: "ready", mutation: { kind: "update", existing } }
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
      .for("update")
      .limit(2);
    const [existing, duplicate] = existingByExternalId;
    if (existing) {
      const resolution: ConnectorConnectionMutationResolution = duplicate
        ? { kind: "ambiguous" }
        : { kind: "ready", mutation: { kind: "update", existing } };
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
    .for("update")
    .limit(2);
  let resolution: ConnectorConnectionMutationResolution;
  if (existing.length > 0 && !args.allowSiblings) {
    resolution = { kind: "sibling-disabled" };
  } else {
    resolution = {
      kind: "ready",
      mutation: {
        kind: "insert",
        displayName: args.mutation.displayName ?? null,
        isDefault: existing.length === 0,
      },
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

export async function writeConnectorConnectionMetadata(
  db: Tx,
  args: ConnectorConnectionMetadataArgs & {
    readonly resolution: ReadyConnectorConnectionMutation;
  },
): Promise<StoredConnectorConnectionRow> {
  const identityValues =
    args.target.kind === "custom"
      ? {
          externalId: null,
          externalUsername: null,
          externalEmail: null,
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
            oauthScopes: JSON.stringify(
              args.target.identity.oauthRequestedScopes,
            ),
            oauthGrantedScopes: JSON.stringify(
              args.target.identity.oauthGrantedScopes,
            ),
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
  const [row] =
    args.resolution.kind === "insert"
      ? await db
          .insert(connectors)
          .values({
            ...(args.insertConnectionId ? { id: args.insertConnectionId } : {}),
            orgId: args.orgId,
            userId: args.userId,
            displayName: args.resolution.displayName,
            isDefault: args.resolution.isDefault,
            ...targetValues,
            ...replacementValues,
          })
          .returning(connectorConnectionSelection())
      : await db
          .update(connectors)
          .set({
            ...replacementValues,
            updatedAt: sql`clock_timestamp()`,
          })
          .where(eq(connectors.id, args.resolution.existing.id))
          .returning(connectorConnectionSelection());
  if (!row) {
    throw new Error(
      `Failed to write ${args.target.kind === "builtin" ? "Builtin" : "Custom"} connector connection`,
    );
  }
  return row;
}

export async function replaceConnectorConnection(
  db: Tx,
  args: ReplaceConnectorConnectionArgs,
  signal: AbortSignal,
): Promise<StoredConnectorConnectionRow> {
  const connection = await writeConnectorConnectionMetadata(db, args);
  signal.throwIfAborted();

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

  return connection;
}
