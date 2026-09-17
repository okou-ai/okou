import type {
  MorningBriefGenerationFailureReason,
  MorningBriefGenerationState,
} from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import {
  MORNING_BRIEF_GENERATION_PROMPT_VERSION,
  MORNING_BRIEF_GENERATION_RESULT_SCHEMA_VERSION,
  morningBriefGenerations,
  morningBriefPlatformGenerationReceipts,
} from "@okouai/db/schema/morning-brief-generation";
import { and, eq, gt, lte, sql } from "drizzle-orm";
import { z } from "zod";

import { executeRawRows } from "../../lib/db-raw-rows";
import type { Tx } from "../../lib/db-types";
import { nowDate, timestampWithoutTimeZone } from "../../lib/time";
import type { Db, ReadonlyDb } from "../external/db";
import {
  lockCollectionOwner,
  type MorningBriefCollectionOwner,
} from "./morning-brief-collection-occurrence.service";

/**
 * The durable boundary for one Morning Brief generation and its platform cost.
 *
 * Every function here is a database boundary only: no provider call, no prompt
 * and no source body passes through it. Two separations are deliberate.
 *
 * **Owner state and platform spend are written separately.** The receipt exists
 * to record what Okou was charged; it carries no owner identity and must be
 * writable even for an invocation whose owner was revoked or erased while the
 * request was in flight. The owner-scoped row is written under the same fences
 * the reservation was admitted with, so a revoked owner simply matches nothing
 * instead of being recreated.
 *
 * **Nothing here charges a user.** It never writes `usage_event`, a credit
 * debit, an allowance or a balance row, and never calls organization billing.
 *
 * The rules are described in
 * [the generation contract](../../../../../../docs/morning-brief-generation.md).
 */

/** The occurrence a generation belongs to. Also the generation's own identity. */
export interface MorningBriefGenerationKey {
  readonly owner: MorningBriefCollectionOwner;
  readonly scheduledFor: Date;
  readonly collectionKind: string;
  readonly collectionVersion: number;
}

/** What an already admitted attempt must still match to write anything. */
export interface MorningBriefGenerationFence {
  readonly key: MorningBriefGenerationKey;
  readonly attemptId: string;
  readonly membershipId: string;
}

export type MorningBriefGenerationRow =
  typeof morningBriefGenerations.$inferSelect;

export interface MorningBriefPlatformReceiptValues {
  readonly attemptId: string;
  readonly operation: string;
  readonly provider: string;
  readonly requestedModel: string;
  readonly returnedModel: string | null;
  readonly providerGenerationId: string | null;
  readonly outcome: (typeof morningBriefPlatformGenerationReceipts.$inferInsert)["outcome"];
  readonly costState: (typeof morningBriefPlatformGenerationReceipts.$inferInsert)["costState"];
  readonly costValue: string | null;
  readonly costUnit: string | null;
  readonly costSource: (typeof morningBriefPlatformGenerationReceipts.$inferInsert)["costSource"];
  readonly promptTokens: number | null;
  readonly completionTokens: number | null;
  readonly reasoningTokens: number | null;
  readonly cachedTokens: number | null;
  readonly totalTokens: number | null;
  readonly startedAt: Date;
  readonly finishedAt: Date;
}

function generationKey(key: MorningBriefGenerationKey) {
  return and(
    eq(morningBriefGenerations.orgId, key.owner.orgId),
    eq(morningBriefGenerations.userId, key.owner.userId),
    eq(morningBriefGenerations.scheduledFor, key.scheduledFor),
    eq(morningBriefGenerations.collectionKind, key.collectionKind),
    eq(morningBriefGenerations.collectionVersion, key.collectionVersion),
  );
}

export interface MorningBriefGenerationAdmission {
  readonly key: MorningBriefGenerationKey;
  readonly attemptId: string;
  readonly membershipId: string;
  readonly agentId: string;
  readonly model: string;
  readonly language: string;
  readonly languageSource: (typeof morningBriefGenerations.$inferInsert)["languageSource"];
  readonly inputDigest: string;
  readonly inputItems: number;
  readonly includedItems: number;
  readonly inputReduced: boolean;
  readonly sourceCoverage: (typeof morningBriefGenerations.$inferInsert)["sourceCoverage"];
  readonly reservedAt: Date;
  readonly reservationExpiresAt: Date;
  readonly expiresAt: Date;
}

function admissionValues(admission: MorningBriefGenerationAdmission) {
  return {
    orgId: admission.key.owner.orgId,
    userId: admission.key.owner.userId,
    scheduledFor: admission.key.scheduledFor,
    collectionKind: admission.key.collectionKind,
    collectionVersion: admission.key.collectionVersion,
    executionPurpose: "preview" as const,
    attemptId: admission.attemptId,
    membershipId: admission.membershipId,
    agentId: admission.agentId,
    model: admission.model,
    promptVersion: MORNING_BRIEF_GENERATION_PROMPT_VERSION,
    resultSchemaVersion: MORNING_BRIEF_GENERATION_RESULT_SCHEMA_VERSION,
    language: admission.language,
    languageSource: admission.languageSource,
    inputDigest: admission.inputDigest,
    inputItems: admission.inputItems,
    includedItems: admission.includedItems,
    inputReduced: admission.inputReduced,
    sourceCoverage: admission.sourceCoverage,
    reservedAt: admission.reservedAt,
    reservationExpiresAt: admission.reservationExpiresAt,
    expiresAt: admission.expiresAt,
    createdAt: admission.reservedAt,
    updatedAt: admission.reservedAt,
  };
}

/**
 * Commit the single invocation admission for this occurrence.
 *
 * It runs inside the transaction that finalizes the collection, so the
 * collected facts and the right to call the provider become durable together
 * or not at all. The primary key is the occurrence, so a second caller can
 * never obtain a second admission — and because the row exists before any
 * request is sent, a crash between this commit and the request leaves an
 * ambiguity the caller has to acknowledge rather than resolve by re-sending.
 */
export async function reserveMorningBriefGeneration(
  tx: Tx,
  admission: MorningBriefGenerationAdmission,
): Promise<boolean> {
  const [created] = await tx
    .insert(morningBriefGenerations)
    .values({ ...admissionValues(admission), state: "reserved" })
    .onConflictDoNothing()
    .returning({ attemptId: morningBriefGenerations.attemptId });
  return created !== undefined;
}

/**
 * Record a terminal outcome that consumed zero model calls.
 *
 * A successful read with no candidates and a bounded read with no candidates
 * are both recorded here, under distinct states, so an incomplete read can
 * never be reported as a healthy empty day.
 */
export async function recordMorningBriefGenerationSkip(
  tx: Tx,
  admission: MorningBriefGenerationAdmission,
  state: Extract<
    MorningBriefGenerationState,
    "skipped_empty" | "skipped_incomplete"
  >,
): Promise<boolean> {
  const [created] = await tx
    .insert(morningBriefGenerations)
    .values({
      ...admissionValues(admission),
      state,
      finishedAt: admission.reservedAt,
    })
    .onConflictDoNothing()
    .returning({ attemptId: morningBriefGenerations.attemptId });
  return created !== undefined;
}

/**
 * Read the generation for one occurrence, for one execution purpose.
 *
 * The purpose is a filter rather than a comment: a consumer only ever sees
 * results produced for the purpose it asked for, so a preview result cannot be
 * picked up by a production delivery that happens to share an owner and an
 * anchor. The slot itself stays one-per-occurrence, so a differing purpose
 * cannot open a second invocation either.
 */
export async function readMorningBriefGeneration(
  db: Pick<ReadonlyDb, "select">,
  key: MorningBriefGenerationKey,
  purpose: (typeof morningBriefGenerations.$inferSelect)["executionPurpose"],
): Promise<MorningBriefGenerationRow | undefined> {
  const [row] = await db
    .select()
    .from(morningBriefGenerations)
    .where(
      and(
        generationKey(key),
        eq(morningBriefGenerations.executionPurpose, purpose),
      ),
    )
    .limit(1);
  return row;
}

function fenceCondition(fence: MorningBriefGenerationFence) {
  return and(
    generationKey(fence.key),
    eq(morningBriefGenerations.state, "reserved"),
    eq(morningBriefGenerations.attemptId, fence.attemptId),
    eq(morningBriefGenerations.membershipId, fence.membershipId),
  );
}

type MorningBriefGenerationWriteResult =
  | { readonly kind: "written"; readonly row: MorningBriefGenerationRow }
  | { readonly kind: "not-owned" };

interface AcceptedResultValues {
  readonly decision: "deliver" | "skip";
  readonly skipReason: string | null;
  readonly title: string | null;
  readonly markdown: string | null;
  readonly bytes: number | null;
}

/**
 * The admission this attempt actually holds, and the instant it holds it at.
 *
 * It is a value rather than an implicit step so the caller can do the two
 * things only it can do — honour cancellation, and re-prove the owner's live
 * authority — at the one instant that matters: after every real wait, and
 * before any mutation has been issued.
 */
interface MorningBriefGenerationHold {
  readonly at: Date;
}

/**
 * Take this attempt's slot and read the clock only once it is really held.
 *
 * Both guarded writes below wait twice: once for the owner lock, and once for
 * the slot row itself. A clock sampled before those waits can be arbitrarily
 * stale by the time the write lands, which would let a reservation that expired
 * *during* the wait still accept content. Sampling here — after every relevant
 * wait and on every attempt — makes the deadline comparison describe the
 * instant the mutation is actually admitted.
 */
export async function holdMorningBriefGenerationSlot(
  tx: Tx,
  fence: MorningBriefGenerationFence,
): Promise<MorningBriefGenerationHold | null> {
  if (!(await lockCollectionOwner(tx, fence.key.owner))) {
    return null;
  }
  const [locked] = await tx
    .select({ attemptId: morningBriefGenerations.attemptId })
    .from(morningBriefGenerations)
    .where(generationKey(fence.key))
    .for("update")
    .limit(1);
  if (!locked) {
    return null;
  }
  return { at: nowDate() };
}

/**
 * Accept one validated result into the occurrence's single result slot.
 *
 * Content is accepted only while this attempt still holds an unexpired
 * reservation under an unchanged membership generation, measured against the
 * clock the caller sampled when it actually took the slot. Equality with the
 * reservation deadline is already expired, so a result that became late while
 * persistence waited is not stored — the caller records the honest
 * non-accepting outcome instead.
 */
export async function acceptMorningBriefGenerationResult(
  tx: Tx,
  fence: MorningBriefGenerationFence,
  held: MorningBriefGenerationHold,
  result: AcceptedResultValues,
): Promise<MorningBriefGenerationWriteResult> {
  const [written] = await tx
    .update(morningBriefGenerations)
    .set({
      state: "succeeded",
      decision: result.decision,
      skipReason: result.skipReason,
      resultTitle: result.title,
      resultMarkdown: result.markdown,
      resultBytes: result.bytes,
      failureReason: null,
      finishedAt: held.at,
      updatedAt: held.at,
    })
    .where(
      and(
        fenceCondition(fence),
        gt(morningBriefGenerations.reservationExpiresAt, held.at),
      ),
    )
    .returning();
  return written ? { kind: "written", row: written } : { kind: "not-owned" };
}

/**
 * Record a terminal outcome that stores no owner content.
 *
 * Unlike acceptance this does not require an unexpired reservation: the
 * invocation already happened, and refusing to record why it produced nothing
 * would leave the slot looking merely stale. It still requires this exact
 * attempt and membership generation, so it can never overwrite another
 * claimant or revive a revoked owner.
 */
export async function recordMorningBriefGenerationOutcome(
  tx: Tx,
  fence: MorningBriefGenerationFence,
  held: MorningBriefGenerationHold,
  outcome: {
    readonly state: Extract<
      MorningBriefGenerationState,
      | "output_rejected"
      | "provider_failed"
      | "not_invoked"
      | "result_discarded"
      | "invocation_outcome_unknown"
    >;
    readonly failureReason: MorningBriefGenerationFailureReason;
  },
): Promise<MorningBriefGenerationWriteResult> {
  const [written] = await tx
    .update(morningBriefGenerations)
    .set({
      state: outcome.state,
      failureReason: outcome.failureReason,
      finishedAt: held.at,
      updatedAt: held.at,
    })
    .where(fenceCondition(fence))
    .returning();
  return written ? { kind: "written", row: written } : { kind: "not-owned" };
}

/**
 * Settle a reservation whose owner never recorded an outcome.
 *
 * This is the observable recovery path, and it deliberately resolves to
 * *unknown* rather than to a retryable state: the original request may already
 * have reached the provider. It is driven by an explicit invocation, so no
 * background scheduler or queue is introduced. The attempt id is not required,
 * because the attempt that would have supplied it is exactly the one that
 * disappeared.
 */
export async function resolveStaleMorningBriefGeneration(
  tx: Tx,
  key: MorningBriefGenerationKey,
): Promise<MorningBriefGenerationRow | undefined> {
  const [locked] = await tx
    .select({ attemptId: morningBriefGenerations.attemptId })
    .from(morningBriefGenerations)
    .where(generationKey(key))
    .for("update")
    .limit(1);
  if (!locked) {
    return undefined;
  }
  // Sampled after the row is held, so a slot that expires during the wait is
  // settled against the instant this statement really runs.
  const at = nowDate();
  const [written] = await tx
    .update(morningBriefGenerations)
    .set({
      state: "invocation_outcome_unknown",
      failureReason: "persistence_failed",
      finishedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        generationKey(key),
        eq(morningBriefGenerations.state, "reserved"),
        lte(morningBriefGenerations.reservationExpiresAt, at),
      ),
    )
    .returning();
  return written;
}

/**
 * Write the platform's own spend record for one invocation.
 *
 * The opaque attempt id is the idempotency key, so a bounded persistence retry
 * of the same observed receipt writes exactly one cost record. This takes no
 * erasure admission and no owner lock on purpose: the charge is real and
 * anonymous, and it must still be recorded when the owner is already gone.
 */
export async function recordPlatformGenerationReceipt(
  db: Pick<Db, "insert">,
  values: MorningBriefPlatformReceiptValues,
): Promise<void> {
  await db
    .insert(morningBriefPlatformGenerationReceipts)
    .values(values)
    .onConflictDoNothing({
      target: [morningBriefPlatformGenerationReceipts.attemptId],
    });
}

export async function readPlatformGenerationReceipt(
  db: Pick<ReadonlyDb, "select">,
  attemptId: string,
): Promise<
  typeof morningBriefPlatformGenerationReceipts.$inferSelect | undefined
> {
  const [row] = await db
    .select()
    .from(morningBriefPlatformGenerationReceipts)
    .where(eq(morningBriefPlatformGenerationReceipts.attemptId, attemptId))
    .limit(1);
  return row;
}

/**
 * Drop this owner's expired preview results.
 *
 * Preview results are derived from source content, so they get a real, bounded
 * lifetime rather than a promise that they are ephemeral. This is the
 * opportunistic half of that bound: the preview entrypoint consumes it for the
 * invoking owner, so an owner who comes back never reads their own stale
 * content. It is scoped to that owner and can never touch another's rows. The
 * bound itself does not depend on it — see the maintenance purge below. The
 * anonymous platform receipt is untouched: an incurred cost is not erased by
 * retention.
 */
export async function sweepExpiredMorningBriefGenerations(
  db: Pick<Db, "delete">,
  owner: MorningBriefCollectionOwner,
  at: Date,
): Promise<number> {
  const deleted = await db
    .delete(morningBriefGenerations)
    .where(
      and(
        eq(morningBriefGenerations.orgId, owner.orgId),
        eq(morningBriefGenerations.userId, owner.userId),
        lte(morningBriefGenerations.expiresAt, at),
      ),
    )
    .returning({ attemptId: morningBriefGenerations.attemptId });
  return deleted.length;
}

const purgedRowSchema = z.object({ purged: z.int().nonnegative() });

/**
 * Physically purge expired preview results, for owners who never came back.
 *
 * An owner-scoped sweep bounds nothing on its own: an owner who invokes once
 * and never again would otherwise keep source-derived title and Markdown
 * forever. This is the batch a bounded maintenance consumer runs instead, and
 * it is deliberately small and interruptible — one ordered, limited selection
 * under `SKIP LOCKED`, so it never queues behind an attempt that is mid-write
 * and never takes a table-wide lock. `idx_morning_brief_generations_expiry`
 * serves the ordered scan, so the plan stays an index range over already
 * expired rows rather than a sequential scan of the table.
 *
 * Removing the row removes the content *and* the attempt's link to its cost
 * record; the anonymous receipt itself is never touched, exactly as the
 * owner-scoped sweep leaves it. What survives instead is the completed
 * collection occurrence, which is content-free and is what actually refuses a
 * second invocation — a purged slot is reported as a completed collection that
 * holds no generation, never as an occurrence free to call the provider again.
 */
export async function purgeExpiredMorningBriefGenerations(
  db: Pick<Db, "execute">,
  at: Date,
  limit: number,
): Promise<number> {
  const cutoff = timestampWithoutTimeZone(at);
  const rows = await executeRawRows(
    db,
    sql`
      WITH expired AS (
        SELECT
          generation.org_id,
          generation.user_id,
          generation.scheduled_for,
          generation.collection_kind,
          generation.collection_version
        FROM ${morningBriefGenerations} generation
        WHERE generation.expires_at <= ${cutoff}::timestamp
        ORDER BY generation.expires_at ASC
        LIMIT ${limit}
        FOR UPDATE OF generation SKIP LOCKED
      ),
      purged AS (
        DELETE FROM ${morningBriefGenerations} generation
        USING expired
        WHERE generation.org_id = expired.org_id
          AND generation.user_id = expired.user_id
          AND generation.scheduled_for = expired.scheduled_for
          AND generation.collection_kind = expired.collection_kind
          AND generation.collection_version = expired.collection_version
        RETURNING generation.attempt_id
      )
      SELECT count(*)::int AS purged FROM purged
    `,
    purgedRowSchema,
  );
  const purged = rows[0]?.purged;
  if (purged === undefined) {
    throw new Error("Morning Brief generation purge returned no summary row");
  }
  return purged;
}
