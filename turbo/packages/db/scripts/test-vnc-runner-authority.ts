import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
await client.connect();
const schema = `vnc_runner_authority_${randomUUID().replaceAll("-", "")}`;

async function rejects(
  query: string,
  expected: { code: string; constraint?: string },
) {
  await client.query("SAVEPOINT invalid_write");
  await assert.rejects(client.query(query), expected);
  await client.query("ROLLBACK TO SAVEPOINT invalid_write");
  await client.query("RELEASE SAVEPOINT invalid_write");
}

async function migrate(name: string) {
  const migration = await readFile(
    new URL(`../src/migrations/${name}.sql`, import.meta.url),
    "utf8",
  );
  await client.query(migration.replaceAll('"public".', `"${schema}".`));
}

const legacyConnectionInsert = `
  INSERT INTO vnc_connections (id,org_id,user_id,display_name,host,credential_id,security_type,trust_mode)
    VALUES ('00000000-0000-4000-8000-000000000002','org','owner','Desktop','desktop.example.com','00000000-0000-4000-8000-000000000001','x509_vnc','system')
`;
const leaseInsert = `
  INSERT INTO vnc_control_leases (connection_id,instance_id,generation,grant_id,holder_id,lease_token,run_id,runner_id,heartbeat_generation,expires_at)
    SELECT id,instance_id,generation,'00000000-0000-4000-8000-000000000004',
      '00000000-0000-4000-8000-000000000006','00000000-0000-4000-8000-000000000007',
      '00000000-0000-4000-8000-000000000008','00000000-0000-4000-8000-000000000009',1,clock_timestamp()+interval '30 seconds'
    FROM vnc_connections WHERE id='00000000-0000-4000-8000-000000000002'
`;

try {
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}"`);
  await client.query("CREATE TABLE agents (id uuid PRIMARY KEY)");
  await migrate("1158_vnc_configuration");
  await client.query(`
    INSERT INTO agents VALUES ('00000000-0000-4000-8000-000000000003');
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000001','org','owner','Password','vnc_password','retained-ciphertext');
  `);
  await client.query(legacyConnectionInsert);
  await migrate("1160_vnc_runner_authority");

  assert.deepEqual(
    (await client.query("SELECT encrypted_password FROM vnc_credentials")).rows,
    [{ encrypted_password: "retained-ciphertext" }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT count(instance_id)::int AS count FROM vnc_connections",
      )
    ).rows,
    [{ count: 1 }],
  );
  // An older configuration writer still omits the new private incarnation field.
  await client.query(
    legacyConnectionInsert.replace("000000000002", "000000000005"),
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT count(DISTINCT instance_id)::int AS count FROM vnc_connections",
      )
    ).rows,
    [{ count: 2 }],
  );
  await rejects("UPDATE vnc_connections SET instance_id=NULL", {
    code: "23502",
  });

  await client.query(`
    INSERT INTO agent_vnc_access (id,org_id,user_id,agent_id)
      VALUES ('00000000-0000-4000-8000-000000000004','org','owner','00000000-0000-4000-8000-000000000003');
  `);
  await rejects(
    "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('org','owner','00000000-0000-4000-8000-000000000003')",
    { code: "23505", constraint: "uq_agent_vnc_access_owner_agent" },
  );
  await client.query(
    "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('org','other','00000000-0000-4000-8000-000000000003')",
  );
  await client.query(leaseInsert);
  await rejects(leaseInsert, {
    code: "23505",
    constraint: "vnc_control_leases_pkey",
  });

  for (const assignment of ["generation=0", "generation=-1"]) {
    await rejects(`UPDATE vnc_control_leases SET ${assignment}`, {
      code: "23514",
      constraint: "chk_vnc_control_leases_generation",
    });
  }
  await rejects("UPDATE vnc_control_leases SET generation=2147483648", {
    code: "22003",
  });
  for (const value of ["0", "-1", "9007199254740992"]) {
    await rejects(
      `UPDATE vnc_control_leases SET heartbeat_generation=${value}`,
      {
        code: "23514",
        constraint: "chk_vnc_control_leases_runner_generation",
      },
    );
  }
  await client.query(
    "UPDATE vnc_control_leases SET generation=2147483647,heartbeat_generation=9007199254740991",
  );

  // Revoking a grant cannot erase the old holder's accepted lease lifetime.
  await client.query(
    "DELETE FROM agent_vnc_access WHERE id='00000000-0000-4000-8000-000000000004'",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM vnc_control_leases",
      )
    ).rows,
    [{ count: 1 }],
  );
  await client.query(`
    INSERT INTO agent_vnc_access (org_id,user_id,agent_id)
      VALUES ('org','owner','00000000-0000-4000-8000-000000000003');
    UPDATE vnc_control_leases SET grant_id=(SELECT id FROM agent_vnc_access WHERE user_id='owner');
  `);
  await client.query("DELETE FROM agents");
  assert.deepEqual(
    (await client.query("SELECT count(*)::int AS count FROM agent_vnc_access"))
      .rows,
    [{ count: 0 }],
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM vnc_control_leases",
      )
    ).rows,
    [{ count: 1 }],
  );

  await client.query(`
    CREATE TABLE previous_incarnation AS
      SELECT instance_id FROM vnc_connections WHERE id='00000000-0000-4000-8000-000000000002';
    DELETE FROM vnc_connections WHERE id='00000000-0000-4000-8000-000000000002';
  `);
  assert.deepEqual(
    (
      await client.query(
        "SELECT count(*)::int AS count FROM vnc_control_leases",
      )
    ).rows,
    [{ count: 0 }],
  );
  await client.query(legacyConnectionInsert);
  assert.deepEqual(
    (
      await client.query(`
      SELECT v.generation, v.instance_id <> p.instance_id AS fresh
      FROM vnc_connections v CROSS JOIN previous_incarnation p
      WHERE v.id='00000000-0000-4000-8000-000000000002'
    `)
    ).rows,
    [{ generation: 1, fresh: true }],
  );
  console.log(
    "VNC Runner authority migration and lease storage constraints passed",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
