import { and, eq } from "drizzle-orm";
import { connectors } from "@okouai/db/schema/connector";

import type { Db } from "../external/db";
import type { Tx } from "../../lib/db-types";
import {
  deleteConnectorCredentialStorageConnection,
  type ConnectorCredentialStorageDeclaration,
} from "./connector-credential-storage-write.service";
import { prepareConnectorAccountDeletionWithTargetLocked } from "./connector-account-lifecycle.service";

export type PreparedCustomConnectorValue =
  | {
      readonly kind: "secret";
      readonly key: string;
      readonly encryptedValue: string;
    }
  | {
      readonly kind: "variable";
      readonly key: string;
      readonly value: string;
    };

interface CustomConnectorCredentialField {
  readonly kind: "secret" | "variable";
  readonly key: string;
}

interface CustomConnectorMemberConnection {
  readonly connectorId: string;
  readonly orgId: string;
  readonly userId: string;
}

export function customConnectorStorageDeclaration(
  fields: readonly CustomConnectorCredentialField[],
): ConnectorCredentialStorageDeclaration {
  return {
    secrets: fields.flatMap((field) => {
      return field.kind === "secret" ? [field.key] : [];
    }),
    variables: fields.flatMap((field) => {
      return field.kind === "variable" ? [field.key] : [];
    }),
  };
}

export async function deleteCustomConnectorMemberConnectionById(
  db: Db,
  args: CustomConnectorMemberConnection & {
    readonly memberConnectorId: string;
  },
  signal: AbortSignal,
): Promise<boolean> {
  const [connection] = await db
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        eq(connectors.customConnectorId, args.connectorId),
        eq(connectors.id, args.memberConnectorId),
        eq(connectors.userId, args.userId),
        eq(connectors.orgId, args.orgId),
      ),
    )
    .for("update")
    .limit(1);
  signal.throwIfAborted();
  if (!connection) {
    return false;
  }
  await deleteConnectorCredentialStorageConnection(
    db,
    { connectorId: connection.id },
    signal,
  );
  return true;
}

export async function deleteCustomConnectorMemberConnectionExact(
  db: Tx,
  args: CustomConnectorMemberConnection & {
    readonly memberConnectorId: string;
  },
  signal: AbortSignal,
): Promise<
  | { readonly kind: "missing" }
  | {
      readonly kind: "deleted";
      readonly resolvedSelectionCount: number;
      readonly promotedDefaultConnectionId: string | null;
    }
> {
  const deletion = await prepareConnectorAccountDeletionWithTargetLocked(
    db,
    {
      orgId: args.orgId,
      userId: args.userId,
      target: { kind: "custom", customConnectorId: args.connectorId },
      connectionId: args.memberConnectorId,
    },
    signal,
  );
  signal.throwIfAborted();
  if (deletion.kind !== "ready") {
    return deletion;
  }
  const lateSelectionCount = await deleteConnectorCredentialStorageConnection(
    db,
    { connectorId: args.memberConnectorId },
    signal,
  );
  return {
    kind: "deleted",
    resolvedSelectionCount:
      deletion.resolvedSelectionCount + lateSelectionCount,
    promotedDefaultConnectionId: deletion.promotedDefaultConnectionId,
  };
}
