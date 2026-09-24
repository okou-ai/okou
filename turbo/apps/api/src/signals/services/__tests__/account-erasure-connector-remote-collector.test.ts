import { createHash, randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
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
import { connectors } from "@okouai/db/schema/connector";
import { gmailWatchStates } from "@okouai/db/schema/gmail-event";
import { googleCalendarWatchStates } from "@okouai/db/schema/google-calendar-event";
import { googleFormsWatchStates } from "@okouai/db/schema/google-forms-event";
import { googleWorkspaceEventSubscriptionStates } from "@okouai/db/schema/google-workspace-event";
import { secrets } from "@okouai/db/schema/secret";

import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { encryptStoredSecretValue } from "../crypto.utils";
import {
  CONNECTOR_REMOTE_ERASURE_COLLECTOR_VERSION,
  createConnectorRemoteErasureCollector,
} from "../account-erasure-connector-remote-collector";
import {
  decryptErasureSelector,
  encryptErasureSelector,
} from "../account-erasure-selector";

describe("account erasure connector remote capture", () => {
  const pool = new Pool({ connectionString: env("DATABASE_URL"), max: 4 });
  const db = drizzle(pool);
  const context = testContext();
  afterAll(async () => {
    await pool.end();
  });

  async function begin(userId: string) {
    const sink: ErasureSink = {
      sinkId: randomUUID(),
      domain: "providers",
      collectorVersion: CONNECTOR_REMOTE_ERASURE_COLLECTOR_VERSION,
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
    return { job, handler: createConnectorRemoteErasureCollector(db) };
  }

  async function collect(
    jobId: string,
    handler: ReturnType<typeof createConnectorRemoteErasureCollector>,
  ) {
    for (let page = 0; page < 8; page += 1) {
      const [lease] = await claimErasureWork(db, jobId, "inventory");
      if (!lease) {
        break;
      }
      await executeErasureWork(db, lease, handler, context.signal);
      await yieldErasureLease(db, lease);
    }
    return await db
      .select()
      .from(accountErasureWork)
      .where(eq(accountErasureWork.jobId, jobId));
  }

  it("captures 100-row pages, credentials and watches before catalog removal, but never treats local loss as provider revocation", async () => {
    const userId = `connector_erasure_${randomUUID()}`;
    const peerId = `connector_peer_${randomUUID()}`;
    const orgId = `connector_org_${randomUUID()}`;
    const accounts = Array.from({ length: 105 }, () => {
      return {
        id: randomUUID(),
        orgId,
        userId,
        connectorSlug: "gmail",
        authMethod: "oauth",
        storageVersion: 1,
        isDefault: false,
      };
    });
    const peer = {
      id: randomUUID(),
      orgId,
      userId: peerId,
      connectorSlug: "gmail",
      authMethod: "oauth",
      storageVersion: 1,
    };
    await db.insert(connectors).values([...accounts, peer]);
    onTestFinished(async () => {
      await db.delete(connectors).where(eq(connectors.userId, userId));
      await db.delete(connectors).where(eq(connectors.id, peer.id));
    });
    const firstAccount = accounts[0];
    if (!firstAccount) {
      throw new Error("Expected a connector account fixture");
    }
    const connectorId = firstAccount.id;
    const secretId = randomUUID();
    const token = `synthetic-provider-token-${randomUUID()}`;
    const encryptedValue = await encryptStoredSecretValue(token);
    await db.insert(secrets).values({
      id: secretId,
      name: "access_token",
      encryptedValue,
      type: "connector",
      connectorId,
      orgId,
      userId,
    });
    await db.insert(gmailWatchStates).values({
      orgId,
      userId,
      connectorId,
      emailAddress: "victim@example.com",
      topicName: "projects/p/topics/gmail",
      lastHistoryId: "12",
      watchExpirationAt: new Date("2090-01-01"),
      lastWatchRenewedAt: nowDate(),
    });
    await db.insert(googleCalendarWatchStates).values({
      orgId,
      userId,
      connectorId,
      calendarId: "primary",
      channelId: randomUUID(),
      channelToken: "private-current-channel-token",
      resourceId: "current-resource",
      resourceUri: "https://calendar.google.com/",
      previousChannelId: randomUUID(),
      previousChannelToken: "private-previous-channel-token",
      previousResourceId: "previous-resource",
      watchExpirationAt: new Date("2090-01-01"),
      lastWatchRenewedAt: nowDate(),
    });
    await db.insert(googleFormsWatchStates).values({
      orgId,
      userId,
      connectorId,
      formId: "form-123",
      watchId: "watch-123",
      topicName: "projects/p/topics/forms",
      expireTime: new Date("2090-01-01"),
      lastRenewedAt: nowDate(),
    });
    await db.insert(googleWorkspaceEventSubscriptionStates).values({
      orgId,
      userId,
      connectorId,
      provider: "google-meet",
      targetResource: "//meet.googleapis.com/",
      eventTypes: [],
      eventTypesKey: "events",
      subscriptionName: "subscriptions/123",
      pubsubTopic: "projects/p/topics/meet",
      expireTime: new Date("2090-01-01"),
      lastRenewedAt: nowDate(),
    });
    const { job, handler } = await begin(userId);
    const work = await collect(job.id, handler);
    expect(
      work.filter((item) => {
        return item.kind === "erase";
      }),
    ).toHaveLength(110);
    expect(
      work.filter((item) => {
        return item.kind === "inventory";
      }),
    ).toHaveLength(1);
    expect(
      work.find((item) => {
        return item.kind === "inventory";
      })?.captureComplete,
    ).toBeTruthy();
    const captured = await Promise.all(
      work
        .filter((item) => {
          return item.kind === "erase";
        })
        .map(async (item) => {
          if (!item.selectorCiphertext || !item.selectorDigest) {
            throw new Error("Missing encrypted connector locator");
          }
          return await decryptErasureSelector({
            ciphertext: item.selectorCiphertext,
            digest: item.selectorDigest,
          });
        }),
    );
    const types = captured.flatMap((item) => {
      return item.kind === "connector_remote" ? [item.resourceType] : [];
    });
    expect(new Set(types)).toStrictEqual(
      new Set([
        "connector",
        "secret",
        "gmail_watch",
        "calendar_watch",
        "forms_watch",
        "meet_subscription",
      ]),
    );
    const credential = captured.find((item) => {
      return item.kind === "connector_remote" && item.resourceId === secretId;
    });
    expect(credential).toMatchObject({
      kind: "connector_remote",
      credentialDigest: createHash("sha256")
        .update(encryptedValue)
        .digest("hex"),
      credentialCiphertext: encryptedValue,
    });
    // The stored-secret envelope remains recoverable for a later provider
    // revoke, while neither it nor the plaintext token appears in B1 rows.
    expect(JSON.stringify(captured)).not.toContain(token);
    expect(JSON.stringify(work)).not.toContain(token);
    expect(JSON.stringify(work)).not.toContain(encryptedValue);

    await db.delete(connectors).where(eq(connectors.userId, userId));
    await expect(
      db
        .select({ id: connectors.id })
        .from(connectors)
        .where(eq(connectors.id, peer.id)),
    ).resolves.toHaveLength(1);
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
    const leases = await claimErasureWork(db, job.id, "verification", 2);
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    const [residual] = await db
      .select({ errorCode: accountErasureWork.errorCode })
      .from(accountErasureWork)
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.kind, "erase"),
          eq(accountErasureWork.state, "capability_unresolved"),
        ),
      )
      .limit(1);
    expect(residual?.errorCode).toBe("boundary_unproven");
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  });

  it("leaves source credentials intact when their envelope cannot fit a durable selector", async () => {
    const userId = `connector_erasure_${randomUUID()}`;
    const orgId = `connector_org_${randomUUID()}`;
    const connectorId = randomUUID();
    const secretId = randomUUID();
    await db.insert(connectors).values({
      id: connectorId,
      orgId,
      userId,
      connectorSlug: "gmail",
      authMethod: "oauth",
      storageVersion: 1,
    });
    onTestFinished(async () => {
      await db.delete(connectors).where(eq(connectors.id, connectorId));
    });
    await db.insert(secrets).values({
      id: secretId,
      name: "access_token",
      encryptedValue: "x".repeat(3073),
      type: "connector",
      connectorId,
      orgId,
      userId,
    });
    const { job, handler } = await begin(userId);
    const [lease] = await claimErasureWork(db, job.id, "inventory");
    if (!lease) {
      throw new Error("Expected a connector inventory lease");
    }
    await expect(
      executeErasureWork(db, lease, handler, context.signal),
    ).rejects.toThrow("account_erasure:invalid_selector");
    await expect(
      db
        .select({ id: secrets.id })
        .from(secrets)
        .where(eq(secrets.id, secretId)),
    ).resolves.toHaveLength(1);
    const [inventory] = await db
      .select({ complete: accountErasureWork.captureComplete })
      .from(accountErasureWork)
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.kind, "inventory"),
        ),
      );
    expect(inventory).toBeDefined();
    expect(inventory?.complete).toBeFalsy();
  });

  it("rejects a watch whose connector belongs to another account without capturing or deleting it", async () => {
    const userId = `connector_erasure_${randomUUID()}`;
    const peerId = `connector_peer_${randomUUID()}`;
    const orgId = `connector_org_${randomUUID()}`;
    const connectorId = randomUUID();
    await db.insert(connectors).values({
      id: connectorId,
      orgId,
      userId: peerId,
      connectorSlug: "gmail",
      authMethod: "oauth",
      storageVersion: 1,
    });
    const [watch] = await db
      .insert(gmailWatchStates)
      .values({
        orgId,
        userId,
        connectorId,
        emailAddress: "peer@example.com",
        topicName: "projects/p/topics/gmail",
        lastHistoryId: "12",
        watchExpirationAt: new Date("2090-01-01"),
        lastWatchRenewedAt: nowDate(),
      })
      .returning({ id: gmailWatchStates.id });
    if (!watch) {
      throw new Error("Expected a watch fixture");
    }
    onTestFinished(async () => {
      await db
        .delete(gmailWatchStates)
        .where(eq(gmailWatchStates.id, watch.id));
      await db.delete(connectors).where(eq(connectors.id, connectorId));
    });
    const { job, handler } = await begin(userId);
    const work = await collect(job.id, handler);
    expect(work).toHaveLength(1);
    expect(work[0]).toMatchObject({
      kind: "inventory",
      captureComplete: false,
      errorCode: "ownership_unknown",
    });
    await expect(
      db
        .select({ id: gmailWatchStates.id })
        .from(gmailWatchStates)
        .where(eq(gmailWatchStates.id, watch.id)),
    ).resolves.toHaveLength(1);
    await expect(
      sealErasureCapture(
        db,
        job.id,
        job,
        {
          verify: () => {
            throw new Error("Must not verify unowned capture");
          },
        },
        context.signal,
      ),
    ).rejects.toThrow("capture");
  });
});
