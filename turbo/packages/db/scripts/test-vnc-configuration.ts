import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
const schema = `vnc_configuration_${randomUUID().replaceAll("-", "")}`;

const preservationMigrations = [
  "1182_wet_felicia_hardy.sql",
  "1183_wild_natasha_romanoff.sql",
  "1184_lovely_christian_walker.sql",
  "1196_dizzy_archangel.sql",
  "1197_puzzling_aaron_stack.sql",
  "1207_smart_oracle.sql",
  "1211_daily_diamondback.sql",
  "1229_peaceful_mathemanic.sql",
  "1253_unique_zarek.sql",
  "1289_thick_bruce_banner.sql",
  "1296_little_electro.sql",
  "1304_bright_grim_reaper.sql",
  "1313_rsa_aes_vnc.sql",
  "1381_vnc_kerberos_admission.sql",
] as const;

const fixtureTables = [
  "retained_owner_data",
  "vnc_credentials",
  "ssh_connections",
  "agent_vnc_access",
  "vnc_connections",
] as const;

const namespaceRows = z.array(z.strictObject({ nspname: z.string() }));
const searchPathRows = z.tuple([z.strictObject({ search_path: z.string() })]);
const fixtureSnapshotRows = z
  .array(
    z.strictObject({
      namespace: z.string(),
      relations: z.literal(
        "{agent_vnc_access,retained_owner_data,ssh_connections,vnc_connections,vnc_credentials}",
      ),
      retained_owner_data: z
        .string()
        .min(3)
        .refine((text) => {
          return text !== "[]";
        }),
      vnc_credentials: z
        .string()
        .min(3)
        .refine((text) => {
          return text !== "[]";
        }),
      ssh_connections: z
        .string()
        .min(3)
        .refine((text) => {
          return text !== "[]";
        }),
      agent_vnc_access: z
        .string()
        .min(3)
        .refine((text) => {
          return text !== "[]";
        }),
      vnc_connections: z
        .string()
        .min(3)
        .refine((text) => {
          return text !== "[]";
        }),
      catalog: z.string().min(3),
    }),
  )
  .length(1);
type FixtureSnapshot = Omit<
  z.infer<typeof fixtureSnapshotRows>[number],
  "namespace"
>;
type NativeOwnership = { namespace: string; createAcknowledged: true };

function decodeSnapshot(rows: unknown, namespace: string): FixtureSnapshot {
  const [row] = fixtureSnapshotRows.parse(rows);
  assert.ok(row);
  const { namespace: capturedNamespace, ...snapshot } = row;
  assert.equal(capturedNamespace, namespace);
  return snapshot;
}

// Keep server JSON TEXT opaque: pg's native record decoder owns bigint,
// timestamp microseconds, JSONB, NULL and ciphertext materialization.
function fixtureSnapshotQuery() {
  const images = fixtureTables.map((table) => {
    return `
    (SELECT COALESCE(json_agg(to_json(r) ORDER BY to_json(r)::text),'[]'::json)::text
     FROM ${table} AS r) AS ${table}`;
  });
  return `SELECT current_schema() AS namespace,
    (SELECT array_agg(relname ORDER BY relname)::text FROM pg_class
      WHERE relnamespace = current_schema()::regnamespace AND relkind = 'r') AS relations,
    ${images.join(",")},
    json_build_object(
      'columns', (SELECT json_agg(to_json(r) ORDER BY r.table_name,r.attnum) FROM (
        SELECT c.relname AS table_name,a.attnum,a.attname,
          format_type(a.atttypid,a.atttypmod) AS type,a.atttypmod,a.attnotnull,
          a.attidentity,a.attgenerated,co.collname,
          pg_get_expr(d.adbin,d.adrelid) AS default
        FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
        LEFT JOIN pg_collation co ON co.oid=a.attcollation
        WHERE c.relnamespace=current_schema()::regnamespace
          AND a.attnum>0 AND NOT a.attisdropped AND c.relkind='r'
      ) r),
      'constraints', (SELECT json_agg(to_json(r) ORDER BY r.table_name,r.conname) FROM (
        SELECT c.relname AS table_name,k.conname,k.contype,k.convalidated,
          k.condeferrable,k.condeferred,k.conkey,k.confkey,
          k.confupdtype,k.confdeltype,k.confmatchtype,
          ref.relname AS referenced_table,
          CASE WHEN k.confrelid=0 THEN NULL
            WHEN ref.relnamespace=current_schema()::regnamespace THEN 'fixture'
            ELSE rn.nspname END AS referenced_namespace,
          pg_get_constraintdef(k.oid) AS definition
        FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
        LEFT JOIN pg_class ref ON ref.oid=k.confrelid
        LEFT JOIN pg_namespace rn ON rn.oid=ref.relnamespace
        WHERE c.relnamespace=current_schema()::regnamespace
      ) r),
      'indexes', (SELECT json_agg(to_json(r) ORDER BY r.table_name,r.index_name) FROM (
        SELECT c.relname AS table_name,i.relname AS index_name,
          k.indisunique,k.indisprimary,k.indisvalid,k.indisready,k.indkey::text,
          replace(replace(pg_get_indexdef(i.oid),
            quote_ident(current_schema())||'.',''),
            '"'||current_schema()||'".','') AS definition
        FROM pg_index k JOIN pg_class c ON c.oid=k.indrelid
          JOIN pg_class i ON i.oid=k.indexrelid
        WHERE c.relnamespace=current_schema()::regnamespace
      ) r)
    )::text AS catalog`;
}

function throwFailures(failures: unknown[]) {
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1)
    throw new AggregateError(
      failures,
      "VNC fixture operation and cleanup failed",
    );
}

async function prepareNative(connectionString: string) {
  const localClient = new Client({ connectionString });
  const namespace = `vnc_negative_${randomUUID().replaceAll("-", "")}`;
  let ownership: NativeOwnership | undefined;
  let path: string | undefined;
  const failures: unknown[] = [];
  try {
    await localClient.connect();
    path = searchPathRows.parse(
      (await localClient.query("SHOW search_path")).rows,
    )[0].search_path;
    assert.deepEqual(
      namespaceRows.parse(
        (
          await localClient.query(
            "SELECT nspname FROM pg_namespace WHERE nspname=$1",
            [namespace],
          )
        ).rows,
      ),
      [],
    );
    await localClient.query(`CREATE SCHEMA "${namespace}"`);
    // The ACK survives path restoration or end failure in the plain receipt.
    ownership = { namespace, createAcknowledged: true };
    await localClient.query("SELECT set_config('search_path',$1,false)", [
      namespace,
    ]);
    await localClient.query(
      "CREATE TABLE retained_owner_data (value text NOT NULL)",
    );
    await localClient.query(
      (await migration("1158_vnc_configuration.sql")).replaceAll(
        '"public".',
        `"${namespace}".`,
      ),
    );
    await localClient.query(`CREATE TABLE ssh_connections (
      id uuid PRIMARY KEY,org_id text NOT NULL,user_id text NOT NULL
    )`);
    await localClient.query(`CREATE TABLE agent_vnc_access (
      org_id text NOT NULL,user_id text NOT NULL,agent_id uuid NOT NULL,
      PRIMARY KEY (org_id,user_id,agent_id)
    )`);
    for (const name of preservationMigrations) {
      await localClient.query(
        (await migration(name)).replaceAll('"public".', `"${namespace}".`),
      );
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (path !== undefined) {
        try {
          await localClient.query("SELECT set_config('search_path',$1,false)", [
            path,
          ]);
        } catch (error) {
          failures.push(error);
        }
        try {
          assert.deepEqual(
            searchPathRows.parse(
              (await localClient.query("SHOW search_path")).rows,
            ),
            [{ search_path: path }],
          );
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      try {
        await localClient.end();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  return { ownership, failures };
}

async function rejects(
  query: string,
  expected: { code: string | RegExp; constraint?: string },
  ownership: NativeOwnership,
  source: FixtureSnapshot,
) {
  assert.equal(ownership.createAcknowledged, true);
  const localClient = new Client({ connectionString: databaseUrl });
  let path: string | undefined;
  const failures: unknown[] = [];
  try {
    await localClient.connect();
    path = searchPathRows.parse(
      (await localClient.query("SHOW search_path")).rows,
    )[0].search_path;
    await localClient.query("SELECT set_config('search_path',$1,false)", [
      ownership.namespace,
    ]);
    for (const table of [
      "vnc_connections",
      "ssh_connections",
      "vnc_credentials",
      "agent_vnc_access",
      "retained_owner_data",
    ]) {
      await localClient.query(`DELETE FROM ${table}`);
    }
    for (const table of fixtureTables) {
      await localClient.query(
        `INSERT INTO ${table}
        SELECT * FROM json_populate_recordset(NULL::${table}, $1::json)`,
        [source[table]],
      );
    }
    assert.deepEqual(
      decodeSnapshot(
        (await localClient.query(fixtureSnapshotQuery())).rows,
        ownership.namespace,
      ),
      source,
    );
    try {
      await assert.rejects(
        localClient.query(query).catch((error: unknown) => {
          const frontier = z
            .object({ schema: z.string().optional() })
            .parse(error);
          if (frontier.schema !== undefined) {
            assert.equal(frontier.schema, ownership.namespace);
          }
          throw error;
        }),
        expected,
        `Synthetic VNC constraint query: ${query}`,
      );
    } catch (error) {
      failures.push(error);
    }
    // Also inspect the committed image after a wrong error or unexpected success.
    assert.deepEqual(
      decodeSnapshot(
        (await localClient.query(fixtureSnapshotQuery())).rows,
        ownership.namespace,
      ),
      source,
    );
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (path !== undefined) {
        try {
          await localClient.query("SELECT set_config('search_path',$1,false)", [
            path,
          ]);
        } catch (error) {
          failures.push(error);
        }
        try {
          assert.deepEqual(
            searchPathRows.parse(
              (await localClient.query("SHOW search_path")).rows,
            ),
            [{ search_path: path }],
          );
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      try {
        await localClient.end();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  throwFailures(failures);
}

async function disposeNative(ownership: NativeOwnership) {
  assert.equal(ownership.createAcknowledged, true);
  const localClient = new Client({ connectionString: databaseUrl });
  let path: string | undefined;
  const failures: unknown[] = [];
  try {
    await localClient.connect();
    try {
      path = searchPathRows.parse(
        (await localClient.query("SHOW search_path")).rows,
      )[0].search_path;
    } catch (error) {
      failures.push(error);
    }
    try {
      await localClient.query(`DROP SCHEMA "${ownership.namespace}" CASCADE`);
    } catch (error) {
      failures.push(error);
    }
    try {
      assert.deepEqual(
        namespaceRows.parse(
          (
            await localClient.query(
              "SELECT nspname FROM pg_namespace WHERE nspname=$1",
              [ownership.namespace],
            )
          ).rows,
        ),
        [],
      );
    } catch (error) {
      failures.push(error);
    }
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (path !== undefined) {
        try {
          await localClient.query("SELECT set_config('search_path',$1,false)", [
            path,
          ]);
        } catch (error) {
          failures.push(error);
        }
        try {
          assert.deepEqual(
            searchPathRows.parse(
              (await localClient.query("SHOW search_path")).rows,
            ),
            [{ search_path: path }],
          );
        } catch (error) {
          failures.push(error);
        }
      }
    } finally {
      try {
        await localClient.end();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  throwFailures(failures);
}

async function migration(name: string) {
  return await readFile(
    new URL(`../src/migrations/${name}`, import.meta.url),
    "utf8",
  );
}

let nativeOwnership: NativeOwnership | undefined;
let originalPath: string | undefined;
let positiveCreateAcknowledged = false;
const failures: unknown[] = [];
client.on("error", (error) => {
  failures.push(error);
});

try {
  await client.connect();
  originalPath = searchPathRows.parse(
    (await client.query("SHOW search_path")).rows,
  )[0].search_path;
  const prepared = await prepareNative(databaseUrl);
  nativeOwnership = prepared.ownership;
  throwFailures(prepared.failures);
  assert.ok(nativeOwnership);
  assert.match(schema, /^vnc_configuration_[0-9a-f]{32}$/);
  assert.deepEqual(
    namespaceRows.parse(
      (
        await client.query(
          "SELECT nspname FROM pg_namespace WHERE nspname=$1",
          [schema],
        )
      ).rows,
    ),
    [],
  );
  await client.query(`CREATE SCHEMA "${schema}"`);
  // Only the CREATE ACK owns this namespace on the disposable native-job DB.
  positiveCreateAcknowledged = true;
  await client.query("SELECT set_config('search_path',$1,false)", [schema]);
  await client.query("CREATE TABLE retained_owner_data (value text NOT NULL)");
  await client.query("INSERT INTO retained_owner_data VALUES ('retained')");
  await client.query(
    (await migration("1158_vnc_configuration.sql")).replaceAll(
      '"public".',
      `"${schema}".`,
    ),
  );
  await client.query(`
    CREATE TABLE ssh_connections (
      id uuid PRIMARY KEY,
      org_id text NOT NULL,
      user_id text NOT NULL
    );
  `);
  await client.query(`
    CREATE TABLE agent_vnc_access (
      org_id text NOT NULL,
      user_id text NOT NULL,
      agent_id uuid NOT NULL,
      PRIMARY KEY (org_id,user_id,agent_id)
    );
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_password,revision)
      VALUES ('00000000-0000-4000-8000-000000000001','org','owner','Password','vnc_password','ciphertext',7),
             ('00000000-0000-4000-8000-000000000007','org','second-owner','Second password','vnc_password','second-ciphertext',11);
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,port,credential_id,security_type,trust_mode,ca_bundle,generation)
      VALUES ('00000000-0000-4000-8000-000000000003','org','owner','Desktop','desktop.example.com',5900,'00000000-0000-4000-8000-000000000001','x509_vnc','system',NULL,9),
             ('00000000-0000-4000-8000-000000000008','org','second-owner','Second desktop','second.example.com',5901,'00000000-0000-4000-8000-000000000007','x509_vnc','custom_ca','second-ca',13);
    INSERT INTO agent_vnc_access
      VALUES ('org','owner','00000000-0000-4000-8000-000000000004'),
             ('org','second-owner','00000000-0000-4000-8000-000000000009');
  `);

  const credentialsBefore = (
    await client.query(
      "SELECT id::text,org_id,user_id,name,auth_method,encrypted_password,revision,created_at,updated_at FROM vnc_credentials ORDER BY id",
    )
  ).rows;
  const connectionsBefore = (
    await client.query(
      "SELECT id::text,org_id,user_id,display_name,host,port,credential_id::text,security_type,trust_mode,ca_bundle,generation,created_at,updated_at FROM vnc_connections ORDER BY id",
    )
  ).rows;
  const grantsBefore = (
    await client.query(
      "SELECT org_id,user_id,agent_id::text FROM agent_vnc_access ORDER BY org_id,user_id,agent_id",
    )
  ).rows;

  for (const name of preservationMigrations) {
    await client.query(
      (await migration(name)).replaceAll('"public".', `"${schema}".`),
    );
  }

  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,org_id,user_id,name,auth_method,encrypted_password,revision,created_at,updated_at FROM vnc_credentials ORDER BY id",
      )
    ).rows,
    credentialsBefore,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,transport_type,ssh_connection_id::text,x509_server_name FROM vnc_connections ORDER BY id",
      )
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000003",
        transport_type: "direct",
        ssh_connection_id: null,
        x509_server_name: null,
      },
      {
        id: "00000000-0000-4000-8000-000000000008",
        transport_type: "direct",
        ssh_connection_id: null,
        x509_server_name: null,
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,org_id,user_id,display_name,host,port,credential_id::text,security_type,trust_mode,ca_bundle,generation,created_at,updated_at FROM vnc_connections ORDER BY id",
      )
    ).rows,
    connectionsBefore,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT org_id,user_id,agent_id::text FROM agent_vnc_access ORDER BY org_id,user_id,agent_id",
      )
    ).rows,
    grantsBefore,
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,username,auth_method FROM vnc_credentials ORDER BY id",
      )
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000001",
        username: null,
        auth_method: "vnc_password",
      },
      {
        id: "00000000-0000-4000-8000-000000000007",
        username: null,
        auth_method: "vnc_password",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT id::text,auth_method FROM vnc_connections ORDER BY id",
      )
    ).rows,
    [
      {
        id: "00000000-0000-4000-8000-000000000003",
        auth_method: "vnc_password",
      },
      {
        id: "00000000-0000-4000-8000-000000000008",
        auth_method: "vnc_password",
      },
    ],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT column_default FROM information_schema.columns WHERE table_schema=$1 AND table_name='vnc_connections' AND column_name='auth_method'",
        [schema],
      )
    ).rows,
    [{ column_default: null }],
  );
  assert.deepEqual(
    (await client.query("SELECT value FROM retained_owner_data")).rows,
    [{ value: "retained" }],
  );

  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000002','org','owner','Username password','operator','username_password','username-ciphertext'),
             ('00000000-0000-4000-8000-000000000005','org','other','Other',NULL,'vnc_password','other-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000004','org','owner','Plain desktop','plain.example.com','00000000-0000-4000-8000-000000000002','username_password','x509_plain','system');
    INSERT INTO ssh_connections (id,org_id,user_id)
      VALUES ('00000000-0000-4000-8000-000000000010','org','owner'),
             ('00000000-0000-4000-8000-000000000011','org','other');
  `);

  assert.deepEqual(
    (
      await client.query(
        "SELECT transport_type,ssh_connection_id,x509_server_name FROM vnc_connections WHERE id='00000000-0000-4000-8000-000000000004'",
      )
    ).rows,
    [
      {
        transport_type: "direct",
        ssh_connection_id: null,
        x509_server_name: null,
      },
    ],
  );
  await client.query(
    "UPDATE vnc_connections SET transport_type='ssh',ssh_connection_id='00000000-0000-4000-8000-000000000010',x509_server_name='plain-tls.example.com' WHERE id='00000000-0000-4000-8000-000000000004'",
  );
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "DELETE FROM ssh_connections WHERE id='00000000-0000-4000-8000-000000000010'",
      {
        code: /^(23503|23001)$/,
        constraint: "vnc_connections_ssh_owner_fk",
      },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  for (const assignment of [
    "transport_type='direct'",
    "ssh_connection_id=NULL",
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000004'`,
        { code: "23514", constraint: "chk_vnc_connections_transport" },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET ssh_connection_id='00000000-0000-4000-8000-000000000011' WHERE id='00000000-0000-4000-8000-000000000004'",
      { code: "23503", constraint: "vnc_connections_ssh_owner_fk" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  for (const serverName of [
    "TLS.EXAMPLE.COM",
    "tls.example.com/path",
    "",
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET x509_server_name='${serverName}' WHERE id='00000000-0000-4000-8000-000000000004'`,
        {
          code: "23514",
          constraint: "chk_vnc_connections_x509_server_name",
        },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }

  for (const assignment of [
    "org_id='foreign'",
    "user_id='other'",
    "credential_id='00000000-0000-4000-8000-000000000005'",
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000003'`,
        { code: "23503", constraint: "vnc_connections_credential_owner_fk" },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }

  for (const [authMethod, securityType, credentialId, constraint] of [
    [
      "username_password",
      "x509_plain",
      "00000000-0000-4000-8000-000000000001",
      "vnc_connections_credential_profile_fk",
    ],
    [
      "vnc_password",
      "x509_vnc",
      "00000000-0000-4000-8000-000000000002",
      "vnc_connections_credential_profile_fk",
    ],
    [
      "username_password",
      "x509_vnc",
      "00000000-0000-4000-8000-000000000002",
      "chk_vnc_connections_profile",
    ],
    [
      "vnc_password",
      "x509_plain",
      "00000000-0000-4000-8000-000000000001",
      "chk_vnc_connections_profile",
    ],
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `INSERT INTO vnc_connections (org_id,user_id,display_name,host,credential_id,auth_method,security_type,trust_mode) VALUES ('org','owner','Mismatch','mismatch.example.com','${credentialId}','${authMethod}','${securityType}','system')`,
        {
          code: constraint.endsWith("_fk") ? "23503" : "23514",
          constraint,
        },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }

  await client.query(
    "INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,auth_method,security_type,trust_mode) VALUES ('00000000-0000-4000-8000-000000000099','org','owner','Credentialless','none.example.com',NULL,'none','x509_none','system')",
  );
  const credentialless = await client.query(
    "SELECT credential_id,auth_method,security_type FROM vnc_connections WHERE id='00000000-0000-4000-8000-000000000099'",
  );
  assert.deepEqual(credentialless.rows, [
    { credential_id: null, auth_method: "none", security_type: "x509_none" },
  ]);
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET security_type='x509_vnc' WHERE id='00000000-0000-4000-8000-000000000099'",
      { code: "23514", constraint: "chk_vnc_connections_profile" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET credential_id='00000000-0000-4000-8000-000000000001' WHERE id='00000000-0000-4000-8000-000000000099'",
      { code: "23514", constraint: "chk_vnc_connections_profile" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  await client.query(
    "DELETE FROM vnc_connections WHERE id='00000000-0000-4000-8000-000000000099'",
  );

  // New certificate-bearing records are distinct from both existing certificate-free pairs.
  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_password,encrypted_client_identity)
      VALUES ('00000000-0000-4000-8000-000000000080','org','owner','Client cert','client_certificate',NULL,'kms-key'),
             ('00000000-0000-4000-8000-000000000081','org','owner','Client cert and password','client_certificate_vnc_password','kms-password','kms-key');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000082','org','owner','Mutual TLS','mtls.example.com','00000000-0000-4000-8000-000000000080','client_certificate','x509_none','system'),
             ('00000000-0000-4000-8000-000000000083','org','owner','Mutual TLS VNC','mtlsvnc.example.com','00000000-0000-4000-8000-000000000081','client_certificate_vnc_password','x509_vnc','system');
  `);
  for (const [assignment, constraint] of [
    ["encrypted_client_identity=NULL", "chk_vnc_credentials_password"],
    ["encrypted_password='unexpected'", "chk_vnc_credentials_password"],
    ["username='unexpected'", "chk_vnc_credentials_auth"],
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_credentials SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000080'`,
        { code: "23514", constraint },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  for (const assignment of [
    "security_type='x509_vnc'",
    "auth_method='none'",
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000082'`,
        { code: "23514", constraint: "chk_vnc_connections_profile" },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET credential_id='00000000-0000-4000-8000-000000000081' WHERE id='00000000-0000-4000-8000-000000000082'",
      { code: "23503", constraint: "vnc_connections_credential_profile_fk" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  await client.query(
    "DELETE FROM vnc_connections WHERE id IN ('00000000-0000-4000-8000-000000000082','00000000-0000-4000-8000-000000000083')",
  );
  await client.query(
    "DELETE FROM vnc_credentials WHERE id IN ('00000000-0000-4000-8000-000000000080','00000000-0000-4000-8000-000000000081')",
  );

  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET username='operator',auth_method='username_password' WHERE id='00000000-0000-4000-8000-000000000001'",
      { code: "23503", constraint: "vnc_connections_credential_profile_fk" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "DELETE FROM vnc_credentials WHERE id='00000000-0000-4000-8000-000000000001'",
      { code: /^(23503|23001)$/ },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }

  for (const [assignment, constraint] of [
    ["revision=0", "chk_vnc_credentials_revision"],
    ["auth_method='unsupported'", "chk_vnc_credentials_auth"],
    ["encrypted_password=''", "chk_vnc_credentials_password"],
    ["name=''", "chk_vnc_credentials_name"],
    ["username='unexpected'", "chk_vnc_credentials_auth"],
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_credentials SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000001'`,
        { code: "23514", constraint },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  for (const [assignment, expected] of [
    [
      "username=NULL",
      { code: "23514", constraint: "chk_vnc_credentials_auth" },
    ],
    ["username=''", { code: "23514", constraint: "chk_vnc_credentials_auth" }],
    [
      "username=repeat('é',128)",
      { code: "23514", constraint: "chk_vnc_credentials_auth" },
    ],
    ["username=repeat('x',256)", { code: "22001" }],
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_credentials SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000002'`,
        expected,
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET encrypted_password=NULL WHERE id='00000000-0000-4000-8000-000000000001'",
      { code: "23514", constraint: "chk_vnc_credentials_password" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET auth_method=NULL WHERE id='00000000-0000-4000-8000-000000000001'",
      { code: "23502" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET auth_method=NULL WHERE id='00000000-0000-4000-8000-000000000003'",
      { code: "23502" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET security_type=NULL WHERE id='00000000-0000-4000-8000-000000000003'",
      { code: "23502" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  for (const [assignment, constraint] of [
    ["generation=0", "chk_vnc_connections_generation"],
    ["security_type='unsupported'", "chk_vnc_connections_profile"],
    ["port=0", "chk_vnc_connections_port"],
    ["port=65536", "chk_vnc_connections_port"],
    ["display_name=''", "chk_vnc_connections_display_name"],
    ["host=''", "chk_vnc_connections_host"],
    ["host='DESKTOP.example.com'", "chk_vnc_connections_host"],
    ["host='desktop.example.com/path'", "chk_vnc_connections_host"],
    ["trust_mode='insecure'", "chk_vnc_connections_trust"],
    ["ca_bundle='unexpected'", "chk_vnc_connections_trust"],
    ["trust_mode='custom_ca'", "chk_vnc_connections_trust"],
    ["trust_mode='custom_ca',ca_bundle=''", "chk_vnc_connections_trust"],
    [
      "trust_mode='custom_ca',ca_bundle=repeat('x',65537)",
      "chk_vnc_connections_trust",
    ],
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000003'`,
        { code: "23514", constraint },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }

  // PEM parsing belongs to the API; storage enforces the discriminated shape.
  await client.query(
    "UPDATE vnc_connections SET trust_mode='custom_ca',ca_bundle='public-certificate',host='2001:db8::1' WHERE id='00000000-0000-4000-8000-000000000003'",
  );
  await client.query(
    "UPDATE vnc_connections SET trust_mode='system',ca_bundle=NULL,generation=2147483647 WHERE id='00000000-0000-4000-8000-000000000003'",
  );
  await client.query(
    "UPDATE vnc_credentials SET revision=2147483647 WHERE id='00000000-0000-4000-8000-000000000001'",
  );

  // QEMU SCRAM is a distinct verified-TLS pair; the migration preserves old rows.
  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000021','org','owner','QEMU SCRAM','operator','qemu_scram_sha256','scram-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,auth_method,security_type,trust_mode,x509_server_name)
      VALUES ('00000000-0000-4000-8000-000000000022','org','owner','QEMU SCRAM','qemu.example.com','00000000-0000-4000-8000-000000000021','qemu_scram_sha256','qemu_x509_sasl','system','qemu.example.com');
  `);
  for (const assignment of [
    "username='has space'",
    "username='has,comma'",
    "username='has=equal'",
    "username='é'",
    "username=''",
  ]) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_credentials SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000021'`,
        { code: "23514", constraint: "chk_vnc_credentials_auth" },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET username=repeat('x',256) WHERE id='00000000-0000-4000-8000-000000000021'",
      { code: "22001" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  for (const securityType of ["x509_plain", "x509_vnc", "x509_none"]) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET security_type='${securityType}' WHERE id='00000000-0000-4000-8000-000000000022'`,
        { code: "23514", constraint: "chk_vnc_connections_profile" },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET credential_id='00000000-0000-4000-8000-000000000002' WHERE id='00000000-0000-4000-8000-000000000022'",
      { code: "23503", constraint: "vnc_connections_credential_profile_fk" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }

  // One existing classic password can be explicitly selected for either X509Vnc
  // or Mac type 2; the saved security remains a distinct, constrained profile.
  await client.query(`
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,transport_type,ssh_connection_id,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000018','org','owner','Mac classic password','127.0.0.1','ssh','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000001','vnc_password','apple_vnc_password','none');
  `);
  for (const [assignment, constraint] of [
    ["host='localhost'", "chk_vnc_connections_profile"],
    [
      "transport_type='direct',ssh_connection_id=NULL",
      "chk_vnc_connections_profile",
    ],
    ["x509_server_name='mac.example.com'", "chk_vnc_connections_profile"],
    ["trust_mode='system'", "chk_vnc_connections_trust"],
    ["ca_bundle='unexpected'", "chk_vnc_connections_trust"],
    ["security_type='apple_dh'", "chk_vnc_connections_profile"],
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000018'`,
        { code: "23514", constraint },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  await client.query(
    "UPDATE vnc_connections SET host='::1' WHERE id='00000000-0000-4000-8000-000000000018'",
  );

  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000012','org','owner','Mac login','operator','apple_dh_username_password','apple-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,transport_type,ssh_connection_id,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000013','org','owner','Mac Screen Sharing','127.0.0.1','ssh','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000012','apple_dh_username_password','apple_dh','none');
  `);
  for (const [assignment, constraint] of [
    ["host='mac.example.com'", "chk_vnc_connections_profile"],
    [
      "transport_type='direct',ssh_connection_id=NULL",
      "chk_vnc_connections_profile",
    ],
    ["x509_server_name='mac.example.com'", "chk_vnc_connections_profile"],
    ["trust_mode='system'", "chk_vnc_connections_trust"],
    ["ca_bundle='unexpected'", "chk_vnc_connections_trust"],
    ["security_type='x509_plain'", "chk_vnc_connections_profile"],
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000013'`,
        { code: "23514", constraint },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET username=repeat('é',32) WHERE id='00000000-0000-4000-8000-000000000012'",
      { code: "23514", constraint: "chk_vnc_credentials_auth" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  await client.query(
    "UPDATE vnc_credentials SET username=repeat('x',63) WHERE id='00000000-0000-4000-8000-000000000012'",
  );
  await client.query(
    "UPDATE vnc_connections SET host='::1' WHERE id='00000000-0000-4000-8000-000000000013'",
  );

  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000014','org','owner','Mac SRP login','operator','apple_srp_username_password','apple-srp-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,transport_type,ssh_connection_id,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000015','org','owner','Mac Screen Sharing SRP','127.0.0.1','ssh','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000014','apple_srp_username_password','apple_srp','none');
  `);
  for (const [assignment, constraint] of [
    ["host='localhost'", "chk_vnc_connections_profile"],
    [
      "transport_type='direct',ssh_connection_id=NULL",
      "chk_vnc_connections_profile",
    ],
    ["security_type='apple_dh'", "chk_vnc_connections_profile"],
    ["trust_mode='system'", "chk_vnc_connections_trust"],
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000015'`,
        { code: "23514", constraint },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET username=repeat('é',128) WHERE id='00000000-0000-4000-8000-000000000014'",
      { code: "23514", constraint: "chk_vnc_credentials_auth" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  await client.query(
    "UPDATE vnc_credentials SET username=repeat('x',255) WHERE id='00000000-0000-4000-8000-000000000014'",
  );

  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000016','org','owner','Mac RSA/SRP login','operator','apple_rsa_srp_username_password','rsa-srp-ciphertext');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,transport_type,ssh_connection_id,credential_id,auth_method,security_type,trust_mode)
      VALUES ('00000000-0000-4000-8000-000000000017','org','owner','Mac Screen Sharing RSA/SRP','127.0.0.1','ssh','00000000-0000-4000-8000-000000000010','00000000-0000-4000-8000-000000000016','apple_rsa_srp_username_password','apple_rsa_srp','none');
  `);
  for (const [assignment, constraint] of [
    ["host='localhost'", "chk_vnc_connections_profile"],
    [
      "transport_type='direct',ssh_connection_id=NULL",
      "chk_vnc_connections_profile",
    ],
    ["security_type='apple_srp'", "chk_vnc_connections_profile"],
    ["trust_mode='system'", "chk_vnc_connections_trust"],
  ] as const) {
    {
      const sourceImage = decodeSnapshot(
        (await client.query(fixtureSnapshotQuery())).rows,
        schema,
      );
      await rejects(
        `UPDATE vnc_connections SET ${assignment} WHERE id='00000000-0000-4000-8000-000000000017'`,
        { code: "23514", constraint },
        nativeOwnership,
        sourceImage,
      );
      assert.deepEqual(
        decodeSnapshot(
          (await client.query(fixtureSnapshotQuery())).rows,
          schema,
        ),
        sourceImage,
      );
    }
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET username=repeat('é',118) WHERE id='00000000-0000-4000-8000-000000000016'",
      { code: "23514", constraint: "chk_vnc_credentials_auth" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  await client.query(
    "UPDATE vnc_credentials SET username=repeat('é',117) WHERE id='00000000-0000-4000-8000-000000000016'",
  );
  await client.query(
    "UPDATE vnc_connections SET host='::1' WHERE id='00000000-0000-4000-8000-000000000017'",
  );

  await client.query(`
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,username,encrypted_password) VALUES
      ('00000000-0000-4000-8000-000000000018','org','owner','RSA password','rsa_aes_password',NULL,'rsa-password-ciphertext'),
      ('00000000-0000-4000-8000-000000000019','org','owner','RSA user','rsa_aes_username_password',repeat('界',85),'rsa-user-ciphertext');
  `);
  for (const method of ["rsa_aes_password", "rsa_aes_username_password"]) {
    const credential =
      method === "rsa_aes_password"
        ? "00000000-0000-4000-8000-000000000018"
        : "00000000-0000-4000-8000-000000000019";
    for (const security of [
      "rsa_aes_ra2",
      "rsa_aes_ra2_256",
      "rsa_aes_ra2ne",
      "rsa_aes_ra2ne_256",
    ]) {
      const id = randomUUID();
      await client.query(`INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,transport_type,ssh_connection_id,credential_id,auth_method,security_type,trust_mode,rsa_server_key_sha256)
        VALUES ('${id}','org','owner','RSA loopback','127.0.0.1','ssh','00000000-0000-4000-8000-000000000010','${credential}','${method}','${security}','none',repeat('a',64))`);
      for (const assignment of [
        "rsa_server_key_sha256=NULL",
        "rsa_server_key_sha256=repeat('A',64)",
        "rsa_server_key_sha256=repeat('a',40)",
        "ca_bundle='not-a-ca'",
        "x509_server_name='other.example.com'",
        "trust_mode='system'",
      ]) {
        {
          const sourceImage = decodeSnapshot(
            (await client.query(fixtureSnapshotQuery())).rows,
            schema,
          );
          await rejects(
            `UPDATE vnc_connections SET ${assignment} WHERE id='${id}'`,
            { code: "23514" },
            nativeOwnership,
            sourceImage,
          );
          assert.deepEqual(
            decodeSnapshot(
              (await client.query(fixtureSnapshotQuery())).rows,
              schema,
            ),
            sourceImage,
          );
        }
      }
      if (security.includes("ra2ne")) {
        for (const assignment of [
          "transport_type='direct',ssh_connection_id=NULL",
          "host='localhost'",
          "host='other.example.com'",
        ]) {
          {
            const sourceImage = decodeSnapshot(
              (await client.query(fixtureSnapshotQuery())).rows,
              schema,
            );
            await rejects(
              `UPDATE vnc_connections SET ${assignment} WHERE id='${id}'`,
              { code: "23514" },
              nativeOwnership,
              sourceImage,
            );
            assert.deepEqual(
              decodeSnapshot(
                (await client.query(fixtureSnapshotQuery())).rows,
                schema,
              ),
              sourceImage,
            );
          }
        }
      } else {
        await client.query(
          `UPDATE vnc_connections SET transport_type='direct',ssh_connection_id=NULL,host='rsa.example.com' WHERE id='${id}'`,
        );
      }
      await client.query(`DELETE FROM vnc_connections WHERE id='${id}'`);
    }
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET username=repeat('é',128) WHERE id='00000000-0000-4000-8000-000000000019'",
      { code: "23514", constraint: "chk_vnc_credentials_auth" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET username='not-password-only' WHERE id='00000000-0000-4000-8000-000000000018'",
      { code: "23514", constraint: "chk_vnc_credentials_auth" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET rsa_server_key_sha256=repeat('a',64) WHERE id='00000000-0000-4000-8000-000000000003'",
      { code: "23514", constraint: "chk_vnc_connections_rsa_pin" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  await client.query(`
    INSERT INTO ssh_connections (id,org_id,user_id)
      VALUES ('00000000-0000-4000-8000-00000000b015','org','owner');
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_kerberos_credential,kerberos_initiator)
      VALUES ('00000000-0000-4000-8000-00000000b013','org','owner','Online Kerberos','qemu_kerberos_password','synthetic-ciphertext',
        '{"realm":"EXAMPLE.INVALID","components":["alice"]}');
    INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,port,credential_id,auth_method,security_type,trust_mode,kerberos_service,
      kdc_transport_type,kdc_host,kdc_port,kerberos_ticket_lifetime_seconds,kerberos_renewable_lifetime_seconds)
      VALUES ('00000000-0000-4000-8000-00000000b014','org','owner','Kerberos','desktop.example.com',5900,
        '00000000-0000-4000-8000-00000000b013','qemu_kerberos_password','qemu_x509_gssapi','system',
        '{"realm":"EXAMPLE.INVALID","components":["vnc","desktop.example.com"]}', 'direct','kdc.example.com',88,1200,7200);
  `);
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_credentials SET encrypted_password='wrong-source' WHERE id='00000000-0000-4000-8000-00000000b013'",
      { code: "23514", constraint: "chk_vnc_credentials_password" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      'UPDATE vnc_credentials SET kerberos_initiator=\'{"realm":"EXAMPLE.INVALID","components":[false]}\' WHERE id=\'00000000-0000-4000-8000-00000000b013\'',
      { code: "23514", constraint: "chk_vnc_credentials_kerberos_initiator" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      'UPDATE vnc_credentials SET kerberos_initiator=\'{"realm":"EXAMPLE.INVALID","components":["alice"],"ambient":true}\' WHERE id=\'00000000-0000-4000-8000-00000000b013\'',
      { code: "23514", constraint: "chk_vnc_credentials_kerberos_initiator" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET kerberos_ticket_lifetime_seconds=7201 WHERE id='00000000-0000-4000-8000-00000000b014'",
      { code: "23514", constraint: "chk_vnc_connections_kdc" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET kdc_transport_type=NULL WHERE id='00000000-0000-4000-8000-00000000b014'",
      { code: "23514", constraint: "chk_vnc_connections_kdc" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "UPDATE vnc_connections SET kdc_transport_type='ssh',kdc_host='127.0.0.1',kdc_ssh_connection_id='00000000-0000-4000-8000-000000000011' WHERE id='00000000-0000-4000-8000-00000000b014'",
      { code: "23503", constraint: "vnc_connections_kdc_ssh_owner_fk" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  await client.query(
    "UPDATE vnc_connections SET kdc_transport_type='ssh',kdc_host='127.0.0.1',kdc_ssh_connection_id='00000000-0000-4000-8000-00000000b015' WHERE id='00000000-0000-4000-8000-00000000b014'",
  );
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      "DELETE FROM ssh_connections WHERE id='00000000-0000-4000-8000-00000000b015'",
      {
        code: /^(23503|23001)$/,
        constraint: "vnc_connections_kdc_ssh_owner_fk",
      },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  {
    const sourceImage = decodeSnapshot(
      (await client.query(fixtureSnapshotQuery())).rows,
      schema,
    );
    await rejects(
      'UPDATE vnc_connections SET kerberos_service=\'{"realm":"EXAMPLE.INVALID","components":["host","desktop.example.com"]}\' WHERE id=\'00000000-0000-4000-8000-00000000b014\'',
      { code: "23514", constraint: "chk_vnc_connections_kerberos_service" },
      nativeOwnership,
      sourceImage,
    );
    assert.deepEqual(
      decodeSnapshot((await client.query(fixtureSnapshotQuery())).rows, schema),
      sourceImage,
    );
  }
  await client.query(
    "DELETE FROM vnc_connections WHERE id='00000000-0000-4000-8000-00000000b014'",
  );
  await client.query(
    "DELETE FROM vnc_credentials WHERE id='00000000-0000-4000-8000-00000000b013'",
  );
  await client.query("DELETE FROM vnc_connections");
  await client.query("DELETE FROM ssh_connections");
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM vnc_credentials"))
      .rows,
    [{ count: 10 }],
  );
  await client.query("DELETE FROM vnc_credentials");
} catch (error) {
  failures.push(error);
} finally {
  if (nativeOwnership !== undefined) {
    try {
      await disposeNative(nativeOwnership);
    } catch (error) {
      failures.push(error);
    }
  }
  if (positiveCreateAcknowledged) {
    try {
      await client.query(`DROP SCHEMA "${schema}" CASCADE`);
    } catch (error) {
      failures.push(error);
    }
    try {
      assert.deepEqual(
        namespaceRows.parse(
          (
            await client.query(
              "SELECT nspname FROM pg_namespace WHERE nspname=$1",
              [schema],
            )
          ).rows,
        ),
        [],
      );
    } catch (error) {
      failures.push(error);
    }
  }
  if (originalPath !== undefined) {
    try {
      await client.query("SELECT set_config('search_path',$1,false)", [
        originalPath,
      ]);
    } catch (error) {
      failures.push(error);
    }
    try {
      assert.deepEqual(
        searchPathRows.parse((await client.query("SHOW search_path")).rows),
        [{ search_path: originalPath }],
      );
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    await client.end();
  } catch (error) {
    failures.push(error);
  }
}
throwFailures(failures);
console.log("VNC preservation migrations and storage constraints passed");
