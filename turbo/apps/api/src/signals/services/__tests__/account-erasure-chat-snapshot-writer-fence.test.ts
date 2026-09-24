import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, type SQL } from "drizzle-orm";
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
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { createDeferredPromise } from "../../utils";
import type { Db } from "../../external/db";
import { encryptErasureSelector } from "../account-erasure-selector";
import {
  CHAT_SNAPSHOT_ERASURE_COLLECTOR_VERSION,
  createChatSnapshotErasureCollector,
} from "../account-erasure-chat-snapshot-collector";
import { chatThreadSnapshotObjectPrefix } from "../chat-thread-snapshot-object";
import { compactChatThreadSnapshotsForScope } from "../cron-compact-chat-thread-snapshots.service";

describe("chat snapshot writer and erasure closure", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 5 });
  const db = drizzle(pool);
  const context = testContext();
  afterAll(async () => {
    await pool.end();
  });

  async function capture(userId: string) {
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "objects",
      collectorVersion: CHAT_SNAPSHOT_ERASURE_COLLECTOR_VERSION,
      selector: await encryptErasureSelector({
        version: 1,
        kind: "subject",
        subjectKind: "user",
        subjectId: userId,
      }),
      dependencies: [],
    };
    const projected = await projectErasureDecision(db, {
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
    const job = await reviseErasureInventory(db, projected.id, projected, [
      sink,
    ]);
    const handler = createChatSnapshotErasureCollector(db);
    const [inventory] = await claimErasureWork(db, job.id, "inventory");
    if (!inventory) {
      throw new Error("Missing snapshot inventory lease");
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
    return { job, sealed, handler };
  }

  function mockStorage(bytes: Map<string, Buffer>, stale: Date) {
    const storage = {
      upload: (key: string, body: Buffer) => {
        bytes.set(key, body);
        return Promise.resolve();
      },
      list: () => {
        throw new Error("Fixture-scoped compaction must not run global GC");
      },
      delete: () => {
        throw new Error("Fixture-scoped compaction must not run global GC");
      },
    };
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input =
        command instanceof Object && "input" in command
          ? (command.input as Record<string, unknown>)
          : {};
      if (
        command instanceof Object &&
        command.constructor.name === "ListObjectsV2Command"
      ) {
        const contents = [...bytes.keys()]
          .filter((key) => {
            return key.startsWith(String(input.Prefix));
          })
          .map((key) => {
            return { Key: key, Size: 1, LastModified: stale };
          });
        return Promise.resolve({ Contents: contents, IsTruncated: false });
      }
      if (
        command instanceof Object &&
        command.constructor.name === "DeleteObjectsCommand"
      ) {
        const entries = (input.Delete as { Objects: { Key: string }[] })
          .Objects;
        for (const entry of entries) {
          bytes.delete(entry.Key);
        }
        return Promise.resolve({ Deleted: entries });
      }
      return Promise.resolve({});
    });
    return storage;
  }

  it("rejects a prepared candidate resumed after captured erasure and leaves another owner writable", async () => {
    const userId = `snapshot_race_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const otherUserId = `snapshot_race_${randomUUID()}`;
    const otherOrgId = `org_${randomUUID()}`;
    const stale = new Date("2020-01-01T00:00:00Z");
    await db.insert(chatThreadSnapshots).values([
      { userId, orgId, updatedAt: stale },
      { userId: otherUserId, orgId: otherOrgId, updatedAt: stale },
    ]);
    onTestFinished(async () => {
      await db
        .delete(chatThreadSnapshots)
        .where(eq(chatThreadSnapshots.userId, userId));
      await db
        .delete(chatThreadSnapshots)
        .where(eq(chatThreadSnapshots.userId, otherUserId));
    });

    const bytes = new Map<string, Buffer>();
    const storage = mockStorage(bytes, stale);

    // Synchronize precisely after candidate SELECT resolves but before the
    // compressor can seek D1 admission. No production test hook is required.
    const selected = createDeferredPromise<void>(context.signal);
    const resume = createDeferredPromise<void>(context.signal);
    onTestFinished(() => {
      if (!resume.settled()) {
        resume.resolve(undefined);
      }
    });
    let firstQuery = true;
    const pausedDb: Db = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "execute") {
          return Reflect.get(target, property, receiver);
        }
        return (query: SQL) => {
          const result = target.execute(query);
          if (!firstQuery) {
            return result;
          }
          firstQuery = false;
          return (async () => {
            const rows = await result;
            selected.resolve(undefined);
            await resume.promise;
            return rows;
          })();
        };
      },
    });
    const compaction = compactChatThreadSnapshotsForScope(
      pausedDb,
      { kind: "fixtures", scopes: [{ userId, orgId }] },
      storage,
      context.signal,
    );
    await selected.promise;
    const { job, sealed, handler } = await capture(userId);
    await db
      .delete(chatThreadSnapshots)
      .where(eq(chatThreadSnapshots.userId, userId));
    const leases = await claimErasureWork(db, job.id, "verification", 2);
    expect(leases).toHaveLength(2);
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_erased",
    );
    resume.resolve(undefined);
    await expect(compaction).rejects.toThrow("account_erasure:subject_closed");
    expect(
      [...bytes.keys()].filter((key) => {
        return key.startsWith(chatThreadSnapshotObjectPrefix(userId, orgId));
      }),
    ).toStrictEqual([]);
    const rows = await db
      .select({ key: chatThreadSnapshots.objectKey })
      .from(chatThreadSnapshots)
      .where(eq(chatThreadSnapshots.userId, userId));
    expect(rows).toStrictEqual([]);

    const peer = await compactChatThreadSnapshotsForScope(
      db,
      {
        kind: "fixtures",
        scopes: [
          { userId, orgId },
          { userId: otherUserId, orgId: otherOrgId },
        ],
      },
      storage,
      context.signal,
    );
    expect(peer.scopes).toBe(1);
    const [otherPointer] = await db
      .select({ key: chatThreadSnapshots.objectKey })
      .from(chatThreadSnapshots)
      .where(eq(chatThreadSnapshots.userId, otherUserId));
    expect(otherPointer?.key).toSatisfy((key: string) => {
      return (
        key.startsWith(
          chatThreadSnapshotObjectPrefix(otherUserId, otherOrgId),
        ) && bytes.has(key)
      );
    });
  });

  it("holds the user fence through an in-flight PUT and lets B1 erase the published byte", async () => {
    const userId = `snapshot_race_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const stale = new Date("2020-01-01T00:00:00Z");
    await db
      .insert(chatThreadSnapshots)
      .values({ userId, orgId, updatedAt: stale });
    onTestFinished(async () => {
      await db
        .delete(chatThreadSnapshots)
        .where(eq(chatThreadSnapshots.userId, userId));
    });
    const bytes = new Map<string, Buffer>();
    const baseStorage = mockStorage(bytes, stale);
    const uploading = createDeferredPromise<void>(context.signal);
    const resume = createDeferredPromise<void>(context.signal);
    const storage = {
      ...baseStorage,
      upload: async (key: string, body: Buffer) => {
        uploading.resolve(undefined);
        await resume.promise;
        bytes.set(key, body);
      },
    };
    onTestFinished(() => {
      if (!resume.settled()) {
        resume.resolve(undefined);
      }
    });
    const compaction = compactChatThreadSnapshotsForScope(
      db,
      { kind: "fixtures", scopes: [{ userId, orgId }] },
      storage,
      context.signal,
    );
    await uploading.promise;
    const closing = capture(userId);
    // The closure cannot commit while the exact user/org shared admission
    // protects a PUT that has already begun. Observe its PostgreSQL waiter,
    // rather than sleeping and guessing whether the race was reached.
    await expect
      .poll(
        async () => {
          const result = await pool.query(
            "SELECT count(*)::int AS count FROM pg_stat_activity WHERE wait_event = 'advisory' AND query LIKE '%erasure_isolation_probe%'",
          );
          return Number(result.rows[0]?.count ?? 0);
        },
        { timeout: 10_000 },
      )
      .toBeGreaterThan(0);
    resume.resolve(undefined);
    expect((await compaction).scopes).toBe(1);
    const { job, sealed, handler } = await closing;
    const [pointer] = await db
      .select({ key: chatThreadSnapshots.objectKey })
      .from(chatThreadSnapshots)
      .where(eq(chatThreadSnapshots.userId, userId));
    expect(pointer?.key).toSatisfy((key: string) => {
      return bytes.has(key);
    });
    await db
      .delete(chatThreadSnapshots)
      .where(eq(chatThreadSnapshots.userId, userId));
    const leases = await claimErasureWork(db, job.id, "verification", 2);
    expect(leases).toHaveLength(2);
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_erased",
    );
    expect(
      [...bytes.keys()].filter((key) => {
        return key.startsWith(chatThreadSnapshotObjectPrefix(userId, orgId));
      }),
    ).toStrictEqual([]);
  });
});
