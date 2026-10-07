import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import {
  connectorCatalogArtifactSchema,
  type ConnectorCatalogArtifactConnector,
} from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import {
  compactConnectorCatalogDefaultPolicy,
  connectorCatalogEntryColumns,
  connectorCatalogPermissionSummary,
} from "@okouai/connectors/connector-catalog/entry-columns";
import { connectorCatalogEntries } from "../src/schema/connector-catalog";

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
  // Neither migration may assume only the currently published hash matters.
  for (const hash of ["historical", "current"]) {
    for (const connector of connectors) {
      await client.query(
        "INSERT INTO connector_catalog_entries VALUES ($1, $2, $3)",
        [hash, connector.slug, JSON.stringify(connector)],
      );
    }
  }
  await client.query(expansion);
  await client.query(backfill);
  const rows = await db.select().from(connectorCatalogEntries);
  assert.equal(rows.length, connectors.length * 2);
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
  console.log(
    `Catalog entry expansion/backfill: ${rows.length} rows across historical/current hashes, ${cases.length} summary boundaries, outgoing/new writer coexistence, idempotent retry`,
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
