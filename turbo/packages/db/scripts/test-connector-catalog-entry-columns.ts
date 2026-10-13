import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
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

// Keep every selected catalog field; result generics do not decode pg rows.
const physicalCatalogRows = z.tuple([
  z.strictObject({
    catalog: z.strictObject({
      columns: z.array(
        z.strictObject({
          oid: z.string().regex(/^\d+$/u),
          table: z.string(),
          attnum: z.number().int().positive(),
          name: z.string(),
          type: z.string(),
          notNull: z.boolean(),
          default: z.string().nullable(),
          identity: z.string(),
          generated: z.string(),
          dropped: z.boolean(),
          collation: z.string().nullable(),
        }),
      ),
      constraints: z.array(
        z.strictObject({
          oid: z.string().regex(/^\d+$/u),
          name: z.string(),
          type: z.string(),
          validated: z.boolean(),
          deferrable: z.boolean(),
          deferred: z.boolean(),
          definition: z.string(),
        }),
      ),
      indexes: z.array(
        z.strictObject({
          table: z.string(),
          name: z.string(),
          definition: z.string(),
        }),
      ),
      tables: z.array(
        z.strictObject({
          name: z.string(),
          kind: z.string(),
          rls: z.boolean(),
        }),
      ),
      triggers: z.array(
        z.strictObject({ name: z.string(), definition: z.string() }),
      ),
      routines: z.array(
        z.strictObject({
          name: z.string(),
          kind: z.string(),
          body: z.string(),
        }),
      ),
    }),
  }),
]);

const physicalCatalogSql = `SELECT jsonb_build_object(
 'columns', (SELECT coalesce(jsonb_agg(jsonb_build_object('oid',c.oid,'table',c.relname,'attnum',a.attnum,'name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull,'default',pg_get_expr(d.adbin,d.adrelid),'identity',a.attidentity,'generated',a.attgenerated,'dropped',a.attisdropped,'collation',co.collname) ORDER BY c.relname,a.attnum),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE n.nspname=$1 AND c.relkind='r'),
 'constraints',(SELECT coalesce(jsonb_agg(jsonb_build_object('oid',c.oid,'name',c.conname,'type',c.contype,'validated',c.convalidated,'deferrable',c.condeferrable,'deferred',c.condeferred,'definition',pg_get_constraintdef(c.oid)) ORDER BY c.conname),'[]'::jsonb) FROM pg_constraint c JOIN pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1),
 'indexes',(SELECT coalesce(jsonb_agg(jsonb_build_object('table',tablename,'name',indexname,'definition',indexdef) ORDER BY indexname),'[]'::jsonb) FROM pg_indexes WHERE schemaname=$1),
 'tables',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',c.relname,'kind',c.relkind,'rls',c.relrowsecurity) ORDER BY c.relname),'[]'::jsonb) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relkind IN ('r','v','m','S','f')),
 'triggers',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',t.tgname,'definition',pg_get_triggerdef(t.oid)) ORDER BY t.tgname),'[]'::jsonb) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND NOT t.tgisinternal),
 'routines',(SELECT coalesce(jsonb_agg(jsonb_build_object('name',r.proname,'kind',r.prokind,'body',r.prosrc) ORDER BY r.proname),'[]'::jsonb) FROM pg_proc r JOIN pg_namespace n ON n.oid=r.pronamespace WHERE n.nspname=$1)
 ) AS catalog`;

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

// Compare physical contracts across namespaces without comparing allocated OIDs
// or the private namespace prefix. Keep dropped attributes in the frontier.
const catalogFrontierSql = `SELECT jsonb_build_object(
  'columns', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'table', c.relname, 'position', a.attnum, 'name', a.attname,
    'type', format_type(a.atttypid, a.atttypmod), 'notNull', a.attnotnull,
    'default', pg_get_expr(d.adbin, d.adrelid), 'identity', a.attidentity,
    'generated', a.attgenerated, 'dropped', a.attisdropped,
    'collation', co.collname) ORDER BY c.relname, a.attnum), '[]'::jsonb)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0
    LEFT JOIN pg_attrdef d ON d.adrelid = c.oid AND d.adnum = a.attnum
    LEFT JOIN pg_collation co ON co.oid = a.attcollation
    WHERE n.nspname = $1 AND c.relkind = 'r'),
  'constraints', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', c.conname, 'type', c.contype, 'validated', c.convalidated,
    'deferrable', c.condeferrable, 'deferred', c.condeferred,
    'definition', pg_get_constraintdef(c.oid)) ORDER BY c.conname), '[]'::jsonb)
    FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE n.nspname = $1),
  'indexes', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'table', tablename, 'name', indexname,
    'definition', replace(indexdef, quote_ident($1) || '.', ''))
    ORDER BY indexname), '[]'::jsonb)
    FROM pg_indexes WHERE schemaname = $1),
  'relations', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', c.relname, 'kind', c.relkind, 'persistence', c.relpersistence,
    'rls', c.relrowsecurity, 'forceRls', c.relforcerowsecurity)
    ORDER BY c.relname), '[]'::jsonb)
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1),
  'triggers', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', t.tgname, 'definition', pg_get_triggerdef(t.oid))
    ORDER BY t.tgname), '[]'::jsonb)
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = $1 AND NOT t.tgisinternal),
  'routines', (SELECT coalesce(jsonb_agg(jsonb_build_object(
    'name', r.proname, 'kind', r.prokind, 'body', r.prosrc)
    ORDER BY r.proname), '[]'::jsonb)
    FROM pg_proc r JOIN pg_namespace n ON n.oid = r.pronamespace
    WHERE n.nspname = $1)
) AS catalog`;
const catalogRowsSchema = z
  .array(
    z.strictObject({
      catalog: z.strictObject({
        columns: z.array(
          z.strictObject({
            table: z.string(),
            position: z.number().int(),
            name: z.string(),
            type: z.string(),
            notNull: z.boolean(),
            default: z.string().nullable(),
            identity: z.string(),
            generated: z.string(),
            dropped: z.boolean(),
            collation: z.string().nullable(),
          }),
        ),
        constraints: z.array(
          z.strictObject({
            name: z.string(),
            type: z.string(),
            validated: z.boolean(),
            deferrable: z.boolean(),
            deferred: z.boolean(),
            definition: z.string(),
          }),
        ),
        indexes: z.array(
          z.strictObject({
            table: z.string(),
            name: z.string(),
            definition: z.string(),
          }),
        ),
        relations: z.array(
          z.strictObject({
            name: z.string(),
            kind: z.string(),
            persistence: z.string(),
            rls: z.boolean(),
            forceRls: z.boolean(),
          }),
        ),
        triggers: z.array(
          z.strictObject({ name: z.string(), definition: z.string() }),
        ),
        routines: z.array(
          z.strictObject({
            name: z.string(),
            kind: z.string(),
            body: z.string(),
          }),
        ),
      }),
    }),
  )
  .length(1);
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
  await validateConnectorCatalogColumnContract(client);
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
  // The actual contraction must roll back along with its transaction.
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0380; new non-billing transactions are prohibited.
  await client.query("SAVEPOINT contraction");
  await client.query(contraction);
  await validateConnectorCatalogColumnContract(client);
  await client.query("ROLLBACK TO SAVEPOINT contraction");
  await client.query("RELEASE SAVEPOINT contraction");
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
  await validateConnectorCatalogColumnContract(client);
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
