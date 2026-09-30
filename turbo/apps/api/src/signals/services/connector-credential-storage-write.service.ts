import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { isForeignKeyViolation, safeSqlStateCode } from "../../lib/pg-errors";
import { settle } from "../utils";
import type { Db } from "../external/db";

export interface ConnectorCredentialStorageDeclaration {
  readonly secrets: readonly string[];
  readonly variables: readonly string[];
}

interface ConnectorOwnedCredentialWrite {
  readonly connectorId: string;
  readonly storage: ConnectorCredentialStorageDeclaration;
  readonly name: string;
  readonly orgId: string;
  readonly userId: string;
}

interface ConnectorOwnedCredentialDescription {
  readonly description: string | null;
  readonly updatedDescription?: string | null;
}

export type ConnectorOwnerScope =
  | {
      readonly kind: "user";
      readonly userId: string;
    }
  | {
      readonly kind: "organization";
      readonly orgId: string;
    };

interface ConnectorOwnedCredentialDeleteConditions {
  readonly secret: SQL;
  readonly variable: SQL;
}

interface ConnectorCredentialStorageDeleteConditions extends ConnectorOwnedCredentialDeleteConditions {
  readonly selection: SQL;
  readonly connection: SQL;
}

function requireDeclaredStorageName(args: {
  readonly kind: "secret" | "variable";
  readonly storage: ConnectorCredentialStorageDeclaration;
  readonly name: string;
}): void {
  const names =
    args.kind === "secret" ? args.storage.secrets : args.storage.variables;
  if (!names.includes(args.name)) {
    throw new Error(
      `Connector auth method does not declare ${args.kind} ${args.name}`,
    );
  }
}

export async function upsertConnectorOwnedSecret(
  db: Db,
  args: ConnectorOwnedCredentialWrite &
    ConnectorOwnedCredentialDescription & {
      readonly encryptedValue: string;
    },
): Promise<void> {
  requireDeclaredStorageName({
    kind: "secret",
    storage: args.storage,
    name: args.name,
  });
  const [row] = await db
    .insert(secrets)
    .values({
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      encryptedValue: args.encryptedValue,
      description: args.description,
      type: "connector",
    })
    .onConflictDoUpdate({
      target: [secrets.connectorId, secrets.name],
      targetWhere: isNotNull(secrets.connectorId),
      set: {
        encryptedValue: args.encryptedValue,
        ...(args.updatedDescription === undefined
          ? {}
          : { description: args.updatedDescription }),
        updatedAt: nowDate(),
      },
    })
    .returning({ id: secrets.id });
  if (!row) {
    throw new Error(`Connector secret ${args.name} is owned by another row`);
  }
}

export async function upsertConnectorOwnedVariable(
  db: Db,
  args: ConnectorOwnedCredentialWrite &
    ConnectorOwnedCredentialDescription & {
      readonly value: string;
    },
): Promise<void> {
  requireDeclaredStorageName({
    kind: "variable",
    storage: args.storage,
    name: args.name,
  });
  const [row] = await db
    .insert(variables)
    .values({
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      value: args.value,
      description: args.description,
      type: "connector",
    })
    .onConflictDoUpdate({
      target: [variables.connectorId, variables.name],
      targetWhere: isNotNull(variables.connectorId),
      set: {
        value: args.value,
        ...(args.updatedDescription === undefined
          ? {}
          : { description: args.updatedDescription }),
        updatedAt: nowDate(),
      },
    })
    .returning({ id: variables.id });
  if (!row) {
    throw new Error(`Connector variable ${args.name} is owned by another row`);
  }
}

async function deleteConnectorOwnedCredentialRowsWhere(
  db: Db,
  conditions: ConnectorOwnedCredentialDeleteConditions,
  signal: AbortSignal,
): Promise<void> {
  await db.delete(secrets).where(conditions.secret);
  signal.throwIfAborted();
  await db.delete(variables).where(conditions.variable);
  signal.throwIfAborted();
}

async function deleteConnectorCredentialStorageConnectionsWhere(
  db: Db,
  conditions: ConnectorCredentialStorageDeleteConditions,
  signal: AbortSignal,
): Promise<void> {
  await db.delete(chatThreadConnectorSelections).where(conditions.selection);
  signal.throwIfAborted();
  await deleteConnectorOwnedCredentialRowsWhere(db, conditions, signal);
  const deleted = await db
    .delete(connectors)
    .where(conditions.connection)
    .returning({ id: connectors.id });
  if (deleted.length > 0) {
    // FK deletion has already cleared event_connector_id. Use the retained
    // source config to invalidate only cursors belonging to deleted accounts.
    // A subsequent projection onto a new account is a different source.
    await db.delete(googleFormsAutomationCursors).where(
      inArray(
        googleFormsAutomationCursors.automationId,
        db
          .select({ id: workflowAutomations.id })
          .from(workflowAutomations)
          .where(
            and(
              eq(
                workflowAutomations.eventType,
                "google-forms-response-submitted",
              ),
              sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ANY(${sql.param(
                deleted.map((row) => {
                  return row.id;
                }),
              )}::text[])`,
            ),
          ),
      ),
    );
  }
  signal.throwIfAborted();
}

export async function deleteConnectorOwnedCredentialRows(
  db: Db,
  args: {
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<void> {
  await deleteConnectorOwnedCredentialRowsWhere(
    db,
    {
      secret: eq(secrets.connectorId, args.connectorId),
      variable: eq(variables.connectorId, args.connectorId),
    },
    signal,
  );
}

/** RESTRICT (23001) or NO ACTION (23503) rejection from a late selection row. */
function isSelectionReferenceViolation(error: unknown): boolean {
  return isForeignKeyViolation(error) || safeSqlStateCode(error) === "23001";
}

export async function deleteConnectorCredentialStorageConnection(
  db: Db,
  args: {
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<number> {
  const conditions = {
    selection: eq(chatThreadConnectorSelections.connectorId, args.connectorId),
    secret: eq(secrets.connectorId, args.connectorId),
    variable: eq(variables.connectorId, args.connectorId),
    connection: eq(connectors.id, args.connectorId),
  };
  // A chat-thread selection can commit between this cleanup's selection
  // delete and the account delete (no explicit lock excludes it), which the
  // RESTRICT foreign key rejects. Each savepoint attempt removes selections
  // committed so far; the account delete then succeeds deterministically.
  // Returns the selections this cleanup itself resolved.
  for (let attempt = 1; ; attempt += 1) {
    const deleted = await settle(
      db.transaction(async (savepoint) => {
        const selections = await savepoint
          .delete(chatThreadConnectorSelections)
          .where(conditions.selection);
        await deleteConnectorCredentialStorageConnectionsWhere(
          savepoint,
          conditions,
          signal,
        );
        return selections.rowCount ?? 0;
      }),
      signal,
    );
    if (deleted.ok) {
      return deleted.value;
    }
    if (attempt >= 3 || !isSelectionReferenceViolation(deleted.error)) {
      throw deleted.error;
    }
  }
}

export async function deleteConnectorCredentialStorageConnectionsForOwner(
  db: Db,
  owner: ConnectorOwnerScope,
  signal: AbortSignal,
): Promise<void> {
  const connectorOwnerCondition =
    owner.kind === "user"
      ? eq(connectors.userId, owner.userId)
      : eq(connectors.orgId, owner.orgId);
  const conditions: ConnectorCredentialStorageDeleteConditions =
    owner.kind === "user"
      ? {
          selection: inArray(
            chatThreadConnectorSelections.connectorId,
            db
              .select({ connectorId: connectors.id })
              .from(connectors)
              .where(connectorOwnerCondition),
          ),
          secret: sql`${eq(secrets.userId, owner.userId)} AND ${isNotNull(secrets.connectorId)}`,
          variable: sql`${eq(variables.userId, owner.userId)} AND ${isNotNull(variables.connectorId)}`,
          connection: connectorOwnerCondition,
        }
      : {
          selection: inArray(
            chatThreadConnectorSelections.connectorId,
            db
              .select({ connectorId: connectors.id })
              .from(connectors)
              .where(connectorOwnerCondition),
          ),
          secret: sql`${eq(secrets.orgId, owner.orgId)} AND ${isNotNull(secrets.connectorId)}`,
          variable: sql`${eq(variables.orgId, owner.orgId)} AND ${isNotNull(variables.connectorId)}`,
          connection: connectorOwnerCondition,
        };
  await deleteConnectorCredentialStorageConnectionsWhere(
    db,
    conditions,
    signal,
  );
}

export async function deleteConnectorSelectionsForCustomConnectorDefinition(
  db: Db,
  args: { readonly customConnectorId: string },
  signal: AbortSignal,
): Promise<void> {
  await db
    .delete(chatThreadConnectorSelections)
    .where(
      eq(
        chatThreadConnectorSelections.customConnectorId,
        args.customConnectorId,
      ),
    );
  signal.throwIfAborted();
}
