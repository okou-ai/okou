import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { connectors } from "@okouai/db/schema/connector";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";

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

interface ManualGrantUserCredentialDeletion {
  readonly orgId: string;
  readonly userId: string;
  readonly name: string;
}

export function manualGrantUserSecretDeletion(
  args: ManualGrantUserCredentialDeletion,
) {
  return {
    from: secrets,
    where: and(
      eq(secrets.orgId, args.orgId),
      eq(secrets.userId, args.userId),
      eq(secrets.name, args.name),
      eq(secrets.type, "user"),
    ),
  };
}

export function manualGrantUserVariableDeletion(
  args: ManualGrantUserCredentialDeletion,
) {
  return {
    from: variables,
    where: and(
      eq(variables.orgId, args.orgId),
      eq(variables.userId, args.userId),
      eq(variables.type, "user"),
      eq(variables.name, args.name),
    ),
  };
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

export function connectorOwnedSecretWrite(
  args: ConnectorOwnedCredentialWrite &
    ConnectorOwnedCredentialDescription & {
      readonly encryptedValue: string;
    },
) {
  requireDeclaredStorageName({
    kind: "secret",
    storage: args.storage,
    name: args.name,
  });
  return {
    values: {
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      encryptedValue: args.encryptedValue,
      description: args.description,
      type: "connector",
    },
    conflict: {
      target: [secrets.connectorId, secrets.name],
      targetWhere: isNotNull(secrets.connectorId),
      set: {
        encryptedValue: args.encryptedValue,
        ...(args.updatedDescription === undefined
          ? {}
          : { description: args.updatedDescription }),
        updatedAt: nowDate(),
      },
    },
  };
}

export function connectorOwnedVariableWrite(
  args: ConnectorOwnedCredentialWrite &
    ConnectorOwnedCredentialDescription & {
      readonly value: string;
    },
) {
  requireDeclaredStorageName({
    kind: "variable",
    storage: args.storage,
    name: args.name,
  });
  return {
    values: {
      connectorId: args.connectorId,
      orgId: args.orgId,
      userId: args.userId,
      name: args.name,
      value: args.value,
      description: args.description,
      type: "connector",
    },
    conflict: {
      target: [variables.connectorId, variables.name],
      targetWhere: isNotNull(variables.connectorId),
      set: {
        value: args.value,
        ...(args.updatedDescription === undefined
          ? {}
          : { description: args.updatedDescription }),
        updatedAt: nowDate(),
      },
    },
  };
}

export function connectorCredentialStorageConnectionDeletionPlan(args: {
  readonly connectorId: string;
}) {
  return {
    secrets: {
      from: secrets,
      where: eq(secrets.connectorId, args.connectorId),
    },
    variables: {
      from: variables,
      where: eq(variables.connectorId, args.connectorId),
    },
    account: {
      from: connectors,
      where: eq(connectors.id, args.connectorId),
      returning: { id: connectors.id },
    },
    deferSelections: sql`SET CONSTRAINTS fk_chat_thread_connector_selections_connector_slug, fk_chat_thread_connector_selections_custom_connector DEFERRED`,
    enforceSelections: sql`SET CONSTRAINTS fk_chat_thread_connector_selections_connector_slug, fk_chat_thread_connector_selections_custom_connector IMMEDIATE`,
  };
}

export function connectorCredentialStorageSelectionDeletionPlan(
  deleted: readonly { readonly id: string }[],
) {
  return {
    from: chatThreadConnectorSelections,
    where: inArray(
      chatThreadConnectorSelections.connectorId,
      deleted.map((row) => {
        return row.id;
      }),
    ),
    returning: { connectorId: chatThreadConnectorSelections.connectorId },
  };
}

export function connectorCredentialStorageCursorDeletionPlan(
  deleted: readonly { readonly id: string }[],
) {
  return {
    from: googleFormsAutomationCursors,
    automationId: googleFormsAutomationCursors.automationId,
    automations: {
      columns: { id: workflowAutomations.id },
      from: workflowAutomations,
      where: and(
        eq(workflowAutomations.eventType, "google-forms-response-submitted"),
        sql`${workflowAutomations.eventConfig} ->> 'connectorId' = ANY(${sql.param(
          deleted.map((row) => {
            return row.id;
          }),
        )}::text[])`,
      ),
    },
  };
}
