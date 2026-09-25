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
import { agentSshAccess } from "@okouai/db/schema/agent-ssh-access";
import { cloudflareAccessConfigs } from "@okouai/db/schema/cloudflare-access-config";
import { sshConnections } from "@okouai/db/schema/ssh-connection";
import { sshCredentials } from "@okouai/db/schema/ssh-credential";
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
  SSH_REMOTE_ERASURE_COLLECTOR_VERSION,
  createSshRemoteErasureCollector,
} from "../account-erasure-ssh-remote-collector";

describe("SSH connection, encrypted credential and in-flight remote B1", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  const db = drizzle(pool);
  const context = testContext();
  afterAll(async () => {
    return await pool.end();
  });

  async function cleanup(userId: string) {
    await db.delete(vncConnections).where(eq(vncConnections.userId, userId));
    await db.delete(vncCredentials).where(eq(vncCredentials.userId, userId));
    await db.delete(agentRuns).where(eq(agentRuns.userId, userId));
    await db.delete(agentSessions).where(eq(agentSessions.userId, userId));
    await db.delete(agentSshAccess).where(eq(agentSshAccess.userId, userId));
    await db.delete(sshConnections).where(eq(sshConnections.userId, userId));
    await db.delete(sshCredentials).where(eq(sshCredentials.userId, userId));
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
      name: `ssh-${agentId.slice(0, 8)}`,
    });
    await db.insert(agentSshAccess).values({ orgId, userId, agentId });
    await db.insert(sshCredentials).values({
      id: credentialId,
      orgId,
      userId,
      name: "ssh key",
      username: "deploy",
      authMethod: "private_key",
      encryptedPrivateKey: "encrypted-canary-not-plaintext",
    });
    await db.insert(sshConnections).values({
      id: connectionId,
      orgId,
      userId,
      displayName: "remote host",
      host: "ssh.example.test",
      credentialId,
    });
    return { agentId, credentialId, connectionId };
  }

  async function setup(userId: string) {
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "providers",
      collectorVersion: SSH_REMOTE_ERASURE_COLLECTOR_VERSION,
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
    const handler = createSshRemoteErasureCollector(db);
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
        throw new Error("Unbounded SSH inventory");
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

  it("persists 1,001 encrypted credential locators across pages without capturing ciphertext or a peer", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const peerId = `user_${randomUUID()}`;
    const target = await fixture(orgId, userId);
    await fixture(orgId, peerId);
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
        username: "deploy",
        authMethod: "private_key" as const,
        encryptedPrivateKey: "another-ciphertext-canary",
      };
    });
    for (let i = 0; i < credentials.length; i += 100) {
      await db.insert(sshCredentials).values(credentials.slice(i, i + 100));
    }
    const { job, pages } = await setup(userId);
    expect(pages).toBeGreaterThan(10);
    const rows = await db
      .select()
      .from(accountErasureWork)
      .where(eq(accountErasureWork.jobId, job.id));
    expect(
      rows.filter((row) => {
        return row.kind === "erase";
      }),
    ).toHaveLength(1002);
    const captured = rows.find((row) => {
      return row.itemKey !== null && row.selectorCiphertext;
    });
    expect(captured).toBeDefined();
    for (const row of rows) {
      if (row.selectorCiphertext) {
        expect(row.selectorCiphertext).not.toContain("ciphertext-canary");
      }
    }
    expect(target.credentialId).toBeTruthy();
  }, 120_000);

  it("revokes only the subject's grants, captures SSH/VNC and active Run locators, and retains remote residual after catalog loss", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const peerId = `user_${randomUUID()}`;
    const target = await fixture(orgId, userId);
    const peer = await fixture(orgId, peerId);
    const sharedAccessId = randomUUID();
    await db.insert(cloudflareAccessConfigs).values({
      id: sharedAccessId,
      orgId,
      userId: null,
      scope: "organization",
      name: "shared tunnel",
      encryptedClientId: "encrypted-client-id",
      encryptedClientSecret: "encrypted-client-secret",
    });
    await db
      .update(sshConnections)
      .set({
        port: 443,
        cloudflareAccessId: sharedAccessId,
      })
      .where(eq(sshConnections.id, target.connectionId));
    await db
      .update(sshConnections)
      .set({
        port: 443,
        cloudflareAccessId: sharedAccessId,
      })
      .where(eq(sshConnections.id, peer.connectionId));
    const vncCredentialId = randomUUID();
    const vncId = randomUUID();
    const sessionId = randomUUID();
    const runId = randomUUID();
    const capturedGroup = `ssh-b1-${randomUUID()}`;
    await db.insert(vncCredentials).values({
      id: vncCredentialId,
      orgId,
      userId,
      name: "vnc",
      authMethod: "vnc_password",
      encryptedPassword: "encrypted-vnc",
    });
    await db.insert(vncConnections).values({
      id: vncId,
      orgId,
      userId,
      displayName: "tunnel",
      host: "127.0.0.1",
      transportType: "ssh",
      sshConnectionId: target.connectionId,
      credentialId: vncCredentialId,
      authMethod: "vnc_password",
      securityType: "x509_vnc",
      trustMode: "system",
    });
    await db
      .insert(agentSessions)
      .values({ id: sessionId, orgId, userId, agentId: target.agentId });
    await db.insert(agentRuns).values({
      id: runId,
      orgId,
      userId,
      sessionId,
      status: "running",
      prompt: "test",
      runnerGroup: capturedGroup,
    });
    onTestFinished(async () => {
      await cleanup(userId);
      await cleanup(peerId);
      await db
        .delete(cloudflareAccessConfigs)
        .where(eq(cloudflareAccessConfigs.id, sharedAccessId));
    });
    const { job, handler } = await setup(userId);
    const items = await db
      .select()
      .from(accountErasureWork)
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.kind, "erase"),
        ),
      );
    expect(items).toHaveLength(4);
    const selectors = await Promise.all(
      items.map((item) => {
        return decryptErasureSelector({
          ciphertext: item.selectorCiphertext ?? "",
          digest: item.selectorDigest ?? "",
        });
      }),
    );
    expect(
      selectors
        .map((item) => {
          return item.kind === "ssh_remote" && item.resourceType;
        })
        .sort(),
    ).toStrictEqual(["connection", "credential", "run", "vnc_link"]);
    expect(
      selectors.some((item) => {
        return item.kind === "ssh_remote" && item.resourceId === vncId;
      }),
    ).toBeTruthy();
    expect(
      selectors.some((item) => {
        return item.kind === "ssh_remote" && item.resourceId === runId;
      }),
    ).toBeTruthy();
    expect(
      selectors.some((item) => {
        return (
          item.kind === "ssh_remote" &&
          item.cloudflareAccessId === sharedAccessId
        );
      }),
    ).toBeTruthy();
    const newGroup = `ssh-b1-${randomUUID()}`;
    await db
      .update(agentRuns)
      .set({ runnerGroup: newGroup })
      .where(eq(agentRuns.id, runId));
    const revision = await sealed(job);
    const leases = await claimErasureWork(db, job.id, "verification", 5);
    // A selector referring to another owner's resource must not revoke that
    // owner, even when both people use the same organization and Access config.
    const anyResourceLease = leases.find((lease) => {
      return lease.item.kind === "erase";
    });
    if (!anyResourceLease) {
      throw new Error("missing resource lease");
    }
    const forged = await encryptErasureSelector({
      version: 1,
      kind: "ssh_remote",
      userId,
      orgId,
      resourceType: "connection",
      resourceId: peer.connectionId,
      credentialId: peer.credentialId,
      credentialRevision: null,
      credentialDigest: null,
      connectionId: peer.connectionId,
      host: "ssh.example.test",
      port: 443,
      cloudflareAccessId: sharedAccessId,
      runnerGroup: null,
    });
    await expect(
      handler.erase(
        {
          ...anyResourceLease,
          item: {
            ...anyResourceLease.item,
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
      db.select().from(agentSshAccess).where(eq(agentSshAccess.userId, userId)),
    ).resolves.toHaveLength(0);
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
      db.select().from(agentSshAccess).where(eq(agentSshAccess.userId, peerId)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(sshConnections)
        .where(eq(sshConnections.id, peer.connectionId)),
    ).resolves.toHaveLength(1);
    await expect(
      db
        .select()
        .from(cloudflareAccessConfigs)
        .where(eq(cloudflareAccessConfigs.id, sharedAccessId)),
    ).resolves.toHaveLength(1);
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
    ).resolves.toHaveLength(4);
    // Simulate downstream relational sweep: the encrypted selector still
    // diagnoses live remote sessions even with the catalog rows absent.
    await db.delete(vncConnections).where(eq(vncConnections.id, vncId));
    await db
      .delete(vncCredentials)
      .where(eq(vncCredentials.id, vncCredentialId));
    await db
      .delete(sshConnections)
      .where(eq(sshConnections.id, target.connectionId));
    await db
      .delete(sshCredentials)
      .where(eq(sshCredentials.id, target.credentialId));
    const lease = leases.find((entry) => {
      return entry.item.selectorCiphertext && entry.item.kind === "erase";
    });
    if (!lease) {
      throw new Error("missing resource lease");
    }
    await expect(
      handler.verify(lease, "test-readback", context.signal),
    ).resolves.toMatchObject({
      outcome: "capability_unresolved",
      errorCode: "boundary_unproven",
    });
    await expect(finalizeErasureJob(db, job.id, revision)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  }, 60_000);

  it("persists transient publication failure and retries the same B1 selector", async () => {
    const orgId = `org_${randomUUID()}`;
    const userId = `user_${randomUUID()}`;
    const { agentId } = await fixture(orgId, userId);
    const sessionId = randomUUID();
    await db
      .insert(agentSessions)
      .values({ id: sessionId, orgId, userId, agentId });
    await db.insert(agentRuns).values({
      orgId,
      userId,
      sessionId,
      status: "running",
      prompt: "test",
      runnerGroup: `ssh-retry-${randomUUID()}`,
    });
    onTestFinished(async () => {
      return await cleanup(userId);
    });
    const { job, handler } = await setup(userId);
    await sealed(job);
    let fail = true;
    context.mocks.ably.publish.mockImplementation((topic: unknown) => {
      return topic === "ssh-authority-invalidated" && fail
        ? Promise.reject(new Error("503 Service Unavailable"))
        : Promise.resolve();
    });
    const firstPass = await claimErasureWork(db, job.id, "verification", 5);
    for (const lease of firstPass) {
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
      throw new Error("missing retry");
    }
    await executeErasureWork(
      db,
      retry,
      createSshRemoteErasureCollector(db),
      context.signal,
    );
    const [state] = await db
      .select({ state: accountErasureWork.state })
      .from(accountErasureWork)
      .where(eq(accountErasureWork.id, failed[0]?.id ?? ""));
    expect(state?.state).toBe("capability_unresolved");
  }, 30_000);
});
