import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { HttpResponse, http } from "msw";
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
import { browserSessionInstances } from "@okouai/db/schema/browser-session";
import { chatThreads } from "@okouai/db/schema/chat-thread";

import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  BROWSER_SESSION_ERASURE_COLLECTOR_VERSION,
  createBrowserSessionErasureCollector,
} from "../account-erasure-browser-session-collector";
import { encryptErasureSelector } from "../account-erasure-selector";

const BROWSER_API = "https://api.browser-use.com/api/v3";

describe("account erasure browser session capture", () => {
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
      collectorVersion: BROWSER_SESSION_ERASURE_COLLECTOR_VERSION,
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
    const handler = createBrowserSessionErasureCollector(db);
    const [inventory] = await claimErasureWork(db, job.id, "inventory");
    if (!inventory) {
      throw new Error("Missing browser session capture");
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

  async function seed(userId: string) {
    const threadId = randomUUID();
    const sessionId = randomUUID();
    await db.insert(chatThreads).values({ id: threadId, userId });
    await db.insert(browserSessionInstances).values({
      providerSessionId: sessionId,
      chatThreadId: threadId,
      runId: randomUUID(),
      status: "active",
      timeoutAt: new Date("2090-01-01T00:00:00Z"),
      startedAt: nowDate(),
    });
    onTestFinished(async () => {
      await db
        .delete(browserSessionInstances)
        .where(eq(browserSessionInstances.providerSessionId, sessionId));
      await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
    });
    return { threadId, sessionId };
  }

  it("captures the session before the thread disappears and requires provider absence", async () => {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
    const userId = `browser_erasure_${randomUUID()}`;
    const { threadId, sessionId } = await seed(userId);
    server.use(
      http.patch(`${BROWSER_API}/browsers/:id`, () => {
        return HttpResponse.json({ id: sessionId, status: "stopped" });
      }),
      http.get(`${BROWSER_API}/browsers/:id`, () => {
        return HttpResponse.json({
          id: sessionId,
          status: "stopped",
          timeoutAt: "2090-01-01T00:00:00.000Z",
          startedAt: "2026-01-01T00:00:00.000Z",
        });
      }),
    );
    const { job, handler } = await begin(userId);
    const items = await db
      .select({ kind: accountErasureWork.kind })
      .from(accountErasureWork)
      .where(eq(accountErasureWork.jobId, job.id));
    expect(
      items.filter((item) => {
        return item.kind === "erase";
      }),
    ).toHaveLength(1);
    await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
    const leases = await claimErasureWork(db, job.id, "verification", 2);
    expect(leases).toHaveLength(2);
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    const [retained] = await db
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
    expect(retained).toMatchObject({
      state: "capability_unresolved",
      errorCode: "verification_failed",
    });
    await expect(finalizeErasureJob(db, job.id, job)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  });

  it("does not stop a captured session when its thread identity is reused by another owner", async () => {
    const userId = `browser_erasure_${randomUUID()}`;
    const otherUserId = `browser_erasure_${randomUUID()}`;
    const { threadId } = await seed(userId);
    const { job, handler } = await begin(userId);
    await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
    await db.insert(chatThreads).values({ id: threadId, userId: otherUserId });
    const leases = await claimErasureWork(db, job.id, "verification", 2);
    expect(leases).toHaveLength(2);
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    const [blocked] = await db
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
    expect(blocked).toMatchObject({
      state: "capability_unresolved",
      errorCode: "ownership_unknown",
    });
    await expect(finalizeErasureJob(db, job.id, job)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  });

  it("verifies only a provider session actually absent after catalog removal", async () => {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
    const userId = `browser_erasure_${randomUUID()}`;
    const { threadId } = await seed(userId);
    server.use(
      http.patch(`${BROWSER_API}/browsers/:id`, () => {
        return new HttpResponse(null, { status: 404 });
      }),
      http.get(`${BROWSER_API}/browsers/:id`, () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );
    const { job, handler } = await begin(userId);
    await db.delete(chatThreads).where(eq(chatThreads.id, threadId));
    const leases = await claimErasureWork(db, job.id, "verification", 2);
    expect(leases).toHaveLength(2);
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    expect((await finalizeErasureJob(db, job.id, job)).state).toBe(
      "verified_erased",
    );
  });
});
