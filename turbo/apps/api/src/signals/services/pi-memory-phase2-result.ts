import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import { and, eq, inArray, sql } from "drizzle-orm";
import { nullableDriverValueDecoder } from "../../lib/db-structured-result";

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

/** Published results use the published version; no-diff results retain their base. */
export function maintenancePublicationResultVersion() {
  return sql`CASE
    WHEN ${piMemoryPhase2Jobs.lastMaintenanceOutcome} = 'published'
      THEN ${piMemoryPhase2Jobs.lastPublishedVersionId}
    WHEN ${piMemoryPhase2Jobs.lastMaintenanceOutcome} = 'no_diff'
      THEN ${piMemoryPhase2Jobs.lastMaintenanceBaseVersionId}
    ELSE NULL
  END`.mapWith(
    nullableDriverValueDecoder(piMemoryPhase2Jobs.lastPublishedVersionId),
  );
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
