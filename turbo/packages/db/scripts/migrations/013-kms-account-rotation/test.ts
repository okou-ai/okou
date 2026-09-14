#!/usr/bin/env tsx

// CLI integration: a real, isolated Postgres database and an HTTP KMS boundary.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import process from "node:process";
import { promisify } from "node:util";

import { EncryptCommand, KMSClient } from "@aws-sdk/client-kms";
import { Client } from "pg";

import { fields } from "./fields";
import {
  decode,
  decrypt,
  encode,
  encrypt,
  encryptionContext,
  object,
  prefix,
  string,
} from "./kms";

const source =
  "arn:aws:kms:us-west-2:072707626411:key/a1b3922b-fab1-4ed3-aa9e-40f86f92a7a8";
const target =
  "arn:aws:kms:us-west-2:251964670836:key/e68917e2-5541-4597-b6ef-7e9eb5670947";
const secret = "synthetic-secret-that-must-never-appear-in-cli-output";
const input = new URL(string(process.env.DATABASE_URL));
assert.ok(
  ["localhost", "127.0.0.1", "postgres"].includes(input.hostname),
  "Integration tests require local PostgreSQL",
);
const databaseName = `kms_rotation_test_${randomUUID().replaceAll("-", "")}`;
const admin = new Client({ connectionString: input.toString() });
await admin.connect();
await admin.query(`CREATE DATABASE "${databaseName}"`);
input.pathname = `/${databaseName}`;
const db = new Client({ connectionString: input.toString() });
await db.connect();
const directory = await mkdtemp(join(tmpdir(), "kms-rotation-test-"));
const blobs = new Map<string, { key: string; plaintext: Buffer }>();
let kmsRequests = 0;
let beforeRewrap: (() => Promise<void>) | undefined;
let beforeDecrypt: ((ciphertext: string) => Promise<void>) | undefined;
let failRewrap = false;
function wrap(plaintext: Buffer, key: string): string {
  const blob = randomBytes(64).toString("base64");
  blobs.set(blob, { key, plaintext: Buffer.from(plaintext) });
  return blob;
}
const server = createServer((request, response) => {
  async function handle(): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const chunk of request) {
      chunks.push(Buffer.from(chunk));
    }
    kmsRequests++;
    const body = object(JSON.parse(Buffer.concat(chunks).toString("utf8")));
    const operation = string(request.headers["x-amz-target"]).split(".").at(-1);
    const context = object(
      operation === "ReEncrypt"
        ? body.SourceEncryptionContext
        : body.EncryptionContext,
    );
    if (
      operation === "GenerateDataKey" &&
      string(request.headers.authorization).includes("Credential=target/") &&
      (body.KeyId !== target || context.purpose !== encryptionContext.purpose)
    ) {
      response.writeHead(400, {
        "content-type": "application/x-amz-json-1.1",
      });
      response.end(JSON.stringify({ __type: "AccessDeniedException" }));
      return;
    }
    assert.deepEqual(context, encryptionContext);
    let result: Record<string, unknown>;
    if (operation === "GenerateDataKey" || operation === "Encrypt") {
      const plain =
        operation === "Encrypt"
          ? Buffer.from(string(body.Plaintext), "base64")
          : randomBytes(32);
      result = {
        KeyId: body.KeyId,
        CiphertextBlob: wrap(plain, string(body.KeyId)),
      };
      if (operation === "GenerateDataKey") {
        result.Plaintext = plain.toString("base64");
      }
    } else {
      const stored = blobs.get(string(body.CiphertextBlob));
      assert.ok(stored);
      assert.equal(
        stored.key,
        operation === "ReEncrypt" ? body.SourceKeyId : body.KeyId,
      );
      if (operation === "Decrypt") {
        await beforeDecrypt?.(string(body.CiphertextBlob));
        result = {
          KeyId: stored.key,
          Plaintext: stored.plaintext.toString("base64"),
        };
      } else {
        assert.equal(operation, "ReEncrypt");
        assert.deepEqual(body.DestinationEncryptionContext, encryptionContext);
        if (failRewrap) {
          response.writeHead(400, {
            "content-type": "application/x-amz-json-1.1",
          });
          response.end(
            JSON.stringify({
              __type: "AccessDeniedException",
              message: secret,
            }),
          );
          return;
        }
        const concurrentWrite = beforeRewrap;
        beforeRewrap = undefined;
        await concurrentWrite?.();
        result = {
          SourceKeyId: stored.key,
          KeyId: body.DestinationKeyId,
          CiphertextBlob: wrap(stored.plaintext, string(body.DestinationKeyId)),
        };
      }
    }
    response.writeHead(200, { "content-type": "application/x-amz-json-1.1" });
    response.end(JSON.stringify(result));
  }
  handle().catch(() => {
    response.writeHead(400, { "content-type": "application/x-amz-json-1.1" });
    response.end(
      JSON.stringify({
        __type: "InvalidCiphertextException",
        message: "synthetic KMS rejected request",
      }),
    );
  });
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const endpoint = `http://127.0.0.1:${address.port}`;
const kms = new KMSClient({
  region: "us-west-2",
  endpoint,
  credentials: { accessKeyId: "synthetic", secretAccessKey: "synthetic" },
});
const execute = promisify(execFile);
const script = "scripts/migrations/013-kms-account-rotation/backfill.ts";
async function cli(
  name: string,
  args: string[] = [],
  reverse = false,
  expectedFailure = false,
  databaseUrl = input.toString(),
): Promise<Record<string, unknown>> {
  const reportPath = join(directory, `${name}.json`);
  const command = [
    "exec",
    "tsx",
    script,
    "--source-key",
    reverse ? target : source,
    "--target-key",
    reverse ? source : target,
    "--report-path",
    reportPath,
    ...args,
  ];
  let failed = false;
  let stdout = "";
  let stderr = "";
  try {
    const output = await execute("pnpm", command, {
      timeout: 30_000,
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        AWS_ACCESS_KEY_ID: "synthetic",
        AWS_SECRET_ACCESS_KEY: "synthetic",
        AWS_SESSION_TOKEN: "",
        AWS_ENDPOINT_URL_KMS: endpoint,
      },
    });
    stdout = output.stdout;
    stderr = output.stderr;
  } catch (error) {
    failed = true;
    const failure = object(error);
    stdout = string(failure.stdout);
    stderr = string(failure.stderr);
  }
  assert.equal(failed, expectedFailure, stderr);
  assert.ok(!stdout.includes(secret) && !stderr.includes(secret));
  const raw = await readFile(reportPath, "utf8");
  assert.ok(!raw.includes(secret));
  return object(JSON.parse(raw));
}
async function stored(
  table: string,
  column: string,
  id: string,
): Promise<string> {
  const key = fields.find((field) => {
    return field.table === table;
  })?.primaryKey;
  assert.ok(key);
  const rows: unknown[] = (
    await db.query(
      `SELECT "${column}" AS value FROM "${table}" WHERE "${key}" = $1`,
      [id],
    )
  ).rows;
  return string(object(rows[0]).value);
}

async function workflowCli(
  name: string,
  operation: "verify" | "verify-business" | "migrate",
  scenario = "success",
  overrides: Record<string, string> = {},
): Promise<Record<string, unknown> | null> {
  const root = join(directory, name);
  const binary = join(root, "bin");
  await mkdir(binary, { recursive: true });
  const wrapper = await readFile(
    "../../../.github/scripts/tests/fixtures/kms-production-migration-tools.py",
    "utf8",
  );
  for (const command of ["aws", "curl", "pnpm"]) {
    const path = join(binary, command);
    await writeFile(path, wrapper);
    await chmod(path, 0o700);
  }
  const snapshot = {
    version: 1,
    sourceKeyArn: source,
    sourcePrincipal: "arn:aws:iam::072707626411:user/vm0-kms-prod",
    configuration: {
      AWS_ACCESS_KEY_ID: "source",
      AWS_SECRET_ACCESS_KEY: "synthetic-source-secret",
      SECRETS_KMS_KEY_ID: source,
      AWS_REGION: "us-west-2",
    },
    workflow: {
      repository: "vm0-ai/vm0",
      commit: "594d907ca844e845f674c04640a58ae8cebcdc8a",
      runId: "34324494642",
    },
  };
  const pnpm = (await execute("which", ["pnpm"])).stdout.trim();
  await writeFile(
    join(root, "provider.json"),
    JSON.stringify({
      scenario,
      snapshot,
      pnpm,
      kmsEndpoint: endpoint,
      databaseUrl: input.toString(),
      assumeCalls: 0,
      deploymentReads: 0,
    }),
  );
  const environment = {
    ...process.env,
    PATH: binary + delimiter + string(process.env.PATH),
    RUNNER_TEMP: root,
    GITHUB_REPOSITORY: "vm0-ai/vm0",
    GITHUB_REF: "refs/heads/main",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_RUN_ID: "12345",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_WORKFLOW_REF: `vm0-ai/vm0/.github/workflows/kms-production-${{ verify: "preflight", "verify-business": "business-verify", migrate: "migrate" }[operation]}.yml@refs/heads/main`,
    ACTIONS_ID_TOKEN_REQUEST_URL:
      "https://pipelines.actions.githubusercontent.com/oidc",
    ACTIONS_ID_TOKEN_REQUEST_TOKEN: "synthetic-github-token",
    DOPPLER_SERVICE_IDENTITY_ID: "c0c87790-e651-45dd-b7fa-c5ed07bb990f",
    EXPECTED_BACKUP_SHA256: createHash("sha256")
      .update(JSON.stringify(snapshot))
      .digest("hex"),
    EXPECTED_DEPLOYMENT_ID: "dpl_fixture",
    VERCEL_TOKEN: "synthetic-vercel-secret",
    NEON_PROJECT_ID: "hidden-lab-39609750",
    NEON_API_KEY: "synthetic-neon-secret",
    CLERK_SECRET_KEY: "synthetic-clerk-secret",
    CLERK_PUBLISHABLE_KEY: "synthetic-publishable-key",
    BUSINESS_USER_ID: "user_fixture",
    BUSINESS_ORG_ID: "org_fixture",
    BUSINESS_AGENT_ID: "agent_fixture",
    AWS_ACCESS_KEY_ID: "target",
    AWS_SECRET_ACCESS_KEY: "synthetic-target-secret",
    AWS_SESSION_TOKEN: "",
    AWS_REGION: "us-west-2",
    SECRETS_KMS_KEY_ID: target,
    KMS_OPERATION: operation,
    KMS_MIGRATION_ROLE_ARN:
      "arn:aws:iam::251964670836:role/vm0-kms-migration-github-32264",
    MAX_ROWS: "1",
    ...overrides,
  };
  let failed = false;
  let output = "";
  try {
    const result = await execute(
      "python3",
      [resolve("../../../.github/scripts/kms-production-migration.py")],
      { env: environment, timeout: 60_000 },
    );
    output = result.stdout + result.stderr;
  } catch (error) {
    const result = object(error);
    output = string(result.stdout) + string(result.stderr);
    failed = true;
  }
  assert.equal(failed, scenario !== "success", output);
  let report: Record<string, unknown> | null = null;
  try {
    report = object(
      JSON.parse(
        await readFile(
          join(root, "kms-production-reports/operation.json"),
          "utf8",
        ),
      ),
    );
  } catch (error) {
    assert.equal(object(error).code, "ENOENT");
  }
  const reportDirectory = join(root, "kms-production-reports");
  let reportText = "";
  for (const name of [
    "operation.json",
    "verification.json",
    "migration.json",
    "business-verification.json",
  ]) {
    try {
      reportText += await readFile(join(reportDirectory, name), "utf8");
    } catch (error) {
      assert.equal(object(error).code, "ENOENT");
    }
  }
  for (const value of [
    secret,
    "synthetic-source-secret",
    "synthetic-target-secret",
    "synthetic-operator-secret",
    "syntheticOperatorSecret",
    "synthetic-operator-session",
    "synthetic-database-secret",
    "synthetic-doppler-token",
    "synthetic-oidc-token",
    "synthetic-provider-secret-must-not-be-logged",
    "synthetic-clerk-secret",
  ]) {
    assert.ok(!(output + reportText).includes(value));
  }
  if (operation !== "migrate" || scenario !== "success") {
    assert.equal(report?.migration, undefined);
  }
  return report;
}
try {
  const tables = new Map<string, string[]>();
  for (const field of fields) {
    if (field.optional) {
      continue;
    }
    const columns = tables.get(field.table) ?? [
      `"${field.primaryKey}" text PRIMARY KEY`,
    ];
    columns.push(`"${field.column}" ${field.jsonKey ? "jsonb" : "text"}`);
    tables.set(field.table, columns);
  }
  for (const [table, columns] of tables) {
    await db.query(`CREATE TABLE "${table}" (${columns.join(", ")})`);
  }
  const missingDatabase = new URL(input);
  missingDatabase.pathname = `/missing_${randomUUID().replaceAll("-", "")}`;
  const connectionFailure = await cli(
    "connection-failure",
    ["--verify"],
    false,
    true,
    missingDatabase.toString(),
  );
  assert.deepEqual(connectionFailure.failureDetails, {
    stage: "connect",
    code: "3D000",
  });
  assert.equal(connectionFailure.complete, false);
  assert.equal(object(connectionFailure.totals).verified, 0);
  await db.query(
    "ALTER TABLE secrets RENAME COLUMN encrypted_value TO fixture_missing_column",
  );
  try {
    const manifestFailure = await cli(
      "manifest-failure",
      ["--verify"],
      false,
      true,
    );
    assert.deepEqual(manifestFailure.failureDetails, {
      stage: "storage_manifest",
      code: "storage_manifest_mismatch",
    });
    assert.equal(manifestFailure.complete, false);
  } finally {
    await db.query(
      "ALTER TABLE secrets RENAME COLUMN fixture_missing_column TO encrypted_value",
    );
  }
  const workflowCiphertext = encode(
    await encrypt(kms, Buffer.from(secret), source),
  );
  await db.query(
    "INSERT INTO secrets VALUES ('workflow-1', $1), ('workflow-2', $1)",
    [workflowCiphertext],
  );
  const workflowVerify = await workflowCli("workflow-verify", "verify");
  assert.equal(
    object(workflowVerify?.targetRuntimeVerification).databaseVerifiedOnTarget,
    false,
  );
  assert.equal(
    await stored("secrets", "encrypted_value", "workflow-1"),
    workflowCiphertext,
  );
  const business = await workflowCli("workflow-business", "verify-business");
  assert.equal(business?.businessVerification, "passed");
  assert.equal(business.operatorReencryptAndRollback, "passed");
  assert.equal(business.targetRuntimeVerification, undefined);
  for (const [scenario, errorCode] of [
    ["aws-access-denied", "AccessDenied"],
    ["aws-invalid-identity-token", "InvalidIdentityToken"],
    ["aws-cli-input-error", "CliInputError"],
    ["aws-unclassified", "UnclassifiedAwsCliFailure"],
  ]) {
    const rejected = await workflowCli(
      "workflow-business-" + scenario,
      "verify-business",
      scenario,
    );
    assert.equal(rejected?.result, "failed");
    assert.deepEqual(rejected.awsFailure, {
      operation: "sts:AssumeRoleWithWebIdentity",
      errorCode,
      exitCode: 255,
    });
    assert.equal(
      rejected.failure,
      "aws_operation_failed:sts:AssumeRoleWithWebIdentity:" + errorCode,
    );
    assert.equal(rejected.businessVerification, undefined);
    assert.equal(rejected.operatorReencryptAndRollback, undefined);
  }
  for (const scenario of [
    "business-incomplete",
    "wrong-operator",
    "deployment-changed",
  ]) {
    await workflowCli(
      "workflow-business-" + scenario,
      "verify-business",
      scenario,
    );
  }
  assert.equal(
    await stored("secrets", "encrypted_value", "workflow-1"),
    workflowCiphertext,
  );
  assert.equal(
    await stored("secrets", "encrypted_value", "workflow-2"),
    workflowCiphertext,
  );
  for (const scenario of [
    "backup-changed",
    "wrong-operator",
    "deployment-changed",
    "provider-error",
  ]) {
    await workflowCli("workflow-" + scenario, "migrate", scenario);
    assert.equal(
      await stored("secrets", "encrypted_value", "workflow-1"),
      workflowCiphertext,
    );
    assert.equal(
      await stored("secrets", "encrypted_value", "workflow-2"),
      workflowCiphertext,
    );
  }
  for (const [name, overrides] of [
    ["unprotected-branch", { GITHUB_REF: "refs/heads/unprotected" }],
    ["missing-role", { KMS_MIGRATION_ROLE_ARN: "" }],
    ["invalid-limit", { MAX_ROWS: "100001" }],
    ["wrong-runtime-key", { SECRETS_KMS_KEY_ID: source }],
  ] satisfies [string, Record<string, string>][]) {
    await workflowCli("workflow-" + name, "migrate", "rejected", overrides);
    assert.equal(
      await stored("secrets", "encrypted_value", "workflow-1"),
      workflowCiphertext,
    );
  }
  failRewrap = true;
  try {
    await workflowCli("workflow-operator-denied", "migrate", "operator-denied");
    assert.equal(
      await stored("secrets", "encrypted_value", "workflow-1"),
      workflowCiphertext,
    );
  } finally {
    failRewrap = false;
  }
  const workflowMigration = await workflowCli("workflow-bounded", "migrate");
  const migration = object(workflowMigration?.migration);
  assert.equal(migration.complete, false);
  assert.equal(object(migration.totals).updated, 1);
  assert.equal(
    decode(await stored("secrets", "encrypted_value", "workflow-1")).kms.keyId,
    target,
  );
  assert.equal(
    await stored("secrets", "encrypted_value", "workflow-2"),
    workflowCiphertext,
  );
  await workflowCli("workflow-resume", "migrate", "success", {
    CURSOR: string(migration.cursor),
    MAX_ROWS: "100",
  });
  const workflowFinal = await workflowCli("workflow-final", "verify");
  assert.equal(
    object(workflowFinal?.targetRuntimeVerification).databaseVerifiedOnTarget,
    true,
  );
  await db.query("DELETE FROM secrets");
  const concurrentFixtures: { id: string; ciphertext: string }[] = [];
  for (let index = 0; index < 9; index++) {
    const envelope = await encrypt(kms, Buffer.from(secret), source);
    const id = `parallel-${index}`;
    await db.query("INSERT INTO secrets VALUES ($1, $2)", [
      id,
      encode(envelope),
    ]);
    concurrentFixtures.push({
      id,
      ciphertext: string(envelope.kms.encryptedDataKey),
    });
  }
  const beforeConcurrentVerification: unknown[] = (
    await db.query("SELECT * FROM secrets ORDER BY id")
  ).rows;
  let activeDecrypts = 0;
  let peakDecrypts = 0;
  const waiting: (() => void)[] = [];
  beforeDecrypt = async () => {
    activeDecrypts++;
    peakDecrypts = Math.max(peakDecrypts, activeDecrypts);
    try {
      await new Promise<void>((resolve) => {
        waiting.push(resolve);
        if (waiting.length === 3) {
          for (const release of waiting.splice(0)) {
            release();
          }
        }
      });
    } finally {
      activeDecrypts--;
    }
  };
  try {
    const concurrent = await cli("concurrent-verify", [
      "--verify",
      "--verify-concurrency",
      "3",
      "--batch-size",
      "9",
      "--max-rows",
      "100001",
    ]);
    assert.equal(concurrent.complete, true);
    assert.equal(object(concurrent.totals).verified, 9);
    assert.equal(object(concurrent.totals).updated, 0);
    assert.equal(
      peakDecrypts,
      3,
      "Decrypts must run concurrently within the cap",
    );
    assert.equal(activeDecrypts, 0, "The CLI must drain all requests");
  } finally {
    beforeDecrypt = undefined;
    for (const release of waiting.splice(0)) {
      release();
    }
  }
  const firstFixture = concurrentFixtures[0];
  const failedFixture = concurrentFixtures[1];
  const laterFixture = concurrentFixtures[2];
  assert.ok(firstFixture && failedFixture && laterFixture);
  let releaseFirst: (() => void) | undefined;
  const firstMayComplete = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  beforeDecrypt = async (ciphertext) => {
    if (ciphertext === firstFixture.ciphertext) {
      await firstMayComplete;
    } else if (ciphertext === failedFixture.ciphertext) {
      throw new Error("synthetic failure in the middle of a concurrent group");
    } else if (ciphertext === laterFixture.ciphertext) {
      assert.ok(releaseFirst);
      releaseFirst();
    }
  };
  let concurrentFailure: Record<string, unknown>;
  try {
    concurrentFailure = await cli(
      "concurrent-failure",
      ["--verify", "--verify-concurrency", "3", "--batch-size", "9"],
      false,
      true,
    );
  } finally {
    beforeDecrypt = undefined;
    assert.ok(releaseFirst);
    releaseFirst();
  }
  assert.deepEqual(concurrentFailure.failureDetails, {
    stage: "process_rows",
    code: "InvalidCiphertextException",
  });
  assert.equal(concurrentFailure.complete, false);
  assert.equal(object(concurrentFailure.totals).rows, 1);
  assert.equal(object(concurrentFailure.totals).verified, 1);
  const failedCursor = object(
    JSON.parse(
      Buffer.from(string(concurrentFailure.cursor), "base64url").toString(
        "utf8",
      ),
    ),
  );
  assert.equal(failedCursor.id, firstFixture.id);
  const concurrentResume = await cli("concurrent-resume", [
    "--verify",
    "--verify-concurrency",
    "3",
    "--cursor",
    string(concurrentFailure.cursor),
  ]);
  assert.equal(concurrentResume.complete, true);
  assert.equal(concurrentResume.resumed, true);
  assert.equal(object(concurrentResume.totals).verified, 8);
  assert.equal(object(concurrentResume.totals).updated, 0);
  assert.deepEqual(
    (await db.query("SELECT * FROM secrets ORDER BY id")).rows,
    beforeConcurrentVerification,
    "Concurrent verification and resume must preserve every stored ciphertext",
  );
  await db.query("DELETE FROM secrets");
  const original = encode(await encrypt(kms, Buffer.from(secret), source));
  const latest = encode(
    await encrypt(kms, Buffer.from(`${secret}-updated`), source),
  );
  const direct = await kms.send(
    new EncryptCommand({
      KeyId: source,
      Plaintext: Buffer.from(secret),
      EncryptionContext: encryptionContext,
    }),
  );
  assert.ok(direct.CiphertextBlob);
  const legacy = encode({
    v: 1,
    kind: "stored-secret",
    kms: {
      keyId: source,
      ciphertext: Buffer.from(direct.CiphertextBlob).toString("base64"),
    },
  });
  const bareKey = decode(original);
  const bare = encode({
    ...bareKey,
    kms: { ...bareKey.kms, keyId: string(source.split("/").at(-1)) },
  });
  await db.query(
    "INSERT INTO secrets VALUES ('01', $1), ('02', $2), ('03', $3)",
    [original, legacy, bare],
  );
  await db.query("INSERT INTO runner_job_queue VALUES ('run', $1)", [
    JSON.stringify({ encryptedSecrets: original, keep: "unchanged" }),
  ]);
  const payload = {
    version: 1,
    executionContext: { encryptedSecrets: original, extra: 42 },
    runnerGroup: "synthetic",
  };
  const outer = encode(
    await encrypt(
      kms,
      Buffer.from(
        JSON.stringify({ __api_runner_job_payload__: JSON.stringify(payload) }),
      ),
      target,
    ),
  );
  await db.query("INSERT INTO agent_run_queue VALUES ('queued', $1)", [outer]);

  const beforeInventory = kmsRequests;
  const inventory = await cli("inventory");
  assert.equal(inventory.complete, true);
  assert.equal(kmsRequests, beforeInventory, "Inventory must not call KMS");
  assert.equal(object(inventory.totals).nestedUninspected, 1);
  assert.equal(object(inventory.totals).nonArn, 1);
  const limited = await cli("limited", ["--max-rows", "1"]);
  assert.equal(limited.complete, false);
  const resumed = await cli("inventory-resume", [
    "--cursor",
    string(limited.cursor),
  ]);
  assert.equal(resumed.complete, true);
  assert.equal(resumed.resumed, true);

  const verified = await cli("preflight", ["--verify"]);
  assert.equal(verified.complete, true);
  assert.equal(object(verified.totals).nestedSource, 1);
  assert.equal(verified.databaseVerifiedOnTarget, false);
  assert.equal(await stored("secrets", "encrypted_value", "01"), original);
  beforeRewrap = async () => {
    await db.query("UPDATE secrets SET encrypted_value = $1 WHERE id = '01'", [
      latest,
    ]);
    await db.query(
      "UPDATE runner_job_queue SET execution_context = jsonb_set(execution_context, '{keep}', '\"concurrent\"') WHERE run_id = 'run'",
    );
  };
  const bounded = await cli("bounded-migrate", [
    "--migrate",
    "--preflight",
    join(directory, "preflight.json"),
    "--max-rows",
    "2",
  ]);
  assert.equal(bounded.complete, false);
  assert.equal(object(bounded.totals).concurrentChanges, 1);
  assert.equal(
    await stored("secrets", "encrypted_value", "01"),
    latest,
    "CAS must preserve a concurrent credential update",
  );
  await cli("resume-migrate", [
    "--migrate",
    "--preflight",
    join(directory, "preflight.json"),
    "--cursor",
    string(bounded.cursor),
  ]);
  const afterResume = await cli("post-resume", ["--verify"]);
  assert.equal(
    object(afterResume.totals).source,
    1,
    "A fresh scan must rediscover a skipped concurrent write",
  );
  const moved = decode(await stored("secrets", "encrypted_value", "03"));
  assert.equal(moved.kms.iv, bareKey.kms.iv);
  assert.equal(moved.kms.authTag, bareKey.kms.authTag);
  assert.equal(moved.kms.ciphertext, bareKey.kms.ciphertext);
  assert.equal(moved.kms.keyId, target);
  assert.notEqual(moved.kms.encryptedDataKey, bareKey.kms.encryptedDataKey);
  const queueRows: unknown[] = (
    await db.query("SELECT execution_context FROM runner_job_queue")
  ).rows;
  assert.equal(
    object(object(queueRows[0]).execution_context).keep,
    "concurrent",
  );
  const newOuter = decode(
    await stored("agent_run_queue", "encrypted_params", "queued"),
  );
  assert.notEqual(newOuter.kms.iv, decode(outer).kms.iv);
  const queuePlaintext = await decrypt(kms, newOuter, target);
  const newMap = object(JSON.parse(queuePlaintext.toString("utf8")));
  queuePlaintext.fill(0);
  const newPayload = object(
    JSON.parse(string(newMap.__api_runner_job_payload__)),
  );
  assert.equal(object(newPayload.executionContext).extra, 42);
  assert.equal(
    decode(string(object(newPayload.executionContext).encryptedSecrets)).kms
      .keyId,
    target,
  );

  failRewrap = true;
  const failure = await cli(
    "kms-failure",
    ["--migrate", "--preflight", join(directory, "post-resume.json")],
    false,
    true,
  );
  assert.deepEqual(failure.failureDetails, {
    stage: "process_rows",
    code: "AccessDeniedException",
  });
  assert.equal(failure.complete, false);
  assert.ok(failure.cursor);
  failRewrap = false;
  await cli("retry", [
    "--migrate",
    "--preflight",
    join(directory, "post-resume.json"),
    "--cursor",
    string(failure.cursor),
  ]);
  const final = await cli("final", ["--verify"]);
  assert.equal(final.databaseVerifiedOnTarget, true);
  const finalClear = await decrypt(
    kms,
    decode(await stored("secrets", "encrypted_value", "01")),
    target,
  );
  assert.equal(finalClear.toString("utf8"), `${secret}-updated`);
  finalClear.fill(0);

  await cli("rollback-preflight", ["--verify"], true);
  await cli(
    "rollback",
    ["--migrate", "--preflight", join(directory, "rollback-preflight.json")],
    true,
  );
  const rollback = await cli("rollback-verify", ["--verify"], true);
  assert.equal(rollback.databaseVerifiedOnTarget, true);
  const rollbackClear = await decrypt(
    kms,
    decode(await stored("secrets", "encrypted_value", "01")),
    source,
  );
  assert.equal(
    rollbackClear.toString("utf8"),
    `${secret}-updated`,
    "Rollback must keep the current value",
  );
  rollbackClear.fill(0);
  const malformed =
    prefix +
    Buffer.from(
      JSON.stringify({
        v: 1,
        kind: "stored-secret",
        kms: {
          keyId: source,
          ciphertext: "c2FmZQ==",
          encryptedDataKey: "partial",
        },
      }),
    ).toString("base64url");
  await db.query("INSERT INTO secrets VALUES ('bad', $1)", [malformed]);
  const invalid = await cli("malformed", [], false, true);
  assert.equal(object(invalid.totals).invalid, 1);
  assert.equal(invalid.databaseVerifiedOnTarget, false);
  process.stdout.write(
    "KMS rotation CLI integration passed: protected workflow entry, runtime and operator canaries, failure-before-write guards, secret-safe artifacts, read-only inventory, concurrent verification and failure checkpoints, nested verification, bounded resume, concurrent writes, KMS failure recovery, rewrap preservation, reverse migration, and malformed ciphertext.\n",
  );
} finally {
  kms.destroy();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
  await db.end();
  await admin.query(`DROP DATABASE "${databaseName}"`);
  await admin.end();
  await rm(directory, { recursive: true, force: true });
}
