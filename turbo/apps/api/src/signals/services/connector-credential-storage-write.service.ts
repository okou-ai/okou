import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { workflowAutomations } from "@okouai/db/schema/workflow";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, gte, inArray, isNotNull, sql, type SQL } from "drizzle-orm";

import { nowDate } from "../../lib/time";
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

/**
 * Delete visible selections before their accounts in one statement. The
 * cascading account FK also clears a reference committed after this statement's
 * snapshot; an insert after deletion fails its ordinary FK check. Returns the
 * number of selections explicitly resolved by this statement's snapshot.
 */
async function deleteConnectorCredentialStorageConnectionsWhere(
  db: Db,
  conditions: ConnectorCredentialStorageDeleteConditions,
  signal: AbortSignal,
): Promise<number> {
  await deleteConnectorOwnedCredentialRowsWhere(db, conditions, signal);
  const deletedSelections = db
    .$with("deleted_connector_selections")
    .as(
      db
        .delete(chatThreadConnectorSelections)
        .where(conditions.selection)
        .returning({ connectorId: chatThreadConnectorSelections.connectorId }),
    );
  const deletedConnections = db.$with("deleted_connector_accounts").as(
    db
      .delete(connectors)
      .where(
        and(
          conditions.connection,
          // Consume the child mutation before deleting its parent, so the
          // returned count describes this statement's resolved selections.
          gte(db.$count(deletedSelections), 0),
        ),
      )
      .returning({ id: connectors.id }),
  );
  const deleted = await db
    .with(deletedSelections, deletedConnections)
    .select({
      id: deletedConnections.id,
      selectionCount: db.$count(deletedSelections),
    })
    .from(deletedConnections);
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
  return deleted[0]?.selectionCount ?? 0;
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

/** Deletes one account with its selections and credential rows. */
export async function deleteConnectorCredentialStorageConnection(
  db: Db,
  args: {
    readonly connectorId: string;
  },
  signal: AbortSignal,
): Promise<number> {
  return await deleteConnectorCredentialStorageConnectionsWhere(
    db,
    {
      selection: eq(
        chatThreadConnectorSelections.connectorId,
        args.connectorId,
      ),
      secret: eq(secrets.connectorId, args.connectorId),
      variable: eq(variables.connectorId, args.connectorId),
      connection: eq(connectors.id, args.connectorId),
    },
    signal,
  );
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
