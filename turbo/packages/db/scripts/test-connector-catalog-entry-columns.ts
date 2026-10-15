import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, Query, escapeIdentifier, escapeLiteral } from "pg";
import { z } from "zod";
import { drizzle } from "drizzle-orm/node-postgres";
import { jsonb, pgTable, primaryKey } from "drizzle-orm/pg-core";
import {
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  compactConnectorCatalogDefaultPolicy,
  connectorCatalogEntryColumns,
  connectorCatalogPermissionSummary,
} from "@okouai/connectors/connector-catalog/entry-columns";
import { connectorCatalogColumns } from "../src/columns/connector-catalog";
import {
  connectorCatalog,
  connectorCatalogEntries as runtimeEntries,
} from "../src/runtime/connector-catalog";
import {
  physicalCatalogRows,
  physicalCatalogSql,
  catalogFrontierSql,
  catalogRowsSchema,
} from "./test-connector-catalog-frontier";
import { validateConnectorCatalogColumnContract } from "./test-connector-catalog-columns-permanent";

// Frozen outgoing table shape, only for expand/preparation migration replay.
// Production schema and runtime both use the final payload-free table.
const connectorCatalogEntries = pgTable(
  "connector_catalog_entries",
  {
    ...connectorCatalogColumns(),
    payload: jsonb("payload").$type<ConnectorCatalogArtifactConnector>(),
  },
  (table) => {
    return [primaryKey({ columns: [table.hash, table.slug] })];
  },
);

function throwCollectedErrors(errors: readonly unknown[], message: string) {
  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, message);
  }
}

async function validateRejectedPreparation(args: {
  readonly databaseUrl: string;
  readonly expansion: string;
  readonly preparation: string;
  readonly entries: (typeof connectorCatalogEntries.$inferSelect)[];
  readonly pointers: (typeof connectorCatalog.$inferSelect)[];
  readonly sourceSchema: string;
  readonly frontier: z.infer<typeof physicalCatalogRows>[0]["catalog"];
}) {
  const client = new Client({ connectionString: args.databaseUrl });
  const schema = `catalog_preparation_${randomUUID().replaceAll("-", "")}`;
  const errors: unknown[] = [];
  const observeError = (error: Error) => {
    errors.push(error);
  };
  client.on("error", observeError);
  const settings: {
    name: "search_path" | "lock_timeout" | "statement_timeout";
    value: string;
  }[] = [];
  let connected = false;
  let ownsSchema = false;
  try {
    await client.connect();
    connected = true;
    const db = drizzle(client);
    for (const name of [
      "search_path",
      "lock_timeout",
      "statement_timeout",
    ] as const) {
      const shown = z
        .tuple([z.record(z.string(), z.string())])
        .parse((await client.query(`SHOW ${name}`)).rows);
      assert.deepEqual(Object.keys(shown[0]), [name]);
      const value = shown[0][name];
      assert.equal(typeof value, "string");
      assert.ok(value !== undefined);
      settings.push({ name, value });
    }
    assert.deepEqual(
      (
        await client.query(
          "SELECT nspname FROM pg_namespace WHERE nspname = $1",
          [schema],
        )
      ).rows,
      [],
    );
    const created = await client.query(`CREATE SCHEMA "${schema}"`);
    // A collision or an uncertain response grants no right to adopt this name.
    assert.equal(created.command, "CREATE");
    ownsSchema = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("SET lock_timeout = '1s'");
    await client.query("SET statement_timeout = '10s'");
    assert.deepEqual((await client.query("SHOW search_path")).rows, [
      { search_path: schema },
    ]);
    assert.deepEqual((await client.query("SHOW lock_timeout")).rows, [
      { lock_timeout: "1s" },
    ]);
    assert.deepEqual((await client.query("SHOW statement_timeout")).rows, [
      { statement_timeout: "10s" },
    ]);
    await client.query(`CREATE TABLE connector_catalog_entries (
      hash text NOT NULL, slug text NOT NULL, payload jsonb NOT NULL,
      PRIMARY KEY (hash, slug)
    )`);
    await client.query(`CREATE TABLE connector_catalog (
      schema_version integer PRIMARY KEY, hash text NOT NULL
    )`);
    await client.query(args.expansion);
    await db.insert(connectorCatalog).values(args.pointers);
    await db.insert(connectorCatalogEntries).values(args.entries);
    assert.equal(args.entries.length, 39);
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalogEntries)
        .orderBy(connectorCatalogEntries.hash, connectorCatalogEntries.slug),
      args.entries,
    );
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalog)
        .orderBy(connectorCatalog.schemaVersion),
      args.pointers,
    );
    const copiedCatalog = physicalCatalogRows.parse(
      (await client.query(physicalCatalogSql, [schema])).rows,
    )[0].catalog;
    // OIDs and the private namespace are the only different physical identities.
    assert.deepEqual(
      copiedCatalog.columns.map(({ oid: _oid, ...column }) => {
        return column;
      }),
      args.frontier.columns.map(({ oid: _oid, ...column }) => {
        return column;
      }),
    );
    assert.deepEqual(
      copiedCatalog.constraints.map(({ oid: _oid, ...constraint }) => {
        return constraint;
      }),
      args.frontier.constraints.map(({ oid: _oid, ...constraint }) => {
        return constraint;
      }),
    );
    assert.deepEqual(
      copiedCatalog.indexes,
      args.frontier.indexes.map((index) => {
        return {
          ...index,
          definition: index.definition.replace(
            ` ${args.sourceSchema}.`,
            ` ${schema}.`,
          ),
        };
      }),
    );
    assert.deepEqual(copiedCatalog.tables, args.frontier.tables);
    assert.deepEqual(copiedCatalog.triggers, args.frontier.triggers);
    assert.deepEqual(copiedCatalog.routines, args.frontier.routines);
    await client.query(
      "UPDATE connector_catalog_entries SET label = NULL WHERE hash = 'historical'",
    );
    // pg retains SQL NULL and whole JSONB/array values, including the bad labels.
    const beforeRows = await client.query(
      "SELECT * FROM connector_catalog_entries ORDER BY hash, slug",
    );
    assert.equal(beforeRows.rows.length, args.entries.length);
    const beforePointers = await db
      .select()
      .from(connectorCatalog)
      .orderBy(connectorCatalog.schemaVersion);
    const beforeCatalog = physicalCatalogRows.parse(
      (await client.query(physicalCatalogSql, [schema])).rows,
    );
    // One original simple-query message owns the implicit DDL rollback.
    await assert.rejects(client.query(args.preparation), (error: unknown) => {
      return (
        error instanceof Error && "code" in error && error.code === "23502"
      );
    });
    const payloadConstraint = await client.query(
      `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'connector_catalog_entries'
       AND column_name = 'payload'`,
      [schema],
    );
    assert.deepEqual(payloadConstraint.rows, [{ is_nullable: "NO" }]);
    assert.deepEqual(
      (
        await client.query(
          "SELECT * FROM connector_catalog_entries ORDER BY hash, slug",
        )
      ).rows,
      beforeRows.rows,
    );
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalog)
        .orderBy(connectorCatalog.schemaVersion),
      beforePointers,
    );
    assert.deepEqual(
      physicalCatalogRows.parse(
        (await client.query(physicalCatalogSql, [schema])).rows,
      ),
      beforeCatalog,
    );
    await client.query(
      `UPDATE connector_catalog_entries SET label = payload ->> 'label'
     WHERE hash = 'historical'`,
    );
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalogEntries)
        .orderBy(connectorCatalogEntries.hash, connectorCatalogEntries.slug),
      args.entries,
    );
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalog)
        .orderBy(connectorCatalog.schemaVersion),
      args.pointers,
    );
    assert.deepEqual(
      physicalCatalogRows.parse(
        (await client.query(physicalCatalogSql, [schema])).rows,
      )[0].catalog,
      copiedCatalog,
    );
  } catch (error: unknown) {
    errors.push(error);
  } finally {
    if (ownsSchema) {
      try {
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (connected) {
      // Observe even unowned residue; never DROP a collision or a lost ACK.
      try {
        assert.deepEqual(
          (
            await client.query(
              "SELECT nspname FROM pg_namespace WHERE nspname = $1",
              [schema],
            )
          ).rows,
          [],
        );
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    for (const { name, value } of settings) {
      try {
        await client.query("SELECT set_config($1, $2, false)", [name, value]);
      } catch (error: unknown) {
        errors.push(error);
      }
      try {
        assert.deepEqual((await client.query(`SHOW ${name}`)).rows, [
          { [name]: value },
        ]);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    try {
      await client.end();
    } catch (error: unknown) {
      errors.push(error);
    }
    client.removeListener("error", observeError);
  }
  // A killed process can leave committed residue for exclusive job DB disposal.
  throwCollectedErrors(
    errors,
    "Rejected catalog preparation or disposal failed",
  );
}

const namespaceRowsSchema = z.array(z.strictObject({ nspname: z.string() }));
const fixtureSettings = [
  "search_path",
  "lock_timeout",
  "statement_timeout",
] as const;
function shownSetting(rows: unknown, setting: string): string {
  const shown = z.array(z.record(z.string(), z.string())).length(1).parse(rows);
  const row = shown[0];
  assert.ok(row);
  assert.deepEqual(Object.keys(row), [setting]);
  const value = row[setting];
  assert.equal(typeof value, "string");
  assert.ok(value !== undefined);
  return value;
}

const preparedRowSchema = z.strictObject({
  hash: z.string(),
  slug: z.string(),
  label: z.string(),
  description: z.string(),
  category: z.string(),
  icon: z.json(),
  tags: z.array(z.string().nullable()),
  generation: z.array(z.string().nullable()),
  auth_methods: z.json(),
  mcp: z.json(),
  skill: z.json(),
  firewall: z.json(),
  permission_summary: z.json(),
  payload: z.json(),
  icon_sql_null: z.boolean(),
  auth_methods_sql_null: z.boolean(),
  mcp_sql_null: z.boolean(),
  skill_sql_null: z.boolean(),
  firewall_sql_null: z.boolean(),
  permission_summary_sql_null: z.boolean(),
  payload_sql_null: z.boolean(),
});
const contractionReadRowSchema = preparedRowSchema.omit({
  payload: true,
  icon_sql_null: true,
  auth_methods_sql_null: true,
  mcp_sql_null: true,
  skill_sql_null: true,
  firewall_sql_null: true,
  permission_summary_sql_null: true,
  payload_sql_null: true,
});
const nativeIdentitySql = `SELECT current_database() AS database,
  current_user::text AS role, session_user::text AS session_role,
  pg_backend_pid() AS pid, version() AS version,
  current_setting('server_encoding') AS encoding,
  current_setting('TimeZone') AS timezone`;
const nativeIdentitySchema = z.tuple([
  z.strictObject({
    database: z.string(),
    role: z.string(),
    session_role: z.string(),
    pid: z.number().int().positive(),
    version: z.string(),
    encoding: z.string(),
    timezone: z.string(),
  }),
]);
const contractionStateSchema = z.tuple([
  z.strictObject({
    state: z.strictObject({
      entries: z.array(preparedRowSchema),
      pointers: z.array(
        z.strictObject({ schema_version: z.number().int(), hash: z.string() }),
      ),
      physical: physicalCatalogRows,
      frontier: catalogRowsSchema,
      relationOids: z.array(
        z.strictObject({ name: z.string(), oid: z.string().regex(/^\d+$/u) }),
      ),
      namespace: z.tuple([
        z.strictObject({
          owner: z.string(),
          acl: z.string().nullable(),
          can_use: z.boolean(),
          can_create: z.boolean(),
        }),
      ]),
      permissions: z.array(
        z.strictObject({
          relname: z.string(),
          owner: z.string(),
          acl: z.string().nullable(),
          kind: z.string(),
          persistence: z.string(),
          rls: z.boolean(),
          force_rls: z.boolean(),
          can_select: z.boolean(),
          can_insert: z.boolean(),
          can_update: z.boolean(),
          can_delete: z.boolean(),
        }),
      ),
      attributes: z.array(
        z.strictObject({
          relname: z.string(),
          attnum: z.number().int().positive(),
          attname: z.string(),
          attisdropped: z.boolean(),
          acl: z.string().nullable(),
        }),
      ),
      // The exact skeleton and four original migrations create none of these.
      // Fail on unexpected objects rather than copying or silently omitting them.
      policies: z.array(z.never()).length(0),
      rules: z.array(z.never()).length(0),
      inheritance: z.array(z.never()).length(0),
    }),
  }),
]);
// One real native full-state read also fences a preceding failed Query. Keep
// SQL NULL flags beside JSON values: pg decodes JSON null and SQL NULL alike.
const contractionStateSql = `WITH physical AS (${physicalCatalogSql}),
  frontier AS (${catalogFrontierSql})
SELECT jsonb_build_object(
  'entries', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY hash, slug), '[]'::jsonb)
    FROM (SELECT hash, slug, label, description, category, icon, tags, generation,
      auth_methods, mcp, skill, firewall, permission_summary, payload,
      icon IS NULL AS icon_sql_null, auth_methods IS NULL AS auth_methods_sql_null,
      mcp IS NULL AS mcp_sql_null, skill IS NULL AS skill_sql_null,
      firewall IS NULL AS firewall_sql_null,
      permission_summary IS NULL AS permission_summary_sql_null,
      payload IS NULL AS payload_sql_null FROM connector_catalog_entries) e),
  'pointers', (SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY schema_version), '[]'::jsonb)
    FROM connector_catalog p),
  'physical', (SELECT jsonb_agg(to_jsonb(physical)) FROM physical),
  'frontier', (SELECT jsonb_agg(to_jsonb(frontier)) FROM frontier),
  'relationOids', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', c.relname, 'oid', c.oid::text) ORDER BY c.relname), '[]'::jsonb)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1),
  'namespace', (SELECT jsonb_agg(jsonb_build_object(
    'owner', pg_get_userbyid(n.nspowner), 'acl', n.nspacl::text,
    'can_use', has_schema_privilege(current_user, n.oid, 'USAGE'),
    'can_create', has_schema_privilege(current_user, n.oid, 'CREATE')))
    FROM pg_namespace n WHERE n.nspname=$1),
  'permissions', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'relname', c.relname, 'owner', pg_get_userbyid(c.relowner), 'acl', c.relacl::text,
    'kind', c.relkind, 'persistence', c.relpersistence,
    'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity,
    'can_select', has_table_privilege(current_user,c.oid,'SELECT'),
    'can_insert', has_table_privilege(current_user,c.oid,'INSERT'),
    'can_update', has_table_privilege(current_user,c.oid,'UPDATE'),
    'can_delete', has_table_privilege(current_user,c.oid,'DELETE')) ORDER BY c.relname), '[]'::jsonb)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname=$1 AND c.relkind IN ('r','p')),
  'attributes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'relname', c.relname, 'attnum', a.attnum, 'attname', a.attname,
    'attisdropped', a.attisdropped, 'acl', a.attacl::text)
    ORDER BY c.relname,a.attnum), '[]'::jsonb)
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0
    WHERE n.nspname=$1 AND c.relkind IN ('r','p')),
  'policies', (SELECT coalesce(jsonb_agg(to_jsonb(p)), '[]'::jsonb)
    FROM pg_policy p JOIN pg_class c ON c.oid=p.polrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1),
  'rules', (SELECT coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
    FROM pg_rewrite r JOIN pg_class c ON c.oid=r.ev_class
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1),
  'inheritance', (SELECT coalesce(jsonb_agg(to_jsonb(i)), '[]'::jsonb)
    FROM pg_inherits i JOIN pg_class c ON c.oid=i.inhrelid
    JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_class pc ON pc.oid=i.inhparent
    JOIN pg_namespace pn ON pn.oid=pc.relnamespace
    WHERE n.nspname=$1 OR pn.nspname=$1)
) AS state`;

function normalizedContractionState(
  state: z.infer<typeof contractionStateSchema>[0]["state"],
  schema: string,
  version: string,
) {
  const catalog = state.physical[0].catalog;
  assert.deepEqual(catalog.triggers, []);
  assert.deepEqual(catalog.routines, []);
  const expectedConstraints = [
    { name: "connector_catalog_entries_pkey", type: "p" },
    { name: "connector_catalog_pkey", type: "p" },
  ];
  // PostgreSQL 18 also represents these original NOT NULL attributes as native
  // constraints. Enumerate them exactly; never filter them out of either the
  // cross-namespace comparison or the same-namespace OID rollback snapshot.
  if (version.startsWith("PostgreSQL 18.")) {
    for (const column of [
      "auth_methods",
      "category",
      "description",
      "firewall",
      "generation",
      "hash",
      "icon",
      "label",
      "permission_summary",
      "skill",
      "slug",
      "tags",
    ]) {
      expectedConstraints.push({
        name: `connector_catalog_entries_${column}_not_null`,
        type: "n",
      });
    }
    for (const column of ["hash", "schema_version"]) {
      expectedConstraints.push({
        name: `connector_catalog_${column}_not_null`,
        type: "n",
      });
    }
  }
  expectedConstraints.sort((a, b) => {
    return a.name.localeCompare(b.name);
  });
  assert.deepEqual(
    catalog.constraints.map(({ name, type }) => {
      return { name, type };
    }),
    expectedConstraints,
  );
  assert.deepEqual(
    state.frontier[0]?.catalog.relations.map(({ name, kind }) => {
      return { name, kind };
    }),
    [
      { name: "connector_catalog", kind: "r" },
      { name: "connector_catalog_entries", kind: "r" },
      { name: "connector_catalog_entries_pkey", kind: "i" },
      { name: "connector_catalog_pkey", kind: "i" },
    ],
  );
  return {
    ...state,
    relationOids: state.relationOids.map(({ oid: _oid, name }) => {
      return { name };
    }),
    physical: {
      ...catalog,
      columns: catalog.columns.map(({ oid: _oid, ...column }) => {
        return column;
      }),
      constraints: catalog.constraints.map(({ oid: _oid, ...constraint }) => {
        return constraint;
      }),
      indexes: catalog.indexes.map((index) => {
        const qualification = ` ${schema}.`;
        assert.equal(index.definition.split(qualification).length, 2);
        return {
          ...index,
          definition: index.definition.replace(qualification, " "),
        };
      }),
    },
  };
}

const outgoingInsertSql =
  'insert into "connector_catalog_entries" ("hash", "slug", "label", "description", "category", "icon", "tags", "generation", "auth_methods", "mcp", "skill", "firewall", "permission_summary", "payload") values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)';
const outgoingParametersSchema = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
  z.null(),
  z.string(),
  z.string(),
  z.string(),
  z.string(),
]);
const nativeFieldSchema = z.strictObject({
  name: z.string(),
  tableID: z.number().int(),
  columnID: z.number().int(),
  dataTypeID: z.number().int(),
  dataTypeSize: z.number().int(),
  dataTypeModifier: z.number().int(),
  format: z.literal("text"),
});

function preparedRowBindings(row: z.infer<typeof preparedRowSchema>) {
  return [
    row.hash,
    row.slug,
    row.label,
    row.description,
    row.category,
    row.icon_sql_null ? null : JSON.stringify(row.icon),
    row.tags,
    row.generation,
    row.auth_methods_sql_null ? null : JSON.stringify(row.auth_methods),
    row.mcp_sql_null ? null : JSON.stringify(row.mcp),
    row.skill_sql_null ? null : JSON.stringify(row.skill),
    row.firewall_sql_null ? null : JSON.stringify(row.firewall),
    row.permission_summary_sql_null
      ? null
      : JSON.stringify(row.permission_summary),
    row.payload_sql_null ? null : JSON.stringify(row.payload),
  ];
}

function assertContractionReceipt(args: {
  readonly batch: string;
  readonly targetPosition: number;
  readonly rowsAtError: number;
  readonly received: z.infer<typeof contractionReadRowSchema>[];
  readonly fields: z.infer<typeof nativeFieldSchema>[][];
  readonly before: z.infer<typeof contractionStateSchema>[0]["state"];
}) {
  const { batch, targetPosition, rowsAtError, received, fields, before } = args;
  assert.equal(
    batch.slice(targetPosition - 1, targetPosition + 8),
    '"payload"',
  );
  assert.equal(rowsAtError, 40);
  assert.deepEqual(
    received,
    before.entries.map((row) => {
      return contractionReadRowSchema.parse({
        hash: row.hash,
        slug: row.slug,
        label: row.label,
        description: row.description,
        category: row.category,
        icon: row.icon,
        tags: row.tags,
        generation: row.generation,
        auth_methods: row.auth_methods,
        mcp: row.mcp,
        skill: row.skill,
        firewall: row.firewall,
        permission_summary: row.permission_summary,
      });
    }),
  );
  assert.equal(fields.length, 40);
  const columns = before.physical[0].catalog.columns.filter((column) => {
    return (
      column.table === "connector_catalog_entries" && column.name !== "payload"
    );
  });
  for (const receipt of fields) {
    assert.deepEqual(
      receipt.map((field) => {
        return field.name;
      }),
      columns.map((column) => {
        return column.name;
      }),
    );
    for (const [index, field] of receipt.entries()) {
      const column = columns[index];
      assert.ok(column);
      assert.equal(String(field.tableID), column.oid);
      assert.equal(field.columnID, column.attnum);
      assert.equal(
        field.dataTypeID,
        column.type === "jsonb" ? 3802 : column.type === "text[]" ? 1009 : 25,
      );
    }
  }
}

function outgoingErrorFailures(error: Error | undefined, position: number) {
  if (error === undefined) {
    return [new Error("The outgoing writer unexpectedly succeeded")];
  }
  if (
    error instanceof Error &&
    "code" in error &&
    error.code === "42703" &&
    "position" in error &&
    error.position === String(position)
  ) {
    return [];
  }
  // Preserve the original wrong native error before a later fence can fail.
  return [error];
}

async function validateFailedContraction(args: {
  readonly databaseUrl: string;
  readonly sourceSchema: string;
  readonly source: z.infer<typeof contractionStateSchema>[0]["state"];
  readonly identity: z.infer<typeof nativeIdentitySchema>[0];
  readonly base: ConnectorCatalogArtifactConnector;
  readonly expansion: string;
  readonly backfill: string;
  readonly preparation: string;
  readonly contraction: string;
}) {
  const client = new Client({ connectionString: args.databaseUrl });
  const schema = `catalog_contraction_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^catalog_contraction_[0-9a-f]{32}$/u);
  const identifier = escapeIdentifier(schema);
  const errors: unknown[] = [];
  const observeError = (error: Error) => {
    errors.push(error);
  };
  client.on("error", observeError);
  const settings: Partial<Record<(typeof fixtureSettings)[number], string>> =
    {};
  let connected = false;
  let ownsSchema = false;
  let message: Query | undefined;
  try {
    await client.connect();
    connected = true;
    for (const setting of fixtureSettings) {
      settings[setting] = shownSetting(
        (await client.query(`SHOW ${setting}`)).rows,
        setting,
      );
    }
    const identity = nativeIdentitySchema.parse(
      (await client.query(nativeIdentitySql)).rows,
    )[0];
    const { pid: parentPid, ...sourceIdentity } = args.identity;
    const { pid, ...childIdentity } = identity;
    assert.notEqual(pid, parentPid);
    assert.deepEqual(childIdentity, sourceIdentity);
    assert.deepEqual(
      namespaceRowsSchema.parse(
        (
          await client.query(
            "SELECT nspname FROM pg_namespace WHERE nspname = $1",
            [schema],
          )
        ).rows,
      ),
      [],
    );
    await client.query("SET lock_timeout = '1s'");
    await client.query("SET statement_timeout = '10s'");
    assert.equal(
      shownSetting(
        (await client.query("SHOW lock_timeout")).rows,
        "lock_timeout",
      ),
      "1s",
    );
    assert.equal(
      shownSetting(
        (await client.query("SHOW statement_timeout")).rows,
        "statement_timeout",
      ),
      "10s",
    );
    const created = await client.query(`CREATE SCHEMA ${identifier}`);
    assert.equal(created.command, "CREATE");
    ownsSchema = true;
    await client.query(`SET search_path TO ${identifier}`);
    assert.equal(
      shownSetting(
        (await client.query("SHOW search_path")).rows,
        "search_path",
      ),
      schema,
    );
    await client.query(`CREATE TABLE connector_catalog_entries (
    hash text NOT NULL, slug text NOT NULL, payload jsonb NOT NULL,
    PRIMARY KEY (hash, slug)
  )`);
    await client.query(`CREATE TABLE connector_catalog (
    schema_version integer PRIMARY KEY, hash text NOT NULL
  )`);
    // Empty replay establishes the original physical shape; populated migration
    // coverage remains on the parent and the independent preparation owner.
    await client.query(args.expansion);
    await client.query(args.backfill);
    await client.query(args.preparation);
    assert.equal(args.source.entries.length, 40);
    for (const row of args.source.entries) {
      await client.query(
        `INSERT INTO connector_catalog_entries
        (hash, slug, label, description, category, icon, tags, generation,
         auth_methods, mcp, skill, firewall, permission_summary, payload)
        VALUES ($1::text, $2::text, $3::text, $4::text, $5::text, $6::jsonb,
          $7::text[], $8::text[], $9::jsonb, $10::jsonb, $11::jsonb,
          $12::jsonb, $13::jsonb, $14::jsonb)`,
        preparedRowBindings(row),
      );
    }
    for (const pointer of args.source.pointers) {
      await client.query(
        "INSERT INTO connector_catalog (schema_version, hash) VALUES ($1::integer, $2::text)",
        [pointer.schema_version, pointer.hash],
      );
    }
    const before = contractionStateSchema.parse(
      (await client.query(contractionStateSql, [schema])).rows,
    )[0].state;
    assert.deepEqual(
      normalizedContractionState(before, schema, identity.version),
      normalizedContractionState(
        args.source,
        args.sourceSchema,
        args.identity.version,
      ),
    );
    assert.ok(
      !before.entries.some((row) => {
        return row.hash === "retired-dual-writer";
      }),
    );
    const db = drizzle(client);
    const base = args.base;
    const outgoing = db
      .insert(connectorCatalogEntries)
      .values({
        hash: "retired-dual-writer",
        slug: base.slug,
        payload: base,
        ...connectorCatalogEntryColumns(base),
      })
      .toSQL();
    assert.equal(outgoing.sql, outgoingInsertSql);
    const params = outgoingParametersSchema.parse(outgoing.params);
    assert.equal(base.slug, "019sms");
    assert.equal(base.mcp, undefined);
    assert.deepEqual(params, [
      "retired-dual-writer",
      base.slug,
      base.label,
      base.description,
      base.category,
      JSON.stringify(base.icon),
      '{"sms","messaging","text-messaging","bulk-sms","delivery-reports","019sms"}',
      "{}",
      JSON.stringify(base.authMethods),
      null,
      JSON.stringify(base.skill),
      JSON.stringify(base.firewall),
      JSON.stringify(connectorCatalogPermissionSummary(base)),
      JSON.stringify(base),
    ]);
    // This compiler accepts only the asserted closed fourteen-slot template.
    // A single pass never interprets placeholder-like text inside a value.
    let replacements = 0;
    const literalInsert = outgoing.sql.replace(
      /\$(\d+)/gu,
      (_token, digits: string) => {
        replacements += 1;
        assert.equal(Number(digits), replacements);
        const value = params[replacements - 1];
        assert.ok(typeof value === "string" || value === null);
        return value === null ? "NULL" : escapeLiteral(value);
      },
    );
    assert.equal(replacements, 14);
    const prefix = `${args.contraction}\nSELECT * FROM connector_catalog_entries ORDER BY hash, slug;\n`;
    const batch = `${prefix}${literalInsert};`;
    const targetPosition =
      prefix.length + outgoingInsertSql.indexOf('"payload"') + 1;
    assert.equal(
      Buffer.byteLength(batch.slice(0, targetPosition), "utf8"),
      targetPosition,
    );
    const received: z.infer<typeof contractionReadRowSchema>[] = [];
    const fields: z.infer<typeof nativeFieldSchema>[][] = [];
    let rowsAtError = -1;
    message = new Query(batch);
    // No name, values, portal controls or extended mode: exactly one native Q.
    const settled = new Promise<Error | undefined>((resolve) => {
      const onRow = (row: unknown, result: unknown) => {
        try {
          received.push(contractionReadRowSchema.parse(row));
          fields.push(
            z.object({ fields: z.array(nativeFieldSchema) }).parse(result)
              .fields,
          );
        } catch (error: unknown) {
          errors.push(error);
        }
      };
      const onError = (error: Error) => {
        rowsAtError = received.length;
        resolve(error);
      };
      const onEnd = () => {
        return resolve(undefined);
      };
      assert.ok(message);
      message.on("row", onRow);
      message.on("error", onError);
      message.on("end", onEnd);
    });
    client.query(message);
    const nativeError = await settled;
    errors.push(...outgoingErrorFailures(nativeError, targetPosition));
    // Error settlement can precede ReadyForQuery. Await a real full read before
    // observing I or releasing Query listeners, including on a wrong-error path.
    const recovered = await client.query(contractionStateSql, [schema]);
    assert.deepEqual(
      contractionStateSchema.parse(recovered.rows)[0].state,
      before,
    );
    assert.equal(client.getTransactionStatus(), "I");
    const recoveredAgain = contractionStateSchema.parse(
      (await client.query(contractionStateSql, [schema])).rows,
    )[0].state;
    assert.deepEqual(recoveredAgain, before);
    assert.equal(client.getTransactionStatus(), "I");
    assertContractionReceipt({
      batch,
      targetPosition,
      rowsAtError,
      received,
      fields,
      before,
    });
  } catch (error: unknown) {
    errors.push(error);
  } finally {
    if (ownsSchema) {
      try {
        assert.equal(
          (await client.query(`DROP SCHEMA ${identifier} CASCADE`)).command,
          "DROP",
        );
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (connected) {
      try {
        assert.deepEqual(
          namespaceRowsSchema.parse(
            (
              await client.query(
                "SELECT nspname FROM pg_namespace WHERE nspname = $1",
                [schema],
              )
            ).rows,
          ),
          [],
        );
      } catch (error: unknown) {
        errors.push(error);
      }
      for (const setting of fixtureSettings) {
        const value = settings[setting];
        if (value === undefined) continue;
        try {
          await client.query("SELECT set_config($1, $2, false)", [
            setting,
            value,
          ]);
        } catch (error: unknown) {
          errors.push(error);
        }
        try {
          assert.equal(
            shownSetting((await client.query(`SHOW ${setting}`)).rows, setting),
            value,
          );
        } catch (error: unknown) {
          errors.push(error);
        }
      }
    }
    // Every owned query above has settled; no end/destroy of an active Query.
    try {
      await client.end();
    } catch (error: unknown) {
      errors.push(error);
    }
    // This locally created Query has only the three owner-installed listeners.
    message?.removeAllListeners();
    client.removeListener("error", observeError);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "Failed contraction validation or disposal failed",
      { cause: errors[0] },
    );
}

async function validateRetiredWriter(args: {
  readonly databaseUrl: string;
  readonly entries: (typeof runtimeEntries.$inferSelect)[];
  readonly pointers: (typeof connectorCatalog.$inferSelect)[];
  readonly frontier: z.infer<typeof catalogRowsSchema>;
  readonly base: ConnectorCatalogArtifactConnector;
  readonly expansion: string;
  readonly preparation: string;
  readonly contraction: string;
}) {
  const client = new Client({ connectionString: args.databaseUrl });
  const testSchema = `catalog_retired_writer_${randomUUID().replaceAll("-", "")}`;
  const errors: unknown[] = [];
  const observeError = (error: Error) => {
    errors.push(error);
  };
  client.on("error", observeError);
  const settings: Partial<Record<(typeof fixtureSettings)[number], string>> =
    {};
  let connected = false;
  let ownsSchema = false;
  try {
    await client.connect();
    connected = true;
    for (const setting of fixtureSettings) {
      settings[setting] = shownSetting(
        (await client.query(`SHOW ${setting}`)).rows,
        setting,
      );
    }
    assert.deepEqual(
      namespaceRowsSchema.parse(
        (
          await client.query(
            "SELECT nspname FROM pg_namespace WHERE nspname = $1",
            [testSchema],
          )
        ).rows,
      ),
      [],
    );
    const created = await client.query(`CREATE SCHEMA "${testSchema}"`);
    assert.equal(created.command, "CREATE");
    ownsSchema = true;
    await client.query(`SET search_path TO "${testSchema}"`);
    await client.query("SET lock_timeout = '1s'");
    await client.query("SET statement_timeout = '10s'");
    assert.equal(
      shownSetting(
        (await client.query("SHOW search_path")).rows,
        "search_path",
      ),
      testSchema,
    );
    assert.equal(
      shownSetting(
        (await client.query("SHOW lock_timeout")).rows,
        "lock_timeout",
      ),
      "1s",
    );
    assert.equal(
      shownSetting(
        (await client.query("SHOW statement_timeout")).rows,
        "statement_timeout",
      ),
      "10s",
    );
    await client.query(`CREATE TABLE connector_catalog_entries (
    hash text NOT NULL, slug text NOT NULL, payload jsonb NOT NULL,
    PRIMARY KEY (hash, slug)
  )`);
    await client.query(`CREATE TABLE connector_catalog (
    schema_version integer PRIMARY KEY, hash text NOT NULL
  )`);
    await client.query(args.expansion);
    await client.query(args.preparation);
    await client.query(args.contraction);
    const db = drizzle(client);
    await db.insert(connectorCatalog).values(args.pointers);
    await db.insert(runtimeEntries).values(args.entries);
    assert.deepEqual(
      await db
        .select()
        .from(runtimeEntries)
        .orderBy(runtimeEntries.hash, runtimeEntries.slug),
      args.entries,
    );
    assert.deepEqual(await db.select().from(connectorCatalog), args.pointers);
    assert.deepEqual(
      catalogRowsSchema.parse(
        (await client.query(catalogFrontierSql, [testSchema])).rows,
      ),
      args.frontier,
    );
    // Use the actual outgoing ORM column list, including the dropped payload.
    const base = args.base;
    await assert.rejects(
      db.insert(connectorCatalogEntries).values({
        hash: "retired-dual-writer",
        slug: base.slug,
        payload: base,
        ...connectorCatalogEntryColumns(base),
      }),
      (error: unknown) => {
        return (
          error instanceof Error &&
          "cause" in error &&
          error.cause instanceof Error &&
          "code" in error.cause &&
          error.cause.code === "42703"
        );
      },
    );
    assert.deepEqual(
      await db
        .select()
        .from(runtimeEntries)
        .orderBy(runtimeEntries.hash, runtimeEntries.slug),
      args.entries,
    );
    assert.deepEqual(await db.select().from(connectorCatalog), args.pointers);
    assert.deepEqual(
      catalogRowsSchema.parse(
        (await client.query(catalogFrontierSql, [testSchema])).rows,
      ),
      args.frontier,
    );
  } catch (error: unknown) {
    errors.push(error);
  } finally {
    if (ownsSchema) {
      try {
        await client.query(`DROP SCHEMA "${testSchema}" CASCADE`);
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (connected) {
      try {
        const namespaces = namespaceRowsSchema.parse(
          (
            await client.query(
              "SELECT nspname FROM pg_namespace WHERE nspname = $1",
              [testSchema],
            )
          ).rows,
        );
        if (ownsSchema) assert.deepEqual(namespaces, []);
      } catch (error: unknown) {
        errors.push(error);
      }
      for (const setting of fixtureSettings) {
        const value = settings[setting];
        if (value !== undefined) {
          try {
            await client.query("SELECT set_config($1, $2, false)", [
              setting,
              value,
            ]);
          } catch (error: unknown) {
            errors.push(error);
          }
          try {
            assert.equal(
              shownSetting(
                (await client.query(`SHOW ${setting}`)).rows,
                setting,
              ),
              value,
            );
          } catch (error: unknown) {
            errors.push(error);
          }
        }
      }
    }
    try {
      await client.end();
    } catch (error: unknown) {
      errors.push(error);
    }
    client.removeListener("error", observeError);
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Retired writer validation and cleanup failed",
    );
  }
}

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
const errors: unknown[] = [];
const observeError = (error: Error) => {
  errors.push(error);
};
client.on("error", observeError);
let connected = false;
let successMessage: string | undefined;
try {
  await client.connect();
  connected = true;
  const db = drizzle(client);
  const testSchema = `catalog_entry_columns_${randomUUID().replaceAll("-", "")}`;
  const expansion = await readFile(
    new URL(
      "../src/migrations/1339_expand_connector_catalog_entry_columns.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const backfill = await readFile(
    new URL(
      "../src/migrations/1340_backfill_connector_catalog_entry_columns.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const preparation = await readFile(
    new URL(
      "../src/migrations/1348_connector_catalog_payload_independent_api.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const contraction = await readFile(
    new URL(
      "../src/migrations/1351_drop_connector_catalog_payload.sql",
      import.meta.url,
    ),
    "utf8",
  );
  const rawCatalog: unknown = JSON.parse(
    await readFile(
      new URL(
        "../../connectors/src/__tests__/fixtures/published-v4-catalog.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const catalog = connectorCatalogArtifactSchema.parse(rawCatalog);
  const base = catalog.connectors.find((connector) => {
    return (
      connector.mcp === undefined && connector.firewall.kind === "generated"
    );
  });
  assert.ok(base);
  assert.equal(base.firewall.kind, "generated");
  const generated = base.firewall;
  assert.ok(generated.kind === "generated");
  const firstApi = generated.config.apis[0];
  assert.ok(firstApi);

  function firewallConnector(args: {
    readonly slug: string;
    readonly permissions: readonly string[];
    readonly defaultAllowed: readonly string[] | null;
    readonly unknownPolicy?: "allow" | "deny" | "ask";
    readonly categories?: boolean;
    readonly mcp?: boolean;
  }): ConnectorCatalogArtifactConnector {
    assert.ok(base);
    assert.ok(generated.kind === "generated");
    assert.ok(firstApi);
    const apiWithoutPermissions = { ...firstApi };
    delete apiWithoutPermissions.permissions;
    return {
      ...base,
      slug: args.slug,
      ...(args.mcp
        ? {
            mcp: {
              transport: "streamable-http",
              endpoint: "https://example.com/mcp",
            },
          }
        : {}),
      firewall: {
        ...generated,
        categories: args.categories
          ? { byPermission: {}, displayOrder: [] }
          : null,
        defaultAllowed:
          args.defaultAllowed === null ? null : [...args.defaultAllowed],
        defaultUnknownPolicy: args.unknownPolicy ?? "allow",
        config: {
          ...generated.config,
          apis: [
            {
              ...firstApi,
              permissions: args.permissions.map((name) => {
                return { name, rules: ["GET /"] };
              }),
            },
            // A repeated permission in another API must count only once.
            {
              ...firstApi,
              permissions: args.permissions.slice(0, 1).map((name) => {
                return { name, rules: ["POST /"] };
              }),
            },
            // APIs without permission metadata contribute nothing.
            apiWithoutPermissions,
          ],
        },
      },
    };
  }

  const cases = [
    {
      connector: firewallConnector({
        slug: "all-allowed",
        permissions: ["read", "write"],
        defaultAllowed: null,
      }),
      count: 2,
      overrides: false,
    },
    {
      connector: firewallConnector({
        slug: "explicit-allowed",
        permissions: ["read", "write"],
        defaultAllowed: ["read", "write", "unused"],
      }),
      count: 2,
      overrides: false,
    },
    {
      connector: firewallConnector({
        slug: "deny-majority",
        permissions: ["read", "write", "delete"],
        defaultAllowed: ["read"],
      }),
      count: 3,
      overrides: true,
    },
    {
      connector: firewallConnector({
        slug: "tied-policy",
        permissions: ["read", "write"],
        defaultAllowed: ["read"],
      }),
      count: 2,
      overrides: true,
    },
    {
      connector: firewallConnector({
        slug: "deny-all",
        permissions: ["read", "write"],
        defaultAllowed: [],
      }),
      count: 2,
      overrides: true,
    },
    {
      connector: firewallConnector({
        slug: "empty-allowed",
        permissions: [],
        defaultAllowed: [],
      }),
      count: 0,
      overrides: false,
    },
    {
      connector: firewallConnector({
        slug: "empty-default",
        permissions: [],
        defaultAllowed: null,
        categories: true,
      }),
      count: 0,
      overrides: false,
      categories: true,
    },
    {
      connector: firewallConnector({
        slug: "unknown-deny",
        permissions: [],
        defaultAllowed: null,
        unknownPolicy: "deny",
      }),
      count: 0,
      overrides: true,
    },
    {
      connector: firewallConnector({
        slug: "unknown-ask",
        permissions: ["read"],
        defaultAllowed: null,
        unknownPolicy: "ask",
      }),
      count: 1,
      overrides: true,
    },
    {
      connector: firewallConnector({
        slug: "mcp-suppressed",
        permissions: ["read"],
        defaultAllowed: [],
        unknownPolicy: "deny",
        categories: true,
        mcp: true,
      }),
      count: 0,
      overrides: false,
    },
    {
      connector: {
        ...base,
        slug: "firewall-none",
        firewall: { kind: "none" },
      } satisfies ConnectorCatalogArtifactConnector,
      count: 0,
      overrides: false,
    },
  ];
  const connectors = [
    ...catalog.connectors,
    ...cases.map((item) => {
      return item.connector;
    }),
  ];
  for (const item of cases) {
    assert.deepEqual(
      connectorCatalogPermissionSummary(item.connector),
      {
        hasPermissions: item.count > 0,
        permissionCount: item.count,
        hasCategories: item.categories ?? false,
        hasDefaultPolicyOverrides: item.overrides,
      },
      item.connector.slug,
    );
  }
  assert.deepEqual(
    compactConnectorCatalogDefaultPolicy(
      firewallConnector({
        slug: "policy-tie",
        permissions: ["write", "read"],
        defaultAllowed: ["read"],
      }),
    ),
    {
      permissionDefault: "allow",
      permissionOverrides: { deny: ["write"] },
      unknownPolicy: "allow",
    },
  );
  assert.deepEqual(
    compactConnectorCatalogDefaultPolicy(
      firewallConnector({
        slug: "policy-majority",
        permissions: ["write", "read", "delete"],
        defaultAllowed: ["read"],
      }),
    ),
    {
      permissionDefault: "deny",
      permissionOverrides: { allow: ["read"] },
      unknownPolicy: "allow",
    },
  );

  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0378; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${testSchema}"`);
  await client.query(`SET LOCAL search_path TO "${testSchema}"`);
  await client.query("SET LOCAL lock_timeout = '1s'");
  await client.query("SET LOCAL statement_timeout = '10s'");
  await client.query(`CREATE TABLE connector_catalog_entries (
    hash text NOT NULL, slug text NOT NULL, payload jsonb NOT NULL,
    PRIMARY KEY (hash, slug)
  )`);
  await client.query(`CREATE TABLE connector_catalog (
    schema_version integer PRIMARY KEY, hash text NOT NULL
  )`);
  await db
    .insert(connectorCatalog)
    .values({ schemaVersion: 4, hash: "current" });
  // Neither migration may assume only the currently published hash matters.
  for (const hash of ["historical", "current", "partial-preparation"]) {
    for (const connector of hash === "partial-preparation"
      ? connectors.slice(0, 1)
      : connectors) {
      await client.query(
        "INSERT INTO connector_catalog_entries VALUES ($1, $2, $3)",
        [hash, connector.slug, JSON.stringify(connector)],
      );
    }
  }
  await client.query(expansion);
  await client.query(backfill);
  const rows = await db.select().from(connectorCatalogEntries);
  assert.equal(rows.length, connectors.length * 2 + 1);
  for (const row of rows) {
    const expected = connectors.find((connector) => {
      return connector.slug === row.slug;
    });
    assert.ok(expected);
    assert.deepEqual(row, {
      hash: row.hash,
      slug: expected.slug,
      payload: expected,
      ...connectorCatalogEntryColumns(expected),
    });
  }
  // Outgoing binaries must still be able to prepare generations after expansion.
  await client.query(
    "INSERT INTO connector_catalog_entries (hash, slug, payload) VALUES ($1, $2, $3)",
    ["late-legacy", base.slug, JSON.stringify(base)],
  );
  const late = await client.query(
    "SELECT auth_methods, permission_summary FROM connector_catalog_entries WHERE hash = 'late-legacy'",
  );
  assert.deepEqual(late.rows, [
    { auth_methods: null, permission_summary: null },
  ]);
  const retry = await client.query(backfill);
  assert.equal(
    retry.rowCount,
    1,
    "retry projects only the outgoing writer's new row",
  );
  assert.equal(
    (await client.query(backfill)).rowCount,
    0,
    "completed retry is a no-op",
  );
  // New writers insert every column in the same immutable row as payload.
  await db.insert(connectorCatalogEntries).values({
    hash: "new-writer",
    slug: base.slug,
    payload: base,
    ...connectorCatalogEntryColumns(base),
  });
  assert.equal(
    (await client.query(backfill)).rowCount,
    0,
    "new writer already supplies the projection",
  );
  // The parent frontier is uncommitted: copy ordinary complete values only.
  await validateRejectedPreparation({
    databaseUrl,
    expansion,
    preparation,
    entries: await db
      .select()
      .from(connectorCatalogEntries)
      .orderBy(connectorCatalogEntries.hash, connectorCatalogEntries.slug),
    pointers: await db
      .select()
      .from(connectorCatalog)
      .orderBy(connectorCatalog.schemaVersion),
    sourceSchema: testSchema,
    frontier: physicalCatalogRows.parse(
      (await client.query(physicalCatalogSql, [testSchema])).rows,
    )[0].catalog,
  });
  const before = await db.select().from(connectorCatalogEntries);
  await client.query(preparation);
  assert.deepEqual(await db.select().from(connectorCatalogEntries), before);
  await validateConnectorCatalogColumnContract(client, {
    databaseUrl,
    sourceSchema: testSchema,
    phase: "prepared",
    expectedRows: 41,
    expansion,
    backfill,
    preparation,
    contraction,
  });
  // The immediately outgoing dual writer remains valid while migrations run
  // before API promotion, even though payload is now optional.
  await db.insert(connectorCatalogEntries).values({
    hash: "outgoing-dual-writer",
    slug: base.slug,
    payload: base,
    ...connectorCatalogEntryColumns(base),
  });
  await client.query(preparation);
  assert.deepEqual(await db.select().from(connectorCatalogEntries), [
    ...before,
    {
      hash: "outgoing-dual-writer",
      slug: base.slug,
      payload: base,
      ...connectorCatalogEntryColumns(base),
    },
  ]);
  const retained = await db
    .select()
    .from(runtimeEntries)
    .orderBy(runtimeEntries.hash, runtimeEntries.slug);
  const pointers = await db.select().from(connectorCatalog);
  // Only ordinary complete data crosses into the independent native owner.
  const preparedState = contractionStateSchema.parse(
    (await client.query(contractionStateSql, [testSchema])).rows,
  )[0].state;
  const parentIdentity = nativeIdentitySchema.parse(
    (await client.query(nativeIdentitySql)).rows,
  )[0];
  const parentSettings: Partial<
    Record<(typeof fixtureSettings)[number], string>
  > = {};
  for (const setting of fixtureSettings) {
    parentSettings[setting] = shownSetting(
      (await client.query(`SHOW ${setting}`)).rows,
      setting,
    );
  }
  const contractionErrors: unknown[] = [];
  try {
    await validateFailedContraction({
      databaseUrl,
      sourceSchema: testSchema,
      source: preparedState,
      identity: parentIdentity,
      base,
      expansion,
      backfill,
      preparation,
      contraction,
    });
  } catch (error: unknown) {
    contractionErrors.push(error);
  } finally {
    // A failed child never suppresses the parent's independent preservation checks.
    try {
      assert.deepEqual(
        contractionStateSchema.parse(
          (await client.query(contractionStateSql, [testSchema])).rows,
        )[0].state,
        preparedState,
      );
      assert.equal(client.getTransactionStatus(), "T");
    } catch (error: unknown) {
      contractionErrors.push(error);
    }
    for (const setting of fixtureSettings) {
      try {
        assert.equal(
          shownSetting((await client.query(`SHOW ${setting}`)).rows, setting),
          parentSettings[setting],
        );
      } catch (error: unknown) {
        contractionErrors.push(error);
      }
    }
  }
  if (contractionErrors.length === 1) throw contractionErrors[0];
  if (contractionErrors.length > 1)
    throw new AggregateError(
      contractionErrors,
      "Contraction or parent preservation failed",
      { cause: contractionErrors[0] },
    );
  assert.deepEqual(await db.select().from(connectorCatalogEntries), [
    ...before,
    {
      hash: "outgoing-dual-writer",
      slug: base.slug,
      payload: base,
      ...connectorCatalogEntryColumns(base),
    },
  ]);
  await client.query(contraction);
  // Retain the complete middle group at the same forty-row frontier, after the
  // one surviving parent DROP and before partial generation completion.
  await validateConnectorCatalogColumnContract(client, {
    databaseUrl,
    sourceSchema: testSchema,
    phase: "contracted",
    expectedRows: 42,
    expansion,
    backfill,
    preparation,
    contraction,
  });
  const physicalColumns = await client.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'connector_catalog_entries'
       AND column_name = 'payload'`,
    [testSchema],
  );
  assert.deepEqual(physicalColumns.rows, []);
  // DROP is incompatible with a still-serving dual writer. Execute the frozen
  // outgoing statement in its own fully populated contracted namespace.
  const frontier = catalogRowsSchema.parse(
    (await client.query(catalogFrontierSql, [testSchema])).rows,
  );
  await validateRetiredWriter({
    databaseUrl,
    entries: retained,
    pointers,
    frontier,
    base,
    expansion,
    preparation,
    contraction,
  });
  assert.deepEqual(
    catalogRowsSchema.parse(
      (await client.query(catalogFrontierSql, [testSchema])).rows,
    ),
    frontier,
  );
  assert.deepEqual(
    await db
      .select()
      .from(runtimeEntries)
      .orderBy(runtimeEntries.hash, runtimeEntries.slug),
    retained,
    "contraction preserves every projection and hash/slug receipt across current, historical and partial generations",
  );
  assert.deepEqual(await db.select().from(connectorCatalog), pointers);
  // A retained partial generation can still finish with payload-free inserts;
  // the already-existing entry is its immutable receipt, not an update target.
  const partialRetry = await db
    .insert(runtimeEntries)
    .values(
      connectors.map((connector) => {
        return {
          hash: "partial-preparation",
          slug: connector.slug,
          ...connectorCatalogEntryColumns(connector),
        };
      }),
    )
    .onConflictDoNothing()
    .returning();
  assert.equal(partialRetry.length, connectors.length - 1);
  assert.deepEqual(await db.select().from(connectorCatalog), pointers);
  assert.deepEqual(
    await db
      .select()
      .from(runtimeEntries)
      .orderBy(runtimeEntries.hash, runtimeEntries.slug),
    [...retained, ...partialRetry].sort((a, b) => {
      return a.hash.localeCompare(b.hash) || a.slug.localeCompare(b.slug);
    }),
  );
  await validateConnectorCatalogColumnContract(client, {
    databaseUrl,
    sourceSchema: testSchema,
    phase: "contracted",
    expectedRows: 59,
    expansion,
    backfill,
    preparation,
    contraction,
  });
  successMessage = `Catalog entry expansion/backfill/preparation/contraction: ${rows.length} retained rows, ${cases.length} summary boundaries, transactional DDL rollback, outgoing/new writers, unchanged identity/projections/pointer, post-DROP runtime reads`;
} catch (error: unknown) {
  errors.push(error);
} finally {
  if (connected) {
    try {
      await client.query("ROLLBACK");
    } catch (error: unknown) {
      errors.push(error);
    }
  }
  try {
    await client.end();
  } catch (error: unknown) {
    errors.push(error);
  }
  client.removeListener("error", observeError);
}
throwCollectedErrors(errors, "Catalog entry transition or disposal failed");
assert.ok(successMessage);
console.log(successMessage);
