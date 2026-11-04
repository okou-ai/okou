import { open } from "node:fs/promises";
import { S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";
import { RegistryArchiveValidationError } from "@okouai/core/registry-resource-archive";
import { InventoryError } from "./source";
import { readInput, backfillConfiguration } from "./backfill-command";
import { sha256, type PlanRow } from "./backfill-plan";
import { publishObject, sourceBytes, targetExists } from "./backfill-objects";
import { BackfillIndex } from "./backfill-index";

function classification(error: unknown): string {
  if (error instanceof InventoryError) return error.classification;
  if (error instanceof RegistryArchiveValidationError) return error.message;
  return "RegistryBackfillFailed";
}

async function main() {
  const { selected, bytes, reviewed, inventory, rows } = await readInput();
  const config = await backfillConfiguration(
    reviewed?.scope ?? inventory!.scope,
    selected.apply,
  );
  const { scope, targetBucket, targetEndpoint } = config;
  const output = await open(selected.output!, "wx", 0o600);
  const sql = postgres(config.connection, {
    max: 1,
    connect_timeout: 10,
    connection: {
      default_transaction_read_only: !selected.apply,
      statement_timeout: 30_000,
    },
  });
  const source = new S3Client({
    region: "auto",
    endpoint: config.endpoint.toString(),
    credentials: config.credentials,
    maxAttempts: 1,
  });
  const target = new S3Client({
    region: "auto",
    endpoint: targetEndpoint.toString(),
    credentials: config.targetCredentials,
    maxAttempts: 1,
  });
  const index = new BackfillIndex(sql);
  const failures: {
    resourceId: string;
    selection: string;
    classification: string;
  }[] = [];
  const planned: PlanRow[] = [];
  const append = async (entry: object) => {
    await output.writeFile(`${JSON.stringify(entry)}\n`);
    await output.sync();
  };
  try {
    if (selected.apply)
      await append({
        event: "start",
        format: "registry-resource-backfill-receipt-v1",
        scope,
        planSha256: sha256(bytes),
        startedAt: new Date().toISOString(),
      });
    for (const row of rows) {
      try {
        if (selected.apply)
          await append({
            event: "intent",
            resourceId: row.resourceId,
            selection: row.selection,
            sha256: row.archive.sha256,
          });
        await index.sourceUnchanged(row);
        const original = await sourceBytes(source, config.bucket, row);
        await index.sourceUnchanged(row);
        if (reviewed) {
          // Preflight immutable index metadata before an external write.
          await index.archive(row);
          await publishObject(target, targetBucket, row, original);
          const plannedRow = reviewed.rows.find((entry) => {
            return (
              entry.resourceId === row.resourceId &&
              entry.selection === row.selection
            );
          })!;
          await index.publish(plannedRow);
          await append({
            event: "verified",
            resourceId: row.resourceId,
            selection: row.selection,
            sha256: row.archive.sha256,
          });
        } else {
          await targetExists(target, targetBucket, row);
          await index.archive(row);
          const expectedHead =
            row.selection === "latest"
              ? await index.head(row.resourceId)
              : null;
          await index.sourceUnchanged(row);
          planned.push({ ...row, expectedHead });
        }
      } catch (error) {
        const failure = {
          resourceId: row.resourceId,
          selection: row.selection,
          classification: classification(error),
        };
        failures.push(failure);
        if (selected.apply) await append({ event: "failed", ...failure });
      }
    }
    // Reconcile every selected source again: a successful earlier row is not a
    // global snapshot, and legacy publishers may have advanced during the run.
    for (const row of rows) {
      try {
        if (reviewed) await index.verify(row);
        else await index.sourceUnchanged(row);
      } catch (error) {
        const failure = {
          resourceId: row.resourceId,
          selection: row.selection,
          classification: classification(error),
        };
        failures.push(failure);
        if (selected.apply)
          await append({ event: "reconciliation-failed", ...failure });
      }
    }
    const complete = failures.length === 0;
    if (selected.apply) {
      await append({
        event: "complete",
        complete,
        verified:
          rows.length -
          new Set(
            failures.map((row) => {
              return `${row.resourceId}/${row.selection}`;
            }),
          ).size,
        failed: failures.length,
        completedAt: new Date().toISOString(),
      });
      process.stdout.write(
        `${JSON.stringify({ complete, failed: failures.length })}\n`,
      );
    } else {
      const plan = `${JSON.stringify({ format: "registry-resource-backfill-plan-v1", mode: "read-only", capturedAt: new Date().toISOString(), inventorySha256: sha256(bytes), scope, complete, rows: planned, failures }, null, 2)}\n`;
      await output.writeFile(plan);
      await output.sync();
      process.stdout.write(
        `${JSON.stringify({ complete, planned: planned.length, failed: failures.length, planSha256: sha256(plan) })}\n`,
      );
    }
    if (!complete) process.exitCode = 1;
  } finally {
    try {
      await sql.end({ timeout: 5 });
    } finally {
      source.destroy();
      target.destroy();
      await output.close();
    }
  }
}

try {
  await main();
} catch (error) {
  // Provider errors can embed credentials; persist only bounded classifications.
  process.stderr.write(`${classification(error)}\n`);
  process.exitCode = 1;
}
