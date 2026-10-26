import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { z } from "zod";
import { sourceSchema } from "./format";

const exec = promisify(execFile);
export function identity(uri: string) {
  const parsed = new URL(uri);
  if (parsed.protocol !== "postgresql:" && parsed.protocol !== "postgres:")
    throw new Error("UnsupportedDatabaseProtocol");
  for (const name of parsed.searchParams.keys()) {
    if (name !== "sslmode") throw new Error("UnsupportedDatabaseUriSetting");
  }
  const database = decodeURIComponent(parsed.pathname.slice(1));
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(database))
    throw new Error("UnsupportedDatabaseName");
  return {
    host: `${parsed.hostname}:${parsed.port || "5432"}`,
    database,
  };
}
export async function pg(
  command: string,
  args: string[],
  uri: string,
  bin: string | undefined,
) {
  const parsed = new URL(uri);
  // Never inherit libpq routing/service/password-file overrides from the shell.
  const ordinaryEnvironment = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      return !key.startsWith("PG");
    }),
  );
  try {
    await exec(path.join(bin ?? "", command), args, {
      env: {
        ...ordinaryEnvironment,
        PGHOST: parsed.hostname,
        PGPORT: parsed.port || "5432",
        PGDATABASE: decodeURIComponent(parsed.pathname.slice(1)),
        PGUSER: decodeURIComponent(parsed.username),
        PGPASSWORD: decodeURIComponent(parsed.password),
        PGSSLMODE: parsed.searchParams.get("sslmode") ?? "prefer",
      },
      maxBuffer: 1024 * 1024,
    });
  } catch {
    throw new Error("PostgresToolFailedInspectPrivateTarget");
  }
}
export async function writeReceipt(file: string, value: unknown) {
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`);
    await handle.sync();
  } finally {
    await handle.close();
  }
  const directory = await open(path.dirname(file), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
const attemptSchema = z.object({
  attemptId: z.uuid(),
  archiveSha256: z.string(),
  approvalSha256: z.string(),
  source: sourceSchema,
});
export async function recordIntent(
  directory: string,
  archiveSha256: string,
  approvalSha256: string,
  source: z.infer<typeof sourceSchema>,
  plannedCounts: unknown,
) {
  const intent = {
    attemptId: randomUUID(),
    archiveSha256,
    approvalSha256,
    source,
    startedAt: new Date().toISOString(),
    plannedCounts,
  };
  // wx refuses an unexamined previous attempt, including an uncertain commit.
  await writeReceipt(path.join(directory, "retirement-intent.json"), intent);
  return intent;
}
export async function reconcileEmpty(
  directory: string,
  archiveSha256: string,
  approvalSha256: string,
  source: z.infer<typeof sourceSchema>,
) {
  const intent = attemptSchema.parse(
    JSON.parse(
      await readFile(path.join(directory, "retirement-intent.json"), "utf8"),
    ),
  );
  if (
    intent.archiveSha256 !== archiveSha256 ||
    intent.approvalSha256 !== approvalSha256 ||
    JSON.stringify(intent.source) !== JSON.stringify(source)
  )
    throw new Error("RetirementIntentMismatch");
  for (const name of [
    "retirement-receipt.json",
    "retirement-reconciliation.json",
  ]) {
    try {
      const receipt = attemptSchema.parse(
        JSON.parse(await readFile(path.join(directory, name), "utf8")),
      );
      if (JSON.stringify(receipt) !== JSON.stringify(intent))
        throw new Error("RetirementReceiptMismatch");
      return;
    } catch (error) {
      if (!(
        error instanceof Error &&
        "code" in error &&
        error.code === "ENOENT"
      ))
        throw error;
    }
  }
  // This observes emptiness; it does not invent counts for an unobserved DELETE.
  await writeReceipt(path.join(directory, "retirement-reconciliation.json"), {
    ...intent,
    reconciledAt: new Date().toISOString(),
    observedState: "all-four-tables-empty",
    disposition:
      "platform-absorbs-unconfirmed-cost-no-additional-charge-no-refund-or-compensation",
  });
}
