/* eslint-disable no-restricted-syntax -- B1 has no product endpoint; exact capture and byte proof are exercised through its durable job boundary. */
import { randomBytes, randomUUID } from "node:crypto";
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
import { env } from "../../../lib/env";
import {
  createSharedBlobErasureCollector,
  SHARED_BLOB_ERASURE_COLLECTOR_VERSION,
} from "../account-erasure-shared-blob-collector";
import { encryptErasureSelector } from "../account-erasure-selector";

describe("shared blob account-erasure capture", () => {
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.searchParams.set(
    "application_name",
    `erasure_shared_blob_${randomUUID()}`,
  );
  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 8 });
  const db = drizzle(pool);
  const context = testContext();

  afterAll(async () => {
    await pool.end();
  });

  it("captures hashes before catalog deletion, waits without exhausting retries, and preserves a survivor", async () => {
    const mine = `user_blob_${randomUUID().replaceAll("-", "")}`;
    const theirs = `user_blob_${randomUUID().replaceAll("-", "")}`;
    const orgId = `org_blob_${randomUUID().replaceAll("-", "")}`;
    const ownStorage = randomUUID();
    const theirStorage = randomUUID();
    const privateHash = randomBytes(32).toString("hex");
    const sharedHash = randomBytes(32).toString("hex");
    const privateKey = `blobs/${privateHash}.blob`;
    const sharedKey = `blobs/${sharedHash}.blob`;
    const live = new Set([privateKey, sharedKey]);
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input =
        command instanceof Object && "input" in command
          ? (command as { input: Record<string, unknown> }).input
          : {};
      if (
        command instanceof Object &&
        command.constructor.name === "HeadObjectCommand"
      ) {
        if (live.has(String(input.Key))) {
          return Promise.resolve({ ContentLength: 4 });
        }
        return Promise.reject(
          Object.assign(new Error("absent"), { name: "NoSuchKey" }),
        );
      }
      if (
        command instanceof Object &&
        command.constructor.name === "DeleteObjectsCommand"
      ) {
        const objects =
          input.Delete instanceof Object && "Objects" in input.Delete
            ? (input.Delete as { Objects: { Key: string }[] }).Objects
            : [];
        for (const object of objects) {
          live.delete(object.Key);
        }
      }
      return Promise.resolve({});
    });

    await pool.query(
      "INSERT INTO blobs (hash, raw_size, encoding, encoded_size, ref_count, erasure_eligible_at) VALUES ($1, 4, 'identity', 4, 1, clock_timestamp() + interval '49 hours'), ($2, 4, 'identity', 4, 2, clock_timestamp() - interval '1 hour')",
      [privateHash, sharedHash],
    );
    await pool.query(
      "INSERT INTO storages (id, user_id, org_id, name, s3_prefix) VALUES ($1, $2, $3, 'memory', $4), ($5, $6, $3, 'memory', $7)",
      [
        ownStorage,
        mine,
        orgId,
        `storage/${ownStorage}`,
        theirStorage,
        theirs,
        `storage/${theirStorage}`,
      ],
    );
    await pool.query(
      "INSERT INTO pi_memory_stage1_candidates (memory_storage_id, org_id, user_id, pi_session_id, source_run_id, source_history_hash, source_completed_at, eligible_at) VALUES ($1, $2, $3, 'private', $4, $5, now(), now()), ($1, $2, $3, 'shared', $6, $7, now(), now()), ($8, $2, $9, 'survivor', $10, $7, now(), now())",
      [
        ownStorage,
        orgId,
        mine,
        randomUUID(),
        privateHash,
        randomUUID(),
        sharedHash,
        theirStorage,
        theirs,
        randomUUID(),
      ],
    );
    const initial = await projectErasureDecision(db, {
      subjectKind: "user",
      subjectId: mine,
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
    onTestFinished(async () => {
      await pool.query(
        "DELETE FROM account_erasure_selector_dependencies WHERE work_id IN (SELECT id FROM account_erasure_work WHERE job_id = $1)",
        [initial.id],
      );
      await pool.query(
        "DELETE FROM account_erasure_pages WHERE work_id IN (SELECT id FROM account_erasure_work WHERE job_id = $1)",
        [initial.id],
      );
      await pool.query("DELETE FROM account_erasure_work WHERE job_id = $1", [
        initial.id,
      ]);
      await pool.query("DELETE FROM account_erasure_sinks WHERE job_id = $1", [
        initial.id,
      ]);
      await pool.query("DELETE FROM account_erasure_jobs WHERE id = $1", [
        initial.id,
      ]);
      await pool.query(
        "DELETE FROM pi_memory_stage1_candidates WHERE memory_storage_id IN ($1, $2)",
        [ownStorage, theirStorage],
      );
      await pool.query("DELETE FROM storages WHERE id IN ($1, $2)", [
        ownStorage,
        theirStorage,
      ]);
      await pool.query("DELETE FROM blobs WHERE hash IN ($1, $2)", [
        privateHash,
        sharedHash,
      ]);
    });
    const selector = await encryptErasureSelector({
      version: 1,
      kind: "subject",
      subjectKind: "user",
      subjectId: mine,
    });
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "objects",
      collectorVersion: SHARED_BLOB_ERASURE_COLLECTOR_VERSION,
      selector,
      dependencies: [],
    };
    const job = await reviseErasureInventory(db, initial.id, initial, [sink]);
    const handler = createSharedBlobErasureCollector(db);
    const [inventory] = await claimErasureWork(db, job.id, "inventory");
    expect(inventory).toBeDefined();
    if (!inventory) {
      throw new Error("Missing shared blob inventory lease");
    }
    await executeErasureWork(db, inventory, handler, context.signal);
    const captured = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM account_erasure_work WHERE job_id = $1 AND kind = 'erase'",
      [job.id],
    );
    expect(captured.rows[0]?.count).toBe("2");
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

    // A premature object pass cannot interpret this owner's retain as a
    // surviving account's reference and produce a false proof.
    const beforeSweep = await claimErasureWork(db, job.id, "verification");
    for (const lease of beforeSweep) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    const stillPending = await pool.query<{ count: string }>(
      "SELECT count(*) AS count FROM account_erasure_work WHERE job_id = $1 AND kind = 'erase' AND state = 'pending' AND error_code = 'boundary_unproven'",
      [job.id],
    );
    expect(stillPending.rows[0]?.count).toBe("2");
    expect(live.has(privateKey)).toBeTruthy();
    expect(live.has(sharedKey)).toBeTruthy();

    // The relational sweep now removes source rows and commits both releases.
    await pool.query(
      "DELETE FROM pi_memory_stage1_candidates WHERE memory_storage_id = $1",
      [ownStorage],
    );
    await pool.query("DELETE FROM storages WHERE id = $1", [ownStorage]);
    await pool.query(
      "UPDATE blobs SET ref_count = CASE WHEN hash = $1 THEN 0 ELSE 1 END WHERE hash IN ($1, $2)",
      [privateHash, sharedHash],
    );
    await pool.query(
      "UPDATE account_erasure_work SET available_at = clock_timestamp() - interval '1 second' WHERE job_id = $1 AND kind = 'erase' AND state = 'pending'",
      [job.id],
    );

    const first = await claimErasureWork(db, job.id, "verification");
    for (const lease of first) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    expect(live.has(privateKey)).toBeTruthy();
    expect(live.has(sharedKey)).toBeTruthy();
    const deferred = await pool.query<{
      attempt_count: number;
      available_at: Date;
      state: string;
    }>(
      "SELECT attempt_count, available_at, state FROM account_erasure_work WHERE job_id = $1 AND kind = 'erase' AND state = 'pending'",
      [job.id],
    );
    expect(deferred.rows).toHaveLength(1);
    expect(deferred.rows[0]?.attempt_count).toBe(0);
    expect(deferred.rows[0]?.available_at.getTime()).toBeGreaterThan(
      Date.now() + 47 * 60 * 60 * 1000,
    );
    await pool.query(
      "UPDATE blobs SET erasure_eligible_at = clock_timestamp() - interval '1 minute' WHERE hash = $1",
      [privateHash],
    );
    await pool.query(
      "UPDATE account_erasure_work SET available_at = clock_timestamp() - interval '1 second' WHERE job_id = $1 AND kind = 'erase' AND state = 'pending'",
      [job.id],
    );
    const resumed = await claimErasureWork(db, job.id, "verification");
    expect(resumed).toHaveLength(1);
    for (const lease of resumed) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    expect(live.has(privateKey)).toBeFalsy();
    expect(live.has(sharedKey)).toBeTruthy();
    await expect(finalizeErasureJob(db, job.id, sealed)).resolves.toMatchObject(
      { state: "verified_erased" },
    );
  });
});
