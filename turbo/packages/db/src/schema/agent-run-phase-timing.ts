import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  pgTable,
  smallint,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import { agentRuns } from "./agent-run";

export const agentRunPhaseTimings = pgTable(
  "agent_run_phase_timings",
  {
    runId: uuid("run_id")
      .primaryKey()
      .references(
        () => {
          return agentRuns.id;
        },
        { onDelete: "cascade" },
      ),
    schemaVersion: smallint("schema_version").notNull().default(1),
    researchStartedAt: timestamp("research_started_at"),
    generationStartedAt: timestamp("generation_started_at"),
    researchSkipped: boolean("research_skipped").notNull().default(false),
    generationKind: text("generation_kind"),
  },
  (table) => {
    return [
      check("agent_run_phase_timings_version", sql`${table.schemaVersion} = 1`),
      check(
        "agent_run_phase_timings_nonempty",
        sql`${table.researchStartedAt} IS NOT NULL OR ${table.generationStartedAt} IS NOT NULL`,
      ),
      check(
        "agent_run_phase_timings_order",
        sql`${table.researchStartedAt} IS NULL OR ${table.generationStartedAt} IS NULL OR ${table.researchStartedAt} <= ${table.generationStartedAt}`,
      ),
      check(
        "agent_run_phase_timings_skip",
        sql`NOT ${table.researchSkipped} OR (${table.researchStartedAt} IS NULL AND ${table.generationStartedAt} IS NOT NULL)`,
      ),
      check(
        "agent_run_phase_timings_kind",
        sql`(${table.generationStartedAt} IS NULL AND ${table.generationKind} IS NULL) OR (${table.generationStartedAt} IS NOT NULL AND ${table.generationKind} IS NOT NULL AND ${table.generationKind} IN ('image', 'presentation', 'document', 'spreadsheet', 'website', 'report', 'video', 'audio', 'mixed', 'other'))`,
      ),
    ];
  },
);
