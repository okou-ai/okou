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
let phase = "connect";
let decrypted = 0;
async function decrypt(encrypted: string) {
  phase = "decrypt";
  const value = await decryptStoredSecretValue(encrypted);
  decrypted++;
  phase = "audit";
  return value;
}
try {
  if (!process.env.DATABASE_URL) {
    throw new BackfillError("DatabaseRequired");
  }
  await client.connect();
  phase = "audit";
  const before = await audit(client, decrypt);
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
    phase = "apply";
    const updated = await apply(client, before.candidates);
    phase = "post-audit";
    const after = await audit(client, decrypt);
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
  const rawCode = error instanceof Error && "code" in error ? error.code : "";
  const code =
    typeof rawCode === "string" &&
    (/^[0-9A-Z]{5}$/.test(rawCode) ||
      ["ENOTFOUND", "ECONNRESET", "ETIMEDOUT", "ECONNREFUSED"].includes(
        rawCode,
      ))
      ? rawCode
      : "Other";
  const errorType =
    error instanceof Error &&
    [
      "ZodError",
      "AccessDeniedException",
      "InvalidCiphertextException",
      "UnrecognizedClientException",
      "CredentialsProviderError",
    ].includes(error.name)
      ? error.name
      : "Other";
  process.stderr.write(
    JSON.stringify({
      status: "failed",
      reason,
      phase,
      decrypted,
      code,
      errorType,
    }) + "\n",
  );
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {
    process.stderr.write(
      '{"status":"failed","reason":"ConnectionCleanupFailed"}\n',
    );
    process.exitCode = 1;
  });
}
