import { chatThreadConnectorSelections } from "@okouai/db/schema/chat-thread-connector-selection";
import { googleFormsAutomationCursors } from "@okouai/db/schema/google-forms-event";
import { workflowAutomations } from "@okouai/db/runtime/workflow-automation";
import { boolean, literal, object, uuid } from "zod";
import { pgInt8ToSafeIntegerSchema } from "../../lib/db-raw-rows";
import { connectors } from "@okouai/db/schema/connector";
import { orgCustomConnectors } from "@okouai/db/schema/org-custom-connector";
import { builtinConnectorAccountOauthBindings } from "@okouai/db/schema/connector-account-oauth-binding";
import {
  and,
  asc,
  eq,
  exists,
  getTableColumns,
  inArray,
  ne,
  SQL,
  sql,
  type Column,
} from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import {
  connectorConnectionMetadataWritePlan,
  connectorConnectionMetadataWriteResult,
  type ConnectorConnectionWriteArgs,
} from "./connector-connection-write.service";
import { secrets } from "@okouai/db/schema/secret";
import { variables } from "@okouai/db/schema/variable";

import {
  connectorOwnedSecretWrite,
  connectorOwnedVariableWrite,
  type ConnectorCredentialStorageDeclaration,
} from "./connector-credential-storage-write.service";

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

export type CustomConnectorMemberConnectionDeletionResult =
  | { readonly kind: "missing" }
  | {
      readonly kind: "deleted";
      readonly resolvedSelectionCount: number;
      readonly promotedDefaultConnectionId: string | null;
    };

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

export function customConnectorCredentialValues(
  owner: { readonly orgId: string; readonly userId: string },
  fields: readonly CustomConnectorCredentialField[],
  values: readonly PreparedCustomConnectorValue[],
) {
  return { orgId: owner.orgId, userId: owner.userId, fields, values };
}

export function* customConnectorCredentialWrites(
  values: ReturnType<typeof customConnectorCredentialValues>,
  connectionId: string,
) {
  const preparedWrite = { connectionId, ...values };
  const storage = customConnectorStorageDeclaration(preparedWrite.fields);
  for (const value of preparedWrite.values) {
    yield {
      field: value,
      ...customConnectorValueCredentialWrite(preparedWrite, storage, value),
    };
  }
}

function customConnectorValueCredentialScope(
  preparedWrite: {
    readonly connectionId: string;
    readonly orgId: string;
    readonly userId: string;
  },
  storage: ReturnType<typeof customConnectorStorageDeclaration>,
) {
  return {
    connectorId: preparedWrite.connectionId,
    storage,
    orgId: preparedWrite.orgId,
    userId: preparedWrite.userId,
  };
}

function customConnectorValueCredentialWrite(
  preparedWrite: Parameters<typeof customConnectorValueCredentialScope>[0],
  storage: ReturnType<typeof customConnectorStorageDeclaration>,
  value: PreparedCustomConnectorValue,
) {
  const credential = {
    ...customConnectorValueCredentialScope(preparedWrite, storage),
    name: value.key,
    description: null,
    updatedDescription: null,
  };
  return value.kind === "secret"
    ? {
        table: secrets,
        ...connectorOwnedSecretWrite({
          ...credential,
          encryptedValue: value.encryptedValue,
        }),
      }
    : {
        table: variables,
        ...connectorOwnedVariableWrite({ ...credential, value: value.value }),
      };
}

function customValuePublicationFields(
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
        "Custom connector publication contains an unknown column",
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

function customValueConditionalInsert(
  table: typeof connectors | typeof secrets | typeof variables,
  values: Readonly<Record<string, unknown>>,
  condition: SQL,
  conflict: SQL,
): SQL {
  const fields = customValuePublicationFields(table, values);
  return sql`INSERT INTO ${table} (${sql.join(
    fields.map(({ column }) => {
      return sql.identifier(column.name);
    }),
    sql`, `,
  )}) SELECT ${sql.join(
    fields.map(({ value }) => {
      return value;
    }),
    sql`, `,
  )} WHERE ${condition} ${conflict} RETURNING id`;
}

/** Publish one prepared account and its canonical credentials as one SQL unit. */
interface CustomConnectorValuePublicationArgs {
  readonly metadata: ConnectorConnectionWriteArgs;
  readonly accountId: string;
  readonly definitionRevision: string;
  readonly accountRevision: string | null;
  readonly preservesStoredValues: boolean;
  readonly credentials: ReturnType<typeof customConnectorCredentialValues>;
}

function customValueCredentialClauses(
  args: CustomConnectorValuePublicationArgs,
): SQL[] {
  const clauses: SQL[] = [];
  const dialect = new PgDialect();
  let previous: string | undefined;
  if (!args.preservesStoredValues) {
    const deletions = [
      { table: secrets, parent: secrets.connectorId },
      { table: variables, parent: variables.connectorId },
      {
        table: builtinConnectorAccountOauthBindings,
        parent: builtinConnectorAccountOauthBindings.connectorAccountId,
      },
    ];
    for (const [index, deletion] of deletions.entries()) {
      const name = "value_removed_" + index;
      const after = previous
        ? sql`AND (SELECT count(*) FROM ${sql.identifier(previous)}) >= 0`
        : sql.empty();
      clauses.push(sql`${sql.identifier(name)} AS (DELETE FROM ${deletion.table}
        WHERE ${deletion.parent} IN (SELECT id FROM value_connection) ${after} RETURNING 1)`);
      previous = name;
    }
  }
  for (const [index, credential] of [
    ...customConnectorCredentialWrites(args.credentials, args.accountId),
  ].entries()) {
    const name = "value_credential_" + index;
    const after = previous
      ? sql`AND (SELECT count(*) FROM ${sql.identifier(previous)}) >= 0`
      : sql.empty();
    const conflict = credential.conflict;
    const update = dialect.buildUpdateSet(
      credential.table,
      Object.fromEntries(
        customValuePublicationFields(credential.table, conflict.set).map(
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
    )}) WHERE ${conflict.targetWhere} DO UPDATE SET ${update}`;
    clauses.push(
      sql`${sql.identifier(name)} AS (${customValueConditionalInsert(
        credential.table,
        credential.values,
        sql`EXISTS (SELECT 1 FROM value_connection) ${after}`,
        onConflict,
      )})`,
    );
    previous = name;
  }
  return clauses;
}

export function customConnectorValuesPublicationSql(
  args: CustomConnectorValuePublicationArgs,
): SQL {
  const { metadata } = args;
  if (
    metadata.target.kind !== "custom" ||
    (metadata.authMethod !== "manual" && metadata.authMethod !== "none")
  ) {
    throw new Error(
      "Custom value publication requires a manual or no-auth target",
    );
  }
  const query = new QueryBuilder();
  const dialect = new PgDialect();
  const definition = query
    .select({ id: orgCustomConnectors.id })
    .from(orgCustomConnectors)
    .where(
      and(
        eq(orgCustomConnectors.id, metadata.target.customConnectorId),
        eq(orgCustomConnectors.orgId, metadata.orgId),
        eq(orgCustomConnectors.storageVersion, metadata.storageVersion),
        eq(orgCustomConnectors.authMode, metadata.authMethod),
        sql`${orgCustomConnectors}.xmin::text = ${args.definitionRevision}`,
      ),
    )
    .for("update")
    .limit(1)
    .getSQL();
  const admitted = sql`EXISTS (SELECT 1 FROM value_definition)`;
  const clauses: SQL[] = [];
  const write = connectorConnectionMetadataWritePlan(metadata);
  if (write.kind === "update") {
    if (args.accountRevision === null) {
      throw new Error("Custom value reconnect has no observed account version");
    }
    const update = dialect.buildUpdateQuery({
      table: connectors,
      set: Object.fromEntries(
        customValuePublicationFields(connectors, write.values).map(
          ({ key, value }) => {
            return [key, value];
          },
        ),
      ),
      joins: [],
      where: and(
        write.where,
        admitted,
        eq(connectors.id, args.accountId),
        sql`${connectors}.xmin::text = ${args.accountRevision}`,
      ),
      returning: [{ path: ["id"], field: connectors.id }],
    });
    clauses.push(sql`value_connection AS (${update})`);
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
      throw new Error(
        "Custom value add requires one prepared default-first account identity",
      );
    }
    const conflict = sql`ON CONFLICT (${sql.join(
      write.conflict.target.map((column) => {
        return sql.identifier(column.name);
      }),
      sql`, `,
    )}) WHERE ${write.conflict.where} DO NOTHING`;
    clauses.push(
      sql`value_default AS (${customValueConditionalInsert(connectors, write.values, admitted, conflict)})`,
      sql`value_sibling AS (${customValueConditionalInsert(
        connectors,
        sibling.write.values,
        sql`${admitted} AND NOT EXISTS (SELECT 1 FROM value_default)`,
        sql.empty(),
      )})`,
      sql`value_connection AS (SELECT id FROM value_default UNION ALL SELECT id FROM value_sibling)`,
    );
  }
  clauses.push(...customValueCredentialClauses(args));
  return sql`WITH value_definition AS (${definition}), ${sql.join(clauses, sql`,\n`)}
    SELECT ${admitted} AS definition_current,
      (SELECT id FROM value_connection) AS connection_id`;
}

interface AccountDeletionInput {
  readonly orgId: string;
  readonly userId: string;
  readonly connectorId: string;
  readonly memberConnectorId: string;
}

export const customConnectorAccountDeletionRow = object({
  definition_current: boolean(),
  deleted_count: pgInt8ToSafeIntegerSchema,
  resolved_selection_count: pgInt8ToSafeIntegerSchema,
  promoted_default_connection_id: uuid().nullable(),
  promotion_guard: literal(1),
  cleanup_complete: pgInt8ToSafeIntegerSchema,
});

function accountOwner(args: AccountDeletionInput) {
  return and(
    eq(connectors.orgId, args.orgId),
    eq(connectors.userId, args.userId),
    eq(connectors.customConnectorId, args.connectorId),
  );
}

function accountDeletionStatements(
  args: AccountDeletionInput,
  definitionRevision: string,
) {
  const query = new QueryBuilder();
  const dialect = new PgDialect();
  const definition = query
    .select({ id: orgCustomConnectors.id })
    .from(orgCustomConnectors)
    .where(
      and(
        eq(orgCustomConnectors.id, args.connectorId),
        eq(orgCustomConnectors.orgId, args.orgId),
        sql`${orgCustomConnectors}.xmin::text = ${definitionRevision}`,
      ),
    )
    .for("update")
    .limit(1);
  const removed = dialect.buildDeleteQuery({
    table: connectors,
    where: and(
      accountOwner(args),
      eq(connectors.id, args.memberConnectorId),
      exists(sql`(SELECT 1 FROM deletion_definition)`),
    ),
  });
  const sibling = query
    .select({ id: connectors.id })
    .from(connectors)
    .where(
      and(
        accountOwner(args),
        ne(connectors.id, args.memberConnectorId),
        exists(sql`(SELECT 1 FROM deleted_account WHERE is_default)`),
      ),
    )
    .orderBy(asc(connectors.createdAt), asc(connectors.id))
    .limit(1);
  const promoted = dialect.buildUpdateQuery({
    table: connectors,
    set: { isDefault: sql`true`, updatedAt: sql`clock_timestamp()` },
    joins: [],
    where: and(
      accountOwner(args),
      eq(connectors.id, sql`(SELECT id FROM deletion_sibling)`),
    ),
  });
  return { definition, removed, sibling, promoted };
}

/** One mutation unit; credentials are owned by the existing account cascades. */
export function customConnectorAccountDeletionSql(
  args: AccountDeletionInput,
  definitionRevision: string,
) {
  const { definition, removed, sibling, promoted } = accountDeletionStatements(
    args,
    definitionRevision,
  );
  const dialect = new PgDialect();
  const selections = dialect.buildDeleteQuery({
    table: chatThreadConnectorSelections,
    where: inArray(
      chatThreadConnectorSelections.connectorId,
      sql`(SELECT id FROM deleted_account)`,
    ),
  });
  const query = new QueryBuilder();
  const cursors = dialect.buildDeleteQuery({
    table: googleFormsAutomationCursors,
    where: and(
      inArray(
        googleFormsAutomationCursors.automationId,
        query
          .select({ id: workflowAutomations.id })
          .from(workflowAutomations)
          .where(
            and(
              eq(
                workflowAutomations.eventType,
                "google-forms-response-submitted",
              ),
              sql`${workflowAutomations.eventConfig} ->> 'connectorId' IN (SELECT id::text FROM deleted_account)`,
            ),
          ),
      ),
      sql`(SELECT count(*) FROM deleted_selections) >= 0`,
    ),
  });
  // A concurrently created, snapshot-invisible non-default account is not
  // silently selected. A visible promotion target that disappears aborts all
  // writes instead of committing a known incomplete default transition.
  return sql`WITH deletion_definition AS MATERIALIZED (${definition}),
    deleted_account AS (${removed} RETURNING id, is_default),
    deletion_sibling AS MATERIALIZED (${sibling}),
    promoted_default AS (${promoted} RETURNING id),
    deleted_selections AS (${selections} RETURNING connector_id),
    deleted_cursors AS (${cursors} RETURNING automation_id)
    SELECT EXISTS(SELECT 1 FROM deletion_definition) AS definition_current,
      (SELECT count(*) FROM deleted_account) AS deleted_count,
      (SELECT count(*) FROM deleted_selections) AS resolved_selection_count,
      (SELECT id FROM promoted_default) AS promoted_default_connection_id,
      1 / CASE WHEN EXISTS(SELECT 1 FROM deletion_sibling)
        AND NOT EXISTS(SELECT 1 FROM promoted_default) THEN 0 ELSE 1 END AS promotion_guard,
      (SELECT count(*) FROM deleted_cursors) AS cleanup_complete`;
}
