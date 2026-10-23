import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Client } from "pg";
import { create } from "tar";
import { z } from "zod";
import {
  workflowAttachmentHash,
  verifyWorkflowAttachmentBundle,
} from "@okouai/core/workflow-attachment-bundle";
import { workflowAttachmentsSchema } from "@okouai/api-contracts/contracts/workflow-attachments";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A disposable DATABASE_URL is required");
const addressUrl = new URL(databaseUrl);
const isLocal = ["localhost", "127.0.0.1"].includes(addressUrl.hostname);
const isOwnedCiDatabase =
  addressUrl.hostname === "postgres" &&
  addressUrl.pathname === "/migration_test_existing";
if (!isLocal && !isOwnedCiDatabase) {
  throw new Error(
    "A disposable local or migration-consistency DATABASE_URL is required",
  );
}
const db = new Client({ connectionString: databaseUrl });
await db.connect();
const root = await mkdtemp(join(tmpdir(), "workflow-backfill-test-"));
const objects = new Map<string, Buffer>();
async function handleObjectRequest(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const key = decodeURIComponent(
    (request.url ?? "").split("?")[0] ?? "",
  ).replace(/^\/test\//u, "");
  if (request.method === "PUT") {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    objects.set(key, Buffer.concat(chunks));
    response.end();
    return;
  }
  const object = objects.get(key);
  if (!object) {
    response.writeHead(404);
    response.end();
    return;
  }
  response.writeHead(200, { "content-length": object.length });
  response.end(object);
}
const server = createServer((request, response) => {
  void handleObjectRequest(request, response).catch((error: unknown) => {
    response.destroy(
      error instanceof Error ? error : new Error("Fixture request failed"),
    );
  });
});
await new Promise<void>((resolve) => {
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
if (address === null || typeof address === "string")
  throw new Error("Expected local object-store address");
const agentId = randomUUID(),
  workflowId = randomUUID(),
  storageId = randomUUID();
const orgId = `org_${randomUUID()}`;
const versionId = workflowAttachmentHash(storageId);
const s3Key = `legacy/${storageId}/${versionId}`;
const instruction = "\ufeff  authoritative database body\n\n";
const credential = join(root, "database-url");
await writeFile(credential, databaseUrl, { mode: 0o600 });
const run = async (...args: string[]) => {
  const result = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/migrations/024-workflow-attachments/backfill.ts",
      "--workflow-id",
      workflowId,
      ...args,
    ],
    {
      cwd: process.cwd(),
      env: {
        ...process.env,
        TZ: "Asia/Shanghai",
        DATABASE_URL_FILE: credential,
        R2_ENDPOINT: `http://127.0.0.1:${address.port}`,
        R2_USER_STORAGES_BUCKET_NAME: "test",
        R2_ACCESS_KEY_ID: "local",
        R2_SECRET_ACCESS_KEY: "local",
      },
    },
  );
  return result.stdout
    .trim()
    .split("\n")
    .map((line) => {
      return JSON.parse(line) as unknown;
    });
};
try {
  await db.query(
    "INSERT INTO agents (id, org_id, owner, name) VALUES ($1, $2, 'owner', 'attachment-test')",
    [agentId, orgId],
  );
  // Outgoing inserts remain legal after the additive migration; NULL is unconverted.
  await db.query(
    "INSERT INTO workflows (id, org_id, agent_id, owner_user_id, name, instruction, created_by, updated_by) VALUES ($1,$2,$3,'owner','attachment-test',$4,'owner','owner')",
    [workflowId, orgId, agentId, instruction],
  );
  await assert.rejects(run(), (error: unknown) => {
    const failed = z
      .object({ code: z.literal(2), stdout: z.string() })
      .safeParse(error);
    if (!failed.success) return false;
    const receipt = z
      .object({
        ready: z.literal(0),
        blocked: z.array(
          z.object({ workflowId: z.string(), classification: z.string() }),
        ),
      })
      .parse(JSON.parse(failed.data.stdout));
    return receipt.blocked.some((row) => {
      return (
        row.workflowId === workflowId &&
        row.classification === "SourceUnavailable"
      );
    });
  });
  await mkdir(join(root, "legacy/references"), { recursive: true });
  await writeFile(join(root, "legacy/SKILL.md"), "old generated document");
  await writeFile(join(root, "legacy/references/keep.md"), "  附件\n\n");
  await create(
    {
      cwd: join(root, "legacy"),
      file: join(root, "archive.tar.gz"),
      gzip: true,
    },
    ["SKILL.md", "references/keep.md"],
  );
  const archive = await readFile(join(root, "archive.tar.gz"));
  objects.set(`${s3Key}/archive.tar.gz`, archive);
  objects.set(
    `${s3Key}/manifest.json`,
    Buffer.from(
      JSON.stringify({
        version: versionId,
        files: [
          {
            path: "SKILL.md",
            hash: workflowAttachmentHash("old generated document"),
            size: Buffer.byteLength("old generated document"),
          },
          {
            path: "references/keep.md",
            hash: workflowAttachmentHash("  附件\n\n"),
            size: Buffer.byteLength("  附件\n\n"),
          },
        ],
      }),
    ),
  );
  await db.query(
    "INSERT INTO storages (id,org_id,user_id,name,s3_prefix) VALUES ($1,$2,'__org__',$3,$4)",
    [storageId, orgId, `custom-skill@${workflowId}`, `legacy/${storageId}`],
  );
  await db.query(
    "INSERT INTO storage_versions (id,storage_id,s3_key,archive_size,created_by) VALUES ($1,$2,$3,$4,'owner')",
    [versionId, storageId, s3Key, archive.length],
  );
  await db.query("UPDATE storages SET head_version_id=$2 WHERE id=$1", [
    storageId,
    versionId,
  ]);
  const planFile = join(root, "plan.json");
  const preview = await run("--output", planFile);
  assert.equal(
    JSON.parse(await readFile(planFile, "utf8")).rows.length,
    1,
    JSON.stringify(preview),
  );
  assert.equal(
    (
      await db.query("SELECT attachments FROM workflows WHERE id=$1", [
        workflowId,
      ])
    ).rows[0].attachments,
    null,
  );
  assert.equal(objects.size, 2, "dry-run performs no uploads");
  const currentInstruction = instruction + "user edit before apply\n";
  await db.query("UPDATE workflows SET instruction=$2 WHERE id=$1", [
    workflowId,
    currentInstruction,
  ]);
  const stale = await run(
    "--migrate",
    "--writers-drained",
    "--plan-file",
    planFile,
    "--expect-plan-sha256",
    workflowAttachmentHash(await readFile(planFile)),
  );
  assert.ok(
    stale.some((row) => {
      return z.object({ result: z.literal("skipped-changed") }).safeParse(row)
        .success;
    }),
  );
  const untouched = (
    await db.query(
      "SELECT instruction,attachments FROM workflows WHERE id=$1",
      [workflowId],
    )
  ).rows[0];
  assert.equal(untouched.instruction, currentInstruction);
  assert.equal(untouched.attachments, null);
  const currentPlanFile = join(root, "current-plan.json");
  await run("--output", currentPlanFile);
  const applied = await run(
    "--migrate",
    "--writers-drained",
    "--plan-file",
    currentPlanFile,
    "--expect-plan-sha256",
    workflowAttachmentHash(await readFile(currentPlanFile)),
  );
  assert.equal(
    (
      await db.query(
        "SELECT attachments IS NOT NULL AS converted FROM workflows WHERE id=$1",
        [workflowId],
      )
    ).rows[0].converted,
    true,
    JSON.stringify(applied),
  );
  const row = (
    await db.query(
      "SELECT instruction,attachments FROM workflows WHERE id=$1",
      [workflowId],
    )
  ).rows[0];
  assert.equal(row.instruction, currentInstruction);
  const descriptor = workflowAttachmentsSchema.parse(row.attachments);
  assert.equal(descriptor.kind, "bundle");
  if (descriptor.kind !== "bundle")
    throw new Error("Expected converted attachments");
  const newArchive = objects.get(descriptor.objectKey);
  assert.ok(newArchive);
  assert.equal(
    verifyWorkflowAttachmentBundle(
      newArchive,
      descriptor,
    )[0]?.content.toString(),
    "  附件\n\n",
  );
  assert.ok(
    objects.has(`${s3Key}/archive.tar.gz`),
    "legacy source is preserved",
  );
  await run("--audit");
  await db.query("UPDATE workflows SET instruction='user edit' WHERE id=$1", [
    workflowId,
  ]);
  await run(
    "--migrate",
    "--writers-drained",
    "--plan-file",
    planFile,
    "--expect-plan-sha256",
    workflowAttachmentHash(await readFile(planFile)),
  );
  const preserved = (
    await db.query(
      "SELECT instruction,attachments FROM workflows WHERE id=$1",
      [workflowId],
    )
  ).rows[0];
  assert.equal(preserved.instruction, "user edit");
  assert.deepEqual(preserved.attachments, descriptor);
  // Model an outgoing old API that replaced legacy files after the new API
  // already published a descriptor. NULL-only conversion cannot repair this.
  const latestContent = "latest outgoing API attachment\n";
  await writeFile(join(root, "legacy/references/keep.md"), latestContent);
  await create(
    {
      cwd: join(root, "legacy"),
      file: join(root, "outgoing.tar.gz"),
      gzip: true,
    },
    ["SKILL.md", "references/keep.md"],
  );
  const outgoingArchive = await readFile(join(root, "outgoing.tar.gz"));
  const outgoingVersion = workflowAttachmentHash(`outgoing:${storageId}`);
  const outgoingKey = `legacy/${storageId}/${outgoingVersion}`;
  objects.set(`${outgoingKey}/archive.tar.gz`, outgoingArchive);
  objects.set(
    `${outgoingKey}/manifest.json`,
    Buffer.from(
      JSON.stringify({
        version: outgoingVersion,
        files: [
          {
            path: "SKILL.md",
            hash: workflowAttachmentHash("old generated document"),
            size: Buffer.byteLength("old generated document"),
          },
          {
            path: "references/keep.md",
            hash: workflowAttachmentHash(latestContent),
            size: Buffer.byteLength(latestContent),
          },
        ],
      }),
    ),
  );
  await db.query(
    "INSERT INTO storage_versions (id,storage_id,s3_key,archive_size,created_by) VALUES ($1,$2,$3,$4,'owner')",
    [outgoingVersion, storageId, outgoingKey, outgoingArchive.length],
  );
  await db.query("UPDATE storages SET head_version_id=$2 WHERE id=$1", [
    storageId,
    outgoingVersion,
  ]);
  await assert.rejects(run("--audit"), (error: unknown) => {
    const failed = z
      .object({ code: z.literal(2), stdout: z.string() })
      .safeParse(error);
    if (!failed.success) return false;
    const receipt = z
      .object({
        verified: z.literal(0),
        attention: z.array(
          z.object({ workflowId: z.string(), classification: z.string() }),
        ),
      })
      .parse(JSON.parse(failed.data.stdout));
    return receipt.attention.some((row) => {
      return (
        row.workflowId === workflowId && row.classification === "SourceChanged"
      );
    });
  });
  const overlapPlan = join(root, "overlap-plan.json");
  await run("--output", overlapPlan);
  const overlapArgs = [
    "--migrate",
    "--writers-drained",
    "--plan-file",
    overlapPlan,
    "--expect-plan-sha256",
    workflowAttachmentHash(await readFile(overlapPlan)),
  ];
  await run(...overlapArgs);
  const repaired = (
    await db.query(
      "SELECT instruction,attachments FROM workflows WHERE id=$1",
      [workflowId],
    )
  ).rows[0];
  assert.equal(repaired.instruction, "user edit");
  const repairedDescriptor = workflowAttachmentsSchema.parse(
    repaired.attachments,
  );
  if (repairedDescriptor.kind !== "bundle")
    throw new Error("Expected a reconciled package");
  assert.notEqual(repairedDescriptor.objectKey, descriptor.objectKey);
  const repairedArchive = objects.get(repairedDescriptor.objectKey);
  assert.ok(repairedArchive);
  assert.equal(
    verifyWorkflowAttachmentBundle(
      repairedArchive,
      repairedDescriptor,
    )[0]?.content.toString(),
    latestContent,
  );
  // A second invocation of the reviewed plan must not replace the descriptor
  // adopted by the first invocation, even when body/timestamp/HEAD are equal.
  const repeat = await run(...overlapArgs);
  assert.ok(
    repeat.some((row) => {
      return z.object({ result: z.literal("skipped-changed") }).safeParse(row)
        .success;
    }),
  );
  assert.deepEqual(
    (
      await db.query("SELECT attachments FROM workflows WHERE id=$1", [
        workflowId,
      ])
    ).rows[0].attachments,
    repairedDescriptor,
  );
  await run("--audit");
  const currentPlan = join(root, "verified-plan.json");
  const current = await run("--output", currentPlan);
  assert.ok(
    current.some((row) => {
      return z
        .object({ ready: z.literal(0), alreadyCurrent: z.literal(1) })
        .safeParse(row).success;
    }),
  );
  assert.equal(
    JSON.parse(await readFile(currentPlan, "utf8")).baseline.length,
    1,
  );
  // The published encoder emits the same final file again for duplicate raw
  // paths. A full audit must preserve that supported filesystem semantics.
  await create(
    {
      cwd: join(root, "legacy"),
      file: join(root, "duplicate.tar.gz"),
      gzip: true,
    },
    ["SKILL.md", "references/keep.md", "references/keep.md"],
  );
  const duplicateArchive = await readFile(join(root, "duplicate.tar.gz"));
  const duplicateVersion = workflowAttachmentHash(`duplicate:${storageId}`);
  const duplicateKey = `legacy/${storageId}/${duplicateVersion}`;
  const duplicateFile = {
    path: "references/keep.md",
    hash: workflowAttachmentHash(latestContent),
    size: Buffer.byteLength(latestContent),
  };
  objects.set(`${duplicateKey}/archive.tar.gz`, duplicateArchive);
  objects.set(
    `${duplicateKey}/manifest.json`,
    Buffer.from(
      JSON.stringify({
        version: duplicateVersion,
        files: [
          {
            path: "SKILL.md",
            hash: workflowAttachmentHash("old generated document"),
            size: Buffer.byteLength("old generated document"),
          },
          duplicateFile,
          duplicateFile,
        ],
      }),
    ),
  );
  await db.query(
    "INSERT INTO storage_versions (id,storage_id,s3_key,archive_size,created_by) VALUES ($1,$2,$3,$4,'owner')",
    [duplicateVersion, storageId, duplicateKey, duplicateArchive.length],
  );
  await db.query("UPDATE storages SET head_version_id=$2 WHERE id=$1", [
    storageId,
    duplicateVersion,
  ]);
  await run("--audit");
  const duplicates = await run();
  assert.ok(
    duplicates.some((row) => {
      return z
        .object({ ready: z.literal(0), alreadyCurrent: z.literal(1) })
        .safeParse(row).success;
    }),
  );
  console.log(
    "Workflow attachment operator: dry-run, apply, archive audit, instruction preservation, overlap reconciliation, canonical legacy duplicates and stale-plan protection passed",
  );
} finally {
  await db.query("DELETE FROM agents WHERE id=$1", [agentId]);
  await db.query("DELETE FROM storages WHERE id=$1", [storageId]);
  await db.end();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      return error ? reject(error) : resolve();
    });
  });
  await rm(root, { recursive: true, force: true });
}
