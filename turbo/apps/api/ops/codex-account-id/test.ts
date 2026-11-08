import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { array, object, string } from "zod";
import { apply, audit } from "./core";

const url = process.env.CODEX_BACKFILL_TEST_DATABASE_URL;
assert.ok(url, "CODEX_BACKFILL_TEST_DATABASE_URL is required");
assert.ok(
  ["localhost", "127.0.0.1", "postgres"].includes(new URL(url).hostname),
);
const client = new Client({ connectionString: url });
const schema = `codex_backfill_${randomUUID().replaceAll("-", "")}`;
const providerId = randomUUID();
const decrypt = (value: string) => {
  if (!value.startsWith("cipher:")) {
    throw new Error("private diagnostic");
  }
  return Promise.resolve(value.slice(7));
};
async function seed(values: readonly (string | null)[]) {
  await client.query(
    "TRUNCATE model_provider_accounts, model_provider_account_secrets",
  );
  const ids: string[] = [];
  for (const [index, value] of values.entries()) {
    const id = randomUUID();
    ids.push(id);
    await client.query(
      `INSERT INTO model_provider_accounts
      (id, model_provider_id, org_id, user_id, type, auth_method, external_account_id)
      VALUES ($1,$2,'org','user','codex-oauth-token','auth_json',$3)`,
      [id, providerId, value],
    );
    await client.query(
      `INSERT INTO model_provider_account_secrets
      (id,model_provider_account_id,name,encrypted_value)
      VALUES ($1,$2,'CHATGPT_ACCOUNT_ID',$3)`,
      [randomUUID(), id, `cipher:account-${index}`],
    );
  }
  return ids;
}
async function stored() {
  const result = await client.query(
    "SELECT external_account_id FROM model_provider_accounts",
  );
  return array(object({ external_account_id: string().nullable() }))
    .parse(result.rows)
    .map((row) => row.external_account_id);
}
try {
  await client.connect();
  await client.query(`CREATE SCHEMA ${schema}`);
  await client.query(`SET search_path TO ${schema}`);
  await client.query(`CREATE TABLE model_provider_accounts (
    id uuid PRIMARY KEY, model_provider_id uuid NOT NULL, org_id text NOT NULL,
    user_id text NOT NULL, type text NOT NULL, auth_method text,
    external_account_id text, updated_at timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(model_provider_id, external_account_id))`);
  await client.query(`CREATE TABLE model_provider_account_secrets (
    id uuid PRIMARY KEY, model_provider_account_id uuid NOT NULL,
    name text NOT NULL, encrypted_value text NOT NULL,
    UNIQUE(model_provider_account_id,name))`);

  await seed([null, null, "account-2"]);
  const first = await audit(client, decrypt);
  assert.equal(first.matching, 1);
  assert.equal(first.candidates.length, 2);
  assert.ok((await stored()).includes(null), "dry-run must not write");
  assert.equal(await apply(client, first.candidates), 2);
  assert.equal((await audit(client, decrypt)).candidates.length, 0);
  assert.equal(await apply(client, []), 0);

  let ids = await seed([null, null]);
  let plan = await audit(client, decrypt);
  await client.query(
    "UPDATE model_provider_account_secrets SET encrypted_value='cipher:changed' WHERE model_provider_account_id=$1",
    [ids[0]],
  );
  assert.notEqual((await audit(client, decrypt)).planSha256, plan.planSha256);
  await assert.rejects(apply(client, plan.candidates));
  assert.deepEqual(
    await stored(),
    [null, null],
    "changed secret rolls back the whole batch",
  );

  ids = await seed([null, null]);
  plan = await audit(client, decrypt);
  await client.query(
    "UPDATE model_provider_accounts SET external_account_id='concurrent' WHERE id=$1",
    [ids[0]],
  );
  await assert.rejects(apply(client, plan.candidates));
  assert.deepEqual((await stored()).sort(), ["concurrent", null].sort());

  await seed([null, null]);
  plan = await audit(client, decrypt);
  await client.query(
    `INSERT INTO model_provider_accounts
    (id,model_provider_id,org_id,user_id,type,external_account_id)
    VALUES ($1,$2,'org','user','codex-oauth-token','account-0')`,
    [randomUUID(), providerId],
  );
  await assert.rejects(apply(client, plan.candidates));
  assert.equal((await stored()).filter((value) => value === null).length, 2);

  await seed(["wrong"]);
  await assert.rejects(audit(client, decrypt), /ExistingIdentityMismatch/);
  await seed([null, null]);
  await client.query(
    "UPDATE model_provider_account_secrets SET encrypted_value='cipher:duplicate'",
  );
  await assert.rejects(audit(client, decrypt), /DuplicateIdentity/);
  await seed([null]);
  await client.query("DELETE FROM model_provider_account_secrets");
  await assert.rejects(audit(client, decrypt), /MissingAccountIdSecret/);
  await seed([null]);
  await client.query(
    "UPDATE model_provider_account_secrets SET encrypted_value='cipher: '",
  );
  await assert.rejects(audit(client, decrypt), /InvalidAccountId/);
  process.stdout.write(
    "Codex account backfill: native PostgreSQL safety checks passed\n",
  );
} finally {
  await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await client.end();
}
