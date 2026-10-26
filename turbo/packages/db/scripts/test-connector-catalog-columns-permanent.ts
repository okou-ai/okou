import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client, escapeIdentifier } from "pg";
import {
  array,
  record,
  strictObject,
  string,
  tuple,
  type infer as zInfer,
} from "zod";

import {
  physicalCatalogRows,
  physicalCatalogSql,
  catalogFrontierSql,
  catalogRowsSchema,
  contractedRequiredRows,
  preparedRequiredRows,
  requiredPointers,
  nativeIdentityRows,
  nativeIdentitySql,
  requiredRowsSql,
  requiredPermissions,
  type RequiredColumnPhase,
} from "./test-connector-catalog-frontier";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, inArray } from "drizzle-orm";
import { connectorCatalogArtifactSchema } from "@okouai/connectors/connector-catalog/artifacts/artifacts";
import { connectorCatalogEntryColumns } from "@okouai/connectors/connector-catalog/entry-columns";
import { connectorCatalogEntries } from "../src/runtime/connector-catalog";

const requiredColumns = [
  "label",
  "description",
  "category",
  "icon",
  "tags",
  "generation",
  "auth_methods",
  "skill",
  "firewall",
  "permission_summary",
];

const requiredSettings = [
  "search_path",
  "lock_timeout",
  "statement_timeout",
] as const;
function requiredShownSetting(rows: unknown, name: string) {
  const [row] = tuple([record(string(), string())]).parse(rows);
  assert.deepEqual(Object.keys(row), [name]);
  const value = row[name];
  assert.ok(value !== undefined);
  return value;
}

async function captureRequiredFrontier(
  client: Client,
  phase: RequiredColumnPhase,
  schema: string,
) {
  const result = await client.query(requiredRowsSql(phase));
  const rows =
    phase === "prepared"
      ? preparedRequiredRows.parse(result.rows)
      : contractedRequiredRows.parse(result.rows);
  const pointers = requiredPointers.parse(
    (
      await client.query(
        "SELECT schema_version, hash FROM connector_catalog ORDER BY schema_version",
      )
    ).rows,
  );
  const physical = physicalCatalogRows.parse(
    (await client.query(physicalCatalogSql, [schema])).rows,
  );
  const catalog = catalogRowsSchema.parse(
    (await client.query(catalogFrontierSql, [schema])).rows,
  );
  assert.deepEqual(
    catalog[0]?.catalog.relations.map((relation) => {
      return [relation.name, relation.kind];
    }),
    [
      ["connector_catalog", "r"],
      ["connector_catalog_entries", "r"],
      ["connector_catalog_entries_pkey", "i"],
      ["connector_catalog_pkey", "i"],
    ],
    "unexpected relations cannot be omitted from the clone",
  );
  assert.deepEqual(physical[0].catalog.triggers, []);
  assert.deepEqual(physical[0].catalog.routines, []);
  assert.deepEqual(catalog[0]?.catalog.triggers, []);
  assert.deepEqual(catalog[0]?.catalog.routines, []);
  assert.ok(
    physical[0].catalog.constraints.every((constraint) => {
      return constraint.type !== "f";
    }),
  );
  const payload = physical[0].catalog.columns.filter((column) => {
    return column.name === "payload";
  });
  if (phase === "prepared") {
    assert.equal(payload.length, 1);
    assert.equal(payload[0]?.notNull, false);
  } else {
    assert.deepEqual(payload, []);
    assert.ok(
      physical[0].catalog.columns.some((column) => {
        return column.dropped && column.attnum === 3;
      }),
    );
  }
  const permissions: {
    name: string;
    rows: zInfer<
      (typeof requiredPermissions)[keyof typeof requiredPermissions]["rows"]
    >;
  }[] = [];
  for (const [name, query] of Object.entries(requiredPermissions)) {
    const decoded = query.rows.parse(
      (await client.query(query.sql, [schema])).rows,
    );
    if (name === "policies" || name === "rules" || name === "inheritance")
      assert.deepEqual(decoded, []);
    permissions.push({ name, rows: decoded });
  }
  const settings: { name: (typeof requiredSettings)[number]; value: string }[] =
    [];
  for (const name of requiredSettings)
    settings.push({
      name,
      value: requiredShownSetting(
        (await client.query(`SHOW ${name}`)).rows,
        name,
      ),
    });
  const [identity] = nativeIdentityRows.parse(
    (await client.query(nativeIdentitySql)).rows,
  );
  return { rows, pointers, physical, catalog, permissions, settings, identity };
}

function requiredCopyValues(
  row:
    | zInfer<typeof preparedRequiredRows>[number]
    | zInfer<typeof contractedRequiredRows>[number],
  phase: RequiredColumnPhase,
) {
  const values = [
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
  ];
  if (phase === "prepared") {
    assert.ok("payload" in row && "payload_sql_null" in row);
    values.push(row.payload_sql_null ? null : JSON.stringify(row.payload));
  }
  return values;
}

async function validateRequiredColumnRejections(
  args: RequiredColumnOptions & {
    readonly hash: string;
    readonly frontier: Awaited<ReturnType<typeof captureRequiredFrontier>>;
  },
) {
  // No parent executor, callback, Query or promise crosses this ownership boundary.
  const client = new Client({ connectionString: args.databaseUrl });
  const schema = `catalog_required_${randomUUID().replaceAll("-", "")}`;
  assert.match(schema, /^catalog_required_[0-9a-f]{32}$/u);
  const identifier = escapeIdentifier(schema);
  const errors: unknown[] = [];
  const observeError = (error: Error) => {
    errors.push(error);
  };
  client.on("error", observeError);
  const settings: { name: (typeof requiredSettings)[number]; value: string }[] =
    [];
  let connected = false;
  let ownsSchema = false;
  try {
    await client.connect();
    connected = true;
    for (const name of requiredSettings)
      settings.push({
        name,
        value: requiredShownSetting(
          (await client.query(`SHOW ${name}`)).rows,
          name,
        ),
      });
    const [identity] = nativeIdentityRows.parse(
      (await client.query(nativeIdentitySql)).rows,
    );
    const { pid: parentPid, ...parentIdentity } = args.frontier.identity;
    const { pid, ...childIdentity } = identity;
    assert.deepEqual(childIdentity, parentIdentity);
    assert.notEqual(pid, parentPid);
    assert.deepEqual(
      array(strictObject({ nspname: string() })).parse(
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
      requiredShownSetting(
        (await client.query("SHOW lock_timeout")).rows,
        "lock_timeout",
      ),
      "1s",
    );
    assert.equal(
      requiredShownSetting(
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
      requiredShownSetting(
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
    // Empty replay establishes the physical phase; populated migration coverage
    // remains on the parent and the independent rejected-preparation owner.
    await client.query(args.expansion);
    await client.query(args.backfill);
    await client.query(args.preparation);
    if (args.phase === "contracted") await client.query(args.contraction);
    const copySql = `INSERT INTO connector_catalog_entries
      (hash, slug, label, description, category, icon, tags, generation,
       auth_methods, mcp, skill, firewall, permission_summary${args.phase === "prepared" ? ", payload" : ""})
      VALUES ($1::text,$2::text,$3::text,$4::text,$5::text,$6::jsonb,$7::text[],
        $8::text[],$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb,$13::jsonb${args.phase === "prepared" ? ",$14::jsonb" : ""})`;
    for (const row of args.frontier.rows) {
      const values = requiredCopyValues(row, args.phase);
      const copied = await client.query(copySql, values);
      assert.equal(copied.command, "INSERT");
      assert.equal(copied.rowCount, 1);
    }
    for (const pointer of args.frontier.pointers) {
      const copied = await client.query(
        "INSERT INTO connector_catalog (schema_version, hash) VALUES ($1::integer, $2::text)",
        [pointer.schema_version, pointer.hash],
      );
      assert.equal(copied.command, "INSERT");
      assert.equal(copied.rowCount, 1);
    }
    const before = await captureRequiredFrontier(client, args.phase, schema);
    assert.equal(before.rows.length, args.expectedRows);
    assert.deepEqual(before.rows, args.frontier.rows);
    assert.deepEqual(before.pointers, args.frontier.pointers);
    assert.deepEqual(before.permissions, args.frontier.permissions);
    assert.deepEqual(before.catalog, args.frontier.catalog);
    assert.deepEqual(
      before.physical[0].catalog.columns.map(({ oid: _oid, ...column }) => {
        return column;
      }),
      args.frontier.physical[0].catalog.columns.map(
        ({ oid: _oid, ...column }) => {
          return column;
        },
      ),
    );
    assert.deepEqual(
      before.physical[0].catalog.constraints.map(
        ({ oid: _oid, ...constraint }) => {
          return constraint;
        },
      ),
      args.frontier.physical[0].catalog.constraints.map(
        ({ oid: _oid, ...constraint }) => {
          return constraint;
        },
      ),
    );
    assert.deepEqual(
      before.physical[0].catalog.indexes,
      args.frontier.physical[0].catalog.indexes.map((index) => {
        return {
          ...index,
          definition: index.definition.replace(
            ` ${args.sourceSchema}.`,
            ` ${schema}.`,
          ),
        };
      }),
    );
    assert.deepEqual(
      before.physical[0].catalog.tables,
      args.frontier.physical[0].catalog.tables,
    );
    assert.equal(client.getTransactionStatus(), "I");
    for (const column of requiredColumns) {
      await assert.rejects(
        client.query(
          `UPDATE connector_catalog_entries SET "${column}" = NULL WHERE hash = $1`,
          [args.hash],
        ),
        (error: unknown) => {
          if (
            error instanceof Error &&
            "code" in error &&
            error.code === "23502" &&
            "column" in error &&
            error.column === column
          )
            return true;
          // Wrong native failures remain the original object for cleanup/error
          // aggregation, rather than being replaced by a predicate assertion.
          throw error;
        },
      );
      // A fulfilled real full read, not an immediate status read, fences ReadyForQuery.
      assert.deepEqual(
        await captureRequiredFrontier(client, args.phase, schema),
        before,
      );
      assert.equal(client.getTransactionStatus(), "I");
    }
  } catch (error: unknown) {
    errors.push(error);
  } finally {
    if (ownsSchema) {
      try {
        const dropped = await client.query(`DROP SCHEMA ${identifier} CASCADE`);
        assert.equal(dropped.command, "DROP");
      } catch (error: unknown) {
        errors.push(error);
      }
    }
    if (connected) {
      // Observe uncertain/unowned residue without adopting or dropping it.
      try {
        assert.deepEqual(
          array(strictObject({ nspname: string() })).parse(
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
    }
    for (const { name, value } of settings) {
      try {
        await client.query("SELECT set_config($1, $2, false)", [name, value]);
      } catch (error: unknown) {
        errors.push(error);
      }
      try {
        assert.equal(
          requiredShownSetting((await client.query(`SHOW ${name}`)).rows, name),
          value,
        );
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
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "Required column rejection or disposal failed",
      { cause: errors[0] },
    );
}

type RequiredColumnOptions = {
  readonly databaseUrl: string;
  readonly sourceSchema: string;
  readonly phase: RequiredColumnPhase;
  readonly expectedRows: 41 | 42 | 59;
  readonly expansion: string;
  readonly backfill: string;
  readonly preparation: string;
  readonly contraction: string;
};

// Only positive work and frontier capture use the caller's existing connection.
// The rejection owner below receives ordinary values and opens its own Client.
export async function validateConnectorCatalogColumnContract(
  client: Client,
  args: RequiredColumnOptions,
) {
  const raw: unknown = JSON.parse(
    await readFile(
      new URL(
        "../../connectors/src/__tests__/fixtures/published-v4-catalog.json",
        import.meta.url,
      ),
      "utf8",
    ),
  );
  const catalog = connectorCatalogArtifactSchema.parse(raw);
  const nonMcp = catalog.connectors.find((connector) => {
    return connector.mcp === undefined;
  });
  const mcp = catalog.connectors.find((connector) => {
    return connector.mcp !== undefined;
  });
  assert.ok(nonMcp);
  assert.ok(mcp);
  const hash = `column-contract-${randomUUID()}`;
  const expected = [nonMcp, mcp]
    .map((connector) => {
      return {
        hash,
        slug: connector.slug,
        ...connectorCatalogEntryColumns(connector),
      };
    })
    .sort((a, b) => {
      return a.slug.localeCompare(b.slug);
    });
  const db = drizzle(client);
  const errors: unknown[] = [];
  const slugs = expected.map((entry) => {
    return entry.slug;
  });
  assert.equal(new Set(slugs).size, 2);
  const before = await captureRequiredFrontier(
    client,
    args.phase,
    args.sourceSchema,
  );
  assert.equal(before.rows.length, args.expectedRows - 2);
  assert.deepEqual(
    before.rows.filter((row) => {
      return row.hash === hash;
    }),
    [],
    "a collision grants no right to mutate or clean that generation",
  );
  let ownsEntries = false;
  try {
    ownsEntries = true;
    const inserted = await db
      .insert(connectorCatalogEntries)
      .values(expected)
      .returning();
    assert.deepEqual(inserted, expected);
    const selected = await db
      .select()
      .from(connectorCatalogEntries)
      .where(eq(connectorCatalogEntries.hash, hash))
      .orderBy(connectorCatalogEntries.slug);
    assert.deepEqual(selected, expected);
    // A same-hash retry preserves the immutable preparation receipt.
    const retried = await db
      .insert(connectorCatalogEntries)
      .values(
        expected.map((entry) => {
          return {
            ...entry,
            label: "retry must not replace an existing entry",
            permissionSummary: {
              ...entry.permissionSummary,
              hasDefaultPolicyOverrides:
                !entry.permissionSummary.hasDefaultPolicyOverrides,
            },
          };
        }),
      )
      .onConflictDoNothing()
      .returning();
    assert.deepEqual(retried, []);
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalogEntries)
        .where(eq(connectorCatalogEntries.hash, hash))
        .orderBy(connectorCatalogEntries.slug),
      expected,
      "same-hash retry must not recompute stored summaries or overwrite projections",
    );

    const frontier = await captureRequiredFrontier(
      client,
      args.phase,
      args.sourceSchema,
    );
    assert.equal(frontier.rows.length, args.expectedRows);
    assert.equal(frontier.pointers.length, 1);
    assert.equal(client.getTransactionStatus(), "I");
    try {
      await validateRequiredColumnRejections({ ...args, hash, frontier });
    } catch (error: unknown) {
      errors.push(error);
    }
    // This real read also fences the caller after the independent child ends.
    try {
      assert.deepEqual(
        await captureRequiredFrontier(client, args.phase, args.sourceSchema),
        frontier,
      );
      assert.equal(client.getTransactionStatus(), "I");
    } catch (error: unknown) {
      errors.push(error);
    }
  } catch (error: unknown) {
    errors.push(error);
  } finally {
    if (ownsEntries) {
      try {
        await db
          .delete(connectorCatalogEntries)
          .where(
            and(
              eq(connectorCatalogEntries.hash, hash),
              inArray(connectorCatalogEntries.slug, slugs),
            ),
          );
      } catch (error: unknown) {
        errors.push(error);
      }
      try {
        assert.deepEqual(
          await db
            .select()
            .from(connectorCatalogEntries)
            .where(eq(connectorCatalogEntries.hash, hash)),
          [],
          "the complete owned hash is absent after two-slug disposal",
        );
      } catch (error: unknown) {
        errors.push(error);
      }
      try {
        assert.deepEqual(
          await captureRequiredFrontier(client, args.phase, args.sourceSchema),
          before,
          "unrelated complete rows, pointer, catalog, permissions and session survive disposal",
        );
      } catch (error: unknown) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "Transitional column contract or disposal failed",
      { cause: errors[0] },
    );
}

export async function validatePermanentConnectorCatalogColumns(
  databaseUrl: string,
) {
  // The migration suite owns an exclusive disposable database. This owner never
  // calls the transitional SAVEPOINT helper above or changes its search_path.
  const client = new Client({ connectionString: databaseUrl });
  const db = drizzle(client);
  const errors: unknown[] = [];
  const observeError = (error: Error) => {
    errors.push(error);
  };
  client.on("error", observeError);
  const hash = `column-contract-${randomUUID()}`;
  const slugs: string[] = [];
  let connected = false;
  let ownsEntries = false;
  try {
    const raw: unknown = JSON.parse(
      await readFile(
        new URL(
          "../../connectors/src/__tests__/fixtures/published-v4-catalog.json",
          import.meta.url,
        ),
        "utf8",
      ),
    );
    const catalog = connectorCatalogArtifactSchema.parse(raw);
    const nonMcp = catalog.connectors.find((connector) => {
      return connector.mcp === undefined;
    });
    const mcp = catalog.connectors.find((connector) => {
      return connector.mcp !== undefined;
    });
    assert.ok(nonMcp);
    assert.ok(mcp);
    const expected = [nonMcp, mcp]
      .map((connector) => {
        return {
          hash,
          slug: connector.slug,
          ...connectorCatalogEntryColumns(connector),
        };
      })
      .sort((a, b) => {
        return a.slug.localeCompare(b.slug);
      });
    slugs.push(
      ...expected.map((entry) => {
        return entry.slug;
      }),
    );
    assert.equal(new Set(slugs).size, 2);

    await client.connect();
    connected = true;
    assert.deepEqual(
      (await client.query("SELECT current_schema() AS schema")).rows,
      [{ schema: "public" }],
      "permanent probes must address the public schema",
    );
    const payload = await client.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'connector_catalog_entries'
         AND column_name = 'payload'`,
    );
    assert.deepEqual(payload.rows, [], "payload is physically retired");
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalogEntries)
        .where(eq(connectorCatalogEntries.hash, hash)),
      [],
      "a collision grants no right to mutate or clean that generation",
    );
    if (errors.length > 0) throw errors[0];
    // The empty precondition is scoped to this exclusive job database; it is
    // not concurrency arbitration for a shared application database.
    ownsEntries = true;

    const inserted = await db
      .insert(connectorCatalogEntries)
      .values(expected)
      .returning();
    assert.deepEqual(inserted, expected);
    const selected = await db
      .select()
      .from(connectorCatalogEntries)
      .where(eq(connectorCatalogEntries.hash, hash))
      .orderBy(connectorCatalogEntries.slug);
    assert.deepEqual(selected, expected);
    const retried = await db
      .insert(connectorCatalogEntries)
      .values(
        expected.map((entry) => {
          return {
            ...entry,
            label: "retry must not replace an existing entry",
            permissionSummary: {
              ...entry.permissionSummary,
              hasDefaultPolicyOverrides:
                !entry.permissionSummary.hasDefaultPolicyOverrides,
            },
          };
        }),
      )
      .onConflictDoNothing()
      .returning();
    assert.deepEqual(retried, []);
    assert.deepEqual(
      await db
        .select()
        .from(connectorCatalogEntries)
        .where(eq(connectorCatalogEntries.hash, hash))
        .orderBy(connectorCatalogEntries.slug),
      expected,
      "same-hash retry must not recompute stored summaries or overwrite projections",
    );

    for (const column of requiredColumns) {
      // Each UPDATE is one autocommit statement. Keep the native pg error,
      // including its exact column, rather than accepting an ORM wrapper.
      await assert.rejects(
        client.query(
          `UPDATE connector_catalog_entries SET "${column}" = NULL WHERE hash = $1`,
          [hash],
        ),
        (error: unknown) => {
          return (
            error instanceof Error &&
            "code" in error &&
            error.code === "23502" &&
            "column" in error &&
            error.column === column
          );
        },
      );
      // Await the same client's next real query: both rows must survive every
      // failed statement, and the client must remain usable without recovery SQL.
      assert.deepEqual(
        await db
          .select()
          .from(connectorCatalogEntries)
          .where(eq(connectorCatalogEntries.hash, hash))
          .orderBy(connectorCatalogEntries.slug),
        expected,
        `failed ${column} probe preserves both complete projections`,
      );
    }
    if (errors.length > 0) throw errors[0];
  } catch (error: unknown) {
    errors.push(error);
  } finally {
    if (connected && ownsEntries) {
      // No broad hash deletion: these two slugs are the only owned entries.
      try {
        await db
          .delete(connectorCatalogEntries)
          .where(
            and(
              eq(connectorCatalogEntries.hash, hash),
              inArray(connectorCatalogEntries.slug, slugs),
            ),
          );
      } catch (error: unknown) {
        errors.push(error);
      }
      // Observe cleanup separately even when DELETE failed. Never adopt or
      // delete unexpected third-slug rows merely to make this assertion pass.
      try {
        assert.deepEqual(
          await db
            .select()
            .from(connectorCatalogEntries)
            .where(eq(connectorCatalogEntries.hash, hash)),
          [],
          "the owned generation is absent after disposal",
        );
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
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Permanent catalog columns or disposal failed",
      {
        cause: errors[0],
      },
    );
  }
}
