import type { RunOutputMemoryCitation } from "../jsonb-contracts/run-output-memory-citation";
import {
  primaryKey,
  integer,
  jsonb,
  pgTable,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

import { agentRuns } from "./agent-run";

/**
 * Retired runtime storage retained for older API instances and rollback targets.
 * Remove physically only after those writers are excluded from deployment.
 */
export const runOutputMemoryCitations = pgTable(
  "run_output_memory_citations",
  {
    runId: uuid("run_id")
      .notNull()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    sequenceNumber: integer("sequence_number").notNull(),
    citation: jsonb("citation").$type<RunOutputMemoryCitation>().notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => {
    return [primaryKey({ columns: [table.runId, table.sequenceNumber] })];
  },
);
