import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { spawn } from "node:child_process";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, URL } from "node:url";
import { Client } from "pg";
import { apiTestEnvironment } from "../src/__tests__/test-environment.ts";

// This is an operator transition test: the database is the command's input and
// output. It launches the actual CLI against an owned PostgreSQL database and
// intercepts only the external Link and AWS HTTP boundaries in that process.
const appDir = fileURLToPath(new URL("../", import.meta.url));
const dataKey = Buffer.from("0123456789abcdef0123456789abcdef");

function encrypt(credentials) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(credentials)),
    cipher.final(),
  ]);
  return `vm0secret:v1:${Buffer.from(
    JSON.stringify({
      v: 1,
      kind: "stored-secret",
      kms: {
        keyId: "fixture-kms-key",
        encryptedDataKey: Buffer.from("fixture-encrypted-key").toString(
          "base64",
        ),
        iv: iv.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
    }),
  ).toString("base64url")}`;
}

function decrypt(envelope) {
  const { kms } = JSON.parse(
    Buffer.from(envelope.slice("vm0secret:v1:".length), "base64url").toString(),
  );
  const decipher = createDecipheriv(
    "aes-256-gcm",
    dataKey,
    Buffer.from(kms.iv, "base64"),
    { authTagLength: 16 },
  );
  decipher.setAuthTag(Buffer.from(kms.authTag, "base64"));
  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(kms.ciphertext, "base64")),
      decipher.final(),
    ]).toString(),
  );
}

function legacy(token) {
  return { accessToken: `access-${token}`, refreshToken: token, expiresAt: 1 };
}

async function database(t) {
  assert.ok(
    process.env.DATABASE_URL,
    "DATABASE_URL must select a disposable PostgreSQL server",
  );
  const adminUrl = new URL(process.env.DATABASE_URL);
  adminUrl.pathname = "/postgres";
  const admin = new Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  const name = `wallet_grants_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const client = new Client({ connectionString: url.toString() });
  const reports = await mkdtemp(join(tmpdir(), "wallet-grants-"));
  t.after(async () => {
    await client.end();
    await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
    await admin.end();
    await rm(reports, { recursive: true, force: true });
  });
  await client.connect();
  await client.query(`CREATE TABLE link_wallet_connections (
    id uuid PRIMARY KEY, org_id text NOT NULL, user_id text NOT NULL,
    agent_id uuid, authorization_id uuid NOT NULL, encrypted_credentials text,
    oauth_requested_scopes text, revoked_at timestamptz, revocation_confirmed_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`);
  return { client, url: url.toString(), reports };
}

async function insert(
  client,
  credentials,
  { revoked = false, agentId = null } = {},
) {
  const id = randomUUID();
  await client.query(
    `INSERT INTO link_wallet_connections
    (id, org_id, user_id, agent_id, authorization_id, encrypted_credentials, oauth_requested_scopes, revoked_at)
    VALUES ($1, 'fixture-org', 'fixture-user', $2, $3, $4, 'retained-request-snapshot', $5)`,
    [
      id,
      agentId,
      randomUUID(),
      encrypt(credentials),
      revoked ? new Date() : null,
    ],
  );
  return id;
}

async function run(db, { migrate = false, mode = "success", onRefresh } = {}) {
  const report = join(db.reports, `${randomUUID()}.json`);
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--import",
      "./scripts/fixtures/link-wallet-migration-providers.mjs",
      "src/scripts/migrate-link-wallet-grants.ts",
      ...(migrate ? ["--migrate"] : []),
      "--report",
      report,
    ],
    {
      cwd: appDir,
      env: {
        ...process.env,
        ...apiTestEnvironment,
        DATABASE_URL: db.url,
        VITEST: "false",
        AWS_ACCESS_KEY_ID: "fixture-access",
        AWS_SECRET_ACCESS_KEY: "fixture-secret",
        AWS_REGION: "us-west-2",
        SECRETS_KMS_KEY_ID: "fixture-kms-key",
        LINK_OAUTH_CLIENT_ID: "fixture-client",
        LINK_OAUTH_CLIENT_SECRET: "fixture-link-secret",
        LINK_STRIPE_PUBLISHABLE_KEY: "pk_live_fixture",
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    },
  );
  let output = "";
  let errors = "";
  const effects = [];
  const pending = [];
  child.stdout.on("data", (data) => {
    output += data;
  });
  child.stderr.on("data", (data) => {
    errors += data;
  });
  child.on("message", (message) => {
    if (message.operation === "ready") {
      child.send({ mode });
      return;
    }
    effects.push(message);
    if (message.operation === "refresh" && onRefresh) {
      pending.push(
        onRefresh().then(() => {
          child.send("continue");
        }),
      );
    }
  });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  await Promise.all(pending);
  return {
    code,
    output,
    errors,
    effects,
    report: await readFile(report, "utf8")
      .then(JSON.parse)
      .catch((error) => {
        if (error.code === "ENOENT") {
          return null;
        }
        throw error;
      }),
  };
}

test("dry-run, migration and rerun preserve wallet identities and use actual Link grants", async (t) => {
  const db = await database(t);
  const active = await insert(db.client, legacy("legacy-active"));
  const historical = await insert(db.client, legacy("legacy-agent"), {
    agentId: randomUUID(),
  });
  const revoked = await insert(db.client, legacy("legacy-revoked"), {
    revoked: true,
  });
  const current = await insert(db.client, {
    ...legacy("current-readonly"),
    scope: "userinfo:read",
    readOnly: true,
  });
  const before = (
    await db.client.query("SELECT * FROM link_wallet_connections ORDER BY id")
  ).rows;
  const dry = await run(db);
  assert.equal(dry.code, 0, dry.errors);
  assert.deepEqual(dry.effects, []);
  assert.deepEqual(dry.report.before, {
    scanned: 4,
    current: 1,
    legacy: 2,
    revokedLegacy: 1,
  });
  assert.deepEqual(
    (await db.client.query("SELECT * FROM link_wallet_connections ORDER BY id"))
      .rows,
    before,
  );
  const migrated = await run(db, { migrate: true });
  assert.equal(migrated.code, 0, migrated.errors);
  assert.deepEqual(migrated.report.after, {
    scanned: 3,
    current: 3,
    legacy: 0,
    revokedLegacy: 0,
  });
  assert.deepEqual(migrated.report.changes, {
    refreshesStarted: 2,
    refreshed: 2,
    revoked: 1,
    changedConcurrently: 0,
  });
  const after = (
    await db.client.query("SELECT * FROM link_wallet_connections ORDER BY id")
  ).rows;
  for (const row of after) {
    const old = before.find((value) => {
      return value.id === row.id;
    });
    for (const key of [
      "org_id",
      "user_id",
      "agent_id",
      "authorization_id",
      "oauth_requested_scopes",
      "created_at",
      "revoked_at",
    ]) {
      assert.deepEqual(row[key], old[key]);
    }
    if (row.id === current) {
      assert.equal(row.encrypted_credentials, old.encrypted_credentials);
    }
    if ([active, historical].includes(row.id)) {
      const credentials = decrypt(row.encrypted_credentials);
      assert.equal(credentials.scope, "payment_methods.agentic userinfo:read");
      assert.equal(credentials.readOnly, false);
      assert.deepEqual(credentials.authorizationDetails, [
        { type: "source", actions: ["read_link_transactions"] },
      ]);
    }
    if (row.id === revoked) {
      assert.equal(row.encrypted_credentials, null);
      assert.ok(row.revocation_confirmed_at);
    }
  }
  assert.doesNotMatch(
    migrated.output + migrated.errors,
    /legacy-active|legacy-agent|legacy-revoked|rotated-refresh/,
  );
  const rerun = await run(db, { migrate: true });
  assert.equal(rerun.code, 0, rerun.errors);
  assert.deepEqual(rerun.effects, []);
  assert.deepEqual(
    (await db.client.query("SELECT * FROM link_wallet_connections ORDER BY id"))
      .rows,
    after,
  );
});

test("refresh failure blocks promotion and never replays the consumed token", async (t) => {
  const db = await database(t);
  const id = await insert(db.client, legacy("failed-refresh"));
  const result = await run(db, { migrate: true, mode: "refresh-failure" });
  assert.equal(result.code, 1);
  assert.match(result.errors, /API promotion must stop/);
  assert.equal(
    (
      await db.client.query(
        "SELECT encrypted_credentials FROM link_wallet_connections WHERE id = $1",
        [id],
      )
    ).rows[0].encrypted_credentials,
    null,
  );
  const rerun = await run(db, { migrate: true });
  assert.equal(rerun.code, 0, rerun.errors);
  assert.deepEqual(rerun.effects, []);
});

for (const action of ["reauthorize", "disconnect"]) {
  test(`concurrent ${action} wins over the migrated grant`, async (t) => {
    const db = await database(t);
    const id = await insert(db.client, legacy("concurrent-old"));
    const replacement = encrypt({
      ...legacy("replacement"),
      scope: "userinfo:read",
      readOnly: true,
    });
    const result = await run(db, {
      migrate: true,
      mode: "concurrent",
      onRefresh: async () => {
        if (action === "reauthorize") {
          await db.client.query(
            "UPDATE link_wallet_connections SET authorization_id = $1, encrypted_credentials = $2 WHERE id = $3",
            [randomUUID(), replacement, id],
          );
        } else {
          await db.client.query(
            "UPDATE link_wallet_connections SET revoked_at = now() WHERE id = $1",
            [id],
          );
        }
      },
    });
    assert.equal(result.code, 0, result.errors);
    assert.equal(result.report.changes.changedConcurrently, 1);
    assert.deepEqual(
      result.effects.map((effect) => {
        return effect.operation;
      }),
      ["refresh", "revoke"],
    );
    const row = (
      await db.client.query(
        "SELECT * FROM link_wallet_connections WHERE id = $1",
        [id],
      )
    ).rows[0];
    assert.equal(
      row.encrypted_credentials,
      action === "reauthorize" ? replacement : null,
    );
    if (action === "disconnect") {
      assert.ok(row.revocation_confirmed_at);
    }
  });
}

test("incomplete metadata blocks the preflight without modifying any grant", async (t) => {
  const db = await database(t);
  await insert(db.client, legacy("valid-legacy"));
  await insert(db.client, { ...legacy("incomplete"), scope: "userinfo:read" });
  const before = (
    await db.client.query("SELECT * FROM link_wallet_connections ORDER BY id")
  ).rows;
  const result = await run(db, { migrate: true });
  assert.equal(result.code, 1);
  assert.deepEqual(result.effects, []);
  assert.deepEqual(
    (await db.client.query("SELECT * FROM link_wallet_connections ORDER BY id"))
      .rows,
    before,
  );
  assert.doesNotMatch(
    result.output + result.errors,
    /incomplete|valid-legacy|userinfo:read/,
  );
});

test("failed revocation retains the token for supported retry and blocks promotion", async (t) => {
  const db = await database(t);
  const id = await insert(db.client, legacy("revoked-retry"), {
    revoked: true,
  });
  const before = (
    await db.client.query(
      "SELECT * FROM link_wallet_connections WHERE id = $1",
      [id],
    )
  ).rows;
  const result = await run(db, { migrate: true, mode: "revoke-failure" });
  assert.equal(result.code, 1);
  assert.deepEqual(
    (
      await db.client.query(
        "SELECT * FROM link_wallet_connections WHERE id = $1",
        [id],
      )
    ).rows,
    before,
  );
  const retry = await run(db, { migrate: true });
  assert.equal(retry.code, 0, retry.errors);
  assert.equal(retry.report.after.revokedLegacy, 0);
});
