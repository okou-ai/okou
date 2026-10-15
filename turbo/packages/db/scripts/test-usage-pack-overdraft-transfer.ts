import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { PgDialect } from "drizzle-orm/pg-core";
import { usagePackOverdraftTransferSql } from "../src/operations/usage-pack-overdraft-transfer";

// These are historical fixture columns, not the current production schemas.
const int8Text = z.string().regex(/^-?\d+$/);
const timestampText = z.string().min(1);
const fixtureTables = [
  {
    name: "org_metadata",
    columns: ["org_id", "credits", "updated_at"],
    casts: ["text", "bigint", "timestamp"],
    row: z.tuple([z.string(), int8Text, timestampText.nullable()]),
  },
  {
    name: "credit_expires_record",
    columns: ["id", "org_id", "remaining", "expires_at"],
    casts: ["uuid", "text", "bigint", "timestamp"],
    row: z.tuple([z.uuid(), z.string(), int8Text, timestampText]),
  },
  {
    name: "usage_pack_credit_grants",
    columns: [
      "id",
      "org_id",
      "user_id",
      "grant_type",
      "original_amount",
      "remaining_amount",
      "expires_at",
      "idempotency_key",
    ],
    casts: [
      "uuid",
      "text",
      "text",
      "text",
      "bigint",
      "bigint",
      "timestamp",
      "text",
    ],
    row: z.tuple([
      z.uuid(),
      z.string(),
      z.string(),
      z.string(),
      int8Text,
      int8Text,
      timestampText,
      z.string(),
    ]),
  },
  {
    name: "usage_pack_overdraft_transfers",
    columns: [
      "id",
      "org_id",
      "user_id",
      "credit_grant_id",
      "amount",
      "created_at",
    ],
    casts: ["uuid", "text", "text", "uuid", "bigint", "timestamp"],
    row: z.tuple([
      z.uuid(),
      z.string(),
      z.string(),
      z.uuid(),
      int8Text,
      timestampText,
    ]),
  },
];
const textField = z.strictObject({
  name: z.string(),
  tableID: z.number().int().nonnegative(),
  columnID: z.number().int().nonnegative(),
  dataTypeID: z.literal(25),
  dataTypeSize: z.literal(-1),
  dataTypeModifier: z.literal(-1),
  format: z.literal("text"),
});
function textRows(
  result: unknown,
  names: readonly string[],
  provenance?: readonly { tableID: string; columnID: number }[],
  command: "SELECT" | "SHOW" = "SELECT",
) {
  const parsed = z
    .object({
      command: z.literal(command),
      rowCount: command === "SHOW" ? z.null() : z.number().int().nonnegative(),
      fields: z.array(textField),
      rows: z.array(z.array(z.string().nullable())),
    })
    .parse(result);
  assert.deepEqual(
    parsed.fields.map((field) => {
      return field.name;
    }),
    names,
  );
  for (const [index, field] of parsed.fields.entries()) {
    const expected = provenance?.[index];
    assert.equal(field.tableID.toString(), expected ? expected.tableID : "0");
    assert.equal(field.columnID, expected ? expected.columnID : 0);
  }
  assert.equal(parsed.rows.length, command === "SHOW" ? 1 : parsed.rowCount);
  for (const row of parsed.rows) assert.equal(row.length, names.length);
  return parsed.rows;
}
function commandAck(
  result: unknown,
  command: string,
  rowCount: number | null = null,
) {
  const parsed = z
    .object({
      command: z.string(),
      rowCount: z.number().nullable(),
      rows: z.array(z.unknown()),
    })
    .parse(result);
  assert.equal(parsed.command, command);
  assert.equal(parsed.rowCount, rowCount);
  assert.deepEqual(parsed.rows, []);
}
function fixtureSelect(table: (typeof fixtureTables)[number]) {
  return `SELECT ${table.columns
    .map((column) => {
      return `"${column}"::text`;
    })
    .join(",")} FROM "${table.name}" ORDER BY "${table.columns[0]}"`;
}

// Full native catalog records are retained per scope. JSON here is only a
// read representation: every catalog value is converted to text on the server.
const catalogSources = [
  ["namespace", "SELECT n.* FROM pg_catalog.pg_namespace n WHERE n.nspname=$1"],
  [
    "relations",
    "SELECT c.* FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
  ],
  [
    "attributes",
    "SELECT a.* FROM pg_catalog.pg_attribute a JOIN pg_catalog.pg_class c ON c.oid=a.attrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
  ],
  [
    "defaults",
    "SELECT d.* FROM pg_catalog.pg_attrdef d JOIN pg_catalog.pg_class c ON c.oid=d.adrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
  ],
  [
    "constraints",
    "SELECT c.* FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1",
  ],
  [
    "indexes",
    "SELECT i.* FROM pg_catalog.pg_index i JOIN pg_catalog.pg_class c ON c.oid=i.indrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
  ],
  [
    "types",
    "SELECT t.* FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1",
  ],
  [
    "sequences",
    "SELECT s.* FROM pg_catalog.pg_sequence s JOIN pg_catalog.pg_class c ON c.oid=s.seqrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
  ],
  [
    "triggers",
    "SELECT t.* FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid=t.tgrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
  ],
  [
    "policies",
    "SELECT p.* FROM pg_catalog.pg_policy p JOIN pg_catalog.pg_class c ON c.oid=p.polrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
  ],
  [
    "routines",
    "SELECT p.* FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=$1",
  ],
  [
    "rewrites",
    "SELECT r.* FROM pg_catalog.pg_rewrite r JOIN pg_catalog.pg_class c ON c.oid=r.ev_class JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
  ],
  [
    "inheritance",
    "SELECT i.* FROM pg_catalog.pg_inherits i JOIN pg_catalog.pg_class c ON c.oid=i.inhrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1",
  ],
  [
    "dependencies",
    `SELECT d.* FROM pg_catalog.pg_depend d WHERE
    (d.classid='pg_class'::regclass AND d.objid IN (SELECT c.oid FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)) OR
    (d.classid='pg_type'::regclass AND d.objid IN (SELECT t.oid FROM pg_catalog.pg_type t JOIN pg_catalog.pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname=$1)) OR
    (d.classid='pg_attrdef'::regclass AND d.objid IN (SELECT a.oid FROM pg_catalog.pg_attrdef a JOIN pg_catalog.pg_class c ON c.oid=a.adrelid JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1)) OR
    (d.classid='pg_constraint'::regclass AND d.objid IN (SELECT c.oid FROM pg_catalog.pg_constraint c JOIN pg_catalog.pg_namespace n ON n.oid=c.connamespace WHERE n.nspname=$1))`,
  ],
];
const catalogRecord = z.record(z.string(), z.string().nullable());
const catalogSchema = z.record(z.string(), z.array(catalogRecord));
type Catalog = z.infer<typeof catalogSchema>;
function fixtureRows(
  result: unknown,
  table: (typeof fixtureTables)[number],
  catalog: Catalog,
) {
  const relation = catalogGroup(catalog, "relations").find((row) => {
    return row.relname === table.name;
  });
  assert.ok(relation);
  const tableID = catalogValue(relation, "oid");
  return z.array(table.row).parse(
    textRows(
      result,
      table.columns,
      table.casts.map((cast, index) => {
        return cast === "text"
          ? { tableID, columnID: index + 1 }
          : { tableID: "0", columnID: 0 };
      }),
    ),
  );
}

function catalogSelect(source: string) {
  return `SELECT (SELECT jsonb_object_agg(key,value) FROM jsonb_each_text(to_jsonb(fact)))::text AS catalog FROM (${source}) fact ORDER BY catalog`;
}
function catalogRows(result: unknown) {
  return textRows(result, ["catalog"]).map(([value]) => {
    assert.ok(value !== null && value !== undefined);
    return catalogRecord.parse(JSON.parse(value));
  });
}
function catalogGroup(catalog: Catalog, name: string) {
  const rows = catalog[name];
  assert.ok(rows, `Missing catalog group ${name}`);
  return rows;
}
function catalogValue(row: z.infer<typeof catalogRecord>, key: string) {
  const value = row[key];
  assert.ok(
    value !== null && value !== undefined,
    `Missing catalog field ${key}`,
  );
  return value;
}
function logicalCatalog(catalog: Catalog) {
  const relations = new Map(
    catalogGroup(catalog, "relations").map((row) => {
      return [catalogValue(row, "oid"), catalogValue(row, "relname")];
    }),
  );
  const maps = new Map([
    ["1259", relations],
    [
      "2615",
      new Map(
        catalogGroup(catalog, "namespace").map((row) => {
          return [catalogValue(row, "oid"), "fixture"];
        }),
      ),
    ],
    [
      "1247",
      new Map(
        catalogGroup(catalog, "types").map((row) => {
          return [catalogValue(row, "oid"), catalogValue(row, "typname")];
        }),
      ),
    ],
    [
      "2604",
      new Map(
        catalogGroup(catalog, "defaults").map((row) => {
          const relation = relations.get(catalogValue(row, "adrelid"));
          assert.ok(relation);
          return [
            catalogValue(row, "oid"),
            `${relation}.${catalogValue(row, "adnum")}`,
          ];
        }),
      ),
    ],
    [
      "2606",
      new Map(
        catalogGroup(catalog, "constraints").map((row) => {
          const relation = relations.get(catalogValue(row, "conrelid"));
          assert.ok(relation);
          return [
            catalogValue(row, "oid"),
            `${relation}.${catalogValue(row, "conname")}`,
          ];
        }),
      ),
    ],
  ]);
  const identities: Record<string, Record<string, string>> = {
    namespace: { oid: "2615" },
    relations: {
      oid: "1259",
      relnamespace: "2615",
      reltype: "1247",
      reloftype: "1247",
    },
    attributes: { attrelid: "1259", atttypid: "1247" },
    defaults: { oid: "2604", adrelid: "1259" },
    constraints: {
      oid: "2606",
      connamespace: "2615",
      conrelid: "1259",
      conindid: "1259",
      confrelid: "1259",
      contypid: "1247",
    },
    indexes: { indexrelid: "1259", indrelid: "1259" },
    types: {
      oid: "1247",
      typnamespace: "2615",
      typrelid: "1259",
      typelem: "1247",
      typarray: "1247",
    },
    dependencies: {},
    sequences: {},
    triggers: {},
    policies: {},
    routines: {},
    rewrites: {},
    inheritance: {},
  };
  const logical: Catalog = {};
  for (const [group, rows] of Object.entries(catalog)) {
    const fields = identities[group];
    assert.ok(fields);
    logical[group] = rows
      .map((source) => {
        const row = { ...source };
        for (const [key, domain] of Object.entries(fields)) {
          const value = catalogValue(row, key);
          const own = maps.get(domain)?.get(value);
          if (own !== undefined) row[key] = `<own:${own}>`;
        }
        if (group === "namespace") row.nspname = "<fixture>";
        if (group === "dependencies") {
          for (const [domainKey, objectKey] of [
            ["classid", "objid"],
            ["refclassid", "refobjid"],
          ]) {
            assert.ok(domainKey && objectKey);
            const own = maps
              .get(catalogValue(row, domainKey))
              ?.get(catalogValue(row, objectKey));
            if (own !== undefined) row[objectKey] = `<own:${own}>`;
          }
        }
        if (group === "relations") {
          // Physical allocation/vacuum facts differ in newly created scopes.
          // They stay intact in the raw same-scope before/after comparisons.
          for (const key of [
            "relfilenode",
            "reltoastrelid",
            "relpages",
            "reltuples",
            "relallvisible",
            "relallfrozen",
            "relfrozenxid",
            "relminmxid",
          ])
            delete row[key];
        }
        return row;
      })
      .sort((a, b) => {
        return JSON.stringify(a).localeCompare(JSON.stringify(b));
      });
  }
  return logical;
}
function historicalCatalog(catalog: Catalog) {
  assert.equal(catalogGroup(catalog, "namespace").length, 1);
  assert.deepEqual(
    catalogGroup(catalog, "relations")
      .filter((row) => {
        return row.relkind === "r";
      })
      .map((row) => {
        return row.relname;
      })
      .sort(),
    fixtureTables
      .map((table) => {
        return table.name;
      })
      .sort(),
  );
  assert.equal(catalogGroup(catalog, "indexes").length, 5);
  for (const group of [
    "sequences",
    "triggers",
    "policies",
    "routines",
    "rewrites",
    "inheritance",
  ])
    assert.deepEqual(catalogGroup(catalog, group), [], group);
  assert.ok(
    catalogGroup(catalog, "attributes").every((row) => {
      return row.attidentity === "" && row.attgenerated === "";
    }),
  );
  assert.ok(
    catalogGroup(catalog, "constraints").every((row) => {
      return row.contype !== "f";
    }),
  );
  // Defaults must depend on builtins or their own columns, never local routines.
  const localRoutines = new Set(
    catalogGroup(catalog, "routines").map((row) => {
      return row.oid;
    }),
  );
  assert.ok(
    catalogGroup(catalog, "dependencies").every((row) => {
      return row.refclassid !== "1255" || !localRoutines.has(row.refobjid);
    }),
  );
}
const sessionSql = `SELECT current_setting('TimeZone') AS timezone, current_setting('DateStyle') AS datestyle, current_setting('search_path') AS path`;
const sessionTuple = z.tuple([z.string(), z.string(), z.string()]);
const parentSessionSql = `SELECT current_setting('TimeZone') AS timezone, current_setting('DateStyle') AS datestyle, current_setting('search_path') AS path, now()::text AS cohort, txid_current()::text AS transaction, pg_backend_pid()::text AS backend`;
const parentSessionTuple = z.tuple([
  z.string(),
  z.string(),
  z.string(),
  timestampText,
  int8Text,
  int8Text.refine((value) => {
    return BigInt(value) > 0n;
  }),
]);
const absenceSql =
  "SELECT count(*)::text AS count FROM pg_catalog.pg_namespace WHERE nspname=$1";
type FixtureRows = (string | null)[][][];

async function expectMissingWalletRepair(input: {
  readonly databaseUrl: string;
  readonly rows: FixtureRows;
  readonly catalog: Catalog;
  readonly timezone: string;
  readonly datestyle: string;
  readonly ddl: string;
  readonly auditDDL: string;
  readonly repair: string;
}) {
  const aux = new Client({ connectionString: input.databaseUrl });
  const schema = `pack_transfer_negative_${randomUUID().replaceAll("-", "")}`;
  const errors: unknown[] = [];
  let connected = false;
  let owned = false;
  let oldSettings: z.infer<typeof sessionTuple> | undefined;
  // These closures stay inside this connection owner and never escape it.
  const capture = async () => {
    const catalog: Catalog = {};
    for (const [group, source] of catalogSources) {
      assert.ok(group && source);
      catalog[group] = catalogRows(
        await aux.query({
          text: catalogSelect(source),
          values: [schema],
          rowMode: "array",
        }),
      );
    }
    const rows: FixtureRows = [];
    for (const table of fixtureTables)
      rows.push(
        fixtureRows(
          await aux.query({ text: fixtureSelect(table), rowMode: "array" }),
          table,
          catalog,
        ),
      );
    historicalCatalog(catalogSchema.parse(catalog));
    return { rows, catalog };
  };
  const attempt = async (action: () => Promise<void>) => {
    try {
      await action();
    } catch (error) {
      errors.push(error);
    }
  };
  try {
    await aux.connect();
    connected = true;
    oldSettings = sessionTuple.parse(
      textRows(await aux.query({ text: sessionSql, rowMode: "array" }), [
        "timezone",
        "datestyle",
        "path",
      ])[0],
    );
    assert.deepEqual(
      textRows(
        await aux.query({
          text: absenceSql,
          values: [schema],
          rowMode: "array",
        }),
        ["count"],
      ),
      [["0"]],
    );
    const created = await aux.query(`CREATE SCHEMA "${schema}"`);
    commandAck(created, "CREATE");
    owned = true;
    for (const [setting, value] of [
      ["search_path", `"${schema}"`],
      ["TimeZone", input.timezone],
      ["DateStyle", input.datestyle],
    ]) {
      assert.ok(setting && value);
      assert.deepEqual(
        textRows(
          await aux.query({
            text: "SELECT set_config($1,$2,false) AS setting",
            values: [setting, value],
            rowMode: "array",
          }),
          ["setting"],
        ),
        [[value]],
      );
    }
    assert.deepEqual(
      sessionTuple.parse(
        textRows(await aux.query({ text: sessionSql, rowMode: "array" }), [
          "timezone",
          "datestyle",
          "path",
        ])[0],
      ),
      [input.timezone, input.datestyle, `"${schema}"`],
    );
    const ddlResults = z
      .array(z.unknown())
      .length(3)
      .parse(await aux.query(input.ddl));
    for (const result of ddlResults) commandAck(result, "CREATE");
    const auditResults = z
      .array(z.unknown())
      .length(2)
      .parse(await aux.query(input.auditDDL));
    for (const result of auditResults) commandAck(result, "CREATE");
    assert.equal(input.rows.length, fixtureTables.length);
    for (const [index, table] of fixtureTables.entries()) {
      const rows = z.array(table.row).parse(input.rows[index]);
      const insert = `INSERT INTO "${table.name}" (${table.columns
        .map((column) => {
          return `"${column}"`;
        })
        .join(",")}) VALUES (${table.casts
        .map((cast, position) => {
          return `$${position + 1}::${cast}`;
        })
        .join(",")})`;
      for (const row of rows) {
        const values: (string | null)[] = [...row];
        commandAck(await aux.query(insert, values), "INSERT", 1);
      }
    }
    const mirrored = await capture();
    assert.deepEqual(mirrored.rows, input.rows);
    assert.deepEqual(
      logicalCatalog(mirrored.catalog),
      logicalCatalog(input.catalog),
    );
    commandAck(
      await aux.query(
        `INSERT INTO usage_pack_credit_grants VALUES ('00000000-0000-4000-a000-000000000006', 'missing_wallet', 'eve', 'bonus', 10, -3, '2099-01-01', 'missing-source')`,
      ),
      "INSERT",
      1,
    );
    const negative = await capture();
    const repair = input.repair;
    await assert.rejects(aux.query(repair), /no organization wallet/);
    assert.deepEqual(await capture(), negative);
    assert.equal(
      negative.rows[2]?.find((row) => {
        return row[0] === "00000000-0000-4000-a000-000000000006";
      })?.[5],
      "-3",
    );
  } catch (error) {
    errors.push(error);
  } finally {
    // A collision or unknown CREATE ACK is unowned: never adopt/drop/retry it.
    // Committed auxiliary fixtures can survive SIGKILL. Use a disposable job.
    if (owned)
      await attempt(async () => {
        commandAck(await aux.query(`DROP SCHEMA "${schema}" CASCADE`), "DROP");
      });
    if (connected)
      await attempt(async () => {
        assert.deepEqual(
          textRows(
            await aux.query({
              text: absenceSql,
              values: [schema],
              rowMode: "array",
            }),
            ["count"],
          ),
          [["0"]],
        );
      });
    if (oldSettings) {
      for (const setting of [
        { name: "search_path", value: oldSettings[2] },
        { name: "TimeZone", value: oldSettings[0] },
        { name: "DateStyle", value: oldSettings[1] },
      ]) {
        await attempt(async () => {
          assert.deepEqual(
            textRows(
              await aux.query({
                text: "SELECT set_config($1,$2,false) AS setting",
                values: [setting.name, setting.value],
                rowMode: "array",
              }),
              ["setting"],
            ),
            [[setting.value]],
          );
        });
        await attempt(async () => {
          assert.deepEqual(
            textRows(
              await aux.query({
                text: `SHOW ${setting.name}`,
                rowMode: "array",
              }),
              [setting.name],
              undefined,
              "SHOW",
            ),
            [[setting.value]],
          );
        });
      }
    }
    await attempt(async () => {
      await aux.end();
    });
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1)
    throw new AggregateError(
      errors,
      "Missing-wallet repair and resource cleanup failed",
      { cause: errors[0] },
    );
}

const setup = `
    CREATE TABLE org_metadata (org_id text PRIMARY KEY, credits bigint NOT NULL, updated_at timestamp);
    CREATE TABLE credit_expires_record (id uuid PRIMARY KEY, org_id text NOT NULL, remaining bigint NOT NULL, expires_at timestamp NOT NULL);
    CREATE TABLE usage_pack_credit_grants (
      id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL,
      grant_type text NOT NULL, original_amount bigint NOT NULL,
      remaining_amount bigint NOT NULL, expires_at timestamp NOT NULL,
      idempotency_key text NOT NULL
    );
    INSERT INTO org_metadata (org_id, credits) VALUES ('positive', 20), ('negative', -5), ('unchanged', 50);
    INSERT INTO usage_pack_credit_grants VALUES
      ('00000000-0000-4000-a000-000000000001', 'positive', 'alice', 'purchased', 10, -3, '2099-01-01', 'paid-source'),
      ('00000000-0000-4000-a000-000000000002', 'positive', 'bob', 'bonus', 10, -4, '2020-01-01', 'expired-source'),
      ('00000000-0000-4000-a000-000000000003', 'negative', 'charlie', 'bonus', 10, -6, '2099-01-01', 'bonus-source'),
      ('00000000-0000-4000-a000-000000000004', 'unchanged', 'alice', 'purchased', 10, 8, '2099-01-01', 'positive-source');
  `;

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
const schema = `pack_transfer_${randomUUID().replaceAll("-", "")}`;
const errors: unknown[] = [];
let connected = false;
let owned = false;
let oldSettings: z.infer<typeof sessionTuple> | undefined;
try {
  await client.connect();
  connected = true;
  assert.equal(client.getTransactionStatus(), "I");
  oldSettings = z
    .tuple([sessionTuple])
    .parse(
      textRows(await client.query({ text: sessionSql, rowMode: "array" }), [
        "timezone",
        "datestyle",
        "path",
      ]),
    )[0];
  assert.equal(client.getTransactionStatus(), "I");
  assert.deepEqual(
    textRows(
      await client.query({
        text: absenceSql,
        values: [schema],
        rowMode: "array",
      }),
      ["count"],
    ),
    [["0"]],
  );
  assert.equal(client.getTransactionStatus(), "I");
  commandAck(await client.query(`CREATE SCHEMA "${schema}"`), "CREATE");
  owned = true;
  assert.equal(client.getTransactionStatus(), "I");
  assert.deepEqual(
    textRows(
      await client.query({
        text: "SELECT set_config($1,$2,false) AS setting",
        values: ["search_path", `"${schema}"`],
        rowMode: "array",
      }),
      ["setting"],
    ),
    [[`"${schema}"`]],
  );
  assert.equal(client.getTransactionStatus(), "I");
  assert.deepEqual(
    textRows(await client.query({ text: sessionSql, rowMode: "array" }), [
      "timezone",
      "datestyle",
      "path",
    ]),
    [[oldSettings[0], oldSettings[1], `"${schema}"`]],
  );
  assert.equal(client.getTransactionStatus(), "I");
  await client.query(setup);
  const migration = await readFile(
    new URL(
      "../src/migrations/1346_usage_pack_overdraft_transfers.sql",
      import.meta.url,
    ),
    "utf8",
  );
  await client.query(migration);
  assert.deepEqual(
    (
      await client.query(
        "SELECT org_id, credits::text FROM org_metadata ORDER BY org_id",
      )
    ).rows,
    [
      { org_id: "negative", credits: "-11" },
      { org_id: "positive", credits: "13" },
      { org_id: "unchanged", credits: "50" },
    ],
  );
  const grants = (
    await client.query(
      "SELECT idempotency_key, grant_type, original_amount::text, remaining_amount::text FROM usage_pack_credit_grants ORDER BY id",
    )
  ).rows;
  assert.deepEqual(grants, [
    {
      idempotency_key: "paid-source",
      grant_type: "purchased",
      original_amount: "10",
      remaining_amount: "0",
    },
    {
      idempotency_key: "expired-source",
      grant_type: "bonus",
      original_amount: "10",
      remaining_amount: "0",
    },
    {
      idempotency_key: "bonus-source",
      grant_type: "bonus",
      original_amount: "10",
      remaining_amount: "0",
    },
    {
      idempotency_key: "positive-source",
      grant_type: "purchased",
      original_amount: "10",
      remaining_amount: "8",
    },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT sum(amount)::text AS amount FROM usage_pack_overdraft_transfers",
      )
    ).rows[0]?.amount,
    "13",
  );
  // The repair portion is restart-safe: after zeroing there is nothing to move.
  const repair = migration.slice(migration.indexOf("DO $$"));
  await client.query(repair);
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::text AS count FROM usage_pack_overdraft_transfers",
      )
    ).rows[0]?.count,
    "3",
  );
  assert.equal(
    (await client.query("SELECT sum(credits)::text AS total FROM org_metadata"))
      .rows[0]?.total,
    "52",
  );
  await client.query(`
    INSERT INTO org_metadata (org_id, credits) VALUES ('expired_wallet', 10);
    INSERT INTO credit_expires_record VALUES ('00000000-0000-4000-a000-000000000010', 'expired_wallet', 20, '2020-01-01');
    INSERT INTO usage_pack_credit_grants VALUES ('00000000-0000-4000-a000-000000000005', 'expired_wallet', 'dana', 'bonus', 10, -2, '2020-01-01', 'expired-wallet-source');
  `);
  await client.query(repair);
  assert.equal(
    (
      await client.query(
        "SELECT credits::text FROM org_metadata WHERE org_id = 'expired_wallet'",
      )
    ).rows[0]?.credits,
    "-2",
  );
  assert.equal(
    (
      await client.query(
        "SELECT remaining::text FROM credit_expires_record WHERE org_id = 'expired_wallet'",
      )
    ).rows[0]?.remaining,
    "0",
  );
  const ddlEnd = setup.indexOf("    INSERT INTO org_metadata");
  const repairStart = migration.indexOf("DO $$");
  assert.ok(ddlEnd > 0 && repairStart > 0);
  // Autocommit observations retain their real clocks and distinct transaction IDs.
  const parentSession = z
    .tuple([parentSessionTuple])
    .parse(
      textRows(
        await client.query({ text: parentSessionSql, rowMode: "array" }),
        ["timezone", "datestyle", "path", "cohort", "transaction", "backend"],
      ),
    )[0];
  assert.equal(client.getTransactionStatus(), "I");
  assert.deepEqual(parentSession.slice(0, 3), [
    oldSettings[0],
    oldSettings[1],
    `"${schema}"`,
  ]);
  const captureParent = async () => {
    const catalog: Catalog = {};
    for (const [group, source] of catalogSources) {
      assert.ok(group && source);
      catalog[group] = catalogRows(
        await client.query({
          text: catalogSelect(source),
          values: [schema],
          rowMode: "array",
        }),
      );
    }
    const rows: FixtureRows = [];
    for (const table of fixtureTables)
      rows.push(
        fixtureRows(
          await client.query({ text: fixtureSelect(table), rowMode: "array" }),
          table,
          catalog,
        ),
      );
    historicalCatalog(catalogSchema.parse(catalog));
    return { rows, catalog };
  };
  const parentBefore = await captureParent();
  assert.deepEqual(
    parentBefore.rows.map((rows) => {
      return rows.length;
    }),
    [4, 1, 5, 4],
  );
  assert.equal(parentBefore.rows.flat(2).length, 80);
  await expectMissingWalletRepair({
    databaseUrl,
    ...parentBefore,
    timezone: parentSession[0],
    datestyle: parentSession[1],
    ddl: setup.slice(0, ddlEnd),
    auditDDL: migration.slice(0, repairStart),
    repair,
  });
  assert.deepEqual(await captureParent(), parentBefore);
  const parentAfterSession = z
    .tuple([parentSessionTuple])
    .parse(
      textRows(
        await client.query({ text: parentSessionSql, rowMode: "array" }),
        ["timezone", "datestyle", "path", "cohort", "transaction", "backend"],
      ),
    )[0];
  assert.equal(client.getTransactionStatus(), "I");
  assert.deepEqual(parentAfterSession.slice(0, 3), parentSession.slice(0, 3));
  assert.equal(parentAfterSession[5], parentSession[5]);
  assert.notEqual(parentAfterSession[4], parentSession[4]);
  // Both genuine now() cohorts remain decoded above; no equality is required.

  // Exercise the current repair statement against retained outgoing-writer data.
  const runtimeRepair = (orgId: string, userId?: string) => {
    const query = new PgDialect().sqlToQuery(
      usagePackOverdraftTransferSql(
        { orgId, userId },
        new Date("2026-10-08T00:00:00Z"),
      ),
    );
    return client.query(query.sql, query.params);
  };
  await client.query(`
    INSERT INTO org_metadata (org_id, credits) VALUES ('runtime_expired', 10);
    INSERT INTO credit_expires_record VALUES ('00000000-0000-4000-a000-000000000011', 'runtime_expired', 20, '2020-01-01');
    INSERT INTO usage_pack_credit_grants VALUES
      ('00000000-0000-4000-a000-000000000007', 'positive', 'alice', 'bonus', 10, -2, '2099-01-01', 'runtime-alice'),
      ('00000000-0000-4000-a000-000000000008', 'positive', 'bob', 'bonus', 10, -3, '2020-01-01', 'runtime-bob'),
      ('00000000-0000-4000-a000-000000000009', 'runtime_expired', 'dana', 'bonus', 10, -3, '2020-01-01', 'runtime-expired');
  `);
  assert.deepEqual((await runtimeRepair("positive", "alice")).rows, [
    { has_wallet: true, negative_grants: "1", amount: "2" },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT credits::text FROM org_metadata WHERE org_id = 'positive'",
      )
    ).rows[0]?.credits,
    "11",
  );
  assert.equal(
    (
      await client.query(
        "SELECT remaining_amount::text FROM usage_pack_credit_grants WHERE idempotency_key = 'runtime-bob'",
      )
    ).rows[0]?.remaining_amount,
    "-3",
  );
  assert.deepEqual((await runtimeRepair("positive", "alice")).rows, [
    { has_wallet: true, negative_grants: "0", amount: "0" },
  ]);
  assert.deepEqual((await runtimeRepair("positive")).rows, [
    { has_wallet: true, negative_grants: "1", amount: "3" },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT credits::text FROM org_metadata WHERE org_id = 'positive'",
      )
    ).rows[0]?.credits,
    "8",
  );
  assert.deepEqual((await runtimeRepair("runtime_expired")).rows, [
    { has_wallet: true, negative_grants: "1", amount: "3" },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT credits::text FROM org_metadata WHERE org_id = 'runtime_expired'",
      )
    ).rows[0]?.credits,
    "-3",
  );
  assert.equal(
    (
      await client.query(
        "SELECT remaining::text FROM credit_expires_record WHERE org_id = 'runtime_expired'",
      )
    ).rows[0]?.remaining,
    "0",
  );
  assert.deepEqual((await runtimeRepair("no_wallet")).rows, [
    { has_wallet: false, negative_grants: "0", amount: "0" },
  ]);
  await client.query(
    `INSERT INTO usage_pack_credit_grants VALUES ('00000000-0000-4000-a000-000000000012', 'no_wallet', 'eve', 'bonus', 10, -3, '2099-01-01', 'runtime-orphan')`,
  );
  assert.deepEqual((await runtimeRepair("no_wallet")).rows, [
    { has_wallet: false, negative_grants: "1", amount: "0" },
  ]);
  assert.equal(
    (
      await client.query(
        "SELECT remaining_amount::text FROM usage_pack_credit_grants WHERE idempotency_key = 'runtime-orphan'",
      )
    ).rows[0]?.remaining_amount,
    "-3",
  );
  await client.query("DELETE FROM usage_pack_credit_grants");
  assert.equal(
    (
      await client.query(
        "SELECT count(*)::text AS count FROM usage_pack_overdraft_transfers",
      )
    ).rows[0]?.count,
    "7",
  );
} catch (error) {
  errors.push(error);
} finally {
  // A collision or unknown CREATE ACK is unowned: never adopt/drop/retry it.
  // Committed fixtures can outlive connection/process/job death; use a disposable job.
  if (owned) {
    try {
      commandAck(await client.query(`DROP SCHEMA "${schema}" CASCADE`), "DROP");
      assert.equal(client.getTransactionStatus(), "I");
    } catch (error) {
      errors.push(error);
    }
  }
  if (connected) {
    try {
      assert.deepEqual(
        textRows(
          await client.query({
            text: absenceSql,
            values: [schema],
            rowMode: "array",
          }),
          ["count"],
        ),
        [["0"]],
      );
      assert.equal(client.getTransactionStatus(), "I");
    } catch (error) {
      errors.push(error);
    }
  }
  if (oldSettings) {
    try {
      assert.deepEqual(
        textRows(
          await client.query({
            text: "SELECT set_config($1,$2,false) AS setting",
            values: ["search_path", oldSettings[2]],
            rowMode: "array",
          }),
          ["setting"],
        ),
        [[oldSettings[2]]],
      );
      assert.equal(client.getTransactionStatus(), "I");
    } catch (error) {
      errors.push(error);
    }
    for (const setting of [
      { name: "search_path", value: oldSettings[2] },
      { name: "TimeZone", value: oldSettings[0] },
      { name: "DateStyle", value: oldSettings[1] },
    ]) {
      try {
        assert.deepEqual(
          textRows(
            await client.query({
              text: `SHOW ${setting.name}`,
              rowMode: "array",
            }),
            [setting.name],
            undefined,
            "SHOW",
          ),
          [[setting.value]],
        );
        assert.equal(client.getTransactionStatus(), "I");
      } catch (error) {
        errors.push(error);
      }
    }
  }
  try {
    await client.end();
  } catch (error) {
    errors.push(error);
  }
}
if (errors.length === 1) throw errors[0];
if (errors.length > 1)
  throw new AggregateError(
    errors,
    "Overdraft transfer and parent cleanup failed",
    { cause: errors[0] },
  );
console.log(
  "Legacy and current package overdraft transfer: conservation, expired debt, member scope, missing wallet, replay and retained audit passed",
);
