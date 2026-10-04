import type { ConnectorCredentialStorageReadiness } from "@okouai/api-contracts/contracts/connector-catalog-diagnostics";
import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { command } from "ccstate";
import { and, count, eq, isNull, sql } from "drizzle-orm";
import { unionAll } from "drizzle-orm/pg-core";
import { z } from "zod";

import { zodEnumDriverValueDecoder } from "../../lib/db-structured-result";
import { db$ } from "../external/db";

const readinessCountKindSchema = z.enum([
  "missing-connector-versions",
  "unowned-connector-secrets",
  "unowned-connector-variables",
]);
type ReadinessCountKind = z.output<typeof readinessCountKindSchema>;
const readinessCountKindDecoder = zodEnumDriverValueDecoder(
  readinessCountKindSchema,
);

function readinessCountKind(kind: ReadinessCountKind) {
  return sql`${kind}::text`.mapWith(readinessCountKindDecoder).as("kind");
}

export const loadConnectorCredentialReadiness$ = command(
  async ({ get }): Promise<ConnectorCredentialStorageReadiness> => {
    const db = get(db$);
    // One UNION statement gives every count the same PostgreSQL statement
    // snapshot. The hard constraints make every unowned connector credential an
    // unresolved invariant violation, independent of catalog source selection.
    const rows = await unionAll(
      db
        .select({
          kind: readinessCountKind("missing-connector-versions"),
          value: count(),
        })
        .from(connectors)
        .where(isNull(connectors.storageVersion)),
      db
        .select({
          kind: readinessCountKind("unowned-connector-secrets"),
          value: count(),
        })
        .from(secrets)
        .where(and(eq(secrets.type, "connector"), isNull(secrets.connectorId))),
      db
        .select({
          kind: readinessCountKind("unowned-connector-variables"),
          value: count(),
        })
        .from(variables)
        .where(
          and(eq(variables.type, "connector"), isNull(variables.connectorId)),
        ),
    );
    const counts = new Map(
      rows.map((row) => {
        return [row.kind, row.value] as const;
      }),
    );
    const missingConnectorVersions =
      counts.get("missing-connector-versions") ?? 0;
    const unownedConnectorSecrets =
      counts.get("unowned-connector-secrets") ?? 0;
    const unownedConnectorVariables =
      counts.get("unowned-connector-variables") ?? 0;
    return {
      missingConnectorVersions,
      unownedConnectorSecrets,
      unownedConnectorVariables,
      unresolvedBridgeCredentials:
        unownedConnectorSecrets + unownedConnectorVariables,
    };
  },
);
