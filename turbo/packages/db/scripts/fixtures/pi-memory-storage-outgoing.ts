import { pgTable, uuid, varchar } from "drizzle-orm/pg-core";

import { piMemoryPhase2JobColumns } from "../../src/columns/pi-memory-phase2-job";

/** Outgoing projection before #39185; retain through #39171 contraction acceptance. */
export const outgoingPiMemoryJobs = pgTable("pi_memory_phase2_jobs", {
  ...piMemoryPhase2JobColumns(),
  legacyLeaseToken: uuid("legacy_lease_token"),
  sandboxLeaseToken: uuid("sandbox_lease_token"),
  lastMaintenancePublicationVersionId: varchar(
    "last_maintenance_checkpoint_version_id",
    { length: 64 },
  ),
});
