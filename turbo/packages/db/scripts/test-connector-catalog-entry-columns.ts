import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
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
const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
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
    "../src/migrations/1349_drop_connector_catalog_payload.sql",
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
  return connector.mcp === undefined && connector.firewall.kind === "generated";
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

try {
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
  // Fail closed on an incomplete retained projection; DDL rollback must keep
  // the old NOT NULL payload contract intact. No automatic data rewrite.
  await client.query(
    "UPDATE connector_catalog_entries SET label = NULL WHERE hash = 'historical'",
  );
  await client.query("SAVEPOINT preparation");
  await assert.rejects(client.query(preparation), (error: unknown) => {
    return error instanceof Error && "code" in error && error.code === "23502";
  });
  await client.query("ROLLBACK TO SAVEPOINT preparation");
  const payloadConstraint = await client.query(
    `SELECT is_nullable FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = 'connector_catalog_entries'
       AND column_name = 'payload'`,
    [testSchema],
  );
  assert.deepEqual(payloadConstraint.rows, [{ is_nullable: "NO" }]);
  await client.query(
    `UPDATE connector_catalog_entries SET label = payload ->> 'label'
     WHERE hash = 'historical'`,
  );
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
  // DROP is incompatible with a still-serving dual writer. This rejection
  // makes the separate preparation-release/drain boundary explicit.
  await client.query("SAVEPOINT retired_writer");
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
  await client.query("ROLLBACK TO SAVEPOINT retired_writer");
  await client.query("RELEASE SAVEPOINT retired_writer");
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
  console.log(
    `Catalog entry expansion/backfill/preparation/contraction: ${rows.length} retained rows, ${cases.length} summary boundaries, transactional DDL rollback, outgoing/new writers, unchanged identity/projections/pointer, post-DROP runtime reads`,
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
