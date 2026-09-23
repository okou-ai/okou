import { randomBytes, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import {
  claimErasureWork,
  executeErasureWork,
  finalizeErasureJob,
  projectErasureDecision,
  reviseErasureInventory,
  sealErasureCapture,
  type ErasureSink,
} from "@okouai/db/operations/account-erasure";

import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import {
  STORAGE_OBJECT_ERASURE_COLLECTOR_VERSION,
  createStorageObjectErasureCollector,
} from "../account-erasure-storage-object-collector";
import { encryptErasureSelector } from "../account-erasure-selector";

// Drive the durable job contract directly and mock only the AWS SDK boundary:
// provider listings after delete, rather than the response, decide completion.
describe("storage-object erasure", () => {
  const applicationName = `erasure_storage_${randomUUID()}`;
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.searchParams.set("application_name", applicationName);
  const pool = new Pool({
    connectionString: databaseUrl.toString(),
    application_name: applicationName,
    max: 8,
  });
  const db = drizzle(pool);
  const context = testContext();

  afterAll(async () => {
    await pool.end();
  });

  function owner(label: string): string {
    return `user_storage_${label}_${randomUUID().replaceAll("-", "")}`;
  }

  function inputOf(command: unknown): Record<string, unknown> {
    const input =
      command instanceof Object && "input" in command
        ? (command as { input: unknown }).input
        : undefined;
    return input instanceof Object ? (input as Record<string, unknown>) : {};
  }

  function bucketWithObjects(
    keys: readonly string[],
    survivor?: string,
  ): { readonly live: Set<string>; readonly batches: string[][] } {
    const live = new Set(keys);
    const batches: string[][] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = inputOf(command);
      if (
        command instanceof Object &&
        command.constructor.name === "ListObjectsV2Command"
      ) {
        const prefix = typeof input.Prefix === "string" ? input.Prefix : "";
        const maxKeys =
          typeof input.MaxKeys === "number" ? input.MaxKeys : 1000;
        const matching = [...live]
          .filter((key) => {
            return key.startsWith(prefix);
          })
          .sort();
        return Promise.resolve({
          Contents: matching.slice(0, maxKeys).map((Key) => {
            return { Key, Size: 1, LastModified: nowDate() };
          }),
          IsTruncated: matching.length > maxKeys,
        });
      }
      if (
        command instanceof Object &&
        command.constructor.name === "DeleteObjectsCommand"
      ) {
        const objects =
          input.Delete instanceof Object && "Objects" in input.Delete
            ? (input.Delete as { Objects: { Key: string }[] }).Objects
            : [];
        batches.push(
          objects.map((object) => {
            return object.Key;
          }),
        );
        for (const object of objects) {
          if (object.Key !== survivor) {
            live.delete(object.Key);
          }
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    return { live, batches };
  }

  async function createStorage(
    userId: string,
    prefix: string,
  ): Promise<string> {
    const id = randomUUID();
    await db.execute(sql`INSERT INTO storages
      (id, user_id, org_id, name, s3_prefix)
      VALUES (${id}, ${userId}, ${`org_${id}`}, ${`storage-${id}`}, ${prefix})`);
    onTestFinished(async () => {
      await db.execute(sql`DELETE FROM storages WHERE id = ${id}`);
    });
    return id;
  }

  async function createVersion(
    storageId: string,
    createdBy: string,
    storagePrefix: string,
  ): Promise<{ readonly id: string; readonly prefix: string }> {
    const id = randomBytes(32).toString("hex");
    const prefix = `${storagePrefix}/${id}`;
    await db.execute(sql`INSERT INTO storage_versions
      (id, storage_id, s3_key, archive_size, created_by)
      VALUES (${id}, ${storageId}, ${prefix}, ${1}, ${createdBy})`);
    return { id, prefix };
  }

  async function sealedJob(subjectId: string) {
    const selector = await encryptErasureSelector({
      version: 1,
      kind: "subject",
      subjectKind: "user",
      subjectId,
    });
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "objects",
      collectorVersion: STORAGE_OBJECT_ERASURE_COLLECTOR_VERSION,
      selector,
      dependencies: [],
    };
    const initial = await projectErasureDecision(db, {
      subjectKind: "user",
      subjectId,
      generation: 1,
      authorityId: randomUUID(),
      decisionRef: randomUUID(),
      decisionSequence: 1n,
      confirmationRef: randomUUID(),
      previousDecisionRef: null,
      dispositionVersion: 1,
      requestedAt: new Date("2026-09-23T00:00:00Z"),
      deadlineAt: new Date("2090-01-01T00:00:00Z"),
    });
    return await reviseErasureInventory(db, initial.id, initial, [sink]);
  }

  async function capture(subjectId: string) {
    const handler = createStorageObjectErasureCollector(db);
    const job = await sealedJob(subjectId);
    const [collector] = await claimErasureWork(db, job.id, "inventory");
    expect(collector).toBeDefined();
    for (let page = 0; collector && page < 8; page += 1) {
      await executeErasureWork(db, collector, handler, context.signal);
      const result = await db.execute(
        sql`SELECT capture_complete FROM account_erasure_work WHERE id = ${collector.workId}`,
      );
      if (result.rows[0]?.capture_complete === true) {
        break;
      }
    }
    const sealed = await sealErasureCapture(
      db,
      job.id,
      job,
      {
        verify: () => {
          return Promise.resolve({
            jobId: job.id,
            generation: job.generation,
            captureRevision: job.captureRevision,
            inventoryRevision: job.inventoryRevision,
            reference: randomUUID(),
          });
        },
      },
      context.signal,
    );
    return { job, sealed, handler };
  }

  async function runVerification(
    jobId: string,
    handler: ReturnType<typeof createStorageObjectErasureCollector>,
  ): Promise<number> {
    let executed = 0;
    for (let round = 0; round < 64; round += 1) {
      const claimed = await claimErasureWork(db, jobId, "verification");
      if (claimed.length === 0) {
        return executed;
      }
      for (const lease of claimed) {
        await executeErasureWork(db, lease, handler, context.signal);
        executed += 1;
      }
    }
    return executed;
  }

  it("captures a storage and a cross-owner version before their rows vanish", async () => {
    const subject = owner("subject");
    const survivor = owner("survivor");
    const ownedPrefix = `storages/${randomUUID()}`;
    const otherPrefix = `storages/${randomUUID()}`;
    const ownedId = await createStorage(subject, ownedPrefix);
    const otherId = await createStorage(survivor, otherPrefix);
    const ownedVersion = await createVersion(ownedId, survivor, ownedPrefix);
    const subjectVersion = await createVersion(otherId, subject, otherPrefix);
    const survivingVersion = await createVersion(
      otherId,
      survivor,
      otherPrefix,
    );
    const bucket = bucketWithObjects([
      `${ownedVersion.prefix}/archive.tar.gz`,
      `${ownedPrefix}-other/keep.txt`,
      `${subjectVersion.prefix}/archive.tar.gz`,
      `${survivingVersion.prefix}/archive.tar.gz`,
    ]);
    const captured = await capture(subject);
    await db.execute(sql`DELETE FROM storages WHERE id = ${ownedId}`);
    await db.execute(
      sql`DELETE FROM storage_versions WHERE id = ${subjectVersion.id}`,
    );
    await expect(
      runVerification(captured.job.id, captured.handler),
    ).resolves.toBe(3);
    expect([...bucket.live].sort()).toStrictEqual(
      [
        `${ownedPrefix}-other/keep.txt`,
        `${survivingVersion.prefix}/archive.tar.gz`,
      ].sort(),
    );
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).resolves.toMatchObject({ state: "verified_erased" });
  });

  it("keeps the completion gate red when the provider leaves an archive", async () => {
    const subject = owner("residual");
    const prefix = `storages/${randomUUID()}`;
    await createStorage(subject, prefix);
    const key = `${prefix}/archive.tar.gz`;
    bucketWithObjects([key], key);
    const captured = await capture(subject);
    await runVerification(captured.job.id, captured.handler);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");
  });

  it("refuses to verify a captured prefix against a different bucket", async () => {
    const subject = owner("bucket-drift");
    const prefix = `storages/${randomUUID()}`;
    await createStorage(subject, prefix);
    const key = `${prefix}/archive.tar.gz`;
    const bucket = bucketWithObjects([key]);
    const captured = await capture(subject);
    const originalBucket = env("R2_USER_STORAGES_BUCKET_NAME");
    mockEnv("R2_USER_STORAGES_BUCKET_NAME", `${originalBucket}-new`);
    onTestFinished(() => {
      mockEnv("R2_USER_STORAGES_BUCKET_NAME", originalBucket);
    });
    await runVerification(captured.job.id, captured.handler);
    expect(bucket.live.has(key)).toBeTruthy();
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");
  });

  it("refuses a version locator outside its parent storage", async () => {
    const subject = owner("mismatched");
    const other = owner("other");
    const parentId = await createStorage(other, `storages/${randomUUID()}`);
    const versionId = randomBytes(32).toString("hex");
    await db.execute(sql`INSERT INTO storage_versions
      (id, storage_id, s3_key, archive_size, created_by)
      VALUES (${versionId}, ${parentId}, ${`storages/${randomUUID()}/${versionId}`}, ${1}, ${subject})`);
    const job = await sealedJob(subject);
    const [collector] = await claimErasureWork(db, job.id, "inventory");
    expect(collector).toBeDefined();
    if (!collector) {
      throw new Error("Missing inventory lease");
    }
    await executeErasureWork(
      db,
      collector,
      createStorageObjectErasureCollector(db),
      context.signal,
    );
    const work = await db.execute(
      sql`SELECT error_code FROM account_erasure_work WHERE id = ${collector.workId}`,
    );
    expect(work.rows[0]?.error_code).toBe("ownership_unknown");
    await expect(
      sealErasureCapture(
        db,
        job.id,
        job,
        {
          verify: () => {
            return Promise.resolve({
              jobId: job.id,
              generation: job.generation,
              captureRevision: job.captureRevision,
              inventoryRevision: job.inventoryRevision,
              reference: randomUUID(),
            });
          },
        },
        context.signal,
      ),
    ).rejects.toThrow("account_erasure:capture_incomplete");
  });

  it("refuses a storage prefix shared with another member", async () => {
    const subject = owner("legacy-collision");
    const prefix = `legacy/${randomUUID()}`;
    await createStorage(subject, prefix);
    await createStorage(owner("other-collision"), prefix);
    const job = await sealedJob(subject);
    const [collector] = await claimErasureWork(db, job.id, "inventory");
    if (!collector) {
      throw new Error("Missing inventory lease");
    }
    await executeErasureWork(
      db,
      collector,
      createStorageObjectErasureCollector(db),
      context.signal,
    );
    const work = await db.execute(
      sql`SELECT error_code FROM account_erasure_work WHERE id = ${collector.workId}`,
    );
    expect(work.rows[0]?.error_code).toBe("ownership_unknown");
  });

  it("refuses a storage prefix containing another member's prefix", async () => {
    const subject = owner("legacy-ancestor");
    const prefix = `legacy/${randomUUID()}`;
    await createStorage(subject, prefix);
    await createStorage(owner("nested-owner"), `${prefix}/nested`);
    const job = await sealedJob(subject);
    const [collector] = await claimErasureWork(db, job.id, "inventory");
    if (!collector) {
      throw new Error("Missing inventory lease");
    }
    await executeErasureWork(
      db,
      collector,
      createStorageObjectErasureCollector(db),
      context.signal,
    );
    const work = await db.execute(
      sql`SELECT error_code FROM account_erasure_work WHERE id = ${collector.workId}`,
    );
    expect(work.rows[0]?.error_code).toBe("ownership_unknown");
  });

  it("uses the existing bounded S3 delete primitive for a large prefix", async () => {
    const subject = owner("large");
    const prefix = `storages/${randomUUID()}`;
    await createStorage(subject, prefix);
    const bucket = bucketWithObjects(
      Array.from({ length: 2500 }, (_value, index) => {
        return `${prefix}/file-${index.toString().padStart(5, "0")}`;
      }),
    );
    const captured = await capture(subject);
    await runVerification(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(0);
    expect(
      bucket.batches.map((batch) => {
        return batch.length;
      }),
    ).toStrictEqual([1000, 1000, 500]);
  });

  it("replays a large prefix after the bounded lease without claiming completion early", async () => {
    const subject = owner("large-replay");
    const prefix = `storages/${randomUUID()}`;
    await createStorage(subject, prefix);
    const bucket = bucketWithObjects(
      Array.from({ length: 10005 }, (_value, index) => {
        return `${prefix}/file-${index.toString().padStart(5, "0")}`;
      }),
    );
    const captured = await capture(subject);
    await runVerification(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(5);
    expect(bucket.batches).toHaveLength(10);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");

    // Advance only this test's durable retry boundary; no sleeping or special
    // production retry path is needed to exercise lease replay.
    await db.execute(sql`UPDATE account_erasure_work
      SET available_at = clock_timestamp() - interval '1 second'
      WHERE job_id = ${captured.job.id} AND state = 'pending'`);
    await runVerification(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(0);
    expect(bucket.batches.at(-1)).toHaveLength(5);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).resolves.toMatchObject({ state: "verified_erased" });
  });

  it("resumes capture across both storage and version pages", async () => {
    const subject = owner("paged");
    const survivor = owner("page-parent");
    const otherPrefix = `storages/${randomUUID()}`;
    const otherId = await createStorage(survivor, otherPrefix);
    const prefixes: string[] = [];
    for (let index = 0; index < 90; index += 1) {
      const prefix = `storages/${randomUUID()}`;
      await createStorage(subject, prefix);
      prefixes.push(prefix);
    }
    for (let index = 0; index < 30; index += 1) {
      const version = await createVersion(otherId, subject, otherPrefix);
      prefixes.push(version.prefix);
    }
    const bucket = bucketWithObjects(
      prefixes.map((prefix) => {
        return `${prefix}/manifest.json`;
      }),
    );
    const captured = await capture(subject);
    await expect(
      runVerification(captured.job.id, captured.handler),
    ).resolves.toBe(121);
    expect(bucket.live.size).toBe(0);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).resolves.toMatchObject({ state: "verified_erased" });
  });
});
