import { piMemoryPhase2Jobs } from "@okouai/db/runtime/pi-memory-phase2-job";
import { and, eq, inArray, or, sql } from "drizzle-orm";
import {
  nullableDriverValueDecoder,
  pgTextDecoder,
} from "../../lib/db-structured-result";

export interface MaintenancePublicationBinding {
  readonly runId: string;
  readonly memoryStorageId: string;
  readonly orgId: string;
  readonly userId: string;
  readonly leaseToken: string;
  readonly claimedRevision: number;
  readonly claimedBaseVersionId: string;
  readonly selectionDigest: string;
}

/** The callback authenticates the lease; the Job owns its latest committed result. */
export function maintenancePublicationResultCondition(
  binding: MaintenancePublicationBinding,
) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, binding.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, binding.orgId),
    eq(piMemoryPhase2Jobs.userId, binding.userId),
    eq(piMemoryPhase2Jobs.lastMaintenanceRunId, binding.runId),
    eq(piMemoryPhase2Jobs.lastMaintenanceRevision, binding.claimedRevision),
    eq(
      piMemoryPhase2Jobs.lastMaintenanceBaseVersionId,
      binding.claimedBaseVersionId,
    ),
    eq(
      piMemoryPhase2Jobs.lastMaintenanceSelectionDigest,
      binding.selectionDigest,
    ),
    inArray(piMemoryPhase2Jobs.lastMaintenanceOutcome, [
      "published",
      "no_diff",
    ]),
  );
}

/** The original owned attempt, or its explicit unpublished failure, proves base recovery. */
export function maintenanceUnpublishedRecoveryCondition(
  binding: MaintenancePublicationBinding,
) {
  return and(
    eq(piMemoryPhase2Jobs.memoryStorageId, binding.memoryStorageId),
    eq(piMemoryPhase2Jobs.orgId, binding.orgId),
    eq(piMemoryPhase2Jobs.userId, binding.userId),
    or(
      and(
        eq(piMemoryPhase2Jobs.status, "leased"),
        eq(piMemoryPhase2Jobs.maintenanceRunId, binding.runId),
        eq(piMemoryPhase2Jobs.leaseToken, binding.leaseToken),
        eq(piMemoryPhase2Jobs.claimedRevision, binding.claimedRevision),
        eq(
          piMemoryPhase2Jobs.claimedBaseVersionId,
          binding.claimedBaseVersionId,
        ),
        eq(piMemoryPhase2Jobs.claimedSelectionDigest, binding.selectionDigest),
      ),
      and(
        eq(piMemoryPhase2Jobs.lastMaintenanceRunId, binding.runId),
        eq(piMemoryPhase2Jobs.lastMaintenanceRevision, binding.claimedRevision),
        eq(
          piMemoryPhase2Jobs.lastMaintenanceBaseVersionId,
          binding.claimedBaseVersionId,
        ),
        eq(
          piMemoryPhase2Jobs.lastMaintenanceSelectionDigest,
          binding.selectionDigest,
        ),
        eq(piMemoryPhase2Jobs.lastMaintenanceOutcome, "failed"),
      ),
    ),
  );
}

/** Select a version only after the exact published/unpublished predicate admitted its row. */
export function maintenanceOutputResultVersion(runId: string) {
  return sql`CASE
    WHEN ${eq(piMemoryPhase2Jobs.lastMaintenanceRunId, runId)}
      THEN CASE WHEN ${eq(piMemoryPhase2Jobs.lastMaintenanceOutcome, "published")}
        THEN ${piMemoryPhase2Jobs.lastPublishedVersionId}
        ELSE ${piMemoryPhase2Jobs.lastMaintenanceBaseVersionId} END
    ELSE ${piMemoryPhase2Jobs.claimedBaseVersionId}
  END`.mapWith(nullableDriverValueDecoder(pgTextDecoder));
}

/** Published results use the published version; no-diff results retain their base. */
export function maintenancePublicationResultVersion() {
  return sql`CASE
    WHEN ${piMemoryPhase2Jobs.lastMaintenanceOutcome} = 'published'
      THEN ${piMemoryPhase2Jobs.lastPublishedVersionId}
    WHEN ${piMemoryPhase2Jobs.lastMaintenanceOutcome} = 'no_diff'
      THEN ${piMemoryPhase2Jobs.lastMaintenanceBaseVersionId}
    ELSE NULL
  END`.mapWith(nullableDriverValueDecoder(pgTextDecoder));
}

/** A committed result must identify its published or retained Storage version. */
export function maintenancePublicationVersion(
  result: { readonly versionId: string | null } | undefined,
): string | undefined {
  if (!result) {
    return undefined;
  }
  if (result.versionId === null) {
    throw new Error("Pi memory publication result has no version");
  }
  return result.versionId;
}
