import "./placeholder-env";

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import {
  GetObjectCommand,
  ListObjectsV2Command,
  S3Client,
} from "@aws-sdk/client-s3";

import {
  CHAT_EVENT_SNAPSHOT_PREFIX,
  createDryRunTally,
  inspectSnapshotObject,
  recordDownloadFailure,
  recordInspection,
  renderDryRunMarkdown,
  summarizeDryRun,
  type DryRunTally,
} from "./dry-run";

/**
 * Chat Event V8 transition code (removed in PR-3): read-only production dry
 * run of the V7 -> V8 Snapshot upgrade. It only issues ListObjectsV2 and
 * GetObject; it never writes to R2 and never connects to a database.
 */

const DOWNLOAD_ATTEMPTS = 4;
const DEFAULT_CONCURRENCY = 16;
const MAX_CONCURRENCY = 64;
const PROGRESS_INTERVAL = 5000;

function optionalInput(name: string): string | undefined {
  return process.env[name] || undefined;
}

function requiredInput(name: string): string {
  const value = optionalInput(name);
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function concurrency(): number {
  const raw = optionalInput("CHAT_EVENT_DRY_RUN_CONCURRENCY");
  if (!raw) {
    return DEFAULT_CONCURRENCY;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1 || value > MAX_CONCURRENCY) {
    throw new Error(
      `CHAT_EVENT_DRY_RUN_CONCURRENCY must be an integer from 1 to ${MAX_CONCURRENCY.toString()}`,
    );
  }
  return value;
}

async function listSnapshotKeys(
  client: S3Client,
  bucket: string,
): Promise<string[]> {
  const keys: string[] = [];
  let continuationToken: string | undefined;
  do {
    const page = await client.send(
      new ListObjectsV2Command({
        Bucket: bucket,
        Prefix: CHAT_EVENT_SNAPSHOT_PREFIX,
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }),
    );
    for (const object of page.Contents ?? []) {
      if (object.Key !== undefined) {
        keys.push(object.Key);
      }
    }
    continuationToken = page.IsTruncated
      ? page.NextContinuationToken
      : undefined;
  } while (continuationToken !== undefined);
  return keys;
}

async function downloadOnce(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer> {
  const response = await client.send(
    new GetObjectCommand({ Bucket: bucket, Key: key }),
  );
  if (response.Body === undefined) {
    throw new Error("Empty GetObject body");
  }
  return Buffer.from(await response.Body.transformToByteArray());
}

async function download(
  client: S3Client,
  bucket: string,
  key: string,
): Promise<Buffer> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= DOWNLOAD_ATTEMPTS; attempt += 1) {
    try {
      return await downloadOnce(client, bucket, key);
    } catch (error) {
      lastError = error;
      if (attempt < DOWNLOAD_ATTEMPTS) {
        await sleep(500 * 2 ** (attempt - 1));
      }
    }
  }
  throw lastError;
}

async function inspectAll(
  client: S3Client,
  bucket: string,
  keys: readonly string[],
  tally: DryRunTally,
  workers: number,
): Promise<void> {
  let next = 0;
  let done = 0;
  const worker = async (): Promise<void> => {
    while (next < keys.length) {
      const key = keys[next];
      next += 1;
      if (key === undefined) {
        return;
      }
      try {
        const body = await download(client, bucket, key);
        recordInspection(tally, key, inspectSnapshotObject(key, body));
      } catch (error) {
        recordDownloadFailure(tally, key, error);
      }
      done += 1;
      if (done % PROGRESS_INTERVAL === 0) {
        process.stdout.write(
          `progress ${done.toString()}/${keys.length.toString()} succeeded=${tally.succeeded.toString()} failed=${tally.failed.toString()} downloadFailed=${tally.downloadFailed.toString()}\n`,
        );
      }
    }
  };
  await Promise.all(
    Array.from({ length: workers }, () => {
      return worker();
    }),
  );
}

async function main(): Promise<void> {
  const accountId = requiredInput("CHAT_EVENT_DRY_RUN_R2_ACCOUNT_ID");
  const bucket = requiredInput("CHAT_EVENT_DRY_RUN_R2_BUCKET");
  const outputDir = requiredInput("CHAT_EVENT_DRY_RUN_OUTPUT_DIR");
  const client = new S3Client({
    region: "auto",
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: requiredInput("CHAT_EVENT_DRY_RUN_R2_ACCESS_KEY_ID"),
      secretAccessKey: requiredInput("CHAT_EVENT_DRY_RUN_R2_SECRET_ACCESS_KEY"),
    },
    maxAttempts: 5,
  });

  const startedAt = new Date().toISOString();
  const tally = createDryRunTally();
  const keys = await listSnapshotKeys(client, bucket);
  tally.objectsListed = keys.length;
  process.stdout.write(`listed ${keys.length.toString()} objects\n`);
  await inspectAll(client, bucket, keys, tally, concurrency());

  const summary = summarizeDryRun(tally, {
    startedAt,
    finishedAt: new Date().toISOString(),
  });
  const markdown = renderDryRunMarkdown(summary);
  await mkdir(outputDir, { recursive: true });
  await writeFile(
    join(outputDir, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  await writeFile(join(outputDir, "summary.md"), markdown);
  const stepSummary = optionalInput("GITHUB_STEP_SUMMARY");
  if (stepSummary) {
    await appendFile(stepSummary, markdown);
  }
  process.stdout.write(markdown);
  if (summary.failed > 0 || summary.downloadFailed > 0) {
    process.exitCode = 1;
  }
}

await main();
