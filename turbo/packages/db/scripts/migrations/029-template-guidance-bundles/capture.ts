import {
  createCipheriv,
  createPublicKey,
  publicEncrypt,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import { c } from "tar";
import { S3Client } from "@aws-sdk/client-s3";
import { contentBundleDigest } from "@okouai/core/content-bundle";
import type { TemplateGuidanceBundle } from "@okouai/api-contracts/contracts/template-guidance-bundle";
import {
  BackfillError,
  inventorySchema,
  objectConfiguration,
  validateSources,
  type Source,
} from "./plan";
import { prepareSource } from "./archives";

async function main() {
  const { values } = parseArgs({
    options: {
      inventory: { type: "string" },
      "public-key": { type: "string" },
      output: { type: "string" },
      commit: { type: "string" },
    },
  });
  if (!values.inventory || !values["public-key"] || !values.output)
    throw new BackfillError("CaptureArgumentsRequired");
  if (values.commit && !/^[a-f0-9]{40}$/u.test(values.commit))
    throw new BackfillError("InvalidCaptureCommit");
  const input = await readFile(values.inventory);
  const inventory = inventorySchema.parse(JSON.parse(input.toString("utf8")));
  validateSources(inventory.rows);
  if (
    inventory.rows.reduce((n, s) => {
      return n + s.package.archiveBytes;
    }, 0) >
    512 * 1024 * 1024
  )
    throw new BackfillError("CaptureBatchTooLarge");
  const recipient = createPublicKey(await readFile(values["public-key"]));
  if (
    recipient.asymmetricKeyType !== "rsa" ||
    (recipient.asymmetricKeyDetails?.modulusLength ?? 0) < 2048
  )
    throw new BackfillError("RsaRecipientRequired");
  const config = objectConfiguration();
  if (
    inventory.scope.bucket !== config.bucket ||
    inventory.scope.endpoint !== config.endpoint.origin
  )
    throw new BackfillError("CaptureScopeMismatch");
  await mkdir(values.output, { mode: 0o700 });
  const privateDirectory = await mkdtemp(
    join(tmpdir(), "template-guidance-capture-"),
  );
  const client = new S3Client({
    endpoint: config.endpoint.toString(),
    region: "auto",
    credentials: config.credentials,
    maxAttempts: 1,
  });
  const rows: {
    source: Source;
    archiveSha256: string;
    manifestSha256: string;
    bundle: TemplateGuidanceBundle;
  }[] = [];
  const failures: { templateId: string; classification: string }[] = [];
  const paths: string[] = [];
  try {
    for (const source of inventory.rows) {
      try {
        const prepared = await prepareSource(client, config.bucket, source);
        const relative = `${source.ownerKind}/${source.templateId}`;
        const directory = join(privateDirectory, relative);
        await mkdir(directory, { recursive: true, mode: 0o700 });
        for (const [name, bytes] of [
          ["archive.tar.gz", prepared.legacyArchive],
          ["manifest.json", prepared.legacyManifest],
        ] as const) {
          await writeFile(join(directory, name), bytes, {
            flag: "wx",
            mode: 0o600,
          });
          paths.push(`${relative}/${name}`);
        }
        rows.push({
          source,
          archiveSha256: prepared.archiveSha256,
          manifestSha256: prepared.manifestSha256,
          bundle: prepared.descriptor,
        });
      } catch (error) {
        failures.push({
          templateId: source.templateId,
          classification:
            error instanceof BackfillError
              ? error.message
              : error instanceof Error
                ? error.name
                : "UnknownCaptureFailure",
        });
      }
    }
    const complete = failures.length === 0;
    const report = {
      format: "template-guidance-capture-v1",
      capturedAt: new Date().toISOString(),
      inventorySha256: contentBundleDigest(input),
      scope: inventory.scope,
      commit: values.commit ?? null,
      complete,
      rows,
      failures,
    };
    if (!complete) {
      await writeFile(
        join(values.output, "report.json"),
        JSON.stringify(report, null, 2) + "\n",
        { flag: "wx", mode: 0o600 },
      );
      process.exitCode = 1;
      return;
    }
    const archive = join(privateDirectory, "capture.tar");
    await c({ cwd: privateDirectory, file: archive, portable: true }, paths);
    const key = randomBytes(32),
      iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", key, iv, {
      authTagLength: 16,
    });
    await pipeline(
      createReadStream(archive),
      cipher,
      createWriteStream(join(values.output, "payload.enc"), {
        flags: "wx",
        mode: 0o600,
      }),
    );
    const envelope = {
      format: "template-guidance-capture-aes256gcm-rsaoaep256-v1",
      recipientSha256: contentBundleDigest(
        recipient.export({ type: "spki", format: "der" }),
      ),
      wrappedKey: publicEncrypt(
        { key: recipient, oaepHash: "sha256" },
        key,
      ).toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
    };
    key.fill(0);
    await writeFile(
      join(values.output, "envelope.json"),
      JSON.stringify(envelope) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(values.output, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    process.stdout.write(
      JSON.stringify({
        complete: true,
        verified: rows.length,
        encrypted: true,
      }) + "\n",
    );
  } finally {
    client.destroy();
    await rm(privateDirectory, { recursive: true, force: true });
  }
}
try {
  await main();
} catch (error) {
  process.stderr.write(
    (error instanceof BackfillError ? error.message : "TemplateCaptureFailed") +
      "\n",
  );
  process.exitCode = 1;
}
