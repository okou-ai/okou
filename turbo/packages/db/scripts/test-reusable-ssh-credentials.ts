import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
const schema = `ssh_credentials_${randomUUID().replaceAll("-", "")}`;
const negativeSchema = `ssh_credentials_negative_${randomUUID().replaceAll("-", "")}`;
async function migrate(name: string, targetSchema: string) {
  const sql = await readFile(
    new URL(`../src/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  await client.query(sql.replaceAll('"public".', `"${targetSchema}".`));
}
let hostId: string;
async function readFixtureRows() {
  const credentials = (
    await client.query("SELECT * FROM ssh_credentials ORDER BY id")
  ).rows;
  const connections = (
    await client.query("SELECT * FROM ssh_connections ORDER BY id")
  ).rows;
  assert.equal(credentials.length, 1);
  assert.equal(connections.length, 1);
  assert.deepEqual(
    credentials.map((row) => {
      return { id: row.id, org_id: row.org_id, user_id: row.user_id };
    }),
    [
      {
        id: "00000000-0000-4000-8000-000000000003",
        org_id: "org",
        user_id: "user",
      },
    ],
  );
  assert.deepEqual(
    connections.map((row) => {
      return {
        id: row.id,
        credential_id: row.credential_id,
        org_id: row.org_id,
        user_id: row.user_id,
      };
    }),
    [
      {
        id: hostId,
        credential_id: "00000000-0000-4000-8000-000000000003",
        org_id: "org",
        user_id: "user",
      },
    ],
  );
  return { credentials, connections };
}
async function rejects(
  query: string,
  expected: { code: string | RegExp; constraint?: string },
) {
  const before = await readFixtureRows();
  await assert.rejects(client.query(query), expected);
  assert.deepEqual(await readFixtureRows(), before);
}

// This validator runs only on a test-owned disposable database. Autocommit
// fixture timestamps are per query message; forced termination can leave the
// fixture namespaces until database disposal. Seed batches retain their own clocks.
const failures: unknown[] = [];
try {
  await client.connect();
  let searchPath: string | undefined;
  let negativeSchemaCreated = false;
  try {
    const path = (await client.query("SHOW search_path")).rows;
    assert.equal(path.length, 1);
    assert.equal(typeof path[0].search_path, "string");
    searchPath = path[0].search_path;
    assert.deepEqual(
      (
        await client.query(
          "SELECT nspname FROM pg_namespace WHERE nspname=$1",
          [negativeSchema],
        )
      ).rows,
      [],
    );
    await client.query(`CREATE SCHEMA "${negativeSchema}"`);
    negativeSchemaCreated = true;
    await client.query(`SET search_path TO "${negativeSchema}"`);
    await client.query(
      "CREATE TABLE agents (id uuid PRIMARY KEY, org_id text, owner text, description text)",
    );
    // Replay the selected historical prerequisite, not the complete snapshot or
    // current Drizzle schema. Keep each immutable SQL file in one query message.
    await migrate("1085_needy_nemesis", negativeSchema);
    await migrate("1104_flawless_alex_power", negativeSchema);
    await migrate("1113_reusable_ssh_credentials", negativeSchema);
    await client.query(`
      INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
        VALUES ('00000000-0000-4000-8000-000000000003','org','user','Shared','deploy','password','encrypted-password');
      INSERT INTO ssh_connections (org_id,user_id,display_name,host,credential_id)
        VALUES ('org','user','New host','new.example.com','00000000-0000-4000-8000-000000000003');
    `);
    const hosts = (
      await client.query("SELECT id FROM ssh_connections ORDER BY id")
    ).rows;
    assert.equal(hosts.length, 1);
    assert.equal(typeof hosts[0].id, "string");
    hostId = hosts[0].id;
    // PostgreSQL 18 reports RESTRICT violations as 23001 instead of 23503.
    await rejects("DELETE FROM ssh_credentials", {
      code: /^(23503|23001)$/,
      constraint: "ssh_connections_credential_owner_fk",
    });
    await rejects("UPDATE ssh_connections SET user_id='foreign'", {
      code: "23503",
      constraint: "ssh_connections_credential_owner_fk",
    });
    await rejects("UPDATE ssh_connections SET org_id='foreign'", {
      code: "23503",
      constraint: "ssh_connections_credential_owner_fk",
    });
    await rejects("UPDATE ssh_connections SET credential_id=NULL", {
      code: "23502",
    });
    await rejects(
      "UPDATE ssh_credentials SET encrypted_private_key='key' WHERE auth_method='password'",
      { code: "23514" },
    );
    await rejects("UPDATE ssh_credentials SET encrypted_password=NULL", {
      code: "23514",
    });
    await rejects("UPDATE ssh_credentials SET encrypted_password=''", {
      code: "23514",
    });
    await rejects("UPDATE ssh_credentials SET revision=0", { code: "23514" });
    await client.query(
      "UPDATE ssh_credentials SET auth_method='private_key',encrypted_private_key='key',encrypted_password=NULL",
    );
    await rejects("UPDATE ssh_credentials SET encrypted_passphrase=''", {
      code: "23514",
    });
    await rejects("UPDATE ssh_credentials SET encrypted_password='password'", {
      code: "23514",
    });
  } catch (error) {
    failures.push(error);
  } finally {
    try {
      if (negativeSchemaCreated) {
        await client.query(`DROP SCHEMA "${negativeSchema}" CASCADE`);
        assert.deepEqual(
          (
            await client.query(
              "SELECT nspname FROM pg_namespace WHERE nspname=$1",
              [negativeSchema],
            )
          ).rows,
          [],
        );
      }
    } catch (error) {
      failures.push(error);
    } finally {
      try {
        if (searchPath !== undefined) {
          await client.query("SELECT set_config('search_path', $1, false)", [
            searchPath,
          ]);
          assert.deepEqual((await client.query("SHOW search_path")).rows, [
            { search_path: searchPath },
          ]);
        }
      } catch (error) {
        failures.push(error);
      }
    }
  }

  // Never enter the original positive phase after a failed probe or cleanup.
  if (failures.length === 0) {
    const pathRows = z
      .array(z.strictObject({ search_path: z.string() }))
      .length(1);
    const namespaceRows = z.array(z.strictObject({ nspname: z.string() }));
    const countRows = z.array(z.strictObject({ count: z.int32() })).length(1);
    const descriptionRows = z
      .array(z.strictObject({ description: z.string().nullable() }))
      .length(1);
    const oldTableRows = z
      .array(z.strictObject({ old_table: z.string().nullable() }))
      .length(1);
    const restoredPathRows = z
      .array(z.strictObject({ set_config: z.string() }))
      .length(1);
    let positiveSearchPath: string | undefined;
    let positiveSchemaCreated = false;
    // pg can both reject a query and emit an error on transport termination.
    // Own every native event through the shared client's awaited end below.
    client.on("error", (error: Error) => {
      failures.push(error);
    });
    try {
      const [path] = pathRows.parse(
        (await client.query("SHOW search_path")).rows,
      );
      assert.ok(path);
      positiveSearchPath = path.search_path;
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
      positiveSchemaCreated = true;
      await client.query(`SET search_path TO "${schema}"`);
      await client.query(
        "CREATE TABLE agents (id uuid PRIMARY KEY, org_id text, owner text, description text)",
      );
      await migrate("1085_needy_nemesis", schema);
      await migrate("1104_flawless_alex_power", schema);
      await client.query(`
        INSERT INTO agents VALUES ('00000000-0000-4000-8000-000000000001', 'org', 'user', 'retained');
        INSERT INTO agent_ssh_access (org_id,user_id,agent_id) VALUES ('org','user','00000000-0000-4000-8000-000000000001');
        INSERT INTO ssh_connections (id,org_id,user_id,display_name,host,username,learned_host_key_algorithm,learned_host_key_fingerprint)
          VALUES ('00000000-0000-4000-8000-000000000002','org','user','Old host','ssh.example.com','deploy','ssh-ed25519','SHA256:old');
        INSERT INTO ssh_connection_credentials (connection_id,encrypted_private_key) VALUES ('00000000-0000-4000-8000-000000000002','old-ciphertext');
        INSERT INTO ssh_connection_observations VALUES ('00000000-0000-4000-8000-000000000002',1,now(),'authentication_failed');
      `);
      await migrate("1113_reusable_ssh_credentials", schema);
      for (const table of [
        "ssh_connections",
        "ssh_credentials",
        "ssh_connection_observations",
      ]) {
        assert.deepEqual(
          countRows.parse(
            (
              await client.query(
                `SELECT count(*)::int AS count FROM "${table}"`,
              )
            ).rows,
          ),
          [{ count: 0 }],
        );
      }
      assert.deepEqual(
        descriptionRows.parse(
          (await client.query("SELECT description FROM agents")).rows,
        ),
        [{ description: "retained" }],
      );
      assert.deepEqual(
        countRows.parse(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM agent_ssh_access",
            )
          ).rows,
        ),
        [{ count: 1 }],
      );
      assert.deepEqual(
        oldTableRows.parse(
          (
            await client.query(
              "SELECT to_regclass('ssh_connection_credentials') AS old_table",
            )
          ).rows,
        ),
        [{ old_table: null }],
      );

      await client.query(`
        INSERT INTO ssh_credentials (id,org_id,user_id,name,username,auth_method,encrypted_password)
          VALUES ('00000000-0000-4000-8000-000000000003','org','user','Shared','deploy','password','encrypted-password');
        INSERT INTO ssh_connections (org_id,user_id,display_name,host,credential_id)
          VALUES ('org','user','New host','new.example.com','00000000-0000-4000-8000-000000000003');
      `);
      await client.query(
        "UPDATE ssh_credentials SET auth_method='private_key',encrypted_private_key='key',encrypted_password=NULL",
      );
      await client.query("DELETE FROM ssh_connections");
      assert.deepEqual(
        countRows.parse(
          (
            await client.query(
              "SELECT count(*)::int AS count FROM ssh_credentials",
            )
          ).rows,
        ),
        [{ count: 1 }],
      );
      await client.query("DELETE FROM ssh_credentials");
    } catch (error) {
      failures.push(error);
    } finally {
      if (positiveSchemaCreated) {
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
      if (positiveSearchPath !== undefined) {
        try {
          assert.deepEqual(
            restoredPathRows.parse(
              (
                await client.query(
                  "SELECT set_config('search_path', $1, false)",
                  [positiveSearchPath],
                )
              ).rows,
            ),
            [{ set_config: positiveSearchPath }],
          );
        } catch (error) {
          failures.push(error);
        }
      }
      try {
        const paths = pathRows.parse(
          (await client.query("SHOW search_path")).rows,
        );
        if (positiveSearchPath !== undefined) {
          assert.deepEqual(paths, [{ search_path: positiveSearchPath }]);
        }
      } catch (error) {
        failures.push(error);
      }
    }
  }
} catch (error) {
  failures.push(error);
} finally {
  try {
    await client.end();
  } catch (error) {
    failures.push(error);
  }
}
if (failures.length > 0) {
  throw new AggregateError(
    failures,
    "Reusable SSH credential validation failed",
  );
}
console.log(
  "Reusable SSH credential reset scope and storage invariants passed",
);
