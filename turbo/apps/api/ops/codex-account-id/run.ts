/** One-off operator: dry-run by default. Never prints identities or credentials. */
import { parseArgs } from "node:util";
import { Client } from "pg";
import { decryptStoredSecretValue } from "../../src/signals/services/crypto.utils";
import { apply, audit, BackfillError } from "./core";

const { values } = parseArgs({
  options: {
    apply: { type: "boolean", default: false },
    "expect-plan-sha256": { type: "string" },
  },
});
const expected = values["expect-plan-sha256"];
if (values.apply && !/^[a-f0-9]{64}$/.test(expected ?? "")) {
  throw new BackfillError("ReviewedPlanRequired");
}
const client = new Client({
  connectionString: process.env.DATABASE_URL,
  connectionTimeoutMillis: 20_000,
  statement_timeout: 30_000,
});
try {
  if (!process.env.DATABASE_URL) {
    throw new BackfillError("DatabaseRequired");
  }
  await client.connect();
  const before = await audit(client, decryptStoredSecretValue);
  process.stdout.write(
    JSON.stringify({
      mode: "dry-run",
      scanned: before.scanned,
      matching: before.matching,
      missing: before.candidates.length,
      planSha256: before.planSha256,
    }) + "\n",
  );
  if (values.apply) {
    if (expected !== before.planSha256) {
      throw new BackfillError("PlanChanged");
    }
    const updated = await apply(client, before.candidates);
    const after = await audit(client, decryptStoredSecretValue);
    if (after.candidates.length !== 0) {
      throw new BackfillError("NotConverged");
    }
    process.stdout.write(
      JSON.stringify({
        mode: "verified",
        updated,
        scanned: after.scanned,
        matching: after.matching,
        missing: after.candidates.length,
        reviewedPlanSha256: expected,
      }) + "\n",
    );
  }
} catch (error) {
  // Raw PostgreSQL/KMS diagnostics can contain an account ID or credential.
  const reason =
    error instanceof BackfillError ? error.message : "OperatorFailed";
  process.stderr.write(JSON.stringify({ status: "failed", reason }) + "\n");
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {
    process.stderr.write(
      '{"status":"failed","reason":"ConnectionCleanupFailed"}\n',
    );
    process.exitCode = 1;
  });
}
