import { connectors } from "@okouai/db/schema/connector";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";
import { and, eq, getTableColumns, SQL, sql, type Column } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";

import {
  connectorCredentialDeletion,
  connectorCredentialDeletionKinds,
} from "./connector-account-mutation.service";
import {
  connectorConnectionMetadataWritePlan,
  connectorConnectionMetadataWriteResult,
  connectorConnectionSelection,
  type ConnectorConnectionWriteArgs,
} from "./connector-connection-write.service";
import {
  manualGrantCredentialArgs,
  manualGrantCredentialFields,
  manualGrantCredentialWrite,
  manualGrantUserSecretDeletion,
  manualGrantUserVariableDeletion,
} from "./connector-credential-storage-write.service";
import { contextJsonProjection } from "./context-rowset";

interface ManualGrantPublicationArgs {
  readonly metadata: ConnectorConnectionWriteArgs;
  readonly accountId: string;
  readonly accountRevision: string | null;
  readonly credentials: ReturnType<typeof manualGrantCredentialArgs>;
  readonly secretCleanup: {
    readonly orgId: string;
    readonly userId: string;
    readonly names: readonly string[];
  };
  readonly variableCleanup: ManualGrantPublicationArgs["secretCleanup"];
}

function publicationFields(
  table: typeof connectors | typeof secrets | typeof variables,
  values: Readonly<Record<string, unknown>>,
) {
  const columns: Readonly<Record<string, Column>> = getTableColumns(table);
  return Object.entries(values).flatMap(([key, value]) => {
    if (value === undefined) {
      return [];
    }
    const column = columns[key];
    if (!column) {
      throw new Error(
        "Manual connector publication contains an unknown column",
      );
    }
    return [
      {
        key,
        column,
        value: value instanceof SQL ? value : sql.param(value, column),
      },
    ];
  });
}

function conditionalInsert(
  table: typeof connectors | typeof secrets | typeof variables,
  values: Readonly<Record<string, unknown>>,
  condition: SQL,
  conflict: SQL,
  returning: SQL,
) {
  const fields = publicationFields(table, values);
  return sql`INSERT INTO ${table} (${sql.join(
    fields.map(({ column }) => {
      return sql.identifier(column.name);
    }),
    sql`, `,
  )})
    SELECT ${sql.join(
      fields.map(({ value }) => {
        return value;
      }),
      sql`, `,
    )} WHERE ${condition}
    ${conflict} RETURNING ${returning}`;
}

function manualCredentialClauses(args: ManualGrantPublicationArgs): SQL[] {
  const clauses: SQL[] = [];
  const dialect = new PgDialect();
  const admitted = sql`EXISTS (SELECT 1 FROM manual_connection)`;
  let previous: string | undefined;
  const after = () => {
    return previous
      ? sql`AND (SELECT count(*) FROM ${sql.identifier(previous)}) >= 0`
      : sql.empty();
  };
  for (const [index, kind] of connectorCredentialDeletionKinds.entries()) {
    const deletion = connectorCredentialDeletion(kind, { id: args.accountId });
    const name = "manual_removed_" + index;
    clauses.push(sql`${sql.identifier(name)} AS (DELETE FROM ${deletion.from}
      WHERE ${deletion.where} AND ${admitted} ${after()} RETURNING 1)`);
    previous = name;
  }
  for (const [index, entry] of [
    ...manualGrantCredentialFields(args.credentials),
  ].entries()) {
    const credential = manualGrantCredentialWrite(args.credentials, entry);
    const conflict = credential.conflict;
    const update = dialect.buildUpdateSet(
      credential.table,
      Object.fromEntries(
        publicationFields(credential.table, conflict.set).map(
          ({ key, value }) => {
            return [key, value];
          },
        ),
      ),
    );
    const onConflict = sql`ON CONFLICT (${sql.join(
      conflict.target.map((column) => {
        return sql.identifier(column.name);
      }),
      sql`, `,
    )})
      WHERE ${conflict.targetWhere} DO UPDATE SET ${update}`;
    const name = "manual_credential_" + index;
    clauses.push(
      sql`${sql.identifier(name)} AS (${conditionalInsert(
        credential.table,
        credential.values,
        sql`${admitted} ${after()}`,
        onConflict,
        sql`id`,
      )})`,
    );
    previous = name;
  }
  const cleanups = [
    ...args.secretCleanup.names.map((name) => {
      return manualGrantUserSecretDeletion({ ...args.secretCleanup, name });
    }),
    ...args.variableCleanup.names.map((name) => {
      return manualGrantUserVariableDeletion(args.variableCleanup, name);
    }),
  ];
  for (const [index, deletion] of cleanups.entries()) {
    const name = "manual_user_removed_" + index;
    clauses.push(sql`${sql.identifier(name)} AS (DELETE FROM ${deletion.from}
      WHERE ${deletion.where} AND ${admitted} ${after()} RETURNING 1)`);
    previous = name;
  }
  return clauses;
}

/** Publish the prepared manual account, credentials and legacy-key cleanup together. */
export function builtinManualGrantPublicationSql(
  args: ManualGrantPublicationArgs,
): SQL {
  if (
    args.metadata.target.kind !== "builtin" ||
    args.metadata.target.identity.kind !== "local"
  ) {
    throw new Error(
      "Manual connector publication requires a local builtin target",
    );
  }
  const dialect = new PgDialect();
  const write = connectorConnectionMetadataWritePlan(args.metadata);
  const projection = contextJsonProjection(connectorConnectionSelection());
  const returning = sql`${connectors.id}, ${projection} AS payload`;
  const clauses: SQL[] = [];
  if (write.kind === "update") {
    if (args.accountRevision === null || write.insert !== null) {
      throw new Error(
        "Manual reconnect requires its observed account revision",
      );
    }
    const update = dialect.buildUpdateQuery({
      table: connectors,
      set: Object.fromEntries(
        publicationFields(connectors, write.values).map(({ key, value }) => {
          return [key, value];
        }),
      ),
      joins: [],
      where: and(
        write.where,
        eq(connectors.id, args.accountId),
        sql`${connectors}.xmin::text = ${args.accountRevision}`,
      ),
      returning: [
        { path: ["id"], field: connectors.id },
        { path: ["payload"], field: projection.as("payload") },
      ],
    });
    clauses.push(sql`manual_connection AS (${update})`);
  } else {
    const sibling = connectorConnectionMetadataWriteResult(write, undefined);
    if (
      !write.conflict ||
      sibling.kind !== "write" ||
      sibling.write.kind !== "insert" ||
      sibling.write.phase !== "sibling" ||
      write.values.id !== args.accountId ||
      sibling.write.values.id !== args.accountId
    ) {
      throw new Error("Manual add requires one default-first account identity");
    }
    const conflict = sql`ON CONFLICT (${sql.join(
      write.conflict.target.map((column) => {
        return sql.identifier(column.name);
      }),
      sql`, `,
    )}) WHERE ${write.conflict.where} DO NOTHING`;
    clauses.push(
      sql`manual_default AS (${conditionalInsert(connectors, write.values, sql`true`, conflict, returning)})`,
      sql`manual_sibling AS (${conditionalInsert(connectors, sibling.write.values, sql`NOT EXISTS (SELECT 1 FROM manual_default)`, sql.empty(), returning)})`,
      sql`manual_connection AS (SELECT id,payload FROM manual_default UNION ALL SELECT id,payload FROM manual_sibling)`,
    );
  }
  clauses.push(...manualCredentialClauses(args));
  return sql`WITH ${sql.join(clauses, sql`,\n`)} SELECT (SELECT payload FROM manual_connection) AS connector`;
}
