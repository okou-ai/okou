import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

// CI supplies a PostgreSQL service connection, never a fixture schema. Create a
// separate random database so neither the input database nor parallel tests can
// observe this migration's rows. Invoke the current migration runner only from
// this test harness; the historical operation itself remains self-contained.
const configuredUrl = process.env.DATABASE_URL;
assert.ok(
  configuredUrl,
  "DATABASE_URL is required for the test PostgreSQL service",
);
const adminUrl = new URL(configuredUrl);
assert.ok(
  ["localhost", "127.0.0.1", "[::1]", "postgres"].includes(adminUrl.hostname),
  "Use a local or CI PostgreSQL test service",
);
adminUrl.pathname = "/postgres";
const database = `hosted_pointer_test_${randomUUID().replaceAll("-", "")}`;
const fixtureUrl = new URL(adminUrl);
fixtureUrl.pathname = `/${database}`;
const packageDirectory = fileURLToPath(new URL("../../../", import.meta.url));
const admin = new Client({ connectionString: adminUrl.toString() });

async function run(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", ...args], {
      cwd: packageDirectory,
      env,
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `Hosted publication pointer test subprocess failed: ${String(code)}`,
          ),
        );
    });
  });
}

await admin.connect();
let created = false;
try {
  await admin.query(`CREATE DATABASE "${database}"`);
  created = true;
  await run(["scripts/migrate.ts"], {
    ...process.env,
    DATABASE_URL: fixtureUrl.toString(),
  });
  await run(
    [
      "--test",
      "--test-concurrency=1",
      "scripts/migrations/018-hosted-publication-pointers/test-model.ts",
      "scripts/migrations/018-hosted-publication-pointers/test-integration.ts",
    ],
    {
      ...process.env,
      DATABASE_URL: fixtureUrl.toString(),
      HOSTED_MIGRATION_TEST_DATABASE_URL: fixtureUrl.toString(),
    },
  );
} finally {
  if (created) await admin.query(`DROP DATABASE "${database}" WITH (FORCE)`);
  await admin.end();
}
