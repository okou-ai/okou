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
import { agentRuns } from "@okouai/db/runtime/agent-run";
import { accountErasureWork } from "@okouai/db/schema/account-erasure";
import { agents } from "@okouai/db/schema/agent";
import { agentSessions } from "@okouai/db/schema/agent-session";
import { agentVncAccess } from "@okouai/db/schema/agent-vnc-access";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { chatThreadVncAccessOverrides } from "@okouai/db/schema/chat-thread-vnc-access-override";
import { vncConnections } from "@okouai/db/schema/vnc-connection";
import { vncCredentials } from "@okouai/db/schema/vnc-credential";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "../account-erasure-selector";
import {
  VNC_DIRECT_ERASURE_COLLECTOR_VERSION,
  createVncDirectErasureCollector,
} from "../account-erasure-vnc-direct-collector";
import { enterVncWrite } from "../vnc-owner-lifecycle.service";

describe("direct VNC credential, connection and in-flight B1", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  const db = drizzle(pool);
  const context = testContext();
  afterAll(async () => {
    await pool.end();
  });

  async function cleanup(userId: string) {
    await db.delete(chatThreads).where(eq(chatThreads.userId, userId));
    await db.delete(agentRuns).where(eq(agentRuns.userId, userId));
    await db.delete(agentSessions).where(eq(agentSessions.userId, userId));
    await db.delete(agentVncAccess).where(eq(agentVncAccess.userId, userId));
    await db.delete(vncConnections).where(eq(vncConnections.userId, userId));
    await db.delete(vncCredentials).where(eq(vncCredentials.userId, userId));
    await db.delete(agents).where(eq(agents.owner, userId));
  }

  async function fixture(orgId: string, userId: string) {
    const agentId = randomUUID();
    const credentialId = randomUUID();
    const connectionId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      orgId,
      owner: userId,
      name: `vnc-${agentId.slice(0, 8)}`,
    });
    await db.insert(agentVncAccess).values({ orgId, userId, agentId });
    await db.insert(vncCredentials).values({
      id: credentialId,
      orgId,
      userId,
      name: "VNC secret",
      authMethod: "vnc_password",
      encryptedPassword: "encrypted-vnc-canary",
    });
    await db.insert(vncConnections).values({
      id: connectionId,
      orgId,
      userId,
      displayName: "direct VNC",
      host: "vnc.example.test",
      credentialId,
      transportType: "direct",
      authMethod: "vnc_password",
      securityType: "x509_vnc",
      trustMode: "system",
    });
    return { agentId, credentialId, connectionId };
  }

  async function addRun(
    orgId: string,
    userId: string,
    agentId: string,
    runnerGroup: string,
  ) {
    const sessionId = randomUUID();
    const runId = randomUUID();
    await db
      .insert(agentSessions)
      .values({ id: sessionId, orgId, userId, agentId });
    await db.insert(agentRuns).values({
      id: runId,
      orgId,
      userId,
      sessionId,
      status: "running",
      prompt: "test",
      runnerGroup,
    });
    return runId;
  }

  async function setup(userId: string) {
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "providers",
      collectorVersion: VNC_DIRECT_ERASURE_COLLECTOR_VERSION,
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
    const handler = createVncDirectErasureCollector(db);
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
        throw new Error("Unbounded direct VNC inventory");
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

  it("captures 1,001 encrypted credentials over bounded pages without a peer's ciphertext", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const peerId = `user_${randomUUID()}`;
    await fixture(orgId, userId);
    const peer = await fixture(orgId, peerId);
    onTestFinished(async () => {
      await cleanup(userId);
      await cleanup(peerId);
    });
    const credentials = Array.from({ length: 1000 }, () => {
      return {
        id: randomUUID(),
        orgId,
        userId,
        name: "extra",
        authMethod: "vnc_password" as const,
        encryptedPassword: "other-encrypted-canary",
      };
    });
    for (let i = 0; i < credentials.length; i += 100) {
      await db.insert(vncCredentials).values(credentials.slice(i, i + 100));
    }
    const { job, pages } = await setup(userId);
    expect(pages).toBeGreaterThan(10);
    const work = await db
      .select()
      .from(accountErasureWork)
      .where(eq(accountErasureWork.jobId, job.id));
    const erase = work.filter((item) => {
      return item.kind === "erase";
    });
    expect(erase).toHaveLength(1003);
    for (const item of erase) {
      expect(item.selectorCiphertext).not.toContain("encrypted-canary");
      expect(item.selectorCiphertext).not.toContain("other-encrypted-canary");
    }
    await expect(
      db
        .select()
        .from(vncCredentials)
        .where(eq(vncCredentials.id, peer.credentialId)),
    ).resolves.toHaveLength(1);
  }, 120_000);

  it("revokes only the target account's grant, cancels captured/current Run groups, and never promotes a vanished catalog row to proof", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const peerId = `user_${randomUUID()}`;
    const target = await fixture(orgId, userId);
    const peer = await fixture(orgId, peerId);
    // A public agent can be used by both accounts; its row and the peer grant survive.
    await db
      .insert(agentVncAccess)
      .values({ orgId, userId, agentId: peer.agentId });
    await db
      .insert(agentVncAccess)
      .values({ orgId, userId: peerId, agentId: target.agentId });
    const capturedGroup = `vnc-b1-${randomUUID()}`;
    const runId = await addRun(orgId, userId, target.agentId, capturedGroup);
    onTestFinished(async () => {
      await cleanup(userId);
      await cleanup(peerId);
    });
    const { job, handler } = await setup(userId);
    await expect(
      db.transaction(async (tx) => {
        return await enterVncWrite(tx, { orgId, userId });
      }),
    ).resolves.toBeFalsy();
    await expect(
      db.transaction(async (tx) => {
        return await enterVncWrite(tx, { orgId, userId: peerId });
      }),
    ).resolves.toBeTruthy();
    const items = await db
      .select()
      .from(accountErasureWork)
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.kind, "erase"),
        ),
      );
    expect(items).toHaveLength(5);
    const selectors = await Promise.all(
      items.map(async (item) => {
        return await decryptErasureSelector({
          ciphertext: item.selectorCiphertext ?? "",
          digest: item.selectorDigest ?? "",
        });
      }),
    );
    expect(
      selectors
        .map((item) => {
          return item.kind === "vnc_direct" && item.resourceType;
        })
        .sort((left, right) => {
          return String(left).localeCompare(String(right));
        }),
    ).toStrictEqual(["connection", "credential", "grant", "grant", "run"]);
    expect(
      selectors.some((item) => {
        return (
          item.kind === "vnc_direct" &&
          item.resourceId === runId &&
          item.runnerGroup === capturedGroup
        );
      }),
    ).toBeTruthy();
    const newGroup = `vnc-b1-${randomUUID()}`;
    await db
      .update(agentRuns)
      .set({ runnerGroup: newGroup })
      .where(eq(agentRuns.id, runId));
    const revision = await sealed(job);
    const leases = await claimErasureWork(db, job.id, "verification", 6);
    const resourceLease = leases.find((lease) => {
      return lease.item.kind === "erase";
    });
    if (!resourceLease) {
      throw new Error("Missing resource lease");
    }
    const forged = await encryptErasureSelector({
      version: 1,
      kind: "vnc_direct",
      orgId,
      userId,
      resourceType: "connection",
      resourceId: peer.connectionId,
      credentialId: peer.credentialId,
      credentialRevision: null,
      credentialDigest: null,
      connectionId: peer.connectionId,
      host: "vnc.example.test",
      port: 5900,
      agentId: null,
      runnerGroup: null,
    });
    await expect(
      handler.erase(
        {
          ...resourceLease,
          item: {
            ...resourceLease.item,
            selectorCiphertext: forged.ciphertext,
            selectorDigest: forged.digest,
          },
        },
        context.signal,
      ),
    ).resolves.toMatchObject({ errorCode: "ownership_unknown" });
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    await expect(
      db.select().from(agentVncAccess).where(eq(agentVncAccess.userId, userId)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(agentVncAccess).where(eq(agentVncAccess.userId, peerId)),
    ).resolves.toHaveLength(2);
    await expect(
      db
        .select()
        .from(vncConnections)
        .where(eq(vncConnections.id, peer.connectionId)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select({ status: agentRuns.status })
        .from(agentRuns)
        .where(eq(agentRuns.id, runId)),
    ).resolves.toStrictEqual([{ status: "cancelled" }]);
    expect(context.mocks.ably.channelGet.mock.calls).toContainEqual([
      `runner-group:${capturedGroup}`,
    ]);
    expect(context.mocks.ably.channelGet.mock.calls).toContainEqual([
      `runner-group:${newGroup}`,
    ]);
    await expect(
      db
        .select()
        .from(accountErasureWork)
        .where(
          and(
            eq(accountErasureWork.jobId, job.id),
            eq(accountErasureWork.state, "capability_unresolved"),
          ),
        ),
    ).resolves.toHaveLength(5);
    await db
      .delete(vncConnections)
      .where(eq(vncConnections.id, target.connectionId));
    await db
      .delete(vncCredentials)
      .where(eq(vncCredentials.id, target.credentialId));
    await db.delete(agentRuns).where(eq(agentRuns.id, runId));
    await expect(
      handler.verify(resourceLease, "post-catalog", context.signal),
    ).resolves.toMatchObject({
      outcome: "capability_unresolved",
      errorCode: "boundary_unproven",
    });
    await expect(finalizeErasureJob(db, job.id, revision)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  }, 60_000);

  it("persists a Runner cancellation 503 and retries the captured locator after backoff", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const { agentId } = await fixture(orgId, userId);
    const capturedGroup = `vnc-retry-${randomUUID()}`;
    const runId = await addRun(orgId, userId, agentId, capturedGroup);
    onTestFinished(async () => {
      await cleanup(userId);
    });
    const { job, handler } = await setup(userId);
    const currentGroup = `vnc-retry-${randomUUID()}`;
    await db
      .update(agentRuns)
      .set({ runnerGroup: currentGroup })
      .where(eq(agentRuns.id, runId));
    await sealed(job);
    let fail = true;
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      return topic === "cancel" && fail
        ? Promise.reject(new Error("503 Service Unavailable"))
        : Promise.resolve();
    });
    const leases = await claimErasureWork(db, job.id, "verification", 5);
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    const failed = await db
      .select()
      .from(accountErasureWork)
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.state, "retryable_failure"),
        ),
      );
    expect(failed).toHaveLength(1);
    fail = false;
    await db
      .update(accountErasureWork)
      .set({ availableAt: new Date("2000-01-01") })
      .where(eq(accountErasureWork.id, failed[0]?.id ?? ""));
    const [retry] = await claimErasureWork(db, job.id, "verification");
    if (!retry) {
      throw new Error("Missing retry");
    }
    await executeErasureWork(
      db,
      retry,
      createVncDirectErasureCollector(db),
      context.signal,
    );
    const [result] = await db
      .select({
        state: accountErasureWork.state,
        errorCode: accountErasureWork.errorCode,
      })
      .from(accountErasureWork)
      .where(eq(accountErasureWork.id, failed[0]?.id ?? ""));
    expect(result).toMatchObject({
      state: "capability_unresolved",
      errorCode: "boundary_unproven",
    });
    expect(context.mocks.ably.channelGet.mock.calls).toContainEqual([
      `runner-group:${capturedGroup}`,
    ]);
    expect(context.mocks.ably.channelGet.mock.calls).toContainEqual([
      `runner-group:${currentGroup}`,
    ]);
  }, 30_000);

  it("refuses a direct connection referenced by another account's thread", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const peerId = `user_${randomUUID()}`;
    const { connectionId } = await fixture(orgId, userId);
    await fixture(orgId, peerId);
    const [thread] = await db
      .insert(chatThreads)
      .values({ userId: peerId })
      .returning({ id: chatThreads.id });
    if (!thread) {
      throw new Error("Missing thread");
    }
    await db
      .insert(chatThreadVncAccessOverrides)
      .values({ chatThreadId: thread.id, connectionId, enabled: true });
    onTestFinished(async () => {
      await cleanup(peerId);
      await cleanup(userId);
    });
    const { job } = await setup(userId);
    const work = await db
      .select()
      .from(accountErasureWork)
      .where(eq(accountErasureWork.jobId, job.id));
    expect(
      work.some((item) => {
        return (
          item.state === "capability_unresolved" &&
          item.errorCode === "ownership_unknown"
        );
      }),
    ).toBeTruthy();
    expect(
      work.some((item) => {
        return item.kind === "erase";
      }),
    ).toBeFalsy();
    await expect(
      db
        .select()
        .from(vncConnections)
        .where(eq(vncConnections.id, connectionId)),
    ).resolves.toHaveLength(1);
  }, 30_000);
});
