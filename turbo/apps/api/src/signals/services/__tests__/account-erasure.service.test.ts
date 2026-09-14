import { createHash, randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { afterAll, describe, expect, it, onTestFinished } from "vitest";
import { testContext } from "../../../__tests__/test-context";
import { env } from "../../../lib/env";
import { createDeferredPromise } from "../../utils";

import { users } from "@okouai/db/schema/user";
import {
  accountErasureJobs as jobs,
  accountErasureWork as work,
  accountErasureSinks as sinks,
  accountErasurePages as pages,
  accountErasureSelectorDependencies as dependencies,
} from "@okouai/db/schema/account-erasure";
import {
  assertErasureSourceCaptured,
  assertErasureSubjectWritable,
  claimErasureWork,
  commitErasureInventoryPage,
  executeErasureWork,
  finalizeErasureJob,
  projectErasureDecision,
  renewErasureLease,
  retireErasureProjectionPage,
  retireErasureSelector,
  reviseErasureInventory,
  sealErasureCapture,
  type EncryptedErasureSelector,
  type ErasureDecision,
  type ErasureHandler,
  type ErasureInventoryItem,
  type ErasureLease,
  type ErasureProof,
  type ErasureSink,
} from "@okouai/db/operations/account-erasure";

// Explicit external-behavior exception: B1 has no HTTP/cron/worker entry point.
// These persistence contracts must be exercised with real PostgreSQL sessions,
// including infrastructure-only expiry/abort states. No DB or service is mocked.
describe("dormant account erasure persistence", () => {
  const applicationName = `erasure_test_${randomUUID()}`;
  const databaseUrl = new URL(env("DATABASE_URL"));
  databaseUrl.searchParams.set("application_name", applicationName);
  const pool = new Pool({
    connectionString: databaseUrl.toString(),
    application_name: applicationName,
    max: 8,
  });
  const db = drizzle(pool);
  const jobIds: string[] = [];
  const userIds: string[] = [];
  const context = testContext();

  afterAll(async () => {
    if (jobIds.length > 0) {
      const ids = db
        .select({ id: work.id })
        .from(work)
        .where(inArray(work.jobId, jobIds));
      await db.delete(pages).where(inArray(pages.workId, ids));
      await db.delete(dependencies).where(inArray(dependencies.workId, ids));
      await db.delete(work).where(inArray(work.jobId, jobIds));
      await db.delete(sinks).where(inArray(sinks.jobId, jobIds));
      await db.delete(jobs).where(inArray(jobs.id, jobIds));
    }
    if (userIds.length > 0) {
      await db.delete(users).where(inArray(users.id, userIds));
    }
    await pool.end();
  });

  function decision(overrides: Partial<ErasureDecision> = {}): ErasureDecision {
    return {
      subjectKind: "user",
      subjectId: `synthetic_${randomUUID()}`,
      generation: 1,
      authorityId: randomUUID(),
      decisionRef: randomUUID(),
      decisionSequence: 1n,
      confirmationRef: randomUUID(),
      previousDecisionRef: null,
      dispositionVersion: 1,
      requestedAt: new Date("2026-01-01T00:00:00Z"),
      deadlineAt: new Date("2099-01-01T00:00:00Z"),
      ...overrides,
    };
  }
  async function project(input = decision()) {
    const job = await projectErasureDecision(db, input);
    jobIds.push(job.id);
    return job;
  }
  // Opaque ciphertext fixture at the DB boundary; the API selector suite separately
  // exercises the actual supported KMS envelope encryption and decryption.
  function encrypted(value = randomUUID()): EncryptedErasureSelector {
    return {
      ciphertext: "vm0secret:v1:opaque-encrypted-test-fixture",
      digest: createHash("sha256").update(value).digest("hex"),
    };
  }
  function sink(): ErasureSink {
    return {
      sinkId: randomUUID(),
      domain: "objects",
      collectorVersion: randomUUID(),
      selector: encrypted(),
      dependencies: [],
    };
  }
  function target(
    sinkId: string,
    kind: "erase" | "recovery" = "erase",
  ): ErasureInventoryItem {
    return {
      sinkId,
      itemKey: randomUUID(),
      kind,
      selector: encrypted(),
      dependencies: [],
    };
  }
  async function inventory(required = [sink()]) {
    const initial = await project();
    const job = await reviseErasureInventory(db, initial.id, initial, required);
    return { job, required };
  }
  function completePage(
    items: readonly ErasureInventoryItem[] = [],
    inputCursorDigest: string | null = null,
  ) {
    return {
      pageKey: randomUUID(),
      inputCursorDigest,
      nextCursor: null,
      enumerationRef: randomUUID(),
      items,
    };
  }
  async function seal(job: typeof jobs.$inferSelect) {
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
  function proof(lease: ErasureLease): ErasureProof {
    if (!lease.producerBoundaryRef) {
      throw new Error("test requires a sealed boundary");
    }
    return {
      workId: lease.workId,
      sinkId: lease.item.sinkId,
      generation: lease.generation,
      captureRevision: lease.captureRevision,
      inventoryRevision: lease.inventoryRevision,
      producerBoundaryRef: lease.producerBoundaryRef,
      outcome: "verified_erased",
      evidenceRef: randomUUID(),
      authenticatedReaderRef: randomUUID(),
      enumerationRef: randomUUID(),
      observedAt: new Date("2026-09-14T00:00:00Z"),
    };
  }
  function handler(
    version: string,
    overrides: Partial<ErasureHandler> = {},
  ): ErasureHandler {
    return {
      version,
      inventory: () => {
        return Promise.resolve(completePage());
      },
      erase: () => {
        return Promise.resolve({ requestRef: randomUUID() });
      },
      verify: (lease) => {
        return Promise.resolve(proof(lease));
      },
      ...overrides,
    };
  }
  function deferred<T>() {
    return createDeferredPromise<T>(context.signal);
  }
  async function waitForAdvisoryWaiter() {
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await pool.query(
        "SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND wait_event = 'advisory'",
        [applicationName],
      );
      if (result.rowCount) {
        return;
      }
      await pool.query("SELECT pg_sleep(0.01)");
    }
    throw new Error("expected a PostgreSQL advisory-lock waiter");
  }
  async function expire(lease: ErasureLease) {
    await db
      .update(work)
      .set({ leaseExpiresAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(work.id, lease.workId));
  }

  it("rejects a snapshot-isolated writer before it can miss a concurrent closure", async () => {
    await expect(
      db.transaction(
        async (tx) => {
          return await assertErasureSubjectWritable(tx, [decision()]);
        },
        { isolationLevel: "repeatable read" },
      ),
    ).rejects.toThrow("unsupported_isolation");
  });
  it("projects exactly once, rejects conflicting decisions, and separates user from organization", async () => {
    const input = decision();
    const [first, second] = await Promise.all([project(input), project(input)]);
    expect(second.id).toBe(first.id);
    await expect(project({ ...input, dispositionVersion: 2 })).rejects.toThrow(
      "conflicting_decision",
    );
    await expect(
      project({ ...input, subjectKind: "organization" }),
    ).rejects.toThrow("conflicting_decision");
    const org = await project(
      decision({ subjectKind: "organization", subjectId: input.subjectId }),
    );
    expect(org.id).not.toBe(first.id);
    const successor = await project({
      ...input,
      generation: 2,
      decisionRef: randomUUID(),
      decisionSequence: 2n,
      previousDecisionRef: input.decisionRef,
    });
    expect((await project(input)).id).toBe(first.id);
    await expect(claimErasureWork(db, first.id, "inventory")).rejects.toThrow(
      "stale_generation",
    );
    await expect(
      project({ ...input, decisionRef: randomUUID() }),
    ).rejects.toThrow("stale_decision");
    expect(successor.generation).toBe(2);
  });

  it("serializes first closure behind a writer without a pre-existing job", async () => {
    const input = decision();
    const entered = deferred<void>();
    const release = deferred<void>();
    userIds.push(input.subjectId);
    const writing = db.transaction(async (tx) => {
      await assertErasureSubjectWritable(tx, [input]);
      await tx.insert(users).values({ id: input.subjectId });
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const closing = project(input);
    const completed = Promise.allSettled([writing, closing]);
    onTestFinished(async () => {
      await completed;
    });
    await waitForAdvisoryWaiter();
    release.resolve();
    await expect(completed).resolves.toMatchObject([
      { status: "fulfilled" },
      { status: "fulfilled" },
    ]);
    await expect(
      db.transaction(async (tx) => {
        return await assertErasureSubjectWritable(tx, [input]);
      }),
    ).rejects.toThrow("subject_closed");
    // A user guard does not close a same-spelled organizational identity.
    await db.transaction(async (tx) => {
      return await assertErasureSubjectWritable(tx, [
        { subjectKind: "organization", subjectId: input.subjectId },
      ]);
    });
    await expect(
      db.select().from(users).where(eq(users.id, input.subjectId)),
    ).resolves.toHaveLength(1);
  });

  it("rejects a writer that raced a first closure already holding the subject lock", async () => {
    const input = decision();
    const entered = deferred<void>();
    const release = deferred<void>();
    const closing = db.transaction(async (tx) => {
      const job = await projectErasureDecision(tx, input);
      jobIds.push(job.id);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const writing = Promise.allSettled([
      db.transaction(async (tx) => {
        return await assertErasureSubjectWritable(tx, [input]);
      }),
    ]);
    const completed = Promise.allSettled([closing, writing]);
    onTestFinished(async () => {
      await completed;
    });
    await waitForAdvisoryWaiter();
    release.resolve();
    await closing;
    const [result] = await writing;
    expect(result).toMatchObject({
      status: "rejected",
      reason: new Error("account_erasure:subject_closed"),
    });
  });

  it("retains locators after synthetic source-root deletion and requires a distinct capture barrier", async () => {
    const input = decision();
    userIds.push(input.subjectId);
    await db.insert(users).values({ id: input.subjectId });
    const initial = await project(input);
    const source = sink();
    const job = await reviseErasureInventory(db, initial.id, initial, [source]);
    const [lease] = await claimErasureWork(db, job.id, "inventory");
    expect(lease).toBeDefined();
    if (!lease) {
      throw new Error("missing claim");
    }
    const item = target(source.sinkId);
    await expect(
      db.transaction(async (tx) => {
        return await assertErasureSourceCaptured(
          tx,
          input,
          job.id,
          { ...job, producerBoundaryRef: randomUUID() },
          [item],
        );
      }),
    ).rejects.toThrow("capture_unsealed");
    await commitErasureInventoryPage(db, lease, completePage([item]));
    const sealed = await seal(job);
    if (!sealed.producerBoundaryRef) {
      throw new Error("missing boundary");
    }
    const boundary = sealed.producerBoundaryRef;
    await db.transaction(async (tx) => {
      await assertErasureSourceCaptured(
        tx,
        input,
        job.id,
        { ...sealed, producerBoundaryRef: boundary },
        [item],
      );
      await tx.delete(users).where(eq(users.id, input.subjectId));
    });
    await expect(
      db
        .select()
        .from(work)
        .where(and(eq(work.jobId, job.id), eq(work.itemKey, item.itemKey))),
    ).resolves.toMatchObject([
      { selectorCiphertext: item.selector.ciphertext },
    ]);
    await expect(
      db.transaction(async (tx) => {
        return await assertErasureSubjectWritable(tx, [input]);
      }),
    ).rejects.toThrow("subject_closed");
  });

  it("claims a bounded disjoint set, rejects expiry before reclaim, and resumes the committed cursor", async () => {
    const { job } = await inventory([sink(), sink(), sink()]);
    const [a, b] = await Promise.all([
      claimErasureWork(db, job.id, "inventory", 2),
      claimErasureWork(db, job.id, "inventory", 2),
    ]);
    expect(
      new Set(
        [...a, ...b].map((item) => {
          return item.workId;
        }),
      ).size,
    ).toBe(3);
    const lease = a[0];
    if (!lease) {
      throw new Error("missing claim");
    }
    const cursor = encrypted();
    const first = {
      ...completePage([target(lease.item.sinkId)]),
      nextCursor: cursor,
      enumerationRef: null,
    };
    await commitErasureInventoryPage(db, lease, first);
    await expire(lease);
    await expect(renewErasureLease(db, lease)).rejects.toThrow("lease_lost");
    await expect(
      commitErasureInventoryPage(db, lease, completePage([], cursor.digest)),
    ).rejects.toThrow("lease_lost");
    const [reclaimed] = await claimErasureWork(db, job.id, "inventory");
    if (!reclaimed) {
      throw new Error("missing reclaim");
    }
    expect(reclaimed.workId).toBe(lease.workId);
    expect(reclaimed.leaseId).not.toBe(lease.leaseId);
    expect(reclaimed.item.cursorDigest).toBe(cursor.digest);
    expect(reclaimed.item.attemptCount).toBe(2);
    await commitErasureInventoryPage(
      db,
      reclaimed,
      completePage([target(lease.item.sinkId)], cursor.digest),
    );
    await expect(claimErasureWork(db, job.id, "inventory", 9)).rejects.toThrow(
      "claim_limit",
    );
  });

  it("atomically commits multiple pages, exact replay, and item/cursor rollback on conflicting capture", async () => {
    const { job, required } = await inventory();
    const [lease] = await claimErasureWork(db, job.id, "inventory");
    if (!lease || !required[0]) {
      throw new Error("missing fixture");
    }
    const cursor = encrypted();
    const existing = target(required[0].sinkId);
    const first = {
      ...completePage([existing]),
      nextCursor: cursor,
      enumerationRef: null,
    };
    await commitErasureInventoryPage(db, lease, first);
    await commitErasureInventoryPage(db, lease, first);
    await expect(
      commitErasureInventoryPage(db, lease, { ...first, items: [] }),
    ).rejects.toThrow("conflicting_page");
    const added = target(required[0].sinkId);
    await expect(
      commitErasureInventoryPage(
        db,
        lease,
        completePage(
          [added, { ...existing, selector: encrypted() }],
          cursor.digest,
        ),
      ),
    ).rejects.toThrow("conflicting_item");
    await expect(
      db
        .select()
        .from(work)
        .where(and(eq(work.jobId, job.id), eq(work.itemKey, added.itemKey))),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(work).where(eq(work.id, lease.workId)),
    ).resolves.toMatchObject([
      { cursorDigest: cursor.digest, captureComplete: false },
    ]);
    const final = completePage([added, existing], cursor.digest);
    await commitErasureInventoryPage(db, lease, final);
    await commitErasureInventoryPage(db, lease, final);
    await expect(
      db.select().from(work).where(eq(work.jobId, job.id)),
    ).resolves.toHaveLength(3);
    await expect(
      db.select().from(pages).where(eq(pages.workId, lease.workId)),
    ).resolves.toHaveLength(2);
    await seal(job);
    await expect(
      commitErasureInventoryPage(db, lease, completePage()),
    ).rejects.toThrow("stale_boundary");
  });

  it("invalidates late proof, boundary, and inventory leases when another required sink appears", async () => {
    const { job, required } = await inventory();
    const [capturing] = await claimErasureWork(db, job.id, "inventory");
    if (!capturing || !required[0]) {
      throw new Error("missing fixture");
    }
    await commitErasureInventoryPage(db, capturing, completePage());
    const sealed = await seal(job);
    const [lease] = await claimErasureWork(db, job.id, "verification");
    if (!lease) {
      throw new Error("missing claim");
    }
    const entered = deferred<void>();
    const finish = deferred<ErasureProof>();
    const result = Promise.allSettled([
      executeErasureWork(
        db,
        lease,
        handler(required[0].collectorVersion, {
          verify: async () => {
            entered.resolve();
            return await finish.promise;
          },
        }),
        context.signal,
      ),
    ]);
    await entered.promise;
    const revised = await reviseErasureInventory(db, job.id, sealed, [
      ...required,
      sink(),
    ]);
    finish.resolve(proof(lease));
    await expect(result).resolves.toMatchObject([
      {
        status: "rejected",
        reason: new Error("account_erasure:stale_revision"),
      },
    ]);
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "stale_revision",
    );
    await expect(seal(revised)).rejects.toThrow("capture_incomplete");
    await expect(
      db.select().from(work).where(eq(work.id, lease.workId)),
    ).resolves.toMatchObject([
      { state: "pending", evidenceRef: null, captureComplete: false },
    ]);
  });

  it("never turns empty inventory, missing handlers, permissions, deadlines, or 2xx into erasure", async () => {
    const empty = await project();
    await expect(seal(empty)).rejects.toThrow("inventory_missing");
    await expect(
      reviseErasureInventory(db, empty.id, empty, []),
    ).rejects.toThrow("sink_limit");
    const { job, required } = await inventory();
    const [lease] = await claimErasureWork(db, job.id, "inventory");
    if (!lease || !required[0]) {
      throw new Error("missing fixture");
    }
    await expect(
      commitErasureInventoryPage(db, lease, {
        ...completePage(),
        enumerationRef: null,
      }),
    ).rejects.toThrow("enumeration_unproven");
    await executeErasureWork(db, lease, undefined, context.signal);
    await expect(
      db.select().from(work).where(eq(work.id, lease.workId)),
    ).resolves.toMatchObject([
      { state: "capability_unresolved", errorCode: "handler_missing" },
    ]);
    const revised = await reviseErasureInventory(db, job.id, job, required);
    const [capture] = await claimErasureWork(db, job.id, "inventory");
    if (!capture) {
      throw new Error("missing claim");
    }
    await commitErasureInventoryPage(
      db,
      capture,
      completePage([target(required[0].sinkId)]),
    );
    const sealed = await seal(revised);
    const claims = await claimErasureWork(db, job.id, "verification");
    const requestRef = randomUUID();
    for (const claim of claims) {
      await executeErasureWork(
        db,
        claim,
        handler(required[0].collectorVersion, {
          erase: () => {
            return Promise.resolve({ requestRef });
          },
          verify: () => {
            return Promise.resolve({
              outcome: "capability_unresolved",
              errorCode: "permission_missing",
              requestRef: null,
            });
          },
        }),
        context.signal,
      );
    }
    await expect(
      db
        .select()
        .from(work)
        .where(and(eq(work.jobId, job.id), eq(work.kind, "erase"))),
    ).resolves.toMatchObject([
      {
        state: "capability_unresolved",
        errorCode: "permission_missing",
        requestRef,
        evidenceRef: null,
      },
    ]);
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "work_unresolved",
    );
    const expired = await project(
      decision({ deadlineAt: new Date("2026-01-02T00:00:00Z") }),
    );
    await reviseErasureInventory(db, expired.id, expired, [sink()]);
    await expect(
      claimErasureWork(db, expired.id, "inventory"),
    ).resolves.toStrictEqual([]);
    await expect(
      db.select().from(work).where(eq(work.jobId, expired.id)),
    ).resolves.toMatchObject([
      { state: "capability_unresolved", errorCode: "deadline_exceeded" },
    ]);
  });

  it("preserves prior receipts when selectors are missing and keeps exhausted retries unresolved", async () => {
    const { job, required } = await inventory();
    const source = required[0];
    const [capture] = await claimErasureWork(db, job.id, "inventory");
    if (!source || !capture) {
      throw new Error("missing fixture");
    }
    await commitErasureInventoryPage(
      db,
      capture,
      completePage([target(source.sinkId)]),
    );
    const sealed = await seal(job);
    const claims = await claimErasureWork(db, job.id, "verification");
    const missing = claims.find((lease) => {
      return lease.item.kind === "erase";
    });
    const exhausted = claims.find((lease) => {
      return lease.item.kind === "inventory";
    });
    if (!missing || !exhausted) {
      throw new Error("missing fixture");
    }
    const requestRef = randomUUID();
    await db
      .update(work)
      .set({ selectorCiphertext: null, requestRef })
      .where(eq(work.id, missing.workId));
    await executeErasureWork(
      db,
      missing,
      handler(source.collectorVersion),
      context.signal,
    );
    await expect(
      db.select().from(work).where(eq(work.id, missing.workId)),
    ).resolves.toMatchObject([
      {
        state: "capability_unresolved",
        errorCode: "selector_missing",
        requestRef,
        evidenceRef: null,
      },
    ]);
    await db
      .update(work)
      .set({ attemptCount: 20 })
      .where(eq(work.id, exhausted.workId));
    await expire(exhausted);
    await expect(
      claimErasureWork(db, job.id, "verification"),
    ).resolves.toStrictEqual([]);
    await expect(
      db.select().from(work).where(eq(work.id, exhausted.workId)),
    ).resolves.toMatchObject([
      {
        state: "capability_unresolved",
        errorCode: "retry_exhausted",
        evidenceRef: null,
        leaseId: null,
      },
    ]);
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "work_unresolved",
    );
  });

  it("preserves an only locator on failed/empty dependencies and retires it only after recovery proof", async () => {
    const source = sink();
    const erased = target(source.sinkId);
    const recovery = target(source.sinkId, "recovery");
    const common = [
      {
        sinkId: source.sinkId,
        itemKey: erased.itemKey,
        obligation: "erasure" as const,
      },
      {
        sinkId: source.sinkId,
        itemKey: recovery.itemKey,
        obligation: "recovery" as const,
      },
    ];
    const configured = {
      ...source,
      dependencies: [
        ...common,
        {
          sinkId: source.sinkId,
          itemKey: source.sinkId,
          obligation: "erasure" as const,
        },
      ],
    };
    const { job } = await inventory([configured]);
    const [capture] = await claimErasureWork(db, job.id, "inventory");
    if (!capture) {
      throw new Error("missing fixture");
    }
    await commitErasureInventoryPage(
      db,
      capture,
      completePage([
        { ...erased, dependencies: common },
        { ...recovery, dependencies: common },
      ]),
    );
    const sealed = await seal(job);
    const claims = await claimErasureWork(db, job.id, "verification");
    const erasure = claims.find((item) => {
      return item.item.itemKey === erased.itemKey;
    });
    const restore = claims.find((item) => {
      return item.item.itemKey === recovery.itemKey;
    });
    if (!erasure || !restore) {
      throw new Error("missing fixtures");
    }
    for (const lease of claims.filter((item) => {
      return item.workId !== restore.workId;
    })) {
      await executeErasureWork(
        db,
        lease,
        handler(source.collectorVersion),
        context.signal,
      );
    }
    await expect(
      retireErasureSelector(db, job.id, erasure.workId, sealed),
    ).rejects.toThrow("dependency_unresolved");
    await expect(
      db.select().from(work).where(eq(work.id, erasure.workId)),
    ).resolves.toMatchObject([
      { selectorCiphertext: erased.selector.ciphertext },
    ]);
    await executeErasureWork(
      db,
      restore,
      handler(source.collectorVersion),
      context.signal,
    );
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_erased",
    );
    for (const lease of claims) {
      await retireErasureSelector(db, job.id, lease.workId, sealed);
    }
    await expect(
      db.select().from(work).where(eq(work.jobId, job.id)),
    ).resolves.toHaveLength(3);
    const reference = randomUUID();
    const verifier = {
      verify: () => {
        return Promise.resolve({
          ...sealed,
          jobId: job.id,
          reference,
          decisionRef: sealed.decisionRef,
          coveringDecisionRef: sealed.decisionRef,
          covering: {
            ...sealed,
            jobId: job.id,
            reference: sealed.producerBoundaryRef ?? "",
          },
        });
      },
    };
    await expect(
      retireErasureProjectionPage(db, job.id, verifier, context.signal),
    ).resolves.toBe("pending");
    await expect(
      retireErasureProjectionPage(db, job.id, verifier, context.signal),
    ).resolves.toBe("pending");
    await expect(
      retireErasureProjectionPage(db, job.id, verifier, context.signal),
    ).resolves.toBe("retired");
    await expect(
      db.select().from(jobs).where(eq(jobs.id, job.id)),
    ).resolves.toHaveLength(0);
    await expect(
      db.select().from(work).where(eq(work.jobId, job.id)),
    ).resolves.toHaveLength(0);
  });

  it("cannot commit a provider proof after lease expiry or retire an empty dependency declaration", async () => {
    const { job, required } = await inventory();
    const [capture] = await claimErasureWork(db, job.id, "inventory");
    if (!capture || !required[0]) {
      throw new Error("missing fixture");
    }
    await commitErasureInventoryPage(db, capture, completePage());
    const sealed = await seal(job);
    const [lease] = await claimErasureWork(db, job.id, "verification");
    if (!lease) {
      throw new Error("missing claim");
    }
    const entered = deferred<void>();
    const finish = deferred<ErasureProof>();
    const result = Promise.allSettled([
      executeErasureWork(
        db,
        lease,
        handler(required[0].collectorVersion, {
          verify: async () => {
            entered.resolve();
            return await finish.promise;
          },
        }),
        context.signal,
      ),
    ]);
    await entered.promise;
    await expire(lease);
    finish.resolve(proof(lease));
    await expect(result).resolves.toMatchObject([
      { status: "rejected", reason: new Error("account_erasure:lease_lost") },
    ]);
    const [retry] = await claimErasureWork(db, job.id, "verification");
    if (!retry) {
      throw new Error("missing retry");
    }
    await executeErasureWork(
      db,
      retry,
      handler(required[0].collectorVersion),
      context.signal,
    );
    await expect(
      retireErasureSelector(db, job.id, lease.workId, sealed),
    ).rejects.toThrow("dependencies_incomplete");
  });

  it("expands recovery dependencies only through a new capture revision", async () => {
    const source = sink();
    const item = target(source.sinkId);
    const recovery = target(source.sinkId, "recovery");
    const initialDependencies = [
      {
        sinkId: source.sinkId,
        itemKey: item.itemKey,
        obligation: "erasure" as const,
      },
      {
        sinkId: source.sinkId,
        itemKey: recovery.itemKey,
        obligation: "recovery" as const,
      },
    ];
    const { job } = await inventory([source]);
    const [oldLease] = await claimErasureWork(db, job.id, "inventory");
    if (!oldLease) {
      throw new Error("missing fixture");
    }
    await commitErasureInventoryPage(
      db,
      oldLease,
      completePage([{ ...item, dependencies: initialDependencies }, recovery]),
    );
    const sealed = await seal(job);
    const newSink = sink();
    const newRecovery = target(newSink.sinkId, "recovery");
    const expanded = [
      ...initialDependencies,
      {
        sinkId: newSink.sinkId,
        itemKey: newRecovery.itemKey,
        obligation: "recovery" as const,
      },
    ];
    const revised = await reviseErasureInventory(db, job.id, sealed, [
      source,
      newSink,
    ]);
    const captures = await claimErasureWork(db, job.id, "inventory");
    const sourceLease = captures.find((claim) => {
      return claim.item.sinkId === source.sinkId;
    });
    const newLease = captures.find((claim) => {
      return claim.item.sinkId === newSink.sinkId;
    });
    if (!sourceLease || !newLease) {
      throw new Error("missing fixtures");
    }
    await expect(
      commitErasureInventoryPage(db, sourceLease, completePage([item])),
    ).rejects.toThrow("dependency_removal");
    await commitErasureInventoryPage(
      db,
      sourceLease,
      completePage([{ ...item, dependencies: expanded }, recovery]),
    );
    await commitErasureInventoryPage(db, newLease, completePage([newRecovery]));
    const recaptured = await seal(revised);
    const claims = await claimErasureWork(db, job.id, "verification");
    const erasure = claims.find((claim) => {
      return claim.item.itemKey === item.itemKey;
    });
    const last = claims.find((claim) => {
      return claim.item.itemKey === newRecovery.itemKey;
    });
    if (!erasure || !last) {
      throw new Error("missing fixtures");
    }
    for (const claim of claims.filter((claim) => {
      return claim !== last;
    })) {
      await executeErasureWork(
        db,
        claim,
        handler(
          claim.item.sinkId === source.sinkId
            ? source.collectorVersion
            : newSink.collectorVersion,
        ),
        context.signal,
      );
    }
    await expect(
      retireErasureSelector(db, job.id, erasure.workId, recaptured),
    ).rejects.toThrow("dependency_unresolved");
    await executeErasureWork(
      db,
      last,
      handler(newSink.collectorVersion),
      context.signal,
    );
    await retireErasureSelector(db, job.id, erasure.workId, recaptured);
    await expect(
      db.select().from(work).where(eq(work.id, erasure.workId)),
    ).resolves.toMatchObject([
      {
        selectorCiphertext: null,
        selectorCaptureRevision: recaptured.captureRevision,
      },
    ]);
  });

  it("passes the persisted request reference to verification and keeps interrupted capture reclaimable", async () => {
    const { job, required } = await inventory();
    const [capture] = await claimErasureWork(db, job.id, "inventory");
    const source = required[0];
    if (!capture || !source) {
      throw new Error("missing fixture");
    }
    const controller = new AbortController();
    await expect(
      executeErasureWork(
        db,
        capture,
        handler(source.collectorVersion, {
          inventory: () => {
            controller.abort();
            return Promise.resolve(completePage());
          },
        }),
        controller.signal,
      ),
    ).rejects.toThrow("This operation was aborted");
    await expect(
      db.select().from(pages).where(eq(pages.workId, capture.workId)),
    ).resolves.toHaveLength(0);
    await expire(capture);
    const [restart] = await claimErasureWork(db, job.id, "inventory");
    if (!restart) {
      throw new Error("missing claim");
    }
    await commitErasureInventoryPage(
      db,
      restart,
      completePage([target(source.sinkId)]),
    );
    const sealed = await seal(job);
    const claims = await claimErasureWork(db, job.id, "verification");
    const requestRef = randomUUID();
    for (const claim of claims) {
      await executeErasureWork(
        db,
        claim,
        handler(source.collectorVersion, {
          erase: () => {
            return Promise.resolve({ requestRef });
          },
          verify: (leased) => {
            if (
              leased.item.kind !== "inventory" &&
              leased.item.requestRef !== requestRef
            ) {
              return Promise.resolve({
                outcome: "capability_unresolved",
                errorCode: "verification_failed",
                requestRef: null,
              });
            }
            return Promise.resolve(proof(leased));
          },
        }),
        context.signal,
      );
    }
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_erased",
    );
  });

  it("requires declared authenticated absence proof even for an empty completed enumeration", async () => {
    const { job, required } = await inventory();
    const [capture] = await claimErasureWork(db, job.id, "inventory");
    if (!capture || !required[0]) {
      throw new Error("missing fixture");
    }
    await commitErasureInventoryPage(db, capture, completePage());
    const sealed = await seal(job);
    await expect(finalizeErasureJob(db, job.id, sealed)).rejects.toThrow(
      "work_unresolved",
    );
    const [lease] = await claimErasureWork(db, job.id, "verification");
    if (!lease) {
      throw new Error("missing fixture");
    }
    await executeErasureWork(
      db,
      lease,
      handler(required[0].collectorVersion, {
        verify: (leased) => {
          return Promise.resolve({
            ...proof(leased),
            outcome: "verified_no_applicable_data",
          });
        },
      }),
      context.signal,
    );
    expect((await finalizeErasureJob(db, job.id, sealed)).state).toBe(
      "verified_no_applicable_data",
    );
    await db
      .update(jobs)
      .set({ deadlineAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(jobs.id, job.id));
    await expect(
      claimErasureWork(db, job.id, "verification"),
    ).resolves.toStrictEqual([]);
    await expect(
      db.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, job.id)),
    ).resolves.toStrictEqual([{ state: "verified_no_applicable_data" }]);
  });

  it("retires superseded mappings with current coverage and recovers a new generation between pages", async () => {
    const source = sink();
    const item = target(source.sinkId);
    const recovery = target(source.sinkId, "recovery");
    const common = [
      {
        sinkId: source.sinkId,
        itemKey: item.itemKey,
        obligation: "erasure" as const,
      },
      {
        sinkId: source.sinkId,
        itemKey: recovery.itemKey,
        obligation: "recovery" as const,
      },
    ];
    const configured = {
      ...source,
      dependencies: [
        ...common,
        {
          sinkId: source.sinkId,
          itemKey: source.sinkId,
          obligation: "erasure" as const,
        },
      ],
    };
    const input = decision();
    const first = await project(input);
    const firstRevision = await reviseErasureInventory(db, first.id, first, [
      configured,
    ]);
    const [oldLease] = await claimErasureWork(db, first.id, "inventory");
    if (!oldLease) {
      throw new Error("missing fixture");
    }
    const items = [
      { ...item, dependencies: common },
      { ...recovery, dependencies: common },
    ];
    await commitErasureInventoryPage(db, oldLease, completePage(items));
    async function completeGeneration(initial: typeof jobs.$inferSelect) {
      const revision = await reviseErasureInventory(db, initial.id, initial, [
        configured,
      ]);
      const [capture] = await claimErasureWork(db, initial.id, "inventory");
      if (!capture) {
        throw new Error("missing fixture");
      }
      await commitErasureInventoryPage(db, capture, completePage(items));
      const sealed = await seal(revision);
      const claims = await claimErasureWork(db, initial.id, "verification");
      for (const claim of claims) {
        await executeErasureWork(
          db,
          claim,
          handler(source.collectorVersion),
          context.signal,
        );
      }
      await finalizeErasureJob(db, initial.id, sealed);
      for (const claim of claims) {
        await retireErasureSelector(db, initial.id, claim.workId, sealed);
      }
      return sealed;
    }
    const nextInput = {
      ...input,
      generation: 2,
      decisionSequence: 2n,
      decisionRef: randomUUID(),
      previousDecisionRef: input.decisionRef,
    };
    const second = await project(nextInput);
    await completeGeneration(second);
    const verifier = {
      verify: (
        job: typeof jobs.$inferSelect,
        covering: typeof jobs.$inferSelect,
      ) => {
        return Promise.resolve({
          ...job,
          jobId: job.id,
          reference: randomUUID(),
          decisionRef: job.decisionRef,
          coveringDecisionRef: covering.decisionRef,
          covering: {
            ...covering,
            jobId: covering.id,
            reference: covering.producerBoundaryRef ?? "",
          },
        });
      },
    };
    await expect(
      retireErasureProjectionPage(db, second.id, verifier, context.signal),
    ).rejects.toThrow("earlier_generation_unresolved");
    await expect(
      retireErasureProjectionPage(db, first.id, verifier, context.signal),
    ).resolves.toBe("pending");
    const third = await project({
      ...nextInput,
      generation: 3,
      decisionSequence: 3n,
      decisionRef: randomUUID(),
      previousDecisionRef: second.decisionRef,
    });
    await expect(
      retireErasureProjectionPage(db, first.id, verifier, context.signal),
    ).rejects.toThrow("work_unresolved");
    await completeGeneration(third);
    await expect(renewErasureLease(db, oldLease)).rejects.toThrow(
      "stale_generation",
    );
    await expect(
      finalizeErasureJob(db, first.id, firstRevision),
    ).rejects.toThrow("stale_generation");
    for (const job of [first, second, third]) {
      let result: "pending" | "retired" = "pending";
      for (let page = 0; page < 5 && result === "pending"; page++) {
        result = await retireErasureProjectionPage(
          db,
          job.id,
          verifier,
          context.signal,
        );
      }
      expect(result).toBe("retired");
    }
  });
});
