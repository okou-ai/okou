import { createHash, randomUUID } from "node:crypto";
import {
  and,
  asc,
  desc,
  eq,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  ne,
  exists,
  or,
  sql,
} from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { PgUpdateSetSource } from "drizzle-orm/pg-core";

import {
  accountErasureJobs as jobs,
  accountErasurePages as pages,
  accountErasureSelectorDependencies as dependencies,
  accountErasureSinks as sinks,
  accountErasureWork as work,
} from "../schema/account-erasure";

type Db = NodePgDatabase<Record<string, never>>;
type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
type Job = typeof jobs.$inferSelect;
type Work = typeof work.$inferSelect;
type Dependency = Pick<
  typeof dependencies.$inferSelect,
  "sinkId" | "itemKey" | "obligation"
>;

export type ErasureSubject = Pick<Job, "subjectKind" | "subjectId">;
export type ErasureDecision = Pick<
  Job,
  | "subjectKind"
  | "subjectId"
  | "generation"
  | "authorityId"
  | "decisionRef"
  | "decisionSequence"
  | "confirmationRef"
  | "previousDecisionRef"
  | "dispositionVersion"
  | "requestedAt"
  | "deadlineAt"
>;
export type ErasureRevision = Pick<
  Job,
  "generation" | "captureRevision" | "inventoryRevision"
>;
export interface EncryptedErasureSelector {
  readonly ciphertext: string;
  readonly digest: string;
}
export interface ErasureInventoryItem {
  readonly sinkId: string;
  readonly itemKey: string;
  readonly kind: "erase" | "recovery";
  readonly selector: EncryptedErasureSelector;
  readonly dependencies: readonly Dependency[];
}
export interface ErasureSink {
  readonly sinkId: string;
  readonly domain: typeof sinks.$inferSelect.domain;
  readonly collectorVersion: string;
  readonly selector: EncryptedErasureSelector;
  readonly dependencies: readonly Dependency[];
}
export interface ErasureLease extends ErasureRevision {
  readonly jobId: string;
  readonly workId: string;
  readonly leaseId: string;
  readonly producerBoundaryRef: string | null;
  readonly item: Work;
}
export interface ErasureInventoryPage {
  readonly pageKey: string;
  readonly inputCursorDigest: string | null;
  readonly nextCursor: EncryptedErasureSelector | null;
  readonly items: readonly ErasureInventoryItem[];
  // Only a collector's complete, authorized enumeration may supply this.
  readonly enumerationRef: string | null;
}
export interface ErasureProof extends ErasureRevision {
  readonly workId: string;
  readonly sinkId: string;
  readonly producerBoundaryRef: string;
  readonly outcome: "verified_erased" | "verified_no_applicable_data";
  readonly evidenceRef: string;
  readonly authenticatedReaderRef: string;
  readonly enumerationRef: string;
  readonly observedAt: Date;
}
export interface ErasureUnresolved {
  readonly outcome: "pending" | "retryable_failure" | "capability_unresolved";
  readonly errorCode: NonNullable<Work["errorCode"]>;
  // Null means no new receipt; it must not erase an earlier submission locator.
  readonly requestRef: string | null;
}
// B1 registers no implementations. References name restricted proof records,
// never provider responses, selectors, credentials, or arbitrary diagnostics.
export interface ErasureHandler {
  readonly version: string;
  inventory(
    input: ErasureLease,
    cursor: EncryptedErasureSelector | null,
    signal: AbortSignal,
  ): Promise<ErasureInventoryPage | ErasureUnresolved>;
  erase(
    item: ErasureLease,
    signal: AbortSignal,
  ): Promise<{ readonly requestRef: string } | ErasureUnresolved>;
  verify(
    item: ErasureLease,
    producerBoundary: string,
    signal: AbortSignal,
  ): Promise<ErasureProof | ErasureUnresolved>;
}
export interface ErasureProducerBoundary extends ErasureRevision {
  readonly jobId: string;
  readonly reference: string;
}
export interface ErasureBoundaryVerifier {
  verify(
    job: Readonly<Job>,
    signal: AbortSignal,
  ): Promise<ErasureProducerBoundary>;
}

const MAX_CLAIM = 8;
const MAX_PAGE = 100;
const MAX_SINKS = 64;
const MAX_DEPENDENCIES = 64;
const MAX_ATTEMPTS = 20;
const LEASE_MS = 60_000;
const TERMINAL = ["verified_erased", "verified_no_applicable_data"] as const;

function invariant(valid: unknown, code: string): asserts valid {
  if (!valid) throw new Error(`account_erasure:${code}`);
}
// Match PostgreSQL output before persistence or replay hashing. Subject IDs are
// case-sensitive text and must never pass through this UUID-only boundary.
function uuid(value: string): void {
  invariant(
    value.length === 36 &&
      /^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/.test(value),
    "invalid_reference",
  );
}
function positive(value: number): void {
  invariant(
    Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647,
    "invalid_version",
  );
}
function subjectKey(subject: ErasureSubject): string {
  invariant(
    subject.subjectKind === "user" || subject.subjectKind === "organization",
    "invalid_subject",
  );
  invariant(
    subject.subjectId.length > 0 && Buffer.byteLength(subject.subjectId) <= 192,
    "invalid_subject",
  );
  return JSON.stringify([subject.subjectKind, subject.subjectId]);
}
function subjectCondition(subject: ErasureSubject) {
  return and(
    eq(jobs.subjectKind, subject.subjectKind),
    eq(jobs.subjectId, subject.subjectId),
  );
}
function sameRevision(job: ErasureRevision, expected: ErasureRevision): void {
  invariant(
    job.generation === expected.generation &&
      job.captureRevision === expected.captureRevision &&
      job.inventoryRevision === expected.inventoryRevision,
    "stale_revision",
  );
}
function selector(value: EncryptedErasureSelector): void {
  invariant(
    value.ciphertext.startsWith("vm0secret:v1:") &&
      Buffer.byteLength(value.ciphertext) <= 16_384,
    "invalid_ciphertext",
  );
  invariant(/^[\da-f]{64}$/.test(value.digest), "invalid_digest");
}
function canonicalDependencies(values: readonly Dependency[]): Dependency[] {
  invariant(values.length <= MAX_DEPENDENCIES, "dependency_limit");
  const sorted = [...values].sort((a, b) => {
    return `${a.sinkId}:${a.itemKey}`.localeCompare(`${b.sinkId}:${b.itemKey}`);
  });
  const keys = new Set<string>();
  for (const value of sorted) {
    uuid(value.sinkId);
    uuid(value.itemKey);
    invariant(
      value.obligation === "erasure" || value.obligation === "recovery",
      "invalid_obligation",
    );
    const key = `${value.sinkId}:${value.itemKey}`;
    invariant(!keys.has(key), "duplicate_dependency");
    keys.add(key);
  }
  return sorted.map(({ sinkId, itemKey, obligation }) => {
    return {
      sinkId,
      itemKey,
      obligation,
    };
  });
}
function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/** Lock order: sorted subject advisory locks, job, then work rows by id.
 * Take these locks BEFORE business-row locks; keep them through the caller's
 * commit. Advisory locks also serialize first closure when no job exists.
 */
export async function lockErasureSubjects(
  tx: Tx,
  subjects: readonly ErasureSubject[],
): Promise<void> {
  const [isolation] = await tx
    .select({
      value: sql`current_setting('transaction_isolation')`.mapWith(
        jobs.subjectId,
      ),
    })
    .from(sql`(VALUES (1)) AS erasure_isolation_probe`);
  invariant(isolation?.value === "read committed", "unsupported_isolation");
  invariant(
    subjects.length > 0 && subjects.length <= MAX_SINKS,
    "subject_limit",
  );
  for (const key of [...new Set(subjects.map(subjectKey))].sort()) {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${`account-erasure:${key}`}, 0))`,
    );
  }
}

export async function assertErasureSubjectWritable(
  tx: Tx,
  subjects: readonly ErasureSubject[],
): Promise<void> {
  await lockErasureSubjects(tx, subjects);
  for (const subject of subjects) {
    const [closed] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(subjectCondition(subject))
      .limit(1);
    invariant(!closed, "subject_closed");
  }
}

async function lockJob(tx: Tx, jobId: string, retiring = false): Promise<Job> {
  uuid(jobId);
  const [locator] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  invariant(locator, "job_missing");
  await lockErasureSubjects(tx, [locator]);
  const [job] = await tx
    .select()
    .from(jobs)
    .where(eq(jobs.id, jobId))
    .for("update");
  invariant(job, "job_missing");
  const [latest] = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(subjectCondition(job))
    .orderBy(desc(jobs.generation))
    .limit(1);
  invariant(retiring || latest?.id === job.id, "stale_generation");
  invariant(
    retiring || job.retirementReleaseRef === null,
    "retirement_started",
  );
  return job;
}

/** Syntactic validation of a projection already authenticated by the future
 * G2d1/B2 bridge. Local persistence does not authenticate or ACK the decision.
 */
export async function projectErasureDecision(
  db: Db,
  input: ErasureDecision,
): Promise<Job> {
  subjectKey(input);
  positive(input.generation);
  positive(input.dispositionVersion);
  for (const ref of [
    input.authorityId,
    input.decisionRef,
    input.confirmationRef,
  ])
    uuid(ref);
  if (input.previousDecisionRef !== null) uuid(input.previousDecisionRef);
  invariant(input.decisionSequence > 0n, "invalid_sequence");
  invariant(
    Number.isFinite(input.requestedAt.getTime()) &&
      input.deadlineAt > input.requestedAt,
    "invalid_deadline",
  );
  return await db.transaction(async (tx) => {
    await lockErasureSubjects(tx, [input]);
    const [existing] = await tx
      .select()
      .from(jobs)
      .where(eq(jobs.decisionRef, input.decisionRef));
    if (existing) {
      for (const key of Object.keys(input) as (keyof ErasureDecision)[]) {
        const a = existing[key];
        const b = input[key];
        invariant(
          a instanceof Date && b instanceof Date
            ? a.getTime() === b.getTime()
            : a === b,
          "conflicting_decision",
        );
      }
      return existing;
    }
    const [latest] = await tx
      .select()
      .from(jobs)
      .where(subjectCondition(input))
      .orderBy(desc(jobs.generation))
      .limit(1);
    if (latest) {
      invariant(
        input.authorityId === latest.authorityId &&
          input.previousDecisionRef === latest.decisionRef &&
          input.generation > latest.generation &&
          input.decisionSequence > latest.decisionSequence,
        "stale_decision",
      );
    } else {
      invariant(input.previousDecisionRef === null, "missing_predecessor");
    }
    const [created] = await tx.insert(jobs).values(input).returning();
    invariant(created, "job_insert_failed");
    return created;
  });
}

async function captureItem(
  tx: Tx,
  job: Job,
  item: Omit<ErasureInventoryItem, "kind"> & { readonly kind: Work["kind"] },
): Promise<void> {
  uuid(item.sinkId);
  uuid(item.itemKey);
  selector(item.selector);
  const required = canonicalDependencies(item.dependencies);
  const [sink] = await tx
    .select()
    .from(sinks)
    .where(and(eq(sinks.jobId, job.id), eq(sinks.sinkId, item.sinkId)));
  invariant(sink, "sink_missing");
  const [existing] = await tx
    .select()
    .from(work)
    .where(
      and(
        eq(work.jobId, job.id),
        eq(work.sinkId, item.sinkId),
        eq(work.itemKey, item.itemKey),
        eq(work.generation, job.generation),
      ),
    );
  if (existing) {
    const stored = await tx
      .select({
        sinkId: dependencies.sinkId,
        itemKey: dependencies.itemKey,
        obligation: dependencies.obligation,
      })
      .from(dependencies)
      .where(eq(dependencies.workId, existing.id));
    invariant(
      existing.kind === item.kind &&
        existing.selectorDigest === item.selector.digest,
      "conflicting_item",
    );
    if (existing.selectorCaptureRevision === job.captureRevision) {
      invariant(
        digest(canonicalDependencies(stored)) === digest(required),
        "conflicting_item",
      );
    } else {
      invariant(
        stored.every((old) => {
          return required.some((next) => {
            return (
              old.sinkId === next.sinkId &&
              old.itemKey === next.itemKey &&
              old.obligation === next.obligation
            );
          });
        }),
        "dependency_removal",
      );
      const added = required.filter((next) => {
        return !stored.some((old) => {
          return old.sinkId === next.sinkId && old.itemKey === next.itemKey;
        });
      });
      if (added.length > 0)
        await tx.insert(dependencies).values(
          added.map((value) => {
            return { ...value, workId: existing.id };
          }),
        );
      await tx
        .update(work)
        .set({
          selectorCiphertext: item.selector.ciphertext,
          selectorCaptureRevision: job.captureRevision,
          state: "pending",
          leaseId: null,
          leaseExpiresAt: null,
          attemptCount: 0,
          availableAt: sql`clock_timestamp()`,
          evidenceRef: null,
          proofCaptureRevision: null,
          proofInventoryRevision: null,
          proofBoundaryRef: null,
          proofReaderRef: null,
          proofObservedAt: null,
          errorCode: null,
        })
        .where(eq(work.id, existing.id));
    }
    return;
  }
  const [created] = await tx
    .insert(work)
    .values({
      jobId: job.id,
      sinkId: item.sinkId,
      itemKey: item.itemKey,
      generation: job.generation,
      kind: item.kind,
      selectorCiphertext: item.selector.ciphertext,
      selectorDigest: item.selector.digest,
      selectorCaptureRevision: job.captureRevision,
    })
    .returning();
  invariant(created, "item_insert_failed");
  if (required.length > 0) {
    await tx.insert(dependencies).values(
      required.map((value) => {
        return { ...value, workId: created.id };
      }),
    );
  }
}

/** Re-enumerate all required sinks after late data, a new sink, or producer
 * boundary changes. Existing sinks cannot silently disappear from the contract.
 */
export async function reviseErasureInventory(
  db: Db,
  jobId: string,
  expected: ErasureRevision,
  required: readonly ErasureSink[],
): Promise<Job> {
  invariant(required.length > 0 && required.length <= MAX_SINKS, "sink_limit");
  for (const item of required) {
    uuid(item.sinkId);
    uuid(item.collectorVersion);
  }
  invariant(
    new Set(
      required.map((item) => {
        return item.sinkId;
      }),
    ).size === required.length,
    "duplicate_sink",
  );
  return await db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    sameRevision(job, expected);
    const existing = await tx
      .select()
      .from(sinks)
      .where(eq(sinks.jobId, jobId));
    invariant(
      existing.every((item) => {
        return required.some((candidate) => {
          return (
            candidate.sinkId === item.sinkId && candidate.domain === item.domain
          );
        });
      }),
      "sink_removal",
    );
    const [revised] = await tx
      .update(jobs)
      .set({
        captureRevision: job.captureRevision + 1,
        inventoryRevision: job.inventoryRevision + 1,
        sealedCaptureRevision: null,
        producerBoundaryRef: null,
        state: "pending",
      })
      .where(eq(jobs.id, jobId))
      .returning();
    invariant(revised, "job_missing");
    // A new revision invalidates old leases/proofs through the job CAS. Targets
    // reset only when recaptured in a bounded page, not via an account-wide UPDATE.
    await tx
      .update(work)
      .set({
        cursorCiphertext: null,
        cursorDigest: null,
        captureComplete: false,
        enumerationRef: null,
        state: "pending",
      })
      .where(and(eq(work.jobId, jobId), eq(work.kind, "inventory")));
    for (const item of required) {
      await tx
        .insert(sinks)
        .values({
          jobId,
          sinkId: item.sinkId,
          domain: item.domain,
          collectorVersion: item.collectorVersion,
          inventoryRevision: revised.inventoryRevision,
        })
        .onConflictDoUpdate({
          target: [sinks.jobId, sinks.sinkId],
          set: {
            collectorVersion: item.collectorVersion,
            inventoryRevision: revised.inventoryRevision,
          },
        });
      await captureItem(tx, revised, {
        ...item,
        itemKey: item.sinkId,
        kind: "inventory",
      });
    }
    return revised;
  });
}

function liveLease(lease: ErasureLease) {
  return and(
    eq(work.id, lease.workId),
    eq(work.jobId, lease.jobId),
    eq(work.generation, lease.generation),
    eq(work.leaseId, lease.leaseId),
    gt(work.leaseExpiresAt, sql`clock_timestamp()`),
  );
}
async function lockedLease(
  tx: Tx,
  lease: ErasureLease,
): Promise<{ job: Job; item: Work }> {
  uuid(lease.workId);
  uuid(lease.leaseId);
  if (lease.producerBoundaryRef !== null) uuid(lease.producerBoundaryRef);
  const job = await lockJob(tx, lease.jobId);
  sameRevision(job, lease);
  invariant(
    job.producerBoundaryRef === lease.producerBoundaryRef,
    "stale_boundary",
  );
  const [item] = await tx
    .select()
    .from(work)
    .where(liveLease(lease))
    .for("update");
  invariant(item, "lease_lost");
  return { job, item };
}
async function updateLease(
  tx: Tx,
  lease: ErasureLease,
  update: PgUpdateSetSource<typeof work>,
): Promise<Work> {
  const [updated] = await tx
    .update(work)
    .set(update)
    .where(
      and(
        liveLease(lease),
        update.evidenceRef
          ? exists(
              tx
                .select({ id: jobs.id })
                .from(jobs)
                .where(
                  and(
                    eq(jobs.id, lease.jobId),
                    gt(jobs.deadlineAt, sql`clock_timestamp()`),
                  ),
                ),
            )
          : undefined,
      ),
    )
    .returning();
  invariant(updated, "lease_lost");
  return updated;
}

export async function claimErasureWork(
  db: Db,
  jobId: string,
  phase: "inventory" | "verification",
  limit: number = MAX_CLAIM,
): Promise<ErasureLease[]> {
  invariant(
    Number.isInteger(limit) && limit > 0 && limit <= MAX_CLAIM,
    "claim_limit",
  );
  return await db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    if (
      job.state === "verified_erased" ||
      job.state === "verified_no_applicable_data"
    ) {
      return [];
    }
    const [expired] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.id, jobId), lte(jobs.deadlineAt, sql`clock_timestamp()`)),
      );
    if (expired) {
      await tx
        .update(work)
        .set({
          state: "capability_unresolved",
          errorCode: "deadline_exceeded",
          leaseId: null,
          leaseExpiresAt: null,
        })
        .where(
          inArray(
            work.id,
            tx
              .select({ id: work.id })
              .from(work)
              .where(
                and(
                  eq(work.jobId, jobId),
                  // Keep the partial-index predicate visible to generic plans.
                  sql`${work.state} IN ('pending', 'retryable_failure')`,
                ),
              )
              .orderBy(asc(work.id))
              .limit(limit),
          ),
        );
      await tx
        .update(jobs)
        .set({ state: "capability_unresolved" })
        .where(eq(jobs.id, jobId));
      return [];
    }
    if (phase === "verification") {
      invariant(
        job.sealedCaptureRevision === job.captureRevision &&
          job.producerBoundaryRef !== null,
        "capture_unsealed",
      );
    } else {
      invariant(job.sealedCaptureRevision === null, "capture_sealed");
    }
    const rows = await tx
      .select()
      .from(work)
      .where(
        and(
          eq(work.jobId, jobId),
          eq(work.generation, job.generation),
          eq(work.selectorCaptureRevision, job.captureRevision),
          // Binding these states hides the partial index from generic plans.
          sql`${work.state} IN ('pending', 'retryable_failure')`,
          lte(work.availableAt, sql`clock_timestamp()`),
          or(
            isNull(work.leaseId),
            lte(work.leaseExpiresAt, sql`clock_timestamp()`),
          ),
          phase === "inventory"
            ? and(eq(work.kind, "inventory"), eq(work.captureComplete, false))
            : undefined,
        ),
      )
      .orderBy(asc(work.availableAt), asc(work.id))
      .limit(limit)
      .for("update", { skipLocked: true });
    const claimed: ErasureLease[] = [];
    for (const item of rows) {
      if (item.attemptCount >= MAX_ATTEMPTS) {
        await tx
          .update(work)
          .set({
            state: "capability_unresolved",
            errorCode: "retry_exhausted",
            leaseId: null,
            leaseExpiresAt: null,
          })
          .where(eq(work.id, item.id));
        continue;
      }
      const leaseId = randomUUID();
      const [updated] = await tx
        .update(work)
        .set({
          leaseId,
          leaseExpiresAt: sql`clock_timestamp() + ${LEASE_MS} * interval '1 millisecond'`,
          attemptCount: item.attemptCount + 1,
        })
        .where(eq(work.id, item.id))
        .returning();
      invariant(updated, "item_missing");
      claimed.push({
        jobId,
        workId: item.id,
        leaseId,
        generation: job.generation,
        captureRevision: job.captureRevision,
        inventoryRevision: job.inventoryRevision,
        producerBoundaryRef: job.producerBoundaryRef,
        item: updated,
      });
    }
    return claimed;
  });
}

export async function renewErasureLease(
  db: Db,
  lease: ErasureLease,
): Promise<void> {
  await db.transaction(async (tx) => {
    await lockedLease(tx, lease);
    await updateLease(tx, lease, {
      leaseExpiresAt: sql`clock_timestamp() + ${LEASE_MS} * interval '1 millisecond'`,
    });
  });
}

export async function commitErasureInventoryPage(
  db: Db,
  lease: ErasureLease,
  page: ErasureInventoryPage,
): Promise<Work> {
  uuid(page.pageKey);
  invariant(page.items.length <= MAX_PAGE, "page_limit");
  if (page.enumerationRef !== null) uuid(page.enumerationRef);
  invariant(
    (page.nextCursor === null) === (page.enumerationRef !== null),
    "enumeration_unproven",
  );
  if (page.nextCursor !== null) {
    selector(page.nextCursor);
    invariant(
      page.nextCursor.digest !== page.inputCursorDigest,
      "cursor_not_advanced",
    );
  }
  const pageDigest = digest({
    inputCursorDigest: page.inputCursorDigest,
    nextCursorDigest: page.nextCursor?.digest ?? null,
    enumerationRef: page.enumerationRef,
    items: page.items.map((item) => {
      uuid(item.sinkId);
      uuid(item.itemKey);
      return {
        sinkId: item.sinkId,
        itemKey: item.itemKey,
        kind: item.kind,
        selectorDigest: item.selector.digest,
        dependencies: canonicalDependencies(item.dependencies),
      };
    }),
  });
  return await db.transaction(async (tx) => {
    const { job, item } = await lockedLease(tx, lease);
    invariant(
      item.kind === "inventory" && job.sealedCaptureRevision === null,
      "capture_sealed",
    );
    const [replay] = await tx
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.workId, item.id),
          eq(pages.captureRevision, job.captureRevision),
          eq(pages.pageKey, page.pageKey),
        ),
      );
    if (replay) {
      invariant(replay.digest === pageDigest, "conflicting_page");
      return await updateLease(tx, lease, { cursorDigest: item.cursorDigest });
    }
    invariant(
      !item.captureComplete && item.cursorDigest === page.inputCursorDigest,
      "cursor_mismatch",
    );
    invariant(
      new Set(
        page.items.map((value) => {
          return `${value.sinkId}:${value.itemKey}`;
        }),
      ).size === page.items.length,
      "duplicate_item",
    );
    for (const value of page.items) {
      invariant(value.sinkId === item.sinkId, "wrong_sink");
      await captureItem(tx, job, value);
    }
    await tx.insert(pages).values({
      workId: item.id,
      captureRevision: job.captureRevision,
      pageKey: page.pageKey,
      digest: pageDigest,
      inputCursorDigest: page.inputCursorDigest,
    });
    return await updateLease(tx, lease, {
      cursorCiphertext: page.nextCursor?.ciphertext ?? null,
      cursorDigest: page.nextCursor?.digest ?? null,
      captureComplete: page.nextCursor === null,
      enumerationRef: page.enumerationRef,
    });
  });
}

async function assertCaptureComplete(tx: Tx, job: Job): Promise<void> {
  const required = await tx
    .select()
    .from(sinks)
    .where(eq(sinks.jobId, job.id))
    .limit(MAX_SINKS + 1);
  invariant(
    required.length > 0 && required.length <= MAX_SINKS,
    "inventory_missing",
  );
  for (const sink of required) {
    const [collector] = await tx
      .select()
      .from(work)
      .where(
        and(
          eq(work.jobId, job.id),
          eq(work.sinkId, sink.sinkId),
          eq(work.itemKey, sink.sinkId),
          eq(work.kind, "inventory"),
          eq(work.captureComplete, true),
        ),
      );
    invariant(
      sink.inventoryRevision === job.inventoryRevision &&
        collector?.enumerationRef &&
        (collector.selectorCiphertext ||
          ((collector.state === "verified_erased" ||
            collector.state === "verified_no_applicable_data") &&
            collector.proofCaptureRevision === job.captureRevision &&
            collector.proofInventoryRevision === job.inventoryRevision &&
            collector.proofBoundaryRef === job.producerBoundaryRef)),
      "capture_incomplete",
    );
  }
  const [uncaptured] = await tx
    .select({ id: work.id })
    .from(work)
    .where(
      and(
        eq(work.jobId, job.id),
        ne(work.selectorCaptureRevision, job.captureRevision),
      ),
    )
    .limit(1);
  invariant(!uncaptured, "capture_incomplete");
}

export async function sealErasureCapture(
  db: Db,
  jobId: string,
  expected: ErasureRevision,
  verifier: ErasureBoundaryVerifier,
  signal: AbortSignal,
): Promise<Job> {
  const snapshot = await db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    sameRevision(job, expected);
    await assertCaptureComplete(tx, job);
    return job;
  });
  signal.throwIfAborted();
  const boundary = await verifier.verify(snapshot, signal);
  signal.throwIfAborted();
  uuid(boundary.reference);
  uuid(boundary.jobId);
  sameRevision(boundary, expected);
  invariant(boundary.jobId === jobId, "wrong_boundary");
  return await db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    sameRevision(job, expected);
    await assertCaptureComplete(tx, job);
    invariant(
      job.producerBoundaryRef === null ||
        job.producerBoundaryRef === boundary.reference,
      "boundary_change_requires_revision",
    );
    const [sealed] = await tx
      .update(jobs)
      .set({
        sealedCaptureRevision: job.captureRevision,
        producerBoundaryRef: boundary.reference,
      })
      .where(eq(jobs.id, jobId))
      .returning();
    invariant(sealed, "job_missing");
    // Inventory leases cannot continue across the newly sealed boundary.
    await tx
      .update(work)
      .set({ leaseId: null, leaseExpiresAt: null, attemptCount: 0 })
      .where(and(eq(work.jobId, jobId), eq(work.kind, "inventory")));
    return sealed;
  });
}

/** Capture assertion only. It grants no A2 readiness or permission to remove
 * run, usage, allowance, ledger, or other billing anchors.
 */
export async function assertErasureSourceCaptured(
  tx: Tx,
  subject: ErasureSubject,
  jobId: string,
  expected: ErasureRevision & { readonly producerBoundaryRef: string },
  requiredItems: readonly Pick<Dependency, "sinkId" | "itemKey">[],
): Promise<void> {
  uuid(jobId);
  uuid(expected.producerBoundaryRef);
  for (const item of requiredItems) {
    uuid(item.sinkId);
    uuid(item.itemKey);
  }
  const [locator] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  invariant(
    locator && subjectKey(subject) === subjectKey(locator),
    "wrong_subject",
  );
  await lockErasureSubjects(tx, [subject]);
  const job = await lockJob(tx, jobId);
  invariant(subjectKey(subject) === subjectKey(job), "wrong_subject");
  sameRevision(job, expected);
  invariant(
    job.sealedCaptureRevision === job.captureRevision &&
      job.producerBoundaryRef === expected.producerBoundaryRef,
    "capture_unsealed",
  );
  invariant(
    requiredItems.length > 0 && requiredItems.length <= MAX_PAGE,
    "required_items_missing",
  );
  await assertCaptureComplete(tx, job);
  for (const required of requiredItems) {
    const [item] = await tx
      .select()
      .from(work)
      .where(
        and(
          eq(work.jobId, jobId),
          eq(work.generation, job.generation),
          eq(work.sinkId, required.sinkId),
          eq(work.itemKey, required.itemKey),
        ),
      );
    invariant(item?.selectorCiphertext, "selector_missing");
  }
}

function proofCondition(job: Job) {
  invariant(job.producerBoundaryRef !== null, "boundary_unproven");
  return and(
    inArray(work.state, TERMINAL),
    eq(work.proofCaptureRevision, job.captureRevision),
    eq(work.proofInventoryRevision, job.inventoryRevision),
    eq(work.proofBoundaryRef, job.producerBoundaryRef),
  );
}

async function commitResult(
  db: Db,
  lease: ErasureLease,
  result: ErasureProof | ErasureUnresolved,
  signal: AbortSignal,
): Promise<void> {
  if ("evidenceRef" in result) {
    for (const ref of [
      result.workId,
      result.sinkId,
      result.producerBoundaryRef,
      result.evidenceRef,
      result.authenticatedReaderRef,
      result.enumerationRef,
    ])
      uuid(ref);
  } else if (result.requestRef !== null) {
    uuid(result.requestRef);
  }
  await db.transaction(async (tx) => {
    const { job, item } = await lockedLease(tx, lease);
    const [beforeDeadline] = await tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(
        and(eq(jobs.id, job.id), gt(jobs.deadlineAt, sql`clock_timestamp()`)),
      );
    if (!beforeDeadline) {
      await updateLease(tx, lease, {
        state: "capability_unresolved",
        errorCode: "deadline_exceeded",
        requestRef:
          "requestRef" in result
            ? (result.requestRef ?? item.requestRef)
            : item.requestRef,
        leaseId: null,
        leaseExpiresAt: null,
      });
      return;
    }
    if ("evidenceRef" in result) {
      invariant(
        result.outcome === "verified_erased" ||
          result.outcome === "verified_no_applicable_data",
        "invalid_outcome",
      );
      sameRevision(job, result);
      invariant(
        job.sealedCaptureRevision === job.captureRevision &&
          result.producerBoundaryRef === job.producerBoundaryRef &&
          result.workId === item.id &&
          result.sinkId === item.sinkId,
        "stale_proof",
      );
      invariant(item.selectorCiphertext, "selector_missing");
      invariant(
        Number.isFinite(result.observedAt.getTime()),
        "invalid_observation",
      );
      signal.throwIfAborted();
      await updateLease(tx, lease, {
        state: result.outcome,
        evidenceRef: result.evidenceRef,
        proofCaptureRevision: result.captureRevision,
        proofInventoryRevision: result.inventoryRevision,
        proofBoundaryRef: result.producerBoundaryRef,
        proofReaderRef: result.authenticatedReaderRef,
        proofObservedAt: result.observedAt,
        enumerationRef: result.enumerationRef,
        errorCode: null,
        leaseId: null,
        leaseExpiresAt: null,
      });
      signal.throwIfAborted();
    } else {
      invariant(
        ["pending", "retryable_failure", "capability_unresolved"].includes(
          result.outcome,
        ),
        "invalid_outcome",
      );
      invariant(
        [
          "handler_missing",
          "selector_missing",
          "permission_missing",
          "ownership_unknown",
          "boundary_unproven",
          "verification_failed",
          "deadline_exceeded",
          "retry_exhausted",
        ].includes(result.errorCode),
        "invalid_error_code",
      );
      await updateLease(tx, lease, {
        state: result.outcome,
        errorCode: result.errorCode,
        requestRef: result.requestRef ?? item.requestRef,
        availableAt: sql`clock_timestamp() + interval '1 minute'`,
        leaseId: null,
        leaseExpiresAt: null,
      });
    }
  });
}

/** Executes only the explicitly supplied internal adapter. Provider operations
 * and KMS preparation never run while this module holds a DB transaction.
 */
export async function executeErasureWork(
  db: Db,
  lease: ErasureLease,
  handler: ErasureHandler | undefined,
  signal: AbortSignal,
): Promise<void> {
  const { job, item } = await db.transaction(async (tx) => {
    return await lockedLease(tx, lease);
  });
  const [sink] = await db
    .select()
    .from(sinks)
    .where(and(eq(sinks.jobId, job.id), eq(sinks.sinkId, item.sinkId)));
  invariant(sink, "sink_missing");
  signal.throwIfAborted();
  if (handler) uuid(handler.version);
  if (
    !handler ||
    handler.version !== sink.collectorVersion ||
    !item.selectorCiphertext
  ) {
    await commitResult(
      db,
      lease,
      {
        outcome: "capability_unresolved",
        errorCode: !item.selectorCiphertext
          ? "selector_missing"
          : "handler_missing",
        requestRef: null,
      },
      signal,
    );
    return;
  }
  if (item.kind === "inventory" && !item.captureComplete) {
    const cursor =
      item.cursorCiphertext && item.cursorDigest
        ? { ciphertext: item.cursorCiphertext, digest: item.cursorDigest }
        : null;
    const result = await handler.inventory({ ...lease, item }, cursor, signal);
    if ("pageKey" in result) {
      signal.throwIfAborted();
      await commitErasureInventoryPage(db, lease, result);
    } else {
      await commitResult(db, lease, result, signal);
    }
    signal.throwIfAborted();
    return;
  }
  invariant(job.producerBoundaryRef !== null, "boundary_unproven");
  let verificationItem = item;
  if (item.kind !== "inventory") {
    const submitted = await handler.erase({ ...lease, item }, signal);
    if ("outcome" in submitted) {
      await commitResult(db, lease, submitted, signal);
      signal.throwIfAborted();
      return;
    }
    // Acknowledged receipts survive cancellation under the same live-lease CAS.
    // Check cancellation again after the commit and before any verification.
    uuid(submitted.requestRef);
    verificationItem = await db.transaction(async (tx) => {
      await lockedLease(tx, lease);
      return await updateLease(tx, lease, { requestRef: submitted.requestRef });
    });
  }
  signal.throwIfAborted();
  const result = await handler.verify(
    { ...lease, item: verificationItem },
    job.producerBoundaryRef,
    signal,
  );
  if ("evidenceRef" in result) signal.throwIfAborted();
  await commitResult(db, lease, result, signal);
  signal.throwIfAborted();
}

export async function finalizeErasureJob(
  db: Db,
  jobId: string,
  expected: ErasureRevision,
): Promise<Job> {
  return await db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    sameRevision(job, expected);
    invariant(
      job.sealedCaptureRevision === job.captureRevision &&
        job.producerBoundaryRef !== null,
      "capture_unsealed",
    );
    await assertCaptureComplete(tx, job);
    const [unresolved] = await tx
      .select({ id: work.id })
      .from(work)
      .where(
        and(
          eq(work.jobId, jobId),
          or(
            inArray(work.state, [
              "pending",
              "retryable_failure",
              "capability_unresolved",
            ]),
            isNull(work.proofCaptureRevision),
            ne(work.proofCaptureRevision, job.captureRevision),
            isNull(work.proofInventoryRevision),
            ne(work.proofInventoryRevision, job.inventoryRevision),
            isNull(work.proofBoundaryRef),
            ne(work.proofBoundaryRef, job.producerBoundaryRef),
          ),
        ),
      )
      .limit(1);
    invariant(!unresolved, "work_unresolved");
    const [erased] = await tx
      .select({ id: work.id })
      .from(work)
      .where(and(eq(work.jobId, jobId), eq(work.state, "verified_erased")))
      .limit(1);
    const [finished] = await tx
      .update(jobs)
      .set({
        state: erased ? "verified_erased" : "verified_no_applicable_data",
      })
      .where(eq(jobs.id, jobId))
      .returning();
    invariant(finished, "job_missing");
    return finished;
  });
}

export interface ErasureLineageRelease extends ErasureProducerBoundary {
  readonly decisionRef: string;
  readonly coveringDecisionRef: string;
  readonly covering: ErasureProducerBoundary;
}
export interface ErasureLineageReleaseVerifier {
  // G2d1/G2d2 verify all producer, recovery, and control-store backup obligations
  // outside the production restore lineage. No implementation ships in B1.
  verify(
    job: Readonly<Job>,
    covering: Readonly<Job>,
    signal: AbortSignal,
  ): Promise<ErasureLineageRelease>;
}

async function coveringJob(tx: Tx, job: Job): Promise<Job> {
  const [covering] = await tx
    .select()
    .from(jobs)
    .where(subjectCondition(job))
    .orderBy(desc(jobs.generation))
    .limit(1);
  invariant(
    covering &&
      (covering.state === "verified_erased" ||
        covering.state === "verified_no_applicable_data") &&
      covering.sealedCaptureRevision === covering.captureRevision &&
      covering.producerBoundaryRef !== null,
    "work_unresolved",
  );
  return covering;
}

/** Bounded retirement after a live, independent lineage release. Historical
 * locators require matching, verified, already-retired current-generation work.
 * Preserve that covering work until every older generation has retired. A new
 * decision during pagination requires a newly verified release and coverage;
 * previously accepted releases never authorize a new generation's work.
 */
export async function retireErasureProjectionPage(
  db: Db,
  jobId: string,
  verifier: ErasureLineageReleaseVerifier,
  signal: AbortSignal,
): Promise<"pending" | "retired"> {
  const snapshot = await db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId, true);
    return { job, covering: await coveringJob(tx, job) };
  });
  signal.throwIfAborted();
  const release = await verifier.verify(
    snapshot.job,
    snapshot.covering,
    signal,
  );
  signal.throwIfAborted();
  for (const ref of [
    release.reference,
    release.jobId,
    release.decisionRef,
    release.coveringDecisionRef,
    release.covering.jobId,
    release.covering.reference,
  ])
    uuid(ref);
  return await db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId, true);
    const covering = await coveringJob(tx, job);
    sameRevision(job, release);
    sameRevision(covering, release.covering);
    invariant(
      release.jobId === job.id &&
        release.decisionRef === job.decisionRef &&
        release.coveringDecisionRef === covering.decisionRef &&
        release.covering.jobId === covering.id &&
        release.covering.reference === covering.producerBoundaryRef,
      "wrong_lineage_release",
    );
    if (job.id === covering.id) {
      const [earlier] = await tx
        .select({ id: jobs.id })
        .from(jobs)
        .where(and(subjectCondition(job), ne(jobs.id, jobId)))
        .limit(1);
      invariant(!earlier, "earlier_generation_unresolved");
      const [selector] = await tx
        .select({ id: work.id })
        .from(work)
        .where(and(eq(work.jobId, jobId), isNotNull(work.selectorCiphertext)))
        .limit(1);
      invariant(!selector, "selectors_unresolved");
    }
    const rows = await tx
      .select()
      .from(work)
      .where(eq(work.jobId, jobId))
      .orderBy(asc(work.id))
      .limit(MAX_PAGE);
    if (job.id !== covering.id) {
      for (const row of rows) {
        const [replacement] = await tx
          .select({ id: work.id })
          .from(work)
          .where(
            and(
              eq(work.jobId, covering.id),
              eq(work.sinkId, row.sinkId),
              eq(work.itemKey, row.itemKey),
              eq(work.kind, row.kind),
              eq(work.selectorDigest, row.selectorDigest),
              eq(work.selectorCaptureRevision, covering.captureRevision),
              isNull(work.selectorCiphertext),
              proofCondition(covering),
            ),
          );
        invariant(replacement, "historical_locator_unresolved");
        const oldDependencies = await tx
          .select()
          .from(dependencies)
          .where(eq(dependencies.workId, row.id))
          .limit(MAX_DEPENDENCIES + 1);
        const newDependencies = await tx
          .select()
          .from(dependencies)
          .where(eq(dependencies.workId, replacement.id))
          .limit(MAX_DEPENDENCIES + 1);
        invariant(
          oldDependencies.length <= MAX_DEPENDENCIES &&
            oldDependencies.every((old) => {
              return newDependencies.some((next) => {
                return (
                  old.sinkId === next.sinkId &&
                  old.itemKey === next.itemKey &&
                  old.obligation === next.obligation
                );
              });
            }),
          "historical_dependency_unresolved",
        );
      }
    }
    // Replacing an invalidated release requires the fresh external verification
    // and exact covering generation/locator checks above on every page.
    await tx
      .update(jobs)
      .set({ retirementReleaseRef: release.reference })
      .where(eq(jobs.id, jobId));
    if (rows.length > 0) {
      const ids = rows.map((row) => {
        return row.id;
      });
      const removedPages = await tx
        .delete(pages)
        .where(
          inArray(
            pages.id,
            tx
              .select({ id: pages.id })
              .from(pages)
              .where(inArray(pages.workId, ids))
              .orderBy(asc(pages.id))
              .limit(MAX_PAGE),
          ),
        )
        .returning({ id: pages.id });
      if (removedPages.length > 0) return "pending";
      await tx.delete(dependencies).where(inArray(dependencies.workId, ids));
      await tx.delete(work).where(inArray(work.id, ids));
      return "pending";
    }
    await tx.delete(sinks).where(eq(sinks.jobId, jobId));
    await tx.delete(jobs).where(eq(jobs.id, jobId));
    return "retired";
  });
}

export async function retireErasureSelector(
  db: Db,
  jobId: string,
  workId: string,
  expected: ErasureRevision,
): Promise<void> {
  uuid(workId);
  await db.transaction(async (tx) => {
    const job = await lockJob(tx, jobId);
    sameRevision(job, expected);
    invariant(
      job.sealedCaptureRevision === job.captureRevision &&
        job.producerBoundaryRef !== null,
      "capture_unsealed",
    );
    const [item] = await tx
      .select()
      .from(work)
      .where(
        and(eq(work.id, workId), eq(work.jobId, jobId), proofCondition(job)),
      );
    invariant(item, "work_unresolved");
    invariant(
      item.selectorCaptureRevision === job.captureRevision,
      "dependencies_incomplete",
    );
    const required = await tx
      .select()
      .from(dependencies)
      .where(eq(dependencies.workId, workId))
      .limit(MAX_DEPENDENCIES + 1);
    invariant(
      required.length > 0 &&
        required.length <= MAX_DEPENDENCIES &&
        required.some((dep) => {
          return dep.sinkId === item.sinkId && dep.itemKey === item.itemKey;
        }) &&
        required.some((dep) => {
          return dep.obligation === "recovery";
        }),
      "dependencies_incomplete",
    );
    for (const dependency of required) {
      const [finished] = await tx
        .select()
        .from(work)
        .where(
          and(
            eq(work.jobId, jobId),
            eq(work.sinkId, dependency.sinkId),
            eq(work.itemKey, dependency.itemKey),
            eq(work.generation, job.generation),
            proofCondition(job),
          ),
        );
      invariant(
        finished &&
          (dependency.obligation === "recovery"
            ? finished.kind === "recovery"
            : finished.kind !== "recovery"),
        "dependency_unresolved",
      );
    }
    await tx
      .update(work)
      .set({
        selectorCiphertext: null,
        cursorCiphertext: null,
        cursorDigest: null,
      })
      .where(eq(work.id, workId));
  });
}
