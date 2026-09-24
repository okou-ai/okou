import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { and, eq, sql } from "drizzle-orm";
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
import {
  browserProfiles,
  browserThreadProfiles,
} from "@okouai/db/schema/browser-session";

import { testContext } from "../../../__tests__/test-context";
import { env, mockEnv } from "../../../lib/env";
import { nowDate } from "../../../lib/time";
import { server } from "../../../mocks/server";
import {
  BROWSER_PROFILE_ERASURE_COLLECTOR_VERSION,
  createBrowserProfileErasureCollector,
} from "../account-erasure-browser-profile-collector";
import { encryptErasureSelector } from "../account-erasure-selector";

const BROWSER_API = "https://api.browser-use.com/api/v3";

function providerProfile(id: string) {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("account erasure browser profile capture", () => {
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
      collectorVersion: BROWSER_PROFILE_ERASURE_COLLECTOR_VERSION,
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
    return { job, handler: createBrowserProfileErasureCollector(db) };
  }

  async function capture(
    jobId: string,
    handler: ReturnType<typeof createBrowserProfileErasureCollector>,
  ) {
    const [lease] = await claimErasureWork(db, jobId, "inventory");
    if (!lease) {
      throw new Error("Missing browser profile inventory lease");
    }
    // Inventory retains its lease across pages so workers cannot interleave
    // cursors; the caller yields only after the last page commits.
    for (let page = 0; page < 4; page += 1) {
      await executeErasureWork(db, lease, handler, context.signal);
      const [remaining] = await db
        .select({ complete: accountErasureWork.captureComplete })
        .from(accountErasureWork)
        .where(eq(accountErasureWork.id, lease.workId));
      if (remaining?.complete) {
        return;
      }
    }
    throw new Error("Browser profile capture did not finish");
  }

  async function seal(job: Awaited<ReturnType<typeof begin>>["job"]) {
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

  it("captures more than one page before rows disappear, then verifies remote absence", async () => {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
    const userId = `browser_erasure_${randomUUID()}`;
    const otherUserId = `browser_erasure_${randomUUID()}`;
    const owned = Array.from({ length: 101 }, () => {
      return randomUUID();
    });
    const otherId = randomUUID();
    const live = new Set<string>([...owned, otherId]);
    server.use(
      http.delete(`${BROWSER_API}/profiles/:id`, ({ params }) => {
        live.delete(String(params.id));
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${BROWSER_API}/profiles/:id`, ({ params }) => {
        const id = String(params.id);
        return live.has(id)
          ? HttpResponse.json(providerProfile(id))
          : new HttpResponse(null, { status: 404 });
      }),
    );
    await db.insert(browserProfiles).values(
      owned.map((providerProfileId) => {
        return { orgId: randomUUID(), userId, providerProfileId };
      }),
    );
    await db.insert(browserThreadProfiles).values({
      chatThreadId: randomUUID(),
      orgId: randomUUID(),
      userId: otherUserId,
      providerProfileId: otherId,
    });
    onTestFinished(async () => {
      await db
        .delete(browserProfiles)
        .where(eq(browserProfiles.userId, userId));
      await db
        .delete(browserThreadProfiles)
        .where(eq(browserThreadProfiles.userId, otherUserId));
    });
    const { job, handler } = await begin(userId);
    await capture(job.id, handler);
    const captured = await db
      .select({ id: accountErasureWork.id })
      .from(accountErasureWork)
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.kind, "erase"),
        ),
      );
    expect(captured).toHaveLength(101);
    const sealed = await seal(job);
    await db.delete(browserProfiles).where(eq(browserProfiles.userId, userId));
    let processed = 0;
    for (let index = 0; index < 102; index += 1) {
      const [lease] = await claimErasureWork(db, job.id, "verification", 1);
      if (!lease) {
        throw new Error("Missing captured browser profile or collector proof");
      }
      await executeErasureWork(db, lease, handler, context.signal);
      processed += 1;
    }
    expect(processed).toBe(102);
    expect(live).toStrictEqual(new Set([otherId]));
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_erased",
    );
  }, 120_000);

  it("persists a retry when DELETE acknowledges but an authenticated GET still finds the profile", async () => {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
    const userId = `browser_erasure_${randomUUID()}`;
    const profileId = randomUUID();
    let absent = false;
    server.use(
      http.delete(`${BROWSER_API}/profiles/:id`, () => {
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${BROWSER_API}/profiles/:id`, () => {
        return absent
          ? new HttpResponse(null, { status: 404 })
          : HttpResponse.json(providerProfile(profileId));
      }),
    );
    await db.insert(browserProfiles).values({
      orgId: randomUUID(),
      userId,
      providerProfileId: profileId,
    });
    onTestFinished(async () => {
      await db
        .delete(browserProfiles)
        .where(eq(browserProfiles.userId, userId));
    });
    const { job, handler } = await begin(userId);
    await capture(job.id, handler);
    const sealed = await seal(job);
    await db.delete(browserProfiles).where(eq(browserProfiles.userId, userId));
    const first = await claimErasureWork(db, job.id, "verification", 2);
    if (first.length !== 2) {
      throw new Error("Missing captured profile or collector");
    }
    for (const lease of first) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    const [erase] = first.filter((lease) => {
      return lease.item.kind === "erase";
    });
    if (!erase) {
      throw new Error("Missing captured profile erase work");
    }
    const [failed] = await db
      .select({
        state: accountErasureWork.state,
        errorCode: accountErasureWork.errorCode,
      })
      .from(accountErasureWork)
      .where(eq(accountErasureWork.id, erase.workId));
    expect(failed).toMatchObject({
      state: "retryable_failure",
      errorCode: "verification_failed",
    });
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
    absent = true;
    await db
      .update(accountErasureWork)
      .set({ availableAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accountErasureWork.id, erase.workId));
    const [retry] = await claimErasureWork(db, job.id, "verification");
    if (!retry) {
      throw new Error("Missing persisted profile retry");
    }
    await executeErasureWork(db, retry, handler, context.signal);
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_erased",
    );
  });

  it("persists provider failure under the B1 lease and retries after restart", async () => {
    mockEnv("OKOU_BROWSER_USE_API_KEY", "test-browser-use-key");
    const userId = `browser_erasure_${randomUUID()}`;
    const profileId = randomUUID();
    let available = false;
    server.use(
      http.delete(`${BROWSER_API}/profiles/:id`, () => {
        return available
          ? new HttpResponse(null, { status: 204 })
          : new HttpResponse(null, { status: 503 });
      }),
      http.get(`${BROWSER_API}/profiles/:id`, () => {
        return new HttpResponse(null, { status: 404 });
      }),
    );
    await db.insert(browserProfiles).values({
      orgId: randomUUID(),
      userId,
      providerProfileId: profileId,
    });
    onTestFinished(async () => {
      await db
        .delete(browserProfiles)
        .where(eq(browserProfiles.userId, userId));
    });
    const { job, handler } = await begin(userId);
    await capture(job.id, handler);
    const sealed = await seal(job);
    await db.delete(browserProfiles).where(eq(browserProfiles.userId, userId));
    const leases = await claimErasureWork(db, job.id, "verification", 2);
    expect(leases).toHaveLength(2);
    for (const lease of leases) {
      await executeErasureWork(db, lease, handler, context.signal);
    }
    const [failed] = await db
      .select({ id: accountErasureWork.id, state: accountErasureWork.state })
      .from(accountErasureWork)
      .where(
        and(
          eq(accountErasureWork.jobId, job.id),
          eq(accountErasureWork.kind, "erase"),
        ),
      );
    expect(failed?.state).toBe("retryable_failure");
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
    available = true;
    await db
      .update(accountErasureWork)
      .set({ availableAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(accountErasureWork.id, failed?.id ?? ""));
    const [retry] = await claimErasureWork(db, job.id, "verification");
    if (!retry) {
      throw new Error("Missing durable provider retry");
    }
    await executeErasureWork(db, retry, handler, context.signal);
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_erased",
    );
  });

  it("refuses a new cross-account profile reference after capture and catalog deletion", async () => {
    const userId = `browser_erasure_${randomUUID()}`;
    const otherUserId = `browser_erasure_${randomUUID()}`;
    const profileId = randomUUID();
    await db.insert(browserProfiles).values({
      orgId: randomUUID(),
      userId,
      providerProfileId: profileId,
    });
    onTestFinished(async () => {
      await db
        .delete(browserProfiles)
        .where(eq(browserProfiles.userId, userId));
      await db
        .delete(browserThreadProfiles)
        .where(eq(browserThreadProfiles.userId, otherUserId));
    });
    const { job, handler } = await begin(userId);
    await capture(job.id, handler);
    const sealed = await seal(job);
    await db.delete(browserProfiles).where(eq(browserProfiles.userId, userId));
    await db.insert(browserThreadProfiles).values({
      chatThreadId: randomUUID(),
      orgId: randomUUID(),
      userId: otherUserId,
      providerProfileId: profileId,
    });
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
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "account_erasure:work_unresolved",
    );
  });

  it("refuses to erase a profile also referenced by a surviving account", async () => {
    const userId = `browser_erasure_${randomUUID()}`;
    const otherUserId = `browser_erasure_${randomUUID()}`;
    const profileId = randomUUID();
    await db.insert(browserProfiles).values({
      orgId: randomUUID(),
      userId,
      providerProfileId: profileId,
    });
    await db.insert(browserThreadProfiles).values({
      chatThreadId: randomUUID(),
      orgId: randomUUID(),
      userId: otherUserId,
      providerProfileId: profileId,
    });
    onTestFinished(async () => {
      await db
        .delete(browserProfiles)
        .where(eq(browserProfiles.userId, userId));
      await db
        .delete(browserThreadProfiles)
        .where(eq(browserThreadProfiles.userId, otherUserId));
    });
    const { job, handler } = await begin(userId);
    const [inventory] = await claimErasureWork(db, job.id, "inventory");
    if (!inventory) {
      throw new Error("Missing profile capture");
    }
    await executeErasureWork(db, inventory, handler, context.signal);
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
    await expect(seal(job)).rejects.toThrow(
      "account_erasure:capture_incomplete",
    );
  });
});
