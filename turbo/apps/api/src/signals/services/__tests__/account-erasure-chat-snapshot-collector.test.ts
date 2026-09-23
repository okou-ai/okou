import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
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
import { accountErasureWork } from "@okouai/db/schema/account-erasure";
import { chatThreadSnapshots } from "@okouai/db/schema/chat-thread-snapshot";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { encryptErasureSelector } from "../account-erasure-selector";
import {
  CHAT_SNAPSHOT_ERASURE_COLLECTOR_VERSION,
  createChatSnapshotErasureCollector,
} from "../account-erasure-chat-snapshot-collector";
import {
  chatThreadSnapshotObjectKey,
  chatThreadSnapshotObjectPrefix,
  isOwnedChatThreadSnapshotObjectKey,
} from "../chat-thread-snapshot-object";

describe("account erasure chat-thread snapshot object capture", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  const db = drizzle(pool);
  const context = testContext();
  afterAll(async () => {
    await pool.end();
  });

  async function begin(userId: string) {
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
    const handler = createChatSnapshotErasureCollector(db);
    const [inventory] = await claimErasureWork(db, job.id, "inventory");
    if (!inventory) {
      throw new Error("Missing snapshot inventory lease");
    }
    await executeErasureWork(db, inventory, handler, context.signal);
    return { job, handler, inventory };
  }

  it("captures the entire scope before its pointer row disappears and removes >1000 immutable versions", async () => {
    const userId = `snapshot_erasure_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const otherUserId = `snapshot_erasure_${randomUUID()}`;
    const pointerKey = chatThreadSnapshotObjectKey({
      userId,
      orgId,
      latestSeqId: null,
      body: Buffer.from("current"),
    });
    const prefix = chatThreadSnapshotObjectPrefix(userId, orgId);
    const otherKey = chatThreadSnapshotObjectKey({
      userId: otherUserId,
      orgId,
      latestSeqId: null,
      body: Buffer.from("other"),
    });
    const keys = new Set<string>([
      pointerKey,
      ...Array.from({ length: 1000 }, (_, index) => {
        return `${prefix}${(index + 2).toString()}-${"a".repeat(64)}.json.gz`;
      }),
      otherKey,
    ]);
    const batchSizes: number[] = [];
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input =
        command instanceof Object && "input" in command
          ? (command.input as Record<string, unknown>)
          : {};
      switch (command instanceof Object ? command.constructor.name : "") {
        case "ListObjectsV2Command": {
          const found = [...keys].filter((key) => {
            return key.startsWith(String(input.Prefix));
          });
          const limit = Number(input.MaxKeys);
          return Promise.resolve({
            Contents: found.slice(0, limit).map((key) => {
              return {
                Key: key,
                Size: 1,
                LastModified: new Date("2026-01-01T00:00:00Z"),
              };
            }),
            IsTruncated: found.length > limit,
          });
        }
        case "DeleteObjectsCommand": {
          const entries =
            input.Delete instanceof Object && "Objects" in input.Delete
              ? (input.Delete as { Objects: { Key: string }[] }).Objects
              : [];
          batchSizes.push(entries.length);
          for (const entry of entries) {
            keys.delete(entry.Key);
          }
          return Promise.resolve({ Deleted: entries });
        }
        default: {
          return Promise.resolve({});
        }
      }
    });
    await db.insert(chatThreadSnapshots).values({
      userId,
      orgId,
      objectKey: pointerKey,
    });
    onTestFinished(async () => {
      await db
        .delete(chatThreadSnapshots)
        .where(eq(chatThreadSnapshots.userId, userId));
    });
    const [stored] = await db
      .select({
        orgId: chatThreadSnapshots.orgId,
        key: chatThreadSnapshots.objectKey,
        seqId: chatThreadSnapshots.latestEventSeqId,
      })
      .from(chatThreadSnapshots)
      .where(eq(chatThreadSnapshots.userId, userId));
    expect(stored?.key).toBe(pointerKey);
    expect(
      isOwnedChatThreadSnapshotObjectKey(
        stored?.key ?? "",
        userId,
        stored?.orgId ?? "",
        stored?.seqId ?? null,
      ),
    ).toBeTruthy();
    const { job, handler } = await begin(userId);
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
    await db
      .delete(chatThreadSnapshots)
      .where(eq(chatThreadSnapshots.userId, userId));
    const leases = await claimErasureWork(db, job.id, "verification", 2);
    expect(leases).toHaveLength(2);
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    expect(batchSizes).toStrictEqual([1000, 1]);
    expect(keys).toStrictEqual(new Set([otherKey]));
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_erased",
    );
  });

  it("refuses a snapshot pointer outside the owner-derived prefix", async () => {
    const userId = `snapshot_erasure_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const foreign = chatThreadSnapshotObjectKey({
      userId: `other_${randomUUID()}`,
      orgId,
      latestSeqId: 1,
      body: Buffer.from("other"),
    });
    await db.insert(chatThreadSnapshots).values({
      userId,
      orgId,
      objectKey: foreign,
      latestEventSeqId: 1,
    });
    onTestFinished(async () => {
      await db
        .delete(chatThreadSnapshots)
        .where(eq(chatThreadSnapshots.userId, userId));
    });
    const { job, inventory } = await begin(userId);
    const [blocked] = await db
      .select({
        state: accountErasureWork.state,
        errorCode: accountErasureWork.errorCode,
      })
      .from(accountErasureWork)
      .where(eq(accountErasureWork.id, inventory.workId));
    expect(blocked).toMatchObject({
      state: "capability_unresolved",
      errorCode: "ownership_unknown",
    });
    const remaining = await db
      .select({ id: accountErasureWork.id })
      .from(accountErasureWork)
      .where(eq(accountErasureWork.jobId, job.id));
    expect(remaining).toHaveLength(1);
  });
});
