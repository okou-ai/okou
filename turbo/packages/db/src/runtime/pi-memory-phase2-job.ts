import { pgTable, primaryKey } from "drizzle-orm/pg-core";
import { piMemoryPhase2JobColumns } from "../columns/pi-memory-phase2-job";

// Physical compatibility storage remains migration-owned until this API is
// deployed, older statements/leases drain, and rollback excludes old writers.
export const piMemoryPhase2Jobs = pgTable(
  "pi_memory_phase2_jobs",
  piMemoryPhase2JobColumns(),
  (table) => {
    return [
      primaryKey({
        name: "pi_memory_phase2_jobs_pkey",
        columns: [table.memoryStorageId],
      }),
    ];
  },
);
