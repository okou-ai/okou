import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
// Negative writes commit only inside ACK-owned namespaces. This standalone
// validator requires an exclusive disposable test database, never a shared or
// production DATABASE_URL. Forced termination/uncertain DDL acknowledgements
// can leave residue until that database/service is disposed.
const migrationTags = [
  "1085_needy_nemesis",
  "1104_flawless_alex_power",
  "1113_reusable_ssh_credentials",
  "1128_cloudflare_access_authority",
  "1203_cloudflare_access_org_scope",
  "1210_cloudflare_access_conversion",
  "1222_cloudflare_access_personal_promotion",
  "1290_retire_cloudflare_access_triggers",
] as const;
const appliedMigrations: string[] = [];
const fixtureTables = [
  { name: "agents", order: "id", identity: "id::text" },
  {
    name: "agent_ssh_access",
    order: "org_id,user_id,agent_id",
    identity: "jsonb_build_array(org_id,user_id,agent_id)::text",
  },
  { name: "ssh_credentials", order: "id", identity: "id::text" },
  { name: "cloudflare_access_configs", order: "id", identity: "id::text" },
  { name: "ssh_connections", order: "id", identity: "id::text" },
  {
    name: "ssh_connection_observations",
    order: "connection_id",
    identity: "connection_id::text",
  },
] as const;
type FixtureTable = (typeof fixtureTables)[number];
const imageRowsSchema = z.array(
  z.strictObject({ value: z.string().min(1), identity: z.string().min(1) }),
);
const textRowsSchema = z
  .array(z.strictObject({ value: z.string().min(1) }))
  .length(1);
// Canonical PG17 uses Etc/UTC; the private PG18 fixture uses UTC. Both
// represent UTC without changing the parent or probe session clock.
const timezoneRowsSchema = z
  .array(z.strictObject({ value: z.enum(["UTC", "Etc/UTC"]) }))
  .length(1);
const pathRowsSchema = z
  .array(z.strictObject({ search_path: z.string().min(1) }))
  .length(1);
const namespaceRowsSchema = z.array(
  z.strictObject({ nspname: z.string().min(1) }),
);
const nativeErrorSchema = z.object({
  code: z.string().min(1),
  constraint: z.string().min(1),
  message: z.string().min(1),
  table: z.string().optional(),
  schema: z.string().optional(),
});
function fixtureId(suffix: string) {
  return `00000000-0000-4000-8000-${suffix.padStart(12, "0")}`;
}
function expectedIdentities(table: FixtureTable, stage: number) {
  switch (table.name) {
    case "agents":
      return [fixtureId("1")];
    case "agent_ssh_access":
      return [`["org", "user", "${fixtureId("1")}"]`];
    case "ssh_credentials":
      return (stage < 6 ? ["2"] : ["2", "12"]).map(fixtureId);
    case "cloudflare_access_configs":
      return (
        stage === 4
          ? ["4", "5"]
          : stage === 5
            ? ["4", "5", "6", "7"]
            : ["4", "5", "6", "7", "11"]
      ).map(fixtureId);
    case "ssh_connections":
      return (stage < 6 ? ["3"] : ["3", "9", "10", "13"]).map(fixtureId);
    case "ssh_connection_observations":
      return [fixtureId("3")];
  }
}
function snapshotSql(table: FixtureTable) {
  return `SELECT to_jsonb(row_value)::text AS value, ${table.identity} AS identity
    FROM "${table.name}" AS row_value ORDER BY ${table.order}`;
}
// Compare the source and reconstruction on the same server, including dropped
// attribute positions and PG17/18's different NOT NULL catalog representation.
const catalogSql = `SELECT jsonb_build_object(
  'columns', (SELECT jsonb_agg(jsonb_build_object(
    'table', r.relname, 'ordinal', a.attnum, 'name', a.attname,
    'dropped', a.attisdropped, 'type', format_type(a.atttypid,a.atttypmod),
    'typmod', a.atttypmod, 'notnull', a.attnotnull,
    'default', pg_get_expr(d.adbin,d.adrelid), 'identity', a.attidentity,
    'generated', a.attgenerated, 'collation', co.collname
  ) ORDER BY r.relname,a.attnum)
    FROM pg_class r JOIN pg_namespace n ON n.oid=r.relnamespace
    JOIN pg_attribute a ON a.attrelid=r.oid AND a.attnum>0
    LEFT JOIN pg_attrdef d ON d.adrelid=r.oid AND d.adnum=a.attnum
    LEFT JOIN pg_collation co ON co.oid=a.attcollation
    WHERE n.nspname=current_schema() AND r.relkind='r'),
  'constraints', (SELECT jsonb_agg(jsonb_build_object(
    'table', r.relname, 'name', c.conname, 'type', c.contype,
    'validated', c.convalidated, 'deferrable', c.condeferrable,
    'deferred', c.condeferred, 'definition', pg_get_constraintdef(c.oid)
  ) ORDER BY r.relname,c.conname)
    FROM pg_constraint c JOIN pg_class r ON r.oid=c.conrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace WHERE n.nspname=current_schema()),
  'indexes', (SELECT jsonb_agg(jsonb_build_object(
    'table', r.relname, 'name', i.relname, 'definition', pg_get_indexdef(x.indexrelid),
    'valid', x.indisvalid, 'ready', x.indisready, 'live', x.indislive
  ) ORDER BY r.relname,i.relname)
    FROM pg_index x JOIN pg_class r ON r.oid=x.indrelid
    JOIN pg_class i ON i.oid=x.indexrelid JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema()),
  'functions', (SELECT jsonb_agg(jsonb_build_object(
    'name', p.proname, 'body', p.prosrc, 'definition', pg_get_functiondef(p.oid),
    'volatility', p.provolatile, 'config', p.proconfig
  ) ORDER BY p.proname)
    FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname=current_schema()),
  'triggers', (SELECT jsonb_agg(jsonb_build_object(
    'table', r.relname, 'name', t.tgname, 'enabled', t.tgenabled,
    'definition', pg_get_triggerdef(t.oid)
  ) ORDER BY r.relname,t.tgname)
    FROM pg_trigger t JOIN pg_class r ON r.oid=t.tgrelid
    JOIN pg_namespace n ON n.oid=r.relnamespace
    WHERE n.nspname=current_schema() AND NOT t.tgisinternal)
)::text AS value`;

const schema = `access_${randomUUID().replaceAll("-", "")}`;
async function migrate(name: string) {
  const sql = await readFile(
    new URL(`../src/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  await client.query(sql.replaceAll('"public".', `"${schema}".`));
  appliedMigrations.push(name);
}
function expectedErrorMessage(
  query: string,
  code: string,
  frontier: { constraint: string; table?: string; message?: string },
) {
  let message: string;
  if (frontier.table === undefined) {
    assert.ok(frontier.message);
    message = frontier.message;
  } else if (query.startsWith("DELETE")) {
    const violation =
      code === "23001"
        ? "RESTRICT setting of foreign key constraint"
        : "foreign key constraint";
    message = `update or delete on table "cloudflare_access_configs" violates ${violation} "${frontier.constraint}" on table "${frontier.table}"`;
  } else if (code === "23503") {
    message = `insert or update on table "${frontier.table}" violates foreign key constraint "${frontier.constraint}"`;
  } else {
    message = `new row for relation "${frontier.table}" violates check constraint "${frontier.constraint}"`;
  }
  return message;
}

async function rejects(
  query: string,
  expected: { code: string | RegExp; constraint?: string },
  frontier: { constraint: string; table?: string; message?: string },
) {
  const stage = appliedMigrations.length;
  assert.ok(stage >= 4 && stage <= migrationTags.length);
  assert.deepEqual(appliedMigrations, migrationTags.slice(0, stage));
  const images: {
    table: FixtureTable;
    rows: z.infer<typeof imageRowsSchema>;
  }[] = [];
  for (const table of fixtureTables) {
    const rows = imageRowsSchema.parse(
      (await client.query(snapshotSql(table))).rows,
    );
    assert.deepEqual(
      rows.map((row) => {
        return row.identity;
      }),
      expectedIdentities(table, stage),
    );
    images.push({ table, rows });
  }
  const parentCatalog = textRowsSchema.parse(
    (await client.query(catalogSql)).rows,
  );
  const parentTimezone = timezoneRowsSchema.parse(
    (await client.query("SELECT current_setting('TimeZone') AS value")).rows,
  );
  const namespace = `access_negative_${randomUUID().replaceAll("-", "")}`;
  const probe = new Client({ connectionString: databaseUrl });
  let owned = false;
  let searchPath: string | undefined;
  const errors: unknown[] = [];
  try {
    await probe.connect();
    const paths = pathRowsSchema.parse(
      (await probe.query("SHOW search_path")).rows,
    );
    const path = paths[0];
    assert.ok(path);
    searchPath = path.search_path;
    assert.deepEqual(
      textRowsSchema.parse(
        (await probe.query("SELECT current_setting('TimeZone') AS value")).rows,
      ),
      parentTimezone,
    );
    // Collision or lost CREATE acknowledgement never confers cleanup ownership.
    await probe.query(`CREATE SCHEMA "${namespace}"`);
    owned = true;
    await probe.query(`SET search_path TO "${namespace}"`);
    await probe.query(
      "CREATE TABLE agents (id uuid PRIMARY KEY, org_id text, owner text)",
    );
    for (const tag of appliedMigrations) {
      const sql = await readFile(
        new URL(`../src/migrations/${tag}.sql`, import.meta.url),
        "utf8",
      );
      // Keep every shipped migration as one complete simple-query message,
      // including 1113's historical reset/LOCK. Do not split or rewrite it.
      await probe.query(sql.replaceAll('"public".', `"${namespace}".`));
    }
    const probeCatalog = textRowsSchema.parse(
      (await probe.query(catalogSql)).rows,
    );
    assert.deepEqual(
      probeCatalog.map((row) => {
        return row.value.replaceAll(namespace, "$OWNED_SCHEMA");
      }),
      parentCatalog.map((row) => {
        return row.value.replaceAll(schema, "$OWNED_SCHEMA");
      }),
    );
    for (const image of images) {
      // Keep server JSON TEXT untouched: no JS number/date/JSON roundtrip.
      const payload = `[${image.rows
        .map((row) => {
          return row.value;
        })
        .join(",")}]`;
      const restored = await probe.query(
        `INSERT INTO "${image.table.name}" SELECT * FROM jsonb_populate_recordset(NULL::"${image.table.name}", $1::jsonb)`,
        [payload],
      );
      assert.equal(restored.rowCount, image.rows.length);
    }
    for (const image of images) {
      assert.deepEqual(
        imageRowsSchema.parse(
          (await probe.query(snapshotSql(image.table))).rows,
        ),
        image.rows,
      );
    }
    let rejected: unknown;
    try {
      // Exactly one original invalid write, in autocommit on the owned fixture.
      await probe.query(query);
    } catch (error) {
      rejected = error;
    }
    assert.ok(rejected, "Historical invalid write unexpectedly succeeded");
    try {
      await assert.rejects(Promise.reject(rejected), expected);
      const error = nativeErrorSchema.parse(rejected);
      assert.equal(error.constraint, frontier.constraint);
      assert.equal(error.table, frontier.table);
      assert.equal(
        error.schema,
        frontier.table === undefined ? undefined : namespace,
      );
      assert.equal(
        error.message,
        expectedErrorMessage(query, error.code, frontier),
      );
    } catch (error) {
      throw new AggregateError(
        [rejected, error],
        "Historical error frontier differs",
      );
    }
    for (const image of images) {
      assert.deepEqual(
        imageRowsSchema.parse(
          (await probe.query(snapshotSql(image.table))).rows,
        ),
        image.rows,
      );
      assert.deepEqual(
        imageRowsSchema.parse(
          (await client.query(snapshotSql(image.table))).rows,
        ),
        image.rows,
      );
    }
    assert.deepEqual(
      textRowsSchema.parse((await probe.query(catalogSql)).rows),
      probeCatalog,
    );
    assert.deepEqual(
      textRowsSchema.parse((await client.query(catalogSql)).rows),
      parentCatalog,
    );
  } catch (error) {
    errors.push(error);
  } finally {
    if (owned) {
      try {
        await probe.query(`DROP SCHEMA "${namespace}" CASCADE`);
      } catch (error) {
        errors.push(error);
      }
      try {
        assert.deepEqual(
          namespaceRowsSchema.parse(
            (
              await probe.query(
                "SELECT nspname FROM pg_namespace WHERE nspname=$1",
                [namespace],
              )
            ).rows,
          ),
          [],
        );
      } catch (error) {
        errors.push(error);
      }
    }
    if (searchPath !== undefined) {
      try {
        await probe.query("SELECT set_config('search_path', $1, false)", [
          searchPath,
        ]);
      } catch (error) {
        errors.push(error);
      }
      try {
        assert.deepEqual(
          pathRowsSchema.parse((await probe.query("SHOW search_path")).rows),
          [{ search_path: searchPath }],
        );
      } catch (error) {
        errors.push(error);
      }
    }
    try {
      await probe.end();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Historical rejection probe or cleanup failed",
    );
  }
}

try {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0374; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query(
    "CREATE TABLE agents (id uuid PRIMARY KEY, org_id text, owner text)",
  );
  await migrate("1085_needy_nemesis");
  await migrate("1104_flawless_alex_power");
  await migrate("1113_reusable_ssh_credentials");
  await client.query(`
    INSERT INTO agents VALUES ('00000000-0000-4000-8000-000000000001','org','user');
    INSERT INTO agent_ssh_access (org_id,user_id,agent_id) VALUES ('org','user','00000000-0000-4000-8000-000000000001');
    INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000002','org','user','Password','deploy','password','ciphertext');
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,credential_id,learned_host_key_algorithm,learned_host_key_fingerprint,generation)
      VALUES ('00000000-0000-4000-8000-000000000003','org','user','Direct','ssh.example.com','00000000-0000-4000-8000-000000000002','ssh-ed25519','SHA256:pin',7);
    INSERT INTO ssh_connection_observations VALUES ('00000000-0000-4000-8000-000000000003',7,now(),'authentication_failed');
  `);
  const before = await client.query(
    "SELECT row_to_json(ssh_connections) AS value FROM ssh_connections",
  );
  await migrate("1128_cloudflare_access_authority");
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(ssh_connections) - 'cloudflare_access_id' AS value FROM ssh_connections",
      )
    ).rows,
    before.rows,
  );
  assert.deepEqual(
    (await client.query("SELECT cloudflare_access_id FROM ssh_connections"))
      .rows,
    [{ cloudflare_access_id: null }],
  );
  assert.deepEqual(
    (await client.query("SELECT encrypted_password FROM ssh_credentials")).rows,
    [{ encrypted_password: "ciphertext" }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT generation, failure_reason FROM ssh_connection_observations",
      )
    ).rows,
    [{ generation: 7, failure_reason: "authentication_failed" }],
  );
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM agent_ssh_access"))
      .rows,
    [{ count: 1 }],
  );
  await client.query(`INSERT INTO cloudflare_access_configs (id,org_id,user_id,name,encrypted_client_id,encrypted_client_secret)
    VALUES ('00000000-0000-4000-8000-000000000004','org','user','Token','encrypted-id','encrypted-secret'),
      ('00000000-0000-4000-8000-000000000005','org','foreign','Foreign','encrypted-id','encrypted-secret')`);
  await rejects(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000004'",
    { code: "23514" },
    {
      constraint: "chk_ssh_connections_cloudflare_access_destination",
      table: "ssh_connections",
    },
  );
  await rejects(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000005',port=443",
    {
      code: "23503",
      constraint: "ssh_connections_cloudflare_access_owner_fk",
    },
    {
      constraint: "ssh_connections_cloudflare_access_owner_fk",
      table: "ssh_connections",
    },
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000004',port=443",
  );
  for (const host of [
    "1.2.3.4",
    "localhost",
    "::1",
    "*.example.com",
    "https://ssh.example.com",
    "ssh..example.com",
  ]) {
    await rejects(
      `UPDATE ssh_connections SET host='${host}'`,
      {
        code: "23514",
      },
      {
        constraint: "chk_ssh_connections_cloudflare_access_destination",
        table: "ssh_connections",
      },
    );
  }
  // PostgreSQL 18 reports RESTRICT violations as 23001 instead of 23503.
  await rejects(
    "DELETE FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000004'",
    {
      code: /^(23503|23001)$/,
      constraint: "ssh_connections_cloudflare_access_owner_fk",
    },
    {
      constraint: "ssh_connections_cloudflare_access_owner_fk",
      table: "ssh_connections",
    },
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET generation=0",
    {
      code: "23514",
    },
    {
      constraint: "chk_cloudflare_access_configs_revision",
      table: "cloudflare_access_configs",
    },
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET revision=0",
    {
      code: "23514",
    },
    {
      constraint: "chk_cloudflare_access_configs_revision",
      table: "cloudflare_access_configs",
    },
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET encrypted_client_secret=''",
    { code: "23514" },
    {
      constraint: "chk_cloudflare_access_configs_credentials",
      table: "cloudflare_access_configs",
    },
  );
  await migrate("1203_cloudflare_access_org_scope");
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope, user_id FROM cloudflare_access_configs ORDER BY id",
      )
    ).rows,
    [
      { scope: "personal", user_id: "user" },
      { scope: "personal", user_id: "foreign" },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT cloudflare_access_id, needs_rebind FROM ssh_connections",
      )
    ).rows,
    [
      {
        cloudflare_access_id: "00000000-0000-4000-8000-000000000004",
        needs_rebind: false,
      },
    ],
  );
  await client.query(`
    INSERT INTO cloudflare_access_configs (id,org_id,user_id,scope,name,encrypted_client_id,encrypted_client_secret)
      VALUES ('00000000-0000-4000-8000-000000000006','org',NULL,'organization','Shared','encrypted-id','encrypted-secret'),
        ('00000000-0000-4000-8000-000000000007','other',NULL,'organization','Outside','encrypted-id','encrypted-secret');
  `);
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope, user_id FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000004'",
      )
    ).rows,
    [{ scope: "personal", user_id: "user" }],
  );
  await rejects(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000005',port=443",
    {
      code: "23514",
      constraint: "ssh_connections_cloudflare_access_personal_owner_guard",
    },
    {
      constraint: "ssh_connections_cloudflare_access_personal_owner_guard",
      message: "SSH Cloudflare Access personal owner mismatch",
    },
  );
  await rejects(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000007',port=443",
    { code: "23503", constraint: "ssh_connections_cloudflare_access_org_fk" },
    {
      constraint: "ssh_connections_cloudflare_access_org_fk",
      table: "ssh_connections",
    },
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000004',port=443",
  );
  assert.deepEqual(
    (await client.query("SELECT needs_rebind FROM ssh_connections")).rows,
    [{ needs_rebind: false }],
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000006'",
  );
  await rejects(
    "DELETE FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000006'",
    {
      code: /^(23503|23001)$/,
      constraint: "ssh_connections_cloudflare_access_org_fk",
    },
    {
      constraint: "ssh_connections_cloudflare_access_org_fk",
      table: "ssh_connections",
    },
  );
  await rejects(
    "UPDATE ssh_connections SET needs_rebind=true",
    {
      code: "23514",
      constraint: "chk_ssh_connections_needs_rebind_unbound",
    },
    {
      constraint: "chk_ssh_connections_needs_rebind_unbound",
      table: "ssh_connections",
    },
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id=NULL,needs_rebind=true",
  );
  await rejects(
    "UPDATE ssh_connections SET port=22",
    {
      code: "23514",
      constraint: "chk_ssh_connections_cloudflare_access_destination",
    },
    {
      constraint: "chk_ssh_connections_cloudflare_access_destination",
      table: "ssh_connections",
    },
  );
  await client.query("UPDATE ssh_connections SET needs_rebind=false,port=22");
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='organization',user_id=NULL WHERE id='00000000-0000-4000-8000-000000000004'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
    {
      constraint: "cloudflare_access_scope_change_guard",
      message:
        "Cloudflare Access scope and owner are immutable before conversion activation",
    },
  );
  await rejects(
    "INSERT INTO cloudflare_access_configs (id,org_id,user_id,scope,name,encrypted_client_id,encrypted_client_secret) VALUES ('00000000-0000-4000-8000-000000000008','org',NULL,'personal','Invalid','encrypted-id','encrypted-secret')",
    { code: "23514", constraint: "chk_cloudflare_access_configs_scope_owner" },
    {
      constraint: "chk_cloudflare_access_configs_scope_owner",
      table: "cloudflare_access_configs",
    },
  );
  // Outgoing API binaries omit the new columns and use INSERT ... RETURNING.
  assert.deepEqual(
    (
      await client.query(`
        INSERT INTO cloudflare_access_configs (id,org_id,user_id,name,encrypted_client_id,encrypted_client_secret)
          VALUES ('00000000-0000-4000-8000-000000000011','org','user','Old Personal','encrypted-id','encrypted-secret')
          RETURNING id,org_id,user_id,name,revision,generation;
      `)
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000011",
        org_id: "org",
        user_id: "user",
        name: "Old Personal",
        revision: 1,
        generation: 1,
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000011'",
      )
    ).rows,
    [{ scope: "personal" }],
  );
  assert.deepEqual(
    (
      await client.query(`
        UPDATE cloudflare_access_configs SET name='Renamed Personal',revision=revision+1
          WHERE id='00000000-0000-4000-8000-000000000011'
          RETURNING id,name,revision;
      `)
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000011",
        name: "Renamed Personal",
        revision: 2,
      },
    ],
  );
  const oldDirect = await client.query(`
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,credential_id)
      VALUES ('00000000-0000-4000-8000-000000000009','org','user','Old Direct','legacy-direct.example.com','00000000-0000-4000-8000-000000000002')
      RETURNING id,org_id,user_id,cloudflare_access_id,port,generation;
  `);
  const oldAccess = await client.query(`
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,port,credential_id,cloudflare_access_id)
      VALUES ('00000000-0000-4000-8000-000000000010','org','user','Old Access','legacy-access.example.com',443,'00000000-0000-4000-8000-000000000002','00000000-0000-4000-8000-000000000011')
      RETURNING id,org_id,user_id,cloudflare_access_id,port,generation;
  `);
  assert.deepEqual(oldDirect.rows, [
    {
      id: "00000000-0000-4000-8000-000000000009",
      org_id: "org",
      user_id: "user",
      cloudflare_access_id: null,
      port: 22,
      generation: 1,
    },
  ]);
  assert.deepEqual(oldAccess.rows, [
    {
      id: "00000000-0000-4000-8000-000000000010",
      org_id: "org",
      user_id: "user",
      cloudflare_access_id: "00000000-0000-4000-8000-000000000011",
      port: 443,
      generation: 1,
    },
  ]);
  assert.deepEqual(
    (
      await client.query(
        "SELECT cloudflare_access_id,needs_rebind FROM ssh_connections WHERE id IN ('00000000-0000-4000-8000-000000000009','00000000-0000-4000-8000-000000000010') ORDER BY id",
      )
    ).rows,
    [
      { cloudflare_access_id: null, needs_rebind: false },
      {
        cloudflare_access_id: "00000000-0000-4000-8000-000000000011",
        needs_rebind: false,
      },
    ],
  );
  await client.query(`
    INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000012','org','foreign','Foreign login','deploy','password','ciphertext');
    INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,port,credential_id,cloudflare_access_id,generation)
      VALUES ('00000000-0000-4000-8000-000000000013','org','foreign','Shared host','shared.example.com',443,'00000000-0000-4000-8000-000000000012','00000000-0000-4000-8000-000000000006',7);
  `);
  await migrate("1210_cloudflare_access_conversion");
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='personal',user_id='user' WHERE id='00000000-0000-4000-8000-000000000006'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
    {
      constraint: "cloudflare_access_scope_change_guard",
      message:
        "Other owners still reference this Cloudflare Access configuration",
    },
  );
  await client.query(
    "UPDATE ssh_connections SET cloudflare_access_id=NULL,needs_rebind=true,generation=generation+1 WHERE id='00000000-0000-4000-8000-000000000013'",
  );
  await client.query(
    "UPDATE cloudflare_access_configs SET scope='personal',user_id='user' WHERE id='00000000-0000-4000-8000-000000000006'",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope,user_id,encrypted_client_id,encrypted_client_secret FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000006'",
      )
    ).rows,
    [
      {
        scope: "personal",
        user_id: "user",
        encrypted_client_id: "encrypted-id",
        encrypted_client_secret: "encrypted-secret",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT cloudflare_access_id,needs_rebind,generation,credential_id FROM ssh_connections WHERE id='00000000-0000-4000-8000-000000000013'",
      )
    ).rows,
    [
      {
        cloudflare_access_id: null,
        needs_rebind: true,
        generation: 8,
        credential_id: "00000000-0000-4000-8000-000000000012",
      },
    ],
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='organization',user_id=NULL WHERE id='00000000-0000-4000-8000-000000000006'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
    {
      constraint: "cloudflare_access_scope_change_guard",
      message: "Cloudflare Access scope and owner change is not permitted",
    },
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET user_id='foreign' WHERE id='00000000-0000-4000-8000-000000000006'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
    {
      constraint: "cloudflare_access_scope_change_guard",
      message: "Cloudflare Access scope and owner change is not permitted",
    },
  );
  await client.query(
    "UPDATE ssh_connections SET learned_host_key_algorithm='ssh-ed25519',learned_host_key_fingerprint='SHA256:pin' WHERE id='00000000-0000-4000-8000-000000000010'",
  );
  await migrate("1222_cloudflare_access_personal_promotion");
  await rejects(
    "UPDATE cloudflare_access_configs SET user_id='foreign' WHERE id='00000000-0000-4000-8000-000000000004'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
    {
      constraint: "cloudflare_access_scope_change_guard",
      message: "Cloudflare Access scope and owner change is not permitted",
    },
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='organization',user_id=NULL,org_id='other' WHERE id='00000000-0000-4000-8000-000000000004'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
    {
      constraint: "cloudflare_access_scope_change_guard",
      message: "Cloudflare Access scope and owner change is not permitted",
    },
  );
  await client.query(
    "UPDATE cloudflare_access_configs SET scope='organization',user_id=NULL WHERE id='00000000-0000-4000-8000-000000000011'",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT scope,user_id,encrypted_client_id,encrypted_client_secret FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000011'",
      )
    ).rows,
    [
      {
        scope: "organization",
        user_id: null,
        encrypted_client_id: "encrypted-id",
        encrypted_client_secret: "encrypted-secret",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT cloudflare_access_id,needs_rebind,credential_id,learned_host_key_algorithm,learned_host_key_fingerprint FROM ssh_connections WHERE id='00000000-0000-4000-8000-000000000010'",
      )
    ).rows,
    [
      {
        cloudflare_access_id: "00000000-0000-4000-8000-000000000011",
        needs_rebind: false,
        credential_id: "00000000-0000-4000-8000-000000000002",
        learned_host_key_algorithm: "ssh-ed25519",
        learned_host_key_fingerprint: "SHA256:pin",
      },
    ],
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='personal',user_id='foreign' WHERE id='00000000-0000-4000-8000-000000000011'",
    { code: "23514", constraint: "cloudflare_access_scope_change_guard" },
    {
      constraint: "cloudflare_access_scope_change_guard",
      message:
        "Other owners still reference this Cloudflare Access configuration",
    },
  );
  // The trigger-specific rejections above belong to their historical stages.
  // A catalog mismatch must fail before either trigger can be removed.
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0375; new non-billing transactions are prohibited.
  await client.query("SAVEPOINT mismatched_catalog");
  await client.query(
    "ALTER TABLE cloudflare_access_configs DISABLE TRIGGER cloudflare_access_scope_change_guard",
  );
  await assert.rejects(migrate("1290_retire_cloudflare_access_triggers"), {
    message: /Cloudflare Access legacy trigger catalog differs/,
  });
  await client.query("ROLLBACK TO SAVEPOINT mismatched_catalog");

  const beforeDrop = await client.query(
    "SELECT to_jsonb(cloudflare_access_configs) AS value FROM cloudflare_access_configs ORDER BY id",
  );
  const bindingsBeforeDrop = await client.query(
    "SELECT to_jsonb(ssh_connections) AS value FROM ssh_connections ORDER BY id",
  );
  await migrate("1290_retire_cloudflare_access_triggers");
  assert.deepEqual(
    (
      await client.query(`
        SELECT guard.tgname
        FROM pg_catalog.pg_trigger AS guard
        JOIN pg_catalog.pg_class AS relation ON relation.oid = guard.tgrelid
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = relation.relnamespace
        WHERE ns.nspname = current_schema()
          AND guard.tgname IN ('ssh_cloudflare_access_binding_guard', 'cloudflare_access_scope_change_guard')
      `)
    ).rows,
    [],
  );
  assert.deepEqual(
    (
      await client.query(`
        SELECT routine.proname
        FROM pg_catalog.pg_proc AS routine
        JOIN pg_catalog.pg_namespace AS ns ON ns.oid = routine.pronamespace
        WHERE ns.nspname = current_schema()
          AND routine.proname IN ('validate_ssh_cloudflare_access_binding', 'reject_cloudflare_access_scope_change')
      `)
    ).rows,
    [],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(cloudflare_access_configs) AS value FROM cloudflare_access_configs ORDER BY id",
      )
    ).rows,
    beforeDrop.rows,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(ssh_connections) AS value FROM ssh_connections ORDER BY id",
      )
    ).rows,
    bindingsBeforeDrop.rows,
  );
  await rejects(
    "UPDATE ssh_connections SET cloudflare_access_id='00000000-0000-4000-8000-000000000007',port=443 WHERE id='00000000-0000-4000-8000-000000000010'",
    { code: "23503", constraint: "ssh_connections_cloudflare_access_org_fk" },
    {
      constraint: "ssh_connections_cloudflare_access_org_fk",
      table: "ssh_connections",
    },
  );
  await rejects(
    "UPDATE cloudflare_access_configs SET scope='personal',user_id=NULL WHERE id='00000000-0000-4000-8000-000000000011'",
    { code: "23514", constraint: "chk_cloudflare_access_configs_scope_owner" },
    {
      constraint: "chk_cloudflare_access_configs_scope_owner",
      table: "cloudflare_access_configs",
    },
  );
  await rejects(
    "DELETE FROM cloudflare_access_configs WHERE id='00000000-0000-4000-8000-000000000011'",
    {
      code: /^(23503|23001)$/,
      constraint: "ssh_connections_cloudflare_access_org_fk",
    },
    {
      constraint: "ssh_connections_cloudflare_access_org_fk",
      table: "ssh_connections",
    },
  );
  await client.query("ROLLBACK");
  console.log("Cloudflare Access historical and contracted schemas passed");
} finally {
  await client.end();
}
