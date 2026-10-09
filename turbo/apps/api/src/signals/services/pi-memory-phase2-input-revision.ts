import { sql } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { piMemoryPhase2Jobs } from "@okouai/db/schema/pi-memory-phase2-job";
import type { PiMemoryPhase2OwnerScope } from "./pi-memory-phase2-job.service";

export function piMemoryPhase2InputRevisionSql(
  args: PiMemoryPhase2OwnerScope & { readonly enqueuedAt: Date },
) {
  const plan = {
    values: {
      memoryStorageId: args.memoryStorageId,
      orgId: args.orgId,
      userId: args.userId,
      status: "pending",
      inputRevision: 1,
      completedRevision: 0,
      retryCount: 0,
      updatedAt: args.enqueuedAt,
    },
    conflict: {
      target: piMemoryPhase2Jobs.memoryStorageId,
      set: {
        orgId: sql.param(args.orgId, piMemoryPhase2Jobs.orgId),
        userId: sql.param(args.userId, piMemoryPhase2Jobs.userId),
        status: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased' THEN 'leased'
          ELSE 'pending'
        END`,
        inputRevision: sql`${piMemoryPhase2Jobs.inputRevision} + 1`,
        claimedRevision: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedRevision}
          ELSE NULL
        END`,
        claimedBaseVersionId: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedBaseVersionId}
          ELSE NULL
        END`,
        leaseToken: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.leaseToken}
          ELSE NULL
        END`,
        leaseExpiresAt: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.leaseExpiresAt}
          ELSE NULL
        END`,
        sandboxLeaseToken: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.sandboxLeaseToken}
          ELSE NULL
        END`,
        maintenanceRunId: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.maintenanceRunId}
          ELSE NULL
        END`,
        retryCount: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.retryCount}
          ELSE 0
        END`,
        retryAt: sql.param(null, piMemoryPhase2Jobs.retryAt),
        lastErrorClass: sql.param(null, piMemoryPhase2Jobs.lastErrorClass),
        claimedSelectionDigest: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedSelectionDigest}
          ELSE NULL
        END`,
        claimedSelectedCount: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedSelectedCount}
          ELSE NULL
        END`,
        claimedSelectedUtf8Bytes: sql`CASE
          WHEN ${piMemoryPhase2Jobs.status} = 'leased'
          THEN ${piMemoryPhase2Jobs.claimedSelectedUtf8Bytes}
          ELSE NULL
        END`,
        updatedAt: sql.param(args.enqueuedAt, piMemoryPhase2Jobs.updatedAt),
      },
    },
  } as const;
  // An ORM INSERT names all mapped columns, including omitted DEFAULT values.
  // Keep this producer independent of obsolete columns before schema contraction.
  const updates = new PgDialect().buildUpdateSet(
    piMemoryPhase2Jobs,
    plan.conflict.set,
  );
  const values = plan.values;
  return sql`INSERT INTO ${piMemoryPhase2Jobs}
    ("memory_storage_id", "org_id", "user_id", "status", "input_revision", "completed_revision", "retry_count", "updated_at")
    VALUES (${values.memoryStorageId}, ${values.orgId}, ${values.userId}, ${values.status}, ${values.inputRevision}, ${values.completedRevision}, ${values.retryCount}, ${sql.param(values.updatedAt, piMemoryPhase2Jobs.updatedAt)})
    ON CONFLICT ("memory_storage_id") DO UPDATE SET ${updates}
    RETURNING "memory_storage_id" AS "memoryStorageId"`;
}
