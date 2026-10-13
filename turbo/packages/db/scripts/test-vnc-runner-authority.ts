import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const client = new Client({ connectionString: databaseUrl });
const schema = `vnc_runner_authority_${randomUUID().replaceAll("-", "")}`;

const timestamp = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
const agentRows = z.array(z.strictObject({ id: z.uuid() }));
const credentialRows = z.array(
  z.strictObject({
    id: z.uuid(),
    org_id: z.string(),
    user_id: z.string(),
    name: z.string(),
    auth_method: z.string(),
    encrypted_password: z.string(),
    revision: z.int(),
    created_at: timestamp,
    updated_at: timestamp,
  }),
);
const connectionRows = z.array(
  z.strictObject({
    id: z.uuid(),
    org_id: z.string(),
    user_id: z.string(),
    display_name: z.string(),
    host: z.string(),
    port: z.int(),
    credential_id: z.uuid(),
    security_type: z.string(),
    trust_mode: z.string(),
    ca_bundle: z.string().nullable(),
    generation: z.int(),
    created_at: timestamp,
    updated_at: timestamp,
  }),
);
const grantRows = z.array(
  z.strictObject({
    org_id: z.string(),
    user_id: z.string(),
    agent_id: z.uuid(),
    created_at: timestamp,
  }),
);
const credentialSelect = `
  SELECT id,org_id,user_id,name,auth_method,encrypted_password,revision,
    to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
    to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS updated_at
  FROM vnc_credentials ORDER BY id
`;
const connectionSelect = `
  SELECT id,org_id,user_id,display_name,host,port,credential_id,security_type,trust_mode,ca_bundle,generation,
    to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at,
    to_char(updated_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS updated_at
  FROM vnc_connections ORDER BY id
`;
const grantSelect = `
  SELECT org_id,user_id,agent_id,
    to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') AS created_at
  FROM agent_vnc_access ORDER BY org_id,user_id,agent_id
`;

async function rejects(
  query: string,
  expected: { code: string; constraint?: string },
  expectedGrants: string[][],
): Promise<void> {
  const before = {
    agents: agentRows.parse(
      (await client.query("SELECT id FROM agents ORDER BY id")).rows,
    ),
    credentials: credentialRows.parse(
      (await client.query(credentialSelect)).rows,
    ),
    connections: connectionRows.parse(
      (await client.query(connectionSelect)).rows,
    ),
    grants: grantRows.parse((await client.query(grantSelect)).rows),
  };
  assert.deepEqual(before.agents, [
    { id: "00000000-0000-4000-8000-000000000003" },
  ]);
  assert.equal(before.credentials.length, 1);
  assert.equal(before.connections.length, 1);
  assert.deepEqual(
    before.grants.map((row) => {
      return [row.org_id, row.user_id, row.agent_id];
    }),
    expectedGrants,
  );
  await assert.rejects(client.query(query), expected);
  const after = {
    agents: agentRows.parse(
      (await client.query("SELECT id FROM agents ORDER BY id")).rows,
    ),
    credentials: credentialRows.parse(
      (await client.query(credentialSelect)).rows,
    ),
    connections: connectionRows.parse(
      (await client.query(connectionSelect)).rows,
    ),
    grants: grantRows.parse((await client.query(grantSelect)).rows),
  };
  assert.deepEqual(
    after,
    before,
    "Rejected writes must preserve every historical fixture field",
  );
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

const agentCredentialInsert = `
    INSERT INTO agents VALUES ('00000000-0000-4000-8000-000000000003');
    INSERT INTO vnc_credentials (id,org_id,user_id,name,auth_method,encrypted_password)
      VALUES ('00000000-0000-4000-8000-000000000001','org','owner','Password','vnc_password','retained-ciphertext');
  `;
const ownerGrantInsert = `
    INSERT INTO agent_vnc_access (org_id,user_id,agent_id)
      VALUES ('org','owner','00000000-0000-4000-8000-000000000003');
  `;
const otherUserGrantInsert =
  "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('org','other','00000000-0000-4000-8000-000000000003')";
const otherOrgGrantInsert =
  "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('other-org','owner','00000000-0000-4000-8000-000000000003')";

// Use only an exclusive disposable test database. Negative probes commit their
// historical fixture; abrupt termination can leave it until database disposal.
// The positive migration/default/cascade probes retain their original rollback.
const errors: unknown[] = [];
try {
  await client.connect();
  const originalSearchPath = z
    .tuple([z.strictObject({ search_path: z.string() })])
    .parse((await client.query("SHOW search_path")).rows);
  assert.deepEqual(
    (
      await client.query(
        "SELECT nspname FROM pg_namespace WHERE nspname = $1",
        [schema],
      )
    ).rows,
    [],
    "The negative schema must not pre-exist",
  );
  let schemaOwned = false;
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaOwned = true;
    await client.query(`SET search_path TO "${schema}"`);
    await client.query("CREATE TABLE agents (id uuid PRIMARY KEY)");
    await migrate("1158_vnc_configuration");
    await client.query(agentCredentialInsert);
    await client.query(legacyConnectionInsert);
    await migrate("1160_vnc_runner_authority");
    await client.query(ownerGrantInsert);
    await rejects(
      "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('org','owner','00000000-0000-4000-8000-000000000003')",
      { code: "23505", constraint: "agent_vnc_access_pkey" },
      [["org", "owner", "00000000-0000-4000-8000-000000000003"]],
    );
    await client.query(otherUserGrantInsert);
    await client.query(otherOrgGrantInsert);
    await rejects(
      "INSERT INTO agent_vnc_access (org_id,user_id,agent_id) VALUES ('org','owner','00000000-0000-4000-8000-000000000099')",
      { code: "23503", constraint: "agent_vnc_access_agent_id_agents_id_fk" },
      [
        ["org", "other", "00000000-0000-4000-8000-000000000003"],
        ["org", "owner", "00000000-0000-4000-8000-000000000003"],
        ["other-org", "owner", "00000000-0000-4000-8000-000000000003"],
      ],
    );
  } catch (error) {
    errors.push(error);
  } finally {
    try {
      if (schemaOwned) {
        await client.query(`DROP SCHEMA "${schema}" CASCADE`);
        assert.deepEqual(
          (
            await client.query(
              "SELECT nspname FROM pg_namespace WHERE nspname = $1",
              [schema],
            )
          ).rows,
          [],
          "The owned negative schema must be absent before BEGIN",
        );
      }
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await client.query("SELECT set_config('search_path', $1, false)", [
          originalSearchPath[0].search_path,
        ]);
        assert.deepEqual(
          (await client.query("SHOW search_path")).rows,
          originalSearchPath,
        );
      } catch (error) {
        errors.push(error);
      }
    }
  }
  if (errors.length === 0) {
    try {
      // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0437; new non-billing transactions are prohibited.
      await client.query("BEGIN");
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`SET LOCAL search_path TO "${schema}"`);
      await client.query("CREATE TABLE agents (id uuid PRIMARY KEY)");
      await migrate("1158_vnc_configuration");
      await client.query(agentCredentialInsert);
      await client.query(legacyConnectionInsert);
      await migrate("1160_vnc_runner_authority");

      assert.deepEqual(
        (await client.query("SELECT encrypted_password FROM vnc_credentials"))
          .rows,
        [{ encrypted_password: "retained-ciphertext" }],
      );
      assert.deepEqual(
        (await client.query("SELECT host, generation FROM vnc_connections"))
          .rows,
        [{ host: "desktop.example.com", generation: 1 }],
      );

      await client.query(ownerGrantInsert);
      await client.query(otherUserGrantInsert);
      await client.query(otherOrgGrantInsert);
      await client.query("DELETE FROM agents");
      assert.deepEqual(
        (
          await client.query(
            "SELECT count(*)::int AS count FROM agent_vnc_access",
          )
        ).rows,
        [{ count: 0 }],
      );

      console.log(
        "VNC Runner authority migration and grant ownership constraints passed",
      );
    } catch (error) {
      errors.push(error);
    } finally {
      try {
        await client.query("ROLLBACK");
      } catch (error) {
        errors.push(error);
      }
    }
  }
} catch (error) {
  errors.push(error);
} finally {
  try {
    await client.end();
  } catch (error) {
    errors.push(error);
  }
}
if (errors.length === 1) {
  throw errors[0];
}
if (errors.length > 1) {
  throw new AggregateError(errors, "VNC authority checks or cleanup failed");
}
