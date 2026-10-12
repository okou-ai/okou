import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Client } from "pg";
import { z } from "zod";
import { DRIZZLE_MIGRATE_OUT } from "../drizzle.config";

const databaseUrl = process.env.DATABASE_URL;
assert.ok(databaseUrl, "DATABASE_URL is required");
const journal = z
  .object({ entries: z.array(z.object({ tag: z.string() })) })
  .parse(
    JSON.parse(
      await readFile(`${DRIZZLE_MIGRATE_OUT}/meta/_journal.json`, "utf8"),
    ),
  );
const entry = journal.entries.find((item) => {
  return item.tag.endsWith("_retire_oauth_contract_hash");
});
assert.ok(entry, "OAuth hash retirement migration must remain in the journal");
const migration = await readFile(
  `${DRIZZLE_MIGRATE_OUT}/${entry.tag}.sql`,
  "utf8",
);
const legacy = await readFile(
  `${DRIZZLE_MIGRATE_OUT}/1170_connector_mcp_automatic_oauth.sql`,
  "utf8",
);
const schema = `oauth_hash_retirement_${randomUUID().replaceAll("-", "")}`;
const client = new Client({ connectionString: databaseUrl });
await client.connect();
try {
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0407; new non-billing transactions are prohibited.
  await client.query("BEGIN");
  await client.query(`CREATE SCHEMA "${schema}"`);
  await client.query(`SET LOCAL search_path TO "${schema}", public`);
  // CI starts with an empty database. Reconstruct the historical tables in an
  // owned schema instead of requiring or reading any existing business rows.
  await client.query(`
    CREATE TABLE connectors (
      id uuid PRIMARY KEY,
      connector_slug varchar(64) NOT NULL,
      auth_method varchar(50) NOT NULL,
      storage_version bigint NOT NULL,
      org_id text NOT NULL,
      user_id text NOT NULL,
      is_default boolean NOT NULL,
      token_expires_at timestamp,
      needs_reconnect boolean NOT NULL DEFAULT false,
      UNIQUE (id, connector_slug),
      UNIQUE (id, org_id, user_id)
    );
    CREATE TABLE connector_oauth_states (
      id uuid PRIMARY KEY,
      state text NOT NULL,
      connector_slug varchar(64) NOT NULL,
      auth_method varchar(50) NOT NULL,
      user_id text NOT NULL,
      org_id text NOT NULL,
      oauth_context text,
      account_mutation jsonb NOT NULL,
      expires_at timestamp NOT NULL,
      redirect_uri text NOT NULL
    );
  `);
  await client.query(legacy.replaceAll('"public".', `"${schema}".`));
  const registrationIds = [randomUUID(), randomUUID()];
  const accountIds = [randomUUID(), randomUUID()];
  for (const [index, registrationId] of registrationIds.entries()) {
    await client.query(
      `INSERT INTO connectors (id, connector_slug, auth_method, automatic_auth_type, storage_version, org_id, user_id, is_default)
       VALUES ($1, 'retirement-mcp', 'smart-connect', 'oauth', 1, 'retirement-org', 'retirement-user', false)`,
      [accountIds[index]],
    );
    await client.query(
      `INSERT INTO connector_dcr_registrations (id, org_id, connector_slug, auth_method, contract_hash, issuer, client_id,
         encrypted_client_secret, token_endpoint_auth_method, registered_scopes, redirect_uri, issued_at)
       VALUES ($1, 'retirement-org', 'retirement-mcp', 'smart-connect', $2, 'https://issuer.example.test', $3,
         'opaque-encrypted-client-secret', 'client_secret_basic', ARRAY['read'], 'https://api.example.test/callback', now())`,
      [
        registrationId,
        (index === 0 ? "a" : "b").repeat(64),
        `registered-client-${index}`,
      ],
    );
    await client.query(
      `INSERT INTO connector_account_oauth_bindings (connector_account_id, org_id, user_id, connector_slug, auth_method,
         storage_version, contract_hash, endpoint, issuer, resource, token_endpoint, client_id, token_endpoint_auth_method,
         registration_method, dcr_registration_id)
       VALUES ($1, 'retirement-org', 'retirement-user', 'retirement-mcp', 'smart-connect', 1, $2,
         'https://mcp.example.test', 'https://issuer.example.test', 'https://mcp.example.test', 'https://issuer.example.test/token',
         $3, 'client_secret_basic', 'dcr', $4)`,
      [
        accountIds[index],
        (index === 0 ? "a" : "b").repeat(64),
        `registered-client-${index}`,
        registrationId,
      ],
    );
  }
  const context = {
    version: 1,
    kind: "connector-mcp-automatic",
    connectorSlug: "retirement-mcp",
    issuer: "https://issuer.example.test",
    clientId: "registered-client-0",
  };
  const contexts = [
    JSON.stringify({ ...context, contractHash: "a".repeat(64) }),
    JSON.stringify(context),
    '{"kind":"other-provider","contractHash":"unrelated-value"}',
    "malformed-json",
    "[]",
    null,
  ];
  for (const [index, oauthContext] of contexts.entries()) {
    await client.query(
      `INSERT INTO connector_oauth_states (id, state, connector_slug, auth_method, user_id, org_id, oauth_context, account_mutation, expires_at, redirect_uri)
       VALUES ($1, $2, 'retirement-mcp', 'smart-connect', 'retirement-user', 'retirement-org', $3, '{"intent":"add"}', now() + interval '10 minutes', 'https://api.example.test/callback')`,
      [randomUUID(), `retirement-state-${index}`, oauthContext],
    );
  }
  const beforeRegistrations = await client.query<{ value: unknown }>(
    "SELECT to_jsonb(t) - 'contract_hash' AS value FROM connector_dcr_registrations t ORDER BY id",
  );
  const beforeBindings = await client.query<{ value: unknown }>(
    "SELECT to_jsonb(t) - 'contract_hash' AS value FROM connector_account_oauth_bindings t ORDER BY connector_account_id",
  );
  const beforeAccounts = await client.query<{ value: unknown }>(
    "SELECT to_jsonb(t) AS value FROM connectors t ORDER BY id",
  );
  await client.query(migration.replaceAll('"public".', `"${schema}".`));
  const columns = await client.query(
    "SELECT 1 FROM information_schema.columns WHERE table_schema = $1 AND table_name IN ('connector_dcr_registrations', 'connector_account_oauth_bindings') AND column_name = 'contract_hash'",
    [schema],
  );
  assert.equal(
    columns.rowCount,
    0,
    "Both hash columns must be physically removed",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(t) AS value FROM connector_dcr_registrations t ORDER BY id",
      )
    ).rows,
    beforeRegistrations.rows,
    "Preserve both registrations, encrypted secrets, scopes and client identities",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(t) AS value FROM connector_account_oauth_bindings t ORDER BY connector_account_id",
      )
    ).rows,
    beforeBindings.rows,
    "Preserve every account's exact DCR reference",
  );
  assert.deepEqual(
    (
      await client.query(
        "SELECT to_jsonb(t) AS value FROM connectors t ORDER BY id",
      )
    ).rows,
    beforeAccounts.rows,
    "Do not rewrite accounts or require reconnect",
  );
  // eslint-disable-next-line api/no-db-transaction -- Legacy transaction existing on 2026-10-09; id=TX-0408; new non-billing transactions are prohibited.
  await client.query("SAVEPOINT invalid_redirect_uri");
  await assert.rejects(
    client.query(
      "UPDATE connector_dcr_registrations SET redirect_uri = ' ' WHERE id = $1",
      [registrationIds[0]],
    ),
    { code: "23514" },
    "Retain the nonblank redirect URI constraint independently of hash retirement",
  );
  await client.query("ROLLBACK TO SAVEPOINT invalid_redirect_uri");
  const transformed = await client.query<{ oauth_context: string | null }>(
    "SELECT oauth_context FROM connector_oauth_states ORDER BY state",
  );
  const retiredContext = transformed.rows[0]?.oauth_context;
  assert.ok(retiredContext);
  assert.deepEqual(JSON.parse(retiredContext), context);
  assert.deepEqual(
    transformed.rows.slice(1).map((row) => {
      return row.oauth_context;
    }),
    contexts.slice(1),
    "Unrelated, malformed, absent and already-retired contexts must remain byte-identical",
  );
  const transform = migration.split("--> statement-breakpoint").at(-1);
  assert.ok(transform);
  await client.query(transform);
  assert.deepEqual(
    (
      await client.query(
        "SELECT oauth_context FROM connector_oauth_states ORDER BY state",
      )
    ).rows,
    transformed.rows,
    "Context retirement is idempotent",
  );
} finally {
  await client.query("ROLLBACK");
  await client.end();
}
console.log(
  "OAuth contract hash retirement preserves registrations, accounts, credentials and authorization contexts",
);
