/* eslint-disable no-restricted-syntax -- The hash coordination protocol is exercised at the database and S3 boundaries. */
import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";
// The exact-hash PostgreSQL/S3 interleaving cannot be selected through a product endpoint.
// eslint-disable-next-line no-restricted-imports
import { reserveBlobUploadIntent } from "../blob-upload-intent.service";
// eslint-disable-next-line no-restricted-imports
import { eraseUnreferencedSharedBlob } from "../shared-blob-erasure.service";

describe("content-addressed blob erasure coordination", () => {
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.searchParams.set(
    "application_name",
    `erasure_blob_${randomUUID()}`,
  );
  const pool = new Pool({ connectionString: databaseUrl.toString(), max: 8 });
  const db = drizzle(pool);
  const context = testContext();

  afterAll(async () => {
    await pool.end();
  });

  function hash(): string {
    return createHash("sha256").update(randomUUID()).digest("hex");
  }

  async function blob(refCount = 0) {
    const value = hash();
    await pool.query(
      "INSERT INTO blobs (hash, raw_size, encoding, encoded_size, ref_count, erasure_eligible_at) VALUES ($1, 4, 'identity', 4, $2, clock_timestamp() - interval '1 hour')",
      [value, refCount],
    );
    onTestFinished(async () => {
      await pool.query("DELETE FROM blob_upload_intents WHERE hash = $1", [
        value,
      ]);
      await pool.query("DELETE FROM blobs WHERE hash = $1", [value]);
    });
    return value;
  }

  function bucket(keys: readonly string[], pauseDelete?: () => Promise<void>) {
    const live = new Set(keys);
    const deleted: string[] = [];
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      const input =
        command instanceof Object && "input" in command
          ? (command as { input: Record<string, unknown> }).input
          : {};
      if (
        command instanceof Object &&
        command.constructor.name === "HeadObjectCommand"
      ) {
        if (live.has(String(input.Key))) {
          return { ContentLength: 4 };
        }
        throw Object.assign(new Error("absent"), { name: "NoSuchKey" });
      }
      if (
        command instanceof Object &&
        command.constructor.name === "DeleteObjectsCommand"
      ) {
        if (pauseDelete) {
          await pauseDelete();
        }
        const objects =
          input.Delete instanceof Object && "Objects" in input.Delete
            ? (input.Delete as { Objects: { Key: string }[] }).Objects
            : [];
        for (const object of objects) {
          live.delete(object.Key);
          deleted.push(object.Key);
        }
      }
      return {};
    });
    return { live, deleted };
  }

  it("holds zero-reference bytes through a pending upload URL, then removes all encodings", async () => {
    const value = await blob();
    const key = `blobs/${value}.blob`;
    const objects = bucket([key, `blobs/${value}.blob.gz`]);
    await db.transaction(async (tx) => {
      await reserveBlobUploadIntent(tx, { hash: value, runId: randomUUID() });
    });
    await expect(
      eraseUnreferencedSharedBlob(db, value, context.signal),
    ).resolves.toStrictEqual({ outcome: "pending", reason: "upload_intent" });
    expect(objects.live.has(key)).toBeTruthy();
    await pool.query(
      "UPDATE blob_upload_intents SET expires_at = clock_timestamp() - interval '1 second' WHERE hash = $1",
      [value],
    );
    await expect(
      eraseUnreferencedSharedBlob(db, value, context.signal),
    ).resolves.toStrictEqual({ outcome: "erased" });
    expect(objects.live.size).toBe(0);
    expect(objects.deleted).toHaveLength(3);
    await expect(
      eraseUnreferencedSharedBlob(db, value, context.signal),
    ).resolves.toStrictEqual({ outcome: "absent" });
  });

  it("keeps bytes when a surviving account holds a reference", async () => {
    const value = await blob(1);
    const key = `blobs/${value}.blob`;
    const objects = bucket([key]);
    await expect(
      eraseUnreferencedSharedBlob(db, value, context.signal),
    ).resolves.toStrictEqual({ outcome: "shared" });
    expect(objects.live.has(key)).toBeTruthy();
    expect(objects.deleted).toStrictEqual([]);
  });

  it("replays a durable pending claim after a failed object deletion", async () => {
    const value = await blob();
    const key = `blobs/${value}.blob`;
    const objects = bucket([key]);
    const originalSend = context.mocks.s3.send.getMockImplementation();
    let failed = false;
    context.mocks.s3.send.mockImplementation(async (command: unknown) => {
      if (
        !failed &&
        command instanceof Object &&
        command.constructor.name === "DeleteObjectsCommand"
      ) {
        failed = true;
        throw new Error("object deletion interrupted");
      }
      return await originalSend?.(command);
    });
    await expect(
      eraseUnreferencedSharedBlob(db, value, context.signal),
    ).rejects.toThrow("object deletion interrupted");
    const pending = await pool.query<{ erasure_pending: boolean }>(
      "SELECT erasure_pending FROM blobs WHERE hash = $1",
      [value],
    );
    expect(pending.rows[0]?.erasure_pending).toBe(true);
    expect(objects.live.has(key)).toBeTruthy();
    await expect(
      eraseUnreferencedSharedBlob(db, value, context.signal),
    ).resolves.toStrictEqual({ outcome: "erased" });
    expect(objects.live.has(key)).toBeFalsy();
  });

  it("serializes a new uploader with deletion and rejects its stale retain", async () => {
    const value = await blob();
    const key = `blobs/${value}.blob`;
    const deleting = createDeferredPromise<void>(context.signal);
    const continueDelete = createDeferredPromise<void>(context.signal);
    const objects = bucket([key], async () => {
      deleting.resolve();
      await continueDelete.promise;
    });
    const erasure = eraseUnreferencedSharedBlob(db, value, context.signal);
    await deleting.promise;
    try {
      await expect(
        db.transaction(async (tx) => {
          await reserveBlobUploadIntent(tx, {
            hash: value,
            runId: randomUUID(),
          });
        }),
      ).rejects.toThrow("Session history blob is being erased");
      await expect(
        pool.query("UPDATE blobs SET ref_count = 1 WHERE hash = $1", [value]),
      ).rejects.toThrow();
    } finally {
      continueDelete.resolve();
    }
    await expect(erasure).resolves.toStrictEqual({ outcome: "erased" });
    expect(objects.live.has(key)).toBeFalsy();
  });
});
