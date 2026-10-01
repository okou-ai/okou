import { randomUUID } from "node:crypto";

import { backgroundJobs } from "@okouai/db/schema/background-job";
import { eq, inArray, sql } from "drizzle-orm";
import { describe, expect, it, onTestFinished } from "vitest";

import { testContext } from "../../../__tests__/test-context";
import { db } from "../../../lib/db";
import { createDeferredPromise, settleIncludingAbort } from "../../utils";
import {
  checkpointBackgroundJob,
  claimBackgroundJob,
  completeBackgroundJob,
  enqueueBackgroundJob,
  enqueueBackgroundJobs,
  failBackgroundJob,
  retryBackgroundJob,
  yieldBackgroundJob,
  type ClaimedBackgroundJob,
} from "../background-job.service";

const context = testContext();

// An HTTP caller cannot hold PostgreSQL row locks, expire one worker's lease,
// choose a future handler version, or roll back a result-publication transaction.
// These cases exercise the durable kernel used by endpoint integration tests.
async function createJob(
  overrides: { kind?: string; handlerVersion?: number } = {},
) {
  const id = randomUUID();
  onTestFinished(async () => {
    await db().delete(backgroundJobs).where(eq(backgroundJobs.id, id));
  });
  return await enqueueBackgroundJob(
    db(),
    {
      id,
      kind: overrides.kind ?? `test-${randomUUID()}`,
      handlerVersion: overrides.handlerVersion ?? 1,
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      input: { objectPrefix: `jobs/${id}` },
    },
    context.signal,
  );
}

async function claimJob(job: {
  id: string;
  kind: string;
  handlerVersion: number;
}) {
  const claimed = await claimBackgroundJob(
    db(),
    { jobId: job.id, kind: job.kind, handlerVersion: job.handlerVersion },
    context.signal,
  );
  if (!claimed) {
    throw new Error("Expected the owned test job to be claimable");
  }
  return claimed;
}

function jobInputs(count: number) {
  const owner = {
    kind: `test-${randomUUID()}`,
    handlerVersion: 1,
    userId: `user_${randomUUID()}`,
    orgId: `org_${randomUUID()}`,
  };
  const rows = Array.from({ length: count }, () => {
    const id = randomUUID();
    return { ...owner, id, input: { objectPrefix: `jobs/${id}` } };
  });
  onTestFinished(async () => {
    await db()
      .delete(backgroundJobs)
      .where(
        inArray(
          backgroundJobs.id,
          rows.map((row) => {
            return row.id;
          }),
        ),
      );
  });
  return rows;
}

async function readJobs(rows: readonly { readonly id: string }[]) {
  return await db()
    .select()
    .from(backgroundJobs)
    .where(
      inArray(
        backgroundJobs.id,
        rows.map((row) => {
          return row.id;
        }),
      ),
    )
    .orderBy(backgroundJobs.id);
}

async function readJob(id: string) {
  const [job] = await db()
    .select()
    .from(backgroundJobs)
    .where(eq(backgroundJobs.id, id));
  if (!job) {
    throw new Error("Expected the owned test job to exist");
  }
  return job;
}

async function expectFenceRejected(job: ClaimedBackgroundJob) {
  await expect(
    checkpointBackgroundJob(
      db(),
      { job, checkpoint: { stale: true } },
      context.signal,
    ),
  ).resolves.toBeFalsy();
  await expect(
    yieldBackgroundJob(
      db(),
      { job, checkpoint: { stale: true } },
      context.signal,
    ),
  ).resolves.toBeFalsy();
  await expect(
    retryBackgroundJob(
      db(),
      { job, error: "stale", availableAt: new Date(0) },
      context.signal,
    ),
  ).resolves.toBeFalsy();
  await expect(
    completeBackgroundJob(db(), { job }, context.signal),
  ).resolves.toBeFalsy();
  await expect(
    failBackgroundJob(db(), { job, error: "stale" }, context.signal),
  ).resolves.toBeFalsy();
}

describe("atomic bulk background job admission", () => {
  // Production APIs cannot submit arbitrary durable IDs/handler versions or
  // contradictory immutable input. These exercise the real kernel/database;
  // Clerk webhook tests cover its constructible source-deletion behavior.
  it("coalesces exact duplicates across batches and preserves every replay's progress", async () => {
    const rows = jobInputs(205);
    const [pending, completed, running] = rows.slice(100, 103);
    if (!pending || !completed || !running) {
      throw new Error("Expected three existing inventory targets");
    }
    for (const args of [pending, completed, running]) {
      await enqueueBackgroundJob(db(), args, context.signal);
    }
    const pendingClaim = await claimJob(pending);
    await checkpointBackgroundJob(
      db(),
      { job: pendingClaim, checkpoint: { page: 17 } },
      context.signal,
    );
    await retryBackgroundJob(
      db(),
      {
        job: pendingClaim,
        error: "lost provider receipt",
        availableAt: new Date("2999-01-01T00:00:00Z"),
      },
      context.signal,
    );
    await completeBackgroundJob(
      db(),
      { job: await claimJob(completed) },
      context.signal,
    );
    await claimJob(running);
    const before = await readJobs([pending, completed, running]);
    const first = rows[0];
    if (!first) {
      throw new Error("Expected a fresh inventory target");
    }
    const admitted = await db().transaction(async (tx) => {
      return await enqueueBackgroundJobs(
        tx,
        [...rows, { ...first, id: first.id.toUpperCase() }, pending],
        context.signal,
      );
    });
    expect(
      admitted.map((job) => {
        return job.id;
      }),
    ).toStrictEqual(
      rows.map((args) => {
        return args.id;
      }),
    );
    await expect(readJobs(rows)).resolves.toHaveLength(205);
    for (const previous of before) {
      await expect(readJob(previous.id)).resolves.toStrictEqual(previous);
    }
    await db().transaction(async (tx) => {
      await expect(
        enqueueBackgroundJobs(tx, [], context.signal),
      ).resolves.toStrictEqual([]);
    });
  });

  it.each([
    { field: "kind", change: { kind: "different-handler" } },
    { field: "handler version", change: { handlerVersion: 2 } },
    { field: "user", change: { userId: "different-user" } },
    { field: "organization", change: { orgId: "different-org" } },
    { field: "input", change: { input: { objectPrefix: "different-target" } } },
  ])(
    "rejects a conflicting $field without admitting any fresh targets",
    async ({ change }) => {
      const rows = jobInputs(2);
      const [first, fresh] = rows;
      if (!first || !fresh) {
        throw new Error("Expected existing and fresh inventory targets");
      }
      const previous = await enqueueBackgroundJob(db(), first, context.signal);
      await expect(
        db().transaction(async (tx) => {
          await enqueueBackgroundJobs(
            tx,
            [fresh, { ...first, ...change }],
            context.signal,
          );
        }),
      ).rejects.toThrow("identity conflicts");
      await expect(readJobs(rows)).resolves.toStrictEqual([previous]);
    },
  );

  it("rejects contradictory duplicates spanning batches before creating any inventory", async () => {
    const rows = jobInputs(205);
    const first = rows[0];
    if (!first) {
      throw new Error("Expected a duplicate inventory target");
    }
    await expect(
      db().transaction(async (tx) => {
        await enqueueBackgroundJobs(
          tx,
          [
            ...rows,
            {
              ...first,
              id: first.id.toUpperCase(),
              input: { objectPrefix: "contradiction" },
            },
          ],
          context.signal,
        );
      }),
    ).rejects.toThrow("identity conflicts");
    await expect(readJobs(rows)).resolves.toStrictEqual([]);
  });

  it("rolls back earlier batches when the final batch finds an identity conflict", async () => {
    const rows = jobInputs(205).sort((a, b) => {
      return a.id.localeCompare(b.id);
    });
    const last = rows.at(-1);
    if (!last) {
      throw new Error("Expected a last-batch inventory target");
    }
    const previous = await enqueueBackgroundJob(
      db(),
      { ...last, handlerVersion: 2 },
      context.signal,
    );
    await expect(
      db().transaction(async (tx) => {
        await enqueueBackgroundJobs(tx, rows, context.signal);
      }),
    ).rejects.toThrow("identity conflicts");
    await expect(readJobs(rows)).resolves.toStrictEqual([previous]);
  });

  it("accepts competing overlapping inventories in different input orders exactly once", async () => {
    const rows = jobInputs(205);
    const admitted = await Promise.all([
      db().transaction(async (tx) => {
        return await enqueueBackgroundJobs(
          tx,
          rows.slice(0, 151),
          context.signal,
        );
      }),
      db().transaction(async (tx) => {
        return await enqueueBackgroundJobs(
          tx,
          rows.slice(50).reverse(),
          context.signal,
        );
      }),
    ]);
    expect(
      admitted.map((jobs) => {
        return jobs.length;
      }),
    ).toStrictEqual([151, 155]);
    const before = await readJobs(rows);
    expect(before).toHaveLength(205);
    await db().transaction(async (tx) => {
      await enqueueBackgroundJobs(tx, [...rows].reverse(), context.signal);
    });
    await expect(readJobs(rows)).resolves.toStrictEqual(before);
  });

  it("rejects an already-aborted admission without leaving targets behind", async () => {
    const rows = jobInputs(2);
    const controller = new AbortController();
    controller.abort(new Error("Admission cancelled"));
    await expect(
      db().transaction(async (tx) => {
        await enqueueBackgroundJobs(tx, rows, controller.signal);
      }),
    ).rejects.toThrow("Admission cancelled");
    await expect(readJobs(rows)).resolves.toStrictEqual([]);
  });
});

describe("durable background job ownership", () => {
  it("claims a job once under competing invocations", async () => {
    const job = await createJob();
    const claims = await Promise.all([
      claimBackgroundJob(
        db(),
        { jobId: job.id, kind: job.kind, handlerVersion: job.handlerVersion },
        context.signal,
      ),
      claimBackgroundJob(
        db(),
        { jobId: job.id, kind: job.kind, handlerVersion: job.handlerVersion },
        context.signal,
      ),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    await expect(readJob(job.id)).resolves.toMatchObject({
      status: "running",
      failureCount: 0,
    });
  });

  it("skips a locked job and claims other compatible work without waiting", async () => {
    const first = await createJob();
    const second = await createJob({ kind: first.kind });
    const locked = createDeferredPromise<void>(context.signal);
    const release = createDeferredPromise<void>(context.signal);
    const holding = db().transaction(async (tx) => {
      const claimed = await claimBackgroundJob(
        tx,
        {
          jobId: first.id,
          kind: first.kind,
          handlerVersion: first.handlerVersion,
        },
        context.signal,
      );
      if (!claimed) {
        throw new Error("Expected the first job's transaction to own its row");
      }
      locked.resolve();
      await release.promise;
      context.signal.throwIfAborted();
    });
    const result = await settleIncludingAbort(
      (async () => {
        await locked.promise;
        context.signal.throwIfAborted();
        return await claimBackgroundJob(
          db(),
          { kind: first.kind, handlerVersion: first.handlerVersion },
          context.signal,
        );
      })(),
    );
    if (!release.settled()) {
      release.resolve();
    }
    await holding;
    if (!result.ok) {
      throw result.error;
    }
    expect(result.value?.id).toBe(second.id);
  });

  it("resumes durable progress after lease expiry and rejects every stale mutation", async () => {
    const original = await claimJob(await createJob());
    await checkpointBackgroundJob(
      db(),
      { job: original, checkpoint: { committedPart: 17 } },
      context.signal,
    );
    await db()
      .update(backgroundJobs)
      .set({
        leaseExpiresAt: sql`timezone('UTC', clock_timestamp()) - interval '1 millisecond'`,
      })
      .where(eq(backgroundJobs.id, original.id));

    await expectFenceRejected(original);
    const resumed = await claimJob(original);
    expect(resumed.leaseId).not.toBe(original.leaseId);
    expect(resumed.checkpoint).toStrictEqual({ committedPart: 17 });
    expect(resumed.failureCount).toBe(0);
    await expectFenceRejected(original);
    await expect(
      completeBackgroundJob(db(), { job: resumed }, context.signal),
    ).resolves.toBeTruthy();
    await expect(readJob(original.id)).resolves.toMatchObject({
      status: "completed",
      checkpoint: { committedPart: 17 },
      lastError: null,
      leaseId: null,
    });
    await expectFenceRejected(resumed);
  });

  it("preserves committed progress on failure and resets failures on real progress", async () => {
    const first = await claimJob(await createJob());
    await checkpointBackgroundJob(
      db(),
      { job: first, checkpoint: { committedPart: 1 } },
      context.signal,
    );
    await retryBackgroundJob(
      db(),
      {
        job: first,
        error: "object store temporarily unavailable",
        availableAt: new Date(0),
      },
      context.signal,
    );
    const retried = await claimJob(first);
    expect(retried).toMatchObject({
      failureCount: 1,
      checkpoint: { committedPart: 1 },
      lastError: "object store temporarily unavailable",
    });
    await checkpointBackgroundJob(
      db(),
      { job: retried, checkpoint: { committedPart: 2 } },
      context.signal,
    );
    await expect(readJob(first.id)).resolves.toMatchObject({
      failureCount: 0,
      lastError: null,
      leaseId: retried.leaseId,
      leaseExpiresAt: retried.leaseExpiresAt,
    });
    await yieldBackgroundJob(
      db(),
      { job: retried, checkpoint: { committedPart: 3 } },
      context.signal,
    );
    const continued = await claimJob(first);
    expect(continued).toMatchObject({
      failureCount: 0,
      lastError: null,
      checkpoint: { committedPart: 3 },
    });
    expect(continued.leaseId).not.toBe(retried.leaseId);
    await expectFenceRejected(retried);
  });

  it("defers retries until their due time and never claims an unsupported handler version", async () => {
    const first = await claimJob(await createJob({ handlerVersion: 2 }));
    await retryBackgroundJob(
      db(),
      {
        job: first,
        error: "retry later",
        availableAt: new Date("2999-01-01T00:00:00Z"),
      },
      context.signal,
    );
    await expect(
      claimBackgroundJob(
        db(),
        { jobId: first.id, kind: first.kind, handlerVersion: 2 },
        context.signal,
      ),
    ).resolves.toBeNull();
    await db()
      .update(backgroundJobs)
      .set({ availableAt: new Date(0) })
      .where(eq(backgroundJobs.id, first.id));
    await expect(
      claimBackgroundJob(
        db(),
        { jobId: first.id, kind: first.kind, handlerVersion: 1 },
        context.signal,
      ),
    ).resolves.toBeNull();
    await expect(claimJob(first)).resolves.toMatchObject({
      handlerVersion: 2,
      failureCount: 1,
    });
  });

  it("does not reset progress on admission replay or allow a job ID to change owner or input", async () => {
    const first = await claimJob(await createJob());
    await yieldBackgroundJob(
      db(),
      { job: first, checkpoint: { committedPart: 17 } },
      context.signal,
    );
    const args = {
      id: first.id,
      kind: first.kind,
      handlerVersion: first.handlerVersion,
      userId: first.userId,
      orgId: first.orgId,
      input: first.input,
    };
    await expect(
      enqueueBackgroundJob(db(), args, context.signal),
    ).resolves.toMatchObject({ checkpoint: { committedPart: 17 } });
    await expect(
      enqueueBackgroundJob(
        db(),
        { ...args, userId: "different-owner" },
        context.signal,
      ),
    ).rejects.toThrow("identity conflicts");
    await expect(
      enqueueBackgroundJob(
        db(),
        { ...args, input: { different: true } },
        context.signal,
      ),
    ).rejects.toThrow("identity conflicts");
    await expect(readJob(first.id)).resolves.toMatchObject({
      userId: first.userId,
      checkpoint: { committedPart: 17 },
    });
  });

  it("rolls back completion with its caller's failed result-publication transaction", async () => {
    const claimed = await claimJob(await createJob());
    await expect(
      db().transaction(async (tx) => {
        const completed = await completeBackgroundJob(
          tx,
          { job: claimed },
          context.signal,
        );
        if (!completed) {
          throw new Error("Expected active completion authority");
        }
        throw new Error("Result publication rolled back");
      }),
    ).rejects.toThrow("Result publication rolled back");
    await expect(readJob(claimed.id)).resolves.toMatchObject({
      status: "running",
      leaseId: claimed.leaseId,
      completedAt: null,
    });
    await expect(
      completeBackgroundJob(db(), { job: claimed }, context.signal),
    ).resolves.toBeTruthy();
    await expect(
      claimBackgroundJob(
        db(),
        {
          jobId: claimed.id,
          kind: claimed.kind,
          handlerVersion: claimed.handlerVersion,
        },
        context.signal,
      ),
    ).resolves.toBeNull();
  });

  it("leaves pre-aborted claims available and makes permanent failure terminal", async () => {
    const job = await createJob();
    const controller = new AbortController();
    controller.abort(new Error("Invocation cancelled"));
    await expect(
      claimBackgroundJob(
        db(),
        { jobId: job.id, kind: job.kind, handlerVersion: job.handlerVersion },
        controller.signal,
      ),
    ).rejects.toThrow("Invocation cancelled");
    const claimed = await claimJob(job);
    await expect(
      failBackgroundJob(
        db(),
        { job: claimed, error: "required source is missing" },
        context.signal,
      ),
    ).resolves.toBeTruthy();
    await expect(readJob(job.id)).resolves.toMatchObject({
      status: "failed",
      failureCount: 1,
      lastError: "required source is missing",
      leaseId: null,
      leaseExpiresAt: null,
    });
    await expect(
      claimBackgroundJob(
        db(),
        { jobId: job.id, kind: job.kind, handlerVersion: job.handlerVersion },
        context.signal,
      ),
    ).resolves.toBeNull();
  });
});
