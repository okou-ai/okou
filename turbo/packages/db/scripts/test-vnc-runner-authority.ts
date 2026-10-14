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
// Positive probes own a separate client and committed namespace with exact cleanup.
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
    const positiveClient = new Client({ connectionString: databaseUrl });
    const positiveSchema = `vnc_runner_authority_positive_${randomUUID().replaceAll("-", "")}`;
    const searchPathRows = z.tuple([
      z.strictObject({ search_path: z.string() }),
    ]);
    const namespaceRows = z.array(z.strictObject({ nspname: z.string() }));
    const int4 = z.int().min(-2147483648).max(2147483647);
    let capturedSearchPath: string | undefined;
    let positiveSchemaOwned = false;
    let positiveConnected = false;
    try {
      await positiveClient.connect();
      positiveConnected = true;
      capturedSearchPath = searchPathRows.parse(
        (await positiveClient.query("SHOW search_path")).rows,
      )[0].search_path;
      assert.deepEqual(
        namespaceRows.parse(
          (
            await positiveClient.query(
              "SELECT nspname FROM pg_namespace WHERE nspname = $1",
              [positiveSchema],
            )
          ).rows,
        ),
        [],
        "The positive schema must not pre-exist",
      );
      await positiveClient.query(`CREATE SCHEMA "${positiveSchema}"`);
      positiveSchemaOwned = true;
      await positiveClient.query(`SET search_path TO "${positiveSchema}"`);
      await positiveClient.query("CREATE TABLE agents (id uuid PRIMARY KEY)");
      const configurationMigration = await readFile(
        new URL(
          "../src/migrations/1158_vnc_configuration.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await positiveClient.query(
        configurationMigration.replaceAll('"public".', `"${positiveSchema}".`),
      );
      await positiveClient.query(agentCredentialInsert);
      await positiveClient.query(legacyConnectionInsert);

      const beforeMigration = {
        agents: agentRows.parse(
          (await positiveClient.query("SELECT id FROM agents ORDER BY id"))
            .rows,
        ),
        credentials: credentialRows.parse(
          (await positiveClient.query(credentialSelect)).rows,
        ),
        connections: connectionRows.parse(
          (await positiveClient.query(connectionSelect)).rows,
        ),
      };
      assert.deepEqual(beforeMigration.agents, [
        { id: "00000000-0000-4000-8000-000000000003" },
      ]);
      assert.equal(beforeMigration.credentials.length, 1);
      assert.equal(beforeMigration.connections.length, 1);
      const [credential] = beforeMigration.credentials;
      const [connection] = beforeMigration.connections;
      assert.ok(credential);
      assert.ok(connection);
      assert.deepEqual(credential, {
        id: "00000000-0000-4000-8000-000000000001",
        org_id: "org",
        user_id: "owner",
        name: "Password",
        auth_method: "vnc_password",
        encrypted_password: "retained-ciphertext",
        revision: 1,
        created_at: credential.created_at,
        updated_at: credential.created_at,
      });
      assert.deepEqual(connection, {
        id: "00000000-0000-4000-8000-000000000002",
        org_id: "org",
        user_id: "owner",
        display_name: "Desktop",
        host: "desktop.example.com",
        port: 5900,
        credential_id: "00000000-0000-4000-8000-000000000001",
        security_type: "x509_vnc",
        trust_mode: "system",
        ca_bundle: null,
        generation: 1,
        created_at: connection.created_at,
        updated_at: connection.created_at,
      });
      const authorityMigration = await readFile(
        new URL(
          "../src/migrations/1160_vnc_runner_authority.sql",
          import.meta.url,
        ),
        "utf8",
      );
      await positiveClient.query(
        authorityMigration.replaceAll('"public".', `"${positiveSchema}".`),
      );
      const afterMigration = {
        agents: agentRows.parse(
          (await positiveClient.query("SELECT id FROM agents ORDER BY id"))
            .rows,
        ),
        credentials: credentialRows.parse(
          (await positiveClient.query(credentialSelect)).rows,
        ),
        connections: connectionRows.parse(
          (await positiveClient.query(connectionSelect)).rows,
        ),
        grants: grantRows.parse((await positiveClient.query(grantSelect)).rows),
      };
      assert.deepEqual(afterMigration, { ...beforeMigration, grants: [] });

      assert.deepEqual(
        z
          .tuple([z.strictObject({ encrypted_password: z.string() })])
          .parse(
            (
              await positiveClient.query(
                "SELECT encrypted_password FROM vnc_credentials",
              )
            ).rows,
          ),
        [{ encrypted_password: "retained-ciphertext" }],
      );
      assert.deepEqual(
        z
          .tuple([z.strictObject({ host: z.string(), generation: int4 })])
          .parse(
            (
              await positiveClient.query(
                "SELECT host, generation FROM vnc_connections",
              )
            ).rows,
          ),
        [{ host: "desktop.example.com", generation: 1 }],
      );

      await positiveClient.query(ownerGrantInsert);
      await positiveClient.query(otherUserGrantInsert);
      await positiveClient.query(otherOrgGrantInsert);
      const beforeCascade = {
        agents: agentRows.parse(
          (await positiveClient.query("SELECT id FROM agents ORDER BY id"))
            .rows,
        ),
        credentials: credentialRows.parse(
          (await positiveClient.query(credentialSelect)).rows,
        ),
        connections: connectionRows.parse(
          (await positiveClient.query(connectionSelect)).rows,
        ),
        grants: grantRows.parse((await positiveClient.query(grantSelect)).rows),
      };
      assert.deepEqual({ ...beforeCascade, grants: [] }, afterMigration);
      assert.deepEqual(
        beforeCascade.grants.map((row) => {
          return [row.org_id, row.user_id, row.agent_id];
        }),
        [
          ["org", "other", "00000000-0000-4000-8000-000000000003"],
          ["org", "owner", "00000000-0000-4000-8000-000000000003"],
          ["other-org", "owner", "00000000-0000-4000-8000-000000000003"],
        ],
      );
      await positiveClient.query("DELETE FROM agents");
      assert.deepEqual(
        z
          .tuple([z.strictObject({ count: int4 })])
          .parse(
            (
              await positiveClient.query(
                "SELECT count(*)::int AS count FROM agent_vnc_access",
              )
            ).rows,
          ),
        [{ count: 0 }],
      );
      const afterCascade = {
        agents: agentRows.parse(
          (await positiveClient.query("SELECT id FROM agents ORDER BY id"))
            .rows,
        ),
        credentials: credentialRows.parse(
          (await positiveClient.query(credentialSelect)).rows,
        ),
        connections: connectionRows.parse(
          (await positiveClient.query(connectionSelect)).rows,
        ),
        grants: grantRows.parse((await positiveClient.query(grantSelect)).rows),
      };
      assert.deepEqual(afterCascade, {
        ...beforeMigration,
        agents: [],
        grants: [],
      });

      // Keep the complete native catalog, including PG18's NOT NULL records.
      const [version] = z
        .tuple([
          z.strictObject({
            server_version_num: z.string().regex(/^(17|18)\d{4}$/),
          }),
        ])
        .parse((await positiveClient.query("SHOW server_version_num")).rows);
      const columns = z
        .array(
          z.strictObject({
            table_name: z.string(),
            ordinal: int4,
            attname: z.string(),
            type_oid: int4,
            formatted_type: z.string(),
            attnotnull: z.boolean(),
            default_expression: z.string().nullable(),
            datetime_precision: int4.nullable(),
          }),
        )
        .parse(
          (
            await positiveClient.query(
              `
        SELECT c.relname AS table_name, a.attnum::int AS ordinal, a.attname,
          a.atttypid::int AS type_oid, format_type(a.atttypid,a.atttypmod) AS formatted_type,
          a.attnotnull, pg_get_expr(d.adbin,d.adrelid) AS default_expression,
          i.datetime_precision::int AS datetime_precision
        FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
        JOIN information_schema.columns i ON i.table_schema = n.nspname
          AND i.table_name = c.relname AND i.column_name = a.attname
        WHERE n.nspname = $1 AND a.attnum > 0 AND NOT a.attisdropped
        ORDER BY c.relname COLLATE "C", a.attnum
      `,
              [positiveSchema],
            )
          ).rows,
        );
      const expectedColumns = [
        {
          table_name: "agent_vnc_access",
          ordinal: 1,
          attname: "org_id",
          type_oid: 25,
          formatted_type: "text",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "agent_vnc_access",
          ordinal: 2,
          attname: "user_id",
          type_oid: 25,
          formatted_type: "text",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "agent_vnc_access",
          ordinal: 3,
          attname: "agent_id",
          type_oid: 2950,
          formatted_type: "uuid",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "agent_vnc_access",
          ordinal: 4,
          attname: "created_at",
          type_oid: 1114,
          formatted_type: "timestamp without time zone",
          attnotnull: true,
          default_expression: "now()",
          datetime_precision: 6,
        },
        {
          table_name: "agents",
          ordinal: 1,
          attname: "id",
          type_oid: 2950,
          formatted_type: "uuid",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 1,
          attname: "id",
          type_oid: 2950,
          formatted_type: "uuid",
          attnotnull: true,
          default_expression: "gen_random_uuid()",
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 2,
          attname: "org_id",
          type_oid: 25,
          formatted_type: "text",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 3,
          attname: "user_id",
          type_oid: 25,
          formatted_type: "text",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 4,
          attname: "display_name",
          type_oid: 1043,
          formatted_type: "character varying(128)",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 5,
          attname: "host",
          type_oid: 1043,
          formatted_type: "character varying(253)",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 6,
          attname: "port",
          type_oid: 23,
          formatted_type: "integer",
          attnotnull: true,
          default_expression: "5900",
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 7,
          attname: "credential_id",
          type_oid: 2950,
          formatted_type: "uuid",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 8,
          attname: "security_type",
          type_oid: 1043,
          formatted_type: "character varying(32)",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 9,
          attname: "trust_mode",
          type_oid: 1043,
          formatted_type: "character varying(16)",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 10,
          attname: "ca_bundle",
          type_oid: 25,
          formatted_type: "text",
          attnotnull: false,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 11,
          attname: "generation",
          type_oid: 23,
          formatted_type: "integer",
          attnotnull: true,
          default_expression: "1",
          datetime_precision: null,
        },
        {
          table_name: "vnc_connections",
          ordinal: 12,
          attname: "created_at",
          type_oid: 1114,
          formatted_type: "timestamp without time zone",
          attnotnull: true,
          default_expression: "now()",
          datetime_precision: 6,
        },
        {
          table_name: "vnc_connections",
          ordinal: 13,
          attname: "updated_at",
          type_oid: 1114,
          formatted_type: "timestamp without time zone",
          attnotnull: true,
          default_expression: "now()",
          datetime_precision: 6,
        },
        {
          table_name: "vnc_credentials",
          ordinal: 1,
          attname: "id",
          type_oid: 2950,
          formatted_type: "uuid",
          attnotnull: true,
          default_expression: "gen_random_uuid()",
          datetime_precision: null,
        },
        {
          table_name: "vnc_credentials",
          ordinal: 2,
          attname: "org_id",
          type_oid: 25,
          formatted_type: "text",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_credentials",
          ordinal: 3,
          attname: "user_id",
          type_oid: 25,
          formatted_type: "text",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_credentials",
          ordinal: 4,
          attname: "name",
          type_oid: 1043,
          formatted_type: "character varying(128)",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_credentials",
          ordinal: 5,
          attname: "auth_method",
          type_oid: 1043,
          formatted_type: "character varying(32)",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_credentials",
          ordinal: 6,
          attname: "encrypted_password",
          type_oid: 25,
          formatted_type: "text",
          attnotnull: true,
          default_expression: null,
          datetime_precision: null,
        },
        {
          table_name: "vnc_credentials",
          ordinal: 7,
          attname: "revision",
          type_oid: 23,
          formatted_type: "integer",
          attnotnull: true,
          default_expression: "1",
          datetime_precision: null,
        },
        {
          table_name: "vnc_credentials",
          ordinal: 8,
          attname: "created_at",
          type_oid: 1114,
          formatted_type: "timestamp without time zone",
          attnotnull: true,
          default_expression: "now()",
          datetime_precision: 6,
        },
        {
          table_name: "vnc_credentials",
          ordinal: 9,
          attname: "updated_at",
          type_oid: 1114,
          formatted_type: "timestamp without time zone",
          attnotnull: true,
          default_expression: "now()",
          datetime_precision: 6,
        },
      ];
      assert.deepEqual(columns, expectedColumns);
      const constraints = z
        .array(
          z.strictObject({
            table_name: z.string(),
            conname: z.string(),
            contype: z.enum(["p", "u", "c", "f", "n"]),
            condeferrable: z.boolean(),
            condeferred: z.boolean(),
            convalidated: z.boolean(),
            confupdtype: z.string(),
            confdeltype: z.string(),
            definition: z.string(),
          }),
        )
        .parse(
          (
            await positiveClient.query(
              `
        SELECT c.relname AS table_name, con.conname, con.contype,
          con.condeferrable, con.condeferred, con.convalidated, con.confupdtype,
          con.confdeltype, pg_get_constraintdef(con.oid) AS definition
        FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = $1
        ORDER BY c.relname COLLATE "C", con.conname COLLATE "C"
      `,
              [positiveSchema],
            )
          ).rows,
        );
      const expectedConstraints = [
        {
          table_name: "agent_vnc_access",
          conname: "agent_vnc_access_agent_id_agents_id_fk",
          contype: "f",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: "a",
          confdeltype: "c",
          definition:
            "FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE",
        },
        {
          table_name: "agent_vnc_access",
          conname: "agent_vnc_access_pkey",
          contype: "p",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "PRIMARY KEY (org_id, user_id, agent_id)",
        },
        {
          table_name: "agents",
          conname: "agents_pkey",
          contype: "p",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "PRIMARY KEY (id)",
        },
        {
          table_name: "vnc_connections",
          conname: "chk_vnc_connections_display_name",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition:
            "CHECK (((char_length((display_name)::text) >= 1) AND (char_length((display_name)::text) <= 128)))",
        },
        {
          table_name: "vnc_connections",
          conname: "chk_vnc_connections_generation",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "CHECK ((generation > 0))",
        },
        {
          table_name: "vnc_connections",
          conname: "chk_vnc_connections_host",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition:
            "CHECK ((((char_length((host)::text) >= 1) AND (char_length((host)::text) <= 253)) AND ((host)::text = lower((host)::text)) AND ((host)::text !~ '[[:space:]/@?#]'::text)))",
        },
        {
          table_name: "vnc_connections",
          conname: "chk_vnc_connections_port",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "CHECK (((port >= 1) AND (port <= 65535)))",
        },
        {
          table_name: "vnc_connections",
          conname: "chk_vnc_connections_security_type",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "CHECK (((security_type)::text = 'x509_vnc'::text))",
        },
        {
          table_name: "vnc_connections",
          conname: "chk_vnc_connections_trust",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition:
            "CHECK (((((trust_mode)::text = 'system'::text) AND (ca_bundle IS NULL)) OR (((trust_mode)::text = 'custom_ca'::text) AND (ca_bundle IS NOT NULL) AND ((octet_length(ca_bundle) >= 1) AND (octet_length(ca_bundle) <= 65536)))))",
        },
        {
          table_name: "vnc_connections",
          conname: "vnc_connections_credential_owner_fk",
          contype: "f",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: "a",
          confdeltype: "r",
          definition:
            "FOREIGN KEY (credential_id, org_id, user_id) REFERENCES vnc_credentials(id, org_id, user_id) ON DELETE RESTRICT",
        },
        {
          table_name: "vnc_connections",
          conname: "vnc_connections_pkey",
          contype: "p",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "PRIMARY KEY (id)",
        },
        {
          table_name: "vnc_credentials",
          conname: "chk_vnc_credentials_auth_method",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "CHECK (((auth_method)::text = 'vnc_password'::text))",
        },
        {
          table_name: "vnc_credentials",
          conname: "chk_vnc_credentials_name",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition:
            "CHECK (((char_length((name)::text) >= 1) AND (char_length((name)::text) <= 128)))",
        },
        {
          table_name: "vnc_credentials",
          conname: "chk_vnc_credentials_password",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "CHECK ((char_length(encrypted_password) > 0))",
        },
        {
          table_name: "vnc_credentials",
          conname: "chk_vnc_credentials_revision",
          contype: "c",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "CHECK ((revision > 0))",
        },
        {
          table_name: "vnc_credentials",
          conname: "uq_vnc_credentials_owner_id",
          contype: "u",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "UNIQUE (id, org_id, user_id)",
        },
        {
          table_name: "vnc_credentials",
          conname: "vnc_credentials_pkey",
          contype: "p",
          condeferrable: false,
          condeferred: false,
          convalidated: true,
          confupdtype: " ",
          confdeltype: " ",
          definition: "PRIMARY KEY (id)",
        },
      ];
      if (version.server_version_num.startsWith("18")) {
        for (const column of expectedColumns) {
          if (column.attnotnull) {
            expectedConstraints.push({
              table_name: column.table_name,
              conname: `${column.table_name}_${column.attname}_not_null`,
              contype: "n",
              condeferrable: false,
              condeferred: false,
              convalidated: true,
              confupdtype: " ",
              confdeltype: " ",
              definition: `NOT NULL ${column.attname}`,
            });
          }
        }
      }
      expectedConstraints.sort((left, right) => {
        const a = `${left.table_name}/${left.conname}`;
        const b = `${right.table_name}/${right.conname}`;
        return a < b ? -1 : a > b ? 1 : 0;
      });
      assert.deepEqual(constraints, expectedConstraints);
      const indexes = z
        .array(
          z.strictObject({
            tablename: z.string(),
            indexname: z.string(),
            indexdef: z.string(),
          }),
        )
        .parse(
          (
            await positiveClient.query(
              `SELECT tablename,indexname,indexdef FROM pg_indexes
          WHERE schemaname = $1 ORDER BY tablename COLLATE "C",indexname COLLATE "C"`,
              [positiveSchema],
            )
          ).rows,
        );
      assert.deepEqual(indexes, [
        {
          tablename: "agent_vnc_access",
          indexname: "agent_vnc_access_pkey",
          indexdef: `CREATE UNIQUE INDEX agent_vnc_access_pkey ON ${positiveSchema}.agent_vnc_access USING btree (org_id, user_id, agent_id)`,
        },
        {
          tablename: "agent_vnc_access",
          indexname: "idx_agent_vnc_access_agent",
          indexdef: `CREATE INDEX idx_agent_vnc_access_agent ON ${positiveSchema}.agent_vnc_access USING btree (agent_id)`,
        },
        {
          tablename: "agent_vnc_access",
          indexname: "idx_agent_vnc_access_user",
          indexdef: `CREATE INDEX idx_agent_vnc_access_user ON ${positiveSchema}.agent_vnc_access USING btree (user_id)`,
        },
        {
          tablename: "agents",
          indexname: "agents_pkey",
          indexdef: `CREATE UNIQUE INDEX agents_pkey ON ${positiveSchema}.agents USING btree (id)`,
        },
        {
          tablename: "vnc_connections",
          indexname: "idx_vnc_connections_credential",
          indexdef: `CREATE INDEX idx_vnc_connections_credential ON ${positiveSchema}.vnc_connections USING btree (credential_id, id)`,
        },
        {
          tablename: "vnc_connections",
          indexname: "idx_vnc_connections_owner_created",
          indexdef: `CREATE INDEX idx_vnc_connections_owner_created ON ${positiveSchema}.vnc_connections USING btree (org_id, user_id, created_at, id)`,
        },
        {
          tablename: "vnc_connections",
          indexname: "idx_vnc_connections_user",
          indexdef: `CREATE INDEX idx_vnc_connections_user ON ${positiveSchema}.vnc_connections USING btree (user_id, id)`,
        },
        {
          tablename: "vnc_connections",
          indexname: "vnc_connections_pkey",
          indexdef: `CREATE UNIQUE INDEX vnc_connections_pkey ON ${positiveSchema}.vnc_connections USING btree (id)`,
        },
        {
          tablename: "vnc_credentials",
          indexname: "idx_vnc_credentials_owner_created",
          indexdef: `CREATE INDEX idx_vnc_credentials_owner_created ON ${positiveSchema}.vnc_credentials USING btree (org_id, user_id, created_at, id)`,
        },
        {
          tablename: "vnc_credentials",
          indexname: "idx_vnc_credentials_user",
          indexdef: `CREATE INDEX idx_vnc_credentials_user ON ${positiveSchema}.vnc_credentials USING btree (user_id, id)`,
        },
        {
          tablename: "vnc_credentials",
          indexname: "uq_vnc_credentials_owner_id",
          indexdef: `CREATE UNIQUE INDEX uq_vnc_credentials_owner_id ON ${positiveSchema}.vnc_credentials USING btree (id, org_id, user_id)`,
        },
        {
          tablename: "vnc_credentials",
          indexname: "vnc_credentials_pkey",
          indexdef: `CREATE UNIQUE INDEX vnc_credentials_pkey ON ${positiveSchema}.vnc_credentials USING btree (id)`,
        },
      ]);

      console.log(
        "VNC Runner authority migration and grant ownership constraints passed",
      );
    } catch (error) {
      errors.push(error);
    } finally {
      // Only an acknowledged CREATE permits DROP. Uncertain acknowledgements and
      // abrupt termination can leave committed batches until whole job-DB disposal.
      if (positiveSchemaOwned) {
        try {
          await positiveClient.query(`DROP SCHEMA "${positiveSchema}" CASCADE`);
        } catch (error) {
          errors.push(error);
        }
        try {
          assert.deepEqual(
            namespaceRows.parse(
              (
                await positiveClient.query(
                  "SELECT nspname FROM pg_namespace WHERE nspname = $1",
                  [positiveSchema],
                )
              ).rows,
            ),
            [],
            "The owned positive schema must be absent after cleanup",
          );
        } catch (error) {
          errors.push(error);
        }
      }
      if (capturedSearchPath !== undefined) {
        try {
          z.tuple([z.strictObject({ set_config: z.string() })]).parse(
            (
              await positiveClient.query(
                "SELECT set_config('search_path', $1, false)",
                [capturedSearchPath],
              )
            ).rows,
          );
        } catch (error) {
          errors.push(error);
        }
      } else {
        errors.push(
          new Error(
            "Positive search_path restoration unverified: capture failed",
          ),
        );
      }
      try {
        assert.ok(
          positiveConnected,
          "Positive search_path observation unavailable: connection did not succeed",
        );
        const observedPath = searchPathRows.parse(
          (await positiveClient.query("SHOW search_path")).rows,
        );
        if (capturedSearchPath !== undefined) {
          assert.equal(observedPath[0].search_path, capturedSearchPath);
        }
      } catch (error) {
        errors.push(error);
      }
      try {
        await positiveClient.end();
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
