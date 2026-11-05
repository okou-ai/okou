import { open } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { S3Client } from "@aws-sdk/client-s3";
import postgres from "postgres";
import {
  BackfillError,
  classification,
  configuration,
  input,
  type PlanRow,
} from "./command";
import { loadSource, publishReference, sourceUnchanged } from "./source";
import { publishArchive, sourceArchive, targetExists } from "./objects";

async function processTarget({
  sql,
  objects,
  bucket,
  connectorId,
  reviewed,
  append,
}: {
  sql: postgres.Sql;
  objects: S3Client;
  bucket: string;
  connectorId: string;
  reviewed: PlanRow | undefined;
  append: (entry: object) => Promise<void>;
}): Promise<PlanRow> {
  const source = await loadSource(sql, connectorId);
  if (reviewed) sourceUnchanged(source, reviewed);
  const original = await sourceArchive(objects, bucket, source);
  const target =
    reviewed?.target ??
    (source.bundle && source.bundleSource === source.sourceVersionId
      ? source.bundle
      : original.target);
  const row = reviewed ?? { source, target };
  sourceUnchanged(await loadSource(sql, connectorId), row);
  if (reviewed) {
    await append({
      event: "intent",
      connectorId,
      sourceVersionId: source.sourceVersionId,
      target,
    });
    const current = await loadSource(sql, connectorId);
    if (sourceUnchanged(current, row) === "pending") {
      if (!isDeepStrictEqual(original.target, row.target))
        throw new BackfillError("ReviewedArchiveMismatch");
      await publishArchive(objects, bucket, source, row.target, original.bytes);
      if (
        sourceUnchanged(await loadSource(sql, connectorId), row) === "pending"
      )
        await publishReference(sql, row);
    }
    if (
      sourceUnchanged(await loadSource(sql, connectorId), row) !== "verified" ||
      !(await targetExists(objects, bucket, row.target, source))
    )
      throw new BackfillError("PublishedReferenceUnverified");
    await append({
      event: "verified",
      connectorId,
      sourceVersionId: source.sourceVersionId,
      target,
    });
  } else {
    const exists = await targetExists(objects, bucket, target, source);
    if (
      source.bundle &&
      source.bundleSource === source.sourceVersionId &&
      !exists
    )
      throw new BackfillError("PreparedObjectMissing");
    sourceUnchanged(await loadSource(sql, connectorId), row);
  }
  return row;
}

async function main() {
  const selected = await input();
  const config = await configuration(selected.reviewed?.scope);
  const output = await open(selected.output, "wx", 0o600);
  const sql = postgres(config.connection, {
    max: 1,
    connect_timeout: 10,
    connection: {
      default_transaction_read_only: !selected.reviewed,
      statement_timeout: 30_000,
    },
  });
  const objects = new S3Client({
    region: "auto",
    endpoint: config.endpoint,
    credentials: config.credentials,
    forcePathStyle: true,
    maxAttempts: 1,
  });
  const rows: PlanRow[] = [];
  const failures: { connectorId: string; classification: string }[] = [];
  const append = async (entry: object) => {
    await output.writeFile(JSON.stringify(entry) + "\n");
    await output.sync();
  };
  try {
    if (selected.reviewed)
      await append({
        event: "start",
        planSha256: selected.planSha256,
        scope: config.scope,
        at: new Date().toISOString(),
      });
    for (const connectorId of selected.ids) {
      try {
        const reviewed = selected.reviewed?.rows.find((row) => {
          return row.source.connectorId === connectorId;
        });
        rows.push(
          await processTarget({
            sql,
            objects,
            bucket: config.bucket,
            connectorId,
            reviewed,
            append,
          }),
        );
      } catch (error) {
        const failure = { connectorId, classification: classification(error) };
        failures.push(failure);
        if (selected.reviewed) await append({ event: "failed", ...failure });
      }
    }
    // A bounded batch is not a snapshot. Reconcile every selected owner again.
    for (const row of rows) {
      try {
        sourceUnchanged(await loadSource(sql, row.source.connectorId), row);
      } catch (error) {
        const failure = {
          connectorId: row.source.connectorId,
          classification: classification(error),
        };
        failures.push(failure);
        if (selected.reviewed)
          await append({ event: "reconciliation-failed", ...failure });
      }
    }
    const failedIds = new Set(
      failures.map((failure) => {
        return failure.connectorId;
      }),
    );
    const complete = failedIds.size === 0;
    const verified = rows.filter((row) => {
      return !failedIds.has(row.source.connectorId);
    }).length;
    if (selected.reviewed)
      await append({
        event: "complete",
        complete,
        verified,
        failed: failedIds.size,
        at: new Date().toISOString(),
      });
    else {
      await output.writeFile(
        JSON.stringify(
          {
            format: "connector-skill-backfill-v1",
            mode: "read-only",
            capturedAt: new Date().toISOString(),
            scope: config.scope,
            complete,
            rows,
            failures,
          },
          null,
          2,
        ) + "\n",
      );
      await output.sync();
    }
    process.stdout.write(
      JSON.stringify({
        complete,
        verified,
        failed: failedIds.size,
      }) + "\n",
    );
    if (!complete) process.exitCode = 1;
  } finally {
    try {
      await sql.end({ timeout: 5 });
    } finally {
      objects.destroy();
      await output.close();
    }
  }
}

try {
  await main();
} catch (error) {
  process.stderr.write(classification(error) + "\n");
  process.exitCode = 1;
}
