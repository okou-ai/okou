import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
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
  yieldErasureLease,
  type ErasureSink,
} from "@okouai/db/operations/account-erasure";
import { accountErasureWork } from "@okouai/db/schema/account-erasure";
import {
  computerUseCommands,
  computerUseHosts,
} from "@okouai/db/schema/computer-use-host";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { encryptErasureSelector } from "../account-erasure-selector";
import {
  COMPUTER_USE_ERASURE_COLLECTOR_VERSION,
  createComputerUseErasureCollector,
} from "../account-erasure-computer-use-collector";

describe("Computer Use remote/in-flight B1 capture", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  const db = drizzle(pool);
  const context = testContext();
  afterAll(async () => {
    return await pool.end();
  });

  async function setup(userId: string) {
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "providers",
      collectorVersion: COMPUTER_USE_ERASURE_COLLECTOR_VERSION,
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
    const handler = createComputerUseErasureCollector(db);
    let pages = 0;
    for (;;) {
      const [lease] = await claimErasureWork(db, job.id, "inventory");
      if (!lease) {
        break;
      }
      await executeErasureWork(db, lease, handler, context.signal);
      await yieldErasureLease(db, lease);
      pages += 1;
      if (pages > 100) {
        throw new Error("Unbounded Computer Use inventory");
      }
    }
    return { job, handler, pages };
  }

  async function sealed(job: Awaited<ReturnType<typeof setup>>["job"]) {
    return await sealErasureCapture(
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
  }

  function objectMock(keys: Set<string>, failOnce = false) {
    let failure = failOnce;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input =
        command instanceof Object && "input" in command
          ? (command.input as Record<string, unknown>)
          : {};
      if (
        command instanceof Object &&
        command.constructor.name === "ListObjectsV2Command"
      ) {
        if (failure) {
          failure = false;
          return Promise.reject(new Error("503 Service Unavailable"));
        }
        const found = [...keys].filter((key) => {
          return key.startsWith(String(input.Prefix));
        });
        const limit = Number(input.MaxKeys);
        return Promise.resolve({
          Contents: found.slice(0, limit).map((key) => {
            return { Key: key, Size: 1, LastModified: nowDate() };
          }),
          IsTruncated: found.length > limit,
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
        for (const { Key } of objects) {
          keys.delete(Key);
        }
        return Promise.resolve({ Deleted: objects });
      }
      return Promise.resolve({});
    });
  }

  function host(orgId: string, userId: string) {
    return {
      id: randomUUID(),
      orgId,
      userId,
      tokenHash: randomUUID(),
      displayName: "erasure host",
      appVersion: "1.0",
      osVersion: "macOS",
    };
  }

  async function cleanup(userId: string) {
    await db
      .delete(computerUseCommands)
      .where(eq(computerUseCommands.userId, userId));
    await db
      .delete(computerUseHosts)
      .where(eq(computerUseHosts.userId, userId));
  }

  it("persists all 1,001 command locators across pages and does not touch another account", async () => {
    const userId = `computer_erasure_${randomUUID()}`;
    const peerId = `computer_erasure_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const ownerHost = host(orgId, userId);
    const peerHost = host(orgId, peerId);
    await db.insert(computerUseHosts).values([ownerHost, peerHost]);
    onTestFinished(async () => {
      await cleanup(userId);
      await cleanup(peerId);
    });
    const rows = Array.from({ length: 1001 }, () => {
      return {
        id: randomUUID(),
        orgId,
        userId,
        hostId: ownerHost.id,
        kind: "app.state",
        timeoutMs: 60_000,
        status: "succeeded",
      };
    });
    await db.insert(computerUseCommands).values(rows);
    const [peerCommand] = await db
      .insert(computerUseCommands)
      .values({
        orgId,
        userId: peerId,
        hostId: peerHost.id,
        kind: "app.state",
        timeoutMs: 60_000,
        status: "succeeded",
      })
      .returning({ id: computerUseCommands.id });
    const { job, pages } = await setup(userId);
    expect(pages).toBeGreaterThan(10);
    const items = await db
      .select({
        key: accountErasureWork.itemKey,
        kind: accountErasureWork.kind,
      })
      .from(accountErasureWork)
      .where(eq(accountErasureWork.jobId, job.id));
    expect(
      items.filter((item) => {
        return item.kind === "erase";
      }),
    ).toHaveLength(1002);
    await expect(
      db
        .select()
        .from(computerUseCommands)
        .where(eq(computerUseCommands.id, peerCommand?.id ?? "")),
    ).resolves.toHaveLength(1);
  }, 120_000);

  it("revokes server host access, retries storage 503 after restart, and retains Desktop/in-flight residuals after catalog loss", async () => {
    const userId = `computer_erasure_${randomUUID()}`;
    const peerId = `computer_erasure_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const ownerHost = host(orgId, userId);
    const peerHost = host(orgId, peerId);
    await db.insert(computerUseHosts).values([ownerHost, peerHost]);
    onTestFinished(async () => {
      await cleanup(userId);
      await cleanup(peerId);
    });
    const [running] = await db
      .insert(computerUseCommands)
      .values({
        orgId,
        userId,
        hostId: ownerHost.id,
        kind: "app.state",
        timeoutMs: 60_000,
        status: "running",
      })
      .returning({ id: computerUseCommands.id });
    if (!running) {
      throw new Error("Missing command");
    }
    const prefix = `computer-use/${orgId}/${userId}/${running.id}/`;
    const object = `${prefix}screenshot.png`;
    const otherKey = `computer-use/${orgId}/${peerId}/${randomUUID()}/screenshot.png`;
    const keys = new Set([object, otherKey]);
    objectMock(keys, true);
    const { job, handler } = await setup(userId);
    const revision = await sealed(job);
    const firstPass = await claimErasureWork(db, job.id, "verification", 3);
    for (const lease of firstPass) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    let states = await db
      .select({ state: accountErasureWork.state })
      .from(accountErasureWork)
      .where(eq(accountErasureWork.jobId, job.id));
    expect(
      states.some((item) => {
        return item.state === "retryable_failure";
      }),
    ).toBeTruthy();
    expect(
      (
        await db
          .select({ revokedAt: computerUseHosts.revokedAt })
          .from(computerUseHosts)
          .where(eq(computerUseHosts.id, ownerHost.id))
      )[0]?.revokedAt,
    ).toBeInstanceOf(Date);
    await expect(
      db
        .select({ status: computerUseCommands.status })
        .from(computerUseCommands)
        .where(eq(computerUseCommands.id, running.id)),
    ).resolves.toStrictEqual([{ status: "failed" }]);
    expect(
      (
        await db
          .select({ revokedAt: computerUseHosts.revokedAt })
          .from(computerUseHosts)
          .where(eq(computerUseHosts.id, peerHost.id))
      )[0]?.revokedAt,
    ).toBeNull();
    // Restart with only durable B1 selectors; the live command/host rows may
    // have been removed by relational sweep before verification resumes.
    await db
      .delete(computerUseCommands)
      .where(eq(computerUseCommands.userId, userId));
    await db
      .delete(computerUseHosts)
      .where(eq(computerUseHosts.userId, userId));
    // Advance only this fixture's persisted retry schedule, as a later
    // worker invocation would after the bounded backoff expires.
    await db
      .update(accountErasureWork)
      .set({ availableAt: new Date("2000-01-01T00:00:00Z") })
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.state, "retryable_failure"),
        ),
      );
    const [retry] = await claimErasureWork(db, job.id, "verification");
    if (!retry) {
      throw new Error("Missing retry");
    }
    await executeErasureWork(
      db,
      retry,
      createComputerUseErasureCollector(db),
      context.signal,
    );
    states = await db
      .select({ state: accountErasureWork.state })
      .from(accountErasureWork)
      .where(eq(accountErasureWork.jobId, job.id));
    expect(
      states.some((item) => {
        return item.state === "capability_unresolved";
      }),
    ).toBeTruthy();
    expect(keys).toStrictEqual(new Set([otherKey]));
    await expect(finalizeErasureJob(db, job.id, revision)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  }, 30_000);

  it("does not treat a successful DELETE response as proof when LIST still sees command bytes", async () => {
    const userId = `computer_erasure_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const commandId = randomUUID();
    // Commands always name a host, so the subject's host is erased too.
    const ownerHost = host(orgId, userId);
    await db.insert(computerUseHosts).values(ownerHost);
    await db.insert(computerUseCommands).values({
      id: commandId,
      orgId,
      userId,
      hostId: ownerHost.id,
      kind: "app.state",
      status: "queued",
      timeoutMs: 60_000,
    });
    onTestFinished(async () => {
      await cleanup(userId);
    });
    const key = `computer-use/${orgId}/${userId}/${commandId}/plugin-content.txt`;
    context.mocks.s3.send.mockImplementation((command: unknown) => {
      const input =
        command instanceof Object && "input" in command
          ? (command.input as Record<string, unknown>)
          : {};
      if (
        command instanceof Object &&
        command.constructor.name === "ListObjectsV2Command"
      ) {
        return Promise.resolve({
          Contents:
            String(input.Prefix) ===
            `computer-use/${orgId}/${userId}/${commandId}/`
              ? [{ Key: key, Size: 1, LastModified: nowDate() }]
              : [],
          IsTruncated: false,
        });
      }
      if (
        command instanceof Object &&
        command.constructor.name === "DeleteObjectsCommand"
      ) {
        return Promise.resolve({ Deleted: [{ Key: key }] });
      }
      return Promise.resolve({});
    });
    const { job, handler } = await setup(userId);
    const revision = await sealed(job);
    await db
      .delete(computerUseCommands)
      .where(eq(computerUseCommands.id, commandId));
    const leases = await claimErasureWork(db, job.id, "verification", 3);
    if (leases.length < 2) {
      throw new Error("Missing command work");
    }
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    const works = await db
      .select({
        state: accountErasureWork.state,
        errorCode: accountErasureWork.errorCode,
      })
      .from(accountErasureWork)
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.kind, "erase"),
        ),
      );
    expect(works).toContainEqual({
      state: "retryable_failure",
      errorCode: "verification_failed",
    });
    await expect(finalizeErasureJob(db, job.id, revision)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  });

  it("refuses a cross-account reference to a host before revoking its credential", async () => {
    const userId = `computer_erasure_${randomUUID()}`;
    const peerId = `computer_erasure_${randomUUID()}`;
    const orgId = `org_${randomUUID()}`;
    const ownerHost = host(orgId, userId);
    await db.insert(computerUseHosts).values(ownerHost);
    await db.insert(computerUseCommands).values({
      orgId,
      userId: peerId,
      hostId: ownerHost.id,
      kind: "app.state",
      timeoutMs: 60_000,
    });
    onTestFinished(async () => {
      await cleanup(peerId);
      await cleanup(userId);
    });
    const { job } = await setup(userId);
    const [inventory] = await db
      .select({
        state: accountErasureWork.state,
        errorCode: accountErasureWork.errorCode,
      })
      .from(accountErasureWork)
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.kind, "inventory"),
        ),
      );
    expect(inventory).toMatchObject({
      state: "capability_unresolved",
      errorCode: "ownership_unknown",
    });
    expect(
      (
        await db
          .select({ revokedAt: computerUseHosts.revokedAt })
          .from(computerUseHosts)
          .where(eq(computerUseHosts.id, ownerHost.id))
      )[0]?.revokedAt,
    ).toBeNull();
  });
});
