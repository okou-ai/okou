import { randomUUID } from "node:crypto";
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
import { buildFileUrlFromKey } from "../../../lib/file-url";
import {
  ARTIFACT_FILE_ERASURE_COLLECTOR_VERSION,
  createArtifactFileErasureCollector,
} from "../account-erasure-artifact-file-collector";
import { encryptErasureSelector } from "../account-erasure-selector";

describe("dormant artifact-file byte erasure", () => {
  const applicationName = "erasure_artifact_" + randomUUID();
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

  function inputOf(command: unknown): Record<string, unknown> {
    const input =
      command instanceof Object && "input" in command
        ? (command as { input: unknown }).input
        : undefined;
    return input instanceof Object ? (input as Record<string, unknown>) : {};
  }

  function bucketWithObjects(keys: readonly string[], survivor?: string) {
    const live = new Set(keys);
    const deletions: string[][] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input = inputOf(command);
      if (
        command instanceof Object &&
        command.constructor.name === "HeadObjectCommand"
      ) {
        if (live.has(String(input.Key))) {
          return Promise.resolve({ ContentLength: 1 });
        }
        return Promise.reject(
          Object.assign(new Error("Object absent"), { name: "NoSuchKey" }),
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
        const batch = objects.map((object) => {
          return object.Key;
        });
        deletions.push(batch);
        for (const key of batch) {
          if (key !== survivor) {
            live.delete(key);
          }
        }
        return Promise.resolve({});
      }
      return Promise.resolve({});
    });
    return { live, deletions };
  }

  async function fileFor(
    userId: string,
    key: string | null,
    url: string | null = null,
    metadata: Record<string, string> = {},
    id = randomUUID(),
  ) {
    await pool.query(
      "INSERT INTO run_uploaded_files (id, source, external_id, user_id, storage_key, url, metadata) VALUES ($1, 'web', $2, $3, $4, $5, $6::jsonb)",
      [id, id, userId, key, url, JSON.stringify(metadata)],
    );
    onTestFinished(async () => {
      await pool.query("DELETE FROM run_uploaded_files WHERE id = $1", [id]);
    });
    return id;
  }

  async function capture(subjectId: string, shortenAfterFirstPage = false) {
    const selector = await encryptErasureSelector({
      version: 1,
      kind: "subject",
      subjectKind: "user",
      subjectId,
    });
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "objects",
      collectorVersion: ARTIFACT_FILE_ERASURE_COLLECTOR_VERSION,
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
    const job = await reviseErasureInventory(db, initial.id, initial, [sink]);
    const handler = createArtifactFileErasureCollector(db);
    const [collector] = await claimErasureWork(db, job.id, "inventory");
    if (!collector) {
      throw new Error("Missing artifact inventory lease");
    }
    for (let page = 0; page < 8; page += 1) {
      await executeErasureWork(db, collector, handler, context.signal);
      if (page === 0 && shortenAfterFirstPage) {
        await pool.query(
          "UPDATE account_erasure_work SET lease_expires_at = clock_timestamp() + interval '2 seconds' WHERE id = $1",
          [collector.workId],
        );
      }
      if (page === 1 && shortenAfterFirstPage) {
        const renewed = await pool.query<{ renewed: boolean }>(
          "SELECT lease_expires_at > clock_timestamp() + interval '30 seconds' AS renewed FROM account_erasure_work WHERE id = $1",
          [collector.workId],
        );
        expect(renewed.rows).toStrictEqual([{ renewed: true }]);
      }
      const state = await pool.query<{
        capture_complete: boolean;
        error_code: string | null;
      }>(
        "SELECT capture_complete, error_code FROM account_erasure_work WHERE id = $1",
        [collector.workId],
      );
      if (state.rows[0]?.capture_complete || state.rows[0]?.error_code) {
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

  async function verify(
    jobId: string,
    handler: ReturnType<typeof createArtifactFileErasureCollector>,
  ) {
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

  it("deletes a null-run artifact after its catalog row has vanished", async () => {
    const userId = "user_artifact_" + randomUUID().replaceAll("-", "");
    const key =
      "artifacts/" +
      encodeURIComponent(userId) +
      "/" +
      randomUUID() +
      "/output.txt";
    await fileFor(userId, key);
    const bucket = bucketWithObjects([key]);
    const captured = await capture(userId);
    await pool.query("DELETE FROM run_uploaded_files WHERE user_id = $1", [
      userId,
    ]);
    await expect(verify(captured.job.id, captured.handler)).resolves.toBe(2);
    expect(bucket.live.size).toBe(0);
    expect(bucket.deletions).toStrictEqual([[key]]);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).resolves.toMatchObject({ state: "verified_erased" });
  });

  it("keeps the gate red when a delete response leaves the bytes", async () => {
    const userId = "user_artifact_" + randomUUID().replaceAll("-", "");
    const key =
      "artifacts/" +
      encodeURIComponent(userId) +
      "/" +
      randomUUID() +
      "/file.txt";
    await fileFor(userId, key);
    const bucket = bucketWithObjects([key], key);
    const captured = await capture(userId);
    await verify(captured.job.id, captured.handler);
    expect(bucket.live.has(key)).toBeTruthy();
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");
  });

  it("resolves a legacy public URL when storage_key was never set", async () => {
    const userId = "user_artifact_" + randomUUID().replaceAll("-", "");
    const key =
      "artifacts/" +
      encodeURIComponent(userId) +
      "/" +
      randomUUID() +
      "/legacy.txt";
    await fileFor(userId, null, buildFileUrlFromKey(key, "vm0"));
    const bucket = bucketWithObjects([key]);
    const captured = await capture(userId);
    await verify(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(0);
    expect(bucket.deletions).toStrictEqual([[key]]);
  });

  it("proves absence for a legacy URL whose object was already gone", async () => {
    const userId = "user_artifact_" + randomUUID().replaceAll("-", "");
    const key =
      "artifacts/" +
      encodeURIComponent(userId) +
      "/" +
      randomUUID() +
      "/lost.txt";
    await fileFor(userId, null, buildFileUrlFromKey(key, "vm0"));
    const bucket = bucketWithObjects([]);
    const captured = await capture(userId);
    await verify(captured.job.id, captured.handler);
    expect(bucket.deletions).toStrictEqual([]);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).resolves.toMatchObject({ state: "verified_no_applicable_data" });
  });

  it("deletes a private artifact from its own catalog locator", async () => {
    const userId = "user_artifact_" + randomUUID().replaceAll("-", "");
    const id = randomUUID();
    const privateBucket = env("R2_PRIVATE_ARTIFACTS_BUCKET_NAME");
    if (!privateBucket) {
      throw new Error("Private artifact bucket required by fixture");
    }
    const key = "private-artifacts/" + id + "/secret.txt";
    await fileFor(
      userId,
      key,
      null,
      { storage: "private-artifact-v1", bucket: privateBucket },
      id,
    );
    const bucket = bucketWithObjects([key]);
    const captured = await capture(userId);
    await pool.query("DELETE FROM run_uploaded_files WHERE id = $1", [id]);
    await verify(captured.job.id, captured.handler);
    expect(bucket.live.size).toBe(0);
    expect(bucket.deletions).toStrictEqual([[key]]);
  });

  it("refuses to check the captured key in a different R2 account", async () => {
    const userId = "user_artifact_" + randomUUID().replaceAll("-", "");
    const key =
      "artifacts/" +
      encodeURIComponent(userId) +
      "/" +
      randomUUID() +
      "/file.txt";
    await fileFor(userId, key);
    const bucket = bucketWithObjects([key]);
    const captured = await capture(userId);
    const accountId = env("R2_ACCOUNT_ID");
    mockEnv("R2_ACCOUNT_ID", accountId + "-new");
    onTestFinished(() => {
      mockEnv("R2_ACCOUNT_ID", accountId);
    });
    await verify(captured.job.id, captured.handler);
    expect(bucket.live.has(key)).toBeTruthy();
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).rejects.toThrow("account_erasure:work_unresolved");
  });

  it("captures an already missing compact object without an owner HEAD", async () => {
    const userId = "user_artifact_" + randomUUID().replaceAll("-", "");
    const key = "artifacts/abcdefghij.txt";
    await fileFor(userId, key);
    const bucket = bucketWithObjects([]);
    const captured = await capture(userId);
    await verify(captured.job.id, captured.handler);
    expect(bucket.deletions).toStrictEqual([]);
    await expect(
      finalizeErasureJob(db, captured.job.id, captured.sealed),
    ).resolves.toMatchObject({ state: "verified_no_applicable_data" });
  });

  it("refuses a live compact object without matching owner metadata", async () => {
    const userId = "user_artifact_" + randomUUID().replaceAll("-", "");
    const key = "artifacts/abcdefghij.txt";
    await fileFor(userId, key);
    const bucket = bucketWithObjects([key]);
    await expect(capture(userId)).rejects.toThrow(
      "account_erasure:capture_incomplete",
    );
    expect(bucket.deletions).toStrictEqual([]);
  });

  it("resumes capture across more files than one page", async () => {
    const userId = "user_artifact_" + randomUUID().replaceAll("-", "");
    const keys: string[] = [];
    for (let index = 0; index < 45; index += 1) {
      const key =
        "artifacts/" +
        encodeURIComponent(userId) +
        "/" +
        randomUUID() +
        "/file.txt";
      await fileFor(userId, key);
      keys.push(key);
    }
    const bucket = bucketWithObjects(keys);
    const captured = await capture(userId, true);
    await expect(verify(captured.job.id, captured.handler)).resolves.toBe(46);
    expect(bucket.live.size).toBe(0);
  });
});
