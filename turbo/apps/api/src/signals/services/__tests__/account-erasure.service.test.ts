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
  lockErasureSubjects,
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
  type ErasureUnresolved,
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
  function releaseGate() {
    const gate = deferred<void>();
    return {
      promise: gate.promise,
      release() {
        if (!gate.settled()) {
          gate.resolve();
        }
      },
    };
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

  function noncanonicalUuid(value: string): string {
    const uppercase = value.toUpperCase();
    // Digit-only UUIDs have no uppercase variant. Braces preserve the same
    // PostgreSQL identity while still violating the canonical input contract.
    return uppercase === value ? `{${value}}` : uppercase;
  }

  async function erasureFixture() {
    const source = sink();
    const { job } = await inventory([source]);
    const [capture] = await claimErasureWork(db, job.id, "inventory");
    if (!capture) {
      throw new Error("missing capture");
    }
    await commitErasureInventoryPage(
      db,
      capture,
      completePage([target(source.sinkId)]),
    );
    const sealed = await seal(job);
    const claims = await claimErasureWork(db, job.id, "verification");
    const lease = claims.find((claim) => {
      return claim.item.kind === "erase";
    });
    const collector = claims.find((claim) => {
      return claim.item.kind === "inventory";
    });
    if (!lease || !collector) {
      throw new Error("missing claims");
    }
    await executeErasureWork(
      db,
      collector,
      handler(source.collectorVersion),
      context.signal,
    );
    return { job: sealed, source, lease };
  }

  it.each([
    ["pending", false],
    ["retryable_failure", false],
    ["pending", true],
    ["retryable_failure", true],
  ] as const)(
    "retains a %s receipt across the deadline (null: %s)",
    async (outcome, noNewReceipt) => {
      const { job, source, lease } = await erasureFixture();
      const previousRef = randomUUID();
      const requestRef = noNewReceipt ? null : randomUUID();
      await db
        .update(work)
        .set({ requestRef: previousRef })
        .where(eq(work.id, lease.workId));
      const entered = deferred<void>();
      const returned = deferred<ErasureUnresolved>();
      const result = Promise.allSettled([
        executeErasureWork(
          db,
          lease,
          handler(source.collectorVersion, {
            erase: async () => {
              entered.resolve();
              return await returned.promise;
            },
            verify: () => {
              throw new Error("unexpected verification");
            },
          }),
          context.signal,
        ),
      ]);
      await entered.promise;
      // Explicit infrastructure state: the job deadline crosses while the provider
      // owns the request, but the lease still has its original valid expiry.
      await db
        .update(jobs)
        .set({ deadlineAt: sql`clock_timestamp() - interval '1 second'` })
        .where(eq(jobs.id, job.id));
      returned.resolve({
        outcome,
        errorCode: "verification_failed",
        requestRef,
      });
      await expect(result).resolves.toMatchObject([{ status: "fulfilled" }]);
      await expect(
        db.select().from(work).where(eq(work.id, lease.workId)),
      ).resolves.toMatchObject([
        {
          state: "capability_unresolved",
          errorCode: "deadline_exceeded",
          requestRef: requestRef ?? previousRef,
          evidenceRef: null,
          leaseId: null,
        },
      ]);
      await expect(finalizeErasureJob(db, job.id, job)).rejects.toThrow(
        "work_unresolved",
      );
    },
  );

  it.each(["acknowledged", "pending", "retryable_failure"] as const)(
    "retains a %s receipt after abort without starting verification",
    async (outcome) => {
      const { job, source, lease } = await erasureFixture();
      const controller = new AbortController();
      const entered = deferred<void>();
      const returned = deferred<Awaited<ReturnType<ErasureHandler["erase"]>>>();
      const requestRef = randomUUID();
      let verified = false;
      const result = Promise.allSettled([
        executeErasureWork(
          db,
          lease,
          handler(source.collectorVersion, {
            erase: async () => {
              entered.resolve();
              return await returned.promise;
            },
            verify: (current) => {
              verified = true;
              return Promise.resolve(proof(current));
            },
          }),
          controller.signal,
        ),
      ]);
      await entered.promise;
      controller.abort();
      returned.resolve(
        outcome === "acknowledged"
          ? { requestRef }
          : { outcome, requestRef, errorCode: "verification_failed" },
      );
      await expect(result).resolves.toMatchObject([
        {
          status: "rejected",
          reason: expect.objectContaining({ name: "AbortError" }),
        },
      ]);
      expect(verified).toBeFalsy();
      await expect(
        db.select().from(work).where(eq(work.id, lease.workId)),
      ).resolves.toMatchObject([
        {
          requestRef,
          evidenceRef: null,
          state: outcome === "acknowledged" ? "pending" : outcome,
        },
      ]);
      await expect(finalizeErasureJob(db, job.id, job)).rejects.toThrow(
        "work_unresolved",
      );
    },
  );

  it("starts no provider work for pre-aborted execution and rejects proof returned after abort", async () => {
    const { job, source, lease } = await erasureFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      executeErasureWork(
        db,
        lease,
        handler(source.collectorVersion, {
          erase: () => {
            throw new Error("unexpected submission");
          },
        }),
        controller.signal,
      ),
    ).rejects.toThrow("This operation was aborted");
    const verifying = new AbortController();
    const requestRef = randomUUID();
    await expect(
      executeErasureWork(
        db,
        lease,
        handler(source.collectorVersion, {
          erase: () => {
            return Promise.resolve({ requestRef });
          },
          verify: (current) => {
            verifying.abort();
            return Promise.resolve(proof(current));
          },
        }),
        verifying.signal,
      ),
    ).rejects.toThrow("This operation was aborted");
    await expect(
      db.select().from(work).where(eq(work.id, lease.workId)),
    ).resolves.toMatchObject([
      {
        state: "pending",
        requestRef,
        evidenceRef: null,
      },
    ]);
    await expect(finalizeErasureJob(db, job.id, job)).rejects.toThrow(
      "work_unresolved",
    );
  });

  it.each([
    "expired",
    "replaced",
    "generation",
    "capture",
    "inventory",
    "boundary",
  ] as const)(
    "rejects a returned receipt from an owner invalidated by %s",
    async (change) => {
      const { job, source, lease } = await erasureFixture();
      const previousRef = randomUUID();
      await db
        .update(work)
        .set({ requestRef: previousRef })
        .where(eq(work.id, lease.workId));
      const entered = deferred<void>();
      const returned = deferred<ErasureUnresolved>();
      const result = Promise.allSettled([
        executeErasureWork(
          db,
          lease,
          handler(source.collectorVersion, {
            erase: async () => {
              entered.resolve();
              return await returned.promise;
            },
            verify: () => {
              throw new Error("unexpected verification");
            },
          }),
          context.signal,
        ),
      ]);
      await entered.promise;
      let replacement: ErasureLease | undefined;
      if (change === "expired" || change === "replaced") {
        await expire(lease);
        if (change === "replaced") {
          [replacement] = await claimErasureWork(db, job.id, "verification");
          expect(replacement?.workId).toBe(lease.workId);
        }
      } else if (change === "generation") {
        await project(
          decision({
            subjectKind: job.subjectKind,
            subjectId: job.subjectId,
            authorityId: job.authorityId,
            generation: job.generation + 1,
            decisionSequence: job.decisionSequence + 1n,
            decisionRef: randomUUID(),
            previousDecisionRef: job.decisionRef,
          }),
        );
      } else {
        // Separate revision fixtures prove each CAS term remains required.
        await db
          .update(jobs)
          .set(
            change === "capture"
              ? { captureRevision: job.captureRevision + 1 }
              : change === "inventory"
                ? { inventoryRevision: job.inventoryRevision + 1 }
                : { producerBoundaryRef: randomUUID() },
          )
          .where(eq(jobs.id, job.id));
      }
      returned.resolve({
        outcome: "pending",
        errorCode: "verification_failed",
        requestRef: randomUUID(),
      });
      const code =
        change === "generation"
          ? "stale_generation"
          : change === "boundary"
            ? "stale_boundary"
            : change === "capture" || change === "inventory"
              ? "stale_revision"
              : "lease_lost";
      await expect(result).resolves.toMatchObject([
        { status: "rejected", reason: new Error(`account_erasure:${code}`) },
      ]);
      await expect(
        db.select().from(work).where(eq(work.id, lease.workId)),
      ).resolves.toMatchObject([
        {
          requestRef: previousRef,
          evidenceRef: null,
          state: "pending",
          leaseId: replacement?.leaseId ?? lease.leaseId,
        },
      ]);
    },
  );

  it.each([
    "authorityId",
    "decisionRef",
    "confirmationRef",
    "previousDecisionRef",
  ] as const)(
    "rejects noncanonical decision %s before persistence and preserves canonical replay",
    async (field) => {
      const first = decision();
      const original = await project(first);
      const canonical =
        field === "previousDecisionRef"
          ? {
              ...first,
              generation: 2,
              decisionSequence: 2n,
              decisionRef: randomUUID(),
              previousDecisionRef: first.decisionRef,
            }
          : decision();
      const value = canonical[field];
      if (!value) {
        throw new Error("missing reference");
      }
      const invalid = { ...canonical, [field]: noncanonicalUuid(value) };
      await expect(project(invalid)).rejects.toThrow("invalid_reference");
      await expect(
        db
          .select()
          .from(jobs)
          .where(eq(jobs.decisionRef, canonical.decisionRef)),
      ).resolves.toHaveLength(0);
      const accepted = await project(canonical);
      expect((await project(canonical)).id).toBe(accepted.id);
      await expect(
        project({ ...canonical, confirmationRef: randomUUID() }),
      ).rejects.toThrow("conflicting_decision");
      expect((await project(first)).id).toBe(original.id);
    },
  );

  it("preserves case-sensitive subject identity and rejects a conflicting subject replay", async () => {
    const input = decision({ subjectId: `CaseSensitive_${randomUUID()}` });
    const original = await project(input);
    const lower = input.subjectId.toLowerCase();
    await expect(project({ ...input, subjectId: lower })).rejects.toThrow(
      "conflicting_decision",
    );
    const distinct = await project(decision({ subjectId: lower }));
    expect(distinct.id).not.toBe(original.id);
    expect(original.subjectId).toBe(input.subjectId);
  });

  it.each([
    "sinkId",
    "collectorVersion",
    "dependencySink",
    "dependencyItem",
  ] as const)(
    "rejects noncanonical %s before revising sink inventory",
    async (field) => {
      const source = sink();
      const dependency = {
        sinkId: source.sinkId,
        itemKey: source.sinkId,
        obligation: "erasure" as const,
      };
      const canonical = { ...source, dependencies: [dependency] };
      const initial = await project();
      const invalid =
        field === "sinkId" || field === "collectorVersion"
          ? { ...canonical, [field]: noncanonicalUuid(canonical[field]) }
          : {
              ...canonical,
              dependencies: [
                {
                  ...dependency,
                  [field === "dependencySink" ? "sinkId" : "itemKey"]:
                    noncanonicalUuid(source.sinkId),
                },
              ],
            };
      await expect(
        reviseErasureInventory(db, initial.id, initial, [invalid]),
      ).rejects.toThrow("invalid_reference");
      await expect(
        db.select().from(jobs).where(eq(jobs.id, initial.id)),
      ).resolves.toMatchObject([
        {
          captureRevision: initial.captureRevision,
          inventoryRevision: initial.inventoryRevision,
        },
      ]);
      await expect(
        db.select().from(sinks).where(eq(sinks.jobId, initial.id)),
      ).resolves.toHaveLength(0);
      const accepted = await reviseErasureInventory(db, initial.id, initial, [
        canonical,
      ]);
      const revised = await reviseErasureInventory(db, initial.id, accepted, [
        canonical,
      ]);
      await expect(
        db.select().from(work).where(eq(work.jobId, initial.id)),
      ).resolves.toHaveLength(1);
      await expect(
        reviseErasureInventory(db, initial.id, revised, [
          { ...canonical, domain: "providers" },
        ]),
      ).rejects.toThrow("sink_removal");
    },
  );

  it.each([
    "pageKey",
    "enumerationRef",
    "sinkId",
    "itemKey",
    "dependencySink",
    "dependencyItem",
  ] as const)(
    "rejects noncanonical page %s without losing canonical page/dependency replay",
    async (field) => {
      const { job, required } = await inventory();
      const [lease] = await claimErasureWork(db, job.id, "inventory");
      const source = required[0];
      if (!lease || !source) {
        throw new Error("missing fixture");
      }
      const item = target(source.sinkId);
      const dependency = {
        sinkId: item.sinkId,
        itemKey: item.itemKey,
        obligation: "erasure" as const,
      };
      const canonical = completePage([{ ...item, dependencies: [dependency] }]);
      const invalid =
        field === "pageKey" || field === "enumerationRef"
          ? { ...canonical, [field]: noncanonicalUuid(canonical[field]) }
          : {
              ...canonical,
              items: [
                field === "sinkId" || field === "itemKey"
                  ? {
                      ...item,
                      [field]: noncanonicalUuid(item[field]),
                      dependencies: [dependency],
                    }
                  : {
                      ...item,
                      dependencies: [
                        {
                          ...dependency,
                          [field === "dependencySink" ? "sinkId" : "itemKey"]:
                            noncanonicalUuid(
                              field === "dependencySink"
                                ? item.sinkId
                                : item.itemKey,
                            ),
                        },
                      ],
                    },
              ],
            };
      await expect(
        commitErasureInventoryPage(db, lease, invalid),
      ).rejects.toThrow("invalid_reference");
      await expect(
        db.select().from(pages).where(eq(pages.workId, lease.workId)),
      ).resolves.toHaveLength(0);
      await expect(
        db.select().from(work).where(eq(work.jobId, job.id)),
      ).resolves.toHaveLength(1);
      await commitErasureInventoryPage(db, lease, canonical);
      await commitErasureInventoryPage(db, lease, canonical);
      await expect(
        commitErasureInventoryPage(db, lease, { ...canonical, items: [] }),
      ).rejects.toThrow("conflicting_page");
      await expect(
        db.select().from(pages).where(eq(pages.workId, lease.workId)),
      ).resolves.toHaveLength(1);
      await expect(
        db.select().from(work).where(eq(work.jobId, job.id)),
      ).resolves.toHaveLength(2);
    },
  );

  it.each(["inventory", "verification"] as const)(
    "retains an unresolved %s receipt returned after abort",
    async (phase) => {
      const { job, required } = await inventory();
      const [capture] = await claimErasureWork(db, job.id, "inventory");
      const source = required[0];
      if (!capture || !source) {
        throw new Error("missing fixture");
      }
      let lease = capture;
      if (phase === "verification") {
        await commitErasureInventoryPage(db, capture, completePage());
        await seal(job);
        const [claim] = await claimErasureWork(db, job.id, "verification");
        if (!claim) {
          throw new Error("missing claim");
        }
        lease = claim;
      }
      const controller = new AbortController();
      const requestRef = randomUUID();
      const result: ErasureUnresolved = {
        outcome: "pending",
        requestRef,
        errorCode: "verification_failed",
      };
      const interrupted = () => {
        controller.abort();
        return Promise.resolve(result);
      };
      await expect(
        executeErasureWork(
          db,
          lease,
          handler(source.collectorVersion, {
            inventory: interrupted,
            verify: interrupted,
          }),
          controller.signal,
        ),
      ).rejects.toThrow("This operation was aborted");
      await expect(
        db.select().from(work).where(eq(work.id, lease.workId)),
      ).resolves.toMatchObject([
        {
          requestRef,
          evidenceRef: null,
          state: "pending",
          leaseId: null,
        },
      ]);
    },
  );

  it("rejects terminal proof when cancellation arrives while its commit waits for ownership", async () => {
    const { job, source, lease } = await erasureFixture();
    const controller = new AbortController();
    const entered = deferred<void>();
    const returned = deferred<ErasureProof>();
    const requestRef = randomUUID();
    const result = Promise.allSettled([
      executeErasureWork(
        db,
        lease,
        handler(source.collectorVersion, {
          erase: () => {
            return Promise.resolve({ requestRef });
          },
          verify: async () => {
            entered.resolve();
            return await returned.promise;
          },
        }),
        controller.signal,
      ),
    ]);
    await entered.promise;
    const locked = deferred<void>();
    const release = deferred<void>();
    const blocker = db.transaction(async (tx) => {
      await lockErasureSubjects(tx, [job]);
      locked.resolve();
      await release.promise;
    });
    onTestFinished(async () => {
      if (!release.settled()) {
        release.resolve();
      }
      await blocker;
    });
    await locked.promise;
    returned.resolve(proof(lease));
    await waitForAdvisoryWaiter();
    controller.abort();
    release.resolve();
    await blocker;
    await expect(result).resolves.toMatchObject([
      {
        status: "rejected",
        reason: expect.objectContaining({ name: "AbortError" }),
      },
    ]);
    await expect(
      db.select().from(work).where(eq(work.id, lease.workId)),
    ).resolves.toMatchObject([
      {
        state: "pending",
        requestRef,
        evidenceRef: null,
        leaseId: lease.leaseId,
      },
    ]);
    await expect(finalizeErasureJob(db, job.id, job)).rejects.toThrow(
      "work_unresolved",
    );
  });

  it("rejects noncanonical job, lease, and handler references before changing ownership or invoking an adapter", async () => {
    const { job, source, lease } = await erasureFixture();
    await expect(
      claimErasureWork(db, noncanonicalUuid(job.id), "verification"),
    ).rejects.toThrow("invalid_reference");
    for (const key of [
      "jobId",
      "workId",
      "leaseId",
      "producerBoundaryRef",
    ] as const) {
      const value = lease[key];
      if (!value) {
        throw new Error("missing reference");
      }
      await expect(
        renewErasureLease(db, { ...lease, [key]: noncanonicalUuid(value) }),
      ).rejects.toThrow("invalid_reference");
    }
    await expect(
      executeErasureWork(
        db,
        lease,
        handler(noncanonicalUuid(source.collectorVersion), {
          erase: () => {
            throw new Error("unexpected submission");
          },
        }),
        context.signal,
      ),
    ).rejects.toThrow("invalid_reference");
    await expect(
      db.select().from(work).where(eq(work.id, lease.workId)),
    ).resolves.toMatchObject([
      {
        requestRef: null,
        evidenceRef: null,
        leaseId: lease.leaseId,
        leaseExpiresAt: lease.item.leaseExpiresAt,
      },
    ]);
    await renewErasureLease(db, lease);
  });

  it.each(["acknowledged", "unresolved", "deadline"] as const)(
    "rejects a noncanonical %s request receipt without replacing an earlier reference",
    async (response) => {
      const { job, source, lease } = await erasureFixture();
      const previousRef = randomUUID();
      await db
        .update(work)
        .set({ requestRef: previousRef })
        .where(eq(work.id, lease.workId));
      await expect(
        executeErasureWork(
          db,
          lease,
          handler(source.collectorVersion, {
            erase: async () => {
              if (response === "deadline") {
                await db
                  .update(jobs)
                  .set({
                    deadlineAt: sql`clock_timestamp() - interval '1 second'`,
                  })
                  .where(eq(jobs.id, job.id));
              }
              const requestRef = "aBcdef01-2345-6789-abcd-ef0123456789";
              return response === "acknowledged"
                ? { requestRef }
                : {
                    outcome: "pending",
                    errorCode: "verification_failed",
                    requestRef,
                  };
            },
            verify: () => {
              throw new Error("unexpected verification");
            },
          }),
          context.signal,
        ),
      ).rejects.toThrow("invalid_reference");
      await expect(
        db.select().from(work).where(eq(work.id, lease.workId)),
      ).resolves.toMatchObject([
        {
          requestRef: previousRef,
          evidenceRef: null,
          state: "pending",
          leaseId: lease.leaseId,
        },
      ]);
    },
  );

  it("rejects noncanonical proof references while retaining the acknowledged submission", async () => {
    const { job, source, lease } = await erasureFixture();
    const requestRef = randomUUID();
    const valid = proof(lease);
    for (const key of [
      "workId",
      "sinkId",
      "producerBoundaryRef",
      "evidenceRef",
      "authenticatedReaderRef",
      "enumerationRef",
    ] as const) {
      await expect(
        executeErasureWork(
          db,
          lease,
          handler(source.collectorVersion, {
            erase: () => {
              return Promise.resolve({ requestRef });
            },
            verify: () => {
              return Promise.resolve({
                ...valid,
                [key]: noncanonicalUuid(valid[key]),
              });
            },
          }),
          context.signal,
        ),
      ).rejects.toThrow("invalid_reference");
      await expect(
        db.select().from(work).where(eq(work.id, lease.workId)),
      ).resolves.toMatchObject([
        {
          requestRef,
          evidenceRef: null,
          state: "pending",
          leaseId: lease.leaseId,
        },
      ]);
    }
    await executeErasureWork(
      db,
      lease,
      handler(source.collectorVersion),
      context.signal,
    );
    expect((await finalizeErasureJob(db, job.id, job)).state).toBe(
      "verified_erased",
    );
    await expect(
      retireErasureSelector(db, job.id, noncanonicalUuid(lease.workId), job),
    ).rejects.toThrow("invalid_reference");
  });

  it("rejects noncanonical producer and source-capture references before changing the capture barrier", async () => {
    const { job, required } = await inventory();
    const [lease] = await claimErasureWork(db, job.id, "inventory");
    const source = required[0];
    if (!lease || !source) {
      throw new Error("missing fixture");
    }
    const item = target(source.sinkId);
    await commitErasureInventoryPage(db, lease, completePage([item]));
    const boundary = { ...job, jobId: job.id, reference: randomUUID() };
    for (const key of ["jobId", "reference"] as const) {
      await expect(
        sealErasureCapture(
          db,
          job.id,
          job,
          {
            verify: () => {
              return Promise.resolve({
                ...boundary,
                [key]: noncanonicalUuid(boundary[key]),
              });
            },
          },
          context.signal,
        ),
      ).rejects.toThrow("invalid_reference");
      await expect(
        db.select().from(jobs).where(eq(jobs.id, job.id)),
      ).resolves.toMatchObject([
        {
          sealedCaptureRevision: null,
          producerBoundaryRef: null,
        },
      ]);
    }
    const sealed = await sealErasureCapture(
      db,
      job.id,
      job,
      {
        verify: () => {
          return Promise.resolve(boundary);
        },
      },
      context.signal,
    );
    const expected = { ...sealed, producerBoundaryRef: boundary.reference };
    for (const key of ["sinkId", "itemKey"] as const) {
      await expect(
        db.transaction(async (tx) => {
          await assertErasureSourceCaptured(tx, job, job.id, expected, [
            { ...item, [key]: noncanonicalUuid(item[key]) },
          ]);
        }),
      ).rejects.toThrow("invalid_reference");
    }
    await expect(
      db.transaction(async (tx) => {
        await assertErasureSourceCaptured(
          tx,
          job,
          job.id,
          {
            ...expected,
            producerBoundaryRef: noncanonicalUuid(boundary.reference),
          },
          [item],
        );
      }),
    ).rejects.toThrow("invalid_reference");
    await db.transaction(async (tx) => {
      await assertErasureSourceCaptured(tx, job, job.id, expected, [item]);
    });
  });

  it("keeps a submitted receipt unresolved when verification returns terminal proof after the deadline", async () => {
    const { job, source, lease } = await erasureFixture();
    const requestRef = randomUUID();
    const entered = deferred<void>();
    const returned = deferred<ErasureProof>();
    const result = Promise.allSettled([
      executeErasureWork(
        db,
        lease,
        handler(source.collectorVersion, {
          erase: () => {
            return Promise.resolve({ requestRef });
          },
          verify: async () => {
            entered.resolve();
            return await returned.promise;
          },
        }),
        context.signal,
      ),
    ]);
    await entered.promise;
    await db
      .update(jobs)
      .set({ deadlineAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(jobs.id, job.id));
    returned.resolve(proof(lease));
    await expect(result).resolves.toMatchObject([{ status: "fulfilled" }]);
    await expect(
      db.select().from(work).where(eq(work.id, lease.workId)),
    ).resolves.toMatchObject([
      {
        requestRef,
        evidenceRef: null,
        state: "capability_unresolved",
        errorCode: "deadline_exceeded",
        leaseId: null,
      },
    ]);
    await expect(finalizeErasureJob(db, job.id, job)).rejects.toThrow(
      "work_unresolved",
    );
  });

  it("rejects a trailing newline in an adapter UUID before persisting a missing-handler outcome", async () => {
    const { source, lease } = await erasureFixture();
    await expect(
      executeErasureWork(
        db,
        lease,
        handler(`${source.collectorVersion}\n`, {
          erase: () => {
            throw new Error("unexpected submission");
          },
        }),
        context.signal,
      ),
    ).rejects.toThrow("invalid_reference");
    await expect(
      db.select().from(work).where(eq(work.id, lease.workId)),
    ).resolves.toMatchObject([
      {
        state: "pending",
        errorCode: null,
        requestRef: null,
        leaseId: lease.leaseId,
      },
    ]);
  });

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

  it.each(["user", "organization"] as const)(
    "admits concurrent %s writers and waits for both before closure",
    async (subjectKind) => {
      const input = decision({ subjectKind });
      const entered = [deferred<void>(), deferred<void>()];
      const release = [releaseGate(), releaseGate()];
      const writing: Promise<void>[] = [];
      const tasks: Promise<unknown>[] = [];
      onTestFinished(async () => {
        for (const gate of release) {
          gate.release();
        }
        await Promise.allSettled(tasks);
      });
      for (const [index, gate] of entered.entries()) {
        const writer = db.transaction(async (tx) => {
          await tx.execute(sql`SET LOCAL lock_timeout = '1s'`);
          await assertErasureSubjectWritable(tx, [input, input]);
          gate.resolve();
          await release[index]!.promise;
        });
        writing.push(writer);
        tasks.push(writer);
        // Surface a failed admission instead of waiting for a gate it cannot open.
        await Promise.race([gate.promise, writer]);
      }
      const closing = project(input);
      tasks.push(closing);
      await waitForAdvisoryWaiter();
      release[0]!.release();
      await writing[0];
      await waitForAdvisoryWaiter();
      release[1]!.release();
      await Promise.all([...writing, closing]);
      await expect(
        db.transaction(async (tx) => {
          await assertErasureSubjectWritable(tx, [input]);
        }),
      ).rejects.toThrow("subject_closed");
    },
  );

  it("allows a writer after the first closure rolls back", async () => {
    const input = decision();
    const entered = deferred<void>();
    const release = releaseGate();
    const rollback = new Error("synthetic closure rollback");
    const closing = Promise.allSettled([
      db.transaction(async (tx) => {
        await projectErasureDecision(tx, input);
        entered.resolve();
        await release.promise;
        throw rollback;
      }),
    ]);
    onTestFinished(async () => {
      release.release();
      await closing;
    });
    await entered.promise;
    const writing = db.transaction(async (tx) => {
      await assertErasureSubjectWritable(tx, [input]);
    });
    onTestFinished(async () => {
      release.release();
      await Promise.allSettled([writing]);
    });
    await waitForAdvisoryWaiter();
    release.release();
    await writing;
    await expect(closing).resolves.toStrictEqual([
      { status: "rejected", reason: rollback },
    ]);
  });

  it.each(["admission", "exclusive"] as const)(
    "preserves mixed-version exclusion with %s first",
    async (first) => {
      const input = decision();
      const entered = deferred<void>();
      const release = releaseGate();
      const lock =
        first === "admission"
          ? assertErasureSubjectWritable
          : lockErasureSubjects;
      const otherLock =
        first === "admission"
          ? lockErasureSubjects
          : assertErasureSubjectWritable;
      const holding = db.transaction(async (tx) => {
        await lock(tx, [input]);
        entered.resolve();
        await release.promise;
      });
      onTestFinished(async () => {
        release.release();
        await Promise.allSettled([holding]);
      });
      await entered.promise;
      const waiting = db.transaction(async (tx) => {
        await otherLock(tx, [input]);
      });
      onTestFinished(async () => {
        release.release();
        await Promise.allSettled([waiting]);
      });
      await waitForAdvisoryWaiter();
      release.release();
      await expect(Promise.all([holding, waiting])).resolves.toStrictEqual([
        undefined,
        undefined,
      ]);
    },
  );

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

  it("orders claims by availability then id, caps batches at eight, and delays released retries", async () => {
    const required = Array.from({ length: 12 }, () => {
      return sink();
    });
    const { job } = await inventory(required);
    const items = await db.select().from(work).where(eq(work.jobId, job.id));
    const ids = items
      .map((item) => {
        return item.id;
      })
      .sort();
    const earliest = ids.at(-1);
    if (!earliest) {
      throw new Error("missing fixture");
    }
    await db
      .update(work)
      .set({ availableAt: new Date("2020-01-01") })
      .where(eq(work.jobId, job.id));
    await db
      .update(work)
      .set({ availableAt: new Date("2019-01-01") })
      .where(eq(work.id, earliest));

    const first = await claimErasureWork(db, job.id, "inventory");
    expect(
      first.map((lease) => {
        return lease.workId;
      }),
    ).toStrictEqual([earliest, ...ids.slice(0, 7)]);
    const second = await claimErasureWork(db, job.id, "inventory");
    expect(
      second.map((lease) => {
        return lease.workId;
      }),
    ).toStrictEqual(ids.slice(7, 11));
    await expect(
      claimErasureWork(db, job.id, "inventory"),
    ).resolves.toStrictEqual([]);

    const lease = first[0];
    const source = required.find((item) => {
      return item.sinkId === lease?.item.sinkId;
    });
    if (!lease || !source) {
      throw new Error("missing claim");
    }
    await executeErasureWork(
      db,
      lease,
      handler(source.collectorVersion, {
        inventory: () => {
          return Promise.resolve({
            outcome: "retryable_failure",
            errorCode: "verification_failed",
            requestRef: null,
          });
        },
      }),
      context.signal,
    );
    await expect(
      claimErasureWork(db, job.id, "inventory"),
    ).resolves.toStrictEqual([]);
    // Infrastructure-only clock fixture; the real unresolved write above owns
    // the retry state and delay, and the claim still uses the database clock.
    await db
      .update(work)
      .set({ availableAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(work.id, lease.workId));
    const retry = await claimErasureWork(db, job.id, "inventory");
    expect(retry).toMatchObject([
      { workId: lease.workId, item: { attemptCount: 2 } },
    ]);
    await expect(renewErasureLease(db, lease)).rejects.toThrow("lease_lost");
  });

  it("expires pending work in bounded id order regardless of availability or a live lease", async () => {
    const { job } = await inventory(
      Array.from({ length: 12 }, () => {
        return sink();
      }),
    );
    const items = await db.select().from(work).where(eq(work.jobId, job.id));
    const ids = items
      .map((item) => {
        return item.id;
      })
      .sort();
    const terminalId = ids[0];
    if (!terminalId) {
      throw new Error("missing fixture");
    }
    const [, leased] = await claimErasureWork(db, job.id, "inventory", 2);
    if (!leased) {
      throw new Error("missing lease");
    }
    await db
      .update(work)
      .set({
        state: "capability_unresolved",
        errorCode: "permission_missing",
        leaseId: null,
        leaseExpiresAt: null,
      })
      .where(eq(work.id, terminalId));
    await db
      .update(work)
      .set({ availableAt: new Date("2099-01-01") })
      .where(eq(work.jobId, job.id));
    await db
      .update(jobs)
      .set({ deadlineAt: sql`clock_timestamp() - interval '1 second'` })
      .where(eq(jobs.id, job.id));
    await expect(
      claimErasureWork(db, job.id, "inventory"),
    ).resolves.toStrictEqual([]);
    const expired = await db
      .select()
      .from(work)
      .where(
        and(eq(work.jobId, job.id), eq(work.errorCode, "deadline_exceeded")),
      );
    expect(
      expired
        .map((item) => {
          return item.id;
        })
        .sort(),
    ).toStrictEqual(ids.slice(1, 9));
    expect(
      expired.every((item) => {
        return item.leaseId === null && item.leaseExpiresAt === null;
      }),
    ).toBeTruthy();
    await claimErasureWork(db, job.id, "verification");
    await expect(
      db
        .select({ id: work.id })
        .from(work)
        .where(
          and(eq(work.jobId, job.id), eq(work.errorCode, "deadline_exceeded")),
        ),
    ).resolves.toHaveLength(11);
    await expect(
      db
        .select({ errorCode: work.errorCode })
        .from(work)
        .where(eq(work.id, terminalId)),
    ).resolves.toStrictEqual([{ errorCode: "permission_missing" }]);
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
    const release = await verifier.verify();
    for (const key of [
      "reference",
      "jobId",
      "decisionRef",
      "coveringDecisionRef",
    ] as const) {
      await expect(
        retireErasureProjectionPage(
          db,
          job.id,
          {
            verify: () => {
              return Promise.resolve({
                ...release,
                [key]: noncanonicalUuid(release[key]),
              });
            },
          },
          context.signal,
        ),
      ).rejects.toThrow("invalid_reference");
    }
    for (const key of ["jobId", "reference"] as const) {
      await expect(
        retireErasureProjectionPage(
          db,
          job.id,
          {
            verify: () => {
              return Promise.resolve({
                ...release,
                covering: {
                  ...release.covering,
                  [key]: noncanonicalUuid(release.covering[key]),
                },
              });
            },
          },
          context.signal,
        ),
      ).rejects.toThrow("invalid_reference");
    }
    await expect(
      db.select().from(jobs).where(eq(jobs.id, job.id)),
    ).resolves.toMatchObject([{ retirementReleaseRef: null }]);
    await expect(
      db.select().from(work).where(eq(work.jobId, job.id)),
    ).resolves.toHaveLength(3);
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
