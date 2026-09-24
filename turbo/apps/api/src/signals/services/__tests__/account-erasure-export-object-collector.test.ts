import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
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
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import {
  createExportObjectErasureCollector,
  EXPORT_OBJECT_ERASURE_COLLECTOR_VERSION,
} from "../account-erasure-export-object-collector";
import { encryptErasureSelector } from "../account-erasure-selector";

describe("export object erasure", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  const db = drizzle(pool);
  const context = testContext();

  afterAll(async () => {
    await pool.end();
  });

  function commandInput(command: unknown): Record<string, unknown> {
    const input =
      command instanceof Object && "input" in command
        ? (command as { input: unknown }).input
        : undefined;
    return input instanceof Object ? (input as Record<string, unknown>) : {};
  }

  function objectStore(keys: readonly string[]) {
    const live = new Set(keys);
    const deleted: string[] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = commandInput(command);
      switch (command instanceof Object ? command.constructor.name : "") {
        case "HeadObjectCommand": {
          return live.has(String(input.Key))
            ? Promise.resolve({ ContentLength: 1 })
            : Promise.reject(
                Object.assign(new Error("Missing object"), {
                  name: "NoSuchKey",
                }),
              );
        }
        case "DeleteObjectsCommand": {
          const entries =
            input.Delete instanceof Object && "Objects" in input.Delete
              ? (input.Delete as { Objects: { Key: string }[] }).Objects
              : [];
          for (const entry of entries) {
            live.delete(entry.Key);
            deleted.push(entry.Key);
          }
          return Promise.resolve({});
        }
        case "ListObjectsV2Command": {
          const prefix = String(input.Prefix);
          const matching = [...live].filter((key) => {
            return key.startsWith(prefix);
          });
          return Promise.resolve({
            Contents: matching.map((key) => {
              return { Key: key };
            }),
            IsTruncated: false,
          });
        }
        case "ListMultipartUploadsCommand": {
          return Promise.resolve({ Uploads: [], IsTruncated: false });
        }
        default: {
          return Promise.resolve({});
        }
      }
    });
    return { live, deleted };
  }

  async function capture(userId: string) {
    const selector = await encryptErasureSelector({
      version: 1,
      kind: "subject",
      subjectKind: "user",
      subjectId: userId,
    });
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "objects",
      collectorVersion: EXPORT_OBJECT_ERASURE_COLLECTOR_VERSION,
      selector,
      dependencies: [],
    };
    const initial = await projectErasureDecision(db, {
      subjectKind: "user",
      subjectId: userId,
      generation: 1,
      authorityId: randomUUID(),
      decisionRef: randomUUID(),
      decisionSequence: 1n,
      confirmationRef: randomUUID(),
      previousDecisionRef: null,
      dispositionVersion: 1,
      requestedAt: nowDate(),
      deadlineAt: new Date("2090-01-01T00:00:00Z"),
    });
    const job = await reviseErasureInventory(db, initial.id, initial, [sink]);
    const handler = createExportObjectErasureCollector(db);
    const [inventory] = await claimErasureWork(db, job.id, "inventory");
    expect(inventory).toBeDefined();
    if (!inventory) {
      throw new Error("Missing export inventory lease");
    }
    await executeErasureWork(db, inventory, handler, context.signal);
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
    return { job: sealed, handler };
  }

  async function createExport(
    userId: string,
    jobId: string,
    mode: string | null,
  ) {
    await db.execute(sql`
      INSERT INTO export_jobs (id, user_id, org_id, status, execution_mode)
      VALUES (${jobId}, ${userId}, ${`org_${jobId}`}, 'completed', ${mode})
    `);
    onTestFinished(async () => {
      await db.execute(sql`DELETE FROM export_jobs WHERE id = ${jobId}`);
      await db.execute(sql`DELETE FROM background_jobs WHERE id = ${jobId}`);
    });
  }

  it("deletes captured export bytes after the catalog row disappears while preserving another account", async () => {
    const userId = `user_export_${randomUUID()}`;
    const otherUser = `user_export_${randomUUID()}`;
    const jobId = randomUUID();
    await createExport(userId, jobId, null);
    const result = `exports/${userId}/${jobId}.zip`;
    const staged = `exports/${userId}/${jobId}/staging/part-1`;
    const other = `exports/${otherUser}/${randomUUID()}.zip`;
    const objects = objectStore([result, staged, other]);
    const { job, handler } = await capture(userId);

    await db.execute(sql`DELETE FROM export_jobs WHERE id = ${jobId}`);
    expect(objects.live.has(result)).toBeTruthy();
    for (const lease of await claimErasureWork(db, job.id, "verification")) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    expect(objects.live).toStrictEqual(new Set([other]));
    expect(objects.deleted).toContain(result);
    expect(objects.deleted).toContain(staged);
    expect((await finalizeErasureJob(db, job.id, job)).state).toBe(
      "verified_erased",
    );
  });

  it("replays a running durable export after lease loss and catalog deletion", async () => {
    const userId = `user_export_${randomUUID()}`;
    const jobId = randomUUID();
    await createExport(userId, jobId, "durable-v1");
    await db.execute(sql`
      INSERT INTO background_jobs
        (id, kind, handler_version, user_id, org_id, input, status, lease_id, lease_expires_at)
      VALUES
        (${jobId}, 'user-export', 1, ${userId}, ${`org_${jobId}`}, '{}'::jsonb,
         'running', ${randomUUID()}, clock_timestamp() + interval '2 minutes')
    `);
    const result = `exports/${userId}/${jobId}.zip`;
    const objects = objectStore([result]);
    const { job, handler } = await capture(userId);
    const [inventory, erase] = await claimErasureWork(
      db,
      job.id,
      "verification",
    );
    expect(inventory).toBeDefined();
    expect(erase).toBeDefined();
    if (!inventory || !erase) {
      throw new Error("Missing captured export work or inventory proof");
    }
    await executeErasureWork(db, erase, handler, context.signal);
    expect(objects.live.has(result)).toBeTruthy();
    const state = await db.execute(sql`
      SELECT state, error_code FROM account_erasure_work WHERE id = ${erase.workId}
    `);
    expect(state.rows[0]).toMatchObject({
      state: "pending",
      error_code: "boundary_unproven",
    });
    await expect(finalizeErasureJob(db, job.id, job)).rejects.toThrow(
      "work_unresolved",
    );

    // The legacy phase removes the export catalog, and the old worker can no
    // longer own a live lease. Its cleanup coordinator must finish before B1
    // can delete and verify the captured result bytes.
    await db.execute(sql`DELETE FROM export_jobs WHERE id = ${jobId}`);
    await db.execute(sql`
      UPDATE background_jobs
      SET lease_expires_at = timezone('UTC', clock_timestamp()) - interval '3 minutes',
          updated_at = timezone('UTC', clock_timestamp()) - interval '3 minutes'
      WHERE id = ${jobId}
    `);
    await executeErasureWork(db, inventory, handler, context.signal);
    await db.execute(sql`
      UPDATE account_erasure_work
      SET available_at = clock_timestamp()
      WHERE id = ${erase.workId}
    `);
    const [replayed] = await claimErasureWork(db, job.id, "verification");
    expect(replayed?.workId).toBe(erase.workId);
    if (!replayed) {
      throw new Error("Missing replayed export erasure work");
    }
    await executeErasureWork(db, replayed, handler, context.signal);
    const coordinator = await db.execute(sql`
      SELECT id FROM background_jobs WHERE id = ${jobId}
    `);
    expect(coordinator.rows).toStrictEqual([]);
    expect(objects.live.has(result)).toBeFalsy();
    expect((await finalizeErasureJob(db, job.id, job)).state).toBe(
      "verified_erased",
    );
  });
});
