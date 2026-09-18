import type {
  MorningBriefGenerationFailureReason,
  MorningBriefGenerationState,
} from "@okouai/api-contracts/contracts/morning-brief-generation-preview";
import type { MorningBriefRetainedSources } from "@okouai/db/jsonb-contracts/morning-brief-generation";
import {
  MORNING_BRIEF_GENERATION_PROMPT_VERSION,
  MORNING_BRIEF_GENERATION_RESULT_SCHEMA_VERSION,
  MORNING_BRIEF_GENERATION_UNINVOKED_STATES,
  morningBriefGenerations,
  morningBriefPlatformGenerationReceipts,
} from "@okouai/db/schema/morning-brief-generation";
import {
  and,
  eq,
  gt,
  isNotNull,
  isNull,
  lt,
  lte,
  notInArray,
  or,
  sql,
} from "drizzle-orm";
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
  /**
   * Who may consume the result this admission reserves.
   *
   * It is carried on the admission rather than fixed per module so the native
   * scheduler's production occurrences and the operator preview share one
   * reservation, accounting and validation engine while remaining unable to
   * read each other's results.
   */
  readonly executionPurpose: (typeof morningBriefGenerations.$inferSelect)["executionPurpose"];
  readonly attemptId: string;
  readonly membershipId: string;
  readonly agentId: string;
  /** Complete canonical binding; null only for historical Slack-only writers. */
  readonly installationId: string | null;
  readonly automationId: string | null;
  readonly chatThreadId: string | null;
  readonly model: string;
  readonly language: string;
  readonly languageSource: (typeof morningBriefGenerations.$inferInsert)["languageSource"];
  readonly inputDigest: string;
  readonly inputItems: number;
  readonly includedItems: number;
  readonly inputReduced: boolean;
  readonly sourceCoverage: (typeof morningBriefGenerations.$inferInsert)["sourceCoverage"];
  /** Frozen at reservation. Both present or both absent. */
  readonly instructionsVersionId: string | null;
  readonly instructionsDigest: string | null;
  /**
   * The bounded proof that every supplied input was authorized, cited or not.
   *
   * Frozen with the reservation because it describes the request that is about
   * to be sent; a later phase revalidates it rather than recollecting it.
   */
  readonly retainedSources: MorningBriefRetainedSources | null;
  /** Never earlier than `expiresAt`, and never extended by a retry. */
  readonly retainedUntil: Date | null;
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
    executionPurpose: admission.executionPurpose,
    attemptId: admission.attemptId,
    membershipId: admission.membershipId,
    agentId: admission.agentId,
    installationId: admission.installationId,
    automationId: admission.automationId,
    chatThreadId: admission.chatThreadId,
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
    instructionsVersionId: admission.instructionsVersionId,
    instructionsDigest: admission.instructionsDigest,
    retainedSources: admission.retainedSources,
    retainedUntil: admission.retainedUntil,
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
 *
 * `onConflictDoNothing` covers every unique constraint on the table, so this
 * also refuses when the owner's anchor is already occupied by a possibly
 * invoked generation admitted under a *different* collection kind or contract
 * version. That is the case a per-occurrence key cannot see, and it is
 * precisely the one that would otherwise turn a widened source set into a
 * second provider request for the same morning.
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
 * The generation already occupying this owner's anchor, if any.
 *
 * It reads the same predicate the anchor's unique index enforces, so a refused
 * reservation can be reported as the conflict it is rather than as a broken
 * invariant. It is purpose-scoped like every other read here: a preview
 * generation never occupies a production anchor.
 */
export async function readInvokedAnchorGeneration(
  tx: Tx,
  args: {
    readonly owner: MorningBriefCollectionOwner;
    readonly scheduledFor: Date;
    readonly executionPurpose: MorningBriefGenerationAdmission["executionPurpose"];
  },
): Promise<MorningBriefGenerationRow | undefined> {
  const [row] = await tx
    .select()
    .from(morningBriefGenerations)
    .where(
      and(
        eq(morningBriefGenerations.orgId, args.owner.orgId),
        eq(morningBriefGenerations.userId, args.owner.userId),
        eq(morningBriefGenerations.scheduledFor, args.scheduledFor),
        eq(morningBriefGenerations.executionPurpose, args.executionPurpose),
        notInArray(morningBriefGenerations.state, [
          ...MORNING_BRIEF_GENERATION_UNINVOKED_STATES,
        ]),
      ),
    )
    .limit(1);
  return row;
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

/** Extend metadata only to the original outbox deadline; never a retry clock. */
export async function retainMorningBriefGenerationProofUntil(
  tx: Tx,
  args: {
    readonly owner: MorningBriefCollectionOwner;
    readonly attemptId: string;
    readonly retainedUntil: Date;
  },
): Promise<boolean> {
  const [updated] = await tx
    .update(morningBriefGenerations)
    .set({
      retainedUntil: sql`GREATEST(${morningBriefGenerations.retainedUntil}, ${args.retainedUntil})`,
    })
    .where(
      and(
        eq(morningBriefGenerations.orgId, args.owner.orgId),
        eq(morningBriefGenerations.userId, args.owner.userId),
        eq(morningBriefGenerations.attemptId, args.attemptId),
      ),
    )
    .returning({ attemptId: morningBriefGenerations.attemptId });
  return updated !== undefined;
}

/** Read one occurrence for one purpose; purposes never consume each other. */
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
  /**
   * The output language the invocation reported, when it is one this pipeline
   * recognizes. Null records that nothing usable was reported; it is never the
   * requested language standing in for an unobserved one.
   */
  readonly reportedLanguage?: string | null;
  readonly title: string | null;
  readonly markdown: string | null;
  readonly bytes: number | null;
}

/**
 * Take this occurrence's generation row for the rest of the transaction.
 *
 * It is the row every guarded write updates and the row the retention purge
 * deletes, so holding it is what makes an attempt's own slot stable: the
 * maintenance purge selects `FOR UPDATE ... SKIP LOCKED` and simply skips a held
 * row, and the owner-scoped sweep, the member cleanup cascade and the Agent
 * deletion cascade all have to acquire it before they can remove it.
 *
 * It returns the row rather than an existence flag because the readback fence
 * needs the same copy it just pinned; reading it again afterwards would reopen
 * the interval the lock exists to close. It deliberately samples no clock: the
 * instant that decides a deadline belongs at the caller's own admission point,
 * after every wait the caller still has ahead of it.
 */
export async function lockMorningBriefGeneration(
  tx: Tx,
  key: MorningBriefGenerationKey,
): Promise<MorningBriefGenerationRow | undefined> {
  const [locked] = await tx
    .select()
    .from(morningBriefGenerations)
    .where(generationKey(key))
    .for("update")
    .limit(1);
  return locked;
}

/**
 * The owner fence plus this attempt's slot, in the one order that is safe.
 *
 * The member row comes first because membership, user and organization cleanup
 * take it before deleting the occurrences this row hangs from; the slot row
 * comes second because every cascade that can remove it walks a parent first.
 * Callers that also hold local authority rows take those between the two, so
 * the whole path stays parent-before-child and cannot close a cycle with a
 * deletion walking the same foreign keys.
 */
export async function holdMorningBriefGenerationSlot(
  tx: Tx,
  fence: MorningBriefGenerationFence,
): Promise<boolean> {
  if (!(await lockCollectionOwner(tx, fence.key.owner))) {
    return false;
  }
  return (await lockMorningBriefGeneration(tx, fence.key)) !== undefined;
}

/**
 * Accept one validated result into the occurrence's single result slot.
 *
 * Content is accepted only while this attempt still holds an unexpired
 * reservation under an unchanged membership generation, measured against `at` —
 * the instant the caller admitted this write at, after every lock, every local
 * read and its own cancellation check. Equality with the reservation deadline is
 * already expired, so a result that became late while persistence waited is not
 * stored — the caller records the honest non-accepting outcome instead.
 */
export async function acceptMorningBriefGenerationResult(
  tx: Tx,
  fence: MorningBriefGenerationFence,
  at: Date,
  result: AcceptedResultValues,
): Promise<MorningBriefGenerationWriteResult> {
  const [written] = await tx
    .update(morningBriefGenerations)
    .set({
      state: "succeeded",
      decision: result.decision,
      skipReason: result.skipReason,
      reportedLanguage: result.reportedLanguage ?? null,
      resultTitle: result.title,
      resultMarkdown: result.markdown,
      resultBytes: result.bytes,
      failureReason: null,
      finishedAt: at,
      updatedAt: at,
    })
    .where(
      and(
        fenceCondition(fence),
        gt(morningBriefGenerations.reservationExpiresAt, at),
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
  at: Date,
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
      finishedAt: at,
      updatedAt: at,
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
 * Drop this owner's expired content while retaining its invocation fence.
 *
 * Preview results are derived from source content, so they get a real, bounded
 * lifetime rather than a promise that they are ephemeral. This is the
 * opportunistic half of that bound: the preview entrypoint consumes it for the
 * invoking owner, so an owner who comes back never reads stale content.
 * Retained-source proof has its own deadline and is cleared only then; the
 * content-free row survives through the seven-day anchor admission window so a
 * different kind or contract version cannot POST again. The anonymous platform
 * receipt is untouched.
 */
export async function sweepExpiredMorningBriefGenerations(
  db: Pick<Db, "update" | "delete">,
  owner: MorningBriefCollectionOwner,
  at: Date,
): Promise<number> {
  const sanitized = await db
    .update(morningBriefGenerations)
    .set({
      resultTitle: null,
      resultMarkdown: null,
      resultBytes: null,
      contentPurgedAt: sql`CASE
        WHEN ${morningBriefGenerations.decision} = 'deliver'
          THEN COALESCE(${morningBriefGenerations.contentPurgedAt}, ${at})
        ELSE ${morningBriefGenerations.contentPurgedAt}
      END`,
      retainedSources: sql`CASE
        WHEN ${morningBriefGenerations.retainedUntil} <= ${at}
          THEN NULL
        ELSE ${morningBriefGenerations.retainedSources}
      END`,
      retainedUntil: sql`CASE
        WHEN ${morningBriefGenerations.retainedUntil} <= ${at}
          THEN NULL
        ELSE ${morningBriefGenerations.retainedUntil}
      END`,
    })
    .where(
      and(
        eq(morningBriefGenerations.orgId, owner.orgId),
        eq(morningBriefGenerations.userId, owner.userId),
        lte(morningBriefGenerations.expiresAt, at),
        or(
          and(
            eq(morningBriefGenerations.decision, "deliver"),
            isNull(morningBriefGenerations.contentPurgedAt),
          ),
          and(
            lte(morningBriefGenerations.retainedUntil, at),
            isNotNull(morningBriefGenerations.retainedSources),
          ),
        ),
      ),
    )
    .returning({ attemptId: morningBriefGenerations.attemptId });

  const replayCutoff = new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000);
  const deleted = await db
    .delete(morningBriefGenerations)
    .where(
      and(
        eq(morningBriefGenerations.orgId, owner.orgId),
        eq(morningBriefGenerations.userId, owner.userId),
        lte(morningBriefGenerations.expiresAt, at),
        lt(morningBriefGenerations.scheduledFor, replayCutoff),
      ),
    )
    .returning({ attemptId: morningBriefGenerations.attemptId });
  return sanitized.length + deleted.length;
}

const purgedRowSchema = z.object({ purged: z.int().nonnegative() });

/**
 * Purge expired source content for owners who never came back.
 *
 * An owner-scoped sweep bounds nothing on its own: an owner who invokes once
 * and never again would otherwise keep source-derived title and Markdown
 * forever. This bounded maintenance batch first clears accepted body bytes,
 * then clears retained authorization proof only at its own original deadline.
 * The content-free row remains while the anchor is still invocable, because its
 * owner/purpose anchor index is the cross-kind/version proof that the provider
 * may already have been contacted. Only after the seven-day anchor admission
 * window closes can that metadata row be physically removed.
 *
 * The ordered, limited selection uses `SKIP LOCKED`, so it never queues behind
 * an attempt that is mid-write and never takes a table-wide lock.
 * `idx_morning_brief_generations_expiry` serves the ordered scan. The anonymous
 * platform receipt is never touched. `owners` narrows the same statement to an
 * explicit set of members for isolated route coverage; production passes none.
 */
export async function purgeExpiredMorningBriefGenerations(
  db: Pick<Db, "execute">,
  at: Date,
  limit: number,
  owners?: readonly MorningBriefCollectionOwner[],
): Promise<number> {
  if (owners?.length === 0) {
    return 0;
  }
  const cutoff = timestampWithoutTimeZone(at);
  const replayCutoff = timestampWithoutTimeZone(
    new Date(at.getTime() - 7 * 24 * 60 * 60 * 1000),
  );
  const ownerScope =
    owners === undefined
      ? sql.empty()
      : sql` AND (generation.org_id, generation.user_id) IN (${sql.join(
          owners.map((owner) => {
            return sql`(${owner.orgId}, ${owner.userId})`;
          }),
          sql`, `,
        )})`;
  const rows = await executeRawRows(
    db,
    sql`
      WITH candidates AS (
        SELECT
          generation.org_id,
          generation.user_id,
          generation.scheduled_for,
          generation.collection_kind,
          generation.collection_version
        FROM ${morningBriefGenerations} generation
        WHERE generation.expires_at <= ${cutoff}::timestamp${ownerScope}
          AND (
            generation.scheduled_for < ${replayCutoff}::timestamp
            OR (generation.decision = 'deliver'
              AND generation.content_purged_at IS NULL)
            OR (generation.retained_until <= ${cutoff}::timestamp
              AND generation.retained_sources IS NOT NULL)
          )
        ORDER BY generation.expires_at ASC
        LIMIT ${limit}
        FOR UPDATE OF generation SKIP LOCKED
      ),
      sanitized AS (
        UPDATE ${morningBriefGenerations} generation
        SET result_title = NULL,
            result_markdown = NULL,
            result_bytes = NULL,
            content_purged_at = CASE
              WHEN generation.decision = 'deliver'
                THEN COALESCE(generation.content_purged_at, ${cutoff}::timestamp)
              ELSE generation.content_purged_at
            END,
            retained_sources = CASE
              WHEN generation.retained_until <= ${cutoff}::timestamp THEN NULL
              ELSE generation.retained_sources
            END,
            retained_until = CASE
              WHEN generation.retained_until <= ${cutoff}::timestamp THEN NULL
              ELSE generation.retained_until
            END
        FROM candidates
        WHERE generation.org_id = candidates.org_id
          AND generation.user_id = candidates.user_id
          AND generation.scheduled_for = candidates.scheduled_for
          AND generation.collection_kind = candidates.collection_kind
          AND generation.collection_version = candidates.collection_version
          AND generation.scheduled_for >= ${replayCutoff}::timestamp
        RETURNING generation.attempt_id
      ),
      purged AS (
        DELETE FROM ${morningBriefGenerations} generation
        USING candidates
        WHERE generation.org_id = candidates.org_id
          AND generation.user_id = candidates.user_id
          AND generation.scheduled_for = candidates.scheduled_for
          AND generation.collection_kind = candidates.collection_kind
          AND generation.collection_version = candidates.collection_version
          AND generation.scheduled_for < ${replayCutoff}::timestamp
        RETURNING generation.attempt_id
      ),
      affected AS (
        SELECT attempt_id FROM sanitized
        UNION ALL
        SELECT attempt_id FROM purged
      )
      SELECT count(*)::int AS purged FROM affected
    `,
    purgedRowSchema,
  );
  const purged = rows[0]?.purged;
  if (purged === undefined) {
    throw new Error("Morning Brief generation purge returned no summary row");
  }
  return purged;
}
