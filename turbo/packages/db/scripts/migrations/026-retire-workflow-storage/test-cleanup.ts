import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  createConnection,
  createServer as createTcpServer,
  type Socket,
} from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearTimeout, setTimeout } from "node:timers";
import { promisify } from "node:util";
import { Client } from "pg";
import {
  array,
  number,
  object,
  record,
  string,
  unknown as zUnknown,
} from "zod";
import { planSchema, type Plan } from "./schema";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("A disposable DATABASE_URL is required");
const databaseAddress = new URL(databaseUrl);
if (
  databaseAddress.searchParams.has("host") ||
  databaseAddress.searchParams.has("port") ||
  databaseAddress.searchParams.getAll("options").length > 1
)
  throw new Error(
    "A canonical disposable database URL without endpoint query overrides is required",
  );
if (
  !["localhost", "127.0.0.1"].includes(databaseAddress.hostname) &&
  !(
    databaseAddress.hostname === "postgres" &&
    databaseAddress.pathname === "/migration_test_existing"
  )
)
  throw new Error(
    "A disposable local or migration-consistency database is required",
  );

const db = new Client({ connectionString: databaseUrl });
const root = await mkdtemp(join(tmpdir(), "workflow-retirement-test-"));
const credential = join(root, "database-url");
const orgId = `retirement-${randomUUID()}`;
const agentId = randomUUID();
const runnerId = randomUUID();
const runId = randomUUID();
const objects = new Set<string>();
let listCount = 0;
let deleteCount = 0;
let beforeList: (() => Promise<void>) | undefined;
let deleteFailure: "partial" | "lost-reply" | undefined;

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://fixture.test");
  assert.equal(url.pathname, "/test/");
  if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
    listCount++;
    const callback = beforeList;
    beforeList = undefined;
    await callback?.();
    const prefix = url.searchParams.get("prefix") ?? "";
    assert.notEqual(prefix, "");
    const limit = Number(url.searchParams.get("max-keys"));
    assert.equal(limit, 1000);
    const keys = [...objects]
      .filter((key) => {
        return key.startsWith(prefix);
      })
      .sort();
    const page = keys.slice(0, limit);
    // This fixture generates UUIDs and fixed path segments, not arbitrary XML text.
    for (const key of page) assert.doesNotMatch(key, /[<>&]/u);
    response.writeHead(200, { "content-type": "application/xml" });
    response.end(
      `<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><IsTruncated>${keys.length > limit}</IsTruncated><KeyCount>${page.length}</KeyCount>${page
        .map((key) => {
          return `<Contents><Key>${key}</Key><Size>1</Size></Contents>`;
        })
        .join("")}</ListBucketResult>`,
    );
    return;
  }
  assert.equal(request.method, "POST");
  assert.equal(url.searchParams.has("delete"), true);
  deleteCount++;
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  const keys = [
    ...Buffer.concat(chunks)
      .toString()
      .matchAll(/<Key>([^<]+)<\/Key>/gu),
  ].map((match) => {
    return string().parse(match[1]);
  });
  assert.ok(keys.length > 0 && keys.length <= 1000);
  const failure = deleteFailure;
  deleteFailure = undefined;
  for (const key of failure === "partial" ? keys.slice(1) : keys)
    objects.delete(key);
  if (failure === "lost-reply") {
    response.destroy();
    return;
  }
  response.writeHead(200, { "content-type": "application/xml" });
  response.end(
    `<DeleteResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${failure === "partial" ? `<Error><Key>${string().parse(keys[0])}</Key><Code>AccessDenied</Code></Error>` : ""}</DeleteResult>`,
  );
}
const server = createServer((request, response) => {
  void handle(request, response).catch((error: unknown) => {
    return response.destroy(
      error instanceof Error ? error : new Error("Fixture failed"),
    );
  });
});
const summarySchema = record(string(), zUnknown());
type Review = { path: string; sha: string; plan: Plan };
const digest = (value: string) => {
  return createHash("sha256").update(value).digest("hex");
};
let sequence = 0;

try {
  await db.connect();
  await db.query("SET TIME ZONE 'UTC'");
  await writeFile(credential, databaseUrl, { mode: 0o600 });
  await new Promise<void>((resolve) => {
    return server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("Expected local S3 address");
  const environment = {
    ...process.env,
    DATABASE_URL_FILE: credential,
    R2_ENDPOINT: `http://127.0.0.1:${address.port}`,
    R2_USER_STORAGES_BUCKET_NAME: "test",
    R2_ACCESS_KEY_ID: "local",
    R2_SECRET_ACCESS_KEY: "local",
  };
  async function invoke(
    args: string[],
    code = 0,
    overrides: NodeJS.ProcessEnv = {},
  ) {
    const output = join(root, `${++sequence}.json`);
    let stdout: string;
    let classification: string | undefined;
    try {
      const result = await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "scripts/migrations/026-retire-workflow-storage/cleanup.ts",
          "--output",
          output,
          ...args,
        ],
        { env: { ...environment, ...overrides }, maxBuffer: 4 * 1024 * 1024 },
      );
      assert.equal(
        code,
        0,
        `Expected exit ${code}, got success: ${result.stdout}`,
      );
      stdout = result.stdout;
    } catch (error) {
      const failure = object({
        code: number(),
        stdout: string(),
        stderr: string(),
      }).safeParse(error);
      if (!failure.success) throw error;
      assert.equal(
        failure.data.code,
        code,
        `${failure.data.stderr}\n${failure.data.stdout}`,
      );
      if (code === 1) {
        const rejected = object({
          status: string(),
          classification: string(),
        }).parse(JSON.parse(failure.data.stderr.trim()));
        assert.equal(rejected.status, "failed");
        classification = rejected.classification;
      }
      stdout = failure.data.stdout;
    }
    const records =
      stdout.trim() === ""
        ? []
        : stdout
            .trim()
            .split("\n")
            .map((line) => {
              return summarySchema.parse(JSON.parse(line));
            });
    return { output, records, last: records.at(-1), classification };
  }
  async function review(id: string, code = 0): Promise<Review> {
    const result = await invoke(["--storage-id", id], code);
    const bytes = await readFile(result.output, "utf8");
    assert.equal((await stat(result.output)).mode & 0o777, 0o600);
    const plan = planSchema.parse(JSON.parse(bytes));
    assert.equal(result.last?.planSha256, digest(bytes));
    return { path: result.output, sha: digest(bytes), plan };
  }
  async function rewrite(reviewed: Review): Promise<Review> {
    const path = join(root, `changed-${++sequence}.json`);
    const bytes = `${JSON.stringify(reviewed.plan)}\n`;
    await writeFile(path, bytes, { mode: 0o600 });
    return { path, sha: digest(bytes), plan: reviewed.plan };
  }
  const reviewedArgs = (value: Review) => {
    return ["--plan-file", value.path, "--expect-plan-sha256", value.sha];
  };
  const apply = (value: Review, code = 0) => {
    return invoke(
      ["--migrate", "--ack-consumer-retirement", ...reviewedArgs(value)],
      code,
    );
  };
  const processJobs = (value: Review, code = 0, pages = "8") => {
    return invoke(
      [
        "--process-jobs",
        "--ack-consumer-retirement",
        ...reviewedArgs(value),
        "--max-pages",
        pages,
      ],
      code,
    );
  };
  const audit = (value: Review, code = 0) => {
    return invoke(["--audit", ...reviewedArgs(value)], code);
  };
  const scalar = async (text: string, values: readonly string[]) => {
    return number().parse((await db.query(text, [...values])).rows[0]?.count);
  };
  const storageCount = (id: string) => {
    return scalar("SELECT count(*)::int AS count FROM storages WHERE id=$1", [
      id,
    ]);
  };
  const versionCount = (id: string) => {
    return scalar(
      "SELECT count(*)::int AS count FROM storage_versions WHERE storage_id=$1",
      [id],
    );
  };
  const jobs = async (id: string) => {
    return array(
      object({ id: string(), status: string(), failure_count: number() }),
    ).parse(
      (
        await db.query(
          "SELECT id,status,failure_count FROM background_jobs WHERE org_id=$1 AND input->>'storageId'=$2 ORDER BY id",
          [orgId, id],
        )
      ).rows,
    );
  };
  await db.query(
    "INSERT INTO agents(id,org_id,owner,name,visibility) VALUES($1,$2,'owner','retirement-test','private')",
    [agentId, orgId],
  );

  async function seed(historical = false, user = "__org__", name?: string) {
    const id = randomUUID(),
      workflowId = randomUUID();
    const storageName = name ?? `custom-skill@${workflowId}`;
    const prefix = name?.startsWith("custom-skill@")
      ? `${orgId}/volume/${storageName}`
      : `${orgId}/${id}`;
    const version = digest(id);
    const directory = historical
      ? `renamed-org/volume/${storageName}/${version}`
      : `${prefix}/${version}`;
    await db.query(
      "INSERT INTO workflows(id,org_id,agent_id,owner_user_id,name,instruction,attachments,created_by,updated_by) VALUES($1::uuid,$2,$3,'owner',$1::text,$4,'{\"kind\":\"empty\"}','owner','owner')",
      [workflowId, orgId, agentId, "\ufeff  database body\n\n"],
    );
    await db.query(
      "INSERT INTO storages(id,org_id,user_id,name,s3_prefix) VALUES($1,$2,$3,$4,$5)",
      [id, orgId, user, storageName, prefix],
    );
    await db.query(
      "INSERT INTO storage_versions(id,storage_id,s3_key,archive_size,created_by) VALUES($1,$2,$3,1,'owner')",
      [version, id, directory],
    );
    await db.query("UPDATE storages SET head_version_id=$2 WHERE id=$1", [
      id,
      version,
    ]);
    objects.add(`${directory}/archive.tar.gz`);
    objects.add(`${directory}/manifest.json`);
    return { id, workflowId, prefix, version, directory };
  }

  // Delay a large response on the wire, after PostgreSQL has produced it. This
  // exceeds the old 12-second client deadline without extending SQL execution.
  const slowSource = await seed();
  await db.query(
    `INSERT INTO workflows(org_id,agent_id,owner_user_id,name,instruction,attachments,created_by,updated_by)
      SELECT $1,$2,'owner','receive-fixture-'||n,'fixture body','{"kind":"empty"}'::jsonb,'owner','owner'
      FROM generate_series(1,80) AS item(n)`,
    [orgId, agentId],
  );
  const sockets = new Set<Socket>();
  const receiveTimers = new Set<NodeJS.Timeout>();
  let delayedInventory = false;
  const slowProxy = createTcpServer((downstream) => {
    const upstream = createConnection({ host: db.host, port: db.port });
    sockets.add(downstream);
    sockets.add(upstream);
    downstream.on("error", () => {
      upstream.destroy();
    });
    upstream.on("error", () => {
      downstream.destroy();
    });
    downstream.on("close", () => {
      sockets.delete(downstream);
      upstream.destroy();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      downstream.destroy();
    });
    upstream.on("end", () => {
      downstream.end();
    });
    downstream.pipe(upstream);
    let received = 0;
    upstream.on("data", (chunk: Buffer) => {
      received += chunk.length;
      if (!delayedInventory && received > 16 * 1024) {
        delayedInventory = true;
        upstream.pause();
        const timer: NodeJS.Timeout = setTimeout(() => {
          receiveTimers.delete(timer);
          downstream.write(chunk);
          upstream.resume();
        }, 13000);
        receiveTimers.add(timer);
      } else downstream.write(chunk);
    });
  });
  try {
    await new Promise<void>((resolve) => {
      return slowProxy.listen(0, "127.0.0.1", resolve);
    });
    const proxyAddress = slowProxy.address();
    assert.ok(proxyAddress && typeof proxyAddress !== "string");
    const proxyUrl = new URL(databaseUrl);
    proxyUrl.hostname = "127.0.0.1";
    proxyUrl.port = String(proxyAddress.port);
    const proxyCredential = join(root, "slow-database-url");
    await writeFile(proxyCredential, proxyUrl.href, { mode: 0o600 });
    const result = await invoke(["--storage-id", slowSource.id], 0, {
      DATABASE_URL_FILE: proxyCredential,
    });
    const plan = planSchema.parse(
      JSON.parse(await readFile(result.output, "utf8")),
    );
    assert.equal(delayedInventory, true);
    assert.equal(result.last?.status, "review_ready");
    assert.deepEqual(
      plan.ready.map((row) => {
        return row.source.id;
      }),
      [slowSource.id],
    );
    assert.ok(plan.workflows.length >= 81);
  } finally {
    for (const timer of receiveTimers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (slowProxy.listening)
      await new Promise<void>((resolve, reject) => {
        return slowProxy.close((error) => {
          return error ? reject(error) : resolve();
        });
      });
    await db.query(
      "DELETE FROM workflows WHERE org_id=$1 AND agent_id=$2 AND starts_with(name,'receive-fixture-')",
      [orgId, agentId],
    );
  }

  // An exact reviewed manifest is the boundary; unrelated Storage and new attachments survive.
  const main = await seed(true);
  const userOwned = await seed(false, "owner");
  const memory = await seed(false, "__org__", "memory");
  const sibling = `${main.prefix}-other/archive.tar.gz`;
  const newAttachment = `workflow-attachments/${orgId}/${main.workflowId}/${randomUUID()}/archive.tar.gz`;
  objects.add(sibling);
  objects.add(newAttachment);
  const reviewed = await review(main.id);
  for (const [key, value] of [
    ["host", databaseAddress.hostname],
    ["port", String(db.port)],
  ] as const) {
    const overridden = new URL(databaseUrl);
    overridden.searchParams.set(key, value);
    const file = join(root, `override-${key}`);
    await writeFile(file, overridden.href, { mode: 0o600 });
    const rejected = await invoke(
      ["--migrate", "--ack-consumer-retirement", ...reviewedArgs(reviewed)],
      1,
      { DATABASE_URL_FILE: file },
    );
    assert.equal(rejected.classification, "ExplicitDatabaseEndpointRequired");
  }
  const duplicateOptions = new URL(databaseUrl);
  duplicateOptions.searchParams.append("options", "-c application_name=first");
  duplicateOptions.searchParams.append("options", "-c application_name=second");
  const duplicateFile = join(root, "duplicate-options");
  await writeFile(duplicateFile, duplicateOptions.href, { mode: 0o600 });
  assert.equal(
    (
      await invoke(["--storage-id", main.id], 1, {
        DATABASE_URL_FILE: duplicateFile,
      })
    ).classification,
    "ExplicitDatabaseEndpointRequired",
  );
  const unportedAddress = new URL(databaseUrl);
  unportedAddress.port = "";
  const unportedFile = join(root, "unported-database-url");
  await writeFile(unportedFile, unportedAddress.href, { mode: 0o600 });
  await invoke(["--audit", ...reviewedArgs(reviewed)], 2, {
    DATABASE_URL_FILE: unportedFile,
    PGPORT: String(db.port),
  });
  const changedPort = await invoke(
    ["--migrate", "--ack-consumer-retirement", ...reviewedArgs(reviewed)],
    1,
    {
      DATABASE_URL_FILE: unportedFile,
      PGPORT: String(db.port === 6543 ? 6544 : 6543),
    },
  );
  assert.equal(
    changedPort.classification,
    "ReviewedDatabaseOrR2AccountMismatch",
  );
  const optionsAddress = new URL(databaseUrl);
  optionsAddress.searchParams.delete("options");
  const optionsFile = join(root, "environment-options-database-url");
  await writeFile(optionsFile, optionsAddress.href, { mode: 0o600 });
  const optionsReview = await invoke(["--storage-id", main.id], 0, {
    DATABASE_URL_FILE: optionsFile,
  });
  const changedOptions = await invoke(
    [
      "--migrate",
      "--ack-consumer-retirement",
      "--plan-file",
      optionsReview.output,
      "--expect-plan-sha256",
      string().parse(optionsReview.last?.planSha256),
    ],
    1,
    {
      DATABASE_URL_FILE: optionsFile,
      PGOPTIONS: `-c application_name=retirement_${randomUUID()}`,
    },
  );
  assert.equal(
    changedOptions.classification,
    "ReviewedDatabaseOrR2AccountMismatch",
  );
  const scopedCredential = join(root, "scoped-database-url");
  const scopedAddress = new URL(databaseUrl);
  scopedAddress.searchParams.set("options", "-c search_path=pg_catalog");
  await writeFile(scopedCredential, scopedAddress.href, { mode: 0o600 });
  const scopedReview = await invoke(["--storage-id", main.id], 0, {
    DATABASE_URL_FILE: scopedCredential,
  });
  assert.equal(scopedReview.last?.ready, 1);
  assert.equal(listCount, 0);
  assert.equal(deleteCount, 0);
  assert.equal(await storageCount(main.id), 1);
  assert.equal((await jobs(main.id)).length, 0);
  assert.deepEqual(
    reviewed.plan.ready[0]?.jobs
      .map((job) => {
        return job.prefix;
      })
      .sort(),
    [main.prefix, main.directory].sort(),
  );
  assert.equal(JSON.stringify(reviewed.plan).includes("database body"), false);
  assert.equal((await review(userOwned.id)).plan.ready.length, 0);
  assert.equal((await review(memory.id)).plan.ready.length, 0);
  await invoke(["--migrate", ...reviewedArgs(reviewed)], 1);
  await invoke(
    [
      "--migrate",
      "--ack-consumer-retirement",
      "--plan-file",
      reviewed.path,
      "--expect-plan-sha256",
      "0".repeat(64),
    ],
    1,
  );
  await invoke(
    ["--migrate", "--ack-consumer-retirement", ...reviewedArgs(reviewed)],
    1,
    { R2_ENDPOINT: "http://127.0.0.1:1" },
  );
  await invoke(
    ["--migrate", "--ack-consumer-retirement", ...reviewedArgs(reviewed)],
    1,
    { R2_USER_STORAGES_BUCKET_NAME: "different" },
  );
  const wrongDatabase = structuredClone(reviewed);
  wrongDatabase.plan.databaseScope = "0".repeat(64);
  await apply(await rewrite(wrongDatabase), 1);
  const widened = structuredClone(reviewed);
  const widenedTarget = widened.plan.ready[0]?.jobs[0];
  assert.ok(widenedTarget);
  widenedTarget.prefix = orgId;
  await apply(await rewrite(widened), 1);
  assert.equal(await storageCount(main.id), 1);
  await apply(reviewed);
  assert.equal(await storageCount(main.id), 0);
  assert.equal(await versionCount(main.id), 0);
  assert.equal((await jobs(main.id)).length, 2);
  assert.equal((await apply(reviewed)).records[0]?.status, "already_retired");
  await audit(reviewed, 2);
  await processJobs(reviewed, 2, "1");
  assert.equal(
    (await jobs(main.id)).filter((job) => {
      return job.status === "completed";
    }).length,
    0,
  );
  await processJobs(reviewed);
  assert.equal((await audit(reviewed)).records[0]?.status, "verified");
  const calls = listCount;
  await processJobs(reviewed);
  assert.equal(listCount, calls);
  assert.equal(objects.has(sibling), true);
  assert.equal(objects.has(newAttachment), true);
  assert.equal(await storageCount(userOwned.id), 1);
  assert.equal(await storageCount(memory.id), 1);

  // Pre-UUID slugs can have zero, one or multiple current namesakes. None owns
  // the captured Storage by name; current UUID Storage and Workflows survive.
  for (const matches of [0, 1, 2]) {
    const slug = `legacy-${matches}-${randomUUID().slice(0, 8)}`;
    const legacySource = await seed(false, "__org__", `custom-skill@${slug}`);
    const canonicalIds: string[] = [];
    for (let index = 0; index < matches; index++) {
      const canonical = await seed();
      canonicalIds.push(canonical.id);
      await db.query(
        "UPDATE workflows SET name=$2,owner_user_id=$3 WHERE id=$1",
        [canonical.workflowId, slug, `owner-${index}`],
      );
    }
    const legacyPlan = await review(legacySource.id);
    assert.equal(legacyPlan.plan.ready.length, 1);
    assert.deepEqual(
      legacyPlan.plan.ready[0]?.jobs.map((job) => {
        return job.prefix;
      }),
      [legacySource.prefix],
    );
    const listsBefore: number = listCount;
    await apply(legacyPlan);
    assert.equal(listCount, listsBefore);
    assert.equal(await storageCount(legacySource.id), 0);
    assert.equal(await versionCount(legacySource.id), 0);
    await processJobs(legacyPlan);
    assert.equal(
      objects.has(`${legacySource.directory}/archive.tar.gz`),
      false,
    );
    const legacyAudit = await audit(legacyPlan);
    assert.equal(legacyAudit.records[0]?.status, "verified");
    assert.deepEqual(legacyAudit.last?.workflowChanges, []);
    for (const id of canonicalIds) {
      assert.equal(await storageCount(id), 1);
      assert.equal(await versionCount(id), 1);
    }
  }

  // Canonical UUID identities still require the actual Workflow organization.
  const foreignOwner = await seed();
  const foreignOwnerPlan = await review(foreignOwner.id);
  await db.query("UPDATE workflows SET org_id=$2 WHERE id=$1", [
    foreignOwner.workflowId,
    `${orgId}-other`,
  ]);
  assert.ok(
    (await review(foreignOwner.id, 2)).plan.blocked[0]?.reasons.includes(
      "workflow-owner",
    ),
  );
  await apply(foreignOwnerPlan, 2);
  assert.equal(await storageCount(foreignOwner.id), 1);
  await db.query("UPDATE workflows SET org_id=$2 WHERE id=$1", [
    foreignOwner.workflowId,
    orgId,
  ]);

  // A collision cannot remove the source without its complete durable job inventory.
  const collision = await seed();
  const collisionPlan = await review(collision.id);
  const collisionId = string().parse(collisionPlan.plan.ready[0]?.jobs[0]?.id);
  await db.query(
    "INSERT INTO background_jobs(id,kind,handler_version,user_id,org_id,input) VALUES($1,'workflow-storage-retirement',1,'__org__',$2,$3)",
    [
      collisionId,
      orgId,
      JSON.stringify({
        bucket: "test",
        storageId: collision.id,
        storageName: `custom-skill@${collision.workflowId}`,
        storagePrefix: collision.prefix,
        prefix: collision.prefix,
        versionIds: [collision.version],
      }),
    ],
  );
  await apply(collisionPlan, 1);
  assert.equal(await storageCount(collision.id), 1);
  assert.equal(await versionCount(collision.id), 1);
  assert.equal((await jobs(collision.id)).length, 1);
  await db.query("DELETE FROM background_jobs WHERE id=$1", [collisionId]);

  // Both source and version writes invalidate the reviewed snapshot, even unchanged values.
  const changed = await seed();
  const changedPlan = await review(changed.id);
  await db.query(
    "UPDATE storage_versions SET message=message WHERE storage_id=$1",
    [changed.id],
  );
  await apply(changedPlan, 2);
  assert.equal(await storageCount(changed.id), 1);
  const changedAgain = await review(changed.id);
  await db.query("UPDATE storages SET size=size WHERE id=$1", [changed.id]);
  await apply(changedAgain, 2);
  assert.equal(await versionCount(changed.id), 1);

  // Expired queue context and terminal Runs with live owners remain consumers.
  const protectedSource = await seed();
  const protectedPlan = await review(protectedSource.id);
  const mount = JSON.stringify([
    { storageId: protectedSource.id, version: protectedSource.version },
  ]);
  await db.query(
    "INSERT INTO agent_runs(id,status,prompt,user_id,org_id,storage_mounts) VALUES($1,'completed','fixture','owner',$2,$3)",
    [runId, orgId, mount],
  );
  await db.query(
    "INSERT INTO runner_job_queue(run_id,runner_group,execution_context,expires_at) VALUES($1,'fixture',$2,now()-interval '1 day')",
    [
      runId,
      JSON.stringify({
        storageMounts: [
          { storageId: protectedSource.id, versionId: protectedSource.version },
        ],
      }),
    ],
  );
  assert.ok(
    (await review(protectedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "queued-consumer",
    ),
  );
  await apply(protectedPlan, 2);
  await db.query(
    "UPDATE runner_job_queue SET execution_context=$2 WHERE run_id=$1",
    [
      runId,
      JSON.stringify({ artifacts: [{ versionId: protectedSource.version }] }),
    ],
  );
  assert.ok(
    (await review(protectedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "queued-consumer",
    ),
  );
  await db.query("DELETE FROM runner_job_queue WHERE run_id=$1", [runId]);
  await db.query(
    "INSERT INTO active_agent_runs(run_id,org_id,user_id,last_heartbeat_at) VALUES($1,$2,'owner',now())",
    [runId, orgId],
  );
  assert.ok(
    (await review(protectedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "execution-consumer",
    ),
  );
  await db.query("DELETE FROM active_agent_runs WHERE run_id=$1", [runId]);
  await db.query(
    "INSERT INTO runner_state(runner_id,runner_group,last_seen_at,active_reuse_producers) VALUES($1,'fixture',now(),$2)",
    [
      runnerId,
      JSON.stringify([{ runId, reuseKey: "fixture", profile: "vm0/default" }]),
    ],
  );
  assert.ok(
    (await review(protectedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "execution-consumer",
    ),
  );
  await db.query("DELETE FROM runner_state WHERE runner_id=$1", [runnerId]);
  assert.equal((await review(protectedSource.id)).plan.ready.length, 1);

  // Historical name-only references are tenant-scoped and protect planning,
  // metadata removal and deletion, including a reference created during LIST.
  const namedSource = await seed(
    false,
    "__org__",
    `custom-skill@named-${randomUUID()}`,
  );
  const namedPlan = await review(namedSource.id);
  const storageName = string().parse(namedPlan.plan.ready[0]?.source.name);
  await db.query(
    "INSERT INTO runner_job_queue(run_id,runner_group,execution_context,expires_at) VALUES($1,'fixture',$2,now()-interval '1 day')",
    [runId, JSON.stringify({ storageMounts: [{ name: storageName }] })],
  );
  assert.ok(
    (await review(namedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "queued-consumer",
    ),
  );
  await apply(namedPlan, 2);
  assert.equal(await storageCount(namedSource.id), 1);
  await db.query("UPDATE agent_runs SET org_id=$2 WHERE id=$1", [
    runId,
    `${orgId}-other`,
  ]);
  assert.equal((await review(namedSource.id)).plan.ready.length, 1);
  // UUID/version references remain global even when the consumer is in another org.
  await db.query(
    "UPDATE runner_job_queue SET execution_context=$2 WHERE run_id=$1",
    [
      runId,
      JSON.stringify({ artifacts: [{ versionId: namedSource.version }] }),
    ],
  );
  assert.ok(
    (await review(namedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "queued-consumer",
    ),
  );
  await db.query("DELETE FROM runner_job_queue WHERE run_id=$1", [runId]);
  await db.query(
    "UPDATE agent_runs SET org_id=$2,storage_mounts=$3 WHERE id=$1",
    [runId, orgId, JSON.stringify([{ name: storageName }])],
  );
  await db.query(
    "INSERT INTO active_agent_runs(run_id,org_id,user_id,last_heartbeat_at) VALUES($1,$2,'owner',now())",
    [runId, orgId],
  );
  assert.ok(
    (await review(namedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "execution-consumer",
    ),
  );
  await db.query("DELETE FROM active_agent_runs WHERE run_id=$1", [runId]);
  const consumerId = randomUUID();
  await db.query(
    "INSERT INTO background_jobs(id,kind,handler_version,user_id,org_id,input,checkpoint) VALUES($1,'fixture',1,'owner',$2,'{}',$3)",
    [consumerId, orgId, JSON.stringify({ mount: { storageName } })],
  );
  assert.ok(
    (await review(namedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "background-consumer",
    ),
  );
  await db.query("DELETE FROM background_jobs WHERE id=$1", [consumerId]);
  await apply(namedPlan);
  beforeList = async () => {
    await db.query(
      "INSERT INTO runner_job_queue(run_id,runner_group,execution_context,expires_at) VALUES($1,'fixture',$2,now()-interval '1 day')",
      [runId, JSON.stringify({ storageMounts: [{ name: storageName }] })],
    );
  };
  const namedDeletesBefore = deleteCount;
  await processJobs(namedPlan, 1);
  assert.equal(deleteCount, namedDeletesBefore);
  assert.equal(objects.has(`${namedSource.directory}/archive.tar.gz`), true);
  await db.query("DELETE FROM runner_job_queue WHERE run_id=$1", [runId]);
  await processJobs(namedPlan);
  await audit(namedPlan);

  // A foreign Storage root is protected by overlap, not only by foreign keys.
  for (const overlappingPrefix of [orgId, `${protectedSource.prefix}/shared`]) {
    await db.query("UPDATE storages SET s3_prefix=$2 WHERE id=$1", [
      memory.id,
      overlappingPrefix,
    ]);
    assert.ok(
      (await review(protectedSource.id, 2)).plan.blocked[0]?.reasons.includes(
        "other-storage",
      ),
    );
  }
  await db.query("UPDATE storages SET s3_prefix=$2 WHERE id=$1", [
    memory.id,
    `${protectedSource.prefix}-sibling`,
  ]);
  assert.equal((await review(protectedSource.id)).plan.ready.length, 1);
  await db.query("UPDATE storages SET s3_prefix=$2 WHERE id=$1", [
    memory.id,
    memory.prefix,
  ]);
  await db.query(
    "INSERT INTO skills(url,name,full_path,storage_id) VALUES($1,'fixture','fixture',$2)",
    [`https://fixture.test/${protectedSource.id}`, protectedSource.id],
  );
  assert.ok(
    (await review(protectedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "skill",
    ),
  );
  await db.query("DELETE FROM skills WHERE storage_id=$1", [
    protectedSource.id,
  ]);

  // A version-only Skill or custom connector remains an independent owner.
  const versionOwnerPlan = await review(protectedSource.id);
  const skillUrl = `https://fixture.test/version/${protectedSource.id}`;
  await db.query(
    "INSERT INTO skills(url,name,full_path,version_hash) VALUES($1,'fixture','fixture',$2)",
    [skillUrl, protectedSource.version],
  );
  assert.ok(
    (await review(protectedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "skill",
    ),
  );
  await apply(versionOwnerPlan, 2);
  await db.query("DELETE FROM skills WHERE url=$1", [skillUrl]);
  const connectorId = randomUUID();
  await db.query(
    "INSERT INTO org_custom_connectors(id,org_id,slug,display_name,prefix_templates,auth_mode,created_by,skill_markdown,skill_storage_version_id) VALUES($1,$2,'_retirement','Retirement','[\"https://fixture.test/\"]','none','owner','fixture',$3)",
    [connectorId, orgId, protectedSource.version],
  );
  assert.ok(
    (await review(protectedSource.id, 2)).plan.blocked[0]?.reasons.includes(
      "custom-connector",
    ),
  );
  const connectorApply = await apply(versionOwnerPlan, 2);
  assert.equal(connectorApply.records[0]?.status, "changed_or_referenced");
  assert.equal(await versionCount(protectedSource.id), 1);
  await db.query("DELETE FROM org_custom_connectors WHERE id=$1", [
    connectorId,
  ]);

  // Pending work and running leases (even expired) block retirement. Completed
  // derived indexes follow their parent version's existing cascading lifecycle.
  for (const state of ["pending", "leased", "expired"] as const) {
    const running = state !== "pending";
    await db.query(
      "INSERT INTO pi_resource_version_indexes(storage_version_id,extractor_version,status,lease_id,lease_expires_at) VALUES($1,1,$2,$3,$4)",
      [
        protectedSource.version,
        running ? "running" : "pending",
        running ? randomUUID() : null,
        running
          ? new Date(Date.now() + (state === "leased" ? 60_000 : -60_000))
          : null,
      ],
    );
    assert.ok(
      (await review(protectedSource.id, 2)).plan.blocked[0]?.reasons.includes(
        "pi-index-work",
      ),
    );
    await apply(versionOwnerPlan, 2);
    assert.equal(await versionCount(protectedSource.id), 1);
    await db.query(
      "DELETE FROM pi_resource_version_indexes WHERE storage_version_id=$1",
      [protectedSource.version],
    );
  }
  await db.query(
    "INSERT INTO pi_resource_version_indexes(storage_version_id,extractor_version,status,projection,projection_hash,source_archive_size) VALUES($1,1,'ready','{\"schemaVersion\":1,\"files\":[]}',$2,1),($1,2,'unindexable',NULL,NULL,NULL)",
    [protectedSource.version, digest("empty-index")],
  );
  const indexedPlan = await review(protectedSource.id);
  await apply(indexedPlan);
  assert.equal(
    await scalar(
      "SELECT count(*)::int AS count FROM pi_resource_version_indexes WHERE storage_version_id=$1",
      [protectedSource.version],
    ),
    0,
  );
  await processJobs(indexedPlan);
  await audit(indexedPlan);

  // Multi-page deletion has a bounded continuation and certifies only a final empty listing.
  const paginated = await seed();
  for (let index = 0; index < 1005; index++)
    objects.add(`${paginated.directory}/references/${index}.txt`);
  const paginationPlan = await review(paginated.id);
  await apply(paginationPlan);
  await processJobs(paginationPlan, 2, "1");
  assert.equal((await jobs(paginated.id))[0]?.status, "pending");
  assert.equal(
    [...objects].filter((key) => {
      return key.startsWith(`${paginated.prefix}/`);
    }).length,
    7,
  );
  await processJobs(paginationPlan);
  await audit(paginationPlan);

  // A reference appearing during LIST must prevent the subsequent delete.
  const late = await seed();
  const latePlan = await review(late.id);
  await apply(latePlan);
  beforeList = async () => {
    await db.query("UPDATE storages SET s3_prefix=$2 WHERE id=$1", [
      memory.id,
      late.prefix,
    ]);
  };
  const deletesBefore = deleteCount;
  await processJobs(latePlan, 1);
  assert.equal(deleteCount, deletesBefore);
  assert.equal(objects.has(`${late.directory}/archive.tar.gz`), true);
  assert.equal((await jobs(late.id))[0]?.failure_count, 1);
  await db.query("UPDATE storages SET s3_prefix=$2 WHERE id=$1", [
    memory.id,
    memory.prefix,
  ]);
  await processJobs(latePlan);
  const recoveredAudit = await audit(latePlan);
  assert.ok(
    JSON.stringify(recoveredAudit.records).includes('"failureCount":1'),
  );

  // Provider partial deletion and a lost success reply stop without an internal retry.
  for (const mode of ["partial", "lost-reply"] as const) {
    const retry = await seed();
    const retryPlan = await review(retry.id);
    await apply(retryPlan);
    deleteFailure = mode;
    const prior: number = deleteCount;
    await processJobs(retryPlan, 1);
    assert.equal(deleteCount, prior + 1);
    assert.equal((await jobs(retry.id))[0]?.failure_count, 1);
    await processJobs(retryPlan);
    await audit(retryPlan);
  }

  // Only an expired existing lease can be reclaimed; completion never hides a missing receipt.
  const leased = await seed();
  const leasePlan = await review(leased.id);
  await apply(leasePlan);
  const leaseJob = string().parse(leasePlan.plan.ready[0]?.jobs[0]?.id);
  await db.query(
    "UPDATE background_jobs SET status='running',lease_id=$2,lease_expires_at=now()+interval '1 hour' WHERE id=$1",
    [leaseJob, randomUUID()],
  );
  const priorLists = listCount;
  await processJobs(leasePlan, 2);
  assert.equal(listCount, priorLists);
  await db.query(
    "UPDATE background_jobs SET lease_expires_at=now()-interval '1 second' WHERE id=$1",
    [leaseJob],
  );
  await processJobs(leasePlan);
  await audit(leasePlan);
  await db.query("DELETE FROM background_jobs WHERE id=$1", [leaseJob]);
  assert.equal((await audit(leasePlan, 2)).records[0]?.status, "incomplete");
  await apply(leasePlan, 1);

  // Empty instructions are legal. User changes are reported, never overwritten or auto-approved.
  const natural = await seed();
  await db.query("UPDATE workflows SET instruction=NULL WHERE id=$1", [
    natural.workflowId,
  ]);
  const naturalPlan = await review(natural.id);
  await db.query(
    "UPDATE workflows SET instruction='legitimate later edit' WHERE id=$1",
    [natural.workflowId],
  );
  await apply(naturalPlan);
  await processJobs(naturalPlan);
  const naturalAudit = await audit(naturalPlan, 2);
  assert.equal(naturalAudit.last?.preservationReviewRequired, true);
  assert.deepEqual(naturalAudit.last?.workflowChanges, [
    { id: natural.workflowId, change: "changed", instructionChanged: true },
  ]);
  assert.equal(
    (
      await db.query("SELECT instruction FROM workflows WHERE id=$1", [
        natural.workflowId,
      ])
    ).rows[0]?.instruction,
    "legitimate later edit",
  );
  await db.query("UPDATE workflows SET attachments=NULL WHERE id=$1", [
    natural.workflowId,
  ]);
  await invoke(["--storage-id", changed.id], 1);
  await db.query(
    'UPDATE workflows SET attachments=\'{"kind":"empty"}\' WHERE id=$1',
    [natural.workflowId],
  );
  const malformed = await seed();
  await db.query(
    "UPDATE storages SET s3_prefix='workflow-attachments/forbidden' WHERE id=$1",
    [malformed.id],
  );
  assert.ok(
    (await review(malformed.id, 2)).plan.blocked[0]?.reasons.includes(
      "UnrecognizedLegacyPrefix",
    ),
  );
  const unknownName = await seed(false, "__org__", "custom-skill@Unknown_Name");
  assert.deepEqual((await review(unknownName.id, 2)).plan.blocked[0]?.reasons, [
    "UnsupportedWorkflowStorageIdentity",
  ]);
  assert.equal(objects.has(newAttachment), true);
  assert.equal(objects.has(sibling), true);
  console.log(
    "Workflow Storage retirement CLI: scope, atomic receipts, CAS, live consumers, bounded R2 pages, recovery and preservation passed",
  );
} finally {
  beforeList = undefined;
  server.closeAllConnections();
  if (server.listening)
    await new Promise<void>((resolve, reject) => {
      return server.close((error) => {
        return error ? reject(error) : resolve();
      });
    });
  await db.query("DELETE FROM runner_state WHERE runner_id=$1", [runnerId]);
  await db.query(
    "DELETE FROM runner_job_queue WHERE run_id=$2 OR run_id IN(SELECT id FROM agent_runs WHERE org_id=$1)",
    [orgId, runId],
  );
  await db.query("DELETE FROM active_agent_runs WHERE org_id=$1 OR run_id=$2", [
    orgId,
    runId,
  ]);
  await db.query("DELETE FROM agent_runs WHERE org_id=$1 OR id=$2", [
    orgId,
    runId,
  ]);
  await db.query(
    "DELETE FROM skills WHERE storage_id IN(SELECT id FROM storages WHERE org_id=$1) OR version_hash IN(SELECT v.id FROM storage_versions v JOIN storages s ON s.id=v.storage_id WHERE s.org_id=$1)",
    [orgId],
  );
  await db.query("DELETE FROM background_jobs WHERE org_id=$1", [orgId]);
  await db.query("DELETE FROM org_custom_connectors WHERE org_id=$1", [orgId]);
  await db.query("DELETE FROM storages WHERE org_id=$1", [orgId]);
  await db.query("DELETE FROM workflows WHERE org_id=$1 OR agent_id=$2", [
    orgId,
    agentId,
  ]);
  await db.query("DELETE FROM agents WHERE id=$1", [agentId]);
  await db.end();
  await rm(root, { recursive: true, force: true });
}
