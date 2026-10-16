import {
  and,
  count,
  eq,
  exists,
  getTableColumns,
  gt,
  is,
  lt,
  sql,
  SQL,
  type Column,
} from "drizzle-orm";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { chatThreads } from "@okouai/db/runtime/chat-thread";
import { piMemoryStage1Candidates } from "@okouai/db/schema/pi-memory-stage1-candidate";
import { piMemoryPhase2Jobs } from "@okouai/db/runtime/pi-memory-phase2-job";
import { piMemoryStage1Watermarks } from "@okouai/db/schema/pi-memory-stage1-schedule";
import { storages } from "@okouai/db/schema/storage";

type PiMemoryStage1CommitResult =
  | {
      readonly kind: "succeeded";
      readonly rawMemory: string;
      readonly rolloutSummary: string;
      readonly rolloutSlug?: string;
    }
  | { readonly kind: "succeeded_no_output" }
  | {
      readonly kind: "retryable_failure";
      readonly retryAt: Date;
      readonly errorClass: string;
    }
  | { readonly kind: "terminal_failure"; readonly errorClass: string };

export interface CommitPiMemoryStage1CandidateArgs {
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly piSessionId: string;
  readonly sourceHistoryHash: string;
  readonly leaseToken: string;
  readonly committedAt: Date;
  readonly result: PiMemoryStage1CommitResult;
  readonly selectedSource?: {
    readonly chatThreadId: string;
    readonly sourceRunId: string;
    readonly sourceActivityAt: Date;
  };
}

function candidateCommitValues(args: CommitPiMemoryStage1CandidateArgs) {
  const common = {
    leaseToken: null,
    leaseExpiresAt: null,
    updatedAt: args.committedAt,
  };
  const resultValues =
    args.result.kind === "succeeded"
      ? {
          status: args.result.kind,
          rawMemory: args.result.rawMemory,
          rolloutSummary: args.result.rolloutSummary,
          rolloutSlug: args.result.rolloutSlug ?? null,
          generatedAt: args.committedAt,
          lastSelectedSourceHistoryHash: null,
          retryAt: null,
          lastErrorClass: null,
        }
      : args.result.kind === "succeeded_no_output"
        ? {
            status: args.result.kind,
            rawMemory: null,
            rolloutSummary: null,
            rolloutSlug: null,
            generatedAt: args.committedAt,
            lastSelectedSourceHistoryHash: null,
            retryAt: null,
            lastErrorClass: null,
          }
        : args.result.kind === "retryable_failure"
          ? {
              status: args.result.kind,
              rawMemory: null,
              rolloutSummary: null,
              rolloutSlug: null,
              generatedAt: null,
              lastSelectedSourceHistoryHash: null,
              retryAt: args.result.retryAt,
              retryCount: sql`${piMemoryStage1Candidates.retryCount} + 1`,
              lastErrorClass: args.result.errorClass,
            }
          : {
              status: args.result.kind,
              rawMemory: null,
              rolloutSummary: null,
              rolloutSlug: null,
              generatedAt: null,
              lastSelectedSourceHistoryHash: null,
              retryAt: null,
              lastErrorClass: args.result.errorClass,
            };
  return { ...common, ...resultValues };
}
function candidateCommitCondition(args: CommitPiMemoryStage1CandidateArgs) {
  return and(
    eq(piMemoryStage1Candidates.memoryStorageId, args.memoryStorageId),
    eq(piMemoryStage1Candidates.orgId, args.orgId),
    eq(piMemoryStage1Candidates.userId, args.userId),
    eq(piMemoryStage1Candidates.piSessionId, args.piSessionId),
    eq(piMemoryStage1Candidates.sourceHistoryHash, args.sourceHistoryHash),
    args.selectedSource
      ? eq(
          piMemoryStage1Candidates.sourceRunId,
          args.selectedSource.sourceRunId,
        )
      : undefined,
    eq(piMemoryStage1Candidates.status, "leased"),
    eq(piMemoryStage1Candidates.leaseToken, args.leaseToken),
    gt(piMemoryStage1Candidates.leaseExpiresAt, args.committedAt),
  );
}

export function candidateCommitPlan(args: CommitPiMemoryStage1CandidateArgs) {
  const builder = new QueryBuilder();
  const sourceThread = args.selectedSource
    ? builder
        .select({ id: chatThreads.id })
        .from(chatThreads)
        .where(
          and(
            eq(chatThreads.id, args.selectedSource.chatThreadId),
            eq(chatThreads.userId, args.userId),
          ),
        )
    : undefined;
  const storage = builder
    .select({ id: storages.id })
    .from(storages)
    .where(
      and(
        eq(storages.id, args.memoryStorageId),
        eq(storages.orgId, args.orgId),
        eq(storages.userId, args.userId),
      ),
    );
  return {
    sourceThread,
    storage,
    condition: and(
      candidateCommitCondition(args),
      exists(storage),
      sourceThread ? exists(sourceThread) : undefined,
    ),
    values: candidateCommitValues(args),
  };
}

/** Only the actual conditional UPDATE owns publication of its dependents. */
export function candidateCommitSql(
  args: CommitPiMemoryStage1CandidateArgs,
  entryCreatedAt?: string,
) {
  const plan = candidateCommitPlan(args);
  const columns: Readonly<Record<string, Column>> = getTableColumns(
    piMemoryStage1Candidates,
  );
  const values = Object.fromEntries(
    Object.entries(plan.values).map(([name, value]) => {
      return [name, is(value, SQL) ? value : sql.param(value, columns[name])];
    }),
  );
  const updates = new PgDialect().buildUpdateSet(
    piMemoryStage1Candidates,
    values,
  );
  const root = sql`UPDATE ${piMemoryStage1Candidates} SET ${updates}
    WHERE ${plan.condition} RETURNING "memory_storage_id", "org_id", "user_id"`;
  if (
    args.result.kind !== "succeeded" &&
    args.result.kind !== "succeeded_no_output"
  ) {
    return root;
  }
  if (entryCreatedAt === undefined) {
    throw new Error(
      "Successful Pi memory reconciliation requires its entry clock",
    );
  }
  const selected = args.selectedSource;
  const watermark = selected
    ? sql`, watermark AS (
    INSERT INTO ${piMemoryStage1Watermarks}
      ("memory_storage_id", "org_id", "user_id", "chat_thread_id", "source_activity_at", "source_history_hash")
    SELECT r.memory_storage_id, r.org_id, r.user_id,
      ${sql.param(selected.chatThreadId, piMemoryStage1Watermarks.chatThreadId)},
      ${sql.param(selected.sourceActivityAt, piMemoryStage1Watermarks.sourceActivityAt)},
      ${sql.param(args.sourceHistoryHash, piMemoryStage1Watermarks.sourceHistoryHash)}
    FROM committed r
    ON CONFLICT ("memory_storage_id", "chat_thread_id") DO UPDATE SET
      "source_activity_at" = EXCLUDED.source_activity_at, "source_history_hash" = EXCLUDED.source_history_hash
    WHERE ${and(
      eq(piMemoryStage1Watermarks.orgId, sql`EXCLUDED.org_id`),
      eq(piMemoryStage1Watermarks.userId, sql`EXCLUDED.user_id`),
      lt(
        piMemoryStage1Watermarks.sourceActivityAt,
        sql`EXCLUDED.source_activity_at`,
      ),
    )}
    RETURNING "memory_storage_id"
  )`
    : sql.empty();
  // The aggregate is total even when the monotonic watermark updates zero rows.
  const dependency = selected
    ? sql`CROSS JOIN (SELECT ${count()} AS n FROM watermark) w_done WHERE w_done.n >= 0`
    : sql`WHERE true`;
  return sql`WITH committed AS (${root})${watermark}, revision AS (
    INSERT INTO ${piMemoryPhase2Jobs}
      ("memory_storage_id", "org_id", "user_id", "status", "input_revision", "completed_revision", "retry_count", "updated_at", "created_at")
    SELECT r.memory_storage_id, r.org_id, r.user_id, 'pending', 1, 0, 0,
      ${sql.param(args.committedAt, piMemoryPhase2Jobs.updatedAt)}, CAST(${entryCreatedAt} AS timestamp)
    FROM committed r ${dependency}
    ON CONFLICT ("memory_storage_id") DO UPDATE SET
      "org_id" = EXCLUDED.org_id, "user_id" = EXCLUDED.user_id,
      "status" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN 'leased' ELSE 'pending' END,
      "input_revision" = ${piMemoryPhase2Jobs.inputRevision} + 1,
      "claimed_revision" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN ${piMemoryPhase2Jobs.claimedRevision} ELSE NULL END,
      "claimed_base_version_id" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN ${piMemoryPhase2Jobs.claimedBaseVersionId} ELSE NULL END,
      "lease_token" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN ${piMemoryPhase2Jobs.leaseToken} ELSE NULL END,
      "lease_expires_at" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN ${piMemoryPhase2Jobs.leaseExpiresAt} ELSE NULL END,
      "maintenance_run_id" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN ${piMemoryPhase2Jobs.maintenanceRunId} ELSE NULL END,
      "retry_count" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN ${piMemoryPhase2Jobs.retryCount} ELSE 0 END,
      "claimed_selection_digest" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN ${piMemoryPhase2Jobs.claimedSelectionDigest} ELSE NULL END,
      "claimed_selected_count" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN ${piMemoryPhase2Jobs.claimedSelectedCount} ELSE NULL END,
      "claimed_selected_utf8_bytes" = CASE WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN ${piMemoryPhase2Jobs.claimedSelectedUtf8Bytes} ELSE NULL END,
      "retry_at" = NULL, "last_error_class" = NULL, "updated_at" = EXCLUDED.updated_at
    RETURNING "memory_storage_id"
  ) SELECT memory_storage_id AS "memoryStorageId" FROM committed`;
}
